-- OE-12 Phase 4 — Guarded auto-promote.
--
-- Adds ONE narrow autonomous action: after triage drafts in a run, the subset
-- of same-run drafts that pass a strict server-side allowlist may move from
-- Standing -> Agent Todo WITHOUT a human promote click, at most N per UTC day.
-- The human promote path (promote_agent_task_intake) is UNTOUCHED.
--
-- Depends on 20260715_oe_ops_verbs_c2_c3 (requires_local column). Filename
-- "oe_phase4" sorts AFTER "oe_ops_verbs" on a fresh replay, so the column
-- exists before this function references it.
--
-- Three artifacts:
--   1. triage-auto ledger row — an EVENT-AUTHOR identity only. Required because
--      agent_task_events.agent_code has an FK to agent_task_ledger. It is NOT a
--      scheduled lane: it writes no agent_run_log, has no schedule, and is
--      deliberately absent from the sentinel's explicit lane list, so it is
--      never checked for freshness. Its only jobs: satisfy the FK and keep
--      autonomous promotions distinguishable from an operator's NULL-authored
--      promotes in agent_task_events / agent_scorecard. It MUST NOT be 'triage'
--      (the readiness-watch DIRTY predicate keys on
--      agent_task_events.agent_code = 'triage'; authoring as triage would mark
--      every auto-promote day DIRTY and poison the watch).
--   2. oe_auto_promote_config — a single-row config table (daily cap + enabled
--      flag) so rollback levels 1/2 need no redeploy: set enabled false OR
--      daily_cap 0 and every call refuses server-side.
--   3. auto_promote_agent_task_intake — SECURITY DEFINER, fail-closed. Enforces
--      every server-side allowlist condition (A-I) + the daily cap (H) in one
--      transaction. On success: UNASSIGNED Agent Todo row + one AGENT STATUS
--      event authored by triage-auto. On any failed condition: RAISE (leaves the
--      draft Standing, legible to the triage run, never retried in-run). Never
--      touches attempt_count or claim state.
--
-- Signature note: the event must carry payload.rationale and payload.allowlist_
-- category. Those are caller-supplied (rubric-side, condition J — recorded, not
-- structurally enforced), so the signature adds p_allowlist_category and
-- p_rationale. They are validated only for shape (category 1-4, rationale
-- non-empty) so the audit trail is never blank.

-- ---------------------------------------------------------------------------
-- 1. triage-auto event-author identity (FK requirement; NOT a lane).
-- ---------------------------------------------------------------------------

insert into public.agent_task_ledger
  (agent_code, operator, runtime, automation, automation_state, notes)
values
  ('triage-auto', 'Local Operator', 'claude', null, 'manual-required',
   'OE-12 Phase 4 event-author identity ONLY, not a scheduled lane. Auto-promote (auto_promote_agent_task_intake) authors its single AGENT STATUS {action:auto-promoted} event as this code so autonomous promotions stay distinguishable from an operator''s NULL-authored human promotes in agent_task_events / agent_scorecard. It writes no agent_run_log, runs on no schedule, and is intentionally absent from the sentinel''s explicit lane list, so the sentinel never checks it for freshness. Exists to satisfy the agent_task_events.agent_code FK. MUST NOT be triage: the readiness-watch DIRTY predicate keys on events authored by triage; authoring here as triage would dirty every auto-promote day and poison the readiness watch.')
on conflict (agent_code) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Single-row config: daily cap + enabled flag (no-deploy rollback).
-- ---------------------------------------------------------------------------

create table if not exists public.oe_auto_promote_config (
  id boolean primary key default true,
  enabled boolean not null default false,
  daily_cap integer not null default 5,
  updated_at timestamptz not null default now(),
  constraint oe_auto_promote_config_singleton check (id = true),
  constraint oe_auto_promote_config_cap_nonneg check (daily_cap >= 0)
);

comment on table public.oe_auto_promote_config is
  'OE-12 Phase 4 auto-promote config. Single row (id=true). enabled=false is the instant server-side off-switch (rollback level 2); daily_cap=0 has the same effect via the cap check. Ships OFF (enabled false, daily_cap 5 per UTC day): autonomous promotion is opt-in, so flip enabled=true only once you have your own clean-day evidence.';

alter table public.oe_auto_promote_config enable row level security;
revoke all on public.oe_auto_promote_config from anon, authenticated;

drop policy if exists "Service role full access on oe_auto_promote_config"
  on public.oe_auto_promote_config;
create policy "Service role full access on oe_auto_promote_config"
  on public.oe_auto_promote_config for all
  using (auth.role() = 'service_role'::text);

-- Ships OFF. All four allowlist categories are wired at cap 5/UTC-day, but
-- enabled=false so a fresh install never machine-promotes work into the claim
-- pool before the operator has decided to allow it. Flip to true once you have
-- your own clean-day evidence (see the Phase 4 readiness watch).
insert into public.oe_auto_promote_config (id, enabled, daily_cap)
values (true, false, 5)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. auto_promote_agent_task_intake — the guarded autonomous promote.
-- ---------------------------------------------------------------------------

create or replace function public.auto_promote_agent_task_intake(
  p_task_id uuid,
  p_caller_agent_code text,
  p_allowlist_category integer,
  p_rationale text
)
returns public.agent_tasks
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_task public.agent_tasks;
  v_enabled boolean;
  v_daily_cap integer;
  v_today_count integer;
  v_rationale text;
begin
  -- ---- Caller identity (condition G). Self-attested on the shared key; the
  -- tool layer re-checks. Fail-closed with 42501 to mirror the C2 pattern.
  if coalesce(p_caller_agent_code, '') <> 'triage' then
    raise exception 'AUTO_PROMOTE_REFUSED (G caller): only triage may auto-promote; got %', coalesce(p_caller_agent_code, '<null>')
      using errcode = '42501';
  end if;

  -- ---- Rubric-side payload shape (condition J). Recorded, not a safety gate,
  -- but never blank: an auto-promotion with no category or reason is not
  -- auditable, so reject a malformed audit trail up front.
  if p_allowlist_category is null or p_allowlist_category not between 1 and 4 then
    raise exception 'AUTO_PROMOTE_REFUSED (J category): allowlist_category must be 1..4; got %', coalesce(p_allowlist_category::text, '<null>')
      using errcode = '22023';
  end if;
  v_rationale := nullif(trim(coalesce(p_rationale, '')), '');
  if v_rationale is null then
    raise exception 'AUTO_PROMOTE_REFUSED (J rationale): a one-sentence rationale is required for the audit event'
      using errcode = '22023';
  end if;

  -- ---- Config gate (rollback level 2). Missing row = fail closed.
  select enabled, daily_cap into v_enabled, v_daily_cap
  from public.oe_auto_promote_config
  where id = true;
  if not found or v_enabled is not true then
    raise exception 'AUTO_PROMOTE_DISABLED: auto-promote is switched off (oe_auto_promote_config.enabled is not true)'
      using errcode = '22023';
  end if;

  -- ---- Load + lock the draft. FOR UPDATE guards a concurrent double-promote.
  select * into v_task
  from public.agent_tasks
  where id = p_task_id
  for update;
  if not found then
    raise exception 'Task not found: %', p_task_id using errcode = 'P0002';
  end if;

  -- ---- Row-property conditions (A-F, I). These hold regardless of caller
  -- honesty; a dishonest key cannot fake a row it did not create.
  -- C: status Standing + not archived.
  if v_task.archived_at is not null then
    raise exception 'AUTO_PROMOTE_REFUSED (C archived): task % is archived', p_task_id
      using errcode = '22023';
  end if;
  if v_task.status <> 'Standing' then
    raise exception 'AUTO_PROMOTE_REFUSED (C status): only Standing drafts auto-promote; task % is %', p_task_id, v_task.status
      using errcode = '22023';
  end if;
  -- D: triage-authored.
  if coalesce(v_task.intake_source, '') <> 'triage-agent' then
    raise exception 'AUTO_PROMOTE_REFUSED (D intake_source): expected triage-agent; got %', coalesce(v_task.intake_source, '<null>')
      using errcode = '22023';
  end if;
  -- A: low risk.
  if coalesce(v_task.risk, '') <> 'low' then
    raise exception 'AUTO_PROMOTE_REFUSED (A risk): only low-risk drafts auto-promote; got %', coalesce(v_task.risk, '<null>')
      using errcode = '22023';
  end if;
  -- B: no explicit approval.
  if v_task.explicit_approval is true then
    raise exception 'AUTO_PROMOTE_REFUSED (B explicit_approval): a draft flagged explicit_approval requires a human promote'
      using errcode = '22023';
  end if;
  -- E: linked to an action item.
  if v_task.linked_action_item_id is null then
    raise exception 'AUTO_PROMOTE_REFUSED (E linked_action_item_id): draft is not linked to an action item'
      using errcode = '22023';
  end if;
  -- F: full packet.
  if nullif(trim(coalesce(v_task.desired_outcome, '')), '') is null
     or nullif(trim(coalesce(v_task.acceptance_criteria, '')), '') is null
     or nullif(trim(coalesce(v_task.boundaries, '')), '') is null then
    raise exception 'AUTO_PROMOTE_REFUSED (F packet): desired_outcome, acceptance_criteria, and boundaries must all be non-empty'
      using errcode = '22023';
  end if;
  -- I: not local-only (the C2 hard constraint). A requires_local task can never
  -- be executed by a scheduled lane, so auto-promoting it would strand it — refuse.
  if v_task.requires_local is true then
    raise exception 'AUTO_PROMOTE_REFUSED (I requires_local): a local-runtime-only task cannot be auto-promoted; it needs an attended local session and a human promote'
      using errcode = '22023';
  end if;

  -- ---- Daily cap (condition H). Counted from that UTC day's
  -- AGENT STATUS payload.action=auto-promoted events, NOT a mutable counter.
  select count(*) into v_today_count
  from public.agent_task_events
  where event_type = 'AGENT STATUS'
    and payload->>'action' = 'auto-promoted'
    and (created_at at time zone 'UTC')::date = (now() at time zone 'UTC')::date;
  if v_today_count >= v_daily_cap then
    raise exception 'AUTO_PROMOTE_REFUSED (H cap): daily cap % reached for this UTC day (% already auto-promoted)', v_daily_cap, v_today_count
      using errcode = '22023';
  end if;

  -- ---- All conditions pass. Emit UNASSIGNED: status Agent Todo, agent_code
  -- NULL, preferred_agent NULL -> enters the shared claim pool. Deliberately
  -- does NOT touch attempt_count, claim_token, claimed_by, claim_expires_at,
  -- completed_at, or explicit_approval — a Standing draft already has null claim
  -- state, and auto-promote must not disturb it.
  update public.agent_tasks
  set
    status = 'Agent Todo',
    agent_code = null,
    preferred_agent = null
  where id = p_task_id
  returning * into v_task;

  -- ---- One audit event, authored as triage-auto, NEVER triage (the readiness-
  -- watch DIRTY predicate). This makes the promotion legible and machine-
  -- attributable without dirtying the watch day.
  insert into public.agent_task_events (task_id, event_type, agent_code, payload)
  values (
    p_task_id,
    'AGENT STATUS',
    'triage-auto',
    jsonb_build_object(
      'status', 'Agent Todo',
      'from_status', 'Standing',
      'action', 'auto-promoted',
      'allowlist_category', p_allowlist_category,
      'rationale', v_rationale,
      'caller', 'triage'
    )
  );

  return v_task;
end;
$$;

-- SECURITY DEFINER: revoke from web-exposed roles, grant only service_role
-- (the Edge Function runs as service_role).
revoke execute on function public.auto_promote_agent_task_intake(uuid, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.auto_promote_agent_task_intake(uuid, text, integer, text)
  to service_role;

notify pgrst, 'reload schema';
