import assert from "node:assert/strict";
import test from "node:test";

import {
  _resetLoginRateLimitForTests,
  checkLoginRateLimit,
  clearLoginFailures,
  constantTimeEqualStr,
  LOGIN_MAX_ATTEMPTS,
  recordFailedLogin,
} from "../src/lib/login-security.js";

test("constantTimeEqualStr: equal strings match", () => {
  assert.equal(constantTimeEqualStr("hunter2", "hunter2"), true);
});

test("constantTimeEqualStr: same-length difference rejects", () => {
  assert.equal(constantTimeEqualStr("hunter2", "hunter3"), false);
});

test("constantTimeEqualStr: different lengths reject", () => {
  assert.equal(constantTimeEqualStr("hunter2", "hunter22"), false);
  assert.equal(constantTimeEqualStr("", "x"), false);
});

test("constantTimeEqualStr: non-string inputs reject", () => {
  assert.equal(constantTimeEqualStr(null, "x"), false);
  assert.equal(constantTimeEqualStr(undefined, undefined), false);
});

test("rate limit: allows up to LOGIN_MAX_ATTEMPTS failures, then blocks", () => {
  _resetLoginRateLimitForTests();
  const now = 1_000_000;
  for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
    assert.equal(checkLoginRateLimit("1.2.3.4", now).allowed, true);
    recordFailedLogin("1.2.3.4", now);
  }
  const blocked = checkLoginRateLimit("1.2.3.4", now);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
});

test("rate limit: window expiry re-allows", () => {
  _resetLoginRateLimitForTests();
  const now = 1_000_000;
  for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) recordFailedLogin("1.2.3.4", now);
  assert.equal(checkLoginRateLimit("1.2.3.4", now).allowed, false);
  const later = now + 16 * 60 * 1000;
  assert.equal(checkLoginRateLimit("1.2.3.4", later).allowed, true);
});

test("rate limit: keys are independent", () => {
  _resetLoginRateLimitForTests();
  const now = 1_000_000;
  for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) recordFailedLogin("1.2.3.4", now);
  assert.equal(checkLoginRateLimit("1.2.3.4", now).allowed, false);
  assert.equal(checkLoginRateLimit("5.6.7.8", now).allowed, true);
});

test("rate limit: success clears failures", () => {
  _resetLoginRateLimitForTests();
  const now = 1_000_000;
  for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) recordFailedLogin("1.2.3.4", now);
  clearLoginFailures("1.2.3.4");
  assert.equal(checkLoginRateLimit("1.2.3.4", now).allowed, true);
});
