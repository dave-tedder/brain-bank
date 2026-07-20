#!/usr/bin/env bash
# Durability push for executor deliverables (spec 2026-07-19 GAP A, Phase 1).
#
# WHY THIS EXISTS: scheduled lanes emit one flat, statically-analyzable command
# (the closeout-run.sh precedent) — the harness blocks compound shell shapes
# BEFORE consulting permissions.allow, so all multi-step git logic must live
# inside a committed script the lane invokes as:
#   bash scripts/open-engine/deliverables-push.sh --task <shortid>
#   bash scripts/open-engine/deliverables-push.sh --sweep
#
# CONTRACT:
# - Stages ONLY deliverables/ (write-safe policy holds at the durability layer).
# - Refuses to commit staged content matching obvious secret shapes.
# - Commits as "deliverable: <files> [OE:<shortid>]" (or [OE:sweep]).
# - pull --rebase then push; a push failure NEVER fails the caller — the lane
#   records "@ UNPUSHED" in its receipt and the closeout sweep retries.
# - Prints exactly one JSON line on stdout. Never prints secret values.

set -euo pipefail

# Contract: after set -e, any UNEXPECTED command failure (index lock, hook,
# transient git error) still emits one JSON line and exits 0 — a scheduled
# lane must never see a bare nonzero. Explicit `exit 1` paths (usage, missing
# dir) do NOT trigger ERR and keep their own exit code; commands inside `if`
# conditions do not trigger it either.
trap 'printf "{\"pushed\":false,\"reason\":\"SCRIPT_ERROR\",\"detail\":\"unexpected git failure (exit %s)\"}\n" "$?"; exit 0' ERR

MODE=""
SHORTID=""
case "${1:-}" in
  --task)
    MODE="task"
    SHORTID="${2:-}"
    if [ -z "$SHORTID" ]; then
      echo '{"pushed":false,"reason":"USAGE","detail":"--task requires a shortid"}'
      exit 1
    fi
    ;;
  --sweep)
    MODE="sweep"
    SHORTID="sweep"
    ;;
  *)
    echo '{"pushed":false,"reason":"USAGE","detail":"usage: deliverables-push.sh --task <shortid> | --sweep"}'
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Repo root; DELIVERABLES_REPO_ROOT overrides for tests only.
ROOT="${DELIVERABLES_REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

if [ ! -d "$ROOT/deliverables" ]; then
  echo '{"pushed":false,"reason":"NO_DELIVERABLES_DIR"}'
  exit 1
fi

# Stage only deliverables/. Exclude iCloud dupe artifacts ("foo 2.md").
git -C "$ROOT" add -A -- 'deliverables/' ':(exclude)deliverables/**/* [0-9]*.*' ':(exclude)deliverables/* [0-9]*.*' >/dev/null

if git -C "$ROOT" diff --cached --quiet -- deliverables/; then
  echo '{"pushed":false,"reason":"NOTHING_TO_COMMIT"}'
  exit 0
fi

# Secret-shape guard on the staged diff. Deliverables are client-facing drafts;
# a secret in one is always a bug. Patterns are deliberately loose.
SECRET_PATTERNS='sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|sbp_[A-Za-z0-9]{10,}|x-brain-key[": ]+[A-Za-z0-9]'
if git -C "$ROOT" diff --cached -- deliverables/ | grep -qE "$SECRET_PATTERNS"; then
  # Unstage and leave the files on disk for attended review. Never print the match.
  git -C "$ROOT" reset -q -- deliverables/
  echo '{"pushed":false,"reason":"SECRET_SHAPE_BLOCKED","detail":"staged deliverables diff matched a secret pattern; unstaged for attended review"}'
  exit 0
fi

FILES="$(git -C "$ROOT" diff --cached --name-only -- deliverables/ | tr '\n' ' ' | sed 's/ $//')"
FILE_COUNT="$(git -C "$ROOT" diff --cached --name-only -- deliverables/ | grep -c . || true)"
SUMMARY="$FILES"
if [ "${#SUMMARY}" -gt 120 ]; then
  SUMMARY="$FILE_COUNT files"
fi

git -C "$ROOT" commit -q -m "deliverable: $SUMMARY [OE:$SHORTID]"
COMMIT_SHA="$(git -C "$ROOT" rev-parse HEAD)"
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"

FILES_JSON="$(git -C "$ROOT" show --name-only --pretty=format: HEAD -- deliverables/ | grep . | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')"

emit() {
  # $1 pushed "true"/"false", $2 reason ("" for none)
  python3 -c 'import json,sys; r=sys.argv[2]; o={"pushed":sys.argv[1]=="true","commit":sys.argv[3],"branch":sys.argv[4],"files":json.loads(sys.argv[5])};
if r: o["reason"]=r
print(json.dumps(o))' "$1" "$2" "$COMMIT_SHA" "$BRANCH" "$FILES_JSON"
}

# Rebase then push. Failures are reported, never fatal to the caller: the
# commit exists locally and the closeout sweep retries the push.
if ! git -C "$ROOT" pull --rebase -q >/dev/null 2>&1; then
  git -C "$ROOT" rebase --abort >/dev/null 2>&1 || true
  emit false "PUSH_FAILED_REBASE"
  exit 0
fi
# The rebase may have rewritten the commit; ours is the newest local commit, so it remains HEAD (race-free, no message-tag grep).
COMMIT_SHA="$(git -C "$ROOT" rev-parse HEAD)"

if git -C "$ROOT" push -q >/dev/null 2>&1; then
  emit true ""
else
  emit false "PUSH_FAILED"
fi
exit 0
