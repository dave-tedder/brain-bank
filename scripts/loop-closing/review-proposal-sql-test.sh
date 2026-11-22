#!/bin/bash
# Loop-closing Task 3.6 (with Task 3.2's schema part): prove
# 20261109a_action_items_archive_proposals.sql and 20261109b_review_proposal_rpc.sql
# on a throwaway LOCAL PostgreSQL cluster (never production).
#
#   bash scripts/loop-closing/review-proposal-sql-test.sh                  # exit 0 passed
#   bash scripts/loop-closing/review-proposal-sql-test.sh --mutate <name>  # exit 1 expected
#   bash scripts/loop-closing/review-proposal-sql-test.sh --all-mutations  # all must be CAUGHT
#
# Three outcomes, never two (PR 23 review F3):
#   0  passed: every check ran to completion and held.
#   1  FAILED: a check RAN TO COMPLETION and its assertion did not hold. Only this is
#      a caught mutation. Every exit 1 prints a line starting "FAIL" or "ERROR".
#   2  NEVER-RAN: the cluster, a migration or a mutant did not apply; a connection
#      never finished its statements; a helper query could not connect; a step
#      stopped before its last check. Nothing was judged, so nothing was caught.
# --all-mutations runs each mutant under its own deadline (OBRP_MUTANT_DEADLINE,
# default 300 s) via deadline.py; a deadline (124), any exit other than 0/1, and an
# exit 1 with no completed FAIL/ERROR line are all NEVER-RAN, and the sweep exits
# 2 if any mutant never ran, 1 if any survived, 0 only when every one was CAUGHT.
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
# OBRP_TEST_SQL lets a negative control run an OLDER contract against a mutant.
TEST_SQL="${OBRP_TEST_SQL:-$HERE/review-proposal-sql-test.sql}"

MUTATIONS="latest_by_time no_generation_filter keep_no_item_columns archive_reason_always_expired decision_ref_on_keep transition_unchecked recheck_no_evidence survivor_unchecked mcp_actor_unchecked slack_actor_unchecked closed_any_verb_recorded no_locks no_earlier_review_branch resolution_set_without_latest seq_per_generation reopen_keeps_archive_columns reopen_event_drops_archive deferred_done_allowed rpc_grant_anon ambiguous_takes_first restore_hint_for_open blank_ref_as_absent empty_done_ref_unchecked refusal_writes_note refusal_rewrites_event"
MUTANT_DEADLINE="${OBRP_MUTANT_DEADLINE:-300}"

# classify <mutation> <exit code> <output>: prints one line; returns 0 CAUGHT,
# 1 SURVIVED, 2 NEVER-RAN.
classify() {
  local m="$1" code="$2" out="$3" line
  case "$code" in
    1)
      line=$(printf '%s\n' "$out" | grep -E '^(FAIL|ERROR)' | head -1 | cut -c1-160)
      if [ -n "$line" ]; then echo "CAUGHT    $m: $line"; return 0; fi
      echo "NEVER-RAN $m: exit 1 with no completed FAIL/ERROR line: $(printf '%s\n' "$out" | tail -1 | cut -c1-140)"; return 2;;
    0) echo "SURVIVED  $m"; return 1;;
    124) echo "NEVER-RAN $m: deadline of ${MUTANT_DEADLINE}s exceeded, the run did not complete"; return 2;;
    *) echo "NEVER-RAN $m (exit $code): $(printf '%s\n' "$out" | tail -1 | cut -c1-140)"; return 2;;
  esac
}

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
PORT=$((55000 + RANDOM % 900))
WORK="$(mktemp -d /tmp/obrp.XXXXXX)"
[ -n "${OBRP_STATE_FILE:-}" ] && printf '%s\n' "$WORK" > "$OBRP_STATE_FILE"
PIDS=""
COMPLETED=0
never() { echo "NEVER-RAN: $*"; exit 2; }
# A behavioral failure, unless a helper query could not even connect while the
# check was being made, in which case nothing was judged.
fail() {
  if [ -s "$WORK/qfail" ]; then never "a helper query could not connect while checking: $* ($(head -1 "$WORK/qfail" | cut -c1-160))"; fi
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
PSQL=(psql -X -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)
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
python3 - "$M_CLOSE" "$M_ARCHIVE" <<'PY' || exit 1
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

# 2. The single-connection contract. ONLY_CONCURRENCY=1 skips it (and the
# integration step), to prove a mutant is caught by the schedules on their own.
# psql -f with ON_ERROR_STOP: 3 = a statement raised (a check ran and failed, or the
# function under test raised); 2 = the connection went bad; 0 must end in PASSED.
if [ -z "${ONLY_CONCURRENCY:-}" ]; then
  OUT=$("${PSQL[@]}" -d obtest -f "$TEST_SQL" 2>&1); code=$?
  echo "$OUT" | grep -E "PASS|PASSED|ERROR" | sed 's/^psql:.*NOTICE:  //; s/^psql:.*ERROR:  /ERROR: /'
  case "$code" in
    0) echo "$OUT" | grep -q "REVIEW PROPOSAL SQL TEST PASSED" || never "the SQL contract exited 0 without its PASSED line";;
    3) echo "FAIL REVIEW PROPOSAL SQL TEST: $(echo "$OUT" | grep -m1 'ERROR' | sed 's/^psql:.*ERROR:  //' | cut -c1-200)"; exit 1;;
    *) never "the SQL contract did not complete (psql exit $code): $(echo "$OUT" | tail -1 | cut -c1-160)";;
  esac

  # 3. The public entry points against these real RPCs.
  if [ -z "${SKIP_INTEGRATION:-}" ]; then
    IOUT=$(OBRP_PG_PORT="$PORT" python3 "$HERE/deadline.py" "${OBRP_INTEGRATION_DEADLINE:-240}" \
      deno run --no-lock --config "$HERE/closeout-capture-probe.deno.json" \
      --allow-net --allow-env --allow-read --allow-run=psql "$HERE/review-proposal-integration.ts" 2>&1); icode=$?
    echo "$IOUT" | grep -E '^(PASS I |FAIL|NEVER-RAN|REVIEW PROPOSAL INTEGRATION|  )'
    case "$icode" in
      0) echo "$IOUT" | grep -q "REVIEW PROPOSAL INTEGRATION PASSED" || never "the integration harness exited 0 without its PASSED line";;
      1) echo "$IOUT" | grep -q '^FAIL integration:' || never "the integration harness exited 1 without a completed assertion: $(echo "$IOUT" | tail -1 | cut -c1-160)"
         exit 1;;
      *) never "the integration harness did not complete (exit $icode)";;
    esac
  fi
fi

# 4. Concurrency. Each connection reads commands from a FIFO, so the shell decides
# the interleaving. "Blocked" is read from pg_stat_activity, never assumed.
SEQ=0
open_conn() { # name
  mkfifo "$WORK/$1.in"
  psql -X -h 127.0.0.1 -p "$PORT" -U postgres -d obtest -v ON_ERROR_STOP=0 -q -At < "$WORK/$1.in" > "$WORK/$1.out" 2>&1 &
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
# A helper query on a fresh connection. psql -c: 1 = the SQL raised (a completed
# execution); 2 = could not connect, recorded so fail() reports NEVER-RAN instead.
q() {
  local out code
  out=$("${PSQL[@]}" -d obtest -At -c "$1" 2>&1); code=$?
  if [ "$code" -ne 0 ] && [ "$code" -ne 1 ]; then echo "psql exit $code: $out" >> "$WORK/qfail"; fi
  printf '%s\n' "$out"
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
clean A | grep -qx "recorded" || fail "C1: the first review did not record ($(clean A | tail -2))"
clean B | grep -q "^refused|c0900001 is open; last proposal kept .* UTC; nothing pending to archive$" || fail "C1: the second review was not refused ($(clean B | tail -2))"
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
clean A | grep -qx "recorded" || fail "C2: T1's done did not record ($(clean A | tail -2))"
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
clean A | grep -qx "recorded" || fail "C3: the archive review did not record ($(clean A | tail -3))"
clean B | grep -q "ERROR" && fail "C3: the producer insert raised ($(clean B | tail -2))"
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
COMPLETED=1
echo "REVIEW PROPOSAL TEST COMPLETE${MUTATE:+ (mutation $MUTATE)}"
