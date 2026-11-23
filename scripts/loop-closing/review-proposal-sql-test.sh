#!/bin/bash
# Loop-closing Task 3.6 (with Task 3.2's schema part): prove
# 20261109a_action_items_archive_proposals.sql and 20261109b_review_proposal_rpc.sql
# on a throwaway LOCAL PostgreSQL cluster (never production).
#
#   bash scripts/loop-closing/review-proposal-sql-test.sh                  # exit 0 passed
#   bash scripts/loop-closing/review-proposal-sql-test.sh --mutate <name>  # exit 1 expected
#   bash scripts/loop-closing/review-proposal-sql-test.sh --all-mutations  # all must be CAUGHT
#   bash scripts/loop-closing/review-proposal-sql-test.sh --verdict-selftest  # no database
# (Live negative controls for these verdicts: tf001-harness-selftest.sh review.)
#
# Three outcomes, never two (PR 23 review F3):
#   0  passed: every check ran to completion and held.
#   1  FAILED: a check RAN TO COMPLETION and its assertion did not hold. Only this is
#      a caught mutation. Every exit 1 prints a line starting "FAIL ".
#   2  NEVER-RAN: the cluster, a migration or a mutant did not apply; a connection
#      never finished its statements; a helper query did not execute; a statement
#      was cancelled, timed out or lost a resource; the SQL contract stopped on an
#      error that is not one of its own assertions; a step stopped before its last
#      check. Nothing was judged, so nothing was caught.
#
# A psql error is NOT by itself a failed check. This is the rule
# action-item-review-sql-test.sh has had since the PR 25 Codex review (P2,
# 2026-11-18): psql exits 3 for a syntax error, a missing function or a statement
# cancelled by statement_timeout just as it does for a failed assertion. Until
# 2026-11-19 this runner counted every psql exit 3 as a FAIL. The rule, an allowlist:
#   - The SQL contract's exit 3 is a FAIL only when its first error carries the
#     contract's own assertion SQLSTATE (TF001, raised by pg_temp.ok and by nothing
#     else) and a message starting "FAIL ". Every error a mutant is expected to
#     produce is judged inside the contract by a named check, so no raw SQL error
#     has to count. Any other SQLSTATE, and an error with no readable SQLSTATE, is
#     NEVER-RAN.
#   - A helper query (q) that exits non-zero for any reason did not execute: the
#     check made on it, and the run as a whole, is NEVER-RAN.
#   - A schedule check that fails while either connection's transcript carries an
#     interruption (INTERRUPTION_PREFIXES below, or an error with no readable
#     SQLSTATE) is NEVER-RAN. A behavioral error there is still a completed answer.
#   - The integration bridge (review-proposal-integration.ts) treats the same
#     SQLSTATE list as NEVER-RAN, and so an error with no readable SQLSTATE. It
#     keeps a record of every incomplete execution, because the client library
#     and the Slack handler catch an exception thrown inside fetch, and reads that
#     record before it prints a FAIL and before it prints its PASSED line. A
#     psql subprocess that could not be launched at all (no exit status exists),
#     and a psql exit 0 without the output its statement must produce, are
#     recorded the same way (PR 28 Codex re-review 1, P2).
# --all-mutations runs each mutant under its own deadline (OBRP_MUTANT_DEADLINE,
# default 300 s) via deadline.py; a deadline (124), any exit other than 0/1, an
# exit 1 with no completed "FAIL " line, an exit 1 whose output also says NEVER-RAN
# or shows an SQL error other than a contract assertion are all NEVER-RAN, and the
# sweep exits 2 if any mutant never ran, 1 if any survived, 0 only when every one
# was CAUGHT.
#
# What it proves, in order:
#   1. The two trigger functions in 20261107, with their "-- T3.2+" lines removed,
#      are byte-identical to 20261106's (production matched 20261106 on 2026-11-17).
#   2. The single-connection contract in review-proposal-sql-test.sql (T01 to T39),
#      every refusal compared against a complete before/after snapshot of
#      action_items, auto_resolve_decisions and action_item_events.
#   3. review-proposal-integration.ts: the public helper, the MCP tool entrypoint
#      and the Slack entrypoint wired to these real RPCs (nothing scripted).
#   4. Schedules on real second connections:
#      C1 concurrent keep and archive on one item: one review, one refusal, and the
#         second really waits on the lock (read from pg_stat_activity).
#      C2 reversed start order: B's reviewed_at EARLIER than A's, review_seq greater.
#      C3 (Codex's reviewer schedule) a producer insert waits behind an uncommitted
#         archive review; the review reopens the item and commits; the producer's
#         row is stamped generation 1; the next keep is review_seq 2.
#      C4 (investigation, not a fix) the dedup survivor read is unlocked: the
#         survivor archived by a concurrent uncommitted transaction, and archived
#         and committed before the review. Outcomes are compared with serial order.
export LC_ALL=C
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/scripts/loop-closing"
M_MCP_LOG="$ROOT/supabase/migrations/0016_mcp_tool_invocations.sql"
M_DECISIONS="$ROOT/supabase/migrations/20261105_auto_resolve_decisions.sql"
M_CLOSE="$ROOT/supabase/migrations/20261106_action_items_close_reason.sql"
M_ARCHIVE="$ROOT/supabase/migrations/20261109a_action_items_archive_proposals.sql"
M_REVIEW="$ROOT/supabase/migrations/20261109b_review_proposal_rpc.sql"
# OBRP_TEST_SQL lets a negative control run an OLDER contract against a mutant. A
# contract older than the TF001 rule raises its failures without that SQLSTATE,
# so this runner reports them as NEVER-RAN, not as failed checks.
TEST_SQL="${OBRP_TEST_SQL:-$HERE/review-proposal-sql-test.sql}"

MUTATIONS="latest_by_time no_generation_filter keep_no_item_columns archive_reason_always_expired decision_ref_on_keep transition_unchecked recheck_no_evidence survivor_unchecked mcp_actor_unchecked slack_actor_unchecked closed_any_verb_recorded no_locks no_earlier_review_branch resolution_set_without_latest seq_per_generation reopen_keeps_archive_columns reopen_event_drops_archive deferred_done_allowed rpc_grant_anon ambiguous_takes_first restore_hint_for_open blank_ref_as_absent empty_done_ref_unchecked refusal_writes_note refusal_rewrites_event"
MUTANT_DEADLINE="${OBRP_MUTANT_DEADLINE:-300}"

# SQLSTATE prefixes that mean the statement was interrupted or the server could
# not do the work: nothing was judged. 08 connection, 53 insufficient resources,
# 54 program limit, 57 operator intervention (57014 is statement_timeout and
# cancel), 58 system error, XX internal error, 55P03 lock_timeout. The SQL
# contract is handed this same list.
INTERRUPTION_PREFIXES="08 53 54 57 58 XX 55P03"
# The SQL contract's assertion failures: pg_temp.ok raises this, nothing else does.
ASSERT_STATE=TF001
CONTRACT_NAME="REVIEW PROPOSAL SQL TEST"
# The contract's last line, as psql prints it (a one-column result row, so one leading space).
CONTRACT_PASSED_RE='^ REVIEW PROPOSAL SQL TEST PASSED$'

# sqlstate_kind <state>: assertion | interruption | behavioral | unparseable.
sqlstate_kind() {
  local p
  case "$1" in
    [0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z]) ;;
    *) echo unparseable; return;;
  esac
  [ "$1" = "$ASSERT_STATE" ] && { echo assertion; return; }
  for p in $INTERRUPTION_PREFIXES; do
    case "$1" in "$p"*) echo interruption; return;; esac
  done
  echo behavioral
}

# contract_verdict <psql exit> <output file>: judge one run of the SQL contract
# (psql -f, ON_ERROR_STOP, VERBOSITY=verbose, so every error line carries its
# SQLSTATE). Sets VERDICT; returns 0 passed, 1 a completed assertion failed,
# 2 NEVER-RAN. psql's exit 3 says only that a statement raised.
contract_verdict() {
  local code="$1" file="$2" first state msg
  first=$(grep -m1 -E '^psql:.*:[0-9]+: ERROR:  ' "$file")
  case "$code" in
    0)
      if [ -n "$first" ]; then VERDICT="psql exited 0 but its output carries an error"; return 2; fi
      if grep -Eq "$CONTRACT_PASSED_RE" "$file"; then VERDICT="passed"; return 0; fi
      VERDICT="the SQL contract exited 0 without its PASSED line"; return 2;;
    3)
      state=$(printf '%s\n' "$first" | sed -nE 's/^psql:.*:[0-9]+: ERROR:  ([0-9A-Z]{5}): .*$/\1/p')
      msg=$(printf '%s\n' "$first" | sed -E 's/^psql:.*:[0-9]+: ERROR:  ([0-9A-Z]{5}: )?//' | cut -c1-240)
      case "$(sqlstate_kind "$state")" in
        assertion)
          case "$msg" in
            "FAIL "*) VERDICT="$msg"; return 1;;
          esac
          VERDICT="SQLSTATE $ASSERT_STATE without a FAIL message, so no named check failed: $msg"; return 2;;
        interruption) VERDICT="the SQL contract was interrupted (SQLSTATE $state: $msg); the statement did not complete, so no check was judged"; return 2;;
        behavioral) VERDICT="the SQL contract stopped on an SQL error that is not one of its assertions (SQLSTATE $state: $msg); no check judged it, so it is not a failure and not a catch"; return 2;;
        *) VERDICT="the SQL contract stopped (psql exit 3) on an error with no readable SQLSTATE: $(printf '%s' "${first:-$(tail -1 "$file")}" | cut -c1-200)"; return 2;;
      esac;;
    *) VERDICT="the SQL contract did not complete (psql exit $code): $(tail -1 "$file" | cut -c1-160)"; return 2;;
  esac
}

# classify <mutation> <exit code> <output>: prints one line; returns 0 CAUGHT,
# 1 SURVIVED, 2 NEVER-RAN. An exit 1 is a catch only when the run printed a
# completed "FAIL " line and nothing in it says the run was cut short: no
# NEVER-RAN line, and no SQL error line other than a contract assertion.
classify() {
  local m="$1" code="$2" out="$3" line bad
  case "$code" in
    1)
      bad=$(printf '%s\n' "$out" | grep -m1 '^NEVER-RAN')
      if [ -n "$bad" ]; then echo "NEVER-RAN $m: exit 1, but the run says it did not complete: $(printf '%s' "$bad" | cut -c1-160)"; return 2; fi
      bad=$(printf '%s\n' "$out" | grep -E '^ERROR' | grep -m1 -v "^ERROR $ASSERT_STATE: FAIL ")
      if [ -n "$bad" ]; then echo "NEVER-RAN $m: exit 1, but the output carries an SQL error that is not a completed assertion: $(printf '%s' "$bad" | cut -c1-160)"; return 2; fi
      line=$(printf '%s\n' "$out" | grep -m1 '^FAIL ' | cut -c1-240)
      if [ -n "$line" ]; then echo "CAUGHT    $m: $line"; return 0; fi
      echo "NEVER-RAN $m: exit 1 with no completed FAIL line: $(printf '%s\n' "$out" | tail -1 | cut -c1-140)"; return 2;;
    0) echo "SURVIVED  $m"; return 1;;
    124) echo "NEVER-RAN $m: deadline of ${MUTANT_DEADLINE}s exceeded, the run did not complete"; return 2;;
    *) echo "NEVER-RAN $m (exit $code): $(printf '%s\n' "$out" | tail -1 | cut -c1-140)"; return 2;;
  esac
}

# Canned transcripts with the verdict each must get; no database. Run by
# --verdict-selftest and, silently, before any run trusts a verdict. Fields:
# want | contract, classify or kind | exit code | output (\n separates lines).
# @P stands for psql's "psql:<file>:<line>:" prefix, @OK for the contract's own
# last line. The three outcomes, by arm:
#   outcome 0  exit 0 with the PASSED line and no error line.
#   outcome 1  exit 3 whose first error is SQLSTATE TF001 with a "FAIL " message.
#   outcome 2  every other exit 3 (a syntax error 42601, an undefined function
#              42883, an undefined table 42P01, a statement timeout 57014, a
#              terminated backend 57P01, a resource error, an error no check was
#              written for, an error with no SQLSTATE), every other exit code,
#              and an exit 0 that lacks the PASSED line or carries an error.
verdict_selftest() {
  local d n=0 bad=0 got want kind code body P="psql:/x/t.sql:9:"
  d=$(mktemp -d /tmp/obrp-verdict.XXXXXX)
  while IFS='|' read -r want kind code body; do
    [ -z "$want" ] && continue
    n=$((n + 1))
    body=$(printf '%s' "$body" | sed "s#@P#$P#g; s#@OK# REVIEW PROPOSAL SQL TEST PASSED#g")
    printf '%b\n' "$body" > "$d/out"
    VERDICT=""
    case "$kind" in
      contract) contract_verdict "$code" "$d/out"; got=$?;;
      classify) VERDICT=$(classify m "$code" "$(cat "$d/out")"); got=$?;;
      kind) VERDICT=$(sqlstate_kind "$code"); [ "$VERDICT" = "$body" ]; got=$?;;
    esac
    if [ "$got" != "$want" ]; then
      bad=$((bad + 1)); echo "FAIL verdict case $n ($kind, exit $code): got $got, expected $want: $VERDICT"
    fi
  done <<'CASES'
0|contract|0|@P NOTICE:  00000: PASS T01 x\nLOCATION:  exec_stmt_raise, pl_exec.c:3911\n@OK
2|contract|0|@P NOTICE:  00000: PASS T01 x
2|contract|0|@P NOTICE:  00000: PASS T01 x\n@P ERROR:  TF001: FAIL T02 y: z\n@OK
2|contract|0|@P NOTICE:  00000: PASS T01 the words REVIEW PROPOSAL SQL TEST PASSED inside a notice are not the last line
1|contract|3|@P NOTICE:  00000: PASS T01 x\n@P ERROR:  TF001: FAIL T08 a named check that ran and did not hold: got 2\nCONTEXT:  PL/pgSQL function pg_temp_3.ok(text,boolean,text) line 4 at RAISE
1|contract|3|@P ERROR:  TF001: FAIL T01 the first check: \nLOCATION:  exec_stmt_raise, pl_exec.c:3911
2|contract|3|@P ERROR:  42601: syntax error at or near "selec"\nLINE 1: selec 1;\n        ^\nLOCATION:  scanner_yyerror, scan.l:1242
2|contract|3|@P NOTICE:  00000: PASS T01 x\n@P ERROR:  42601: syntax error at end of input
2|contract|3|@P ERROR:  42883: function public.no_such_function() does not exist\nLINE 1: select public.no_such_function();\nHINT:  No function matches the given name and argument types.
2|contract|3|@P ERROR:  42P01: relation "public.no_such_table" does not exist
2|contract|3|@P ERROR:  42703: column "nope" does not exist
2|contract|3|@P ERROR:  57014: canceling statement due to statement timeout\nLOCATION:  ProcessInterrupts, postgres.c:3382
2|contract|3|@P NOTICE:  00000: PASS T01 x\n@P ERROR:  57014: canceling statement due to user request
2|contract|3|@P ERROR:  57P01: terminating connection due to administrator command
2|contract|3|@P FATAL:  57P01: terminating connection due to administrator command\nserver closed the connection unexpectedly
2|contract|2|@P FATAL:  57P01: terminating connection due to administrator command\n@P error: connection to server was lost
2|contract|3|@P ERROR:  08006: connection failure
2|contract|3|@P ERROR:  53200: out of memory
2|contract|3|@P ERROR:  53100: could not extend file: No space left on device
2|contract|3|@P ERROR:  54001: stack depth limit exceeded
2|contract|3|@P ERROR:  58030: could not read block 0
2|contract|3|@P ERROR:  XX000: unexpected internal state
2|contract|3|@P ERROR:  55P03: canceling statement due to lock timeout
2|contract|3|@P ERROR:  23503: insert or update on table "action_items" violates foreign key constraint "x_fkey"
2|contract|3|@P ERROR:  23514: new row for relation "action_items" violates check constraint "x_check"
2|contract|3|@P ERROR:  22012: division by zero
2|contract|3|@P ERROR:  P0001: FAIL T02 looks like a check but is not the contract's SQLSTATE
2|contract|3|@P ERROR:  P0001: review_proposal: the done transition of c0200001 wrote 0 rows.
2|contract|3|@P ERROR:  TF001: T02 the contract's SQLSTATE without the FAIL marker
2|contract|3|@P ERROR:  canceling statement due to statement timeout
2|contract|3|@P ERROR:  FAIL T02 a FAIL message with no SQLSTATE at all (the display before this rule)
2|contract|3|@P ERROR:  42601: syntax error at or near "x"\n@P ERROR:  TF001: FAIL T02 a later assertion does not outrank the first error
2|contract|3|@P NOTICE:  00000: PASS T01 x
2|contract|3|
2|contract|2|psql: error: connection to server at "127.0.0.1", port 1 failed
2|contract|1|psql: fatal
2|contract|124|@P ERROR:  TF001: FAIL T02 y: z
2|contract|137|@P ERROR:  TF001: FAIL T02 y: z
0|classify|1|migrations applied\nPASS T01 x\nERROR TF001: FAIL T08 a named check: got 2\nFAIL REVIEW PROPOSAL SQL TEST: FAIL T08 a named check: got 2
0|classify|1|PASS C1 x\nFAIL C2: the second run did not wait
0|classify|1|PASS I helper list\nFAIL integration: MCP review: a keep is recorded
2|classify|1|ERROR 57014: canceling statement due to statement timeout\nFAIL REVIEW PROPOSAL SQL TEST: canceling statement due to statement timeout
2|classify|1|ERROR 42601: syntax error at or near "selec"\nFAIL REVIEW PROPOSAL SQL TEST: syntax error at or near "selec"
2|classify|1|ERROR 42883: function public.no_such_function() does not exist\nFAIL REVIEW PROPOSAL SQL TEST: function public.no_such_function() does not exist
2|classify|1|ERROR: canceling statement due to statement timeout\nFAIL REVIEW PROPOSAL SQL TEST: canceling statement due to statement timeout
2|classify|1|ERROR (no SQLSTATE): something\nFAIL REVIEW PROPOSAL SQL TEST: something
2|classify|1|ERROR 23503: insert or update on table "action_items" violates foreign key constraint\nFAIL REVIEW PROPOSAL SQL TEST: insert or update on table
2|classify|1|ERROR TF001: not a fail message\nFAIL REVIEW PROPOSAL SQL TEST: x
2|classify|1|ERROR: FAIL T38 the old display shape, with no SQLSTATE
2|classify|1|FAIL C1: the first review did not record\nNEVER-RAN: a helper query did not execute
2|classify|1|NEVER-RAN: the script stopped before its last check
2|classify|1|something died
2|classify|1|
2|classify|1|PASS T01 x\n  FAIL indented is not a verdict line
1|classify|0|REVIEW PROPOSAL SQL TEST COMPLETE (mutation x)
2|classify|124|FAIL C2: printed before the deadline killed the run
2|classify|2|NEVER-RAN: initdb failed
2|classify|3|FAIL x
2|classify|137|FAIL x
0|kind|TF001|assertion
0|kind|57014|interruption
0|kind|57P01|interruption
0|kind|08006|interruption
0|kind|53200|interruption
0|kind|54001|interruption
0|kind|58030|interruption
0|kind|XX000|interruption
0|kind|55P03|interruption
0|kind|55000|behavioral
0|kind|42601|behavioral
0|kind|42883|behavioral
0|kind|42P01|behavioral
0|kind|23503|behavioral
0|kind|23514|behavioral
0|kind|22023|behavioral
0|kind|40P01|behavioral
0|kind|P0001|behavioral
0|kind||unparseable
0|kind|5701|unparseable
0|kind|57014x|unparseable
0|kind|tf001|unparseable
CASES
  rm -rf "$d"
  [ "$n" = 81 ] || { echo "CONTRACT VERDICT SELFTEST FAILED: ran $n cases, expected 81 (a case was lost)"; return 1; }
  if [ "$bad" -gt 0 ]; then echo "CONTRACT VERDICT SELFTEST FAILED ($bad of $n)"; return 1; fi
  echo "CONTRACT VERDICT SELFTEST PASSED ($n cases)"; return 0
}

if [ "${1:-}" = "--verdict-selftest" ]; then
  verdict_selftest; exit $?
fi
# No verdict below is trusted unless the classifiers pass their own cases.
vst=$(verdict_selftest) || { echo "NEVER-RAN: the verdict classifiers failed their own self-test, so no verdict can be trusted: $(printf '%s\n' "$vst" | grep -m1 '^FAIL')"; exit 2; }

if [ "${1:-}" = "--all-mutations" ]; then
  # OBRP_MUTANT_CMD / OBRP_MUTATIONS exist for review-proposal-runner-selftest.sh.
  if [ -n "${OBRP_MUTANT_CMD:-}" ]; then read -r -a CMD <<< "$OBRP_MUTANT_CMD"; else CMD=(bash "$0"); fi
  caught=0; survived=0; never=0; n=0
  shm_before=$(ipcs -m 2>/dev/null | grep -c '^m')
  for m in ${OBRP_MUTATIONS:-$MUTATIONS}; do
    n=$((n + 1))
    state="$(mktemp /tmp/obrp-state.XXXXXX)"
    out=$(OBRP_STATE_FILE="$state" python3 "$HERE/deadline.py" "$MUTANT_DEADLINE" "${CMD[@]}" --mutate "$m" 2>&1); code=$?
    rm -f "$state"
    classify "$m" "$code" "$out"
    case $? in 0) caught=$((caught + 1));; 1) survived=$((survived + 1));; *) never=$((never + 1));; esac
  done
  shm_after=$(ipcs -m 2>/dev/null | grep -c '^m')
  [ "$shm_after" -gt "$shm_before" ] && echo "WARNING: SysV shared memory segments grew from $shm_before to $shm_after during the sweep"
  echo "SWEEP: $n mutations, $caught caught, $survived survived, $never never ran"
  if [ "$never" -gt 0 ]; then echo "SWEEP INCOMPLETE: $never mutant(s) never ran; they are not catches"; exit 2; fi
  if [ "$survived" -gt 0 ]; then exit 1; fi
  echo "ALL $n MUTATIONS CAUGHT"
  exit 0
fi

MUTATE="${2:-}"; [ "${1:-}" = "--mutate" ] || MUTATE=""
# OBRP_INJECT=<name>: a negative control for the verdicts themselves, used by
# tf001-harness-selftest.sh. Each one makes this run end non-zero in a known way;
# a run that reaches its last line with one set is NEVER-RAN.
INJECT="${OBRP_INJECT:-}"
PORT=$((55000 + RANDOM % 900))
WORK="$(mktemp -d /tmp/obrp.XXXXXX)"
[ -n "${OBRP_STATE_FILE:-}" ] && printf '%s\n' "$WORK" > "$OBRP_STATE_FILE"
PIDS=""
COMPLETED=0
never() { echo "NEVER-RAN: $*"; exit 2; }
# An interruption in either schedule connection's transcript: an error line whose
# SQLSTATE is in INTERRUPTION_PREFIXES, or that carries no readable SQLSTATE.
# Prints "<connection>: <line>" for the first one; prints nothing when clean.
conn_interruption() {
  local c line state
  for c in A B; do
    [ -f "$WORK/$c.out" ] || continue
    while IFS= read -r line; do
      state=$(printf '%s\n' "$line" | sed -nE 's/^(ERROR|FATAL|PANIC):  ([0-9A-Z]{5}): .*$/\2/p')
      case "$(sqlstate_kind "$state")" in
        interruption|unparseable) echo "$c: $(printf '%s' "$line" | cut -c1-160)"; return;;
      esac
    done < <(tr -d '\000' < "$WORK/$c.out" | grep -E '^(ERROR|FATAL|PANIC):')
  done
}
# A behavioral failure, unless the check was made on something that did not
# execute: a helper query that exited non-zero, or a schedule connection whose
# statement was interrupted. Then nothing was judged.
fail() {
  local bad
  if [ -s "$WORK/qfail" ]; then never "a helper query did not execute while checking: $* ($(head -1 "$WORK/qfail" | cut -c1-200))"; fi
  bad=$(conn_interruption)
  if [ -n "$bad" ]; then never "a schedule connection was interrupted while checking: $* ($bad)"; fi
  echo "FAIL $*"; exit 1
}
cleanup() {
  local rc=$?
  for p in $PIDS; do kill "$p" 2>/dev/null; done
  wait 2>/dev/null
  pg_ctl -D "$WORK/pg" stop -m fast -t 10 >/dev/null 2>&1 || pg_ctl -D "$WORK/pg" stop -m immediate >/dev/null 2>&1
  rm -rf "$WORK"
  if [ "$COMPLETED" != 1 ] && [ "$rc" = 0 ]; then
    echo "NEVER-RAN: the script stopped before its last check"
    rc=2
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'echo "NEVER-RAN: interrupted by a signal"; exit 2' TERM INT HUP

if ! initdb -D "$WORK/pg" -A trust -U postgres >"$WORK/initdb.log" 2>&1; then
  if grep -q shmget "$WORK/initdb.log"; then
    never "initdb failed at shmget: SysV shared memory is exhausted or denied (check 'ipcs -m' for orphaned segments from killed clusters, kern.sysv.shmmni)"
  fi
  never "initdb failed: $(tail -1 "$WORK/initdb.log")"
fi
pg_ctl -D "$WORK/pg" -o "-p $PORT -c listen_addresses=127.0.0.1 -k $WORK -c deadlock_timeout=200ms" -l "$WORK/pg.log" start -w >/dev/null || never "pg start failed: $(tail -1 "$WORK/pg.log")"
# VERBOSITY=verbose: every error line carries its SQLSTATE, which is what tells a
# failed check from a cancelled statement or a syntax error.
PSQL=(psql -X -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -q)
# Selftest hook only: stall with the cluster up, so a deadline lands mid-run.
[ -n "${OBRP_SELFTEST_STALL:-}" ] && sleep "$OBRP_SELFTEST_STALL"
"${PSQL[@]}" -d postgres -c "create database obtest" >/dev/null || never "create database failed"

"${PSQL[@]}" -d obtest <<'SQL' >/dev/null || never "stub schema failed"
create role service_role nologin bypassrls; create role anon nologin; create role authenticated nologin;
create schema auth;
create function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;
grant usage on schema auth to service_role, anon, authenticated;
create table public.thoughts (id uuid primary key);
insert into public.thoughts values ('e0000000-0000-4000-8000-000000000001'), ('e0000000-0000-4000-8000-000000000002');
create table public.business_events (id uuid primary key, title text);
insert into public.business_events values ('b0000000-0000-4000-8000-000000000001', 'Joseph session');
create table public.agent_task_ledger (agent_code text primary key);
create table public.action_items (
  id uuid primary key default gen_random_uuid(),
  source_thought_id uuid references public.thoughts(id) on delete set null,
  description text not null,
  status text not null default 'open' check (status in ('open','resolved','archived','deferred')),
  resolved_by_thought_id uuid references public.thoughts(id) on delete set null,
  created_at timestamptz default now(),
  resolved_at timestamptz,
  resolution_note text,
  deferred_at timestamptz,
  defer_reason text
);
create table public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null default 't',
  status text not null,
  completed_at timestamptz, claimed_at timestamptz, claimed_by text, claim_expires_at timestamptz,
  blocked_reason text, review_reason text, operator_action text, operator_target text,
  linked_action_item_id uuid references public.action_items(id),
  parent_task_id uuid, archived_at timestamptz, updated_at timestamptz not null default now()
);
create table public.agent_task_events (
  id uuid primary key default gen_random_uuid(), task_id uuid not null, event_type text not null,
  agent_code text, payload jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
grant select, insert, update, delete on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
SQL

for f in "$M_MCP_LOG" "$M_DECISIONS" "$M_CLOSE"; do
  PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d obtest -f "$f" >"$WORK/prior.out" 2>&1 \
    || never "prior migration failed: $(basename "$f"): $(head -3 "$WORK/prior.out")"
done

# 1. Carry-forward proof: 20261107's trigger bodies minus the T3.2+ lines are 20261106's.
# Python exits 1 for an uncaught exception as well, so exit 1 is a failed check
# only together with the FAIL line the comparison prints.
python3 - "$M_CLOSE" "$M_ARCHIVE" >"$WORK/carry.out" 2>&1 <<'PY'
import sys
a, b = (open(p).read() for p in sys.argv[1:3])
def fn(s, name):
    i = s.index("create or replace function public.%s()" % name); return s[i:s.index("$$;", i)]
for n in ["action_items_set_closed_at", "action_items_record_status_event"]:
    y = "\n".join(l for l in fn(b, n).split("\n") if "-- T3.2+" not in l)
    y = y.replace("'reopen_generation', new.reopen_generation,\n", "'reopen_generation', new.reopen_generation\n")
    if y != fn(a, n):
        print("FAIL carry-forward: %s without its T3.2+ lines differs from 20261106" % n); sys.exit(1)
    print("PASS carry-forward: %s without its T3.2+ lines equals 20261106" % n)
PY
ccode=$?
cat "$WORK/carry.out"
case "$ccode" in
  0) [ "$(grep -c '^PASS carry-forward: ' "$WORK/carry.out")" = 2 ] || never "the carry-forward comparison exited 0 without its two PASS lines";;
  1) [ "$(tail -1 "$WORK/carry.out" | cut -c1-19)" = "FAIL carry-forward:" ] || never "the carry-forward comparison did not complete (exit 1 without its FAIL line): $(tail -1 "$WORK/carry.out" | cut -c1-160)"
     exit 1;;
  *) never "the carry-forward comparison did not complete (exit $ccode): $(tail -1 "$WORK/carry.out" | cut -c1-160)";;
esac

SRC_A="$WORK/archive.sql"; cp "$M_ARCHIVE" "$SRC_A"
SRC_R="$WORK/review.sql"; cp "$M_REVIEW" "$SRC_R"
mutate_file() { # file, old, new: literal replace, every occurrence
  python3 - "$1" "$2" "$3" <<'PY' || never "mutant did not change the target: $(printf '%s' "$2" | head -1)"
import sys
p, a, b = sys.argv[1:4]
s = open(p).read()
if a not in s: sys.exit(1)
open(p, 'w').write(s.replace(a, b))
PY
}
mr() { mutate_file "$SRC_R" "$1" "$2"; }
ma() { mutate_file "$SRC_A" "$1" "$2"; }
case "$MUTATE" in
  "") ;;
  # The latest review picked by greatest reviewed_at, not greatest review_seq. C2 must catch it.
  latest_by_time) mr "  select max(d.review_seq) into v_latest_seq
  from public.auto_resolve_decisions d
  where d.item_id = p_item_id and d.item_generation = v_gen and d.review_seq is not null;" "  select d.review_seq into v_latest_seq
  from public.auto_resolve_decisions d
  where d.item_id = p_item_id and d.item_generation = v_gen and d.review_seq is not null
  order by d.reviewed_at desc, d.review_seq asc limit 1;";;
  # The pending count without the generation filter: an older generation's row reads as pending.
  no_generation_filter) mr "  select count(*) into v_pending
  from public.auto_resolve_decisions d
  where d.item_id = p_item_id and d.item_generation = v_gen" "  select count(*) into v_pending
  from public.auto_resolve_decisions d
  where d.item_id = p_item_id";;
  keep_no_item_columns) mr "      set archive_review_outcome = 'kept', archive_reviewed_at = now()" "      set archive_reviewed_at = archive_reviewed_at";;
  archive_reason_always_expired) mr "v_close_reason := case when v_has_fragment then 'fragment' else 'expired' end;" "v_close_reason := 'expired';";;
  decision_ref_on_keep) mr "  if v_ref_supplied and v_verb <> 'done' then" "  if false then";;
  transition_unchecked) mr "  if v_affected <> 1 then
    raise exception 'review_proposal: the done transition" "  if false then
    raise exception 'review_proposal: the done transition";;
  recheck_no_evidence) mr "      v_dec.evidence_thought_id, v_dec.evidence_thought_id, null, null, v_payload);" "      null, null, null, null, v_payload);";;
  survivor_unchecked) mr "    if v_survivor_status = 'archived' then" "    if false then";;
  mcp_actor_unchecked) mr "    if v_actor <> 'operator' and not exists (" "    if false and not exists (";;
  slack_actor_unchecked) mr "    if v_actor !~ '^slack:[A-Z0-9]+\$' then" "    if false then";;
  closed_any_verb_recorded) mr "    if v_latest_seq is not null and v_verb = v_latest_verb
      and (v_dec.id is null" "    if v_latest_seq is not null
      and (v_dec.id is null";;
  # Both locks gone. C1 must see the second review run without waiting.
  no_locks) mr "  select * into v_item from public.action_items a where a.id = p_item_id for update;" "  select * into v_item from public.action_items a where a.id = p_item_id;"
            mr "  order by d.id
  for update;" "  order by d.id;";;
  no_earlier_review_branch) mr "        if found then
          return query select 'refused'::text,
            format('%s already reviewed" "        if false then
          return query select 'refused'::text,
            format('%s already reviewed";;
  resolution_set_without_latest) mr "           or (v_latest_seq is not null and d.review_seq = v_latest_seq))
      and (case when v_ref ~ c_full then d.id::text = v_ref else left(d.id::text, 8) = v_ref end);" "           or false)
      and (case when v_ref ~ c_full then d.id::text = v_ref else left(d.id::text, 8) = v_ref end);";;
  seq_per_generation) mr "    select max(d.review_seq) from public.auto_resolve_decisions d where d.item_id = p_item_id
  ), 0);" "    select max(d.review_seq) from public.auto_resolve_decisions d where d.item_id = p_item_id and d.item_generation = v_gen
  ), 0);";;
  reopen_keeps_archive_columns) ma "    new.archive_review_outcome := null; -- T3.2+
    new.archive_reviewed_at := null; -- T3.2+" "";;
  reopen_event_drops_archive) ma "      'archive_review_outcome', old.archive_review_outcome, -- T3.2+" "";;
  deferred_done_allowed) mr "  if v_item.status <> 'open' then
    return query select 'refused'::text,
      format('%s is %s; done needs an open item'" "  if false then
    return query select 'refused'::text,
      format('%s is %s; done needs an open item'";;
  rpc_grant_anon) echo "grant execute on function public.review_proposal(uuid, text, text, text, text) to anon;" >> "$SRC_R";;
  ambiguous_takes_first) mr "    if v_matches >= 2 then
      return query select 'ambiguous'::text" "    if false then
      return query select 'ambiguous'::text";;
  restore_hint_for_open) mr "format('%s is %s; last proposal %s %s; nothing pending to %s', v_short, v_item.status," "format('%s is %s; last proposal %s %s; nothing pending to %s; restore_action_item is the undo', v_short, v_item.status,";;
  # F1 negative control: the pre-amendment normalization, blank ref read as absent.
  blank_ref_as_absent) mr "  v_ref_supplied constant boolean := p_decision_ref is not null;
  v_ref text := lower(regexp_replace(p_decision_ref, '^[[:space:]]+|[[:space:]]+\$', '', 'g'));" "  v_ref text := nullif(lower(trim(coalesce(p_decision_ref, ''))), '');
  v_ref_supplied constant boolean := v_ref is not null;";;
  # F1: done's empty-ref refusal removed (an empty ref then falls to another answer).
  empty_done_ref_unchecked) mr "  if v_ref_supplied and v_ref = '' then" "  if false then";;
  # F2 negative controls: a refusal that writes a column / row content the earlier
  # partial signature never serialized (resolution_note; an existing event's note).
  refusal_writes_note) mr "    return query select 'refused'::text,
      format('%s is %s since %s; restore_action_item is the undo'" "    update public.action_items a set resolution_note = coalesce(a.resolution_note, '') || ' (refused)' where a.id = p_item_id;
    return query select 'refused'::text,
      format('%s is %s since %s; restore_action_item is the undo'";;
  refusal_rewrites_event) mr "    return query select 'refused'::text,
      format('%s is %s since %s; restore_action_item is the undo'" "    update public.action_item_events e set note = coalesce(e.note, '') || ' (refused)' where e.item_id = p_item_id;
    return query select 'refused'::text,
      format('%s is %s since %s; restore_action_item is the undo'";;
  *) never "unknown mutation: $MUTATE";;
esac

for f in "$SRC_A" "$SRC_R"; do
  if ! PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d obtest -f "$f" >"$WORK/mig.out" 2>&1; then
    never "migration failed to apply: $(sed 's/^psql:.*ERROR/ERROR/' "$WORK/mig.out" | head -3)"
  fi
done
echo "migrations applied"

# A helper query on a fresh connection. These are the harness's own reads and
# fixture writes; none is expected to raise under any mutant. So ANY non-zero exit
# (1 = the SQL raised, including a cancelled statement; 2 = could not connect) means
# the query did not execute: it is recorded, fail() then reports NEVER-RAN instead
# of a failed check, and a run that reaches its end with one recorded is NEVER-RAN.
q() {
  local out code
  out=$("${PSQL[@]}" -d obtest -At -c "$1" 2>&1); code=$?
  if [ "$code" -ne 0 ]; then echo "psql exit $code: $(printf '%s' "$out" | head -1)" >> "$WORK/qfail"; fi
  printf '%s\n' "$out"
}

# Negative controls (OBRP_INJECT). The contract ones edit a COPY of the contract;
# the others plant a trigger on one named row, so the event arrives through the
# real path being judged. The trigger raises a statement cancellation (57014)
# unless a body is given: a sleep that a real statement_timeout then cancels, or a
# behavioral error, which must stay a completed answer.
CONTRACT="$TEST_SQL"
inject_sql() { # anchor, replacement text: in a copy of the contract, exactly one site
  CONTRACT="$WORK/contract.sql"; cp "$TEST_SQL" "$CONTRACT"
  mutate_once "$CONTRACT" "$1" "$2"
}
mutate_once() { # file, old, new: literal replace, exactly one occurrence
  python3 - "$1" "$2" "$3" <<'PY' || never "injection $INJECT did not apply: the contract does not hold its anchor exactly once"
import sys
p, a, b = sys.argv[1:4]
s = open(p).read()
if s.count(a) != 1: sys.exit(1)
open(p, 'w').write(s.replace(a, b))
PY
}
# plant_psql <case pattern> <command>: the integration child gets a PATH of its
# own holding python3, deno and a psql that runs <command> when its arguments
# match <pattern> and otherwise becomes the real psql. Nothing the bridge reads
# is mocked: the fault is in the subprocess itself. Sets IENV.
plant_psql() {
  local real py dn
  real=$(command -v psql) && py=$(command -v python3) && dn=$(command -v deno) || never "injection $INJECT did not apply: psql, python3 or deno is not on PATH"
  mkdir "$WORK/ibin" && ln -s "$py" "$WORK/ibin/python3" && ln -s "$dn" "$WORK/ibin/deno" || never "injection $INJECT did not apply: could not build the private PATH"
  printf '#!/bin/bash\ncase "$*" in %s) %s;; esac\nexec %q "$@"\n' "$1" "$2" "$real" > "$WORK/ibin/psql"
  chmod +x "$WORK/ibin/psql" || never "injection $INJECT did not apply: could not build the private psql"
  IENV=("PATH=$WORK/ibin")
}
inject_trigger() { # timing/event, WHEN condition [, table [, plpgsql body]]
  local table="${3:-public.action_items}"
  local body="${4:-raise exception using errcode = '57014', message = 'canceling statement due to statement timeout (injected by OBRP_INJECT=$INJECT)';}"
  "${PSQL[@]}" -d obtest >/dev/null 2>"$WORK/inject.err" <<SQL || never "injection $INJECT did not apply: $(head -1 "$WORK/inject.err")"
create function public.obt_injected_cancel() returns trigger language plpgsql as \$f\$
begin
  $body
  return new;
end \$f\$;
create trigger obt_injected_cancel $1 on $table for each row when ($2) execute function public.obt_injected_cancel();
SQL
}
POINT_ANCHOR="-- OBRP_INJECT_POINT (the runner's negative controls insert one statement here)
"
case "$INJECT" in
  "") ;;
  # The positive control: a check that runs to completion and does not hold.
  assert_fail) inject_sql "$POINT_ANCHOR" "select pg_temp.ok('INJECTED a completed check that does not hold', 1 = 2, 'one is not two');
";;
  # Three errors that are not assertions and that no check was written for.
  syntax_error) inject_sql "$POINT_ANCHOR" "selec 1;
";;
  undefined_function) inject_sql "$POINT_ANCHOR" "select public.obt_no_such_function();
";;
  raw_error) inject_sql "$POINT_ANCHOR" "select 1/0;
";;
  # A real statement_timeout.
  sql_timeout) inject_sql "$POINT_ANCHOR" "set statement_timeout = 10;
select pg_sleep(0.2);
";;
  # The contract's own backend terminated: the connection is lost mid-script.
  backend_killed) inject_sql "$POINT_ANCHOR" "select pg_terminate_backend(pg_backend_pid());
select pg_sleep(1);
";;
  # A statement that outlives the outer deadline.
  sql_sleep) inject_sql "$POINT_ANCHOR" "select pg_sleep(600);
";;
  # A resource error raised inside one of the contract's own WHEN OTHERS handlers
  # (T19's first refusal), which the handler does catch and must re-raise.
  resource_in_handler) inject_sql "    perform pg_temp.rp('c0190001-0000-4000-8000-000000000000', 'keep', null, 'slack:', 'slack-signature');
" "    raise exception using errcode = '53200', message = 'out of memory (injected)';
";;
  integration_timeout_slack|integration_cancel_helper|integration_cancel_mcp|integration_cancel_telemetry) ;; # planted further down
  integration_unreadable_state|integration_backend_killed|integration_behavioral_error) ;; # planted further down
  integration_psql_missing|integration_psql_denied|integration_psql_killed|integration_psql_empty_rpc|integration_psql_empty_count) ;; # planted further down
  conn_cancel|helper_cancel|helper_stray) ;; # planted further down
  *) never "unknown injection: $INJECT";;
esac

# 2. The single-connection contract. ONLY_CONCURRENCY=1 skips it (and the
# integration step), to prove a mutant is caught by the schedules on their own.
# psql's exit 3 says only that a statement raised; contract_verdict reads the
# SQLSTATE to tell a failed check (exit 1) from everything else (NEVER-RAN).
if [ -z "${ONLY_CONCURRENCY:-}" ]; then
  "${PSQL[@]}" -d obtest -v interruption_prefixes="$INTERRUPTION_PREFIXES" -f "$CONTRACT" >"$WORK/contract.out" 2>&1; code=$?
  grep -E '^psql:.*:[0-9]+: (NOTICE|ERROR|FATAL):  ' "$WORK/contract.out" \
    | sed -E 's/^psql:.*:[0-9]+: NOTICE:  00000: //; s/^psql:.*:[0-9]+: (ERROR|FATAL):  ([0-9A-Z]{5}): /\1 \2: /; s/^psql:.*:[0-9]+: (ERROR|FATAL):  /\1 (no SQLSTATE): /'
  contract_verdict "$code" "$WORK/contract.out"
  case $? in
    0) echo "$CONTRACT_NAME PASSED";;
    1) echo "FAIL $CONTRACT_NAME: $VERDICT"; exit 1;;
    *) never "$VERDICT";;
  esac

  # 3. The public entry points against these real RPCs.
  # The bridge is handed the runner's interruption list: an RPC that ends in one of
  # those SQLSTATEs did not complete, and nothing may be judged on it.
  if [ -z "${SKIP_INTEGRATION:-}" ]; then
    IENV=()
    case "$INJECT" in
      # A REAL statement_timeout on the Slack route: every statement the bridge
      # sends runs under a 2 s statement_timeout, and the Slack reply's first
      # write (the selective done that archives c0710001) sleeps past it. The
      # client library and the Slack handler both catch the bridge's exception.
      integration_timeout_slack)
        inject_trigger "before update" "new.id = 'c0710001-0000-4000-8000-000000000000'" public.action_items "perform pg_sleep(60);"
        IENV=("PGOPTIONS=-c statement_timeout=2000");;
      # The helper's first write (I3, done by full id), called on the bridge directly.
      integration_cancel_helper) inject_trigger "before update" "new.id = 'c0720001-0000-4000-8000-000000000000'";;
      # The MCP tool's first write (I7's control archive), through the client library.
      integration_cancel_mcp) inject_trigger "before update" "new.id = 'c0770001-0000-4000-8000-000000000000'";;
      # The telemetry write of the LAST MCP call. The tool answers as usual
      # whatever that write returns, so every assertion goes on to hold: only the
      # record of the incomplete execution can stop the PASSED line.
      integration_cancel_telemetry) inject_trigger "before insert" "new.args->>'decision_ref' = ' D0780001 '" public.mcp_tool_invocations;;
      # An error line the bridge cannot read a SQLSTATE from: a behavioral error
      # on the Slack write, reported by a server session whose messages are in
      # German ("FEHLER:" where the bridge looks for "ERROR:"). Without a readable
      # state nothing says the statement completed, so nothing is judged on it.
      integration_unreadable_state)
        probe=$(PGOPTIONS="-c lc_messages=de_DE.UTF-8" "${PSQL[@]}" -d obtest -At -c "select 1/0" 2>&1)
        printf '%s\n' "$probe" | grep -q '^ERROR:' && never "injection $INJECT did not apply: this server has no de_DE message catalog"
        printf '%s\n' "$probe" | grep -q ':  22012: ' || never "injection $INJECT did not apply: the probe statement did not raise 22012"
        inject_trigger "before update" "new.id = 'c0710001-0000-4000-8000-000000000000'" public.action_items "raise exception using errcode = '23514', message = 'injected behavioral error (OBRP_INJECT=$INJECT)';"
        IENV=("PGOPTIONS=-c lc_messages=de_DE.UTF-8");;
      # The backend of the helper's first write terminates itself: psql loses the
      # connection (exit 2) and the RPC did not execute.
      integration_backend_killed)
        inject_trigger "before update" "new.id = 'c0720001-0000-4000-8000-000000000000'" public.action_items "perform pg_terminate_backend(pg_backend_pid());";;
      # A REAL failure to launch psql, with no exit status to read: the private
      # psql removes itself while it serves the first state read (which still
      # completes), so the next launch, the first Slack lookup inside the client
      # library's fetch, finds no executable. The client library and the Slack
      # handler both catch that rejection.
      integration_psql_missing) plant_psql '*jsonb_build_object*' '/bin/mv "$0" "$0.gone"';;
      # The same launch refused by the operating system for another reason: the
      # private psql replaces itself with a script whose interpreter is a file
      # that may not be executed (EACCES at exec, where the one above is a name
      # that resolves to nothing). A plain chmod 000 would not do: Deno resolves
      # the name on PATH first and reports a non-executable file as not found.
      integration_psql_denied) plant_psql '*jsonb_build_object*' '/bin/mv "$0" "$0.gone"; : > "$0.noexec"; printf "#!%s\n" "$0.noexec" > "$0"; /bin/chmod 755 "$0"';;
      # The psql of the first Slack lookup is killed by a signal: an exit status
      # exists (128 + 9) and is none of psql's own.
      integration_psql_killed) plant_psql '*resolve_proposal_item*' 'kill -KILL $$';;
      # A psql that exits 0 without the output its statement must produce: on the
      # first Slack lookup (the RPC's JSON array), and on a telemetry count,
      # where an empty answer would otherwise read as the number 0.
      integration_psql_empty_rpc) plant_psql '*resolve_proposal_item*' 'exit 0';;
      integration_psql_empty_count) plant_psql '*from\ public.mcp_tool_invocations*' 'exit 0';;
      # A behavioral error (a constraint-class SQLSTATE) on the same Slack write:
      # an answer from the database, so the check made on it is a completed FAIL.
      integration_behavioral_error)
        inject_trigger "before update" "new.id = 'c0710001-0000-4000-8000-000000000000'" public.action_items "raise exception using errcode = '23514', message = 'injected behavioral error (OBRP_INJECT=$INJECT)';";;
    esac
    IOUT=$(env ${IENV[@]+"${IENV[@]}"} OBRP_PG_PORT="$PORT" OBRP_INTERRUPTION_PREFIXES="$INTERRUPTION_PREFIXES" python3 "$HERE/deadline.py" "${OBRP_INTEGRATION_DEADLINE:-240}" \
      deno run --no-lock --config "$HERE/closeout-capture-probe.deno.json" \
      --allow-net --allow-env --allow-read --allow-run=psql "$HERE/review-proposal-integration.ts" 2>&1); icode=$?
    echo "$IOUT" | grep -E '^(PASS I |FAIL|NEVER-RAN|REVIEW PROPOSAL INTEGRATION|  )'
    case "$icode" in
      0) echo "$IOUT" | grep -q "REVIEW PROPOSAL INTEGRATION PASSED" || never "the integration harness exited 0 without its PASSED line";;
      1) echo "$IOUT" | grep -q '^FAIL integration:' || never "the integration harness exited 1 without a completed assertion: $(echo "$IOUT" | tail -1 | cut -c1-160)"
         exit 1;;
      *) never "the integration harness did not complete (exit $icode): $(echo "$IOUT" | tail -1 | cut -c1-200)";;
    esac
  fi
fi

# 4. Concurrency. Each connection reads commands from a FIFO, so the shell decides
# the interleaving. "Blocked" is read from pg_stat_activity, never assumed.
SEQ=0
open_conn() { # name
  mkfifo "$WORK/$1.in"
  psql -X -h 127.0.0.1 -p "$PORT" -U postgres -d obtest -v ON_ERROR_STOP=0 -v VERBOSITY=verbose -q -At < "$WORK/$1.in" > "$WORK/$1.out" 2>&1 &
  PIDS="$PIDS $!"
  case "$1" in A) exec 7>"$WORK/A.in";; B) exec 8>"$WORK/B.in";; esac
  send "$1" "set application_name = 'conn_$1';"
  sync_conn "$1"
}
send() { case "$1" in A) printf '%s\n' "$2" >&7;; B) printf '%s\n' "$2" >&8;; esac; }
# Wait until the connection has run everything sent. A connection that never gets
# there did not complete: NEVER-RAN (exit 2), never a failed assertion.
sync_conn() { # name
  SEQ=$((SEQ + 1)); local f="$WORK/sync.$SEQ"
  send "$1" "\\! touch $f"
  local t="${OBRP_SYNC_TICKS:-200}"
  while [ ! -e "$f" ] && [ "$t" -gt 0 ]; do sleep 0.05; t=$((t - 1)); done
  [ -e "$f" ] || never "connection $1 did not finish its statements in time (incomplete execution, not a check failure)"
}
blocked_count() { q "select count(*) from pg_stat_activity where application_name = 'conn_$1' and wait_event_type = 'Lock'"; }
# Seen waiting on a lock: pass. Never seen waiting: a FAILURE only if the statement
# then demonstrably COMPLETED (it ran without waiting); if it does not complete,
# sync_conn reports NEVER-RAN.
wait_blocked() { # name label
  local t=60
  while [ "$t" -gt 0 ]; do
    [ "$(blocked_count "$1")" = "1" ] && return 0
    sleep 0.05; t=$((t - 1))
  done
  sync_conn "$1"
  fail "$2: connection $1 completed without ever waiting on a lock"
}
clean() { tr -d '\000' < "$WORK/$1.out"; }
# The end of a transcript on ONE line, for a FAIL message: a second line starting
# "ERROR" would read to the sweep as an SQL error of its own.
last2() { clean "$1" | tail -2 | tr '\n' ' '; }

case "$INJECT" in
  # C1's first review is cancelled on connection A.
  conn_cancel) inject_trigger "before update" "new.description = 'c1'";;
  # The helper query that inserts C1's item is cancelled.
  helper_cancel) inject_trigger "before insert" "new.description = 'c1'";;
  # A helper query that raises while every check goes on to hold.
  helper_stray) q "select 1/0" >/dev/null;;
esac
open_conn A; open_conn B

# C1: concurrent keep and archive.
I1=c0900001-0000-4000-8000-000000000000
q "insert into public.action_items (id, description) values ('$I1', 'c1')" >/dev/null
q "insert into public.auto_resolve_decisions (id, item_id, candidate_description, layer, outcome, reason) values ('d0900001-0000-4000-8000-000000000000', '$I1', 'c', 'archive', 'proposed', 'age_standard')" >/dev/null
: > "$WORK/A.out"; : > "$WORK/B.out"
send A "begin;"
send A "select status from public.review_proposal('$I1', 'keep', 'operator', 'mcp-shared-key');"
sync_conn A
send B "select status || '|' || message from public.review_proposal('$I1', 'archive', 'operator', 'mcp-shared-key');"
wait_blocked B "C1 the second review waits for the first"
send A "commit;"; sync_conn A; sync_conn B
clean A | grep -qx "recorded" || fail "C1: the first review did not record ($(last2 A))"
clean B | grep -q "^refused|c0900001 is open; last proposal kept .* UTC; nothing pending to archive$" || fail "C1: the second review was not refused ($(last2 B))"
[ "$(q "select count(distinct review_seq) || '|' || string_agg(outcome, ',') from public.auto_resolve_decisions where item_id = '$I1'")" = "1|kept" ] || fail "C1: not exactly one review"
[ "$(q "select status from public.action_items where id = '$I1'")" = "open" ] || fail "C1: the item moved"
echo "PASS C1 concurrent keep and archive: one review, one refusal, and the second really waited"

# C2: reversed start order.
I2=c0910001-0000-4000-8000-000000000000; DA=d0910001-0000-4000-8000-000000000000; DB=d0910002-0000-4000-8000-000000000000
q "insert into public.action_items (id, description) values ('$I2', 'c2')" >/dev/null
q "insert into public.auto_resolve_decisions (id, item_id, candidate_description, layer, outcome, reason) values ('$DA', '$I2', 'c', 'archive', 'proposed', 'age_standard')" >/dev/null
: > "$WORK/A.out"; : > "$WORK/B.out"
send A "begin;"
send A "select 'T1 started';"
sync_conn A
sleep 0.2
send B "select status from public.review_proposal('$I2', 'keep', 'operator', 'mcp-shared-key');"
sync_conn B
q "insert into public.auto_resolve_decisions (id, item_id, evidence_thought_id, quote, score, candidate_description, layer, outcome) values ('$DB', '$I2', 'e0000000-0000-4000-8000-000000000001', 'q', 0.9, 'c', 'recheck', 'proposed')" >/dev/null
send A "select status from public.review_proposal('$I2', 'done', 'operator', 'mcp-shared-key', '$DB');"
send A "commit;"
sync_conn A
clean B | grep -qx "recorded" || fail "C2: T2's keep did not record"
clean A | grep -qx "recorded" || fail "C2: T1's done did not record ($(last2 A))"
[ "$(q "select (select reviewed_at from public.auto_resolve_decisions where id = '$DB') < (select reviewed_at from public.auto_resolve_decisions where id = '$DA')")" = "t" ] \
  || fail "C2: the inversion did not occur (B's reviewed_at is not earlier than A's), so this fixture proves nothing"
[ "$(q "select (select review_seq from public.auto_resolve_decisions where id = '$DB') > (select review_seq from public.auto_resolve_decisions where id = '$DA')")" = "t" ] \
  || fail "C2: B's review_seq is not greater than A's"
[ "$(q "select status from public.review_proposal('$I2', 'done', 'operator', 'mcp-shared-key', '$DB')")" = "already_recorded" ] \
  || fail "C2: the retried full-id done is not already recorded"
echo "PASS C2 reversed start order: B reviewed earlier by the clock, later by the sequence, and the retry is already recorded"

# C3 (Codex's reviewer schedule, PR 23 review): a producer waits behind a review,
# then stamps the reopened generation.
I3=c0920001-0000-4000-8000-000000000000; P3A=d0920001-0000-4000-8000-000000000000; P3B=d0920002-0000-4000-8000-000000000000
q "insert into public.action_items (id, description) values ('$I3', 'reviewer C3')" >/dev/null
q "insert into public.auto_resolve_decisions (id, item_id, candidate_description, layer, outcome, reason) values ('$P3A', '$I3', 'c', 'archive', 'proposed', 'age_standard')" >/dev/null
: > "$WORK/A.out"; : > "$WORK/B.out"
send A "begin;"
send A "select status from public.review_proposal('$I3', 'archive', 'operator', 'mcp-shared-key');"
sync_conn A
send B "insert into public.auto_resolve_decisions (id, item_id, candidate_description, layer, outcome, reason) values ('$P3B', '$I3', 'waiting producer', 'archive', 'proposed', 'age_standard');"
wait_blocked B "C3 the producer insert waits behind the uncommitted review"
send A "select public.transition_action_item('$I3', '{archived}', 'open', 'operator');"
send A "commit;"
sync_conn A; sync_conn B
clean A | grep -qx "recorded" || fail "C3: the archive review did not record ($(last2 A))"
clean B | grep -q "ERROR" && fail "C3: the producer insert raised ($(last2 B))"
[ "$(q "select reopen_generation || '|' || status from public.action_items where id = '$I3'")" = "1|open" ] || fail "C3: the item is not open in generation 1"
[ "$(q "select item_generation || '|' || outcome || '|' || review_seq from public.auto_resolve_decisions where id = '$P3A'")" = "0|accepted|1" ] || fail "C3: the reviewed row is not generation 0, accepted, review 1"
[ "$(q "select item_generation || '|' || outcome from public.auto_resolve_decisions where id = '$P3B'")" = "1|proposed" ] || fail "C3: the waiting producer's row is not generation 1 and proposed"
[ "$(q "select status from public.review_proposal('$I3', 'keep', 'operator', 'mcp-shared-key')")" = "recorded" ] || fail "C3: the next keep did not record"
[ "$(q "select review_seq || '|' || outcome from public.auto_resolve_decisions where id = '$P3B'")" = "2|kept" ] || fail "C3: the next keep is not review_seq 2"
echo "PASS C3 reviewer schedule: the producer really waited, stamped generation 1 after the reopen, and the next keep is review_seq 2"

# C4 (investigation of the unlocked survivor read; no lock is added, which would
# break Task 3.1's single-item lock order). Two schedules, compared with serial order.
# C4a: the survivor's archive is IN FLIGHT (uncommitted) when the review reads it.
X4=c0930001-0000-4000-8000-000000000000; S4=c0930002-0000-4000-8000-000000000000; D4=d0930001-0000-4000-8000-000000000000
q "insert into public.action_items (id, description) values ('$S4', 'c4 survivor'), ('$X4', 'c4 duplicate')" >/dev/null
q "insert into public.auto_resolve_decisions (id, item_id, related_item_id, score, candidate_description, layer, outcome, reason) values ('$D4', '$X4', '$S4', 0.92, 'c', 'dedup', 'proposed', 'semantic_overlap')" >/dev/null
: > "$WORK/A.out"; : > "$WORK/B.out"
send B "begin;"
send B "select public.transition_action_item('$S4', '{open}', 'archived', 'operator', 'expired');"
sync_conn B
send A "select status || '|' || message from public.review_proposal('$X4', 'done', 'operator', 'mcp-shared-key');"
c4_waited=no
for _ in $(seq 1 40); do
  [ "$(blocked_count A)" = "1" ] && { c4_waited=yes; break; }
  grep -q '|' "$WORK/A.out" 2>/dev/null && break
  sleep 0.05
done
if [ "$c4_waited" = yes ]; then send B "commit;"; sync_conn B; sync_conn A; else sync_conn A; send B "commit;"; sync_conn B; fi
c4a_review=$(clean A | grep '|' | tail -1)
c4a_state=$(q "select string_agg(left(id::text, 8) || ':' || status || ':' || coalesce(close_reason, '-') || ':' || coalesce(left(duplicate_of::text, 8), '-'), ',' order by id) from public.action_items where id in ('$X4', '$S4')")
echo "$c4a_review" | grep -q '^recorded|archived c0930001 (dedup d0930001)$' \
  || fail "C4a: expected the review to record against the committed 'open' survivor; got '$c4a_review' (waited=$c4_waited)"
[ "$c4a_state" = "c0930001:archived:duplicate:c0930002,c0930002:archived:expired:-" ] || fail "C4a: unexpected final state $c4a_state"
echo "PASS C4a survivor archive in flight: the review waited=$c4_waited, recorded against the committed 'open' survivor; final state ($c4a_state) is exactly serial order review-then-archive"
# C4b: the survivor archived and COMMITTED before the review reads it.
X5=c0940001-0000-4000-8000-000000000000; S5=c0940002-0000-4000-8000-000000000000; D5=d0940001-0000-4000-8000-000000000000
q "insert into public.action_items (id, description) values ('$S5', 'c4b survivor'), ('$X5', 'c4b duplicate')" >/dev/null
q "insert into public.auto_resolve_decisions (id, item_id, related_item_id, score, candidate_description, layer, outcome, reason) values ('$D5', '$X5', '$S5', 0.92, 'c', 'dedup', 'proposed', 'semantic_overlap')" >/dev/null
q "select public.transition_action_item('$S5', '{open}', 'archived', 'operator', 'expired')" >/dev/null
c4b_review=$(q "select status || '|' || message from public.review_proposal('$X5', 'done', 'operator', 'mcp-shared-key')")
[ "$c4b_review" = "refused|survivor c0940002 is archived" ] || fail "C4b: expected the archived-survivor refusal, got '$c4b_review'"
[ "$(q "select status || '|' || (select outcome from public.auto_resolve_decisions where id = '$D5') from public.action_items where id = '$X5'")" = "open|proposed" ] || fail "C4b: the refused review wrote"
echo "PASS C4b survivor archived and committed first: refused, nothing written (serial order archive-then-review)"

[ "$(q "select count(*) from public.action_item_events where actor = 'sql'")" = "0" ] || fail "C: an sql-actor event"
# Every check held. That is a pass only if everything the checks read executed.
[ -s "$WORK/qfail" ] && never "every check held, but a helper query did not execute during the run ($(head -1 "$WORK/qfail" | cut -c1-200))"
[ -n "$INJECT" ] && never "the injection $INJECT did not stop the run, so it did not fire"
COMPLETED=1
echo "REVIEW PROPOSAL TEST COMPLETE${MUTATE:+ (mutation $MUTATE)}"
