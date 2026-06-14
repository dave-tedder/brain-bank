import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const captureFunctions = [
  {
    path: "../supabase/functions/ingest-thought/index.ts",
    slug: "ingest-thought",
    labels: [
      "getEmbedding",
      "extractMetadata",
      "synthesizeContextualQuery",
      "synthesizeAnswer",
      "checkAutoResolve",
      "handleDoneCommand",
    ],
  },
  {
    path: "../supabase/functions/open-brain-mcp/index.ts",
    slug: "open-brain-mcp",
    labels: ["getEmbedding", "extractMetadata", "checkAutoResolve"],
  },
];

for (const target of captureFunctions) {
  Deno.test(`${target.slug} routes every OpenRouter call through the shared wrapper`, async () => {
    const source = await Deno.readTextFile(new URL(target.path, import.meta.url));
    assertStringIncludes(
      source,
      'import { callOpenRouter } from "../_shared/openrouter.ts";',
    );
    assertStringIncludes(source, `const FUNCTION_SLUG = "${target.slug}";`);
    assertEquals(source.includes("https://openrouter.ai"), false);
    assertEquals(source.includes("OPENROUTER_API_KEY"), false);
    for (const label of target.labels) {
      assertStringIncludes(source, `call_site: "${label}"`);
    }
  });
}

Deno.test("classify-edges keeps capped budget math while adding both telemetry stages", async () => {
  const source = await Deno.readTextFile(
    new URL("../supabase/functions/classify-edges/index.ts", import.meta.url),
  );
  assertStringIncludes(
    source,
    'import { callOpenRouter, computeCost } from "../_shared/openrouter.ts";',
  );
  assertStringIncludes(source, 'const FUNCTION_SLUG = "classify-edges";');
  assertStringIncludes(source, 'callSite: "filter_pair" | "classify_pair"');
  assertStringIncludes(source, '"filter_pair"');
  assertStringIncludes(source, '"classify_pair"');
  assertStringIncludes(source, "computeCost(FILTER_MODEL, 500, 128) ?? 0");
  assertStringIncludes(source, "computeCost(CLASSIFY_MODEL, 800, 512) ?? 0");
  assertStringIncludes(source, "computeCost(FILTER_MODEL, inTokens, outTokens) ?? 0");
  assertStringIncludes(source, "computeCost(CLASSIFY_MODEL, inTokens, outTokens) ?? 0");
  assertEquals(source.includes("https://openrouter.ai"), false);
  assertEquals(source.includes("OPENROUTER_API_KEY"), false);
});

Deno.test("compile-pages preserves abort timeout and exposes three telemetry labels", async () => {
  const source = await Deno.readTextFile(
    new URL("../supabase/functions/compile-pages/index.ts", import.meta.url),
  );
  assertStringIncludes(
    source,
    'import { callOpenRouter } from "../_shared/openrouter.ts";',
  );
  assertStringIncludes(source, 'const FUNCTION_SLUG = "compile-pages";');
  assertStringIncludes(source, "callSite: string");
  assertStringIncludes(source, "signal: controller.signal");
  assertStringIncludes(source, 'llmCall("compile_index"');
  assertStringIncludes(source, 'llmCall("compile_entity_page"');
  assertStringIncludes(source, '"lint_crossref_check"');
  assertStringIncludes(source, "model: options?.model || DEFAULT_COMPILE_MODEL");
  assertEquals(source.includes("https://openrouter.ai"), false);
  assertEquals(source.includes("OPENROUTER_API_KEY"), false);
});
