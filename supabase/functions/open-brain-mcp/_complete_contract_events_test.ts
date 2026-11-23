// Loop-closing Task 5.4 follow-up (PR 32 decision 7): the complete_contract_events
// writer. The end-to-end proof through the real entrypoint is
// scripts/open-engine/complete-contract-events-probe-harness.ts.
import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import {
  COMPLETE_CONTRACT_EVENTS_TABLE,
  CONTRACT_EVENT_REASON_PATTERN,
  contractEventTool,
  type ContractEventRow,
  describeError,
  refusalEventRow,
  warningEventRow,
  writeContractEvent,
} from "./_complete_contract_events.ts";
import { evaluateCompletion } from "./_complete_contract.ts";

const ROOT = new URL("../../../", import.meta.url);
const TASK = "5a4e0000-0000-4000-8000-000000000001";
// The emission moment the site passes in (correction 1, finding 1).
const AT = new Date("2026-11-22T23:59:30.000Z");

const CLEAN = [
  "Work summary: x", "Verification: x", "Touched files or records: none", "Limitations: none",
  "Tracker draft: x", "Session-log draft: x", "Brain Bank capture draft: x", "Follow-up recommendation: none",
].join("\n");

Deno.test("contractEventTool maps each contract action to its MCP tool", () => {
  assertEquals(contractEventTool("complete"), "complete_agent_task");
  assertEquals(contractEventTool("request-review"), "request_agent_review");
});

Deno.test("refusalEventRow: outcome refused, reasons joined exactly as the log line prints them", () => {
  const row = refusalEventRow({
    action: "complete", taskId: TASK, agentCode: "claude-code", slug: " brain-bank ",
    reasons: ["RECEIPT_MISSING_SECTION", "MISSING_CAPTURE_TAG"], occurredAt: AT,
  });
  assertEquals(row, {
    tool: "complete_agent_task", task_id: TASK, agent_code: "claude-code", outcome: "refused",
    reason: "RECEIPT_MISSING_SECTION,MISSING_CAPTURE_TAG", project_slug: "brain-bank",
    occurred_at: "2026-11-22T23:59:30.000Z",
  });
});

Deno.test("refusalEventRow: a blank slug is stored as null, request-review names its tool", () => {
  const row = refusalEventRow({
    action: "request-review", taskId: TASK, agentCode: "a", slug: "   ", reasons: ["MISSING_PROJECT_SLUG"],
    occurredAt: AT,
  });
  assertEquals(row.tool, "request_agent_review");
  assertEquals(row.project_slug, null);
  assertEquals(row.outcome, "refused");
  assertEquals(row.reason, "MISSING_PROJECT_SLUG");
});

Deno.test("warningEventRow: outcome warned, reason is the warning code", () => {
  const row = warningEventRow({
    action: "complete", taskId: TASK, agentCode: "codex", slug: "brain-bank", code: "ROUTE_SNAPSHOT_UNAVAILABLE",
    occurredAt: AT,
  });
  assertEquals(row, {
    tool: "complete_agent_task", task_id: TASK, agent_code: "codex", outcome: "warned",
    reason: "ROUTE_SNAPSHOT_UNAVAILABLE", project_slug: "brain-bank",
    occurred_at: "2026-11-22T23:59:30.000Z",
  });
});

Deno.test("warningEventRow: request-review names request_agent_review", () => {
  const row = warningEventRow({
    action: "request-review", taskId: TASK, agentCode: "codex", slug: "brain-bank", code: "ROUTE_SNAPSHOT_UNAVAILABLE",
    occurredAt: AT,
  });
  assertEquals(row.tool, "request_agent_review");
  assertEquals(row.outcome, "warned");
});

Deno.test("every reason the contract can refuse with fits the table's reason CHECK, and receipt text does not", () => {
  const re = new RegExp(CONTRACT_EVENT_REASON_PATTERN);
  // A real refusal: many reasons at once, from a receipt with no headings and a null slug.
  const verdict = evaluateCompletion({
    receipt: "not a receipt\nOPERATOR-ACTION: x",
    task: { project_slug: null, desired_outcome: "A fix", title: "t" },
    route: null,
    now: new Date(),
  });
  assert(!verdict.ok);
  assert(verdict.reasons.length > 1, `expected several reasons, got ${verdict.reasons}`);
  const row = refusalEventRow({ action: "complete", taskId: TASK, agentCode: "a", slug: null, reasons: verdict.reasons, occurredAt: AT });
  assert(re.test(row.reason), `reason ${row.reason} does not fit ${CONTRACT_EVENT_REASON_PATTERN}`);
  assert(re.test("ROUTE_SNAPSHOT_UNAVAILABLE"));
  for (const bad of ["", "Work summary: x", "A,B C", "RECEIPT_MISSING_SECTION,", "a_lower", "X\nY"]) {
    assert(!re.test(bad), `pattern accepted ${JSON.stringify(bad)}`);
  }
});

Deno.test("the migration's reason CHECK is the module's pattern, character for character", async () => {
  const sql = await Deno.readTextFile(new URL("supabase/migrations/20261121c_complete_contract_events.sql", ROOT));
  assert(sql.includes(`check (reason ~ '${CONTRACT_EVENT_REASON_PATTERN}')`), "the migration does not carry the module's reason pattern");
  assert(sql.includes(`create table public.${COMPLETE_CONTRACT_EVENTS_TABLE} (`), "table name differs from the module's");
});

function capture() {
  const lines: string[] = [];
  return { lines, log: (l: string) => { lines.push(l); } };
}
const ROW: ContractEventRow = {
  tool: "complete_agent_task", task_id: TASK, agent_code: "a", outcome: "refused",
  reason: "RECEIPT_MISSING_SECTION", project_slug: "brain-bank", occurred_at: "2026-11-22T23:59:30.000Z",
};

Deno.test("writeContractEvent: inserts the row once and logs nothing on success", async () => {
  const seen: ContractEventRow[] = [];
  const { lines, log } = capture();
  const out = await writeContractEvent((r) => { seen.push(r); return Promise.resolve({ error: null }); }, ROW, log);
  assertEquals(out, undefined);
  assertEquals(seen, [ROW]);
  assertEquals(lines, []);
});

Deno.test("writeContractEvent: an insert error resolves (never rejects) and is logged once", async () => {
  const { lines, log } = capture();
  let rejected = false;
  await writeContractEvent(() => Promise.resolve({ error: { message: "relation does not exist" } }), ROW, log)
    .catch(() => { rejected = true; });
  assertEquals(rejected, false);
  assertEquals(lines.length, 1);
  assert(lines[0].startsWith("[complete-contract] event write failed outcome=refused reason=RECEIPT_MISSING_SECTION"), lines[0]);
  assert(lines[0].includes("relation does not exist"));
});

Deno.test("writeContractEvent: a rejected insert resolves and is logged once", async () => {
  const { lines, log } = capture();
  let rejected = false;
  await writeContractEvent(() => Promise.reject(new Error("network down")), ROW, log).catch(() => { rejected = true; });
  assertEquals(rejected, false);
  assertEquals(lines.length, 1);
  assert(lines[0].includes("network down"), lines[0]);
});

Deno.test("writeContractEvent: an insert that throws synchronously does not throw and is logged once", async () => {
  const { lines, log } = capture();
  let threw = false;
  let p: Promise<void> | null = null;
  try {
    p = writeContractEvent(() => { throw new Error("client exploded"); }, ROW, log);
  } catch {
    threw = true;
  }
  assertEquals(threw, false);
  let rejected = false;
  await p!.catch(() => { rejected = true; });
  assertEquals(rejected, false);
  assertEquals(lines.length, 1);
  assert(lines[0].includes("client exploded"), lines[0]);
});

Deno.test("writeContractEvent: a logger that throws does not make the write throw or reject", async () => {
  let rejected = false;
  await writeContractEvent(() => Promise.resolve({ error: { message: "x" } }), ROW, () => { throw new Error("log broke"); })
    .catch(() => { rejected = true; });
  assertEquals(rejected, false);
});

// Correction 1 of PR 37, finding 3: values that cannot be formatted. Each of
// these escaped the writer before the fix (Codex review 1 reproduced all three).
const opaque = () => Object.create(null);

Deno.test("describeError never throws: no primitive conversion, a throwing message getter, ordinary values", () => {
  assertEquals(describeError(new Error("boom")), "boom");
  assertEquals(describeError("text"), "text");
  assertEquals(describeError(null), "null");
  assertEquals(describeError(opaque()), "(error value could not be formatted)");
  const getterThrows = { get message(): string { throw new Error("unreadable detail"); } };
  assertEquals(describeError(getterThrows), "(error value could not be formatted)");
  assertEquals(describeError({ message: opaque() }), "(error value could not be formatted)");
});

Deno.test("writeContractEvent: an insert that throws an opaque object neither throws nor rejects, and logs once", async () => {
  const { lines, log } = capture();
  let threw = false, rejected = false;
  let p: Promise<void> | null = null;
  try { p = writeContractEvent(() => { throw opaque(); }, ROW, log); } catch { threw = true; }
  assertEquals(threw, false);
  await p!.catch(() => { rejected = true; });
  assertEquals(rejected, false);
  assertEquals(lines.length, 1);
  assert(lines[0].endsWith("(error value could not be formatted)"), lines[0]);
});

Deno.test("writeContractEvent: an insert that rejects with an opaque object resolves and logs once", async () => {
  const { lines, log } = capture();
  let rejected = false;
  await writeContractEvent(() => Promise.reject(opaque()), ROW, log).catch(() => { rejected = true; });
  assertEquals(rejected, false);
  assertEquals(lines.length, 1);
});

Deno.test("writeContractEvent: an error result whose message getter throws resolves and logs once", async () => {
  const { lines, log } = capture();
  let rejected = false;
  await writeContractEvent(
    () => Promise.resolve({ error: { get message(): string { throw new Error("unreadable detail"); } } }),
    ROW,
    log,
  ).catch(() => { rejected = true; });
  assertEquals(rejected, false);
  assertEquals(lines.length, 1);
});

Deno.test("writeContractEvent: a result whose error getter throws resolves and logs once", async () => {
  const { lines, log } = capture();
  let rejected = false;
  const result = { get error(): { message: string } { throw new Error("getter broke"); } };
  await writeContractEvent(() => Promise.resolve(result), ROW, log).catch(() => { rejected = true; });
  assertEquals(rejected, false);
  assertEquals(lines.length, 1);
  assert(lines[0].includes("getter broke"), lines[0]);
});

// Inventory pin: index.ts has exactly two "[complete-contract]" emission sites
// (the refusal line and the per-warning line in moveAgentTaskViaTool), and each
// is followed, before the next statement that leaves the block, by exactly one
// recordCompleteContractEvent call of the matching kind. A third log line added
// without a row fails here.
Deno.test("index.ts: each [complete-contract] log line is paired with one event write of its kind", async () => {
  const src = await Deno.readTextFile(new URL("supabase/functions/open-brain-mcp/index.ts", ROOT));
  const lines = src.split("\n");
  // The writer's own diagnostics ("[complete-contract] event write ...") are
  // about the row, not contract outcomes, and are not sites.
  const sites = lines.flatMap((l, i) =>
    l.includes("`[complete-contract] ") && !l.includes("`[complete-contract] event write") ? [i] : []
  );
  assertEquals(sites.length, 2, `expected two [complete-contract] log sites, found ${sites.length}`);
  const kinds: string[] = [];
  for (const at of sites) {
    // The window: from the log line to the end of its enclosing statement group
    // (the throw for the refusal, the loop's closing brace for warnings).
    let end = at;
    while (end < lines.length && !/^\s*(throw new Error\(verdict\.message\);|\}\s*)$/.test(lines[end])) end += 1;
    const window = lines.slice(at, end + 1).join("\n");
    const calls = window.match(/recordCompleteContractEvent\(\(\) =>\s*(refusalEventRow|warningEventRow)\(/g) ?? [];
    assertEquals(calls.length, 1, `log site at line ${at + 1} is followed by ${calls.length} event writes`);
    kinds.push(calls[0]!.includes("refusal") ? "refusal" : "warning");
    // The row is built inside the site's closure with the emission moment, not
    // at insert time (correction 1, finding 1).
    assert(/occurredAt: new Date\(\),/.test(window), `log site at line ${at + 1}: the row does not take occurredAt: new Date() at the site`);
  }
  assertEquals(kinds.sort(), ["refusal", "warning"]);
  assert(lines[sites[0]].includes("COMPLETE_REFUSED"), "the first site is the refusal line");
});
