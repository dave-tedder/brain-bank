-- OE: release_claim must fold Needs Input/Review back to Agent Todo AND clear
-- agent_code, or the "honest cross-runtime handoff" the verb advertises is
-- impossible.
--
-- Two halves of one bug, both found on live state:
--
-- 1. THE ORPHAN. Releasing a claim on an Agent Needs Input / Agent Review task
--    left a row no verb could reach: answer/resume/unblock require a claim or
--    agent_code assignment (the release just cleared the claim),
--    claim_specific_agent_task requires Agent Todo, the reaper only reaps Agent
--    Working, and move_to_needs_operator requires Done/Review. For those two
--    statuses the claim IS what makes the status reachable, so releasing it must
--    fold the task back to Agent Todo in the same transaction. The same lock has
--    a passive form: an EXPIRED claim on an Agent Needs Input row, which the
--    reaper never looks at (one real row sat stranded 11 days).
--
-- 2. THE LANE LOCK. Folding alone was NOT sufficient. agent_code survived the
--    release, so claim_specific_agent_task still refused every other runtime
--    ("Task <id> is assigned to agent_code <lane>, not <other-lane>") and
--    answer/resume still gated on the claiming lane. The only ways through were
--    posting as the original lane (false runtime attribution) or raw SQL -- the
--    two outcomes this ops-correction verb exists to prevent. So a release also
--    clears agent_code, returning the row to the shared pool (the OE-9 default:
--    drafts are born unassigned).
--
-- agent_code is cleared on ANY release_claim, not only on the fold path: a
-- release on an already-folded row (status Agent Todo) must still hand off, and
-- that is the common repair shape.
--
-- Deliberately does NOT copy the old agent_code into preferred_agent: preferring
-- the lane that just released the task contradicts the purpose of a handoff and
-- would send the same lane back at work it could not finish. The cleared value is
-- recorded in the audit event as released_from_agent_code instead.
--
-- move_to_needs_operator keeps precedence over the fold: it is evaluated first in
-- v_target_status, so an explicit desk move still wins.
--
-- Copied forward verbatim from 20260715_oe_ops_verbs_c2_c3.sql except for the
-- fold, the agent_code clear, and the two new audit fields.

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
  v_folded_to_todo boolean;
  v_released_agent_code text;
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

  -- The fold: releasing a claim on a human-facing status returns the row to the
  -- claim pool instead of orphaning it. move_to_needs_operator keeps precedence.
  v_folded_to_todo := coalesce(p_release_claim, false)
    and not coalesce(p_move_to_needs_operator, false)
    and v_current.status in ('Agent Needs Input', 'Agent Review');

  v_target_status := case
    when p_move_to_needs_operator then 'Needs Operator'
    when v_folded_to_todo then 'Agent Todo'
    else v_current.status
  end;

  -- The lane lock: a release that leaves agent_code set is not a handoff, since
  -- every other runtime is refused at claim time. Record what was cleared.
  v_released_agent_code := case
    when coalesce(p_release_claim, false) then v_current.agent_code
    else null
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
    agent_code = case when p_release_claim then null else agent_code end,
    claimed_by = case when p_release_claim then null else claimed_by end,
    claim_token = case when p_release_claim then null else claim_token end,
    claim_expires_at = case when p_release_claim then null else claim_expires_at end
  where id = p_task_id
  returning * into v_task;

  v_event_type := case when p_move_to_needs_operator then 'AGENT NEEDS OPERATOR' else 'AGENT STATUS' end;

  -- agent_code on the event is the lane the row is LEAVING, not null, so the
  -- audit trail still names who held it when the handoff happened.
  insert into public.agent_task_events (task_id, event_type, agent_code, payload)
  values (
    p_task_id,
    v_event_type,
    coalesce(v_task.agent_code, v_released_agent_code),
    jsonb_strip_nulls(jsonb_build_object(
      'action', 'ops-amend',
      'reason', p_reason,
      'actor', nullif(trim(coalesce(p_actor, '')), ''),
      'from_status', v_current.status,
      'status', v_target_status,
      'released_claim', case when p_release_claim then true else null end,
      'released_to_status', case when v_folded_to_todo then 'Agent Todo' else null end,
      'released_from_agent_code', v_released_agent_code,
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
