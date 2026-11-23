// Loop-closing Task 3.6, PR 23 review F1/F2: the PUBLIC entry points wired to the
// REAL review RPCs on a throwaway local PostgreSQL cluster. Nothing is scripted:
// every resolve_proposal_item / review_proposal call made by the helper, the MCP
// tool callback or the Slack reply handler is executed by the migrated functions
// in the disposable database, and every assertion reads persisted rows back.
//
// Run ONLY by review-proposal-sql-test.sh, after the migrations are applied, with
// OBRP_PG_PORT pointing at its cluster:
//   deno run --no-lock --config scripts/loop-closing/closeout-capture-probe.deno.json \
//     --allow-net --allow-env --allow-read --allow-run=psql \
//     scripts/loop-closing/review-proposal-integration.ts
// The config is the harness import map (zod 3.25.76): the MCP function's own pin,
// zod 3.24.2, has no ./v3 subpath, which the pinned MCP SDK 1.24.3 imports, so a
// plain `deno run` of the entrypoint dies at link time. The review tool's schema
// uses z.string/z.enum only; the one-minor zod difference is a stated caveat.
//
// Three entry points, one bridge:
//   helper  reviewProposal(db, ...) with db.rpc executed through psql;
//   MCP     the real open-brain-mcp Deno.serve handler, tools/call review_proposal
//           (schema validation, callback, telemetry write, helper, RPC);
//   Slack   the real ingest-thought Deno.serve handler, a validly signed event in
//           the capture channel (signature check, router, parser, helper, RPC).
// Handlers are captured by stubbing Deno.serve, so requests are delivered
// in-process (no socket); the ingest socket path is ingest-probe-harness.ts's.
//
// Business state is the complete rows of action_items, auto_resolve_decisions and
// action_item_events keyed by full uuid. mcp_tool_invocations is TELEMETRY: the
// MCP callback writes one row per call BEFORE validation, by design, so a refusal
// through MCP is "zero business writes, exactly one telemetry row", never "zero
// writes anywhere". Helper and Slack calls write no telemetry.
//
// Exit 0 with "REVIEW PROPOSAL INTEGRATION PASSED"; 1 on a failed assertion that
// ran to completion; 2 when the bridge itself could not execute (NEVER-RAN).
//
// A database error is passed to the code under test only when it is an answer
// from the functions (a refusal the RPC raises, a constraint, an unknown parameter
// name). An interruption (a cancelled statement, a timeout, a lost connection or
// resource: the SQLSTATE prefixes in OBRP_INTERRUPTION_PREFIXES, the runner's
// list) or an error with no readable SQLSTATE is NEVER-RAN: no assertion may be
// judged on it (PR 28 Codex review, P2, 2026-11-19; the rule and the mechanism are
// action-item-review-integration.ts's, PR 25). The client library and the Slack
// handler both swallow an exception thrown inside fetch, so every NeverRan is
// also recorded, and fail() and the final line both refuse to give a verdict
// once one exists.
//
// The same holds one step earlier, where there is no exit status at all (PR 28
// Codex re-review 1, P2, 2026-11-19): psql() records a native failure to create
// or run the subprocess (psql missing from PATH, not executable, the run
// permission refused) before the rejection can reach the client library or a
// handler. A psql that exits 0 without the output its statement must produce
// (an RPC answer that is not JSON, a count that is not a number) is recorded the
// same way: nothing says the statement ran.

import { reviewProposal, type ReviewArgs } from "../../supabase/functions/_shared/proposal-review.ts";

const PORT = Deno.env.get("OBRP_PG_PORT");
if (!PORT) {
  console.error("NEVER-RAN: OBRP_PG_PORT is not set (run me from review-proposal-sql-test.sh)");
  Deno.exit(2);
}
const ACCESS_KEY = "integration-access-key";
const SIGNING_SECRET = "integration-signing-secret";
const CAPTURE_CHANNEL = "C_INTEGRATION_CAPTURE";
const SLACK_USER = "U0INTEG01";

Deno.env.set("SUPABASE_URL", "http://supabase.mock");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "mock-service-key");
Deno.env.set("MCP_ACCESS_KEY", ACCESS_KEY);
Deno.env.set("SLACK_BOT_TOKEN", "mock-bot-token");
Deno.env.set("SLACK_CAPTURE_CHANNEL", CAPTURE_CHANNEL);
Deno.env.set("SLACK_SIGNING_SECRET", SIGNING_SECRET);
Deno.env.set("OPENROUTER_API_KEY", "mock-openrouter-key");
Deno.env.delete("OB_SECRET_KEY_NAME");

const origLog = console.log;
const logs: string[] = [];
console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
console.error = (...a: unknown[]) => { logs.push("ERR " + a.map(String).join(" ")); };
console.warn = (...a: unknown[]) => { logs.push("WARN " + a.map(String).join(" ")); };
const say = (s: string) => origLog(s);

const INTERRUPTION_PREFIXES = (Deno.env.get("OBRP_INTERRUPTION_PREFIXES") ?? "").split(" ").filter(Boolean);
if (INTERRUPTION_PREFIXES.length === 0) {
  origLog("NEVER-RAN: OBRP_INTERRUPTION_PREFIXES is not set (run me from review-proposal-sql-test.sh)");
  Deno.exit(2);
}
const neverRan: string[] = [];
class NeverRan extends Error {
  constructor(message: string) {
    super(message);
    neverRan.push(message);
  }
}

// ---------- psql bridge ----------
// Every statement the harness sends goes through here. Creating the command,
// running it and decoding its output can each throw before any exit status
// exists; that is an execution that did not happen, recorded as NeverRan HERE so
// that no caller (the client library inside fetch, a handler, a discarded
// promise) can turn the rejection into an answer.
async function psql(query: string): Promise<{ code: number; out: string; err: string }> {
  try {
    const cmd = new Deno.Command("psql", {
      args: ["-h", "127.0.0.1", "-p", PORT!, "-U", "postgres", "-d", "obtest", "-X", "-q", "-A", "-t",
        "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-c", query],
      stdout: "piped", stderr: "piped",
    });
    const r = await cmd.output();
    return { code: r.code, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) };
  } catch (e) {
    throw new NeverRan(`psql subprocess could not execute: ${String(e).slice(0, 300)}`);
  }
}

// psql exit 2 = connection trouble, 1 = a server-reported error from the SQL.
async function sqlValue(query: string): Promise<string> {
  const r = await psql(query);
  if (r.code !== 0) throw new NeverRan(`bridge query failed (psql exit ${r.code}): ${r.err.trim().slice(0, 300)}`);
  return r.out.replace(/\n$/, "");
}

function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return `'${v.replaceAll("'", "''")}'`;
  return `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
}

const BRIDGED = new Set(["resolve_proposal_item", "review_proposal"]);
const rpcLog: Array<{ fn: string; args: Record<string, unknown> }> = [];

// PostgREST's answer for a set-returning function, from the real function.
async function bridgeRpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string; code?: string } | null; status: number }> {
  if (!BRIDGED.has(fn)) throw new NeverRan(`unbridged rpc ${fn}: this harness only executes the review RPCs`);
  rpcLog.push({ fn, args });
  const named = Object.entries(args).map(([k, v]) => {
    if (!/^p_[a-z_]+$/.test(k)) throw new NeverRan(`unexpected rpc argument name ${k}`);
    return `${k} => ${lit(v)}`;
  }).join(", ");
  const r = await psql(`select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)::text from public.${fn}(${named}) x`);
  if (r.code === 0) {
    // The statement always yields one JSON array. Anything else under exit 0 is
    // not an answer from the function.
    let data: unknown;
    try { data = JSON.parse(r.out.trim()); } catch {
      throw new NeverRan(`rpc ${fn} gave no readable answer (psql exit 0, output is not JSON): ${r.out.trim().slice(0, 200)}`);
    }
    return { data, error: null, status: 200 };
  }
  if (r.code === 1 || r.code === 3) {
    const m = /ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/.exec(r.err);
    if (!m) throw new NeverRan(`rpc ${fn} failed with no readable SQLSTATE (psql exit ${r.code}): ${r.err.trim().slice(0, 300)}`);
    if (INTERRUPTION_PREFIXES.some((p) => m[1].startsWith(p))) {
      throw new NeverRan(`rpc ${fn} was interrupted (SQLSTATE ${m[1]}: ${m[2].slice(0, 200)}); it did not complete, so nothing is judged on it`);
    }
    return { data: null, error: { message: m[2], code: m[1] }, status: 400 };
  }
  throw new NeverRan(`rpc ${fn} could not execute (psql exit ${r.code}): ${r.err.trim().slice(0, 300)}`);
}

const db = {
  rpc: async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await bridgeRpc(fn, args);
    return { data, error };
  },
};

// ---------- fetch interception: Supabase REST/RPC to the bridge, Slack recorded ----------
const pending: Promise<unknown>[] = [];
(globalThis as unknown as { EdgeRuntime: unknown }).EdgeRuntime = {
  waitUntil: (p: Promise<unknown>) => { pending.push(p); },
};
const slackReplies: Array<{ text: string; thread_ts?: string }> = [];
const unexpected: string[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const raw = init?.body ?? (input instanceof Request ? await input.text() : null);
  let body: unknown = null;
  if (typeof raw === "string" && raw.length > 0) { try { body = JSON.parse(raw); } catch { body = raw; } }
  if (url.startsWith("https://slack.com/")) {
    const b = body as { text?: string; thread_ts?: string };
    slackReplies.push({ text: String(b?.text ?? ""), thread_ts: b?.thread_ts });
    return json({ ok: true });
  }
  if (url.startsWith("http://supabase.mock/rest/v1/")) {
    const path = new URL(url).pathname.replace("/rest/v1/", "");
    if (path.startsWith("rpc/")) {
      const r = await bridgeRpc(path.slice(4), (body ?? {}) as Record<string, unknown>);
      return r.error ? json(r.error, r.status) : json(r.data);
    }
    if (path === "mcp_tool_invocations" && method === "POST") {
      const rows = Array.isArray(body) ? body : [body];
      for (const row of rows as Array<{ tool_name: string; args: unknown; source: string }>) {
        await sqlValue(`insert into public.mcp_tool_invocations (tool_name, args, source) values (${lit(row.tool_name)}, ${lit(row.args ?? {})}, ${lit(row.source)})`);
      }
      return new Response(null, { status: 201 });
    }
  }
  // Anything else means a review path wandered off (capture, LLM, direct table write).
  unexpected.push(`${method} ${url}`);
  return json({ message: "unexpected request in review integration harness" }, 500);
};

// ---------- capture both entrypoints' handlers without opening sockets ----------
type Handler = (req: Request) => Response | Promise<Response>;
const handlers: Handler[] = [];
(Deno as unknown as { serve: unknown }).serve = (h: Handler) => {
  handlers.push(h);
  return { finished: Promise.resolve(), shutdown: async () => {}, ref() {}, unref() {}, addr: { hostname: "in-process", port: 0, transport: "tcp" } };
};
// Anything that escapes is a harness/setup failure, never a behavioral catch.
globalThis.addEventListener("unhandledrejection", (e) => {
  say(`NEVER-RAN integration: unhandled rejection: ${String((e as PromiseRejectionEvent).reason).slice(0, 300)}`);
  Deno.exit(2);
});
try {
  await import("../../supabase/functions/open-brain-mcp/index.ts");
  await import("../../supabase/functions/ingest-thought/index.ts");
} catch (e) {
  say(`NEVER-RAN integration: an entrypoint failed to load: ${String((e as Error).message ?? e).slice(0, 400)}`);
  Deno.exit(2);
}
if (handlers.length !== 2) {
  say(`NEVER-RAN: expected 2 captured Deno.serve handlers, got ${handlers.length}`);
  Deno.exit(2);
}
const [mcpHandler, ingestHandler] = handlers;

async function drain() {
  while (pending.length) { const p = pending.shift()!; await p.catch(() => {}); }
}

async function mcpCall(args: Record<string, unknown>): Promise<{ isError: boolean; text: string; rpcError: unknown }> {
  const res = await mcpHandler(new Request("http://in-process/open-brain-mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": ACCESS_KEY },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "review_proposal", arguments: args } }),
  }));
  const raw = await res.text();
  await drain();
  let rpc: { result?: { content?: Array<{ type: string; text: string }>; isError?: boolean }; error?: unknown } | null = null;
  const t = raw.trim();
  if (t.startsWith("{")) rpc = JSON.parse(t);
  else {
    const lines = t.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    for (let i = lines.length - 1; i >= 0; i--) { try { rpc = JSON.parse(lines[i]); break; } catch { /* keep scanning */ } }
  }
  if (!rpc) throw new NeverRan(`MCP answer unparseable (HTTP ${res.status}): ${raw.slice(0, 200)}`);
  if (rpc.error) return { isError: true, text: JSON.stringify(rpc.error), rpcError: rpc.error };
  const text = (rpc.result?.content ?? []).find((c) => c.type === "text")?.text ?? "";
  return { isError: rpc.result?.isError === true, text, rpcError: null };
}

async function sign(body: string, ts: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${body}`));
  return "v0=" + Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function slack(text: string): Promise<string> {
  slackReplies.length = 0;
  const body = JSON.stringify({
    type: "event_callback",
    event: { type: "message", text, user: SLACK_USER, channel: CAPTURE_CHANNEL, ts: `${Date.now() / 1000}`, thread_ts: "1731900000.000100" },
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await ingestHandler(new Request("http://in-process/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": await sign(body, ts) },
    body,
  }));
  await res.text();
  await drain();
  if (res.status !== 200) throw new NeverRan(`Slack handler answered HTTP ${res.status}`);
  if (slackReplies.length !== 1) fail(`Slack "${text}": expected one reply, got ${JSON.stringify(slackReplies)}`);
  return slackReplies[0].text;
}

// ---------- state ----------
const STATE_SQL = `select jsonb_build_object(
  'action_items', coalesce((select jsonb_object_agg(a.id::text, to_jsonb(a)) from public.action_items a), '{}'::jsonb),
  'auto_resolve_decisions', coalesce((select jsonb_object_agg(d.id::text, to_jsonb(d)) from public.auto_resolve_decisions d), '{}'::jsonb),
  'action_item_events', coalesce((select jsonb_object_agg(e.id::text, to_jsonb(e)) from public.action_item_events e), '{}'::jsonb))::text`;
type State = Record<string, Record<string, Record<string, unknown>>>;
async function state(): Promise<State> { return JSON.parse(await sqlValue(STATE_SQL)); }
async function telemetryCount(): Promise<number> {
  const v = await sqlValue("select count(*) from public.mcp_tool_invocations where tool_name = 'review_proposal'");
  // Number("") is 0: an empty answer must not read as "no telemetry rows".
  if (!/^[0-9]+$/.test(v)) throw new NeverRan(`telemetry count gave no readable answer (psql exit 0, output is not a number): ${v.slice(0, 200)}`);
  return Number(v);
}
function diff(a: State, b: State): string[] {
  const out: string[] = [];
  for (const t of Object.keys({ ...a, ...b })) {
    const ka = a[t] ?? {}, kb = b[t] ?? {};
    for (const k of new Set([...Object.keys(ka), ...Object.keys(kb)])) {
      if (JSON.stringify(ka[k]) !== JSON.stringify(kb[k])) out.push(`${t}:${k}`);
    }
  }
  return out;
}
// jsonb::text is canonical, so a re-read of unchanged rows is byte-equal; diff()
// compares per row so the failure names exactly what moved.
async function expectUnchanged(label: string, before: State) {
  const d = diff(before, await state());
  if (d.length) fail(`${label}: business rows changed: ${d.join(", ")}`);
}
function live(label: string, s: State, item: string, pendingRows: number) {
  const it = s.action_items[item];
  const n = Object.values(s.auto_resolve_decisions).filter((d) => d.item_id === item && d.outcome === "proposed").length;
  if (!it || n !== pendingRows) fail(`${label}: fixture not live (item ${item} present=${!!it}, proposed rows ${n}, expected ${pendingRows})`);
}

let checks = 0;
function fail(msg: string): never {
  if (neverRan.length) {
    say(`NEVER-RAN integration: ${neverRan[0]} (while checking: ${msg.slice(0, 200)})`);
    Deno.exit(2);
  }
  say(`FAIL integration: ${msg}`);
  if (unexpected.length) say(`  unexpected requests: ${unexpected.join(" | ")}`);
  for (const l of logs.slice(-15)) say(`  log: ${l.slice(0, 240)}`);
  Deno.exit(1);
}
function ok(cond: boolean, label: string, detail = "") {
  if (!cond) fail(`${label}${detail ? `: ${detail}` : ""}`);
  checks++;
  say(`PASS I ${label}`);
}

// ---------- fixtures (namespace c07* items, d07*/e07* decisions) ----------
async function item(id: string, status = "open") {
  await sqlValue(`insert into public.action_items (id, description, status, defer_reason) values ('${id}', 'integration ${id.slice(0, 8)}', '${status}', ${status === "deferred" ? "'pause:test'" : "null"})`);
}
async function prop(id: string, itemId: string, layer: string, related: string | null = null) {
  const q = {
    archive: `insert into public.auto_resolve_decisions (id, item_id, candidate_description, layer, outcome, reason) values ('${id}', '${itemId}', 'c', 'archive', 'proposed', 'age_standard')`,
    // One evidence thought per recheck row (auto_resolve_decisions_recheck_evidence_uniq).
    recheck: `with t as (insert into public.thoughts (id) values (gen_random_uuid()) returning id)
      insert into public.auto_resolve_decisions (id, item_id, evidence_thought_id, quote, score, candidate_description, layer, outcome)
      select '${id}', '${itemId}', t.id, 'sent it', 0.9, 'c', 'recheck', 'proposed' from t`,
    dedup: `insert into public.auto_resolve_decisions (id, item_id, related_item_id, score, candidate_description, layer, outcome, reason) values ('${id}', '${itemId}', '${related}', 0.92, 'c', 'dedup', 'proposed', 'semantic_overlap')`,
  }[layer];
  if (!q) throw new NeverRan(`unknown layer ${layer}`);
  await sqlValue(q);
}
async function reopen(itemId: string, from: string) {
  await sqlValue(`select public.transition_action_item('${itemId}', '{${from}}', 'open', 'operator')`);
}
const H = (a: Omit<ReviewArgs, "actor" | "source"> & { actor?: string }) =>
  reviewProposal(db, { actor: "operator", source: "mcp-shared-key", ...a });
const row = (s: State, t: string, id: string) => s[t][id] as Record<string, unknown> | undefined;

try {
  await sqlValue("insert into public.agent_task_ledger (agent_code) values ('codex') on conflict do nothing");
  // I1 selective done (Slack), then the full-id retry (MCP) with the sibling still proposed.
  const A = "c0710001-0000-4000-8000-000000000000", SURV = "c0710002-0000-4000-8000-000000000000";
  const RC = "d0710001-0000-4000-8000-000000000000", DD = "d0710002-0000-4000-8000-000000000000";
  await item(SURV); await item(A); await prop(RC, A, "recheck"); await prop(DD, A, "dedup", SURV);
  let s = await state(); live("I1", s, A, 2);
  let text = await slack("done c0710001");
  ok(text.startsWith('c0710001 "integration c0710001": c0710001 has 2 pending:') && text.includes("Reply done c0710001 <decision id>"),
    "I1 Slack done with two pending rows lists them", text);
  await expectUnchanged("I1 needs_decision", s);
  text = await slack("done c0710001 d0710002");
  ok(text === 'c0710001 "integration c0710001": archived c0710001 (dedup d0710002)', "I1 Slack selective done recorded", text);
  s = await state();
  ok(row(s, "auto_resolve_decisions", DD)?.outcome === "accepted" && row(s, "auto_resolve_decisions", DD)?.reviewed_by === `slack:${SLACK_USER}`
    && row(s, "auto_resolve_decisions", DD)?.review_seq === 1, "I1 persisted: the named row accepted by the signed Slack user, review_seq 1");
  ok(row(s, "auto_resolve_decisions", RC)?.outcome === "proposed" && row(s, "auto_resolve_decisions", RC)?.review_seq === null,
    "I1 persisted: the sibling is still proposed and unreviewed");
  ok(row(s, "action_items", A)?.status === "archived" && row(s, "action_items", A)?.close_reason === "duplicate"
    && row(s, "action_items", A)?.duplicate_of === SURV, "I1 persisted: item archived as a duplicate of the survivor");
  const ev = Object.values(s.action_item_events).filter((e) => e.item_id === A);
  ok(ev.length === 1 && ev[0].actor === `slack:${SLACK_USER}` && (ev[0].payload as Record<string, unknown>)?.actor_source === "slack-signature"
    && (ev[0].payload as Record<string, unknown>)?.decision_id === DD, "I1 persisted: one close event with the Slack actor and source", JSON.stringify(ev));
  let tel = await telemetryCount();
  let r = await mcpCall({ item_ref: A, verb: "done", actor: "operator", decision_ref: DD });
  ok(!r.isError && JSON.parse(r.text).review.status === "already_recorded", "I1 MCP full-id retry is already recorded", r.text);
  await expectUnchanged("I1 retry", s);
  ok(await telemetryCount() === tel + 1, "I1 MCP retry wrote exactly one telemetry row and zero business rows");

  // I2 leftover sibling on the closed item, by full id: the restore refusal.
  r = await mcpCall({ item_ref: "c0710001", verb: "done", actor: "operator", decision_ref: RC });
  const rv = JSON.parse(r.text).review;
  ok(rv.status === "refused" && rv.message.endsWith("restore_action_item is the undo"), "I2 leftover sibling on a closed item is the restore refusal", r.text);
  await expectUnchanged("I2", s);
  const h2 = await H({ verb: "done", itemRef: A, decisionRef: RC });
  ok(h2.status === "refused" && h2.message.endsWith("restore_action_item is the undo"), "I2 the same through the helper", h2.message);
  await expectUnchanged("I2 helper", s);

  // I3 accepted row and leftover sibling share their first 8 hex characters.
  const P = "c0720001-0000-4000-8000-000000000000", PS = "c0720002-0000-4000-8000-000000000000";
  const X1 = "ef0720aa-0000-4000-8000-000000000001", X2 = "ef0720aa-0000-4000-8000-000000000002";
  await item(PS); await item(P); await prop(X1, P, "recheck"); await prop(X2, P, "dedup", PS);
  let h = await H({ verb: "done", itemRef: "c0720001", decisionRef: X1 });
  ok(h.status === "recorded" && h.decisionId === X1, "I3 done by full id accepts the recheck row", h.message);
  s = await state();
  ok(row(s, "auto_resolve_decisions", X2)?.outcome === "proposed" && row(s, "action_items", P)?.status === "resolved",
    "I3 persisted: item resolved, the prefix-sharing sibling still proposed");
  h = await H({ verb: "done", itemRef: "c0720001", decisionRef: "ef0720aa" });
  ok(h.status === "ambiguous" && h.message === "ambiguous, use the full decision id", "I3 the shared short form is ambiguous", h.message);
  await expectUnchanged("I3 ambiguous", s);
  h = await H({ verb: "done", itemRef: "c0720001", decisionRef: X1 });
  ok(h.status === "already_recorded", "I3 the accepted row by full id is already recorded", h.message);
  h = await H({ verb: "done", itemRef: "c0720001", decisionRef: X2 });
  ok(h.status === "refused" && h.message.endsWith("restore_action_item is the undo"), "I3 the sibling by full id is the closed-item refusal", h.message);
  await expectUnchanged("I3 full forms", s);
  tel = await telemetryCount();
  r = await mcpCall({ item_ref: P, verb: "done", actor: "operator", decision_ref: "EF0720AA" });
  ok(JSON.parse(r.text).review.status === "ambiguous", "I3 the shared short form through MCP is ambiguous", r.text);
  await expectUnchanged("I3 MCP", s);
  ok(await telemetryCount() === tel + 1, "I3 MCP refusal: one telemetry row, zero business rows");

  // I4 foreign and prior-generation decision references are never success.
  const F1 = "c0730001-0000-4000-8000-000000000000", F2 = "c0730002-0000-4000-8000-000000000000";
  await item(F1); await item(F2);
  await prop("d0730001-0000-4000-8000-000000000000", F1, "recheck");
  await prop("d0730002-0000-4000-8000-000000000000", F2, "recheck");
  s = await state(); live("I4 foreign", s, F1, 1);
  for (const ref of ["d0730002", "d0730002-0000-4000-8000-000000000000"]) {
    h = await H({ verb: "done", itemRef: F1, decisionRef: ref });
    ok(h.status === "not_found" && h.message === `no pending decision ${ref} on c0730001`, `I4 a foreign decision id ${ref} is not found`, h.message);
    r = await mcpCall({ item_ref: "c0730001", verb: "done", actor: "operator", decision_ref: ref });
    ok(JSON.parse(r.text).review.status === "not_found", `I4 a foreign decision id ${ref} through MCP is not found`, r.text);
  }
  await expectUnchanged("I4 foreign", s);
  const G = "c0740001-0000-4000-8000-000000000000", G0 = "d0740001-0000-4000-8000-000000000000", G1 = "d0740002-0000-4000-8000-000000000000";
  await item(G); await prop(G0, G, "recheck");
  h = await H({ verb: "done", itemRef: G });
  ok(h.status === "recorded" && h.decisionId === G0, "I4 generation 0's row accepted", h.message);
  await reopen(G, "resolved");
  await prop(G1, G, "recheck");
  s = await state();
  ok(row(s, "action_items", G)?.reopen_generation === 1 && row(s, "auto_resolve_decisions", G1)?.item_generation === 1
    && row(s, "auto_resolve_decisions", G0)?.item_generation === 0, "I4 fixture: reopened into generation 1 with a new pending row");
  for (const ref of [G0, "d0740001"]) {
    h = await H({ verb: "done", itemRef: G, decisionRef: ref });
    ok(!["recorded", "already_recorded"].includes(h.status), `I4 a prior-generation id ${ref} is never success (got ${h.status})`, h.message);
    text = await slack(`done c0740001 ${ref}`);
    ok(!/already recorded|resolved c0740001/.test(text), `I4 a prior-generation id ${ref} through Slack is never success`, text);
  }
  await expectUnchanged("I4 prior generation", s);
  h = await H({ verb: "done", itemRef: G });
  ok(h.status === "recorded" && h.decisionId === G1, "I4 control: generation 1's own row is accepted", h.message);

  // I5 item lookup when only an older generation holds proposal rows.
  const O = "c0750001-0000-4000-8000-000000000000";
  await item(O); await prop("d0750001-0000-4000-8000-000000000000", O, "archive");
  text = await slack("archive c0750001");
  ok(text === 'c0750001 "integration c0750001": archived c0750001 (expired)', "I5 Slack archive recorded", text);
  await reopen(O, "archived");
  s = await state();
  ok(row(s, "action_items", O)?.status === "open" && row(s, "action_items", O)?.reopen_generation === 1, "I5 fixture: restored into generation 1");
  for (const verb of ["keep", "archive", "done"]) {
    h = await H({ verb, itemRef: "c0750001" });
    ok(h.status === "nothing_pending" && h.message === "nothing pending on c0750001", `I5 ${verb} through the helper is nothing pending`, h.message);
  }
  text = await slack("keep c0750001");
  ok(text === 'c0750001 "integration c0750001": nothing pending on c0750001', "I5 keep through Slack is nothing pending", text);
  await expectUnchanged("I5", s);

  // I6 earlier-review versus latest-review references.
  const E = "c0760001-0000-4000-8000-000000000000";
  const EA = "d0760001-0000-4000-8000-000000000000", EB = "d0760002-0000-4000-8000-000000000000", EC = "d0760003-0000-4000-8000-000000000000";
  await item(E); await prop(EA, E, "archive");
  h = await H({ verb: "keep", itemRef: E });
  ok(h.status === "recorded", "I6 keep reviews A", h.message);
  await prop(EB, E, "recheck"); await prop(EC, E, "recheck");
  text = await slack("keep c0760001");
  ok(text.endsWith("kept c0760001 on open (2 proposals)"), "I6 Slack keep reviews B and C", text);
  s = await state();
  ok(row(s, "auto_resolve_decisions", EA)?.review_seq === 1 && row(s, "auto_resolve_decisions", EB)?.review_seq === 2
    && row(s, "auto_resolve_decisions", EC)?.review_seq === 2 && row(s, "auto_resolve_decisions", EB)?.reviewed_by === `slack:${SLACK_USER}`,
    "I6 persisted: A is review 1, B and C are review 2 by the Slack user");
  h = await H({ verb: "done", itemRef: E, decisionRef: EA });
  ok(h.status === "refused" && /^d0760001 already reviewed \(keep .* UTC\); nothing pending$/.test(h.message), "I6 the earlier review's row by full id is already reviewed", h.message);
  h = await H({ verb: "done", itemRef: E, decisionRef: "d0760002" });
  ok(h.status === "refused" && /^c0760001 is open; last proposal kept .* UTC; nothing pending to done$/.test(h.message), "I6 a latest-review row is the open-item refusal", h.message);
  h = await H({ verb: "done", itemRef: E, decisionRef: "d0760001" });
  ok(h.status === "not_found", "I6 the earlier review's short id is no pending decision", h.message);
  r = await mcpCall({ item_ref: E, verb: "keep", actor: "codex" });
  ok(JSON.parse(r.text).review.status === "already_recorded", "I6 a further keep through MCP is already recorded", r.text);
  await expectUnchanged("I6", s);

  // I7 keep/archive with a decision_ref through the MCP entrypoint (F1), and
  // done with a blank one, against existing pending rows.
  const K = "c0770001-0000-4000-8000-000000000000", KA = "d0770001-0000-4000-8000-000000000000", KR = "d0770002-0000-4000-8000-000000000000";
  const D1 = "c0780001-0000-4000-8000-000000000000", D1R = "d0780001-0000-4000-8000-000000000000";
  await item(K); await prop(KA, K, "archive"); await prop(KR, K, "recheck");
  await item(D1); await prop(D1R, D1, "recheck");
  s = await state(); live("I7 keep/archive", s, K, 2); live("I7 done", s, D1, 1);
  const refs = ["d0770002", KR, "", " ", "   ", "\t", "\n", " \t\r\n "];
  for (const verb of ["keep", "archive"]) {
    for (const ref of refs) {
      tel = await telemetryCount();
      const before = rpcLog.length;
      r = await mcpCall({ item_ref: "c0770001", verb, actor: "operator", decision_ref: ref });
      const v = r.isError ? null : JSON.parse(r.text).review;
      ok(v?.status === "refused" && v.message === "keep and archive take no decision id",
        `I7 MCP ${verb} with decision_ref ${JSON.stringify(ref)} is refused`, r.text);
      ok(rpcLog.length === before, `I7 MCP ${verb} ${JSON.stringify(ref)}: no RPC reached (refused before item lookup)`);
      ok(await telemetryCount() === tel + 1, `I7 MCP ${verb} ${JSON.stringify(ref)}: one telemetry row`);
    }
  }
  for (const ref of ["", " ", "\t", "\n", " \t\r\n "]) {
    r = await mcpCall({ item_ref: "c0780001", verb: "done", actor: "operator", decision_ref: ref });
    const v = r.isError ? null : JSON.parse(r.text).review;
    ok(v?.status === "refused" && v.message === "empty decision id; use the full id or its first 8 characters, or leave it out",
      `I7 MCP done with decision_ref ${JSON.stringify(ref)} is malformed, not "the only row"`, r.text);
    h = await H({ verb: "done", itemRef: D1, decisionRef: ref });
    ok(h.status === "refused" && h.message.startsWith("empty decision id"), `I7 helper done ${JSON.stringify(ref)} is malformed`, h.message);
  }
  await expectUnchanged("I7 every decision_ref refusal", s);
  // Direct RPC, no helper in front: the RPC refuses the same on its own.
  for (const [verb, ref, want] of [["keep", "  ", "keep and archive take no decision id"], ["archive", "", "keep and archive take no decision id"],
    ["done", "\t", "empty decision id; use the full id or its first 8 characters, or leave it out"]] as const) {
    const d = await bridgeRpc("review_proposal", { p_item_id: verb === "done" ? D1 : K, p_verb: verb, p_actor: "operator", p_actor_source: "mcp-shared-key", p_decision_ref: ref });
    const first = (d.data as Array<{ status: string; message: string }>)?.[0];
    ok(first?.status === "refused" && first.message === want, `I7 direct RPC ${verb} ${JSON.stringify(ref)} refused on its own`, JSON.stringify(d));
  }
  await expectUnchanged("I7 direct RPC refusals", s);
  // null is not a string: the MCP schema rejects it before the callback runs.
  tel = await telemetryCount();
  r = await mcpCall({ item_ref: "c0770001", verb: "archive", actor: "operator", decision_ref: null });
  ok(r.isError && !r.text.includes('"status":"recorded"'), "I7 MCP decision_ref null is a schema refusal", r.text);
  ok(await telemetryCount() === tel, "I7 MCP schema refusal: the callback never ran, zero telemetry");
  await expectUnchanged("I7 schema refusal", s);
  // Controls: the SAME fixtures accept the absent form, so each refusal above
  // refused a call that would have written.
  r = await mcpCall({ item_ref: "c0770001", verb: "archive", actor: "operator" });
  ok(JSON.parse(r.text).review.status === "recorded", "I7 control: MCP archive with decision_ref absent records", r.text);
  s = await state();
  ok(row(s, "action_items", K)?.status === "archived" && row(s, "auto_resolve_decisions", KA)?.outcome === "accepted"
    && row(s, "auto_resolve_decisions", KR)?.outcome === "proposed", "I7 control persisted: archived, archive row accepted, recheck untouched");
  r = await mcpCall({ item_ref: "c0780001", verb: "done", actor: "operator", decision_ref: " D0780001 " });
  ok(JSON.parse(r.text).review.status === "recorded", "I7 control: MCP done with a padded valid id records", r.text);
  s = await state();
  ok(row(s, "action_items", D1)?.status === "resolved" && row(s, "auto_resolve_decisions", D1R)?.reviewed_by === "operator",
    "I7 control persisted: resolved by operator");

  ok(unexpected.length === 0, "no review path made any request other than the review RPCs and telemetry", unexpected.join(" | "));
  ok(rpcLog.length > 40, `the bridge really executed the RPCs (${rpcLog.length} calls)`);
  if (neverRan.length) throw new NeverRan(neverRan[0]);
} catch (e) {
  if (e instanceof NeverRan) { say(`NEVER-RAN integration: ${e.message}`); Deno.exit(2); }
  // An exception of another kind after a recorded incomplete execution (an
  // answer that is not JSON because the tool reported the swallowed error): the
  // record is the reason, the exception its consequence.
  if (neverRan.length) { say(`NEVER-RAN integration: ${neverRan[0]} (then: ${String(e).slice(0, 160)})`); Deno.exit(2); }
  say(`NEVER-RAN integration: harness crashed: ${(e as Error).stack ?? e}`);
  Deno.exit(2);
}
say(`REVIEW PROPOSAL INTEGRATION PASSED (${checks} checks)`);
Deno.exit(0);
