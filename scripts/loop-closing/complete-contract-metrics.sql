-- complete-contract metrics (loop-closing Task 5.4 measure, PR 32 decision 7)
-- Read-only. Reads public.complete_contract_events (migration
-- 20261121c_complete_contract_events.sql) and public.agent_task_events. Run each
-- query as written in the SQL editor (or psql); neither writes anything.
--
-- How to read complete_contract_weekly: one row per week (UTC, weeks start
-- Monday) for the current week and the 11 before it, weeks with nothing
-- included. The plan's measure is "new cards reaching Agent Review with zero
-- holds above 90%; ROUTE_SNAPSHOT_UNAVAILABLE warnings 0 on a normal week".
--   agent_done_events        AGENT DONE events (complete_agent_task and
--                            request_agent_review both write one): completions
--                            the contract let through.
--   refused_events           complete-time refusals. Each one is a receipt the
--                            closeout controller would have held, caught while
--                            the agent still held the claim.
--   refused_tasks            distinct cards refused at least once that week.
--   refused_tasks_later_done of those, cards with an AGENT DONE after their
--                            first refusal that week (at any later time): the
--                            agent repaired the receipt and got through.
--   refused_share_pct        refused_events / (refused_events +
--                            agent_done_events), percent; null when both are 0.
--   route_snapshot_unavailable  ROUTE_SNAPSHOT_UNAVAILABLE warnings; the plan's
--                            target is 0 on a normal week.
--   warned_slugs             distinct project slugs behind those warnings.
-- Events are bucketed and ordered by occurred_at, the moment the Edge Function
-- emitted the log line, never by created_at (the later insert's time). Both
-- queries cover exactly the 12 weeks: nothing at or after next Monday counts.
-- Rows exist only from the day the migration is applied; earlier weeks show
-- agent_done_events alone. Closeout-time holds are not in the database (the
-- controller prints them), so the "zero holds" half of the measure still comes
-- from the closeout runs; this table supplies the refusal and warning half.

-- query: complete_contract_weekly
with bounds as (
  select date_trunc('week', now() at time zone 'UTC') - interval '11 weeks' as start_week,
         date_trunc('week', now() at time zone 'UTC') as this_week
),
weeks as (
  select generate_series(b.start_week, b.this_week, interval '1 week')::date as week from bounds b
),
ev as (
  select date_trunc('week', c.occurred_at at time zone 'UTC')::date as week,
         c.task_id, c.outcome, c.reason, c.project_slug, c.occurred_at
  from public.complete_contract_events c, bounds b
  where c.occurred_at at time zone 'UTC' >= b.start_week
    and c.occurred_at at time zone 'UTC' < b.this_week + interval '7 days'
),
done as (
  select date_trunc('week', e.created_at at time zone 'UTC')::date as week
  from public.agent_task_events e, bounds b
  where e.event_type = 'AGENT DONE' and e.created_at at time zone 'UTC' >= b.start_week
    and e.created_at at time zone 'UTC' < b.this_week + interval '7 days'
),
first_refusal as (
  select ev.week, ev.task_id, min(ev.occurred_at) as at
  from ev where ev.outcome = 'refused' and ev.task_id is not null
  group by 1, 2
),
counts as (
  select w.week,
         (select count(*) from done d where d.week = w.week) as agent_done_events,
         (select count(*) from ev where ev.week = w.week and ev.outcome = 'refused') as refused_events,
         (select count(*) from first_refusal f where f.week = w.week) as refused_tasks,
         (select count(*) from first_refusal f
           where f.week = w.week
             and exists (select 1 from public.agent_task_events e
                         where e.task_id = f.task_id and e.event_type = 'AGENT DONE'
                           and e.created_at > f.at)) as refused_tasks_later_done,
         (select count(*) from ev where ev.week = w.week and ev.outcome = 'warned'
                                    and ev.reason = 'ROUTE_SNAPSHOT_UNAVAILABLE') as route_snapshot_unavailable,
         (select count(distinct ev.project_slug) from ev where ev.week = w.week and ev.outcome = 'warned'
                                    and ev.reason = 'ROUTE_SNAPSHOT_UNAVAILABLE') as warned_slugs
  from weeks w
)
select week, agent_done_events, refused_events, refused_tasks, refused_tasks_later_done,
       case when refused_events + agent_done_events = 0 then null
            else round(100.0 * refused_events / (refused_events + agent_done_events), 1) end as refused_share_pct,
       route_snapshot_unavailable, warned_slugs
from counts
order by week;

-- How to read complete_contract_refusal_reasons_by_week: per week (the same 12
-- weeks, by occurred_at), how often each refusal reason fired. A refusal with several reasons
-- counts once under each, so the column sums to more than refused_events.
-- query: complete_contract_refusal_reasons_by_week
select date_trunc('week', c.occurred_at at time zone 'UTC')::date as week,
       r.reason_code, count(*) as refusals
from public.complete_contract_events c
cross join lateral unnest(string_to_array(c.reason, ',')) as r(reason_code)
where c.outcome = 'refused'
  and c.occurred_at at time zone 'UTC' >= date_trunc('week', now() at time zone 'UTC') - interval '11 weeks'
  and c.occurred_at at time zone 'UTC' < date_trunc('week', now() at time zone 'UTC') + interval '7 days'
group by 1, 2
order by 1, 3 desc, 2;
