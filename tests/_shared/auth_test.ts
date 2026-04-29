// Verifies the F#C17 cookie format: dashboard auth cookies are no longer the
// literal DASHBOARD_PASSWORD; they're `<random>.<sig>` where sig =
// HMAC-SHA256(random, password).
//
// This pins the cookie format invariant so a future edit can't silently
// regress to "cookie value IS the password" (the F#C17 finding).

import { assert, assertEquals } from "https://deno.land/std@0.220.0/assert/mod.ts";
import {
  signSessionToken,
  verifySessionToken,
} from "../../dashboard/src/lib/auth.ts";

const PASSWORD = "test-password-fc17";
const COOKIE_FORMAT = /^[0-9a-f]{64}\.[0-9a-f]{64}$/;

Deno.test("signSessionToken returns <64-hex>.<64-hex>", async () => {
  const token = await signSessionToken(PASSWORD);
  assert(COOKIE_FORMAT.test(token), `cookie format mismatch: ${token}`);
});

Deno.test("signSessionToken output is not the literal password", async () => {
  const token = await signSessionToken(PASSWORD);
  assert(!token.includes(PASSWORD), "cookie value contains the password");
  assert(token !== PASSWORD, "cookie value equals the password");
});

Deno.test("signSessionToken returns a different value each call (random)", async () => {
  const a = await signSessionToken(PASSWORD);
  const b = await signSessionToken(PASSWORD);
  assert(a !== b, "consecutive signSessionToken calls returned the same value");
});

Deno.test("verifySessionToken accepts a freshly signed token", async () => {
  const token = await signSessionToken(PASSWORD);
  assertEquals(await verifySessionToken(token, PASSWORD), true);
});

Deno.test("verifySessionToken rejects a token signed under a different password", async () => {
  const token = await signSessionToken(PASSWORD);
  assertEquals(await verifySessionToken(token, "wrong-password"), false);
});

Deno.test("verifySessionToken rejects the legacy literal-password format", async () => {
  // The pre-F#C17 cookie was just the password as the cookie value. Confirm
  // any old session cookie sitting in a browser fails the new check and
  // forces a relogin.
  assertEquals(await verifySessionToken(PASSWORD, PASSWORD), false);
});

Deno.test("verifySessionToken rejects tampered signature", async () => {
  const token = await signSessionToken(PASSWORD);
  const [random] = token.split(".");
  const tampered = `${random}.${"f".repeat(64)}`;
  assertEquals(await verifySessionToken(tampered, PASSWORD), false);
});

Deno.test("verifySessionToken rejects empty / undefined / wrong-shape inputs", async () => {
  assertEquals(await verifySessionToken("", PASSWORD), false);
  assertEquals(await verifySessionToken(undefined, PASSWORD), false);
  assertEquals(await verifySessionToken(null, PASSWORD), false);
  assertEquals(await verifySessionToken("no-dot", PASSWORD), false);
  assertEquals(await verifySessionToken("a.b.c", PASSWORD), false);
  assertEquals(await verifySessionToken("zzz.zzz", PASSWORD), false); // non-hex
});

Deno.test("verifySessionToken returns false when password is undefined", async () => {
  const token = await signSessionToken(PASSWORD);
  assertEquals(await verifySessionToken(token, undefined), false);
});
