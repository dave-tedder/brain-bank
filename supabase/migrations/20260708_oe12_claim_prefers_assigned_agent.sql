-- OE-12 follow-up: make claim_next_agent_task prefer tasks
-- explicitly assigned to the calling agent over unassigned (agent_code IS NULL)
-- tasks. The WHERE clause already matches both (agent_code is null or
-- agent_code = p_agent_code), so the executor already claims unassigned
-- low-risk work (e.g. freshly human-promoted triage drafts). This only adds an
-- ORDER BY key so a caller drains its own assigned queue first, then picks up
-- unassigned tasks -- operator directive: "the executor should claim
-- unassigned low-risk tasks, with assigned tasks prioritized."
--
-- Everything else is byte-identical to the live function
-- (20260702 hardening batch REVOKE preserved and re-asserted below).

create or replace function public.claim_next_agent_task(p_agent_code text, p_max_risk text)
returns setof public.agent_tasks
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_task public.agent_tasks;
  v_max_rank int;
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
  where status = 'Agent Todo'
    and archived_at is null
    and (agent_code is null or agent_code = p_agent_code)
    and (
      case risk
        when 'low' then 1
        when 'medium' then 2
        else 3
      end
    ) <= v_max_rank
    and (risk <> 'high' or explicit_approval = true)
  order by
    -- assigned-to-this-agent first, then unassigned (operator directive)
    case when agent_code = p_agent_code then 0 else 1 end,
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
      'claim_expires_at', v_task.claim_expires_at,
      'max_risk', p_max_risk
    )
  );

  update public.agent_task_ledger
  set
    last_heartbeat = now(),
    last_queue_result = 'claimed task ' || v_task.id::text
  where agent_code = p_agent_code;

  return next v_task;
end;
$function$;

-- Re-assert the S3 hardening ACL (CREATE OR REPLACE preserves grants, but keep
-- this explicit so the migration is self-contained): service_role only.
revoke execute on function public.claim_next_agent_task(text, text)
  from public, anon, authenticated;
grant execute on function public.claim_next_agent_task(text, text)
  to service_role;

notify pgrst, 'reload schema';
