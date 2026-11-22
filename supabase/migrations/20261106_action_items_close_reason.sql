-- Loop-closing Task 3.1 (C1): every close carries a reason and a time, every
-- status change writes one append-only event, and closed items can be reopened
-- with their old evidence preserved in that event.
--
-- Rollout order: this migration first, then the Edge Functions that call the
-- RPCs. The deployed functions keep working on top of this schema; their direct
-- updates simply record actor 'sql' until they are replaced.
--
-- Rollback is consumer-first. Redeploy the prior functions, then in one
-- transaction restore both card verbs from 20260710_oe_hardening_batch_3_critic_flags_fix.sql
-- as read back from production; drop the four RPCs below; drop the triggers
-- action_items_set_closed_at, action_items_record_status_event and
-- auto_resolve_decisions_stamp_generation with their functions; drop column
-- auto_resolve_decisions.item_generation; drop the three action_items CHECKs;
-- drop table action_item_events; drop the five new action_items columns.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

alter table public.action_items
  add column if not exists closed_at timestamptz null,
  add column if not exists close_reason text null,
  add column if not exists duplicate_of uuid null
    references public.action_items(id) on delete set null,
  add column if not exists reopened_at timestamptz null,
  add column if not exists reopen_generation integer not null default 0;

comment on column public.action_items.reopen_generation is
  'Task 3.1: incremented on every reopen and never reset. The generation boundary Task 3.6 reads. A timestamp cannot be this boundary because now() is the transaction timestamp, so a row written in the same transaction as a reopen carries exactly reopened_at on either side of it.';

-- ---------------------------------------------------------------------------
-- 2. Backfill, justified rows only. Runs before the triggers exist and changes
-- no status. Every other historical close keeps close_reason null, which
-- closed_by_week_and_path reports as unknown.
-- ---------------------------------------------------------------------------

update public.action_items
set closed_at = resolved_at
where status in ('resolved', 'archived') and resolved_at is not null;

update public.action_items
set close_reason = 'done'
where status in ('resolved', 'archived') and resolved_by_thought_id is not null;

update public.action_items
set close_reason = 'fragment'
where status = 'archived'
  and resolution_note like 'Chief of Staff sweep 2026-11-03 (the operator''s direction): archived as a fragment%';

update public.action_items
set close_reason = 'done'
where status in ('resolved', 'archived')
  and resolution_note like 'Chief of Staff sweep 2026-11-03%'
  and resolution_note like '%verified done%';

-- ---------------------------------------------------------------------------
-- 3. Invariants. The RPCs enforce the same rules with named messages; these are
-- the backstop for a direct write.
-- ---------------------------------------------------------------------------

alter table public.action_items
  add constraint action_items_close_reason_known check (
    close_reason is null
    or close_reason in ('done', 'superseded', 'duplicate', 'fragment', 'expired', 'wont_do')
  ),
  add constraint action_items_close_reason_only_when_closed check (
    close_reason is null or status in ('resolved', 'archived')
  ),
  -- One direction only: on delete set null must be able to clear duplicate_of
  -- when a survivor is hard-deleted, leaving close_reason = 'duplicate' with no
  -- survivor. IS NOT DISTINCT FROM, because a plain = returns SQL NULL for a
  -- populated survivor with a null reason, and a CHECK accepts NULL.
  add constraint action_items_duplicate_of_consistent check (
    duplicate_of is null
    or (close_reason is not distinct from 'duplicate' and duplicate_of <> id)
  );

create index if not exists action_items_duplicate_of_idx
  on public.action_items (duplicate_of) where duplicate_of is not null;

-- ---------------------------------------------------------------------------
-- 4. The event table. Append-only means callers cannot change it: only the
-- trigger writes it, and no role is granted update or delete.
--
-- Retention limitation: it is NOT an immutable audit trail. item_id cascades, so a
-- hard-deleted item takes its events with it, the same choice
-- auto_resolve_decisions makes, so probe rows can be cleaned up. Nothing in this
-- task hard-deletes an item, and status changes never do. Anything that must
-- outlive a hard delete has to be copied out first.
-- ---------------------------------------------------------------------------

create table public.action_item_events (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.action_items(id) on delete cascade,
  at timestamptz not null default now(),
  actor text not null,
  old_status text not null,
  new_status text not null,
  close_reason text null,
  note text null,
  evidence_thought_id uuid null references public.thoughts(id) on delete set null,
  payload jsonb null
);

create index action_item_events_item_at_idx on public.action_item_events (item_id, at desc);
create index action_item_events_at_idx on public.action_item_events (at desc);
create index action_item_events_evidence_idx on public.action_item_events (evidence_thought_id)
  where evidence_thought_id is not null;

alter table public.action_item_events enable row level security;
create policy "Service role full access on action_item_events"
  on public.action_item_events for all
  using (auth.role() = 'service_role'::text);

revoke all on table public.action_item_events from public, anon, authenticated, service_role;
grant select on table public.action_item_events to service_role;

comment on table public.action_item_events is
  'Task 3.1: one row per action_items status change, written by a trigger. actor = sql means a write reached the trigger with no actor set, which the loop-closing measure counts as a defect. Callers cannot update or delete rows, but a hard delete of the item cascades here, so this is not an immutable audit trail across item deletion.';

-- ---------------------------------------------------------------------------
-- 5. Triggers
-- ---------------------------------------------------------------------------

-- The single clearing mechanism: the RPCs write forward and this resets, so a
-- raw status update is covered the same way an RPC is.
create or replace function public.action_items_set_closed_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if new.status in ('resolved', 'archived') then
    new.closed_at := coalesce(new.closed_at, now());
  end if;
  if old.status in ('resolved', 'archived') and new.status not in ('resolved', 'archived') then
    new.closed_at := null;
    new.close_reason := null;
    new.resolved_at := null;
    new.resolved_by_thought_id := null;
    new.resolution_note := null;
    new.duplicate_of := null;
    new.reopened_at := now();
    new.reopen_generation := old.reopen_generation + 1;
  end if;
  if old.status = 'deferred' and new.status <> 'deferred' then
    new.deferred_at := null;
    new.defer_reason := null;
  end if;
  return new;
end;
$$;

drop trigger if exists action_items_set_closed_at on public.action_items;
create trigger action_items_set_closed_at
  before update on public.action_items
  for each row execute function public.action_items_set_closed_at();

-- AFTER, so old still holds what the BEFORE trigger cleared: a reopen event
-- carries the completion evidence the row no longer does. Security definer
-- because no caller holds insert on the table.
create or replace function public.action_items_record_status_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor text := coalesce(nullif(current_setting('app.actor', true), ''), 'sql');
  v_payload jsonb := nullif(current_setting('app.event_payload', true), '')::jsonb;
  v_evidence uuid := nullif(current_setting('app.evidence_thought_id', true), '')::uuid;
  v_extra jsonb;
begin
  if new.status is not distinct from old.status then
    return null;
  end if;

  if old.status in ('resolved', 'archived') and new.status not in ('resolved', 'archived') then
    v_extra := jsonb_strip_nulls(jsonb_build_object(
      'resolved_at', old.resolved_at,
      'closed_at', old.closed_at,
      'duplicate_of', old.duplicate_of,
      'previous_reopened_at', old.reopened_at,
      'reopen_generation', new.reopen_generation
    ));
    insert into public.action_item_events
      (item_id, actor, old_status, new_status, close_reason, note, evidence_thought_id, payload)
    values
      (new.id, v_actor, old.status, new.status, old.close_reason, old.resolution_note,
       old.resolved_by_thought_id, coalesce(v_payload, '{}'::jsonb) || v_extra);
  elsif new.status in ('resolved', 'archived') then
    v_extra := jsonb_strip_nulls(jsonb_build_object(
      'duplicate_of', new.duplicate_of,
      'defer_reason', case when old.status = 'deferred' then old.defer_reason end
    ));
    insert into public.action_item_events
      (item_id, actor, old_status, new_status, close_reason, note, evidence_thought_id, payload)
    values
      (new.id, v_actor, old.status, new.status, new.close_reason, new.resolution_note,
       coalesce(v_evidence, new.resolved_by_thought_id),
       case when v_extra = '{}'::jsonb then v_payload
            else coalesce(v_payload, '{}'::jsonb) || v_extra end);
  else
    insert into public.action_item_events
      (item_id, actor, old_status, new_status, note, evidence_thought_id, payload)
    values
      (new.id, v_actor, old.status, new.status,
       case when new.status = 'deferred' then new.defer_reason else old.defer_reason end,
       v_evidence, v_payload);
  end if;
  return null;
end;
$$;

revoke execute on function public.action_items_record_status_event() from public, anon, authenticated;

drop trigger if exists action_items_record_status_event on public.action_items;
create trigger action_items_record_status_event
  after update on public.action_items
  for each row execute function public.action_items_record_status_event();

-- ---------------------------------------------------------------------------
-- 6. The transition RPCs. set_config is transaction-local and runs in the same
-- transaction as the guarded update; a preceding RPC would live on whichever
-- pooled connection served it, which is why the actor cannot be set separately.
-- ---------------------------------------------------------------------------

create or replace function public.transition_action_item(
  p_item_id uuid,
  p_from_statuses text[],
  p_to_status text,
  p_actor text,
  p_close_reason text default null,
  p_resolution_note text default null,
  p_resolved_by_thought_id uuid default null,
  p_evidence_thought_id uuid default null,
  p_duplicate_of uuid default null,
  p_defer_reason text default null,
  p_event_payload jsonb default null
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor text := nullif(trim(coalesce(p_actor, '')), '');
  v_closing boolean := p_to_status in ('resolved', 'archived');
  v_defer_reason text := nullif(trim(coalesce(p_defer_reason, '')), '');
  v_affected integer;
begin
  if v_actor is null then
    raise exception 'transition_action_item requires an actor.' using errcode = '22023';
  end if;
  if p_to_status is null or p_to_status not in ('open', 'deferred', 'resolved', 'archived') then
    raise exception 'Unknown target status: %', p_to_status using errcode = '22023';
  end if;
  if p_from_statuses is null or cardinality(p_from_statuses) = 0 then
    raise exception 'transition_action_item requires p_from_statuses.' using errcode = '22023';
  end if;
  if p_to_status = any(p_from_statuses) then
    raise exception 'p_from_statuses must not include the target status % (no event would be written).', p_to_status
      using errcode = '22023';
  end if;
  if v_closing and nullif(trim(coalesce(p_close_reason, '')), '') is null then
    raise exception 'A close to % requires p_close_reason.', p_to_status using errcode = '22023';
  end if;
  if not v_closing and p_close_reason is not null then
    raise exception 'p_close_reason is only legal on a close.' using errcode = '22023';
  end if;
  if p_close_reason = 'duplicate' then
    if p_duplicate_of is null then
      raise exception 'close_reason duplicate requires p_duplicate_of.' using errcode = '22023';
    end if;
    if p_duplicate_of = p_item_id then
      raise exception 'An item cannot be a duplicate of itself.' using errcode = '22023';
    end if;
    if not exists (select 1 from public.action_items where id = p_duplicate_of) then
      raise exception 'Duplicate survivor not found: %', p_duplicate_of using errcode = 'P0002';
    end if;
  elsif p_duplicate_of is not null then
    raise exception 'p_duplicate_of is only legal with close_reason duplicate.' using errcode = '22023';
  end if;
  if p_to_status = 'deferred' and v_defer_reason is null then
    raise exception 'A defer requires p_defer_reason.' using errcode = '22023';
  end if;
  if p_to_status <> 'deferred' and v_defer_reason is not null then
    raise exception 'p_defer_reason is only legal on a defer.' using errcode = '22023';
  end if;

  perform set_config('app.actor', v_actor, true);
  perform set_config('app.event_payload', coalesce(p_event_payload::text, ''), true);
  perform set_config('app.evidence_thought_id', coalesce(p_evidence_thought_id::text, ''), true);

  update public.action_items
  set
    status = p_to_status,
    close_reason = case when v_closing then p_close_reason else close_reason end,
    resolution_note = case when v_closing then p_resolution_note else resolution_note end,
    resolved_by_thought_id = case when v_closing then p_resolved_by_thought_id else resolved_by_thought_id end,
    resolved_at = case when p_to_status = 'resolved' then now() else resolved_at end,
    duplicate_of = case when v_closing then p_duplicate_of else duplicate_of end,
    deferred_at = case when p_to_status = 'deferred' then now() else deferred_at end,
    defer_reason = case when p_to_status = 'deferred' then v_defer_reason else defer_reason end
  where id = p_item_id
    and status = any(p_from_statuses);
  get diagnostics v_affected = row_count;
  return v_affected;
end;
$$;

revoke execute on function public.transition_action_item(uuid, text[], text, text, text, text, uuid, uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.transition_action_item(uuid, text[], text, text, text, text, uuid, uuid, uuid, text, jsonb)
  to service_role;

-- The unpause path: the deferred rows carrying exactly this tag when it takes its
-- locks, back to open, one transaction, one event per row. It can never reopen closed work, because
-- it touches deferred rows only. Multi-item writer, so it pre-locks in id order
-- (see record_decisions below for the contract).
--
-- The update is limited to the ids the pre-lock returned. READ COMMITTED gives each
-- statement its own snapshot, so re-running the tag predicate would also match a
-- row tagged and committed while the pre-lock waited: a row this writer never locked
-- in order, which can deadlock against another ordered writer. A row tagged after
-- the pre-lock's snapshot therefore stays deferred, and the return value counts only
-- what was restored, so it does not show that none remain; the next unpause of that
-- tag picks it up.
create or replace function public.transition_action_items_by_defer_reason(
  p_defer_reason text,
  p_actor text
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor text := nullif(trim(coalesce(p_actor, '')), '');
  v_reason text := nullif(trim(coalesce(p_defer_reason, '')), '');
  v_ids uuid[];
  v_affected integer;
begin
  if v_actor is null then
    raise exception 'transition_action_items_by_defer_reason requires an actor.' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'transition_action_items_by_defer_reason requires a defer reason.' using errcode = '22023';
  end if;

  select coalesce(array_agg(locked.id), '{}') into v_ids from (
    select id from public.action_items
    where status = 'deferred' and defer_reason = v_reason
    order by id
    for no key update
  ) locked;

  perform set_config('app.actor', v_actor, true);
  perform set_config('app.event_payload', '', true);
  perform set_config('app.evidence_thought_id', '', true);

  update public.action_items
  set status = 'open'
  where id = any(v_ids)
    and status = 'deferred' and defer_reason = v_reason;
  get diagnostics v_affected = row_count;
  return v_affected;
end;
$$;

revoke execute on function public.transition_action_items_by_defer_reason(text, text)
  from public, anon, authenticated;
grant execute on function public.transition_action_items_by_defer_reason(text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 7. The generation stamp on decision rows. The trigger, not the writer, stamps
-- it, so no producer can forget it or misstate it. FOR SHARE makes an insert
-- that starts while a reopen is uncommitted wait for the reopen and land in the
-- new generation. Generation 0 is the deployed epoch: rows from before this task
-- belong to it by definition and no earlier generation is reconstructed.
-- ---------------------------------------------------------------------------

alter table public.auto_resolve_decisions
  add column if not exists item_generation integer null;

update public.auto_resolve_decisions
set item_generation = 0
where item_id is not null and item_generation is null;

create or replace function public.auto_resolve_decisions_stamp_generation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.item_id is null then
    new.item_generation := null;
    return new;
  end if;
  select reopen_generation into new.item_generation
  from public.action_items
  where id = new.item_id
  for share;
  return new;
end;
$$;

drop trigger if exists auto_resolve_decisions_stamp_generation on public.auto_resolve_decisions;
create trigger auto_resolve_decisions_stamp_generation
  before insert on public.auto_resolve_decisions
  for each row execute function public.auto_resolve_decisions_stamp_generation();

-- The multi-item decision writer. Every writer that can touch two or more items
-- in one transaction locks the whole set first, in id order, FOR NO KEY UPDATE:
-- the mode a non-key update takes, so the stamping trigger's later FOR SHARE is a
-- re-lock inside the same transaction, and foreign-key checks from other
-- transactions stay unblocked. A CHECK failure on any row aborts the whole call,
-- which is the right fail-closed behaviour for an atomic writer.
create or replace function public.record_decisions(p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_inserted integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'record_decisions requires a json array.' using errcode = '22023';
  end if;

  perform 1 from (
    select a.id from public.action_items a
    where a.id in (
      select (r->>'item_id')::uuid from jsonb_array_elements(p_rows) r
      where r->>'item_id' is not null
    )
    order by a.id
    for no key update
  ) locked;

  insert into public.auto_resolve_decisions (
    thought_id, item_id, candidate_description, layer, reason, score, quote,
    related_item_id, evidence_thought_id, evidence_event_id, outcome
  )
  select
    r.thought_id, r.item_id, r.candidate_description, r.layer, r.reason, r.score, r.quote,
    r.related_item_id, r.evidence_thought_id, r.evidence_event_id, r.outcome
  from jsonb_to_recordset(p_rows) as r(
    thought_id uuid, item_id uuid, candidate_description text, layer text, reason text,
    score numeric, quote text, related_item_id uuid, evidence_thought_id uuid,
    evidence_event_id uuid, outcome text
  )
  order by r.item_id
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

revoke execute on function public.record_decisions(jsonb) from public, anon, authenticated;
grant execute on function public.record_decisions(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 8. The two card verbs, carried forward from the definitions read back from
-- production on 2026-11-06. Lines ending "-- T3.1+" are the only additions; the
-- harness strips them and compares the result to production's md5.
-- ---------------------------------------------------------------------------

create or replace function public.apply_agent_task_review(p_task_id uuid, p_applied_by text, p_resolution text, p_note text, p_resolve_linked_action_item boolean, p_child_task_ids uuid[] DEFAULT '{}'::uuid[], p_closeout_evidence jsonb DEFAULT '{}'::jsonb, p_operator_action text DEFAULT NULL::text, p_operator_target text DEFAULT NULL::text)
 returns public.agent_tasks
 language plpgsql
 set search_path to 'pg_catalog', 'public'
as $function$
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
      perform set_config('app.actor', coalesce(nullif(trim(coalesce(p_applied_by, '')), ''), 'apply_agent_task_review'), true); -- T3.1+
      perform set_config('app.event_payload', '', true); -- T3.1+
      perform set_config('app.evidence_thought_id', '', true); -- T3.1+
      update public.action_items
      set status = 'resolved', resolved_at = now()
        , close_reason = 'done', resolution_note = 'card ' || left(p_task_id::text, 8) -- T3.1+
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
$function$;

create or replace function public.complete_operator_action(p_task_id uuid, p_completed_by text, p_note text DEFAULT NULL::text)
 returns public.agent_tasks
 language plpgsql
 set search_path to 'pg_catalog', 'public'
as $function$
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
    perform set_config('app.actor', v_completed_by, true); -- T3.1+
    perform set_config('app.event_payload', '', true); -- T3.1+
    perform set_config('app.evidence_thought_id', '', true); -- T3.1+
    update public.action_items
    set status = 'resolved', resolved_at = now()
      , close_reason = 'done', resolution_note = 'card ' || left(p_task_id::text, 8) -- T3.1+
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
$function$;
