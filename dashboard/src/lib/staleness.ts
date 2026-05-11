// Audit Finding 16: standardize stale thresholds across the dashboard
// wiki surfaces. Index pages stale at 2 days (they refresh daily via
// compile-pages-index-daily cron); entity pages stale at 30 days
// (matches compile-pages runLint threshold).

export const STALE_THRESHOLD_DAYS = {
  index: 2,
  client: 30,
  topic: 30,
  project: 30,
} as const;

export function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.floor(ms / 86400000);
}

export function stalenessFor(
  pageType: string,
  lastCompiled: string | null,
): { isStale: boolean; daysOld: number | null; threshold: number } {
  const threshold =
    STALE_THRESHOLD_DAYS[pageType as keyof typeof STALE_THRESHOLD_DAYS] ?? 30;
  const daysOld = daysSince(lastCompiled);
  const isStale = daysOld !== null && daysOld > threshold;
  return { isStale, daysOld, threshold };
}
