#!/usr/bin/env bash
# PreToolUse hook: block `claude mcp add` / `claude mcp remove`.
#
# WHY: two agent sessions independently misdiagnosed a still-connecting Desktop
# MCP as "unavailable" and moved to re-register it. Doing so duplicates servers
# that are already live. The servers connect asynchronously; waiting and
# re-running ToolSearch is the fix. See "STEP 0 — MCP PREFLIGHT" in
# skills/open-engine-briefing/SKILL.md.
#
# Reads the PreToolUse payload on stdin; blocks on exit 2 with stderr shown to
# the model. `claude mcp list` is intentionally NOT blocked (it is harmless and
# informational); the skill simply declares it non-authoritative.
#
# Wire it up in .claude/settings.json (usually gitignored, so this is per-clone):
#   { "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [
#       { "type": "command",
#         "command": "\"$CLAUDE_PROJECT_DIR\"/scripts/hooks/block-mcp-registration.sh" }
#   ] } ] } }
set -uo pipefail

payload="$(cat)"
cmd="$(printf '%s' "$payload" | python3 -c \
  'import sys,json;print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' \
  2>/dev/null || true)"

case "$cmd" in
  *"claude mcp add"*|*"claude mcp remove"*)
    cat >&2 <<'MSG'
BLOCKED: `claude mcp add` / `claude mcp remove` is not the fix here.

If a WordPress / Notion / Desktop MCP looks missing, it is almost certainly still
CONNECTING, not absent. Desktop servers connect asynchronously and routinely
surface minutes into a session. They are already registered and already live.
Re-registering would DUPLICATE working servers.

Do this instead (STEP 0 — MCP PREFLIGHT):
  1. Wait, then re-run ToolSearch, e.g. "select:mcp__<server>__mcp_ping".
  2. Verify with a live call: mcp__<server>__mcp_ping.
  3. Retry up to 3 times before concluding anything.

`claude mcp list` and the config files describe REGISTRATION, not REACHABILITY.
Neither is evidence of absence. Only a live call is, and only after the retries.

This misdiagnosis has already recurred across separate sessions on the same day.
If you are certain this is a genuine new server install, ask the operator to run
it themselves.
MSG
    exit 2
    ;;
esac
exit 0
