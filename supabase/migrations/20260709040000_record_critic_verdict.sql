-- OE-11 Phase 4: advisory critic verdict recorder. Never moves status.
-- Independence guard: the critic runtime must differ from the executor's.
-- Reviews Agent Review and Needs Operator tasks. Routing to Needs Operator
-- clears claimed_by, so the executor is resolved from the newest AGENT DONE
-- receipt. The function refuses tasks whose executor cannot be resolved.

drop function if exists public.record_critic_verdict(uuid,text,text,jsonb);

create or replace function public.record_critic_verdict(
  p_task_id uuid,
  p_critic_agent_code text,
  p_verdict text,
  p_flags jsonb default '[]'::jsonb,
  p_allow_rereview boolean default false
)
returns public.agent_tasks
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_current public.agent_tasks;
  v_task public.agent_tasks;
  v_executor_agent_code text;
  v_executor_runtime text;
  v_critic_runtime text;
begin
  if p_verdict not in ('clean','flagged') then
    raise exception 'Invalid verdict: % (clean|flagged).', p_verdict using errcode = '22023';
  end if;

  if p_critic_agent_code !~ '-critic$' then
    raise exception 'Critic agent_code must end in -critic: %', p_critic_agent_code using errcode = '22023';
  end if;

  select * into v_current from public.agent_tasks where id = p_task_id for update;
  if not found then
    raise exception 'Task not found: %', p_task_id using errcode = 'P0002';
  end if;
  if v_current.archived_at is not null then
    raise exception 'Task % is archived; cannot record critic verdict', p_task_id using errcode = '22023';
  end if;
  if v_current.status not in ('Agent Review', 'Needs Operator') then
    raise exception 'Critic reviews Agent Review or Needs Operator tasks only (got %).', v_current.status using errcode = '22023';
  end if;
  if v_current.critic_reviewed_by is not null and p_allow_rereview is not true then
    raise exception 'Task % already has critic verdict by %. Pass p_allow_rereview=true to overwrite with a new AGENT CRITIC event.', p_task_id, v_current.critic_reviewed_by
      using errcode = '22023';
  end if;

  select runtime into v_critic_runtime
  from public.agent_task_ledger
  where agent_code = p_critic_agent_code;

  if v_critic_runtime is null then
    raise exception 'Unknown critic agent_code: %', p_critic_agent_code using errcode = '22023';
  end if;

  v_executor_agent_code := v_current.claimed_by;
  if v_executor_agent_code is null then
    select agent_code into v_executor_agent_code
    from public.agent_task_events
    where task_id = p_task_id
      and event_type = 'AGENT DONE'
      and agent_code is not null
    order by created_at desc
    limit 1;
  end if;

  if v_executor_agent_code is null then
    raise exception 'Cannot resolve executor for task %; critic verdict refuses unknown executor runtime.', p_task_id
      using errcode = '22023';
  end if;

  select runtime into v_executor_runtime
  from public.agent_task_ledger
  where agent_code = v_executor_agent_code;

  if v_executor_runtime is null then
    raise exception 'Cannot resolve executor runtime for task % executor %.', p_task_id, v_executor_agent_code
      using errcode = '22023';
  end if;

  if v_critic_runtime = v_executor_runtime then
    raise exception 'Critic runtime (%) must differ from executor runtime (%); a runtime may not review its own work.',
      v_critic_runtime, v_executor_runtime using errcode = '22023';
  end if;

  update public.agent_tasks
  set critic_verdict = p_verdict,
      critic_flags = coalesce(p_flags, '[]'::jsonb),
      critic_reviewed_by = p_critic_agent_code,
      critic_reviewed_at = now(),
      updated_at = now()
  where id = p_task_id
  returning * into v_task;

  insert into public.agent_task_events (task_id, event_type, agent_code, payload)
  values (
    p_task_id, 'AGENT CRITIC', p_critic_agent_code,
    jsonb_build_object(
      'verdict', p_verdict,
      'flags', coalesce(p_flags, '[]'::jsonb),
      'executor_agent_code', v_executor_agent_code,
      'executor_runtime', v_executor_runtime,
      'critic_runtime', v_critic_runtime,
      'rereview', p_allow_rereview
    )
  );

  return v_task;
end;
$$;

revoke execute on function public.record_critic_verdict(uuid,text,text,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.record_critic_verdict(uuid,text,text,jsonb,boolean) to service_role;

notify pgrst, 'reload schema';
