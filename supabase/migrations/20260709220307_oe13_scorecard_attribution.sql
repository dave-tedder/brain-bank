-- OE-13 scorecard attribution correction.
--
-- Fixes WS-2 from the 2026-07-09 Open Engine corrections program:
-- - attribute resolved work to the actual executor even when completion clears
--   agent_tasks.claimed_by, by falling back to the newest AGENT DONE event;
-- - keep active reworked tasks out of the resolved denominator until they
--   resolve again;
-- - count critic_verdict='flagged' as a setback for Phase 4 evidence quality;
-- - make the view's public grants explicit.

create or replace view public.agent_scorecard
with (security_invoker = on) as
with per_task as (
  select
    t.id,
    coalesce(t.claimed_by, latest_done.agent_code, t.agent_code, '(unassigned)') as agent_code,
    coalesce(t.intake_source, '(unknown)')                                      as task_type,
    t.status in (
      'Standing',
      'Agent Todo',
      'Agent Working',
      'Agent Needs Input',
      'Agent Review',
      'Needs Operator'
    ) as is_active,
    exists (
      select 1
      from public.agent_task_events e
      where e.task_id = t.id
        and e.event_type in ('AGENT DONE', 'AGENT APPLIED')
    ) as reached_success,
    (
      t.critic_verdict = 'flagged'
      or exists (
        select 1
        from public.agent_task_events e
        where e.task_id = t.id
          and e.event_type in ('AGENT FAILED', 'AGENT HUMAN HOLD', 'AGENT BLOCKED')
      )
    ) as had_setback
  from public.agent_tasks t
  left join lateral (
    select e.agent_code
    from public.agent_task_events e
    where e.task_id = t.id
      and e.event_type = 'AGENT DONE'
      and e.agent_code is not null
    order by e.created_at desc, e.id desc
    limit 1
  ) latest_done on true
  where t.archived_at is null
),
scored as (
  select
    *,
    (not is_active and (reached_success or had_setback)) as resolved,
    (not is_active and reached_success and not had_setback) as first_try_pass
  from per_task
)
select
  agent_code,
  task_type,
  count(*) filter (where resolved) as attempts_resolved,
  count(*) filter (where first_try_pass) as first_try_passes,
  count(*) filter (where resolved and had_setback) as setbacks,
  count(*) filter (where not resolved) as in_flight,
  round(
    100.0 * count(*) filter (where first_try_pass)
    / nullif(count(*) filter (where resolved), 0),
    0
  ) as first_try_pass_pct
from scored
group by agent_code, task_type
order by agent_code, attempts_resolved desc, task_type;

comment on view public.agent_scorecard is
  'OE-13 Sub-phase A: read-only first-try pass-rate scorecard per executor x task_type (task_type derived from intake_source). Executor attribution falls back from claimed_by to newest AGENT DONE agent_code, then assigned agent_code. first-try pass = non-active task reached AGENT DONE/APPLIED with no AGENT FAILED/HUMAN HOLD/BLOCKED and no flagged critic verdict; active reworked tasks are excluded from the resolved denominator. See migration 20260709220307_oe13_scorecard_attribution.sql.';

revoke select on public.agent_scorecard from anon, authenticated;
grant select on public.agent_scorecard to service_role;
