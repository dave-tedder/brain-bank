-- Brain Bank P7: SQL hardening batch 3
--
-- Scope:
--   * Port the corrected final form from Open Brain; critic_flags clears to []
--     from the start.
--   * Claim ownership guard for task receipts.
--   * Attempt ceiling and dead-letter routing.
--   * Critic integrity hardening and two-value runtime taxonomy.
--   * Operator completion attribution.
--   * Small state-machine and data-integrity guards from the corrections plan.

-- ---------------------------------------------------------------------------
-- Runtime taxonomy for critic independence.
-- ---------------------------------------------------------------------------

update public.agent_task_ledger
set runtime = case
  when agent_code in (
    'briefing',
    'local-claude-code',
    'claude-code',
    'claude-critic',
    'triage'
  ) then 'claude'
  when agent_code in (
    'local-codex',
    'codex',
    'codex-critic',
    'sentinel'
  ) then 'codex'
  when lower(runtime) like '%claude%' then 'claude'
  when lower(runtime) like '%codex%' then 'codex'
  else runtime
end;

alter table public.agent_task_ledger
  alter column runtime set not null;

alter table public.agent_task_ledger
  drop constraint if exists agent_task_ledger_runtime_check;

alter table public.agent_task_ledger
  add constraint agent_task_ledger_runtime_check
  check (runtime in ('claude', 'codex'));

-- The scorecard is service-role/internal only. Re-assert that it is not exposed.
revoke select on public.agent_scorecard from anon, authenticated;

-- ---------------------------------------------------------------------------
-- move_agent_task_status: claimant ownership, restored Review resume, critic
-- cleanup when a task re-enters execution, and current event/status vocabulary.
-- ---------------------------------------------------------------------------

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
  v_valid_from_state boolean := false;
begin
  if p_status not in ('Standing','Agent Todo','Agent Working','Agent Needs Input','Agent Review','Needs Operator','Agent Done') then
    raise exception 'Invalid status: %', p_status using errcode = '22023';
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
    'AGENT NEEDS OPERATOR',
    'OPERATOR DONE',
    'AGENT CRITIC',
    'AGENT SKILL SUBSCRIBED',
    'AGENT SKILL INSTALLED',
    'AGENT SKILL UPDATED',
    'AGENT SKILL DECLINED',
    'AGENT FOLLOW-UP',
    'AGENT STATUS'
  ) then
    raise exception 'Invalid event_type: %', p_event_type using errcode = '22023';
  end if;

  if p_agent_code is not null and not exists (
    select 1 from public.agent_task_ledger where agent_code = p_agent_code
  ) then
    raise exception 'Unknown agent_code: %', p_agent_code using errcode = '22023';
  end if;

  select * into v_current
  from public.agent_tasks
  where id = p_task_id
  for update;

  if not found then
    raise exception 'Task not found: %', p_task_id using errcode = 'P0002';
  end if;

  if v_current.archived_at is not null then
    raise exception 'Task % is archived; refusing status change', p_task_id
      using errcode = '22023';
  end if;

  if v_current.status = 'Agent Done'
    and not (p_status = 'Agent Done' and p_event_type = 'AGENT APPLIED') then
    raise exception 'Done tasks cannot receive non-apply receipts through this helper'
      using errcode = '22023';
  end if;

  if v_current.claimed_by is not null
    and p_agent_code is not null
    and p_agent_code <> v_current.claimed_by then
    raise exception 'Task % is claimed by %, not %', p_task_id, v_current.claimed_by, p_agent_code
      using errcode = '42501';
  end if;

  v_valid_from_state := case
    when p_status = 'Agent Working'
      and p_event_type in ('AGENT RESUMED','AGENT UNBLOCKED','AGENT HUMAN ANSWERED')
      then v_current.status in ('Agent Needs Input','Agent Review')

    when p_status = 'Agent Working' and p_event_type = 'AGENT STATUS'
      then v_current.status = 'Agent Working'

    when p_status = 'Agent Needs Input'
      and p_event_type in ('AGENT BLOCKED','AGENT HUMAN HOLD','AGENT FAILED')
      then v_current.status = 'Agent Working'

    when p_status = 'Agent Review' and p_event_type = 'AGENT DONE'
      then v_current.status = 'Agent Working'

    when p_status = 'Agent Done' and p_event_type = 'AGENT APPLIED'
      then v_current.status = 'Agent Review'

    when p_status = 'Agent Todo' and p_event_type = 'AGENT FAILED'
      then v_current.status = 'Agent Working'

    when p_status = 'Agent Todo' and p_event_type = 'AGENT FOLLOW-UP'
      then v_current.status in ('Agent Working','Agent Needs Input','Agent Review','Needs Operator','Agent Done')

    when p_status = 'Standing' and p_event_type = 'AGENT STATUS'
      then v_current.status in ('Agent Todo','Agent Working','Agent Needs Input','Agent Review','Standing')

    when p_status = v_current.status
      and p_event_type in (
        'AGENT FOLLOW-UP',
        'AGENT STATUS',
        'AGENT SKILL SUBSCRIBED',
        'AGENT SKILL INSTALLED',
        'AGENT SKILL UPDATED',
        'AGENT SKILL DECLINED'
      )
      and v_current.status <> 'Agent Done'
      then true

    else false
  end;

  if not v_valid_from_state then
    raise exception 'Invalid transition: % on % -> % (from %)',
      p_event_type, p_task_id, p_status, v_current.status
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
      when p_status in ('Agent Working','Agent Needs Input','Agent Review') then coalesce(claimed_at, now())
      else null
    end,
    claimed_by = case
      when p_status in ('Agent Working','Agent Needs Input','Agent Review') then coalesce(claimed_by, p_agent_code)
      else null
    end,
    claim_expires_at = case
      when p_status = 'Agent Working' then now() + interval '60 minutes'
      when p_status in ('Agent Needs Input','Agent Review') then claim_expires_at
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
    end,
    critic_verdict = case
      when p_status in ('Agent Working','Agent Todo') then null
      else critic_verdict
    end,
    critic_flags = case
      when p_status in ('Agent Working','Agent Todo') then '[]'::jsonb
      else critic_flags
    end,
    critic_reviewed_by = case
      when p_status in ('Agent Working','Agent Todo') then null
      else critic_reviewed_by
    end,
    critic_reviewed_at = case
      when p_status in ('Agent Working','Agent Todo') then null
      else critic_reviewed_at
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
      'from_status', v_current.status,
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

-- ---------------------------------------------------------------------------
-- claim_next_agent_task: attempt ceiling and paused/blocked caller guard.
-- ---------------------------------------------------------------------------

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

  if exists (
    select 1
    from public.agent_task_ledger
    where agent_code = p_agent_code
      and automation_state in ('paused','blocked')
  ) then
    raise exception 'Agent % is paused or blocked and cannot claim tasks.', p_agent_code
      using errcode = '42501';
  end if;

  select *
  into v_task
  from public.agent_tasks
  where status = 'Agent Todo'
    and archived_at is null
    and attempt_count < 5
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

revoke execute on function public.claim_next_agent_task(text, text) from public, anon, authenticated;
grant execute on function public.claim_next_agent_task(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- claim_specific_agent_task: same guards as claim_next.
-- ---------------------------------------------------------------------------

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

  if exists (
    select 1
    from public.agent_task_ledger
    where agent_code = p_agent_code
      and automation_state in ('paused','blocked')
  ) then
    raise exception 'Agent % is paused or blocked and cannot claim tasks.', p_agent_code
      using errcode = '42501';
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

  if v_task.attempt_count >= 5 then
    raise exception 'Task % has reached the max attempt ceiling (5) and needs human triage', p_task_id
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

-- ---------------------------------------------------------------------------
-- release_expired_agent_claims: route attempt 5 to human triage.
-- ---------------------------------------------------------------------------

create or replace function public.release_expired_agent_claims()
returns table (
  reaped_task_id uuid,
  previous_claimed_by text,
  reaped_claim_expired_at timestamptz,
  new_attempt_count int
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_row record;
  v_new_attempt_count int;
  v_new_status text;
  v_reason text;
begin
  for v_row in
    select id, claimed_by, claim_expires_at, attempt_count
    from public.agent_tasks
    where status = 'Agent Working'
      and claim_expires_at is not null
      and claim_expires_at < now()
      and archived_at is null
    for update skip locked
  loop
    v_new_attempt_count := v_row.attempt_count + 1;
    v_new_status := case when v_new_attempt_count >= 5 then 'Agent Needs Input' else 'Agent Todo' end;
    v_reason := case
      when v_new_attempt_count >= 5 then 'max attempts reached (5); needs human triage'
      else 'claim expired'
    end;

    update public.agent_tasks
    set
      status = v_new_status,
      claimed_at = case when v_new_status = 'Agent Needs Input' then claimed_at else null end,
      claimed_by = case when v_new_status = 'Agent Needs Input' then claimed_by else null end,
      claim_expires_at = null,
      blocked_reason = case when v_new_status = 'Agent Needs Input' then v_reason else null end,
      review_reason = null,
      attempt_count = v_new_attempt_count,
      last_failed_at = now(),
      last_failure_reason = v_reason,
      critic_verdict = null,
      critic_flags = '[]'::jsonb,
      critic_reviewed_by = null,
      critic_reviewed_at = null
    where id = v_row.id;

    insert into public.agent_task_events (task_id, event_type, agent_code, payload)
    values (
      v_row.id,
      'AGENT FAILED',
      v_row.claimed_by,
      jsonb_strip_nulls(jsonb_build_object(
        'status', v_new_status,
        'from_status', 'Agent Working',
        'reason', v_reason,
        'reaped_by', 'release_expired_agent_claims',
        'claim_expired_at', v_row.claim_expires_at,
        'dead_letter', v_new_attempt_count >= 5
      ))
    );

    reaped_task_id := v_row.id;
    previous_claimed_by := v_row.claimed_by;
    reaped_claim_expired_at := v_row.claim_expires_at;
    new_attempt_count := v_new_attempt_count;
    return next;
  end loop;

  return;
end;
$$;

revoke execute on function public.release_expired_agent_claims() from public, anon, authenticated;
grant execute on function public.release_expired_agent_claims() to service_role;

-- ---------------------------------------------------------------------------
-- record_critic_verdict: fail closed, duplicate guard, critic identity guard.
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- complete_operator_action: required operator identity and honest action-item
-- outcome reporting.
-- ---------------------------------------------------------------------------

drop function if exists public.complete_operator_action(uuid,text);

create or replace function public.complete_operator_action(
  p_task_id uuid,
  p_completed_by text,
  p_note text default null
)
returns public.agent_tasks
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_current public.agent_tasks;
  v_task public.agent_tasks;
  v_action_outcome text := 'not_linked';
  v_updated_action int := 0;
  v_completed_by text := nullif(trim(coalesce(p_completed_by, '')), '');
begin
  if v_completed_by is null then
    raise exception 'complete_operator_action requires completed_by.' using errcode = '22023';
  end if;

  select * into v_current from public.agent_tasks where id = p_task_id for update;
  if not found then
    raise exception 'Task not found: %', p_task_id using errcode = 'P0002';
  end if;
  if v_current.archived_at is not null then
    raise exception 'Task % is archived; cannot complete operator action', p_task_id using errcode = '22023';
  end if;
  if v_current.status <> 'Needs Operator' then
    raise exception 'complete_operator_action requires status Needs Operator (got %).', v_current.status
      using errcode = '22023';
  end if;

  update public.agent_tasks
  set status = 'Agent Done', completed_at = now(), updated_at = now()
  where id = p_task_id
  returning * into v_task;

  if v_current.linked_action_item_id is not null then
    update public.action_items
    set status = 'resolved', resolved_at = now()
    where id = v_current.linked_action_item_id
      and status = 'open';
    get diagnostics v_updated_action = row_count;
    v_action_outcome := case
      when v_updated_action = 1 then 'resolved'
      else 'already_closed'
    end;
  end if;

  insert into public.agent_task_events (task_id, event_type, agent_code, payload)
  values (
    p_task_id, 'OPERATOR DONE', null,
    jsonb_strip_nulls(jsonb_build_object(
      'status', 'Agent Done',
      'from_status', 'Needs Operator',
      'operator_action', v_current.operator_action,
      'operator_target', v_current.operator_target,
      'completed_by', v_completed_by,
      'note', nullif(trim(coalesce(p_note, '')), ''),
      'linked_action_item_id', v_current.linked_action_item_id,
      'linked_action_item_outcome', v_action_outcome
    ))
  );

  return v_task;
end;
$$;

revoke execute on function public.complete_operator_action(uuid,text,text) from public, anon, authenticated;
grant execute on function public.complete_operator_action(uuid,text,text) to service_role;

-- ---------------------------------------------------------------------------
-- apply_agent_task_review: small guards from the review.
-- ---------------------------------------------------------------------------

create or replace function public.apply_agent_task_review(
  p_task_id uuid,
  p_applied_by text,
  p_resolution text,
  p_note text,
  p_resolve_linked_action_item boolean,
  p_child_task_ids uuid[] default '{}'::uuid[],
  p_closeout_evidence jsonb default '{}'::jsonb,
  p_operator_action text default null,
  p_operator_target text default null
)
returns public.agent_tasks
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_current public.agent_tasks;
  v_task public.agent_tasks;
  v_child_count int;
  v_child_ids uuid[] := coalesce(p_child_task_ids, '{}'::uuid[]);
  v_action_outcome text := 'not_requested';
  v_updated_action int := 0;
  v_operator_action text := nullif(trim(coalesce(p_operator_action, '')), '');
  v_operator_target text := nullif(trim(coalesce(p_operator_target, '')), '');
begin
  if p_resolution not in ('accepted','accepted_with_follow_up') then
    raise exception 'Invalid review resolution: %', p_resolution
      using errcode = '22023';
  end if;

  if v_operator_target is not null and v_operator_action is null then
    raise exception 'p_operator_target requires p_operator_action.'
      using errcode = '22023';
  end if;

  select * into v_current
  from public.agent_tasks
  where id = p_task_id
  for update;

  if not found then
    raise exception 'Task not found: %', p_task_id using errcode = 'P0002';
  end if;

  if v_current.archived_at is not null then
    raise exception 'Task % is archived; cannot apply review', p_task_id
      using errcode = '22023';
  end if;

  if v_current.status <> 'Agent Review' then
    raise exception 'AGENT APPLIED requires Agent Review.'
      using errcode = '22023';
  end if;

  if v_operator_action is not null and p_resolve_linked_action_item then
    raise exception 'Cannot resolve a linked action item while routing to Needs Operator; the operator step is still open.'
      using errcode = '22023';
  end if;

  if p_resolve_linked_action_item and p_resolution <> 'accepted' then
    raise exception 'Linked action item can only be resolved when review resolution is accepted.'
      using errcode = '22023';
  end if;

  if p_resolution = 'accepted_with_follow_up' and cardinality(v_child_ids) = 0 then
    raise exception 'accepted_with_follow_up requires at least one child task.'
      using errcode = '22023';
  end if;

  if cardinality(v_child_ids) > 0 then
    perform 1
    from public.agent_tasks
    where id = any(v_child_ids)
    for share;

    select count(*)
    into v_child_count
    from public.agent_tasks
    where id = any(v_child_ids)
      and parent_task_id = p_task_id
      and status = 'Standing'
      and archived_at is null;

    if v_child_count <> cardinality(v_child_ids) then
      raise exception 'Every child task must be a non-archived Standing draft linked to the reviewed parent task.'
        using errcode = '22023';
    end if;
  end if;

  update public.agent_tasks
  set
    status = case when v_operator_action is not null then 'Needs Operator' else 'Agent Done' end,
    completed_at = case when v_operator_action is not null then null else now() end,
    claimed_at = null,
    claimed_by = null,
    claim_expires_at = null,
    blocked_reason = null,
    review_reason = coalesce(nullif(trim(p_note), ''), review_reason),
    operator_action = case when v_operator_action is not null then v_operator_action else operator_action end,
    operator_target = case when v_operator_action is not null then v_operator_target else operator_target end,
    updated_at = now()
  where id = p_task_id
  returning * into v_task;

  if p_resolve_linked_action_item then
    if v_current.linked_action_item_id is null then
      v_action_outcome := 'not_linked';
    else
      update public.action_items
      set status = 'resolved', resolved_at = now()
      where id = v_current.linked_action_item_id
        and status = 'open';
      get diagnostics v_updated_action = row_count;
      v_action_outcome := case
        when v_updated_action = 1 then 'resolved'
        else 'already_closed'
      end;
    end if;
  end if;

  insert into public.agent_task_events (
    task_id,
    event_type,
    agent_code,
    payload
  )
  values (
    p_task_id,
    case when v_operator_action is not null then 'AGENT NEEDS OPERATOR' else 'AGENT APPLIED' end,
    v_current.claimed_by,
    jsonb_strip_nulls(jsonb_build_object(
      'status', case when v_operator_action is not null then 'Needs Operator' else 'Agent Done' end,
      'from_status', 'Agent Review',
      'applied_by', nullif(trim(coalesce(p_applied_by, '')), ''),
      'resolution', p_resolution,
      'note', nullif(trim(coalesce(p_note, '')), ''),
      'resolve_linked_action_item_requested', p_resolve_linked_action_item,
      'linked_action_item_id', v_current.linked_action_item_id,
      'linked_action_item_outcome', v_action_outcome,
      'child_task_ids', to_jsonb(v_child_ids),
      'closeout_evidence', coalesce(p_closeout_evidence, '{}'::jsonb),
      'operator_action', v_operator_action,
      'operator_target', v_operator_target
    ))
  );

  return v_task;
end;
$$;

revoke execute on function public.apply_agent_task_review(
  uuid,
  text,
  text,
  text,
  boolean,
  uuid[],
  jsonb,
  text,
  text
) from public, anon, authenticated;

grant execute on function public.apply_agent_task_review(
  uuid,
  text,
  text,
  text,
  boolean,
  uuid[],
  jsonb,
  text,
  text
) to service_role;

-- ---------------------------------------------------------------------------
-- reroute_operator_action_task: archived guard and critic cleanup.
-- ---------------------------------------------------------------------------

create or replace function public.reroute_operator_action_task(
  p_task_id uuid,
  p_reason text
)
returns public.agent_tasks
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_current public.agent_tasks;
  v_task public.agent_tasks;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if v_reason is null then
    raise exception 'reroute_operator_action_task requires a reason.' using errcode = '22023';
  end if;

  select * into v_current from public.agent_tasks where id = p_task_id for update;
  if not found then
    raise exception 'Task not found: %', p_task_id using errcode = 'P0002';
  end if;
  if v_current.archived_at is not null then
    raise exception 'Task % is archived; cannot reroute Needs Operator task', p_task_id using errcode = '22023';
  end if;
  if v_current.status <> 'Needs Operator' then
    raise exception 'reroute_operator_action_task requires status Needs Operator (got %).', v_current.status
      using errcode = '22023';
  end if;

  update public.agent_tasks
  set status = 'Agent Todo',
      operator_action = null,
      operator_target = null,
      critic_verdict = null,
      critic_flags = '[]'::jsonb,
      critic_reviewed_by = null,
      critic_reviewed_at = null,
      updated_at = now()
  where id = p_task_id
  returning * into v_task;

  insert into public.agent_task_events (task_id, event_type, agent_code, payload)
  values (
    p_task_id, 'AGENT FOLLOW-UP', null,
    jsonb_strip_nulls(jsonb_build_object(
      'status', 'Agent Todo',
      'from_status', 'Needs Operator',
      'reason', v_reason,
      'source', 'reroute_operator_action_task'
    ))
  );

  return v_task;
end;
$$;

revoke execute on function public.reroute_operator_action_task(uuid,text) from public, anon, authenticated;
grant execute on function public.reroute_operator_action_task(uuid,text) to service_role;

notify pgrst, 'reload schema';
