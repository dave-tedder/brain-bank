#!/bin/bash
# Task 5.4 follow-up (PR 32 decision 7): prove
# supabase/migrations/20261121c_complete_contract_events.sql and the read-only
# queries in scripts/loop-closing/complete-contract-metrics.sql on a throwaway
# LOCAL PostgreSQL cluster (never production).
#
#   bash scripts/open-engine/complete-contract-events-sql-test.sh                   # exit 0 passed
#   bash scripts/open-engine/complete-contract-events-sql-test.sh --mutate <name>   # a planted fault: exit 1 expected
#   bash scripts/open-engine/complete-contract-events-sql-test.sh --all-mutations   # every planted fault must be CAUGHT
#   bash scripts/open-engine/complete-contract-events-sql-test.sh --inject <name>   # one control case
#   bash scripts/open-engine/complete-contract-events-sql-test.sh --inject-selftest # every control case reads as expected
#
# Three outcomes, never two:
#   0  passed: every check ran to completion and held (the contract printed its
#      PASSED line and psql exited 0 with no error).
#   1  FAILED: a check RAN TO COMPLETION and did not hold: the contract raised
#      SQLSTATE TF001 with a message starting "FAIL " (pg_temp.ok is the only
#      thing that raises TF001). Only this is a caught planted fault.
#   2  NEVER-RAN: the lock, the cluster, the stub, the migration, the query
#      extraction or a planted fault did not apply; a statement was interrupted
#      (SQLSTATE 08, 53, 54, 57, 58, XX, 55P03); the contract stopped on an SQL
#      error that is not one of its assertions; it exited 0 without its PASSED
#      line. Nothing was judged, so nothing was caught.
#
# The cluster lock: the shared database lock (scripts/loop-closing/db-lock.sh,
# an flock the operating system frees when this run dies) is taken before a
# cluster starts, waiting up to OB_DB_LOCK_WAIT_MIN minutes (default 150).
# --all-mutations and --inject-selftest hold it once for the whole sweep; the
# per-case runs see OB_DB_LOCK_HELD and use that hold instead of waiting on it.
export LC_ALL=C
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/scripts/open-engine"
DEADLINE_PY="$ROOT/scripts/loop-closing/deadline.py"
MIGRATION="$ROOT/supabase/migrations/20261121c_complete_contract_events.sql"
METRICS="$ROOT/scripts/loop-closing/complete-contract-metrics.sql"
TEST_SQL="$HERE/complete-contract-events-sql-test.sql"
. "$ROOT/scripts/loop-closing/db-lock.sh"
INITDB_BIN="${OBCE_INITDB:-initdb}"
CASE_DEADLINE="${OBCE_CASE_DEADLINE:-240}"
INTERRUPTION_PREFIXES="08 53 54 57 58 XX 55P03"

# name | the first FAIL line a completed run must print
mutation_table() {
  cat <<'T'
rls_off|^FAIL T03 RLS enabled
select_policy_dropped|^FAIL T03 policies
anon_select_granted|^FAIL T04 anon has no privilege
authenticated_insert_granted|^FAIL T04 authenticated has no privilege
anon_keeps_default|^FAIL T04 anon has no privilege
authenticated_keeps_default|^FAIL T04 authenticated has no privilege
service_role_keeps_default|^FAIL T04 service_role has exactly insert and select
service_role_update|^FAIL T04 service_role has exactly insert and select
service_role_delete|^FAIL T04 service_role has exactly insert and select
service_role_no_insert|^FAIL T04 service_role has exactly insert and select
service_role_no_select|^FAIL T04 service_role has exactly insert and select
outcome_check_widened|^FAIL T02 outcome accepted is refused
tool_check_dropped|^FAIL T02 another tool is refused
reason_check_loosened|^FAIL T02 receipt text in reason is refused
reason_check_dropped|^FAIL T02 receipt text in reason is refused
weekly_done_any_event|^FAIL T05 this week
weekly_refused_counts_all|^FAIL T05 this week
weekly_later_done_ignores_order|^FAIL T05 this week
weekly_local_time_weeks|^FAIL T05 (this|last) week
weekly_slugs_not_distinct|^FAIL T05 this week
reasons_not_split|^FAIL T05 reasons by week
reasons_window_unbounded|^FAIL T05 reasons by week
weekly_uses_created_at|^FAIL T05 this week
later_done_uses_created_at|^FAIL T05 this week
reasons_uses_created_at|^FAIL T05 reasons by week
reasons_no_upper_bound|^FAIL T05 reasons by week
slug_length_cap|^FAIL T04 service_role insert of a 5000-character agent_code and project_slug works
agent_length_cap|^FAIL T04 service_role insert of a 5000-character agent_code and project_slug works
share_integer_division|^FAIL T05 this week
later_done_uses_last_refusal|^FAIL T05 this week
service_role_column_update|^FAIL T04 no column-level grants on the table
anon_column_select|^FAIL T04 no column-level grants on the table
service_role_set_only_writer|^FAIL T04 no role reachable from anon, authenticated or service_role holds more than intended on the table
service_role_inherited_writer|^FAIL T04 service_role has exactly insert and select
service_role_grant_option|^FAIL T04 no role reachable from anon, authenticated or service_role holds more than intended on the table
T
}

# name | expected exit | ERE the first FAIL/NEVER-RAN line must match
inject_table() {
  cat <<'T'
initdb_missing|2|^NEVER-RAN: initdb failed
migration_syntax_error|2|^NEVER-RAN: migration failed to apply
query_marker_missing|2|^NEVER-RAN: could not extract query complete_contract_weekly
contract_sql_error|2|^NEVER-RAN: the SQL contract stopped on an SQL error that is not one of its assertions \(SQLSTATE 22012
statement_timeout|2|^NEVER-RAN: the SQL contract was interrupted \(SQLSTATE 57014
no_passed_line|2|^NEVER-RAN: the SQL contract exited 0 without its PASSED line
unknown_mutation|2|^NEVER-RAN: unknown planted fault
planted_assertion|1|^FAIL INJECTED planted assertion
role_setup_failure|2|^NEVER-RAN: the SQL contract stopped on an SQL error that is not one of its assertions \(SQLSTATE 22023: role "anon" does not exist
query_tail_statement|2|^NEVER-RAN: could not extract query complete_contract_weekly from complete-contract-metrics.sql: block complete_contract_weekly does not hold exactly one statement
query_text_outside_blocks|2|^NEVER-RAN: could not extract query complete_contract_weekly from complete-contract-metrics.sql: executable text before the first marker
query_marker_duplicated|2|^NEVER-RAN: could not extract query complete_contract_weekly from complete-contract-metrics.sql: the query markers are
query_commented_terminator|2|^NEVER-RAN: could not extract query complete_contract_weekly from complete-contract-metrics.sql: block complete_contract_weekly does not hold exactly one statement ending in its only terminator \(0 terminators
verbatim_file_error|2|^NEVER-RAN: the metrics file did not run on its own in a fresh psql session \(psql exit 3: ERROR:  22012
verbatim_fresh_session_variable|2|^NEVER-RAN: the metrics file did not run on its own in a fresh psql session \(psql exit 3: ERROR:  42601
query_psql_variable|2|^NEVER-RAN: could not extract query complete_contract_weekly from complete-contract-metrics.sql: psql variable interpolation in block complete_contract_weekly
query_psql_variable_existence|2|^NEVER-RAN: could not extract query complete_contract_weekly from complete-contract-metrics.sql: psql variable interpolation in block complete_contract_weekly
raw_sql_variable_existence|2|^NEVER-RAN: the metrics file did not run as raw SQL, as the SQL editor sends it \(psql exit 1: ERROR:  42601
T
}

take_lock() {
  ob_db_lock_acquire complete-contract-events-sql-test || { echo "NEVER-RAN: $OB_DB_LOCK_ERROR"; exit 2; }
}
release_lock() { ob_db_lock_release; }

case "${1:-}" in
  --all-mutations)
    take_lock; trap release_lock EXIT
    caught=0; survived=0; never=0; wrong=0; n=0
    while IFS='|' read -r m want; do
      [ -z "$m" ] && continue
      n=$((n + 1))
      out=$(python3 "$DEADLINE_PY" "$CASE_DEADLINE" bash "$0" --mutate "$m" 2>&1); code=$?
      first=$(printf '%s\n' "$out" | grep -m1 -E '^(FAIL|NEVER-RAN)')
      case "$code" in
        1) if printf '%s\n' "$first" | grep -Eq "$want"; then caught=$((caught + 1)); echo "CAUGHT $m: $first"
           else wrong=$((wrong + 1)); echo "WRONG-CHECK $m: wanted /$want/, got: $first"; fi;;
        0) survived=$((survived + 1)); echo "SURVIVED $m";;
        *) never=$((never + 1)); echo "NEVER-RAN $m (exit $code): ${first:-$(printf '%s\n' "$out" | tail -1)}";;
      esac
    done < <(mutation_table)
    echo "SWEEP: $n planted faults, $caught caught, $survived survived, $wrong failed a different check, $never never ran"
    if [ "$never" -gt 0 ]; then echo "SWEEP INCOMPLETE"; exit 2; fi
    if [ "$survived" -gt 0 ] || [ "$wrong" -gt 0 ]; then exit 1; fi
    echo "ALL $n PLANTED FAULTS CAUGHT"; exit 0;;
  --inject-selftest)
    take_lock; trap release_lock EXIT
    good=0; bad=0; n=0
    while IFS='|' read -r name want_code want; do
      [ -z "$name" ] && continue
      n=$((n + 1))
      if [ "$name" = unknown_mutation ]; then
        out=$(python3 "$DEADLINE_PY" "$CASE_DEADLINE" bash "$0" --mutate obce_no_such_fault 2>&1); code=$?
      else
        out=$(python3 "$DEADLINE_PY" "$CASE_DEADLINE" bash "$0" --inject "$name" 2>&1); code=$?
      fi
      first=$(printf '%s\n' "$out" | grep -m1 -E '^(FAIL|NEVER-RAN)')
      if [ "$code" = "$want_code" ] && printf '%s\n' "$first" | grep -Eq "$want"; then
        good=$((good + 1)); echo "AS-EXPECTED $name (exit $code): $first"
      else
        bad=$((bad + 1)); echo "UNEXPECTED $name: exit $code (want $want_code), first line: ${first:-$(printf '%s\n' "$out" | tail -1)}"
      fi
    done < <(inject_table)
    echo "CONTROLS: $n cases, $good as expected, $bad unexpected"
    [ "$bad" -eq 0 ] && { echo "ALL $n CONTROL CASES AS EXPECTED"; exit 0; }
    exit 1;;
esac

MUTATE=""; INJECT=""
case "${1:-}" in
  --mutate) MUTATE="${2:-}";;
  --inject) INJECT="${2:-}";;
  "") ;;
  *) echo "NEVER-RAN: unknown argument ${1}"; exit 2;;
esac
[ "$INJECT" = initdb_missing ] && INITDB_BIN=/nonexistent/obce-initdb

PORT=$((57000 + RANDOM % 900))
WORK="$(mktemp -d /tmp/obrp.ccevents.XXXXXX)"
[ -n "${OBRP_STATE_FILE:-}" ] && printf '%s\n' "$WORK" > "$OBRP_STATE_FILE"
never() { echo "NEVER-RAN: $*"; exit 2; }
cleanup() {
  local rc=$?
  if [ -f "$WORK/pg/postmaster.pid" ]; then
    pg_ctl -D "$WORK/pg" stop -m fast -t 10 >/dev/null 2>&1 || pg_ctl -D "$WORK/pg" stop -m immediate >/dev/null 2>&1
  fi
  rm -rf "$WORK"
  release_lock
  exit "$rc"
}
trap cleanup EXIT
trap 'echo "NEVER-RAN: interrupted by a signal"; exit 2' TERM INT HUP

take_lock

# literal replace of exactly one occurrence, else NEVER-RAN
replace_once() {
  python3 - "$1" "$2" "$3" <<'PY' || never "planted fault or control did not change exactly one site in $(basename "$1"): $(printf '%s' "$2" | head -1)"
import sys
p, a, b = sys.argv[1:4]
s = open(p).read()
if s.count(a) != 1: sys.exit(1)
open(p, 'w').write(s.replace(a, b))
PY
}

MIG="$WORK/migration.sql"; cp "$MIGRATION" "$MIG" || never "cannot read the migration"
MET="$WORK/metrics.sql"; cp "$METRICS" "$MET" || never "cannot read the metrics file"
CON="$WORK/contract-src.sql"; cp "$TEST_SQL" "$CON" || never "cannot read the contract"
mm() { replace_once "$MIG" "$1" "$2"; }
mq() { replace_once "$MET" "$1" "$2"; }
REVOKE="revoke all on table public.complete_contract_events from public, anon, authenticated, service_role;"
GRANT="grant select, insert on table public.complete_contract_events to service_role;"
case "$MUTATE" in
  "") ;;
  rls_off) mm "alter table public.complete_contract_events enable row level security;" "";;
  select_policy_dropped) mm 'create policy "Service role reads complete_contract_events"
  on public.complete_contract_events for select to service_role using (true);' "";;
  anon_select_granted) printf '%s\n' "grant select on table public.complete_contract_events to anon;" >> "$MIG";;
  authenticated_insert_granted) printf '%s\n' "grant insert on table public.complete_contract_events to authenticated;" >> "$MIG";;
  anon_keeps_default) mm "$REVOKE" "revoke all on table public.complete_contract_events from public, authenticated, service_role;";;
  authenticated_keeps_default) mm "$REVOKE" "revoke all on table public.complete_contract_events from public, anon, service_role;";;
  service_role_keeps_default) mm "$REVOKE" "revoke all on table public.complete_contract_events from public, anon, authenticated;";;
  service_role_update) mm "$GRANT" "grant select, insert, update on table public.complete_contract_events to service_role;";;
  service_role_delete) mm "$GRANT" "grant select, insert, delete on table public.complete_contract_events to service_role;";;
  service_role_no_insert) mm "$GRANT" "grant select on table public.complete_contract_events to service_role;";;
  service_role_no_select) mm "$GRANT" "grant insert on table public.complete_contract_events to service_role;";;
  outcome_check_widened) mm "check (outcome in ('refused', 'warned'))" "check (outcome in ('refused', 'warned', 'accepted'))";;
  tool_check_dropped) mm "check (tool in ('complete_agent_task', 'request_agent_review'))" "check (tool <> '')";;
  reason_check_loosened) mm "check (reason ~ '^[A-Z][A-Z0-9_]{0,63}(,[A-Z][A-Z0-9_]{0,63}){0,31}\$')" "check (reason ~ '^[A-Za-z][A-Za-z0-9_ :.,]*\$')";;
  reason_check_dropped) mm "check (reason ~ '^[A-Z][A-Z0-9_]{0,63}(,[A-Z][A-Z0-9_]{0,63}){0,31}\$')" "check (reason <> '')";;
  weekly_done_any_event) mq "  where e.event_type = 'AGENT DONE' and e.created_at at time zone 'UTC' >= b.start_week" "  where e.created_at at time zone 'UTC' >= b.start_week";;
  weekly_refused_counts_all) mq "(select count(*) from ev where ev.week = w.week and ev.outcome = 'refused') as refused_events" "(select count(*) from ev where ev.week = w.week) as refused_events";;
  weekly_later_done_ignores_order) mq "                         where e.task_id = f.task_id and e.event_type = 'AGENT DONE'
                           and e.created_at > f.at)) as refused_tasks_later_done," "                         where e.task_id = f.task_id and e.event_type = 'AGENT DONE')) as refused_tasks_later_done,";;
  weekly_local_time_weeks) mq "  select date_trunc('week', c.occurred_at at time zone 'UTC')::date as week,
         c.task_id" "  select date_trunc('week', c.occurred_at)::date as week,
         c.task_id";;
  weekly_uses_created_at) mq "  select date_trunc('week', c.occurred_at at time zone 'UTC')::date as week,
         c.task_id" "  select date_trunc('week', c.created_at at time zone 'UTC')::date as week,
         c.task_id";;
  later_done_uses_created_at) mq "         c.task_id, c.outcome, c.reason, c.project_slug, c.occurred_at
" "         c.task_id, c.outcome, c.reason, c.project_slug, c.created_at as occurred_at
";;
  reasons_uses_created_at) mq "select date_trunc('week', c.occurred_at at time zone 'UTC')::date as week,
       r.reason_code" "select date_trunc('week', c.created_at at time zone 'UTC')::date as week,
       r.reason_code";;
  reasons_no_upper_bound) mq "
  and c.occurred_at at time zone 'UTC' < date_trunc('week', now() at time zone 'UTC') + interval '7 days'" "";;
  weekly_slugs_not_distinct) mq "(select count(distinct ev.project_slug) from ev" "(select count(ev.project_slug) from ev";;
  reasons_not_split) mq "cross join lateral unnest(string_to_array(c.reason, ',')) as r(reason_code)" "cross join lateral unnest(array[c.reason]) as r(reason_code)";;
  reasons_window_unbounded) mq "where c.outcome = 'refused'
  and c.occurred_at at time zone 'UTC' >= date_trunc('week', now() at time zone 'UTC') - interval '11 weeks'" "where c.outcome = 'refused'";;
  slug_length_cap) mm "check (project_slug is null or project_slug <> '')" "check (project_slug is null or char_length(project_slug) between 1 and 200)";;
  agent_length_cap) mm "check (agent_code is null or agent_code <> '')" "check (agent_code is null or char_length(agent_code) between 1 and 200)";;
  service_role_column_update) printf '%s\n' "grant update (project_slug) on table public.complete_contract_events to service_role;" >> "$MIG";;
  anon_column_select) printf '%s\n' "grant select (reason) on table public.complete_contract_events to anon;" >> "$MIG";;
  service_role_set_only_writer) printf '%s\n' "create role obt_writer nologin bypassrls;" "grant update on table public.complete_contract_events to obt_writer;" "grant obt_writer to service_role with inherit false, set true;" >> "$MIG";;
  service_role_inherited_writer) printf '%s\n' "create role obt_writer nologin bypassrls;" "grant update on table public.complete_contract_events to obt_writer;" "grant obt_writer to service_role;" >> "$MIG";;
  service_role_grant_option) printf '%s\n' "grant select, insert on table public.complete_contract_events to service_role with grant option;" >> "$MIG";;
  later_done_uses_last_refusal) mq "min(ev.occurred_at) as at" "max(ev.occurred_at) as at";;
  share_integer_division) mq "round(100.0 * refused_events" "round(100 * refused_events";;
  *) never "unknown planted fault: $MUTATE";;
esac
case "$INJECT" in
  ""|initdb_missing) ;;
  migration_syntax_error) printf '%s\n' "create tabel obce_injected ();" >> "$MIG";;
  query_marker_missing) mq "-- query: complete_contract_weekly" "-- (marker removed by the control case)";;
  contract_sql_error) replace_once "$CON" "-- T02 the CHECKs" "select 1/0;
-- T02 the CHECKs";;
  statement_timeout) replace_once "$CON" "-- T02 the CHECKs" "set statement_timeout = '50ms';
select pg_sleep(2);
-- T02 the CHECKs";;
  no_passed_line) replace_once "$CON" "do \$\$ begin raise notice 'COMPLETE CONTRACT EVENTS SQL TEST PASSED'; end \$\$;" "";;
  planted_assertion) replace_once "$CON" "-- T02 the CHECKs" "select pg_temp.ok('INJECTED planted assertion', false, 'planted by the control case');
-- T02 the CHECKs";;
  role_setup_failure) replace_once "$CON" "select pg_temp.raises('T04 anon select is refused'" "alter role anon rename to obce_renamed_anon;
select pg_temp.raises('T04 anon select is refused'";;
  query_tail_statement) mq "order by week;" "order by week;
select 1/0;";;
  query_text_outside_blocks) mq "-- query: complete_contract_weekly" "select 1;
-- query: complete_contract_weekly";;
  query_marker_duplicated) mq "-- query: complete_contract_weekly" "-- query: complete_contract_weekly
-- query: complete_contract_weekly";;
  query_commented_terminator) mq "order by week;" "order by week -- ;";;
  verbatim_file_error|verbatim_fresh_session_variable|raw_sql_variable_existence) ;;  # applied after the contract is built, below
  query_psql_variable_existence) mq "from ev where ev.outcome = 'refused' and ev.task_id is not null" "from ev where ev.outcome = 'refused' and ev.task_id is not null and :{?ON_ERROR_STOP}";;
  query_psql_variable) mq "from ev where ev.outcome = 'refused' and ev.task_id is not null" "from ev where ev.outcome = 'refused' and ev.task_id is not null and :'interruption_prefixes' is not null";;
  *) never "unknown control case: $INJECT";;
esac

# Extract each query (correction 1, finding 4; correction 2, finding 1). The
# file is read with a small SQL lexer (single and double quotes, -- and /* */
# comments), so a ';' inside a comment or a literal is not a terminator and a
# comment line inside a literal is kept. The file must hold exactly the two
# named markers, each once; nothing but comments and whitespace before the
# first; in each block (marker to next marker or end) exactly ONE terminator
# outside quotes and comments, with nothing but comments and whitespace after
# it; no psql meta-command (a line starting with a backslash outside quotes);
# no dollar quoting (the lexer does not model it, so it is refused); no psql
# variable interpolation (:name, :'name', :"name"; a :: cast is fine). The body
# handed to the contract is the block's original text up to that terminator.
# Any other shape prints why and is NEVER-RAN. After the contract passes, the
# file also runs verbatim in a FRESH psql session that carries none of the
# harness's variables (correction 3, finding 1), so a shape the lexer misjudged
# still fails the run.
extract() {
  python3 - "$MET" "$1" <<'PY'
import sys
path, name = sys.argv[1:3]
want = ["complete_contract_weekly", "complete_contract_refusal_reasons_by_week"]
lines = open(path).read().split("\n")
marks = [(i, l[len("-- query:"):].strip()) for i, l in enumerate(lines) if l.startswith("-- query:")]
names = [n for _, n in marks]
if sorted(names) != sorted(want) or len(set(names)) != len(names):
    print(f"the query markers are {names}, not exactly {want} once each"); sys.exit(1)

def scan(text):
    """Return (terminator offsets, offsets of code characters, problem) for text."""
    semis, code, i, n, state, line_start = [], [], 0, len(text), "code", True
    while i < n:
        c = text[i]
        if state == "code":
            if line_start and c == "\\":
                return semis, code, "a psql meta-command"
            if c == "-" and text.startswith("--", i):
                state = "line"; i += 2; continue
            if c == "/" and text.startswith("/*", i):
                state = "block"; i += 2; continue
            if c in "'\"":
                state = c; code.append(i); i += 1; line_start = False; continue
            if c == "$":
                return semis, code, "dollar quoting"
            if c == ":":
                # "::" is a cast. Every psql colon form is refused: ":name",
                # ":'name'", ":\"name\"" (correction 3, finding 1) and the
                # existence test ":{?name}" (correction 4, finding 1); psql
                # variable names may also start with a digit. The SQL editor
                # sends all of these to the server as written.
                if text.startswith("::", i):
                    code.append(i); i += 2; line_start = False; continue
                nxt = text[i + 1] if i + 1 < n else ""
                if nxt in "'\"{_" or nxt.isalnum():
                    return semis, code, "psql variable interpolation"
            if c == ";":
                semis.append(i)
            elif not c.isspace():
                code.append(i)
            if c == "\n":
                line_start = True
            elif not c.isspace():
                line_start = False
            i += 1
        elif state == "line":
            if c == "\n":
                state = "code"; line_start = True
            i += 1
        elif state == "block":
            if text.startswith("*/", i):
                state = "code"; i += 2
            else:
                i += 1
        else:  # inside a quote: state is the quote character; a doubled quote escapes it
            if c == state and text.startswith(state * 2, i):
                i += 2
            elif c == state:
                state = "code"; i += 1
            else:
                i += 1
    if state in ("'", '"', "block"):
        return semis, code, "an unterminated quote or comment"
    return semis, code, None

head = "\n".join(lines[:marks[0][0]])
semis, code, problem = scan(head)
if problem or semis or code:
    print(f"executable text before the first marker ({problem or 'code'})"); sys.exit(1)
body = None
for k, (at, n) in enumerate(marks):
    end = marks[k + 1][0] if k + 1 < len(marks) else len(lines)
    text = "\n".join(lines[at + 1:end])
    semis, code, problem = scan(text)
    if problem:
        print(f"{problem} in block {n}"); sys.exit(1)
    if len(semis) != 1 or any(c > semis[0] for c in code):
        print(f"block {n} does not hold exactly one statement ending in its only terminator ({len(semis)} terminators outside comments and quotes)"); sys.exit(1)
    if n == name:
        body = text[:semis[0]]
if body is None or not body.strip():
    print(f"no statement for {name}"); sys.exit(1)
print(body)
PY
}
WEEKLY=$(extract complete_contract_weekly) || never "could not extract query complete_contract_weekly from $(basename "$METRICS"): $WEEKLY"
REASONS=$(extract complete_contract_refusal_reasons_by_week) || never "could not extract query complete_contract_refusal_reasons_by_week from $(basename "$METRICS"): $REASONS"
CONTRACT="$WORK/contract.sql"
python3 - "$CON" "$CONTRACT" "$WEEKLY" "$REASONS" <<'PY' || never "could not build the contract from the queries"
import sys
src, dst, weekly, reasons = sys.argv[1:5]
s = open(src).read()
for marker, body in (("-- @@WEEKLY_QUERY@@", weekly), ("-- @@REASONS_QUERY@@", reasons)):
    if s.count(marker) != 1: sys.exit(1)
    s = s.replace(marker, body)
open(dst, "w").write(s)
PY
# Control cases: the file changes AFTER extraction, as if the lexer had misread
# it; only the fresh-session verbatim run can see the planted statement.
[ "$INJECT" = verbatim_file_error ] && printf '%s\n' "select 1/0;" >> "$MET"
[ "$INJECT" = verbatim_fresh_session_variable ] && printf '%s\n' "select 1 where :'interruption_prefixes' is not null;" >> "$MET"
# The fresh psql -f session sets ON_ERROR_STOP, so this line passes there; only
# the raw-SQL step (server parsing) refuses it.
[ "$INJECT" = raw_sql_variable_existence ] && printf '%s\n' "select 1 where :{?ON_ERROR_STOP};" >> "$MET"

if ! "$INITDB_BIN" -D "$WORK/pg" -A trust -U postgres --locale=en_US.UTF-8 >"$WORK/initdb.log" 2>&1; then
  if grep -q shmget "$WORK/initdb.log" 2>/dev/null; then
    never "initdb failed at shmget: SysV shared memory is exhausted or denied (check ipcs -m)"
  fi
  never "initdb failed: $(tail -1 "$WORK/initdb.log" 2>/dev/null)"
fi
pg_ctl -D "$WORK/pg" -o "-p $PORT -c listen_addresses=127.0.0.1 -k $WORK" -l "$WORK/pg.log" start -w >/dev/null \
  || never "pg start failed: $(tail -1 "$WORK/pg.log")"
PSQL=(psql -X -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -q)
"${PSQL[@]}" -d postgres -c "create database obtest" >/dev/null 2>&1 || never "create database failed"

# Supabase's roles and default privileges: every table postgres creates in
# public is granted to anon, authenticated and service_role unless a migration
# revokes it. agent_task_events is a stub with the columns the weekly query
# reads (the real table: 20260629042442_oe1_agent_task_board_schema.sql).
"${PSQL[@]}" -d obtest >/dev/null 2>"$WORK/stub.err" <<'SQL' || never "stub schema failed: $(head -1 "$WORK/stub.err")"
create role service_role nologin bypassrls;
create role anon nologin;
create role authenticated nologin;
create role authenticator login noinherit;
grant anon, authenticated, service_role to authenticator;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
create table public.agent_task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  created_at timestamptz not null default now(),
  event_type text not null
);
SQL

if ! PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d obtest -f "$MIG" >"$WORK/mig.out" 2>&1; then
  never "migration failed to apply: $(grep -m1 ERROR "$WORK/mig.out" | sed 's/^psql:[^ ]* //')"
fi
echo "migration applied on a stub with Supabase's default privileges"

"${PSQL[@]}" -d obtest -v interruption_prefixes="$INTERRUPTION_PREFIXES" -f "$CONTRACT" >"$WORK/contract.out" 2>&1
code=$?
grep -E '^psql:.*: NOTICE:  00000: (PASS|SKIP) ' "$WORK/contract.out" | sed -E 's/^psql:.*NOTICE:  00000: //'
first=$(grep -m1 -E '^psql:.*:[0-9]+: ERROR:  ' "$WORK/contract.out")
state=$(printf '%s\n' "$first" | sed -nE 's/^psql:.*:[0-9]+: ERROR:  ([0-9A-Z]{5}): .*$/\1/p')
msg=$(printf '%s\n' "$first" | sed -E 's/^psql:.*:[0-9]+: ERROR:  ([0-9A-Z]{5}: )?//' | cut -c1-300)
case "$code" in
  0)
    [ -n "$first" ] && never "psql exited 0 but its output carries an error: $msg"
    grep -Eq '^psql:.*: NOTICE:  00000: COMPLETE CONTRACT EVENTS SQL TEST PASSED$' "$WORK/contract.out" \
      || never "the SQL contract exited 0 without its PASSED line"
    # The metrics file exactly as shipped, in a fresh psql session on the
    # seeded rows the contract left behind: no -v interruption_prefixes, no
    # \set, nothing from the contract's session (correction 3, finding 1).
    psql -X -h 127.0.0.1 -p "$PORT" -U postgres -d obtest -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -q \
      -f "$MET" >"$WORK/verbatim.out" 2>&1
    vcode=$?
    vfirst=$(grep -m1 -E '^psql:.*:[0-9]+: ERROR:  ' "$WORK/verbatim.out")
    if [ "$vcode" -ne 0 ] || [ -n "$vfirst" ]; then
      never "the metrics file did not run on its own in a fresh psql session (psql exit $vcode: $(printf '%s' "${vfirst:-$(tail -1 "$WORK/verbatim.out")}" | sed -E 's/^psql:[^ ]* //' | cut -c1-200))"
    fi
    echo "metrics file ran verbatim in a fresh psql session"
    # And as raw SQL, the way the SQL editor sends it: one psql -c string goes
    # to the server parser with no psql variable handling at all (correction 4,
    # finding 1), on the same seeded rows.
    psql -X -h 127.0.0.1 -p "$PORT" -U postgres -d obtest -v VERBOSITY=verbose -q \
      -c "$(cat "$MET")" >"$WORK/raw.out" 2>&1
    rcode=$?
    rfirst=$(grep -m1 -E 'ERROR:  ' "$WORK/raw.out")
    if [ "$rcode" -ne 0 ] || [ -n "$rfirst" ]; then
      never "the metrics file did not run as raw SQL, as the SQL editor sends it (psql exit $rcode: $(printf '%s' "${rfirst:-$(tail -1 "$WORK/raw.out")}" | sed -E 's/^psql:[^ ]* //' | cut -c1-200))"
    fi
    echo "metrics file ran as raw SQL (server parsing only)"
    echo "COMPLETE CONTRACT EVENTS SQL TEST PASSED"
    exit 0;;
  3)
    [ -z "$state" ] && never "the SQL contract stopped on an error with no readable SQLSTATE: $(printf '%s' "${first:-$(tail -1 "$WORK/contract.out")}" | cut -c1-200)"
    if [ "$state" = TF001 ]; then
      case "$msg" in "FAIL "*) echo "$msg"; exit 1;; esac
      never "SQLSTATE TF001 without a FAIL message: $msg"
    fi
    for p in $INTERRUPTION_PREFIXES; do
      case "$state" in "$p"*) never "the SQL contract was interrupted (SQLSTATE $state: $msg); no check was judged";; esac
    done
    never "the SQL contract stopped on an SQL error that is not one of its assertions (SQLSTATE $state: $msg)";;
  *) never "the SQL contract did not complete (psql exit $code): $(tail -1 "$WORK/contract.out" | cut -c1-200)";;
esac
