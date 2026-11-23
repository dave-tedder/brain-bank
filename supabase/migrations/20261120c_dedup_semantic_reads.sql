-- Loop-closing Task 5.2 (A3): the two reads semantic dedup needs.
--
-- The capture paths (supabase/functions/_shared/dedup.ts, called by BOTH
-- copies of extractAndStoreActionItems) propose, never suppress: an inserted
-- item that overlaps a recent open item gets an auto_resolve_decisions row
-- layer 'dedup', outcome 'proposed', reason 'semantic_overlap', item_id the
-- newer item, related_item_id the older survivor, score the containment. The
-- rows are written through record_decisions (20261106); the table, its CHECKs
-- (both dedup triples are already legal, 20261105), the item_generation
-- trigger and review_proposal's dedup disposition (done -> archived with
-- close_reason 'duplicate' and duplicate_of the survivor; keep -> kept,
-- 20261109b) already exist. What was missing:
--
--   dedup_semantic_candidates  the capture-time read: open items of the last
--                              p_window_days with their source thought's
--                              project, oldest first. The project comparison,
--                              the same-thought exclusion and the overlap test
--                              stay in TypeScript (dedup.ts), single source.
--   dedup_pending_proposals    the digest's read, shaped like
--                              fragment_pending_proposals (20261120): pending
--                              semantic proposals on open items in the current
--                              generation, one row per item (the newest
--                              decision), with the survivor's description and
--                              status, oldest first.
--
-- Read-only: no table, column, constraint, trigger, policy or existing function
-- changes. Plain ASCII, no backslash escape, so md5(prosrc) after
-- apply_migration must equal each body below byte for byte.
--
-- Rollback:
--   drop function public.dedup_semantic_candidates(integer, integer);
--   drop function public.dedup_pending_proposals(integer);

create or replace function public.dedup_semantic_candidates(
  p_window_days integer default 14,
  p_limit integer default 500
)
returns table (
  id uuid, description text, created_at timestamptz, source_thought_id uuid,
  project text
)
language sql
stable
set search_path = pg_catalog, public
as $$
  select a.id, a.description, a.created_at, a.source_thought_id,
         nullif(btrim(th.metadata->>'project'), '')
  from public.action_items a
  left join public.thoughts th on th.id = a.source_thought_id
  where a.status = 'open'
    and a.created_at >= now() - make_interval(days => least(greatest(coalesce(p_window_days, 14), 1), 90))
  order by a.created_at, a.id
  limit least(greatest(coalesce(p_limit, 500), 1), 1000)
$$;

comment on function public.dedup_semantic_candidates(integer, integer) is
  'Open action items created in the last p_window_days (clamped 1..90) with the source thought project, oldest first, at most p_limit (clamped 1..1000). Capture-time read for semantic dedup proposals. Loop-closing Task 5.2.';

revoke execute on function public.dedup_semantic_candidates(integer, integer) from public, anon, authenticated;
grant execute on function public.dedup_semantic_candidates(integer, integer) to service_role;

create or replace function public.dedup_pending_proposals(p_limit integer default 200)
returns table (
  decision_id uuid, item_id uuid, description text, survivor_id uuid,
  survivor_description text, survivor_status text, score numeric,
  proposed_at timestamptz, pending_total bigint
)
language sql
stable
set search_path = pg_catalog, public
as $$
  with pending as (
    select distinct on (a.id) d.id as decision_id, a.id as item_id, a.description,
           d.related_item_id as survivor_id, s.description as survivor_description,
           s.status as survivor_status, d.score, d.created_at as proposed_at
    from public.auto_resolve_decisions d
    join public.action_items a on a.id = d.item_id
    left join public.action_items s on s.id = d.related_item_id
    where d.layer = 'dedup'
      and d.outcome = 'proposed'
      and d.reason = 'semantic_overlap'
      and a.status = 'open'
      and d.item_generation = a.reopen_generation
    order by a.id, d.created_at desc, d.id desc
  )
  select p.decision_id, p.item_id, p.description, p.survivor_id, p.survivor_description,
         p.survivor_status, p.score, p.proposed_at, count(*) over ()
  from pending p
  order by p.proposed_at, p.item_id
  limit least(greatest(coalesce(p_limit, 200), 1), 500)
$$;

comment on function public.dedup_pending_proposals(integer) is
  'Pending semantic dedup proposals (layer dedup, outcome proposed, reason semantic_overlap) on open items, current generation, one row per item, with the survivor description and status, oldest first; pending_total counts them all. Loop-closing Task 5.2.';

revoke execute on function public.dedup_pending_proposals(integer) from public, anon, authenticated;
grant execute on function public.dedup_pending_proposals(integer) to service_role;
