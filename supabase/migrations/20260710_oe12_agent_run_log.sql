-- OE-12 Phase 4 readiness watch: durable, append-only per-run record for the
-- Open Engine lanes. One row per (agent_code, heartbeat).
--
-- ran_at is asserted by the lane (its own heartbeat claim); logged_at is
-- asserted by Postgres. A back-dated heartbeat shows up as skew between the
-- two instead of being silently trusted.

create table public.agent_run_log (
  id uuid primary key default gen_random_uuid(),
  agent_code text not null,
  runtime text,
  ran_at timestamptz not null,
  succeeded_at timestamptz,
  queue_result text,
  automation_state text,
  logged_at timestamptz not null default now(),
  backfilled boolean not null default false,
  backfill_note text
);

-- Idempotent backfill + double-fire absorption both key on this.
create unique index agent_run_log_agent_code_ran_at_key
  on public.agent_run_log (agent_code, ran_at);

create or replace function public.log_agent_run()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- ON CONFLICT DO NOTHING absorbs only the benign duplicate-heartbeat case
  -- via the (agent_code, ran_at) unique index. Every other failure raises,
  -- and the lane's ledger write fails with it: a loud failure is safe, a
  -- silent gap is not (the briefing skill's loud-failure principle).
  insert into public.agent_run_log
    (agent_code, runtime, ran_at, succeeded_at, queue_result, automation_state)
  values
    (new.agent_code, new.runtime, new.last_heartbeat, new.last_successful_run,
     new.last_queue_result, new.automation_state)
  on conflict (agent_code, ran_at) do nothing;
  return new;
end;
$$;

-- Two triggers, not one combined AFTER INSERT OR UPDATE: Postgres rejects OLD
-- references in an INSERT trigger's WHEN clause.
--
-- The UPDATE predicate is NOT cosmetic. A maintenance pass that refreshes
-- several agent_task_ledger.notes fields in one SQL statement can touch a
-- lane's row while last_heartbeat stays put (observed on the briefing and
-- claude-critic lanes). A bare AFTER UPDATE trigger would log phantom runs on
-- a day those lanes never ran, and the Phase 4 gate would count them. Every
-- real run writes a heartbeat; no maintenance edit does. Any refactor that
-- widens these predicates reintroduces that bug.
create trigger agent_task_ledger_log_run_insert
  after insert on public.agent_task_ledger
  for each row
  when (new.last_heartbeat is not null)
  execute function public.log_agent_run();

create trigger agent_task_ledger_log_run_update
  after update on public.agent_task_ledger
  for each row
  when (new.last_heartbeat is distinct from old.last_heartbeat)
  execute function public.log_agent_run();

-- Immutability by grant, not convention. RLS on, no policies (the
-- openrouter_calls precedent; service_role bypasses RLS, grants are the
-- control surface). UPDATE/DELETE for service_role are revoked in
-- 20260710_oe12_run_log_immutability.sql, applied LAST so a verification
-- smoke can clean up its scratch rows first.
alter table public.agent_run_log enable row level security;
revoke all on public.agent_run_log from anon, authenticated;
grant select, insert on public.agent_run_log to service_role;
