import {
  assert,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";

Deno.test("done command maps LLM matches to the filtered candidate list", async () => {
  const source = await Deno.readTextFile(
    new URL("../supabase/functions/ingest-thought/index.ts", import.meta.url),
  );
  const start = source.indexOf("async function handleDoneCommand(");
  const end = source.indexOf("// --- Capture Processing ---");
  assert(start >= 0 && end > start);
  const block = source.slice(start, end);

  assertStringIncludes(block, '.order("created_at", { ascending: false })');
  assertStringIncludes(block, "filterCandidatesForDone(doneText, openItems, 200)");
  assertStringIncludes(block, "const itemList = filteredItems");
  assertStringIncludes(block, "idx < filteredItems.length");
  assertStringIncludes(block, "const item = filteredItems[idx]");
});
