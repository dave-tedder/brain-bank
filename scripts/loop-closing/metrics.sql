-- metrics v2 (v1 queries unchanged; auto_resolve_outcomes_by_week added by loop-closing Task 1.4)
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

-- status_counts
select count(*) filter (where status = 'open') as open,
       count(*) filter (where status = 'deferred') as deferred,
       count(*) filter (where status = 'resolved') as resolved,
       count(*) filter (where status = 'archived') as archived,
       count(*) filter (where status in ('resolved','archived') and resolved_at is null) as closed_time_unknown
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

-- auto_resolve_outcomes_by_week (metrics v2, Task 1.4)
-- A proposed row whose item closed by another path (done: command, a card
-- verb, resolve_action_item) counts as closed_otherwise, never as kept or
-- accepted.
select date_trunc('week', d.created_at at time zone 'UTC')::date as week,
       d.layer,
       case when d.outcome = 'proposed' and a.status in ('resolved','archived') then 'closed_otherwise'
            else d.outcome end as outcome,
       d.reason,
       count(*) as decisions
from auto_resolve_decisions d
left join action_items a on a.id = d.item_id
group by 1, 2, 3, 4 order by 1, 2, 3, 4;
