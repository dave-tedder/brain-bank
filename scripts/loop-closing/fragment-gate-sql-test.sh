#!/bin/bash
# Loop-closing Task 5.1: prove 20261120_fragment_pending_proposals.sql, and the
# fragment rows the capture paths write, on a throwaway LOCAL PostgreSQL cluster
# (never production).
#
#   bash scripts/loop-closing/fragment-gate-sql-test.sh                   # exit 0 passed
#   bash scripts/loop-closing/fragment-gate-sql-test.sh --mutate <name>   # exit 1 expected
#   bash scripts/loop-closing/fragment-gate-sql-test.sh --all-mutations   # all must be CAUGHT
#   bash scripts/loop-closing/fragment-gate-sql-test.sh --verdict-selftest  # no database
#   bash scripts/loop-closing/fragment-gate-sql-test.sh --inject-selftest   # negative controls
#
# Three outcomes, never two (the rule and the verdict code are
# action-item-review-sql-test.sh's, with this contract's PASSED line):
#   0  passed: every check ran to completion and held.
#   1  FAILED: a check RAN TO COMPLETION and its assertion did not hold. Only this is
#      a caught mutation. Every exit 1 prints a line starting "FAIL ".
#   2  NEVER-RAN: the cluster, a migration or a mutant did not apply; a helper query
#      did not execute; a statement was cancelled, timed out or lost a resource; the
#      SQL contract stopped on an error that is not one of its own assertions (only
#      SQLSTATE TF001 with a "FAIL " message is); the integration bridge could not
#      run; a step stopped before its last check. Nothing was judged.
#
# What it proves, in order:
#   1. The migration applies over the prior Task 1.4 / 3.1 / 3.2 / 3.6 schema and
#      changes no existing function (every public function's md5(prosrc) is
#      compared before and after; only fragment_pending_proposals may appear).
#   2. fragment-gate-sql-test.sql (F, P, R, L, S, G checks): the gate's drop and
#      suspect payloads against the real CHECKs and generation trigger; what the
#      read lists (open items, current generation, proposed fragment rows only,
#      one per item, newest decision, oldest first, total, limit bounds); Task
#      3.6's keep and archive on a fragment suspect; volatility, security and
#      grants.
#   3. fragment-gate-integration.ts: the real shared extractAndStoreActionItems,
#      the digest renderer and the review helper against these real functions.
# --all-mutations runs each mutant under its own deadline (OBFG_MUTANT_DEADLINE,
# default 300 s) via deadline.py and classifies it exactly as
# action-item-review-sql-test.sh does. --inject-selftest runs the negative
# controls: each must end with its known exit (assert_fail 1, the others 2).
export LC_ALL=C
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/scripts/loop-closing"
M_MCP_LOG="$ROOT/supabase/migrations/0016_mcp_tool_invocations.sql"
M_DECISIONS="$ROOT/supabase/migrations/20261105_auto_resolve_decisions.sql"
M_CLOSE="$ROOT/supabase/migrations/20261106_action_items_close_reason.sql"
M_ARCHIVE="$ROOT/supabase/migrations/20261109a_action_items_archive_proposals.sql"
M_REVIEW="$ROOT/supabase/migrations/20261109b_review_proposal_rpc.sql"
M_FRAGMENT="$ROOT/supabase/migrations/20261120_fragment_pending_proposals.sql"
TEST_SQL="$HERE/fragment-gate-sql-test.sql"

MUTATIONS="no_generation_filter includes_deferred any_outcome any_proposal_layer no_distinct oldest_decision order_desc total_is_row_number limit_unbounded limit_default_50 grant_anon security_definer volatile_read no_search_path"
INJECTIONS="assert_fail raw_error sql_timeout helper_fail integration_cancel"
MUTANT_DEADLINE="${OBFG_MUTANT_DEADLINE:-300}"

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
      if grep -Eq '^psql:.*:[0-9]+: NOTICE:  00000: FRAGMENT GATE SQL TEST PASSED$' "$file"; then VERDICT="passed"; return 0; fi
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
  d=$(mktemp -d /tmp/obfg-verdict.XXXXXX)
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
0|contract|0|@P NOTICE:  00000: PASS T01 x\nLOCATION:  exec_stmt_raise, pl_exec.c:3911\n@P NOTICE:  00000: FRAGMENT GATE SQL TEST PASSED\nLOCATION:  exec_stmt_raise, pl_exec.c:3911
2|contract|0|@P NOTICE:  00000: PASS T01 x
2|contract|0|@P NOTICE:  00000: PASS T01 x\n@P ERROR:  TF001: FAIL T02 y: z\n@P NOTICE:  00000: FRAGMENT GATE SQL TEST PASSED
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
0|classify|1|migration applied over 3 existing rows\nPASS T01 x\nERROR TF001: FAIL T08 a keep on a deferred item is refused: recorded\nFAIL FRAGMENT GATE SQL TEST: FAIL T08 a keep on a deferred item is refused: recorded
0|classify|1|PASS C1 x\nFAIL C2: the review behind the archive was not refused (recorded|kept c0910001)
0|classify|1|PASS I helper list\nFAIL integration: MCP review: a keep is recorded
2|classify|1|ERROR 57014: canceling statement due to statement timeout\nFAIL FRAGMENT GATE SQL TEST: canceling statement due to statement timeout
2|classify|1|ERROR: canceling statement due to statement timeout\nFAIL FRAGMENT GATE SQL TEST: canceling statement due to statement timeout
2|classify|1|ERROR 23503: insert or update on table "action_items" violates foreign key constraint\nFAIL FRAGMENT GATE SQL TEST: insert or update on table
2|classify|1|ERROR TF001: not a fail message\nFAIL FRAGMENT GATE SQL TEST: x
2|classify|1|ERROR: FAIL T38 the old display shape, with no SQLSTATE
2|classify|1|FAIL C1: the first review did not record\nNEVER-RAN: a helper query did not execute
2|classify|1|NEVER-RAN: the script stopped before its last check
2|classify|1|something died
2|classify|1|
2|classify|1|PASS T01 x\n  FAIL indented is not a verdict line
1|classify|0|FRAGMENT GATE TEST COMPLETE (mutation x)
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
  for m in ${OBFG_MUTATIONS:-$MUTATIONS}; do
    n=$((n + 1))
    out=$(python3 "$HERE/deadline.py" "$MUTANT_DEADLINE" bash "$0" --mutate "$m" 2>&1); code=$?
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

if [ "${1:-}" = "--inject-selftest" ]; then
  bad=0; n=0
  for i in $INJECTIONS; do
    n=$((n + 1))
    out=$(OBFG_INJECT="$i" python3 "$HERE/deadline.py" "$MUTANT_DEADLINE" bash "$0" 2>&1); code=$?
    want=2; [ "$i" = assert_fail ] && want=1
    if [ "$code" = "$want" ]; then
      echo "PASS inject $i: exit $code ($(printf '%s\n' "$out" | grep -m1 -E '^(FAIL|NEVER-RAN)' | cut -c1-160))"
    else
      bad=$((bad + 1)); echo "FAIL inject $i: exit $code, expected $want ($(printf '%s\n' "$out" | tail -1 | cut -c1-160))"
    fi
  done
  echo "INJECT SELFTEST: $n injections, $((n - bad)) gave their expected exit, $bad did not"
  [ "$bad" = 0 ] && exit 0
  exit 1
fi

MUTATE="${2:-}"; [ "${1:-}" = "--mutate" ] || MUTATE=""
INJECT="${OBFG_INJECT:-}"
# A port nothing is listening on.
PORT=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  p=$((55000 + RANDOM % 900))
  if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then PORT=$p; break; fi
done
[ -n "$PORT" ] || { echo "NEVER-RAN: no free port found"; exit 2; }
# The /tmp/obrp. prefix is the one deadline.py's reaper recognises.
WORK="$(mktemp -d /tmp/obrp.XXXXXX)"
COMPLETED=0
never() { echo "NEVER-RAN: $*"; exit 2; }
fail() {
  if [ -s "$WORK/qfail" ]; then never "a helper query did not execute while checking: $* ($(head -1 "$WORK/qfail" | cut -c1-200))"; fi
  echo "FAIL $*"; exit 1
}
cleanup() {
  local rc=$?
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
pg_ctl -D "$WORK/pg" -o "-p $PORT -c listen_addresses=127.0.0.1 -k $WORK" -l "$WORK/pg.log" start -w >/dev/null || never "pg start failed: $(tail -1 "$WORK/pg.log")"
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

for f in "$M_MCP_LOG" "$M_DECISIONS" "$M_CLOSE" "$M_ARCHIVE" "$M_REVIEW"; do
  PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d obtest -f "$f" >"$WORK/prior.out" 2>&1 \
    || never "prior migration failed: $(basename "$f"): $(head -3 "$WORK/prior.out")"
done

# A helper query on a fresh connection. Any non-zero exit means it did not
# execute: recorded, and fail() then reports NEVER-RAN instead of a failure.
q() {
  local out code
  out=$("${PSQL[@]}" -d obtest -At -c "$1" 2>&1); code=$?
  if [ "$code" -ne 0 ]; then echo "psql exit $code: $(printf '%s' "$out" | head -1)" >> "$WORK/qfail"; fi
  printf '%s\n' "$out"
}

FN_SQL="select coalesce(string_agg(p.proname || ':' || md5(p.prosrc), ',' order by p.proname, md5(p.prosrc)), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'"
fn_before=$(q "$FN_SQL")
case "$fn_before" in *review_proposal:*) ;; *) never "could not read the public functions before the migration";; esac
case "$fn_before" in *fragment_pending_proposals:*) never "fragment_pending_proposals exists before its migration";; esac

SRC="$WORK/fragment.sql"; cp "$M_FRAGMENT" "$SRC"
mf() { # old, new: literal replace, exactly one occurrence
  python3 - "$SRC" "$1" "$2" <<'PY' || never "mutant did not change exactly one site: $(printf '%s' "$1" | head -1)"
import sys
p, a, b = sys.argv[1:4]
s = open(p).read()
if s.count(a) != 1: sys.exit(1)
open(p, 'w').write(s.replace(a, b))
PY
}
case "$MUTATE" in
  "") ;;
  # A row from before a reopen reads as pending (P02).
  no_generation_filter) mf "      and d.item_generation = a.reopen_generation
" "";;
  # A suspect on a deferred item is listed (P01).
  includes_deferred) mf "      and a.status = 'open'" "      and a.status in ('open', 'deferred')";;
  # A reviewed row is listed (P01, R01).
  any_outcome) mf "      and d.outcome = 'proposed'" "      and d.outcome in ('proposed', 'kept', 'accepted')";;
  # Another layer's proposal is listed (P01). The layer and reason filters are
  # redundant with each other under auto_resolve_decision_legal (pronoun_object
  # is legal only on layer fragment), so widening either one alone is an
  # equivalent mutant; this one removes both.
  any_proposal_layer) mf "    where d.layer = 'fragment'" "    where d.layer in ('fragment', 'archive')"
                      mf "      and d.reason = 'pronoun_object'
" "";;
  # Two rows for one item make two lines (P03).
  no_distinct) mf "    select distinct on (a.id) d.id as decision_id" "    select d.id as decision_id";;
  # The older decision wins the one line (P03).
  oldest_decision) mf "    order by a.id, d.created_at desc, d.id desc" "    order by a.id, d.created_at asc, d.id asc";;
  # Newest first (P01).
  order_desc) mf "  order by p.proposed_at, p.item_id" "  order by p.proposed_at desc, p.item_id";;
  # The total counts only up to the row (P01, L01).
  total_is_row_number) mf "count(*) over ()" "row_number() over (order by p.proposed_at, p.item_id)";;
  # No bounds on the limit (L01).
  limit_unbounded) mf "  limit least(greatest(coalesce(p_limit, 200), 1), 500)" "  limit coalesce(p_limit, 200)";;
  # A different default (L01).
  limit_default_50) mf "  limit least(greatest(coalesce(p_limit, 200), 1), 500)" "  limit least(greatest(coalesce(p_limit, 50), 1), 500)";;
  # Grants (G01).
  grant_anon) echo "grant execute on function public.fragment_pending_proposals(integer) to anon;" >> "$SRC";;
  # Shape (S01).
  security_definer) mf "language sql
stable
set search_path" "language sql
stable
security definer
set search_path";;
  volatile_read) mf "language sql
stable
set search_path" "language sql
volatile
set search_path";;
  no_search_path) mf "set search_path = pg_catalog, public
as \$\$" "as \$\$";;
  *) never "unknown mutation: $MUTATE";;
esac

if ! PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d obtest -f "$SRC" >"$WORK/mig.out" 2>&1; then
  never "migration failed to apply: $(sed 's/^psql:.*ERROR/ERROR/' "$WORK/mig.out" | head -3)"
fi
echo "migration applied"

# 1. No existing function changed; exactly one new one.
fn_after=$(q "$FN_SQL")
[ -n "$fn_after" ] || never "could not read the public functions after the migration"
stripped=$(printf '%s\n' "$fn_after" | tr ',' '\n' | grep -v '^fragment_pending_proposals:' | paste -sd, -)
[ "$stripped" = "$fn_before" ] || fail "the migration changed or added a function other than fragment_pending_proposals"
[ "$(printf '%s\n' "$fn_after" | tr ',' '\n' | grep -c '^fragment_pending_proposals:')" = 1 ] || fail "fragment_pending_proposals is not exactly one function after the migration"
echo "PASS the migration adds fragment_pending_proposals and changes none of the other $(printf '%s\n' "$fn_before" | tr ',' '\n' | wc -l | tr -d ' ') public functions"

CONTRACT="$TEST_SQL"
inject_sql() { # anchor, inserted text: into a copy of the contract, exactly one site
  CONTRACT="$WORK/contract.sql"; cp "$TEST_SQL" "$CONTRACT"
  python3 - "$CONTRACT" "$1" "$2" <<'PY' || never "injection anchor not found exactly once"
import sys
p, a, b = sys.argv[1:4]
s = open(p).read()
if s.count(a) != 1: sys.exit(1)
open(p, 'w').write(s.replace(a, a + b))
PY
}
POINT_ANCHOR="-- OBRP_INJECT_POINT (the runner's negative controls insert one statement here)
"
case "$INJECT" in
  "") ;;
  # The positive control: a check that runs to completion and does not hold.
  assert_fail) inject_sql "$POINT_ANCHOR" "select pg_temp.ok('INJECTED a completed check that does not hold', 1 = 2, 'one is not two');
";;
  # A behavioral SQL error no check was written for.
  raw_error) inject_sql "$POINT_ANCHOR" "select 1/0;
";;
  # A real statement_timeout.
  sql_timeout) inject_sql "$POINT_ANCHOR" "set statement_timeout = 10;
select pg_sleep(0.2);
";;
  # A helper query that raises while every check goes on to hold.
  helper_fail) q "select 1/0" >/dev/null;;
  integration_cancel) ;; # planted below, before the bridge runs
  *) never "unknown injection: $INJECT";;
esac

# 2. The contract. psql's exit 3 says only that a statement raised;
# contract_verdict reads the SQLSTATE.
"${PSQL[@]}" -d obtest -v interruption_prefixes="$INTERRUPTION_PREFIXES" -f "$CONTRACT" >"$WORK/contract.out" 2>&1; code=$?
grep -E '^psql:.*:[0-9]+: (NOTICE|ERROR):  ' "$WORK/contract.out" \
  | sed -E 's/^psql:.*:[0-9]+: NOTICE:  00000: //; s/^psql:.*:[0-9]+: ERROR:  ([0-9A-Z]{5}): /ERROR \1: /; s/^psql:.*:[0-9]+: ERROR:  /ERROR (no SQLSTATE): /'
contract_verdict "$code" "$WORK/contract.out"
case $? in
  0) ;;
  1) echo "FAIL FRAGMENT GATE SQL TEST: $VERDICT"; exit 1;;
  *) never "$VERDICT";;
esac

# 3. The integration bridge, on the same database after the contract.
if [ "$INJECT" = integration_cancel ]; then
  "${PSQL[@]}" -d obtest >/dev/null 2>"$WORK/inject.err" <<'SQL' || never "injection integration_cancel did not apply: $(head -1 "$WORK/inject.err")"
create function public.obt_injected_cancel() returns trigger language plpgsql as $f$
begin
  raise exception using errcode = '57014', message = 'canceling statement due to statement timeout (injected)';
end $f$;
create trigger obt_injected_cancel before insert on public.action_items for each row
  when (new.description = 'nudge Jordan if nothing arrives') execute function public.obt_injected_cancel();
SQL
fi
IOUT=$(OBRP_PG_PORT="$PORT" OBRP_INTERRUPTION_PREFIXES="$INTERRUPTION_PREFIXES" python3 "$HERE/deadline.py" "${OBFG_INTEGRATION_DEADLINE:-240}" \
  deno run --no-lock --allow-env --allow-read --allow-run=psql "$HERE/fragment-gate-integration.ts" 2>&1); icode=$?
echo "$IOUT" | grep -E '^(PASS I|FAIL|NEVER-RAN|FRAGMENT GATE INTEGRATION|  )'
case "$icode" in
  0) echo "$IOUT" | grep -q "^FRAGMENT GATE INTEGRATION PASSED$" || never "the integration bridge exited 0 without its PASSED line";;
  1) echo "$IOUT" | grep -q '^FAIL integration:' || never "the integration bridge exited 1 without a completed assertion: $(echo "$IOUT" | tail -1 | cut -c1-160)"
     echo "FAIL integration (see above)"; exit 1;;
  *) never "the integration bridge did not complete (exit $icode): $(echo "$IOUT" | tail -1 | cut -c1-200)";;
esac

[ -s "$WORK/qfail" ] && never "every check held, but a helper query did not execute during the run ($(head -1 "$WORK/qfail" | cut -c1-200))"
[ -n "$INJECT" ] && never "the injection $INJECT did not stop the run, so it did not fire"
COMPLETED=1
echo "FRAGMENT GATE TEST COMPLETE${MUTATE:+ (mutation $MUTATE)}"
