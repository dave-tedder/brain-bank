import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import {
  RECHECK_PROPOSAL_LIST_CAP,
  type RecheckProposalRow,
  recheckRunWarning,
  renderRecheckProposals,
} from "./recheck-proposals.ts";

const NOW = "2026-11-19T11:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const OK_RUN = { started_at: "2026-11-19T04:00:02.000Z", status: "ok", summary: { recheck_incomplete: 0 } };
const HEADER = "## Looks done (reply done <id> or keep <id>)";

function row(n: number, over: Partial<RecheckProposalRow> = {}): RecheckProposalRow {
  const h = String(n).padStart(4, "0");
  return {
    decision_id: `d${h}000-0000-4000-8000-000000000000`,
    item_id: `a${h}000-0000-4000-8000-000000000000`,
    description: `Item number ${n}`,
    quote: `finished item ${n}`,
    evidence_thought_id: `e${h}000-0000-4000-8000-000000000000`,
    proposed_at: new Date(NOW_MS - (100 - n) * 60_000).toISOString(),
    ...over,
  };
}

Deno.test("render: one line per proposal: item id, description, the quote, the evidence thought", () => {
  const out = renderRecheckProposals([row(1), row(2)], OK_RUN, NOW);
  assertEquals(
    out,
    `${HEADER}\n\n` +
      `- a0001000 Item number 1: "finished item 1" from e0001000\n` +
      `- a0002000 Item number 2: "finished item 2" from e0002000`,
  );
});

Deno.test("render: oldest proposal first, then decision id, whatever order the rows arrive in", () => {
  const same = "2026-11-19T04:00:10.000Z";
  const a = row(1, { proposed_at: same, decision_id: "d9000000-0000-4000-8000-000000000000" });
  const b = row(2, { proposed_at: same, decision_id: "d1000000-0000-4000-8000-000000000000" });
  const c = row(3, { proposed_at: "2026-11-18T04:00:10.000Z" });
  const out = renderRecheckProposals([a, b, c], OK_RUN, NOW);
  assertEquals(out.split("\n").slice(2).map((l) => l.slice(2, 10)), ["a0003000", "a0002000", "a0001000"]);
});

Deno.test("render: an item with two pending proposals shows each decision id and the reply that needs it", () => {
  const one = row(1);
  const two = row(2, { item_id: one.item_id, description: one.description });
  const lone = row(3);
  const lines = renderRecheckProposals([one, two, lone], OK_RUN, NOW).split("\n").slice(2);
  assertEquals(lines, [
    `- a0001000 Item number 1: "finished item 1" from e0001000 (decision d0001000; 2 pending, reply done a0001000 <decision id>)`,
    `- a0001000 Item number 1: "finished item 2" from e0002000 (decision d0002000; 2 pending, reply done a0001000 <decision id>)`,
    `- a0003000 Item number 3: "finished item 3" from e0003000`,
  ]);
});

Deno.test("render: a description and a quote are one line each and capped", () => {
  const out = renderRecheckProposals(
    [row(1, { description: "first line\nsecond   line " + "x".repeat(200), quote: "q\n\tq " + "y".repeat(300) })],
    OK_RUN,
    NOW,
  );
  const line = out.split("\n")[2];
  assertEquals(out.split("\n").length, 3, "no line break leaks from the text");
  const m = /^- a0001000 (.*): "(.*)" from e0001000$/.exec(line);
  assert(m, line);
  assertEquals([m![1].length, m![2].length], [70, 140]);
  assert(m![1].startsWith("first line second line xxx") && m![1].endsWith("…"));
  assert(m![2].startsWith("q q yyy") && m![2].endsWith("…"));
});

Deno.test("render: a list longer than the cap says how many there are", () => {
  const rows = Array.from({ length: RECHECK_PROPOSAL_LIST_CAP + 6 }, (_, i) => row(i + 1));
  const lines = renderRecheckProposals(rows, OK_RUN, NOW).split("\n");
  assertEquals(lines.filter((l) => l.startsWith("- ")).length, RECHECK_PROPOSAL_LIST_CAP);
  assertEquals(lines[lines.length - 1], `_Showing ${RECHECK_PROPOSAL_LIST_CAP} of ${RECHECK_PROPOSAL_LIST_CAP + 6} pending proposals, oldest first._`);
  // The database's own total wins when the read itself was capped.
  const capped = [row(1, { pending_total: 240 }), row(2, { pending_total: 240 })];
  assertEquals(renderRecheckProposals(capped, OK_RUN, NOW).split("\n").pop(), "_Showing 2 of 240 pending proposals, oldest first._");
  // Exactly at the cap: no note.
  const exact = Array.from({ length: RECHECK_PROPOSAL_LIST_CAP }, (_, i) => row(i + 1));
  assert(!renderRecheckProposals(exact, OK_RUN, NOW).includes("Showing"));
});

Deno.test("render: nothing pending and a healthy job is one quiet line", () => {
  assertEquals(renderRecheckProposals([], OK_RUN, NOW), "Re-check proposals: none pending (last run 2026-11-19 04:00 UTC).");
});

Deno.test("render: a failed read is said, never shown as an empty list", () => {
  assertEquals(
    renderRecheckProposals(null, OK_RUN, NOW),
    "Re-check proposals unavailable: the pending proposals could not be read.",
  );
  assertEquals(
    renderRecheckProposals(null, null, NOW),
    "Re-check proposals unavailable: the pending proposals could not be read.\n_Re-check status unavailable: its last run could not be read._",
  );
  assertEquals(
    renderRecheckProposals([], null, NOW),
    "Re-check proposals: none pending.\n_Re-check status unavailable: its last run could not be read._",
  );
});

Deno.test("run warning: never ran, failed, partial, stale, mid-scan, healthy", () => {
  assertEquals(recheckRunWarning({ started_at: null, status: null }, NOW_MS), "Re-check has never run.");
  assertEquals(
    recheckRunWarning({ started_at: "2026-11-19T04:00:02Z", status: "failed", summary: { failure: "recheck_eligible_items 42883: function\ndoes not exist" } }, NOW_MS),
    "Re-check: last run 2026-11-19 04:00 UTC failed: recheck_eligible_items 42883: function does not exist.",
  );
  assertEquals(
    recheckRunWarning({ started_at: "2026-11-19T04:00:02Z", status: "partial", summary: { items_errored: 2, items_not_started: 5, items_budget_stopped: 1, items_canary_skipped: 0 } }, NOW_MS),
    "Re-check: last run 2026-11-19 04:00 UTC partial: 2 errored, 5 not started, 1 stopped by the time budget.",
  );
  assertEquals(
    recheckRunWarning({ started_at: "2026-11-19T04:00:02Z", status: "partial", summary: { items_canary_skipped: 1 } }, NOW_MS),
    "Re-check: last run 2026-11-19 04:00 UTC partial: 1 canary reached the loop.",
  );
  assertEquals(
    recheckRunWarning({ started_at: "2026-11-19T04:00:02Z", status: null }, NOW_MS),
    "Re-check: last run 2026-11-19 04:00 UTC unknown.",
  );
  // 36 hours is the boundary: exactly 36 is healthy, a minute more is stale.
  const at = (hours: number, minutes = 0) => new Date(NOW_MS - hours * 3_600_000 - minutes * 60_000).toISOString();
  assertEquals(recheckRunWarning({ started_at: at(36), status: "ok", summary: {} }, NOW_MS), null);
  assertEquals(
    recheckRunWarning({ started_at: at(36, 1), status: "ok", summary: {} }, NOW_MS),
    "Re-check: last run 2026-11-17 22:59 UTC, more than 36 hours ago.",
  );
  assertEquals(
    recheckRunWarning({ started_at: "2026-11-19T04:00:02Z", status: "ok", summary: { recheck_incomplete: 3 } }, NOW_MS),
    "Re-check: last run 2026-11-19 04:00 UTC left 3 items mid-scan (recheck_incomplete 3); they continue first next run.",
  );
  assertEquals(
    recheckRunWarning({ started_at: "2026-11-19T04:00:02Z", status: "ok", summary: { recheck_incomplete: 1 } }, NOW_MS),
    "Re-check: last run 2026-11-19 04:00 UTC left 1 item mid-scan (recheck_incomplete 1); they continue first next run.",
  );
  assertEquals(recheckRunWarning(OK_RUN, NOW_MS), null);
  assertEquals(recheckRunWarning({ started_at: "2026-11-19T04:00:02Z", status: "ok", summary: null }, NOW_MS), null);
});

Deno.test("render: the run warning follows the list, and the list is still shown", () => {
  const out = renderRecheckProposals([row(1)], { started_at: null, status: null }, NOW);
  assertEquals(out.split("\n").slice(2), [`- a0001000 Item number 1: "finished item 1" from e0001000`, "_Re-check has never run._"]);
  assertEquals(
    renderRecheckProposals([], { started_at: null, status: null }, NOW),
    "Re-check proposals: none pending.\n_Re-check has never run._",
  );
});

Deno.test("render: a proposal with no quote or evidence id still renders one well-formed line", () => {
  assertEquals(
    renderRecheckProposals([row(1, { quote: null, evidence_thought_id: null })], OK_RUN, NOW).split("\n")[2],
    `- a0001000 Item number 1: ""`,
  );
});

Deno.test("render: no em dash reaches the digest", () => {
  const out = renderRecheckProposals([row(1), row(2, { item_id: row(1).item_id })], { started_at: null, status: null }, NOW) +
    renderRecheckProposals(null, null, NOW) + renderRecheckProposals([], OK_RUN, NOW);
  assert(!out.includes("—"));
});
