import { assertEquals } from "jsr:@std/assert@1.0.19";
import { type DeskRow, isPerpetualCanary, renderDeskLine } from "./desk-line.ts";

const NOW = "2026-11-03T11:00:00.000Z";
const daysAgo = (d: number) =>
  new Date(Date.parse(NOW) - d * 86_400_000).toISOString();

function row(over: Partial<DeskRow> & { id: string; status: string }): DeskRow {
  return {
    created_at: daysAgo(1),
    archived_at: null,
    not_before: null,
    title: "[agent instructions][unassigned][task] fixture",
    desired_outcome: "fixture",
    ...over,
  };
}

// Plan Task 2.3 Step 1 fixtures, every one in a single call: seven desk cards,
// seven review cards, four held cards (one future hold NOT counted, one expired
// hold counted, two undated), one released card with a stale date (excluded,
// status is no longer Needs Input), one terminal card (excluded), one
// perpetual canary (excluded by marker, never by id).
const FIXTURES: DeskRow[] = [
  ...Array.from({ length: 7 }, (_, i) =>
    row({ id: `desk000${i}-0000-0000-0000-000000000000`, status: "Needs Operator", created_at: daysAgo(i === 3 ? 116 : 10 + i) })),
  ...Array.from({ length: 7 }, (_, i) =>
    row({ id: `revw000${i}-0000-0000-0000-000000000000`, status: "Agent Review", created_at: daysAgo(i === 0 ? 56 : 5 + i) })),
  row({ id: "f78f1aec-c83b-4c33-9d82-d3d24465d37c", status: "Agent Needs Input", created_at: daysAgo(39), not_before: "2026-10-01T00:00:00Z" }),
  row({ id: "aaaaaaaa-1111-0000-0000-000000000000", status: "Agent Needs Input", created_at: daysAgo(3), not_before: "2026-12-01T00:00:00Z" }),
  row({ id: "bbbbbbbb-2222-0000-0000-000000000000", status: "Agent Needs Input", created_at: daysAgo(66) }),
  row({ id: "cccccccc-3333-0000-0000-000000000000", status: "Agent Needs Input", created_at: daysAgo(64) }),
  row({ id: "dddddddd-4444-0000-0000-000000000000", status: "Agent Todo", created_at: daysAgo(80), not_before: "2026-09-01T00:00:00Z" }),
  row({ id: "eeeeeeee-5555-0000-0000-000000000000", status: "Agent Done", created_at: daysAgo(200), not_before: "2026-09-01T00:00:00Z" }),
  row({ id: "7b2dfc8d-0000-0000-0000-000000000000", status: "Needs Operator", created_at: daysAgo(400), title: "PERPETUAL canary: never promote", desired_outcome: "a standing tripwire" }),
];

Deno.test("renderDeskLine: the plan's Step 1 line, exactly", () => {
  assertEquals(
    renderDeskLine(FIXTURES, NOW),
    "Board desk: Needs Operator 7 (oldest 116 d), Review held 7 (oldest 56 d), Needs Input 4, 1 hold past its not-before date (f78f1aec).",
  );
});

Deno.test("renderDeskLine: a future hold is in the Needs Input count but not the expired list", () => {
  const out = renderDeskLine([
    row({ id: "aaaaaaaa-1111-0000-0000-000000000000", status: "Agent Needs Input", not_before: "2026-12-01T00:00:00Z" }),
  ], NOW);
  assertEquals(out, "Board desk: Needs Operator 0, Review held 0, Needs Input 1, no holds past their not-before date.");
});

Deno.test("renderDeskLine: a hold whose date is exactly now is not yet expired; one second earlier is", () => {
  const atNow = row({ id: "aaaaaaaa-1111-0000-0000-000000000000", status: "Agent Needs Input", not_before: NOW });
  assertEquals(renderDeskLine([atNow], NOW).endsWith("no holds past their not-before date."), true);
  const justBefore = { ...atNow, not_before: new Date(Date.parse(NOW) - 1000).toISOString() };
  assertEquals(renderDeskLine([justBefore], NOW).endsWith("1 hold past its not-before date (aaaaaaaa)."), true);
});

Deno.test("renderDeskLine: a released card keeps a stale date but is excluded by status; a terminal card too", () => {
  const out = renderDeskLine([
    row({ id: "dddddddd-4444-0000-0000-000000000000", status: "Agent Todo", not_before: "2026-09-01T00:00:00Z" }),
    row({ id: "eeeeeeee-5555-0000-0000-000000000000", status: "Agent Done", not_before: "2026-09-01T00:00:00Z" }),
    row({ id: "ffffffff-6666-0000-0000-000000000000", status: "Standing" }),
  ], NOW);
  assertEquals(out, "Board desk: Needs Operator 0, Review held 0, Needs Input 0, no holds past their not-before date.");
});

Deno.test("renderDeskLine: archived rows are excluded even when the status matches", () => {
  const out = renderDeskLine([
    row({ id: "aaaaaaaa-1111-0000-0000-000000000000", status: "Agent Needs Input", not_before: "2026-01-01T00:00:00Z", archived_at: daysAgo(2) }),
    row({ id: "bbbbbbbb-2222-0000-0000-000000000000", status: "Needs Operator", archived_at: daysAgo(2) }),
  ], NOW);
  assertEquals(out, "Board desk: Needs Operator 0, Review held 0, Needs Input 0, no holds past their not-before date.");
});

Deno.test("renderDeskLine: the perpetual canary is excluded by marker, never by id", () => {
  const canary = row({ id: "12345678-0000-0000-0000-000000000000", status: "Agent Needs Input", not_before: "2026-01-01T00:00:00Z", title: "Perpetual Tripwire: do not touch" });
  assertEquals(isPerpetualCanary(canary), true);
  assertEquals(isPerpetualCanary(row({ id: "x", status: "Agent Needs Input", title: "canary deployment plan" })), false);
  assertEquals(isPerpetualCanary(row({ id: "x", status: "Agent Needs Input", title: "a perpetual calendar" })), false);
  assertEquals(
    renderDeskLine([canary], NOW),
    "Board desk: Needs Operator 0, Review held 0, Needs Input 0, no holds past their not-before date.",
  );
});

Deno.test("renderDeskLine: several expired holds list sorted shortids and plural wording", () => {
  const out = renderDeskLine([
    row({ id: "bbbbbbbb-0000-0000-0000-000000000000", status: "Agent Needs Input", not_before: "2026-10-01T00:00:00Z" }),
    row({ id: "aaaaaaaa-0000-0000-0000-000000000000", status: "Agent Needs Input", not_before: "2026-09-01T00:00:00Z" }),
  ], NOW);
  assertEquals(out, "Board desk: Needs Operator 0, Review held 0, Needs Input 2, 2 holds past their not-before date (aaaaaaaa, bbbbbbbb).");
});

Deno.test("renderDeskLine: age is whole days from created_at, floored, never negative", () => {
  const out = renderDeskLine([
    row({ id: "a", status: "Needs Operator", created_at: new Date(Date.parse(NOW) - 2.9 * 86_400_000).toISOString() }),
    row({ id: "b", status: "Agent Review", created_at: new Date(Date.parse(NOW) + 3600_000).toISOString() }),
  ], NOW);
  assertEquals(out, "Board desk: Needs Operator 1 (oldest 2 d), Review held 1 (oldest 0 d), Needs Input 0, no holds past their not-before date.");
});

Deno.test("renderDeskLine: no rows still renders a complete line", () => {
  assertEquals(renderDeskLine([], NOW), "Board desk: Needs Operator 0, Review held 0, Needs Input 0, no holds past their not-before date.");
});
