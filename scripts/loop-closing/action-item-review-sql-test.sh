#!/bin/bash
# Loop-closing Task 3.3: prove 20261119b_action_items_review.sql on a throwaway
# LOCAL PostgreSQL cluster (never production).
#
#   bash scripts/loop-closing/action-item-review-sql-test.sh                  # exit 0 passed
#   bash scripts/loop-closing/action-item-review-sql-test.sh --mutate <name>  # exit 1 expected
#   bash scripts/loop-closing/action-item-review-sql-test.sh --all-mutations  # all must be CAUGHT
#   bash scripts/loop-closing/action-item-review-sql-test.sh --verdict-selftest  # no database
# (Live negative controls for these verdicts: action-item-review-harness-selftest.sh.)
#
# Three outcomes, never two (the rule review-proposal-sql-test.sh states):
#   0  passed: every check ran to completion and held.
#   1  FAILED: a check RAN TO COMPLETION and its assertion did not hold. Only this is
#      a caught mutation. Every exit 1 prints a line starting "FAIL ".
#   2  NEVER-RAN: the cluster, a migration or a mutant did not apply; a connection
#      never finished its statements; a helper query did not execute; a statement
#      was cancelled, timed out or lost a resource; the SQL contract stopped on an
#      error that is not one of its own assertions; a step stopped before its last
#      check. Nothing was judged, so nothing was caught.
#
# A psql error is NOT by itself a failed check (PR 25 Codex review, P2,
# 2026-11-18: psql exits 3 for a statement cancelled by statement_timeout just as
# it does for a failed assertion). The rule, an allowlist:
#   - The SQL contract's exit 3 is a FAIL only when its first error carries the
#     contract's own assertion SQLSTATE (TF001, raised by pg_temp.ok and by nothing
#     else) and a message starting "FAIL ". Every error a mutant is expected to
#     produce is judged inside the contract by a named check (pg_temp.attempt), so
#     no raw SQL error has to count. Any other SQLSTATE, and an error with no
#     readable SQLSTATE, is NEVER-RAN.
#   - A helper query (q) that exits non-zero for any reason did not execute: the
#     check made on it, and the run as a whole, is NEVER-RAN.
#   - A schedule check that fails while either connection's transcript carries an
#     interruption (INTERRUPTION_PREFIXES below, or an error with no readable
#     SQLSTATE) is NEVER-RAN. A behavioral error there is still a completed answer.
#   - The integration bridge treats the same SQLSTATE list as NEVER-RAN.
# --all-mutations runs each mutant under its own deadline (OBRP_MUTANT_DEADLINE,
# default 300 s) via deadline.py; a deadline (124), any exit other than 0/1, an
# exit 1 with no completed "FAIL " line, an exit 1 whose output also says NEVER-RAN
# or shows an SQL error other than a contract assertion are all NEVER-RAN, and the
# sweep exits 2 if any mutant never ran, 1 if any survived, 0 only when every one
# was CAUGHT.
#
# What it proves, in order:
#   1. The migration applies over rows that already exist (seeded BEFORE it), and
#      it does not touch Task 3.1's two status trigger functions (their stored
#      source is hashed before and after).
#   2. The single-connection contract in action-item-review-sql-test.sql (T01 to
#      T14): recorded reviews, every malformed input, every state answer with a
#      complete before/after snapshot, the five CHECKs by name, the clearing
#      trigger, the read order and its bounds, and the grants.
#   3. action-item-review-integration.ts: the TypeScript helpers and the real MCP
#      tool entrypoint wired to these real functions (nothing scripted).
#   4. Schedules on real second connections:
#      C1 two reviews of one item: the second really waits (read from
#         pg_stat_activity) and both record, the later one winning.
#      C2 a review started while an archive of the same item is uncommitted waits,
#         then answers refused and writes nothing.
#      C3 two duplicate proposals that name each other do not block each other:
#         the lock is FOR NO KEY UPDATE, which a foreign-key check passes.
export LC_ALL=C
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/scripts/loop-closing"
M_MCP_LOG="$ROOT/supabase/migrations/0016_mcp_tool_invocations.sql"
M_DECISIONS="$ROOT/supabase/migrations/20261105_auto_resolve_decisions.sql"
M_CLOSE="$ROOT/supabase/migrations/20261106_action_items_close_reason.sql"
M_ARCHIVE="$ROOT/supabase/migrations/20261109a_action_items_archive_proposals.sql"
M_REVIEW="$ROOT/supabase/migrations/20261119b_action_items_review.sql"
TEST_SQL="$HERE/action-item-review-sql-test.sql"

MUTATIONS="no_status_guard not_found_unchecked no_lock lock_for_update actor_unchecked keep_takes_fields done_pointer_unchecked evidence_untrimmed evidence_length_unchecked duplicate_without_replacement self_replacement_unchecked replacement_on_other replacement_existence_unchecked review_touches_created_at refusal_writes trigger_never_clears trigger_clears_on_any_change trigger_clears_without_status_change touches_31_trigger list_no_exclusion list_order_created_only list_id_desc list_includes_deferred list_boundary_inclusive list_total_is_row_number list_days_ignored list_days_unchecked list_limit_unchecked list_offset_unchecked grant_review_anon grant_list_authenticated no_check_outcome_known no_check_disposition_known no_check_together no_check_proposal_shape no_check_replacement check_together_no_reviewer_arm check_shape_no_evidence_arm check_replacement_no_self_arm fk_no_set_null"
MUTANT_DEADLINE="${OBRP_MUTANT_DEADLINE:-300}"

# SQLSTATE prefixes that mean the statement was interrupted or the server could
# not do the work: nothing was judged. 08 connection, 53 insufficient resources,
# 54 program limit, 57 operator intervention (57014 is statement_timeout and
# cancel), 58 system error, XX internal error, 55P03 lock_timeout. The SQL
# contract and the integration bridge are handed this same list.
INTERRUPTION_PREFIXES="08 53 54 57 58 XX 55P03"
# The SQL contract's assertion failures: pg_temp.ok raises this, nothing else does.
ASSERT_STATE=TF001

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
      if grep -Eq '^psql:.*:[0-9]+: NOTICE:  00000: ACTION ITEM REVIEW SQL TEST PASSED$' "$file"; then VERDICT="passed"; return 0; fi
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
# want | contract or classify | exit code | output (\n separates lines).
verdict_selftest() {
  local d n=0 bad=0 got want kind code body P="psql:/x/t.sql:9:"
  d=$(mktemp -d /tmp/obrp-verdict.XXXXXX)
  while IFS='|' read -r want kind code body; do
    [ -z "$want" ] && continue
    n=$((n + 1))
    body=$(printf '%s' "$body" | sed "s#@P#$P#g")
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
0|contract|0|@P NOTICE:  00000: PASS T01 x\nLOCATION:  exec_stmt_raise, pl_exec.c:3911\n@P NOTICE:  00000: ACTION ITEM REVIEW SQL TEST PASSED\nLOCATION:  exec_stmt_raise, pl_exec.c:3911
2|contract|0|@P NOTICE:  00000: PASS T01 x
2|contract|0|@P NOTICE:  00000: PASS T01 x\n@P ERROR:  TF001: FAIL T02 y: z\n@P NOTICE:  00000: ACTION ITEM REVIEW SQL TEST PASSED
1|contract|3|@P NOTICE:  00000: PASS T01 x\n@P ERROR:  TF001: FAIL T08 a keep on a deferred item is refused: recorded|kept c1080001\nCONTEXT:  PL/pgSQL function pg_temp_3.ok(text,boolean,text) line 4 at RAISE
2|contract|3|@P ERROR:  57014: canceling statement due to statement timeout\nLOCATION:  ProcessInterrupts, postgres.c:3382
2|contract|3|@P NOTICE:  00000: PASS T01 x\n@P ERROR:  57014: canceling statement due to user request
2|contract|3|@P ERROR:  57P01: terminating connection due to administrator command
2|contract|3|@P ERROR:  08006: connection failure
2|contract|3|@P ERROR:  53200: out of memory
2|contract|3|@P ERROR:  53100: could not extend file: No space left on device
2|contract|3|@P ERROR:  54001: stack depth limit exceeded
2|contract|3|@P ERROR:  58030: could not read block 0
2|contract|3|@P ERROR:  XX000: unexpected internal state
2|contract|3|@P ERROR:  55P03: canceling statement due to lock timeout
2|contract|3|@P ERROR:  23503: insert or update on table "action_items" violates foreign key constraint "action_items_triage_replacement_id_fkey"
2|contract|3|@P ERROR:  22012: division by zero
2|contract|3|@P ERROR:  P0001: FAIL T02 looks like a check but is not the contract's SQLSTATE
2|contract|3|@P ERROR:  TF001: T02 the contract's SQLSTATE without the FAIL marker
2|contract|3|@P ERROR:  canceling statement due to statement timeout
2|contract|3|@P ERROR:  FAIL T02 a FAIL message with no SQLSTATE at all
2|contract|3|@P NOTICE:  00000: PASS T01 x
2|contract|3|
2|contract|2|psql: error: connection to server at "127.0.0.1", port 1 failed
2|contract|1|psql: fatal
2|contract|124|@P ERROR:  TF001: FAIL T02 y: z
0|classify|1|migration applied over 3 existing rows\nPASS T01 x\nERROR TF001: FAIL T08 a keep on a deferred item is refused: recorded\nFAIL ACTION ITEM REVIEW SQL TEST: FAIL T08 a keep on a deferred item is refused: recorded
0|classify|1|PASS C1 x\nFAIL C2: the review behind the archive was not refused (recorded|kept c0910001)
0|classify|1|PASS I helper list\nFAIL integration: MCP review: a keep is recorded
2|classify|1|ERROR 57014: canceling statement due to statement timeout\nFAIL ACTION ITEM REVIEW SQL TEST: canceling statement due to statement timeout
2|classify|1|ERROR: canceling statement due to statement timeout\nFAIL ACTION ITEM REVIEW SQL TEST: canceling statement due to statement timeout
2|classify|1|ERROR 23503: insert or update on table "action_items" violates foreign key constraint\nFAIL ACTION ITEM REVIEW SQL TEST: insert or update on table
2|classify|1|ERROR TF001: not a fail message\nFAIL ACTION ITEM REVIEW SQL TEST: x
2|classify|1|ERROR: FAIL T38 the old display shape, with no SQLSTATE
2|classify|1|FAIL C1: the first review did not record\nNEVER-RAN: a helper query did not execute
2|classify|1|NEVER-RAN: the script stopped before its last check
2|classify|1|something died
2|classify|1|
2|classify|1|PASS T01 x\n  FAIL indented is not a verdict line
1|classify|0|ACTION ITEM REVIEW TEST COMPLETE (mutation x)
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
  [ "$n" = 62 ] || { echo "VERDICT SELFTEST FAILED: ran $n cases, expected 62 (a case was lost)"; return 1; }
  if [ "$bad" -gt 0 ]; then echo "VERDICT SELFTEST FAILED ($bad of $n)"; return 1; fi
  echo "VERDICT SELFTEST PASSED ($n cases)"; return 0
}

if [ "${1:-}" = "--verdict-selftest" ]; then
  verdict_selftest; exit $?
fi
# No verdict below is trusted unless the classifiers pass their own cases.
vst=$(verdict_selftest) || { echo "NEVER-RAN: the verdict classifiers failed their own self-test, so no verdict can be trusted: $(printf '%s\n' "$vst" | grep -m1 '^FAIL')"; exit 2; }

if [ "${1:-}" = "--all-mutations" ]; then
  caught=0; survived=0; never=0; n=0
  shm_before=$(ipcs -m 2>/dev/null | grep -c '^m')
  for m in ${OBRP_MUTATIONS:-$MUTATIONS}; do
    n=$((n + 1))
    state="$(mktemp /tmp/obrp-state.XXXXXX)"
    out=$(OBRP_STATE_FILE="$state" python3 "$HERE/deadline.py" "$MUTANT_DEADLINE" bash "$0" --mutate "$m" 2>&1); code=$?
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
# action-item-review-harness-selftest.sh. Each one makes this run end non-zero in
# a known way; a run that reaches its last line with one set is NEVER-RAN.
INJECT="${OBRP_INJECT:-}"
PORT=$((55000 + RANDOM % 900))
# The /tmp/obrp. prefix is the one deadline.py's reaper recognises.
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

if ! initdb -D "$WORK/pg" -A trust -U postgres --locale=en_US.UTF-8 >"$WORK/initdb.log" 2>&1; then
  if grep -q shmget "$WORK/initdb.log"; then
    never "initdb failed at shmget: SysV shared memory is exhausted or denied (check 'ipcs -m' for orphaned segments from killed clusters, kern.sysv.shmmni)"
  fi
  never "initdb failed: $(tail -1 "$WORK/initdb.log")"
fi
pg_ctl -D "$WORK/pg" -o "-p $PORT -c listen_addresses=127.0.0.1 -k $WORK -c deadlock_timeout=200ms" -l "$WORK/pg.log" start -w >/dev/null || never "pg start failed: $(tail -1 "$WORK/pg.log")"
# VERBOSITY=verbose: every error line carries its SQLSTATE, which is what tells a
# failed check from a cancelled statement.
PSQL=(psql -X -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -q)
"${PSQL[@]}" -d postgres -c "create database obtest" >/dev/null || never "create database failed"

"${PSQL[@]}" -d obtest <<'SQL' >/dev/null || never "stub schema failed"
create role service_role nologin bypassrls; create role anon nologin; create role authenticated nologin;
create schema auth;
create function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;
grant usage on schema auth to service_role, anon, authenticated;
create table public.thoughts (id uuid primary key);
create table public.business_events (id uuid primary key, title text);
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

for f in "$M_MCP_LOG" "$M_DECISIONS" "$M_CLOSE" "$M_ARCHIVE"; do
  PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d obtest -f "$f" >"$WORK/prior.out" 2>&1 \
    || never "prior migration failed: $(basename "$f"): $(head -3 "$WORK/prior.out")"
done

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

# Rows that exist BEFORE the migration under test, as production's do.
q "insert into public.action_items (id, description, status) values
  ('a0000001-0000-4000-8000-000000000000', 'predates the migration 1', 'open'),
  ('a0000002-0000-4000-8000-000000000000', 'predates the migration 2', 'open'),
  ('a0000003-0000-4000-8000-000000000000', 'predates the migration 3', 'archived')" >/dev/null
[ "$(q "select count(*) from public.action_items")" = "3" ] || never "the pre-migration rows were not inserted"

# Task 3.1's two status trigger functions, as stored, before the migration.
TRIG_SQL="select string_agg(p.proname || ':' || md5(p.prosrc), ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('action_items_set_closed_at', 'action_items_record_status_event')"
trig_before=$(q "$TRIG_SQL")
case "$trig_before" in
  action_items_record_status_event:*,action_items_set_closed_at:*) ;;
  *) never "could not read the two Task 3.1 trigger functions before the migration (got '$trig_before')";;
esac

SRC_R="$WORK/review.sql"; cp "$M_REVIEW" "$SRC_R"
mutate_file() { # file, old, new: literal replace, exactly one occurrence
  python3 - "$1" "$2" "$3" <<'PY' || never "mutant did not change exactly one site: $(printf '%s' "$2" | head -1)"
import sys
p, a, b = sys.argv[1:4]
s = open(p).read()
if s.count(a) != 1: sys.exit(1)
open(p, 'w').write(s.replace(a, b))
PY
}
mr() { mutate_file "$SRC_R" "$1" "$2"; }
drop_check() { # constraint name: remove its whole alter table statement
  python3 - "$SRC_R" "$1" <<'PY' || never "mutant did not find the constraint $1"
import re, sys
p, name = sys.argv[1:3]
s = open(p).read()
pat = re.compile(r"alter table public\.action_items\n  add constraint %s check \(.*?\n  \);\n" % re.escape(name), re.S)
if len(pat.findall(s)) != 1: sys.exit(1)
open(p, 'w').write(pat.sub("", s))
PY
}
case "$MUTATE" in
  "") ;;
  # The writer.
  no_status_guard) mr "  if v_item_status <> 'open' then" "  if false then";;
  # An unknown item reported as a recorded review.
  not_found_unchecked) mr "  if not found then" "  if false then";;
  # The row lock gone: C2 must see a review recorded on an archived item.
  no_lock) mr "  where a.id = p_item_id
  for no key update;" "  where a.id = p_item_id;";;
  # A stronger lock than a non-key update needs: C3 must see the two proposals block.
  lock_for_update) mr "  where a.id = p_item_id
  for no key update;" "  where a.id = p_item_id
  for update;";;
  actor_unchecked) mr "  if v_actor <> 'operator' and not exists (" "  if false and not exists (";;
  keep_takes_fields) mr "    if p_disposition is not null or p_evidence is not null or p_replacement_id is not null then" "    if false then";;
  done_pointer_unchecked) mr "    if v_disposition = 'done' and v_evidence !~" "    if false and v_evidence !~";;
  evidence_untrimmed) mr "  v_evidence text := regexp_replace(p_evidence, '^[[:space:]]+|[[:space:]]+\$', '', 'g');" "  v_evidence text := p_evidence;";;
  evidence_length_unchecked) mr "    if char_length(v_evidence) > 500 then" "    if false then";;
  duplicate_without_replacement) mr "      if p_replacement_id is null then" "      if false then";;
  self_replacement_unchecked) mr "      if p_replacement_id = p_item_id then" "      if false then";;
  replacement_on_other) mr "    elsif p_replacement_id is not null then" "    elsif false then";;
  replacement_existence_unchecked) mr "  if p_replacement_id is not null and not exists (" "  if false and not exists (";;
  # A review that also rewrites a column it does not own.
  review_touches_created_at) mr "  set last_reviewed_at = now(),
      last_reviewed_by = v_actor," "  set last_reviewed_at = now(), created_at = now(),
      last_reviewed_by = v_actor,";;
  # A refusal that writes.
  refusal_writes) mr "    return query select 'refused'::text,
      format('%s is %s; only an open item is reviewed', v_short, v_item_status);" "    update public.action_items a set description = a.description || ' (refused)' where a.id = p_item_id;
    return query select 'refused'::text,
      format('%s is %s; only an open item is reviewed', v_short, v_item_status);";;
  # The clearing trigger.
  trigger_never_clears) mr "  if new.status is distinct from old.status and new.status = 'open' then" "  if false then";;
  trigger_clears_on_any_change) mr "  if new.status is distinct from old.status and new.status = 'open' then" "  if new.status is distinct from old.status then";;
  trigger_clears_without_status_change) mr "  if new.status is distinct from old.status and new.status = 'open' then" "  if new.status = 'open' then";;
  # The migration replacing one of Task 3.1's trigger functions after all.
  touches_31_trigger) cat >> "$SRC_R" <<'SQL'
create or replace function public.action_items_set_closed_at()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  return new;
end;
$$;
SQL
    ;;
  # The read order.
  list_no_exclusion) mr "      and (a.last_reviewed_at is null
           or a.last_reviewed_at < now() - make_interval(days => p_unreviewed_days))" "      and true";;
  list_order_created_only) mr "    order by coalesce(a.last_reviewed_at, a.created_at) asc, a.id asc" "    order by a.created_at asc, a.id asc";;
  list_id_desc) mr "    order by coalesce(a.last_reviewed_at, a.created_at) asc, a.id asc" "    order by coalesce(a.last_reviewed_at, a.created_at) asc, a.id desc";;
  list_includes_deferred) mr "    where a.status = 'open'
      and (a.last_reviewed_at is null" "    where a.status in ('open', 'deferred')
      and (a.last_reviewed_at is null";;
  list_boundary_inclusive) mr "           or a.last_reviewed_at < now() - make_interval(days => p_unreviewed_days))" "           or a.last_reviewed_at <= now() - make_interval(days => p_unreviewed_days))";;
  list_total_is_row_number) mr "           count(*) over () as unreviewed_total" "           row_number() over (order by coalesce(a.last_reviewed_at, a.created_at), a.id) as unreviewed_total";;
  list_days_ignored) mr "           or a.last_reviewed_at < now() - make_interval(days => p_unreviewed_days))" "           or a.last_reviewed_at < now() - interval '14 days')";;
  list_days_unchecked) mr "  if p_unreviewed_days is null or p_unreviewed_days < 1 or p_unreviewed_days > 365 then" "  if false then";;
  list_limit_unchecked) mr "  if p_limit is null or p_limit < 1 or p_limit > 100 then" "  if false then";;
  list_offset_unchecked) mr "  if p_offset is null or p_offset < 0 then" "  if false then";;
  # Grants.
  grant_review_anon) echo "grant execute on function public.review_action_item(uuid, text, text, text, text, uuid) to anon;" >> "$SRC_R";;
  grant_list_authenticated) echo "grant execute on function public.list_unreviewed_action_items(integer, integer, integer) to authenticated;" >> "$SRC_R";;
  # The five CHECKs, one at a time.
  no_check_outcome_known) drop_check action_items_review_outcome_known;;
  no_check_disposition_known) drop_check action_items_triage_disposition_known;;
  no_check_together) drop_check action_items_review_together;;
  no_check_proposal_shape) drop_check action_items_review_proposal_shape;;
  no_check_replacement) drop_check action_items_triage_replacement_consistent;;
  # One arm of a two-arm CHECK at a time; the other arm stays.
  check_together_no_reviewer_arm) mr "    (last_reviewed_at is null) = (review_outcome is null)
    and (last_reviewed_at is null) = (last_reviewed_by is null)" "    (last_reviewed_at is null) = (review_outcome is null)";;
  check_shape_no_evidence_arm) mr "    (review_outcome is not distinct from 'proposal') = (triage_disposition is not null)
    and (review_outcome is not distinct from 'proposal') = (triage_evidence is not null)" "    (review_outcome is not distinct from 'proposal') = (triage_disposition is not null)";;
  check_replacement_no_self_arm) mr "    or (triage_disposition is not distinct from 'duplicate' and triage_replacement_id <> id)" "    or (triage_disposition is not distinct from 'duplicate')";;
  fk_no_set_null) mr "    references public.action_items(id) on delete set null;" "    references public.action_items(id);";;
  *) never "unknown mutation: $MUTATE";;
esac

if ! PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d obtest -f "$SRC_R" >"$WORK/mig.out" 2>&1; then
  never "migration failed to apply: $(sed 's/^psql:.*ERROR/ERROR/' "$WORK/mig.out" | head -3)"
fi
echo "migration applied over 3 existing rows"

# 1. Task 3.1's trigger functions are byte-identical after the migration.
trig_after=$(q "$TRIG_SQL")
[ -n "$trig_after" ] || never "could not read the two Task 3.1 trigger functions after the migration"
[ "$trig_after" = "$trig_before" ] || fail "the migration changed a Task 3.1 status trigger function (before $trig_before, after $trig_after)"
echo "PASS the two Task 3.1 status trigger functions are unchanged by the migration ($trig_after)"

# Negative controls (OBRP_INJECT). The contract ones edit a COPY of the contract;
# the others plant a trigger that raises a statement cancellation (57014) on one
# named row, so the interruption arrives through the real path being judged.
CONTRACT="$TEST_SQL"
inject_sql() { # anchor, inserted text: into a copy of the contract, exactly one site
  CONTRACT="$WORK/contract.sql"; cp "$TEST_SQL" "$CONTRACT"
  mutate_file "$CONTRACT" "$1" "$1$2"
}
inject_trigger() { # timing/event, WHEN condition
  "${PSQL[@]}" -d obtest >/dev/null 2>"$WORK/inject.err" <<SQL || never "injection $INJECT did not apply: $(head -1 "$WORK/inject.err")"
create function public.obt_injected_cancel() returns trigger language plpgsql as \$f\$
begin
  raise exception using errcode = '57014', message = 'canceling statement due to statement timeout (injected by OBRP_INJECT=$INJECT)';
end \$f\$;
create trigger obt_injected_cancel $1 on public.action_items for each row when ($2) execute function public.obt_injected_cancel();
SQL
}
TOP_ANCHOR="set client_min_messages = notice;
"
POINT_ANCHOR="-- OBRP_INJECT_POINT (the runner's negative controls insert one statement here)
"
case "$INJECT" in
  "") ;;
  # A real statement_timeout before any check (the review's reproduction).
  sql_timeout) inject_sql "$TOP_ANCHOR" "set statement_timeout=10;
select pg_sleep(0.2);
";;
  # A statement that outlives the outer deadline.
  sql_sleep) inject_sql "$TOP_ANCHOR" "select pg_sleep(600);
";;
  # A real statement_timeout inside pg_temp.attempt's handler block.
  cancel_in_attempt) inject_sql "$POINT_ANCHOR" "set statement_timeout = 50;
select pg_temp.raises('INJECTED a statement cancelled inside attempt', 'select pg_sleep(2)', '22023', 'x');
";;
  # A resource error raised inside pg_temp.attempt, which WHEN OTHERS does catch.
  resource_in_attempt) inject_sql "$POINT_ANCHOR" "select pg_temp.raises('INJECTED out of memory inside attempt', \$i\$do \$j\$ begin raise exception using errcode = '53200', message = 'out of memory (injected)'; end \$j\$\$i\$, '22023', 'x');
";;
  # A behavioral SQL error that no check was written for.
  raw_error) inject_sql "$POINT_ANCHOR" "select 1/0;
";;
  # The positive control: a check that runs to completion and does not hold.
  assert_fail) inject_sql "$POINT_ANCHOR" "select pg_temp.ok('INJECTED a completed check that does not hold', 1 = 2, 'one is not two');
";;
  integration_cancel_helper|integration_cancel_mcp|conn_cancel|helper_cancel|helper_stray) ;; # planted further down
  *) never "unknown injection: $INJECT";;
esac

# 2. The single-connection contract. ONLY_CONCURRENCY=1 skips it (and the
# integration step), to prove a mutant is caught by the schedules on their own.
# psql's exit 3 says only that a statement raised; contract_verdict reads the
# SQLSTATE to tell a failed check (exit 1) from everything else (NEVER-RAN).
if [ -z "${ONLY_CONCURRENCY:-}" ]; then
  "${PSQL[@]}" -d obtest -v interruption_prefixes="$INTERRUPTION_PREFIXES" -f "$CONTRACT" >"$WORK/contract.out" 2>&1; code=$?
  grep -E '^psql:.*:[0-9]+: (NOTICE|ERROR):  ' "$WORK/contract.out" \
    | sed -E 's/^psql:.*:[0-9]+: NOTICE:  00000: //; s/^psql:.*:[0-9]+: ERROR:  ([0-9A-Z]{5}): /ERROR \1: /; s/^psql:.*:[0-9]+: ERROR:  /ERROR (no SQLSTATE): /'
  contract_verdict "$code" "$WORK/contract.out"
  case $? in
    0) ;;
    1) echo "FAIL ACTION ITEM REVIEW SQL TEST: $VERDICT"; exit 1;;
    *) never "$VERDICT";;
  esac

  # 3. The public entry points against these real functions.
  if [ -z "${SKIP_INTEGRATION:-}" ]; then
    case "$INJECT" in
      # The helper path's first recorded review, then the MCP tool's first keep.
      integration_cancel_helper) inject_trigger "before update" "new.id = 'c2000004-0000-4000-8000-000000000000'";;
      integration_cancel_mcp) inject_trigger "before update" "new.id = 'c2000001-0000-4000-8000-000000000000' and new.review_outcome = 'keep'";;
    esac
    IOUT=$(OBRP_PG_PORT="$PORT" OBRP_INTERRUPTION_PREFIXES="$INTERRUPTION_PREFIXES" python3 "$HERE/deadline.py" "${OBRP_INTEGRATION_DEADLINE:-240}" \
      deno run --no-lock --config "$HERE/closeout-capture-probe.deno.json" \
      --allow-net --allow-env --allow-read --allow-run=psql "$HERE/action-item-review-integration.ts" 2>&1); icode=$?
    echo "$IOUT" | grep -E '^(PASS I |FAIL|NEVER-RAN|ACTION ITEM REVIEW INTEGRATION|  )'
    case "$icode" in
      0) echo "$IOUT" | grep -q "ACTION ITEM REVIEW INTEGRATION PASSED" || never "the integration harness exited 0 without its PASSED line";;
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
# The mirror: the statement must COMPLETE without waiting. Seen waiting on a lock
# is the failure; completing is the pass; neither within the time is NEVER-RAN.
expect_unblocked() { # name label
  SEQ=$((SEQ + 1)); local f="$WORK/sync.$SEQ" t=100
  send "$1" "\\! touch $f"
  while [ "$t" -gt 0 ]; do
    [ -e "$f" ] && return 0
    [ "$(blocked_count "$1")" = "1" ] && fail "$2: connection $1 is waiting on a lock"
    sleep 0.05; t=$((t - 1))
  done
  never "connection $1 neither completed nor was seen waiting on a lock"
}
clean() { tr -d '\000' < "$WORK/$1.out"; }
# The end of a transcript on ONE line, for a FAIL message: a second line starting
# "ERROR" would read to the sweep as an SQL error of its own.
last2() { clean "$1" | tail -2 | tr '\n' ' '; }
rev() { q "select concat_ws('|', status, coalesce(review_outcome, '-'), coalesce(last_reviewed_by, '-'), coalesce(triage_disposition, '-'), coalesce(triage_evidence, '-'), coalesce(left(triage_replacement_id::text, 8), '-')) from public.action_items where id = '$1'"; }

case "$INJECT" in
  # C1's first review is cancelled on connection A.
  conn_cancel) inject_trigger "before update" "new.description = 'c1'";;
  # The helper query that inserts C1's item is cancelled.
  helper_cancel) inject_trigger "before insert" "new.description = 'c1'";;
  # A helper query that raises while every check goes on to hold.
  helper_stray) q "select 1/0" >/dev/null;;
esac
q "insert into public.agent_task_ledger (agent_code) values ('triage') on conflict do nothing" >/dev/null
open_conn A; open_conn B

# C1: two reviews of one item.
I1=c0900001-0000-4000-8000-000000000000
q "insert into public.action_items (id, description) values ('$I1', 'c1')" >/dev/null
: > "$WORK/A.out"; : > "$WORK/B.out"
send A "begin;"
send A "select status from public.review_action_item('$I1', 'keep', 'triage');"
sync_conn A
send B "select status || '|' || message from public.review_action_item('$I1', 'proposal', 'operator', 'stale', 'second writer');"
wait_blocked B "C1 the second review waits for the first"
send A "commit;"; sync_conn A; sync_conn B
clean A | grep -qx "recorded" || fail "C1: the first review did not record ($(last2 A))"
clean B | grep -qx "recorded|proposed c0900001: stale" || fail "C1: the second review did not record ($(last2 B))"
[ "$(rev "$I1")" = "open|proposal|operator|stale|second writer|-" ] || fail "C1: the later review is not the one on the row ($(rev "$I1"))"
echo "PASS C1 two reviews of one item: the second really waited, both recorded, the later one is on the row"

# C2: a review behind an uncommitted archive.
I2=c0910001-0000-4000-8000-000000000000
q "insert into public.action_items (id, description) values ('$I2', 'c2')" >/dev/null
: > "$WORK/A.out"; : > "$WORK/B.out"
send A "begin;"
send A "select public.transition_action_item('$I2', '{open}', 'archived', 'operator', 'expired');"
sync_conn A
send B "select status || '|' || message from public.review_action_item('$I2', 'keep', 'triage');"
wait_blocked B "C2 the review waits behind the uncommitted archive"
send A "commit;"; sync_conn A; sync_conn B
clean A | grep -qx "1" || fail "C2: the archive did not apply ($(last2 A))"
clean B | grep -qx "refused|c0910001 is archived; only an open item is reviewed" || fail "C2: the review behind the archive was not refused ($(last2 B))"
[ "$(rev "$I2")" = "archived|-|-|-|-|-" ] || fail "C2: an archived item carries a review ($(rev "$I2"))"
echo "PASS C2 a review behind an uncommitted archive: it really waited, then answered refused and wrote nothing"

# C3: two duplicate proposals naming each other. Each needs a key-share lock on the
# other's row for its foreign key, which FOR NO KEY UPDATE does not block.
X3=c0920001-0000-4000-8000-000000000000; Y3=c0920002-0000-4000-8000-000000000000
q "insert into public.action_items (id, description) values ('$X3', 'c3 x'), ('$Y3', 'c3 y')" >/dev/null
: > "$WORK/A.out"; : > "$WORK/B.out"
send A "begin;"
send A "select status from public.review_action_item('$X3', 'proposal', 'triage', 'duplicate', 'same as y', '$Y3');"
sync_conn A
[ "$(q "select count(*) from pg_stat_activity where application_name = 'conn_A' and state = 'idle in transaction'")" = "1" ] || fail "C3: connection A is not holding its transaction open, so this fixture proves nothing"
send B "select status from public.review_action_item('$Y3', 'proposal', 'triage', 'duplicate', 'same as x', '$X3');"
expect_unblocked B "C3 a duplicate proposal naming a row another review holds"
send A "commit;"; sync_conn A
clean A | grep -qx "recorded" || fail "C3: A's proposal did not record ($(last2 A))"
clean B | grep -qx "recorded" || fail "C3: B's proposal did not record ($(last2 B))"
[ "$(rev "$X3")" = "open|proposal|triage|duplicate|same as y|c0920002" ] || fail "C3: X's row ($(rev "$X3"))"
[ "$(rev "$Y3")" = "open|proposal|triage|duplicate|same as x|c0920001" ] || fail "C3: Y's row ($(rev "$Y3"))"
echo "PASS C3 two duplicate proposals naming each other: neither waited on the other, both recorded"

# Every check held. That is a pass only if everything the checks read executed.
[ -s "$WORK/qfail" ] && never "every check held, but a helper query did not execute during the run ($(head -1 "$WORK/qfail" | cut -c1-200))"
[ -n "$INJECT" ] && never "the injection $INJECT did not stop the run, so it did not fire"
COMPLETED=1
echo "ACTION ITEM REVIEW TEST COMPLETE${MUTATE:+ (mutation $MUTATE)}"
