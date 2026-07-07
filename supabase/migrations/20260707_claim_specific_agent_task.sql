-- claim_specific_agent_task
--
-- Adds a guarded claim path keyed by a SPECIFIC task_id, for human-supervised
-- interactive sessions that already know exactly which board task they want
-- to execute right now, rather than "whatever's oldest for this agent_code."
--
-- claim_next_agent_task only claims the oldest eligible Agent Todo row for an
-- agent_code, so a human operator executing a specific task live (with other,
-- older, unrelated Agent Todo rows ahead of it in the queue) has no way to
-- claim the one they mean -- claim_next_agent_task would claim a different
-- task instead.
--
-- Same guard rails as claim_next_agent_task: status must be Agent Todo,
-- archived rows excluded, agent_code must match or be unassigned, risk must
-- be within max_risk, high-risk tasks require explicit_approval, atomic
-- FOR UPDATE SKIP LOCKED row lock, same 60-minute claim TTL, same
-- AGENT CLAIMED event + ledger heartbeat on success.
--
-- Unlike claim_next_agent_task (which silently returns nothing when no task
-- is eligible -- the caller didn't ask for anything specific), this
-- function raises a specific, actionable exception when the named task
-- can't be claimed, since the caller already committed to that one ID:
-- not found/locked, archived, wrong status, assigned to a different agent,
-- risk exceeds max_risk, or high risk without explicit_approval.
--
-- Intended for human-present interactive sessions only. Scheduled/autonomous
-- runners keep using claim_next_agent_task so oldest-eligible fairness holds.

create or replace function public.claim_specific_agent_task(
  p_task_id uuid,
  p_agent_code text,
  p_max_risk text
)
returns setof public.agent_tasks
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_task public.agent_tasks;
  v_max_rank int;
  v_task_rank int;
begin
  if p_max_risk not in ('low', 'medium', 'high') then
    raise exception 'Invalid max risk: %', p_max_risk
      using errcode = '22023';
  end if;

  v_max_rank := case p_max_risk
    when 'low' then 1
    when 'medium' then 2
    else 3
  end;

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
  where id = p_task_id
  for update skip locked;

  if not found then
    raise exception 'Task not found, or currently locked by another claim: %', p_task_id
      using errcode = 'P0002';
  end if;

  if v_task.archived_at is not null then
    raise exception 'Task % is archived and cannot be claimed', p_task_id
      using errcode = '22023';
  end if;

  if v_task.status <> 'Agent Todo' then
    raise exception 'Task % is not claimable: current status is %, expected Agent Todo', p_task_id, v_task.status
      using errcode = '22023';
  end if;

  if v_task.agent_code is not null and v_task.agent_code <> p_agent_code then
    raise exception 'Task % is assigned to agent_code %, not %', p_task_id, v_task.agent_code, p_agent_code
      using errcode = '22023';
  end if;

  v_task_rank := case v_task.risk
    when 'low' then 1
    when 'medium' then 2
    else 3
  end;

  if v_task_rank > v_max_rank then
    raise exception 'Task % risk (%) exceeds max_risk (%)', p_task_id, v_task.risk, p_max_risk
      using errcode = '22023';
  end if;

  if v_task.risk = 'high' and v_task.explicit_approval is not true then
    raise exception 'Task % is high risk and requires explicit_approval before claiming', p_task_id
      using errcode = '22023';
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
      'claim_expires_at', v_task.claim_expires_at,
      'max_risk', p_max_risk,
      'claim_mode', 'specific'
    )
  );

  update public.agent_task_ledger
  set
    last_heartbeat = now(),
    last_queue_result = 'claimed specific task ' || v_task.id::text
  where agent_code = p_agent_code;

  return next v_task;
end;
$function$;

revoke execute on function public.claim_specific_agent_task(uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_specific_agent_task(uuid, text, text) to service_role;

notify pgrst, 'reload schema';
