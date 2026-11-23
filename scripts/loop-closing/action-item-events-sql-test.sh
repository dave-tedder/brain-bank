#!/bin/bash
# Loop-closing Task 3.1: prove 20261106_action_items_close_reason.sql on a throwaway
# LOCAL PostgreSQL cluster (never production).
#
#   bash scripts/loop-closing/action-item-events-sql-test.sh                  # exit 0 passed
#   bash scripts/loop-closing/action-item-events-sql-test.sh --mutate <name>  # exit 1 expected
#   bash scripts/loop-closing/action-item-events-sql-test.sh --all-mutations  # all must fail
#   bash scripts/loop-closing/action-item-events-sql-test.sh --mutate-triage <name>  # exit 1 expected
#
# Three outcomes, never two: 0 passed, 1 failed, 2 never ran (cluster, migration, or
# a mutant that did not change its target). --all-mutations treats 2 as an error.
#
# What it proves, in order:
#   1. Seed rows exist BEFORE the migration, as production's do.
#   2. The two card verbs in the migration, with their "-- T3.1+" lines removed,
#      hash to the pre-migration definitions, recorded 2026-11-06.
#   3. The single-connection contract in action-item-events-sql-test.sql.
#   4. The concurrency schedules, on real second connections:
#      S1 a two-item rollback read from a second connection; S2 and S3 the stamp
#      lock in both directions; S4 pre-locked writers in opposite order finish with
#      no deadlock; S5 the same writers without the pre-lock really deadlock; S6 two
#      concurrent transitions keep their own actors; S7 and S8 lock order and mode;
#      S9 and S10 the bulk writer's set stays the set it locked when membership moves.
#   5. The real outcomes query from metrics.sql on reopened items (M1), the
#      arguments triage.mjs actually builds, run against the migrated functions (M2),
#      and the real triage.mjs --apply through a loopback adapter into this database
#      (M3, triage-cli-db-test.mjs). --mutate-triage runs M3 on a mutated copy of the tool.
export LC_ALL=C
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261106_action_items_close_reason.sql"
PRIOR_DECISIONS="$ROOT/supabase/migrations/20261105_auto_resolve_decisions.sql"
TEST_SQL="$ROOT/scripts/loop-closing/action-item-events-sql-test.sql"
LIVE_APPLY_MD5="fe0115e6f010e606cdae63a67d577d2f"
LIVE_COMPLETE_MD5="8544cec8bd084d42a413f258ff4f7eba"

MUTATIONS="close_stamp reopen_clear reopen_generation reopen_stamp defer_clear event_old_note event_old_evidence event_old_duplicate event_prev_reopened event_payload actor_fallback actor_set from_guard from_includes_target duplicate_required duplicate_exists duplicate_other_reason close_reason_required defer_required bulk_status_guard bulk_prelock_selects_nothing bulk_prelock_lock_removed bulk_order stamp_lock_weak stamp_lock_removed stamp_forced record_prelock record_order record_weak backfill_all backfill_fragment events_grant_update rpc_grant_anon card_reason card_actor apply_note bulk_set_unbounded duplicate_check_null duplicate_check_survivor_required events_no_cascade metrics_no_scope metrics_relabel_prior metrics_drop_capture metrics_capture_scope"

TRIAGE_MUTATIONS="archive_defaults_fragment archive_accepts_any_reason done_without_evidence done_from_free_text status_guard_dropped csv_not_prepared csv_keeps_old_header csv_prepared_after_writes claim_not_taken claim_refusal_ignored dead_claim_not_recovered temp_path_shared csv_quote_in_unquoted_accepted csv_text_after_quote_accepted csv_seven_under_current_accepted csv_writer_leaves_bare_cr start_time_env_not_pinned cascade_project_without_reason cascade_duplicate_without_survivor"

if [ "${1:-}" = "--all-mutations" ]; then
  rc=0; n=0
  for m in $MUTATIONS; do
    n=$((n + 1))
    out=$(bash "$0" --mutate "$m" 2>&1); code=$?
    case "$code" in
      1) echo "CAUGHT    $m: $(echo "$out" | grep -E 'FAIL|ERROR' | head -1 | cut -c1-120)";;
      0) echo "SURVIVED  $m"; rc=1;;
      *) echo "NEVER-RAN $m: $(echo "$out" | tail -1 | cut -c1-120)"; rc=1;;
    esac
  done
  for m in $TRIAGE_MUTATIONS; do
    n=$((n + 1))
    out=$(bash "$0" --mutate-triage "$m" 2>&1); code=$?
    case "$code" in
      1) echo "CAUGHT    triage:$m: $(echo "$out" | grep -E 'FAIL|ERROR' | head -1 | cut -c1-120)";;
      0) echo "SURVIVED  triage:$m"; rc=1;;
      *) echo "NEVER-RAN triage:$m: $(echo "$out" | tail -1 | cut -c1-120)"; rc=1;;
    esac
  done
  [ "$rc" = 0 ] && echo "ALL $n MUTATIONS CAUGHT"
  exit "$rc"
fi

MUTATE="${2:-}"; [ "${1:-}" = "--mutate" ] || MUTATE=""
MUTATE_TRIAGE="${2:-}"; [ "${1:-}" = "--mutate-triage" ] || MUTATE_TRIAGE=""
PORT=$((55000 + RANDOM % 900))
WORK="$(mktemp -d /tmp/obev.XXXXXX)"
PIDS=""
COMPLETED=0
# A run that dies partway must not read as a pass: the concurrency section once
# failed to open its connections on macOS's bash 3.2 and the script still exited 0
# with every single-connection check printed PASS. Only the last line of this file
# sets COMPLETED, so "never finished" is exit 2 whatever the last status was.
cleanup() {
  local rc=$?
  for p in $PIDS; do kill "$p" 2>/dev/null; done
  wait 2>/dev/null
  pg_ctl -D "$WORK/pg" stop -m immediate >/dev/null 2>&1
  rm -rf "$WORK"
  if [ "$COMPLETED" != 1 ] && [ "$rc" = 0 ]; then
    echo "NEVER COMPLETED: the script stopped before its last check"
    rc=2
  fi
  exit "$rc"
}
trap cleanup EXIT

initdb -D "$WORK/pg" -A trust -U postgres >"$WORK/initdb.log" 2>&1 || { echo "initdb failed"; exit 2; }
pg_ctl -D "$WORK/pg" -o "-p $PORT -c listen_addresses=127.0.0.1 -k $WORK -c deadlock_timeout=200ms" -l "$WORK/pg.log" start -w >/dev/null || { echo "pg start failed"; exit 2; }
PSQL=(psql -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -d postgres -c "create database obtest" >/dev/null

"${PSQL[@]}" -d obtest <<'SQL' >/dev/null || { echo "stub schema failed"; exit 2; }
create role service_role nologin bypassrls; create role anon nologin; create role authenticated nologin;
create schema auth;
create function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;
grant usage on schema auth to service_role, anon, authenticated;
create table public.thoughts (id uuid primary key);
insert into public.thoughts values ('e0000000-0000-4000-8000-000000000001'), ('e0000000-0000-4000-8000-000000000002');
create table public.business_events (id uuid primary key);
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

insert into public.action_items (id, description, status, resolved_by_thought_id, resolved_at, resolution_note) values
 ('a0000000-0000-4000-8000-000000000001', 'auto closed', 'resolved', 'e0000000-0000-4000-8000-000000000001', '2026-01-01T00:00:00Z', null),
 ('a0000000-0000-4000-8000-000000000002', 'sweep fragment', 'archived', null, '2026-11-03T00:00:00Z', 'Chief of Staff sweep 2026-11-03 (the operator''s direction): archived as a fragment, no owner'),
 ('a0000000-0000-4000-8000-000000000003', 'sweep done', 'resolved', null, '2026-11-03T00:00:00Z', 'Chief of Staff sweep 2026-11-03 (the operator''s direction): verified done in the tracker'),
 ('a0000000-0000-4000-8000-000000000004', 'old archive', 'archived', null, null, null),
 ('a0000000-0000-4000-8000-000000000005', 'sweep other', 'archived', null, null, 'Chief of Staff sweep 2026-11-03 (the operator''s direction): kept for review'),
 ('a0000000-0000-4000-8000-000000000006', 'still open', 'open', null, null, null),
 ('a0000000-0000-4000-8000-000000000007', 'operator link', 'open', null, null, null),
 ('a0000000-0000-4000-8000-000000000008', 'apply link', 'open', null, null, null),
 ('a0000000-0000-4000-8000-000000000009', 's1 row', 'open', null, null, null),
 ('a0000000-0000-4000-8000-00000000000a', 'x', 'open', null, null, null),
 ('a0000000-0000-4000-8000-00000000000b', 'y', 'open', null, null, null),
 ('a0000000-0000-4000-8000-00000000000c', 's2 row', 'archived', null, null, null),
 ('a0000000-0000-4000-8000-00000000000d', 's3 row', 'archived', null, null, null),
 ('a0000000-0000-4000-8000-00000000000e', 's6 one', 'open', null, null, null),
 ('a0000000-0000-4000-8000-00000000000f', 's6 two', 'open', null, null, null),
 ('a0000000-0000-4000-8000-000000000010', 'bare writer', 'open', null, null, null);
insert into public.agent_tasks (id, status, linked_action_item_id) values
 ('f0000000-0000-4000-8000-000000000001', 'Needs Operator', 'a0000000-0000-4000-8000-000000000007'),
 ('f0000000-0000-4000-8000-000000000002', 'Agent Review', 'a0000000-0000-4000-8000-000000000008'),
 ('f0000000-0000-4000-8000-000000000003', 'Needs Operator', 'a0000000-0000-4000-8000-000000000001');
SQL

PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d obtest -f "$PRIOR_DECISIONS" >/dev/null || { echo "prior decisions migration failed"; exit 2; }
"${PSQL[@]}" -d obtest <<'SQL' >/dev/null || { echo "decision seed failed"; exit 2; }
insert into public.auto_resolve_decisions (id, item_id, thought_id, candidate_description, layer, outcome, reason) values
 ('d0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000006', 'e0000000-0000-4000-8000-000000000001', 'seed', 'L2', 'dropped', 'not_claimed'),
 ('d0000000-0000-4000-8000-000000000002', null, 'e0000000-0000-4000-8000-000000000001', 'seed', 'L0', 'blocked', 'mechanical_prefix');
SQL

SRC="$WORK/migration.sql"; cp "$MIGRATION" "$SRC"

# 2. Carry-forward proof: strip the marked lines and compare to the pre-migration definitions.
extract_fn() { sed -n "/^create or replace function public\.$1(/,/^\\\$function\\\$;/p" "$SRC"; }
for pair in "apply_agent_task_review:$LIVE_APPLY_MD5" "complete_operator_action:$LIVE_COMPLETE_MD5"; do
  fn="${pair%%:*}"; live="${pair##*:}"
  extract_fn "$fn" | grep -v -- '-- T3\.1+$' > "$WORK/prior_$fn.sql"
  [ -s "$WORK/prior_$fn.sql" ] || { echo "$fn not extracted"; exit 2; }
  "${PSQL[@]}" -d obtest -f "$WORK/prior_$fn.sql" >/dev/null || { echo "prior $fn failed to apply"; exit 2; }
  got=$("${PSQL[@]}" -d obtest -At -c "select md5(pg_get_functiondef('public.$fn'::regproc))")
  if [ "$got" = "$live" ]; then
    echo "PASS carry-forward: $fn without its T3.1+ lines equals the pre-migration definition (md5 $got)"
  else
    echo "FAIL carry-forward: $fn without its T3.1+ lines differs from the pre-migration definition ($got vs $live)"; exit 1
  fi
done

METRICS_SQL="$WORK/metrics.sql"; cp "$ROOT/scripts/loop-closing/metrics.sql" "$METRICS_SQL"
mutate_file() { # file, old, new: literal replace
  python3 - "$1" "$2" "$3" <<'PY' || { echo "mutant did not change the target: $2"; exit 2; }
import sys
p,a,b=sys.argv[1:4]
s=open(p).read()
if a not in s: sys.exit(1)
open(p,'w').write(s.replace(a,b))
PY
}
mutate() { mutate_file "$SRC" "$1" "$2"; }
mutate_metrics() { mutate_file "$METRICS_SQL" "$1" "$2"; }
case "$MUTATE" in
  "") ;;
  close_stamp) mutate "new.closed_at := coalesce(new.closed_at, now());" "null;";;
  reopen_clear) mutate "    new.resolved_by_thought_id := null;
" "";;
  reopen_generation) mutate "new.reopen_generation := old.reopen_generation + 1;" "null;";;
  reopen_stamp) mutate "new.reopened_at := now();" "null;";;
  defer_clear) mutate "    new.defer_reason := null;
" "";;
  event_old_note) mutate "old.close_reason, old.resolution_note," "old.close_reason, new.resolution_note,";;
  event_old_evidence) mutate "       old.resolved_by_thought_id, coalesce(v_payload" "       new.resolved_by_thought_id, coalesce(v_payload";;
  event_old_duplicate) mutate "      'duplicate_of', old.duplicate_of,
" "";;
  event_prev_reopened) mutate "'previous_reopened_at', old.reopened_at," "'previous_reopened_at', new.reopened_at,";;
  event_payload) mutate "perform set_config('app.event_payload', coalesce(p_event_payload::text, ''), true);" "perform set_config('app.event_payload', '', true);";;
  actor_fallback) mutate "coalesce(nullif(current_setting('app.actor', true), ''), 'sql')" "coalesce(nullif(current_setting('app.actor', true), ''), 'operator')";;
  actor_set) mutate "  perform set_config('app.actor', v_actor, true);
  perform set_config('app.event_payload', coalesce" "  perform set_config('app.event_payload', coalesce";;
  from_guard) mutate "    and status = any(p_from_statuses);" "    ;";;
  from_includes_target) mutate "if p_to_status = any(p_from_statuses) then" "if false then";;
  duplicate_required) mutate "if p_duplicate_of is null then" "if false then";;
  duplicate_exists) mutate "if not exists (select 1 from public.action_items where id = p_duplicate_of) then" "if false then";;
  duplicate_other_reason) mutate "elsif p_duplicate_of is not null then" "elsif false then";;
  close_reason_required) mutate "if v_closing and nullif(trim(coalesce(p_close_reason, '')), '') is null then" "if false then";;
  defer_required) mutate "if p_to_status = 'deferred' and v_defer_reason is null then" "if false then";;
  bulk_status_guard) mutate "    where status = 'deferred' and defer_reason = v_reason
    order by id" "    where defer_reason = v_reason
    order by id"; mutate "    and status = 'deferred' and defer_reason = v_reason;" "    and defer_reason = v_reason;";;
  bulk_set_unbounded) mutate "  where id = any(v_ids)
    and status = 'deferred' and defer_reason = v_reason;" "  where status = 'deferred' and defer_reason = v_reason;";;
  duplicate_check_null) mutate "or (close_reason is not distinct from 'duplicate' and duplicate_of <> id)" "or (close_reason = 'duplicate' and duplicate_of <> id)";;
  duplicate_check_survivor_required) mutate "    duplicate_of is null
    or (close_reason is not distinct from 'duplicate' and duplicate_of <> id)" "    (duplicate_of is null and close_reason is distinct from 'duplicate')
    or (close_reason is not distinct from 'duplicate' and duplicate_of is not null and duplicate_of <> id)";;
  events_no_cascade) mutate "item_id uuid not null references public.action_items(id) on delete cascade," "item_id uuid not null references public.action_items(id) on delete no action,";;
  metrics_no_scope) mutate_metrics "when d.item_generation is not distinct from a.reopen_generation then 'current'
            else 'prior_generation' end as generation_scope" "else 'current' end as generation_scope";;
  metrics_relabel_prior) mutate_metrics "                 and d.item_generation is not distinct from a.reopen_generation
                 and a.status in ('resolved','archived') then 'closed_otherwise'" "                 and a.status in ('resolved','archived') then 'closed_otherwise'";;
  metrics_drop_capture) mutate_metrics "left join action_items a on a.id = d.item_id
group by 1, 2, 3, 4, 5" "join action_items a on a.id = d.item_id
group by 1, 2, 3, 4, 5";;
  metrics_capture_scope) mutate_metrics "case when d.item_id is null then 'capture'
            when d.item_generation" "case when d.item_generation";;
  # Selects no rows, so the update touches nothing and T9 fails. This does not show
  # that removing the lock is caught; bulk_prelock_lock_removed below does.
  bulk_prelock_selects_nothing) mutate "    where status = 'deferred' and defer_reason = v_reason
    order by id
    for no key update" "    where false";;
  # Keeps the membership and the order, drops only the lock. S8 must see it.
  bulk_prelock_lock_removed) mutate "    where status = 'deferred' and defer_reason = v_reason
    order by id
    for no key update" "    where status = 'deferred' and defer_reason = v_reason
    order by id";;
  bulk_order) mutate "    where status = 'deferred' and defer_reason = v_reason
    order by id
    for no key update" "    where status = 'deferred' and defer_reason = v_reason
    for no key update";;
  record_order) mutate "    order by a.id
    for no key update" "    for no key update";;
  record_weak) mutate "    order by a.id
    for no key update" "    order by a.id
    for share";;
  stamp_lock_weak) mutate "  where id = new.item_id
  for share;" "  where id = new.item_id
  for key share;";;
  stamp_lock_removed) mutate "  where id = new.item_id
  for share;" "  where id = new.item_id;";;
  stamp_forced) mutate "    new.item_generation := null;
    return new;" "    return new;";;
  record_prelock) mutate "    order by a.id
    for no key update" "    limit 0";;
  backfill_all) mutate "set close_reason = 'done'
where status in ('resolved', 'archived') and resolved_by_thought_id is not null;" "set close_reason = 'done'
where status in ('resolved', 'archived');";;
  backfill_fragment) mutate "archived as a fragment%'" "nothing matches this%'";;
  events_grant_update) mutate "grant select on table public.action_item_events to service_role;" "grant select, update, delete on table public.action_item_events to service_role;";;
  rpc_grant_anon) echo "grant execute on function public.transition_action_item(uuid, text[], text, text, text, text, uuid, uuid, uuid, text, jsonb) to anon;" >> "$SRC";;
  card_reason) mutate "      , close_reason = 'done', resolution_note = 'card ' || left(p_task_id::text, 8) -- T3.1+" "      , resolution_note = 'card ' || left(p_task_id::text, 8) -- T3.1+";;
  card_actor) mutate "    perform set_config('app.actor', v_completed_by, true); -- T3.1+" "    perform 1; -- T3.1+";;
  apply_note) mutate "      perform set_config('app.actor', coalesce(nullif(trim(coalesce(p_applied_by, '')), ''), 'apply_agent_task_review'), true); -- T3.1+" "      perform 1; -- T3.1+";;
  *) echo "unknown mutation: $MUTATE"; exit 2;;
esac

if ! PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d obtest -f "$SRC" >"$WORK/mig.out" 2>&1; then
  if [ -n "$MUTATE" ]; then sed 's/^psql:.*ERROR/ERROR/' "$WORK/mig.out" | head -3; fi
  echo "migration failed to apply"; sed 's/^psql:.*ERROR/ERROR/' "$WORK/mig.out" | head -5; exit 2
fi
echo "migration applied"

# 3. The single-connection contract.
OUT=$("${PSQL[@]}" -d obtest -f "$TEST_SQL" 2>&1)
echo "$OUT" | grep -E "PASS|PASSED|ERROR" | sed 's/^psql:.*NOTICE:  //; s/^psql:.*ERROR:  /ERROR: /'
echo "$OUT" | grep -q "ACTION ITEM EVENTS SQL TEST PASSED" || { echo "ACTION ITEM EVENTS SQL TEST FAILED"; exit 1; }

# M1: the real outcomes query, extracted from metrics.sql by its anchor, on an item
# that goes through generations 0, 1 and 2, in a week no other fixture uses.
OUTCOMES_SQL=$(sed -n '/^-- auto_resolve_outcomes_by_week/,/;$/p' "$METRICS_SQL" | grep -v '^--' | sed 's/;$//')
case "$OUTCOMES_SQL" in *"from auto_resolve_decisions"*) ;; *) echo "outcomes query not extracted"; exit 2;; esac
mq() { "${PSQL[@]}" -d obtest -At -c "$1"; }
M=a6000000-0000-4000-8000-000000000001; W1="'2030-01-08T12:00:00Z'"
outcome_count() { # scope outcome
  mq "with o as ($OUTCOMES_SQL) select coalesce(sum(decisions), 0) from o where week = '2030-01-07' and layer = 'archive' and generation_scope = '$1' and outcome = '$2'"
}
expect_outcomes() { # label, expected counts: current proposed/current closed_otherwise/prior proposed
  local got="$(outcome_count current proposed)/$(outcome_count current closed_otherwise)/$(outcome_count prior_generation proposed)"
  [ "$got" = "$2" ] || { echo "FAIL M1 $1: current proposed/current closed_otherwise/prior proposed is $got, expected $2"; exit 1; }
}
mq "insert into public.action_items (id, description, status) values ('$M', 'metrics item', 'open')" >/dev/null
mq "insert into public.auto_resolve_decisions (item_id, candidate_description, layer, outcome, reason, created_at) values ('$M', 'g0', 'archive', 'proposed', 'age_standard', $W1)" >/dev/null
expect_outcomes "a proposal on an open item is pending" "1/0/0"
mq "select public.transition_action_item('$M', '{open}', 'archived', 'operator', 'expired')" >/dev/null
expect_outcomes "the item closed by another path" "0/1/0"
mq "select public.transition_action_item('$M', '{archived}', 'open', 'operator')" >/dev/null
expect_outcomes "reopened: the old proposal is history, not pending" "0/0/1"
mq "insert into public.auto_resolve_decisions (item_id, candidate_description, layer, outcome, reason, created_at) values ('$M', 'g1', 'archive', 'proposed', 'age_standard', $W1)" >/dev/null
expect_outcomes "a new proposal in the new generation is the only pending one" "1/0/1"
mq "select public.transition_action_item('$M', '{open}', 'archived', 'operator', 'expired')" >/dev/null
expect_outcomes "a later close relabels only the current generation" "0/1/1"
mq "select public.transition_action_item('$M', '{archived}', 'open', 'operator')" >/dev/null
expect_outcomes "a second reopen leaves nothing current" "0/0/2"
mq "insert into public.auto_resolve_decisions (thought_id, candidate_description, layer, outcome, reason, created_at) values ('e0000000-0000-4000-8000-000000000001', 'item-less', 'L0', 'blocked', 'mechanical_prefix', $W1)" >/dev/null
[ "$(mq "with o as ($OUTCOMES_SQL) select coalesce(sum(decisions), 0) from o where week = '2030-01-07' and layer = 'L0' and generation_scope = 'capture' and outcome = 'blocked'")" = "1" ] || { echo "FAIL M1 an item-less capture decision was lost"; exit 1; }
echo "PASS M1 the outcomes query applies the generation rule and keeps item-less capture decisions"

# M2: the arguments triage.mjs builds, by the same names PostgREST would send, run
# against the migrated functions. A row that left 'open' since classification is the
# case the old PATCH overwrote.
TA=a7000000-0000-4000-8000-000000000001; TB=a7000000-0000-4000-8000-000000000002; TC=a7000000-0000-4000-8000-000000000003; TD=a7000000-0000-4000-8000-000000000004; TE=a7000000-0000-4000-8000-000000000005; TF=a7000000-0000-4000-8000-000000000006
mq "insert into public.action_items (id, description, status, defer_reason) values ('$TA','t','open',null),('$TB','t','open',null),('$TC','t','open',null),('$TD','survivor','open',null),('$TE','t','deferred','pause:triage'),('$TF','t','open',null)" >/dev/null
mq "select public.transition_action_item('$TF', '{open}', 'resolved', 'someone-else', 'wont_do', 'closed after the report')" >/dev/null
triage_sql() { # id status close-reason reason [survivor]
  node --input-type=module -e "
    const { triageTransitionArgs } = await import(process.argv[1]);
    const lit = (v) => Array.isArray(v) ? 'array[' + v.map((x) => \"'\" + x + \"'\").join(',') + ']::text[]'
      : typeof v === 'object' ? \"'\" + JSON.stringify(v).replace(/'/g, \"''\") + \"'::jsonb\" : \"'\" + String(v).replace(/'/g, \"''\") + \"'\";
    const args = triageTransitionArgs({ id: process.argv[2], closeReason: process.argv[4], reason: process.argv[5], duplicateOf: process.argv[6] }, process.argv[3]);
    console.log('select public.transition_action_item(' + Object.entries(args).map(([k, v]) => k + ' => ' + lit(v)).join(', ') + ')');
  " "$ROOT/integrations/action-item-triage/triage-lib.mjs" "$1" "$2" "$3" "$4" "${5:-}"
}
expect_one() { [ "$(mq "$(triage_sql "$2" "$3" "$4" "$5" "${6:-}")")" = "$1" ] || { echo "FAIL M2 $2 $3: expected $1 rows"; exit 1; }; }
expect_one 1 "$TA" resolved done 'external project complete: "Jane Doe - Website" (done)'
expect_one 1 "$TB" archived fragment "coaching advice, it's narration"
expect_one 1 "$TC" archived duplicate "duplicate-of $TD" "$TD"
expect_one 0 "$TE" archived fragment "coaching advice"
expect_one 0 "$TF" archived fragment "coaching advice"
[ "$(mq "select count(*) from public.action_item_events where item_id in ('$TA','$TB','$TC','$TE') and actor = 'sql'")" = "0" ] || { echo "FAIL M2 a triage write recorded actor sql"; exit 1; }
[ "$(mq "select close_reason || '|' || actor from public.action_item_events where item_id='$TA'")" = "done|action-item-triage" ] || { echo "FAIL M2 resolve event"; exit 1; }
[ "$(mq "select close_reason || '|' || actor from public.action_item_events where item_id='$TB'")" = "fragment|action-item-triage" ] || { echo "FAIL M2 archive event"; exit 1; }
[ "$(mq "select close_reason || '|' || actor || '|' || (payload->>'duplicate_of') from public.action_item_events where item_id='$TC'")" = "duplicate|action-item-triage|$TD" ] || { echo "FAIL M2 duplicate event"; exit 1; }
[ "$(mq "select resolved_at is not null and closed_at is not null and resolution_note like 'triage: external project complete%' from public.action_items where id='$TA'")" = "t" ] || { echo "FAIL M2 resolve row"; exit 1; }
[ "$(mq "select status || '|' || defer_reason from public.action_items where id='$TE'")" = "deferred|pause:triage" ] || { echo "FAIL M2 a row deferred since classification was overwritten"; exit 1; }
[ "$(mq "select status || '|' || close_reason || '|' || resolution_note from public.action_items where id='$TF'")" = "resolved|wont_do|closed after the report" ] || { echo "FAIL M2 a row closed since classification was overwritten"; exit 1; }
echo "PASS M2 triage's own arguments record actor and reason, and never overwrite a row that moved"

# M3: the real triage.mjs --apply, through a loopback HTTP adapter that runs the named
# RPC as service_role, into this database. Not PostgREST, so the wrapper's schema cache
# and grants stay a rollout check. A triage mutant runs from a copy of the tool.
TRIAGE_DIR="$ROOT/integrations/action-item-triage"
if [ -n "$MUTATE_TRIAGE" ]; then
  mkdir "$WORK/triage-copy"
  cp "$TRIAGE_DIR"/*.mjs "$WORK/triage-copy/"
  TRIAGE_DIR="$WORK/triage-copy"
  node "$ROOT/scripts/loop-closing/triage-cli-db-test.mjs" --mutate-file "$TRIAGE_DIR" "$MUTATE_TRIAGE" || exit 2
fi
TRIAGE_DB_PORT="$PORT" TRIAGE_TOOL_DIR="$TRIAGE_DIR" node "$ROOT/scripts/loop-closing/triage-cli-db-test.mjs"
m3=$?
[ "$m3" = 0 ] || exit "$m3"

# 4. Concurrency. Each connection reads commands from a FIFO, so the shell decides
# the interleaving. A "blocked" claim is read from pg_stat_activity, never assumed
# from a sleep, and a wait that never happens fails rather than passing.
SEQ=0
open_conn() { # name
  mkfifo "$WORK/$1.in"
  psql -h 127.0.0.1 -p "$PORT" -U postgres -d obtest -v ON_ERROR_STOP=0 -q -At < "$WORK/$1.in" > "$WORK/$1.out" 2>&1 &
  PIDS="$PIDS $!"
  case "$1" in A) exec 7>"$WORK/A.in";; B) exec 8>"$WORK/B.in";; C) exec 9>"$WORK/C.in";; esac
  send "$1" "set application_name = 'conn_$1';"
  sync_conn "$1"
}
send() { case "$1" in A) printf '%s\n' "$2" >&7;; B) printf '%s\n' "$2" >&8;; C) printf '%s\n' "$2" >&9;; esac; }
sync_conn() { # name [timeout seconds]: wait until the connection has run everything sent
  SEQ=$((SEQ + 1)); local f="$WORK/sync.$SEQ"
  send "$1" "\\! touch $f"
  local t=$(( ${2:-10} * 20 ))
  while [ ! -e "$f" ] && [ "$t" -gt 0 ]; do sleep 0.05; t=$((t - 1)); done
  [ -e "$f" ] || { echo "FAIL S: connection $1 did not finish in time"; exit 1; }
}
wait_blocked() { # name label: fail unless the connection is really waiting on a lock
  local t=100
  while [ "$t" -gt 0 ]; do
    [ "$("${PSQL[@]}" -d obtest -At -c "select count(*) from pg_stat_activity where application_name = 'conn_$1' and wait_event_type = 'Lock'")" = "1" ] && return 0
    sleep 0.05; t=$((t - 1))
  done
  echo "FAIL $2: connection $1 never blocked"; exit 1
}
not_blocked_yet() { # name label
  sleep 0.3
  [ "$("${PSQL[@]}" -d obtest -At -c "select count(*) from pg_stat_activity where application_name = 'conn_$1' and wait_event_type = 'Lock'")" = "0" ]
}
q() { "${PSQL[@]}" -d obtest -At -c "$1"; }
close_conn() { case "$1" in A) exec 7>&-;; B) exec 8>&-;; C) exec 9>&-;; esac; }
# Truncating an output file a psql still holds open leaves NUL bytes where its write
# offset was, so a whole-line match has to strip them first.
returned_value() { tr -d '\000' < "$WORK/A.out" | grep -qx "$1"; }
PROP="'archive','proposed','age_standard'"
ins() { echo "insert into public.auto_resolve_decisions (id, item_id, candidate_description, layer, outcome, reason) values ('$1','$2','s',$PROP);"; }

open_conn A; open_conn B

# S1: a refused duplicate rolls back, read from a SECOND connection.
send A "begin;"
send A "select public.transition_action_item('a0000000-0000-4000-8000-000000000009', '{open}', 'archived', 'operator', 'duplicate', null, null, null, 'ffffffff-0000-4000-8000-000000000000');"
send A "rollback;"
sync_conn A
grep -q "Duplicate survivor not found" "$WORK/A.out" || { echo "FAIL S1: the call was not refused"; exit 1; }
[ "$(q "select status from public.action_items where id='a0000000-0000-4000-8000-000000000009'")" = "open" ] || { echo "FAIL S1: row changed"; exit 1; }
[ "$(q "select count(*) from public.action_item_events where item_id='a0000000-0000-4000-8000-000000000009'")" = "0" ] || { echo "FAIL S1: event written"; exit 1; }
echo "PASS S1 a refused duplicate leaves the row open with no event, read from a second connection"

# S2: A inserts a decision and holds; B's reopen blocks until A commits; A's row is old.
# SKIP_S2=1 isolates S3, so a weakened stamp lock is proven caught by S3 on its own.
if [ -z "${SKIP_S2:-}" ]; then
  I=a0000000-0000-4000-8000-00000000000c
  send A "begin;"; send A "$(ins d4000000-0000-4000-8000-000000000001 $I)"; sync_conn A
  send B "select public.transition_action_item('$I', '{archived}', 'open', 'operator');"
  wait_blocked B "S2 reopen waits for the uncommitted decision insert"
  send A "commit;"; sync_conn A; sync_conn B
  [ "$(q "select item_generation from public.auto_resolve_decisions where id='d4000000-0000-4000-8000-000000000001'")" = "0" ] || { echo "FAIL S2: the earlier insert did not stay in the old generation"; exit 1; }
  [ "$(q "select reopen_generation from public.action_items where id='$I'")" = "1" ] || { echo "FAIL S2: reopen did not land"; exit 1; }
  echo "PASS S2 a reopen waits for an uncommitted insert, which keeps the OLD generation"
fi

# S3: B holds a plain, non-key update uncommitted (exactly what the trigger path
# holds). A's insert must wait and then read the NEW generation. A FOR KEY SHARE
# stamp does not conflict with that lock, so it reads the stale number unblocked.
I=a0000000-0000-4000-8000-00000000000d
send B "begin;"; send B "update public.action_items set status = 'open' where id = '$I';"; sync_conn B
send A "$(ins d4000000-0000-4000-8000-000000000002 $I)"
if not_blocked_yet A; then
  # The insert never waited: the stamp read a stale number. That is the defect.
  sync_conn A; send B "commit;"; sync_conn B
  echo "FAIL S3: the decision insert did not wait for the uncommitted reopen (generation $(q "select item_generation from public.auto_resolve_decisions where id='d4000000-0000-4000-8000-000000000002'"))"; exit 1
fi
send B "commit;"; sync_conn B; sync_conn A
[ "$(q "select item_generation from public.auto_resolve_decisions where id='d4000000-0000-4000-8000-000000000002'")" = "1" ] || { echo "FAIL S3: the insert did not read the NEW generation"; exit 1; }
echo "PASS S3 an insert during an uncommitted reopen waits, then reads the NEW generation"

# S4: a record_decisions batch and a bulk unpause over the same two items, started
# so each would take its FIRST statement's lock in opposite order without the
# pre-lock. Both pre-lock X then Y, so one waits and both finish with no 40P01.
X=a0000000-0000-4000-8000-00000000000a; Y=a0000000-0000-4000-8000-00000000000b
q "update public.action_items set status='deferred', defer_reason='pause:s4' where id in ('$X','$Y')" >/dev/null
q "update public.action_items set status='open' where id in ('$X','$Y')" >/dev/null
q "update public.action_items set status='deferred', defer_reason='pause:s4' where id in ('$X','$Y')" >/dev/null
: > "$WORK/A.out"; : > "$WORK/B.out"
send A "begin;"
send A "select public.record_decisions('[{\"item_id\":\"$Y\",\"candidate_description\":\"s4\",\"layer\":\"archive\",\"outcome\":\"proposed\",\"reason\":\"age_standard\"},{\"item_id\":\"$X\",\"candidate_description\":\"s4\",\"layer\":\"archive\",\"outcome\":\"proposed\",\"reason\":\"age_standard\"}]'::jsonb);"
sync_conn A
send B "select public.transition_action_items_by_defer_reason('pause:s4', 'operator');"
wait_blocked B "S4 the second writer waits on the first's pre-lock"
send A "commit;"; sync_conn A; sync_conn B
if grep -q "deadlock" "$WORK/A.out" "$WORK/B.out"; then echo "FAIL S4: pre-locked writers deadlocked"; exit 1; fi
[ "$(q "select count(*) from public.action_items where id in ('$X','$Y') and status='open'")" = "2" ] || { echo "FAIL S4: unpause did not finish"; exit 1; }
[ "$(q "select count(*) from public.auto_resolve_decisions where candidate_description='s4'")" = "2" ] || { echo "FAIL S4: batch did not land"; exit 1; }
echo "PASS S4 pre-locked writers in opposite statement order both finish with no deadlock"

# S5: the same two writers with the pre-lock taken away and the statements forced
# into reverse order really deadlock, so S4's clean run is evidence and not luck.
: > "$WORK/A.out"; : > "$WORK/B.out"
send A "set deadlock_timeout = '200ms';"
send B "set deadlock_timeout = '200ms';"
send A "begin;"; send A "$(ins d4000000-0000-4000-8000-000000000003 $Y)"; sync_conn A
send B "begin;"; send B "update public.action_items set status='archived', close_reason='expired' where id='$X';"; sync_conn B
send A "$(ins d4000000-0000-4000-8000-000000000004 $X)"
send B "update public.action_items set status='archived', close_reason='expired' where id='$Y';"
send A "rollback;"; send B "rollback;"
sync_conn A 15; sync_conn B 15
grep -q "deadlock detected" "$WORK/A.out" "$WORK/B.out" || { echo "FAIL S5: the unlocked reverse order did not deadlock, so S4 proves nothing"; exit 1; }
echo "PASS S5 the same schedule without the pre-lock really deadlocks (40P01)"

# S6: concurrent transitions keep their own actors; a third, bare writer records sql.
send A "begin;"; send A "select public.transition_action_item('a0000000-0000-4000-8000-00000000000e', '{open}', 'resolved', 'actor-a', 'done');"; sync_conn A
send B "begin;"; send B "select public.transition_action_item('a0000000-0000-4000-8000-00000000000f', '{open}', 'resolved', 'actor-b', 'done');"; sync_conn B
q "update public.action_items set status='deferred' where id='a0000000-0000-4000-8000-000000000010'" >/dev/null
send A "commit;"; send B "commit;"; sync_conn A; sync_conn B
[ "$(q "select actor from public.action_item_events where item_id='a0000000-0000-4000-8000-00000000000e'")" = "actor-a" ] || { echo "FAIL S6: connection A's actor"; exit 1; }
[ "$(q "select actor from public.action_item_events where item_id='a0000000-0000-4000-8000-00000000000f'")" = "actor-b" ] || { echo "FAIL S6: connection B's actor"; exit 1; }
[ "$(q "select actor from public.action_item_events where item_id='a0000000-0000-4000-8000-000000000010'")" = "sql" ] || { echo "FAIL S6: the bare writer did not record sql"; exit 1; }
echo "PASS S6 concurrent transitions keep their own actors; a bare update records sql"

# S7 and S8: the pre-lock itself, order and mode, for each multi-item writer. The
# higher id sits FIRST in the heap, so a scan without ORDER BY reaches it first.
# B holds the higher id. A correct writer locks the lower id first and then blocks
# on B, so while it waits the lower id is held FOR NO KEY UPDATE: a third connection
# asking FOR SHARE NOWAIT is refused. A writer that went high-first, took a weaker
# lock, or skipped the pre-lock leaves the lower id free and the probe succeeds.
LOW7=a1000000-0000-4000-8000-000000000001; HIGH7=a1000000-0000-4000-8000-000000000002
LOW8=a2000000-0000-4000-8000-000000000001; HIGH8=a2000000-0000-4000-8000-000000000002
q "insert into public.action_items (id, description, status) values ('$HIGH7','s7 high','open'), ('$LOW7','s7 low','open')" >/dev/null
q "insert into public.action_items (id, description, status, defer_reason) values ('$HIGH8','s8 high','deferred','pause:s8'), ('$LOW8','s8 low','deferred','pause:s8')" >/dev/null
probe_low() { # low-id label: must be refused 55P03 while A waits
  local out
  out=$(psql -h 127.0.0.1 -p "$PORT" -U postgres -d obtest -v ON_ERROR_STOP=1 -q -At -c "select 1 from public.action_items where id='$1' for share nowait" 2>&1)
  case "$out" in
    *"could not obtain lock"*) ;;
    *) echo "FAIL $2: the lower id was not held FOR NO KEY UPDATE while the writer waited ($out)"; exit 1;;
  esac
}
send B "begin;"; send B "select 1 from public.action_items where id='$HIGH7' for update;"; sync_conn B
send A "begin;"
send A "select public.record_decisions('[{\"item_id\":\"$HIGH7\",\"candidate_description\":\"s7\",\"layer\":\"archive\",\"outcome\":\"proposed\",\"reason\":\"age_standard\"},{\"item_id\":\"$LOW7\",\"candidate_description\":\"s7\",\"layer\":\"archive\",\"outcome\":\"proposed\",\"reason\":\"age_standard\"}]'::jsonb);"
wait_blocked A "S7 record_decisions waits on the held higher id"
probe_low "$LOW7" "S7 record_decisions"
send B "rollback;"; sync_conn B; send A "commit;"; sync_conn A
[ "$(q "select count(*) from public.auto_resolve_decisions where candidate_description='s7'")" = "2" ] || { echo "FAIL S7: the batch did not land"; exit 1; }
echo "PASS S7 record_decisions locks in id order, FOR NO KEY UPDATE, before any insert"

send B "begin;"; send B "select 1 from public.action_items where id='$HIGH8' for update;"; sync_conn B
send A "begin;"
send A "select public.transition_action_items_by_defer_reason('pause:s8', 'operator');"
wait_blocked A "S8 the unpause waits on the held higher id"
probe_low "$LOW8" "S8 unpause"
send B "rollback;"; sync_conn B; send A "commit;"; sync_conn A
[ "$(q "select count(*) from public.action_items where id in ('$LOW8','$HIGH8') and status='open'")" = "2" ] || { echo "FAIL S8: the unpause did not land"; exit 1; }
echo "PASS S8 the unpause locks in id order, FOR NO KEY UPDATE, before any update"

# S9: the bulk writer's set grows while it waits. A locks MID and waits on B's HIGH.
# LOW is tagged and committed. C, a correctly sorted record_decisions, locks LOW and
# waits on MID. When B lets go, a bulk UPDATE that re-ran the predicate would see LOW
# in its new snapshot and wait on C, while C waits on A: a deadlock between two
# writers that each pre-locked in order. Restricted to the ids it locked, A never
# touches LOW. The probe proves C really holds LOW, so the cycle is armed, and
# bulk_set_unbounded proves this schedule deadlocks without the fix.
LOW9=a4000000-0000-4000-8000-000000000001; MID9=a4000000-0000-4000-8000-000000000002; HIGH9=a4000000-0000-4000-8000-000000000003
q "insert into public.action_items (id, description, status, defer_reason) values ('$MID9','s9 mid','deferred','pause:s9'), ('$HIGH9','s9 high','deferred','pause:s9')" >/dev/null
open_conn C
: > "$WORK/A.out"; : > "$WORK/B.out"; : > "$WORK/C.out"
send B "begin;"; send B "select 1 from public.action_items where id='$HIGH9' for no key update;"; sync_conn B
send A "begin;"
send A "select public.transition_action_items_by_defer_reason('pause:s9', 'operator');"
wait_blocked A "S9 the bulk writer waits on HIGH"
q "insert into public.action_items (id, description, status, defer_reason) values ('$LOW9','s9 late low','deferred','pause:s9')" >/dev/null
send C "begin;"
send C "select public.record_decisions('[{\"item_id\":\"$LOW9\",\"candidate_description\":\"s9\",\"layer\":\"archive\",\"outcome\":\"proposed\",\"reason\":\"age_standard\"},{\"item_id\":\"$MID9\",\"candidate_description\":\"s9\",\"layer\":\"archive\",\"outcome\":\"proposed\",\"reason\":\"age_standard\"}]'::jsonb);"
wait_blocked C "S9 the sorted writer waits on MID"
probe_low "$LOW9" "S9 the sorted writer holds LOW"
send B "commit;"; sync_conn B
sync_conn A 15
send A "commit;"; sync_conn A
sync_conn C 15
send C "commit;"; sync_conn C
if grep -q "deadlock detected" "$WORK/A.out" "$WORK/C.out"; then
  echo "FAIL S9: the bulk writer deadlocked after a row joined its tag: $(grep -h 'deadlock detected' "$WORK/A.out" "$WORK/C.out" | head -1)"; exit 1
fi
[ "$(q "select count(*) from public.action_items where id in ('$MID9','$HIGH9') and status='open'")" = "2" ] || { echo "FAIL S9: the locked rows were not restored"; exit 1; }
[ "$(q "select status || '|' || defer_reason from public.action_items where id='$LOW9'")" = "deferred|pause:s9" ] || { echo "FAIL S9: the late row was restored by a writer that never locked it"; exit 1; }
returned_value 2 || { echo "FAIL S9: the return value is not the two restored rows: $(tr -d '\000' < "$WORK/A.out")"; exit 1; }
[ "$(q "select count(*) from public.action_item_events where item_id in ('$MID9','$HIGH9') and actor='operator'")" = "2" ] || { echo "FAIL S9: one event per restored row"; exit 1; }
[ "$(q "select count(*) from public.auto_resolve_decisions where candidate_description='s9'")" = "2" ] || { echo "FAIL S9: the sorted batch did not land"; exit 1; }
echo "PASS S9 a row tagged during the pre-lock is left alone, and the ordered writers finish with no deadlock"

# S10: the set shrinks while it waits. The row B re-tags and commits is re-checked by
# the lock wait, so the bulk writer neither restores it nor counts it.
LOW10=a4100000-0000-4000-8000-000000000001; HIGH10=a4100000-0000-4000-8000-000000000002
q "insert into public.action_items (id, description, status, defer_reason) values ('$HIGH10','s10 high','deferred','pause:s10'), ('$LOW10','s10 low','deferred','pause:s10')" >/dev/null
: > "$WORK/A.out"
send B "begin;"; send B "update public.action_items set defer_reason='pause:moved' where id='$HIGH10';"; sync_conn B
send A "select public.transition_action_items_by_defer_reason('pause:s10', 'operator');"
wait_blocked A "S10 the bulk writer waits on the row being re-tagged"
send B "commit;"; sync_conn B; sync_conn A
returned_value 1 || { echo "FAIL S10: expected one restored row: $(tr -d '\000' < "$WORK/A.out")"; exit 1; }
[ "$(q "select status || '|' || defer_reason from public.action_items where id='$HIGH10'")" = "deferred|pause:moved" ] || { echo "FAIL S10: the re-tagged row was restored"; exit 1; }
[ "$(q "select status from public.action_items where id='$LOW10'")" = "open" ] || { echo "FAIL S10: the row still carrying the tag was not restored"; exit 1; }
echo "PASS S10 a row re-tagged during the pre-lock leaves the set"

close_conn A; close_conn B; close_conn C
echo "ALL CONTRACT AND CONCURRENCY CHECKS PASSED"
COMPLETED=1
exit 0
