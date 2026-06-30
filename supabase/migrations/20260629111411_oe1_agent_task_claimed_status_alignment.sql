-- OE-1 review follow-up: align dashboard Todo -> Working movement with the
-- canonical AGENT CLAIMED receipt.
--
-- The first dashboard action mapped Agent Todo -> Agent Working to AGENT
-- RESUMED. That is correct for resuming blocked/review tasks, but fresh Todo
-- work should write AGENT CLAIMED.

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
  v_current public.agent_tasks;
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

  if p_agent_code is not null and not exists (
    select 1
    from public.agent_task_ledger
    where agent_code = p_agent_code
  ) then
    raise exception 'Unknown agent_code: %', p_agent_code
      using errcode = '22023';
  end if;

  select *
  into v_current
  from public.agent_tasks
  where id = p_task_id
  for update;

  if not found then
    raise exception 'Task not found: %', p_task_id
      using errcode = 'P0002';
  end if;

  if v_current.status = 'Agent Done'
    and not (p_status = 'Agent Done' and p_event_type = 'AGENT APPLIED') then
    raise exception 'Done tasks cannot receive non-apply receipts through this helper'
      using errcode = '22023';
  end if;

  if not (
    (p_status = 'Agent Working' and p_event_type in ('AGENT CLAIMED','AGENT RESUMED','AGENT UNBLOCKED','AGENT HUMAN ANSWERED','AGENT STATUS'))
    or (p_status = 'Agent Needs Input' and p_event_type in ('AGENT BLOCKED','AGENT HUMAN HOLD','AGENT FAILED'))
    or (p_status = 'Agent Review' and p_event_type = 'AGENT DONE')
    or (p_status = 'Agent Done' and p_event_type = 'AGENT APPLIED')
    or (p_status = 'Agent Todo' and p_event_type in ('AGENT FAILED','AGENT FOLLOW-UP'))
    or (p_status = 'Standing' and p_event_type = 'AGENT STATUS')
    or (p_status = v_current.status and p_event_type in (
      'AGENT FOLLOW-UP',
      'AGENT STATUS',
      'AGENT SKILL SUBSCRIBED',
      'AGENT SKILL INSTALLED',
      'AGENT SKILL UPDATED',
      'AGENT SKILL DECLINED'
    ) and v_current.status <> 'Agent Done')
  ) then
    raise exception 'Invalid status/event transition: % -> %', p_event_type, p_status
      using errcode = '22023';
  end if;

  if p_status = 'Agent Working'
    and v_current.risk = 'high'
    and v_current.explicit_approval is not true then
    raise exception 'High-risk task requires explicit approval before Agent Working'
      using errcode = '42501';
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
      when p_status = 'Agent Done' then coalesce(completed_at, now())
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

  if p_event_type = 'AGENT STATUS' and p_agent_code is not null then
    update public.agent_task_ledger
    set
      last_heartbeat = now(),
      last_queue_result = coalesce(p_reason, 'status heartbeat')
    where agent_code = p_agent_code;
  end if;

  return v_task;
end;
$$;

revoke execute on function public.move_agent_task_status(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.move_agent_task_status(uuid, text, text, text, text) to service_role;

notify pgrst, 'reload schema';
