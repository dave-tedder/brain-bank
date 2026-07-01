import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const forbiddenSourceContracts = [
  {
    name: "direct OpenRouter endpoint literal",
    tokens: ["https:", "/", "/", "openrouter.ai"],
  },
  {
    name: "direct OpenRouter API key usage",
    tokens: ["OPENROUTER", "_", "API", "_", "KEY"],
  },
];

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

function hasAdjacentTokens(source: string, tokens: string[]): boolean {
  const firstToken = tokens[0];
  if (!firstToken) return false;

  let searchFrom = 0;
  while (searchFrom < source.length) {
    const start = source.indexOf(firstToken, searchFrom);
    if (start === -1) return false;

    let cursor = start + firstToken.length;
    let matched = true;
    for (const token of tokens.slice(1)) {
      if (source.slice(cursor, cursor + token.length) !== token) {
        matched = false;
        break;
      }
      cursor += token.length;
    }

    if (matched) return true;
    searchFrom = start + 1;
  }

  return false;
}

function assertNoDirectOpenRouterAccess(source: string, label: string) {
  for (const contract of forbiddenSourceContracts) {
    assertEquals(
      hasAdjacentTokens(source, contract.tokens),
      false,
      `${label} should not contain ${contract.name}`,
    );
  }
}

for (const target of captureFunctions) {
  Deno.test(`${target.slug} routes every OpenRouter call through the shared wrapper`, async () => {
    const source = await Deno.readTextFile(
      new URL(target.path, import.meta.url),
    );
    assertStringIncludes(
      source,
      'import { callOpenRouter } from "../_shared/openrouter.ts";',
    );
    assertStringIncludes(source, `const FUNCTION_SLUG = "${target.slug}";`);
    assertNoDirectOpenRouterAccess(source, target.slug);
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
  assertStringIncludes(
    source,
    "computeCost(FILTER_MODEL, inTokens, outTokens) ?? 0",
  );
  assertStringIncludes(
    source,
    "computeCost(CLASSIFY_MODEL, inTokens, outTokens) ?? 0",
  );
  assertNoDirectOpenRouterAccess(source, "classify-edges");
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
  assertStringIncludes(
    source,
    "model: options?.model || DEFAULT_COMPILE_MODEL",
  );
  assertNoDirectOpenRouterAccess(source, "compile-pages");
});

Deno.test("brain-digest labels daily and weekly synthesis separately", async () => {
  const source = await Deno.readTextFile(
    new URL("../supabase/functions/brain-digest/index.ts", import.meta.url),
  );
  assertStringIncludes(
    source,
    'import { callOpenRouter } from "../_shared/openrouter.ts";',
  );
  assertStringIncludes(source, 'const FUNCTION_SLUG = "brain-digest";');
  assertStringIncludes(
    source,
    'call_site: mode === "weekly" ? "digest_synth_weekly" : "digest_synth_daily"',
  );
  assertNoDirectOpenRouterAccess(source, "brain-digest");
});
