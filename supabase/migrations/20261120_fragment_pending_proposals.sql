-- Loop-closing Task 5.1 (A2, A3): the digest's read of pending fragment
-- suspects.
--
-- The capture paths (supabase/functions/_shared/fragment-gate.ts) insert an
-- item whose object is a bare pronoun and record it as a fragment suspect:
-- auto_resolve_decisions layer 'fragment', outcome 'proposed', reason
-- 'pronoun_object', item_id set. The digest lists those as
--   check wording (reply keep <id> or archive <id>)
-- and the replies go through Task 3.6's review_proposal (keep -> kept;
-- archive -> accepted, the item archived with close_reason 'fragment'). The
-- table, its CHECKs, the item_generation trigger and review_proposal already
-- accept every fragment row (20261105, 20261106, 20261109b); this migration
-- adds only the read, shaped like recheck_pending_proposals (20261119c).
--
-- Pending means: outcome 'proposed', the item open, and the row in the item's
-- current generation (item_generation = reopen_generation), so a row from
-- before a restore_action_item is history and never shown. A suspect on a
-- deferred item is not listed until the item is open again (as for recheck).
-- One line per item: a suspect is written at insert only, once per item, so
-- two rows for one item would be a defect elsewhere; the read still collapses
-- them to the newest decision so the digest never repeats an item.
--
-- Read-only: no table, column, constraint, trigger, policy or existing
-- function changes. Plain ASCII, no backslash escape, so md5(prosrc) after
-- apply_migration must equal the body below byte for byte.
--
-- Rollback: drop function public.fragment_pending_proposals(integer);

create or replace function public.fragment_pending_proposals(p_limit integer default 200)
returns table (
  decision_id uuid, item_id uuid, description text, proposed_at timestamptz,
  pending_total bigint
)
language sql
stable
set search_path = pg_catalog, public
as $$
  with pending as (
    select distinct on (a.id) d.id as decision_id, a.id as item_id, a.description,
           d.created_at as proposed_at
    from public.auto_resolve_decisions d
    join public.action_items a on a.id = d.item_id
    where d.layer = 'fragment'
      and d.outcome = 'proposed'
      and d.reason = 'pronoun_object'
      and a.status = 'open'
      and d.item_generation = a.reopen_generation
    order by a.id, d.created_at desc, d.id desc
  )
  select p.decision_id, p.item_id, p.description, p.proposed_at, count(*) over ()
  from pending p
  order by p.proposed_at, p.item_id
  limit least(greatest(coalesce(p_limit, 200), 1), 500)
$$;

comment on function public.fragment_pending_proposals(integer) is
  'Pending fragment suspects (layer fragment, outcome proposed, reason pronoun_object) on open items, current generation, one row per item, oldest first; pending_total counts them all. Loop-closing Task 5.1.';

revoke execute on function public.fragment_pending_proposals(integer) from public, anon, authenticated;
grant execute on function public.fragment_pending_proposals(integer) to service_role;
