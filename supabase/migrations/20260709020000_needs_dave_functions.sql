-- OE-11 Phase 2: operator-action routing for the apply gate + operator close
-- + the Needs Dave reroute escape hatch.
--
-- Base: the LIVE apply_agent_task_review from 20260702_oe_hardening_batch.sql
-- (archived-task guard + H-APPLY-HONESTY linked-action outcome reporting),
-- NOT the older OE-7 version. Do not regress either behavior.
--
-- The old 7-arg signature is DROPPED first: create-or-replace with two new
-- params would CREATE AN OVERLOAD (Postgres treats a new arg list as a new
-- function), and PostgREST named-arg calls that match both fail with "could
-- not choose the best candidate function". Precedent:
-- 20260629150236_oe5_drop_legacy_claim_overload.sql. With only the 9-arg
-- function present, existing 7-named-arg callers resolve via the defaults,
-- so there is no deploy-gap breakage.

drop function if exists public.apply_agent_task_review(uuid, text, text, text, boolean, uuid[], jsonb);

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
  v_needs_dave boolean := v_operator_action is not null;
  v_target_status text;
begin
  if p_resolution not in ('accepted', 'accepted_with_follow_up') then
    raise exception 'Invalid review resolution: %', p_resolution using errcode = '22023';
  end if;

  select * into v_current from public.agent_tasks where id = p_task_id for update;
  if not found then
    raise exception 'Task not found: %', p_task_id using errcode = 'P0002';
  end if;
  if v_current.archived_at is not null then
    raise exception 'Task % is archived; cannot apply review', p_task_id using errcode = '22023';
  end if;
  if v_current.status <> 'Agent Review' then
    raise exception 'AGENT APPLIED requires Agent Review.' using errcode = '22023';
  end if;

  -- A Needs-Dave routing keeps the linked action item OPEN (it is not done
  -- until the operator's hands-on step lands via complete_operator_action).
  if v_needs_dave and p_resolve_linked_action_item then
    raise exception 'Cannot resolve a linked action item while routing to Needs Dave; the operator step is still open.'
      using errcode = '22023';
  end if;
  if p_resolve_linked_action_item and p_resolution <> 'accepted' then
    raise exception 'Linked action item can only be resolved when review resolution is accepted.'
      using errcode = '22023';
  end if;
  if p_resolution = 'accepted_with_follow_up' and cardinality(v_child_ids) = 0 then
    raise exception 'accepted_with_follow_up requires at least one child task.' using errcode = '22023';
  end if;
  if cardinality(v_child_ids) > 0 then
    select count(*) into v_child_count
    from public.agent_tasks
    where id = any(v_child_ids) and parent_task_id = p_task_id and status = 'Standing';
    if v_child_count <> cardinality(v_child_ids) then
      raise exception 'Every child task must be a Standing draft linked to the reviewed parent task.'
        using errcode = '22023';
    end if;
  end if;

  v_target_status := case when v_needs_dave then 'Needs Dave' else 'Agent Done' end;

  update public.agent_tasks
  set
    status = v_target_status,
    completed_at = case when v_needs_dave then null else now() end,
    claimed_at = null,
    claimed_by = null,
    claim_expires_at = null,
    blocked_reason = null,
    operator_action = case when v_needs_dave then v_operator_action else operator_action end,
    operator_target = case when v_needs_dave then nullif(trim(coalesce(p_operator_target,'')),'') else operator_target end,
    review_reason = coalesce(nullif(trim(p_note), ''), review_reason),
    updated_at = now()
  where id = p_task_id
  returning * into v_task;

  -- H-APPLY-HONESTY (from 20260702_oe_hardening_batch): report the real
  -- linked-action outcome instead of silently no-oping. Unreachable when
  -- v_needs_dave (guarded above), so a Needs Dave routing reports 'not_requested'.
  if p_resolve_linked_action_item then
    if v_current.linked_action_item_id is null then
      v_action_outcome := 'not_linked';
    else
      update public.action_items set status = 'resolved', resolved_at = now()
      where id = v_current.linked_action_item_id and status = 'open';
      get diagnostics v_updated_action = row_count;
      v_action_outcome := case when v_updated_action = 1 then 'resolved' else 'already_closed' end;
    end if;
  end if;

  insert into public.agent_task_events (task_id, event_type, agent_code, payload)
  values (
    p_task_id,
    case when v_needs_dave then 'AGENT NEEDS DAVE' else 'AGENT APPLIED' end,
    v_current.claimed_by,
    jsonb_strip_nulls(jsonb_build_object(
      'status', v_target_status,
      'from_status', 'Agent Review',
      'applied_by', nullif(trim(coalesce(p_applied_by, '')), ''),
      'resolution', p_resolution,
      'note', nullif(trim(coalesce(p_note, '')), ''),
      'operator_action', v_operator_action,
      'operator_target', nullif(trim(coalesce(p_operator_target,'')),''),
      'resolve_linked_action_item_requested', p_resolve_linked_action_item,
      'linked_action_item_id', v_current.linked_action_item_id,
      'linked_action_item_outcome', v_action_outcome,
      'child_task_ids', to_jsonb(v_child_ids),
      'closeout_evidence', coalesce(p_closeout_evidence, '{}'::jsonb)
    ))
  );

  return v_task;
end;
$$;

revoke execute on function public.apply_agent_task_review(uuid,text,text,text,boolean,uuid[],jsonb,text,text) from public, anon, authenticated;
grant execute on function public.apply_agent_task_review(uuid,text,text,text,boolean,uuid[],jsonb,text,text) to service_role;

-- Operator close: Needs Dave -> Agent Done, one OPERATOR DONE receipt,
-- resolves the linked action item if still open.
create or replace function public.complete_operator_action(
  p_task_id uuid,
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
begin
  select * into v_current from public.agent_tasks where id = p_task_id for update;
  if not found then
    raise exception 'Task not found: %', p_task_id using errcode = 'P0002';
  end if;
  if v_current.archived_at is not null then
    raise exception 'Task % is archived; cannot complete operator action', p_task_id using errcode = '22023';
  end if;
  if v_current.status <> 'Needs Dave' then
    raise exception 'complete_operator_action requires status Needs Dave (got %).', v_current.status
      using errcode = '22023';
  end if;

  -- operator_action / operator_target are deliberately RETAINED after close
  -- (audit trail); the OPERATOR DONE payload records them too.
  update public.agent_tasks
  set status = 'Agent Done', completed_at = now(), updated_at = now()
  where id = p_task_id
  returning * into v_task;

  insert into public.agent_task_events (task_id, event_type, agent_code, payload)
  values (
    p_task_id, 'OPERATOR DONE', null,
    jsonb_strip_nulls(jsonb_build_object(
      'status', 'Agent Done',
      'operator_action', v_current.operator_action,
      'operator_target', v_current.operator_target,
      'note', nullif(trim(coalesce(p_note, '')), '')
    ))
  );

  if v_current.linked_action_item_id is not null then
    update public.action_items set status = 'resolved', resolved_at = now()
    where id = v_current.linked_action_item_id and status = 'open';
  end if;

  return v_task;
end;
$$;

revoke execute on function public.complete_operator_action(uuid,text) from public, anon, authenticated;
grant execute on function public.complete_operator_action(uuid,text) to service_role;

-- Reroute escape hatch: a misrouted Needs Dave card goes back to the executor
-- queue instead of being falsely closed as done. The generic
-- move_agent_task_status (live: 20260702_oe_hardening_batch.sql) hardcodes the
-- six pre-OE-11 statuses and its transition matrix, so it cannot touch
-- Needs Dave; this function is the ONLY exit besides complete_operator_action.
-- The linked action item stays open.
create or replace function public.reroute_needs_dave_task(
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
    raise exception 'reroute_needs_dave_task requires a reason.' using errcode = '22023';
  end if;

  select * into v_current from public.agent_tasks where id = p_task_id for update;
  if not found then
    raise exception 'Task not found: %', p_task_id using errcode = 'P0002';
  end if;
  if v_current.status <> 'Needs Dave' then
    raise exception 'reroute_needs_dave_task requires status Needs Dave (got %).', v_current.status
      using errcode = '22023';
  end if;

  update public.agent_tasks
  set status = 'Agent Todo',
      operator_action = null,
      operator_target = null,
      updated_at = now()
  where id = p_task_id
  returning * into v_task;

  insert into public.agent_task_events (task_id, event_type, agent_code, payload)
  values (
    p_task_id, 'AGENT FOLLOW-UP', null,
    jsonb_strip_nulls(jsonb_build_object(
      'status', 'Agent Todo',
      'from_status', 'Needs Dave',
      'reason', v_reason,
      'source', 'reroute_needs_dave_task'
    ))
  );

  return v_task;
end;
$$;

revoke execute on function public.reroute_needs_dave_task(uuid,text) from public, anon, authenticated;
grant execute on function public.reroute_needs_dave_task(uuid,text) to service_role;

notify pgrst, 'reload schema';
