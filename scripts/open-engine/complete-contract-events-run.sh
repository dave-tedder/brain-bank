#!/bin/bash
# Task 5.4 follow-up (PR 32 decision 7): run every check for the
# complete_contract_events change and write a compact summary.
#
#   bash scripts/open-engine/complete-contract-events-run.sh --out <dir> [--mode full|baseline]
#
# full (default): type check, the full Deno suite, the Node Open Engine suite,
#   PR 32's probe (P1 to P7), the new probe (Q1 to Q10) and its two control
#   cases, the TypeScript planted faults, PR 32's planted-fault runner, the SQL
#   harness, its planted faults and its control cases.
# baseline: only the type check, the Deno suite and the Node suite (for a
#   checkout without this change; OBCE_ROOT points at it).
#
# Every step's full output goes to <dir>/logs/<step>.log; <dir>/summary.txt has
# one line per step: step, exit, verdict, counts, log. A step's verdict is
# PASS, FAIL (a completed check failed) or NEVER-RAN; the runner exits 0 when
# every step reads as expected, 1 when a step FAILED, 2 when one NEVER-RAN.
# The Node suite needs scripts/open-engine/project-closeout-registry.json,
# which is gitignored; the runner records whether it is present.
export LC_ALL=C
set -u
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${OBCE_ROOT:-$(cd "$SELF_DIR/../.." && pwd)}"
OUT=""; MODE=full
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2;;
    --mode) MODE="$2"; shift 2;;
    *) echo "unknown argument $1"; exit 2;;
  esac
done
[ -n "$OUT" ] || { echo "--out <dir> is required"; exit 2; }
mkdir -p "$OUT/logs"
SUM="$OUT/summary.txt"
cd "$ROOT" || { echo "NEVER-RAN: cannot cd to $ROOT"; exit 2; }
DEADLINE_PY="$ROOT/scripts/loop-closing/deadline.py"
[ -f "$DEADLINE_PY" ] || DEADLINE_PY="$SELF_DIR/../loop-closing/deadline.py"
strip() { sed -E $'s/\x1b\\[[0-9;]*m//g' "$1"; }
worst=0
note() { # step exit verdict counts
  printf '%-22s exit=%-3s %-9s %s | log logs/%s.log\n' "$1" "$2" "$3" "$4" "$1" >> "$SUM"
  case "$3" in FAIL) [ "$worst" -lt 1 ] && worst=1;; NEVER-RAN) worst=2;; esac
}
runlog() { # step deadline-seconds command...
  local step="$1" secs="$2"; shift 2
  printf '$ %s\n' "$*" > "$OUT/logs/$step.log"
  python3 "$DEADLINE_PY" "$secs" "$@" >> "$OUT/logs/$step.log" 2>&1
}

{
  echo "complete_contract_events check run, mode $MODE"
  echo "root $ROOT"
  echo "head $(git rev-parse HEAD 2>/dev/null) ($(git rev-parse --abbrev-ref HEAD 2>/dev/null))"
  echo "started $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$(deno --version | head -1); node $(node --version); $(psql --version)"
  if [ -f scripts/open-engine/project-closeout-registry.json ]; then echo "registry: present (gitignored, copied from the main checkout for the Node suite)"; else echo "registry: absent"; fi
  echo "ipcs -m segments before: $(ipcs -m 2>/dev/null | grep -c '^m')"
  echo
} > "$SUM"

ENTRY="supabase/functions/ingest-thought/index.ts supabase/functions/open-brain-mcp/index.ts supabase/functions/external-crm-sync/index.ts supabase/functions/brain-digest/index.ts supabase/functions/action-item-recheck/index.ts"
EXTRA=""
[ "$MODE" = full ] && EXTRA="scripts/open-engine/complete-contract-events-probe-harness.ts"
# shellcheck disable=SC2086
runlog 01-deno-check 600 deno check $ENTRY $EXTRA; c=$?
if [ "$c" = 0 ]; then note 01-deno-check "$c" PASS "$(echo $ENTRY $EXTRA | wc -w | tr -d ' ') files"
elif strip "$OUT/logs/01-deno-check.log" | grep -q "TS[0-9]"; then note 01-deno-check "$c" FAIL "type errors"
else note 01-deno-check "$c" NEVER-RAN "no type-check result"; fi

runlog 02-deno-suite 900 deno test --no-lock --allow-read --allow-env supabase/functions/_shared supabase/functions/open-brain-mcp supabase/functions/brain-digest supabase/functions/action-item-recheck supabase/functions/external-crm-sync; c=$?
line=$(strip "$OUT/logs/02-deno-suite.log" | grep -E '^(ok|FAILED) \| [0-9]+ passed' | tail -1)
if [ "$c" = 0 ] && [ "${line%% *}" = ok ]; then note 02-deno-suite "$c" PASS "$line"
elif [ -n "$line" ]; then note 02-deno-suite "$c" FAIL "$line"
else note 02-deno-suite "$c" NEVER-RAN "no summary line"; fi

runlog 03-node-open-engine 900 bash -c 'node --test scripts/open-engine/*.test.mjs'; c=$?
p=$(grep -E '^ℹ pass ' "$OUT/logs/03-node-open-engine.log" | awk '{print $3}'); f=$(grep -E '^ℹ fail ' "$OUT/logs/03-node-open-engine.log" | awk '{print $3}')
if [ -z "$p" ]; then note 03-node-open-engine "$c" NEVER-RAN "no summary"
elif [ "$c" = 0 ] && [ "$f" = 0 ]; then note 03-node-open-engine "$c" PASS "$p passed, $f failed"
else note 03-node-open-engine "$c" FAIL "$p passed, $f failed"; fi

if [ "$MODE" = full ]; then
  PROBE_CFG="scripts/loop-closing/closeout-capture-probe.deno.json"
  runlog 04-pr32-probe 300 deno run --config "$PROBE_CFG" --no-lock --allow-net --allow-env --allow-read scripts/open-engine/complete-contract-probe-harness.ts; c=$?
  case "$c" in 0) note 04-pr32-probe 0 PASS "$(grep -c '^PASS P' "$OUT/logs/04-pr32-probe.log") probes (P1 to P7)";; 1) note 04-pr32-probe 1 FAIL "$(grep -m1 '^FAIL' "$OUT/logs/04-pr32-probe.log")";; *) note 04-pr32-probe "$c" NEVER-RAN "$(grep -m1 '^NEVER' "$OUT/logs/04-pr32-probe.log")";; esac

  runlog 05-events-probe 300 deno run --config "$PROBE_CFG" --no-lock --allow-net --allow-env --allow-read scripts/open-engine/complete-contract-events-probe-harness.ts; c=$?
  case "$c" in 0) note 05-events-probe 0 PASS "$(grep -c '^PASS Q' "$OUT/logs/05-events-probe.log") probes (Q1 to Q13)";; 1) note 05-events-probe 1 FAIL "$(grep -m1 '^FAIL' "$OUT/logs/05-events-probe.log")";; *) note 05-events-probe "$c" NEVER-RAN "$(grep -m1 '^NEVER' "$OUT/logs/05-events-probe.log")";; esac

  ok=0
  for inj in module-missing bad-port; do
    printf '$ OBCE_PROBE_INJECT=%s deno run ... complete-contract-events-probe-harness.ts\n' "$inj" >> "$OUT/logs/06-probe-controls.log"
    OBCE_PROBE_INJECT=$inj python3 "$DEADLINE_PY" 300 deno run --config "$PROBE_CFG" --no-lock --allow-net --allow-env --allow-read scripts/open-engine/complete-contract-events-probe-harness.ts >> "$OUT/logs/06-probe-controls.log" 2>&1; c=$?
    echo "exit $c" >> "$OUT/logs/06-probe-controls.log"
    [ "$c" = 2 ] && ok=$((ok + 1))
  done
  if [ "$ok" = 2 ]; then note 06-probe-controls 0 PASS "2 of 2 control cases read NEVER-RAN (exit 2)"; else note 06-probe-controls 1 FAIL "$ok of 2 control cases read NEVER-RAN"; fi

  runlog 07-ts-faults 1800 python3 scripts/open-engine/complete-contract-events-mutants.py; c=$?
  s=$(grep -m1 '^SWEEP' "$OUT/logs/07-ts-faults.log")
  case "$c" in 0) note 07-ts-faults 0 PASS "$s; 3 of 3 controls as expected";; 1) note 07-ts-faults 1 FAIL "$s";; *) note 07-ts-faults "$c" NEVER-RAN "${s:-$(grep -m1 NEVER-RAN "$OUT/logs/07-ts-faults.log")}";; esac

  # receipt-shape-parity.mjs compares against the controller as it was BEFORE
  # the contract moved into the shared module (Brain Bank 6f4f420a, the commit
  # before that port); the current controller imports that module and cannot
  # serve as "old".
  git show 6f4f420adb3890c8bfb0b4e6ca94a51f89b1a7a2:scripts/open-engine/closeout-controller.mjs > "$OUT/old-closeout-controller.mjs" 2>/dev/null
  runlog 08-pr32-faults 3000 node scripts/open-engine/receipt-contract-mutants.mjs --old "$OUT/old-closeout-controller.mjs"; c=$?
  s=$(grep -E -m1 '^(SWEEP|ALL|[0-9]+ of [0-9]+)' "$OUT/logs/08-pr32-faults.log"); s=${s:-$(tail -1 "$OUT/logs/08-pr32-faults.log")}
  case "$c" in 0) note 08-pr32-faults 0 PASS "$s";; 1) note 08-pr32-faults 1 FAIL "$s";; *) note 08-pr32-faults "$c" NEVER-RAN "$s";; esac
  rm -f "$OUT/old-closeout-controller.mjs"

  echo "ipcs -m before SQL steps: $(ipcs -m 2>/dev/null | grep -c '^m') segments" >> "$OUT/logs/09-sql-harness.log"
  ipcs -m >> "$OUT/logs/ipcs-before-sql.txt" 2>&1
  printf '$ bash scripts/open-engine/complete-contract-events-sql-test.sh\n' >> "$OUT/logs/09-sql-harness.log"
  python3 "$DEADLINE_PY" 900 bash scripts/open-engine/complete-contract-events-sql-test.sh >> "$OUT/logs/09-sql-harness.log" 2>&1; c=$?
  case "$c" in 0) note 09-sql-harness 0 PASS "$(grep -c '^PASS T' "$OUT/logs/09-sql-harness.log") checks (T01 to T05), $(grep -c '^SKIP T' "$OUT/logs/09-sql-harness.log") skipped: $(grep '^SKIP T' "$OUT/logs/09-sql-harness.log" | sed -E 's/: .*//' | tr '\n' ' ')";; 1) note 09-sql-harness 1 FAIL "$(grep -m1 '^FAIL' "$OUT/logs/09-sql-harness.log")";; *) note 09-sql-harness "$c" NEVER-RAN "$(grep -m1 'NEVER-RAN' "$OUT/logs/09-sql-harness.log")";; esac

  runlog 10-sql-faults 3000 bash scripts/open-engine/complete-contract-events-sql-test.sh --all-mutations; c=$?
  s=$(grep -m1 '^SWEEP' "$OUT/logs/10-sql-faults.log")
  case "$c" in 0) note 10-sql-faults 0 PASS "$s";; 1) note 10-sql-faults 1 FAIL "$s";; *) note 10-sql-faults "$c" NEVER-RAN "${s:-$(grep -m1 NEVER-RAN "$OUT/logs/10-sql-faults.log")}";; esac

  runlog 11-sql-controls 3000 bash scripts/open-engine/complete-contract-events-sql-test.sh --inject-selftest; c=$?
  s=$(grep -m1 '^CONTROLS' "$OUT/logs/11-sql-controls.log")
  case "$c" in 0) note 11-sql-controls 0 PASS "$s";; 1) note 11-sql-controls 1 FAIL "$s";; *) note 11-sql-controls "$c" NEVER-RAN "${s:-$(tail -1 "$OUT/logs/11-sql-controls.log")}";; esac
  ipcs -m >> "$OUT/logs/ipcs-after-sql.txt" 2>&1
fi

{
  echo
  echo "ipcs -m segments after: $(ipcs -m 2>/dev/null | grep -c '^m')"
  echo "finished $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "overall exit $worst (0 every step as expected, 1 a step FAILED, 2 a step NEVER-RAN)"
} >> "$SUM"
cat "$SUM"
exit "$worst"
