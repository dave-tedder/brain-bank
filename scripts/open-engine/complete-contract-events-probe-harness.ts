// Task 5.4 follow-up (PR 32 decision 7): drive complete_agent_task and
// request_agent_review through the REAL open-brain-mcp entrypoint (Deno.serve,
// the MCP transport, the tool handler, moveAgentTaskViaTool) with Supabase
// mocked at fetch, and prove what reaches public.complete_contract_events.
// Nothing leaves this machine. Modeled on complete-contract-probe-harness.ts
// (PR 32's P1 to P7), which still runs unchanged.
//   Q1 a refused complete_agent_task: exactly one events row (outcome refused,
//      reason = the refusal reasons as the log line prints them, the tool, task,
//      agent and slug, occurred_at inside the call, nothing else); no status write; the only writes are that
//      row and the usual mcp_tool_invocations row; the answer is exactly the
//      pre-existing refusal text.
//   Q2 a refused request_agent_review: one row naming request_agent_review.
//   Q3 a null project_slug: one row, reason MISSING_PROJECT_SLUG, slug null.
//   Q4 a fresh route with a false capability: one row with the route reason.
//   Q5 an absent route snapshot: accepted, one status write, exactly one row
//      (outcome warned, ROUTE_SNAPSHOT_UNAVAILABLE).
//   Q6 a clean completion on a fresh route: accepted, zero rows.
//   Q7 another agent's call: ownership error first, zero rows.
//   Q8 the events insert answers an HTTP 500: the refusal and the warned answer
//      are byte-identical to Q1 and Q5, the status write still happens once on
//      the warned path, and one "event write failed" line is logged.
//   Q9 the events insert's fetch throws: same as Q8.
//   Q10 EdgeRuntime.waitUntil throws: the answers are still byte-identical, and
//      one "event write not scheduled" line is logged.
//   Q11 waitUntil throws a value that cannot be formatted (Object.create(null)):
//      the answers are still byte-identical (correction 1, finding 3).
//   Q12 a 201-character project_slug and agent_code (no route row can match it):
//      the warned row carries both whole (correction 1, finding 2).
//   Q13 request_agent_review warned, on an absent snapshot and on a failed
//      route read: one warned row naming request_agent_review each time
//      (correction 1, finding 5).
//
//   deno run --config scripts/loop-closing/closeout-capture-probe.deno.json --no-lock --allow-net --allow-env --allow-read scripts/open-engine/complete-contract-events-probe-harness.ts
//
// Exit 0 with "COMPLETE CONTRACT EVENTS PROBE PASSED"; exit 1 with "FAIL <probe>"
// when a probe ran to completion and its check did not hold; exit 2 with
// "NEVER-RAN" when the module could not start, the endpoint could not be reached
// or an answer could not be read. Control cases for the NEVER-RAN path:
// OBCE_PROBE_INJECT=module-missing (imports a file that does not exist) and
// OBCE_PROBE_INJECT=bad-port (calls a port nothing listens on).

import { evaluateCompletion } from "../../supabase/functions/open-brain-mcp/_complete_contract.ts";
import { CONTRACT_EVENT_REASON_PATTERN } from "../../supabase/functions/open-brain-mcp/_complete_contract_events.ts";

const INJECT = Deno.env.get("OBCE_PROBE_INJECT") ?? "";
const ACCESS_KEY = "probe-access-key";
const PORT = INJECT === "bad-port" ? 1 : 8000;
Deno.env.set("SUPABASE_URL", "http://supabase.mock");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "mock-service-key");
Deno.env.set("MCP_ACCESS_KEY", ACCESS_KEY);
Deno.env.set("OPENROUTER_API_KEY", "mock-openrouter-key");

type Rec = { table: string; method: string; url: string; body: unknown };
const recorded: Rec[] = [];
const pending: Promise<unknown>[] = [];
const origLog = console.log, origErr = console.error;
const logs: string[] = [];
console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
console.error = (...a: unknown[]) => { logs.push("ERR " + a.map(String).join(" ")); };
// waitUntilThrows makes every waitUntil call after the first one of a request
// throw. The first is logToolInvocation's mcp_tool_invocations write at the top
// of every tool handler (outside this change, and not guarded); the next is the
// events write (Q10 asserts the not-scheduled line, so a different order would
// fail Q10 rather than pass it).
const runtime = { waitUntilThrows: false, opaque: false, calls: 0 };
(globalThis as unknown as { EdgeRuntime: unknown }).EdgeRuntime = {
  waitUntil: (p: Promise<unknown>) => {
    runtime.calls += 1;
    if (runtime.waitUntilThrows && runtime.calls > 1) {
      // Q11: a thrown value with no primitive conversion.
      if (runtime.opaque) throw Object.create(null);
      throw new Error("waitUntil unavailable (probe)");
    }
    pending.push(p);
  },
};

const TASK_ID = "5a4e0000-0000-4000-8000-0000000000c1";
const AGENT = "claude-code";
const TOKEN = "5a4e0000-0000-4000-8000-0000000000cc";
type RouteScenario = { kind: "row" | "absent" | "error"; row: Record<string, unknown> | null };
const scenario = {
  task: {} as Record<string, unknown>,
  route: { kind: "row", row: null } as RouteScenario,
  events: "ok" as "ok" | "error" | "throw",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const realFetch = globalThis.fetch;
globalThis.fetch = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (!url.startsWith("http://supabase.mock/")) return realFetch(input as string, init);
  let body: unknown = null;
  const raw = init?.body ?? (input instanceof Request ? await input.text() : null);
  if (typeof raw === "string" && raw.length > 0) { try { body = JSON.parse(raw); } catch { body = raw; } }
  const u = new URL(url);
  const table = u.pathname.replace("/rest/v1/", "");
  recorded.push({ table, method, url, body });
  const accept = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("accept") ?? "";
  const single = accept.includes("vnd.pgrst.object");
  if (table === "agent_tasks" && method === "GET") return json(single ? scenario.task : [scenario.task]);
  if (table === "closeout_routes" && method === "GET") {
    if (scenario.route.kind === "error") return json({ code: "XX000", message: "probe: route lookup failed" }, 500);
    const rows = scenario.route.kind === "absent" || !scenario.route.row ? [] : [scenario.route.row];
    return json(single ? (rows[0] ?? null) : rows);
  }
  if (table === "complete_contract_events" && method === "POST") {
    if (scenario.events === "throw") throw new TypeError("probe: network unreachable");
    if (scenario.events === "error") return json({ code: "XX000", message: "probe: events insert failed" }, 500);
    return new Response(null, { status: 201 });
  }
  if (table === "rpc/move_agent_task_status") return json({ ...scenario.task, status: "Agent Review" });
  if (method === "POST") return json([]);
  return json(single ? null : []);
};

try {
  const target = INJECT === "module-missing"
    ? "../../supabase/functions/open-brain-mcp/does-not-exist.ts"
    : "../../supabase/functions/open-brain-mcp/index.ts";
  await import(target);
} catch (err) {
  console.log = origLog; console.error = origErr;
  console.log(`NEVER-RAN: the open-brain-mcp module did not start: ${(err as Error).message}`);
  Deno.exit(2);
}

async function drain() {
  // Let every scheduled write settle, including ones whose promise was created
  // but never handed to waitUntil (Q10).
  for (let i = 0; i < 3; i += 1) {
    while (pending.length) { const p = pending.shift()!; await p.catch(() => {}); }
    await new Promise((r) => setTimeout(r, 0));
  }
}
function never(msg: string): never {
  console.log = origLog; console.error = origErr;
  console.log(`NEVER-RAN: ${msg}`);
  Deno.exit(2);
}
function fail(probe: string, msg: string): never {
  console.log = origLog; console.error = origErr;
  console.log(`FAIL ${probe}: ${msg}`);
  for (const r of recorded) console.log(`  recorded ${r.method} ${r.table}`);
  Deno.exit(1);
}
const expect = (probe: string, cond: boolean, msg: string) => { if (!cond) fail(probe, msg); };

// The window of the latest call: an events row's occurred_at must fall inside it.
const lastCall = { start: 0, end: 0 };
async function call(receipt: string, agent = AGENT, tool = "complete_agent_task"): Promise<{ isError: boolean; text: string }> {
  let res: Response;
  lastCall.start = Date.now();
  try {
    res = await realFetch(`http://127.0.0.1:${PORT}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": ACCESS_KEY },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: {
          name: tool,
          arguments: tool === "request_agent_review"
            ? { task_id: TASK_ID, agent_code: agent, review_note: receipt, claim_token: TOKEN }
            : { task_id: TASK_ID, agent_code: agent, result: receipt, claim_token: TOKEN },
        },
      }),
    });
  } catch (err) {
    never(`the MCP endpoint could not be reached: ${(err as Error).message}`);
  }
  const raw = await res!.text();
  lastCall.end = Date.now();
  await drain();
  let rpc: { result?: { content?: Array<{ type: string; text: string }>; isError?: boolean }; error?: unknown } | null = null;
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) { try { rpc = JSON.parse(trimmed); } catch { rpc = null; } }
  else {
    const dataLines = trimmed.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    for (let i = dataLines.length - 1; i >= 0; i -= 1) { try { rpc = JSON.parse(dataLines[i]); break; } catch { /* next */ } }
  }
  if (!rpc || rpc.error || !rpc.result) never(`unreadable MCP answer (HTTP ${res!.status}): ${raw.slice(0, 200)}`);
  const text = (rpc!.result!.content || []).find((c) => c.type === "text")?.text;
  if (typeof text !== "string") never(`MCP answer without text: ${raw.slice(0, 200)}`);
  return { isError: rpc!.result!.isError === true, text: text! };
}

const statusWrites = () => recorded.filter((r) => r.table === "rpc/move_agent_task_status");
const eventRows = () => recorded.filter((r) => r.table === "complete_contract_events");
const routeReads = () => recorded.filter((r) => r.table === "closeout_routes");
const nonGets = () => recorded.filter((r) => r.method !== "GET" && r.method !== "HEAD");
const failLines = () => logs.filter((l) => l.startsWith("ERR [complete-contract] event write failed"));
const unscheduledLines = () => logs.filter((l) => l.startsWith("ERR [complete-contract] event write not scheduled"));

const BASE_TASK = {
  id: TASK_ID, title: "probe", status: "Agent Working", risk: "low", agent_code: null,
  claimed_by: AGENT, claim_token: TOKEN, explicit_approval: false, project_slug: "brain-bank",
  desired_outcome: "A working fix",
};
function reset(task: Record<string, unknown>, route: RouteScenario, events: typeof scenario.events = "ok") {
  recorded.length = 0; logs.length = 0;
  scenario.task = { ...BASE_TASK, ...task };
  scenario.route = route;
  scenario.events = events;
  runtime.waitUntilThrows = false;
  runtime.opaque = false;
  runtime.calls = 0;
}
const freshRow = (over: Record<string, unknown> = {}) => ({
  slug: "brain-bank", has_workspace: true, has_tracker: true, has_session_log: true, has_capture_tag: true,
  published_at: new Date(Date.now() - 3600_000).toISOString(), ...over,
});

const CLEAN = [
  "Work summary: probe", "Verification: probe", "Touched files or records: none", "Limitations: none",
  "Tracker draft: probe", "Session-log draft: probe", "Brain Bank capture draft: probe", "Follow-up recommendation: none",
].join("\n");
// Seven headings missing and a marker outside Follow-up recommendation: a static
// refusal with two reasons, so the row's comma-joined reason is exercised.
const HELD = "Work summary: probe only\nOPERATOR-ACTION: do it";

const ROW_KEYS = ["agent_code", "occurred_at", "outcome", "project_slug", "reason", "task_id", "tool"];
const reasonRe = new RegExp(CONTRACT_EVENT_REASON_PATTERN);
function oneRow(probe: string, want: Record<string, unknown>) {
  const rows = eventRows();
  expect(probe, rows.length === 1, `expected exactly one complete_contract_events write, saw ${rows.length}`);
  expect(probe, rows[0].method === "POST", `events write method ${rows[0].method}`);
  const body = rows[0].body as Record<string, unknown>;
  expect(probe, body !== null && typeof body === "object" && !Array.isArray(body), `events body is not one object: ${JSON.stringify(body)}`);
  expect(probe, JSON.stringify(Object.keys(body).sort()) === JSON.stringify(ROW_KEYS), `events row keys ${Object.keys(body).sort().join(",")}`);
  for (const [k, v] of Object.entries(want)) {
    expect(probe, body[k] === v, `events row ${k}=${JSON.stringify(body[k])}, want ${JSON.stringify(v)}`);
  }
  expect(probe, typeof body.reason === "string" && reasonRe.test(body.reason as string), `reason does not fit the table CHECK: ${JSON.stringify(body.reason)}`);
  const at = typeof body.occurred_at === "string" ? Date.parse(body.occurred_at) : NaN;
  expect(probe, Number.isFinite(at) && at >= lastCall.start && at <= lastCall.end, `occurred_at ${JSON.stringify(body.occurred_at)} is not inside the call window`);
}

// Q1
reset({}, { kind: "row", row: freshRow() });
const q1Verdict = evaluateCompletion({ receipt: HELD, task: { project_slug: "brain-bank", desired_outcome: "A working fix", title: "probe" }, route: { row: freshRow() as never }, now: new Date() });
if (q1Verdict.ok || q1Verdict.reasons.length < 2) never("the Q1 receipt is not refused with two or more reasons by the contract module, so Q1 cannot test a joined reason");
const q1 = await call(HELD);
expect("Q1", q1.isError, `accepted: ${q1.text.slice(0, 200)}`);
expect("Q1", q1.text === `Error completing agent task: ${q1Verdict.message}`, `the refusal text changed: ${q1.text.slice(0, 300)}`);
expect("Q1", statusWrites().length === 0, `a refused completion wrote status ${statusWrites().length} time(s)`);
oneRow("Q1", { tool: "complete_agent_task", task_id: TASK_ID, agent_code: AGENT, outcome: "refused", reason: q1Verdict.reasons.join(","), project_slug: "brain-bank" });
const q1Writes = nonGets().map((r) => `${r.method} ${r.table}`).sort();
expect("Q1", JSON.stringify(q1Writes) === JSON.stringify(["POST complete_contract_events", "POST mcp_tool_invocations"]), `writes: ${q1Writes.join(" | ")}`);
expect("Q1", logs.filter((l) => l.startsWith("[complete-contract] ")).length === 1, "expected exactly one [complete-contract] log line");
origLog(`PASS Q1 refused complete_agent_task: one refused row (${q1Verdict.reasons.join(",")}), no status write, answer unchanged`);

// Q2
reset({}, { kind: "row", row: freshRow() });
const q2 = await call(HELD, AGENT, "request_agent_review");
expect("Q2", q2.isError && q2.text === `Error requesting agent review: ${q1Verdict.message}`, `request_agent_review answer: ${q2.text.slice(0, 200)}`);
expect("Q2", statusWrites().length === 0, "a refused request_agent_review wrote status");
oneRow("Q2", { tool: "request_agent_review", outcome: "refused", reason: q1Verdict.reasons.join(","), task_id: TASK_ID, agent_code: AGENT });
origLog("PASS Q2 refused request_agent_review: one refused row naming request_agent_review");

// Q3
reset({ project_slug: null }, { kind: "row", row: freshRow() });
const q3 = await call(CLEAN);
expect("Q3", q3.isError && q3.text.includes("COMPLETE_REFUSED (MISSING_PROJECT_SLUG)"), q3.text.slice(0, 200));
expect("Q3", routeReads().length === 0 && statusWrites().length === 0, `route reads ${routeReads().length}, status writes ${statusWrites().length}`);
oneRow("Q3", { outcome: "refused", reason: "MISSING_PROJECT_SLUG", project_slug: null, tool: "complete_agent_task" });
origLog("PASS Q3 null project_slug: one refused row, reason MISSING_PROJECT_SLUG, slug null");

// Q4
reset({}, { kind: "row", row: freshRow({ has_tracker: false }) });
const q4 = await call(CLEAN);
expect("Q4", q4.isError && q4.text.includes("COMPLETE_REFUSED (UNRESOLVED_TRACKER_PATH)"), q4.text.slice(0, 200));
oneRow("Q4", { outcome: "refused", reason: "UNRESOLVED_TRACKER_PATH", project_slug: "brain-bank" });
expect("Q4", statusWrites().length === 0, "route refusal wrote status");
origLog("PASS Q4 false route capability: one refused row, reason UNRESOLVED_TRACKER_PATH");

// Q5
reset({}, { kind: "absent", row: null });
const q5 = await call(CLEAN);
expect("Q5", !q5.isError, `refused: ${q5.text.slice(0, 200)}`);
expect("Q5", statusWrites().length === 1, `expected one status write, saw ${statusWrites().length}`);
const q5Body = JSON.parse(q5.text);
expect("Q5", q5Body.receipt === "AGENT DONE" && Array.isArray(q5Body.warnings) && q5Body.warnings.length === 1 && q5Body.warnings[0].code === "ROUTE_SNAPSHOT_UNAVAILABLE", `answer: ${q5.text.slice(0, 200)}`);
oneRow("Q5", { outcome: "warned", reason: "ROUTE_SNAPSHOT_UNAVAILABLE", project_slug: "brain-bank", tool: "complete_agent_task", task_id: TASK_ID, agent_code: AGENT });
origLog("PASS Q5 absent route snapshot: accepted, one status write, one warned row");

// Q6
reset({}, { kind: "row", row: freshRow() });
const q6 = await call(CLEAN);
expect("Q6", !q6.isError && statusWrites().length === 1, `clean: isError=${q6.isError} writes=${statusWrites().length}`);
expect("Q6", eventRows().length === 0, `a clean completion wrote ${eventRows().length} events row(s)`);
origLog("PASS Q6 clean completion on a fresh route: accepted, zero events rows");

// Q7
reset({}, { kind: "row", row: freshRow() });
const q7 = await call(HELD, "someone-else");
expect("Q7", q7.isError && q7.text.includes("Agent can only update tasks it has claimed") && !q7.text.includes("COMPLETE_REFUSED"), q7.text.slice(0, 200));
expect("Q7", eventRows().length === 0, "an ownership failure wrote an events row");
origLog("PASS Q7 another agent's call: ownership error first, zero events rows");

// Q8, Q9
for (const [probe, mode] of [["Q8", "error"], ["Q9", "throw"]] as Array<[string, "error" | "throw"]>) {
  reset({}, { kind: "row", row: freshRow() }, mode);
  const refused = await call(HELD);
  expect(probe, refused.text === q1.text && refused.isError === q1.isError, `the refusal answer changed when the events insert failed (${mode}): ${refused.text.slice(0, 200)}`);
  expect(probe, statusWrites().length === 0, "refusal wrote status");
  expect(probe, eventRows().length === 1, `events insert attempts ${eventRows().length}`);
  expect(probe, failLines().length === 1, `expected one "event write failed" line, saw ${failLines().length}: ${logs.join(" | ").slice(0, 300)}`);
  reset({}, { kind: "absent", row: null }, mode);
  const warned = await call(CLEAN);
  expect(probe, warned.text === q5.text && warned.isError === q5.isError, `the warned answer changed when the events insert failed (${mode}): ${warned.text.slice(0, 200)}`);
  expect(probe, statusWrites().length === 1, `the warned completion wrote status ${statusWrites().length} time(s)`);
  expect(probe, failLines().length === 1, `expected one "event write failed" line on the warned path, saw ${failLines().length}`);
  origLog(`PASS ${probe} events insert ${mode === "error" ? "answers HTTP 500" : "fetch throws"}: answers byte-identical, completion still written, one failure line`);
}

// Q10
reset({}, { kind: "row", row: freshRow() });
runtime.waitUntilThrows = true;
const q10r = await call(HELD);
expect("Q10", q10r.text === q1.text && q10r.isError, `the refusal answer changed when waitUntil threw: ${q10r.text.slice(0, 200)}`);
expect("Q10", unscheduledLines().length === 1, `expected one "event write not scheduled" line, saw ${unscheduledLines().length}`);
reset({}, { kind: "absent", row: null });
runtime.waitUntilThrows = true;
const q10w = await call(CLEAN);
expect("Q10", q10w.text === q5.text && !q10w.isError && statusWrites().length === 1, `the warned answer changed when waitUntil threw: ${q10w.text.slice(0, 200)}`);
origLog("PASS Q10 waitUntil throws: answers byte-identical, completion still written, one not-scheduled line");

// Q11
for (const [receipt, want] of [[HELD, q1], [CLEAN, q5]] as const) {
  reset({}, receipt === HELD ? { kind: "row", row: freshRow() } : { kind: "absent", row: null });
  runtime.waitUntilThrows = true;
  runtime.opaque = true;
  const got = await call(receipt);
  expect("Q11", got.text === want.text && got.isError === want.isError, `the answer changed when waitUntil threw an opaque value: ${got.text.slice(0, 200)}`);
  expect("Q11", unscheduledLines().length === 1 && unscheduledLines()[0].endsWith("(error value could not be formatted)"), `not-scheduled lines: ${unscheduledLines().join(" | ")}`);
}
origLog("PASS Q11 waitUntil throws an opaque value: answers byte-identical, one not-scheduled line");

// Q12
{
  const longSlug = "s".repeat(201), longAgent = "a".repeat(201);
  reset({ project_slug: longSlug, claimed_by: longAgent }, { kind: "absent", row: null });
  const got = await call(CLEAN, longAgent);
  expect("Q12", !got.isError && statusWrites().length === 1, `the long-identifier completion: ${got.text.slice(0, 200)}`);
  oneRow("Q12", { outcome: "warned", reason: "ROUTE_SNAPSHOT_UNAVAILABLE", project_slug: longSlug, agent_code: longAgent });
}
origLog("PASS Q12 201-character slug and agent: the warned row carries both whole");

// Q13
for (const route of [{ kind: "absent", row: null }, { kind: "error", row: null }] as RouteScenario[]) {
  reset({}, route);
  const got = await call(CLEAN, AGENT, "request_agent_review");
  expect("Q13", !got.isError && statusWrites().length === 1, `request_agent_review warned (${route.kind}): ${got.text.slice(0, 200)}`);
  oneRow("Q13", { tool: "request_agent_review", outcome: "warned", reason: "ROUTE_SNAPSHOT_UNAVAILABLE", task_id: TASK_ID, agent_code: AGENT, project_slug: "brain-bank" });
}
origLog("PASS Q13 request_agent_review warned (absent snapshot, failed read): one warned row naming request_agent_review");

console.log = origLog; console.error = origErr;
console.log("COMPLETE CONTRACT EVENTS PROBE PASSED");
Deno.exit(0);
