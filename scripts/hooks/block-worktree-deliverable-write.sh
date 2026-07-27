#!/usr/bin/env bash
# PreToolUse hook (Write|Edit): deny a worktree-local `deliverables/` write and
# hand back the correct main-checkout path.
#
# WHY: some agent runtimes execute a session in a fresh git worktree (Claude
# Code spawns one per task chip, under `.claude/worktrees/`), and nothing inside
# the session reveals that. A worktree is a SEPARATE working directory. The
# closeout controller, both critic lanes, and the deliverables sweep all resolve
# the MAIN checkout only, so a file written to `<worktree>/deliverables/` is
# physically real, is named honestly in the receipt, and is unreachable by every
# downstream reader — then is destroyed outright when the worktree is removed.
# Four critic flags in one day on the origin deployment were caused by this and
# nothing else, each worded as "the work is missing" when the work was fine.
#
# There is a second, quieter failure: when the path ALSO exists in main, the
# stranded copy shows as modified rather than untracked, so a reader finds a
# file, reads it, and reviews the STALE version with no flag at all.
#
# The rule this enforces is in `AGENTS.md` and `skills/queue-runner/SKILL.md`.
#
# CONTRACT — FAIL OPEN, ALWAYS. A hook that blocks work when it breaks is worse
# than the bug it prevents. Every path that is not an unambiguous worktree-local
# deliverables write exits 0, including every internal error, missing
# dependency, and unparseable payload. The ONLY nonzero exit is exit 2 on a
# positively-identified violation. Note the deliberate absence of `set -e`.
set -uo pipefail

# Anything unexpected past this point allows the write.
trap 'exit 0' ERR

payload="$(cat 2>/dev/null || true)"
[ -n "$payload" ] || exit 0

# Write and Edit both carry the target as tool_input.file_path.
path="$(printf '%s' "$payload" | python3 -c \
  'import sys,json;print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))' \
  2>/dev/null || true)"

[ -n "$path" ] || exit 0

# Gate 1: only deliverables writes are in scope. This hook must never become a
# general worktree write ban — worktree sessions legitimately write code, specs,
# and scratch files.
case "$path" in
  */deliverables/*) ;;
  *) exit 0 ;;
esac

# Gate 2: only writes that land inside a worktree are in scope.
case "$path" in
  */.claude/worktrees/*) ;;
  *) exit 0 ;;
esac

# Derive the correct main-checkout path: strip the `.claude/worktrees/<name>/`
# segment. Self-contained — no env var, no git call, nothing that can fail
# open-ended. `<repo>/.claude/worktrees/foo/deliverables/x.md`
#                                    -> `<repo>/deliverables/x.md`
repo_root="${path%%/.claude/worktrees/*}"
after="${path#*/.claude/worktrees/}"
rest="${after#*/}"

# If the shape was not what we expected, allow the write rather than guess.
[ -n "$repo_root" ] || exit 0
[ -n "$rest" ] || exit 0
[ "$rest" != "$after" ] || exit 0
case "$rest" in
  deliverables/*) ;;
  *) exit 0 ;;
esac

corrected="$repo_root/$rest"

cat >&2 <<MSG
BLOCKED: that deliverables path is inside a git worktree, where no downstream reader can reach it.

Write here instead:
$corrected

Why: a worktree is a SEPARATE working directory. The closeout controller, both
critic lanes, and the deliverables sweep all resolve the MAIN checkout only. A
file written to the worktree is physically real and your receipt naming it would
be honest, but every reader reports it missing, and it is destroyed when the
worktree is removed.

Then verify before you name it: read the file back from that absolute path and
stamp the receipt path "@ MAIN-VERIFIED". "I just wrote it" is not verification
— that is exactly the check that passes while a file is stranded.

If you also run the durability push, use its ABSOLUTE path too. The script
anchors to its own location, so the relative form invoked from a worktree
stages the wrong tree and reports NOTHING_TO_COMMIT.

See AGENTS.md ("Deliverables are written to the MAIN checkout").
MSG
exit 2
