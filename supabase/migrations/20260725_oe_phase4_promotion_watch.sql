-- OE-12 Phase 4 readiness: measure the watch by OBSERVED AUTO-PROMOTIONS,
-- not calendar days. ADDITIVE ONLY.
--
-- The day-shaped machinery is left FULLY INTACT: oe_triage_watch_days,
-- oe_triage_watch_streak, oe_watch_rulings, and the PHASE4_WATCH_DAY0 marker
-- in triage-auto's ledger notes are untouched, so nothing reading them
-- breaks and a rollback is a one-line revert (drop the two views + the table).
--
-- Why this exists: the calendar-day streak measured days-since-day0, so
-- several "clean" watch days were days on which nothing happened, and the
-- gate was positioned to be declared ready on a handful of lifetime
-- promotions. A rep count asks "have we seen enough?" where a countdown asks
-- "has enough time passed?". Same gate, better question.
--
-- The gate's graduation CONDITION is unchanged: it still requires the
-- operator's explicit go. There is no graduation code path anywhere; reaching
-- the target only makes the gate ELIGIBLE for that go. These are REPORTING
-- surfaces only and cannot open the gate.

-- ---------------------------------------------------------------------------
-- 1. Per-promotion rulings. oe_watch_rulings rules whole DAYS; this rules
--    individual auto-promotions, so a veto is visible against the specific
--    card that earned it instead of silently reducing a day tally. Keyed on
--    the promoted task (one auto-promotion per task in practice). Re-rulable
--    (UPDATE granted) so a mistaken veto can be corrected; DELETE stays
--    revoked, mirroring oe_watch_rulings.
-- ---------------------------------------------------------------------------
create table if not exists public.oe_promotion_rulings (
  task_id uuid primary key references public.agent_tasks(id) on delete cascade,
  verdict text not null check (verdict in ('good', 'vetoed')),
  ruled_by text not null default 'operator',
  ruled_at timestamptz not null default now(),
  note text
);

alter table public.oe_promotion_rulings enable row level security;
revoke all on public.oe_promotion_rulings from anon, authenticated;
grant select, insert, update on public.oe_promotion_rulings to service_role;
revoke delete on public.oe_promotion_rulings from service_role;

comment on table public.oe_promotion_rulings is
  'OE-12 Phase 4 per-promotion verdicts. One row per auto-promoted task the operator rules good or vetoed. Additive to the day-shaped oe_watch_rulings, which is left intact. Re-rulable (UPDATE granted, DELETE revoked). A vetoed row counts toward M in the "N observed, M vetoed" readiness figure and, per the Phase 4 design, is the operator''s cue to reset the PHASE4_WATCH_DAY0 marker.';

-- ---------------------------------------------------------------------------
-- 2. One row per lifetime auto-promotion, each individually visible and
--    rulable. "Individually ruled, not merely counted": this is the surface
--    the operator rules from. Auto-promotions are identified exactly as the
--    daily-cap counter inside auto_promote_agent_task_intake identifies them:
--    an AGENT STATUS event whose payload.action = 'auto-promoted'. Only
--    triage-auto ever authors that action; the match is kept author-agnostic
--    to stay byte-identical to the function's own cap query.
-- ---------------------------------------------------------------------------
create view public.oe_phase4_promotions
with (security_invoker = on) as
select
  e.task_id,
  (e.created_at at time zone 'America/New_York')::date as promoted_et_day,
  e.created_at                                          as promoted_at,
  (e.payload->>'allowlist_category')::int              as allowlist_category,
  e.payload->>'rationale'                              as rationale,
  t.title,
  t.status                                             as current_status,
  t.archived_at,
  coalesce(r.verdict, 'unruled')                       as verdict,
  r.ruled_at,
  r.note                                               as ruling_note
from public.agent_task_events e
join public.agent_tasks t on t.id = e.task_id
left join public.oe_promotion_rulings r on r.task_id = e.task_id
where e.event_type = 'AGENT STATUS'
  and e.payload->>'action' = 'auto-promoted';

-- ---------------------------------------------------------------------------
-- 3. The single summary row the briefing reads: "N observed, M vetoed"
--    against the target. observed counts DISTINCT auto-promoted tasks (a
--    task can only be auto-promoted once in practice; distinct guards the
--    tally if that ever changes). vetoed counts those with a 'vetoed' ruling;
--    clean_observed = observed - vetoed. target is read from the SINGLE
--    source of truth: the PHASE4_WATCH_TARGET marker in triage-auto's
--    ledger notes (the same row carrying PHASE4_WATCH_DAY0). One place, three
--    readers: this view via SQL, the sentinel via read_agent_ledger, and the
--    skills by name. REPORTS ONLY; contains no graduation logic and cannot
--    open the gate.
-- ---------------------------------------------------------------------------
create view public.oe_phase4_watch_tally
with (security_invoker = on) as
with promos as (
  select distinct task_id
  from public.agent_task_events
  where event_type = 'AGENT STATUS'
    and payload->>'action' = 'auto-promoted'
),
vetoes as (
  select count(*) as n
  from public.oe_promotion_rulings r
  where r.verdict = 'vetoed'
    and exists (select 1 from promos p where p.task_id = r.task_id)
),
tgt as (
  select (substring(notes from 'PHASE4_WATCH_TARGET=([0-9]+)'))::int as target
  from public.agent_task_ledger
  where agent_code = 'triage-auto'
),
day0 as (
  select min((created_at at time zone 'America/New_York')::date) as day0_et
  from public.agent_task_events
  where event_type = 'AGENT STATUS'
    and payload->>'action' = 'auto-promoted'
)
select
  (select count(*) from promos)                                       as observed,
  (select n from vetoes)                                              as vetoed,
  (select count(*) from promos) - (select n from vetoes)             as clean_observed,
  (select target from tgt)                                            as target,
  greatest(
    coalesce((select target from tgt), 0)
      - ((select count(*) from promos) - (select n from vetoes)),
    0
  )                                                                   as remaining_to_target,
  (select day0_et from day0)                                          as day0_et;

revoke all on public.oe_phase4_promotions   from anon, authenticated;
revoke all on public.oe_phase4_watch_tally  from anon, authenticated;
grant select on public.oe_phase4_promotions  to service_role;
grant select on public.oe_phase4_watch_tally to service_role;

notify pgrst, 'reload schema';
