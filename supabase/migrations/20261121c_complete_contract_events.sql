-- Loop-closing Task 5.4 follow-up (the operator's PR 32 decision 7): a durable count of
-- complete-time refusals and warnings.
--
-- complete_agent_task and request_agent_review check the receipt contract before
-- they write (PR 32). Each refusal and each warning prints one
-- "[complete-contract] ..." line to the open-brain-mcp function log, and function
-- logs expire, so the plan's weekly measure for Task 5.4 could not be read after
-- the log window closed. This table holds one row per such line, written
-- best-effort by the Edge Function next to the log line. It is append-only and
-- small (a handful of rows a week).
--
-- Columns:
--   tool          complete_agent_task or request_agent_review.
--   task_id       the card the call named. No foreign key, on purpose: the row
--                 counts an event that happened, and must survive the card being
--                 deleted; a key would also put an agent_tasks row lock on every
--                 insert, next to the status move.
--   agent_code    the caller (already checked to own the claim before the contract
--                 runs).
--   outcome       refused or warned.
--   reason        refused: the refusal reasons joined with ',' exactly as the log
--                 line prints them; warned: the warning code. Reason-code shape
--                 only (capital letters, digits, '_', ','), so no receipt text and
--                 no free text can be stored here.
--   project_slug  the task's project_slug, trimmed, or null when blank.
--                 agent_code and project_slug carry no length cap: the upstream
--                 columns (agent_task_ledger.agent_code, projects.slug) have
--                 none, and a cap here would drop the event for a value they
--                 accept. Only the empty string is refused.
--   occurred_at   when the log line was emitted, set by the Edge Function at
--                 the emission site. The insert itself runs later (under
--                 EdgeRuntime.waitUntil), so created_at, the insert's now(),
--                 can fall after the card's AGENT DONE repair or in the next
--                 UTC week; the weekly queries use occurred_at.
--
-- Access: RLS on. anon and authenticated have no privilege at all (Supabase's
-- default privileges would otherwise grant them everything, so they are revoked
-- here). service_role has INSERT and SELECT only: no UPDATE, no DELETE, no
-- TRUNCATE, so the Edge Function can add rows and the operator can read them.
--
-- Rollback: drop table public.complete_contract_events;
-- (the Edge Function's write is best-effort: with the table gone it logs one
-- "[complete-contract] event write failed" line per event and answers unchanged).

create table public.complete_contract_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  tool text not null
    constraint complete_contract_events_tool_check
    check (tool in ('complete_agent_task', 'request_agent_review')),
  task_id uuid null,
  agent_code text null
    constraint complete_contract_events_agent_code_nonempty
    check (agent_code is null or agent_code <> ''),
  outcome text not null
    constraint complete_contract_events_outcome_check
    check (outcome in ('refused', 'warned')),
  reason text not null
    constraint complete_contract_events_reason_shape
    check (reason ~ '^[A-Z][A-Z0-9_]{0,63}(,[A-Z][A-Z0-9_]{0,63}){0,31}$'),
  project_slug text null
    constraint complete_contract_events_project_slug_nonempty
    check (project_slug is null or project_slug <> ''),
  occurred_at timestamptz not null
);

create index complete_contract_events_occurred_at_idx
  on public.complete_contract_events (occurred_at);

comment on table public.complete_contract_events is
  'Loop-closing Task 5.4 measure: one row per [complete-contract] log line (a complete-time refusal or warning from complete_agent_task / request_agent_review). Append-only, reason codes only, never receipt text. Weekly query: scripts/loop-closing/complete-contract-metrics.sql.';

alter table public.complete_contract_events enable row level security;

revoke all on table public.complete_contract_events from public, anon, authenticated, service_role;
grant select, insert on table public.complete_contract_events to service_role;

create policy "Service role reads complete_contract_events"
  on public.complete_contract_events for select to service_role using (true);
create policy "Service role adds complete_contract_events"
  on public.complete_contract_events for insert to service_role with check (true);

notify pgrst, 'reload config';
