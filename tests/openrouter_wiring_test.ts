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
