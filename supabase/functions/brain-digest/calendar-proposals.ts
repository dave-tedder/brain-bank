// Loop-closing Task 5.3: the digest's "Booked" section, rendered from the
// pending booking proposals (calendar_pending_proposals: layer calendar,
// outcome proposed, reason booking_match, item open, current generation, one
// row per decision, with the event). Pure: the caller passes the rows.
//
// Shape (fixed, tests pin it):
//   ## Booked (reply done <id> or keep <id>; if done asks for a decision, reply done <id> <decision>)
//
//   - 3f2a9c1e "Schedule tattoo appointment for Alicia Brennan" matches Tattoo session: Alicia Brennan on 2027-01-16 (decision 5d6e7f80)
//   _Showing 25 of 31 pending booking matches, oldest first._
//
// The first id is the item's 8-hex short id, which Task 3.6's exact Slack
// forms (`done <id>`, `keep <id>`) and the review_proposal MCP tool accept:
// done resolves the item with close_reason 'done' and the event id in the
// close event's payload; keep records the match as wrong. Every line also
// names its decision, because review_proposal asks for the decision id
// whenever the item holds any other pending evidence (another booking, a
// dedup or a recheck proposal), which this section cannot see. Only
// proposals the matcher still supports reach this read
// (calendar_proposal_supported), so the title and date shown are the ones it
// validated.
//
// Omitted when nothing is pending; a failed read prints one "unavailable"
// line instead of an empty-looking digest.

export interface CalendarProposalRow {
  decision_id: string;
  item_id: string;
  description: string;
  event_id: string;
  event_title: string | null;
  event_date: string | null;
  proposed_at: string;
  pending_total?: number | null;
}

export const CALENDAR_PROPOSAL_LIST_CAP = 25;
export const CALENDAR_SECTION_HEADER =
  "## Booked (reply done <id> or keep <id>; if done asks for a decision, reply done <id> <decision>)";
const DESCRIPTION_MAX = 70;
const TITLE_MAX = 60;

function oneLine(s: string, max: number): string {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One line for one pending proposal. */
export function calendarProposalLine(r: CalendarProposalRow): string {
  const id = r.item_id.slice(0, 8);
  const title = oneLine(r.event_title ?? "", TITLE_MAX) || "(untitled event)";
  const date = String(r.event_date ?? "").slice(0, 10) || "(no date)";
  return `- ${id} "${oneLine(r.description, DESCRIPTION_MAX)}" matches ${title} on ${date} (decision ${r.decision_id.slice(0, 8)})`;
}

/** `rows` null means the read failed. Returns "" when nothing is pending. */
export function renderCalendarProposals(rows: CalendarProposalRow[] | null): string {
  if (rows === null) {
    return "Booking matches unavailable: the pending booking proposals could not be read.";
  }
  if (rows.length === 0) return "";
  const sorted = [...rows].sort((a, b) =>
    Date.parse(a.proposed_at) - Date.parse(b.proposed_at) ||
    (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0) ||
    (a.decision_id < b.decision_id ? -1 : a.decision_id > b.decision_id ? 1 : 0)
  );
  const seen = new Set<string>();
  const unique = sorted.filter((r) => !seen.has(r.decision_id) && seen.add(r.decision_id));
  const shown = unique.slice(0, CALENDAR_PROPOSAL_LIST_CAP);
  const lines = shown.map(calendarProposalLine);
  const total = Math.max(unique.length, ...unique.map((r) => Number(r.pending_total ?? 0) || 0));
  if (total > shown.length) {
    lines.push(`_Showing ${shown.length} of ${total} pending booking matches, oldest first._`);
  }
  return `${CALENDAR_SECTION_HEADER}\n\n${lines.join("\n")}`;
}
