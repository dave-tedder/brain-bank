export interface CompilePagesRun {
  created_at: string;
  mode: string;
  index_mode: string | null;
  batch: number | null;
  compiled: number | null;
  errors: number | null;
  status: string;
  error_message: string | null;
}

const STALE_AFTER_MS = 26 * 60 * 60 * 1000;

export function getCompileRunHealthWarning(
  runs: CompilePagesRun[],
  nowMs = Date.now(),
): string | null {
  const latest = runs
    .filter((run) =>
      run.mode === "compile" && run.batch === 10 && run.index_mode === "auto"
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];

  if (!latest) {
    return "*Wiki compile unavailable:* no recent full compile run was recorded.";
  }

  if (latest.status !== "complete") {
    const detail = latest.error_message ? ` ${latest.error_message}` : "";
    return `*Wiki compile failed:* latest full run ended with status ${latest.status}.${detail}`;
  }

  const errors = latest.errors ?? 0;
  if (errors > 0) {
    return `*Wiki compile degraded:* ${errors} page${errors === 1 ? "" : "s"} failed; ${latest.compiled ?? 0} updated.`;
  }

  const ageMs = nowMs - Date.parse(latest.created_at);
  if (!Number.isFinite(ageMs) || ageMs > STALE_AFTER_MS) {
    const ageHours = Number.isFinite(ageMs)
      ? Math.floor(ageMs / (60 * 60 * 1000))
      : "unknown";
    return `*Wiki compile stale:* latest full run is ${ageHours} hours old.`;
  }

  return null;
}
