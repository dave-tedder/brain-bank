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

# --- 8-13. retry of commits an earlier run left unpushed --------------------
# Each case first proves its own precondition: the commit really is unpushed.
local_commit() { # $1 path, $2 body, $3 message; commits without pushing
  mkdir -p "$(dirname "$SANDBOX/work/$1")"
  printf '%s\n' "$2" > "$SANDBOX/work/$1"
  ( cd "$SANDBOX/work" && git add -- "$1" && git commit -qm "$3" )
}
ahead() { git -C "$SANDBOX/work" rev-list --count '@{u}..HEAD'; }
on_origin() { git -C "$SANDBOX/origin" cat-file -e "$1" 2>/dev/null; }
origin_tip() { git -C "$SANDBOX/origin" log --format=%H -n1 --all; }
head_sha() { git -C "$SANDBOX/work" rev-parse HEAD; }

# 8. The 2026-11-23 incident end to end: a deleted tracked file blocks the
# rebase, the commit sticks, the sweep NAMES the failure, then repairs it.
make_sandbox
rm "$SANDBOX/work/README.md"
echo draft > "$SANDBOX/work/deliverables/test-slug/s1-draft.md"
run_push --task s1
check "dirty tracked file: task run reports PUSH_FAILED_REBASE" \
  "$([ "$(json_field reason)" = "PUSH_FAILED_REBASE" ]; echo $?)"
check "precondition: one commit is stuck locally" "$([ "$(ahead)" -eq 1 ]; echo $?)"
run_push --sweep
check "sweep with the tree still dirty reports PUSH_FAILED_REBASE, not a quiet night" \
  "$([ "$(json_field reason)" = "PUSH_FAILED_REBASE" ]; echo $?)"
check "failed retry still exits 0" "$([ "$RC" -eq 0 ]; echo $?)"
( cd "$SANDBOX/work" && git checkout -q -- README.md )
run_push --sweep
check "sweep after the tree is clean reports pushed=true" "$([ "$(json_field pushed)" = "True" ]; echo $?)"
check "stuck commit reached origin" "$(on_origin "$(head_sha)"; echo $?)"
check "retry names the stuck file" \
  "$([ "$(json_field files)" = "['deliverables/test-slug/s1-draft.md']" ]; echo $?)"
check "retry reports the pushed SHA" "$([ "$(json_field commit)" = "$(origin_tip)" ]; echo $?)"

# 9. Retry still works when origin moved on underneath the stuck commit.
make_sandbox
local_commit deliverables/test-slug/r1.md body "deliverable: r1 [OE:r1]"
rm -rf "$SANDBOX/other" && git clone -q "$SANDBOX/origin" "$SANDBOX/other"
( cd "$SANDBOX/other" && git config user.email o@o && git config user.name o \
  && echo moved > moved.txt && git add -A && git commit -qm moved && git push -q )
run_push --sweep
check "retry rebases onto a moved origin and pushes" "$([ "$(json_field pushed)" = "True" ]; echo $?)"
check "moved-origin retry: the reported SHA is the rebased tip" \
  "$([ "$(json_field commit)" = "$(origin_tip)" ] && on_origin "$(head_sha)"; echo $?)"

# 10. A commit outside deliverables/ is never published by the sweep. The mixed
# range holds a deliverable commit too, so "some path matched" is not enough.
make_sandbox
BEFORE="$(origin_tip)"
local_commit deliverables/test-slug/m1.md body "deliverable: m1 [OE:m1]"
local_commit src/code.txt wip "wip: not for publishing"
run_push --sweep
check "precondition: two commits unpushed" "$([ "$(ahead)" -eq 2 ]; echo $?)"
check "mixed range reports NOTHING_TO_COMMIT" "$([ "$(json_field reason)" = "NOTHING_TO_COMMIT" ]; echo $?)"
check "mixed range says what it left alone" \
  "$(json_field detail | grep -q '^2 unpushed commit(s) left alone'; echo $?)"
check "mixed range: origin untouched" "$([ "$(origin_tip)" = "$BEFORE" ]; echo $?)"

# 11. A file MOVED in from outside is an outside change (rename detection off).
make_sandbox
BEFORE="$(origin_tip)"
( cd "$SANDBOX/work" && git mv README.md deliverables/test-slug/moved.md && git commit -qm "move" )
run_push --sweep
check "move into deliverables/ is not retried" \
  "$([ "$(json_field reason)" = "NOTHING_TO_COMMIT" ] && [ "$(origin_tip)" = "$BEFORE" ]; echo $?)"

# 12. A merge is not retried, even one whose parents touch only deliverables/.
make_sandbox
BEFORE="$(origin_tip)"
MAINBR="$(git -C "$SANDBOX/work" rev-parse --abbrev-ref HEAD)"
( cd "$SANDBOX/work" && git checkout -qb side )
local_commit deliverables/test-slug/side.md body "side"
( cd "$SANDBOX/work" && git checkout -q "$MAINBR" && git merge -q --no-ff -m merge side )
run_push --sweep
check "merge commit is not retried" \
  "$([ "$(json_field reason)" = "NOTHING_TO_COMMIT" ] && [ "$(origin_tip)" = "$BEFORE" ]; echo $?)"

# 13. Secret shapes. The first secret is added and then removed by a later
# commit, so only a per-commit scan sees it (the net diff is clean).
make_sandbox
BEFORE="$(origin_tip)"
local_commit deliverables/test-slug/k.md 'key sk-abcdefgh12345678' "deliverable: k [OE:k]"
local_commit deliverables/test-slug/k.md 'key removed' "deliverable: k [OE:k2]"
run_push --sweep
check "secret in an unpushed commit blocks the retry" \
  "$([ "$(json_field reason)" = "SECRET_SHAPE_BLOCKED" ] && [ "$(origin_tip)" = "$BEFORE" ]; echo $?)"
check "blocked retry never prints the secret" "$(! grep -q 'sk-abcdefgh' <<<"$OUT"; echo $?)"

# 14. Large diffs (past any pipe buffer), secret on the FIRST line: new files,
# then an already-committed one. `git diff | grep -q` under pipefail passed both.
big_secret() { printf 'key sk-abcdefgh12345678\n'; python3 -c "print('filler line of text\n'*40000)"; }
make_sandbox
big_secret > "$SANDBOX/work/deliverables/test-slug/big.md"
run_push --task big
check "secret in a large new file is blocked" \
  "$([ "$(json_field reason)" = "SECRET_SHAPE_BLOCKED" ]; echo $?)"
make_sandbox
BEFORE="$(origin_tip)"
local_commit deliverables/test-slug/big.md "$(big_secret)" "deliverable: big [OE:big]"
run_push --sweep
check "secret in a large unpushed commit is blocked" \
  "$([ "$(json_field reason)" = "SECRET_SHAPE_BLOCKED" ] && [ "$(origin_tip)" = "$BEFORE" ]; echo $?)"

# 15. No upstream: quiet no-op, not a script error.
make_sandbox
( cd "$SANDBOX/work" && git branch --unset-upstream )
run_push --sweep
check "no upstream reports NOTHING_TO_COMMIT" "$([ "$(json_field reason)" = "NOTHING_TO_COMMIT" ]; echo $?)"

# 16. An empty commit carries no deliverable, so there is nothing to retry.
make_sandbox
BEFORE="$(origin_tip)"
( cd "$SANDBOX/work" && git commit -q --allow-empty -m empty )
run_push --sweep
check "empty commit is not retried" \
  "$([ "$(json_field reason)" = "NOTHING_TO_COMMIT" ] && [ "$(origin_tip)" = "$BEFORE" ]; echo $?)"

# 17. A non-ASCII deliverable name is still inside deliverables/ (git quotes
# such paths by default, which would read as an outside path and stay stuck).
make_sandbox
local_commit "deliverables/test-slug/koi-鯉.md" body "deliverable: koi [OE:koi]"
run_push --sweep
check "non-ASCII filename is retried and named" \
  "$([ "$(json_field pushed)" = "True" ] && [ "$(json_field files)" = "['deliverables/test-slug/koi-鯉.md']" ]; echo $?)"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
