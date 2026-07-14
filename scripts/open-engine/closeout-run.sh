#!/usr/bin/env bash
# Thin credential wrapper around closeout-controller.mjs.
#
# WHY THIS EXISTS: Claude Code's Bash tool does not persist env vars between
# calls, so a scheduled closeout lane has to re-establish them on every step.
# The obvious way to do that is a compound command:
#   cd <repo> && export K="$(...)" && node closeout-controller.mjs ...
# but the harness hard-blocks compound and command-substitution shapes
# ("contains shell syntax that cannot be statically analyzed") BEFORE it
# consults permissions.allow. No allowlist entry can auto-approve that line, so
# an unattended scheduled lane freezes on a permission prompt with nobody there
# to click it.
#
# Keeping the compound logic inside a script file means the lane emits one flat,
# statically-analyzable command that permissions.allow CAN cover:
#   bash scripts/open-engine/closeout-run.sh --task-id <uuid> --live-check
#
# Allowlist it in your project's .claude/settings.json:
#   "Bash(bash scripts/open-engine/closeout-run.sh:*)"
#
# closeout-controller.mjs is NOT modified by this. Credentials already present
# in the environment pass straight through, so a lane that sets them itself
# (e.g. a Codex run) is unaffected.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTROLLER="$SCRIPT_DIR/closeout-controller.mjs"

# Where Claude Code stores its MCP server config. The key is read from here at
# runtime and never copied into any file in this repo.
CLAUDE_CONFIG="$HOME/.claude.json"
MCP_SERVER_NAME="brain-bank"

if [ ! -f "$CONTROLLER" ]; then
  echo "NO_RECEIPT: preflight failed (controller not found at $CONTROLLER)" >&2
  exit 1
fi

# Pass through creds already in the environment. Only fall back to the MCP
# config when they are absent.
if [ -z "${BB_MCP_URL:-}" ] || [ -z "${BB_MCP_KEY:-}" ]; then
  if [ ! -f "$CLAUDE_CONFIG" ]; then
    echo "NO_RECEIPT: preflight failed (no creds in env and no $CLAUDE_CONFIG)" >&2
    exit 1
  fi

  # Values are read straight into the environment. They are never echoed,
  # never written to a file, and never appear in this script's output.
  BB_MCP_URL="$(python3 -c 'import json,sys
try:
    print(json.load(open(sys.argv[1]))["mcpServers"][sys.argv[2]]["url"])
except Exception:
    pass' "$CLAUDE_CONFIG" "$MCP_SERVER_NAME")"

  BB_MCP_KEY="$(python3 -c 'import json,sys
try:
    print(json.load(open(sys.argv[1]))["mcpServers"][sys.argv[2]]["headers"]["x-brain-key"])
except Exception:
    pass' "$CLAUDE_CONFIG" "$MCP_SERVER_NAME")"

  export BB_MCP_URL BB_MCP_KEY
fi

# Length-only verification. Never print the values.
if [ -z "${BB_MCP_URL:-}" ]; then
  echo "NO_RECEIPT: preflight failed (BB_MCP_URL empty)" >&2
  exit 1
fi
if [ -z "${BB_MCP_KEY:-}" ]; then
  echo "NO_RECEIPT: preflight failed (BB_MCP_KEY empty)" >&2
  exit 1
fi

exec node "$CONTROLLER" "$@"
