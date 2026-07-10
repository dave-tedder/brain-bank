-- OE-12 Phase 4 readiness watch, part 2: the operator's rulings table, the two
-- watch views, and their grants. Companion to 20260710_oe12_agent_run_log.sql.

-- The operator's verdict on PENDING_REVIEW (draft) days. Re-rulable: a draft
-- archived three days later legitimately flips its creation day, so UPDATE
-- stays granted. DELETE does not.
create table public.oe_watch_rulings (
  watch_date date primary key,
  verdict text not null check (verdict in ('clean', 'dirty')),
  ruled_by text not null default 'operator',
  ruled_at timestamptz not null default now(),
  note text
);

alter table public.oe_watch_rulings enable row level security;
revoke all on public.oe_watch_rulings from anon, authenticated;
grant select, insert, update on public.oe_watch_rulings to service_role;
revoke delete on public.oe_watch_rulings from service_role;

-- One row per settled ET day. Day boundary is America/New_York by
-- construction (DST-safe; UTC-anchored scheduled lanes shift an hour when ET
-- leaves daylight time).
--
-- THE RUBRIC KEYS ON AUTHORSHIP, NOT DRAFT STATE. Draft state appears in no
-- condition: a draft the operator promoted, the executor claimed, and the
-- critic reviewed is indistinguishable here from one still Standing. Only the
-- triage lane's own authorship can dirty a day. (A state-keyed rubric would
-- mark a day DIRTY whenever the operator promotes a same-day draft, punishing
-- the exact board use the system exists to enable.)
--
-- "the triage lane authors zero events" is an empirical claim, not a schema
-- constraint. If triage ever legitimately writes an event, the day flips
-- DIRTY and the streak visibly resets - loud, not silent - forcing a rubric
-- review rather than a miscount.
--
-- The "action_items resolved/deferred by the triage lane" DIRTY clause is
-- deliberately absent: action_items carries no actor attribution anywhere in
-- the schema, and every proxy would dirty days on the OPERATOR's resolutions,
-- which the rubric exists to keep free. Recorded limit; durable cure is an
-- additive actor column stamped at the MCP write path (separate lane, Edge
-- Function deploy required).
create view public.oe_triage_watch_days
with (security_invoker = on) as
with runs as (
  select (ran_at at time zone 'America/New_York')::date as et_day,
         count(*) as run_count
  from public.agent_run_log
  where agent_code = 'triage'
  group by 1
),
bounds as (
  select min(et_day) as first_day from runs
),
-- A day is settled when it is strictly before today (ET), or it is today and
-- a triage run row already exists for it. Without this rule, every morning
-- before the scheduled triage run would report the current day as MISSING and
-- appear to reset the streak.
settled as (
  select gs::date as et_day
  from bounds,
       generate_series(bounds.first_day,
                       (now() at time zone 'America/New_York')::date,
                       interval '1 day') gs
  where gs::date < (now() at time zone 'America/New_York')::date
     or gs::date in (select et_day from runs)
),
triage_events as (
  select (created_at at time zone 'America/New_York')::date as et_day,
         count(*) as n
  from public.agent_task_events
  where agent_code = 'triage'
  group by 1
),
drafts as (
  select (created_at at time zone 'America/New_York')::date as et_day,
         count(*) as n,
         array_agg(id order by created_at) as draft_ids
  from public.agent_tasks
  where intake_source = 'triage-agent'
  group by 1
)
select
  s.et_day,
  coalesce(r.run_count, 0) as run_count,
  coalesce(d.n, 0) as drafts_created,
  d.draft_ids,
  coalesce(te.n, 0) as triage_authored_events,
  case
    when r.et_day is null then 'MISSING'
    when coalesce(te.n, 0) > 0 then 'DIRTY'
    when coalesce(d.n, 0) = 0 then 'CLEAN'
    else 'PENDING_REVIEW'
  end as mechanical_verdict,
  ru.verdict as ruling,
  -- Integrity rule: a ruling resolves PENDING_REVIEW only. It can never
  -- convert MISSING or DIRTY to clean - nobody, including the operator, can
  -- rule a day clean when the record says the lane never ran. This is what
  -- stops the system decaying back into a table someone edits to make the
  -- number go up.
  case
    when r.et_day is null then 'MISSING'
    when coalesce(te.n, 0) > 0 then 'DIRTY'
    when coalesce(d.n, 0) = 0 then 'CLEAN'
    when ru.verdict = 'clean' then 'CLEAN'
    when ru.verdict = 'dirty' then 'DIRTY'
    else 'PENDING_REVIEW'
  end as effective_verdict
from settled s
left join runs r using (et_day)
left join triage_events te using (et_day)
left join drafts d using (et_day)
left join public.oe_watch_rulings ru on ru.watch_date = s.et_day;

-- Single row: consecutive effective-CLEAN days ending at the latest settled
-- day, plus the day and verdict that terminate the streak so a drop is
-- legible instead of alarming. Reports the streak; does NOT open the gate.
-- Phase 4 still requires 5 consecutive CLEAN days AND the operator's explicit
-- go.
create view public.oe_triage_watch_streak
with (security_invoker = on) as
with days as (
  select et_day, effective_verdict from public.oe_triage_watch_days
),
term as (
  select max(et_day) as term_day
  from days
  where effective_verdict <> 'CLEAN'
)
select
  (select count(*)
   from days, term
   where days.effective_verdict = 'CLEAN'
     and (term.term_day is null or days.et_day > term.term_day)) as clean_streak,
  term.term_day as terminated_by_day,
  (select effective_verdict from days where et_day = term.term_day) as terminated_by_verdict,
  (select max(et_day) from days) as latest_settled_day
from term;

revoke all on public.oe_triage_watch_days from anon, authenticated;
revoke all on public.oe_triage_watch_streak from anon, authenticated;
grant select on public.oe_triage_watch_days to service_role;
grant select on public.oe_triage_watch_streak to service_role;
