#!/usr/bin/env bash
# Tests for block-mcp-registration.sh.
#
# The ALLOW cases matter as much as the DENY ones. This hook originally
# tested the whole Bash command with a substring match, so it fired on any call
# that merely MENTIONED the phrase — a commit message describing the rule, an
# echo, a grep. A guard that blocks innocent work gets routed around by reflex,
# and then it is not guarding anything. Every ALLOW case below is a real false
# positive that shipped, or a near neighbour of one.
#
# The fail-open cases are not decoration either: malformed input MUST exit 0.
#
# Run: bash scripts/hooks/block-mcp-registration.test.sh
set -uo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/block-mcp-registration.sh"
PASS=0
FAIL=0

# Assembled at runtime so this file's own text is not a literal the hook
# would match if it is ever scanned by something cruder.
C="claude mcp"

# check <name> <expected-exit> <command-string>
check() {
  local name="$1" want="$2" cmd="$3" got out payload
  payload="$(CMD="$cmd" python3 -c 'import json,os;print(json.dumps({"tool_name":"Bash","tool_input":{"command":os.environ["CMD"]}}))')"
  out="$(printf '%s' "$payload" | bash "$HOOK" 2>&1)"
  got=$?
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1))
    printf 'ok    %s (exit %s)\n' "$name" "$got"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %s: wanted exit %s, got %s\n' "$name" "$want" "$got"
    printf '      output: %s\n' "$(printf '%s' "$out" | head -2)"
  fi
}

echo "--- DENY: real registration invocations ---"
check "plain add"                    2 "$C add --transport http --scope user foo https://x"
check "plain remove"                 2 "$C remove foo --scope user"
check "after &&"                     2 "cd /tmp && $C add foo https://x"
check "after ;"                      2 "echo hi; $C remove foo"
check "leading var assignment"       2 "FOO=1 $C add foo"
check "env prefix"                   2 "env FOO=1 $C add foo"
check "add-json subcommand"          2 "$C add-json foo '{}'"
check "add-from-claude-desktop"      2 "$C add-from-claude-desktop"
check "on a later line"              2 "$(printf 'echo one\n%s remove foo' "$C")"
check "wrapped in bash -c"           2 "bash -c \"$C add foo https://x\""
check "wrapped in eval"              2 "eval \"$C remove foo\""

echo "--- ALLOW: mentions, not invocations (the regression this fixes) ---"
check "heredoc commit message"       0 "$(printf "git commit -F - <<'EOF'\nfix: explain why %s add is wrong\nEOF" "$C")"
check "quoted -m commit message"     0 "git commit -m \"explains that $C add is not the fix\""
check "echo of the phrase"           0 "echo \"$C add\""
check "grep for the phrase"          0 "grep -rn \"$C add\" ."
check "shell comment"                0 "# $C add foo"

echo "--- ALLOW: non-registering subcommands ---"
check "list registers nothing"       0 "$C list"
check "get registers nothing"        0 "$C get foo"
check "unrelated command"            0 "git log --oneline -5"

echo "--- FAIL OPEN: malformed input must never block ---"
check "empty payload"                0 ""
check "no command key"               0 "__NOCMD__"

echo ""
if [ "$FAIL" -eq 0 ]; then
  printf 'ALL PASS (%s assertions)\n' "$PASS"
  exit 0
fi
printf '%s PASSED, %s FAILED\n' "$PASS" "$FAIL"
exit 1
