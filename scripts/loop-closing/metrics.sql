-- metrics v4 (v1 queries unchanged; auto_resolve_outcomes_by_week added by loop-closing Task 1.4, generation_scope added by the Task 3.1 amendment, candidate_axis_attribution added by Task 6.1)
-- created_by_week_and_class
select date_trunc('week', a.created_at at time zone 'UTC')::date as week,
       case when t.content ~* 'session \d+|handoff|closed \(|commit [0-9a-f]{6,}|tracker|deliverables/|task [0-9a-f]{8}\y|\[OE:' then 'work_report'
            when t.metadata->>'source' = 'external-crm' then 'intake'
            else 'other' end as class, count(*) as items
from action_items a left join thoughts t on t.id = a.source_thought_id
group by 1, 2 order by 1, 2;

-- closed_by_week_and_path
select date_trunc('week', a.resolved_at at time zone 'UTC')::date as week,
       case when a.resolved_by_thought_id is not null then 'auto'
            when exists (select 1 from agent_task_events e
                         where e.payload->>'linked_action_item_id' = a.id::text
                           and e.payload->>'linked_action_item_outcome' = 'resolved') then 'card'
            when a.resolution_note like 'Chief of Staff%' then 'sweep'
            when nullif(trim(a.resolution_note), '') is not null then 'manual_note'
            when a.status = 'resolved' then 'ambiguous_done_or_card'
            else 'unknown' end as path, count(*) as items
from action_items a where status in ('resolved','archived')
group by 1, 2 order by 1, 2;

-- closes_by_reason_since_task_3_1 (Task 3.1 measure: the null bucket stops growing)
select date_trunc('week', coalesce(a.closed_at, a.resolved_at) at time zone 'UTC')::date as week,
       coalesce(a.close_reason, 'unknown') as close_reason, count(*) as items
from action_items a where status in ('resolved','archived')
group by 1, 2 order by 1, 2;

-- action_item_events_by_actor (Task 3.1 measure: actor = sql since the ship date is a defect)
select date_trunc('week', e.at at time zone 'UTC')::date as week, e.actor,
       e.old_status, e.new_status, count(*) as events
from action_item_events e group by 1, 2, 3, 4 order by 1, 2, 3, 4;

-- status_counts
select count(*) filter (where status = 'open') as open,
       count(*) filter (where status = 'deferred') as deferred,
       count(*) filter (where status = 'resolved') as resolved,
       count(*) filter (where status = 'archived') as archived,
       count(*) filter (where status in ('resolved','archived') and resolved_at is null and closed_at is null) as closed_time_unknown
from action_items;

-- open_age_histogram
select count(*) filter (where created_at > now() - interval '7 days') as under_7,
       count(*) filter (where created_at <= now() - interval '7 days' and created_at > now() - interval '30 days') as days_7_29,
       count(*) filter (where created_at <= now() - interval '30 days' and created_at > now() - interval '60 days') as days_30_59,
       count(*) filter (where created_at <= now() - interval '60 days') as days_60_plus
from action_items where status = 'open';

-- board_nonterminal_age
select t.id, t.status, floor(extract(epoch from now() - t.created_at)/86400)::int as age_days,
       t.close_check is not null as has_close_check,
       a.status in ('resolved','archived') as linked_item_closed
from agent_tasks t left join action_items a on a.id = t.linked_action_item_id
where t.archived_at is null and t.status <> 'Agent Done'
order by t.created_at, t.id;

-- digest_open_series_14d
with daily as (
  select digest_date, (metadata->>'open_actions_count')::int as n
  from digests where digest_type = 'daily'
)
select a.digest_date, a.n, b.n as n_14d_ago
from daily a join daily b on b.digest_date = a.digest_date - 14
where a.n > 100 and a.n >= b.n * 1.2
order by a.digest_date;

-- auto_resolve_outcomes_by_week (metrics v3, Task 1.4, Task 3.1 amendment)
-- generation_scope applies Task 3.1's rule, item_generation = reopen_generation:
-- capture (no item), current, or prior_generation (the item was reopened since).
-- Pending proposals are generation_scope = 'current' and outcome = 'proposed'. A
-- current-generation proposal whose item closed by another path (done: command, a
-- card verb, resolve_action_item) counts as closed_otherwise, never as kept or
-- accepted. A prior-generation row stays as it was written: it is history, it is
-- never pending, and the item's current status says nothing about it.
select date_trunc('week', d.created_at at time zone 'UTC')::date as week,
       d.layer,
       case when d.item_id is null then 'capture'
            when d.item_generation is not distinct from a.reopen_generation then 'current'
            else 'prior_generation' end as generation_scope,
       case when d.outcome = 'proposed'
                 and d.item_generation is not distinct from a.reopen_generation
                 and a.status in ('resolved','archived') then 'closed_otherwise'
            else d.outcome end as outcome,
       d.reason,
       count(*) as decisions
from auto_resolve_decisions d
left join action_items a on a.id = d.item_id
group by 1, 2, 3, 4, 5 order by 1, 2, 3, 4, 5;

-- candidate_axis_attribution (metrics v4, loop-closing Task 6.1)
-- Per week, over the candidate sets LAYER 2 saw, as successfully recorded distinct thought/item pairs
-- (auto_resolve_decisions rows L2/L3/L3.5/resolved with a thought and an item, available from 2026-11-05): how many
-- candidates reached LAYER 2 ONLY through the operator's own name on the people axis. Both capture files write each
-- candidate LAYER 2 sees into one of those four layers: L2 (not claimed, or the model call or parse failed), L3 (claimed,
-- no quote or coverage too low), L3.5 (claimed, passed L3, vetoed as still owed) or resolved. L1.5 is left out on
-- purpose: it drops restatements BEFORE LAYER 2. A failed decision insert, or a claimed item that left `open` before the
-- guarded resolve, leaves no row, and repeated evaluations of one pair count once. Routes are recomputed the way
-- find_candidate_action_items tests them; a project or topic match, or any other shared person, keeps a candidate.
-- operator_names is the case-insensitive list of the forms your own name takes in captured people metadata: replace
-- the placeholders below with yours (first name alone usually carries almost all of it). other_person_via_operator: the capture names someone else
-- and the operator-only candidate names a different, non-operator person (the wrong-client exposure).
-- Read-only; run as written.
with operator_names(name) as (values ('alex'),('alex rivera'),('alex-rivera'),('alexrivera')),
shown as (
  select d.thought_id, d.item_id, min(d.created_at) as at
  from auto_resolve_decisions d
  where d.layer in ('L2','L3','L3.5','resolved') and d.thought_id is not null and d.item_id is not null
  group by 1, 2
),
cap as (
  select t.id as thought_id, nullif(t.metadata->>'project','') as p_project,
         case when jsonb_typeof(t.metadata->'topics') = 'array' then array(select jsonb_array_elements_text(t.metadata->'topics')) else '{}'::text[] end as p_topics,
         array(select x from jsonb_array_elements_text(case when jsonb_typeof(t.metadata->'people') = 'array' then t.metadata->'people' else '[]'::jsonb end) x
               where lower(btrim(x)) in (select name from operator_names)) as p_op,
         array(select x from jsonb_array_elements_text(case when jsonb_typeof(t.metadata->'people') = 'array' then t.metadata->'people' else '[]'::jsonb end) x
               where lower(btrim(x)) not in (select name from operator_names)) as p_other
  from thoughts t where t.id in (select thought_id from shown)
),
routes as (
  select s.at, s.thought_id, c.p_other,
         coalesce(c.p_project is not null and src.metadata->>'project' = c.p_project, false)
           or (cardinality(c.p_topics) > 0 and coalesce(src.metadata->'topics' ?| c.p_topics, false)) as via_project_or_topic,
         (cardinality(c.p_op) > 0 and coalesce(src.metadata->'people' ?| c.p_op, false)) as via_operator,
         (cardinality(c.p_other) > 0 and coalesce(src.metadata->'people' ?| c.p_other, false)) as via_other_person,
         array(select x from jsonb_array_elements_text(case when jsonb_typeof(src.metadata->'people') = 'array' then src.metadata->'people' else '[]'::jsonb end) x
               where lower(btrim(x)) not in (select name from operator_names) and not (x = any(c.p_other))) as src_other_people
  from shown s join cap c on c.thought_id = s.thought_id
  join action_items ai on ai.id = s.item_id join thoughts src on src.id = ai.source_thought_id
)
select date_trunc('week', at at time zone 'UTC')::date as week,
       count(distinct thought_id) as captures,
       count(*) as candidates,
       count(*) filter (where via_operator and not via_project_or_topic and not via_other_person) as operator_only,
       count(*) filter (where via_project_or_topic or via_other_person) as without_operator_axis,
       count(*) filter (where via_operator and not via_project_or_topic and not via_other_person
                          and cardinality(p_other) > 0 and cardinality(src_other_people) > 0) as other_person_via_operator
from routes group by 1 order by 1;
