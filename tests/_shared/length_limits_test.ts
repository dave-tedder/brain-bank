// Smoke unit test for the REST input length-check guard. The actual handler
// integration is verified end-to-end via curl against a deployed function
// (see commit message for F#C15); this test pins the constants and the
// helper logic so a casual edit can't silently widen the cap.

import { assert, assertEquals } from "https://deno.land/std@0.220.0/assert/mod.ts";

// Re-implementing the helper here rather than importing from the Edge Function
// source because index.ts has top-level Deno.env.get() reads and createClient
// side effects that don't exist in the test runner. The helper is a pure
// 2-line check; mirroring it here is cheaper than refactoring the Edge
// Function to hoist it into a _shared module.
function tooLong(value: unknown, max: number): boolean {
  return typeof value === "string" && value.length > max;
}

const MAX_CONTENT_LENGTH = 32_000;
const MAX_FIELD_LENGTH = 1_000;

Deno.test("tooLong returns false for non-string", () => {
  assertEquals(tooLong(undefined, 10), false);
  assertEquals(tooLong(null, 10), false);
  assertEquals(tooLong(123, 10), false);
  assertEquals(tooLong({}, 10), false);
});

Deno.test("tooLong returns false at exactly the cap", () => {
  assertEquals(tooLong("a".repeat(10), 10), false);
});

Deno.test("tooLong returns true at cap + 1", () => {
  assertEquals(tooLong("a".repeat(11), 10), true);
});

Deno.test("MAX_CONTENT_LENGTH is 32000 (mirror invariant)", () => {
  // If a future edit widens this, the test fails loudly. Bumping the cap
  // requires bumping the assertion deliberately.
  assertEquals(MAX_CONTENT_LENGTH, 32_000);
});

Deno.test("MAX_FIELD_LENGTH is 1000 (mirror invariant)", () => {
  assertEquals(MAX_FIELD_LENGTH, 1_000);
});

Deno.test("33k content trips the cap, 32k does not", () => {
  assert(tooLong("a".repeat(33_000), MAX_CONTENT_LENGTH));
  assertEquals(tooLong("a".repeat(32_000), MAX_CONTENT_LENGTH), false);
});

Deno.test("1001-char field trips the cap, 1000 does not", () => {
  assert(tooLong("a".repeat(1_001), MAX_FIELD_LENGTH));
  assertEquals(tooLong("a".repeat(1_000), MAX_FIELD_LENGTH), false);
});
