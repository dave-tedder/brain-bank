-- OE-15 (Session 328 plan): soft affinity + per-run claim ownership.
--
-- 1. agent_tasks.preferred_agent — soft-affinity hint. Pure ORDER BY key in
--    claim_next_agent_task (assigned-to-me, then preferred-to-me, then
--    priority, then created_at). NEVER a WHERE filter: any eligible runtime
--    can still claim any unassigned task, so nothing starves. Free text (no
--    FK/enum) so new runtimes (antigravity) need no schema change.
-- 2. agent_tasks.claim_token — per-RUN claim ownership. Root cause: when
--    multiple executor slots share one agent_code (e.g. local-claude-code),
--    after an expire+reclaim cycle the complete guard
--    (claimed_by match) accepted a STALE run's receipt. The token is minted at
--    claim/resume time and must be presented for run-side receipts
--    (AGENT DONE / BLOCKED / HUMAN HOLD / FAILED / STATUS) while set. Claims
--    made before this migration have a null token and stay exempt.
-- 3. promote_agent_task_intake gains optional p_preferred_agent (the operator's
--    promote-time routing override); null leaves the intake-set value alone.
--
-- Pre-migration claims (claim_token null) are exempt from the token guard, so
-- apply + Edge deploy can happen back-to-back without stranding in-flight work.

alter table public.agent_tasks
  add column if not exists preferred_agent text;

alter table public.agent_tasks
  add column if not exists claim_token uuid;

comment on column public.agent_tasks.preferred_agent is
  'Soft-affinity hint: agent_code that gets first dibs at claim time. Pure ORDER BY key, never a WHERE filter. Free text, human/triage-set in v1.';

comment on column public.agent_tasks.claim_token is
  'Per-run claim ownership token minted by the claim RPCs and resume-family transitions. Required by move_agent_task_status for run-side receipts while set. Never exposed in list/get selects or event payloads.';

-- ---------------------------------------------------------------------------
-- claim_next_agent_task: 3-tier affinity ORDER BY + token mint.
-- WHERE clause byte-identical to 20260708_oe12_claim_prefers_assigned_agent.
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
    -- OE-15 affinity tier: hard-assigned-to-me, then preferred-to-me, then
    -- everything else (another runtime's preference is invisible to me, so
    -- preference reorders but never restricts and nothing starves).
    case
      when agent_code = p_agent_code then 0
      when preferred_agent = p_agent_code then 1
      else 2
    end,
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
    claim_token = gen_random_uuid(),
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

revoke execute on function public.claim_next_agent_task(text, text)
  from public, anon, authenticated;
grant execute on function public.claim_next_agent_task(text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- claim_specific_agent_task: token mint only. Affinity ordering is not
-- applicable to a named-task claim; all existing guards preserved.
-- Body otherwise byte-identical to 20260707_claim_specific_agent_task.
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
    claim_token = gen_random_uuid(),
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
-- move_agent_task_status: NEW p_claim_token parameter. Signature changes, so
-- the old 5-param overload is dropped first (leaving both would make the
-- PostgREST rpc name ambiguous). No SQL function calls this internally; the
-- Edge Function is redeployed in the same sitting.
--
-- Token rules:
--   * Run-side receipts (AGENT DONE, AGENT BLOCKED, AGENT HUMAN HOLD,
--     AGENT FAILED, AGENT STATUS) on a token-bearing claim must present the
--     CURRENT token. request-review maps to AGENT DONE and is covered.
--   * Resume-family (AGENT RESUMED / UNBLOCKED / HUMAN ANSWERED -> Agent
--     Working) is human-gated and does NOT require the old token; it MINTS a
--     fresh one, returned in the row, so the resuming session owns the claim.
--   * Token follows claimed_by lifecycle: retained through Agent Needs Input /
--     Agent Review, cleared whenever the claim clears.
--   * Claims with a null token (pre-migration) are exempt.
-- Body otherwise byte-identical to 20260710_needs_operator_rename.sql.
-- ---------------------------------------------------------------------------

drop function if exists public.move_agent_task_status(uuid, text, text, text, text);

create or replace function public.move_agent_task_status(
  p_task_id uuid,
  p_status text,
  p_event_type text,
  p_agent_code text default null,
  p_reason text default null,
  p_claim_token uuid default null
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

  -- OE-15 per-run claim ownership: a matching agent_code is no longer enough
  -- for run-side receipts, because three executor slots share one identity.
  if v_current.claim_token is not null
    and p_event_type in ('AGENT DONE','AGENT BLOCKED','AGENT HUMAN HOLD','AGENT FAILED','AGENT STATUS')
    and (p_claim_token is null or p_claim_token <> v_current.claim_token) then
    raise exception 'Task % is held by a different run of %: claim_token missing or stale. Only the run holding the current claim can write % receipts.',
      p_task_id, coalesce(v_current.claimed_by, '(unclaimed)'), p_event_type
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
    claim_token = case
      when p_status = 'Agent Working'
        and p_event_type in ('AGENT RESUMED','AGENT UNBLOCKED','AGENT HUMAN ANSWERED')
        then gen_random_uuid()
      when p_status in ('Agent Working','Agent Needs Input','Agent Review') then claim_token
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

revoke execute on function public.move_agent_task_status(uuid, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.move_agent_task_status(uuid, text, text, text, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- release_expired_agent_claims: clear claim_token on reap (both the
-- return-to-Todo and the attempt-5 dead-letter branches), so a stale run's
-- token is dead the moment its claim expires.
-- Body otherwise byte-identical to 20260710_oe_hardening_batch_3_critic_flags_fix.sql.
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
      claim_token = null,
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
-- promote_agent_task_intake: optional promote-time preferred_agent override.
-- Signature changes, so the old 3-param overload is dropped first. Body starts
-- from the LIVE hardened S3 version (writes the AGENT STATUS promotion audit
-- event), NOT the stale 20260629152619 file.
-- ---------------------------------------------------------------------------

drop function if exists public.promote_agent_task_intake(uuid, text, text);

create or replace function public.promote_agent_task_intake(
  p_task_id uuid,
  p_promoted_by text,
  p_note text,
  p_preferred_agent text default null
)
returns public.agent_tasks
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_current public.agent_tasks;
  v_task public.agent_tasks;
  v_prior_approval boolean;
begin
  select * into v_current
  from public.agent_tasks
  where id = p_task_id
  for update;

  if not found then
    raise exception 'Task not found: %', p_task_id using errcode = 'P0002';
  end if;

  if v_current.archived_at is not null then
    raise exception 'Task % is archived; cannot promote', p_task_id
      using errcode = '22023';
  end if;

  if v_current.status <> 'Standing' then
    raise exception 'Only Standing intake drafts can be promoted to Agent Todo'
      using errcode = '22023';
  end if;

  v_prior_approval := v_current.explicit_approval;

  update public.agent_tasks
  set
    status = 'Agent Todo',
    claimed_at = null,
    claimed_by = null,
    claim_expires_at = null,
    claim_token = null,
    completed_at = null,
    blocked_reason = null,
    review_reason = null,
    explicit_approval = v_current.explicit_approval,
    preferred_agent = coalesce(
      nullif(trim(coalesce(p_preferred_agent, '')), ''),
      preferred_agent
    ),
    context = case
      when nullif(trim(coalesce(p_note, '')), '') is null then context
      else concat_ws(
        E'\n\n',
        context,
        'Intake promoted by ' || coalesce(nullif(trim(p_promoted_by), ''), 'unknown') ||
          ': ' || trim(p_note)
      )
    end
  where id = p_task_id
  returning * into v_task;

  insert into public.agent_task_events (task_id, event_type, agent_code, payload)
  values (
    p_task_id,
    'AGENT STATUS',
    v_task.agent_code,
    jsonb_strip_nulls(jsonb_build_object(
      'status', 'Agent Todo',
      'from_status', 'Standing',
      'action', 'promoted',
      'promoted_by', nullif(trim(coalesce(p_promoted_by, '')), ''),
      'note', nullif(trim(coalesce(p_note, '')), ''),
      'preferred_agent', nullif(trim(coalesce(p_preferred_agent, '')), ''),
      'prior_explicit_approval', v_prior_approval
    ))
  );

  return v_task;
end;
$$;

revoke execute on function public.promote_agent_task_intake(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.promote_agent_task_intake(uuid, text, text, text) to service_role;

notify pgrst, 'reload schema';
