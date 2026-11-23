#!/bin/bash
# Loop-closing Task 4.1: live negative controls for recheck-sql-test.sh's OWN
# verdicts. Each control makes one run of the runner end in a known way
# (OBRP_INJECT) and this script checks the exit status and the line that names
# why. A harness that cannot say "this never ran" would call these catches.
#
#   bash scripts/loop-closing/recheck-harness-selftest.sh
#
# Exit 0: every control got its expected verdict. 1: one did not (the runner's
# classification is wrong). 2: a control itself could not run: the runner said
# its cluster did not start. That is the machine, not a verdict of the runner
# (its port is a random one and may be taken), so the control is run again, up
# to three times in all, and only then counted as not run.
#
# OBRP_SELFTEST_ONLY=<extended regex>: run only the controls whose name matches
# (and neither sweep control). For judging a change to one step's harness; the
# last line then says SUBSET, and a subset is never the self-test's result.
export LC_ALL=C
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNNER="$HERE/recheck-sql-test.sh"
bad=0; n=0; norun=0
ONLY="${OBRP_SELFTEST_ONLY:-}"
ATTEMPTS=3
# The runner's own words when its cluster did not come up. No control asks for
# that, so a control that ends this way did not run: it is neither OK nor BAD.
no_cluster() { printf '%s\n' "$1" | grep -Eq 'NEVER-RAN[^:]*: (.*: )?(pg start failed|initdb failed)'; }
# Run "$@" (which sets out and code) until its cluster starts. Returns 1 when it never did.
with_cluster() { # name, command...
  local name="$1" try=1; shift
  while :; do
    "$@"
    no_cluster "$out" || return 0
    echo "RETRY $name: its cluster did not start, attempt $try of $ATTEMPTS: $(printf '%s\n' "$out" | grep -E -m1 'pg start failed|initdb failed' | cut -c1-170)"
    if [ "$try" -ge "$ATTEMPTS" ]; then
      echo "NORUN $name: no cluster in $ATTEMPTS attempts; this control did not run"
      norun=$((norun + 1)); return 1
    fi
    try=$((try + 1))
  done
}
# Patterns, one per line, that must each match a line of the output IN THIS ORDER:
# every pattern is looked for only after the line the one before it matched.
in_order() { # output, patterns
  local out="$1" pats="$2" from=1 p hit
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    hit=$(printf '%s\n' "$out" | tail -n +"$from" | grep -En -m1 -- "$p" | cut -d: -f1)
    [ -n "$hit" ] || return 1
    from=$((from + hit))
  done <<EOF
$pats
EOF
  return 0
}
control() { # name, expected exit, expected line pattern, deadline seconds, a second pattern that must also match, a pattern that must NOT match, patterns that must match in order (one per line)
  local name="$1" want="$2" pat="$3" dl="${4:-240}" also="${5:-}" never_pat="${6:-}" order="${7:-}" out code
  if [ -n "$ONLY" ] && ! printf '%s\n' "$name" | grep -Eq "$ONLY"; then return; fi
  n=$((n + 1))
  # The cold-start step is run only by the controls that are about it.
  local skip_cold=1
  case "$name" in cold_*) skip_cold="";; esac
  run_control() { out=$(OBRP_INJECT="$name" SKIP_INTEGRATION=1 SKIP_COLD="$skip_cold" python3 "$HERE/deadline.py" "$dl" bash "$RUNNER" 2>&1); code=$?; }
  with_cluster "$name" run_control || return
  if [ "$code" = "$want" ] && printf '%s\n' "$out" | grep -Eq "$pat" \
    && { [ -z "$also" ] || printf '%s\n' "$out" | grep -Eq "$also"; } \
    && { [ -z "$never_pat" ] || ! printf '%s\n' "$out" | grep -Eq "$never_pat"; } \
    && { [ -z "$order" ] || in_order "$out" "$order"; }; then
    echo "OK   $name: exit $code, $(printf '%s\n' "$out" | grep -E -m1 "$pat" | cut -c1-150)"
  else
    echo "BAD  $name: exit $code (wanted $want and a line matching /$pat/${also:+, one matching /$also/}${never_pat:+, none matching /$never_pat/}${order:+, and its ordered lines in their order}): $(printf '%s\n' "$out" | tail -2 | tr '\n' ' ' | cut -c1-240)"
    bad=$((bad + 1))
  fi
}
# A real statement_timeout before any check: never ran, never a failed check.
control sql_timeout 2 '^NEVER-RAN: the SQL contract was interrupted \(SQLSTATE 57014'
# A statement cancelled inside the contract's one handler block.
control cancel_in_attempt 2 '^NEVER-RAN: the SQL contract was interrupted \(SQLSTATE 57014'
# A resource error raised inside the handler block, which WHEN OTHERS does catch.
control resource_in_attempt 2 '^NEVER-RAN: the SQL contract was interrupted \(SQLSTATE 53200'
# A behavioral SQL error no check was written for.
control raw_error 2 '^NEVER-RAN: the SQL contract stopped on an SQL error that is not one of its assertions \(SQLSTATE 22012'
# The positive control: a check that runs to completion and does not hold.
control assert_fail 1 '^FAIL RECHECK SQL TEST: FAIL INJECTED a completed check that does not hold'
# A schedule connection whose statement is cancelled.
control conn_cancel 2 '^NEVER-RAN: a schedule connection was interrupted while checking'
# A harness fixture query that is cancelled.
control helper_cancel 2 '^NEVER-RAN: a helper query did not execute while checking'
# A harness query that raises while every check goes on to hold.
control helper_stray 2 '^NEVER-RAN: every check held, but a helper query did not execute'
# A statement that outlives the outer deadline: 124 from deadline.py.
control sql_sleep 124 '^NEVER-RAN: deadline of 20s exceeded' 20
# The cold-start step's own three outcomes. A simulated cold read that fits inside
# the role's timeout leaves nothing to judge; so does a machine too slow for the
# simulation's margins; a check that ran and did not hold is a failure.
control cold_no_timeout 2 '^NEVER-RAN: the simulated cold read fitted inside the role'"'"'s statement timeout'
control cold_slow_machine 2 '^NEVER-RAN: calibration \(before\): a WARM search took'
# The failed check is a verdict only after the machine calibrated again: the
# pending check, then the calibration, then the FAIL, in that order, and no FAIL
# line anywhere before the calibration.
control cold_assert_fail 1 '^FAIL cold: INJECTED a completed check that does not hold' 240 '^COLD calibration \(after a check did not hold\): four warm searches' '' '^COLD a check did not hold; the machine is calibrated before that is a verdict: INJECTED
^COLD calibration \(after a check did not hold\): four warm searches
^FAIL cold: INJECTED a completed check that does not hold'
fail_before_calibration() { # the first FAIL line is above the calibration line: the order the control above must refuse
  in_order "$1" '^FAIL cold:
^COLD calibration \(after a check did not hold\)'
}
# A slowdown that begins AFTER the first calibration (review finding F2). The
# application is untouched in all four; none may end as a FAIL.
#   From just after the first calibration: the lone-plan control's elapsed time
#   is a timing control, and the calibration it triggers says the machine is slow.
control cold_late_slowdown 2 '^NEVER-RAN: calibration \(after a timing control did not hold\): a WARM search took' 240 '^COLD calibration \(before\): four warm searches' '^FAIL cold:'
#   The same slowdown, then a check that does not hold: not a failure, because
#   the machine no longer calibrates.
control cold_late_slowdown_assert_fail 2 '^NEVER-RAN: calibration \(after a check did not hold\): a WARM search took' 240 '^COLD a check did not hold; the machine is calibrated before that is a verdict: INJECTED' '^FAIL cold:'
#   From just before scenario A, after every control held: the warm-up of the
#   unmodified application runs out of its share. Run A's own timings say so
#   before any check of A is evaluated; the calibration then finds the machine slow.
control cold_slowdown_from_a 2 '^NEVER-RAN: calibration \(after a timing control did not hold\): a WARM search took' 400 '^COLD timing control did NOT hold: A: no call of the run spent more than' '^FAIL cold:|^COLD a check did not hold|^PASS K A ' '^COLD observed control, the same plan from cold with no statement timeout
^COLD timings of A \(dry run, limit 5\), printed before any of its checks:
^COLD timing control did NOT hold: A: no call of the run spent more than'
#   One delayed call, then a machine that calibrates: a timing control outside
#   its margin is NEVER-RAN on its own, never a pass and never a failure.
control cold_spike_at_control 2 '^NEVER-RAN: timing control: the cancelled plan came back at about the role' 240 '^COLD calibration \(after a timing control did not hold\): four warm searches' '^FAIL cold:'
# A stall inside ONE run, then a machine that calibrates (re-review 1). The
# application is untouched in all seven. Each must be NEVER-RAN at that run's own
# timings: the timings are printed, the control does not hold, the machine
# calibrates INSIDE its limit, and no check of that run is evaluated at all, so
# there is no "check did not hold" line, no PASS line of that run and no FAIL.
STALL_ORDER='^COLD timings of RUN \(
^COLD timing control did NOT hold: RUN: no call of the run spent more than
^COLD calibration \(after a timing control did not hold\): four warm searches
^NEVER-RAN: timing control: RUN: no call of the run spent more than'
stall() { # name, run, what the control line must name, deadline, a PASS prefix of that run that must be absent
  control "$1" 2 "^NEVER-RAN: timing control: $2: no call of the run spent more than .*$3" "$4" \
    "^COLD timing control did NOT hold: $2: no call of the run spent more than .*$3" \
    "^FAIL cold:|^COLD a check did not hold|^NEVER-RAN: calibration|^PASS K $5" \
    "$(printf '%s\n' "$STALL_ORDER" | sed "s/RUN/$2/")"
}
#   The reviewer's case: the 17th warm-up call of A reaches the database 41 s
#   late, the warm-up correctly stops on its 40 s share with 17 chunks read, and
#   the machine calibrates. At the reviewed head this was a completed FAIL.
stall cold_stall_one_call_a A 'recheck_warm_embeddings \(call 17 of it\) spent 4[0-9]{4} ms outside the database' 400 'A '
#   One begin of C late by 1.6 s: it is not cancelled with the other three.
#   The late begin itself succeeds, so the database's own clock gives its share.
stall cold_stall_one_call_c C 'recheck_begin_scan \(call [0-9]+ of it\) spent 1[0-9]{3} ms outside the database' 400 'C '
#   The same on night 1 of D, where the late begin is itself cancelled by the
#   role's timeout: its share is bounded by the timeout, not read from a stamp.
stall cold_stall_one_call_d 'D night 1' 'recheck_begin_scan \(call [0-9]+ of it, ended with SQLSTATE 57014\) spent at least 1[0-9]{3} ms outside the database' 400 'D night 1'
#   The delay is in the harness's own read inside the call, not in any psql call of the run.
stall cold_stall_harness_read A 'recheck_warm_embeddings \(call 5 of it\) spent 1[0-9]{3} ms outside the database' 240 'A '
#   This process blocked between two calls: no call is slow, the heartbeat is late.
stall cold_stall_process A '1 out of margin: this process was held up for 1[0-9]{3} ms' 240 'A '
#   The same process blocked for 200 ms before each of 30 calls: no single
#   hold-up is over the limit, and together they are 6 s.
stall cold_stall_process_many A '1 out of margin: this process was held up for [5-9][0-9]{3} ms in all' 240 'A '
#   The model stub slow once: no call is slow and the process was never held up.
stall cold_stall_model_stub A '1 out of margin: the model stub, which answers at once, took 1[0-9]{3} ms' 240 'A '
# The ordering test of cold_assert_fail refuses what it is there to refuse: a
# transcript with the FAIL line above the calibration line. Checked on a fixed
# transcript, so it needs no run.
if [ -z "$ONLY" ] || printf 'order_check\n' | grep -Eq "$ONLY"; then
  n=$((n + 1))
  good='COLD a check did not hold; the machine is calibrated before that is a verdict: INJECTED x
COLD calibration (after a check did not hold): four warm searches
FAIL cold: INJECTED a completed check that does not hold: x'
  swapped='COLD a check did not hold; the machine is calibrated before that is a verdict: INJECTED x
FAIL cold: INJECTED a completed check that does not hold: x
COLD calibration (after a check did not hold): four warm searches'
  want_order='^COLD a check did not hold; the machine is calibrated before that is a verdict: INJECTED
^COLD calibration \(after a check did not hold\): four warm searches
^FAIL cold: INJECTED a completed check that does not hold'
  if in_order "$good" "$want_order" && ! in_order "$swapped" "$want_order" && fail_before_calibration "$swapped" && ! fail_before_calibration "$good"; then
    echo "OK   order_check: calibration-then-FAIL is accepted, FAIL-then-calibration is refused"
  else
    echo "BAD  order_check: the ordered match does not tell calibration-then-FAIL from FAIL-then-calibration"; bad=$((bad + 1))
  fi
fi
# The test of "its cluster did not start" on fixed lines: the runner's two ways
# of saying so, alone and as a sweep reports them, are recognised; a NEVER-RAN
# for any other reason, a FAIL and a pass are not.
if [ -z "$ONLY" ] || printf 'start_check\n' | grep -Eq "$ONLY"; then
  n=$((n + 1))
  if no_cluster 'NEVER-RAN: pg start failed: 2026-11-19 12:11:56.778 EST [14651] LOG:  database system is shut down' \
    && no_cluster 'NEVER-RAN: initdb failed at shmget: SysV shared memory is exhausted or denied' \
    && no_cluster 'NEVER-RAN commit_stale_unchecked (exit 2): NEVER-RAN: pg start failed: x' \
    && ! no_cluster 'NEVER-RAN: the SQL contract was interrupted (SQLSTATE 57014: canceling statement due to statement timeout)' \
    && ! no_cluster 'NEVER-RAN: timing control: A: no call of the run spent more than 250 ms outside the database' \
    && ! no_cluster 'FAIL cold: INJECTED a completed check that does not hold: one is not two' \
    && ! no_cluster 'RECHECK TEST COMPLETE'; then
    echo "OK   start_check: a cluster that did not start is told from every other NEVER-RAN, from a FAIL and from a pass"
  else
    echo "BAD  start_check: the test of a cluster that did not start is wrong"; bad=$((bad + 1))
  fi
fi
if [ -n "$ONLY" ]; then
  [ "$n" -gt 0 ] || { echo "NEVER-RAN: no control matches OBRP_SELFTEST_ONLY=$ONLY"; exit 2; }
  if [ "$bad" -gt 0 ]; then echo "HARNESS SELFTEST FAILED ($bad of $n, SUBSET $ONLY)"; exit 1; fi
  if [ "$norun" -gt 0 ]; then echo "NEVER-RAN: the harness self-test subset is incomplete: $norun of $n controls could not run (no cluster), SUBSET $ONLY"; exit 2; fi
  echo "HARNESS SELFTEST SUBSET PASSED ($n controls matching $ONLY; not the whole self-test)"; exit 0
fi
# And the mutant sweep's reading of the same things: a timed-out mutant is not a catch.
n=$((n + 1))
run_sweep_timeout() { out=$(OBRP_INJECT=sql_timeout OBRP_MUTATIONS="commit_stale_unchecked" python3 "$HERE/deadline.py" 300 bash "$RUNNER" --all-mutations 2>&1); code=$?; }
if ! with_cluster "sweep (timed out)" run_sweep_timeout; then :
elif [ "$code" = 2 ] && printf '%s\n' "$out" | grep -q '^NEVER-RAN commit_stale_unchecked' && printf '%s\n' "$out" | grep -q '^SWEEP: 1 mutations, 0 caught, 0 survived, 1 never ran'; then
  echo "OK   sweep: a mutant whose run timed out is NEVER-RAN, not CAUGHT (exit 2)"
else
  echo "BAD  sweep: exit $code: $(printf '%s\n' "$out" | tail -3 | tr '\n' ' ' | cut -c1-240)"; bad=$((bad + 1))
fi
n=$((n + 1))
run_sweep_plain() { out=$(OBRP_MUTATIONS="commit_stale_unchecked" python3 "$HERE/deadline.py" 300 bash "$RUNNER" --all-mutations 2>&1); code=$?; }
if ! with_cluster "sweep (uninterrupted)" run_sweep_plain; then :
elif [ "$code" = 0 ] && printf '%s\n' "$out" | grep -q '^CAUGHT    commit_stale_unchecked: FAIL '; then
  echo "OK   sweep: the same mutant, uninterrupted, is CAUGHT by a completed FAIL (exit 0)"
else
  echo "BAD  sweep control: exit $code: $(printf '%s\n' "$out" | tail -3 | tr '\n' ' ' | cut -c1-240)"; bad=$((bad + 1))
fi
if [ "$bad" -gt 0 ]; then echo "HARNESS SELFTEST FAILED ($bad of $n)"; exit 1; fi
if [ "$norun" -gt 0 ]; then echo "NEVER-RAN: the harness self-test is incomplete: $norun of $n controls could not run (no cluster); the others got their expected verdicts"; exit 2; fi
echo "HARNESS SELFTEST PASSED ($n controls)"
