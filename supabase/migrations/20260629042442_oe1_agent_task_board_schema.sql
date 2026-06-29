-- OE-1: Open Engine task board schema foundation.
-- Additive only: creates the manual task-board tables, indexes, RLS posture,
-- and the SQL helper surface future dashboard/MCP callers should share.

create table if not exists public.agent_task_ledger (
  agent_code text primary key,
  operator text,
  runtime text,
  automation text,
  automation_state text not null default 'manual-required'
    constraint agent_task_ledger_automation_state_check
    check (automation_state in ('installed','manual-required','blocked','paused')),
  last_heartbeat timestamptz,
  last_queue_result text,
  last_successful_run timestamptz,
  local_context text,
  optional_skills jsonb not null default '[]'::jsonb,
  notes text,
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  title text not null,
  label text not null default 'agent-instructions',
  agent_code text,
  parent_task_id uuid references public.agent_tasks(id) on delete set null,
  project_slug text references public.projects(slug) on delete set null,
  status text not null default 'Agent Todo'
    constraint agent_tasks_status_check
    check (status in ('Standing','Agent Todo','Agent Working','Agent Needs Input','Agent Review','Agent Done')),
  priority text not null default 'medium'
    constraint agent_tasks_priority_check
    check (priority in ('low','medium','high')),
  risk text not null default 'medium'
    constraint agent_tasks_risk_check
    check (risk in ('low','medium','high')),
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
  claimed_by text,
  claim_expires_at timestamptz,
  completed_at timestamptz,
  blocked_reason text,
  review_reason text,
  attempt_count int not null default 0
    constraint agent_tasks_attempt_count_check
    check (attempt_count >= 0),
  last_failed_at timestamptz,
  last_failure_reason text,
  source_thought_id uuid references public.thoughts(id) on delete set null,
  linked_action_item_id uuid references public.action_items(id) on delete set null,
  constraint agent_tasks_agent_code_fkey
    foreign key (agent_code)
    references public.agent_task_ledger(agent_code)
    on delete set null,
  constraint agent_tasks_claimed_by_fkey
    foreign key (claimed_by)
    references public.agent_task_ledger(agent_code)
    on delete set null
);

create table if not exists public.agent_task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.agent_tasks(id) on delete cascade,
  created_at timestamptz not null default now(),
  event_type text not null
    constraint agent_task_events_event_type_check
    check (event_type in (
      'AGENT CLAIMED',
      'AGENT DONE',
      'AGENT BLOCKED',
      'AGENT UNBLOCKED',
      'AGENT HUMAN HOLD',
      'AGENT HUMAN ANSWERED',
      'AGENT RESUMED',
      'AGENT FAILED',
      'AGENT APPLIED',
      'AGENT SKILL SUBSCRIBED',
      'AGENT SKILL INSTALLED',
      'AGENT SKILL UPDATED',
      'AGENT SKILL DECLINED',
      'AGENT FOLLOW-UP',
      'AGENT STATUS'
    )),
  agent_code text references public.agent_task_ledger(agent_code) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  evidence_url text
);

insert into public.agent_task_ledger (agent_code, operator, runtime, automation, automation_state, notes)
values
  ('dave-codex', 'Dave Tedder', 'Codex', 'manual', 'manual-required', 'Seeded OE-1 manual runtime.'),
  ('dave-claude-code', 'Dave Tedder', 'Claude Code', 'manual', 'manual-required', 'Seeded OE-1 manual runtime.')
on conflict (agent_code) do nothing;

create index if not exists agent_tasks_status_created_at_idx
  on public.agent_tasks (status, created_at);

create index if not exists agent_tasks_agent_code_status_created_at_idx
  on public.agent_tasks (agent_code, status, created_at);

create index if not exists agent_tasks_parent_task_id_idx
  on public.agent_tasks (parent_task_id);

create index if not exists agent_tasks_project_slug_status_idx
  on public.agent_tasks (project_slug, status);

create index if not exists agent_tasks_risk_status_idx
  on public.agent_tasks (risk, status);

create index if not exists agent_tasks_working_claim_expires_at_idx
  on public.agent_tasks (claim_expires_at)
  where status = 'Agent Working';

create index if not exists agent_tasks_intake_source_created_at_idx
  on public.agent_tasks (intake_source, created_at);

create index if not exists agent_tasks_sources_gin_idx
  on public.agent_tasks using gin (sources);

create index if not exists agent_task_events_task_id_created_at_idx
  on public.agent_task_events (task_id, created_at desc);

create index if not exists agent_task_events_event_type_created_at_idx
  on public.agent_task_events (event_type, created_at desc);

create index if not exists agent_task_events_agent_code_created_at_idx
  on public.agent_task_events (agent_code, created_at desc);

create trigger agent_tasks_set_updated_at
  before update on public.agent_tasks
  for each row
  execute function public.update_updated_at();

create trigger agent_task_ledger_set_updated_at
  before update on public.agent_task_ledger
  for each row
  execute function public.update_updated_at();

alter table public.agent_task_ledger enable row level security;
alter table public.agent_tasks enable row level security;
alter table public.agent_task_events enable row level security;

create policy "Service role full access on agent_task_ledger"
  on public.agent_task_ledger
  for all
  to service_role
  using (true)
  with check (true);

create policy "Service role full access on agent_tasks"
  on public.agent_tasks
  for all
  to service_role
  using (true)
  with check (true);

create policy "Service role full access on agent_task_events"
  on public.agent_task_events
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.agent_task_ledger from anon, authenticated;
revoke all on public.agent_tasks from anon, authenticated;
revoke all on public.agent_task_events from anon, authenticated;

grant select, insert, update, delete on public.agent_task_ledger to service_role;
grant select, insert, update, delete on public.agent_tasks to service_role;
grant select, insert, update, delete on public.agent_task_events to service_role;

create or replace function public.claim_next_agent_task(p_agent_code text)
returns setof public.agent_tasks
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_task public.agent_tasks;
begin
  if not exists (
    select 1
    from public.agent_task_ledger
    where agent_code = p_agent_code
  ) then
    raise exception 'Unknown agent_code: %', p_agent_code
      using errcode = '22023';
  end if;

  select *
  into v_task
  from public.agent_tasks
  where status = 'Agent Todo'
    and (agent_code is null or agent_code = p_agent_code)
    and (risk <> 'high' or explicit_approval = true)
  order by
    case priority
      when 'high' then 1
      when 'medium' then 2
      else 3
    end,
    created_at
  for update skip locked
  limit 1;

  if not found then
    return;
  end if;

  update public.agent_tasks
  set
    status = 'Agent Working',
    claimed_by = p_agent_code,
    claimed_at = now(),
    claim_expires_at = now() + interval '60 minutes',
    blocked_reason = null,
    review_reason = null
  where id = v_task.id
  returning * into v_task;

  insert into public.agent_task_events (task_id, event_type, agent_code, payload)
  values (
    v_task.id,
    'AGENT CLAIMED',
    p_agent_code,
    jsonb_build_object(
      'claimed_at', v_task.claimed_at,
      'claim_expires_at', v_task.claim_expires_at
    )
  );

  update public.agent_task_ledger
  set
    last_heartbeat = now(),
    last_queue_result = 'claimed task ' || v_task.id::text
  where agent_code = p_agent_code;

  return next v_task;
end;
$$;

create or replace function public.move_agent_task_status(
  p_task_id uuid,
  p_status text,
  p_event_type text,
  p_agent_code text default null,
  p_reason text default null
)
returns public.agent_tasks
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_task public.agent_tasks;
begin
  if p_status not in ('Standing','Agent Todo','Agent Working','Agent Needs Input','Agent Review','Agent Done') then
    raise exception 'Invalid status: %', p_status
      using errcode = '22023';
  end if;

  if p_event_type not in (
    'AGENT CLAIMED',
    'AGENT DONE',
    'AGENT BLOCKED',
    'AGENT UNBLOCKED',
    'AGENT HUMAN HOLD',
    'AGENT HUMAN ANSWERED',
    'AGENT RESUMED',
    'AGENT FAILED',
    'AGENT APPLIED',
    'AGENT SKILL SUBSCRIBED',
    'AGENT SKILL INSTALLED',
    'AGENT SKILL UPDATED',
    'AGENT SKILL DECLINED',
    'AGENT FOLLOW-UP',
    'AGENT STATUS'
  ) then
    raise exception 'Invalid event_type: %', p_event_type
      using errcode = '22023';
  end if;

  if not (
    (p_status = 'Agent Working' and p_event_type in ('AGENT RESUMED','AGENT UNBLOCKED','AGENT HUMAN ANSWERED','AGENT STATUS'))
    or (p_status = 'Agent Needs Input' and p_event_type in ('AGENT BLOCKED','AGENT HUMAN HOLD','AGENT FAILED'))
    or (p_status = 'Agent Review' and p_event_type = 'AGENT DONE')
    or (p_status = 'Agent Done' and p_event_type = 'AGENT APPLIED')
    or (p_status = 'Agent Todo' and p_event_type in ('AGENT FAILED','AGENT FOLLOW-UP'))
    or (p_status = 'Standing' and p_event_type = 'AGENT STATUS')
  ) then
    raise exception 'Invalid status/event transition: % -> %', p_event_type, p_status
      using errcode = '22023';
  end if;

  if p_agent_code is not null and not exists (
    select 1
    from public.agent_task_ledger
    where agent_code = p_agent_code
  ) then
    raise exception 'Unknown agent_code: %', p_agent_code
      using errcode = '22023';
  end if;

  update public.agent_tasks
  set
    status = p_status,
    blocked_reason = case
      when p_status = 'Agent Needs Input' then p_reason
      when status = 'Agent Needs Input' and p_status <> 'Agent Needs Input' then null
      else blocked_reason
    end,
    review_reason = case
      when p_status = 'Agent Review' then p_reason
      when status = 'Agent Review' and p_status <> 'Agent Review' then null
      else review_reason
    end,
    completed_at = case
      when p_status = 'Agent Done' then now()
      when p_status <> 'Agent Done' then null
      else completed_at
    end,
    claimed_at = case
      when p_status in ('Agent Working', 'Agent Needs Input', 'Agent Review') then coalesce(claimed_at, now())
      else null
    end,
    claimed_by = case
      when p_status in ('Agent Working', 'Agent Needs Input', 'Agent Review') then coalesce(claimed_by, p_agent_code)
      else null
    end,
    claim_expires_at = case
      when p_status = 'Agent Working' then now() + interval '60 minutes'
      when p_status in ('Agent Needs Input', 'Agent Review') then claim_expires_at
      else null
    end,
    attempt_count = case
      when p_event_type = 'AGENT FAILED' then attempt_count + 1
      else attempt_count
    end,
    last_failed_at = case
      when p_event_type = 'AGENT FAILED' then now()
      else last_failed_at
    end,
    last_failure_reason = case
      when p_event_type = 'AGENT FAILED' then p_reason
      else last_failure_reason
    end
  where id = p_task_id
  returning * into v_task;

  if not found then
    raise exception 'Task not found: %', p_task_id
      using errcode = 'P0002';
  end if;

  insert into public.agent_task_events (task_id, event_type, agent_code, payload)
  values (
    p_task_id,
    p_event_type,
    p_agent_code,
    jsonb_strip_nulls(jsonb_build_object(
      'status', p_status,
      'reason', p_reason
    ))
  );

  return v_task;
end;
$$;

revoke execute on function public.claim_next_agent_task(text) from public, anon, authenticated;
grant execute on function public.claim_next_agent_task(text) to service_role;

revoke execute on function public.move_agent_task_status(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.move_agent_task_status(uuid, text, text, text, text) to service_role;

notify pgrst, 'reload schema';
