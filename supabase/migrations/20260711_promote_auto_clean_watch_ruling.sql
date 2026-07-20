-- OE Phase-4 readiness streak: auto-record a clean watch ruling when a triage
-- draft is promoted, so the streak reflects the operator's promote decision
-- without a separate manual oe_watch_rulings insert (which used to lag, leaving
-- the newest day PENDING_REVIEW and the streak reading 0 even after the drafts
-- were promoted).
--
-- Added to promote_agent_task_intake, at the end, only for
-- intake_source = 'triage-agent' drafts:
--   * Compute the draft's ET creation day (the watch_date the view groups on).
--   * Auto-write a 'clean' ruling ONLY when this promote clears the LAST still-
--     Standing triage draft for that day AND none of that day's triage drafts
--     were archived (an archived-unpromoted draft is an ambiguous/dirty signal
--     left for a manual ruling).
--   * on conflict (watch_date) do nothing -> never overrides an existing
--     manual ruling; only clean is ever auto-written.

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
  v_watch_date date;
  v_pending_same_day integer;
  v_archived_same_day integer;
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

  -- OE Phase-4: auto-clean watch ruling for a fully-promoted triage day.
  if v_task.intake_source = 'triage-agent' then
    v_watch_date := (v_task.created_at at time zone 'America/New_York')::date;

    select count(*)
      into v_pending_same_day
    from public.agent_tasks t
    where t.intake_source = 'triage-agent'
      and (t.created_at at time zone 'America/New_York')::date = v_watch_date
      and t.id <> v_task.id
      and t.status = 'Standing'
      and t.archived_at is null;

    select count(*)
      into v_archived_same_day
    from public.agent_tasks t
    where t.intake_source = 'triage-agent'
      and (t.created_at at time zone 'America/New_York')::date = v_watch_date
      and t.archived_at is not null;

    if v_pending_same_day = 0 and v_archived_same_day = 0 then
      insert into public.oe_watch_rulings (watch_date, verdict, ruled_by, note)
      values (
        v_watch_date,
        'clean',
        'promote-auto',
        'Auto-ruled clean: all triage drafts for this day promoted to Agent Todo (last via task ' || p_task_id::text || ').'
      )
      on conflict (watch_date) do nothing;
    end if;
  end if;

  return v_task;
end;
$$;
