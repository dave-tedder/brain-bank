// Surfaces the operations sentinel's verdict (OE-14) in the daily digest.
// Advisory like the compile-health warning: a missing or stale sentinel adds a
// warning line but never blocks the digest.
// Verdict contract: agent_task_ledger.last_queue_result for the sentinel starts
// with "OE-SENTINEL " (skills/open-engine-sentinel/SKILL.md).

export interface SentinelLedgerRow {
  last_heartbeat: string | null;
  last_queue_result: string | null;
}

function etDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

export function formatSentinelReport(
  row: SentinelLedgerRow | null,
  nowIso: string,
): string {
  if (!row || !row.last_heartbeat) {
    return "*Ops sentinel:* no run recorded yet.";
  }
  const hbDay = etDay(row.last_heartbeat);
  if (hbDay !== etDay(nowIso)) {
    return `*Ops sentinel MISSED:* no run recorded today (last: ${hbDay}). The scheduled sentinel did not fire.`;
  }
  const verdict = (row.last_queue_result ?? "").trim();
  if (!verdict.startsWith("OE-SENTINEL ")) {
    return `*Ops sentinel:* ran today but left no OE-SENTINEL verdict line (got: "${verdict.slice(0, 80)}").`;
  }
  return `*Ops sentinel:* ${verdict}`;
}

// Board-hygiene reconciler, same ledger-verdict contract as the sentinel above:
// agent_task_ledger.last_queue_result for the reconciler lane starts with
// "OE-RECONCILE ".
//
// RETURNS NULL WHEN THE LANE IS NOT INSTALLED, and that is deliberate. A check
// that has never once passed is a bug in the check, not a finding: if this
// printed "no run recorded yet" every morning before the lane existed, it would
// be a permanent warning and the reader would learn to skip the line, which is
// exactly how a real miss later goes unnoticed. No ledger row means no line at
// all. Once the row exists, a missed run IS reported, because from then on the
// absence is real information.
export function formatReconcilerReport(
  row: SentinelLedgerRow | null,
  nowIso: string,
): string | null {
  if (!row) return null;
  if (!row.last_heartbeat) return null;
  const hbDay = etDay(row.last_heartbeat);
  if (hbDay !== etDay(nowIso)) {
    return `*Reconciled MISSED:* no run recorded today (last: ${hbDay}). The scheduled reconciler did not fire.`;
  }
  const verdict = (row.last_queue_result ?? "").trim();
  if (!verdict.startsWith("OE-RECONCILE ")) {
    return `*Reconciled:* ran today but left no OE-RECONCILE verdict line (got: "${
      verdict.slice(0, 80)
    }").`;
  }
  return `*Reconciled:* ${verdict.slice("OE-RECONCILE ".length)}`;
}
