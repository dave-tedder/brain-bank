#!/bin/bash
# Loop-closing Task 3.4: prove 20261109_close_agent_task_superseded.sql on a
# throwaway LOCAL PostgreSQL cluster (never production).
#
#   bash scripts/loop-closing/supersede-sql-test.sh                  # expect PASSED, exit 0
#   bash scripts/loop-closing/supersede-sql-test.sh --mutate <name>  # expect FAILED, exit 1
#   bash scripts/loop-closing/supersede-sql-test.sh --all-mutations  # every mutation must fail
#   bash scripts/loop-closing/supersede-sql-test.sh --mutate-controller <name>  # expect FAILED, exit 1
#
# Three outcomes, never two: exit 0 passed, exit 1 failed, exit 2 never ran (the
# cluster did not start, the migration did not apply, a real function could not be
# extracted, or a mutant did not change the text it targets). --all-mutations treats
# exit 2 as a harness error.
#
# Fixtures are seeded BEFORE the migration, against the prior event CHECK, because
# that is the world production's rows live in. After supersede-sql-test.sql, the
# recovery harness (supersede-recovery-db-test.mjs) drives the real controller against
# this database through the migration's verb and the real admin reopen, including
# transactions whose start order differs from their commit order. --mutate-controller
# runs that harness against a mutated copy of the controller.
export LC_ALL=C
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261109_close_agent_task_superseded.sql"
TEST_SQL="$ROOT/scripts/loop-closing/supersede-sql-test.sql"

MUTATIONS="status_guard done_guard self_guard replacement_guard actor_guard idempotent_args idempotent_replay event_code actor_source claim_clear check_value check_prior grant_anon definer generation_required generation_cas generation_idempotent generation_payload closed_generation_required closed_generation_consistent closed_generation_not_set closed_generation_never_cleared closed_generation_no_trigger closed_generation_no_check history_well_formed"
CONTROLLER_MUTATIONS="identity_by_array_position closed_by_matching_timestamps ignore_closed_generation event_id_not_checked repair_by_latest_generation audit_latest_generation_only repair_calls_the_verb audit_discards_listed_ids repair_takes_no_claim overlap_ignored dead_owner_never_recovered capture_not_pinned capture_body_is_the_file_body cli_does_nothing start_time_env_not_pinned"

if [ "${1:-}" = "--all-mutations" ]; then
  rc=0
  for m in $MUTATIONS; do
    out=$(bash "$0" --mutate "$m" 2>&1); code=$?
    case "$code" in
      1) echo "CAUGHT   $m: $(echo "$out" | grep -E 'ERROR' | head -1 | cut -c1-130)";;
      0) echo "SURVIVED $m"; rc=1;;
      *) echo "NEVER-RAN $m: $(echo "$out" | tail -1)"; rc=1;;
    esac
  done
  for m in $CONTROLLER_MUTATIONS; do
    out=$(bash "$0" --mutate-controller "$m" 2>&1); code=$?
    case "$code" in
      1) echo "CAUGHT   controller:$m: $(echo "$out" | grep -E 'FAIL ' | head -1 | cut -c1-130)";;
      0) echo "SURVIVED controller:$m"; rc=1;;
      *) echo "NEVER-RAN controller:$m: $(echo "$out" | tail -1)"; rc=1;;
    esac
  done
  [ "$rc" = 0 ] && echo "ALL MUTATIONS CAUGHT ($(($(echo "$MUTATIONS" | wc -w) + $(echo "$CONTROLLER_MUTATIONS" | wc -w))))"
  exit "$rc"
fi

MUTATE="${2:-}"; [ "${1:-}" = "--mutate" ] || MUTATE=""
MUTATE_CONTROLLER="${2:-}"; [ "${1:-}" = "--mutate-controller" ] || MUTATE_CONTROLLER=""
PORT=$((54400 + RANDOM % 400))
WORK="$(mktemp -d /tmp/obss.XXXXXX)"
trap 'pg_ctl -D "$WORK/pg" stop -m immediate >/dev/null 2>&1; rm -rf "$WORK"' EXIT

initdb -D "$WORK/pg" -A trust -U postgres >"$WORK/initdb.log" 2>&1 || { echo "initdb failed"; exit 2; }
pg_ctl -D "$WORK/pg" -o "-p $PORT -c listen_addresses=127.0.0.1 -k $WORK" -l "$WORK/pg.log" start -w >/dev/null || { echo "pg start failed"; exit 2; }
PSQL=(psql -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -d postgres -c "create database obtest" >/dev/null

"${PSQL[@]}" -d obtest <<'SQL' >/dev/null || { echo "stub schema failed"; exit 2; }
create role service_role nologin; create role anon nologin; create role authenticated nologin;
create table public.agent_task_ledger (agent_code text primary key);
insert into public.agent_task_ledger values ('claude-code'), ('codex');
create table public.action_items (id uuid primary key, status text not null default 'open', resolved_at timestamptz);
insert into public.action_items values ('20000000-0000-4000-8000-000000000001', 'open');
create table public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null default 't',
  status text not null,
  completed_at timestamptz,
  claimed_at timestamptz,
  claimed_by text references public.agent_task_ledger(agent_code),
  claim_expires_at timestamptz,
  claim_token uuid,
  blocked_reason text,
  review_reason text,
  linked_action_item_id uuid references public.action_items(id),
  archived_at timestamptz,
  not_before timestamptz,
  updated_at timestamptz not null default now(),
  -- Only so the real status writers below can run against this stub.
  project_slug text,
  sources jsonb,
  operator_action text,
  operator_target text,
  requires_local boolean,
  close_check jsonb,
  agent_code text,
  risk text,
  explicit_approval boolean,
  attempt_count integer default 0,
  last_failed_at timestamptz,
  last_failure_reason text,
  critic_verdict text,
  critic_flags jsonb,
  critic_reviewed_by text,
  critic_reviewed_at timestamptz
);
create table public.agent_task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.agent_tasks(id),
  event_type text not null,
  agent_code text references public.agent_task_ledger(agent_code),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint agent_task_events_event_type_check check (event_type in ('AGENT CLAIMED','AGENT DONE','AGENT BLOCKED','AGENT UNBLOCKED','AGENT HUMAN HOLD','AGENT HUMAN ANSWERED','AGENT RESUMED','AGENT FAILED','AGENT APPLIED','AGENT NEEDS OPERATOR','OPERATOR DONE','AGENT CRITIC','AGENT SKILL SUBSCRIBED','AGENT SKILL INSTALLED','AGENT SKILL UPDATED','AGENT SKILL DECLINED','AGENT FOLLOW-UP','AGENT STATUS'))
);
insert into public.agent_tasks (id, status, claimed_by, claim_expires_at, claim_token, blocked_reason, linked_action_item_id, archived_at) values
 ('10000000-0000-4000-8000-000000000001', 'Needs Operator',    null,               null,  null,              null,        '20000000-0000-4000-8000-000000000001', null),
 ('10000000-0000-4000-8000-000000000002', 'Agent Needs Input', 'claude-code', now(), gen_random_uuid(), 'hold note', null, null),
 ('10000000-0000-4000-8000-000000000003', 'Agent Review',      'claude-code', now(), gen_random_uuid(), null,        null, null),
 ('10000000-0000-4000-8000-000000000004', 'Agent Todo',        null,               null,  null,              null,        null, null),
 ('10000000-0000-4000-8000-000000000005', 'Agent Done',        null,               null,  null,              null,        null, null),
 ('10000000-0000-4000-8000-000000000006', 'Needs Operator',    null,               null,  null,              null,        null, null),
 ('10000000-0000-4000-8000-000000000007', 'Needs Operator',    null,               null,  null,              null,        null, now()),
 ('10000000-0000-4000-8000-000000000009', 'Agent Todo',        null,               null,  null,              null,        null, null),
 ('10000000-0000-4000-8000-00000000000a', 'Needs Operator',    null,               null,  null,              null,        null, null),
 ('10000000-0000-4000-8000-00000000000b', 'Needs Operator',    null,               null,  null,              null,        null, null),
 ('10000000-0000-4000-8000-00000000000c', 'Needs Operator',    null,               null,  null,              null,        null, null),
 ('10000000-0000-4000-8000-00000000000d', 'Needs Operator',    null,               null,  null,              null,        null, null),
 ('10000000-0000-4000-8000-00000000000e', 'Needs Operator',    null,               null,  null,              null,        null, null),
 ('10000000-0000-4000-8000-00000000000f', 'Needs Operator',    null,               null,  null,              null,        null, null),
 ('10000000-0000-4000-8000-000000000010', 'Needs Operator',    null,               null,  null,              null,        null, null),
 ('10000000-0000-4000-8000-000000000011', 'Needs Operator',    null,               null,  null,              null,        null, null),
 ('10000000-0000-4000-8000-000000000012', 'Needs Operator',    null,               null,  null,              null,        null, null),
 ('10000000-0000-4000-8000-000000000013', 'Needs Operator',    null,               null,  null,              null,        null, null);
insert into public.agent_task_events (task_id, event_type) values ('10000000-0000-4000-8000-000000000005', 'AGENT NEEDS OPERATOR');
SQL

# The real clear-on-exit trigger and CHECK, extracted by anchor from their own
# migration, so a dated hold exercises what production runs rather than a copy.
NB="$ROOT/supabase/migrations/20261105_agent_tasks_not_before.sql"
{ sed -n '/^create or replace function public\.agent_tasks_clear_not_before/,/^\$\$;/p' "$NB"
  sed -n '/^create trigger agent_tasks_clear_not_before/,/;$/p' "$NB"
  echo "alter table public.agent_tasks add constraint agent_tasks_not_before_only_when_held check (not_before is null or status = 'Agent Needs Input');"
  echo "update public.agent_tasks set not_before = '2026-10-01T00:00:00Z' where id = '10000000-0000-4000-8000-000000000002';"
} > "$WORK/nb.sql"
grep -q "create trigger agent_tasks_clear_not_before" "$WORK/nb.sql" || { echo "not_before trigger not extracted"; exit 2; }
"${PSQL[@]}" -d obtest -f "$WORK/nb.sql" >/dev/null || { echo "not_before setup failed"; exit 2; }

# The real writers of every transition a supersede lifecycle crosses, extracted by
# anchor from the migrations that define them, so a reopen and an ordinary completion
# in these tests are the production code and not a direct UPDATE that mirrors it.
RENAME="$ROOT/supabase/migrations/20260710_oe_hardening_batch_3.sql"
{ sed -n '/^create or replace function public\.move_agent_task_status(/,/^\$\$;/p' "$NB"
  sed -n '/^create or replace function public\.admin_amend_agent_task(/,/^\$function\$;/p' "$NB"
  sed -n '/^create or replace function public\.complete_operator_action(/,/^\$\$;/p' "$RENAME"
} > "$WORK/writers.sql"
for fn in move_agent_task_status admin_amend_agent_task complete_operator_action; do
  [ "$(grep -c "^create or replace function public\.$fn(" "$WORK/writers.sql")" = "1" ] || { echo "real $fn not extracted"; exit 2; }
done
"${PSQL[@]}" -d obtest -f "$WORK/writers.sql" >/dev/null || { echo "real status writers failed to load"; exit 2; }

# Each mutation rewrites one line of the migration BEFORE it is applied (the
# migration, not a later patch, because the migration is the world that ships). The
# file must actually differ afterwards: the proof text alone could already be there.
SRC="$WORK/migration.sql"; cp "$MIGRATION" "$SRC"
mutate() { # sed-expression, grep -F proof the text changed
  cp "$SRC" "$WORK/before-mutation.sql"
  sed -i '' "$1" "$SRC"
  cmp -s "$SRC" "$WORK/before-mutation.sql" && { echo "mutant changed nothing: $1"; exit 2; }
  grep -qF "$2" "$SRC" || { echo "mutant did not change the target: $2"; exit 2; }
}
case "$MUTATE" in
  "") ;;
  status_guard) mutate "s/if v_current.status not in ('Needs Operator', 'Agent Needs Input', 'Agent Review') then/if false and v_current.status = 'mut' then/" "if false and v_current.status = 'mut' then";;
  done_guard) mutate "s/if v_current.status = 'Agent Done' then/if false and v_current.status = 'mut' then/" "if false and v_current.status = 'mut' then";;
  self_guard) mutate "s/if p_superseded_by is not null and p_superseded_by = p_task_id then/if false and p_superseded_by = p_task_id then/" "if false and p_superseded_by = p_task_id then";;
  replacement_guard) mutate "s/if p_superseded_by is not null and not exists (/if false and not exists (/" "if false and not exists (";;
  actor_guard) mutate "s/if v_actor <> 'operator' and not exists (/if false and not exists (/" "if false and not exists (";;
  idempotent_args) mutate "s/if v_current.superseded_reason = v_reason/if v_current.superseded_reason is not null/" "if v_current.superseded_reason is not null";;
  idempotent_replay) mutate "s/if v_current.superseded_reason = v_reason/if false and v_current.superseded_reason = v_reason/" "if false and v_current.superseded_reason = v_reason";;
  event_code) mutate "s/^    v_current.claimed_by,\$/    null,/" "    null,";;
  actor_source) mutate "s/'actor_source', 'mcp-shared-key',/'actor_source', null,/" "'actor_source', null,";;
  claim_clear) mutate "s/^    claimed_by = null,\$/    claimed_by = claimed_by,/" "claimed_by = claimed_by,";;
  check_value) mutate "s/^    'AGENT STATUS',\$/    'AGENT STATUS'/; /^    'TASK SUPERSEDED'\$/d" "'AGENT STATUS'";;
  check_prior) mutate "/^    'AGENT NEEDS OPERATOR',\$/d" "'AGENT APPLIED'";;
  grant_anon) mutate "s/^  from public, anon, authenticated;\$/  from public, authenticated;/" "from public, authenticated;"; echo "grant execute on function public.close_agent_task_superseded(uuid, text, uuid, text, integer) to anon;" >> "$SRC";;
  definer) mutate "s/^security definer\$/security invoker/" "security invoker";;
  generation_required) mutate "s/if v_generations > 0 and p_expected_generation is null then/if false and p_expected_generation is null then/" "if false and p_expected_generation is null then";;
  generation_cas) mutate "s/if p_expected_generation is not null and p_expected_generation <> v_generations + 1 then/if false and p_expected_generation <> v_generations + 1 then/" "if false and p_expected_generation <> v_generations + 1 then";;
  generation_idempotent) mutate "s/if p_expected_generation is not null and p_expected_generation <> v_generations then/if false and p_expected_generation <> v_generations then/" "if false and p_expected_generation <> v_generations then";;
  generation_payload) mutate "s/'generation', v_generations + 1,/'generation', 1,/" "'generation', 1,";;
  closed_generation_required) mutate "s/if v_current.superseded_closed_generation is null then/if false then/" "if false then";;
  closed_generation_consistent) mutate "s/if v_current.superseded_closed_generation <> v_generations then/if false then/" "if false then";;
  closed_generation_not_set) mutate "/^    superseded_closed_generation = v_generations + 1,\$/d" "superseded_actor = v_actor,";;
  # The reopen-clears-it defect itself: trigger and CHECK both gone, so only the
  # lifecycle tests can see it. A removed trigger alone is refused by the CHECK.
  closed_generation_never_cleared) mutate "s/^    new.superseded_closed_generation := null;\$/    null;/; /^    or (superseded_closed_generation >= 1\$/,/^      and superseded_at is not null)\$/d; s/^    superseded_closed_generation is null\$/    true/" "    null;";;
  closed_generation_no_trigger) mutate "s/^    new.superseded_closed_generation := null;\$/    null;/" "    null;";;
  closed_generation_no_check) mutate "/^    or (superseded_closed_generation >= 1\$/,/^      and superseded_at is not null)\$/d; s/^    superseded_closed_generation is null\$/    true/" "    true";;
  history_well_formed) mutate "s/if v_well_formed <> v_generations then/if false then/" "if false then";;
  *) echo "unknown mutation: $MUTATE"; exit 2;;
esac

if ! PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d obtest -f "$SRC" >"$WORK/mig.out" 2>&1; then
  # A mutant the prior rows refuse fails here, which is a real catch of that mutant.
  if [ -n "$MUTATE" ] && grep -q "violated by some row" "$WORK/mig.out"; then
    sed 's/^psql:.*ERROR/ERROR/' "$WORK/mig.out"; echo "SUPERSEDE SQL TEST FAILED"; exit 1
  fi
  echo "migration failed to apply"; cat "$WORK/mig.out"; exit 2
fi
[ "$("${PSQL[@]}" -d obtest -At -c "select count(*) from pg_proc where proname='close_agent_task_superseded'")" = "1" ] || { echo "overload count wrong"; exit 2; }

OUT=$("${PSQL[@]}" -d obtest -f "$TEST_SQL" 2>&1)
echo "$OUT" | grep -E "PASS|PASSED|ERROR" | sed 's/^psql:.*NOTICE:  //; s/^psql:.*ERROR/ERROR/'
if ! echo "$OUT" | grep -q "SUPERSEDE SQL TEST PASSED"; then
  echo "SUPERSEDE SQL TEST FAILED"
  exit 1
fi

# The real controller over this real database. A controller mutant runs from a copy,
# and a target that is not there exactly once is NEVER-RAN, not a catch.
CONTROLLER="$ROOT/scripts/open-engine/closeout-controller.mjs"
if [ -n "$MUTATE_CONTROLLER" ]; then
  cp "$CONTROLLER" "$WORK/controller-mutant.mjs"
  CONTROLLER="$WORK/controller-mutant.mjs"
  node "$ROOT/scripts/loop-closing/supersede-recovery-db-test.mjs" --mutate-file "$CONTROLLER" "$MUTATE_CONTROLLER" || exit 2
fi
SUPERSEDE_DB_PORT="$PORT" SUPERSEDE_CONTROLLER="$CONTROLLER" node "$ROOT/scripts/loop-closing/supersede-recovery-db-test.mjs"
code=$?
[ "$code" = 0 ] && echo "SUPERSEDE RECOVERY DB TEST PASSED"
[ "$code" = 1 ] && echo "SUPERSEDE RECOVERY DB TEST FAILED"
exit "$code"
