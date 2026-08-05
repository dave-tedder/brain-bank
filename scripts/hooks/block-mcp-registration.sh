#!/usr/bin/env bash
# PreToolUse hook: block MCP registration commands.
#
# WHY: two agent sessions independently misdiagnosed a still-connecting Desktop
# MCP as "unavailable" and moved to re-register it. Doing so duplicates servers
# that are already live. The servers connect asynchronously; waiting and
# re-running ToolSearch is the fix. See "STEP 1 — MCP PREFLIGHT" in
# skills/open-engine-briefing/SKILL.md.
#
# Reads the PreToolUse payload on stdin; blocks on exit 2 with stderr shown to
# the model. The CLI's `list` and `get` subcommands are intentionally NOT
# blocked (they register nothing); the skill simply declares them
# non-authoritative as evidence of reachability.
#
# MATCHING: the original test was a substring match on the whole Bash command,
# so it fired on any call that merely MENTIONED the phrase — a commit message
# describing the rule, an echo, a grep for it. That is the cry-wolf failure
# mode: a guard that blocks innocent work gets routed around by reflex, and then
# it is not guarding anything.
#
# The test now looks for an actual invocation:
#   - heredoc bodies are removed (that is where commit messages live)
#   - comments are removed
#   - quoted arguments are removed, so a mention inside a string does not fire
#   - what remains must have the CLI in COMMAND POSITION (start of the command,
#     or after ; & | && || ( ` $( newline, then/do/else), optionally preceded by
#     VAR=val assignments or `env VAR=val`, followed by the mcp verb and a
#     registering subcommand (add, add-json, add-from-claude-desktop, remove)
#
# Quoted text is only treated as inert when the command has no string-executing
# wrapper. If eval or sh/bash/zsh -c is present, quotes are left intact so the
# wrapped form still blocks rather than becoming a bypass.
#
# Fails OPEN — any parse error allows the command through, because a hook that
# breaks the session is worse than one that misses a case.
#
# Tests: bash scripts/hooks/block-mcp-registration.test.sh
#
# Wire it up in .claude/settings.json (usually gitignored, so this is per-clone):
#   { "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [
#       { "type": "command",
#         "command": "\"$CLAUDE_PROJECT_DIR\"/scripts/hooks/block-mcp-registration.sh" }
#   ] } ] } }
set -uo pipefail

payload="$(cat)"

verdict="$(printf '%s' "$payload" | python3 -c '
import sys, json, re

try:
    cmd = json.load(sys.stdin).get("tool_input", {}).get("command", "") or ""
except Exception:
    print("ALLOW"); raise SystemExit

def strip_heredocs(s):
    lines, out, pending = s.split("\n"), [], []
    for line in lines:
        if pending:
            if line.strip() == pending[0]:
                pending.pop(0)
            continue
        for m in re.finditer(r"<<-?\s*([\x27\"]?)([A-Za-z_][A-Za-z0-9_]*)\1", line):
            pending.append(m.group(2))
        out.append(line)
    return "\n".join(out)

def strip_comments(s):
    return "\n".join(re.sub(r"(^|\s)#.*$", r"\1", ln) for ln in s.split("\n"))

def strip_quotes(s):
    s = re.sub(r"\x27[^\x27]*\x27", " ", s)
    s = re.sub(r"\"(?:\\\\.|[^\"\\\\])*\"", " ", s)
    return s

text = strip_comments(strip_heredocs(cmd))

# Leave quotes intact when a wrapper could execute their contents.
if not re.search(r"\b(?:eval|(?:ba|z)?sh\s+(?:-[A-Za-z]*c|-c))\b", text):
    text = strip_quotes(text)

# Quote chars count as a command position only in the wrapper branch above,
# where quotes survive; the normal branch has already stripped them by here.
CMD_POS = r"(?:^|[\n;&|(`\x27\"]|&&|\|\||\$\(|\bthen\b|\bdo\b|\belse\b)"
ASSIGN  = r"(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*"
ENVPFX  = r"(?:env\s+" + ASSIGN + r")?"
SUB     = r"(?:add|add-json|add-from-claude-desktop|remove|rm)"
PATTERN = re.compile(CMD_POS + r"\s*" + ASSIGN + ENVPFX + r"claude\s+mcp\s+" + SUB + r"\b")

print("BLOCK" if PATTERN.search(text) else "ALLOW")
' 2>/dev/null || true)"

if [ "${verdict:-ALLOW}" = "BLOCK" ]; then
  cat >&2 <<'MSG'
BLOCKED: re-registering an MCP server is not the fix here.

If a WordPress / Notion / Desktop MCP looks missing, it is almost certainly still
CONNECTING, not absent. Desktop servers connect asynchronously and routinely
surface minutes into a session. They are already registered and already live.
Re-registering would DUPLICATE working servers.

Do this instead (STEP 1 — MCP PREFLIGHT):
  1. Wait, then re-run ToolSearch, e.g. "select:mcp__<server>__mcp_ping".
  2. Verify with a live call: mcp__<server>__mcp_ping.
  3. Retry up to 3 times before concluding anything.

The CLI listing and the config files describe REGISTRATION, not REACHABILITY.
Neither is evidence of absence. Only a live call is, and only after the retries.

This misdiagnosis has already recurred across separate sessions on the same day.
If you are certain this is a genuine new server install, ask the operator to run
it themselves.

If you were only WRITING ABOUT this command (a commit message, an echo, a grep)
and it still fired, that is a hook bug, not a policy decision — report it rather
than rewording around it.
MSG
  exit 2
fi
exit 0
