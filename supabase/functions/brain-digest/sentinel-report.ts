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
