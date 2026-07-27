#!/usr/bin/env bash
# Thin credential wrapper around reconcile-probe.mjs (OE board-hygiene Track B).
#
# WHY THIS EXISTS: same reason as closeout-run.sh (S342). Claude Code's Bash tool
# does not persist env vars between calls, so an unattended lane would otherwise
# re-emit a compound `export K="$(...)" && node probe.mjs ...` line on every step.
# The harness hard-blocks compound and command-substitution shapes BEFORE
# consulting permissions.allow, so no allowlist entry can auto-approve that line
# and the lane stalls on a permission prompt every unattended run (the 2026-07-13
# stall class). Keeping the compound logic inside a script file means the lane
# emits one flat, statically-analyzable command that permissions.allow CAN cover:
#
#   bash scripts/open-engine/reconcile-run.sh --task-id <uuid>
#
# NEVER PRINTS A SECRET. Credentials are read straight into the environment,
# verified by presence only, and never echoed, written, or logged. The probe
# runner receives them through the environment and prints only its JSON result
# line.
#
# CREDENTIALS THIS NEEDS:
#   OPEN_BRAIN_MCP_URL / OPEN_BRAIN_MCP_KEY
#     Read from ~/.claude.json as in closeout-run.sh. Required.
#   gh CLI
#     Used by the two git probes. Already authenticated against the macOS keyring
#     with repo scope, so private repos are reachable and this build stores no
#     GitHub token anywhere. Nothing new to rotate. If gh is missing or logged
#     out, the git probes fail closed to match:false.
#   WordPress application passwords (only if you use the wp_post_status probe)
#     Configure the sites first, as a JSON handle -> base URL map. The handles
#     MUST match profile.json's wordpress_sites, which is what the close_check
#     validator accepts at authorship:
#       export OE_WP_SITE_BASE_URLS='{"example-wp":"https://example.com"}'
#     Then store one application password per site. On macOS this reads from the
#     Keychain, service '<prefix><site-handle>' (prefix defaults to
#     'brainbank-wp-', override with OE_WP_KEYCHAIN_PREFIX), value in
#     'user:application-password' form:
#       security add-generic-password -s brainbank-wp-example-wp \
#         -a brainbank -w 'someuser:xxxx xxxx xxxx xxxx xxxx xxxx'
#     Use a dedicated WordPress application password, never the account password.
#     On a non-macOS host, export WP_APP_CREDENTIAL_<HANDLE> directly instead
#     (uppercased, dashes to underscores) -- the Keychain block below is skipped
#     when `security` is unavailable.
#     A wp_post_status probe with no credential fails closed to match:false and
#     the card stays on the desk. Leaving all of this unset is fine: the other
#     three probes need none of it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="$SCRIPT_DIR/reconcile-probe.mjs"
CLAUDE_CONFIG="$HOME/.claude.json"

if [ ! -f "$PROBE" ]; then
  echo '{"match":false,"error":"preflight failed (probe runner not found)"}'
  exit 0
fi

# Pass through creds already in the environment. Only fall back to the MCP config
# when they are absent.
if [ -z "${OPEN_BRAIN_MCP_URL:-}" ] || [ -z "${OPEN_BRAIN_MCP_KEY:-}" ]; then
  if [ ! -f "$CLAUDE_CONFIG" ]; then
    echo '{"match":false,"error":"preflight failed (no creds in env and no ~/.claude.json)"}'
    exit 0
  fi

  # Values are read straight into the environment. They are never echoed, never
  # written to a file, and never appear in this script's output.
  OPEN_BRAIN_MCP_URL="$(python3 -c 'import json,sys
try:
    print(json.load(open(sys.argv[1]))["mcpServers"]["open-brain"]["url"])
except Exception:
    pass' "$CLAUDE_CONFIG")"

  OPEN_BRAIN_MCP_KEY="$(python3 -c 'import json,sys
try:
    print(json.load(open(sys.argv[1]))["mcpServers"]["open-brain"]["headers"]["x-brain-key"])
except Exception:
    pass' "$CLAUDE_CONFIG")"

  export OPEN_BRAIN_MCP_URL OPEN_BRAIN_MCP_KEY
fi

# Length-only verification. Never print the values.
if [ -z "${OPEN_BRAIN_MCP_URL:-}" ] || [ -z "${OPEN_BRAIN_MCP_KEY:-}" ]; then
  echo '{"match":false,"error":"preflight failed (Open Brain MCP credentials empty)"}'
  exit 0
fi

# WordPress application passwords, optional and per site. A missing one is not an
# error here: the probe runner reports it and fails closed to match:false.
# `|| true` throughout, so a locked keychain or a denied prompt degrades to a
# no-op rather than killing the run under `set -e`.
# Site handles come from OE_WP_SITE_BASE_URLS, so no site is hardcoded here.
# Unset means the loop body never runs and every wp_post_status probe reports
# unknown-site, which is the correct fail-closed default.
KEYCHAIN_PREFIX="${OE_WP_KEYCHAIN_PREFIX:-brainbank-wp-}"
if [ -n "${OE_WP_SITE_BASE_URLS:-}" ] && command -v security >/dev/null 2>&1; then
  SITE_HANDLES="$(printf '%s' "$OE_WP_SITE_BASE_URLS" | python3 -c 'import json,sys
try:
    data = json.load(sys.stdin)
    print(" ".join(k for k in data if isinstance(k, str)))
except Exception:
    pass' || true)"
  for SITE_HANDLE in $SITE_HANDLES; do
    VAR_NAME="WP_APP_CREDENTIAL_$(printf '%s' "$SITE_HANDLE" | tr 'a-z-' 'A-Z_')"
    if [ -z "${!VAR_NAME:-}" ]; then
      CREDENTIAL="$(security find-generic-password -s "$KEYCHAIN_PREFIX$SITE_HANDLE" -w 2>/dev/null || true)"
      if [ -n "$CREDENTIAL" ]; then
        export "$VAR_NAME=$CREDENTIAL"
      fi
      unset CREDENTIAL
    fi
  done
fi

# NOT `exec node ...`. The caller must never see empty stdout: a lane reading a
# blank line could treat it as "no result" when the truth is "the runner never
# ran". That exact failure happened on the first live smoke (2026-07-25), when the
# probe's entry-point guard mis-compared a path containing spaces and main()
# silently never fired. The guard is fixed, but the belt stays: capture the
# output, and synthesize a fail-closed line if anything comes back empty.
set +e
PROBE_OUTPUT="$(node "$PROBE" "$@" 2>/dev/null)"
PROBE_EXIT=$?
set -e

if [ -z "$PROBE_OUTPUT" ]; then
  echo "{\"match\":false,\"error\":\"probe runner produced no output (exit $PROBE_EXIT)\"}"
  exit 0
fi

printf '%s\n' "$PROBE_OUTPUT"
exit 0
