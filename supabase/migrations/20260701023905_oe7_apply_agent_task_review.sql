-- OE-7: explicit review/apply gate for task-board work.
-- This keeps Agent Review as the human/apply checkpoint and prevents linked
-- action-item resolution from happening during claim, intake, or agent done.

create or replace function public.apply_agent_task_review(
  p_task_id uuid,
  p_applied_by text,
  p_resolution text,
  p_note text,
  p_resolve_linked_action_item boolean,
  p_child_task_ids uuid[] default '{}'::uuid[],
  p_closeout_evidence jsonb default '{}'::jsonb
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
begin
  if p_resolution not in ('accepted', 'accepted_with_follow_up') then
    raise exception 'Invalid review resolution: %', p_resolution
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

  if v_current.status <> 'Agent Review' then
    raise exception 'AGENT APPLIED requires Agent Review.'
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
    select count(*)
    into v_child_count
    from public.agent_tasks
    where id = any(v_child_ids)
      and parent_task_id = p_task_id
      and status = 'Standing';

    if v_child_count <> cardinality(v_child_ids) then
      raise exception 'Every child task must be a Standing draft linked to the reviewed parent task.'
        using errcode = '22023';
    end if;
  end if;

  update public.agent_tasks
  set
    status = 'Agent Done',
    completed_at = now(),
    claimed_at = null,
    claimed_by = null,
    claim_expires_at = null,
    blocked_reason = null,
    review_reason = coalesce(nullif(trim(p_note), ''), review_reason),
    updated_at = now()
  where id = p_task_id
  returning * into v_task;

  insert into public.agent_task_events (
    task_id,
    event_type,
    agent_code,
    payload
  )
  values (
    p_task_id,
    'AGENT APPLIED',
    v_current.claimed_by,
    jsonb_strip_nulls(jsonb_build_object(
      'status', 'Agent Done',
      'applied_by', nullif(trim(coalesce(p_applied_by, '')), ''),
      'resolution', p_resolution,
      'note', nullif(trim(coalesce(p_note, '')), ''),
      'resolved_linked_action_item', p_resolve_linked_action_item,
      'child_task_ids', to_jsonb(v_child_ids),
      'closeout_evidence', coalesce(p_closeout_evidence, '{}'::jsonb)
    ))
  );

  if p_resolve_linked_action_item and v_current.linked_action_item_id is not null then
    update public.action_items
    set
      status = 'resolved',
      resolved_at = now()
    where id = v_current.linked_action_item_id
      and status = 'open';
  end if;

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
  jsonb
) from public, anon, authenticated;

grant execute on function public.apply_agent_task_review(
  uuid,
  text,
  text,
  text,
  boolean,
  uuid[],
  jsonb
) to service_role;

notify pgrst, 'reload schema';
