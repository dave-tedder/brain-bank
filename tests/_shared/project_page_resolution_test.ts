import { assert, assertEquals } from "jsr:@std/assert";

const compilePagesSource = await Deno.readTextFile(
  new URL("../../supabase/functions/compile-pages/index.ts", import.meta.url),
);
const mcpSource = await Deno.readTextFile(
  new URL("../../supabase/functions/open-brain-mcp/index.ts", import.meta.url),
);

Deno.test("project page reads use the canonical project-thought RPC", () => {
  assertEquals(
    (compilePagesSource.match(/get_project_page_thoughts/g) ?? []).length,
    2,
  );
  assertEquals(
    (mcpSource.match(/get_project_page_thoughts/g) ?? []).length,
    1,
  );
  assert(!compilePagesSource.includes("{ project: page.title }"));
  assert(!mcpSource.includes("{ project: page.title }"));
});

Deno.test("targeted maintenance runs stay bounded and isolated", () => {
  assert(compilePagesSource.includes('url.searchParams.get("slug")'));
  assert(compilePagesSource.includes("page.slug === targetSlug"));
  assert(compilePagesSource.includes('"openai/gpt-4.1-mini"'));
  assert(compilePagesSource.includes("Math.min(requestedIntake, STEADY_THOUGHT_LIMIT)"));
  assert(compilePagesSource.includes("targetSlug ? 0 : await autoCreatePages"));
});
