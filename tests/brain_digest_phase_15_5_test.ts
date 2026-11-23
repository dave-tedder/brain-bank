import { assert, assertEquals } from "jsr:@std/assert@1.0.19";

const source = await Deno.readTextFile(
  new URL("../supabase/functions/brain-digest/index.ts", import.meta.url),
);

Deno.test("digest caps actions and excludes Gmail deadlines", () => {
  // Open items are read in full (bounded) with their triage review, and the
  // checklist (action-checklist.ts) picks its 40 slots. If the review columns
  // cannot be read, the fallback is the newest 40, still with an exact total.
  assert(source.includes("const OPEN_ACTION_READ_MAX = 1000"));
  assert(source.includes(".limit(OPEN_ACTION_READ_MAX)"));
  assert(source.includes("const LEGACY_ACTION_ITEM_CAP = 40"));
  assert(
    source.includes(
      '.select("id, description, created_at", { count: "exact" })',
    ),
  );
  assert(source.includes('.order("created_at", { ascending: false })'));
  assert(source.includes(".limit(LEGACY_ACTION_ITEM_CAP)"));
  // The capped list reports the true total through the structured count line.
  assert(source.includes("Open action item count: ${openActionTotal}"));
  assert(source.includes('.neq("metadata->>source", "gmail")'));
});

Deno.test("weekly self-capture stays removed", () => {
  assert(!source.includes("[Weekly Review] ${digest}"));
  assert(!source.includes("Self-capture failed:"));
});

Deno.test("Slack truthfulness and compile-health warning stay wired", () => {
  assert(source.includes("const slackResult = await postToSlack"));
  assert(source.includes('status: slackResult.ok ? "delivered" : "delivery_failed"'));
  assert(source.includes("compile_health_warning: compileHealthWarning"));
  assertEquals((source.match(/loadCompileHealthWarning\(\)/g) ?? []).length, 2);
});
