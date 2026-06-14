import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  callOpenRouter,
  computeCost,
  type OpenRouterAuditRow,
  type OpenRouterDependencies,
} from "./openrouter.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function harness(response: Response | (() => Promise<Response>)) {
  const rows: OpenRouterAuditRow[] = [];
  const scheduled: Promise<unknown>[] = [];
  let now = 1_000;
  const deps: OpenRouterDependencies = {
    fetch: typeof response === "function" ? response : async () => response,
    now: () => {
      now += 25;
      return now;
    },
    insertAudit: async (row) => {
      rows.push(row);
    },
    waitUntil: (promise) => scheduled.push(Promise.resolve(promise)),
    apiKey: "test-secret-key",
  };
  return { deps, rows, scheduled };
}

async function flush(scheduled: Promise<unknown>[]): Promise<void> {
  await Promise.all(scheduled);
}

Deno.test("computeCost covers chat, embedding, and unknown models", () => {
  assertEquals(computeCost("openai/gpt-4o-mini", 1_000_000, 1_000_000), 0.75);
  assertEquals(computeCost("openai/gpt-4.1-mini", 500_000, 250_000), 0.6);
  assertEquals(computeCost("anthropic/claude-sonnet-4.6", 1000, 200), 0.006);
  assertEquals(computeCost("openai/text-embedding-3-small", 1_000_000, 0), 0.02);
  assertEquals(computeCost("unknown/model", 100, 50), null);
});

Deno.test("successful call returns provider data and schedules sanitized telemetry", async () => {
  const providerData = {
    choices: [{ message: { content: "private response" } }],
    usage: { prompt_tokens: 120, completion_tokens: 30 },
  };
  const h = harness(jsonResponse(providerData));

  const result = await callOpenRouter({
    function_slug: "ingest-thought",
    call_site: "extractMetadata",
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: "private prompt" }],
  }, h.deps);

  assertEquals(result.data, providerData);
  assertEquals(result.prompt_tokens, 120);
  assertEquals(result.completion_tokens, 30);
  assertEquals(result.cost_usd, 0.000036);
  assertEquals(h.scheduled.length, 1);
  await flush(h.scheduled);
  assertEquals(h.rows, [{
    function_slug: "ingest-thought",
    call_site: "extractMetadata",
    model: "openai/gpt-4o-mini",
    prompt_tokens: 120,
    completion_tokens: 30,
    cost_usd: 0.000036,
    latency_ms: 25,
    status: "ok",
    error_message: null,
  }]);
  const serialized = JSON.stringify(h.rows[0]);
  assertEquals(serialized.includes("private prompt"), false);
  assertEquals(serialized.includes("private response"), false);
  assertEquals(serialized.includes("test-secret-key"), false);
});

Deno.test("budget-limit 403 is classified separately and still throws", async () => {
  const h = harness(new Response("Budget limit exceeded for this key", { status: 403 }));

  await assertRejects(
    () => callOpenRouter({
      function_slug: "brain-digest",
      call_site: "digest_synth_daily",
      model: "anthropic/claude-sonnet-4.6",
      messages: [{ role: "user", content: "secret" }],
    }, h.deps),
    Error,
    "OpenRouter anthropic/claude-sonnet-4.6 403",
  );
  await flush(h.scheduled);
  assertEquals(h.rows[0].status, "budget_exceeded");
  assertEquals(h.rows[0].error_message, "Budget limit exceeded for this key");
});

Deno.test("generic provider errors classify 4xx and 5xx", async () => {
  for (const [httpStatus, expected] of [[429, "error_4xx"], [503, "error_5xx"]] as const) {
    const h = harness(new Response("provider unavailable", { status: httpStatus }));
    await assertRejects(() => callOpenRouter({
      function_slug: "compile-pages",
      call_site: "compile_index",
      model: "openai/gpt-4.1-mini",
      messages: [],
    }, h.deps));
    await flush(h.scheduled);
    assertEquals(h.rows[0].status, expected);
  }
});

Deno.test("abort schedules timeout telemetry and still throws", async () => {
  const h = harness(async () => {
    throw new DOMException("The operation was aborted", "AbortError");
  });

  await assertRejects(() => callOpenRouter({
    function_slug: "compile-pages",
    call_site: "compile_entity_page",
    model: "openai/gpt-4.1-mini",
    messages: [],
  }, h.deps), DOMException, "aborted");
  await flush(h.scheduled);
  assertEquals(h.rows[0].status, "timeout");
});

Deno.test("audit insertion failure does not alter a successful result", async () => {
  const h = harness(jsonResponse({
    data: [{ embedding: [0.1, 0.2] }],
    usage: { prompt_tokens: 2 },
  }));
  h.deps.insertAudit = async (row) => {
    h.rows.push(row);
    throw new Error("audit unavailable");
  };

  const result = await callOpenRouter({
    function_slug: "open-brain-mcp",
    call_site: "getEmbedding",
    model: "openai/text-embedding-3-small",
    endpoint: "embeddings",
    input: "private embedding input",
  }, h.deps);

  assertEquals(result.data.data?.[0].embedding, [0.1, 0.2]);
  await flush(h.scheduled);
  assertEquals(JSON.stringify(h.rows[0]).includes("private embedding input"), false);
});
