#!/usr/bin/env bash
# Regression tests for scripts/open-engine/deliverables-push.sh.
# Style: self-contained bash, PASS/FAIL counters, exit 1 on any failure.
#
# Runs entirely in a scratch sandbox: a bare "origin" repo + a working clone
# with the script copied in. Never touches the real Open Brain repo.
# Run:  bash scripts/open-engine/deliverables-push.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH_SCRIPT="$SCRIPT_DIR/deliverables-push.sh"
SANDBOX="$(mktemp -d /tmp/deliverables-push-test.XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

PASS=0
FAIL=0

check() { # $1 label, $2 condition-result (0 ok)
  if [ "$2" -eq 0 ]; then PASS=$((PASS+1)); echo "PASS: $1";
  else FAIL=$((FAIL+1)); echo "FAIL: $1"; fi
}

make_sandbox() {
  rm -rf "$SANDBOX/origin" "$SANDBOX/work"
  git init -q --bare "$SANDBOX/origin"
  git init -q "$SANDBOX/work"
  ( cd "$SANDBOX/work" \
    && git config user.email test@test && git config user.name test \
    && mkdir -p deliverables/test-slug scripts/open-engine \
    && cp "$PUSH_SCRIPT" scripts/open-engine/deliverables-push.sh \
    && echo base > README.md && git add -A && git commit -qm base \
    && git remote add origin "$SANDBOX/origin" \
    && git push -qu origin "$(git rev-parse --abbrev-ref HEAD)" )
}

run_push() { # $@ args; sets OUT and RC (never aborts the test run)
  RC=0
  OUT="$(cd "$SANDBOX/work" && DELIVERABLES_REPO_ROOT="$SANDBOX/work" \
    bash scripts/open-engine/deliverables-push.sh "$@")" || RC=$?
}

json_field() { # $1 field; reads $OUT
  python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1],""))' "$1" <<<"$OUT"
}

# --- 1. happy path: new file commits and pushes, JSON carries the SHA -------
make_sandbox
echo "draft body" > "$SANDBOX/work/deliverables/test-slug/abcd1234-draft.md"
run_push --task abcd1234
check "happy path reports pushed=true" "$([ "$(json_field pushed)" = "True" ]; echo $?)"
SHA="$(json_field commit)"
check "commit SHA present in JSON" "$([ -n "$SHA" ]; echo $?)"
check "commit reached origin" "$(git -C "$SANDBOX/origin" cat-file -e "$SHA" 2>/dev/null; echo $?)"
MSG="$(git -C "$SANDBOX/origin" log --format=%s -n1)"
check "commit message carries [OE:abcd1234]" "$(echo "$MSG" | grep -q '\[OE:abcd1234\]'; echo $?)"

# --- 2. only deliverables/ is staged ----------------------------------------
make_sandbox
echo "draft" > "$SANDBOX/work/deliverables/test-slug/x1-draft.md"
echo "SHOULD NOT COMMIT" > "$SANDBOX/work/stray.txt"
run_push --task x1
check "stray non-deliverables file left uncommitted" \
  "$(cd "$SANDBOX/work" && git status --porcelain | grep -q 'stray.txt'; echo $?)"

# --- 3. clean tree sweep is a no-op -----------------------------------------
make_sandbox
run_push --sweep
check "sweep on clean tree reports NOTHING_TO_COMMIT" \
  "$([ "$(json_field reason)" = "NOTHING_TO_COMMIT" ]; echo $?)"

# --- 4. secret shape refuses and unstages -----------------------------------
make_sandbox
printf 'api key: sk-abcdefgh12345678\n' > "$SANDBOX/work/deliverables/test-slug/bad-secret.md"
run_push --task bad1
check "secret shape reports SECRET_SHAPE_BLOCKED" \
  "$([ "$(json_field reason)" = "SECRET_SHAPE_BLOCKED" ]; echo $?)"
check "secret file NOT committed" \
  "$(cd "$SANDBOX/work" && ! git log --all --format=%s | grep -q 'OE:bad1'; echo $?)"
check "secret file still on disk for review" \
  "$([ -f "$SANDBOX/work/deliverables/test-slug/bad-secret.md" ]; echo $?)"

# --- 5. push failure fails open (commit local, pushed=false) ----------------
make_sandbox
echo "draft" > "$SANDBOX/work/deliverables/test-slug/y1-draft.md"
( cd "$SANDBOX/work" && git remote set-url origin "$SANDBOX/nonexistent-origin" )
run_push --task y1
check "push failure reports pushed=false" "$([ "$(json_field pushed)" = "False" ]; echo $?)"
check "push failure exit code is 0 (never fails the caller)" "$([ "$RC" -eq 0 ]; echo $?)"
check "commit exists locally despite failed push" \
  "$(cd "$SANDBOX/work" && git log --format=%s -n1 | grep -q '\[OE:y1\]'; echo $?)"

# --- 6. iCloud dupe files are excluded --------------------------------------
make_sandbox
echo real > "$SANDBOX/work/deliverables/test-slug/z1-real.md"
echo dupe > "$SANDBOX/work/deliverables/test-slug/z1-real 2.md"
run_push --task z1
check "iCloud ' 2.md' dupe not committed" \
  "$(cd "$SANDBOX/work" && ! git show --name-only HEAD | grep -q 'real 2.md'; echo $?)"
check "real file committed alongside excluded dupe" \
  "$(cd "$SANDBOX/work" && git show --name-only HEAD | grep -q 'z1-real.md'; echo $?)"
echo dupe10 > "$SANDBOX/work/deliverables/test-slug/z1-real 10.md"
run_push --task z1b
check "iCloud multi-digit ' 10.md' dupe not committed" \
  "$(cd "$SANDBOX/work" && ! git show --name-only HEAD | grep -q 'real 10.md'; echo $?)"

# --- 7. push REJECTED (rebase ok, push refused) fails open as pushed=false --
make_sandbox
# Non-bare origin with the branch checked out: fetch/rebase still work, but a
# push to a checked-out branch is refused (receive.denyCurrentBranch).
git clone -q "$SANDBOX/origin" "$SANDBOX/nonbare"
( cd "$SANDBOX/work" && git remote set-url origin "$SANDBOX/nonbare" )
echo draft > "$SANDBOX/work/deliverables/test-slug/p1-draft.md"
run_push --task p1
check "push-rejected reports pushed=false" "$([ "$(json_field pushed)" = "False" ]; echo $?)"
check "push-rejected commit exists locally" "$(cd "$SANDBOX/work" && git log --format=%s -n1 | grep -q '\[OE:p1\]'; echo $?)"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
