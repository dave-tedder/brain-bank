#!/bin/bash
# Loop-closing Task 3.3, PR 25 Codex review P2 (2026-11-18): negative controls for
# the VERDICTS of action-item-review-sql-test.sh, run without a human. The finding
# was that a statement cancelled by statement_timeout (psql exit 3, SQLSTATE 57014)
# was reported as a failed check and, in the sweep, as a caught mutant.
#
#   bash scripts/loop-closing/action-item-review-harness-selftest.sh            # everything
#   bash scripts/loop-closing/action-item-review-harness-selftest.sh controls   # part 1 and 2 only
#   bash scripts/loop-closing/action-item-review-harness-selftest.sh mutants    # part 1 and 3 only
#
# Part 1  the runner's canned verdict cases (--verdict-selftest, no database).
# Part 2  live controls on the real runner, each on its own throwaway cluster. Each
#         plants one known event (OBRP_INJECT in the runner) and requires the exact
#         verdict: a real statement_timeout, a cancellation inside the contract's
#         one error handler, a resource error there, an SQL error no check was
#         written for, a cancellation reaching the integration bridge by both entry
#         points, a cancellation on a schedule connection, a helper query that did
#         not execute, the outer deadline, and, as positive controls, a completed
#         check that does not hold and three real mutants that must still be CAUGHT.
# Part 3  harness mutants. Each breaks ONE classification rule in a throwaway copy
#         of the runner (never this checkout) and must be caught by the judge named
#         for it: the canned cases, or a live control that then reports the wrong
#         verdict. "old_rule" restores the reviewed behavior exactly (any psql exit
#         3 is a FAIL, and the sweep accepts it). For a live judge the copy's
#         start-up self-test is removed too, because a runner whose classifiers
#         fail their own cases refuses to give any verdict, which would hide what
#         the live control sees.
#
# Three outcomes: 0 "HARNESS SELFTEST PASSED"; 1 a control did not get its verdict
# or a harness mutant survived; 2 something could not be judged (a cluster did not
# start, a deadline, a mutant that did not apply). 2 is never a pass and never a catch.
export LC_ALL=C
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
RUNNER="$HERE/action-item-review-sql-test.sh"
DEADLINE="$HERE/deadline.py"
PART="${1:-all}"
case "$PART" in all|controls|mutants) ;; *) echo "usage: $0 [all|controls|mutants]"; exit 2;; esac
T="$(mktemp -d /tmp/obrp-hs.XXXXXX)"
trap 'rm -rf "$T"' EXIT
passed=0; failed=0; caught=0; survived=0; never=0

# A run that says one of these did not reach the event under test.
SETUP_FAILURE='NEVER-RAN: (initdb failed|pg start failed|create database failed|stub schema failed|prior migration failed|migration failed to apply|the pre-migration rows|could not read the two|mutant did not change|mutant did not find|injection [a-z_]+ did not apply|unknown injection|unknown mutation|the verdict classifiers failed)'

# control <name>: what to run and the verdict it must get.
#   C_ENV / C_ARGS   environment and arguments for the runner
#   C_EXIT           the exit status required
#   C_MUST           regexes that must each match a line of the output
#   C_NOT            a regex that must match no line
control() {
  C_ARGS=(); C_MUST=(); C_NOT='^FAIL '; C_LIMIT=180
  case "$1" in
    sql_timeout_baseline)
      C_WHAT="a real statement_timeout before any check is NEVER-RAN, not a failed check"
      C_ENV=(OBRP_INJECT=sql_timeout SKIP_INTEGRATION=1); C_EXIT=2
      C_MUST=('^ERROR 57014: canceling statement due to statement timeout$' '^NEVER-RAN: the SQL contract was interrupted \(SQLSTATE 57014: canceling statement due to statement timeout\)');;
    sql_timeout_sweep)
      C_WHAT="the same timeout under a mutant is NEVER-RAN in the sweep, not CAUGHT"
      C_ENV=(OBRP_INJECT=sql_timeout SKIP_INTEGRATION=1 OBRP_MUTATIONS=no_status_guard); C_ARGS=(--all-mutations); C_EXIT=2
      C_MUST=('^NEVER-RAN no_status_guard \(exit 2\): NEVER-RAN: the SQL contract was interrupted \(SQLSTATE 57014' '^SWEEP: 1 mutations, 0 caught, 0 survived, 1 never ran$' '^SWEEP INCOMPLETE')
      C_NOT='^CAUGHT|MUTATIONS CAUGHT';;
    outer_deadline_sweep)
      C_WHAT="a mutant killed by the outer deadline (deadline.py exit 124) is NEVER-RAN"
      C_ENV=(OBRP_INJECT=sql_sleep SKIP_INTEGRATION=1 OBRP_MUTATIONS=no_status_guard OBRP_MUTANT_DEADLINE=20); C_ARGS=(--all-mutations); C_EXIT=2
      C_MUST=('^NEVER-RAN no_status_guard: deadline of 20s exceeded, the run did not complete$' '^SWEEP: 1 mutations, 0 caught, 0 survived, 1 never ran$')
      C_NOT='^CAUGHT|MUTATIONS CAUGHT';;
    cancel_in_attempt)
      C_WHAT="a statement cancelled inside the contract's error handler is NEVER-RAN"
      C_ENV=(OBRP_INJECT=cancel_in_attempt SKIP_INTEGRATION=1); C_EXIT=2
      C_MUST=('^NEVER-RAN: the SQL contract was interrupted \(SQLSTATE 57014');;
    resource_in_attempt)
      C_WHAT="a resource error the handler does catch is re-raised and is NEVER-RAN"
      C_ENV=(OBRP_INJECT=resource_in_attempt SKIP_INTEGRATION=1); C_EXIT=2
      C_MUST=('^NEVER-RAN: the SQL contract was interrupted \(SQLSTATE 53200: out of memory \(injected\)\)');;
    raw_error)
      C_WHAT="an SQL error no check was written for is NEVER-RAN, not a failed check"
      C_ENV=(OBRP_INJECT=raw_error SKIP_INTEGRATION=1); C_EXIT=2
      C_MUST=('^NEVER-RAN: the SQL contract stopped on an SQL error that is not one of its assertions \(SQLSTATE 22012: division by zero\)');;
    raw_error_sweep)
      C_WHAT="that unjudged SQL error under a mutant is NEVER-RAN in the sweep, not CAUGHT"
      C_ENV=(OBRP_INJECT=raw_error SKIP_INTEGRATION=1 OBRP_MUTATIONS=no_status_guard); C_ARGS=(--all-mutations); C_EXIT=2
      C_MUST=('^NEVER-RAN no_status_guard \(exit 2\): NEVER-RAN: the SQL contract stopped on an SQL error that is not one of its assertions \(SQLSTATE 22012')
      C_NOT='^CAUGHT|MUTATIONS CAUGHT';;
    assert_fail)
      C_WHAT="positive control: a check that runs to completion and does not hold is exit 1"
      C_ENV=(OBRP_INJECT=assert_fail SKIP_INTEGRATION=1); C_EXIT=1
      C_MUST=('^ERROR TF001: FAIL INJECTED a completed check that does not hold: one is not two$' '^FAIL ACTION ITEM REVIEW SQL TEST: FAIL INJECTED a completed check that does not hold: one is not two$')
      C_NOT='^NEVER-RAN';;
    real_mutants_sweep)
      C_WHAT="positive control: real mutants are still CAUGHT, the two foreign-key ones by a named check"
      C_ENV=(SKIP_INTEGRATION=1 OBRP_MUTATIONS="no_status_guard replacement_existence_unchecked fk_no_set_null"); C_ARGS=(--all-mutations); C_EXIT=0
      C_MUST=('^CAUGHT    no_status_guard: FAIL ACTION ITEM REVIEW SQL TEST: FAIL T08 a keep on a deferred item is refused: recorded'
              '^CAUGHT    replacement_existence_unchecked: FAIL ACTION ITEM REVIEW SQL TEST: FAIL T08 a replacement that does not exist is answered, not raised: raised sqlstate=23503 constraint=action_items_triage_replacement_id_fkey'
              '^CAUGHT    fk_no_set_null: FAIL ACTION ITEM REVIEW SQL TEST: FAIL T11 a replacement named by a proposal can be hard-deleted: raised sqlstate=23503 constraint=action_items_triage_replacement_id_fkey'
              '^ALL 3 MUTATIONS CAUGHT$')
      C_NOT='^NEVER-RAN|^SURVIVED';;
    integration_cancel_helper)
      C_WHAT="a cancellation reaching the integration bridge through the helper is NEVER-RAN"
      C_ENV=(OBRP_INJECT=integration_cancel_helper); C_EXIT=2
      C_MUST=('^ACTION ITEM REVIEW SQL TEST PASSED$' '^NEVER-RAN: the integration harness did not complete \(exit 2\): NEVER-RAN integration: rpc review_action_item was interrupted \(SQLSTATE 57014');;
    integration_cancel_mcp)
      C_WHAT="a cancellation reaching the integration bridge through the MCP tool is NEVER-RAN"
      C_ENV=(OBRP_INJECT=integration_cancel_mcp); C_EXIT=2
      C_MUST=('^PASS I helper review: the row holds the proposal$' '^NEVER-RAN: the integration harness did not complete \(exit 2\): NEVER-RAN integration: rpc review_action_item was interrupted \(SQLSTATE 57014');;
    conn_cancel)
      C_WHAT="a schedule check that fails on a cancelled connection is NEVER-RAN"
      C_ENV=(OBRP_INJECT=conn_cancel ONLY_CONCURRENCY=1); C_EXIT=2
      C_MUST=('^NEVER-RAN: a schedule connection was interrupted while checking: C1 .*\(A: ERROR:  57014: canceling statement due to statement timeout');;
    helper_cancel)
      C_WHAT="a schedule check made after a helper query was cancelled is NEVER-RAN"
      C_ENV=(OBRP_INJECT=helper_cancel ONLY_CONCURRENCY=1); C_EXIT=2
      C_MUST=('^NEVER-RAN: a helper query did not execute while checking: C1.*psql exit 1: ERROR:  57014');;
    helper_stray)
      C_WHAT="a helper query that did not execute makes an otherwise passing run NEVER-RAN"
      C_ENV=(OBRP_INJECT=helper_stray ONLY_CONCURRENCY=1); C_EXIT=2
      C_MUST=('^PASS C3 ' '^NEVER-RAN: every check held, but a helper query did not execute during the run \(psql exit 1: ERROR:  22012');;
    injection_not_fired)
      C_WHAT="a control whose event never happened is NEVER-RAN, never a pass"
      C_ENV=(OBRP_INJECT=integration_cancel_helper SKIP_INTEGRATION=1); C_EXIT=2
      C_MUST=('^PASS C3 ' '^NEVER-RAN: the injection integration_cancel_helper did not stop the run, so it did not fire$')
      C_NOT='^FAIL |TEST COMPLETE';;
    *) echo "unknown control $1"; exit 2;;
  esac
}
CONTROLS="sql_timeout_baseline sql_timeout_sweep outer_deadline_sweep cancel_in_attempt resource_in_attempt raw_error raw_error_sweep assert_fail real_mutants_sweep integration_cancel_helper integration_cancel_mcp conn_cancel helper_cancel helper_stray injection_not_fired"

# run_control <runner path> <control>: sets OUT, CODE, WHY. Returns 0 when the
# required verdict was observed, 1 when the run gave a different verdict, 2 when
# the run did not reach the event (so it shows nothing either way).
run_control() {
  local h="$1" pat
  control "$2"
  OUT=$(env "${C_ENV[@]}" python3 "$DEADLINE" "$C_LIMIT" bash "$h" ${C_ARGS[@]+"${C_ARGS[@]}"} 2>&1); CODE=$?
  WHY=""
  if [ "$CODE" = 124 ]; then WHY="the control itself hit its ${C_LIMIT}s deadline"; return 2; fi
  if printf '%s\n' "$OUT" | grep -Eq "$SETUP_FAILURE"; then
    WHY="setup did not complete: $(printf '%s\n' "$OUT" | grep -Em1 "$SETUP_FAILURE" | cut -c1-200)"; return 2
  fi
  if [ "$CODE" != "$C_EXIT" ]; then WHY="exit $CODE, required $C_EXIT"; fi
  for pat in "${C_MUST[@]}"; do
    printf '%s\n' "$OUT" | grep -Eq -- "$pat" || WHY="${WHY:+$WHY; }no line matches: $pat"
  done
  if printf '%s\n' "$OUT" | grep -Eq -- "$C_NOT"; then
    WHY="${WHY:+$WHY; }a line it must not print: $(printf '%s\n' "$OUT" | grep -Em1 -- "$C_NOT" | cut -c1-200)"
  fi
  [ -z "$WHY" ]
}
excerpt() { printf '%s\n' "$OUT" | grep -Ev '^PASS ' | tail -4 | cut -c1-260 | sed 's/^/      | /'; }

shm_before=$(ipcs -m 2>/dev/null | grep -c '^m')

# ---- Part 1: the canned cases on the real runner ----
out=$(bash "$RUNNER" --verdict-selftest 2>&1); code=$?
if [ "$code" = 0 ] && printf '%s\n' "$out" | grep -Eq '^VERDICT SELFTEST PASSED \([0-9]+ cases\)$'; then
  echo "PASS canned: $out"; passed=$((passed + 1))
else
  echo "FAIL canned: the runner's verdict self-test did not pass (exit $code): $(printf '%s\n' "$out" | head -3 | tr '\n' ' ')"; failed=$((failed + 1))
fi

# ---- Part 2: live controls on the real runner ----
if [ "$PART" != mutants ]; then
  for c in $CONTROLS; do
    run_control "$RUNNER" "$c"
    case $? in
      0) echo "PASS control $c (exit $CODE): $C_WHAT"; passed=$((passed + 1));;
      1) echo "FAIL control $c: $WHY"; excerpt; failed=$((failed + 1));;
      *) echo "NEVER-RAN control $c: $WHY"; excerpt; never=$((never + 1));;
    esac
  done
fi

# ---- Part 3: harness mutants, in a throwaway copy of the runner ----
SH=scripts/loop-closing/action-item-review-sql-test.sh
SQL=scripts/loop-closing/action-item-review-sql-test.sql
TS=scripts/loop-closing/action-item-review-integration.ts
apply() { # tree, file, old, new: literal, exactly one site
  python3 - "$1/$2" "$3" "$4" <<'PY'
import sys
p, a, b = sys.argv[1:4]
s = open(p).read()
if s.count(a) != 1: sys.exit(1)
open(p, 'w').write(s.replace(a, b))
PY
}
OLD_EXIT3='      case "$(sqlstate_kind "$state")" in
        assertion)'
NEW_EXIT3='      VERDICT="$msg"; return 1
      case "$(sqlstate_kind "$state")" in
        assertion)'
OLD_ERRARM='      bad=$(printf '"'"'%s\n'"'"' "$out" | grep -E '"'"'^ERROR'"'"' | grep -m1 -v "^ERROR $ASSERT_STATE: FAIL ")'
# harness_mutant <tree> <name>: applies it; sets JUDGES ("canned" and/or control names).
harness_mutant() {
  case "$2" in
    # The reviewed behavior, both halves: every psql exit 3 is a FAIL, and the
    # sweep takes that FAIL without looking at the SQL error beside it.
    old_rule) JUDGES="canned sql_timeout_baseline sql_timeout_sweep raw_error"
      apply "$1" "$SH" "$OLD_EXIT3" "$NEW_EXIT3" && apply "$1" "$SH" "$OLD_ERRARM" '      bad=""';;
    # The contract half alone: the sweep's own arm still refuses, the baseline does not.
    any_exit3_is_fail) JUDGES="canned sql_timeout_baseline cancel_in_attempt"
      apply "$1" "$SH" "$OLD_EXIT3" "$NEW_EXIT3";;
    # The sweep's arms, one at a time (only a canned transcript isolates each).
    sweep_trusts_error_lines) JUDGES="canned"
      apply "$1" "$SH" "$OLD_ERRARM" '      bad=""';;
    sweep_ignores_never_ran) JUDGES="canned"
      apply "$1" "$SH" '      bad=$(printf '"'"'%s\n'"'"' "$out" | grep -m1 '"'"'^NEVER-RAN'"'"')' '      bad=""';;
    sweep_needs_no_fail_line) JUDGES="canned"
      apply "$1" "$SH" '      echo "NEVER-RAN $m: exit 1 with no completed FAIL line: $(printf '"'"'%s\n'"'"' "$out" | tail -1 | cut -c1-140)"; return 2;;' '      echo "CAUGHT    $m"; return 0;;';;
    # The contract verdict's other arms.
    unjudged_error_is_fail) JUDGES="canned raw_error raw_error_sweep"
      apply "$1" "$SH" 'so it is not a failure and not a catch"; return 2;;' 'so it is not a failure and not a catch"; return 1;;';;
    interruption_is_fail) JUDGES="canned sql_timeout_baseline resource_in_attempt"
      apply "$1" "$SH" 'the statement did not complete, so no check was judged"; return 2;;' 'the statement did not complete, so no check was judged"; return 1;;';;
    marker_not_required) JUDGES="canned"
      apply "$1" "$SH" 'without a FAIL message, so no named check failed: $msg"; return 2;;' 'without a FAIL message, so no named check failed: $msg"; return 1;;';;
    no_sqlstate_is_fail) JUDGES="canned"
      apply "$1" "$SH" '| cut -c1-200)"; return 2;;
      esac;;' '| cut -c1-200)"; return 1;;
      esac;;';;
    passed_line_not_required) JUDGES="canned"
      apply "$1" "$SH" 'VERDICT="the SQL contract exited 0 without its PASSED line"; return 2;;' 'VERDICT="the SQL contract exited 0 without its PASSED line"; return 0;;';;
    # The shared list. Live, the schedules read it directly (conn_cancel). In a
    # full run the contract's own T00 check stops a wrong list first, which is what
    # catches the second one under resource_in_attempt (a FAIL T00, exit 1).
    interruption_57_dropped) JUDGES="canned conn_cancel"
      apply "$1" "$SH" 'INTERRUPTION_PREFIXES="08 53 54 57 58 XX 55P03"' 'INTERRUPTION_PREFIXES="08 53 54 58 XX 55P03"';;
    interruption_53_dropped) JUDGES="canned resource_in_attempt"
      apply "$1" "$SH" 'INTERRUPTION_PREFIXES="08 53 54 57 58 XX 55P03"' 'INTERRUPTION_PREFIXES="08 54 57 58 XX 55P03"';;
    # The list widened to a behavioral class: a foreign-key error would be NEVER-RAN.
    interruption_list_too_wide) JUDGES="canned"
      apply "$1" "$SH" 'INTERRUPTION_PREFIXES="08 53 54 57 58 XX 55P03"' 'INTERRUPTION_PREFIXES="08 23 53 54 57 58 XX 55P03"';;
    # The contract's one handler reports an interruption as an answer.
    attempt_swallows_interruption) JUDGES="resource_in_attempt"
      apply "$1" "$SQL" '    if pg_temp.interruption(o_state) then raise; end if;
' '';;
    # The helper query: an SQL error is again "a completed execution".
    helper_exit1_trusted) JUDGES="helper_cancel helper_stray"
      apply "$1" "$SH" '  if [ "$code" -ne 0 ]; then echo "psql exit $code:' '  if [ "$code" -ne 0 ] && [ "$code" -ne 1 ]; then echo "psql exit $code:';;
    end_ignores_helper_failures) JUDGES="helper_stray"
      apply "$1" "$SH" '[ -s "$WORK/qfail" ] && never "every check held' '[ -s "$WORK/qfail.off" ] && never "every check held';;
    # The schedules: a failed check no longer looks at the connections.
    fail_ignores_connections) JUDGES="conn_cancel"
      apply "$1" "$SH" '  bad=$(conn_interruption)
' '  bad=""
';;
    # The integration bridge hands an interruption to the code under test.
    bridge_passes_interruption) JUDGES="integration_cancel_helper integration_cancel_mcp"
      apply "$1" "$TS" '    if (INTERRUPTION_PREFIXES.some((p) => m[1].startsWith(p))) {' '    if (false) {';;
    bridge_fail_ignores_never_ran) JUDGES="integration_cancel_mcp"
      apply "$1" "$TS" '  if (neverRan.length) {
    say(`NEVER-RAN integration: ${neverRan[0]} (while checking' '  if (false) {
    say(`NEVER-RAN integration: ${neverRan[0]} (while checking';;
    # A control whose event never fired passes.
    unfired_injection_passes) JUDGES="injection_not_fired"
      apply "$1" "$SH" '[ -n "$INJECT" ] && never "the injection' '[ -n "" ] && never "the injection';;
    *) return 2;;
  esac
}
HARNESS_MUTANTS="old_rule any_exit3_is_fail sweep_trusts_error_lines sweep_ignores_never_ran sweep_needs_no_fail_line unjudged_error_is_fail interruption_is_fail marker_not_required no_sqlstate_is_fail passed_line_not_required interruption_57_dropped interruption_53_dropped interruption_list_too_wide attempt_swallows_interruption helper_exit1_trusted end_ignores_helper_failures fail_ignores_connections bridge_passes_interruption bridge_fail_ignores_never_ran unfired_injection_passes"

if [ "$PART" != controls ]; then
  for m in ${OBRP_HARNESS_MUTANTS:-$HARNESS_MUTANTS}; do
    tree="$T/$m"
    mkdir -p "$tree/scripts/loop-closing"
    cp "$HERE/action-item-review-sql-test.sh" "$HERE/action-item-review-sql-test.sql" "$HERE/action-item-review-integration.ts" \
       "$HERE/deadline.py" "$HERE/closeout-capture-probe.deno.json" "$tree/scripts/loop-closing/"
    ln -s "$ROOT/supabase" "$tree/supabase"
    JUDGES=""
    if ! harness_mutant "$tree" "$m"; then
      echo "NEVER-RAN $m: the harness mutant did not apply to exactly one site"; never=$((never + 1)); continue
    fi
    for j in $JUDGES; do
      if [ "$j" = canned ]; then
        out=$(bash "$tree/$SH" --verdict-selftest 2>&1); code=$?
        if [ "$code" = 1 ] && printf '%s\n' "$out" | grep -q '^FAIL verdict case '; then
          echo "CAUGHT    $m by canned: $(printf '%s\n' "$out" | grep -c '^FAIL verdict case ') case(s), first: $(printf '%s\n' "$out" | grep -m1 '^FAIL verdict case ' | cut -c1-170)"; caught=$((caught + 1))
        elif [ "$code" = 0 ]; then
          echo "SURVIVED  $m by canned: the verdict self-test still passes"; survived=$((survived + 1))
        else
          echo "NEVER-RAN $m by canned (exit $code): $(printf '%s\n' "$out" | tail -1 | cut -c1-160)"; never=$((never + 1))
        fi
        continue
      fi
      # A live judge: the copy without its start-up self-test (see the header).
      live="$tree/live"
      if [ ! -d "$live" ]; then
        mkdir -p "$live/scripts"; cp -R "$tree/scripts/loop-closing" "$live/scripts/"; ln -s "$ROOT/supabase" "$live/supabase"
        if ! apply "$live" "$SH" 'vst=$(verdict_selftest) || {' 'vst=$(true) || {'; then
          echo "NEVER-RAN $m by $j: could not remove the copy's start-up self-test"; never=$((never + 1)); continue
        fi
      fi
      run_control "$live/$SH" "$j"
      case $? in
        1) echo "CAUGHT    $m by $j: $(printf '%s' "$WHY" | cut -c1-230)"; caught=$((caught + 1));;
        0) echo "SURVIVED  $m by $j: the control still gets its verdict (exit $CODE)"; survived=$((survived + 1));;
        *) echo "NEVER-RAN $m by $j: $WHY"; never=$((never + 1));;
      esac
    done
  done
fi

shm_after=$(ipcs -m 2>/dev/null | grep -c '^m')
[ "$shm_after" -gt "$shm_before" ] && echo "WARNING: SysV shared memory segments grew from $shm_before to $shm_after during the self-test"
echo "HARNESS SELFTEST: $passed controls passed, $failed failed; $caught harness-mutant judgments caught, $survived survived; $never never ran"
if [ "$never" -gt 0 ]; then echo "HARNESS SELFTEST INCOMPLETE: $never run(s) could not be judged; they are neither passes nor catches"; exit 2; fi
if [ "$failed" -gt 0 ] || [ "$survived" -gt 0 ]; then echo "HARNESS SELFTEST FAILED"; exit 1; fi
echo "HARNESS SELFTEST PASSED"
exit 0
