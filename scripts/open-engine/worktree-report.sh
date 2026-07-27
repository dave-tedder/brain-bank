#!/usr/bin/env bash
# Worktree janitor — REPORT ONLY (GAP C Track 5).
#
# THIS SCRIPT NEVER REMOVES ANYTHING, AND MUST NOT BE EXTENDED TO.
# On the origin deployment, an automatic prune measured at one point would have
# destroyed two live client-facing artifacts whose only current copy lived in a
# worktree. So there is no write
# mode, no removal mode, and no flag that enables one. Its honest job is
# visibility; a human decides what dies.
#
# `git worktree prune` vs `git worktree remove` — the distinction is the whole
# safety story:
#   prune  — deletes only ADMINISTRATIVE RECORDS for directories that are
#            already gone from disk. It cannot touch a live worktree. Safe to
#            run unattended.
#   remove — DELETES THE WORKING TREE, including uncommitted files. Stays human,
#            permanently.
#
# REMOVAL PRECONDITIONS (for a human, by hand):
#   1. zero dirty files in that worktree;
#   2. zero unrescued deliverables per `worktree-rescue.sh --report`
#      (nothing in absent_from_main or divergent for that worktree);
#   3. either no branch commits missing from main, or an explicit decision to
#      keep the branch.
# Removing the directory while KEEPING the branch preserves every committed
# change — branch refs live in the shared object store; only uncommitted work
# is destroyed.
#
# Usage: bash scripts/open-engine/worktree-report.sh [--json]
# Prints a human summary by default, plus one JSON line with --json.
set -uo pipefail

JSON_ONLY=0
case "${1:-}" in
  --json) JSON_ONLY=1 ;;
  "") ;;
  *) echo "usage: worktree-report.sh [--json]" >&2; exit 1 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null)" || exit 0
COMMON_DIR="$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || COMMON_DIR=""
if [ -z "$COMMON_DIR" ]; then
  echo '{"ok":false,"reason":"NOT_A_GIT_REPO"}'
  exit 0
fi
MAIN_ROOT="$(dirname "$COMMON_DIR")"

MAIN_HEAD="$(git -C "$MAIN_ROOT" rev-parse main 2>/dev/null || echo "")"

# Unrescued deliverables, straight from Track 4 — never re-implement the scan.
RESCUE="$SCRIPT_DIR/worktree-rescue.sh"
RESCUE_JSON="{}"
if [ -x "$RESCUE" ] || [ -f "$RESCUE" ]; then
  RESCUE_JSON="$(bash "$RESCUE" --report 2>/dev/null || echo '{}')"
fi

mtime_of() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo ""
}

NOW="$(date +%s 2>/dev/null || echo 0)"

rows=()
stale_records=()

# The loop below flushes an entry when it sees the BLANK line that terminates it
# in git's porcelain output. Command substitution strips ALL trailing newlines,
# so `<<< "$(git worktree list --porcelain)"` silently loses the final blank line
# and therefore NEVER FLUSHES THE LAST WORKTREE. That is a silent under-report,
# not a crash: the janitor just omits one row. Re-append the terminator with a
# literal newline in an assignment, which is not subject to that stripping.
WT_PORCELAIN="$(git -C "$MAIN_ROOT" worktree list --porcelain 2>/dev/null)"
WT_PORCELAIN="$WT_PORCELAIN
"

while IFS= read -r line; do
  case "$line" in
    worktree\ *) cur_wt="${line#worktree }"; cur_prunable="" ;;
    prunable*)   cur_prunable="${line#prunable }"; [ -n "$cur_prunable" ] || cur_prunable="gone" ;;
    "")
      [ -n "${cur_wt:-}" ] || continue
      if [ "$cur_wt" = "$MAIN_ROOT" ]; then cur_wt=""; continue; fi
      name="$(basename "$cur_wt")"

      if [ -n "$cur_prunable" ]; then
        stale_records+=("$name")
        rows+=("$name|STALE_RECORD|-|-|-|$cur_prunable")
        cur_wt=""; continue
      fi

      head="$(git -C "$cur_wt" rev-parse HEAD 2>/dev/null || echo "?")"
      # `grep -c .` already PRINTS 0 on no match (and exits 1), so a `|| echo 0`
      # here appends a SECOND zero, embeds a newline in the field, and silently
      # breaks the downstream `IFS='|' read` for every clean worktree.
      dirty="$(git -C "$cur_wt" status --porcelain -uall 2>/dev/null | grep -c .)"
      dirty="${dirty:-0}"

      # Commits on this worktree's HEAD not reachable from main.
      ahead="0"
      if [ -n "$MAIN_HEAD" ] && [ "$head" != "?" ]; then
        ahead="$(git -C "$MAIN_ROOT" rev-list --count "$head" --not main 2>/dev/null || echo 0)"
      fi

      age_days="?"
      mt="$(mtime_of "$cur_wt")"
      if [ -n "$mt" ] && [ "$NOW" != "0" ]; then
        age_days="$(( (NOW - mt) / 86400 ))"
      fi

      unrescued="$(printf '%s' "$RESCUE_JSON" | python3 -c '
import json,sys
name=sys.argv[1]
try: o=json.load(sys.stdin)
except Exception: print(0); sys.exit()
n=sum(1 for k in ("absent_from_main","divergent") for x in o.get(k,[]) if x.startswith(name+"::"))
print(n)' "$name" 2>/dev/null || echo 0)"

      same="behind/ahead"
      [ "$head" = "$MAIN_HEAD" ] && same="at-main"
      rows+=("$name|$same|${age_days}d|$dirty|$unrescued|$ahead")
      cur_wt=""
      ;;
  esac
done <<< "$WT_PORCELAIN"

if [ "$JSON_ONLY" = 0 ]; then
  echo "WORKTREE REPORT (read-only; this script never removes anything)"
  echo "main: $MAIN_ROOT"
  echo
  printf '%-32s %-14s %6s %6s %10s %7s\n' "WORKTREE" "VS-MAIN" "AGE" "DIRTY" "UNRESCUED" "AHEAD"
  for r in ${rows+"${rows[@]}"}; do
    IFS='|' read -r a b c d e f <<< "$r"
    printf '%-32s %-14s %6s %6s %10s %7s\n' "$a" "$b" "$c" "$d" "$e" "$f"
  done
  echo
  echo "AHEAD = commits on that worktree's HEAD not reachable from main."
  echo "UNRESCUED = deliverables absent from main or divergent (worktree-rescue.sh --report)."
  echo
  if [ "${#stale_records[@]}" -gt 0 ] 2>/dev/null; then
    echo "Stale records (directory already gone): ${stale_records[*]}"
    echo "  Safe cleanup for these, and ONLY these:  git worktree prune"
    echo "  It removes administrative records only and cannot touch a live worktree."
    echo
  fi
  echo "REMOVAL IS A HUMAN DECISION. \`git worktree remove\` deletes uncommitted"
  echo "work. Before removing any row above, require: DIRTY 0, UNRESCUED 0, and"
  echo "either AHEAD 0 or a deliberate choice to keep the branch."
fi

python3 -c '
import json,sys
rows=[]
for r in sys.argv[2:]:
    a,b,c,d,e,f = (r.split("|") + [""]*6)[:6]
    rows.append({"worktree":a,"vs_main":b,"age":c,"dirty":d,"unrescued":e,"ahead":f})
print(json.dumps({"ok":True,"main_root":sys.argv[1],"worktrees":rows}))' \
  "$MAIN_ROOT" ${rows+"${rows[@]}"} 2>/dev/null || echo '{"ok":false,"reason":"JSON_EMIT_FAILED"}'
exit 0
