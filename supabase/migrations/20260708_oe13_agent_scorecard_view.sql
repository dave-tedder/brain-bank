-- OE-13 Sub-phase A — Agent scorecard (Ringer-inspired graft #1)
--
-- Read-only analytics view: first-try pass rate per agent_code x task_type over
-- agent_tasks + agent_task_events. Creates zero board events, promotes/resolves
-- nothing. Its purpose is to quantify the "are the lanes reliable enough to
-- auto-promote" judgment the Phase 4 readiness watch currently makes by eyeball.
--
-- Grain decision (Session 292): agent_tasks carries no task_type column, so we
-- derive task_type from intake_source -- the only genuinely task-shaped column
-- already populated at every intake site (label is a dead constant, risk is
-- nearly all-low, linked-item topics are noisy/expensive to join). Read-only
-- means the grain is cheap to re-grade later; if a first-class task_type is ever
-- authored at intake (Ringer-style), swap the derivation here.
--
-- Metric (from the OE-13 tracker spec, one addition — see judgment call below):
--   first-try pass = the task reached AGENT DONE or AGENT APPLIED with NO
--   AGENT FAILED, NO AGENT HUMAN HOLD, and NO AGENT BLOCKED on it. Reaper resets
--   (release_expired_agent_claims) are written as AGENT FAILED events, so they
--   are already covered by the had_setback test.
--   denominator (attempts_resolved) = tasks that reached a resolution, i.e.
--   success OR a setback. In-flight tasks (claimed but not yet resolved) are
--   reported separately in in_flight and excluded from the rate.
--   Archived (smoke / superseded) rows are excluded.
--
-- Attribution: grouped by claimed_by (who actually attempted the work), falling
-- back to agent_code (assignment) then '(unassigned)'. claimed_by holds the last
-- claimer; across multiple-agent retries this attributes the task to the final
-- claimer -- acceptable at current volume, revisit if cross-agent retries grow.
--
-- Judgment call (resolved Session 292, operator's call): AGENT BLOCKED DOES count as
-- a setback. The metric answers the Phase 4 gate question "can this task type run
-- unattended to completion?" -- a task that blocked and needed unblocking did not,
-- same as an AGENT HUMAN HOLD. Locked now at zero retroactive churn (0 live tasks
-- were ever blocked; all 14 BLOCKED events are on archived smoke rows).
--
-- security_invoker = on so the view honors the underlying service-role-only RLS
-- and does not trip the "Security Definer View" advisor.
--
-- Marginal rollups (task_type-only, or agent-only) are a trivial GROUP BY on top
-- of this view; kept out of the view so it exposes one clean grid.

create or replace view public.agent_scorecard
with (security_invoker = on) as
with per_task as (
  select
    t.id,
    coalesce(t.claimed_by, t.agent_code, '(unassigned)') as agent_code,
    coalesce(t.intake_source, '(unknown)')               as task_type,
    exists (
      select 1 from public.agent_task_events e
      where e.task_id = t.id
        and e.event_type in ('AGENT DONE', 'AGENT APPLIED')
    ) as reached_success,
    exists (
      select 1 from public.agent_task_events e
      where e.task_id = t.id
        and e.event_type in ('AGENT FAILED', 'AGENT HUMAN HOLD', 'AGENT BLOCKED')
    ) as had_setback
  from public.agent_tasks t
  where t.archived_at is null
),
scored as (
  select
    *,
    (reached_success or had_setback)      as resolved,
    (reached_success and not had_setback) as first_try_pass
  from per_task
)
select
  agent_code,
  task_type,
  count(*) filter (where resolved)       as attempts_resolved,
  count(*) filter (where first_try_pass) as first_try_passes,
  count(*) filter (where had_setback)    as setbacks,
  count(*) filter (where not resolved)   as in_flight,
  round(
    100.0 * count(*) filter (where first_try_pass)
    / nullif(count(*) filter (where resolved), 0),
    0
  ) as first_try_pass_pct
from scored
group by agent_code, task_type
order by agent_code, attempts_resolved desc, task_type;

comment on view public.agent_scorecard is
  'OE-13 Sub-phase A: read-only first-try pass-rate scorecard per agent_code x task_type (task_type derived from intake_source). Instruments the Phase 4 readiness gate. first-try pass = reached AGENT DONE/APPLIED with no AGENT FAILED/HUMAN HOLD/BLOCKED; denominator excludes in-flight and archived rows. See migration 20260708_oe13_agent_scorecard_view.sql.';
