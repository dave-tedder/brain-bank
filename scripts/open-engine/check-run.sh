#!/usr/bin/env bash
# OE-13 Sub-phase B isolation wrapper (spec §4).
#
# WHY THIS EXISTS: the closeout controller (Fork A) re-runs a task packet's
# check_spec before applying a code task, and the check executes agent-produced
# code. Following the closeout-run.sh precedent, all compound logic
# (worktree create + env scrub + network deny + run + teardown) lives inside
# this script so the caller emits ONE flat, statically-analyzable command:
#
#   bash scripts/open-engine/check-run.sh --repo <path> --ref <sha> -- <argv...>
#
# Isolation guarantees (spec §4), enforced regardless of the check's verdict:
#   1. Isolated git worktree of the TARGET project at the receipt's CHECK-REF
#      commit — never the live working copy. Created and torn down per check.
#   2. Deny-by-default env allowlist: the check sees ONLY the vars exported in
#      the env -i block below. No BB_MCP_KEY, no SUPABASE_*, no other operator
#      credentials — even ones added to the shell in the future.
#   3. Outbound network denied via sandbox-exec. If sandbox-exec is missing,
#      this script REFUSES to run (exit 67) — it never falls back to
#      scrub-only. Fail closed.
#
# Exit codes (the controller maps these to hold reasons):
#   0        check passed
#   64       usage error                        -> CHECK_INFRA_USAGE
#   65       ref not found in repo              -> CHECK_REF_UNRESOLVED
#   66       worktree create failed             -> CHECK_INFRA_WORKTREE
#   67       sandbox-exec unavailable           -> CHECK_ISOLATION_UNAVAILABLE
#   68       runner binary missing on scrubbed PATH -> CHECK_RUNNER_MISSING
#   other    the check's own non-zero exit      -> EXECUTED_CHECK_FAILED
# Known, accepted collision: a check whose OWN exit code happens to be 64-68 is
# mapped to an infra reason. Still HELD, still fail-closed; only the label is
# imprecise.

set -euo pipefail

usage() {
  echo "usage: check-run.sh --repo <target-repo-path> --ref <40-hex-commit-sha> -- <runner argv...>" >&2
  exit 64
}

REPO=""
REF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) [ $# -ge 2 ] || usage; REPO="$2"; shift 2 ;;
    --ref)  [ $# -ge 2 ] || usage; REF="$2"; shift 2 ;;
    --) shift; break ;;
    *) usage ;;
  esac
done
[ -n "$REPO" ] || usage
[ -n "$REF" ] || usage
[ $# -ge 1 ] || usage
printf '%s' "$REF" | grep -Eq '^[0-9a-f]{40}$' || usage

SANDBOX_BIN="$(command -v sandbox-exec || true)"
if [ -z "$SANDBOX_BIN" ]; then
  echo "CHECK: sandbox-exec unavailable — refusing to run without network deny" >&2
  exit 67
fi

# The pinned PATH the check will actually see; probe the runner against it,
# not against the caller's richer PATH.
CHECK_PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if ! PATH="$CHECK_PATH" command -v "$1" >/dev/null 2>&1; then
  echo "CHECK: runner binary '$1' not found on scrubbed PATH" >&2
  exit 68
fi

if ! git -C "$REPO" rev-parse --verify --quiet "${REF}^{commit}" >/dev/null 2>&1; then
  echo "CHECK: ref $REF not found in $REPO" >&2
  exit 65
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/oe-check.XXXXXX")"
WT="$SCRATCH/wt"
cleanup() {
  git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true
  git -C "$REPO" worktree prune >/dev/null 2>&1 || true
  rm -rf "$SCRATCH" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$SCRATCH/home" "$SCRATCH/tmp" "$SCRATCH/deno" "$SCRATCH/npm"
if ! git -C "$REPO" worktree add --detach "$WT" "$REF" >/dev/null 2>&1; then
  echo "CHECK: worktree create failed" >&2
  exit 66
fi

cd "$WT"

# Deny-by-default env allowlist + network deny. The check sees ONLY these
# variables. HOME/TMPDIR/DENO_DIR/npm_config_cache point into the scratch dir
# so runners that write caches cannot touch the operator's real HOME.
set +e
env -i \
  PATH="$CHECK_PATH" \
  HOME="$SCRATCH/home" \
  TMPDIR="$SCRATCH/tmp" \
  DENO_DIR="$SCRATCH/deno" \
  npm_config_cache="$SCRATCH/npm" \
  CI=1 \
  NO_COLOR=1 \
  "$SANDBOX_BIN" -p '(version 1) (allow default) (deny network*)' \
  "$@"
CHECK_EXIT=$?
set -e

echo "CHECK-EXIT: $CHECK_EXIT"
exit "$CHECK_EXIT"
