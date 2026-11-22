#!/bin/bash
# Loop-closing Task 2.3: prove 20261105_agent_tasks_not_before.sql on a throwaway
# LOCAL PostgreSQL cluster (never production, never a production trigger toggle).
# Needs initdb/pg_ctl/psql (Homebrew postgresql@16 here).
#
#   bash scripts/loop-closing/not-before-sql-test.sh                      # expect: NOT-BEFORE SQL TEST PASSED, exit 0
#   bash scripts/loop-closing/not-before-sql-test.sh --mutate trigger     # expect: FAIL (clear-on-exit trigger dropped)
#   bash scripts/loop-closing/not-before-sql-test.sh --mutate check       # expect: FAIL (invariant CHECK dropped)
#   bash scripts/loop-closing/not-before-sql-test.sh --mutate move_guard  # expect: FAIL (hold-only guard in move_agent_task_status disabled)
#   bash scripts/loop-closing/not-before-sql-test.sh --mutate admin_guard # expect: FAIL (held-only guard in admin_amend_agent_task disabled)
#   bash scripts/loop-closing/not-before-sql-test.sh --mutate admin_move  # expect: FAIL (set-plus-move refusal in admin_amend_agent_task disabled)
#   bash scripts/loop-closing/not-before-sql-test.sh --mutate grant       # expect: FAIL (sentinel_reader column grant removed)
#   bash scripts/loop-closing/not-before-sql-test.sh --mutate move_store  # expect: FAIL (move_agent_task_status no longer stores p_not_before)
#   bash scripts/loop-closing/not-before-sql-test.sh --mutate move_audit  # expect: FAIL (AGENT HUMAN HOLD payload loses not_before)
#   bash scripts/loop-closing/not-before-sql-test.sh --mutate admin_store # expect: FAIL (admin_amend_agent_task no longer stores p_set_not_before)
#   bash scripts/loop-closing/not-before-sql-test.sh --mutate admin_audit # expect: FAIL (AGENT STATUS payload loses set_not_before)
#
# The last four are missing-feature mutations (Codex PR 18 review, 2026-11-05):
# each removes the storage or the audit of the date while leaving every guard in
# place. They only fail if the positive assertions in the .sql are NULL-safe
# (IS DISTINCT FROM); a nullable <> comparison lets a missing date pass silently.
#
# What it proves, in order:
#   1. The PRIOR definitions of both RPCs, extracted from their own migrations,
#      apply cleanly and hash to the production definitions read on 2026-11-05
#      (so the carry-forward in the new migration starts from what is live).
#   2. The new migration applies on top, leaves exactly ONE overload of each
#      RPC, and the only differences between old and new definitions are the
#      marked Task 2.3 lines (the diff is printed for the review report).
#   3. The behavioural contract in not-before-sql-test.sql.
#
# The stub schema holds only what the two function bodies touch: agent_tasks
# with the production column list, agent_task_ledger, agent_task_events, and
# the Supabase roles. macOS: the postmaster needs a valid locale.
export LC_ALL=C
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261105_agent_tasks_not_before.sql"
PRIOR_MOVE="$ROOT/supabase/migrations/20260711_oe15_soft_affinity_claim_tokens.sql"
PRIOR_ADMIN="$ROOT/supabase/migrations/20260725_close_check_packet_field.sql"
# NOT_BEFORE_TEST_SQL overrides the contract file so one block can be run alone
# against a mutation (proving a late fixture can fire when an earlier one aborts).
TEST_SQL="${NOT_BEFORE_TEST_SQL:-$ROOT/scripts/loop-closing/not-before-sql-test.sql}"
# md5(pg_get_functiondef(oid)) on project <your-project-ref>, read 2026-11-05.
LIVE_MOVE_MD5="4bada70983985df8f1a6312264b42341"
LIVE_ADMIN_MD5="ec3a7eaba7c8df26686318197d860bab"
# Same definitions with blank lines and "--" comment lines removed, because the
# production admin_amend_agent_task body lost its SQL comments on the way in
# (apply_migration), so the raw md5 differs while the executable text is equal.
LIVE_MOVE_NORM_MD5="a34f2972456d4480bbfe03c24554091e"
LIVE_ADMIN_NORM_MD5="0f202c8a927cd3f1776c716b59382b75"
NORM_SQL="select md5(string_agg(l.line, E'\\n' order by l.ord)) from regexp_split_to_table(pg_get_functiondef('%s'::regproc), E'\\n') with ordinality as l(line, ord) where btrim(l.line) <> '' and btrim(l.line) not like '--%%'"
MUTATE="${2:-}"; [ "${1:-}" = "--mutate" ] || MUTATE=""
PORT=54331
WORK="$(mktemp -d /tmp/obnb.XXXXXX)"
trap 'pg_ctl -D "$WORK/pg" stop -m immediate >/dev/null 2>&1; rm -rf "$WORK"' EXIT

initdb -D "$WORK/pg" -A trust -U postgres >"$WORK/initdb.log" 2>&1 || { echo "initdb failed"; cat "$WORK/initdb.log"; exit 2; }
pg_ctl -D "$WORK/pg" -o "-p $PORT -c listen_addresses=127.0.0.1 -k $WORK" -l "$WORK/pg.log" start -w >/dev/null || { echo "pg start failed"; cat "$WORK/pg.log"; exit 2; }
PSQL=(psql -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)

"${PSQL[@]}" -d postgres -c "create database obtest" >/dev/null
"${PSQL[@]}" -d obtest <<'SQL' >/dev/null
create role service_role nologin; create role anon nologin; create role authenticated nologin;
create role sentinel_reader nologin noinherit nobypassrls;
create table public.agent_task_ledger (agent_code text primary key, last_heartbeat timestamptz, last_queue_result text);
create table public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  title text not null,
  label text not null default 'agent-instructions',
  agent_code text references public.agent_task_ledger(agent_code) on delete set null,
  parent_task_id uuid,
  project_slug text,
  status text not null default 'Agent Todo'
    check (status in ('Standing','Agent Todo','Agent Working','Agent Needs Input','Agent Review','Needs Operator','Agent Done')),
  priority text not null default 'medium',
  risk text not null default 'medium',
  requested_by text,
  intake_source text,
  desired_outcome text not null,
  context text,
  sources jsonb not null default '[]'::jsonb,
  do_steps text,
  acceptance_criteria text,
  output_handoff text,
  boundaries text,
  explicit_approval boolean not null default false,
  claimed_at timestamptz,
  claimed_by text references public.agent_task_ledger(agent_code) on delete set null,
  claim_expires_at timestamptz,
  completed_at timestamptz,
  blocked_reason text,
  review_reason text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_failed_at timestamptz,
  last_failure_reason text,
  source_thought_id uuid,
  linked_action_item_id uuid,
  archived_at timestamptz,
  operator_action text,
  operator_target text,
  critic_verdict text,
  critic_flags jsonb not null default '[]'::jsonb,
  critic_reviewed_by text,
  critic_reviewed_at timestamptz,
  preferred_agent text,
  claim_token uuid,
  requires_local boolean not null default false,
  check_spec jsonb,
  close_check jsonb
);
create table public.agent_task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.agent_tasks(id),
  event_type text not null,
  agent_code text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
grant select (id, status, created_at, archived_at) on public.agent_tasks to sentinel_reader;
SQL

# 1. Prior definitions, extracted by anchor (never by line number) from their own migrations.
sed -n '/^create or replace function public\.move_agent_task_status(/,/^\$\$;/p' "$PRIOR_MOVE" > "$WORK/prior_move.sql"
sed -n '/^create or replace function public\.admin_amend_agent_task(/,/^\$function\$;/p' "$PRIOR_ADMIN" > "$WORK/prior_admin.sql"
[ -s "$WORK/prior_move.sql" ] && [ -s "$WORK/prior_admin.sql" ] || { echo "prior definitions not extracted"; exit 2; }
"${PSQL[@]}" -d obtest -f "$WORK/prior_move.sql" >/dev/null || { echo "prior move_agent_task_status failed to apply"; exit 2; }
"${PSQL[@]}" -d obtest -f "$WORK/prior_admin.sql" >/dev/null || { echo "prior admin_amend_agent_task failed to apply"; exit 2; }
"${PSQL[@]}" -d obtest -At -c "select pg_get_functiondef('public.move_agent_task_status'::regproc)" > "$WORK/old_move.def"
"${PSQL[@]}" -d obtest -At -c "select pg_get_functiondef('public.admin_amend_agent_task'::regproc)" > "$WORK/old_admin.def"
OLD_MOVE_MD5=$("${PSQL[@]}" -d obtest -At -c "select md5(pg_get_functiondef('public.move_agent_task_status'::regproc))")
OLD_ADMIN_MD5=$("${PSQL[@]}" -d obtest -At -c "select md5(pg_get_functiondef('public.admin_amend_agent_task'::regproc))")
OLD_MOVE_NORM=$("${PSQL[@]}" -d obtest -At -c "$(printf "$NORM_SQL" public.move_agent_task_status)")
OLD_ADMIN_NORM=$("${PSQL[@]}" -d obtest -At -c "$(printf "$NORM_SQL" public.admin_amend_agent_task)")
report_prior() { # name raw live_raw norm live_norm
  if [ "$2" = "$3" ]; then echo "PRIOR $1: repo definition = production byte for byte (md5 $2)"
  elif [ "$4" = "$5" ]; then echo "PRIOR $1: repo definition = production in every non-comment line (normalized md5 $4); raw md5 differs ($2 vs $3) by SQL comments only"
  else echo "PRIOR $1: repo definition DIFFERS from production in executable text (normalized $4 vs $5). The carry-forward base is not what is live; investigate before rollout"; exit 1; fi
}
report_prior move_agent_task_status "$OLD_MOVE_MD5" "$LIVE_MOVE_MD5" "$OLD_MOVE_NORM" "$LIVE_MOVE_NORM_MD5"
report_prior admin_amend_agent_task "$OLD_ADMIN_MD5" "$LIVE_ADMIN_MD5" "$OLD_ADMIN_NORM" "$LIVE_ADMIN_NORM_MD5"

# 2. The new migration on top of the prior state.
PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d obtest -f "$MIGRATION" >/dev/null || { echo "migration failed to apply"; exit 2; }
N_MOVE=$("${PSQL[@]}" -d obtest -At -c "select count(*) from pg_proc where proname='move_agent_task_status'")
N_ADMIN=$("${PSQL[@]}" -d obtest -At -c "select count(*) from pg_proc where proname='admin_amend_agent_task'")
[ "$N_MOVE" = "1" ] && [ "$N_ADMIN" = "1" ] || { echo "overload leak: move=$N_MOVE admin=$N_ADMIN (expected 1 and 1)"; exit 1; }
"${PSQL[@]}" -d obtest -At -c "select pg_get_functiondef('public.move_agent_task_status'::regproc)" > "$WORK/new_move.def"
"${PSQL[@]}" -d obtest -At -c "select pg_get_functiondef('public.admin_amend_agent_task'::regproc)" > "$WORK/new_admin.def"
if [ -n "${SHOW_DIFF:-}" ]; then
  echo "=== move_agent_task_status: prior -> new ==="; diff -u "$WORK/old_move.def" "$WORK/new_move.def"
  echo "=== admin_amend_agent_task: prior -> new ==="; diff -u "$WORK/old_admin.def" "$WORK/new_admin.def"
fi
echo "definitions after migration: move_agent_task_status $(grep -c '' "$WORK/new_move.def") lines ($(diff "$WORK/old_move.def" "$WORK/new_move.def" | grep -c '^>') added), admin_amend_agent_task $(grep -c '' "$WORK/new_admin.def") lines ($(diff "$WORK/old_admin.def" "$WORK/new_admin.def" | grep -c '^>') added)"

# 3. Mutations: each must make the contract test FAIL.
case "$MUTATE" in
  "") ;;
  trigger)
    "${PSQL[@]}" -d obtest -c "drop trigger agent_tasks_clear_not_before on public.agent_tasks" >/dev/null
    echo "MUTATION trigger applied: agent_tasks_clear_not_before dropped";;
  check)
    "${PSQL[@]}" -d obtest -c "alter table public.agent_tasks drop constraint agent_tasks_not_before_only_when_held" >/dev/null
    echo "MUTATION check applied: agent_tasks_not_before_only_when_held dropped";;
  move_guard)
    sed -n '/^create or replace function public\.move_agent_task_status(/,/^\$\$;/p' "$MIGRATION" \
      | sed "s/if p_not_before is not null and p_status <> 'Agent Needs Input' then/if false then/" > "$WORK/mutant.sql"
    grep -q "if false then" "$WORK/mutant.sql" || { echo "mutant did not change the guard"; exit 2; }
    "${PSQL[@]}" -d obtest -f "$WORK/mutant.sql" >/dev/null || { echo "mutant failed to apply"; exit 2; }
    echo "MUTATION move_guard applied: hold-only guard disabled in move_agent_task_status";;
  admin_guard)
    sed -n '/^create or replace function public\.admin_amend_agent_task(/,/^\$function\$;/p' "$MIGRATION" \
      | sed "s/if p_set_not_before is not null and v_current.status <> 'Agent Needs Input' then/if false then/" > "$WORK/mutant.sql"
    grep -q "if false then" "$WORK/mutant.sql" || { echo "mutant did not change the guard"; exit 2; }
    "${PSQL[@]}" -d obtest -f "$WORK/mutant.sql" >/dev/null || { echo "mutant failed to apply"; exit 2; }
    echo "MUTATION admin_guard applied: held-only guard disabled in admin_amend_agent_task";;
  admin_move)
    sed -n '/^create or replace function public\.admin_amend_agent_task(/,/^\$function\$;/p' "$MIGRATION" \
      | sed "s/if p_set_not_before is not null and (coalesce(p_move_to_needs_operator, false) or coalesce(p_release_claim, false)) then/if false then/" > "$WORK/mutant.sql"
    grep -q "if false then" "$WORK/mutant.sql" || { echo "mutant did not change the guard"; exit 2; }
    "${PSQL[@]}" -d obtest -f "$WORK/mutant.sql" >/dev/null || { echo "mutant failed to apply"; exit 2; }
    echo "MUTATION admin_move applied: set-plus-move refusal disabled in admin_amend_agent_task";;
  move_store)
    sed -n '/^create or replace function public\.move_agent_task_status(/,/^\$\$;/p' "$MIGRATION" \
      | sed "s/when p_status = 'Agent Needs Input' then coalesce(p_not_before, not_before)/when p_status = 'Agent Needs Input' then not_before/" > "$WORK/mutant.sql"
    grep -qF "when p_status = 'Agent Needs Input' then not_before" "$WORK/mutant.sql" || { echo "mutant did not change the storage line"; exit 2; }
    "${PSQL[@]}" -d obtest -f "$WORK/mutant.sql" >/dev/null || { echo "mutant failed to apply"; exit 2; }
    echo "MUTATION move_store applied: move_agent_task_status keeps the old not_before instead of storing p_not_before";;
  move_audit)
    sed -n '/^create or replace function public\.move_agent_task_status(/,/^\$\$;/p' "$MIGRATION" \
      | sed "s/'not_before', p_not_before/'not_before', null/" > "$WORK/mutant.sql"
    grep -qF "'not_before', null" "$WORK/mutant.sql" || { echo "mutant did not change the audit line"; exit 2; }
    "${PSQL[@]}" -d obtest -f "$WORK/mutant.sql" >/dev/null || { echo "mutant failed to apply"; exit 2; }
    echo "MUTATION move_audit applied: AGENT HUMAN HOLD payload no longer carries not_before (jsonb_strip_nulls drops the key)";;
  admin_store)
    sed -n '/^create or replace function public\.admin_amend_agent_task(/,/^\$function\$;/p' "$MIGRATION" \
      | sed "s/not_before = coalesce(p_set_not_before, not_before),/not_before = not_before,/" > "$WORK/mutant.sql"
    grep -qF "not_before = not_before," "$WORK/mutant.sql" || { echo "mutant did not change the storage line"; exit 2; }
    "${PSQL[@]}" -d obtest -f "$WORK/mutant.sql" >/dev/null || { echo "mutant failed to apply"; exit 2; }
    echo "MUTATION admin_store applied: admin_amend_agent_task keeps the old not_before instead of storing p_set_not_before";;
  admin_audit)
    sed -n '/^create or replace function public\.admin_amend_agent_task(/,/^\$function\$;/p' "$MIGRATION" \
      | sed "s/'set_not_before', p_set_not_before,/'set_not_before', null,/" > "$WORK/mutant.sql"
    grep -qF "'set_not_before', null," "$WORK/mutant.sql" || { echo "mutant did not change the audit line"; exit 2; }
    "${PSQL[@]}" -d obtest -f "$WORK/mutant.sql" >/dev/null || { echo "mutant failed to apply"; exit 2; }
    echo "MUTATION admin_audit applied: AGENT STATUS payload no longer carries set_not_before (jsonb_strip_nulls drops the key)";;
  grant)
    "${PSQL[@]}" -d obtest -c "revoke select (not_before) on public.agent_tasks from sentinel_reader" >/dev/null
    echo "MUTATION grant applied: sentinel_reader lost select on not_before";;
  *) echo "unknown mutation: $MUTATE"; exit 2;;
esac

OUT=$("${PSQL[@]}" -d obtest -f "$TEST_SQL" 2>&1)
echo "$OUT" | grep -E "NOTICE|PASSED|ERROR" | grep -v "does not exist, skipping" | sed 's/^psql:.*ERROR/ERROR/'
if echo "$OUT" | grep -q "NOT-BEFORE SQL TEST PASSED"; then exit 0; fi
echo "NOT-BEFORE SQL TEST FAILED"
exit 1
