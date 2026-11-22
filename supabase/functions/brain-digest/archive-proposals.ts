// Loop-closing Task 3.2: the digest's archive-proposal section, rendered from
// exact action_items rows (archive_proposed_at set, archive_review_outcome
// null, status open) plus the 05:30 UTC job's last cron run. Pure: the caller
// passes the rows, the last run and the moment.
//
// Shape (fixed, tests pin it):
//   ## Proposed for archive (reply keep <id> or archive <id>)
//
//   - 921d1ad1 212 d Regenerate WordPress MCP bearer tokens for ...
//   - 6e76d6c7 209 d TODO: flip auth_leaked_password_protection ...
//   _2 unreviewed proposals are older than 30 days._
//   _Archive job: last run 2026-11-19 05:30 UTC failed: <message>._
//
// The id is the 8-hex short id Task 3.6's exact Slack forms accept. Age is the
// ITEM's age. Nothing here archives: a proposal waits for a reply forever and
// is counted, never acted on, once it is older than 30 days.
//
// Read surface (pg-cron-patterns I4): the job line is printed when the job has
// never run, its last run did not succeed, or the last run is older than 36
// hours, so a broken job cannot hide behind an empty proposal list. When the
// job is healthy and nothing is pending, one quiet line says so.

export interface ArchiveProposalRow {
  id: string;
  description: string;
  created_at: string;
  archive_proposed_at: string;
}

export interface ArchiveJobRun {
  status: string | null;
  start_time: string | null;
  return_message?: string | null;
}

export const ARCHIVE_PROPOSAL_LIST_CAP = 25;
export const UNREVIEWED_DAYS = 30;
export const JOB_STALE_HOURS = 36;
const DAY_MS = 86_400_000;

function wholeDays(fromIso: string, nowMs: number): number {
  const t = Date.parse(fromIso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((nowMs - t) / DAY_MS));
}

function oneLine(s: string, max = 110): string {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function utcMinute(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** null when the job is healthy; otherwise the warning sentence. `run` null
 * means the read itself failed; undefined-equivalent "never ran" is a run
 * object with no start_time. */
export function archiveJobWarning(run: ArchiveJobRun | null, nowMs: number): string | null {
  if (run === null) return "Archive job status unavailable: its last run could not be read.";
  if (!run.start_time) return "Archive job has never run.";
  const when = utcMinute(run.start_time);
  if (run.status !== "succeeded") {
    const msg = oneLine(run.return_message ?? "", 160);
    return `Archive job: last run ${when} ${run.status ?? "unknown"}${msg ? `: ${msg}` : ""}.`;
  }
  if (nowMs - Date.parse(run.start_time) > JOB_STALE_HOURS * 3_600_000) {
    return `Archive job: last run ${when}, more than ${JOB_STALE_HOURS} hours ago.`;
  }
  return null;
}

/** `rows` null means the proposal read failed. */
export function renderArchiveProposals(
  rows: ArchiveProposalRow[] | null,
  run: ArchiveJobRun | null,
  nowIso: string,
): string {
  const nowMs = Date.parse(nowIso);
  const warning = archiveJobWarning(run, nowMs);
  if (rows === null) {
    return [
      "Archive proposals unavailable: action_items could not be read.",
      warning ? `_${warning}_` : "",
    ].filter(Boolean).join("\n");
  }
  if (rows.length === 0) {
    const when = run?.start_time && !warning ? ` (job ran ${utcMinute(run.start_time)})` : "";
    return [
      `Archive proposals: none pending${when}.`,
      warning ? `_${warning}_` : "",
    ].filter(Boolean).join("\n");
  }
  // Oldest item first: the longest-ignored work leads.
  const sorted = [...rows].sort((a, b) =>
    Date.parse(a.created_at) - Date.parse(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  const shown = sorted.slice(0, ARCHIVE_PROPOSAL_LIST_CAP);
  const lines = shown.map((r) =>
    `- ${r.id.slice(0, 8)} ${wholeDays(r.created_at, nowMs)} d ${oneLine(r.description)}`
  );
  if (sorted.length > shown.length) {
    lines.push(`_Showing ${shown.length} of ${sorted.length} pending proposals, oldest first._`);
  }
  const unreviewed = rows.filter((r) => wholeDays(r.archive_proposed_at, nowMs) >= UNREVIEWED_DAYS).length;
  if (unreviewed > 0) {
    lines.push(
      unreviewed === 1
        ? `_1 unreviewed proposal is older than ${UNREVIEWED_DAYS} days._`
        : `_${unreviewed} unreviewed proposals are older than ${UNREVIEWED_DAYS} days._`,
    );
  }
  if (warning) lines.push(`_${warning}_`);
  return `## Proposed for archive (reply keep <id> or archive <id>)\n\n${lines.join("\n")}`;
}
