// Session token signing + verification for the dashboard auth cookie.
//
// The cookie holds `<random>.<sig>` where:
//   random = 32 bytes of getRandomValues output, hex-encoded (64 chars)
//   sig    = HMAC-SHA256(random, DASHBOARD_PASSWORD), hex-encoded (64 chars)
//
// A stolen cookie is no longer the literal password. The signature scheme
// makes forgery infeasible without knowing DASHBOARD_PASSWORD; rotating
// DASHBOARD_PASSWORD invalidates all existing sessions automatically (the
// recomputed signature stops matching). Verification runs through a
// constant-time comparison so the failure pattern doesn't leak signature
// position via response time.
//
// Edge-runtime safe: uses Web Crypto (crypto.subtle, crypto.getRandomValues),
// no Node-specific imports. Works in Next.js middleware (Edge runtime) and
// in the login Server Action (Node runtime) without changes.

const TOKEN_BYTES = 32;
const HEX_TOKEN_LEN = TOKEN_BYTES * 2; // 64
const HEX_SIG_LEN = 64;
const HEX_REGEX = /^[0-9a-f]+$/;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function signSessionToken(password: string): Promise<string> {
  const random = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(random);
  const tokenHex = bytesToHex(random);
  const sig = await hmacSha256Hex(password, tokenHex);
  return `${tokenHex}.${sig}`;
}

export async function verifySessionToken(
  cookieValue: string | undefined | null,
  password: string | undefined,
): Promise<boolean> {
  if (!password) return false;
  if (typeof cookieValue !== "string") return false;
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return false;
  const [tokenHex, providedSig] = parts;
  if (tokenHex.length !== HEX_TOKEN_LEN || providedSig.length !== HEX_SIG_LEN) return false;
  if (!HEX_REGEX.test(tokenHex) || !HEX_REGEX.test(providedSig)) return false;
  const expectedSig = await hmacSha256Hex(password, tokenHex);
  return constantTimeEqualHex(expectedSig, providedSig);
}
