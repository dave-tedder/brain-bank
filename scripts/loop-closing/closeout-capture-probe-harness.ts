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
//   D/E. (loop-closing Task 5.1) the fragment gate through REST /capture (D) and
//      the MCP capture_thought tool (E): the plan's eight items store four
//      (original text), four fragment/dropped rows name one_token or
//      dangling_clause, and the pronoun-object item gets a
//      fragment/proposed/pronoun_object row carrying the id the insert returned.
//   F/G. (loop-closing Task 5.2) dedup through REST /capture (F) and the MCP
//      capture_thought tool (G): two identical strings in one batch insert once
//      with a dedup/dropped/exact_batch row naming the survivor the insert
//      returned; a reworded copy of a recent open item is inserted AND proposed
//      through ONE record_decisions call (dedup/proposed/semantic_overlap).

//   I/J. LAYER 2 claim indices through REST /capture (I) and the MCP
//      capture_thought tool (J): a fractional claim (1.5, and a bare 2.5) and a
//      claim of 0 are ignored without a throw, the later valid claims (2 and 3)
//      still resolve through the guarded transition with their resolved rows,
//      and the index-0 candidate gets its L2 not_claimed row.
//
//   L/N. (loop-closing Task 5.3) client identity per item through REST /capture
//      (L) and the MCP capture_thought tool (N).
//   M. (loop-closing Task 5.3) REST /event: a created session proposes closing
//      the client's scheduling item through one record_decisions call; an
//      update re-runs the matcher for the same pair; nothing resolves.
//
//   deno run --config scripts/loop-closing/closeout-capture-probe.deno.json --no-lock --allow-net --allow-env --allow-read scripts/loop-closing/closeout-capture-probe-harness.ts
// The config is required: without it the run dies before any probe, because the
// function's pinned zod 3.24.2 has no ./v3 subpath.
//
// Exit 0 with "CLOSEOUT CAPTURE PROBE PASSED" or non-zero with the first failed check.

// The check the TS mutant sweep certifies goes through claimVerdict (Codex
// re-review 2, N1): the claim records its entry and verdict at run time and
// its tag ends the FAILED line, so a direct fail() can never stand in for it.
import { claimVerdict } from "./claim.ts";

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
// Rows the action_items insert returned (Task 5.1 asks for id, description).
const returnedItems: Array<{ id: string; description: string }> = [];

// Scenario knobs the mocks read.
const scenario = {
  metadata: {} as Record<string, unknown>,
  candidates: [] as Array<Record<string, unknown>>,
  resolved: [] as Array<{ num: number; reason: string } | number>,
  updateAffected: [] as Array<{ id: string }>,
  semanticCandidates: [] as Array<Record<string, unknown>>,
  // Task 5.3: clients (name read, find_client, the CRM id), the client's
  // open items the booking matcher reads, and the business_events rows the
  // REST /event route writes and the matcher re-reads.
  clients: [] as Array<{ id: string; name: string; crm_id?: string }>,
  clientItems: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
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
      if (table === "rpc/transition_action_item") return json(scenario.updateAffected.length);
      if (table === "rpc/dedup_semantic_candidates") return json(scenario.semanticCandidates);
      if (table === "rpc/record_decisions") return json(Array.isArray((body as { p_rows?: unknown[] })?.p_rows) ? (body as { p_rows: unknown[] }).p_rows.length : null);
      if (table === "rpc/sync_booking_proposals") return json(Array.isArray((body as { p_rows?: unknown[] })?.p_rows) ? (body as { p_rows: unknown[] }).p_rows.length : null);
      // Task 5.3 correction 3: the roster and a client's open items are ONE
      // call each, answered as one jsonb value with its count.
      if (table === "rpc/client_roster") {
        const sorted = [...scenario.clients].sort((a, b) => (a.id < b.id ? -1 : 1));
        return json({ read_at: new Date().toISOString(), total: sorted.length, clients: sorted.map((c) => ({ id: c.id, name: c.name })) });
      }
      if (table === "rpc/booking_match_read") {
        // Task 5.3 correction 4: the matcher's one read (event, roster with
        // the CRM keys, every open item that carries a client).
        const eid = (body as { p_event_id?: string })?.p_event_id;
        const ev = scenario.events.find((e) => e.id === eid);
        const clients = [...scenario.clients].sort((a, b) => (a.id < b.id ? -1 : 1));
        const items = scenario.clientItems.filter((i) => i.client_id && i.status === "open").sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
        return json({
          read_at: new Date().toISOString(),
          event: ev ? { id: ev.id, title: ev.title ?? null, event_type: ev.event_type ?? null, date_start: ev.date_start ?? null, metadata: ev.metadata ?? null } : null,
          clients_total: clients.length,
          clients: clients.map((c) => ({ id: c.id, name: c.name, crm_id: c.crm_id ?? null })),
          items_total: items.length,
          items: items.map((i) => ({ id: i.id, client_id: i.client_id, description: i.description, created_at: i.created_at, status: i.status })),
        });
      }
      return json(null);
    }
    if (table === "thoughts" && method === "POST") {
      const row = { id: crypto.randomUUID() };
      return json(single ? row : [row]);
    }
    if (table === "clients" && method === "GET") {
      const cb = u.searchParams.get("metadata->>crm_id");
      if (cb && cb.startsWith("eq.")) {
        return json(scenario.clients.filter((c) => c.crm_id === cb.slice(3)).map((c) => ({ id: c.id })));
      }
      // Otherwise only the foreign-key re-check reads the table (id in (...)).
      const ids = (u.searchParams.get("id") ?? "").replace(/^in\.\(|\)$/g, "").split(",").filter(Boolean);
      return json(scenario.clients.filter((c) => ids.includes(c.id)).map((c) => ({ id: c.id })));
    }
    if (table === "business_events") {
      if (method === "POST") {
        const row = { id: crypto.randomUUID(), ...(body as Record<string, unknown>) };
        scenario.events.push(row);
        return json(single ? { id: row.id } : [{ id: row.id }], 201);
      }
      if (method === "PATCH") {
        const id = (u.searchParams.get("id") ?? "").replace(/^eq\./, "");
        for (const ev of scenario.events) if (ev.id === id) Object.assign(ev, body as Record<string, unknown>);
        return json([], 200);
      }
      const id = u.searchParams.get("id");
      if (id) return json(scenario.events.filter((ev) => `eq.${ev.id}` === id));
      const cs = u.searchParams.get("metadata");
      if (cs && cs.startsWith("cs.")) {
        const want = JSON.parse(cs.slice(3)) as Record<string, unknown>;
        return json(scenario.events.filter((ev) => Object.entries(want).every(([k, v]) => (ev.metadata as Record<string, unknown> | null)?.[k] === v)));
      }
      return json([]);
    }
    if (table === "action_items" && method === "PATCH") return json(scenario.updateAffected);
    if (table === "action_items" && method === "POST") {
      const rows = (Array.isArray(body) ? body : [body]) as Array<{ description: string }>;
      const back = rows.map((r) => ({ id: crypto.randomUUID(), description: r.description }));
      returnedItems.push(...back);
      return json(back, 201);
    }
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
const expectClaimed = (tag: string | null, msg: string) => { if (tag !== null) fail(`${msg} ${tag}`); };
const inserts = (table: string) => recorded.filter((r) => r.table === table && r.method === "POST").flatMap((r) => Array.isArray(r.body) ? r.body : [r.body]) as Array<Record<string, unknown>>;
const patches = (table: string) => recorded.filter((r) => (r.table.startsWith(table) && r.method === "PATCH") || (table === "action_items" && r.table === "rpc/transition_action_item"));
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
expect(patchC.length === 1 && patchC[0].table === "rpc/transition_action_item" && JSON.stringify((patchC[0].body as Record<string, unknown>).p_from_statuses) === '["open"]', `probe C control: unprefixed wording reaches the status-guarded transition: ${JSON.stringify(patchC.map((p) => p.url))}`);
const resolvedC = inserts("auto_resolve_decisions").filter((d) => d.layer === "resolved");
expect(resolvedC.length === 1 && resolvedC[0].item_id === candId && resolvedC[0].outcome === "resolved", `probe C control: one resolved decision row: ${JSON.stringify(resolvedC)}`);
expect(modelCalls.resolve === 1, `probe C control: LAYER 2 consulted once (${modelCalls.resolve})`);
expect(inserts("auto_resolve_decisions").every((d) => d.reason !== "mechanical_prefix"), "probe C control: no L0 row for the unprefixed body");
origLog("probe C ok: the same wording unprefixed reproduces the incident offline (1 item, 1 guarded update, 1 resolved row), so the prefix is what excludes it");

// --- Probes D and E (Task 5.1): the fragment gate through both entrypoints ---
const PLAN_ITEMS_5_1 = [
  "deploy", "switch on", "then deploy", "finalize what we're",
  "Awaiting the operator to apply migration 063", "send Sam the explainer PDF",
  "send her the explainer PDF", "nudge Jordan if nothing arrives",
];
function armFragmentScenario() {
  scenario.metadata = { people: ["Sam"], action_items: PLAN_ITEMS_5_1, dates_mentioned: [], topics: ["koi"], type: "task", project: null, priority: "normal" };
  scenario.candidates = []; scenario.resolved = []; scenario.updateAffected = [];
  returnedItems.length = 0;
}
function assertFragmentGate(label: string) {
  const items = inserts("action_items");
  expectClaimed(
    claimVerdict("gate-rows", () => JSON.stringify(items.map((r) => r.description)) === JSON.stringify(["Awaiting the operator to apply migration 063", "send Sam the explainer PDF", "send her the explainer PDF", "nudge Jordan if nothing arrives"])),
    `${label}: action_items rows (original text, fragments dropped): ${JSON.stringify(items)}`,
  );
  const frag = inserts("auto_resolve_decisions").filter((d) => d.layer === "fragment");
  const drops = frag.filter((d) => d.outcome === "dropped");
  expect(
    JSON.stringify(drops.map((d) => [d.candidate_description, d.reason])) === JSON.stringify([["deploy", "one_token"], ["switch on", "one_token"], ["then deploy", "one_token"], ["finalize what we're", "dangling_clause"]]),
    `${label}: fragment drop rows: ${JSON.stringify(drops)}`,
  );
  expect(drops.every((d) => d.item_id === null && typeof d.thought_id === "string" && d.thought_id === drops[0].thought_id), `${label}: drop rows: item_id null, one thought_id`);
  const herId = returnedItems.find((r) => r.description === "send her the explainer PDF")?.id;
  const sus = frag.filter((d) => d.outcome === "proposed");
  expect(
    herId !== undefined && sus.length === 1 && sus[0].reason === "pronoun_object" && sus[0].item_id === herId &&
      sus[0].thought_id === drops[0].thought_id && sus[0].candidate_description === "send her the explainer PDF",
    `${label}: suspect row: ${JSON.stringify(sus)} (returned ${JSON.stringify(returnedItems)})`,
  );
  expect(frag.length === 5, `${label}: exactly five fragment rows (${frag.length})`);
  expect(logs.filter((l) => l.startsWith("fragment gate: dropped item (")).length === 4, `${label}: four drop log lines`);
}

reset(); armFragmentScenario();
const d = await postRest("Loop-closing probe D: notes from the koi consult with Sam and Jordan.", ["koi"]);
expect(d.status === 200 && d.body.status === "captured", `probe D HTTP ${d.status} ${JSON.stringify(d.body).slice(0, 200)}`);
assertFragmentGate("probe D");
origLog("probe D ok: REST /capture stored 4 items, 4 fragment drop rows (3 one_token, 1 dangling_clause), 1 pronoun_object suspect with the inserted id");

reset(); armFragmentScenario();
const e = await postMcpCapture("Loop-closing probe E: notes from the koi consult with Sam and Jordan.", ["koi"]);
expect(e.status === 200 && e.text.startsWith("Captured as"), `probe E HTTP ${e.status} text=${e.text.slice(0, 200)}`);
assertFragmentGate("probe E");
origLog("probe E ok: MCP capture_thought stored 4 items, 4 fragment drop rows, 1 pronoun_object suspect with the inserted id");

// --- Probes F and G (Task 5.2): dedup through both entrypoints ---
const CAND_FG = "c52f0000-0000-4000-8000-000000000001";
function armDedupScenario(tag: string) {
  scenario.metadata = {
    people: ["Sam"],
    action_items: [`Add Casey as guest when his email address arrives ${tag}`, `Send Sam the ${tag} flash deck`, `send sam the ${tag} flash deck.`],
    dates_mentioned: [], topics: ["brain-bank"], type: "task", project: null, priority: "normal",
  };
  scenario.semanticCandidates = [
    { id: CAND_FG, description: `Add Casey as a guest when his email arrives ${tag}`, created_at: "2026-11-19T12:00:00.000Z", source_thought_id: crypto.randomUUID(), project: "brain-bank" },
  ];
  scenario.candidates = []; scenario.resolved = []; scenario.updateAffected = [];
  returnedItems.length = 0;
}
function assertDedup(label: string, tag: string) {
  const casey = `Add Casey as guest when his email address arrives ${tag}`;
  const deck = `Send Sam the ${tag} flash deck`;
  const items = inserts("action_items");
  expectClaimed(
    claimVerdict("dedup-rows", () => JSON.stringify(items.map((r) => r.description)) === JSON.stringify([casey, deck])),
    `${label}: action_items rows (one copy of the deck, the reworded Casey item inserted): ${JSON.stringify(items)}`,
  );
  const deckId = returnedItems.find((r) => r.description === deck)?.id;
  const caseyId = returnedItems.find((r) => r.description === casey)?.id;
  const exact = inserts("auto_resolve_decisions").filter((d) => d.layer === "dedup");
  expectClaimed(
    claimVerdict("dedup-exact-batch", () =>
      deckId !== undefined && JSON.stringify(exact.map((d) => [d.outcome, d.reason, d.candidate_description, d.related_item_id, d.item_id, typeof d.thought_id])) ===
        JSON.stringify([["dropped", "exact_batch", `send sam the ${tag} flash deck.`, deckId, null, "string"]])),
    `${label}: exact_batch row: ${JSON.stringify(exact)} (returned ${JSON.stringify(returnedItems)})`,
  );
  const calls = recorded.filter((r) => r.table === "rpc/record_decisions").map((r) => (r.body as { p_rows: Array<Record<string, unknown>> }).p_rows);
  expectClaimed(
    claimVerdict("dedup-semantic", () =>
      caseyId !== undefined && calls.length === 1 &&
      JSON.stringify(calls[0].map((r) => [r.layer, r.outcome, r.reason, r.item_id, r.related_item_id, r.score, r.thought_id, r.candidate_description])) ===
        JSON.stringify([["dedup", "proposed", "semantic_overlap", caseyId, CAND_FG, 1, null, casey]])),
    `${label}: semantic proposal through record_decisions: ${JSON.stringify(calls)} (returned ${JSON.stringify(returnedItems)})`,
  );
  expect(
    recorded.findIndex((r) => r.table === "rpc/dedup_semantic_candidates") >= 0 &&
      recorded.findIndex((r) => r.table === "rpc/dedup_semantic_candidates") < recorded.findIndex((r) => r.table === "action_items" && r.method === "POST"),
    `${label}: the candidates are read before the insert: ${JSON.stringify(recorded.map((r) => `${r.method} ${r.table}`))}`,
  );
}

reset(); armDedupScenario("probeF");
const f = await postRest("Loop-closing probe F: the Casey guest pass and the flash deck for Sam.", ["brain-bank"]);
expect(f.status === 200 && f.body.status === "captured", `probe F HTTP ${f.status} ${JSON.stringify(f.body).slice(0, 200)}`);
assertDedup("probe F", "probeF");
origLog("probe F ok: REST /capture inserted one copy of the deck with an exact_batch row, and proposed the reworded Casey item through one record_decisions call");

reset(); armDedupScenario("probeG");
const g = await postMcpCapture("Loop-closing probe G: the Casey guest pass and the flash deck for Sam.", ["brain-bank"]);
expect(g.status === 200 && g.text.startsWith("Captured as"), `probe G HTTP ${g.status} text=${g.text.slice(0, 200)}`);
assertDedup("probe G", "probeG");
scenario.semanticCandidates = [];
origLog("probe G ok: MCP capture_thought inserted one copy of the deck with an exact_batch row, and proposed the reworded Casey item through one record_decisions call");

// --- Probe H (Codex review 1 of PR 33, R4): numbered obligations stay distinct
// through REST /capture, i.e. the shared copy and the normalizeActionText
// capture-pipeline.ts imports (_shared/capture-helpers.ts since correction 3).
// Both items insert and the batch dedup records nothing.
reset();
const NUMBERED_H = ["send Sam design 1", "send Sam design 2"];
scenario.metadata = { people: ["Sam"], action_items: NUMBERED_H, dates_mentioned: [], topics: ["koi"], type: "task", project: null, priority: "normal" };
scenario.candidates = []; scenario.resolved = []; scenario.updateAffected = []; scenario.semanticCandidates = [];
returnedItems.length = 0;
const h = await postRest("Loop-closing probe H: two numbered designs still need to go out to Sam.", ["koi"]);
expect(h.status === 200 && h.body.status === "captured", `probe H HTTP ${h.status} ${JSON.stringify(h.body).slice(0, 200)}`);
const itemsH = inserts("action_items");
const dedupH = inserts("auto_resolve_decisions").filter((d) => d.layer === "dedup");
expectClaimed(
  claimVerdict("numbered-rows", () => JSON.stringify(itemsH.map((r) => r.description)) === JSON.stringify(NUMBERED_H) && dedupH.length === 0),
  `probe H: action_items rows (both numbered items insert, no dedup row): ${JSON.stringify(itemsH)} ${JSON.stringify(dedupH)}`,
);
origLog("probe H ok: REST /capture inserted both numbered items (design 1, design 2) and wrote no dedup row");

// --- Probes L and N (loop-closing Task 5.3): client identity per item through
// REST /capture (L) and the MCP capture_thought tool (N), i.e. the shared
// copy. Each item's own text is searched; client_id is set only when
// find_client's query returns exactly one row.
const ALICIA_L = "a11c1a00-0000-4000-8000-0000000000a1";
const JAKE_L = "1a4e0000-0000-4000-8000-0000000000a1";
const CLIENTS_L = [
  { id: ALICIA_L, name: "Alicia Brennan", crm_id: "cb-alicia-probe" },
  { id: JAKE_L, name: "Jordan Marlow" },
  { id: "1a4e0000-0000-4000-8000-0000000000a2", name: "Jordan Ruiz" },
];
function assertClientIds(label: string, items: string[]) {
  const rows = inserts("action_items");
  expectClaimed(
    claimVerdict("client-ids", () =>
      JSON.stringify(rows.map((r) => [r.description, "client_id" in r ? r.client_id : "absent"])) ===
        JSON.stringify([[items[0], ALICIA_L], [items[1], JAKE_L], [items[2], "absent"]])),
    `${label}: client_id per item: ${JSON.stringify(rows)}`,
  );
}
reset();
scenario.clients = CLIENTS_L; scenario.candidates = []; scenario.resolved = []; scenario.updateAffected = []; scenario.semanticCandidates = [];
const ITEMS_L = ["Schedule tattoo appointment for Alicia Brennan", "Send Jordan Marlow the probe L floor plan sketch", "nudge Jordan if nothing arrives"];
scenario.metadata = { people: ["Alicia Brennan", "Jordan Marlow"], action_items: ITEMS_L, dates_mentioned: [], topics: ["koi"], type: "task", project: null, priority: "normal" };
returnedItems.length = 0;
const pl = await postRest("Loop-closing probe L: bookings and sketches for Alicia Brennan and Jordan Marlow still to do.", ["koi"]);
expect(pl.status === 200 && pl.body.status === "captured", `probe L HTTP ${pl.status} ${JSON.stringify(pl.body).slice(0, 200)}`);
assertClientIds("probe L", ITEMS_L);
origLog("probe L ok: REST /capture set client_id per item (Alicia, Jordan Marlow) and left nudge Jordan (two clients) without one");

reset();
const ITEMS_N = ["Schedule tattoo appointment for Alicia Brennan probe N", "Send Jordan Marlow the probe N floor plan sketch", "nudge Jordan if nothing arrives probe N"];
scenario.metadata = { people: ["Alicia Brennan", "Jordan Marlow"], action_items: ITEMS_N, dates_mentioned: [], topics: ["koi"], type: "task", project: null, priority: "normal" };
returnedItems.length = 0;
const pn = await postMcpCapture("Loop-closing probe N: bookings and sketches for Alicia Brennan and Jordan Marlow still to do.", ["koi"]);
expect(pn.status === 200 && pn.text.startsWith("Captured as"), `probe N HTTP ${pn.status} text=${pn.text.slice(0, 200)}`);
assertClientIds("probe N", ITEMS_N);
origLog("probe N ok: MCP capture_thought set client_id per item and left nudge Jordan without one");

// --- Probe M (loop-closing Task 5.3): REST /event, the open-brain-mcp event
// writer the Dash-Bot bridge and the calendar sync use. A created session for
// a client proposes closing her scheduling item through ONE
// sync_booking_proposals call (calendar/proposed/booking_match, typed event
// evidence, no thought id, the item's client and the event snapshot); an
// update of the same event (found by gcal id) syncs again for the same pair
// with the new snapshot, which the database turns into a support refresh
// with no new row (proven on a real cluster by client-identity-sql-test.sh);
// and nothing resolves.
reset();
const ITEM_M = "5c4ed000-0000-4000-8000-0000000000a1";
scenario.clientItems = [
  { id: ITEM_M, description: "Schedule tattoo appointment for Alicia Brennan", status: "open", client_id: ALICIA_L, created_at: "2026-11-20T14:00:00Z" },
  { id: "5c4ed000-0000-4000-8000-0000000000a2", description: "send Alicia the design", status: "open", client_id: ALICIA_L, created_at: "2026-11-20T14:00:00Z" },
];
scenario.events = [];
async function postEvent(payload: Record<string, unknown>) {
  const res = await realFetch(`http://127.0.0.1:${PORT}/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-brain-key": ACCESS_KEY },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  await drain();
  return { status: res.status, body };
}
const EVENT_M = { title: "Tattoo session: Alicia Brennan", event_type: "tattoo_session", date_start: "2099-01-16", metadata: { gcal_event_id: "probe-m@google.com", source: "dash-bot-create" } };
const m1 = await postEvent(EVENT_M);
expect(m1.status === 200 && m1.body.status === "created" && typeof m1.body.id === "string", `probe M create HTTP ${m1.status} ${JSON.stringify(m1.body)}`);
const callsM1 = recorded.filter((r) => r.table === "rpc/sync_booking_proposals").map((r) => r.body as { p_event_id: string; p_snapshot: Record<string, unknown>; p_rows: Array<Record<string, unknown>> });
expectClaimed(
  claimVerdict("event-proposes", () =>
    callsM1.length === 1 && callsM1[0].p_event_id === m1.body.id && callsM1[0].p_snapshot.title === "Tattoo session: Alicia Brennan" &&
    typeof (callsM1[0] as { p_read_at?: unknown }).p_read_at === "string" &&
    JSON.stringify(callsM1[0].p_rows.map((r) => [r.layer, r.outcome, r.reason, r.item_id, r.evidence_event_id, r.thought_id, r.evidence_thought_id, r.quote, r.client_id, r.item_description])) ===
      JSON.stringify([["calendar", "proposed", "booking_match", ITEM_M, m1.body.id, null, null, "Tattoo session: Alicia Brennan on 2099-01-16", ALICIA_L, "Schedule tattoo appointment for Alicia Brennan"]])),
  `probe M: booking proposal through sync_booking_proposals: ${JSON.stringify(callsM1)}`,
);
const m2 = await postEvent({ ...EVENT_M, location: "Studio B" });
expect(m2.status === 200 && m2.body.status === "updated" && m2.body.id === m1.body.id, `probe M update HTTP ${m2.status} ${JSON.stringify(m2.body)}`);
const callsM2 = recorded.filter((r) => r.table === "rpc/sync_booking_proposals").map((r) => r.body as { p_event_id: string; p_snapshot: Record<string, unknown>; p_rows: Array<Record<string, unknown>> });
expect(callsM2.length === 2 && JSON.stringify(callsM2[1].p_rows.map((r) => [r.item_id, r.evidence_event_id])) === JSON.stringify([[ITEM_M, m1.body.id]]),
  `probe M: the update re-runs the matcher for the same pair: ${JSON.stringify(callsM2)}`);
expect(recorded.filter((r) => r.table === "rpc/transition_action_item" || (r.table === "action_items" && r.method === "PATCH")).length === 0,
  `probe M: nothing resolves: ${JSON.stringify(recorded.map((r) => `${r.method} ${r.table}`))}`);
scenario.clients = []; scenario.clientItems = []; scenario.events = [];
origLog("probe M ok: REST /event proposed the client's scheduling item through one sync call on create, re-ran it on update, and resolved nothing");
// --- Probes I and J: invalid LAYER 2 claim indices are ignored; later claims still run. ---
// The (mocked) model answers with a fractional claim (1.5), a claim of 0 and a
// bare fractional number (2.5) BEFORE two valid claims (2, 3). Before the fix
// the 1.5 claim read candidateItems[0.5] (undefined) and threw, which ended the
// claim loop: no later claim resolved. Now the invalid claims are skipped, the
// two valid claims resolve, and candidate 1 (index 0), which no valid claim
// names, gets its L2 not_claimed row and nothing else.
function armClaimIndexScenario(tag: string) {
  const cands = [
    { id: crypto.randomUUID(), description: `send Sam the ${tag} deposit link` },
    { id: crypto.randomUUID(), description: `book the ${tag} koi consult with Jordan` },
    { id: crypto.randomUUID(), description: `order the ${tag} needle cartridges` },
  ].map((c) => ({ ...c, source_thought_id: crypto.randomUUID(), src_project: "brain-bank", src_topics: ["brain-bank"], src_people: [] }));
  scenario.metadata = { people: [], action_items: [], dates_mentioned: [], topics: ["brain-bank"], type: "observation", project: "Brain Bank", priority: "normal" };
  scenario.semanticCandidates = [];
  scenario.candidates = cands;
  scenario.resolved = [
    { num: 1.5, reason: cands[0].description },
    { num: 0, reason: cands[0].description },
    2.5,
    { num: 2, reason: cands[1].description },
    { num: 3, reason: cands[2].description },
  ];
  scenario.updateAffected = [{ id: cands[1].id }];
  return cands;
}
function claimIndexOutcome() {
  return {
    transitions: recorded.filter((r) => r.table === "rpc/transition_action_item").map((r) => (r.body as Record<string, unknown>).p_item_id),
    rows: inserts("auto_resolve_decisions").map((d) => [d.layer, d.outcome, d.reason, d.item_id]),
    threw: logs.filter((l) => l.includes("checkAutoResolve failed")),
  };
}
const claimIndexExpected = (cands: Array<{ id: string }>) => ({
  transitions: [cands[1].id, cands[2].id],
  rows: [
    ["L2", "dropped", "not_claimed", cands[0].id],
    ["resolved", "resolved", null, cands[1].id],
    ["resolved", "resolved", null, cands[2].id],
  ],
  threw: [],
});

reset();
const candsI = armClaimIndexScenario("probe I");
const resI = await postRest("Loop-closing probe I: booked the probe I koi consult with Jordan and ordered the probe I needle cartridges.", ["brain-bank"]);
expect(resI.status === 200 && resI.body.status === "captured", `probe I HTTP ${resI.status} ${JSON.stringify(resI.body).slice(0, 200)}`);
const outI = claimIndexOutcome();
expectClaimed(
  claimVerdict("claim-index-rest", () =>
    JSON.stringify(outI) === JSON.stringify(claimIndexExpected(candsI)) &&
    JSON.stringify(resI.body.auto_resolved) === JSON.stringify([candsI[1].description, candsI[2].description])),
  `probe I: claim indices (1.5, 0 and 2.5 ignored; 2 and 3 resolve; candidate 1 not_claimed): ${JSON.stringify(outI)} auto_resolved=${JSON.stringify(resI.body.auto_resolved)}`,
);
origLog("probe I ok: REST /capture ignored claims 1.5, 0 and 2.5 without a throw, resolved candidates 2 and 3, wrote candidate 1's not_claimed row");

reset();
const candsJ = armClaimIndexScenario("probe J");
const resJ = await postMcpCapture("Loop-closing probe J: booked the probe J koi consult with Jordan and ordered the probe J needle cartridges.", ["brain-bank"]);
expect(resJ.status === 200 && resJ.text.startsWith("Captured as"), `probe J HTTP ${resJ.status} text=${resJ.text.slice(0, 200)}`);
const outJ = claimIndexOutcome();
expect(JSON.stringify(outJ) === JSON.stringify(claimIndexExpected(candsJ)), `probe J: claim indices (1.5, 0 and 2.5 ignored; 2 and 3 resolve; candidate 1 not_claimed): ${JSON.stringify(outJ)}`);
scenario.candidates = []; scenario.resolved = []; scenario.updateAffected = [];
origLog("probe J ok: MCP capture_thought ignored claims 1.5, 0 and 2.5 without a throw, resolved candidates 2 and 3, wrote candidate 1's not_claimed row");

console.log = origLog; console.error = origErr;
console.log("CLOSEOUT CAPTURE PROBE PASSED");
Deno.exit(0);
