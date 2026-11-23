// Loop-closing Task 3.3: the PUBLIC entry points wired to the REAL functions of
// 20261119b_action_items_review.sql on a throwaway local PostgreSQL cluster.
// Nothing is scripted: every review_action_item / list_unreviewed_action_items
// call made by the helpers or by the MCP tool callbacks is executed by the
// migrated functions in the disposable database, and every assertion reads
// persisted rows back.
//
// Run ONLY by action-item-review-sql-test.sh, after the migrations are applied,
// with OBRP_PG_PORT pointing at its cluster:
//   deno run --no-lock --config scripts/loop-closing/closeout-capture-probe.deno.json \
//     --allow-net --allow-env --allow-read --allow-run=psql \
//     scripts/loop-closing/action-item-review-integration.ts
// The config is the harness import map (zod 3.25.76; the function's own pin,
// 3.24.2, has no ./v3 subpath the pinned MCP SDK imports, so a plain `deno run`
// of the entrypoint dies at link time). The two tools' schemas use
// z.string/z.enum/z.number/z.boolean only; the one-minor zod difference is a
// stated caveat, as in review-proposal-integration.ts.
//
// Two entry points, one bridge:
//   helper  reviewActionItem(db, ...) / listUnreviewedActionItems(db, ...) with
//           db.rpc executed through psql, so the argument NAMES the TypeScript
//           sends are checked against the SQL parameter names;
//   MCP     the real open-brain-mcp Deno.serve handler, tools/call
//           review_action_item and list_open_action_items (schema validation,
//           callback, telemetry write, helper, RPC, the has_active_draft read).
// The handler is captured by stubbing Deno.serve; requests are in-process.
// PostgREST is emulated for exactly what these two tools send: POST rpc/<fn>,
// POST mcp_tool_invocations, and GET action_items / agent_tasks with select,
// in-lists, order, offset and limit. Anything else is recorded as unexpected.
//
// Exit 0 with "ACTION ITEM REVIEW INTEGRATION PASSED"; 1 on a failed assertion
// that ran to completion; 2 when the bridge itself could not execute (NEVER-RAN).
//
// A database error is passed to the code under test only when it is an answer
// from the functions (a 22023 refusal, a constraint, an unknown parameter name).
// An interruption (a cancelled statement, a timeout, a lost connection or
// resource: the SQLSTATE prefixes in OBRP_INTERRUPTION_PREFIXES, the runner's
// list) or an error with no readable SQLSTATE is NEVER-RAN: no assertion may be
// judged on it (PR 25 Codex review, P2, 2026-11-18). The client library swallows
// an exception thrown inside fetch, so every NeverRan is also recorded and
// fail() and the final line both refuse to give a verdict once one exists.

import {
  listUnreviewedActionItems,
  reviewActionItem,
} from "../../supabase/functions/open-brain-mcp/_action_items.ts";

const PORT = Deno.env.get("OBRP_PG_PORT");
if (!PORT) {
  console.error("NEVER-RAN: OBRP_PG_PORT is not set (run me from action-item-review-sql-test.sh)");
  Deno.exit(2);
}
const ACCESS_KEY = "integration-access-key";
Deno.env.set("SUPABASE_URL", "http://supabase.mock");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "mock-service-key");
Deno.env.set("MCP_ACCESS_KEY", ACCESS_KEY);
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
  origLog("NEVER-RAN: OBRP_INTERRUPTION_PREFIXES is not set (run me from action-item-review-sql-test.sh)");
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
async function psql(query: string): Promise<{ code: number; out: string; err: string }> {
  const cmd = new Deno.Command("psql", {
    args: ["-h", "127.0.0.1", "-p", PORT!, "-U", "postgres", "-d", "obtest", "-X", "-q", "-A", "-t",
      "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-c", query],
    stdout: "piped", stderr: "piped",
  });
  const r = await cmd.output();
  return { code: r.code, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) };
}
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

const BRIDGED = new Set(["review_action_item", "list_unreviewed_action_items"]);
const rpcLog: Array<{ fn: string; args: Record<string, unknown> }> = [];

// PostgREST's answer for a set-returning function, from the real function. The
// arguments are passed BY NAME, so a TypeScript name the SQL does not declare is
// a database error, exactly as it would be through PostgREST.
async function bridgeRpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string; code?: string } | null; status: number }> {
  if (!BRIDGED.has(fn)) throw new NeverRan(`unbridged rpc ${fn}: this harness only executes the Task 3.3 functions`);
  rpcLog.push({ fn, args });
  const named = Object.entries(args).map(([k, v]) => {
    if (!/^[a-z_]+$/.test(k)) throw new NeverRan(`unexpected rpc argument name ${k}`);
    return `${k} => ${lit(v)}`;
  }).join(", ");
  const r = await psql(`select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)::text from public.${fn}(${named}) x`);
  if (r.code === 0) return { data: JSON.parse(r.out.trim()), error: null, status: 200 };
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

// ---------- the PostgREST GET subset the two tools send ----------
const IDENT = /^[a-z_]+$/;
const GET_TABLES = new Set(["action_items", "agent_tasks"]);
function inList(v: string): string[] {
  const m = /^in\.\((.*)\)$/s.exec(v);
  if (!m) throw new NeverRan(`unsupported filter ${v}`);
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|([^,]+)/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(m[1])) !== null) out.push(x[1] !== undefined ? x[1].replace(/\\(.)/g, "$1") : x[2]);
  return out;
}
async function bridgeGet(table: string, q: URLSearchParams): Promise<{ rows: unknown[] }> {
  if (!GET_TABLES.has(table)) throw new NeverRan(`unbridged GET ${table}`);
  const cols = (q.get("select") ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  if (!cols.length || !cols.every((c) => IDENT.test(c))) throw new NeverRan(`unsupported select ${q.get("select")}`);
  const where: string[] = [];
  let order = "", limit = "", offset = "";
  for (const [k, v] of q.entries()) {
    if (k === "select") continue;
    if (k === "order") {
      order = " order by " + v.split(",").map((o) => {
        const [c, dir] = o.split(".");
        if (!IDENT.test(c) || !["asc", "desc"].includes(dir)) throw new NeverRan(`unsupported order ${o}`);
        return `${c} ${dir}`;
      }).join(", ");
    } else if (k === "limit") {
      if (!/^\d+$/.test(v)) throw new NeverRan(`unsupported limit ${v}`);
      limit = ` limit ${v}`;
    } else if (k === "offset") {
      if (!/^\d+$/.test(v)) throw new NeverRan(`unsupported offset ${v}`);
      offset = ` offset ${v}`;
    } else if (IDENT.test(k)) {
      where.push(`${k}::text in (${inList(v).map(lit).join(", ")})`);
    } else throw new NeverRan(`unsupported query parameter ${k}`);
  }
  const sql = `select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)::text from (select ${cols.join(", ")} from public.${table}${
    where.length ? " where " + where.join(" and ") : ""
  }${order}${limit}${offset}) x`;
  return { rows: JSON.parse(await sqlValue(sql)) };
}

// ---------- fetch interception ----------
const pending: Promise<unknown>[] = [];
(globalThis as unknown as { EdgeRuntime: unknown }).EdgeRuntime = {
  waitUntil: (p: Promise<unknown>) => { pending.push(p); },
};
const unexpected: string[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const raw = init?.body ?? (input instanceof Request ? await input.text() : null);
  let body: unknown = null;
  if (typeof raw === "string" && raw.length > 0) { try { body = JSON.parse(raw); } catch { body = raw; } }
  if (url.startsWith("http://supabase.mock/rest/v1/")) {
    const u = new URL(url);
    const path = u.pathname.replace("/rest/v1/", "");
    if (path.startsWith("rpc/") && method === "POST") {
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
    if (method === "GET" && GET_TABLES.has(path)) {
      const { rows } = await bridgeGet(path, u.searchParams);
      return json(rows);
    }
  }
  unexpected.push(`${method} ${url}`);
  return json({ message: "unexpected request in action item review integration harness" }, 500);
};

// ---------- capture the MCP handler without opening a socket ----------
type Handler = (req: Request) => Response | Promise<Response>;
const handlers: Handler[] = [];
(Deno as unknown as { serve: unknown }).serve = (h: Handler) => {
  handlers.push(h);
  return { finished: Promise.resolve(), shutdown: async () => {}, ref() {}, unref() {}, addr: { hostname: "in-process", port: 0, transport: "tcp" } };
};
globalThis.addEventListener("unhandledrejection", (e) => {
  say(`NEVER-RAN integration: unhandled rejection: ${String((e as PromiseRejectionEvent).reason).slice(0, 300)}`);
  Deno.exit(2);
});
try {
  await import("../../supabase/functions/open-brain-mcp/index.ts");
} catch (e) {
  say(`NEVER-RAN integration: the entrypoint failed to load: ${String((e as Error).message ?? e).slice(0, 400)}`);
  Deno.exit(2);
}
if (handlers.length !== 1) {
  say(`NEVER-RAN: expected 1 captured Deno.serve handler, got ${handlers.length}`);
  Deno.exit(2);
}
const mcpHandler = handlers[0];

async function drain() {
  while (pending.length) { const p = pending.shift()!; await p.catch(() => {}); }
}

interface McpAnswer { isError: boolean; text: string; rpcError: unknown }
async function mcpCall(tool: string, args: Record<string, unknown>): Promise<McpAnswer> {
  const res = await mcpHandler(new Request("http://in-process/open-brain-mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": ACCESS_KEY },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
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
function parsed(a: McpAnswer, label: string): Record<string, unknown> {
  if (a.isError) fail(`${label}: the tool answered an error: ${a.text.slice(0, 300)}`);
  try { return JSON.parse(a.text); } catch { return fail(`${label}: the tool's answer is not JSON: ${a.text.slice(0, 200)}`); }
}

// ---------- state ----------
const STATE_SQL = `select jsonb_build_object(
  'action_items', coalesce((select jsonb_object_agg(a.id::text, to_jsonb(a)) from public.action_items a), '{}'::jsonb),
  'action_item_events', coalesce((select jsonb_object_agg(e.id::text, to_jsonb(e)) from public.action_item_events e), '{}'::jsonb))::text`;
type State = Record<string, Record<string, Record<string, unknown>>>;
async function state(): Promise<State> { return JSON.parse(await sqlValue(STATE_SQL)); }
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
async function expectUnchanged(label: string, before: State) {
  const d = diff(before, await state());
  if (d.length) fail(`${label}: business rows changed: ${d.join(", ")}`);
  checks++;
  say(`PASS I ${label}: no business row changed`);
}
async function telemetry(tool: string): Promise<number> {
  return Number(await sqlValue(`select count(*) from public.mcp_tool_invocations where tool_name = ${lit(tool)}`));
}
async function review(id: string): Promise<string> {
  return await sqlValue(`select concat_ws('|', coalesce(review_outcome, '-'), coalesce(last_reviewed_by, '-'), coalesce(triage_disposition, '-'), coalesce(triage_evidence, '-'), coalesce(triage_replacement_id::text, '-')) from public.action_items where id = ${lit(id)}`);
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

const U = (n: number) => `c2${String(n).padStart(6, "0")}-0000-4000-8000-000000000000`;
// created/reviewed are days before now(); reviewed null = never reviewed.
async function item(n: number, createdDays: number, reviewedDays: number | null = null, status = "open") {
  await sqlValue(`insert into public.action_items (id, description, status, created_at, defer_reason, last_reviewed_at, last_reviewed_by, review_outcome)
    values (${lit(U(n))}, ${lit(`integration ${n}`)}, ${lit(status)}, now() - interval '${createdDays} days',
      ${status === "deferred" ? "'pause:test'" : "null"},
      ${reviewedDays === null ? "null, null, null" : `now() - interval '${reviewedDays} days', 'triage', 'keep'`})`);
}

try {
  // A clean table: this harness runs after the SQL contract, whose rows remain.
  await sqlValue("delete from public.agent_tasks");
  await sqlValue("delete from public.action_items");
  await sqlValue("insert into public.agent_task_ledger (agent_code) values ('triage') on conflict do nothing");
  // Order by coalesce(last_reviewed_at, created_at): 1 (300d), 2 (review 200d), 3 (100d), 4 (50d).
  await item(1, 300);
  await item(2, 500, 200);
  await item(3, 100);
  await item(4, 50);
  await item(5, 400, 2); // reviewed 2 days ago: outside a 14-day window
  await item(6, 900, null, "deferred");
  await sqlValue(`insert into public.agent_tasks (status, linked_action_item_id) values ('Standing', ${lit(U(2))}), ('Agent Done', ${lit(U(3))})`);
  if (Number(await sqlValue("select count(*) from public.action_items")) !== 6) throw new NeverRan("fixture rows missing");

  // ---- helpers against the real functions ----
  {
    const page = await listUnreviewedActionItems(db, { unreviewed_days: 14, limit: 3 });
    ok(JSON.stringify(page.items.map((i) => i.id)) === JSON.stringify([U(1), U(2), U(3)]) && page.unreviewed_total === 4,
      "helper list: the oldest three of a four-row window, total 4", JSON.stringify({ ids: page.items.map((i) => i.id), total: page.unreviewed_total }));
    ok(page.items.every((i) => !("unreviewed_total" in i)) && page.items[1].review_outcome === "keep" && page.items[1].last_reviewed_by === "triage",
      "helper list: items carry their review and not the total");
    const r = await reviewActionItem(db, { id: U(4), outcome: "proposal", actor: "triage", disposition: "duplicate", evidence: "same as item 1", replacement_id: U(1) });
    ok(r.status === "recorded" && r.message === "proposed c2000004: duplicate of c2000001", "helper review: a duplicate proposal is recorded", JSON.stringify(r));
    ok(await review(U(4)) === `proposal|triage|duplicate|same as item 1|${U(1)}`, "helper review: the row holds the proposal", await review(U(4)));
    const before = await state();
    const bad = await reviewActionItem(db, { id: U(1), outcome: "proposal", actor: "triage", disposition: "done", evidence: "it shipped" });
    ok(bad.status === "error" && bad.message.includes("pointer"), "helper review: a done proposal without a pointer is an error carrying the database message", JSON.stringify(bad));
    await expectUnchanged("helper review: the refused done proposal", before);
  }

  // ---- MCP review_action_item ----
  {
    const t0 = await telemetry("review_action_item");
    const a = parsed(await mcpCall("review_action_item", { id: U(1), outcome: "keep", actor: "triage" }), "MCP keep");
    ok(JSON.stringify(a) === JSON.stringify({ review: { status: "recorded", message: "kept c2000001" } }), "MCP review: a keep is recorded", JSON.stringify(a));
    ok(await review(U(1)) === "keep|triage|-|-|-", "MCP review: the row holds the keep", await review(U(1)));
    ok(await telemetry("review_action_item") === t0 + 1, "MCP review: one telemetry row");

    const d = parsed(await mcpCall("review_action_item", { id: U(3), outcome: "proposal", actor: "operator", disposition: "done", evidence: "card:9662e944 applied" }), "MCP done");
    ok((d.review as { status: string }).status === "recorded" && await review(U(3)) === "proposal|operator|done|card:9662e944 applied|-",
      "MCP review: a done proposal with a pointer is recorded", JSON.stringify(d));

    let before = await state();
    let n = rpcLog.length;
    const bad = await mcpCall("review_action_item", { id: U(3), outcome: "proposal", actor: "triage", disposition: "done", evidence: "it shipped" });
    ok(bad.isError && bad.text.includes("pointer"), "MCP review: a done proposal without a pointer is a tool error", bad.text.slice(0, 200));
    ok(rpcLog.length === n + 1, "MCP review: that refusal came from the database, not from the schema");
    await expectUnchanged("MCP review: the refused done proposal", before);

    n = rpcLog.length;
    const keepWith = await mcpCall("review_action_item", { id: U(3), outcome: "keep", actor: "triage", evidence: "" });
    ok(keepWith.isError && keepWith.text.includes("A keep takes no") && rpcLog.length === n + 1,
      "MCP review: a keep with EMPTY evidence reaches the database and is refused", keepWith.text.slice(0, 200));
    await expectUnchanged("MCP review: the keep with empty evidence", before);

    const actor = await mcpCall("review_action_item", { id: U(3), outcome: "keep", actor: "nobody-registered" });
    ok(actor.isError && actor.text.includes("registered agent_code"), "MCP review: an unregistered actor is refused", actor.text.slice(0, 200));
    await expectUnchanged("MCP review: the unregistered actor", before);

    n = rpcLog.length;
    for (const [label, args] of [
      ["an unknown outcome", { id: U(3), outcome: "skip", actor: "triage" }],
      ["an unknown disposition", { id: U(3), outcome: "proposal", actor: "triage", disposition: "junk", evidence: "e" }],
      ["a replacement that is not a uuid", { id: U(3), outcome: "proposal", actor: "triage", disposition: "duplicate", evidence: "e", replacement_id: "c2000001" }],
      ["a missing actor", { id: U(3), outcome: "keep" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const z = await mcpCall("review_action_item", args);
      ok(z.isError, `MCP review: ${label} is refused by the schema`, z.text.slice(0, 160));
    }
    ok(rpcLog.length === n, "MCP review: schema refusals never reach the database");
    await expectUnchanged("MCP review: the four schema refusals", before);

    before = await state();
    const def = parsed(await mcpCall("review_action_item", { id: U(6), outcome: "keep", actor: "triage" }), "MCP deferred");
    ok(JSON.stringify(def) === JSON.stringify({ review: { status: "refused", message: "c2000006 is deferred; only an open item is reviewed" } }),
      "MCP review: a deferred item answers refused, not an error", JSON.stringify(def));
    await expectUnchanged("MCP review: the refused deferred item", before);
  }

  // ---- MCP list_open_action_items with unreviewed_days ----
  {
    // Now: 1 kept today, 3 proposed today, 4 proposed today (helper). Window: 2 only.
    // Add three more so the order and the cap are visible.
    await item(7, 80);
    await item(8, 700, 30);
    await item(9, 60);
    await sqlValue(`insert into public.agent_tasks (status, linked_action_item_id) values ('Needs Operator', ${lit(U(9))})`);
    const before = await state();
    const t0 = await telemetry("list_open_action_items");
    const l = parsed(await mcpCall("list_open_action_items", { unreviewed_days: 14, limit: 3 }), "MCP list");
    const items = l.items as Array<Record<string, unknown>>;
    // 2 (review 200d), 7 (80d), 9 (60d), 8 (review 30d): the first three.
    ok(JSON.stringify(items.map((i) => i.id)) === JSON.stringify([U(2), U(7), U(9)]),
      "MCP list: oldest unreviewed first, by coalesce(last_reviewed_at, created_at)", JSON.stringify(items.map((i) => i.id)));
    ok(l.count === 3 && l.unreviewed_total === 4 && l.unreviewed_days === 14, "MCP list: count 3, unreviewed_total 4, unreviewed_days echoed", JSON.stringify({ c: l.count, t: l.unreviewed_total, d: l.unreviewed_days }));
    ok(JSON.stringify(items.map((i) => i.has_active_draft)) === JSON.stringify([true, false, true]),
      "MCP list: has_active_draft is read for the unreviewed page (Standing and Needs Operator yes, none no)", JSON.stringify(items.map((i) => i.has_active_draft)));
    ok(items[0].review_outcome === "keep" && items[0].last_reviewed_by === "triage" && typeof items[0].last_reviewed_at === "string" && !("unreviewed_total" in items[0]),
      "MCP list: each item carries its previous review", JSON.stringify(items[0]));
    ok(await telemetry("list_open_action_items") === t0 + 1, "MCP list: one telemetry row");
    await expectUnchanged("MCP list: the read", before);

    let n = rpcLog.length;
    const withDeferred = await mcpCall("list_open_action_items", { unreviewed_days: 14, include_deferred: true });
    ok(withDeferred.isError && withDeferred.text.includes("include_deferred"), "MCP list: unreviewed_days with include_deferred is refused", withDeferred.text.slice(0, 200));
    const newest = await mcpCall("list_open_action_items", { unreviewed_days: 14, order: "newest" });
    ok(newest.isError && newest.text.includes("newest"), "MCP list: unreviewed_days with order newest is refused", newest.text.slice(0, 200));
    const zero = await mcpCall("list_open_action_items", { unreviewed_days: 0 });
    ok(zero.isError, "MCP list: unreviewed_days 0 is refused", zero.text.slice(0, 160));
    ok(rpcLog.length === n, "MCP list: none of the three refusals reached the database");

    // The window moves: review the head through the tool, read again.
    parsed(await mcpCall("review_action_item", { id: U(2), outcome: "keep", actor: "triage" }), "MCP keep head");
    const l2 = parsed(await mcpCall("list_open_action_items", { unreviewed_days: 14, limit: 3 }), "MCP list 2");
    ok(JSON.stringify((l2.items as Array<{ id: string }>).map((i) => i.id)) === JSON.stringify([U(7), U(9), U(8)]) && l2.unreviewed_total === 3,
      "MCP list: the reviewed head left the window and the next read starts at the next oldest", JSON.stringify(l2));

    // The read the tool had before this task, untouched: newest first, open only.
    n = rpcLog.length;
    const legacy = parsed(await mcpCall("list_open_action_items", { limit: 3 }), "MCP legacy list");
    const li = legacy.items as Array<Record<string, unknown>>;
    ok(JSON.stringify(li.map((i) => i.id)) === JSON.stringify([U(4), U(9), U(7)]) && legacy.count === 3
      && !("unreviewed_total" in legacy) && !("unreviewed_days" in legacy),
      "MCP legacy list: newest first by created_at, no unreviewed fields", JSON.stringify({ ids: li.map((i) => i.id), keys: Object.keys(legacy) }));
    ok(li[1].has_active_draft === true && li[0].has_active_draft === false && "defer_reason" in li[0],
      "MCP legacy list: has_active_draft and the defer columns as before", JSON.stringify(li[1]));
    const legacyOld = parsed(await mcpCall("list_open_action_items", { limit: 2, order: "oldest", include_deferred: true, offset: 1 }), "MCP legacy oldest");
    // By created_at ascending over open+deferred: 6 (900d), 8 (700d), 2 (500d), ...; offset 1 limit 2.
    ok(JSON.stringify((legacyOld.items as Array<{ id: string }>).map((i) => i.id)) === JSON.stringify([U(8), U(2)]),
      "MCP legacy list: order oldest, include_deferred and offset still work", JSON.stringify(legacyOld.items));
    ok(rpcLog.length === n, "MCP legacy list: no rpc is called without unreviewed_days");
  }

  if (unexpected.length) fail(`unexpected requests: ${unexpected.join(" | ")}`);
  if (neverRan.length) throw new NeverRan(neverRan[0]);
  say(`ACTION ITEM REVIEW INTEGRATION PASSED (${checks} checks)`);
  Deno.exit(0);
} catch (e) {
  if (e instanceof NeverRan) {
    say(`NEVER-RAN integration: ${e.message}`);
    Deno.exit(2);
  }
  say(`NEVER-RAN integration: unexpected exception: ${String((e as Error).stack ?? e).slice(0, 600)}`);
  Deno.exit(2);
}
