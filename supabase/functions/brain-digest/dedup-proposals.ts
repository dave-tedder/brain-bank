// Loop-closing Task 5.2: the digest's "possible duplicates" section, rendered
// from the pending semantic dedup proposals (dedup_pending_proposals: layer
// dedup, outcome proposed, reason semantic_overlap, item open, current
// generation, one row per item, with the survivor). Pure: the caller passes
// the rows.
//
// Shape (fixed, tests pin it):
//   ## Possible duplicates (reply done <id> to archive the newer copy, or keep <id> if they are distinct)
//
//   - 921d1ad1 "send Riley the final appointment reminder email" possible duplicate of 6e76d6c7 "send Sam the final appointment reminder email" (constraints agree)
//   - 4b0c99e2 "deploy the CRM appointment reminder email to demo" possible duplicate of 1f2e3d4c "deploy the CRM appointment reminder email to live" (constraints differ: live vs demo)
//   _Showing 25 of 31 pending duplicate checks, oldest first._
//
// The first id is the NEWER item's 8-hex short id, which Task 3.6's exact
// Slack forms (`done <id>`, `keep <id>`) and the review_proposal MCP tool
// accept: done archives the newer copy with close_reason 'duplicate' and
// duplicate_of the survivor; keep records the pair as distinct. The
// constraint wording comes from _shared/dedup.ts describeConstraints and
// decides nothing. A survivor that is no longer open says so, since done is
// refused while the survivor is archived.
//
// Omitted when nothing is pending; a failed read prints one "unavailable"
// line instead of an empty-looking digest.

import { describeConstraints } from "../_shared/dedup.ts";

export interface DedupProposalRow {
  decision_id: string;
  item_id: string;
  description: string;
  survivor_id: string;
  survivor_description: string | null;
  survivor_status: string | null;
  score?: number | string | null;
  proposed_at: string;
  pending_total?: number | null;
}

export const DEDUP_PROPOSAL_LIST_CAP = 25;
export const DEDUP_SECTION_HEADER =
  "## Possible duplicates (reply done <id> to archive the newer copy, or keep <id> if they are distinct)";
const DESCRIPTION_MAX = 70;

function oneLine(s: string, max: number): string {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One line for one pending proposal. */
export function dedupProposalLine(r: DedupProposalRow): string {
  const survivorText = r.survivor_description ?? "";
  const status = r.survivor_status && r.survivor_status !== "open" ? `, survivor ${r.survivor_status}` : "";
  return `- ${r.item_id.slice(0, 8)} "${oneLine(r.description, DESCRIPTION_MAX)}" possible duplicate of ${
    r.survivor_id.slice(0, 8)
  } "${oneLine(survivorText, DESCRIPTION_MAX)}" (${describeConstraints(r.description, survivorText)}${status})`;
}

/** `rows` null means the read failed. Returns "" when nothing is pending. */
export function renderDedupProposals(rows: DedupProposalRow[] | null): string {
  if (rows === null) {
    return "Duplicate checks unavailable: the pending dedup proposals could not be read.";
  }
  if (rows.length === 0) return "";
  const sorted = [...rows].sort((a, b) =>
    Date.parse(a.proposed_at) - Date.parse(b.proposed_at) ||
    (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0)
  );
  const seen = new Set<string>();
  const unique = sorted.filter((r) => !seen.has(r.item_id) && seen.add(r.item_id));
  const shown = unique.slice(0, DEDUP_PROPOSAL_LIST_CAP);
  const lines = shown.map(dedupProposalLine);
  const total = Math.max(unique.length, ...unique.map((r) => Number(r.pending_total ?? 0) || 0));
  if (total > shown.length) {
    lines.push(`_Showing ${shown.length} of ${total} pending duplicate checks, oldest first._`);
  }
  return `${DEDUP_SECTION_HEADER}\n\n${lines.join("\n")}`;
}
