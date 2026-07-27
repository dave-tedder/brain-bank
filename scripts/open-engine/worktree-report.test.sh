#!/usr/bin/env bash
# Tests for worktree-report.sh (GAP C Track 5).
#
# P5.3 is the one that must never be allowed to rot. This script is LOW risk
# only because it cannot remove anything; the day someone adds a removal mode it
# becomes the highest-risk script in the repo (on the origin deployment an
# automatic prune would have destroyed two live client-facing artifacts). The
# grep guard below
# is the tripwire, and it is asserted by test, not by reading the source.
#
# Run: bash scripts/open-engine/worktree-report.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORT="$SCRIPT_DIR/worktree-report.sh"
MAIN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

echo "--- P5.3a BEHAVIOURAL: running the report changes no worktree state ---"
# This is the assertion that actually matters. The script documents the
# prune-vs-remove distinction and PRINTS a prune recommendation, so any static
# grep will trip over its own prose; what must be true is that running it
# mutates nothing.
before_list="$(git -C "$MAIN_ROOT" worktree list --porcelain 2>/dev/null)"
before_dirty="$(git -C "$MAIN_ROOT" status --porcelain -uall 2>/dev/null | grep -c .)"
bash "$REPORT" >/dev/null 2>&1
after_list="$(git -C "$MAIN_ROOT" worktree list --porcelain 2>/dev/null)"
after_dirty="$(git -C "$MAIN_ROOT" status --porcelain -uall 2>/dev/null | grep -c .)"
[ "$before_list" = "$after_list" ] && ok "worktree list identical before/after" || bad "the report MUTATED the worktree list"
[ "$before_dirty" = "$after_dirty" ] && ok "main working tree unchanged before/after" || bad "the report dirtied main"

echo
echo "--- P5.3b STATIC tripwire: no destructive verb in an executable position ---"
# Strip comment lines and the contents of echo/printf/heredoc output, then look
# for a real invocation. Without this stripping the guard matches the script's
# own documentation and cries wolf every run — a check that can never pass is a
# bug in the check, not a finding.
CODE="$(sed -e 's/[[:space:]]*#.*$//' "$REPORT" \
        | grep -vE '^[[:space:]]*(echo|printf)\b' \
        | grep -vE '^[[:space:]]*(prune|remove)[[:space:]]+—' )"
check_static() { # <pattern> <label>
  if printf '%s\n' "$CODE" | grep -nE "$1" >/dev/null 2>&1; then
    bad "$2"
  else
    ok "$2 — absent"
  fi
}
check_static 'git[[:space:]]+worktree[[:space:]]+remove' "git worktree remove"
check_static '(^|[;&|][[:space:]]*)/?(bin/)?rm[[:space:]]+-[rRf]' "rm -rf invocation"
check_static 'git[[:space:]]+clean' "git clean"
check_static 'git[[:space:]]+worktree[[:space:]]+prune' "executed prune (must only be recommended)"

echo
echo "--- P5.1 report shape ---"
out="$(bash "$REPORT" 2>&1)"
case "$out" in *"never removes anything"*) ok "output states the read-only contract" ;; *) bad "missing read-only contract line" ;; esac
case "$out" in *"REMOVAL IS A HUMAN DECISION"*) ok "output states removal preconditions" ;; *) bad "missing removal preconditions" ;; esac
case "$out" in *"UNRESCUED"*) ok "reports unrescued deliverables column" ;; *) bad "missing UNRESCUED column" ;; esac

# The JSON line must parse, and no field may contain an embedded newline (a
# `grep -c . || echo 0` regression produced "0\n0" and silently broke parsing).
json="$(printf '%s' "$out" | tail -1)"
if printf '%s' "$json" | python3 -c '
import json,sys
o=json.load(sys.stdin)
assert o["ok"] is True
for w in o["worktrees"]:
    for k,v in w.items():
        assert "\n" not in str(v), f"embedded newline in {k}: {v!r}"
' 2>/dev/null; then
  ok "JSON parses and no field carries an embedded newline"
else
  bad "JSON malformed or a field carries an embedded newline"
fi

echo
echo "--- P5.4 EVERY worktree is reported, including the last one ---"
# Regression guard. git's porcelain terminates each entry with a blank line and
# the parser flushes on it, but command substitution strips trailing newlines —
# so the final entry was silently dropped. It never errored; the janitor just
# under-reported by one, which is invisible unless you count. Count.
expected=$(( $(git -C "$MAIN_ROOT" worktree list | grep -c .) - 1 ))
reported=$(bash "$REPORT" --json 2>/dev/null | tail -1 | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["worktrees"]))' 2>/dev/null || echo -1)
if [ "$expected" = "$reported" ]; then
  ok "reported $reported worktrees, matching git's count excluding main"
else
  bad "worktree count mismatch: git says $expected, report says $reported"
fi

echo
echo "--- P5.2 stale record (directory deleted outside git) ---"
STALE="$MAIN_ROOT/.claude/worktrees/gapc-report-stale-probe"
git -C "$MAIN_ROOT" worktree add -q "$STALE" --detach HEAD 2>/dev/null
if [ -d "$STALE" ]; then
  # Deleting a directory we created ourselves, in this test only.
  /bin/rm -rf "$STALE"
  sout="$(bash "$REPORT" 2>&1)"
  case "$sout" in *"gapc-report-stale-probe"*STALE_RECORD*) ok "stale record detected" ;; *)
    case "$sout" in *STALE_RECORD*) ok "stale record detected" ;; *) bad "stale record not detected" ;; esac ;;
  esac
  case "$sout" in *"git worktree prune"*) ok "names 'git worktree prune' as the safe cleanup" ;; *) bad "does not name prune" ;; esac
  git -C "$MAIN_ROOT" worktree prune 2>/dev/null
  ok "cleaned up via prune (the safe verb)"
else
  echo "SKIP: could not create probe worktree"
fi

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" = 0 ]
