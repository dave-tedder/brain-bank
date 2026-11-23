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
for f in never fail sync_conn q wait_blocked classify sqlstate_kind conn_interruption; do
  extract "$f" > "$T/fn_$f.sh"
  [ -s "$T/fn_$f.sh" ] || bad "could not extract $f() from the runner"
done
# fail() reads the schedule connections through these, as the runner does.
cat > "$T/fn_env.sh" <<ENV
$(grep -E '^(INTERRUPTION_PREFIXES|ASSERT_STATE)=' "$RUNNER")
. '$T/fn_sqlstate_kind.sh'
. '$T/fn_conn_interruption.sh'
ENV
[ "$(grep -c '=' "$T/fn_env.sh")" -ge 2 ] || bad "could not read INTERRUPTION_PREFIXES and ASSERT_STATE from the runner"

# 1. sync_conn on a connection that never completes (Codex's timeout-classifier
#    schedule): must be exit 2 NEVER-RAN, not exit 1.
out=$(bash -c "WORK='$T'; SEQ=0; OBRP_SYNC_TICKS=10; send() { :; }; . '$T/fn_never.sh'; . '$T/fn_sync_conn.sh'; sync_conn A" 2>&1); code=$?
[ "$code" = 2 ] && echo "$out" | grep -q '^NEVER-RAN: connection A did not finish' && ! echo "$out" | grep -q '^FAIL' \
  || bad "sync_conn timeout: expected exit 2 NEVER-RAN, got $code: $out"
ok "a connection that never completes is NEVER-RAN (exit 2), never FAIL"

# 2. wait_blocked: never seen waiting AND the statement never completes -> NEVER-RAN.
out=$(bash -c "WORK='$T'; SEQ=0; OBRP_SYNC_TICKS=10; send() { :; }; blocked_count() { echo 0; }; sleep() { :; }
  . '$T/fn_env.sh'; . '$T/fn_never.sh'; . '$T/fn_fail.sh'; . '$T/fn_sync_conn.sh'; . '$T/fn_wait_blocked.sh'; wait_blocked B 'X'" 2>&1); code=$?
[ "$code" = 2 ] && echo "$out" | grep -q '^NEVER-RAN' || bad "wait_blocked + stalled connection: expected NEVER-RAN, got $code: $out"
ok "never seen waiting and never completed is NEVER-RAN"

# 3. wait_blocked: never seen waiting but the statement DID complete -> a real FAIL.
out=$(bash -c "WORK='$T'; SEQ=100; OBRP_SYNC_TICKS=10; send() { case \"\$2\" in '\\! touch '*) touch \"\${2#\\\\! touch }\";; esac; }; blocked_count() { echo 0; }
  . '$T/fn_env.sh'; . '$T/fn_never.sh'; . '$T/fn_fail.sh'; . '$T/fn_sync_conn.sh'; . '$T/fn_wait_blocked.sh'; wait_blocked B 'C1 label'" 2>&1); code=$?
[ "$code" = 1 ] && echo "$out" | grep -q '^FAIL C1 label: connection B completed without ever waiting' || bad "wait_blocked + completed: expected FAIL exit 1, got $code: $out"
ok "completed without waiting is a behavioral FAIL (exit 1)"

# 4. A helper query that cannot connect turns the next check into NEVER-RAN.
out=$(bash -c "WORK='$T/q'; mkdir -p \"\$WORK\"; PSQL=(psql -X -h 127.0.0.1 -p 1 -U postgres -q)
  . '$T/fn_env.sh'; . '$T/fn_never.sh'; . '$T/fn_fail.sh'; . '$T/fn_q.sh'
  [ \"\$(q 'select 1')\" = 1 ] || fail 'the value check'" 2>&1); code=$?
[ "$code" = 2 ] && echo "$out" | grep -q '^NEVER-RAN: a helper query did not execute while checking: the value check (psql exit 2' \
  || bad "q connection failure: expected NEVER-RAN, got $code: $out"
ok "a check made on a helper query that could not connect is NEVER-RAN"

# 4b. So does a helper query whose SQL raised (psql -c exit 1): a cancelled
#     statement is not "a completed execution". A stand-in for psql prints what a
#     statement_timeout prints and exits 1.
cat > "$T/fake-psql.sh" <<'FAKE'
#!/bin/bash
echo "ERROR:  57014: canceling statement due to statement timeout"; exit 1
FAKE
out=$(bash -c "WORK='$T/q1'; mkdir -p \"\$WORK\"; PSQL=(bash '$T/fake-psql.sh')
  . '$T/fn_env.sh'; . '$T/fn_never.sh'; . '$T/fn_fail.sh'; . '$T/fn_q.sh'
  [ \"\$(q 'select 1')\" = 1 ] || fail 'the value check'" 2>&1); code=$?
[ "$code" = 2 ] && echo "$out" | grep -q '^NEVER-RAN: a helper query did not execute while checking: the value check (psql exit 1: ERROR:  57014' \
  || bad "q SQL error: expected NEVER-RAN, got $code: $out"
ok "a check made on a helper query whose statement was cancelled (psql exit 1) is NEVER-RAN"

# 4c. A schedule check that fails while a connection's transcript carries an
#     interruption is NEVER-RAN; with a behavioral error there it stays a FAIL.
for c in "57014: canceling statement due to statement timeout|2|^NEVER-RAN: a schedule connection was interrupted while checking: the schedule check (B: ERROR:  57014" \
         "57P01: terminating connection due to administrator command|2|^NEVER-RAN: a schedule connection was interrupted while checking: the schedule check (B: ERROR:  57P01" \
         "canceling statement due to statement timeout|2|^NEVER-RAN: a schedule connection was interrupted while checking: the schedule check (B: ERROR:  canceling" \
         "P0001: review_proposal: the done transition wrote 0 rows.|1|^FAIL the schedule check$" \
         "23505: duplicate key value violates unique constraint|1|^FAIL the schedule check$"; do
  IFS='|' read -r line want pat <<< "$c"
  rm -rf "$T/c"; mkdir -p "$T/c"; printf 'recorded\nERROR:  %s\nLOCATION:  x, y.c:1\n' "$line" > "$T/c/B.out"; : > "$T/c/A.out"
  out=$(bash -c "WORK='$T/c'; . '$T/fn_env.sh'; . '$T/fn_never.sh'; . '$T/fn_fail.sh'; fail 'the schedule check'" 2>&1); code=$?
  [ "$code" = "$want" ] && echo "$out" | grep -q "$pat" || bad "fail() with '$line' on a connection: expected exit $want, got $code: $out"
done
ok "a failed schedule check is NEVER-RAN when a connection was interrupted (57014, 57P01, no SQLSTATE) and a FAIL when the error is behavioral (P0001, 23505)"

# 5. The sweep classifier, with fake mutant runs covering every outcome.
cat > "$T/fake-mutant.sh" <<'FAKE'
#!/bin/bash
case "$2" in
  pass) echo "REVIEW PROPOSAL TEST COMPLETE"; exit 0;;
  assert_fail) echo "FAIL C2: the inversion did not occur"; exit 1;;
  sql_assert) printf '%s\n' "ERROR TF001: FAIL T38 decision_ref: zero business writes" "FAIL REVIEW PROPOSAL SQL TEST: FAIL T38 decision_ref: zero business writes"; exit 1;;
  old_shape) echo "ERROR: FAIL T38 decision_ref: zero business writes"; exit 1;;
  sql_timeout) printf '%s\n' "ERROR 57014: canceling statement due to statement timeout" "FAIL REVIEW PROPOSAL SQL TEST: canceling statement due to statement timeout"; exit 1;;
  sql_syntax) printf '%s\n' "ERROR 42601: syntax error at or near \"selec\"" "FAIL REVIEW PROPOSAL SQL TEST: syntax error at or near \"selec\""; exit 1;;
  bare_exit1) echo "something died"; exit 1;;
  # The integration step, as the runner prints it: a behavioral answer that failed
  # a check; an RPC the bridge reports as interrupted; and the transcript the
  # bridge gave before PR 28's correction for that same interruption.
  integ_fail) printf '%s\n' "REVIEW PROPOSAL SQL TEST PASSED" "PASS I I1 Slack done with two pending rows lists them" "FAIL integration: I1 Slack selective done recorded: review failed: injected behavioral error"; exit 1;;
  integ_interrupted) printf '%s\n' "REVIEW PROPOSAL SQL TEST PASSED" "NEVER-RAN integration: rpc review_proposal was interrupted (SQLSTATE 57014: canceling statement due to statement timeout); it did not complete, so nothing is judged on it" "NEVER-RAN: the integration harness did not complete (exit 2): NEVER-RAN integration: rpc review_proposal was interrupted"; exit 2;;
  integ_never_ran_exit1) printf '%s\n' "NEVER-RAN integration: rpc review_proposal was interrupted (SQLSTATE 57014: canceling statement due to statement timeout)" "FAIL integration: I1 Slack done with two pending rows lists them: lookup failed"; exit 1;;
  setup) echo "NEVER-RAN: initdb failed"; exit 2;;
  hang)
    w=$(mktemp -d /tmp/obrp.XXXXXX); mkdir -p "$w/pg"; [ -n "${OBRP_STATE_FILE:-}" ] && echo "$w" > "$OBRP_STATE_FILE"
    echo "$w" > "$SELFTEST_DIR/hang.work"
    sleep 300 & echo $! > "$SELFTEST_DIR/hang.child"
    wait;;
esac
FAKE
out=$(SELFTEST_DIR="$T" OBRP_MUTANT_CMD="bash $T/fake-mutant.sh" OBRP_MUTATIONS="pass assert_fail sql_assert old_shape sql_timeout sql_syntax bare_exit1 integ_fail integ_interrupted integ_never_ran_exit1 setup hang" OBRP_MUTANT_DEADLINE=3 \
  bash "$RUNNER" --all-mutations 2>&1); code=$?
echo "$out" | sed 's/^/    /'
echo "$out" | grep -q '^SURVIVED  pass$' || bad "pass must be SURVIVED"
echo "$out" | grep -q '^CAUGHT    assert_fail: FAIL C2' || bad "a completed assertion failure must be CAUGHT"
echo "$out" | grep -q '^CAUGHT    sql_assert: FAIL REVIEW PROPOSAL SQL TEST: FAIL T38' || bad "a completed SQL check failure (TF001) must be CAUGHT"
echo "$out" | grep -q '^NEVER-RAN old_shape: exit 1, but the output carries an SQL error that is not a completed assertion: ERROR: FAIL T38' || bad "an SQL error line with no TF001 SQLSTATE must be NEVER-RAN, whatever its text"
echo "$out" | grep -q '^NEVER-RAN sql_timeout: exit 1, but the output carries an SQL error that is not a completed assertion: ERROR 57014' || bad "a statement timeout beside a FAIL line must be NEVER-RAN"
echo "$out" | grep -q '^NEVER-RAN sql_syntax: exit 1, but the output carries an SQL error that is not a completed assertion: ERROR 42601' || bad "a syntax error beside a FAIL line must be NEVER-RAN"
echo "$out" | grep -q '^NEVER-RAN bare_exit1: exit 1 with no completed FAIL line' || bad "exit 1 without a FAIL line must be NEVER-RAN"
echo "$out" | grep -q '^NEVER-RAN setup (exit 2)' || bad "exit 2 must be NEVER-RAN"
echo "$out" | grep -q '^NEVER-RAN hang: deadline of 3s exceeded' || bad "a hung mutant must be NEVER-RAN by deadline"
echo "$out" | grep -q '^CAUGHT    integ_fail: FAIL integration: I1 Slack selective done recorded' || bad "a completed integration check failure must be CAUGHT"
echo "$out" | grep -q '^NEVER-RAN integ_interrupted (exit 2): NEVER-RAN: the integration harness did not complete (exit 2): NEVER-RAN integration: rpc review_proposal was interrupted' || bad "an integration step the bridge reports as interrupted (exit 2) must be NEVER-RAN"
echo "$out" | grep -q '^NEVER-RAN integ_never_ran_exit1: exit 1, but the run says it did not complete: NEVER-RAN integration: rpc review_proposal was interrupted' || bad "an exit 1 beside a NEVER-RAN integration line must be NEVER-RAN"
echo "$out" | grep -q '^SWEEP: 12 mutations, 3 caught, 1 survived, 8 never ran$' || bad "sweep tally"
[ "$code" = 2 ] || bad "a sweep with NEVER-RAN mutants must exit 2, got $code"
ok "the sweep classifies pass/assert/TF001 as SURVIVED/CAUGHT/CAUGHT, and an SQL error without TF001, a timeout, a syntax error, a bare exit 1, a setup failure and a hang as NEVER-RAN, and exits 2"
ok "an integration check that failed on a behavioral answer is CAUGHT; an interrupted bridge RPC (exit 2), and an exit 1 beside a NEVER-RAN line, are NEVER-RAN"
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
