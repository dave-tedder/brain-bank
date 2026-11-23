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
import { proposeBookingMatches } from "../_shared/booking-match.ts";
import { FakeDb } from "../../../scripts/loop-closing/client-identity-fake.ts";
// Runtime-bound claims for the TS mutant sweep (Codex re-review 2, N1).
import { claim } from "../../../scripts/loop-closing/claim.ts";
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

// ---------------------------------------------------------------------------
// Loop-closing Task 5.3: an upsert_event push PROPOSES closing the client's
// scheduling items, through the same cut-out Deno.serve callback, the real
// upsertEvent and SupabaseSyncStore, and the real proposeBookingMatches, over
// an in-memory database (scripts/loop-closing/client-identity-fake.ts) whose
// sync_booking_proposals re-states 20261121b's (support, same-booking skip,
// record_decisions and the calendar lifetime unique). The session date is
// far in the future so the real clock the handler uses always reads it as
// upcoming.
// ---------------------------------------------------------------------------

const CB_ALICIA = "a11c1a00-0000-4000-8000-0000000000c1";
const CB_APPT = "appt-5-3-0001";
const SCHED_ITEM = "5c4ed000-0000-4000-8000-0000000000c1";

function bookingDb() {
  return new FakeDb({
    clients: [{ id: CB_ALICIA, name: "Alicia Brennan", last_contact: "2026-11-01T00:00:00Z", metadata: { crm_id: "cb-alicia" } }],
    action_items: [
      { id: SCHED_ITEM, description: "Schedule tattoo appointment for Alicia Brennan", status: "open", client_id: CB_ALICIA, created_at: "2026-11-20T14:00:00Z" },
      { id: "5c4ed000-0000-4000-8000-0000000000c2", description: "send Alicia the design", status: "open", client_id: CB_ALICIA, created_at: "2026-11-20T14:00:00Z" },
    ],
  });
}

async function push(db: FakeDb, op: string, payload: Record<string, unknown>) {
  const env: Record<string, unknown> = {
    supabase: db,
    authenticatePushKey: (headers: Headers) => authenticatePushKey(headers, PUSH_KEY),
    captureIntake,
    contentHash,
    coerceMetadata,
    routeProjectFromContent,
    SYNC,
    UniqueViolation,
    upsertClient,
    upsertEvent,
    proposeBookingMatches,
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
  const errors: string[] = [];
  const realError = console.error;
  const realLog = console.log;
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
  console.log = () => {};
  try {
    const response = await handler(
      new Request(`https://synthetic.invalid/functions/v1/external-crm-sync/${op}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-push-key": PUSH_KEY },
        body: JSON.stringify(payload),
      }),
    );
    return { status: response.status, body: await response.json(), errors };
  } finally {
    console.error = realError;
    console.log = realLog;
  }
}

const sessionPush = (over: Record<string, unknown> = {}) => ({
  crm_appointment_id: CB_APPT,
  crm_client_id: "cb-alicia",
  event_type: "tattoo_session",
  title: "Tattoo session: Alicia Brennan",
  date_start: "2099-01-16",
  status: "scheduled",
  ...over,
});
const calendarOf = (db: FakeDb) =>
  db.tables.auto_resolve_decisions.filter((d) => d.layer === "calendar").map((d) => ({
    item_id: d.item_id, evidence_event_id: d.evidence_event_id, outcome: d.outcome, reason: d.reason, quote: d.quote,
  }));

Deno.test("external-crm-sync upsert_event 5.3: a pushed session proposes the client's scheduling item, and the response is unchanged", async () => {
  const db = bookingDb();
  const res = await push(db, "upsert_event", sessionPush());
  assertEquals(res.status, 201);
  assertEquals(Object.keys(res.body).sort(), ["id", "status"]);
  assertEquals(res.body.status, "created");
  assertEquals(res.errors, []);
  claim(
    "cbs-upsert-proposes",
    calendarOf(db),
    [{ item_id: SCHED_ITEM, evidence_event_id: res.body.id, outcome: "proposed", reason: "booking_match", quote: "Tattoo session: Alicia Brennan on 2099-01-16" }],
    "one booking proposal on the scheduling item, naming the event the push wrote",
  );
  assertEquals(db.tables.action_items.map((a) => a.status), ["open", "open"], "nothing resolves");
});

Deno.test("external-crm-sync upsert_event 5.3: the same push again updates the event and never proposes twice", async () => {
  const db = bookingDb();
  const first = await push(db, "upsert_event", sessionPush());
  const second = await push(db, "upsert_event", sessionPush({ title: "Tattoo session: Alicia Brennan (2)" }));
  assertEquals([first.status, second.status], [201, 200]);
  assertEquals(second.body, { status: "updated", id: first.body.id });
  claim("cbs-refire-once", calendarOf(db).length, 1, "a re-fired upsert of the same event writes no second proposal");
  assertEquals(db.rpcCalls.filter((c) => c.fn === "sync_booking_proposals").length, 2, "the matcher ran on both writes");
});

Deno.test("external-crm-sync upsert_event 5.3: a re-push for another client withdraws the support, so the proposal is no longer shown", async () => {
  const db = bookingDb();
  db.tables.clients.push({ id: "1a4e0000-0000-4000-8000-0000000000c9", name: "Jordan Marlow", metadata: { crm_id: "cb-jake" } });
  await push(db, "upsert_event", sessionPush());
  const before = db.tables.calendar_proposal_support.length;
  await push(db, "upsert_event", sessionPush({ crm_client_id: "cb-jake", title: "Consultation: Jordan Marlow", event_type: "consultation" }));
  claim(
    "cbs-reassigned-withdrawn",
    { before, after: db.tables.calendar_proposal_support.length, decisions: calendarOf(db).length },
    { before: 1, after: 0, decisions: 1 },
    "the reassigned booking no longer supports Alicia's item",
  );
});

Deno.test("external-crm-sync upsert_event 5.3: a cancelled push proposes nothing", async () => {
  const db = bookingDb();
  const res = await push(db, "upsert_event", sessionPush({ event_type: "cancelled_session", status: "cancelled" }));
  assertEquals(res.status, 201);
  assertEquals(calendarOf(db), []);
});

Deno.test("external-crm-sync upsert_event 5.3: a failed proposal write is logged and the push still answers created", async () => {
  const db = bookingDb();
  db.failNext["rpc/sync_booking_proposals"] = [{ code: "23514", message: "check violation" }];
  const res = await push(db, "upsert_event", sessionPush());
  assertEquals(res.status, 201);
  assertEquals(res.body.status, "created");
  assertEquals(res.errors.length, 1);
  assert(res.errors[0].startsWith("booking match: sync_booking_proposals failed"), res.errors[0]);
});

Deno.test("external-crm-sync upsert_client 5.3: a client push runs no booking match", async () => {
  const db = bookingDb();
  const res = await push(db, "upsert_client", { crm_id: "cb-new", name: "New Person" });
  assert(res.status === 200 || res.status === 201, `status ${res.status}`);
  assertEquals(db.reads.filter((r) => r.table === "business_events"), []);
  assertEquals(db.rpcCalls, []);
});
