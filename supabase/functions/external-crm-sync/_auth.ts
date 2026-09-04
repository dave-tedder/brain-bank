// external-crm-sync authentication.
//
// This function is unlocked by ONE credential, `EXTERNAL_CRM_PUSH_KEY`, sent in
// the `x-push-key` header. It is deliberately not wired through
// `_shared/access-key.ts`: that helper compares against `MCP_ACCESS_KEY`, the
// key that opens every MCP tool and REST route, and the whole point of this
// function is that the CRM's credential opens two write operations and
// nothing else. The boundary holds in both directions and is tested in
// `_auth_test.ts`: `MCP_ACCESS_KEY` does not unlock this function, and
// `EXTERNAL_CRM_PUSH_KEY` does not unlock `open-brain-mcp`.
//
// No bearer form, no query-string form: one header, one env var.

import { timingSafeEqualStr } from "../_shared/access-key.ts";

export const PUSH_KEY_HEADER = "x-push-key";
export const PUSH_KEY_ENV = "EXTERNAL_CRM_PUSH_KEY";

export type PushAuthReason = "ok" | "not_configured" | "missing" | "mismatch";

export interface PushAuthResult {
  ok: boolean;
  reason: PushAuthReason;
}

/**
 * @param headers   the request headers
 * @param configured the configured key; defaults to the env var. An empty or
 *                   absent configured key refuses EVERY request (never treat
 *                   "no key set" as "no key needed", and never let an empty
 *                   header match an empty secret).
 */
export function authenticatePushKey(
  headers: Headers,
  configured: string = Deno.env.get(PUSH_KEY_ENV) ?? "",
): PushAuthResult {
  if (!configured) return { ok: false, reason: "not_configured" };
  const presented = headers.get(PUSH_KEY_HEADER);
  if (!presented) return { ok: false, reason: "missing" };
  if (!timingSafeEqualStr(configured, presented)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true, reason: "ok" };
}
