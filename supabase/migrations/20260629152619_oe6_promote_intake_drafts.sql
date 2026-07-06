-- OE-6 review follow-up: add an explicit human-controlled promotion path for
-- draft intake records. Intake itself creates Standing records only; this
-- helper is the narrow code path that makes one draft eligible for Queue Runner
-- claim by moving it to Agent Todo.

create or replace function public.promote_agent_task_intake(
  p_task_id uuid,
  p_promoted_by text,
  p_note text
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
  select *
  into v_current
  from public.agent_tasks
  where id = p_task_id
  for update;

  if not found then
    raise exception 'Task not found: %', p_task_id
      using errcode = 'P0002';
  end if;

  if v_current.status <> 'Standing' then
    raise exception 'Only Standing intake drafts can be promoted to Agent Todo'
      using errcode = '22023';
  end if;

  update public.agent_tasks
  set
    status = 'Agent Todo',
    claimed_at = null,
    claimed_by = null,
    claim_expires_at = null,
    completed_at = null,
    blocked_reason = null,
    review_reason = null,
    explicit_approval = false,
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

  return v_task;
end;
$$;

revoke execute on function public.promote_agent_task_intake(uuid, text, text) from public, anon, authenticated;
grant execute on function public.promote_agent_task_intake(uuid, text, text) to service_role;

notify pgrst, 'reload schema';
