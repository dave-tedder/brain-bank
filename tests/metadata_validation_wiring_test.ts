import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const ingestSource = await Deno.readTextFile(
  new URL("../supabase/functions/ingest-thought/index.ts", import.meta.url),
);
const mcpSource = await Deno.readTextFile(
  new URL("../supabase/functions/open-brain-mcp/index.ts", import.meta.url),
);

Deno.test("Slack capture coerces extracted metadata before insert", () => {
  const start = ingestSource.indexOf("async function processCaptureMessage(");
  const end = ingestSource.indexOf("async function processCaptureThreadReply(");
  assert(start >= 0 && end > start);
  const block = ingestSource.slice(start, end);
  assertStringIncludes(block, "const knownSlugs = await loadKnownSlugs(supabase);");
  assertStringIncludes(block, "coerceMetadata(rawMetadata, knownSlugs, messageText)");
  assertStringIncludes(block, "metadata: finalMetadata");
  assertStringIncludes(block, "postCaptureHook(inserted.id, messageText, finalMetadata");
});

Deno.test("Slack thread capture extracts metadata from reply only", () => {
  const start = ingestSource.indexOf("async function processCaptureThreadReply(");
  const end = ingestSource.indexOf("async function handleQueryThreadReply(");
  assert(start >= 0 && end > start);
  const block = ingestSource.slice(start, end);
  assertStringIncludes(block, "getEmbedding(contextualText)");
  assertStringIncludes(block, "extractMetadata(replyText)");
  assertStringIncludes(block, "coerceMetadata(rawMetadata, knownSlugs, replyText)");
});

Deno.test("REST capture coerces metadata while preserving explicit tags", () => {
  const start = mcpSource.indexOf("async function handleRestCapture(");
  const end = mcpSource.indexOf("async function handleRestClient(");
  assert(start >= 0 && end > start);
  const block = mcpSource.slice(start, end);
  assertStringIncludes(block, "coerceMetadata(rawMetadata, knownSlugs, content)");
  assertStringIncludes(block, "[...extractedTopics, ...explicitTags]");
  assertStringIncludes(block, "postCaptureHook(inserted.id, content, finalMetadata");
});

Deno.test("both capture functions gate action-item storage", () => {
  assertStringIncludes(ingestSource, "if (!shouldExtractActionItems(metadata)) return;");
  assertStringIncludes(mcpSource, "if (!shouldExtractActionItems(metadata)) return;");
});
