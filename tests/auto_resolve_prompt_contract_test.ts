import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const functionPaths = [
  "../supabase/functions/ingest-thought/index.ts",
  "../supabase/functions/open-brain-mcp/index.ts",
];

function extractPromptContract(source: string): string {
  const start = source.indexOf("HARD RULES — a match requires ALL of these:");
  const endMarker = "If you cannot produce such a quote, do not include the match.";
  const end = source.indexOf(endMarker, start);

  if (start < 0 || end < 0) {
    throw new Error("Auto-resolve prompt contract block not found");
  }

  return source.slice(start, end + endMarker.length);
}

Deno.test("mirrored auto-resolve prompts share the Session 146 contract", async () => {
  const prompts = await Promise.all(functionPaths.map(async (path) => {
    const source = await Deno.readTextFile(new URL(path, import.meta.url));
    return extractPromptContract(source);
  }));

  assertEquals(prompts[0], prompts[1]);
  assertStringIncludes(prompts[0], "STILL-TO-DO SIGNALS NEVER resolve anything");
  assertStringIncludes(prompts[0], '"remaining", "outstanding", "to-do", "todo"');
  assertStringIncludes(prompts[0], '"yet to", "still to", "still need", "next"');
  assertStringIncludes(prompts[0], '"follows", "to follow"');
  assertStringIncludes(prompts[0], "work that is still owed");
});

Deno.test("sanitized harness snapshots the prompt and FP #4 case", async () => {
  const harness = await Deno.readTextFile(
    new URL("../scripts/auto-resolve-ab-test/run.mjs", import.meta.url),
  );

  assertStringIncludes(harness, "STILL-TO-DO SIGNALS NEVER resolve anything");
  assertStringIncludes(harness, "FP #4 — still-to-do marker");
  assertStringIncludes(harness, "Remaining: email sender blocklist cleanup");
  assertEquals(harness.includes("dvsvzlwxhmqwhmknwmdr"), false);
  assertEquals(harness.includes("A2/A3"), false);
});

Deno.test("mirrored capture functions share the LAYER 3.5 call block", async () => {
  const sources = await Promise.all(functionPaths.map((path) =>
    Deno.readTextFile(new URL(path, import.meta.url))
  ));
  const startMarker = "const stillOwed = stillOwedAdjacencyVeto(";
  const endMarker = "      continue;\n    }";
  const blocks = sources.map((source) => {
    assertStringIncludes(source, 'import { stillOwedAdjacencyVeto } from "../_shared/still-owed-veto.ts";');
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    if (start < 0 || end < 0) throw new Error("LAYER 3.5 call block not found");
    return source.slice(start, end + endMarker.length);
  });

  assertEquals(blocks[0], blocks[1]);
  assertStringIncludes(blocks[0], "newThoughtContent, item.description, stem");
  assertStringIncludes(blocks[0], "LAYER 3.5 still-owed veto dropped item");
});

Deno.test("mirrored LAYER 2 uses Sonnet and fail-closed fenced JSON parsing", async () => {
  const sources = await Promise.all(functionPaths.map((path) =>
    Deno.readTextFile(new URL(path, import.meta.url))
  ));
  const models = sources.map((source) => {
    assertStringIncludes(source, 'import { extractJsonObject } from "../_shared/extract-json.ts";');
    assertStringIncludes(source, "JSON.parse(extractJsonObject(d.choices[0].message.content))");
    assertStringIncludes(source, "checkAutoResolve: LAYER 2 JSON parse failed:");
    const checkStart = source.indexOf("async function checkAutoResolve(");
    const modelMatch = source.slice(checkStart).match(/model: "([^"]+)"/);
    if (!modelMatch) throw new Error("LAYER 2 model not found");
    return modelMatch[1];
  });

  assertEquals(models, ["anthropic/claude-sonnet-4.6", "anthropic/claude-sonnet-4.6"]);
});
