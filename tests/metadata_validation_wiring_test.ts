import {
  assert,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";

const ingestSource = await Deno.readTextFile(
  new URL("../supabase/functions/ingest-thought/index.ts", import.meta.url),
);
const mcpSource = await Deno.readTextFile(
  new URL("../supabase/functions/open-brain-mcp/index.ts", import.meta.url),
);
// extractAndStoreActionItems lives here since the capture pipeline moved out of
// open-brain-mcp; open-brain-mcp and external-crm-sync both call it.
const pipelineSource = await Deno.readTextFile(
  new URL("../supabase/functions/_shared/capture-pipeline.ts", import.meta.url),
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
  // The gate is split so the work-report marker can override the descriptive
  // type and nothing else: excluded source first, then the work-report branch,
  // then the descriptive-type gate for everything else.
  for (const source of [ingestSource, pipelineSource]) {
    assertStringIncludes(source, "if (isExcludedSource(metadata)) return;");
    assertStringIncludes(source, "if (isWorkReportCapture(content)) {");
    assertStringIncludes(source, "items = extractOperatorLines(content);");
    assertStringIncludes(source, "if (isDescriptiveType(metadata)) return;");
    assert(
      source.indexOf("if (isExcludedSource(metadata)) return;") <
        source.indexOf("if (isWorkReportCapture(content)) {"),
      "excluded source must be checked before the work-report marker",
    );
  }
  assertStringIncludes(mcpSource, "sharedExtractAndStoreActionItems(");
});
