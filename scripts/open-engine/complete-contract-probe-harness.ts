// Loop-closing Task 5.4: drive complete_agent_task through the REAL open-brain-mcp
// entrypoint (Deno.serve, the MCP transport, the tool handler, moveAgentTaskViaTool)
// with Supabase mocked at fetch. Nothing leaves this machine. Proves, per probe,
// what reaches the database:
//   P1 a contract-clean receipt on a fresh complete route: the route is read, the
//      write (rpc/move_agent_task_status) happens once, no warnings in the answer;
//   P2 each of the 7 reconstructed held receipts (Task 2.1): refused, the error
//      names its reasons, and the write NEVER happens;
//   P3 a fresh route with a false capability: refused, no write;
//   P4 a null project_slug: refused with MISSING_PROJECT_SLUG, the route table is
//      not even read, no write;
//   P5 a stale snapshot, an absent row, and a failed read (the table missing, as
//      before the migration is applied): accepted, ONE write each, and the answer
//      carries a ROUTE_SNAPSHOT_UNAVAILABLE warning;
//   P6 another agent's call on the task: the ownership error comes first and the
//      route is not read (the contract never leaks to a caller without the claim);
//   P7 request_agent_review, which writes the same AGENT DONE event: a held
//      receipt is refused with no write, a clean one writes once.
// P2 and P5 also check the one-line function log the plan's measures count.
//
//   deno run --config scripts/loop-closing/closeout-capture-probe.deno.json --no-lock --allow-net --allow-env --allow-read scripts/open-engine/complete-contract-probe-harness.ts
// (The config is the existing harness import map; see its _comment for why.)
//
// Exit 0 with "COMPLETE CONTRACT PROBE PASSED"; exit 1 with "FAIL <probe>" when a
// probe ran and its check did not hold; exit 2 with "NEVER-RAN" when the module
// could not start or an answer could not be read.

const ACCESS_KEY = "probe-access-key";
const PORT = 8000;
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
(globalThis as unknown as { EdgeRuntime: unknown }).EdgeRuntime = {
  waitUntil: (p: Promise<unknown>) => { pending.push(p); },
};

const TASK_ID = "5a4e0000-0000-4000-8000-000000000001";
const AGENT = "claude-code";
const TOKEN = "5a4e0000-0000-4000-8000-0000000000aa";
const scenario = {
  task: {} as Record<string, unknown>,
  route: { kind: "row" as "row" | "absent" | "error", row: null as Record<string, unknown> | null },
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
    if (scenario.route.kind === "error") {
      return json({ code: "42P01", message: 'relation "public.closeout_routes" does not exist' }, 404);
    }
    const rows = scenario.route.kind === "absent" || !scenario.route.row ? [] : [scenario.route.row];
    return json(single ? (rows[0] ?? null) : rows);
  }
  if (table === "rpc/move_agent_task_status") {
    return json({ ...scenario.task, status: "Agent Review" });
  }
  if (method === "POST") return json([]);
  return json(single ? null : []);
};

try {
  await import("../../supabase/functions/open-brain-mcp/index.ts");
} catch (err) {
  console.log = origLog; console.error = origErr;
  console.log(`NEVER-RAN: the open-brain-mcp module did not start: ${(err as Error).message}`);
  Deno.exit(2);
}

async function drain() {
  while (pending.length) { const p = pending.shift()!; await p.catch(() => {}); }
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

async function complete(receipt: string, agent = AGENT, tool = "complete_agent_task"): Promise<{ isError: boolean; text: string }> {
  const res = await realFetch(`http://127.0.0.1:${PORT}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": ACCESS_KEY },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: tool,
        arguments: tool === "request_agent_review"
          ? { task_id: TASK_ID, agent_code: agent, review_note: receipt, claim_token: TOKEN }
          : { task_id: TASK_ID, agent_code: agent, result: receipt, claim_token: TOKEN },
      },
    }),
  });
  const raw = await res.text();
  await drain();
  let rpc: { result?: { content?: Array<{ type: string; text: string }>; isError?: boolean }; error?: unknown } | null = null;
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) rpc = JSON.parse(trimmed);
  else {
    const dataLines = trimmed.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    for (let i = dataLines.length - 1; i >= 0; i -= 1) { try { rpc = JSON.parse(dataLines[i]); break; } catch { /* next */ } }
  }
  if (!rpc || rpc.error || !rpc.result) never(`unreadable MCP answer (HTTP ${res.status}): ${raw.slice(0, 200)}`);
  const text = (rpc!.result!.content || []).find((c) => c.type === "text")?.text;
  if (typeof text !== "string") never(`MCP answer without text: ${raw.slice(0, 200)}`);
  return { isError: rpc!.result!.isError === true, text: text! };
}

const writes = () => recorded.filter((r) => r.table === "rpc/move_agent_task_status");
const routeReads = () => recorded.filter((r) => r.table === "closeout_routes");
function reset(task: Record<string, unknown>, route: typeof scenario.route) {
  recorded.length = 0; logs.length = 0;
  scenario.task = {
    id: TASK_ID, title: "probe", status: "Agent Working", risk: "low", agent_code: null,
    claimed_by: AGENT, claim_token: TOKEN, explicit_approval: false, project_slug: "brain-bank",
    desired_outcome: "A working fix", ...task,
  };
  scenario.route = route;
}
const freshRow = (slug: string, over: Record<string, unknown> = {}) => ({
  slug, has_workspace: true, has_tracker: true, has_session_log: true, has_capture_tag: true,
  published_at: new Date(Date.now() - 3600_000).toISOString(), ...over,
});

const CLEAN = [
  "Work summary: probe", "Verification: probe", "Touched files or records: none", "Limitations: none",
  "Tracker draft: probe", "Session-log draft: probe", "Brain Bank capture draft: probe", "Follow-up recommendation: none",
].join("\n");

// P1
reset({}, { kind: "row", row: freshRow("brain-bank") });
let r = await complete(CLEAN);
expect("P1", !r.isError, `a clean receipt was refused: ${r.text.slice(0, 300)}`);
expect("P1", writes().length === 1, `expected one write, saw ${writes().length}`);
expect("P1", routeReads().length === 1 && routeReads()[0].url.includes("slug=eq.brain-bank"), `the route was not read for the slug: ${routeReads().map((x) => x.url).join(" ")}`);
const p1 = JSON.parse(r.text);
expect("P1", p1.receipt === "AGENT DONE" && p1.warnings === undefined, `answer shape: ${r.text.slice(0, 200)}`);
const p1Body = writes()[0].body as Record<string, unknown>;
expect("P1", p1Body.p_reason === CLEAN && p1Body.p_status === "Agent Review", `write payload: ${JSON.stringify(p1Body).slice(0, 200)}`);
origLog("PASS P1 clean receipt on a fresh complete route: route read once, one write, no warnings");

// P2
const held = JSON.parse(await Deno.readTextFile(new URL("./fixtures/complete-contract-held-receipts.json", import.meta.url)));
for (const c of held.cases as Array<Record<string, unknown>>) {
  reset({ project_slug: c.project_slug, desired_outcome: c.desired_outcome, title: c.card },
    { kind: "row", row: c.project_slug ? freshRow(String(c.project_slug)) : null });
  r = await complete(String(c.receipt));
  const want = (c.expected_complete_refusal as string[]).join(", ");
  expect(`P2 ${c.card}`, r.isError, `accepted: ${r.text.slice(0, 200)}`);
  expect(`P2 ${c.card}`, r.text.includes(`COMPLETE_REFUSED (${want})`), `refusal does not name (${want}): ${r.text.slice(0, 300)}`);
  expect(`P2 ${c.card}`, writes().length === 0, `a refused completion wrote ${writes().length} time(s)`);
  expect(`P2 ${c.card}`, logs.some((l) => l === `[complete-contract] COMPLETE_REFUSED task=${TASK_ID} action=complete reasons=${(c.expected_complete_refusal as string[]).join(",")}`), `no refusal log line: ${logs.filter((l) => l.includes("complete-contract")).join(" | ")}`);
}
origLog(`PASS P2 all ${held.cases.length} reconstructed held receipts refused with their reasons and no write`);

// P3
for (const [field, reason] of [["has_workspace", "UNRESOLVED_WORKSPACE_PATH"], ["has_tracker", "UNRESOLVED_TRACKER_PATH"], ["has_session_log", "UNRESOLVED_SESSION_LOG_PATH"], ["has_capture_tag", "MISSING_CAPTURE_TAG"]]) {
  reset({}, { kind: "row", row: freshRow("brain-bank", { [field]: false }) });
  r = await complete(CLEAN);
  expect("P3", r.isError && r.text.includes(`COMPLETE_REFUSED (${reason})`), `${field}=false: ${r.text.slice(0, 200)}`);
  expect("P3", r.text.includes("hold_agent_task"), "the route refusal does not name the hold exit");
  expect("P3", writes().length === 0, `${field}=false wrote`);
}
origLog("PASS P3 each false capability on a fresh route refused with its reason and no write");

// P4
reset({ project_slug: null }, { kind: "row", row: freshRow("brain-bank") });
r = await complete(CLEAN);
expect("P4", r.isError && r.text.includes("COMPLETE_REFUSED (MISSING_PROJECT_SLUG)"), r.text.slice(0, 200));
expect("P4", writes().length === 0 && routeReads().length === 0, `writes ${writes().length}, route reads ${routeReads().length}`);
origLog("PASS P4 null project_slug refused, the route table not read, no write");

// P5
const stale = new Date(Date.now() - 8 * 86400_000).toISOString();
for (const [label, route, pattern] of [
  ["stale", { kind: "row", row: freshRow("brain-bank", { published_at: stale, has_tracker: false }) }, /older than 7 days/],
  ["absent", { kind: "absent", row: null }, /no row in closeout_routes/],
  ["read error", { kind: "error", row: null }, /snapshot read failed/],
] as Array<[string, typeof scenario.route, RegExp]>) {
  reset({}, route);
  r = await complete(CLEAN);
  expect(`P5 ${label}`, !r.isError, `refused: ${r.text.slice(0, 200)}`);
  expect(`P5 ${label}`, writes().length === 1, `expected one write, saw ${writes().length}`);
  const body = JSON.parse(r.text);
  expect(`P5 ${label}`, Array.isArray(body.warnings) && body.warnings.length === 1 && body.warnings[0].code === "ROUTE_SNAPSHOT_UNAVAILABLE" && pattern.test(body.warnings[0].message), `warnings: ${JSON.stringify(body.warnings)}`);
  expect(`P5 ${label}`, logs.some((l) => l === `[complete-contract] ROUTE_SNAPSHOT_UNAVAILABLE task=${TASK_ID} action=complete slug=brain-bank`), `no warning log line: ${logs.filter((l) => l.includes("complete-contract")).join(" | ")}`);
}
origLog("PASS P5 stale, absent and unreadable snapshots: accepted, one write each, ROUTE_SNAPSHOT_UNAVAILABLE in the answer");

// P6
reset({ project_slug: null }, { kind: "row", row: null });
r = await complete(CLEAN, "someone-else");
expect("P6", r.isError && r.text.includes("Agent can only update tasks it has claimed") && !r.text.includes("COMPLETE_REFUSED"), r.text.slice(0, 200));
expect("P6", writes().length === 0 && routeReads().length === 0, "another agent's call reached the contract");
origLog("PASS P6 another agent's call fails on ownership first; the contract is not consulted");

// P7
const heldD = (held.cases as Array<Record<string, unknown>>).find((c) => c.card === "d055613a")!;
reset({ project_slug: heldD.project_slug, desired_outcome: heldD.desired_outcome }, { kind: "row", row: freshRow(String(heldD.project_slug)) });
r = await complete(String(heldD.receipt), AGENT, "request_agent_review");
expect("P7", r.isError && r.text.includes("COMPLETE_REFUSED (DELIVERABLE_WITHOUT_OPERATOR_ACTION)"), `request_agent_review accepted a held receipt: ${r.text.slice(0, 200)}`);
expect("P7", writes().length === 0, `request_agent_review refusal wrote ${writes().length} time(s)`);
reset({}, { kind: "row", row: freshRow("brain-bank") });
r = await complete(CLEAN, AGENT, "request_agent_review");
expect("P7", !r.isError && writes().length === 1, `request_agent_review clean: isError=${r.isError} writes=${writes().length} ${r.text.slice(0, 200)}`);
origLog("PASS P7 request_agent_review (same AGENT DONE event): held receipt refused with no write, clean receipt writes once");

console.log = origLog; console.error = origErr;
console.log("COMPLETE CONTRACT PROBE PASSED");
Deno.exit(0);
