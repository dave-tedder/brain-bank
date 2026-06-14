import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const paths = [
  "../supabase/functions/ingest-thought/index.ts",
  "../supabase/functions/open-brain-mcp/index.ts",
];

for (const path of paths) {
  Deno.test(`${path} scopes auto-resolve through the candidate RPC`, async () => {
    const source = await Deno.readTextFile(new URL(path, import.meta.url));
    const start = source.indexOf("async function checkAutoResolve(");
    const end = source.indexOf("async function postCaptureHook(");
    assert(start >= 0 && end > start);
    const block = source.slice(start, end);

    assertStringIncludes(block, 'supabase.rpc("find_candidate_action_items"');
    assertStringIncludes(block, "p_project: newProject");
    assertStringIncludes(block, "p_topics: newTopics");
    assertStringIncludes(block, "p_people: newPeople");
    assertStringIncludes(block, "p_exclude_source_ids: excludeSourceThoughtIds");
    assertEquals(block.includes(".limit(100)"), false);
  });
}
