import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { FakeTime } from "jsr:@std/testing@1.0.17/time";
import {
  EMBEDDING_TIMEOUT_MS,
  METADATA_TIMEOUT_MS,
  withTimeout,
} from "./capture-timeouts.ts";
import {
  callOpenRouter,
  type OpenRouterAuditRow,
  type OpenRouterDependencies,
} from "./openrouter.ts";

for (
  const [callSite, ceiling, expectedMs] of [
    ["getEmbedding", EMBEDDING_TIMEOUT_MS, 20_000],
    ["extractMetadata", METADATA_TIMEOUT_MS, 45_000],
  ] as const
) {
  Deno.test(`${callSite}: a stalled request aborts at ${expectedMs}ms and logs timeout`, async () => {
    using time = new FakeTime();
    const rows: OpenRouterAuditRow[] = [];
    const scheduled: Promise<unknown>[] = [];
    let settled = false;
    let requestSignal: AbortSignal | null | undefined;
    const deps: OpenRouterDependencies = {
      // Unlike an immediate AbortError fixture, this fetch stays pending until
      // the production timer aborts the actual signal passed by callOpenRouter.
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          requestSignal = init?.signal;
          requestSignal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          }, { once: true });
        }),
      now: Date.now,
      apiKey: "test-only",
      insertAudit: async (row) => {
        rows.push(row);
      },
      waitUntil: (p) => {
        scheduled.push(Promise.resolve(p));
      },
    };
    const result = withTimeout(ceiling, (signal) =>
      callOpenRouter({
        function_slug: "capture-timeout-test",
        call_site: callSite,
        model: callSite === "getEmbedding"
          ? "openai/text-embedding-3-small"
          : "openai/gpt-4o-mini",
        endpoint: callSite === "getEmbedding"
          ? "embeddings"
          : "chat/completions",
        signal,
      }, deps));
    // Attach rejection handling before advancing the virtual clock.
    const rejected = assertRejects(() => result, DOMException, "aborted");
    void result.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });

    await time.tickAsync(expectedMs - 1);
    assertEquals(
      settled,
      false,
      "request must remain pending before its ceiling",
    );
    await time.tickAsync(1);
    assertEquals(
      requestSignal?.aborted,
      true,
      "request must abort at its ceiling",
    );
    await rejected;
    await Promise.all(scheduled);
    assertEquals(
      rows.map(({ status, latency_ms }) => ({ status, latency_ms })),
      [
        { status: "timeout", latency_ms: expectedMs },
      ],
    );
  });
}

Deno.test("successful requests clear the timeout without aborting later", async () => {
  using time = new FakeTime();
  let requestSignal: AbortSignal | undefined;
  const result = await withTimeout(20_000, (signal) => {
    requestSignal = signal;
    return Promise.resolve("captured");
  });
  assertEquals(result, "captured");
  await time.tickAsync(45_000);
  assertEquals(requestSignal?.aborted, false);
});
