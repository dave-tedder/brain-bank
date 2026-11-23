-- Loop-closing Task 4.1 (synthesis B3): the nightly aged-item re-check, SCHEMA
-- AND FUNCTIONS. Proposals only: nothing here, and nothing in the Edge Function
-- that calls it, changes action_items.status. A proposal is reviewed through
-- Task 3.6's review_proposal (`done <id>` / `keep <id>`).
--
-- The schedule is NOT in this file. It is in
-- 20261119d_action_items_recheck_cron.sql, applied only after the dry run of
-- plan Task 4.1 Step 3 has been read (the plan orders dry run before cron).
--
-- Depends on: 20261105_auto_resolve_decisions.sql (the recheck triples, the
-- payload CHECK, the lifetime unique on (item_id, evidence_thought_id)) and
-- 20261106_action_items_close_reason.sql (the item_generation stamp trigger).
-- It reads thoughts.embedding (pgvector) and its `<=>` operator.
--
-- What this file adds:
--   1. Nine scan-state columns on action_items and two CHECK backstops.
--   2. match_thoughts_bounded: similarity search INSIDE a (created_at, id)
--      window. The existing match_thoughts orders and limits globally, so
--      filtering its result afterwards is not the top five within the window.
--   3. recheck_eligible_items: the plan's eligibility, order and cap.
--   4. recheck_plan_scan (read) and recheck_begin_scan (write): fix a scan's
--      identity, upper bound and frozen embedding top five.
--   5. recheck_candidates (read): one page of the bounded candidate union.
--   6. recheck_commit_page (write): the ONE writer of re-check decision rows
--      and of the cursor, one transaction per page, with the item row locked.
--   7. recheck_pending_proposals (read): what the digest prints.
--   8. action_item_recheck_runs: one receipt row per real run, so a failed or
--      missing run is printed where the operator reads (pg-cron-patterns I4).
--   9. recheck_source_embedding, recheck_client_names, recheck_record_run: the
--      remaining reads and the receipt write, as RPCs.
--
-- Window: a scan covers thoughts with (created_at, id) in (cursor, upper].
-- A never-scanned item has a null cursor, which means "after the item's own
-- created_at": every thought stamped exactly at that instant is excluded,
-- whatever its id (the lower id is the greatest uuid). Upper is the newest
-- thought when the scan begins and never grows, so a scan always ends.
--
-- Error codes raised by the two writers (class RC, so a caller can branch on
-- the code and a harness can tell them from an interruption):
--   RC001 stale_commit     the stored cursor is not the one the caller expected
--   RC002 unknown_scan     the scan id is neither the active nor the last one
--   RC003 unknown_item     no such action item
--   RC004 bad_cursor       the new cursor does not advance inside the window
--   RC005 premature_final  a final commit while candidates remain in the window
--   RC006 cursor_not_in_page  the new cursor is not a row of the next candidate
--                          page (it would pass candidates no page has read)
--
-- Rollback: drop the ten functions and the table below, then
--   alter table public.action_items
--     drop constraint action_items_recheck_cursor_pair,
--     drop constraint action_items_recheck_scan_shape,
--     drop column last_rechecked_at, drop column recheck_cursor_at,
--     drop column recheck_cursor_id, drop column recheck_scan_id,
--     drop column recheck_scan_upper_at, drop column recheck_scan_upper_id,
--     drop column recheck_scan_proposed, drop column recheck_last_scan_id,
--     drop column recheck_scan_embedding_ids;
-- Decision rows already written (layer 'recheck') stay as history.

-- ---------------------------------------------------------------------------
-- 1. Scan state on the item.
-- ---------------------------------------------------------------------------
alter table public.action_items
  add column if not exists last_rechecked_at timestamptz null,
  add column if not exists recheck_cursor_at timestamptz null,
  add column if not exists recheck_cursor_id uuid null,
  add column if not exists recheck_scan_id uuid null,
  add column if not exists recheck_scan_upper_at timestamptz null,
  add column if not exists recheck_scan_upper_id uuid null,
  add column if not exists recheck_scan_proposed boolean not null default false,
  add column if not exists recheck_last_scan_id uuid null,
  add column if not exists recheck_scan_embedding_ids uuid[] null;

comment on column public.action_items.recheck_cursor_at is
  'Keyset cursor of the re-check: thoughts up to (recheck_cursor_at, recheck_cursor_id) have been read. Null means never scanned. Loop-closing Task 4.1.';
comment on column public.action_items.recheck_last_scan_id is
  'The completed-scan receipt: the id of the last scan this item finalised. A retried commit carrying it answers already_final.';

-- The cursor is a pair.
alter table public.action_items
  add constraint action_items_recheck_cursor_pair check (
    (recheck_cursor_at is null) = (recheck_cursor_id is null)
  );

-- A scan in progress carries its whole frozen state; no scan carries none of it.
alter table public.action_items
  add constraint action_items_recheck_scan_shape check (
    (recheck_scan_id is null) = (recheck_scan_upper_at is null)
    and (recheck_scan_id is null) = (recheck_scan_upper_id is null)
    and (recheck_scan_id is null) = (recheck_scan_embedding_ids is null)
    and (recheck_scan_id is not null or recheck_scan_proposed = false)
  );

-- ---------------------------------------------------------------------------
-- 2. Bounded similarity search. The window is applied in a MATERIALIZED CTE,
-- so the ordering runs over exactly the window's rows: an approximate vector
-- index can never be used to pick five global neighbours and filter afterwards.
-- A null query embedding, or a null bound, returns no rows.
-- ---------------------------------------------------------------------------
create or replace function public.match_thoughts_bounded(
  query_embedding vector,
  p_lower_at timestamptz,
  p_lower_id uuid,
  p_upper_at timestamptz,
  p_upper_id uuid,
  match_count integer
)
returns table (id uuid, created_at timestamptz, similarity double precision)
language sql
stable
set search_path = pg_catalog, public, extensions
as $$
  with windowed as materialized (
    select t.id, t.created_at, t.embedding
    from public.thoughts t
    where query_embedding is not null
      and t.embedding is not null
      and (t.created_at, t.id) > (p_lower_at, coalesce(p_lower_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
      and (t.created_at, t.id) <= (p_upper_at, p_upper_id)
  )
  select w.id, w.created_at, (1 - (w.embedding <=> query_embedding))::double precision
  from windowed w
  order by w.embedding <=> query_embedding, w.created_at, w.id
  limit greatest(coalesce(match_count, 0), 0)
$$;

-- ---------------------------------------------------------------------------
-- 3. Eligibility (plan Task 4.1, amended round 5): open (which excludes
-- deferred), not the perpetual canary, created more than 7 days ago, and either
-- a scan in progress or never re-checked or re-checked more than 7 days ago.
-- Order: scans in progress first, then last_rechecked_at ascending with nulls
-- first, then (created_at, id). The cap is the caller's, at most 40.
-- The canary test is ASCII-only on purpose: the three words are ASCII.
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
             a.last_rechecked_at asc nulls first,
             a.created_at asc, a.id asc
    limit p_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4a. What a scan of this item would be, WITHOUT writing: the dry run's read,
-- and the single source of the bounds recheck_begin_scan then writes.
--   status 'existing'    a scan is in progress; its stored state is returned
--          'would_begin' the bounds a new scan would freeze
--          'not_open'    the item is not open; nothing to scan
-- scan_proposed is the scan's persisted flag: whether a page already committed
-- in this scan proposed. A dry run resumes from it, as the final commit reads
-- it, so it reports no none_found for a scan that proposed in an earlier run.
-- A scan that would begin now has proposed nothing.
-- Upper is the newest thought, never below the lower bound, so a final commit
-- can never move the cursor backwards (a deleted probe capture can leave the
-- newest thought older than the cursor). NOT strict: a null embedding is a
-- supported shape and yields an empty frozen set.
-- ---------------------------------------------------------------------------
create or replace function public.recheck_plan_scan(
  p_item_id uuid,
  p_query_embedding vector
)
returns table (
  status text, scan_id uuid, cursor_at timestamptz, cursor_id uuid,
  upper_at timestamptz, upper_id uuid, embedding_ids uuid[], scan_proposed boolean
)
language plpgsql
stable
called on null input
set search_path = pg_catalog, public, extensions
as $$
#variable_conflict use_column
declare
  c_max constant uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  v_item public.action_items;
  v_lower_at timestamptz;
  v_lower_id uuid;
  v_upper_at timestamptz;
  v_upper_id uuid;
  v_ids uuid[] := '{}';
begin
  select * into v_item from public.action_items a where a.id = p_item_id;
  if not found then
    raise exception 'unknown_item: no action item %', p_item_id using errcode = 'RC003';
  end if;
  if v_item.status <> 'open' then
    return query select 'not_open'::text, v_item.recheck_scan_id, v_item.recheck_cursor_at,
      v_item.recheck_cursor_id, v_item.recheck_scan_upper_at, v_item.recheck_scan_upper_id,
      v_item.recheck_scan_embedding_ids, v_item.recheck_scan_proposed;
    return;
  end if;
  if v_item.recheck_scan_id is not null then
    return query select 'existing'::text, v_item.recheck_scan_id, v_item.recheck_cursor_at,
      v_item.recheck_cursor_id, v_item.recheck_scan_upper_at, v_item.recheck_scan_upper_id,
      v_item.recheck_scan_embedding_ids, v_item.recheck_scan_proposed;
    return;
  end if;
  if v_item.created_at is null then
    raise exception 'recheck: item % has no created_at, so it has no window.', p_item_id using errcode = '22023';
  end if;

  v_lower_at := coalesce(v_item.recheck_cursor_at, v_item.created_at);
  v_lower_id := coalesce(v_item.recheck_cursor_id, c_max);

  select t.created_at, t.id into v_upper_at, v_upper_id
  from public.thoughts t
  where t.created_at is not null
  order by t.created_at desc, t.id desc
  limit 1;
  if v_upper_at is null or (v_upper_at, v_upper_id) < (v_lower_at, v_lower_id) then
    v_upper_at := v_lower_at;
    v_upper_id := v_lower_id;
  end if;

  if p_query_embedding is not null then
    select coalesce(array_agg(m.id order by m.similarity desc, m.created_at, m.id), '{}')
    into v_ids
    from public.match_thoughts_bounded(p_query_embedding, v_lower_at, v_lower_id, v_upper_at, v_upper_id, 5) m;
  end if;

  return query select 'would_begin'::text, null::uuid, v_item.recheck_cursor_at,
    v_item.recheck_cursor_id, v_upper_at, v_upper_id, v_ids, false;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4b. Begin a scan. With the item row locked: a scan in progress is returned
-- unchanged ('existing'); otherwise the plan above is written with a new scan
-- id ('began'). The cursor stays where the previous scan ended.
-- ---------------------------------------------------------------------------
create or replace function public.recheck_begin_scan(
  p_item_id uuid,
  p_query_embedding vector
)
returns table (
  status text, scan_id uuid, cursor_at timestamptz, cursor_id uuid,
  upper_at timestamptz, upper_id uuid, embedding_ids uuid[]
)
language plpgsql
volatile
called on null input
set search_path = pg_catalog, public, extensions
as $$
#variable_conflict use_column
declare
  v_plan record;
  v_scan uuid;
begin
  perform 1 from public.action_items a where a.id = p_item_id for no key update;
  if not found then
    raise exception 'unknown_item: no action item %', p_item_id using errcode = 'RC003';
  end if;

  select * into v_plan from public.recheck_plan_scan(p_item_id, p_query_embedding);
  if v_plan.status <> 'would_begin' then
    return query select v_plan.status, v_plan.scan_id, v_plan.cursor_at, v_plan.cursor_id,
      v_plan.upper_at, v_plan.upper_id, v_plan.embedding_ids;
    return;
  end if;

  v_scan := gen_random_uuid();
  update public.action_items a
  set recheck_scan_id = v_scan,
      recheck_scan_upper_at = v_plan.upper_at,
      recheck_scan_upper_id = v_plan.upper_id,
      recheck_scan_embedding_ids = v_plan.embedding_ids
  where a.id = p_item_id;

  return query select 'began'::text, v_scan, v_plan.cursor_at, v_plan.cursor_id,
    v_plan.upper_at, v_plan.upper_id, v_plan.embedding_ids;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. One page of candidates: thoughts in (lower, upper] that share project,
-- a topic or a named person with the item's SOURCE thought (the metadata lives
-- on thoughts, read through source_thought_id as find_candidate_action_items
-- reads it), plus the frozen embedding ids, as one union ordered by
-- (created_at, id). An item with no source thought has no metadata candidates.
-- A read: the caller passes the bounds, so the dry run uses it unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.recheck_candidates(
  p_item_id uuid,
  p_lower_at timestamptz,
  p_lower_id uuid,
  p_upper_at timestamptz,
  p_upper_id uuid,
  p_embedding_ids uuid[],
  p_limit integer default 10
)
returns table (id uuid, created_at timestamptz, content text, metadata jsonb)
language sql
stable
set search_path = pg_catalog, public
as $$
  with src as (
    select nullif(th.metadata->>'project', '') as project,
      case when jsonb_typeof(th.metadata->'topics') = 'array'
        then array(select jsonb_array_elements_text(th.metadata->'topics')) else '{}'::text[] end as topics,
      case when jsonb_typeof(th.metadata->'people') = 'array'
        then array(select jsonb_array_elements_text(th.metadata->'people')) else '{}'::text[] end as people
    from public.action_items a
    join public.thoughts th on th.id = a.source_thought_id
    where a.id = p_item_id
  )
  select t.id, t.created_at, t.content, t.metadata
  from public.thoughts t
  where (t.created_at, t.id) > (p_lower_at, coalesce(p_lower_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
    and (t.created_at, t.id) <= (p_upper_at, p_upper_id)
    and (
      t.id = any(coalesce(p_embedding_ids, '{}'::uuid[]))
      or exists (
        select 1 from src
        where (src.project is not null and t.metadata->>'project' = src.project)
           or (cardinality(src.topics) > 0 and t.metadata->'topics' ?| src.topics)
           or (cardinality(src.people) > 0 and t.metadata->'people' ?| src.people)
      )
    )
  order by t.created_at, t.id
  limit least(greatest(coalesce(p_limit, 10), 1), 50)
$$;

-- ---------------------------------------------------------------------------
-- 6. Commit one page. ONE transaction, the item row locked first.
--
-- Scan id precedence: the active scan proceeds; the last finalised scan answers
-- 'already_final' and writes nothing, whatever p_final says; any other id
-- raises unknown_scan. A non-open item answers 'not_open' and writes nothing
-- (its scan waits; a restore resumes it).
--
-- p_rows is a JSON array of {outcome, reason, evidence_thought_id, quote,
-- score}. outcome is 'proposed' or 'no_evidence'; the function supplies
-- item_id, layer and candidate_description; the payload and combination CHECKs
-- of Task 1.4 judge the rest, and any refusal aborts the whole page. A replayed
-- evidence row is dropped by the lifetime unique on (item_id,
-- evidence_thought_id). 'none_found' is written here only, by the final commit,
-- and only when no page of this scan proposed.
--
-- A page that is not final advances the cursor to the page's last
-- (created_at, id). A final page moves it to the scan's upper bound, records
-- the scan id as the receipt, stamps last_rechecked_at and clears the scan.
--
-- The page boundary. A commit may move the cursor only as far as the page the
-- caller could have read: the new cursor must be the (created_at, id) of one of
-- the first ten candidates after the STORED cursor (c_page, the run loop's page
-- size), read here through recheck_candidates with the scan's own frozen ids.
-- Anything else raises cursor_not_in_page: a candidate beyond the tenth, the
-- upper bound when it is not such a row, or a tuple that is no candidate's.
-- So no commit, final or not, with rows or without, can pass a candidate that
-- no page held. A final commit carries either the last row it read (which must
-- be in that page, with no candidate after it) or no cursor at all (an empty
-- page, with no candidate left in the window); the function itself then moves
-- the cursor to the upper bound. Deliberately still accepted: a cursor short of
-- the page's last row (the rest is read again, nothing is skipped), and a final
-- on a full page of ten when nothing remains after it (the run loop never
-- sends one; every candidate was in the page).
-- ---------------------------------------------------------------------------
create or replace function public.recheck_commit_page(
  p_item_id uuid,
  p_scan_id uuid,
  p_expected_cursor_at timestamptz,
  p_expected_cursor_id uuid,
  p_cursor_at timestamptz,
  p_cursor_id uuid,
  p_rows jsonb,
  p_final boolean
)
returns table (
  status text, scan_active boolean, cursor_at timestamptz, cursor_id uuid,
  scan_proposed boolean, inserted integer, last_rechecked_at timestamptz
)
language plpgsql
volatile
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  c_max constant uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  -- The page size of the run loop (PAGE_SIZE in _prompt.ts).
  c_page constant integer := 10;
  v_item public.action_items;
  v_rows jsonb := coalesce(p_rows, '[]'::jsonb);
  v_row jsonb;
  v_lower_at timestamptz;
  v_lower_id uuid;
  v_from_at timestamptz;
  v_from_id uuid;
  v_inserted integer := 0;
  v_proposed_inserted integer := 0;
  v_proposed boolean;
  v_affected integer;
  v_now timestamptz := now();
begin
  if p_item_id is null or p_scan_id is null or p_final is null then
    raise exception 'recheck_commit_page requires an item id, a scan id and p_final.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_rows) <> 'array' then
    raise exception 'recheck_commit_page: p_rows must be a JSON array.' using errcode = '22023';
  end if;
  if (p_cursor_at is null) <> (p_cursor_id is null) then
    raise exception 'recheck_commit_page: the new cursor is a pair; give both parts or neither.' using errcode = '22023';
  end if;

  select * into v_item from public.action_items a where a.id = p_item_id for no key update;
  if not found then
    raise exception 'unknown_item: no action item %', p_item_id using errcode = 'RC003';
  end if;

  if v_item.recheck_scan_id = p_scan_id then
    null;
  elsif v_item.recheck_last_scan_id = p_scan_id then
    return query select 'already_final'::text, v_item.recheck_scan_id is not null,
      v_item.recheck_cursor_at, v_item.recheck_cursor_id, v_item.recheck_scan_proposed,
      0, v_item.last_rechecked_at;
    return;
  else
    raise exception 'unknown_scan: % is neither the active nor the last finalised scan of %',
      p_scan_id, left(p_item_id::text, 8) using errcode = 'RC002';
  end if;

  if v_item.status <> 'open' then
    return query select 'not_open'::text, true, v_item.recheck_cursor_at, v_item.recheck_cursor_id,
      v_item.recheck_scan_proposed, 0, v_item.last_rechecked_at;
    return;
  end if;

  if v_item.recheck_cursor_at is distinct from p_expected_cursor_at
     or v_item.recheck_cursor_id is distinct from p_expected_cursor_id then
    raise exception 'stale_commit: the cursor of % is not the one this commit expected',
      left(p_item_id::text, 8) using errcode = 'RC001';
  end if;

  v_lower_at := coalesce(v_item.recheck_cursor_at, v_item.created_at);
  v_lower_id := coalesce(v_item.recheck_cursor_id, c_max);
  if p_cursor_at is not null then
    if not ((p_cursor_at, p_cursor_id) > (v_lower_at, v_lower_id))
       or (p_cursor_at, p_cursor_id) > (v_item.recheck_scan_upper_at, v_item.recheck_scan_upper_id) then
      raise exception 'bad_cursor: the new cursor of % does not advance inside the scan window',
        left(p_item_id::text, 8) using errcode = 'RC004';
    end if;
    -- The page boundary: the new cursor is a row of the next candidate page.
    if not exists (
      select 1
      from public.recheck_candidates(p_item_id, v_lower_at, v_lower_id,
        v_item.recheck_scan_upper_at, v_item.recheck_scan_upper_id,
        v_item.recheck_scan_embedding_ids, c_page) pg
      where pg.created_at = p_cursor_at and pg.id = p_cursor_id
    ) then
      raise exception 'cursor_not_in_page: the new cursor of % is not a row of its next candidate page; a commit cannot pass candidates no page has read',
        left(p_item_id::text, 8) using errcode = 'RC006';
    end if;
  elsif not p_final then
    raise exception 'recheck_commit_page: a page that is not final needs its last (created_at, id).'
      using errcode = '22023';
  end if;

  for v_row in select e.r from jsonb_array_elements(v_rows) as e(r) loop
    if jsonb_typeof(v_row) <> 'object' then
      raise exception 'recheck_commit_page: every row is a JSON object.' using errcode = '22023';
    end if;
    if coalesce(v_row->>'outcome', '') not in ('proposed', 'no_evidence') then
      raise exception 'recheck_commit_page: a row is proposed or no_evidence (got %).', v_row->>'outcome'
        using errcode = '22023';
    end if;
    if v_row->>'reason' = 'none_found' then
      raise exception 'recheck_commit_page: none_found is written by the final commit, never by a caller.'
        using errcode = '22023';
    end if;
  end loop;

  with ins as (
    insert into public.auto_resolve_decisions
      (item_id, candidate_description, layer, outcome, reason, evidence_thought_id, quote, score)
    select p_item_id, v_item.description, 'recheck', e.r->>'outcome', e.r->>'reason',
           (e.r->>'evidence_thought_id')::uuid, e.r->>'quote', (e.r->>'score')::numeric
    from jsonb_array_elements(v_rows) with ordinality as e(r, n)
    order by e.n
    on conflict (item_id, evidence_thought_id)
      where layer = 'recheck' and evidence_thought_id is not null
      do nothing
    returning outcome
  )
  select count(*)::integer, (count(*) filter (where ins.outcome = 'proposed'))::integer
  into v_inserted, v_proposed_inserted
  from ins;

  v_proposed := v_item.recheck_scan_proposed or v_proposed_inserted > 0;

  if not p_final then
    update public.action_items a
    set recheck_cursor_at = p_cursor_at,
        recheck_cursor_id = p_cursor_id,
        recheck_scan_proposed = v_proposed
    where a.id = p_item_id and a.recheck_scan_id = p_scan_id;
    get diagnostics v_affected = row_count;
    if v_affected <> 1 then
      raise exception 'recheck_commit_page: the cursor update of % wrote % rows.', p_item_id, v_affected
        using errcode = 'P0001';
    end if;
    return query select 'committed'::text, true, p_cursor_at, p_cursor_id, v_proposed, v_inserted,
      v_item.last_rechecked_at;
    return;
  end if;

  -- A final commit is refused while a candidate remains after this page: the
  -- cursor is about to jump to the upper bound, and evidence skipped here would
  -- never be read again.
  v_from_at := coalesce(p_cursor_at, v_lower_at);
  v_from_id := coalesce(p_cursor_id, v_lower_id);
  if exists (
    select 1 from public.recheck_candidates(p_item_id, v_from_at, v_from_id,
      v_item.recheck_scan_upper_at, v_item.recheck_scan_upper_id,
      v_item.recheck_scan_embedding_ids, 1)
  ) then
    raise exception 'premature_final: candidates remain in the scan window of %',
      left(p_item_id::text, 8) using errcode = 'RC005';
  end if;

  update public.action_items a
  set recheck_scan_id = null,
      recheck_last_scan_id = p_scan_id,
      recheck_cursor_at = a.recheck_scan_upper_at,
      recheck_cursor_id = a.recheck_scan_upper_id,
      recheck_scan_upper_at = null,
      recheck_scan_upper_id = null,
      recheck_scan_proposed = false,
      recheck_scan_embedding_ids = null,
      last_rechecked_at = v_now
  where a.id = p_item_id and a.recheck_scan_id = p_scan_id;
  get diagnostics v_affected = row_count;
  if v_affected <> 1 then
    raise exception 'recheck_commit_page: the final update of % wrote % rows.', p_item_id, v_affected
      using errcode = 'P0001';
  end if;

  if not v_proposed then
    insert into public.auto_resolve_decisions (item_id, candidate_description, layer, outcome, reason)
    values (p_item_id, v_item.description, 'recheck', 'no_evidence', 'none_found');
    v_inserted := v_inserted + 1;
  end if;

  return query select 'final'::text, false, v_item.recheck_scan_upper_at, v_item.recheck_scan_upper_id,
    v_proposed, v_inserted, v_now;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Pending re-check proposals for the digest: current generation, open item.
-- pending_total is the whole count, so a capped list says so.
-- ---------------------------------------------------------------------------
create or replace function public.recheck_pending_proposals(p_limit integer default 200)
returns table (
  decision_id uuid, item_id uuid, description text, quote text,
  evidence_thought_id uuid, proposed_at timestamptz, pending_total bigint
)
language sql
stable
set search_path = pg_catalog, public
as $$
  select d.id, a.id, a.description, d.quote, d.evidence_thought_id, d.created_at,
         count(*) over ()
  from public.auto_resolve_decisions d
  join public.action_items a on a.id = d.item_id
  where d.layer = 'recheck'
    and d.outcome = 'proposed'
    and a.status = 'open'
    and d.item_generation = a.reopen_generation
  order by d.created_at, d.id
  limit least(greatest(coalesce(p_limit, 200), 1), 500)
$$;

-- ---------------------------------------------------------------------------
-- 8. One receipt per real run (a dry run writes nothing). The digest reads the
-- newest row. summary is the run's own counts: no thought text, no item text.
-- ---------------------------------------------------------------------------
create table if not exists public.action_item_recheck_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  status text not null,
  summary jsonb not null default '{}'::jsonb,
  constraint action_item_recheck_runs_status check (status in ('ok', 'partial', 'failed'))
);
create index if not exists action_item_recheck_runs_started_idx
  on public.action_item_recheck_runs (started_at desc);

alter table public.action_item_recheck_runs enable row level security;
create policy "Service role full access on action_item_recheck_runs"
  on public.action_item_recheck_runs for all
  using (auth.role() = 'service_role'::text);

-- ---------------------------------------------------------------------------
-- 9. Three small entry points, so the Edge Function reaches the database
-- through RPCs only (one seam, every argument name checked by the SQL):
--   recheck_source_embedding  the item's query embedding, as TEXT, so it makes
--                             the round trip to recheck_begin_scan untouched
--                             (has_source false: no source thought at all;
--                             embedding null: a source with no embedding)
--   recheck_client_names      every client name, as ONE jsonb array, so a row
--                             cap can never hand back a partial list
--   recheck_record_run        the run receipt of section 8
-- ---------------------------------------------------------------------------
create or replace function public.recheck_source_embedding(p_item_id uuid)
returns table (has_source boolean, embedding text)
language sql
stable
set search_path = pg_catalog, public, extensions
as $$
  select th.id is not null, th.embedding::text
  from public.action_items a
  left join public.thoughts th on th.id = a.source_thought_id
  where a.id = p_item_id
$$;

create or replace function public.recheck_client_names()
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  select coalesce(jsonb_agg(c.name order by c.name), '[]'::jsonb)
  from public.clients c
  where c.name is not null and c.name <> ''
$$;

create or replace function public.recheck_record_run(
  p_started_at timestamptz,
  p_status text,
  p_summary jsonb
)
returns uuid
language plpgsql
volatile
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
begin
  if p_started_at is null or p_summary is null or jsonb_typeof(p_summary) <> 'object' then
    raise exception 'recheck_record_run requires a start time and a JSON object summary.' using errcode = '22023';
  end if;
  insert into public.action_item_recheck_runs (started_at, status, summary)
  values (p_started_at, p_status, p_summary)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.recheck_source_embedding(uuid) from public, anon, authenticated;
revoke execute on function public.recheck_client_names() from public, anon, authenticated;
revoke execute on function public.recheck_record_run(timestamptz, text, jsonb) from public, anon, authenticated;
grant execute on function public.recheck_source_embedding(uuid) to service_role;
grant execute on function public.recheck_client_names() to service_role;
grant execute on function public.recheck_record_run(timestamptz, text, jsonb) to service_role;
revoke execute on function public.match_thoughts_bounded(vector, timestamptz, uuid, timestamptz, uuid, integer) from public, anon, authenticated;
revoke execute on function public.recheck_eligible_items(timestamptz, integer) from public, anon, authenticated;
revoke execute on function public.recheck_plan_scan(uuid, vector) from public, anon, authenticated;
revoke execute on function public.recheck_begin_scan(uuid, vector) from public, anon, authenticated;
revoke execute on function public.recheck_candidates(uuid, timestamptz, uuid, timestamptz, uuid, uuid[], integer) from public, anon, authenticated;
revoke execute on function public.recheck_commit_page(uuid, uuid, timestamptz, uuid, timestamptz, uuid, jsonb, boolean) from public, anon, authenticated;
revoke execute on function public.recheck_pending_proposals(integer) from public, anon, authenticated;
grant execute on function public.match_thoughts_bounded(vector, timestamptz, uuid, timestamptz, uuid, integer) to service_role;
grant execute on function public.recheck_eligible_items(timestamptz, integer) to service_role;
grant execute on function public.recheck_plan_scan(uuid, vector) to service_role;
grant execute on function public.recheck_begin_scan(uuid, vector) to service_role;
grant execute on function public.recheck_candidates(uuid, timestamptz, uuid, timestamptz, uuid, uuid[], integer) to service_role;
grant execute on function public.recheck_commit_page(uuid, uuid, timestamptz, uuid, timestamptz, uuid, jsonb, boolean) to service_role;
grant execute on function public.recheck_pending_proposals(integer) to service_role;
