-- OE ops verbs: C2 hard runtime constraint + C3 admin mutation verb.
--
-- C2. agent_tasks.requires_local — HARD constraint (distinct from the SOFT
--     preferred_agent). true = only an attended local runtime (git-capable) may
--     claim. Both claim RPCs gain p_runtime_local boolean default false; a caller
--     that does not assert local capability can never select a requires_local
--     task (fail-safe: a scheduled lane is safe even if its executor prompt
--     update is missed). Root cause: scheduled remote/cloud executors repeatedly
--     claim local-only work they cannot execute, then must fake an AGENT FAILED
--     to hand it back.
--
-- C3. admin_amend_agent_task — one honest verb for ops corrections that today
--     require raw execute_sql: set project_slug / append sources / set operator
--     fields / set requires_local, move a terminal Agent Done|Agent Review task
--     back onto the Needs Operator desk, and release a stuck claim (the folded
--     handoff) — all with an honest audit event, never touching attempt_count
--     and never writing a false AGENT FAILED. Replaces the raw execute_sql ops
--     backfills (slug backfill, sources backfill, deliverable-strand census).
--
-- Signatures on the two claim RPCs change, so the old overloads are dropped
-- first (PostgREST would otherwise see an ambiguous name). No SQL function calls
-- either claim RPC internally; the Edge Function is redeployed in the same
-- sitting so the new arity resolves. move_agent_task_status,
-- release_expired_agent_claims, and promote_agent_task_intake are NOT touched.

-- ---------------------------------------------------------------------------
-- C2 column.
-- ---------------------------------------------------------------------------

alter table public.agent_tasks
  add column if not exists requires_local boolean not null default false;

comment on column public.agent_tasks.requires_local is
  'C2 HARD runtime constraint: true = only an attended local (git-capable) runtime may claim, enforced by claim_next/claim_specific via p_runtime_local. Distinct from preferred_agent (SOFT affinity, reorders never restricts). Per-task, overridable; intake defaults it true for known-local project slugs.';

-- A fork whose intake marks certain project slugs as local-only can backfill
-- existing rows here, e.g.:
--   update public.agent_tasks set requires_local = true
--   where project_slug = '<your-local-only-slug>' and requires_local = false;
-- Fresh forks need no backfill — the column default (false) is correct.

-- ---------------------------------------------------------------------------
-- claim_next_agent_task: + p_runtime_local. WHERE gains one predicate; the
-- 3-tier affinity ORDER BY is byte-identical to
-- 20260711_oe15_soft_affinity_claim_tokens.
-- ---------------------------------------------------------------------------

drop function if exists public.claim_next_agent_task(text, text);

create or replace function public.claim_next_agent_task(
  p_agent_code text,
  p_max_risk text,
  p_runtime_local boolean default false
)
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
    -- OE C2 hard runtime constraint: a local-only task is invisible to any
    -- claim that did not assert local capability. Fail-safe: default false.
    and (requires_local = false or p_runtime_local = true)
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

revoke execute on function public.claim_next_agent_task(text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_next_agent_task(text, text, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- claim_specific_agent_task: + p_runtime_local. Adds one trailing guard after
-- the risk/approval checks; a named claim of local-only work from a non-local
-- lane is refused explicitly (not silently skipped). Body otherwise
-- byte-identical to 20260711_oe15_soft_affinity_claim_tokens.
-- ---------------------------------------------------------------------------

drop function if exists public.claim_specific_agent_task(uuid, text, text);

create or replace function public.claim_specific_agent_task(
  p_task_id uuid,
  p_agent_code text,
  p_max_risk text,
  p_runtime_local boolean default false
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

  -- OE C2 hard runtime constraint: refuse a named claim of local-only work
  -- unless this claim asserts local capability.
  if v_task.requires_local and not p_runtime_local then
    raise exception 'Task % requires a local runtime (requires_local=true); this claim did not assert local capability (p_runtime_local=false). Claim it from an attended local session.', p_task_id
      using errcode = '42501';
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

revoke execute on function public.claim_specific_agent_task(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.claim_specific_agent_task(uuid, text, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- C3. admin_amend_agent_task: one honest ops-correction verb.
-- security invoker (service_role bypasses RLS); search_path pinned; revoked
-- from web-exposed roles. Writes exactly one audit event, never AGENT FAILED,
-- never touches attempt_count, never edits an existing event row.
-- ---------------------------------------------------------------------------

create or replace function public.admin_amend_agent_task(
  p_task_id uuid,
  p_reason text,
  p_actor text default null,
  p_set_project_slug text default null,
  p_add_sources jsonb default null,
  p_set_operator_action text default null,
  p_set_operator_target text default null,
  p_set_requires_local boolean default null,
  p_move_to_needs_operator boolean default false,
  p_release_claim boolean default false
)
returns public.agent_tasks
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_current public.agent_tasks;
  v_task public.agent_tasks;
  v_new_sources jsonb;
  v_elem jsonb;
  v_effective_operator_action text;
  v_event_type text;
  v_target_status text;
begin
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'admin_amend_agent_task requires a non-empty reason for the audit trail'
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
    raise exception 'Task % is archived; refusing admin amend', p_task_id
      using errcode = '22023';
  end if;

  -- Move-to-desk is legal only from a terminal/near-terminal state, and the
  -- desk card must carry an operator_action (existing or provided here).
  if p_move_to_needs_operator then
    if v_current.status not in ('Agent Done', 'Agent Review') then
      raise exception 'admin_amend_agent_task can only move Agent Done or Agent Review tasks to Needs Operator; task % is %', p_task_id, v_current.status
        using errcode = '22023';
    end if;
    v_effective_operator_action := coalesce(
      nullif(trim(coalesce(p_set_operator_action, '')), ''),
      nullif(trim(coalesce(v_current.operator_action, '')), '')
    );
    if v_effective_operator_action is null then
      raise exception 'Moving task % to Needs Operator requires an operator_action (pass p_set_operator_action or have one already set)', p_task_id
        using errcode = '22023';
    end if;
  end if;

  -- Append sources, skipping any entry already present (not-already-present guard).
  v_new_sources := coalesce(v_current.sources, '[]'::jsonb);
  if p_add_sources is not null then
    if jsonb_typeof(p_add_sources) <> 'array' then
      raise exception 'p_add_sources must be a JSON array' using errcode = '22023';
    end if;
    for v_elem in select * from jsonb_array_elements(p_add_sources)
    loop
      if not (v_new_sources @> jsonb_build_array(v_elem)) then
        v_new_sources := v_new_sources || jsonb_build_array(v_elem);
      end if;
    end loop;
  end if;

  v_target_status := case
    when p_move_to_needs_operator then 'Needs Operator'
    else v_current.status
  end;

  update public.agent_tasks
  set
    project_slug = coalesce(nullif(trim(coalesce(p_set_project_slug, '')), ''), project_slug),
    sources = v_new_sources,
    operator_action = coalesce(nullif(trim(coalesce(p_set_operator_action, '')), ''), operator_action),
    operator_target = coalesce(nullif(trim(coalesce(p_set_operator_target, '')), ''), operator_target),
    requires_local = coalesce(p_set_requires_local, requires_local),
    status = v_target_status,
    completed_at = case when p_move_to_needs_operator then null else completed_at end,
    claimed_by = case when p_release_claim then null else claimed_by end,
    claim_token = case when p_release_claim then null else claim_token end,
    claim_expires_at = case when p_release_claim then null else claim_expires_at end
  where id = p_task_id
  returning * into v_task;

  v_event_type := case when p_move_to_needs_operator then 'AGENT NEEDS OPERATOR' else 'AGENT STATUS' end;

  insert into public.agent_task_events (task_id, event_type, agent_code, payload)
  values (
    p_task_id,
    v_event_type,
    v_task.agent_code,
    jsonb_strip_nulls(jsonb_build_object(
      'action', 'ops-amend',
      'reason', p_reason,
      'actor', nullif(trim(coalesce(p_actor, '')), ''),
      'from_status', v_current.status,
      'status', v_target_status,
      'released_claim', case when p_release_claim then true else null end,
      'set_project_slug', nullif(trim(coalesce(p_set_project_slug, '')), ''),
      'set_operator_action', nullif(trim(coalesce(p_set_operator_action, '')), ''),
      'set_operator_target', nullif(trim(coalesce(p_set_operator_target, '')), ''),
      'set_requires_local', p_set_requires_local,
      'added_sources', case
        when p_add_sources is not null and jsonb_array_length(p_add_sources) > 0 then p_add_sources
        else null
      end
    ))
  );

  return v_task;
end;
$$;

revoke execute on function public.admin_amend_agent_task(uuid, text, text, text, jsonb, text, text, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.admin_amend_agent_task(uuid, text, text, text, jsonb, text, text, boolean, boolean, boolean) to service_role;

notify pgrst, 'reload schema';
