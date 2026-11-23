#!/bin/bash
# Negative controls for the VERDICTS of archive-proposals-sql-test.sh and
# review-proposal-sql-test.sh, run without a human. Both runners counted every
# psql exit 3 from their SQL contract as a failed check, so a syntax error, a
# missing function or a statement timeout read as a FAIL and, in the sweep, as a
# caught mutant. They now follow the rule action-item-review-sql-test.sh has had
# since PR 25: only an exit 3 whose error carries the contract's own assertion
# SQLSTATE (TF001) is a completed failure. This file is modelled on
# action-item-review-harness-selftest.sh.
#
#   bash scripts/loop-closing/tf001-harness-selftest.sh                    # both runners, everything
#   bash scripts/loop-closing/tf001-harness-selftest.sh archive            # one runner
#   bash scripts/loop-closing/tf001-harness-selftest.sh review controls    # part 1 and 2 only
#   bash scripts/loop-closing/tf001-harness-selftest.sh both mutants       # part 1 and 3 only
#
# Part 1  the runner's canned verdict cases (--verdict-selftest, no database).
# Part 2  live controls on the real runner, each on its own throwaway cluster. Each
#         plants one known event (OBAP_INJECT / OBRP_INJECT in the runner) and
#         requires the exact verdict. Outcome 0: an untouched run passes. Outcome
#         1: a check that runs to completion and does not hold, and real mutants
#         in the sweep. Outcome 2: a syntax error, an undefined function, an SQL
#         error no check was written for, a real statement_timeout, the contract's
#         backend terminated, the outer deadline, a cancellation on a schedule
#         connection, a helper query that did not execute, and (review-proposal
#         only) a resource error raised inside the contract's own error handler.
#         review-proposal only, the integration bridge (PR 28 Codex review, P2):
#         outcome 0 with the integration step in; outcome 1 for a behavioral
#         database error handed to the code under test; outcome 2 for a REAL
#         statement_timeout on the Slack route (baseline and one-mutant sweep), a
#         cancellation through the helper and through the MCP tool, a cancelled
#         telemetry write that no assertion notices, an error with no readable
#         SQLSTATE, and a terminated backend. And where no psql answer exists at
#         all (PR 28 Codex re-review 1, P2): a REAL failure to launch psql on the
#         Slack route (not found; baseline and one-mutant sweep), the same launch
#         refused with permission denied, a psql killed by a signal, and a psql
#         that exits 0 without the output its statement must produce.
# Part 3  harness mutants. Each breaks ONE classification rule in a throwaway copy
#         of the runner (never this checkout) and must be caught by the judge named
#         for it: the canned cases, or a live control that then reports the wrong
#         verdict. "old_rule" restores the behavior before this rule exactly (any
#         psql exit 3 is a FAIL, and the sweep accepts it); "rule_inverted" makes
#         an assertion NEVER-RAN and any other SQL error a FAIL. For a live judge
#         the copy's start-up self-test is removed too, because a runner whose
#         classifiers fail their own cases refuses to give any verdict, which
#         would hide what the live control sees.
#
# Three outcomes: 0 "HARNESS SELFTEST PASSED"; 1 a control did not get its verdict
# or a harness mutant survived; 2 something could not be judged (a cluster did not
# start, a deadline, a mutant that did not apply). 2 is never a pass and never a catch.
export LC_ALL=C
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DEADLINE="$HERE/deadline.py"
WHICH="${1:-both}"; PART="${2:-all}"
case "$WHICH" in archive|review|both) ;; *) echo "usage: $0 [archive|review|both] [all|controls|mutants]"; exit 2;; esac
case "$PART" in all|controls|mutants) ;; *) echo "usage: $0 [archive|review|both] [all|controls|mutants]"; exit 2;; esac
T="$(mktemp -d /tmp/obtf-hs.XXXXXX)"
trap 'rm -rf "$T"' EXIT
passed=0; failed=0; caught=0; survived=0; never=0

# A run that says one of these did not reach the event under test.
TS=scripts/loop-closing/review-proposal-integration.ts
SETUP_FAILURE='NEVER-RAN: (initdb failed|pg start failed|create database failed|stub schema failed|prior migration failed|migration failed to apply|mutant did not change|injection [a-z_]+ did not apply|unknown injection|unknown mutation|the verdict classifiers failed|the carry-forward comparison)'

# harness <archive|review>: everything that differs between the two runners.
harness() {
  case "$1" in
    archive)
      H=archive; PFX=OBAP; NAME="ARCHIVE PROPOSALS SQL TEST"; DONE="ARCHIVE PROPOSALS TEST COMPLETE"
      SH=scripts/loop-closing/archive-proposals-sql-test.sh; SQL=scripts/loop-closing/archive-proposals-sql-test.sql
      COPY="archive-proposals-sql-test.sh archive-proposals-sql-test.sql deadline.py"
      GUARD='  cst=$(contract_selftest) || {'; GUARD_OFF='  cst=$(true) || {'
      ONE_MUTANT=pending_reproposed
      REAL_MUTANTS="pending_reproposed grant_anon no_prelock"
      REAL_MUST=('^CAUGHT    pending_reproposed: FAIL ARCHIVE PROPOSALS SQL TEST: FAIL A24 a second run is a no-op: '
                 '^CAUGHT    grant_anon: FAIL ARCHIVE PROPOSALS SQL TEST: FAIL G01 anon and authenticated cannot run or read the job: '
                 "^CAUGHT    no_prelock: FAIL C1: expected run=1, got 'run=2 '"
                 '^ALL 3 MUTATIONS CAUGHT$')
      CONTROLS="pass assert_fail real_mutants_sweep syntax_error undefined_function raw_error sql_timeout backend_killed syntax_error_sweep sql_timeout_sweep outer_deadline_sweep conn_cancel helper_cancel helper_stray injection_not_fired"
      HARNESS_MUTANTS="old_rule any_exit3_is_fail rule_inverted assertion_is_never_ran unjudged_error_is_fail interruption_is_fail marker_not_required no_sqlstate_is_fail passed_line_not_required other_exit_is_fail sweep_trusts_error_lines sweep_ignores_never_ran sweep_needs_no_fail_line interruption_57_dropped interruption_list_too_wide ok_raises_p0001 psql_not_verbose helper_exit1_trusted end_ignores_helper_failures fail_ignores_connections unfired_injection_passes";;
    review)
      H=review; PFX=OBRP; NAME="REVIEW PROPOSAL SQL TEST"; DONE="REVIEW PROPOSAL TEST COMPLETE"
      SH=scripts/loop-closing/review-proposal-sql-test.sh; SQL=scripts/loop-closing/review-proposal-sql-test.sql
      COPY="review-proposal-sql-test.sh review-proposal-sql-test.sql review-proposal-integration.ts closeout-capture-probe.deno.json deadline.py"
      GUARD='vst=$(verdict_selftest) || {'; GUARD_OFF='vst=$(true) || {'
      ONE_MUTANT=keep_no_item_columns
      REAL_MUTANTS="keep_no_item_columns deferred_done_allowed no_locks"
      REAL_MUST=('^CAUGHT    keep_no_item_columns: FAIL REVIEW PROPOSAL SQL TEST: FAIL T04 keep on an archive row writes the item columns: '
                 '^CAUGHT    deferred_done_allowed: FAIL REVIEW PROPOSAL SQL TEST: FAIL T33 done on a deferred item is refused: raised sqlstate=P0001: review_proposal: the done transition of c0330002-0000-4000-8000-000000000000 wrote 0 rows'
                 '^CAUGHT    no_locks: FAIL C1: the second review was not refused '
                 '^ALL 3 MUTATIONS CAUGHT$')
      CONTROLS="pass assert_fail real_mutants_sweep syntax_error undefined_function raw_error sql_timeout backend_killed resource_in_handler syntax_error_sweep sql_timeout_sweep outer_deadline_sweep conn_cancel helper_cancel helper_stray injection_not_fired pass_integration integration_behavioral_error integration_timeout_slack integration_timeout_slack_sweep integration_cancel_helper integration_cancel_mcp integration_cancel_telemetry integration_unreadable_state integration_backend_killed integration_psql_missing integration_psql_missing_sweep integration_psql_denied integration_psql_killed integration_psql_empty_rpc integration_psql_empty_count"
      HARNESS_MUTANTS="old_rule any_exit3_is_fail rule_inverted assertion_is_never_ran unjudged_error_is_fail interruption_is_fail marker_not_required no_sqlstate_is_fail passed_line_not_required other_exit_is_fail sweep_trusts_error_lines sweep_ignores_never_ran sweep_needs_no_fail_line interruption_57_dropped interruption_53_dropped interruption_list_too_wide ok_raises_p0001 psql_not_verbose handler_swallows_interruption t33_raise_unjudged helper_exit1_trusted end_ignores_helper_failures fail_ignores_connections unfired_injection_passes bridge_passes_interruption bridge_unreadable_is_answer bridge_fail_ignores_never_ran bridge_pass_ignores_never_ran bridge_never_ran_not_recorded bridge_catch_ignores_never_ran bridge_every_error_never_ran runner_bridge_list_without_57 runner_list_not_passed list_not_passed_not_required bridge_spawn_failure_not_converted bridge_spawn_failure_plain_error bridge_fail_skips_subprocess_record bridge_other_exit_is_answer bridge_empty_answer_parsed bridge_empty_count_is_zero";;
  esac
  RUNNER="$ROOT/$SH"
}

# control <name>: what to run and the verdict it must get.
#   C_ENV / C_ARGS   environment and arguments for the runner
#   C_EXIT           the exit status required
#   C_MUST           regexes that must each match a line of the output
#   C_NOT            a regex that must match no line
# SKIP_INTEGRATION=1 leaves out review-proposal's TypeScript step where the event
# under test is in the contract or the schedules; the archive runner ignores it.
# The integration_* controls and pass_integration keep the step in.
control() {
  C_ARGS=(); C_MUST=(); C_NOT='^FAIL '; C_LIMIT=180
  local unjudged="^NEVER-RAN: the SQL contract stopped on an SQL error that is not one of its assertions \\(SQLSTATE"
  case "$1" in
    pass)
      C_WHAT="outcome 0: an untouched run passes every check and exits 0"
      C_ENV=(SKIP_INTEGRATION=1); C_EXIT=0
      C_MUST=("^$NAME PASSED\$" "^$DONE\$"); C_NOT='^FAIL |^NEVER-RAN|^ERROR|^FATAL';;
    assert_fail)
      C_WHAT="outcome 1: a check that runs to completion and does not hold (TF001) is exit 1"
      C_ENV=("${PFX}_INJECT=assert_fail" SKIP_INTEGRATION=1); C_EXIT=1
      C_MUST=('^ERROR TF001: FAIL INJECTED a completed check that does not hold: one is not two$' "^FAIL $NAME: FAIL INJECTED a completed check that does not hold: one is not two\$")
      C_NOT='^NEVER-RAN';;
    real_mutants_sweep)
      C_WHAT="outcome 1 in the sweep: real mutants are CAUGHT, each by a completed check"
      C_ENV=(SKIP_INTEGRATION=1 "${PFX}_MUTATIONS=$REAL_MUTANTS"); C_ARGS=(--all-mutations); C_EXIT=0; C_LIMIT=300
      C_MUST=("${REAL_MUST[@]}"); C_NOT='^NEVER-RAN|^SURVIVED';;
    syntax_error)
      C_WHAT="outcome 2: a syntax error (psql exit 3, SQLSTATE 42601) is NEVER-RAN, not a failed check"
      C_ENV=("${PFX}_INJECT=syntax_error" SKIP_INTEGRATION=1); C_EXIT=2
      C_MUST=('^ERROR 42601: syntax error at or near "selec"$' "$unjudged 42601: syntax error at or near \"selec\"\\)");;
    undefined_function)
      C_WHAT="outcome 2: an undefined function (psql exit 3, SQLSTATE 42883) is NEVER-RAN"
      C_ENV=("${PFX}_INJECT=undefined_function" SKIP_INTEGRATION=1); C_EXIT=2
      C_MUST=('^ERROR 42883: function public.obt_no_such_function\(\) does not exist$' "$unjudged 42883: function public.obt_no_such_function\\(\\) does not exist\\)");;
    raw_error)
      C_WHAT="outcome 2: an SQL error no check was written for (22012) is NEVER-RAN"
      C_ENV=("${PFX}_INJECT=raw_error" SKIP_INTEGRATION=1); C_EXIT=2
      C_MUST=("$unjudged 22012: division by zero\\)");;
    sql_timeout)
      C_WHAT="outcome 2: a real statement_timeout (psql exit 3, SQLSTATE 57014) is NEVER-RAN"
      C_ENV=("${PFX}_INJECT=sql_timeout" SKIP_INTEGRATION=1); C_EXIT=2
      C_MUST=('^ERROR 57014: canceling statement due to statement timeout$' '^NEVER-RAN: the SQL contract was interrupted \(SQLSTATE 57014: canceling statement due to statement timeout\)');;
    backend_killed)
      C_WHAT="outcome 2: the contract's backend terminated mid-script (connection lost) is NEVER-RAN"
      C_ENV=("${PFX}_INJECT=backend_killed" SKIP_INTEGRATION=1); C_EXIT=2
      C_MUST=('^FATAL 57P01: terminating connection due to administrator command$' '^NEVER-RAN: the SQL contract did not complete \(psql exit 2\)');;
    resource_in_handler)
      C_WHAT="outcome 2: a resource error the contract's own handler catches is re-raised and is NEVER-RAN"
      C_ENV=("${PFX}_INJECT=resource_in_handler" SKIP_INTEGRATION=1); C_EXIT=2
      C_MUST=('^NEVER-RAN: the SQL contract was interrupted \(SQLSTATE 53200: out of memory \(injected\)\)');;
    syntax_error_sweep)
      C_WHAT="outcome 2 in the sweep: a syntax error under a mutant is NEVER-RAN, not CAUGHT"
      C_ENV=("${PFX}_INJECT=syntax_error" SKIP_INTEGRATION=1 "${PFX}_MUTATIONS=$ONE_MUTANT"); C_ARGS=(--all-mutations); C_EXIT=2
      C_MUST=("^NEVER-RAN $ONE_MUTANT \\(exit 2\\): NEVER-RAN: the SQL contract stopped on an SQL error that is not one of its assertions \\(SQLSTATE 42601" '^SWEEP: 1 mutations, 0 caught, 0 survived, 1 never ran$' '^SWEEP INCOMPLETE')
      C_NOT='^CAUGHT|MUTATIONS CAUGHT';;
    sql_timeout_sweep)
      C_WHAT="outcome 2 in the sweep: a statement timeout under a mutant is NEVER-RAN, not CAUGHT"
      C_ENV=("${PFX}_INJECT=sql_timeout" SKIP_INTEGRATION=1 "${PFX}_MUTATIONS=$ONE_MUTANT"); C_ARGS=(--all-mutations); C_EXIT=2
      C_MUST=("^NEVER-RAN $ONE_MUTANT \\(exit 2\\): NEVER-RAN: the SQL contract was interrupted \\(SQLSTATE 57014" '^SWEEP: 1 mutations, 0 caught, 0 survived, 1 never ran$' '^SWEEP INCOMPLETE')
      C_NOT='^CAUGHT|MUTATIONS CAUGHT';;
    outer_deadline_sweep)
      C_WHAT="outcome 2 in the sweep: a mutant killed by the outer deadline (deadline.py exit 124) is NEVER-RAN"
      C_ENV=("${PFX}_INJECT=sql_sleep" SKIP_INTEGRATION=1 "${PFX}_MUTATIONS=$ONE_MUTANT" "${PFX}_MUTANT_DEADLINE=20"); C_ARGS=(--all-mutations); C_EXIT=2
      C_MUST=("^NEVER-RAN $ONE_MUTANT: deadline of 20s exceeded, the run did not complete\$" '^SWEEP: 1 mutations, 0 caught, 0 survived, 1 never ran$')
      C_NOT='^CAUGHT|MUTATIONS CAUGHT';;
    conn_cancel)
      C_WHAT="outcome 2: a schedule check that fails on a cancelled connection is NEVER-RAN"
      C_ENV=("${PFX}_INJECT=conn_cancel" ONLY_CONCURRENCY=1); C_EXIT=2
      C_MUST=('^NEVER-RAN: a schedule connection was interrupted while checking: C1.*\(A: ERROR:  57014: canceling statement due to statement timeout');;
    helper_cancel)
      C_WHAT="outcome 2: a schedule check made after a helper query was cancelled is NEVER-RAN"
      C_ENV=("${PFX}_INJECT=helper_cancel" ONLY_CONCURRENCY=1); C_EXIT=2
      C_MUST=('^NEVER-RAN: a helper query did not execute while checking: C1.*psql exit 1: ERROR:  57014');;
    helper_stray)
      C_WHAT="outcome 2: a helper query that did not execute makes an otherwise passing run NEVER-RAN"
      C_ENV=("${PFX}_INJECT=helper_stray" ONLY_CONCURRENCY=1); C_EXIT=2
      C_MUST=('^PASS C2 ' '^NEVER-RAN: every check held, but a helper query did not execute during the run \(psql exit 1: ERROR:  22012');;
    injection_not_fired)
      C_WHAT="outcome 2: a control whose event never happened is NEVER-RAN, never a pass"
      C_ENV=("${PFX}_INJECT=assert_fail" ONLY_CONCURRENCY=1); C_EXIT=2
      C_MUST=('^PASS C2 ' '^NEVER-RAN: the injection assert_fail did not stop the run, so it did not fire$')
      C_NOT='^FAIL |TEST COMPLETE';;
    # ---- review-proposal's integration bridge (the step is NOT skipped) ----
    pass_integration)
      C_WHAT="outcome 0: an untouched run with the integration step passes every check and exits 0"
      C_ENV=("${PFX}_INJECT="); C_EXIT=0
      C_MUST=("^$NAME PASSED\$" '^REVIEW PROPOSAL INTEGRATION PASSED \(110 checks\)$' "^$DONE\$"); C_NOT='^FAIL |^NEVER-RAN|^ERROR|^FATAL';;
    integration_behavioral_error)
      C_WHAT="outcome 1: a behavioral database error (23514) answered through the bridge is a completed FAIL"
      C_ENV=("${PFX}_INJECT=integration_behavioral_error"); C_EXIT=1
      C_MUST=("^$NAME PASSED\$" '^FAIL integration: I1 Slack selective done recorded: c0710001 "integration c0710001": review failed: injected behavioral error \(OBRP_INJECT=integration_behavioral_error\)$')
      C_NOT='^NEVER-RAN';;
    integration_timeout_slack)
      C_WHAT="outcome 2: a real statement_timeout on the Slack route, swallowed by the client and the handler, is NEVER-RAN"
      C_ENV=("${PFX}_INJECT=integration_timeout_slack"); C_EXIT=2
      C_MUST=("^$NAME PASSED\$" '^PASS I I1 Slack done with two pending rows lists them$'
              '^NEVER-RAN integration: rpc review_proposal was interrupted \(SQLSTATE 57014: canceling statement due to statement timeout\); it did not complete, so nothing is judged on it \(while checking: I1 Slack selective done recorded: '
              '^NEVER-RAN: the integration harness did not complete \(exit 2\): NEVER-RAN integration: rpc review_proposal was interrupted \(SQLSTATE 57014: canceling statement due to statement timeout\)');;
    integration_timeout_slack_sweep)
      C_WHAT="outcome 2 in the sweep: the same timeout under a real mutant is NEVER-RAN, zero caught"
      C_ENV=("${PFX}_INJECT=integration_timeout_slack" "${PFX}_MUTATIONS=no_locks"); C_ARGS=(--all-mutations); C_EXIT=2
      C_MUST=('^NEVER-RAN no_locks \(exit 2\): NEVER-RAN: the integration harness did not complete \(exit 2\): NEVER-RAN integration: rpc review_proposal was interrupted \(SQLSTATE 57014: ' '^SWEEP: 1 mutations, 0 caught, 0 survived, 1 never ran$' '^SWEEP INCOMPLETE')
      C_NOT='^CAUGHT|MUTATIONS CAUGHT';;
    integration_cancel_helper)
      C_WHAT="outcome 2: a cancellation reaching the bridge through the helper is NEVER-RAN"
      C_ENV=("${PFX}_INJECT=integration_cancel_helper"); C_EXIT=2
      C_MUST=('^PASS I I2 the same through the helper$' '^NEVER-RAN integration: rpc review_proposal was interrupted \(SQLSTATE 57014: canceling statement due to statement timeout \(injected by OBRP_INJECT=integration_cancel_helper\)\); it did not complete, so nothing is judged on it$');;
    integration_cancel_mcp)
      C_WHAT="outcome 2: a cancellation reaching the bridge through the MCP tool is NEVER-RAN, named by the record"
      C_ENV=("${PFX}_INJECT=integration_cancel_mcp"); C_EXIT=2
      C_MUST=('^PASS I I7 MCP schema refusal: the callback never ran, zero telemetry$' '^NEVER-RAN integration: rpc review_proposal was interrupted \(SQLSTATE 57014: canceling statement due to statement timeout \(injected by OBRP_INJECT=integration_cancel_mcp\)\); it did not complete, so nothing is judged on it \(then: ');;
    integration_cancel_telemetry)
      C_WHAT="outcome 2: a cancelled bridge write that every assertion survives still stops the PASSED line"
      C_ENV=("${PFX}_INJECT=integration_cancel_telemetry"); C_EXIT=2
      C_MUST=('^PASS I the bridge really executed the RPCs \([0-9]+ calls\)$' '^NEVER-RAN integration: bridge query failed \(psql exit 1\): ERROR:  57014: canceling statement due to statement timeout \(injected by OBRP_INJECT=integration_cancel_telemetry\)$')
      C_NOT='^FAIL |INTEGRATION PASSED|TEST COMPLETE';;
    integration_unreadable_state)
      C_WHAT="outcome 2: an RPC error with no readable SQLSTATE is NEVER-RAN, not an answer"
      C_ENV=("${PFX}_INJECT=integration_unreadable_state"); C_EXIT=2
      C_MUST=('^NEVER-RAN integration: rpc review_proposal failed with no readable SQLSTATE \(psql exit 1\): FEHLER:  23514: injected behavioral error');;
    integration_backend_killed)
      C_WHAT="outcome 2: an RPC whose backend terminated (psql exit 2) is NEVER-RAN"
      C_ENV=("${PFX}_INJECT=integration_backend_killed"); C_EXIT=2
      C_MUST=('^PASS I I2 the same through the helper$' '^NEVER-RAN integration: rpc review_proposal could not execute \(psql exit 2\): FATAL:  57P01: terminating connection due to administrator command$');;
    # ---- the psql subprocess itself (PR 28 Codex re-review 1, P2) ----
    integration_psql_missing)
      C_WHAT="outcome 2: a psql that cannot be launched (not found), swallowed by the client and the Slack handler, is NEVER-RAN"
      C_ENV=("${PFX}_INJECT=integration_psql_missing"); C_EXIT=2
      C_MUST=("^$NAME PASSED\$"
              "^NEVER-RAN integration: psql subprocess could not execute: NotFound: Failed to spawn 'psql': entity not found \\(while checking: I1 Slack done with two pending rows lists them: lookup failed: "
              "^NEVER-RAN: the integration harness did not complete \\(exit 2\\): NEVER-RAN integration: psql subprocess could not execute: NotFound: Failed to spawn 'psql': entity not found");;
    integration_psql_missing_sweep)
      C_WHAT="outcome 2 in the sweep: the same launch failure under a real mutant is NEVER-RAN, zero caught"
      C_ENV=("${PFX}_INJECT=integration_psql_missing" "${PFX}_MUTATIONS=no_locks"); C_ARGS=(--all-mutations); C_EXIT=2
      C_MUST=('^NEVER-RAN no_locks \(exit 2\): NEVER-RAN: the integration harness did not complete \(exit 2\): NEVER-RAN integration: psql subprocess could not execute: NotFound: ' '^SWEEP: 1 mutations, 0 caught, 0 survived, 1 never ran$' '^SWEEP INCOMPLETE')
      C_NOT='^CAUGHT|MUTATIONS CAUGHT';;
    integration_psql_denied)
      C_WHAT="outcome 2: a psql the operating system refuses to execute (permission denied) is NEVER-RAN"
      C_ENV=("${PFX}_INJECT=integration_psql_denied"); C_EXIT=2
      C_MUST=("^$NAME PASSED\$"
              "^NEVER-RAN integration: psql subprocess could not execute: PermissionDenied: Failed to spawn '[^']*/ibin/psql': Permission denied \\(os error 13\\) \\(while checking: I1 Slack done with two pending rows lists them: lookup failed: ");;
    integration_psql_killed)
      C_WHAT="outcome 2: a psql killed by a signal (exit 137, no answer) is NEVER-RAN"
      C_ENV=("${PFX}_INJECT=integration_psql_killed"); C_EXIT=2
      C_MUST=("^$NAME PASSED\$"
              '^NEVER-RAN integration: rpc resolve_proposal_item could not execute \(psql exit 137\):  \(while checking: I1 Slack done with two pending rows lists them: lookup failed: ');;
    integration_psql_empty_rpc)
      C_WHAT="outcome 2: an RPC whose psql exits 0 without a JSON answer is NEVER-RAN, not a parse error handed to the client"
      C_ENV=("${PFX}_INJECT=integration_psql_empty_rpc"); C_EXIT=2
      C_MUST=("^$NAME PASSED\$"
              '^NEVER-RAN integration: rpc resolve_proposal_item gave no readable answer \(psql exit 0, output is not JSON\):  \(while checking: I1 Slack done with two pending rows lists them: lookup failed: ');;
    integration_psql_empty_count)
      C_WHAT="outcome 2: a telemetry count whose psql exits 0 with no number is NEVER-RAN, not zero rows"
      C_ENV=("${PFX}_INJECT=integration_psql_empty_count"); C_EXIT=2
      C_MUST=('^PASS I I1 persisted: one close event with the Slack actor and source$'
              '^NEVER-RAN integration: telemetry count gave no readable answer \(psql exit 0, output is not a number\): $');;
    *) echo "unknown control $1"; exit 2;;
  esac
}

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

apply() { # tree, file, old, new [, sites]: literal; exactly <sites> occurrences (default 1)
  python3 - "$1/$2" "$3" "$4" "${5:-1}" <<'PY'
import sys
p, a, b, n = sys.argv[1:5]
s = open(p).read()
if s.count(a) != int(n): sys.exit(1)
open(p, 'w').write(s.replace(a, b))
PY
}
OLD_EXIT3='      case "$(sqlstate_kind "$state")" in
        assertion)'
NEW_EXIT3='      VERDICT="$msg"; return 1
      case "$(sqlstate_kind "$state")" in
        assertion)'
OLD_ERRARM='      bad=$(printf '"'"'%s\n'"'"' "$out" | grep -E '"'"'^ERROR'"'"' | grep -m1 -v "^ERROR $ASSERT_STATE: FAIL ")'
UNJUDGED_2='so it is not a failure and not a catch"; return 2;;'
UNJUDGED_1='so it is not a failure and not a catch"; return 1;;'
ASSERT_1='            "FAIL "*) VERDICT="$msg"; return 1;;'
ASSERT_2='            "FAIL "*) VERDICT="$msg"; return 2;;'
T33_NEW="  begin
    select * into r from pg_temp.rp('c0330002-0000-4000-8000-000000000000', 'done');
    v_ans := r.status || ': ' || r.message;
  exception when others then
    if pg_temp.interruption(sqlstate) then raise; end if;
    v_ans := format('raised sqlstate=%s: %s', sqlstate, sqlerrm);
  end;
"
T33_OLD="  select * into r from pg_temp.rp('c0330002-0000-4000-8000-000000000000', 'done');
  v_ans := r.status || ': ' || r.message;
"
# harness_mutant <tree> <name>: applies it; sets JUDGES ("canned" and/or control names).
harness_mutant() {
  case "$2" in
    # The behavior before this rule, both halves: every psql exit 3 is a FAIL, and
    # the sweep takes that FAIL without looking at the SQL error beside it.
    old_rule) JUDGES="canned syntax_error undefined_function sql_timeout syntax_error_sweep sql_timeout_sweep"
      apply "$1" "$SH" "$OLD_EXIT3" "$NEW_EXIT3" && apply "$1" "$SH" "$OLD_ERRARM" '      bad=""';;
    # The contract half alone: the sweep's own arm still refuses, the baseline does not.
    any_exit3_is_fail) JUDGES="canned syntax_error undefined_function raw_error sql_timeout"
      apply "$1" "$SH" "$OLD_EXIT3" "$NEW_EXIT3";;
    # The rule turned round: an assertion is NEVER-RAN, any other SQL error a FAIL.
    rule_inverted) JUDGES="canned assert_fail syntax_error undefined_function real_mutants_sweep"
      apply "$1" "$SH" "$ASSERT_1" "$ASSERT_2" && apply "$1" "$SH" "$UNJUDGED_2" "$UNJUDGED_1";;
    # One arm at a time.
    assertion_is_never_ran) JUDGES="canned assert_fail real_mutants_sweep"
      apply "$1" "$SH" "$ASSERT_1" "$ASSERT_2";;
    unjudged_error_is_fail) JUDGES="canned syntax_error undefined_function raw_error"
      apply "$1" "$SH" "$UNJUDGED_2" "$UNJUDGED_1";;
    interruption_is_fail) JUDGES="canned sql_timeout"
      apply "$1" "$SH" 'the statement did not complete, so no check was judged"; return 2;;' 'the statement did not complete, so no check was judged"; return 1;;';;
    marker_not_required) JUDGES="canned"
      apply "$1" "$SH" 'without a FAIL message, so no named check failed: $msg"; return 2;;' 'without a FAIL message, so no named check failed: $msg"; return 1;;';;
    no_sqlstate_is_fail) JUDGES="canned"
      apply "$1" "$SH" '| cut -c1-200)"; return 2;;
      esac;;' '| cut -c1-200)"; return 1;;
      esac;;';;
    passed_line_not_required) JUDGES="canned"
      apply "$1" "$SH" 'VERDICT="the SQL contract exited 0 without its PASSED line"; return 2;;' 'VERDICT="the SQL contract exited 0 without its PASSED line"; return 0;;';;
    # A psql exit that is neither 0 nor 3 (a lost connection is 2) read as a FAIL.
    other_exit_is_fail) JUDGES="canned backend_killed"
      apply "$1" "$SH" '    *) VERDICT="the SQL contract did not complete (psql exit $code): $(tail -1 "$file" | cut -c1-160)"; return 2;;' '    *) VERDICT="the SQL contract did not complete (psql exit $code): $(tail -1 "$file" | cut -c1-160)"; return 1;;';;
    # The sweep's arms, one at a time (only a canned transcript isolates each).
    sweep_trusts_error_lines) JUDGES="canned"
      apply "$1" "$SH" "$OLD_ERRARM" '      bad=""';;
    sweep_ignores_never_ran) JUDGES="canned"
      apply "$1" "$SH" '      bad=$(printf '"'"'%s\n'"'"' "$out" | grep -m1 '"'"'^NEVER-RAN'"'"')' '      bad=""';;
    sweep_needs_no_fail_line) JUDGES="canned"
      apply "$1" "$SH" '      echo "NEVER-RAN $m: exit 1 with no completed FAIL line: $(printf '"'"'%s\n'"'"' "$out" | tail -1 | cut -c1-140)"; return 2;;' '      echo "CAUGHT    $m"; return 0;;';;
    # The shared list. Live, the schedules read it directly (conn_cancel); the
    # review-proposal contract's handlers read it too (resource_in_handler, where
    # the contract's own T00 check stops a wrong list first, a FAIL T00, exit 1).
    interruption_57_dropped) JUDGES="canned conn_cancel"
      apply "$1" "$SH" 'INTERRUPTION_PREFIXES="08 53 54 57 58 XX 55P03"' 'INTERRUPTION_PREFIXES="08 53 54 58 XX 55P03"';;
    interruption_53_dropped) JUDGES="canned resource_in_handler"
      apply "$1" "$SH" 'INTERRUPTION_PREFIXES="08 53 54 57 58 XX 55P03"' 'INTERRUPTION_PREFIXES="08 54 57 58 XX 55P03"';;
    # The list widened to a behavioral class: a foreign-key error would be an interruption.
    interruption_list_too_wide) JUDGES="canned"
      apply "$1" "$SH" 'INTERRUPTION_PREFIXES="08 53 54 57 58 XX 55P03"' 'INTERRUPTION_PREFIXES="08 23 53 54 57 58 XX 55P03"';;
    # The contract's side of the rule: its checks fail with the default SQLSTATE
    # again, or psql stops printing SQLSTATEs. Both must stop reading as a FAIL.
    ok_raises_p0001) JUDGES="assert_fail real_mutants_sweep"
      apply "$1" "$SQL" "    raise exception using errcode = 'TF001'," "    raise exception using errcode = 'P0001',";;
    psql_not_verbose) JUDGES="assert_fail"
      apply "$1" "$SH" 'PSQL=(psql -X -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -q)' 'PSQL=(psql -X -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)';;
    # review-proposal only: the contract's handlers report an interruption as the
    # code's answer (all six sites).
    handler_swallows_interruption) JUDGES="resource_in_handler"
      apply "$1" "$SQL" '    if pg_temp.interruption(sqlstate) then raise; end if;
' '' 6;;
    # review-proposal only: T33 as it was before this rule, so the mutant
    # deferred_done_allowed raises P0001 with no check to judge it.
    t33_raise_unjudged) JUDGES="real_mutants_sweep"
      apply "$1" "$SQL" "$T33_NEW" "$T33_OLD";;
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
    # A control whose event never fired passes.
    unfired_injection_passes) JUDGES="injection_not_fired"
      apply "$1" "$SH" '[ -n "$INJECT" ] && never "the injection' '[ -n "" ] && never "the injection';;
    # ---- review-proposal only: the integration bridge (PR 28 Codex review, P2) ----
    # The bridge as it was: an interruption is handed to the code under test as an
    # answer (a 400), so the check made on it reads as a failed check and a catch.
    bridge_passes_interruption) JUDGES="integration_timeout_slack integration_timeout_slack_sweep integration_cancel_helper integration_cancel_mcp"
      apply "$1" "$TS" '    if (INTERRUPTION_PREFIXES.some((p) => m[1].startsWith(p))) {' '    if (false) {';;
    # As it was for an error line with no SQLSTATE: the raw text is the answer.
    bridge_unreadable_is_answer) JUDGES="integration_unreadable_state"
      apply "$1" "$TS" '    if (!m) throw new NeverRan(`rpc ${fn} failed with no readable SQLSTATE (psql exit ${r.code}): ${r.err.trim().slice(0, 300)}`);' '    if (!m) return { data: null, error: { message: r.err.trim() }, status: 400 };';;
    # The record of an incomplete execution is not read before a failure: what
    # the client and the Slack handler swallowed becomes a failed check.
    bridge_fail_ignores_never_ran) JUDGES="integration_timeout_slack integration_timeout_slack_sweep integration_unreadable_state integration_psql_missing"
      apply "$1" "$TS" '  if (neverRan.length) {
    say(`NEVER-RAN integration: ${neverRan[0]} (while checking' '  if (false) {
    say(`NEVER-RAN integration: ${neverRan[0]} (while checking';;
    # ... nor before the PASSED line: a swallowed failure no assertion notices passes.
    bridge_pass_ignores_never_ran) JUDGES="integration_cancel_telemetry"
      apply "$1" "$TS" '  if (neverRan.length) throw new NeverRan(neverRan[0]);
' '';;
    # A NeverRan that is thrown but not recorded: caught by the client, it is gone.
    bridge_never_ran_not_recorded) JUDGES="integration_timeout_slack integration_cancel_telemetry integration_psql_missing"
      apply "$1" "$TS" '    neverRan.push(message);
' '';;
    # The record is not read when another exception follows the swallowed one.
    bridge_catch_ignores_never_ran) JUDGES="integration_cancel_mcp"
      apply "$1" "$TS" '  if (neverRan.length) { say(`NEVER-RAN integration: ${neverRan[0]} (then: ' '  if (false) { say(`NEVER-RAN integration: ${neverRan[0]} (then: ';;
    # The other direction: every database error is NEVER-RAN, so a behavioral
    # answer can no longer fail a check.
    bridge_every_error_never_ran) JUDGES="integration_behavioral_error"
      apply "$1" "$TS" '    if (INTERRUPTION_PREFIXES.some((p) => m[1].startsWith(p))) {' '    if (true) {';;
    # The runner hands the bridge a list of its own, without class 57 (the
    # contract still gets the shared list, so its T00 checks hold).
    runner_bridge_list_without_57) JUDGES="integration_timeout_slack integration_cancel_helper"
      apply "$1" "$SH" 'OBRP_INTERRUPTION_PREFIXES="$INTERRUPTION_PREFIXES" python3' 'OBRP_INTERRUPTION_PREFIXES="08 53 54 58 XX 55P03" python3';;
    # The runner does not hand the list over. The bridge refuses to run without
    # it (fails closed), which the positive control sees.
    runner_list_not_passed) JUDGES="pass_integration"
      apply "$1" "$SH" ' OBRP_INTERRUPTION_PREFIXES="$INTERRUPTION_PREFIXES" python3' ' python3';;
    # ... and with the bridge's own guard gone too, an interruption is an answer again.
    list_not_passed_not_required) JUDGES="integration_timeout_slack integration_cancel_helper"
      apply "$1" "$SH" ' OBRP_INTERRUPTION_PREFIXES="$INTERRUPTION_PREFIXES" python3' ' python3' \
        && apply "$1" "$TS" 'if (INTERRUPTION_PREFIXES.length === 0) {' 'if (false) {';;
    # ---- the psql subprocess itself (PR 28 Codex re-review 1, P2) ----
    # psql() as it was: a native failure to launch the subprocess leaves as the
    # runtime's own exception, which the client and the Slack handler turn into
    # an answer ("lookup failed: NotFound: ...").
    bridge_spawn_failure_not_converted) JUDGES="integration_psql_missing integration_psql_missing_sweep integration_psql_denied"
      apply "$1" "$TS" '    throw new NeverRan(`psql subprocess could not execute: ${String(e).slice(0, 300)}`);' '    throw e;';;
    # Wrapped, but into a plain Error: the reason reads right and nothing is recorded.
    bridge_spawn_failure_plain_error) JUDGES="integration_psql_missing integration_psql_missing_sweep"
      apply "$1" "$TS" '    throw new NeverRan(`psql subprocess could not execute: ${String(e).slice(0, 300)}`);' '    throw new Error(`psql subprocess could not execute: ${String(e).slice(0, 300)}`);';;
    # Recorded, and the record is not consulted for this kind of entry.
    bridge_fail_skips_subprocess_record) JUDGES="integration_psql_missing integration_psql_missing_sweep integration_psql_denied"
      apply "$1" "$TS" '  if (neverRan.length) {
    say(`NEVER-RAN integration: ${neverRan[0]} (while checking' '  if (neverRan.some((m) => !m.startsWith("psql subprocess"))) {
    say(`NEVER-RAN integration: ${neverRan[0]} (while checking';;
    # A psql exit that is none of 0, 1, 3 (a killed child is 137, a lost
    # connection 2) handed to the code under test as an answer.
    bridge_other_exit_is_answer) JUDGES="integration_psql_killed integration_backend_killed"
      apply "$1" "$TS" '  throw new NeverRan(`rpc ${fn} could not execute (psql exit ${r.code}): ${r.err.trim().slice(0, 300)}`);' '  return { data: null, error: { message: `psql exit ${r.code}: ${r.err.trim().slice(0, 300)}` }, status: 400 };';;
    # Exit 0 is parsed as it was: an answer that is not JSON throws a SyntaxError
    # inside fetch, which the client turns into an answer.
    bridge_empty_answer_parsed) JUDGES="integration_psql_empty_rpc"
      apply "$1" "$TS" '    try { data = JSON.parse(r.out.trim()); } catch {
      throw new NeverRan(`rpc ${fn} gave no readable answer (psql exit 0, output is not JSON): ${r.out.trim().slice(0, 200)}`);
    }' '    data = JSON.parse(r.out.trim());';;
    # An empty count reads as the number 0 again.
    bridge_empty_count_is_zero) JUDGES="integration_psql_empty_count"
      apply "$1" "$TS" '  if (!/^[0-9]+$/.test(v)) throw new NeverRan(' '  if (false) throw new NeverRan(';;
    *) return 2;;
  esac
}

shm_before=$(ipcs -m 2>/dev/null | grep -c '^m')
[ "$WHICH" = both ] && LIST="archive review" || LIST="$WHICH"
for which in $LIST; do
  harness "$which"
  echo "== $H: $SH"

  # ---- Part 1: the canned cases on the real runner ----
  out=$(bash "$RUNNER" --verdict-selftest 2>&1); code=$?
  if [ "$code" = 0 ] && printf '%s\n' "$out" | grep -Eq '^CONTRACT VERDICT SELFTEST PASSED \([0-9]+ cases\)$'; then
    echo "PASS $H canned: $(printf '%s\n' "$out" | grep -E '^CONTRACT VERDICT SELFTEST PASSED')"; passed=$((passed + 1))
  else
    echo "FAIL $H canned: the runner's verdict self-test did not pass (exit $code): $(printf '%s\n' "$out" | head -3 | tr '\n' ' ')"; failed=$((failed + 1))
  fi

  # ---- Part 2: live controls on the real runner ----
  if [ "$PART" != mutants ]; then
    for c in ${OBTF_CONTROLS:-$CONTROLS}; do
      run_control "$RUNNER" "$c"
      case $? in
        0) echo "PASS $H control $c (exit $CODE): $C_WHAT"; passed=$((passed + 1));;
        1) echo "FAIL $H control $c: $WHY"; excerpt; failed=$((failed + 1));;
        *) echo "NEVER-RAN $H control $c: $WHY"; excerpt; never=$((never + 1));;
      esac
    done
  fi

  # ---- Part 3: harness mutants, in a throwaway copy of the runner ----
  if [ "$PART" != controls ]; then
    for m in ${OBTF_HARNESS_MUTANTS:-$HARNESS_MUTANTS}; do
      tree="$T/$H-$m"
      mkdir -p "$tree/scripts/loop-closing"
      for f in $COPY; do cp "$HERE/$f" "$tree/scripts/loop-closing/"; done
      ln -s "$ROOT/supabase" "$tree/supabase"
      JUDGES=""
      if ! harness_mutant "$tree" "$m"; then
        echo "NEVER-RAN $H $m: the harness mutant did not apply to exactly its site(s)"; never=$((never + 1)); continue
      fi
      for j in $JUDGES; do
        if [ "$j" = canned ]; then
          out=$(bash "$tree/$SH" --verdict-selftest 2>&1); code=$?
          if [ "$code" = 1 ] && printf '%s\n' "$out" | grep -q '^FAIL verdict case '; then
            echo "CAUGHT    $H $m by canned: $(printf '%s\n' "$out" | grep -c '^FAIL verdict case ') case(s), first: $(printf '%s\n' "$out" | grep -m1 '^FAIL verdict case ' | cut -c1-170)"; caught=$((caught + 1))
          elif [ "$code" = 0 ]; then
            echo "SURVIVED  $H $m by canned: the verdict self-test still passes"; survived=$((survived + 1))
          else
            echo "NEVER-RAN $H $m by canned (exit $code): $(printf '%s\n' "$out" | tail -1 | cut -c1-160)"; never=$((never + 1))
          fi
          continue
        fi
        # A live judge: the copy without its start-up self-test (see the header).
        live="$tree/live"
        if [ ! -d "$live" ]; then
          mkdir -p "$live/scripts"; cp -R "$tree/scripts/loop-closing" "$live/scripts/"; ln -s "$ROOT/supabase" "$live/supabase"
          if ! apply "$live" "$SH" "$GUARD" "$GUARD_OFF"; then
            echo "NEVER-RAN $H $m by $j: could not remove the copy's start-up self-test"; never=$((never + 1)); continue
          fi
        fi
        run_control "$live/$SH" "$j"
        case $? in
          1) echo "CAUGHT    $H $m by $j: $(printf '%s' "$WHY" | cut -c1-230)"; caught=$((caught + 1));;
          0) echo "SURVIVED  $H $m by $j: the control still gets its verdict (exit $CODE)"; survived=$((survived + 1));;
          *) echo "NEVER-RAN $H $m by $j: $WHY"; never=$((never + 1));;
        esac
      done
    done
  fi
done

shm_after=$(ipcs -m 2>/dev/null | grep -c '^m')
[ "$shm_after" -gt "$shm_before" ] && echo "WARNING: SysV shared memory segments grew from $shm_before to $shm_after during the self-test"
echo "HARNESS SELFTEST: $passed controls passed, $failed failed; $caught harness-mutant judgments caught, $survived survived; $never never ran"
if [ "$never" -gt 0 ]; then echo "HARNESS SELFTEST INCOMPLETE: $never run(s) could not be judged; they are neither passes nor catches"; exit 2; fi
if [ "$failed" -gt 0 ] || [ "$survived" -gt 0 ]; then echo "HARNESS SELFTEST FAILED"; exit 1; fi
echo "HARNESS SELFTEST PASSED"
exit 0
