-- Loop-closing Task 3.2, SCHEMA PART ONLY (shipped ahead of Task 3.6, the operator's call
-- 2026-11-18 ET). Task 3.6's review handler writes these columns when the operator replies
-- keep/archive to an archive proposal, so they have to exist before 3.6 can ship.
-- Task 3.2's producer (archive-policy.ts, the 05:30 UTC pg_cron job, the digest
-- section) is NOT here: it ships later in its own migration and PR. Until it does,
-- nothing writes archive_proposed_at and no archive proposal exists.
--
-- What this file does:
--   1. three nullable columns on action_items, with a CHECK on the outcome and a
--      CHECK that the outcome and its timestamp travel together;
--   2. replaces Task 3.1's two status triggers so that a REOPEN (closed to not
--      closed) also nulls the three columns, and the reopen event carries their old
--      values. Without the reset a restored item keeps archive_review_outcome =
--      'accepted' forever and the digest's null-outcome filter never shows it again.
--
-- Both function bodies below are 20261106_action_items_close_reason.sql's verbatim
-- (production matched that file by hash on 2026-11-17 UTC) plus the lines marked
-- "-- T3.2+". Rollback: re-run those two functions from 20261106, then drop the
-- constraints and columns.

alter table public.action_items
  add column if not exists archive_proposed_at timestamptz null,
  add column if not exists archive_review_outcome text null,
  add column if not exists archive_reviewed_at timestamptz null;

alter table public.action_items
  add constraint action_items_archive_review_outcome_known check (
    archive_review_outcome is null or archive_review_outcome in ('kept', 'accepted')
  );

alter table public.action_items
  add constraint action_items_archive_review_together check (
    (archive_review_outcome is null) = (archive_reviewed_at is null)
  );

comment on column public.action_items.archive_proposed_at is
  'Task 3.2: set by the archive proposal job (not yet shipped). Cleared by a reopen.';
comment on column public.action_items.archive_review_outcome is
  'Task 3.2/3.6: kept or accepted, written only by review_proposal. Null with archive_proposed_at set means the proposal is pending. Cleared by a reopen.';
comment on column public.action_items.archive_reviewed_at is
  'Task 3.2/3.6: when the archive proposal was reviewed. Set and cleared with archive_review_outcome.';

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
    new.archive_proposed_at := null; -- T3.2+
    new.archive_review_outcome := null; -- T3.2+
    new.archive_reviewed_at := null; -- T3.2+
  end if;
  if old.status = 'deferred' and new.status <> 'deferred' then
    new.deferred_at := null;
    new.defer_reason := null;
  end if;
  return new;
end;
$$;

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
      'reopen_generation', new.reopen_generation,
      'archive_proposed_at', old.archive_proposed_at, -- T3.2+
      'archive_review_outcome', old.archive_review_outcome, -- T3.2+
      'archive_reviewed_at', old.archive_reviewed_at -- T3.2+
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
