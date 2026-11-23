-- Loop-closing Task 3.2 follow-up to Task 5.3: archive proposals exempt any
-- open item that carries a client_id.
--
-- What: re-creates public.archive_proposals_due(p_now) with ONE added
-- predicate, "and a.client_id is null", next to the existing text rule
-- "and not public.archive_policy_client_shaped(a.description)". Nothing else in
-- the body changes. Signature, return type, language, STABLE and search_path
-- are identical to 20261119_action_items_archive_proposal_job.sql.
-- run_archive_proposals reads its due set from this function both before and
-- after its pre-lock, so the writer follows the new rule with no change of its own.
--
-- Why: Task 5.3 (20261121b_action_items_client_id.sql) sets
-- action_items.client_id at insert when an item's text names exactly one
-- client, including a lone first name that only one client has. The text rule
-- (archive_policy_client_shaped) exempts a full client name or a first name
-- shared by two or more clients, but NOT a unique first name, so such an item
-- got a client_id and was still proposed for archive at 60 days. The plan
-- (Task 3.2, Interfaces) names client_id as the client-shaped signal after
-- Task 5.3. The client_id rule is IN ADDITION to the text rule, never instead
-- of it: rows from before Task 5.3 carry no client_id (there is no backfill),
-- and a deleted client sets client_id back to null (on delete set null), so
-- those items are still judged by their text.
--
-- Mirror: supabase/functions/_shared/archive-policy.ts (archiveDueAt) is the
-- reference and gains the same rule; scripts/loop-closing/archive-proposals-diff.ts
-- runs both over the same rows, including rows that carry a client_id.
--
-- Depends on: 20261121b_action_items_client_id.sql (the column).
--
-- Rollback: re-create public.archive_proposals_due(p_now timestamptz) with the
-- body from 20261119_action_items_archive_proposal_job.sql unchanged (live
-- md5(prosrc) 6f1436b637b7dcf75c66e00186d02863 before this migration). The
-- column stays; nothing else to undo.
--
-- Grants: create or replace keeps the existing ACL. 20261119 revoked execute
-- from public, anon and authenticated and granted it to service_role; both are
-- restated below so this file holds on its own.

create or replace function public.archive_proposals_due(p_now timestamptz)
returns table (item_id uuid, reason text, due_at timestamptz, action text)
language sql
stable
set search_path = pg_catalog, public
as $$
  select a.id,
    r.reason,
    r.due_at,
    case
      when a.archive_review_outcome = 'accepted' then 'accepted'
      when a.archive_review_outcome = 'kept' then
        case when a.archive_reviewed_at > p_now - interval '2160 hours'
          then 'kept_recently' else 'repropose' end
      when a.archive_proposed_at is not null then 'pending'
      else 'propose'
    end
  from public.action_items a
  left join public.thoughts th on th.id = a.source_thought_id
  cross join lateral (select public.archive_policy_deadline(a.description) as dl) d
  cross join lateral (
    select
      case
        when d.dl is not null then 'deadline_passed'
        when public.archive_policy_is_work_report(th.content, th.created_at)
          or exists (
            select 1 from public.auto_resolve_decisions f
            where f.item_id = a.id and f.layer = 'fragment'
              and f.item_generation = a.reopen_generation
          ) then 'age_work_report'
        else 'age_standard'
      end as reason
  ) k
  cross join lateral (
    select k.reason,
      case k.reason
        when 'deadline_passed' then (d.dl::timestamp at time zone 'UTC') + interval '336 hours'
        when 'age_work_report' then a.created_at + interval '720 hours'
        else a.created_at + interval '1440 hours'
      end as due_at
  ) r
  where a.status = 'open'
    and not (public.archive_policy_js_lower(a.description) like '%perpetual%'
             and (public.archive_policy_js_lower(a.description) like '%canary%'
                  or public.archive_policy_js_lower(a.description) like '%tripwire%'))
    and not exists (
      select 1 from public.agent_tasks t
      where t.linked_action_item_id = a.id
        and t.archived_at is null
        and t.status <> 'Agent Done'
    )
    and (a.reopened_at is null or a.reopened_at <= p_now - interval '2160 hours')
    and not public.archive_policy_client_shaped(a.description)
    and a.client_id is null
    and r.due_at <= p_now
  order by a.id;
$$;

revoke execute on function public.archive_proposals_due(timestamptz) from public, anon, authenticated;
grant execute on function public.archive_proposals_due(timestamptz) to service_role;
