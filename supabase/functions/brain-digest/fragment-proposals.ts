// Loop-closing Task 5.1: the digest's "check wording" section, rendered from
// the pending fragment suspects (fragment_pending_proposals: layer fragment,
// outcome proposed, reason pronoun_object, item open, current generation, one
// row per item). Pure: the caller passes the rows.
//
// Shape (fixed, tests pin it):
//   ## Check wording (reply keep <id> or archive <id>)
//
//   - 921d1ad1 send her the explainer PDF
//   - 6e76d6c7 follow up with him about the deposit
//   _Showing 25 of 31 pending wording checks, oldest first._
//
// The id is the ITEM's 8-hex short id, which Task 3.6's exact Slack forms
// (`keep <id>`, `archive <id>`) and the review_proposal MCP tool accept:
// keep records the wording as acceptable (kept); archive closes the item with
// close_reason 'fragment' (accepted). Nothing here changes anything.
//
// The section is omitted when nothing is pending (there is no job whose health
// it must report, unlike the archive and recheck sections). A failed read
// prints one "unavailable" line instead of an empty-looking digest.

export interface FragmentProposalRow {
  decision_id: string;
  item_id: string;
  description: string;
  proposed_at: string;
  pending_total?: number | null;
}

export const FRAGMENT_PROPOSAL_LIST_CAP = 25;
export const FRAGMENT_SECTION_HEADER = "## Check wording (reply keep <id> or archive <id>)";
const DESCRIPTION_MAX = 90;

function oneLine(s: string, max: number): string {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `rows` null means the read failed. Returns "" when nothing is pending. */
export function renderFragmentProposals(rows: FragmentProposalRow[] | null): string {
  if (rows === null) {
    return "Wording checks unavailable: the pending fragment suspects could not be read.";
  }
  if (rows.length === 0) return "";
  // Oldest first, then item id, whatever order the rows arrived in; one line
  // per item even if the read returned two rows for one.
  const sorted = [...rows].sort((a, b) =>
    Date.parse(a.proposed_at) - Date.parse(b.proposed_at) ||
    (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0)
  );
  const seen = new Set<string>();
  const unique = sorted.filter((r) => !seen.has(r.item_id) && seen.add(r.item_id));
  const shown = unique.slice(0, FRAGMENT_PROPOSAL_LIST_CAP);
  const lines = shown.map((r) => `- ${r.item_id.slice(0, 8)} ${oneLine(r.description, DESCRIPTION_MAX)}`);
  const total = Math.max(unique.length, ...unique.map((r) => Number(r.pending_total ?? 0) || 0));
  if (total > shown.length) {
    lines.push(`_Showing ${shown.length} of ${total} pending wording checks, oldest first._`);
  }
  return `${FRAGMENT_SECTION_HEADER}\n\n${lines.join("\n")}`;
}
