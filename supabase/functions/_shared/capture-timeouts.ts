// Capture requests abort stalled provider calls before the runtime deadline.
// AbortController preserves AbortError so the shared wrapper logs a timeout.
export const EMBEDDING_TIMEOUT_MS = 20_000;
export const METADATA_TIMEOUT_MS = 45_000;

export async function withTimeout<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
