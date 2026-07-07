// Shared access-key helpers.
//
// Single home for credential-compare logic used by the Edge Functions:
// the MCP/REST x-brain-key gates and Slack signature verification.

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
