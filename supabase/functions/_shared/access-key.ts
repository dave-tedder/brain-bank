// Shared access-key helpers.
//
// Single home for credential-compare logic used by the Edge Functions:
// the MCP/REST x-brain-key gates and Slack signature verification.

export type AccessKeySource = "x-brain-key" | "bearer";

export interface AccessKeyAuthResult {
  ok: boolean;
  source: AccessKeySource | null;
}

interface AuthenticateAccessKeyOptions {
  allowBearer?: boolean;
}

function configuredKeys(): string[] {
  return [Deno.env.get("MCP_ACCESS_KEY") || ""].filter(Boolean);
}

// Constant-time string comparison. Compares byte-wise with no early exit;
// on a length mismatch it still walks the full candidate so loop cost tracks
// the attacker-supplied input, not the secret. Largely theoretical over
// HTTPS, but cheap to do right.
export function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const same = ab.length === bb.length;
  // When lengths differ, compare `ab` against itself to keep timing flat and
  // force a non-zero diff.
  const other = same ? bb : ab;
  let diff = same ? 0 : 1;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ other[i];
  return diff === 0;
}

export function authenticateAccessKey(
  headers: Headers,
  options: AuthenticateAccessKeyOptions = {},
): AccessKeyAuthResult {
  const allowBearer = options.allowBearer ?? true;
  const authHeader = headers.get("authorization") || "";
  const bearerKey = allowBearer && authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;
  const candidates: Array<[AccessKeySource, string | null]> = [
    ["x-brain-key", headers.get("x-brain-key")],
    ["bearer", bearerKey],
  ];
  const keys = configuredKeys();

  for (const [source, value] of candidates) {
    if (value && keys.some((k) => timingSafeEqualStr(k, value))) {
      return { ok: true, source };
    }
  }

  return { ok: false, source: null };
}

export function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function clampFloat(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = raw ? Number.parseFloat(raw) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
