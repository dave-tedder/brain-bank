#!/usr/bin/env bash
# Tests for worktree-rescue.sh (GAP C Track 4).
#
# The divergence-refusal test is the one that matters. Deliverables are
# client-facing drafts; a sweep that overwrites the wrong direction destroys
# live content. Everything else here is secondary to P4.2.
#
# Run: bash scripts/open-engine/worktree-rescue.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESCUE="$SCRIPT_DIR/worktree-rescue.sh"
MAIN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WT="$MAIN_ROOT/.claude/worktrees/gapc-probe-scratch"
SLUG="_gapc-test"
PASS=0; FAIL=0
hash_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" 2>/dev/null | cut -d' ' -f1
  else echo ""; fi
}

ok()   { PASS=$((PASS+1)); printf 'ok    %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

# Provision our own scratch worktree rather than depending on one existing. A
# suite that silently SKIPs is indistinguishable from a suite that passes, and
# this one guards the never-overwrite rule — the single most destructive thing
# in the design. It must actually run every time.
# Gate on git REGISTRATION, not on directory existence. A leftover directory
# from a previous run is not a worktree: `git worktree list` ignores it, git
# commands run inside it silently resolve to the MAIN repo (the path is
# gitignored), and every fixture written into it becomes invisible. That
# produced 8 phantom failures once already — the suite looked broken while the
# script under test was fine.
CREATED_WT=0
if ! git -C "$MAIN_ROOT" worktree list --porcelain 2>/dev/null | grep -qxF "worktree $WT"; then
  [ -e "$WT" ] && rm -rf "$WT"
  git -C "$MAIN_ROOT" worktree prune 2>/dev/null
  if git -C "$MAIN_ROOT" worktree add -q "$WT" --detach HEAD 2>/dev/null; then
    CREATED_WT=1
  else
    echo "FAIL: could not create scratch worktree at $WT"
    exit 1
  fi
fi
# Prove the fixture surface is real before asserting anything against it.
if ! git -C "$MAIN_ROOT" worktree list --porcelain 2>/dev/null | grep -qxF "worktree $WT"; then
  echo "FAIL: scratch worktree is not registered with git; aborting"
  exit 1
fi

# Fixture teardown only. Kept separate from the EXIT trap because calling the
# full cleanup up front would remove the scratch worktree we just created, and
# every fixture would then be written into a path that no longer exists.
clean_fixtures() {
  rm -rf "$WT/deliverables/$SLUG" "$MAIN_ROOT/deliverables/$SLUG" 2>/dev/null
  # A fork may ship no deliverables/ at all (it is created on first use), and
  # the fixtures above create one. rmdir removes it ONLY if empty, so a real
  # deliverables/ with content is never touched.
  rmdir "$MAIN_ROOT/deliverables" 2>/dev/null || true
  rmdir "$WT/deliverables" 2>/dev/null || true
}

cleanup() {
  clean_fixtures
  rm -f "${WT_COPY:-}" 2>/dev/null
  if [ "$CREATED_WT" = 1 ]; then
    # Only ever remove a worktree THIS test created, and only after confirming
    # it is clean. Never touch one that was already here.
    if [ -z "$(git -C "$WT" status --porcelain -uall 2>/dev/null)" ]; then
      git -C "$MAIN_ROOT" worktree remove "$WT" 2>/dev/null
      git -C "$MAIN_ROOT" worktree prune 2>/dev/null
    else
      echo "NOTE: left scratch worktree in place (not clean): $WT"
    fi
  fi
}
trap cleanup EXIT
clean_fixtures

mkdir -p "$WT/deliverables/$SLUG" "$MAIN_ROOT/deliverables/$SLUG"

# absent: worktree only
printf 'absent-from-main content\n' > "$WT/deliverables/$SLUG/absent.md"
# divergent: both sides, different content, MAIN LARGER (the dangerous direction)
printf 'short worktree version\n' > "$WT/deliverables/$SLUG/divergent.md"
printf 'much longer main version that must survive intact, byte for byte\n' > "$MAIN_ROOT/deliverables/$SLUG/divergent.md"
# identical: both sides, same content
printf 'same on both sides\n' > "$WT/deliverables/$SLUG/identical.md"
printf 'same on both sides\n' > "$MAIN_ROOT/deliverables/$SLUG/identical.md"
# iCloud dupe: worktree only, must be excluded
printf 'icloud dupe\n' > "$WT/deliverables/$SLUG/notes 2.md"

MAIN_DIVERGENT_HASH_BEFORE="$(hash_of "$MAIN_ROOT/deliverables/$SLUG/divergent.md")"

echo "--- P4.1 --report classifies without writing ---"
rep="$(bash "$RESCUE" --report)"
case "$rep" in *'"mode":"report"'*) ok "report mode reported" ;; *) bad "report mode: $rep" ;; esac
case "$rep" in *"$SLUG/absent.md"*)     ok "absent.md classified" ;;   *) bad "absent.md not seen" ;; esac
case "$rep" in *"$SLUG/divergent.md"*)  ok "divergent.md classified" ;;*) bad "divergent.md not seen" ;; esac
case "$rep" in *'"adopted":[]'*)        ok "report adopted nothing" ;; *) bad "report adopted something!" ;; esac
if [ -f "$MAIN_ROOT/deliverables/$SLUG/absent.md" ]; then bad "report COPIED a file (must not write)"; else ok "report wrote nothing to main"; fi

echo
echo "--- P4.5 iCloud dupe excluded ---"
case "$rep" in *"notes 2.md"*) bad "iCloud dupe was not excluded" ;; *) ok "iCloud dupe excluded" ;; esac

echo
echo "--- P4.2 DIVERGENCE REFUSAL (the load-bearing test) ---"
adopt="$(bash "$RESCUE" --adopt)"
MAIN_DIVERGENT_HASH_AFTER="$(hash_of "$MAIN_ROOT/deliverables/$SLUG/divergent.md")"
if [ "$MAIN_DIVERGENT_HASH_BEFORE" = "$MAIN_DIVERGENT_HASH_AFTER" ]; then
  ok "main's divergent copy is byte-unchanged after --adopt"
else
  bad "MAIN'S DIVERGENT COPY WAS OVERWRITTEN — script is unshippable"
fi
case "$adopt" in *'"divergent":['*"$SLUG/divergent.md"*) ok "divergent reported, not adopted" ;; *) bad "divergent not reported" ;; esac
# Parse the JSON rather than globbing: a glob for '"adopted":[' followed by the
# filename matches across the WHOLE string and false-positives on the later
# "divergent" array. Ask the actual array.
if printf '%s' "$adopt" | python3 -c 'import json,sys; sys.exit(0 if not any("divergent.md" in x for x in json.load(sys.stdin)["adopted"]) else 1)' 2>/dev/null; then
  ok "divergent absent from the adopted array (JSON-parsed)"
else
  bad "divergent appeared in the adopted array"
fi

echo
echo "--- P4.3 absent-from-main is adopted and hash-verified ---"
if [ -f "$MAIN_ROOT/deliverables/$SLUG/absent.md" ]; then ok "absent.md adopted into main"; else bad "absent.md not adopted"; fi
h1="$(hash_of "$WT/deliverables/$SLUG/absent.md")"
h2="$(hash_of "$MAIN_ROOT/deliverables/$SLUG/absent.md")"
if [ -n "$h2" ] && [ "$h1" = "$h2" ]; then ok "adopted copy is byte-identical"; else bad "adopted copy hash mismatch"; fi
case "$adopt" in *'"adopted":['*"$SLUG/absent.md"*) ok "absent.md in adopted list" ;; *) bad "absent.md missing from adopted list" ;; esac

echo
echo "--- P4.4 identical is a no-op ---"
case "$adopt" in *'"identical":['*"$SLUG/identical.md"*) ok "identical classified as identical" ;; *) bad "identical misclassified" ;; esac

echo
echo "--- P4.6 never deletes from the worktree ---"
allpresent=1
for f in absent.md divergent.md identical.md "notes 2.md"; do
  [ -f "$WT/deliverables/$SLUG/$f" ] || { allpresent=0; echo "      missing: $f"; }
done
if [ "$allpresent" = 1 ]; then ok "every worktree file still present after --adopt"; else bad "a worktree file was removed"; fi

echo
echo "--- P4.7 resolves main regardless of cwd (never operates on the worktree tree) ---"
# Copy ONLY the one file, and remove ONLY that file afterwards. An earlier
# version did `rm -rf "$WT/scripts"`, which deleted the worktree's TRACKED
# scripts/ directory wholesale (59 files showed as deleted). Never rm -rf a
# path in a worktree that you did not create.
mkdir -p "$WT/scripts/open-engine"
WT_COPY="$WT/scripts/open-engine/worktree-rescue.probe.sh"
cp "$RESCUE" "$WT_COPY"
from_wt="$(cd "$WT" && bash "$WT_COPY" --report)"
# Invoked via the WORKTREE's own copy, from inside the worktree. It must still
# enumerate worktrees from main and classify against main — the exact failure
# deliverables-push.sh has (spec ground truth item 6).
case "$from_wt" in
  *"$SLUG/divergent.md"*) ok "worktree-invoked copy still classified against main" ;;
  *) bad "worktree-invoked copy resolved the wrong root: $from_wt" ;;
esac
case "$from_wt" in *'"ok":true'*) ok "worktree-invoked copy returned ok" ;; *) bad "worktree-invoked copy errored" ;; esac
rm -f "$WT_COPY"
if [ -z "$(git -C "$WT" status --porcelain -- scripts/ 2>/dev/null)" ]; then
  ok "worktree scripts/ left clean by the probe"
else
  bad "probe left the worktree's scripts/ dirty"
fi

echo
echo "--- guard: script contains no destructive verbs ---"
if grep -nE 'worktree +remove|rm +-rf +"?\$(WT|wt)|git +clean' "$RESCUE" >/dev/null 2>&1; then
  bad "script contains a destructive verb"
else
  ok "no 'worktree remove', no worktree rm -rf, no git clean"
fi

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" = 0 ]
