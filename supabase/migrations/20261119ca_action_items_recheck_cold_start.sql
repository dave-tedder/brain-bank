-- Loop-closing Task 4.1, cold-start correction (production finding, 2026-11-19).
--
-- APPLY ORDER: after 20261119c_action_items_recheck.sql (already applied) and
-- BEFORE 20261119d_action_items_recheck_cron.sql. The name sorts between the
-- two ("c_" < "ca_" < "d_" in byte order). The cron file is still applied
-- last, and only after a COLD production dry run has been read.
--
-- This file is plain ASCII and holds no backslash escape, so a transport that
-- decodes unicode escape sequences cannot change a function body. Compare md5(prosrc)
-- with the file after applying all the same.
--
-- The finding. recheck_plan_scan orders every thought of the item's window by
-- exact distance, so it reads every embedding in the window (about 8,100 rows
-- of 1536 dimensions for the oldest item). With a cold cache that read did not
-- fit in PostgREST's 8 second statement_timeout: 4 of 5 items failed with
-- 57014 on the first production dry run, and all passed seconds later. An item
-- whose plan fails begins no scan and gets no last_rechecked_at, so it kept
-- the head of recheck_eligible_items.
--
-- What this file adds (20261119c is NOT edited):
--   1. action_items.recheck_last_error_at: when a real run last gave up on the
--      item with an error. Written only by recheck_note_error.
--   2. recheck_eligible_items, replaced: the same eligibility, cap and return
--      shape; the order inside each group is now by the item's last ATTEMPT,
--      greatest(last_rechecked_at, recheck_last_error_at), nulls first. An item
--      that errored last night is still eligible tonight, behind every item
--      that has waited longer, instead of first every night.
--   3. recheck_warm_embeddings (read): one bounded chunk of the embeddings the
--      run's plans are about to read, in (created_at, id) order. The run calls
--      it serially, chunk after chunk, before it starts its items, so each
--      statement reads a few hundred embeddings however large the window is,
--      and the plans that follow find them in cache. It changes nothing about
--      what a plan computes: match_thoughts_bounded is untouched and exact.
--   4. recheck_note_error (write): stamps recheck_last_error_at on an OPEN
--      item. It takes the item's row lock like the other writers, touches no
--      scan column, no cursor and no status, and writes no decision row.
--
-- Rollback: drop function public.recheck_note_error(uuid);
--   drop function public.recheck_warm_embeddings(uuid[], timestamptz, uuid, integer);
--   re-create recheck_eligible_items from 20261119c; then
--   alter table public.action_items drop column recheck_last_error_at;

-- ---------------------------------------------------------------------------
-- 1. The error stamp.
-- ---------------------------------------------------------------------------
alter table public.action_items
  add column if not exists recheck_last_error_at timestamptz null;

comment on column public.action_items.recheck_last_error_at is
  'When a real re-check run last gave up on this item with an error (recheck_note_error). Orders recheck_eligible_items together with last_rechecked_at; it never makes an item ineligible. Loop-closing Task 4.1 cold-start correction.';

-- ---------------------------------------------------------------------------
-- 2. Eligibility, replaced. Identical to 20261119c except the second ORDER BY
-- key: the item's last attempt (a finished scan or a recorded error, whichever
-- is later), nulls first. greatest() ignores a null argument and is null only
-- when both are.
-- ---------------------------------------------------------------------------
create or replace function public.recheck_eligible_items(
  p_now timestamptz default now(),
  p_limit integer default 40
)
returns table (
  id uuid, description text, created_at timestamptz, source_thought_id uuid,
  src_project text,
  recheck_scan_id uuid, recheck_cursor_at timestamptz, recheck_cursor_id uuid,
  recheck_scan_upper_at timestamptz, recheck_scan_upper_id uuid,
  recheck_scan_embedding_ids uuid[], last_rechecked_at timestamptz
)
language plpgsql
stable
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
begin
  if p_now is null then
    raise exception 'recheck_eligible_items requires a time.' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 40 then
    raise exception 'recheck_eligible_items limit must be 1 to 40 (got %).', p_limit using errcode = '22023';
  end if;
  return query
    select a.id, a.description, a.created_at, a.source_thought_id,
           nullif(th.metadata->>'project', ''),
           a.recheck_scan_id, a.recheck_cursor_at, a.recheck_cursor_id,
           a.recheck_scan_upper_at, a.recheck_scan_upper_id,
           a.recheck_scan_embedding_ids, a.last_rechecked_at
    from public.action_items a
    left join public.thoughts th on th.id = a.source_thought_id
    cross join lateral (
      select translate(a.description, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') as d
    ) low
    where a.status = 'open'
      and not (low.d like '%perpetual%' and (low.d like '%canary%' or low.d like '%tripwire%'))
      and a.created_at < p_now - interval '168 hours'
      and (a.recheck_scan_id is not null
           or a.last_rechecked_at is null
           or a.last_rechecked_at < p_now - interval '168 hours')
    order by (a.recheck_scan_id is null) asc,
             greatest(a.last_rechecked_at, a.recheck_last_error_at) asc nulls first,
             a.created_at asc, a.id asc
    limit p_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Warm one chunk of the embeddings a run's plans will read. A READ.
--
-- Which rows. A plan reads the embeddings of the thoughts after its item's
-- lower bound (the cursor, or the item's created_at for a never-scanned item)
-- up to the newest thought. Only an item that would BEGIN a scan with a query
-- embedding runs that search: open, no scan in progress, a source thought with
-- an embedding. The earliest lower bound among such items in p_item_ids is
-- where the union of their windows starts; every window is a suffix of it.
--
-- One call reads at most p_limit of those thoughts, in (created_at, id) order,
-- strictly after (p_after_at, p_after_id) when the caller passes the last row
-- of its previous chunk, and returns how many it read, the last row read, and
-- done = fewer than p_limit rows were left. It has no upper bound: thoughts
-- captured while the run warms are simply read too.
--
-- "Reads" means in full: each embedding is passed to the distance operator the
-- plan itself uses (against itself, so no query embedding is needed), which
-- cannot answer without every byte of the stored value.
--
-- No item to warm for (none listed, none open, all mid-scan, no source
-- embedding) answers (0, null, null, true).
-- ---------------------------------------------------------------------------
create or replace function public.recheck_warm_embeddings(
  p_item_ids uuid[],
  p_after_at timestamptz,
  p_after_id uuid,
  p_limit integer default 250
)
returns table (rows_read integer, last_at timestamptz, last_id uuid, done boolean)
language plpgsql
stable
set search_path = pg_catalog, public, extensions
as $$
#variable_conflict use_column
declare
  c_max constant uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  v_from_at timestamptz;
  v_from_id uuid;
  v_rows integer;
  v_full integer;
  v_last_at timestamptz;
  v_last_id uuid;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'recheck_warm_embeddings limit must be 1 to 1000 (got %).', p_limit using errcode = '22023';
  end if;
  if (p_after_at is null) <> (p_after_id is null) then
    raise exception 'recheck_warm_embeddings: the position is a pair; give both parts or neither.' using errcode = '22023';
  end if;

  select coalesce(a.recheck_cursor_at, a.created_at), coalesce(a.recheck_cursor_id, c_max)
  into v_from_at, v_from_id
  from public.action_items a
  join public.thoughts src on src.id = a.source_thought_id
  where a.id = any(coalesce(p_item_ids, '{}'::uuid[]))
    and a.status = 'open'
    and a.recheck_scan_id is null
    and a.created_at is not null
    and src.embedding is not null
  order by 1 asc, 2 asc
  limit 1;
  if v_from_at is null then
    return query select 0, null::timestamptz, null::uuid, true;
    return;
  end if;

  if p_after_at is not null and (p_after_at, p_after_id) > (v_from_at, v_from_id) then
    v_from_at := p_after_at;
    v_from_id := p_after_id;
  end if;

  -- count(<distance>) is an aggregate argument, so it is evaluated for every
  -- row of the chunk; its value (v_full) is not otherwise used.
  with chunk as materialized (
    select t.id, t.created_at, t.embedding
    from public.thoughts t
    where t.embedding is not null
      and (t.created_at, t.id) > (v_from_at, v_from_id)
    order by t.created_at asc, t.id asc
    limit p_limit
  )
  select count(*)::integer,
         count(c.embedding <=> c.embedding)::integer,
         (array_agg(c.created_at order by c.created_at desc, c.id desc))[1],
         (array_agg(c.id order by c.created_at desc, c.id desc))[1]
  into v_rows, v_full, v_last_at, v_last_id
  from chunk c;

  return query select v_rows, v_last_at, v_last_id, v_rows < p_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Record that a real run gave up on an item with an error. With the item
-- row locked, an OPEN item gets recheck_last_error_at = now() and the answer
-- is true; an item that is not open is left alone (false); an unknown item
-- raises unknown_item (RC003), as the other writers do. Nothing else is
-- written: no scan column, no cursor, no status, no decision row, so the
-- RC001 to RC006 contracts of recheck_commit_page and the scan a failed page
-- left in progress are exactly as they were.
-- ---------------------------------------------------------------------------
create or replace function public.recheck_note_error(p_item_id uuid)
returns boolean
language plpgsql
volatile
set search_path = pg_catalog, public
as $$
declare
  v_status text;
begin
  if p_item_id is null then
    raise exception 'recheck_note_error requires an item id.' using errcode = '22023';
  end if;
  select a.status into v_status from public.action_items a where a.id = p_item_id for no key update;
  if not found then
    raise exception 'unknown_item: no action item %', p_item_id using errcode = 'RC003';
  end if;
  if v_status <> 'open' then
    return false;
  end if;
  update public.action_items a
  set recheck_last_error_at = now()
  where a.id = p_item_id;
  return true;
end;
$$;

revoke execute on function public.recheck_warm_embeddings(uuid[], timestamptz, uuid, integer) from public, anon, authenticated;
revoke execute on function public.recheck_note_error(uuid) from public, anon, authenticated;
grant execute on function public.recheck_warm_embeddings(uuid[], timestamptz, uuid, integer) to service_role;
grant execute on function public.recheck_note_error(uuid) to service_role;
-- recheck_eligible_items keeps the privileges 20261119c gave it: create or
-- replace does not reset them.
