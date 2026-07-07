// Login hardening helpers (plain JS so tests/login-security.test.mjs can run
// them under node --test, same pattern as agent-task-intake.js).
//
// Scope note: the rate limiter is module-level in-memory state. The dashboard
// runs as a single standalone instance, so this bounds shared-password
// guessing there; a multi-instance deploy would need a shared store instead.

export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const failures = new Map(); // key -> { count, resetAt }

export function _resetLoginRateLimitForTests() {
  failures.clear();
}

function pruneExpired(now) {
  for (const [key, entry] of failures) {
    if (entry.resetAt <= now) failures.delete(key);
  }
}

// Returns { allowed, retryAfterMs }. Does not itself record an attempt —
// call recordFailedLogin() after a failed password check.
export function checkLoginRateLimit(key, now = Date.now()) {
  pruneExpired(now);
  const entry = failures.get(key);
  if (!entry || entry.count < LOGIN_MAX_ATTEMPTS) {
    return { allowed: true, retryAfterMs: 0 };
  }
  return { allowed: false, retryAfterMs: Math.max(1, entry.resetAt - now) };
}

export function recordFailedLogin(key, now = Date.now()) {
  const entry = failures.get(key);
  if (!entry || entry.resetAt <= now) {
    failures.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

export function clearLoginFailures(key) {
  failures.delete(key);
}

// Constant-time string comparison for the login form's password check (the
// cookie path in auth.ts already compares signatures constant-time). No early
// exit on length mismatch: the loop always walks the caller-supplied input.
export function constantTimeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const same = a.length === b.length;
  const other = same ? b : a;
  let diff = same ? 0 : 1;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ other.charCodeAt(i);
  }
  return diff === 0;
}
