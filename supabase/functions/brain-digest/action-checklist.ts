// The digest's open-action checklist, rendered from exact action_items rows.
//
// Loop-closing Task 3.3: each line carries triage's proposal as a tag, and the
// 40 slots are split so the items that carry a deadline or name a client are
// never crowded out.
//
//   ## Open Action Items
//
//   - [ ] Send the estimate by 2026-12-01 (<id>)
//   - [ ] Research permit requirements (<id>) [triage: duplicate of <id>]
//   - [ ] Draft the aftercare email (<id>) [triage: done per thought:<id>]
//   _Showing 40 of 212 open action items. 172 more remain open._
//
// Selection (selectChecklistRows), from every open row the caller read:
//   1. Reserved, up to 15: items that are dated (a deadline, as
//      archive-policy.ts's deadlineFrom reads one) or client-shaped
//      (isClientShaped), oldest first by created_at.
//   2. General, the rest of the 40: every other item, oldest unreviewed first,
//      by the clock the triage read uses (list_unreviewed_action_items):
//      coalesce(last_reviewed_at, created_at) ascending, then id. A pending
//      triage proposal gets NO priority here: it sorts by its review time like
//      any reviewed item, so proposals cannot push never-reviewed work off the
//      list (the plan's literal order; the operator's decision, 2026-11-19 ET, on the
//      PR 25 review). Its tag still renders on whichever rows are shown. A dated
//      or client-shaped item past the 15 competes here like any other.
//   A reserved slot nothing claims goes to the general list, so 40 lines are
//   shown whenever 40 items are open.
// The two definitions of "dated" and "client-shaped" are Task 3.2's, imported,
// so the digest and the archive policy cannot disagree about them.
//
// Pure: no clock, no I/O. index.ts reads the rows and the client names.

import { deadlineFrom, isClientShaped } from "../_shared/archive-policy.ts";

export interface DigestActionRow {
  id: string;
  description: string;
  created_at: string;
  last_reviewed_at?: string | null;
  review_outcome?: string | null;
  triage_disposition?: string | null;
  triage_evidence?: string | null;
  triage_replacement_id?: string | null;
}

export const CHECKLIST_CAP = 40;
export const RESERVED_SLOTS = 15;
const EVIDENCE_MAX = 80;

function oneLine(s: string, max: number): string {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function time(iso: string | null | undefined): number {
  const t = Date.parse(iso ?? "");
  // An unreadable date sorts last, never first.
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

function byId(a: DigestActionRow, b: DigestActionRow): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function isPendingProposal(row: DigestActionRow): boolean {
  return row.review_outcome === "proposal" && !!row.triage_disposition;
}

/** Dated (carries a deadline) or client-shaped. */
export function isReservedItem(
  row: DigestActionRow,
  clientNames: readonly string[],
): boolean {
  return deadlineFrom(row.description) !== null ||
    isClientShaped(row.description, clientNames);
}

/** The triage tag for one row, or "" when its last review is not a proposal. */
export function triageTag(row: DigestActionRow): string {
  if (!isPendingProposal(row)) return "";
  const disposition = String(row.triage_disposition);
  const evidence = oneLine(row.triage_evidence ?? "", EVIDENCE_MAX);
  if (disposition === "duplicate") {
    return row.triage_replacement_id
      ? `triage: duplicate of ${row.triage_replacement_id}`
      : "triage: duplicate (the other item no longer exists)";
  }
  if (disposition === "done") {
    return evidence ? `triage: done per ${evidence}` : "triage: done";
  }
  return evidence ? `triage: ${disposition} (${evidence})` : `triage: ${disposition}`;
}

export interface ChecklistSelection {
  reserved: DigestActionRow[];
  general: DigestActionRow[];
}

export function selectChecklistRows(
  rows: readonly DigestActionRow[],
  clientNames: readonly string[],
  cap: number = CHECKLIST_CAP,
  reservedSlots: number = RESERVED_SLOTS,
): ChecklistSelection {
  const reserved = rows
    .filter((r) => isReservedItem(r, clientNames))
    .sort((a, b) => time(a.created_at) - time(b.created_at) || byId(a, b))
    .slice(0, Math.min(reservedSlots, cap));
  const taken = new Set(reserved.map((r) => r.id));
  const general = rows
    .filter((r) => !taken.has(r.id))
    .sort((a, b) => {
      const ta = time(a.last_reviewed_at ?? a.created_at);
      const tb = time(b.last_reviewed_at ?? b.created_at);
      return ta - tb || byId(a, b);
    })
    .slice(0, Math.max(0, cap - reserved.length));
  return { reserved, general };
}

export function renderOpenActionChecklist(
  rows: DigestActionRow[],
  total: number = rows.length,
  notes: readonly string[] = [],
): string {
  if (rows.length === 0) return "";

  const lines = rows.map((row) => {
    const tag = triageTag(row);
    return `- [ ] ${row.description} (${row.id})${tag ? ` [${tag}]` : ""}`;
  });
  if (total > rows.length) {
    lines.push(
      `_Showing ${rows.length} of ${total} open action items. ${
        total - rows.length
      } more remain open._`,
    );
  }
  for (const note of notes) lines.push(`_${note}_`);

  return `## Open Action Items\n\n${lines.join("\n")}`;
}

export interface ChecklistInput {
  /** Every open row with its review columns, or null when that read failed. */
  rows: DigestActionRow[] | null;
  /** The exact open count, or null when unknown. */
  total: number | null;
  /** clients.name, or null when that read failed. */
  clientNames: string[] | null;
  /** True when clientNames is known to be, or may be, only part of the list. */
  clientNamesPartial?: boolean;
  /** The pre-3.3 read (newest first, no review columns), used only when `rows`
   * is null, so a missing migration degrades to the old checklist. */
  legacyRows: DigestActionRow[] | null;
}

/** The whole section. A failed read is said, never rendered as an empty or
 * untagged list that looks complete. */
export function buildOpenActionChecklist(input: ChecklistInput): string {
  if (input.rows === null) {
    if (input.legacyRows === null) {
      return "Open action items unavailable: action_items could not be read.";
    }
    const total = input.total ?? input.legacyRows.length;
    const body = renderOpenActionChecklist(input.legacyRows, total, [
      "Triage tags unavailable: the review columns could not be read. Newest first, no reserved slots.",
    ]);
    return body ||
      "Open action items: none read. Triage tags unavailable: the review columns could not be read.";
  }
  const total = Math.max(input.total ?? 0, input.rows.length);
  const notes: string[] = [];
  if (total > input.rows.length) {
    notes.push(
      `Chosen from the oldest ${input.rows.length} open items; ${
        total - input.rows.length
      } newer ones were not considered.`,
    );
  }
  if (input.clientNames === null) {
    notes.push(
      "Client names unavailable: reserved slots hold dated items only.",
    );
  } else if (input.clientNamesPartial) {
    notes.push(
      "Client names only partly read: some client-shaped items may be missing from the reserved slots.",
    );
  }
  const { reserved, general } = selectChecklistRows(
    input.rows,
    input.clientNames ?? [],
  );
  return renderOpenActionChecklist([...reserved, ...general], total, notes);
}
