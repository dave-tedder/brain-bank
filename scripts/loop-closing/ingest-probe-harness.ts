// Loop-closing Phase 1: exercise the ingest-thought Slack capture path LOCALLY
// with a validly signed Slack event and every downstream service mocked
// (OpenRouter, Supabase REST and RPC, Slack chat.postMessage). Nothing leaves
// this machine. Proves, on the ingest copy of the pipeline:
//   1. a work-report capture with one FOR OPERATOR line stores exactly that one
//      action_items row and one gate/dropped/work_report decision row per
//      discarded extracted item, with the gate log line;
//   2. a completion note the (mocked) LAYER 2 model claims resolves the
//      candidate through the status-guarded update and writes the resolved
//      decision row only when the update returned the row.
//   10. (loop-closing Task 5.1) the fragment gate on the ingest copy: the
//      plan's eight items store four (original text), drop four with
//      fragment/dropped rows naming one_token or dangling_clause, and the
//      pronoun-object item gets a fragment/proposed/pronoun_object row carrying
//      the id the insert returned.
//   11. (Codex review 1, F2) the open-item dedup on the ingest copy: an item
//      already open is not inserted again and gets no suspect row, while a new
//      item from the same capture is inserted. The GET mock answers only the
//      exact status=eq.open lookup, so a divergent filter string fails here.
//   12. (Codex review 1, F3) the corrected rollout probe text (step 6) on the
//      ingest copy, with the original probe's item and the MCP probe's item
//      already open: the Slack probe item, carrying its own token, is still
//      inserted and gets its suspect row, and "deploy" is dropped.
//   13. (loop-closing Task 5.2) dedup on the ingest copy: two identical strings
//      in one batch insert once with a dedup/dropped/exact_batch row naming the
//      survivor the insert returned; a reworded copy of a recent open item
//      (dedup_semantic_candidates, read BEFORE the insert) is inserted AND
//      proposed through ONE record_decisions call (dedup/proposed/
//      semantic_overlap, the new id, the candidate as survivor, the score).

//   15. LAYER 2 claim indices on the ingest copy: a fractional claim (1.5,
//      and a bare 2.5) and a claim of 0 are ignored without a throw, the later
//      valid claims (2 and 3) still resolve through the guarded transition with
//      their resolved rows, and the index-0 candidate gets its L2 not_claimed row.
//
//   deno run --allow-net --allow-env --allow-read scripts/loop-closing/ingest-probe-harness.ts
//
// Exit 0 with "INGEST PROBE PASSED" or non-zero with the first failed check.

// The checks the TS mutant sweep certifies go through claimVerdict (Codex
// re-review 2, N1): the claim records its entry and verdict at run time and
// its tag ends the FAILED line, so a direct fail() can never stand in for it.
import { claimVerdict } from "./claim.ts";

const SIGNING_SECRET = "probe-signing-secret";
const CAPTURE_CHANNEL = "C_PROBE_CAPTURE";
const PORT = 8000; // Deno.serve default; the module does not read PORT

Deno.env.set("SUPABASE_URL", "http://supabase.mock");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "mock-service-key");
Deno.env.set("SLACK_BOT_TOKEN", "mock-bot-token");
Deno.env.set("SLACK_CAPTURE_CHANNEL", CAPTURE_CHANNEL);
Deno.env.set("SLACK_SIGNING_SECRET", SIGNING_SECRET);
Deno.env.set("OPENROUTER_API_KEY", "mock-openrouter-key");

type Rec = { table: string; method: string; url: string; body: unknown };
const recorded: Rec[] = [];
const logs: string[] = [];
const pending: Promise<unknown>[] = [];

// Scenario knobs the mocks read.
const scenario = {
  metadata: {} as Record<string, unknown>,
  candidates: [] as Array<Record<string, unknown>>,
  resolved: [] as Array<{ num: number; reason: string } | number>,
  updateAffected: [] as Array<{ id: string }>,
  openItems: null as Array<{ id: string; description: string }> | null,
  doneMatched: [] as number[],
  transitionAnswers: [] as Array<number | "error">,
  proposalItems: [] as Array<{ item_id: string; description: string }>,
  reviewAnswers: [] as Array<Array<{ status: string; message: string; decision_id: string | null }>>,
  semanticCandidates: [] as Array<Record<string, unknown>>,
};
// Rows the action_items insert returned (Task 5.1 asks for id, description).
const returnedItems: Array<{ id: string; description: string }> = [];
const slackThreads: Array<string | undefined> = [];
const slackReplies: string[] = [];

const origLog = console.log, origErr = console.error;
console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
console.error = (...a: unknown[]) => { logs.push("ERR " + a.map(String).join(" ")); };

// EdgeRuntime.waitUntil is a global in the Edge Runtime; collect the promises.
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
      return json({ choices: [{ message: { content: JSON.stringify(scenario.metadata) } }] });
    }
    if (sys.startsWith("The user says they completed something")) {
      return json({ choices: [{ message: { content: JSON.stringify({ matched: scenario.doneMatched }) } }] });
    }
    if (sys.startsWith("You check whether a new note explicitly resolves")) {
      return json({ choices: [{ message: { content: JSON.stringify({ resolved: scenario.resolved }) } }] });
    }
    return json({ choices: [{ message: { content: "{}" } }] });
  }
  if (url.startsWith("https://slack.com/")) {
    slackReplies.push(String((body as { text?: string })?.text ?? ""));
    slackThreads.push((body as { thread_ts?: string })?.thread_ts);
    return json({ ok: true });
  }
  if (url.startsWith("http://supabase.mock/")) {
    const u = new URL(url);
    const table = u.pathname.replace("/rest/v1/", "");
    recorded.push({ table, method, url, body });
    // PostgREST returns a bare object, not an array, when the client asks for
    // one (.single() sends Accept: application/vnd.pgrst.object+json).
    const accept = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("accept") ?? "";
    const single = accept.includes("vnd.pgrst.object");
    if (table.startsWith("rpc/")) {
      if (table === "rpc/find_candidate_action_items") return json(scenario.candidates);
      if (table === "rpc/resolve_proposal_item") return json(scenario.proposalItems);
      if (table === "rpc/review_proposal") return json(scenario.reviewAnswers.shift() ?? []);
      if (table === "rpc/dedup_semantic_candidates") return json(scenario.semanticCandidates);
      if (table === "rpc/record_decisions") return json(Array.isArray((body as { p_rows?: unknown[] })?.p_rows) ? (body as { p_rows: unknown[] }).p_rows.length : null);
      if (table === "rpc/transition_action_item") {
        if (scenario.transitionAnswers.length) {
          const answer = scenario.transitionAnswers.shift()!;
          return answer === "error" ? json({ code: "22023", message: "boom" }, 400) : json(answer);
        }
        return json(scenario.updateAffected.length);
      }
      return json(null);
    }
    if (table === "thoughts" && method === "POST") {
      const row = { id: crypto.randomUUID() };
      return json(single ? row : [row]);
    }
    // Open items answer ONLY the exact open-item lookup the code issues
    // (status=eq.open); any other filter string reads nothing, so a divergent
    // filter in the ingest copy changes behavior here (Codex review 1, F2).
    if (table === "action_items" && method === "GET" && scenario.openItems) {
      return json(u.searchParams.get("status") === "eq.open" ? scenario.openItems : []);
    }
    if (table === "action_items" && method === "PATCH") throw new Error("direct action_items status update: every writer must use transition_action_item");
    if (table === "action_items" && method === "POST") {
      const rows = (Array.isArray(body) ? body : [body]) as Array<{ description: string }>;
      const back = rows.map((r) => ({ id: crypto.randomUUID(), description: r.description }));
      returnedItems.push(...back);
      return json(back, 201);
    }
    if (method === "POST") return json([]);
    return json([]);
  }
  return realFetch(input as string, init);
};

// Import AFTER the mocks are in place: the module creates its supabase client
// and starts Deno.serve at import time.
await import("../../supabase/functions/ingest-thought/index.ts");

async function sign(body: string, ts: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${body}`));
  return "v0=" + Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function postSlackMessage(text: string, extra: Record<string, unknown> = {}): Promise<number> {
  const body = JSON.stringify({ type: "event_callback", event: { type: "message", text, channel: CAPTURE_CHANNEL, ts: `${Date.now() / 1000}`, ...extra } });
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await realFetch(`http://127.0.0.1:${PORT}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": await sign(body, ts) },
    body,
  });
  await res.text();
  // Drain the waitUntil work.
  while (pending.length) { const p = pending.shift()!; await p.catch(() => {}); }
  return res.status;
}

function fail(msg: string): never {
  console.log = origLog; console.error = origErr;
  console.error("INGEST PROBE FAILED: " + msg);
  console.error("--- recorded ---"); for (const r of recorded) console.error(r.method, r.table, JSON.stringify(r.body).slice(0, 300));
  console.error("--- logs ---"); for (const l of logs) console.error(l.slice(0, 300));
  Deno.exit(1);
}
const expect = (cond: boolean, msg: string) => { if (!cond) fail(msg); };
const expectClaimed = (tag: string | null, msg: string) => { if (tag !== null) fail(`${msg} ${tag}`); };
const inserts = (table: string) => recorded.filter((r) => r.table === table && r.method === "POST").flatMap((r) => Array.isArray(r.body) ? r.body : [r.body]) as Array<Record<string, unknown>>;

// --- Probe 1: work report + FOR OPERATOR through the Slack capture channel ---
scenario.metadata = { people: ["Alex Rivera"], action_items: ["The operator runs both deploys", "Update the tracker"], dates_mentioned: ["2026-11-05"], topics: ["brain-bank", "loop-closing"], type: "observation", project: null, priority: "normal" };
scenario.candidates = []; scenario.resolved = []; scenario.updateAffected = [];
const report = "CRM Session 80 (2026-10-29): departure-notice window spec written and committed (commit 4f1c2a9b). Next: The operator runs both deploys.\nFOR OPERATOR: send Sam the sign-in link by 2026-11-05";
const status1 = await postSlackMessage(report);
expect(status1 === 200, `probe 1 HTTP ${status1}`);
const items1 = inserts("action_items");
expectClaimed(claimVerdict("probe-1-rows", () => items1.length === 1 && items1[0].description === "send Sam the sign-in link by 2026-11-05" && items1[0].status === "open"), `probe 1 action_items rows: ${JSON.stringify(items1)}`);
const gate1 = inserts("auto_resolve_decisions").filter((d) => d.layer === "gate");
expect(gate1.length === 2 && gate1.every((d) => d.outcome === "dropped" && d.reason === "work_report" && d.item_id === null && typeof d.thought_id === "string"), `probe 1 gate rows: ${JSON.stringify(gate1)}`);
expect(gate1.map((d) => d.candidate_description).join("|") === "The operator runs both deploys|Update the tracker", "probe 1 gate candidate_description");
expect(logs.some((l) => l === "work-report gate: replaced 2 extracted items with 1 operator-marker lines"), "probe 1 gate log line");
const thoughts1 = inserts("thoughts");
expect(thoughts1.length === 1 && String(thoughts1[0].content) === report, "probe 1 thought insert");
origLog("probe 1 ok: 1 thought, 1 action_items row (the FOR OPERATOR line), 2 gate decision rows, gate log line present");

// --- Probe 2: completion note, candidate still open -> resolved row ---
recorded.length = 0; logs.length = 0;
const candId = crypto.randomUUID();
scenario.metadata = { people: [], action_items: [], dates_mentioned: [], topics: ["brain-bank"], type: "observation", project: "Brain Bank", priority: "normal" };
scenario.candidates = [{ id: candId, description: "send Sam the sign-in link", source_thought_id: crypto.randomUUID(), src_project: "brain-bank", src_topics: ["brain-bank"], src_people: [] }];
scenario.resolved = [{ num: 1, reason: "sent Sam the sign-in link" }];
scenario.updateAffected = [{ id: candId }];
expect(await postSlackMessage("Loop-closing probe 2: sent Sam the sign-in link this morning.") === 200, "probe 2 HTTP");
const rpc2 = recorded.filter((r) => r.table === "rpc/transition_action_item").map((r) => r.body as Record<string, unknown>);
expect(rpc2.length === 1 && rpc2[0].p_item_id === candId && JSON.stringify(rpc2[0].p_from_statuses) === '["open"]' && rpc2[0].p_to_status === "resolved" && rpc2[0].p_close_reason === "done" && rpc2[0].p_actor === "auto-resolve", `probe 2 guarded transition: ${JSON.stringify(rpc2)}`);
const resolved2 = inserts("auto_resolve_decisions").filter((d) => d.layer === "resolved");
expect(resolved2.length === 1 && resolved2[0].outcome === "resolved" && resolved2[0].reason === null && resolved2[0].item_id === candId && resolved2[0].quote === "sent Sam the sign-in link", `probe 2 resolved row: ${JSON.stringify(resolved2)}`);
expect(inserts("action_items").length === 0, "probe 2 must store no items (observation, no FOR OPERATOR)");
origLog("probe 2 ok: transition RPC guarded on open with a done reason, one resolved decision row with the quote");

// --- Probe 3: same note, candidate no longer open -> no resolved row ---
recorded.length = 0; logs.length = 0;
scenario.updateAffected = [];
expect(await postSlackMessage("Loop-closing probe 3: sent Sam the sign-in link again.") === 200, "probe 3 HTTP");
const rpc3 = recorded.filter((r) => r.table === "rpc/transition_action_item").map((r) => r.body as Record<string, unknown>);
expect(rpc3.length === 1 && JSON.stringify(rpc3[0].p_from_statuses) === '["open"]', "probe 3 guarded transition");
expect(inserts("auto_resolve_decisions").filter((d) => d.layer === "resolved").length === 0, "probe 3 must write no resolved row");
expect(logs.some((l) => l.includes("resolve skipped for item") && l.includes("no longer open")), "probe 3 skip log line");
origLog("probe 3 ok: zero affected rows, no resolved decision row, skip logged");

// --- Probe 4: mechanical capture -> one capture-level L0 row, nothing else ---
recorded.length = 0; logs.length = 0;
scenario.metadata = { people: [], action_items: ["call Jordan"], dates_mentioned: [], topics: ["calendar"], type: "task", project: null, priority: "normal" };
scenario.candidates = []; scenario.resolved = [];
expect(await postSlackMessage("[Calendar Sync] 2 events synced\nFOR OPERATOR: call Jordan about the kitchen remodel") === 200, "probe 4 HTTP");
const l0 = inserts("auto_resolve_decisions");
expect(l0.length === 1 && l0[0].layer === "L0" && l0[0].outcome === "blocked" && l0[0].reason === "mechanical_prefix" && l0[0].item_id === null, `probe 4 L0 row: ${JSON.stringify(l0)}`);
expect(inserts("action_items").length === 0, "probe 4 mechanical capture must store no items, marker or not");
origLog("probe 4 ok: mechanical capture wrote one capture-level L0 row and no items");

// --- Probe 5: closeout-controller record (prefixed) with a FOR OPERATOR line ---
// Post-review follow-through Task 1 (2026-11-05): every closeout-controller
// capture carries "[Open Engine Closeout]" and both handlers list it as
// mechanical. Same shape as the open-brain-mcp harness probes A/B, through the
// signed Slack path here. Probe 2 above is the unprefixed positive control: an
// ordinary completion still reaches the status-guarded update, so this prefix
// does not switch resolution off for everything.
recorded.length = 0; logs.length = 0;
const closeoutCandId = crypto.randomUUID();
scenario.metadata = { people: ["Jordan Lee"], action_items: ["Open questions for the client: cedar vs composite decking, plant palette."], dates_mentioned: ["2026-09-30"], topics: ["design", "open-engine"], type: "task", project: null, priority: "normal" };
scenario.candidates = [{ id: closeoutCandId, description: "TODO: create a design for the backyard garden for Jordan Lee, incorporating a stone path, raised beds, a pergola, a water feature, lighting, and native plantings.", source_thought_id: crypto.randomUUID(), src_project: null, src_topics: ["design"], src_people: ["Jordan Lee"] }];
const closeoutBody = "Jordan Lee backyard garden concept brief drafted 2026-09-30 (task 83a4acfa). Layout: stone path from the patio, raised beds along the fence, pergola over the seating area; water feature in the far corner facing the house. Open questions for the client: cedar vs composite decking, plant palette.";
scenario.resolved = [{ num: 1, reason: closeoutBody }];
scenario.updateAffected = [{ id: closeoutCandId }];
const prefixed5 = `[Open Engine Closeout]\n${closeoutBody}\nFOR OPERATOR: draw the Jordan Lee garden and resolve the item`;
expect(await postSlackMessage(prefixed5) === 200, "probe 5 HTTP");
const thoughts5 = inserts("thoughts");
expect(thoughts5.length === 1 && String(thoughts5[0].content) === prefixed5, "probe 5 thought stored once with the prefixed content");
expect(inserts("action_items").length === 0, "probe 5 prefixed closeout record must store no items, FOR OPERATOR line included");
expect(recorded.filter((r) => r.table === "rpc/transition_action_item").length === 0, "probe 5 prefixed closeout record must issue no status update");
const l05 = inserts("auto_resolve_decisions");
expect(l05.length === 1 && l05[0].layer === "L0" && l05[0].outcome === "blocked" && l05[0].reason === "mechanical_prefix" && l05[0].item_id === null, `probe 5 L0 row: ${JSON.stringify(l05)}`);
expect(logs.some((l) => l.startsWith("checkAutoResolve: blocked mechanical capture")), "probe 5 L0 log line");
origLog("probe 5 ok: prefixed closeout record stored, 0 items, 0 updates, one capture-level L0 row (probe 2 remains the unprefixed positive control)");

// --- Probe 6: done: command. Three matches: one closes, one left open while the
// model ran, one errors. Only the first may be reported as done. ---
recorded.length = 0; logs.length = 0; slackReplies.length = 0;
const done1 = crypto.randomUUID(), done2 = crypto.randomUUID(), done3 = crypto.randomUUID();
scenario.openItems = [
  { id: done1, description: "send Sam the invoice" },
  { id: done2, description: "send Sam the contract" },
  { id: done3, description: "send Sam the deposit link" },
];
scenario.doneMatched = [1, 2, 3];
scenario.transitionAnswers = [1, 0, "error"];
expect(await postSlackMessage("done: sent Sam everything") === 200, "probe 6 HTTP");
const rpc6 = recorded.filter((r) => r.table === "rpc/transition_action_item").map((r) => r.body as Record<string, unknown>);
expect(rpc6.length === 3, `probe 6 expected 3 transitions, got ${rpc6.length}`);
for (const call of rpc6) {
  expect(JSON.stringify(call.p_from_statuses) === '["open"]' && call.p_to_status === "resolved" && call.p_close_reason === "done" && call.p_resolution_note === "done: command" && call.p_actor === "slack:done-command", `probe 6 transition args: ${JSON.stringify(call)}`);
}
expect(recorded.filter((r) => r.table === "action_items" && r.method === "PATCH").length === 0, "probe 6 must not update by id");
const reply6 = slackReplies.join("\n");
expect(reply6.includes("Marked 1 item as done") && reply6.includes("send Sam the invoice"), `probe 6 reply reports the close: ${reply6}`);
expect(!reply6.includes("send Sam the contract"), `probe 6 reply must not claim the item that was no longer open: ${reply6}`);
expect(reply6.includes("Failed to mark 1 item") && reply6.includes("send Sam the deposit link"), `probe 6 reply reports the failure: ${reply6}`);
scenario.openItems = null;
origLog("probe 6 ok: done: goes through the guarded transition; a no-longer-open item is not reported as done; an error is reported as an error");

// --- Probe 7 (Task 3.6): the exact-form review replies, in the digest's thread. ---
const PITEM = "c0140001-0000-4000-8000-000000000000";
const reviewCalls = () => recorded.filter((r) => r.table === "rpc/review_proposal").map((r) => r.body as Record<string, unknown>);
const nothingCaptured = () =>
  inserts("thoughts").length === 0 && recorded.filter((r) => r.table === "rpc/transition_action_item").length === 0 &&
  !recorded.some((r) => r.url.startsWith("https://openrouter.ai/"));
const forms: Array<[string, string, string | null]> = [
  ["keep c0140001", "keep", null],
  ["archive C0140001", "archive", null],
  ["done c0140001", "done", null],
  ["DONE c0140001 d0140002", "done", "d0140002"],
];
for (const [text, verb, decisionRef] of forms) {
  recorded.length = 0; logs.length = 0; slackReplies.length = 0; slackThreads.length = 0;
  scenario.proposalItems = [{ item_id: PITEM, description: "send her the explainer PDF" }];
  scenario.reviewAnswers = [[{ status: "recorded", message: `${verb} recorded`, decision_id: null }]];
  expect(await postSlackMessage(text, { user: "U0AB12CD", thread_ts: "1731900000.000100" }) === 200, `probe 7 HTTP for ${text}`);
  const calls = reviewCalls();
  expect(
    calls.length === 1 && calls[0].p_item_id === PITEM && calls[0].p_verb === verb && calls[0].p_actor === "slack:U0AB12CD" &&
      calls[0].p_actor_source === "slack-signature" && calls[0].p_decision_ref === decisionRef,
    `probe 7 review_proposal args for "${text}": ${JSON.stringify(calls)}`,
  );
  expect(nothingCaptured(), `probe 7 "${text}" must not be captured as a thought or touch the done: path`);
  expect(slackReplies.length === 1 && slackReplies[0] === `c0140001 "send her the explainer PDF": ${verb} recorded`, `probe 7 reply: ${JSON.stringify(slackReplies)}`);
  expect(slackThreads[0] === "1731900000.000100", `probe 7 reply must go to the digest thread: ${JSON.stringify(slackThreads)}`);
}
origLog("probe 7 ok: keep, archive, done and done-with-decision route to review_proposal with the signed Slack user, reply in the thread, capture nothing");

// --- Probe 8: no user writes nothing and replies nothing; subtype and bot posts never reach the handler. ---
for (const [label, extra] of [
  ["no user", {}],
  ["empty user", { user: "" }],
  ["edited message", { subtype: "message_changed", message: { user: "U0AB12CD", text: "keep c0140001" } }],
  ["bot post", { user: "U0AB12CD", bot_id: "B0001" }],
] as Array<[string, Record<string, unknown>]>) {
  recorded.length = 0; logs.length = 0; slackReplies.length = 0;
  scenario.proposalItems = [{ item_id: PITEM, description: "send her the explainer PDF" }];
  scenario.reviewAnswers = [[{ status: "recorded", message: "should not happen", decision_id: null }]];
  expect(await postSlackMessage("keep c0140001", extra) === 200, `probe 8 HTTP (${label})`);
  expect(recorded.filter((r) => r.table.startsWith("rpc/")).length === 0, `probe 8 (${label}) must call no RPC: ${JSON.stringify(recorded.map((r) => r.table))}`);
  expect(slackReplies.length === 0, `probe 8 (${label}) must not reply: ${JSON.stringify(slackReplies)}`);
  expect(inserts("thoughts").length === 0, `probe 8 (${label}) must not capture`);
}
origLog("probe 8 ok: a review form with no user, an edited message and a bot post write nothing and reply nothing");

// --- Probe 9: a near-miss is NOT a review command and is captured as before. ---
recorded.length = 0; logs.length = 0; slackReplies.length = 0;
scenario.metadata = { people: [], action_items: [], dates_mentioned: [], topics: ["koi"], type: "observation", project: null, priority: "normal" };
scenario.candidates = [];
expect(await postSlackMessage("keep c0140001 d0140002", { user: "U0AB12CD" }) === 200, "probe 9 HTTP");
expect(reviewCalls().length === 0, "probe 9 keep with a decision id is not a review form");
expect(inserts("thoughts").length === 1, "probe 9 the near-miss is captured as a thought, as before");
origLog("probe 9 ok: keep with a second id is not an exact form and is captured unchanged");

// --- Probe 10 (Task 5.1): the fragment gate on the ingest copy. ---
recorded.length = 0; logs.length = 0; returnedItems.length = 0;
const PLAN_ITEMS_10 = [
  "deploy", "switch on", "then deploy", "finalize what we're",
  "Awaiting the operator to apply migration 063", "send Sam the explainer PDF",
  "send her the explainer PDF", "nudge Jordan if nothing arrives",
];
scenario.metadata = { people: ["Sam"], action_items: PLAN_ITEMS_10, dates_mentioned: [], topics: ["koi"], type: "task", project: null, priority: "normal" };
scenario.candidates = []; scenario.resolved = []; scenario.updateAffected = [];
expect(await postSlackMessage("Loop-closing probe 10: notes from the koi consult with Sam and Jordan.") === 200, "probe 10 HTTP");
const items10 = inserts("action_items");
expectClaimed(
  claimVerdict("probe-10-rows", () => JSON.stringify(items10.map((r) => r.description)) === JSON.stringify(["Awaiting the operator to apply migration 063", "send Sam the explainer PDF", "send her the explainer PDF", "nudge Jordan if nothing arrives"])),
  `probe 10 action_items rows (original text, fragments dropped): ${JSON.stringify(items10)}`,
);
const thought10 = recorded.find((r) => r.table === "auto_resolve_decisions" && (r.body as Record<string, unknown>)?.layer === "fragment");
const frag10 = inserts("auto_resolve_decisions").filter((d) => d.layer === "fragment");
const drops10 = frag10.filter((d) => d.outcome === "dropped");
expectClaimed(
  claimVerdict("probe-10-drops", () => JSON.stringify(drops10.map((d) => [d.candidate_description, d.reason])) === JSON.stringify([["deploy", "one_token"], ["switch on", "one_token"], ["then deploy", "one_token"], ["finalize what we're", "dangling_clause"]])),
  `probe 10 fragment drop rows: ${JSON.stringify(drops10)}`,
);
expect(drops10.every((d) => d.item_id === null && typeof d.thought_id === "string" && d.thought_id === drops10[0].thought_id), "probe 10 drop rows: item_id null, one thought_id");
const herId = returnedItems.find((r) => r.description === "send her the explainer PDF")?.id;
const sus10 = frag10.filter((d) => d.outcome === "proposed");
expectClaimed(
  claimVerdict("probe-10-suspect", () =>
    herId !== undefined && sus10.length === 1 && sus10[0].reason === "pronoun_object" && sus10[0].item_id === herId &&
    sus10[0].thought_id === drops10[0].thought_id && sus10[0].candidate_description === "send her the explainer PDF"),
  `probe 10 suspect row: ${JSON.stringify(sus10)} (returned ${JSON.stringify(returnedItems)})`,
);
expect(frag10.length === 5 && thought10 !== undefined, `probe 10 exactly five fragment rows: ${frag10.length}`);
expect(logs.filter((l) => l.startsWith("fragment gate: dropped item (")).length === 4, "probe 10 four drop log lines");
origLog("probe 10 ok: ingest copy stored 4 items, wrote 4 fragment drop rows (3 one_token, 1 dangling_clause) and 1 pronoun_object suspect with the inserted item's id");

// --- Probe 11 (Codex review 1, F2): the open-item dedup on the ingest copy. ---
recorded.length = 0; logs.length = 0; returnedItems.length = 0;
scenario.metadata = {
  people: ["Sam"],
  action_items: ["send her the probe 11 koi stencil", "send Sam the probe 11 deposit link"],
  dates_mentioned: [], topics: ["koi"], type: "task", project: null, priority: "normal",
};
scenario.openItems = [{ id: crypto.randomUUID(), description: "Send her the probe 11 koi stencil." }];
scenario.candidates = []; scenario.resolved = []; scenario.updateAffected = [];
expect(await postSlackMessage("Loop-closing probe 11: the koi stencil and the deposit link for Sam.") === 200, "probe 11 HTTP");
const items11 = inserts("action_items");
expectClaimed(
  claimVerdict("probe-11-rows", () => JSON.stringify(items11.map((r) => r.description)) === JSON.stringify(["send Sam the probe 11 deposit link"])),
  `probe 11 action_items rows (the already-open item is not inserted again): ${JSON.stringify(items11)}`,
);
const sus11 = inserts("auto_resolve_decisions").filter((d) => d.layer === "fragment");
expect(sus11.length === 0, `probe 11 no fragment rows (the duplicate was not inserted, so it is not a suspect): ${JSON.stringify(sus11)}`);
const lookups11 = recorded.filter((r) => r.table === "action_items" && r.method === "GET");
expect(
  lookups11.length === 1 && new URL(lookups11[0].url).searchParams.get("status") === "eq.open",
  `probe 11 one open-item lookup, status=eq.open: ${JSON.stringify(lookups11.map((r) => r.url))}`,
);
scenario.openItems = null;
origLog("probe 11 ok: ingest copy's open-item lookup (status=eq.open) suppressed the already-open item and inserted only the new one");

// --- Probe 12 (Codex review 1, F3): the corrected rollout probe on the ingest copy. ---
recorded.length = 0; logs.length = 0; returnedItems.length = 0;
const RUN12 = "20261121093000";
const SLACK12 = `send her the fragment probe explainer PDF fgprobe${RUN12}slack`;
scenario.metadata = { people: [], action_items: ["deploy", "send the fragment probe explainer PDF"], dates_mentioned: [], topics: ["brain-bank"], type: "task", project: null, priority: "normal" };
scenario.openItems = [
  { id: crypto.randomUUID(), description: "send her the fragment probe explainer PDF" },
  { id: crypto.randomUUID(), description: `send her the fragment probe explainer PDF fgprobe${RUN12}mcp` },
];
scenario.candidates = []; scenario.resolved = []; scenario.updateAffected = [];
expect(
  await postSlackMessage(`Fragment gate probe, handoff for Session 999 (2026-11-20).\nFOR OPERATOR: deploy\nFOR OPERATOR: ${SLACK12}`) === 200,
  "probe 12 HTTP",
);
const items12 = inserts("action_items");
expect(JSON.stringify(items12.map((r) => r.description)) === JSON.stringify([SLACK12]), `probe 12 action_items rows (the tokenized Slack probe item): ${JSON.stringify(items12)}`);
const frag12 = inserts("auto_resolve_decisions").filter((d) => d.layer === "fragment");
const id12 = returnedItems.find((r) => r.description === SLACK12)?.id;
expect(
  JSON.stringify(frag12.map((d) => [d.outcome, d.reason, d.candidate_description, d.item_id === null ? null : d.item_id === id12 ? "returned id" : d.item_id])) ===
    JSON.stringify([["dropped", "one_token", "deploy", null], ["proposed", "pronoun_object", SLACK12, "returned id"]]),
  `probe 12 fragment rows (deploy dropped; one suspect with the returned id): ${JSON.stringify(frag12)} (returned ${JSON.stringify(returnedItems)})`,
);
scenario.openItems = null;
origLog("probe 12 ok: the corrected Slack probe text stored its tokenized item next to the open original and MCP probe items, dropped deploy and proposed the item with the returned id");

// --- Probe 13 (Task 5.2): batch-local exact dedup and a semantic proposal on the ingest copy. ---
recorded.length = 0; logs.length = 0; returnedItems.length = 0;
const CAND13 = "c5213000-0000-4000-8000-000000000001";
const CASEY13 = "Add Casey as guest when his email address arrives probe13";
const DECK13 = "Send Sam the probe 13 flash deck";
scenario.metadata = { people: ["Sam"], action_items: [CASEY13, DECK13, "send sam the probe 13 flash deck."], dates_mentioned: [], topics: ["brain-bank"], type: "task", project: null, priority: "normal" };
scenario.semanticCandidates = [
  { id: CAND13, description: "Add Casey as a guest when his email arrives probe13", created_at: "2026-11-19T12:00:00.000Z", source_thought_id: crypto.randomUUID(), project: "brain-bank" },
];
scenario.candidates = []; scenario.resolved = []; scenario.updateAffected = [];
expect(await postSlackMessage("Loop-closing probe 13: the Casey guest pass and the flash deck for Sam.") === 200, "probe 13 HTTP");
const items13 = inserts("action_items");
expectClaimed(
  claimVerdict("probe-13-rows", () => JSON.stringify(items13.map((r) => r.description)) === JSON.stringify([CASEY13, DECK13])),
  `probe 13 action_items rows (one copy of the deck, the reworded Casey item inserted): ${JSON.stringify(items13)}`,
);
const deckId13 = returnedItems.find((r) => r.description === DECK13)?.id;
const caseyId13 = returnedItems.find((r) => r.description === CASEY13)?.id;
const exact13 = inserts("auto_resolve_decisions").filter((d) => d.layer === "dedup");
expectClaimed(
  claimVerdict("probe-13-exact-batch", () =>
    deckId13 !== undefined && JSON.stringify(exact13.map((d) => [d.outcome, d.reason, d.candidate_description, d.related_item_id, d.item_id, typeof d.thought_id])) ===
      JSON.stringify([["dropped", "exact_batch", "send sam the probe 13 flash deck.", deckId13, null, "string"]])),
  `probe 13 exact_batch row: ${JSON.stringify(exact13)} (returned ${JSON.stringify(returnedItems)})`,
);
const calls13 = recorded.filter((r) => r.table === "rpc/record_decisions").map((r) => (r.body as { p_rows: Array<Record<string, unknown>> }).p_rows);
expectClaimed(
  claimVerdict("probe-13-semantic", () =>
    caseyId13 !== undefined && calls13.length === 1 &&
    JSON.stringify(calls13[0].map((r) => [r.layer, r.outcome, r.reason, r.item_id, r.related_item_id, r.score, r.thought_id, r.candidate_description])) ===
      JSON.stringify([["dedup", "proposed", "semantic_overlap", caseyId13, CAND13, 1, null, CASEY13]])),
  `probe 13 semantic proposal through record_decisions: ${JSON.stringify(calls13)} (returned ${JSON.stringify(returnedItems)})`,
);
const order13 = recorded.map((r) => r.table).filter((t) => t === "rpc/dedup_semantic_candidates" || t === "action_items" || t === "rpc/record_decisions");
expect(JSON.stringify(order13.filter((t, i) => order13.indexOf(t) === i)) === JSON.stringify(["action_items", "rpc/dedup_semantic_candidates", "rpc/record_decisions"]) &&
  recorded.findIndex((r) => r.table === "rpc/dedup_semantic_candidates") < recorded.findIndex((r) => r.table === "action_items" && r.method === "POST"),
  `probe 13 the candidates are read before the insert: ${JSON.stringify(recorded.map((r) => `${r.method} ${r.table}`))}`);
scenario.semanticCandidates = [];
origLog("probe 13 ok: ingest copy inserted one copy of the deck with an exact_batch row naming its survivor, and proposed the reworded Casey item against the recent open one through one record_decisions call");

// --- Probe 14 (Codex review 1 of PR 33, R4): numbered obligations stay distinct. ---
// Two items that differ only in a digit are two obligations: the
// normalizeActionText the ingest copy imports (_shared/capture-helpers.ts since
// correction 3; before that its own copy) must keep the digits, so both insert
// and the batch dedup records nothing. Codex's mutant (digits stripped from the
// normalizer) inserted one and recorded the other as exact_batch.
recorded.length = 0; logs.length = 0; returnedItems.length = 0;
const NUMBERED14 = ["send Sam design 1", "send Sam design 2"];
scenario.metadata = { people: ["Sam"], action_items: NUMBERED14, dates_mentioned: [], topics: ["koi"], type: "task", project: null, priority: "normal" };
scenario.openItems = []; scenario.semanticCandidates = []; scenario.candidates = []; scenario.resolved = []; scenario.updateAffected = [];
expect(await postSlackMessage("Loop-closing probe 14: two numbered designs still need to go out to Sam.") === 200, "probe 14 HTTP");
const items14 = inserts("action_items");
const dedup14 = inserts("auto_resolve_decisions").filter((d) => d.layer === "dedup");
expectClaimed(
  claimVerdict("probe-14-rows", () => JSON.stringify(items14.map((r) => r.description)) === JSON.stringify(NUMBERED14) && dedup14.length === 0),
  `probe 14 action_items rows (both numbered items insert, no dedup row): ${JSON.stringify(items14)} ${JSON.stringify(dedup14)}`,
);
scenario.openItems = null;
origLog("probe 14 ok: ingest copy inserted both numbered items (design 1, design 2) and wrote no dedup row");

// --- Probe 15: invalid LAYER 2 claim indices are ignored; later claims still run. ---
// The (mocked) model answers with a fractional claim (1.5), a claim of 0 and a
// bare fractional number (2.5) BEFORE two valid claims (2, 3). Before the fix
// the 1.5 claim read candidateItems[0.5] (undefined) and threw, which ended the
// claim loop: no later claim resolved. Now the invalid claims are skipped, the
// two valid claims resolve, and candidate 1 (index 0), which no valid claim
// names, gets its L2 not_claimed row and nothing else.
recorded.length = 0; logs.length = 0; returnedItems.length = 0;
const cand15 = [
  { id: crypto.randomUUID(), description: "send Sam the probe fifteen deposit link" },
  { id: crypto.randomUUID(), description: "book the probe fifteen koi consult with Jordan" },
  { id: crypto.randomUUID(), description: "order the probe fifteen needle cartridges" },
].map((c) => ({ ...c, source_thought_id: crypto.randomUUID(), src_project: "brain-bank", src_topics: ["brain-bank"], src_people: [] }));
scenario.metadata = { people: [], action_items: [], dates_mentioned: [], topics: ["brain-bank"], type: "observation", project: "Brain Bank", priority: "normal" };
scenario.openItems = null; scenario.semanticCandidates = [];
scenario.candidates = cand15;
scenario.resolved = [
  { num: 1.5, reason: cand15[0].description },
  { num: 0, reason: cand15[0].description },
  2.5,
  { num: 2, reason: cand15[1].description },
  { num: 3, reason: cand15[2].description },
];
scenario.updateAffected = [{ id: cand15[1].id }];
expect(await postSlackMessage("Loop-closing probe 15: booked the probe fifteen koi consult with Jordan and ordered the probe fifteen needle cartridges.") === 200, "probe 15 HTTP");
const rpc15 = recorded.filter((r) => r.table === "rpc/transition_action_item").map((r) => (r.body as Record<string, unknown>).p_item_id);
const rows15 = inserts("auto_resolve_decisions").map((d) => [d.layer, d.outcome, d.reason, d.item_id]);
const threw15 = logs.filter((l) => l.includes("checkAutoResolve failed"));
expectClaimed(
  claimVerdict("probe-15-claims", () =>
    JSON.stringify(rpc15) === JSON.stringify([cand15[1].id, cand15[2].id]) &&
    JSON.stringify(rows15) === JSON.stringify([
      ["L2", "dropped", "not_claimed", cand15[0].id],
      ["resolved", "resolved", null, cand15[1].id],
      ["resolved", "resolved", null, cand15[2].id],
    ]) &&
    threw15.length === 0),
  `probe 15 claim indices (1.5, 0 and 2.5 ignored; 2 and 3 resolve; candidate 1 not_claimed): transitions=${JSON.stringify(rpc15)} rows=${JSON.stringify(rows15)} threw=${JSON.stringify(threw15)}`,
);
scenario.candidates = []; scenario.resolved = []; scenario.updateAffected = [];
origLog("probe 15 ok: ingest copy ignored claims 1.5, 0 and 2.5 without a throw, resolved candidates 2 and 3, wrote candidate 1's not_claimed row");

console.log = origLog; console.error = origErr;
console.log("INGEST PROBE PASSED");
Deno.exit(0);
