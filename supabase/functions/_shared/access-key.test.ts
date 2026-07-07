// Deno unit tests for the shared access-key helpers.
// Run: deno test supabase/functions/_shared/access-key.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { timingSafeEqualStr } from "./access-key.ts";

Deno.test("timingSafeEqualStr: equal strings match", () => {
  assertEquals(timingSafeEqualStr("abc123", "abc123"), true);
});

Deno.test("timingSafeEqualStr: same-length difference rejects", () => {
  assertEquals(timingSafeEqualStr("abc123", "abc124"), false);
});

Deno.test("timingSafeEqualStr: different lengths reject", () => {
  assertEquals(timingSafeEqualStr("abc", "abc123"), false);
  assertEquals(timingSafeEqualStr("abc123", "abc"), false);
});

Deno.test("timingSafeEqualStr: empty vs non-empty rejects", () => {
  assertEquals(timingSafeEqualStr("", "x"), false);
  assertEquals(timingSafeEqualStr("x", ""), false);
});

Deno.test("timingSafeEqualStr: both empty match", () => {
  assertEquals(timingSafeEqualStr("", ""), true);
});

Deno.test("timingSafeEqualStr: multibyte content compares byte-wise", () => {
  assertEquals(timingSafeEqualStr("käy™", "käy™"), true);
  assertEquals(timingSafeEqualStr("käy™", "käy!"), false);
});
