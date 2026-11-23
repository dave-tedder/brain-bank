// Loop-closing Task 4.1: the Edge Function's run loop (runRecheck) wired to the
// REAL functions of 20261119c_action_items_recheck.sql and
// 20261119ca_action_items_recheck_cold_start.sql on a throwaway local
// PostgreSQL cluster. The database is not scripted: every RPC the loop makes is
// executed by the migrated functions, and every assertion reads persisted rows
// back. Only the model is a stand-in (no network, no paid call): a function
// that answers from markers in the thought text.
//
// Run ONLY by recheck-sql-test.sh, after the migrations are applied, against the
// database "obint" (a copy taken before the SQL contract wrote anything):
//   deno run --no-lock --allow-env --allow-read --allow-run=psql \
//     scripts/loop-closing/recheck-integration.ts
//
// Exit 0 with "RECHECK INTEGRATION PASSED"; 1 on a failed assertion that ran to
// completion ("FAIL integration: ..."); 2 when the bridge itself could not
// execute (NEVER-RAN). A database error reaches the code under test only when it
// is an answer from the functions. An interruption (the SQLSTATE prefixes in
// OBRP_INTERRUPTION_PREFIXES) or an error with no readable SQLSTATE is
// NEVER-RAN, and once one exists no verdict is given.
//
// The bridge passes arguments BY NAME, so a name the TypeScript sends and the
// SQL does not declare is a database error here exactly as through PostgREST.
// What it does not prove: PostgREST's own JSON-to-argument casting, and the
// real pgvector type (this cluster's `vector` is a stand-in domain).

import { type RecheckLlm, runRecheck, type RunSummary } from "../../supabase/functions/action-item-recheck/_recheck.ts";

const PORT = Deno.env.get("OBRP_PG_PORT");
const DB = Deno.env.get("OBRP_PG_DB") ?? "obint";
if (!PORT) {
  console.log("NEVER-RAN: OBRP_PG_PORT is not set (run me from recheck-sql-test.sh)");
  Deno.exit(2);
}
const INTERRUPTION_PREFIXES = (Deno.env.get("OBRP_INTERRUPTION_PREFIXES") ?? "").split(" ").filter(Boolean);
if (INTERRUPTION_PREFIXES.length === 0) {
  console.log("NEVER-RAN: OBRP_INTERRUPTION_PREFIXES is not set (run me from recheck-sql-test.sh)");
  Deno.exit(2);
}

const say = console.log;
const logs: string[] = [];
console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
console.error = (...a: unknown[]) => { logs.push("ERR " + a.map(String).join(" ")); };
console.warn = (...a: unknown[]) => { logs.push("WARN " + a.map(String).join(" ")); };

const neverRan: string[] = [];
class NeverRan extends Error {
  constructor(message: string) {
    super(message);
    neverRan.push(message);
  }
}

// ---------- psql bridge ----------
async function psql(query: string): Promise<{ code: number; out: string; err: string }> {
  const cmd = new Deno.Command("psql", {
    args: ["-h", "127.0.0.1", "-p", PORT!, "-U", "postgres", "-d", DB, "-X", "-q", "-A", "-t",
      "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-c", query],
    stdout: "piped", stderr: "piped",
  });
  const r = await cmd.output();
  return { code: r.code, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) };
}
async function sql(query: string): Promise<string> {
  const r = await psql(query);
  if (r.code !== 0) throw new NeverRan(`harness query failed (psql exit ${r.code}): ${r.err.trim().slice(0, 300)}`);
  return r.out.replace(/\n$/, "");
}
function quote(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}
const JSONB_ARGS = new Set(["p_rows", "p_summary"]);
const UUID_ARRAY_ARGS = new Set(["p_embedding_ids", "p_item_ids"]);
function lit(key: string, v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (JSONB_ARGS.has(key)) return `${quote(JSON.stringify(v))}::jsonb`;
  if (UUID_ARRAY_ARGS.has(key)) {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new NeverRan(`${key} is not a list of strings`);
    return `${quote("{" + v.join(",") + "}")}::uuid[]`;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return quote(v);
  throw new NeverRan(`unsupported value for ${key}: ${JSON.stringify(v).slice(0, 80)}`);
}

const TABLE_FNS = new Set([
  "recheck_eligible_items", "recheck_source_embedding", "recheck_plan_scan", "recheck_begin_scan",
  "recheck_candidates", "recheck_commit_page", "recheck_warm_embeddings",
]);
const SCALAR_FNS = new Set(["recheck_client_names", "recheck_record_run", "recheck_note_error"]);
const rpcLog: Array<{ fn: string; args: Record<string, unknown> }> = [];
// A hook the scenarios use to make one call fail the way a lost connection or a
// refused page would: it returns an error INSTEAD of executing.
let rpcFault: ((fn: string, args: Record<string, unknown>) => { code: string; message: string } | null) | null = null;
type RpcResult = { data: unknown; error: { code: string; message: string } | null };
// A hook the scenarios use to do something on ANOTHER connection around one
// call: it is handed the real call and must make it. The call still executes
// against the migrated function.
let rpcAround: ((fn: string, args: Record<string, unknown>, call: () => Promise<RpcResult>) => Promise<RpcResult>) | null = null;

async function bridgeRpc(fn: string, args: Record<string, unknown>): Promise<RpcResult> {
  if (!TABLE_FNS.has(fn) && !SCALAR_FNS.has(fn)) throw new NeverRan(`unbridged rpc ${fn}`);
  rpcLog.push({ fn, args });
  const fault = rpcFault?.(fn, args);
  if (fault) return { data: null, error: fault };
  return rpcAround ? await rpcAround(fn, args, () => execRpc(fn, args)) : await execRpc(fn, args);
}
async function execRpc(fn: string, args: Record<string, unknown>): Promise<RpcResult> {
  const named = Object.entries(args).map(([k, v]) => {
    if (!/^[a-z_]+$/.test(k)) throw new NeverRan(`unexpected rpc argument name ${k}`);
    return `${k} => ${lit(k, v)}`;
  }).join(", ");
  const query = TABLE_FNS.has(fn)
    ? `select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)::text from public.${fn}(${named}) x`
    : `select to_jsonb(public.${fn}(${named}))::text`;
  const r = await psql(query);
  if (r.code === 0) return { data: JSON.parse(r.out.trim()), error: null };
  if (r.code === 1 || r.code === 3) {
    const m = /ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/.exec(r.err);
    if (!m) throw new NeverRan(`rpc ${fn} failed with no readable SQLSTATE (psql exit ${r.code}): ${r.err.trim().slice(0, 300)}`);
    if (INTERRUPTION_PREFIXES.some((p) => m[1].startsWith(p))) {
      throw new NeverRan(`rpc ${fn} was interrupted (SQLSTATE ${m[1]}: ${m[2].slice(0, 200)}); nothing is judged on it`);
    }
    return { data: null, error: { code: m[1], message: m[2] } };
  }
  throw new NeverRan(`rpc ${fn} could not execute (psql exit ${r.code}): ${r.err.trim().slice(0, 300)}`);
}
const db = { rpc: (fn: string, args: Record<string, unknown>) => bridgeRpc(fn, args) };

// ---------- assertions ----------
let passed = 0;
function bail(): never {
  say(`NEVER-RAN: ${neverRan[0]}`);
  Deno.exit(2);
}
function check(name: string, cond: boolean, detail = ""): void {
  if (neverRan.length > 0) bail();
  if (!cond) {
    say(`FAIL integration: ${name}${detail ? `: ${detail.replace(/\s+/g, " ").slice(0, 400)}` : ""}`);
    Deno.exit(1);
  }
  passed += 1;
  say(`PASS I ${name}`);
}
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  check(name, g === w, `got ${g}, want ${w}`);
}

// ---------- fixtures ----------
// Real time: items 30 days old, their thoughts spread over the days after, all
// with microseconds a JavaScript Date cannot hold.
const U = (prefix: string, n: number) => `${prefix.padEnd(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AT = (minutes: number) => `(date_trunc('second', now()) - interval '30 days' + interval '${minutes} minutes' + interval '123456 microseconds')`;
const short = (id: string) => id.slice(0, 8) + id.slice(-4);

async function thought(id: string, minutes: number, project: string | null, content: string, embedding: number[] | null = null) {
  await sql(`insert into public.thoughts (id, created_at, content, embedding, metadata) values (${quote(id)}, ${AT(minutes)}, ${quote(content)}, ${
    embedding ? quote("{" + embedding.join(",") + "}") : "NULL"
  }, ${project === null ? "'{}'" : quote(JSON.stringify({ project }))}::jsonb)`);
}
async function item(id: string, minutes: number, source: string | null, description: string) {
  await sql(`insert into public.action_items (id, description, status, source_thought_id, created_at) values (${quote(id)}, ${quote(description)}, 'open', ${
    source ? quote(source) : "NULL"
  }, ${AT(minutes)})`);
}
async function bulkThoughts(prefix: string, count: number, startMinute: number, project: string) {
  await sql(`insert into public.thoughts (id, created_at, content, metadata)
    select (${quote(prefix.padEnd(8, "0"))} || '-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
           ${AT(startMinute)} + (g - 1) * interval '1 minute', 'note ' || g, ${quote(JSON.stringify({ project }))}::jsonb
    from generate_series(1, ${count}) g`);
}
const scanState = (id: string) =>
  sql(`select concat_ws('|', case when recheck_scan_id is null then 'idle' else 'scanning' end,
         case when last_rechecked_at is null then 'never' else 'stamped' end,
         case when recheck_cursor_at is null then 'nocursor' else 'cursor' end) from public.action_items where id = ${quote(id)}`);
const decisions = (id: string) =>
  sql(`select coalesce(string_agg(concat_ws('/', outcome, coalesce(reason, '-'), coalesce(left(evidence_thought_id::text, 8) || right(evidence_thought_id::text, 4), '-')), ' '
         order by outcome, reason, evidence_thought_id), '') from public.auto_resolve_decisions where item_id = ${quote(id)} and layer = 'recheck'`);
// One item's recheck decision rows as "outcome/reason/evidence", sorted, and the
// same shape for the rows a dry run says it would write. The two are compared
// item by item (review finding F2): the dry run reports the rows a real run writes.
const rowKey = (outcome: string, reason: string | null, evidence: string | null) =>
  `${outcome}/${reason ?? "-"}/${evidence ? short(evidence) : "-"}`;
const decisionKeys = async (id: string): Promise<string[]> =>
  (await decisions(id)).split(" ").filter(Boolean).sort();
const wouldBeKeys = (s: RunSummary, id: string): string[] =>
  (s.would_be ?? []).filter((r) => r.item_id === id).map((r) => rowKey(r.outcome, r.reason, r.evidence_thought_id)).sort();
const decisionIds = async (id: string): Promise<string[]> =>
  (await sql(`select coalesce(string_agg(id::text, ' ' order by id), '') from public.auto_resolve_decisions where item_id = ${quote(id)} and layer = 'recheck'`)).split(" ").filter(Boolean);
const decisionKeysExcept = async (id: string, known: string[]): Promise<string[]> =>
  (await sql(`select coalesce(string_agg(concat_ws('/', outcome, coalesce(reason, '-'), coalesce(left(evidence_thought_id::text, 8) || right(evidence_thought_id::text, 4), '-')), ' '), '')
     from public.auto_resolve_decisions where item_id = ${quote(id)} and layer = 'recheck' and not (id::text = any(${quote("{" + known.join(",") + "}")}::text[]))`)).split(" ").filter(Boolean).sort();
const stateHash = () =>
  sql(`select md5(coalesce((select string_agg(to_jsonb(a)::text, '' order by a.id) from public.action_items a), '')
        || coalesce((select string_agg(to_jsonb(d)::text, '' order by d.id) from public.auto_resolve_decisions d), '')
        || coalesce((select string_agg(to_jsonb(r)::text, '' order by r.id) from public.action_item_recheck_runs r), ''))`);

// ---------- the stand-in model ----------
// What it was shown, per item text, so "sent exactly once" can be asserted.
const shown = new Map<string, string[]>();
let llmCalls = 0;
let llmFault: ((itemText: string, callForItem: number) => string | Error | null) | null = null;
let llmSideEffect: ((itemText: string) => Promise<void>) | null = null;
const callsPerItem = new Map<string, number>();
const llm: RecheckLlm = async (messages) => {
  llmCalls += 1;
  const user = messages[1].content;
  const itemText = /^ITEM: (.*)$/m.exec(user)?.[1] ?? "";
  const n = (callsPerItem.get(itemText) ?? 0) + 1;
  callsPerItem.set(itemText, n);
  const ids = [...user.matchAll(/^THOUGHT ([0-9a-f-]{36}) /gm)].map((m) => m[1]);
  shown.set(itemText, [...(shown.get(itemText) ?? []), ...ids]);
  if (llmSideEffect) await llmSideEffect(itemText);
  const fault = llmFault?.(itemText, n);
  if (fault instanceof Error) throw fault;
  if (typeof fault === "string") return fault;
  // A thought whose text carries "DONE: <sentence>." is named with that sentence.
  for (const block of user.split("\n-----\n")) {
    const id = /^THOUGHT ([0-9a-f-]{36}) /m.exec(block)?.[1];
    const done = /DONE: ([^.]*\.)/.exec(block);
    if (id && done) return JSON.stringify({ verdict: "done", thought_id: id, quote: done[1] });
    if (block.includes("INVENT")) return JSON.stringify({ verdict: "done", thought_id: U("dead", 1), quote: "invented" });
  }
  return '{"verdict":"open","thought_id":null,"quote":null}';
};
const run = (dryRun: boolean, limit = 40): Promise<RunSummary> =>
  runRecheck(db, llm, { dryRun, limit, concurrency: 3, log: (l) => logs.push(l) });

try {
  // ----- fixtures -----
  await sql(`insert into public.clients (name) values ('Alicia Brennan'), ('Morgan Lee')`);
  // Paging counts: 40, 41, 49 and 50 candidates.
  const counts = [40, 41, 49, 50];
  const pagingItem = (n: number) => U(`c0${n}`, 1);
  for (const n of counts) {
    await thought(U(`f0${n}`, 1), 0, `p${n}`, "source");
    await item(pagingItem(n), 1, U(`f0${n}`, 1), `paging item ${n}`);
    await bulkThoughts(`b0${n}`, n, 10, `p${n}`);
  }
  // A proposal, and a thought id the model invents on page 2.
  const iProp = U("a001", 1);
  await thought(U("f001", 1), 0, "prop", "source", [1, 0, 0]);
  await item(iProp, 1, U("f001", 1), "rotate the Railway deploy token");
  await bulkThoughts("b001", 9, 10, "prop");
  await thought(U("d001", 1), 30, "prop", "Morning notes. DONE: Rotated the Railway deploy token this morning. Then lunch.");
  // The tenth and eleventh candidates share one instant.
  await thought(U("d001", 2), 31, "prop", "tie one");
  await thought(U("d001", 3), 31, "prop", "tie two INVENT");
  // In the window, no shared metadata, but nearest by embedding.
  await thought(U("d001", 4), 40, "elsewhere", "embedding neighbour", [0.9, 0.1, 0]);
  // A page-2 failure after page 1 committed (page 1 proposes).
  const iFail = U("a002", 1);
  await thought(U("f002", 1), 0, "fail", "source");
  await item(iFail, 1, U("f002", 1), "renew the vault licence key");
  // Its evidence is a quote of 756 characters: 720 of preamble, then the sentence
  // that says the item is done (review finding F1: the stored quote must keep it).
  const LONG_QUOTE = `${"background detail ".repeat(40)}renewed the vault licence key today.`;
  await thought(U("d002", 1), 5, "fail", `DONE: ${LONG_QUOTE}`);
  await bulkThoughts("b002", 14, 10, "fail");
  // A source with no embedding (the default here) and no source at all.
  const iNoSource = U("a003", 1);
  await item(iNoSource, 1, null, "an item with no source thought");
  // A thought captured while the scan is running.
  const iMid = U("a004", 1);
  await thought(U("f004", 1), 0, "mid", "source");
  await item(iMid, 1, U("f004", 1), "publish the midsummer flash sheet");
  await thought(U("d004", 1), 5, "mid", "first note");
  // A client-shaped item whose evidence does not name the client.
  const iClient = U("a005", 1);
  await thought(U("f005", 1), 0, null, "source");
  await sql(`update public.thoughts set metadata = '{"people": ["Alicia Brennan"]}' where id = ${quote(U("f005", 1))}`);
  await item(iClient, 1, U("f005", 1), "Send Alicia Brennan the deposit link");
  await sql(`insert into public.thoughts (id, created_at, content, metadata) values (${quote(U("d005", 1))}, ${AT(5)}, 'DONE: Sent the deposit link.', '{"people": ["Alicia Brennan"]}')`);
  // The canary, old and open.
  const iCanary = U("a006", 1);
  await thought(U("f006", 1), 0, "canary", "source");
  await item(iCanary, 1, U("f006", 1), "PERPETUAL auto-resolve canary: never complete this");
  await thought(U("d006", 1), 5, "canary", "DONE: PERPETUAL auto-resolve canary never complete this.");
  // Too new to be eligible.
  await sql(`insert into public.action_items (id, description, source_thought_id, created_at) values (${quote(U("a007", 1))}, 'a new item', ${quote(U("f001", 1))}, now() - interval '2 days')`);

  // ----- the dry run: reads and judges, writes nothing -----
  const before = await stateHash();
  llmFault = null;
  const dry = await run(true);
  check("dry run: the database is byte-identical afterwards (no begin, no commit, no receipt)", await stateHash() === before);
  const writes = rpcLog.filter((c) => ["recheck_begin_scan", "recheck_commit_page", "recheck_record_run", "recheck_note_error"].includes(c.fn));
  eq("dry run: no write RPC was called", writes.map((c) => c.fn), []);
  eq("dry run: nine items are eligible; the canary and the two-day-old item are not", dry.items_eligible, 9);
  // Cold-start correction: the warm-up read runs before any plan, for the nine
  // items (the canary is not listed), and finds the one window that has a
  // source embedding: the proposing item's, whose only embedded thought in the
  // window is the neighbour.
  const warmCalls = rpcLog.filter((c) => c.fn === "recheck_warm_embeddings");
  eq("dry run: one warm-up call, before every plan, listing the nine eligible items and not the canary; it read the one embedded thought in a window and was complete",
    [warmCalls.length, rpcLog.findIndex((c) => c.fn === "recheck_warm_embeddings") < rpcLog.findIndex((c) => c.fn === "recheck_plan_scan"),
      (warmCalls[0]?.args.p_item_ids as string[]).length, (warmCalls[0]?.args.p_item_ids as string[]).includes(iCanary),
      [dry.warmup.chunks, dry.warmup.rows, dry.warmup.complete, dry.warmup.stopped, dry.warmup.error], dry.timeout_retries],
    [1, true, 9, false, [1, 1, true, null, null], 0]);
  eq("dry run: status and the would-be incomplete scan (50 candidates)", [dry.status, dry.recheck_incomplete, dry.incomplete_ids], ["ok", 1, [pagingItem(50).slice(0, 8)]]);
  const wouldBe = (dry.would_be ?? []).map((r) => `${short(r.item_id)}:${r.outcome}/${r.reason ?? "-"}/${r.evidence_thought_id ? short(r.evidence_thought_id) : "-"}`).sort();
  eq("dry run: the would-be rows, the final none_found of every scan that would finish without a proposal included", wouldBe, [
    `${short(pagingItem(40))}:no_evidence/none_found/-`,
    `${short(pagingItem(41))}:no_evidence/none_found/-`,
    `${short(pagingItem(49))}:no_evidence/none_found/-`,
    `${short(iProp)}:no_evidence/thought_not_in_page/-`,
    `${short(iProp)}:proposed/-/${short(U("d001", 1))}`,
    `${short(iFail)}:proposed/-/${short(U("d002", 1))}`,
    `${short(iNoSource)}:no_evidence/none_found/-`,
    `${short(iMid)}:no_evidence/none_found/-`,
    `${short(iClient)}:no_evidence/none_found/-`,
    `${short(iClient)}:no_evidence/scope_mismatch/${short(U("d005", 1))}`,
  ].sort());
  eq("dry run: the summary counts the none_found rows it lists", [dry.rows.none_found, (dry.would_be ?? []).filter((r) => r.reason === "none_found").length], [6, 6]);
  eq("dry run: every would-be row was written to the run log as JSON, none_found rows included",
    logs.filter((l) => l.startsWith("recheck dry-run row ")).map((l) => { const r = JSON.parse(l.slice("recheck dry-run row ".length)); return `${short(r.item_id)}:${r.outcome}/${r.reason ?? "-"}/${r.evidence_thought_id ? short(r.evidence_thought_id) : "-"}`; }).sort(),
    wouldBe);
  // Per item (plan Step 1): an item with no source thought, and a source thought
  // with no embedding. Every source here but f001's has a null embedding.
  const dryPlan = (id: string) => rpcLog.filter((c) => c.fn === "recheck_plan_scan" && c.args.p_item_id === id).map((c) => c.args.p_query_embedding);
  const dryPages = (id: string) => rpcLog.filter((c) => c.fn === "recheck_candidates" && c.args.p_item_id === id).map((c) => c.args.p_embedding_ids);
  eq("dry run: the item with no source thought plans on a null embedding, reads one empty page with an empty frozen set, and reports an empty scan: its one none_found row",
    [await sql(`select (source_thought_id is null)::text from public.action_items where id = ${quote(iNoSource)}`), dryPlan(iNoSource), dryPages(iNoSource), wouldBeKeys(dry, iNoSource), shown.has("an item with no source thought")],
    ["true", [null], [[]], ["no_evidence/none_found/-"], false]);
  eq("dry run: an item whose source thought has no embedding plans on a null embedding, scans its metadata candidates with an empty frozen set, and reports its rows",
    [await sql(`select (t.id is not null and t.embedding is null)::text from public.action_items a join public.thoughts t on t.id = a.source_thought_id where a.id = ${quote(iClient)}`),
      dryPlan(iClient), dryPages(iClient), wouldBeKeys(dry, iClient), shown.get("Send Alicia Brennan the deposit link")],
    ["true", [null], [[]], [`no_evidence/none_found/-`, `no_evidence/scope_mismatch/${short(U("d005", 1))}`], [U("d005", 1)]]);
  check("dry run: the canary was never sent to the model", !shown.has("PERPETUAL auto-resolve canary: never complete this"));
  const dryKeys = new Map<string, string[]>();
  const eligibleNine = [...counts.map(pagingItem), iProp, iFail, iNoSource, iMid, iClient];
  for (const id of eligibleNine) dryKeys.set(id, wouldBeKeys(dry, id));

  // ----- run 1: page 2 of one item fails; a thought is captured mid-scan -----
  rpcLog.length = 0; shown.clear(); callsPerItem.clear(); llmCalls = 0;
  llmFault = (itemText, n) => itemText === "renew the vault licence key" && n === 2 ? new Error("OpenRouter 503 (injected)") : null;
  let midInserted = false;
  llmSideEffect = async (itemText) => {
    if (itemText === "publish the midsummer flash sheet" && !midInserted) {
      midInserted = true;
      await sql(`insert into public.thoughts (id, created_at, content, metadata) values (${quote(U("d004", 2))}, now(), 'captured while the scan ran', '{"project": "mid"}')`);
    }
  };
  const r1 = await run(false);
  llmSideEffect = null;
  eq("run 1: partial, one item errored, the errored item and the 50-candidate item still mid-scan",
    [r1.status, r1.items_eligible, r1.items_errored, r1.recheck_incomplete, [...r1.incomplete_ids].sort()],
    ["partial", 9, 1, 2, [iFail.slice(0, 8), pagingItem(50).slice(0, 8)].sort()]);
  eq("run 1: no stale commit anywhere: every cursor made the round trip with its microseconds",
    r1.errors, [{ item: iFail.slice(0, 8), message: "OpenRouter 503 (injected)" }]);
  eq("run 1: the one item the run gave up on carries the error stamp, written through recheck_note_error; no other item does, and the dry run before it stamped none",
    [rpcLog.filter((c) => c.fn === "recheck_note_error").map((c) => c.args.p_item_id), [r1.items_error_noted, r1.error_notes_refused, r1.error_notes_failed],
      await sql(`select coalesce(string_agg(id::text, ' ' order by id), '') from public.action_items where recheck_last_error_at is not null`),
      await sql(`select (recheck_last_error_at > now() - interval '5 minutes')::text from public.action_items where id = ${quote(iFail)}`)],
    [[iFail], [1, 0, 0], iFail, "true"]);

  for (const n of [40, 41, 49]) {
    eq(`run 1: ${n} candidates finalise in this run: idle, stamped, one none_found`,
      [await scanState(pagingItem(n)), await decisions(pagingItem(n))], ["idle|stamped|cursor", "no_evidence/none_found/-"]);
    eq(`run 1: ${n} candidates took five commits`, rpcLog.filter((c) => c.fn === "recheck_commit_page" && c.args.p_item_id === pagingItem(n)).length, 5);
    const seen = shown.get(`paging item ${n}`) ?? [];
    eq(`run 1: each of the ${n} candidates was sent to the model exactly once`, [seen.length, new Set(seen).size], [n, n]);
  }
  eq("run 1: 50 candidates: five full pages, scan still active, not stamped, no row yet",
    [await scanState(pagingItem(50)), await decisions(pagingItem(50)), rpcLog.filter((c) => c.fn === "recheck_commit_page" && c.args.p_item_id === pagingItem(50)).length],
    ["scanning|never|cursor", "", 5]);

  eq("run 1: the proposal landed with its evidence thought, and the invented id became thought_not_in_page with no evidence",
    await decisions(iProp), `no_evidence/thought_not_in_page/- proposed/-/${short(U("d001", 1))}`);
  eq("run 1: the proposal row carries the verbatim quote and a score",
    await sql(`select quote || '|' || (score >= 0.4)::text from public.auto_resolve_decisions where item_id = ${quote(iProp)} and outcome = 'proposed'`),
    "Rotated the Railway deploy token this morning.|true");
  const propSeen = shown.get("rotate the Railway deploy token") ?? [];
  eq("run 1: thirteen candidates sent once each, including the embedding neighbour with no shared metadata and both thoughts on the shared instant",
    [propSeen.length, new Set(propSeen).size, propSeen.includes(U("d001", 4)), propSeen.indexOf(U("d001", 2)) + 1 === propSeen.indexOf(U("d001", 3))],
    [13, 13, true, true]);
  eq("run 1: the proposing item is final", await scanState(iProp), "idle|stamped|cursor");

  eq("run 1: the failed item's page 1 is committed (its proposal is there), its scan is active and it is not stamped",
    [await scanState(iFail), await decisions(iFail)], ["scanning|never|cursor", `proposed/-/${short(U("d002", 1))}`]);
  eq("run 1: an accepted quote longer than 500 characters is stored whole, with the sentence that says the item is done, and the digest's read returns it whole",
    [LONG_QUOTE.length,
      await sql(`select (quote = ${quote(LONG_QUOTE)})::text || '|' || (score = 1)::text from public.auto_resolve_decisions where item_id = ${quote(iFail)} and outcome = 'proposed'`),
      await sql(`select (quote = ${quote(LONG_QUOTE)})::text from public.recheck_pending_proposals(200) where item_id = ${quote(iFail)}`)],
    [756, "true|true", "true"]);
  eq("run 1: the failed item committed exactly one page", rpcLog.filter((c) => c.fn === "recheck_commit_page" && c.args.p_item_id === iFail).length, 1);
  const failCursor = await sql(`select recheck_cursor_at::text || '|' || recheck_cursor_id from public.action_items where id = ${quote(iFail)}`);

  eq("run 1: an item with no source thought begins on a null embedding, scans empty and finalises with one none_found",
    [await scanState(iNoSource), await decisions(iNoSource), rpcLog.filter((c) => c.fn === "recheck_begin_scan" && c.args.p_item_id === iNoSource).map((c) => c.args.p_query_embedding)],
    ["idle|stamped|cursor", "no_evidence/none_found/-", [null]]);
  check("run 1: a source WITH an embedding sends it to begin as the text the database returned",
    typeof rpcLog.find((c) => c.fn === "recheck_begin_scan" && c.args.p_item_id === iProp)?.args.p_query_embedding === "string");

  eq("run 1: the thought captured mid-scan was not sent; the scan ended at its fixed upper bound",
    [shown.get("publish the midsummer flash sheet"), await scanState(iMid)], [[U("d004", 1)], "idle|stamped|cursor"]);
  eq("run 1: a client-shaped item whose evidence does not name the client is a scope_mismatch, then none_found",
    await decisions(iClient), `no_evidence/none_found/- no_evidence/scope_mismatch/${short(U("d005", 1))}`);
  eq("run 1: the canary has no decision row and was never sent",
    [await decisions(iCanary), shown.has("PERPETUAL auto-resolve canary: never complete this"), rpcLog.some((c) => c.args.p_item_id === iCanary)], ["", false, false]);
  eq("run 1: nothing changed any item's status",
    await sql(`select string_agg(distinct status, ',') from public.action_items`), "archived,open");
  eq("run 1: one receipt, partial, with the counts",
    await sql(`select concat_ws('|', count(*), max(status), max(summary->>'recheck_incomplete'), max(summary->>'items_errored'), bool_and(summary ? 'would_be')) from public.action_item_recheck_runs`),
    "1|partial|2|1|f");
  eq("run 1: the pending list the digest reads holds the two proposals",
    await sql(`select string_agg(left(item_id::text, 8) || right(item_id::text, 4), ' ' order by item_id) from public.recheck_pending_proposals(200)`),
    `${short(iProp)} ${short(iFail)}`);

  // The dry run said, item by item, what this run then wrote. (The failed item
  // stopped after page 1, whose row is the only one the dry run listed for it;
  // the 50-candidate item wrote nothing and the dry run listed nothing.)
  for (const id of eligibleNine) {
    eq(`run 1: item ${short(id)} holds exactly the rows the dry run reported for it`, await decisionKeys(id), dryKeys.get(id));
  }

  // ----- the page boundary, through the same named-argument bridge (review finding F3) -----
  // The failed item's scan is in progress with page 2 unread. A FINAL commit that
  // names the scan's upper bound as its cursor, with no rows and the correct
  // expected cursor, must be refused: it would finalise over candidates no page read.
  const jumpScan = (await sql(`select concat_ws('|', recheck_scan_id, recheck_cursor_at::text, recheck_cursor_id, recheck_scan_upper_at::text, recheck_scan_upper_id) from public.action_items where id = ${quote(iFail)}`)).split("|");
  const unread = await sql(`select count(*) from public.recheck_candidates(${quote(iFail)}, ${quote(jumpScan[1])}, ${quote(jumpScan[2])}, ${quote(jumpScan[3])}, ${quote(jumpScan[4])}, '{}', 50)`);
  const beforeJump = await stateHash();
  const jump = await db.rpc("recheck_commit_page", {
    p_item_id: iFail, p_scan_id: jumpScan[0], p_expected_cursor_at: jumpScan[1], p_expected_cursor_id: jumpScan[2],
    p_cursor_at: jumpScan[3], p_cursor_id: jumpScan[4], p_rows: [], p_final: true,
  });
  eq("page boundary: with five candidates unread, a final commit that jumps to the scan's upper bound is refused as cursor_not_in_page",
    [unread, jump.data, jump.error?.code, String(jump.error?.message ?? "").startsWith("cursor_not_in_page")], ["5", null, "RC006", true]);
  check("page boundary: the refused jump wrote nothing; the scan is still in progress at page 1's cursor",
    await stateHash() === beforeJump && await scanState(iFail) === "scanning|never|cursor");

  // ----- a dry run BETWEEN run 1 and run 2 (review finding F2) -----
  // Two scans are in progress: the failed item's, whose page 1 PROPOSED, and the
  // 50-candidate item's, which proposed nothing. The dry run must report what
  // run 2 then writes: no none_found for the first, exactly one for the second.
  rpcLog.length = 0; shown.clear(); callsPerItem.clear(); llmCalls = 0; llmFault = null;
  const logMark = logs.length;
  const beforeMid = await stateHash();
  const idsBefore = new Map<string, string[]>();
  for (const id of [iFail, pagingItem(50)]) idsBefore.set(id, await decisionIds(id));
  const dryMid = await run(true);
  check("resumed dry run: the database is byte-identical afterwards", await stateHash() === beforeMid);
  eq("resumed dry run: no write RPC was called",
    rpcLog.filter((c) => ["recheck_begin_scan", "recheck_commit_page", "recheck_record_run", "recheck_note_error"].includes(c.fn)).map((c) => c.fn), []);
  eq("resumed dry run: the two scans in progress are eligible and both would finish",
    [dryMid.status, dryMid.items_eligible, dryMid.items_final, dryMid.recheck_incomplete], ["ok", 2, 2, 0]);
  eq("resumed dry run: it resumed the failed item from page 1's stored cursor and read page 2 only",
    [rpcLog.filter((c) => c.fn === "recheck_candidates" && c.args.p_item_id === iFail).length, (shown.get("renew the vault licence key") ?? []).length,
      (shown.get("renew the vault licence key") ?? []).includes(U("d002", 1))],
    [1, 5, false]);
  eq("resumed dry run: one none_found in all, for the scan that never proposed; none for the scan whose earlier page proposed",
    [dryMid.rows.none_found, wouldBeKeys(dryMid, iFail), wouldBeKeys(dryMid, pagingItem(50))], [1, [], ["no_evidence/none_found/-"]]);
  eq("resumed dry run: its would-be rows are in the run log as JSON",
    logs.slice(logMark).filter((l) => l.startsWith("recheck dry-run row ")).map((l) => JSON.parse(l.slice("recheck dry-run row ".length)).item_id + "/" + JSON.parse(l.slice("recheck dry-run row ".length)).reason),
    [`${pagingItem(50)}/none_found`]);

  // ----- run 2: the two unfinished scans resume, first in line -----
  rpcLog.length = 0; shown.clear(); callsPerItem.clear(); llmCalls = 0; llmFault = null;
  const r2 = await run(false);
  for (const id of [iFail, pagingItem(50)]) {
    eq(`run 2: the rows it wrote for ${short(id)} are exactly the rows the dry run before it reported`,
      await decisionKeysExcept(id, idsBefore.get(id) ?? []), wouldBeKeys(dryMid, id));
  }
  eq("run 2: it wrote exactly one none_found, as the dry run before it counted",
    [r2.rows.none_found, dryMid.rows.none_found], [1, 1]);
  eq("run 2: only the two scans in progress are eligible, and both finish", [r2.status, r2.items_eligible, r2.items_final, r2.recheck_incomplete], ["ok", 2, 2, 0]);
  const failCommits = rpcLog.filter((c) => c.fn === "recheck_commit_page" && c.args.p_item_id === iFail);
  eq("run 2: the failed item resumes from page 1's cursor and reprocesses page 2 only",
    [failCommits.length, `${failCommits[0]?.args.p_expected_cursor_at}`.length > 0, failCommits[0]?.args.p_final,
      await sql(`select (${quote(String(failCommits[0]?.args.p_expected_cursor_at))}::timestamptz::text || '|' || ${quote(String(failCommits[0]?.args.p_expected_cursor_id))}) = ${quote(failCursor)}`)],
    [1, true, true, "t"]);
  const failSeen = shown.get("renew the vault licence key") ?? [];
  eq("run 2: page 2's five thoughts were sent, page 1's ten were not sent again", [failSeen.length, failSeen.includes(U("d002", 1))], [5, false]);
  eq("run 2: its final wrote no none_found, because page 1 proposed in the earlier run",
    [await scanState(iFail), await decisions(iFail)], ["idle|stamped|cursor", `proposed/-/${short(U("d002", 1))}`]);
  eq("run 2: 50 candidates finalise on the empty sixth page, with no model call for it",
    [await scanState(pagingItem(50)), await decisions(pagingItem(50)), shown.has("paging item 50"),
      rpcLog.filter((c) => c.fn === "recheck_commit_page" && c.args.p_item_id === pagingItem(50)).map((c) => [c.args.p_final, c.args.p_cursor_at])],
    ["idle|stamped|cursor", "no_evidence/none_found/-", false, [[true, null]]]);

  // ----- run 3: nothing is eligible until a week has passed -----
  rpcLog.length = 0;
  const r3 = await run(false);
  eq("run 3: nothing eligible the same night: no begin, and a clean receipt", [r3.status, r3.items_eligible, rpcLog.filter((c) => c.fn === "recheck_begin_scan").length], ["ok", 0, 0]);

  // ----- a week later: the mid-scan thought is the next scan's -----
  await sql(`update public.action_items set last_rechecked_at = now() - interval '8 days' where id = ${quote(iMid)}`);
  rpcLog.length = 0; shown.clear(); callsPerItem.clear();
  const r4 = await run(false);
  eq("a week later: the one item re-checked 8 days ago is eligible, and its scan sees exactly the thought captured mid-scan",
    [r4.items_eligible, r4.items_final, shown.get("publish the midsummer flash sheet")], [1, 1, [U("d004", 2)]]);
  eq("the run receipts: four real runs, the two dry runs wrote none", await sql(`select count(*) from public.action_item_recheck_runs`), "4");

  // ----- partial exits: a dry run and a real run stopped at the same point (re-review 1, P2) -----
  // A dry run that leaves an item part-way must report the scan a real run
  // stopped at the same point leaves in progress. Two stops (the time budget
  // after one page; a model answer that is not JSON on the second page), each on
  // a fresh scan and then on that same scan resumed. Each dry run goes first and
  // must leave the database untouched; the real run then starts from that same
  // state, and the dry run's count and ids are compared with what the database
  // then holds.
  type Stop = "budget" | "model-error";
  const WRITE_FNS = ["recheck_begin_scan", "recheck_commit_page", "recheck_record_run", "recheck_note_error"];
  const scansInProgress = async (): Promise<string[]> =>
    (await sql(`select coalesce(string_agg(left(id::text, 8), ' ' order by id), '') from public.action_items where recheck_scan_id is not null`)).split(" ").filter(Boolean);
  // Candidates the item's scan in progress has not read yet, from its stored cursor to its stored upper bound.
  const unreadCandidates = (id: string) =>
    sql(`select (select count(*) from public.recheck_candidates(a.id, coalesce(a.recheck_cursor_at, a.created_at), a.recheck_cursor_id, a.recheck_scan_upper_at, a.recheck_scan_upper_id, a.recheck_scan_embedding_ids, 50))::text
         from public.action_items a where a.id = ${quote(id)} and a.recheck_scan_id is not null`);
  const stoppedRun = async (dryRun: boolean, stop: Stop | null, itemText: string): Promise<RunSummary> => {
    rpcLog.length = 0; shown.clear(); callsPerItem.clear(); llmCalls = 0;
    // The run's clock: real time, pushed an hour ahead once the model has
    // answered for the item's first page. The budget itself is far beyond any
    // real elapsed time, so only that push can end it.
    let skew = 0;
    llmSideEffect = stop === "budget" ? (t) => { if (t === itemText) skew = 3_600_000; return Promise.resolve(); } : null;
    llmFault = stop === "model-error" ? (t, n) => (t === itemText && n === 2 ? "it looks done to me" : null) : null;
    const s = await runRecheck(db, llm, { dryRun, limit: 40, concurrency: 3, budgetMs: 600_000, now: () => Date.now() + skew, log: (l) => logs.push(l) });
    llmSideEffect = null; llmFault = null;
    return s;
  };
  const stopShape = (s: RunSummary, id: string, text: string) => [
    s.status, s.items_eligible, s.pages, s.llm_calls, s.items_budget_stopped, s.items_errored, s.items_final,
    rpcLog.filter((c) => c.fn === "recheck_candidates" && c.args.p_item_id === id).length, (shown.get(text) ?? []).length,
  ];
  const partialPair = async (label: string, stop: Stop, id: string, text: string, want: { shape: unknown[]; unread: string }) => {
    const before = await stateHash();
    const dryS = await stoppedRun(true, stop, text);
    const dryShape = stopShape(dryS, id, text);
    check(`${label}: the dry run leaves the database byte-identical`, await stateHash() === before);
    eq(`${label}: the dry run calls no write RPC`, rpcLog.filter((c) => WRITE_FNS.includes(c.fn)).map((c) => c.fn), []);
    const realS = await stoppedRun(false, stop, text);
    const realShape = stopShape(realS, id, text);
    eq(`${label}: the real run commits exactly one page and stops; in the database its scan is still in progress, with candidates unread`,
      [realShape, rpcLog.filter((c) => c.fn === "recheck_commit_page" && c.args.p_item_id === id).map((c) => c.args.p_final), await scanState(id), await unreadCandidates(id), await scansInProgress()],
      [want.shape, [false], "scanning|never|cursor", want.unread, [id.slice(0, 8)]]);
    eq(`${label}: the dry run stopped at the same point (pages, model calls, exit, pages read, thoughts shown)`, dryShape, realShape);
    if (stop === "model-error") {
      eq(`${label}: both report the same error for the item`, [dryS.errors, realS.errors],
        [[{ item: id.slice(0, 8), message: "the model's answer was not the JSON object asked for" }], [{ item: id.slice(0, 8), message: "the model's answer was not the JSON object asked for" }]]);
    }
    eq(`${label}: the dry run's recheck_incomplete and incomplete_ids equal the real run's`,
      [dryS.recheck_incomplete, dryS.incomplete_ids], [realS.recheck_incomplete, realS.incomplete_ids]);
    eq(`${label}: and they are the scans the database holds in progress after the real run`,
      [dryS.recheck_incomplete, dryS.incomplete_ids], [1, await scansInProgress()]);
  };
  const finishPair = async (label: string, id: string, text: string) => {
    const before = await stateHash();
    const dryS = await stoppedRun(true, null, text);
    check(`${label}: the dry run leaves the database byte-identical`, await stateHash() === before);
    eq(`${label}: the dry run calls no write RPC`, rpcLog.filter((c) => WRITE_FNS.includes(c.fn)).map((c) => c.fn), []);
    const realS = await stoppedRun(false, null, text);
    eq(`${label}: the real run finishes the scan: idle and stamped in the database, one none_found, no scan in progress anywhere`,
      [realS.status, realS.items_eligible, realS.items_final, realS.recheck_incomplete, realS.incomplete_ids, await scanState(id), await decisions(id), await scansInProgress()],
      ["ok", 1, 1, 0, [], "idle|stamped|cursor", "no_evidence/none_found/-", []]);
    eq(`${label}: the dry run before it reported the scan as finishing: no scan in progress, as the database then shows`,
      [dryS.status, dryS.items_final, dryS.recheck_incomplete, dryS.incomplete_ids, wouldBeKeys(dryS, id)],
      ["ok", 1, realS.recheck_incomplete, await scansInProgress(), ["no_evidence/none_found/-"]]);
  };
  const partialItem = async (n: number, project: string, description: string): Promise<string> => {
    const id = U(`a00${n}`, 1);
    await thought(U(`f00${n}`, 1), 0, project, "source");
    await item(id, 1, U(`f00${n}`, 1), description);
    // 25 candidates: three pages (10, 10, 5), so one page in, a full page is still unread.
    await bulkThoughts(`b00${n}`, 25, 10, project);
    return id;
  };
  eq("partial exits: no scan is in progress before the scenarios", await scansInProgress(), []);

  const budgetText = "check the budget stop";
  const iBudget = await partialItem(8, "budget", budgetText);
  await partialPair("budget stop, fresh scan", "budget", iBudget, budgetText,
    { shape: ["partial", 1, 1, 1, 1, 0, 0, 1, 10], unread: "15" });
  await partialPair("budget stop, resumed scan", "budget", iBudget, budgetText,
    { shape: ["partial", 1, 1, 1, 1, 0, 0, 1, 10], unread: "5" });
  await finishPair("after the budget stops, the resumed scan's last page", iBudget, budgetText);

  const errorText = "check the model error stop";
  const iModelError = await partialItem(9, "modelerror", errorText);
  await partialPair("invalid model JSON on page two, fresh scan", "model-error", iModelError, errorText,
    { shape: ["partial", 1, 1, 2, 0, 1, 0, 2, 20], unread: "15" });
  await partialPair("invalid model JSON on page two, resumed scan", "model-error", iModelError, errorText,
    { shape: ["partial", 1, 1, 2, 0, 1, 0, 2, 15], unread: "5" });
  await finishPair("after the model errors, the resumed scan's last page", iModelError, errorText);
  // ----- cold-start correction: an item that errors before its scan begins does not keep the head of the queue -----
  // Three never-re-checked items, oldest first: X1, X2, X3. X1's begin is
  // cancelled by the statement timeout (injected at the bridge, as PostgREST
  // would report it) on the first night. Each night runs ONE item (limit 1), so
  // the item at the head of recheck_eligible_items is the item that runs.
  eq("starvation: nothing is eligible before the scenario", (await run(true)).items_eligible, 0);
  const xs = [1, 2, 3].map((n) => U(`a01${n}`, 1));
  for (const [k, id] of xs.entries()) {
    await thought(U(`f01${k + 1}`, 1), 0, `x${k + 1}`, "source");
    await item(id, 1 + k, U(`f01${k + 1}`, 1), `starvation item ${k + 1}`);
    await thought(U(`d01${k + 1}`, 1), 20, `x${k + 1}`, "a note");
  }
  const TIMEOUT_FAULT = { code: "57014", message: "canceling statement due to statement timeout" };
  const night = async (dryRun: boolean, failing: string | null): Promise<RunSummary> => {
    rpcLog.length = 0; shown.clear(); callsPerItem.clear(); llmCalls = 0; llmFault = null;
    rpcFault = (fn, args) => (failing && (fn === "recheck_begin_scan" || fn === "recheck_plan_scan") && args.p_item_id === failing ? TIMEOUT_FAULT : null);
    const s = await run(dryRun, 1);
    rpcFault = null;
    return s;
  };
  const head = () => rpcLog.filter((c) => c.fn === "recheck_source_embedding").map((c) => c.args.p_item_id);
  const stamps = () => sql(`select coalesce(string_agg(left(id::text, 8), ' ' order by id), '') from public.action_items where recheck_last_error_at is not null and id = any(${quote("{" + xs.join(",") + "}")}::uuid[])`);

  // A dry run meets the same timeout: it reports it, writes nothing, and the same item is still first afterwards.
  const beforeDryNight = await stateHash();
  const dn = await night(true, xs[0]);
  eq("starvation, dry run: the oldest item is at the head; its plan is cancelled twice (one retry) and the item is reported as an error",
    [head(), rpcLog.filter((c) => c.fn === "recheck_plan_scan").length, dn.status, dn.items_errored, dn.timeout_retries, dn.errors],
    [[xs[0]], 2, "partial", 1, 1, [{ item: xs[0].slice(0, 8), message: "recheck_plan_scan 57014: canceling statement due to statement timeout" }]]);
  check("starvation, dry run: nothing was written, the error stamp included", await stateHash() === beforeDryNight && rpcLog.every((c) => !WRITE_FNS.includes(c.fn)));
  const dn2 = await night(true, null);
  eq("starvation, dry run: with no stamp written the same item is first again", [head(), dn2.items_final], [[xs[0]], 1]);

  // Night 1, real: X1 errors before any scan begins and is stamped.
  const n1 = await night(false, xs[0]);
  eq("starvation, night 1: the oldest item is at the head, its begin is cancelled twice, no scan began, and the receipt says partial with the error",
    [head(), rpcLog.filter((c) => c.fn === "recheck_begin_scan").length, n1.status, n1.items_errored, n1.recheck_incomplete, n1.timeout_retries, n1.items_error_noted,
      await scanState(xs[0]), await decisions(xs[0]),
      await sql(`select status || '|' || (summary->>'items_errored') || '|' || (summary->>'items_error_noted') || '|' || (summary->>'timeout_retries') || '|' || (summary->'errors'->0->>'message') from public.action_item_recheck_runs order by started_at desc, finished_at desc limit 1`)],
    [[xs[0]], 2, "partial", 1, 0, 1, 1, "idle|never|nocursor", "",
      "partial|1|1|1|recheck_begin_scan 57014: canceling statement due to statement timeout"]);
  eq("starvation, night 1: the item is stamped and nothing else about it changed", await stamps(), xs[0].slice(0, 8));
  // Night 2: the timeout would hit X1 again, but X1 is no longer first.
  const n2 = await night(false, xs[0]);
  eq("starvation, night 2: the next item is at the head and finishes; the item that errored was not tried and did not error again",
    [head(), n2.status, n2.items_final, n2.items_errored, await scanState(xs[1]), await scanState(xs[0])],
    [[xs[1]], "ok", 1, 0, "idle|stamped|cursor", "idle|never|nocursor"]);
  const n3 = await night(false, xs[0]);
  eq("starvation, night 3: the third item is at the head and finishes", [head(), n3.status, n3.items_final, await scanState(xs[2])], [[xs[2]], "ok", 1, "idle|stamped|cursor"]);
  // Night 4: X1 is the only eligible item left, so it is tried again; the cache is warm by now.
  const n4 = await night(false, null);
  eq("starvation, night 4: the item that errored is retried on a later night and finishes: idle, stamped by the final commit, one none_found",
    [head(), n4.status, n4.items_final, n4.items_errored, n4.timeout_retries, await scanState(xs[0]), await decisions(xs[0])],
    [[xs[0]], "ok", 1, 0, 0, "idle|stamped|cursor", "no_evidence/none_found/-"]);
  eq("starvation: after it finished nothing is eligible, though its error stamp is still on the row", [(await night(true, null)).items_eligible, await stamps()], [0, xs[0].slice(0, 8)]);

  // ----- correction 1 (review finding F1): an item closed between its error and its stamp -----
  // Two never-re-checked items, both of whose begins are cancelled (injected at
  // the bridge), so the run gives up on both and stamps both. While the run is
  // about to stamp the first, a SECOND CONNECTION archives that item in a
  // transaction it has not committed. The run's stamp is then really sent: it
  // waits on the item's row lock. The second connection commits, and the stamp,
  // seeing the item is no longer open, answers false and writes nothing. That
  // answer must not be reported as a written stamp, in the response or in the
  // receipt. The second item stays open: its stamp answers true, in the same run.
  const iClosed = U("a021", 1), iStays = U("a022", 1);
  for (const [k, id] of [iClosed, iStays].entries()) {
    await thought(U(`f02${k + 1}`, 1), 0, `y${k + 1}`, "source");
    await item(id, 1 + k, U(`f02${k + 1}`, 1), `refused stamp item ${k + 1}`);
    await thought(U(`d02${k + 1}`, 1), 20, `y${k + 1}`, "a note");
  }
  const until = async (what: () => Promise<boolean>, seconds: number): Promise<boolean> => {
    for (let i = 0; i < seconds * 20; i++) {
      if (await what()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };
  const others = (where: string) =>
    sql(`select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and ${where}`);
  const seen = { stampWaited: false, statusWhileWaiting: "", stampUnwrittenWhileWaiting: "", stampAnswers: [] as Array<[string, unknown, unknown]> };
  rpcLog.length = 0; shown.clear(); callsPerItem.clear(); llmCalls = 0; llmFault = null;
  rpcFault = (fn) => (fn === "recheck_begin_scan" ? TIMEOUT_FAULT : null);
  rpcAround = async (fn, args, call) => {
    if (fn !== "recheck_note_error") return await call();
    if (args.p_item_id !== iClosed) {
      const r = await call();
      seen.stampAnswers.push([String(args.p_item_id), r.data, r.error]);
      return r;
    }
    // The other connection: archive the item and hold the transaction open.
    const closer = new Deno.Command("psql", {
      args: ["-h", "127.0.0.1", "-p", PORT!, "-U", "postgres", "-d", DB, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"],
      stdin: "piped", stdout: "piped", stderr: "piped",
    }).spawn();
    const stdin = closer.stdin.getWriter();
    const send = (text: string) => stdin.write(new TextEncoder().encode(text));
    await send(`begin;\nselect public.transition_action_item(${quote(iClosed)}, '{open}', 'archived', 'operator', 'expired');\n`);
    if (!await until(async () => (await others(`state = 'idle in transaction' and query like '%transition_action_item%'`)) === "1", 10)) {
      throw new NeverRan("refused stamp: the closing transaction did not open on the second connection");
    }
    // Now the run's own stamp, for real. It must wait behind the uncommitted close.
    const stamp = call();
    seen.stampWaited = await until(async () => (await others(`wait_event_type = 'Lock' and query like '%recheck_note_error%'`)) === "1", 10);
    seen.statusWhileWaiting = await sql(`select status from public.action_items where id = ${quote(iClosed)}`);
    seen.stampUnwrittenWhileWaiting = await sql(`select (recheck_last_error_at is null)::text from public.action_items where id = ${quote(iClosed)}`);
    await send("commit;\n");
    await stdin.close();
    const closed = await closer.output();
    if (closed.code !== 0) throw new NeverRan(`refused stamp: the closing connection failed (psql exit ${closed.code}): ${new TextDecoder().decode(closed.stderr).trim().slice(0, 200)}`);
    const r = await stamp;
    seen.stampAnswers.push([String(args.p_item_id), r.data, r.error]);
    return r;
  };
  const rs = await run(false, 2);
  rpcFault = null; rpcAround = null;
  eq("refused stamp: both items errored before a scan began and the run asked for a stamp for each, once",
    [rs.status, rs.items_eligible, rs.items_errored, rs.recheck_incomplete, rpcLog.filter((c) => c.fn === "recheck_note_error").map((c) => c.args.p_item_id).sort()],
    ["partial", 2, 2, 0, [iClosed, iStays].sort()]);
  eq("refused stamp: the stamp of the item being closed really waited behind the other connection's uncommitted archive (the item still read open and unstamped), then answered false with no error; the other item's stamp answered true",
    [seen.stampWaited, seen.statusWhileWaiting, seen.stampUnwrittenWhileWaiting, [...seen.stampAnswers].sort((a, b) => a[0].localeCompare(b[0]))],
    [true, "open", "true", [[iClosed, false, null], [iStays, true, null]]]);
  eq("refused stamp: in the database the closed item is archived and carries no stamp; the open item carries one",
    await sql(`select string_agg(concat_ws('|', left(id::text, 8), status, (recheck_last_error_at is not null)::text), ' ' order by id) from public.action_items where id = any(${quote("{" + [iClosed, iStays].join(",") + "}")}::uuid[])`),
    "a0210000|archived|false a0220000|open|true");
  eq("refused stamp: the response counts one written stamp and one refused, none failed: the false answer is not reported as a stamp",
    [rs.items_error_noted, rs.error_notes_refused, rs.error_notes_failed], [1, 1, 0]);
  eq("refused stamp: the receipt says the same as the response, and its count of written stamps is the number of stamps this run left in the database",
    [await sql(`select concat_ws('|', status, summary->>'items_errored', summary->>'items_error_noted', summary->>'error_notes_refused', summary->>'error_notes_failed') from public.action_item_recheck_runs order by started_at desc, finished_at desc limit 1`),
      await sql(`select count(*) from public.action_items where recheck_last_error_at is not null and id = any(${quote("{" + [iClosed, iStays].join(",") + "}")}::uuid[])`)],
    ["partial|2|1|1|0", "1"]);

  check("no bridged call was refused for an argument name or type the SQL does not declare",
    !logs.some((l) => /42883|42804|42P02|function .* does not exist/.test(l)), logs.find((l) => /42883|42804|42P02/.test(l)) ?? "");
} catch (e) {
  if (e instanceof NeverRan || neverRan.length > 0) bail();
  say(`NEVER-RAN: the integration harness threw outside an assertion: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
  Deno.exit(2);
}
if (neverRan.length > 0) bail();
say(`RECHECK INTEGRATION PASSED (${passed} checks)`);
Deno.exit(0);
