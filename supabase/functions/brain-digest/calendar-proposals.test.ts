// Loop-closing Task 5.3: the digest's "Booked" section.
// Run: deno test --allow-read supabase/functions/brain-digest/calendar-proposals.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import {
  CALENDAR_PROPOSAL_LIST_CAP,
  CALENDAR_SECTION_HEADER,
  type CalendarProposalRow,
  renderCalendarProposals,
} from "./calendar-proposals.ts";
import { parseReviewCommand } from "../_shared/proposal-review.ts";
// Runtime-bound claim for the TS mutant sweep (Codex re-review 2, N1).
import { claim } from "../../../scripts/loop-closing/claim.ts";

const BASE_MS = Date.parse("2026-11-20T04:00:00.000Z");

function row(n: number, over: Partial<CalendarProposalRow> = {}): CalendarProposalRow {
  const h = String(n).padStart(4, "0");
  return {
    decision_id: `d${h}000-0000-4000-8000-000000000000`,
    item_id: `a${h}000-0000-4000-8000-000000000000`,
    description: `Schedule tattoo appointment for client ${n}`,
    event_id: `e${h}000-0000-4000-8000-000000000000`,
    event_title: `Tattoo session: client ${n}`,
    event_date: "2027-01-16",
    proposed_at: new Date(BASE_MS + n * 60_000).toISOString(),
    pending_total: null,
    ...over,
  };
}

Deno.test("calendar section: header, then <id> <desc> matches <event title> on <date> (decision <id>), one line per proposal", () => {
  assertEquals(CALENDAR_SECTION_HEADER, "## Booked (reply done <id> or keep <id>; if done asks for a decision, reply done <id> <decision>)");
  claim(
    "calendar-digest-lines",
    renderCalendarProposals([
      row(1, { description: "Schedule tattoo appointment for Alicia Brennan", event_title: "Tattoo session: Alicia Brennan", event_date: "2027-01-16" }),
      row(2, { description: "Book a consult with Jordan Marlow", event_title: "Consultation: Jordan Marlow", event_date: "2027-02-03" }),
    ]),
    `${CALENDAR_SECTION_HEADER}\n\n` +
      `- a0001000 "Schedule tattoo appointment for Alicia Brennan" matches Tattoo session: Alicia Brennan on 2027-01-16 (decision d0001000)\n` +
      `- a0002000 "Book a consult with Jordan Marlow" matches Consultation: Jordan Marlow on 2027-02-03 (decision d0002000)`,
    "the plan's line, with the decision every line needs when the item holds other evidence",
  );
});

Deno.test("calendar section: the printed ids are what the exact Slack forms accept, with and without the decision", () => {
  const line = renderCalendarProposals([row(7)]).split("\n")[2];
  const id = line.slice(2, 10);
  const decision = /\(decision ([0-9a-f]{8})\)$/.exec(line)?.[1];
  assertEquals([id, decision], ["a0007000", "d0007000"]);
  assertEquals(parseReviewCommand(`done ${id}`), { verb: "done", itemRef: "a0007000", decisionRef: null });
  assertEquals(parseReviewCommand(`keep ${id}`), { verb: "keep", itemRef: "a0007000", decisionRef: null });
  assertEquals(parseReviewCommand(`done ${id} ${decision}`), { verb: "done", itemRef: "a0007000", decisionRef: "d0007000" });
});

Deno.test("calendar section: nothing pending omits the section; a failed read says so", () => {
  assertEquals(renderCalendarProposals([]), "");
  assertEquals(renderCalendarProposals(null), "Booking matches unavailable: the pending booking proposals could not be read.");
});

Deno.test("calendar section: oldest first, one line per decision, capped with a count line", () => {
  const rows = Array.from({ length: CALENDAR_PROPOSAL_LIST_CAP + 2 }, (_, i) => row(CALENDAR_PROPOSAL_LIST_CAP + 2 - i, { pending_total: 30 }));
  const lines = renderCalendarProposals([...rows, rows[0]]).split("\n");
  assertEquals(lines.length, 2 + CALENDAR_PROPOSAL_LIST_CAP + 1);
  assertEquals(lines[2].slice(2, 10), "a0001000");
  assertEquals(lines[lines.length - 1], `_Showing ${CALENDAR_PROPOSAL_LIST_CAP} of 30 pending booking matches, oldest first._`);
});

Deno.test("calendar section: the digest reads calendar_pending_proposals and joins the section after the dedup section", () => {
  // brain-digest/index.ts builds its client and starts Deno.serve at import, so
  // the wiring is checked in its source.
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  assertEquals(src.split(`supabase.rpc("calendar_pending_proposals", { p_limit: 200 })`).length - 1, 1);
  assertEquals(src.split("return renderCalendarProposals(rows);").length - 1, 1);
  assertEquals(src.split("const calendarSection = await loadCalendarProposals();").length - 1, 1);
  claim(
    "calendar-digest-section-joined",
    src.includes("[synthesized, checklist, deskLine, archiveSection, recheckSection, fragmentSection, dedupSection, calendarSection].filter(Boolean)"),
    true,
    "the section is joined into the digest body",
  );
});
