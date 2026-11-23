// Loop-closing Task 5.2: the REAL shared capture code wired to a throwaway local
// PostgreSQL cluster. Run ONLY by dedup-sql-test.sh after the migrations are
// applied, with OBRP_PG_PORT pointing at its cluster:
//   deno run --no-lock --allow-env --allow-read --allow-run=psql \
//     scripts/loop-closing/dedup-integration.ts
//
// What it proves, every assertion reading persisted rows back:
//   I1 extractAndStoreActionItems (capture-pipeline.ts, the code open-brain-mcp
//      runs) inserts one of two identical Casey strings in ONE batch and writes
//      the exact_batch row through the real CHECKs, naming the survivor the
//      real insert returned.
//   I2 a second capture (same project) inserts its reworded Casey row and the
//      semantic proposal reaches the table through the real
//      dedup_semantic_candidates and record_decisions, stamped generation 0;
//      a third capture in ANOTHER project inserts and proposes nothing; a fourth
//      with no project proposes against the OLDEST overlapping item.
//   I3 dedup_pending_proposals lists both proposals and the digest renderer
//      prints the newer item's 8-hex id with the constraint wording.
//   I4 the real reviewProposal helper (Task 3.6, the one the Slack forms and the
//      MCP tool call): done on the first proposal archives the newer copy with
//      close_reason duplicate and duplicate_of the survivor; keep on the second
//      records the pair as distinct; nothing is pending afterwards.
//
// The db adapter implements exactly the supabase-js calls the code under test
// makes (select/eq, insert, insert().select(), rpc) by running SQL through psql;
// an rpc whose function returns a scalar is read as that scalar, as PostgREST
// does. Three outcomes: exit 0 with "DEDUP INTEGRATION PASSED"; exit 1 on a
// completed assertion ("FAIL integration: ..."); exit 2 NEVER-RAN when psql could
// not run, a statement was interrupted, an error carried no readable SQLSTATE,
// or ANY statement the adapter ran raised an SQL error.
//
// Why every SQL error is NEVER-RAN (Codex review 1 of PR 33, R2): the code under
// test catches database errors, logs them and continues (a failed proposal
// write never fails a capture). An adapter or bridge fault that makes a
// statement raise (an undefined column, a malformed jsonb literal) therefore
// reaches the code as an ordinary error, the code shrugs, and the later
// row assertion used to exit 1: a FAIL for a statement that never executed.
// So the adapter records NEVER-RAN BEFORE it hands the error back (the code under
// test still sees the error object PostgREST would give it), and fail(), each
// capture and the end of the run all check that record first.
// No check in I1 to I4 expects the database to refuse a statement: a refused
// review is a returned status (review_proposal), not an SQL error, and the
// CHECK refusals are proven by the SQL contract (D01, D02). A future check that
// expects a refusal must not loosen this rule; it needs its own bounded path
// that names the one statement and the one SQLSTATE it expects, with a control.
//
// The negative controls of dedup-sql-test.sh --inject-selftest reach this file
// through OBDD_BRIDGE_INJECT (bridge_scalar_column, bridge_object_json: Codex's
// two planted adapter faults). Each prints "OBDD_INJECT_REACHED <name>" from the
// adapter branch it plants into, just before the faulty statement runs, and is
// otherwise inert. The adapter also relays a server NOTICE that is exactly
// "OBDD_INJECT_REACHED <name>" (raised by an injected trigger) to stdout.

import { extractAndStoreActionItems } from "../../supabase/functions/_shared/capture-pipeline.ts";
import { reviewProposal } from "../../supabase/functions/_shared/proposal-review.ts";
import { type DedupProposalRow, renderDedupProposals } from "../../supabase/functions/brain-digest/dedup-proposals.ts";

const PORT = Deno.env.get("OBRP_PG_PORT");
if (!PORT) {
  console.error("NEVER-RAN: OBRP_PG_PORT is not set (run me from dedup-sql-test.sh)");
  Deno.exit(2);
}
const PREFIXES = (Deno.env.get("OBRP_INTERRUPTION_PREFIXES") ?? "08 53 54 57 58 XX 55P03").split(/\s+/).filter(Boolean);
const BRIDGE_INJECT = Deno.env.get("OBDD_BRIDGE_INJECT") ?? "";
if (BRIDGE_INJECT !== "" && BRIDGE_INJECT !== "bridge_scalar_column" && BRIDGE_INJECT !== "bridge_object_json") {
  console.error(`NEVER-RAN: unknown bridge injection ${BRIDGE_INJECT}`);
  Deno.exit(2);
}

const origLog = console.log;
const logs: string[] = [];
console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
console.error = (...a: unknown[]) => { logs.push("ERR " + a.map(String).join(" ")); };
const say = (s: string) => origLog(s);

let neverRan: string | null = null;
// Records the first reason the run cannot be judged, without throwing: the
// caller then hands the code under test the error it would have seen.
function markNever(why: string): void {
  if (!neverRan) neverRan = why;
}
function recordNever(why: string): never {
  markNever(why);
  throw new Error(`NEVER-RAN: ${why}`);
}
function fail(msg: string): never {
  if (neverRan) { say(`NEVER-RAN: ${neverRan}`); Deno.exit(2); }
  say(`FAIL integration: ${msg}`);
  for (const l of logs.slice(-20)) say(`  ${l.slice(0, 200)}`);
  Deno.exit(1);
}
const expect = (cond: boolean, msg: string) => { if (!cond) fail(msg); };

type PgError = { code: string; message: string };

// `at` names the adapter call that issued the statement (for example
// "rpc record_decisions"), so a NEVER-RAN line says which statement raised.
async function psql(sql: string, at: string): Promise<{ out: string } | { error: PgError }> {
  let res: Deno.CommandOutput;
  try {
    res = await new Deno.Command("psql", {
      args: ["-X", "-h", "127.0.0.1", "-p", PORT!, "-U", "postgres", "-d", "obtest", "-At",
        "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-c", sql],
      stdout: "piped", stderr: "piped",
    }).output();
  } catch (e) {
    recordNever(`psql could not be run: ${e instanceof Error ? e.message : String(e)}`);
  }
  const out = new TextDecoder().decode(res.stdout);
  const err = new TextDecoder().decode(res.stderr);
  for (const n of err.matchAll(/^NOTICE:\s+00000: (OBDD_INJECT_REACHED [a-z_]+)$/gm)) say(n[1]);
  if (res.code === 0) return { out };
  const m = /ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/.exec(err);
  if (!m) recordNever(`psql exit ${res.code} at ${at} with no readable SQLSTATE: ${err.split("\n")[0].slice(0, 160)}`);
  if (PREFIXES.some((p) => m[1].startsWith(p))) recordNever(`statement interrupted at ${at} (SQLSTATE ${m[1]}: ${m[2].slice(0, 160)})`);
  const detail = /^DETAIL:\s+([^\n]*)/m.exec(err);
  markNever(`an SQL error no check expects, at ${at} (SQLSTATE ${m[1]}: ${m[2].slice(0, 160)}${detail ? `; ${detail[1].slice(0, 120)}` : ""}); the statement did not execute, so nothing after it was judged`);
  return { error: { code: m[1], message: m[2] } };
}

async function jsonQuery(sql: string, at: string): Promise<{ data: unknown; error: PgError | null }> {
  const r = await psql(sql, at);
  if ("error" in r) return { data: null, error: r.error };
  const text = r.out.trim();
  try {
    return { data: JSON.parse(text), error: null };
  } catch {
    recordNever(`psql exited 0 without JSON output: ${text.slice(0, 120)}`);
  }
}

const TAG = "$obdedup$";
function objectLit(v: unknown): string {
  if (BRIDGE_INJECT === "bridge_object_json") {
    say("OBDD_INJECT_REACHED bridge_object_json");
    return `${TAG}obdd_injected_invalid_json${TAG}::jsonb`;
  }
  return `${TAG}${JSON.stringify(v)}${TAG}::jsonb`;
}
const lit = (v: unknown) =>
  v === null || v === undefined ? "null"
  : typeof v === "object" ? objectLit(v)
  : `${TAG}${String(v)}${TAG}`;
const ident = (s: string) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) recordNever(`unsafe identifier ${s}`); return s; };
// Functions that return a scalar: PostgREST answers those with the bare value.
const SCALAR_RPCS = new Set(["record_decisions"]);

function insertSql(table: string, rows: Array<Record<string, unknown>>, returning: string | null): string {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].map(ident);
  const src = `jsonb_populate_recordset(null::public.${ident(table)}, ${TAG}${JSON.stringify(rows)}${TAG}::jsonb)`;
  const ins = `insert into public.${ident(table)} (${cols.join(", ")}) select ${cols.join(", ")} from ${src}`;
  if (!returning) return `with ins as (${ins} returning 1) select to_jsonb(count(*)) from ins`;
  const ret = returning.split(",").map((c) => ident(c.trim())).join(", ");
  return `with ins as (${ins} returning ${ret}) select coalesce(jsonb_agg(to_jsonb(ins)), '[]'::jsonb) from ins`;
}

const rpcCalls: string[] = [];
const db = {
  from(table: string) {
    return {
      select(cols: string) {
        return {
          eq(col: string, val: unknown) {
            const c = cols.split(",").map((x) => ident(x.trim())).join(", ");
            return jsonQuery(`select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (select ${c} from public.${ident(table)} where ${ident(col)} = ${lit(val)}) x`, `select ${table}`);
          },
        };
      },
    };
  },
  rpc(fn: string, args: Record<string, unknown>) {
    rpcCalls.push(fn);
    const named = Object.entries(args).map(([k, v]) => `${ident(k)} => ${lit(v)}`).join(", ");
    if (SCALAR_RPCS.has(fn)) {
      if (BRIDGE_INJECT === "bridge_scalar_column") {
        say("OBDD_INJECT_REACHED bridge_scalar_column");
        return jsonQuery(`select obdd_injected_missing_column, to_jsonb(public.${ident(fn)}(${named}))`, `rpc ${fn}`);
      }
      return jsonQuery(`select to_jsonb(public.${ident(fn)}(${named}))`, `rpc ${fn}`);
    }
    return jsonQuery(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.${ident(fn)}(${named}) t`, `rpc ${fn}`);
  },
};
// insert() is lazy, as supabase-js's builder is: the plain statement runs only
// when the result is awaited, and .select() runs the RETURNING form instead, so
// one call never inserts twice.
const lazyDb = {
  from(table: string) {
    const inner = db.from(table);
    return {
      select: inner.select,
      insert(rows: Record<string, unknown> | Array<Record<string, unknown>>) {
        const list = Array.isArray(rows) ? rows : [rows];
        return {
          then(onOk: (v: { error: PgError | null }) => unknown, onErr?: (e: unknown) => unknown) {
            return jsonQuery(insertSql(table, list, null), `insert ${table}`).then((r) => ({ error: r.error })).then(onOk, onErr);
          },
          select: (cols: string) => jsonQuery(insertSql(table, list, cols), `insert ${table} returning ${cols}`),
        };
      },
    };
  },
  rpc: db.rpc,
};

async function rows(sql: string): Promise<Array<Record<string, unknown>>> {
  const r = await jsonQuery(`select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (${sql}) x`, "a read-back");
  if (r.error) recordNever(`a read failed: ${r.error.code} ${r.error.message}`);
  return r.data as Array<Record<string, unknown>>;
}

const CASEY_1 = "Add Casey as a guest when his email arrives";
const CASEY_2 = "Add Casey Holt as a guest when his email arrives";
const CASEY_3 = "Add Casey as guest when his email address arrives";
const NOTE = "Notes from today: these still need to go out.";

async function capture(thoughtId: string, project: string | null, items: string[]): Promise<void> {
  const meta = project === null ? "null" : `${TAG}{"project": ${JSON.stringify(project)}}${TAG}::jsonb`;
  const seed = await psql(`insert into public.thoughts (id, metadata) values ('${thoughtId}', ${meta}) on conflict do nothing`, "the thought fixture");
  if ("error" in seed) recordNever(`thought fixture ${thoughtId}: ${seed.error.message}`);
  await extractAndStoreActionItems(lazyDb, thoughtId, { type: "task", source: "slack", project, action_items: items }, NOTE, () => false);
  if (neverRan) { say(`NEVER-RAN: ${neverRan}`); Deno.exit(2); }
}

try {
  const TA = "e5299999-0000-4000-8000-00000000000a";
  const TB = "e5299999-0000-4000-8000-00000000000b";
  const TC = "e5299999-0000-4000-8000-00000000000c";
  const TD = "e5299999-0000-4000-8000-00000000000d";
  const itemsOf = (t: string) => rows(`select id::text, description from public.action_items where source_thought_id = '${t}' order by created_at, description`);

  // I1: one batch, two identical strings.
  await capture(TA, "brain-bank", [CASEY_1, "add casey as a guest, when his email arrives!"]);
  const a = await itemsOf(TA);
  expect(a.length === 1 && a[0].description === CASEY_1, `I1 one row inserted: ${JSON.stringify(a)}`);
  const first = String(a[0].id);
  const exact = await rows(`select layer, outcome, reason, candidate_description, item_id::text, thought_id::text, related_item_id::text, item_generation from public.auto_resolve_decisions where thought_id = '${TA}'`);
  expect(exact.length === 1 && exact[0].layer === "dedup" && exact[0].outcome === "dropped" && exact[0].reason === "exact_batch" &&
    exact[0].candidate_description === "add casey as a guest, when his email arrives!" && exact[0].item_id === null &&
    exact[0].related_item_id === first && exact[0].item_generation === null, `I1 exact_batch row: ${JSON.stringify(exact)}`);
  say("PASS I1 two identical strings in one batch inserted once; the exact_batch row names the inserted survivor through the real CHECKs");

  // I2: a reworded copy in the same project proposes; another project does not.
  await capture(TB, "brain-bank", [CASEY_2]);
  const b = await itemsOf(TB);
  expect(b.length === 1 && b[0].description === CASEY_2, `I2 the reworded copy inserted: ${JSON.stringify(b)}`);
  const second = String(b[0].id);
  const propB = await rows(`select item_id::text, related_item_id::text, score::float8 as score, thought_id, item_generation from public.auto_resolve_decisions where layer = 'dedup' and outcome = 'proposed' and item_id = '${second}'`);
  expect(propB.length === 1 && propB[0].related_item_id === first && propB[0].score === 1 && propB[0].thought_id === null && propB[0].item_generation === 0,
    `I2 proposal row: ${JSON.stringify(propB)}`);
  expect(rpcCalls.includes("dedup_semantic_candidates") && rpcCalls.includes("record_decisions"), `I2 the real reads ran: ${rpcCalls}`);
  await capture(TC, "external-crm", [CASEY_3]);
  const c = await itemsOf(TC);
  expect(c.length === 1, `I2 the other project's copy inserted: ${JSON.stringify(c)}`);
  const propC = await rows(`select 1 from public.auto_resolve_decisions where item_id = '${c[0].id}'`);
  expect(propC.length === 0, `I2 another project proposes nothing: ${JSON.stringify(propC)}`);
  await capture(TD, null, [CASEY_3 + " today"]);
  const d = await itemsOf(TD);
  expect(d.length === 1, `I2 the no-project copy inserted: ${JSON.stringify(d)}`);
  const fourth = String(d[0].id);
  const propD = await rows(`select related_item_id::text from public.auto_resolve_decisions where layer = 'dedup' and outcome = 'proposed' and item_id = '${fourth}'`);
  expect(propD.length === 1 && propD[0].related_item_id === first, `I2 a null project proposes against the oldest overlapping item: ${JSON.stringify(propD)}`);
  say("PASS I2 the reworded copies insert; same project and null project propose against the oldest item; another project proposes nothing");

  // I3: the digest's read and renderer.
  const pend = await lazyDb.rpc("dedup_pending_proposals", { p_limit: 200 });
  if (pend.error) recordNever(`dedup_pending_proposals: ${pend.error.message}`);
  const section = renderDedupProposals(pend.data as DedupProposalRow[]);
  const lines = section.split("\n").slice(2);
  expect(lines.length === 2 && lines[0].startsWith(`- ${second.slice(0, 8)} "${CASEY_2}" possible duplicate of ${first.slice(0, 8)} "${CASEY_1}" (constraints agree)`) &&
    lines[1].startsWith(`- ${fourth.slice(0, 8)} `), `I3 digest section: ${JSON.stringify(section)}`);
  say("PASS I3 the digest section lists both proposals by the newer item's 8-hex id with the constraint wording");

  // I4: Task 3.6's helper on the printed ids.
  const done = await reviewProposal(lazyDb, { verb: "done", itemRef: second.slice(0, 8), actor: "slack:U0DEDUP2", source: "slack-signature" });
  expect(done.status === "recorded", `I4 done: ${JSON.stringify(done)}`);
  const afterDone = await rows(`select a.status, a.close_reason, a.duplicate_of::text, d.outcome, d.reviewed_by from public.action_items a join public.auto_resolve_decisions d on d.item_id = a.id where a.id = '${second}'`);
  expect(afterDone.length === 1 && afterDone[0].status === "archived" && afterDone[0].close_reason === "duplicate" && afterDone[0].duplicate_of === first &&
    afterDone[0].outcome === "accepted" && afterDone[0].reviewed_by === "slack:U0DEDUP2", `I4 after done: ${JSON.stringify(afterDone)}`);
  const keep = await reviewProposal(lazyDb, { verb: "keep", itemRef: fourth, actor: "operator", source: "mcp-shared-key" });
  expect(keep.status === "recorded", `I4 keep: ${JSON.stringify(keep)}`);
  const afterKeep = await rows(`select a.status, d.outcome from public.action_items a join public.auto_resolve_decisions d on d.item_id = a.id where a.id = '${fourth}'`);
  expect(afterKeep.length === 1 && afterKeep[0].status === "open" && afterKeep[0].outcome === "kept", `I4 after keep: ${JSON.stringify(afterKeep)}`);
  const pend2 = await lazyDb.rpc("dedup_pending_proposals", { p_limit: 200 });
  expect(!pend2.error && renderDedupProposals(pend2.data as DedupProposalRow[]) === "", `I4 still pending: ${JSON.stringify(pend2)}`);
  say("PASS I4 done archives the newer copy as a duplicate of the survivor; keep leaves the item open; nothing is pending");
} catch (e) {
  if (neverRan) { say(`NEVER-RAN: ${neverRan}`); Deno.exit(2); }
  say(`NEVER-RAN: the bridge threw: ${e instanceof Error ? e.message : String(e)}`);
  Deno.exit(2);
}
if (neverRan) { say(`NEVER-RAN: ${neverRan}`); Deno.exit(2); }
say("DEDUP INTEGRATION PASSED");
Deno.exit(0);
