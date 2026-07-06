-- Post-Audit Remediation Program Session 3: OE hardening batch.
--
-- Consolidates the seven H-* and hygiene fixes surfaced by
-- docs/audits/2026-07-02-open-brain-open-engine-full-audit.md:
--
--   1. H-STATE: move_agent_task_status enforces FROM state per the build-plan
--      receipt table. Prevents AGENT DONE / AGENT BLOCKED / AGENT HUMAN HOLD
--      from bypassing Agent Working.
--   2. Re-apply the missing REVOKE on claim_next_agent_task(text, text).
--      Dropped in 20260629150236 without re-applying, so the two-arg claim
--      helper is currently EXECUTE-granted to PUBLIC.
--   3. Event log is history: REVOKE UPDATE ON agent_task_events FROM
--      service_role, plus a belt-and-suspenders BEFORE UPDATE trigger that
--      raises on any leftover path.
--   4. promote_agent_task_intake writes a permanent AGENT STATUS audit event
--      and preserves pre-granted explicit_approval instead of silently
--      stripping it.
--   5. apply_agent_task_review reports honestly whether the linked action
--      item was resolved (resolved / already_closed / not_linked / not_requested).
--   6. release_expired_agent_claims() reaper: recover expired non-archived
--      claims by writing AGENT FAILED, bumping attempt_count, clearing claim,
--      and returning the task to Agent Todo. NOT yet scheduled -- Session 4
--      wires it into the runner heartbeat.
--   7. agent_tasks.archived_at + claim_next_agent_task/reaper exclude archived
--      rows so smoke-row hygiene can happen without reaper flow back to Todo.
--
-- Mirror rule note: none of these changes affect the LAYER 2/auto-resolve/
-- metadata blocks. No ingest-thought <-> open-brain-mcp mirror needed.
-- The MCP TypeScript layer continues to call these functions unchanged.

-- ---------------------------------------------------------------------------
-- 7. Board hygiene column: archived_at (defined first because 6 and 1 read it)
-- ---------------------------------------------------------------------------

alter table public.agent_tasks
  add column if not exists archived_at timestamptz;

comment on column public.agent_tasks.archived_at is
  'Set to now() to archive smoke or superseded rows. '
  'Archived rows are excluded from claim_next_agent_task, '
  'release_expired_agent_claims, and dashboard default views.';

create index if not exists agent_tasks_archived_at_idx
  on public.agent_tasks (archived_at)
  where archived_at is null;

-- ---------------------------------------------------------------------------
-- 1. H-STATE: FROM state validation in move_agent_task_status
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
  if p_status not in ('Standing','Agent Todo','Agent Working','Agent Needs Input','Agent Review','Agent Done') then
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

  -- FROM-state matrix per the build plan receipt table (H-STATE).
  v_valid_from_state := case
    -- Agent Working <- Agent Needs Input via resume/unblock/human-answer
    when p_status = 'Agent Working'
      and p_event_type in ('AGENT RESUMED','AGENT UNBLOCKED','AGENT HUMAN ANSWERED')
      then v_current.status = 'Agent Needs Input'

    -- Agent Working same-status STATUS heartbeat
    when p_status = 'Agent Working' and p_event_type = 'AGENT STATUS'
      then v_current.status = 'Agent Working'

    -- Agent Needs Input <- Agent Working via block/hold/fail
    when p_status = 'Agent Needs Input'
      and p_event_type in ('AGENT BLOCKED','AGENT HUMAN HOLD','AGENT FAILED')
      then v_current.status = 'Agent Working'

    -- Agent Review <- Agent Working via AGENT DONE
    when p_status = 'Agent Review' and p_event_type = 'AGENT DONE'
      then v_current.status = 'Agent Working'

    -- Agent Done <- Agent Review via AGENT APPLIED
    when p_status = 'Agent Done' and p_event_type = 'AGENT APPLIED'
      then v_current.status = 'Agent Review'

    -- Agent Todo <- Agent Working via AGENT FAILED retry (reaper path)
    when p_status = 'Agent Todo' and p_event_type = 'AGENT FAILED'
      then v_current.status = 'Agent Working'

    -- Agent Todo <- live states via AGENT FOLLOW-UP
    when p_status = 'Agent Todo' and p_event_type = 'AGENT FOLLOW-UP'
      then v_current.status in ('Agent Working','Agent Needs Input','Agent Review','Agent Done')

    -- Standing <- live states via AGENT STATUS (manual demotion, Session 262 pattern)
    when p_status = 'Standing' and p_event_type = 'AGENT STATUS'
      then v_current.status in ('Agent Todo','Agent Working','Agent Needs Input','Agent Review','Standing')

    -- Same-status heartbeats (STATUS, FOLLOW-UP, skill receipts)
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
-- 2. Re-apply missing REVOKE on claim_next_agent_task(text, text)
-- ---------------------------------------------------------------------------

revoke execute on function public.claim_next_agent_task(text, text) from public, anon, authenticated;
grant execute on function public.claim_next_agent_task(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Event log is history: revoke UPDATE + belt-and-suspenders trigger
-- ---------------------------------------------------------------------------

revoke update on public.agent_task_events from service_role;

create or replace function public.reject_agent_task_event_update()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'agent_task_events is append-only; UPDATE not permitted'
    using errcode = '42501';
end;
$$;

drop trigger if exists reject_agent_task_event_update on public.agent_task_events;
create trigger reject_agent_task_event_update
  before update on public.agent_task_events
  for each row execute function public.reject_agent_task_event_update();

-- ---------------------------------------------------------------------------
-- 4. Promotion helper: audit event + preserve pre-granted approval
-- ---------------------------------------------------------------------------

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
    completed_at = null,
    blocked_reason = null,
    review_reason = null,
    -- Preserve pre-granted approval instead of silently stripping to false.
    explicit_approval = v_current.explicit_approval,
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

  -- Permanent audit event using existing AGENT STATUS vocabulary
  -- (receipt vocabulary is closed per the program-plan Global Constraints).
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
      'prior_explicit_approval', v_prior_approval
    ))
  );

  return v_task;
end;
$$;

revoke execute on function public.promote_agent_task_intake(uuid, text, text) from public, anon, authenticated;
grant execute on function public.promote_agent_task_intake(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. apply_agent_task_review: honest linked-action-item outcome
-- ---------------------------------------------------------------------------

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
  v_action_outcome text := 'not_requested';
  v_updated_action int := 0;
begin
  if p_resolution not in ('accepted','accepted_with_follow_up') then
    raise exception 'Invalid review resolution: %', p_resolution
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

  -- H-APPLY-HONESTY: report the real linked-action outcome instead of
  -- silently no-oping when the item is missing or already resolved.
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
    'AGENT APPLIED',
    v_current.claimed_by,
    jsonb_strip_nulls(jsonb_build_object(
      'status', 'Agent Done',
      'from_status', 'Agent Review',
      'applied_by', nullif(trim(coalesce(p_applied_by, '')), ''),
      'resolution', p_resolution,
      'note', nullif(trim(coalesce(p_note, '')), ''),
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

-- ---------------------------------------------------------------------------
-- 6. Claim reaper: release expired non-archived claims
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
begin
  for v_row in
    select id, claimed_by, claim_expires_at
    from public.agent_tasks
    where status = 'Agent Working'
      and claim_expires_at is not null
      and claim_expires_at < now()
      and archived_at is null
    for update skip locked
  loop
    update public.agent_tasks
    set
      status = 'Agent Todo',
      claimed_at = null,
      claimed_by = null,
      claim_expires_at = null,
      blocked_reason = null,
      review_reason = null,
      attempt_count = agent_tasks.attempt_count + 1,
      last_failed_at = now(),
      last_failure_reason = 'claim expired'
    where id = v_row.id
    returning agent_tasks.attempt_count into v_new_attempt_count;

    insert into public.agent_task_events (task_id, event_type, agent_code, payload)
    values (
      v_row.id,
      'AGENT FAILED',
      v_row.claimed_by,
      jsonb_strip_nulls(jsonb_build_object(
        'status', 'Agent Todo',
        'from_status', 'Agent Working',
        'reason', 'claim expired',
        'reaped_by', 'release_expired_agent_claims',
        'claim_expired_at', v_row.claim_expires_at
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
-- 7. claim_next_agent_task: skip archived rows
-- ---------------------------------------------------------------------------

create or replace function public.claim_next_agent_task(
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

notify pgrst, 'reload schema';
