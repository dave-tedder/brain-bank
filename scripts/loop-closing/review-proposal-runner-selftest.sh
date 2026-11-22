#!/bin/bash
# PR 23 review F3: test the runner's OWN outcome classification, so a timeout or an
# incomplete execution can never be reported as a caught mutation.
#
#   bash scripts/loop-closing/review-proposal-runner-selftest.sh
#
# Exit 0 "RUNNER SELFTEST PASSED", 1 on the first failed check, 2 "RUNNER SELFTEST
# INCOMPLETE" when every check that ran passed but the real-cluster check could
# not start its cluster (initdb or pg start failed), so its kill path was never
# exercised. That is NEVER-RAN, never a pass and never a failed assertion. Uses the real
# function bodies extracted from review-proposal-sql-test.sh (not copies), fake
# mutant commands for the sweep, and one REAL throwaway cluster killed mid-run by
# its per-mutant deadline to prove the cluster and its processes are cleaned up.
export LC_ALL=C
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNNER="$HERE/review-proposal-sql-test.sh"
T="$(mktemp -d /tmp/obrp-selftest.XXXXXX)"
trap 'rm -rf "$T"' EXIT
n=0
ok() { n=$((n + 1)); echo "PASS S$n $1"; }
bad() { echo "FAIL selftest: $1"; exit 1; }

# The runner's own definitions of these functions, verbatim.
extract() { awk -v f="$1() {" 'index($0, f) == 1 { on = 1 } on { print } on && /^}$/ { exit }' "$RUNNER"; }
for f in never fail sync_conn q wait_blocked classify; do
  extract "$f" > "$T/fn_$f.sh"
  [ -s "$T/fn_$f.sh" ] || bad "could not extract $f() from the runner"
done

# 1. sync_conn on a connection that never completes (Codex's timeout-classifier
#    schedule): must be exit 2 NEVER-RAN, not exit 1.
out=$(bash -c "WORK='$T'; SEQ=0; OBRP_SYNC_TICKS=10; send() { :; }; . '$T/fn_never.sh'; . '$T/fn_sync_conn.sh'; sync_conn A" 2>&1); code=$?
[ "$code" = 2 ] && echo "$out" | grep -q '^NEVER-RAN: connection A did not finish' && ! echo "$out" | grep -q '^FAIL' \
  || bad "sync_conn timeout: expected exit 2 NEVER-RAN, got $code: $out"
ok "a connection that never completes is NEVER-RAN (exit 2), never FAIL"

# 2. wait_blocked: never seen waiting AND the statement never completes -> NEVER-RAN.
out=$(bash -c "WORK='$T'; SEQ=0; OBRP_SYNC_TICKS=10; send() { :; }; blocked_count() { echo 0; }; sleep() { :; }
  . '$T/fn_never.sh'; . '$T/fn_fail.sh'; . '$T/fn_sync_conn.sh'; . '$T/fn_wait_blocked.sh'; wait_blocked B 'X'" 2>&1); code=$?
[ "$code" = 2 ] && echo "$out" | grep -q '^NEVER-RAN' || bad "wait_blocked + stalled connection: expected NEVER-RAN, got $code: $out"
ok "never seen waiting and never completed is NEVER-RAN"

# 3. wait_blocked: never seen waiting but the statement DID complete -> a real FAIL.
out=$(bash -c "WORK='$T'; SEQ=100; OBRP_SYNC_TICKS=10; send() { case \"\$2\" in '\\! touch '*) touch \"\${2#\\\\! touch }\";; esac; }; blocked_count() { echo 0; }
  . '$T/fn_never.sh'; . '$T/fn_fail.sh'; . '$T/fn_sync_conn.sh'; . '$T/fn_wait_blocked.sh'; wait_blocked B 'C1 label'" 2>&1); code=$?
[ "$code" = 1 ] && echo "$out" | grep -q '^FAIL C1 label: connection B completed without ever waiting' || bad "wait_blocked + completed: expected FAIL exit 1, got $code: $out"
ok "completed without waiting is a behavioral FAIL (exit 1)"

# 4. A helper query that cannot connect turns the next check into NEVER-RAN.
out=$(bash -c "WORK='$T/q'; mkdir -p \"\$WORK\"; PSQL=(psql -X -h 127.0.0.1 -p 1 -U postgres -q)
  . '$T/fn_never.sh'; . '$T/fn_fail.sh'; . '$T/fn_q.sh'
  [ \"\$(q 'select 1')\" = 1 ] || fail 'the value check'" 2>&1); code=$?
[ "$code" = 2 ] && echo "$out" | grep -q '^NEVER-RAN: a helper query could not connect while checking: the value check' \
  || bad "q connection failure: expected NEVER-RAN, got $code: $out"
ok "a check made on a helper query that could not connect is NEVER-RAN"

# 5. The sweep classifier, with fake mutant runs covering every outcome.
cat > "$T/fake-mutant.sh" <<'FAKE'
#!/bin/bash
case "$2" in
  pass) echo "REVIEW PROPOSAL TEST COMPLETE"; exit 0;;
  assert_fail) echo "FAIL C2: the inversion did not occur"; exit 1;;
  sql_error) echo "ERROR: FAIL T38 decision_ref: zero business writes"; exit 1;;
  bare_exit1) echo "something died"; exit 1;;
  setup) echo "NEVER-RAN: initdb failed"; exit 2;;
  hang)
    w=$(mktemp -d /tmp/obrp.XXXXXX); mkdir -p "$w/pg"; [ -n "${OBRP_STATE_FILE:-}" ] && echo "$w" > "$OBRP_STATE_FILE"
    echo "$w" > "$SELFTEST_DIR/hang.work"
    sleep 300 & echo $! > "$SELFTEST_DIR/hang.child"
    wait;;
esac
FAKE
out=$(SELFTEST_DIR="$T" OBRP_MUTANT_CMD="bash $T/fake-mutant.sh" OBRP_MUTATIONS="pass assert_fail sql_error bare_exit1 setup hang" OBRP_MUTANT_DEADLINE=3 \
  bash "$RUNNER" --all-mutations 2>&1); code=$?
echo "$out" | sed 's/^/    /'
echo "$out" | grep -q '^SURVIVED  pass$' || bad "pass must be SURVIVED"
echo "$out" | grep -q '^CAUGHT    assert_fail: FAIL C2' || bad "a completed assertion failure must be CAUGHT"
echo "$out" | grep -q '^CAUGHT    sql_error: ERROR: FAIL T38' || bad "a completed SQL check failure must be CAUGHT"
echo "$out" | grep -q '^NEVER-RAN bare_exit1: exit 1 with no completed FAIL/ERROR line' || bad "exit 1 without a FAIL line must be NEVER-RAN"
echo "$out" | grep -q '^NEVER-RAN setup (exit 2)' || bad "exit 2 must be NEVER-RAN"
echo "$out" | grep -q '^NEVER-RAN hang: deadline of 3s exceeded' || bad "a hung mutant must be NEVER-RAN by deadline"
echo "$out" | grep -q '^SWEEP: 6 mutations, 2 caught, 1 survived, 3 never ran$' || bad "sweep tally"
[ "$code" = 2 ] || bad "a sweep with NEVER-RAN mutants must exit 2, got $code"
ok "the sweep classifies pass/assert/sql-error/bare-exit-1/setup/hang as SURVIVED/CAUGHT/CAUGHT/NEVER-RAN/NEVER-RAN/NEVER-RAN and exits 2"
child=$(cat "$T/hang.child" 2>/dev/null)
[ -n "$child" ] && ! kill -0 "$child" 2>/dev/null || bad "the hung mutant's child process $child survived the deadline"
[ ! -e "$(cat "$T/hang.work")" ] || bad "the hung mutant's work directory was not reaped"
ok "the deadline killed the hung mutant's own child process and reaped its work directory"

out=$(OBRP_MUTANT_CMD="bash $T/fake-mutant.sh" OBRP_MUTATIONS="assert_fail" bash "$RUNNER" --all-mutations 2>&1); code=$?
[ "$code" = 0 ] && echo "$out" | grep -q '^ALL 1 MUTATIONS CAUGHT$' || bad "an all-caught sweep must exit 0, got $code: $out"
out=$(OBRP_MUTANT_CMD="bash $T/fake-mutant.sh" OBRP_MUTATIONS="assert_fail pass" bash "$RUNNER" --all-mutations 2>&1); code=$?
[ "$code" = 1 ] || bad "a sweep with a survivor and no never-ran must exit 1, got $code"
ok "all caught exits 0; a survivor exits 1"

# 6. A REAL mutant run killed mid-execution by its deadline: NEVER-RAN, and its
#    cluster, postmaster and work directory are gone afterwards. The stall hook
#    holds the run AFTER its cluster is up, so the kill lands on a live cluster.
before_dirs=$(ls -d /tmp/obrp.* 2>/dev/null | sort)
shm_before=$(ipcs -m 2>/dev/null | grep -c '^m')
out=$(OBRP_SELFTEST_STALL=60 OBRP_MUTATIONS="latest_by_time" OBRP_MUTANT_DEADLINE=6 bash "$RUNNER" --all-mutations 2>&1); code=$?
echo "$out" | sed 's/^/    /'
s8_setup=""
if [ "$code" = 2 ] && echo "$out" | grep -q '^NEVER-RAN latest_by_time: deadline of 6s exceeded'; then
  :
elif [ "$code" = 2 ] && echo "$out" | grep -qE '^NEVER-RAN latest_by_time \(exit 2\): NEVER-RAN: (initdb failed|pg start failed)'; then
  # The cluster never came up. The stall hook sits after pg start, so the run
  # never reached it and the deadline had nothing to kill: this check did not
  # execute. Any other outcome (exit 0/1, or exit 2 for a reason past setup,
  # which means the stall did not hold) stays a failed check below.
  s8_setup=$(echo "$out" | grep -E '^NEVER-RAN latest_by_time \(exit 2\)' | head -1)
else
  bad "a real run cut off by its deadline must be NEVER-RAN by deadline (exit 2), got exit $code without the deadline marker"
fi
sleep 1
after_dirs=$(ls -d /tmp/obrp.* 2>/dev/null | sort)
new_dirs=$(comm -13 <(echo "$before_dirs") <(echo "$after_dirs") | grep -v '^$' || true)
[ -z "$new_dirs" ] || bad "the killed run left its work directory: $new_dirs"
pgrep -f "postgres -D /tmp/obrp\." >/dev/null && bad "a postmaster from a killed run is still running: $(pgrep -fl 'postgres -D /tmp/obrp\.')"
shm_after=$(ipcs -m 2>/dev/null | grep -c '^m')
[ "$shm_after" -le "$shm_before" ] || bad "shared memory segments leaked: $shm_before -> $shm_after"
if [ -n "$s8_setup" ]; then
  # The leak checks above still ran and passed: a setup failure left nothing behind.
  echo "NEVER-RAN S$((n + 1)) a real run killed at its deadline: the throwaway cluster never started, so the kill was not exercised"
  echo "    $s8_setup"
  echo "RUNNER SELFTEST INCOMPLETE ($n checks passed, 1 never ran): not a pass"
  exit 2
fi
ok "a real run killed at its deadline is NEVER-RAN and leaves no cluster, postmaster, work directory or shared memory"

echo "RUNNER SELFTEST PASSED ($n checks)"
