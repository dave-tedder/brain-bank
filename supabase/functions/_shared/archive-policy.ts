// Loop-closing Task 3.2 (C2): age-based archive PROPOSALS for open action items.
//
// This module is the reference policy. The 05:30 UTC pg_cron job in
// supabase/migrations/20261119_action_items_archive_proposal_job.sql mirrors it
// in SQL (public.archive_proposals_due), and the two are proven equal by
// running both over the same rows and diffing the result sets
// (scripts/loop-closing/archive-proposals-diff.ts). Change one, change both.
//
// Nothing here archives anything. A due item gets archive_proposed_at and one
// `archive`/`proposed` decision row; The operator replies `keep <id>` or `archive <id>`
// and Task 3.6's review_proposal does the rest.
//
// Pure: no clock, no I/O. The caller passes the item, what it knows about the
// item's surroundings (source thought, cards, clients, fragment flag) and now.
//
// Policy, in evaluation order (plan Task 3.2, "Interfaces"):
//   1. Exempt (null): status other than open (deferred is exempt), the
//      perpetual canary, an item linked to an unarchived non-terminal card, an
//      item reopened within the last 90 days, and a client-shaped item.
//   2. Deadline: an ISO date (YYYY-MM-DD) with by/before/until/due/after among
//      the three tokens before it is a deadline; due at the latest such date
//      plus 14 days, reason deadline_passed. A bare date is a reference and the
//      item follows the age rules.
//   3. Work report or fragment-flagged: created_at plus 30 days, age_work_report.
//   4. Standard: created_at plus 60 days, age_standard.
// Exemptions are re-evaluated on every run, never frozen.

import { isWorkReportCapture } from "./metadata-validation.ts";

export const DAY_MS = 86_400_000;
export const WORK_REPORT_AGE_DAYS = 30;
export const STANDARD_AGE_DAYS = 60;
export const DEADLINE_GRACE_DAYS = 14;
export const REOPEN_EXEMPT_DAYS = 90;
export const KEEP_EXEMPT_DAYS = 90;
export const DEADLINE_KEYWORDS: ReadonlySet<string> = new Set([
  "by",
  "before",
  "until",
  "due",
  "after",
]);
// The keyword must be one of the three tokens immediately before the date.
export const DEADLINE_WINDOW_TOKENS = 3;

export type ArchiveReason = "age_work_report" | "age_standard" | "deadline_passed";

export interface ArchivePolicyItem {
  id: string;
  description: string;
  status: string;
  created_at: string;
  reopened_at: string | null;
  archive_proposed_at: string | null;
  archive_review_outcome: string | null;
  archive_reviewed_at: string | null;
}

export interface ArchivePolicyContext {
  /** The source thought is a session close-out (Task 1.2's classifier). */
  sourceIsWorkReport: boolean;
  /** A current-generation `fragment` decision row exists (Task 5.1's writer). */
  fragmentFlagged: boolean;
  /** An unarchived card that is not Agent Done links to this item. */
  linkedToOpenCard: boolean;
  /** Every clients.name. */
  clientNames: readonly string[];
}

export interface ArchiveDue {
  dueAt: Date;
  reason: ArchiveReason;
}

/** What the job does with a due item. */
export type ArchiveAction =
  | "propose" // never proposed in this generation
  | "repropose" // kept more than 90 days ago and still due: new proposal, review cleared
  | "pending" // proposed, not yet reviewed: nothing written
  | "kept_recently" // kept within 90 days: nothing written
  | "accepted"; // cannot happen on an open item (a reopen clears it): nothing written

/** Tokens for whole-name matching: lowercase ASCII alphanumeric runs. */
export function nameTokens(s: string): string[] {
  return String(s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** The perpetual canary marker, as desk-line.ts and the sentinel define it. */
export function isPerpetualCanaryText(description: string): boolean {
  const t = String(description ?? "").toLowerCase();
  return t.includes("perpetual") && (t.includes("canary") || t.includes("tripwire"));
}

/** Client-shaped: the description names a client in full (two or more name
 * tokens, in order, as whole tokens), or carries a capitalised word of three or
 * more letters that find_client's partial match would return two or more
 * clients for (the "nudge Jordan" case: Jordan matches two names). A capitalised
 * word matching exactly one client is NOT client-shaped on its own; the plan
 * names only the full-name and shared-first-name cases. */
export function isClientShaped(description: string, clientNames: readonly string[]): boolean {
  const desc = String(description ?? "");
  const hay = ` ${nameTokens(desc).join(" ")} `;
  for (const name of clientNames) {
    const ct = nameTokens(name);
    if (ct.length >= 2 && hay.includes(` ${ct.join(" ")} `)) return true;
  }
  const lowered = clientNames.map((n) => String(n ?? "").toLowerCase());
  for (const word of desc.split(/[^A-Za-z]+/)) {
    if (!/^[A-Z][A-Za-z]{2,}$/.test(word)) continue;
    const w = word.toLowerCase();
    let matches = 0;
    for (const n of lowered) if (n.includes(w)) matches += 1;
    if (matches >= 2) return true;
  }
  return false;
}

const ISO_IN_TOKEN = /(?<![0-9])([0-9]{4})-([0-9]{2})-([0-9]{2})(?![0-9])/;
const CLAUSE_END = /[,;.]$/;

/** Midnight UTC of a real calendar date, or null. Years below 100 are refused,
 * as metadata-validation.ts refuses them. */
export function realDateUtc(y: number, mo: number, d: number): number | null {
  if (y < 100 || mo < 1 || mo > 12 || d < 1) return null;
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return t;
}

/** The latest deadline date in the description (midnight UTC ms), or null.
 * Tokens are whitespace-separated; a token's first ISO date counts when one of
 * the three tokens before it is a keyword once lowercased and stripped of
 * everything but a-z, with no clause break (a token ending in , ; or .)
 * between the keyword and the date or on the keyword itself. */
export function deadlineFrom(description: string): number | null {
  const toks = String(description ?? "").split(/\s+/).filter(Boolean);
  let best: number | null = null;
  for (let i = 0; i < toks.length; i++) {
    const m = ISO_IN_TOKEN.exec(toks[i]);
    if (!m) continue;
    const t = realDateUtc(Number(m[1]), Number(m[2]), Number(m[3]));
    if (t === null) continue;
    for (let j = i - 1; j >= Math.max(0, i - DEADLINE_WINDOW_TOKENS); j--) {
      // A token ending a clause (comma, semicolon, full stop) ends the look-back:
      // "before and after, from 2026-12-22" is a reference date, not a deadline.
      if (CLAUSE_END.test(toks[j])) break;
      const kw = toks[j].toLowerCase().replace(/[^a-z]/g, "");
      if (DEADLINE_KEYWORDS.has(kw)) {
        if (best === null || t > best) best = t;
        break;
      }
    }
  }
  return best;
}

/** When the item becomes due for an archive proposal, and why; null when it is
 * exempt (never proposed while the exemption holds). A returned date may be in
 * the future: due means dueAt <= now. */
export function archiveDueAt(
  item: ArchivePolicyItem,
  ctx: ArchivePolicyContext,
  now: Date,
): ArchiveDue | null {
  if (item.status !== "open") return null;
  if (isPerpetualCanaryText(item.description)) return null;
  if (ctx.linkedToOpenCard) return null;
  if (item.reopened_at) {
    const r = Date.parse(item.reopened_at);
    if (r > now.getTime() - REOPEN_EXEMPT_DAYS * DAY_MS) return null;
  }
  if (isClientShaped(item.description, ctx.clientNames)) return null;

  const deadline = deadlineFrom(item.description);
  if (deadline !== null) {
    return { dueAt: new Date(deadline + DEADLINE_GRACE_DAYS * DAY_MS), reason: "deadline_passed" };
  }
  const created = Date.parse(item.created_at);
  if (ctx.sourceIsWorkReport || ctx.fragmentFlagged) {
    return { dueAt: new Date(created + WORK_REPORT_AGE_DAYS * DAY_MS), reason: "age_work_report" };
  }
  return { dueAt: new Date(created + STANDARD_AGE_DAYS * DAY_MS), reason: "age_standard" };
}

/** The review state decides what a due item gets. */
export function archiveAction(item: ArchivePolicyItem, now: Date): ArchiveAction {
  const outcome = item.archive_review_outcome;
  if (outcome === "accepted") return "accepted";
  if (outcome === "kept") {
    const reviewed = Date.parse(item.archive_reviewed_at ?? "");
    return reviewed > now.getTime() - KEEP_EXEMPT_DAYS * DAY_MS ? "kept_recently" : "repropose";
  }
  return item.archive_proposed_at ? "pending" : "propose";
}

export interface ArchiveDueRow {
  item_id: string;
  reason: ArchiveReason;
  due_at: string;
  action: ArchiveAction;
}

/** The whole due set for one run: the same rows public.archive_proposals_due
 * returns. The job writes only `propose` and `repropose` rows. */
export function archiveDueRows(
  items: readonly ArchivePolicyItem[],
  ctxFor: (item: ArchivePolicyItem) => ArchivePolicyContext,
  now: Date,
): ArchiveDueRow[] {
  const out: ArchiveDueRow[] = [];
  for (const item of items) {
    const due = archiveDueAt(item, ctxFor(item), now);
    if (!due || due.dueAt.getTime() > now.getTime()) continue;
    out.push({
      item_id: item.id,
      reason: due.reason,
      due_at: due.dueAt.toISOString(),
      action: archiveAction(item, now),
    });
  }
  return out.sort((a, b) => (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0));
}

/** Task 1.2's classifier applied to the item's source thought. No source
 * thought (or no content) is not a work report. */
export function sourceIsWorkReport(content: string | null | undefined, capturedAt: string | null | undefined): boolean {
  if (!content || !capturedAt) return false;
  return isWorkReportCapture(content, new Date(capturedAt));
}
