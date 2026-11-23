// A capture_intake push stores the thought and no
// action items. Run: deno test --allow-read --allow-env supabase/functions/external-crm-sync/
//
// index.ts cannot be imported (it calls Deno.serve and builds a supabase client
// from the environment at load), so this test cuts it as text, the way
// metadata-validation.test.ts does for the project-routing tests, but takes
// EVERYTHING after the line that creates the supabase client: throwDbError, the
// whole SupabaseSyncStore class and the store, the `pipeline` object (analyze
// AND afterInsert), OPS, json, and the Deno.serve callback. That text runs
// verbatim inside one function whose scope supplies the imports, a recording
// stub for `supabase`, and a local `Deno` whose only member, serve, captures the
// callback. The test then dispatches a synthetic POST
// /external-crm-sync/capture_intake request through that captured callback, so a
// write anywhere on the push's path (the handler after captureIntake, the real
// captureIntake from _sync.ts, the store, the pipeline) lands in the stub's
// record. (Codex review 1 of PR 31, R1: a write added in the handler after a
// created intake passed every test while the fixture called captureIntake
// directly.)
//
// The stub database records every table touched and supports the exact query
// chains the store and the real extractAndStoreActionItems use (thought lookup
// by intake id, open-items read, action_items insert, auto_resolve_decisions
// insert). The real extractAndStoreActionItems and recordDecision are in scope
// for the cut-out code, so putting the old call back makes it write rows here
// rather than throw a ReferenceError that captureIntake would swallow. A throw
// from afterInsert is caught and logged by captureIntake, and a throw in the
// handler is caught, logged and answered 500, so the test also fails on any
// console.error line: a crash cannot pass as "zero rows".
//
// What is stubbed: the embedding and model calls (getEmbedding,
// extractMetadata), the slug and route-map loaders, and the push-key secret (the
// real authenticatePushKey runs against a synthetic configured key). Not run:
// index.ts's imports and its first three constants (the environment URL, the
// service key, createClient). Project routing is covered in
// metadata-validation.test.ts.

import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import {
  contentHash,
  extractAndStoreActionItems,
} from "../_shared/capture-pipeline.ts";
import { recordDecision } from "../_shared/decisions.ts";
import {
  coerceMetadata,
  routeProjectFromContent,
} from "../_shared/metadata-validation.ts";
import { authenticatePushKey } from "./_auth.ts";
import {
  captureIntake,
  SYNC,
  UniqueViolation,
  upsertClient,
  upsertEvent,
} from "./_sync.ts";

const SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

// Everything in index.ts after the one line that builds the supabase client.
// Exactly one such line is required, and the rest must register exactly one
// Deno.serve callback (checked when the service is built).
const CLIENT_LINE = "const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);";
function bodyAfterClientLine(source: string): string {
  const lines = source.split("\n");
  const at = lines.flatMap((l, i) => (l === CLIENT_LINE ? [i] : []));
  if (at.length !== 1) throw new Error(`supabase client line in index.ts: ${at.length}`);
  return lines.slice(at[0] + 1).join("\n");
}
const BODY_SRC = bodyAfterClientLine(SOURCE);

async function importTs(module: string): Promise<Record<string, any>> {
  const bytes = new TextEncoder().encode(module);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return await import(`data:application/typescript;charset=utf-8;base64,${btoa(binary)}`);
}

type Touch = { table: string; op: "select" | "insert"; rows?: unknown };

// A supabase-js stand-in that records every table touched. It answers:
//   from("projects").select(...)                       -> no rows
//   from("thoughts").select(...).eq().order().limit()  -> no rows (intake id miss)
//   from("action_items").select(...).eq(...)           -> the open items given
//   from(<any>).insert(x)                              -> awaitable { error: null }
//   from(<any>).insert(x).select("id").single()        -> { data: { id }, error: null }
//   from(<any>).insert(rows).select(cols)              -> awaitable { data: rows with ids, error: null }
// The last shape is what extractAndStoreActionItems asks for once PR 30 (Task
// 5.1) adds `.insert(rows).select("id, description")`; answering it keeps the
// control and the restore-extraction mutant meaningful on either side of that
// merge.
function makeDb(openItems: string[] = []) {
  const touches: Touch[] = [];
  const db = {
    from(table: string) {
      return {
        select(_cols: string) {
          touches.push({ table, op: "select" });
          const result = {
            data: table === "action_items" ? openItems.map((description) => ({ description })) : [],
            error: null,
          };
          const chain: any = {
            eq: () => chain,
            order: () => chain,
            limit: () => chain,
            then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
              Promise.resolve(result).then(ok, bad),
          };
          return chain;
        },
        insert(rows: unknown) {
          touches.push({ table, op: "insert", rows: structuredClone(rows) });
          const list = Array.isArray(rows) ? rows : [rows];
          const returned = list.map((r, i) => ({
            ...(r as Record<string, unknown>),
            id: `f0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          }));
          return {
            select: (_cols: string) => ({
              single: () =>
                Promise.resolve({ data: { id: THOUGHT_ID }, error: null }),
              then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
                Promise.resolve({ data: returned, error: null }).then(ok, bad),
            }),
            then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
              Promise.resolve({ error: null }).then(ok, bad),
          };
        },
      };
    },
  };
  return { db, touches };
}

const INTAKE_CONTENT = [
  "[Intake] New project request from Jordan R.",
  "Style: Japanese",
  "Placement: left forearm",
  "Idea: koi with peonies, black and grey with a little red",
  "Notes: wants a price and a sketch before he books",
].join("\n");

// What the model returns for that text: a task with two extracted items, the
// shape the old afterInsert turned into two open action_items rows.
const MODEL_METADATA = {
  people: ["Jordan R."],
  action_items: [
    "Send Jordan R. a quote for the koi forearm piece",
    "Draw a koi and peony sketch for Jordan R.",
  ],
  dates_mentioned: [],
  topics: ["intake"],
  type: "task",
  project: null,
  priority: null,
};

const INTAKE_ID = "1a2b3c4d-0000-4000-8000-0000000005f5";
const THOUGHT_ID = "7e570000-0000-4000-8000-0000000000c5";

const PUSH_KEY = "synthetic-push-key-for-index-test";

// One capture_intake push: a synthetic HTTP request dispatched through the
// Deno.serve callback cut out of index.ts, which runs the real captureIntake,
// the real SupabaseSyncStore and the pipeline object over the stub database.
async function runIntake() {
  const { db, touches } = makeDb();
  const env: Record<string, unknown> = {
    supabase: db,
    // real
    authenticatePushKey: (headers: Headers) => authenticatePushKey(headers, PUSH_KEY),
    captureIntake,
    contentHash,
    coerceMetadata,
    routeProjectFromContent,
    SYNC,
    UniqueViolation,
    upsertClient,
    upsertEvent,
    // not imported by index.ts; in scope so a restored extraction call writes
    // rows here instead of throwing a ReferenceError
    extractAndStoreActionItems,
    recordDecision,
    // stubbed external calls
    getEmbedding: () => Promise.resolve([0.25, 0.5]),
    extractMetadata: () => Promise.resolve(structuredClone(MODEL_METADATA)),
    loadKnownSlugs: () => Promise.resolve(new Set<string>()),
    loadRouteMap: () => Promise.resolve(new Map<string, string[]>()),
  };
  const { makeHandler } = await importTs(
    `export function makeHandler(env: any) {\n  const { ${
      Object.keys(env).join(", ")
    } } = env;\n  const registered: Array<(req: Request) => Promise<Response>> = [];\n  const Deno = { serve(h: (req: Request) => Promise<Response>) { registered.push(h); } };\n${BODY_SRC}\n  if (registered.length !== 1) throw new Error("Deno.serve callbacks in index.ts: " + registered.length);\n  return registered[0];\n}\n`,
  );
  const handler = makeHandler(env) as (req: Request) => Promise<Response>;

  // captureIntake logs a throwing afterInsert with console.error and still
  // answers created, and the handler logs a thrown write with console.error;
  // capture both so a crash cannot read as zero rows. The handler's one
  // console.log line (op and outcome) is captured to keep test output clean.
  const errors: string[] = [];
  const logs: string[] = [];
  const realError = console.error;
  const realLog = console.log;
  console.error = (...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  };
  console.log = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  };
  try {
    const response = await handler(
      new Request("https://synthetic.invalid/functions/v1/external-crm-sync/capture_intake", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-push-key": PUSH_KEY },
        body: JSON.stringify({
          crm_intake_id: INTAKE_ID,
          content: INTAKE_CONTENT,
          submitted_at: "2026-11-20T09:00:00Z",
          site: "example.com",
          venue: "Example Studio",
          audience: "artist",
          tags: [],
        }),
      }),
    );
    const result = { status: response.status, body: await response.json() };
    return { result, touches, errors, logs };
  } finally {
    console.error = realError;
    console.log = realLog;
  }
}

Deno.test("external-crm-sync capture_intake: the push inserts the thought and writes zero action_items rows", async () => {
  const { result, touches, errors } = await runIntake();

  assertEquals(result.status, 200);
  assertEquals(result.body, { status: "created", id: THOUGHT_ID });
  assertEquals(errors, [], "nothing was logged as failed (afterInsert did not throw)");

  // The thought: exactly one insert, into thoughts, carrying the intake text.
  const inserts = touches.filter((t) => t.op === "insert");
  assertEquals(inserts.map((t) => t.table), ["thoughts"], "the only write is the thought");
  const record = inserts[0].rows as Record<string, any>;
  assertEquals(record.content, INTAKE_CONTENT);
  assertEquals(record.metadata.source, "external-crm");
  assertEquals(record.metadata.crm_intake_id, INTAKE_ID);
  assertEquals(record.metadata.type, "task");
  // The extracted strings stay on the thought's metadata (display only), as on
  // every capture; what Task 5.5 removes is the action_items rows.
  assertEquals(record.metadata.action_items, MODEL_METADATA.action_items);

  // No action_items row, no decision row, and not even the open-items read.
  assertEquals(
    touches.filter((t) => t.table === "action_items"),
    [],
    "zero action_items rows written (and the table is not read)",
  );
  assertEquals(
    touches.filter((t) => t.table === "auto_resolve_decisions"),
    [],
    "zero auto_resolve_decisions rows written",
  );
  assertEquals(
    [...new Set(touches.map((t) => t.table))],
    ["thoughts"],
    "thoughts is the only table touched",
  );
});

// Positive control: the record the push just wrote DOES produce action_items
// rows when its metadata and content go to the real extractAndStoreActionItems
// exactly as the old afterInsert passed them (the same metadata object that
// went into the insert, and `() => false` for the mechanical test). Without
// this, the zero above could come from a fixture extraction would skip anyway
// (an observation type, an excluded source, an appointment-guarded item).
Deno.test("external-crm-sync capture_intake: control, the pushed record is extraction-eligible, so the zero rows above are not vacuous", async () => {
  const { touches: pushTouches } = await runIntake();
  const record = pushTouches.find((t) => t.table === "thoughts" && t.op === "insert")?.rows as Record<string, any>;
  assert(record, "the push wrote a thought");
  const { db, touches } = makeDb();
  await extractAndStoreActionItems(db, THOUGHT_ID, record.metadata, record.content, () => false);
  const writes = touches.filter((t) => t.table === "action_items" && t.op === "insert");
  assertEquals(writes.length, 1, "one action_items insert");
  const rows = writes[0].rows as Array<Record<string, unknown>>;
  assertEquals(rows.map((r) => r.description), MODEL_METADATA.action_items);
  assert(rows.every((r) => r.source_thought_id === THOUGHT_ID && r.status === "open"));
});
