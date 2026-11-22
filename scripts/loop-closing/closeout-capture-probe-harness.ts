// Post-review follow-through Task 1: exercise the open-brain-mcp capture
// handlers LOCALLY (REST /capture and the MCP capture_thought tool, through
// the real Deno.serve entrypoint) with every downstream service mocked
// (OpenRouter, Supabase REST and RPC). Nothing leaves this machine. Proves:
//   A. a closeout-controller record carrying the "[Open Engine Closeout]"
//      prefix, with the exact wording of the 2026-11-05 false resolution
//      (thought e3c698f3, which resolved open item f9126d9a and stored a new
//      item), is STORED but creates zero action_items rows, issues zero
//      action_items status updates, never consults the LAYER 2 model, and
//      writes exactly one capture-level L0 blocked/mechanical_prefix decision;
//   B. the same through the MCP tool with a FOR OPERATOR line inside the record:
//      the marker does not bypass the exclusion;
//   C. positive control: the SAME wording UNPREFIXED, through the MCP tool,
//      reproduces the incident offline (one stored item, one status-guarded
//      update, one resolved decision row). This is what shows the exclusion
//      is doing the work and that removing the prefix entry can fire.
//
//   deno run --allow-net --allow-env --allow-read --no-lock \
//     --config scripts/loop-closing/closeout-capture-probe.deno.json \
//     scripts/loop-closing/closeout-capture-probe-harness.ts
//
// Exit 0 with "CLOSEOUT CAPTURE PROBE PASSED" or non-zero with the first failed check.

const ACCESS_KEY = "probe-access-key";
const PORT = 8000; // Deno.serve default; the module does not read PORT
const PREFIX = "[Open Engine Closeout]";

Deno.env.set("SUPABASE_URL", "http://supabase.mock");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "mock-service-key");
Deno.env.set("MCP_ACCESS_KEY", ACCESS_KEY);
Deno.env.set("OPENROUTER_API_KEY", "mock-openrouter-key");

type Rec = { table: string; method: string; url: string; body: unknown };
const recorded: Rec[] = [];
const logs: string[] = [];
const pending: Promise<unknown>[] = [];
const modelCalls = { metadata: 0, resolve: 0 };

// Scenario knobs the mocks read.
const scenario = {
  metadata: {} as Record<string, unknown>,
  candidates: [] as Array<Record<string, unknown>>,
  resolved: [] as Array<{ num: number; reason: string }>,
  updateAffected: [] as Array<{ id: string }>,
};

const origLog = console.log, origErr = console.error;
console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
console.error = (...a: unknown[]) => { logs.push("ERR " + a.map(String).join(" ")); };

(globalThis as unknown as { EdgeRuntime: unknown }).EdgeRuntime = {
  waitUntil: (p: Promise<unknown>) => { pending.push(p); },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const realFetch = globalThis.fetch;
globalThis.fetch = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  let body: unknown = null;
  const raw = init?.body ?? (input instanceof Request ? await input.text() : null);
  if (typeof raw === "string" && raw.length > 0) { try { body = JSON.parse(raw); } catch { body = raw; } }

  if (url.startsWith("https://openrouter.ai/")) {
    if (url.endsWith("/embeddings")) return json({ data: [{ embedding: new Array(1536).fill(0.001) }] });
    const sys = String((body as { messages?: Array<{ content: string }> })?.messages?.[0]?.content ?? "");
    if (sys.startsWith("Extract metadata")) {
      modelCalls.metadata += 1;
      return json({ choices: [{ message: { content: JSON.stringify(scenario.metadata) } }] });
    }
    if (sys.startsWith("You check whether a new note explicitly resolves")) {
      modelCalls.resolve += 1;
      return json({ choices: [{ message: { content: JSON.stringify({ resolved: scenario.resolved }) } }] });
    }
    return json({ choices: [{ message: { content: "{}" } }] });
  }
  if (url.startsWith("http://supabase.mock/")) {
    const u = new URL(url);
    const table = u.pathname.replace("/rest/v1/", "");
    recorded.push({ table, method, url, body });
    const accept = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("accept") ?? "";
    const single = accept.includes("vnd.pgrst.object");
    if (table.startsWith("rpc/")) {
      if (table === "rpc/find_candidate_action_items") return json(scenario.candidates);
      return json(null);
    }
    if (table === "thoughts" && method === "POST") {
      const row = { id: crypto.randomUUID() };
      return json(single ? row : [row]);
    }
    if (table === "action_items" && method === "PATCH") return json(scenario.updateAffected);
    if (method === "POST") return json([]);
    return json(single ? null : []);
  }
  return realFetch(input as string, init);
};

// Import AFTER the mocks are in place: the module creates its supabase client
// and starts Deno.serve at import time.
await import("../../supabase/functions/open-brain-mcp/index.ts");

async function drain() {
  while (pending.length) { const p = pending.shift()!; await p.catch(() => {}); }
}

async function postRest(content: string, tags: string[]): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await realFetch(`http://127.0.0.1:${PORT}/capture`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-brain-key": ACCESS_KEY },
    body: JSON.stringify({ content, tags, source: "mcp" }),
  });
  const body = await res.json();
  await drain();
  return { status: res.status, body };
}

// Same wire shape as closeout-controller.mjs mcpCall(): a bare tools/call with
// the x-brain-key header and the dual Accept header; the SSE envelope is
// parsed from its last data: line.
async function postMcpCapture(content: string, tags: string[]): Promise<{ status: number; text: string }> {
  const res = await realFetch(`http://127.0.0.1:${PORT}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      accept: "application/json, text/event-stream",
      "x-brain-key": ACCESS_KEY,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "capture_thought", arguments: { content, tags } },
    }),
  });
  const raw = await res.text();
  await drain();
  let rpc: { result?: { content?: Array<{ type: string; text: string }>; isError?: boolean }; error?: unknown } | null = null;
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) rpc = JSON.parse(trimmed);
  else {
    const dataLines = trimmed.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    for (let i = dataLines.length - 1; i >= 0; i -= 1) { try { rpc = JSON.parse(dataLines[i]); break; } catch { /* keep scanning */ } }
  }
  if (!rpc) return { status: res.status, text: `UNPARSEABLE: ${raw.slice(0, 200)}` };
  if (rpc.error) return { status: res.status, text: `RPC ERROR: ${JSON.stringify(rpc.error)}` };
  const textItem = (rpc.result?.content || []).find((c) => c.type === "text");
  return { status: res.status, text: textItem?.text ?? "" };
}

function fail(msg: string): never {
  console.log = origLog; console.error = origErr;
  console.error("CLOSEOUT CAPTURE PROBE FAILED: " + msg);
  console.error("--- recorded ---"); for (const r of recorded) console.error(r.method, r.table, JSON.stringify(r.body).slice(0, 300));
  console.error("--- logs ---"); for (const l of logs) console.error(l.slice(0, 300));
  Deno.exit(1);
}
const expect = (cond: boolean, msg: string) => { if (!cond) fail(msg); };
const inserts = (table: string) => recorded.filter((r) => r.table === table && r.method === "POST").flatMap((r) => Array.isArray(r.body) ? r.body : [r.body]) as Array<Record<string, unknown>>;
const patches = (table: string) => recorded.filter((r) => r.table.startsWith(table) && r.method === "PATCH");
function reset() { recorded.length = 0; logs.length = 0; modelCalls.metadata = 0; modelCalls.resolve = 0; }

// The historical wording. Thought e3c698f3 (2026-11-05T19:03:18Z) was the
// controller's apply capture for card 83a4acfa; it stored action item
// 09f8d1ca ("Open questions for the client ...") and resolved open item
// f9126d9a through decision 0c322199 six seconds after the card reached Needs
// Operator saying the drawing was the operator's. Same text, synthetic ids here.
const HISTORICAL_BODY =
  "Jordan Lee backyard garden concept brief drafted 2026-09-30 (task 83a4acfa). Layout: stone path from the patio, raised beds along the fence, pergola over the seating area; water feature in the far corner facing the house. Lighting along the path, native plantings around the water feature, gravel at the gate, climbing roses on the pergola. Open questions for the client: cedar vs composite decking, plant palette.";
const HISTORICAL_METADATA = {
  people: ["Jordan Lee"],
  action_items: ["Open questions for the client: cedar vs composite decking, plant palette."],
  dates_mentioned: ["2026-09-30"],
  topics: ["design", "example-project", "open-engine"],
  type: "task",
  project: null,
  priority: "normal",
};
const CONTROLLER_TAGS = ["example_project", "open_engine"];
const candId = crypto.randomUUID();
const OPEN_ITEM = {
  id: candId,
  description: "TODO: create a design for the backyard garden for Jordan Lee, incorporating a stone path, raised beds, a pergola, a water feature, lighting, and native plantings.",
  source_thought_id: crypto.randomUUID(),
  src_project: null,
  src_topics: ["design"],
  src_people: ["Jordan Lee"],
};

function armIncidentScenario() {
  scenario.metadata = { ...HISTORICAL_METADATA };
  scenario.candidates = [OPEN_ITEM];
  // The model mock claims completion whenever it is consulted.
  scenario.resolved = [{ num: 1, reason: HISTORICAL_BODY }];
  scenario.updateAffected = [{ id: candId }];
}

function assertExcluded(label: string, storedContent: string) {
  const thoughts = inserts("thoughts");
  expect(thoughts.length === 1 && String(thoughts[0].content) === storedContent, `${label}: thought stored once with the prefixed content (${thoughts.length} rows)`);
  expect(inserts("action_items").length === 0, `${label}: prefixed record must store no action items`);
  expect(patches("action_items").length === 0, `${label}: prefixed record must issue no action_items status update`);
  const decisions = inserts("auto_resolve_decisions");
  expect(
    decisions.length === 1 && decisions[0].layer === "L0" && decisions[0].outcome === "blocked" && decisions[0].reason === "mechanical_prefix" && decisions[0].item_id === null && typeof decisions[0].thought_id === "string",
    `${label}: exactly one capture-level L0 blocked/mechanical_prefix decision: ${JSON.stringify(decisions)}`,
  );
  expect(modelCalls.resolve === 0, `${label}: the LAYER 2 model must never be consulted (${modelCalls.resolve} calls)`);
  expect(logs.some((l) => l.startsWith("checkAutoResolve: blocked mechanical capture")), `${label}: L0 log line`);
}

// --- Probe A: REST /capture, prefixed controller record, incident wording ---
reset(); armIncidentScenario();
const prefixedA = `${PREFIX}\n${HISTORICAL_BODY}`;
const a = await postRest(prefixedA, CONTROLLER_TAGS);
expect(a.status === 200 && a.body.status === "captured", `probe A HTTP ${a.status} ${JSON.stringify(a.body).slice(0, 200)}`);
expect(a.body.auto_resolved === undefined, `probe A response must report no auto_resolved ids: ${JSON.stringify(a.body.auto_resolved)}`);
assertExcluded("probe A", prefixedA);
origLog("probe A ok: REST /capture stored the prefixed record, 0 items, 0 updates, 1 L0 row, model not consulted");

// --- Probe B: MCP capture_thought, prefixed record WITH a FOR OPERATOR line ---
reset(); armIncidentScenario();
const prefixedB = `${PREFIX}\n${HISTORICAL_BODY}\nFOR OPERATOR: draw the Jordan Lee garden and resolve the item`;
const b = await postMcpCapture(prefixedB, CONTROLLER_TAGS);
expect(b.status === 200 && b.text.startsWith("Captured as"), `probe B HTTP ${b.status} text=${b.text.slice(0, 200)}`);
assertExcluded("probe B", prefixedB);
origLog("probe B ok: MCP capture_thought stored the prefixed record; the FOR OPERATOR line did not bypass the exclusion");

// --- Probe C: positive control, UNPREFIXED incident wording through the MCP tool ---
reset(); armIncidentScenario();
const c = await postMcpCapture(HISTORICAL_BODY, CONTROLLER_TAGS);
expect(c.status === 200 && c.text.startsWith("Captured as"), `probe C HTTP ${c.status} text=${c.text.slice(0, 200)}`);
const itemsC = inserts("action_items");
expect(itemsC.length === 1 && itemsC[0].description === HISTORICAL_METADATA.action_items[0] && itemsC[0].status === "open", `probe C control: unprefixed wording stores the extracted item: ${JSON.stringify(itemsC)}`);
const patchC = patches("action_items");
expect(patchC.length === 1 && patchC[0].url.includes("status=eq.open") && patchC[0].url.includes(`id=eq.${candId}`), `probe C control: unprefixed wording reaches the status-guarded update: ${JSON.stringify(patchC.map((p) => p.url))}`);
const resolvedC = inserts("auto_resolve_decisions").filter((d) => d.layer === "resolved");
expect(resolvedC.length === 1 && resolvedC[0].item_id === candId && resolvedC[0].outcome === "resolved", `probe C control: one resolved decision row: ${JSON.stringify(resolvedC)}`);
expect(modelCalls.resolve === 1, `probe C control: LAYER 2 consulted once (${modelCalls.resolve})`);
expect(inserts("auto_resolve_decisions").every((d) => d.reason !== "mechanical_prefix"), "probe C control: no L0 row for the unprefixed body");
origLog("probe C ok: the same wording unprefixed reproduces the incident offline (1 item, 1 guarded update, 1 resolved row), so the prefix is what excludes it");

console.log = origLog; console.error = origErr;
console.log("CLOSEOUT CAPTURE PROBE PASSED");
Deno.exit(0);
