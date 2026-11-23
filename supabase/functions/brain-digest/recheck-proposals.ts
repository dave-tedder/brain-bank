// Loop-closing Task 4.1: the digest's "Looks done" section, rendered from the
// pending re-check proposals (recheck_pending_proposals: layer recheck, outcome
// proposed, item open, current generation) plus the nightly run's last receipt
// (action_item_recheck_runs). Pure: the caller passes the rows, the receipt and
// the moment.
//
// Shape (fixed, tests pin it):
//   ## Looks done (reply done <id> or keep <id>)
//
//   - 921d1ad1 Regenerate WordPress MCP bearer tokens: "rotated all three tokens" from 4be0a1c2
//   - 6e76d6c7 Flip the leaked password setting: "turned it on" from 77aa0b3d (decision 1c2d3e4f; 2 pending, reply done 6e76d6c7 <decision id>)
//   _Showing 25 of 31 pending proposals, oldest first._
//   _Re-check: last run 2026-11-19 04:00 UTC partial: 2 items errored._
//
// Ids are the 8-hex short ids Task 3.6's exact Slack forms accept: the first is
// the ITEM, "from" names the evidence THOUGHT. An item with two or more pending
// proposals needs `done <item> <decision>`, so its lines carry the decision id.
// Nothing here resolves anything: a proposal waits for a reply.
//
// Read surface (pg-cron-patterns I4): the run line is printed when the job has
// never run, its last run failed or was partial, items are still mid-scan, or
// the last run is older than 36 hours, so a broken job cannot hide behind an
// empty list. When the job is healthy and nothing is pending, one quiet line
// says so.

export interface RecheckProposalRow {
  decision_id: string;
  item_id: string;
  description: string;
  quote: string | null;
  evidence_thought_id: string | null;
  proposed_at: string;
  pending_total?: number | null;
}

export interface RecheckRunRow {
  started_at: string | null;
  status: string | null;
  summary?: Record<string, unknown> | null;
}

export const RECHECK_PROPOSAL_LIST_CAP = 25;
export const RECHECK_JOB_STALE_HOURS = 36;
const DESCRIPTION_MAX = 70;
const QUOTE_MAX = 140;

function oneLine(s: string, max: number): string {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function utcMinute(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function count(summary: Record<string, unknown> | null | undefined, key: string): number {
  const v = summary?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** null when the job is healthy; otherwise the warning sentence. `run` null
 * means the read itself failed; a run with no started_at means it never ran. */
export function recheckRunWarning(run: RecheckRunRow | null, nowMs: number): string | null {
  if (run === null) return "Re-check status unavailable: its last run could not be read.";
  if (!run.started_at) return "Re-check has never run.";
  const when = utcMinute(run.started_at);
  const s = run.summary ?? {};
  if (run.status !== "ok") {
    const parts: string[] = [];
    const failure = typeof s.failure === "string" && s.failure ? oneLine(s.failure, 120) : "";
    if (failure) parts.push(failure);
    for (const [key, label] of [
      ["items_errored", "errored"],
      ["items_not_started", "not started"],
      ["items_budget_stopped", "stopped by the time budget"],
      ["items_canary_skipped", "canary reached the loop"],
    ] as const) {
      const n = count(s, key);
      if (n > 0) parts.push(`${n} ${label}`);
    }
    return `Re-check: last run ${when} ${run.status ?? "unknown"}${parts.length ? `: ${parts.join(", ")}` : ""}.`;
  }
  if (nowMs - Date.parse(run.started_at) > RECHECK_JOB_STALE_HOURS * 3_600_000) {
    return `Re-check: last run ${when}, more than ${RECHECK_JOB_STALE_HOURS} hours ago.`;
  }
  const incomplete = count(s, "recheck_incomplete");
  if (incomplete > 0) {
    return `Re-check: last run ${when} left ${incomplete} ${incomplete === 1 ? "item" : "items"} mid-scan (recheck_incomplete ${incomplete}); they continue first next run.`;
  }
  return null;
}

/** `rows` null means the proposal read failed. */
export function renderRecheckProposals(
  rows: RecheckProposalRow[] | null,
  run: RecheckRunRow | null,
  nowIso: string,
): string {
  const nowMs = Date.parse(nowIso);
  const warning = recheckRunWarning(run, nowMs);
  if (rows === null) {
    return [
      "Re-check proposals unavailable: the pending proposals could not be read.",
      warning ? `_${warning}_` : "",
    ].filter(Boolean).join("\n");
  }
  if (rows.length === 0) {
    const when = run?.started_at && !warning ? ` (last run ${utcMinute(run.started_at)})` : "";
    return [
      `Re-check proposals: none pending${when}.`,
      warning ? `_${warning}_` : "",
    ].filter(Boolean).join("\n");
  }
  // Oldest proposal first, then decision id, whatever order the rows arrived in.
  const sorted = [...rows].sort((a, b) =>
    Date.parse(a.proposed_at) - Date.parse(b.proposed_at) ||
    (a.decision_id < b.decision_id ? -1 : a.decision_id > b.decision_id ? 1 : 0)
  );
  const perItem = new Map<string, number>();
  for (const r of sorted) perItem.set(r.item_id, (perItem.get(r.item_id) ?? 0) + 1);
  const shown = sorted.slice(0, RECHECK_PROPOSAL_LIST_CAP);
  const lines = shown.map((r) => {
    const item = r.item_id.slice(0, 8);
    const from = r.evidence_thought_id ? ` from ${r.evidence_thought_id.slice(0, 8)}` : "";
    const n = perItem.get(r.item_id) ?? 1;
    const which = n > 1
      ? ` (decision ${r.decision_id.slice(0, 8)}; ${n} pending, reply done ${item} <decision id>)`
      : "";
    return `- ${item} ${oneLine(r.description, DESCRIPTION_MAX)}: "${oneLine(r.quote ?? "", QUOTE_MAX)}"${from}${which}`;
  });
  const total = Math.max(sorted.length, ...sorted.map((r) => Number(r.pending_total ?? 0) || 0));
  if (total > shown.length) {
    lines.push(`_Showing ${shown.length} of ${total} pending proposals, oldest first._`);
  }
  if (warning) lines.push(`_${warning}_`);
  return `## Looks done (reply done <id> or keep <id>)\n\n${lines.join("\n")}`;
}
