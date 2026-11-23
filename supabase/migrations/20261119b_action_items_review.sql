-- Loop-closing Task 3.3 (C3): a triage read of an open action item leaves a
-- durable review on the row, and triage reads the oldest unreviewed items first.
--
-- Before this, triage's SKIP bucket (stale, duplicate, vague, done, paused) was a
-- line in a ledger note that nothing read back, and triage read the newest 100
-- items every morning, so the old ones were never looked at again.
--
-- What this file does:
--   1. six nullable columns on action_items (the plan's five plus
--      last_reviewed_by, see the review packet), with CHECKs that keep them
--      consistent;
--   2. a BEFORE trigger of its own that clears the review whenever an item
--      returns to 'open' from another status, so a restored item is unreviewed
--      again and never carries a stale proposal tag. It is a separate trigger:
--      Task 3.1's two status trigger functions are not touched;
--   3. review_action_item(): the one writer of those columns;
--   4. list_unreviewed_action_items(): the read order, exclusion before LIMIT.
--
-- Nothing here closes, defers or reopens an item. A proposal is a tag the operator reads
-- in the digest; closing stays with archive_action_item / resolve_action_item /
-- defer_action_item.
--
-- Depends on: 20261106_action_items_close_reason.sql (nothing structural; listed
-- because the clearing trigger sits beside its status triggers) and
-- public.agent_task_ledger (the actor check).
--
-- Rollout order: this migration first, then open-brain-mcp and brain-digest, then
-- the triage routine prompt. The deployed functions keep working on top of this
-- schema. Rollback is consumer-first: push the prior routine prompt, redeploy the
-- prior functions, then drop the two functions, the trigger and its function, the
-- five constraints, the index and the six columns.

-- ---------------------------------------------------------------------------
-- 1. Columns and invariants
-- ---------------------------------------------------------------------------

alter table public.action_items
  add column if not exists last_reviewed_at timestamptz null,
  add column if not exists last_reviewed_by text null,
  add column if not exists review_outcome text null,
  add column if not exists triage_disposition text null,
  add column if not exists triage_evidence text null,
  add column if not exists triage_replacement_id uuid null
    references public.action_items(id) on delete set null;

alter table public.action_items
  add constraint action_items_review_outcome_known check (
    review_outcome is null or review_outcome in ('keep', 'proposal')
  );

alter table public.action_items
  add constraint action_items_triage_disposition_known check (
    triage_disposition is null
    or triage_disposition in ('stale', 'duplicate', 'vague', 'done', 'paused')
  );

-- The review is one fact: when, by whom and the outcome travel together.
alter table public.action_items
  add constraint action_items_review_together check (
    (last_reviewed_at is null) = (review_outcome is null)
    and (last_reviewed_at is null) = (last_reviewed_by is null)
  );

-- A proposal carries a disposition and its evidence; a keep carries neither.
alter table public.action_items
  add constraint action_items_review_proposal_shape check (
    (review_outcome is not distinct from 'proposal') = (triage_disposition is not null)
    and (review_outcome is not distinct from 'proposal') = (triage_evidence is not null)
  );

-- One direction only: on delete set null must be able to clear the replacement
-- when its row is hard-deleted (the same choice duplicate_of makes). The writer
-- enforces the other direction: a duplicate proposal names its replacement.
alter table public.action_items
  add constraint action_items_triage_replacement_consistent check (
    triage_replacement_id is null
    or (triage_disposition is not distinct from 'duplicate' and triage_replacement_id <> id)
  );

create index if not exists action_items_triage_replacement_idx
  on public.action_items (triage_replacement_id) where triage_replacement_id is not null;

comment on column public.action_items.last_reviewed_at is
  'Task 3.3: when review_action_item last recorded a review. Null means never reviewed in this open spell. Cleared when the item returns to open from another status.';
comment on column public.action_items.last_reviewed_by is
  'Task 3.3: the actor the caller claimed (operator or a ledger agent_code). The MCP shared key does not prove it.';
comment on column public.action_items.review_outcome is
  'Task 3.3: keep (reviewed, still a real open item) or proposal (triage proposes a disposition for the operator to act on). Written only by review_action_item.';
comment on column public.action_items.triage_disposition is
  'Task 3.3: stale, duplicate, vague, done or paused. Set exactly when review_outcome is proposal.';
comment on column public.action_items.triage_evidence is
  'Task 3.3: why the proposal was made. For done it starts with a pointer: thought:, commit:, pr:, card: or url:.';
comment on column public.action_items.triage_replacement_id is
  'Task 3.3: the surviving item of a duplicate proposal.';

-- ---------------------------------------------------------------------------
-- 2. A return to open clears the review
-- ---------------------------------------------------------------------------

-- A review describes the item as it stood while open. Restored from deferred,
-- archived or resolved, it is a new open spell: unreviewed, first in the read
-- order by its created_at, and with no tag in the digest. The old review is not
-- copied into the status event; see the packet's limitations.
create or replace function public.action_items_clear_review_on_open()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.status is distinct from old.status and new.status = 'open' then
    new.last_reviewed_at := null;
    new.last_reviewed_by := null;
    new.review_outcome := null;
    new.triage_disposition := null;
    new.triage_evidence := null;
    new.triage_replacement_id := null;
  end if;
  return new;
end;
$$;

drop trigger if exists action_items_clear_review_on_open on public.action_items;
create trigger action_items_clear_review_on_open
  before update on public.action_items
  for each row execute function public.action_items_clear_review_on_open();

-- ---------------------------------------------------------------------------
-- 3. The writer
-- ---------------------------------------------------------------------------

-- Rules, in the order the body applies them:
--   * The actor is recorded, never treated as authorization: operator or a
--     registered agent_code, as Tasks 3.4 and 3.6 do. The service key authorizes.
--   * Malformed input raises 22023 before any read: an unknown outcome or
--     disposition, a keep carrying a disposition, evidence or replacement, a
--     proposal without a disposition or evidence, evidence over 500 characters, a
--     done proposal whose evidence does not start with a pointer, a duplicate
--     without a replacement, a replacement on any other disposition, an item
--     named as its own replacement.
--   * The item row is locked FOR NO KEY UPDATE (Task 3.1's lock mode for a
--     non-key update). Single-item writer: it takes one row lock.
--   * State answers are returned, not raised, and write nothing: not_found;
--     refused when the item is not open; refused when the replacement does not
--     exist.
--   * A recorded review overwrites the previous one. A keep nulls the three
--     proposal columns.
create or replace function public.review_action_item(
  p_item_id uuid,
  p_outcome text,
  p_actor text,
  p_disposition text default null,
  p_evidence text default null,
  p_replacement_id uuid default null
)
returns table (status text, message text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_outcome text := lower(trim(coalesce(p_outcome, '')));
  v_actor text := nullif(trim(coalesce(p_actor, '')), '');
  v_disposition text := lower(trim(p_disposition));
  v_evidence text := regexp_replace(p_evidence, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  v_item_status text;
  v_short text;
begin
  if p_item_id is null then
    raise exception 'review_action_item requires an item id.' using errcode = '22023';
  end if;
  if v_outcome not in ('keep', 'proposal') then
    raise exception 'Unknown review outcome: % (keep or proposal).', p_outcome using errcode = '22023';
  end if;
  if v_actor is null then
    raise exception 'review_action_item requires an actor.' using errcode = '22023';
  end if;
  if v_actor <> 'operator' and not exists (
    select 1 from public.agent_task_ledger l where l.agent_code = v_actor
  ) then
    raise exception 'Actor % is neither operator nor a registered agent_code.', v_actor
      using errcode = '22023';
  end if;

  if v_outcome = 'keep' then
    -- Supplied means non-null: an empty string is still a supplied value.
    if p_disposition is not null or p_evidence is not null or p_replacement_id is not null then
      raise exception 'A keep takes no disposition, evidence or replacement.' using errcode = '22023';
    end if;
  else
    if v_disposition is null or v_disposition = '' then
      raise exception 'A proposal requires a disposition.' using errcode = '22023';
    end if;
    if v_disposition not in ('stale', 'duplicate', 'vague', 'done', 'paused') then
      raise exception 'Unknown disposition: % (stale, duplicate, vague, done or paused).', p_disposition
        using errcode = '22023';
    end if;
    if v_evidence is null or v_evidence = '' then
      raise exception 'A proposal requires evidence.' using errcode = '22023';
    end if;
    if char_length(v_evidence) > 500 then
      raise exception 'Evidence must be 500 characters or fewer.' using errcode = '22023';
    end if;
    if v_disposition = 'done' and v_evidence !~ '^(thought|commit|pr|card|url):[^[:space:]]+' then
      raise exception 'A done proposal''s evidence must start with a pointer: thought:, commit:, pr:, card: or url:.'
        using errcode = '22023';
    end if;
    if v_disposition = 'duplicate' then
      if p_replacement_id is null then
        raise exception 'A duplicate proposal requires replacement_id, the surviving item.'
          using errcode = '22023';
      end if;
      if p_replacement_id = p_item_id then
        raise exception 'An item cannot be a duplicate of itself.' using errcode = '22023';
      end if;
    elsif p_replacement_id is not null then
      raise exception 'replacement_id is only legal with the duplicate disposition.'
        using errcode = '22023';
    end if;
  end if;

  v_short := left(p_item_id::text, 8);

  select a.status into v_item_status
  from public.action_items a
  where a.id = p_item_id
  for no key update;

  if not found then
    return query select 'not_found'::text, format('no action item %s', v_short);
    return;
  end if;
  if v_item_status <> 'open' then
    return query select 'refused'::text,
      format('%s is %s; only an open item is reviewed', v_short, v_item_status);
    return;
  end if;
  if p_replacement_id is not null and not exists (
    select 1 from public.action_items r where r.id = p_replacement_id
  ) then
    return query select 'refused'::text,
      format('replacement %s not found', left(p_replacement_id::text, 8));
    return;
  end if;

  update public.action_items a
  set last_reviewed_at = now(),
      last_reviewed_by = v_actor,
      review_outcome = v_outcome,
      triage_disposition = case when v_outcome = 'proposal' then v_disposition end,
      triage_evidence = case when v_outcome = 'proposal' then v_evidence end,
      triage_replacement_id = case when v_outcome = 'proposal' then p_replacement_id end
  where a.id = p_item_id;

  if v_outcome = 'keep' then
    return query select 'recorded'::text, format('kept %s', v_short);
  elsif v_disposition = 'duplicate' then
    return query select 'recorded'::text,
      format('proposed %s: duplicate of %s', v_short, left(p_replacement_id::text, 8));
  else
    return query select 'recorded'::text, format('proposed %s: %s', v_short, v_disposition);
  end if;
end;
$$;

revoke execute on function public.review_action_item(uuid, text, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.review_action_item(uuid, text, text, text, text, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. The read order
-- ---------------------------------------------------------------------------

-- Open items never reviewed, or last reviewed more than p_unreviewed_days ago,
-- oldest first by coalesce(last_reviewed_at, created_at), id as the tie-breaker.
-- The exclusion is in the WHERE, before LIMIT: a reviewed row leaves the window
-- and the window moves, so a block of recently reviewed old rows cannot hide the
-- rows behind it. unreviewed_total is the size of the whole window, the same on
-- every returned row, so a caller can report what it did not reach.
create or replace function public.list_unreviewed_action_items(
  p_unreviewed_days integer,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  id uuid,
  description text,
  status text,
  created_at timestamptz,
  source_thought_id uuid,
  last_reviewed_at timestamptz,
  last_reviewed_by text,
  review_outcome text,
  triage_disposition text,
  triage_evidence text,
  triage_replacement_id uuid,
  unreviewed_total bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
begin
  if p_unreviewed_days is null or p_unreviewed_days < 1 or p_unreviewed_days > 365 then
    raise exception 'unreviewed_days must be between 1 and 365.' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'limit must be between 1 and 100.' using errcode = '22023';
  end if;
  if p_offset is null or p_offset < 0 then
    raise exception 'offset must be 0 or greater.' using errcode = '22023';
  end if;
  return query
    select a.id, a.description, a.status, a.created_at, a.source_thought_id,
           a.last_reviewed_at, a.last_reviewed_by, a.review_outcome,
           a.triage_disposition, a.triage_evidence, a.triage_replacement_id,
           count(*) over () as unreviewed_total
    from public.action_items a
    where a.status = 'open'
      and (a.last_reviewed_at is null
           or a.last_reviewed_at < now() - make_interval(days => p_unreviewed_days))
    order by coalesce(a.last_reviewed_at, a.created_at) asc, a.id asc
    limit p_limit offset p_offset;
end;
$$;

revoke execute on function public.list_unreviewed_action_items(integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.list_unreviewed_action_items(integer, integer, integer)
  to service_role;
