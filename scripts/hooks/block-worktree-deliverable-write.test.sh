#!/usr/bin/env bash
# Tests for block-worktree-deliverable-write.sh (GAP C Track 2).
#
# The fail-open cases are not decoration: a hook that blocks legitimate work
# when it breaks is worse than the bug it prevents. Every malformed, empty, and
# unexpected input below MUST exit 0.
#
# Run: bash scripts/hooks/block-worktree-deliverable-write.test.sh
set -uo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/block-worktree-deliverable-write.sh"
PASS=0
FAIL=0
REPO="/home/example/projects/brain-bank"
WT="$REPO/.claude/worktrees/example-worktree"

# check <name> <expected-exit> <payload>
check() {
  local name="$1" want="$2" payload="$3" got out
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

payload_for() { printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$1"; }

echo "--- DENY: the one case this hook exists for ---"
# P2.1
check "worktree deliverables write is denied" 2 "$(payload_for "$WT/deliverables/example-project/x-a1b2c3d4.md")"
check "worktree deliverables, nested deeper"  2 "$(payload_for "$WT/deliverables/a/b/c.md")"
check "Edit tool, same path"                  2 '{"tool_name":"Edit","tool_input":{"file_path":"'"$WT"'/deliverables/x.md"}}'

echo "--- ALLOW: everything else ---"
# P2.2 main-checkout absolute write
check "main checkout absolute deliverables"   0 "$(payload_for "$REPO/deliverables/example-project/x.md")"
# P2.3 relative path in main
check "relative deliverables path"            0 "$(payload_for "deliverables/x.md")"
# P2.4 must NOT be a general worktree write ban
check "worktree docs write"                   0 "$(payload_for "$WT/docs/scratch.md")"
check "worktree source write"                 0 "$(payload_for "$WT/supabase/functions/x.ts")"
check "worktree file named deliverables.md"   0 "$(payload_for "$WT/notes/deliverables.md")"

echo "--- FAIL OPEN: malformed input must never block ---"
check "empty payload"                         0 ""
check "not json"                              0 "this is not json at all"
check "json without tool_input"               0 '{"tool_name":"Write"}'
check "tool_input without file_path"          0 '{"tool_name":"Write","tool_input":{}}'
check "empty file_path"                       0 "$(payload_for "")"
check "null json"                             0 'null'
check "json array"                            0 '[1,2,3]'
check "worktrees path with no trailing seg"   0 "$(payload_for "$REPO/.claude/worktrees/deliverables/x.md")"

echo
echo "--- P2.5 fail-open under a broken hook (non-executable / missing) ---"
# The real P2.5 is behavioural: the harness must allow the write when the hook
# cannot run. Assert the runner's own contract here: a missing hook script
# yields a nonzero *shell* error, which the harness treats as non-blocking.
missing_out=$(printf '%s' "$(payload_for "$REPO/deliverables/x.md")" | bash "$HOOK.does-not-exist" 2>&1; echo "rc=$?")
case "$missing_out" in
  *"rc=127"*) echo "ok    missing hook script surfaces as rc=127 (harness-level, not a deny)"; PASS=$((PASS + 1)) ;;
  *) echo "FAIL  missing hook script: unexpected $missing_out"; FAIL=$((FAIL + 1)) ;;
esac

echo
echo "--- guard: the deny message must name the corrected path ---"
msg="$(printf '%s' "$(payload_for "$WT/deliverables/example-project/x.md")" | bash "$HOOK" 2>&1 || true)"
case "$msg" in
  *"$REPO/deliverables/example-project/x.md"*)
    echo "ok    deny message contains the corrected main path"; PASS=$((PASS + 1)) ;;
  *)
    echo "FAIL  deny message missing corrected path"; echo "$msg"; FAIL=$((FAIL + 1)) ;;
esac
case "$msg" in
  *".claude/worktrees"*)
    echo "FAIL  corrected path still points into the worktree"; FAIL=$((FAIL + 1)) ;;
  *)
    echo "ok    corrected path does not point into a worktree"; PASS=$((PASS + 1)) ;;
esac

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" = 0 ]
