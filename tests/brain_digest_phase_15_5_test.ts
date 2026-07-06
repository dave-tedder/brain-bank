import { assert, assertEquals } from "jsr:@std/assert";

const source = await Deno.readTextFile(
  new URL("../supabase/functions/brain-digest/index.ts", import.meta.url),
);

Deno.test("digest caps actions and excludes Gmail deadlines", () => {
  assert(source.includes("const ACTION_ITEM_DIGEST_CAP = 40"));
  assert(
    source.includes(
      '.select("id, description, created_at", { count: "exact" })',
    ),
  );
  assert(source.includes('.order("created_at", { ascending: false })'));
  assert(source.includes(".limit(ACTION_ITEM_DIGEST_CAP)"));
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
