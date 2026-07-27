#!/usr/bin/env bash
# Rescue deliverables stranded in git worktrees (GAP C Track 4).
#
# WHY: sessions spawned from a task chip run in a fresh git worktree. Every
# reader — the closeout controller, both critic lanes, the deliverables sweep —
# resolves the MAIN checkout only, so a deliverable written into a worktree is
# unreachable and dies with the worktree. Tracks 1-3 stop new stranding at the
# source; this is the backstop for worktrees that already exist and predate the
# enforcement hook.
#
# THE ONE RULE THAT MATTERS — NEVER OVERWRITE. Deliverables are client-facing
# draft content. On the origin deployment two files were measured existing in
# BOTH a worktree and main and DIFFERING, with the worktree copy larger; a later
# measurement found a third where MAIN was the larger side. A copy-newest-wins
# sweep would have destroyed live draft content in one direction or the other. So:
#   ABSENT from main   -> adopt (copy in, verify by hash)
#   IDENTICAL to main  -> no-op
#   DIFFERS from main  -> REPORT AND REFUSE. A human resolves it.
# Adoption is a COPY, never a move: nothing is ever deleted from a worktree.
#
# Usage (one flat command; the harness blocks compound shapes before consulting
# permissions.allow, hence the script):
#   bash scripts/open-engine/worktree-rescue.sh --report   (default, no writes)
#   bash scripts/open-engine/worktree-rescue.sh --adopt
#
# Prints exactly one JSON line on stdout.
set -uo pipefail

MODE="report"
case "${1:---report}" in
  --report) MODE="report" ;;
  --adopt)  MODE="adopt" ;;
  *)
    echo '{"ok":false,"reason":"USAGE","detail":"usage: worktree-rescue.sh [--report|--adopt]"}'
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null)" || {
  echo '{"ok":false,"reason":"SCRIPT_ERROR","detail":"cannot resolve script dir"}'
  exit 0
}

# P4.7: resolve the MAIN checkout regardless of cwd, and NEVER operate on a
# worktree's own tree. deliverables-push.sh anchors to $SCRIPT_DIR/../.., which
# silently yields the WORKTREE root when its worktree copy is invoked (spec
# ground truth item 6). Do not reproduce that: ask git for the common dir, which
# points at the main checkout's .git even from inside a worktree.
COMMON_DIR="$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || COMMON_DIR=""
if [ -z "$COMMON_DIR" ]; then
  echo '{"ok":false,"reason":"NOT_A_GIT_REPO","detail":"could not resolve git common dir"}'
  exit 0
fi
MAIN_ROOT="$(dirname "$COMMON_DIR")"

if [ ! -d "$MAIN_ROOT/deliverables" ]; then
  printf '{"ok":false,"reason":"NO_DELIVERABLES_DIR","main_root":%s}\n' \
    "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$MAIN_ROOT" 2>/dev/null || echo '""')"
  exit 0
fi

# Enumerate worktrees from the main checkout, always.
WORKTREES="$(git -C "$MAIN_ROOT" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')" || WORKTREES=""

adopted=()
divergent=()
identical=()
absent=()
errors=()

# SHA-256 of a file, or empty on any failure. Portable on purpose: `shasum` is
# the macOS spelling and `sha256sum` the GNU one, and this script ships to forks
# whose CI is Linux. A hash helper that silently returns nothing on the other
# platform would make every file classify as HASH_FAILED rather than fail loudly.
hash_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" 2>/dev/null | cut -d' ' -f1
  else
    echo ""
  fi
}

is_icloud_dupe() {
  # Same exclusion deliverables-push.sh uses: "foo 2.md" iCloud dupe artifacts.
  case "$(basename "$1")" in
    *\ [0-9].*|*\ [0-9][0-9].*) return 0 ;;
    *) return 1 ;;
  esac
}

while IFS= read -r wt; do
  [ -n "$wt" ] || continue
  [ "$wt" = "$MAIN_ROOT" ] && continue
  [ -d "$wt/deliverables" ] || continue

  # Dirty or untracked files under the worktree's deliverables/ only.
  # -uall is load-bearing: without it git collapses an untracked DIRECTORY to a
  # single `?? deliverables/foo/` entry, and a brand-new deliverable — the
  # primary rescue case — is never enumerated at all. Modified tracked files
  # list individually either way, which is why live worktrees looked fine.
  files="$(git -C "$wt" status --porcelain -uall -- deliverables/ 2>/dev/null | sed 's/^...//')" || files=""
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    # Strip quoting git applies to paths with spaces.
    rel="${rel%\"}"; rel="${rel#\"}"
    src="$wt/$rel"
    [ -f "$src" ] || continue
    is_icloud_dupe "$src" && continue

    dst="$MAIN_ROOT/$rel"
    entry="$(basename "$wt")::$rel"

    if [ ! -f "$dst" ]; then
      absent+=("$entry")
      if [ "$MODE" = "adopt" ]; then
        mkdir -p "$(dirname "$dst")" 2>/dev/null
        if cp "$src" "$dst" 2>/dev/null; then
          # Byte-verify the adoption by hash; never trust the copy silently.
          h1="$(hash_of "$src")"
          h2="$(hash_of "$dst")"
          if [ -n "$h1" ] && [ "$h1" = "$h2" ]; then
            adopted+=("$entry")
          else
            errors+=("$entry::HASH_MISMATCH_AFTER_COPY")
          fi
        else
          errors+=("$entry::COPY_FAILED")
        fi
      fi
      continue
    fi

    h1="$(hash_of "$src")"
    h2="$(hash_of "$dst")"
    if [ -z "$h1" ] || [ -z "$h2" ]; then
      errors+=("$entry::HASH_FAILED")
    elif [ "$h1" = "$h2" ]; then
      identical+=("$entry")
    else
      # NEVER TOUCH. Report both sizes so a human can judge which is canonical.
      s1="$(wc -c < "$src" 2>/dev/null | tr -d ' ')"
      s2="$(wc -c < "$dst" 2>/dev/null | tr -d ' ')"
      divergent+=("$entry::worktree=${s1}B::main=${s2}B")
    fi
  done <<< "$files"
done <<< "$WORKTREES"

json_arr() {
  if [ "$#" -eq 0 ]; then echo '[]'; return; fi
  python3 -c 'import json,sys;print(json.dumps(sys.argv[1:]))' "$@" 2>/dev/null || echo '[]'
}

printf '{"ok":true,"mode":"%s","adopted":%s,"absent_from_main":%s,"divergent":%s,"identical":%s,"errors":%s}\n' \
  "$MODE" \
  "$(json_arr ${adopted+"${adopted[@]}"})" \
  "$(json_arr ${absent+"${absent[@]}"})" \
  "$(json_arr ${divergent+"${divergent[@]}"})" \
  "$(json_arr ${identical+"${identical[@]}"})" \
  "$(json_arr ${errors+"${errors[@]}"})"
exit 0
