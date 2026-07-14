import { assert, assertEquals } from "jsr:@std/assert";

const compilePagesSource = await Deno.readTextFile(
  new URL("../compile-pages/index.ts", import.meta.url),
);
const openBrainMcpSource = await Deno.readTextFile(
  new URL("../open-brain-mcp/index.ts", import.meta.url),
);

Deno.test("project page reads use the canonical project-thought RPC", () => {
  assertEquals(
    (compilePagesSource.match(/get_project_page_thoughts/g) ?? []).length,
    2,
  );
  assertEquals(
    (openBrainMcpSource.match(/get_project_page_thoughts/g) ?? []).length,
    1,
  );

  assert(!compilePagesSource.includes("{ project: page.title }"));
  assert(!openBrainMcpSource.includes("{ project: page.title }"));
});

Deno.test("compile-pages can target one stale page by slug", () => {
  assert(compilePagesSource.includes('url.searchParams.get("slug")'));
  assert(compilePagesSource.includes("page.slug === targetSlug"));
});

Deno.test("compile-pages leaves enough time for slow synthesis calls", () => {
  assert(compilePagesSource.includes("LLM_CALL_TIMEOUT_MS = 75_000"));
  assert(compilePagesSource.includes("RUN_BUDGET_MS = 70_000"));
});

Deno.test("scheduled compile runs avoid five simultaneous slow synthesis calls", () => {
  assert(compilePagesSource.includes("COMPILE_CONCURRENCY = 3"));
  assert(!compilePagesSource.includes("COMPILE_CONCURRENCY = 5"));
});

Deno.test("targeted maintenance runs can select the allowlisted fast model", () => {
  assert(compilePagesSource.includes('url.searchParams.get("model")'));
  assert(compilePagesSource.includes('"openai/gpt-4.1-mini"'));
  assert(compilePagesSource.includes("targetSlug ? requestedModel"));
});

Deno.test("targeted maintenance runs can raise the catch-up intake safely", () => {
  assert(compilePagesSource.includes('url.searchParams.get("intake")'));
  assert(compilePagesSource.includes("Math.min(requestedIntake, STEADY_THOUGHT_LIMIT)"));
});

Deno.test("targeted maintenance runs skip global page auto-creation", () => {
  assert(compilePagesSource.includes("targetSlug ? 0 : await autoCreatePages"));
});
