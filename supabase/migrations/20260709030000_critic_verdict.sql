-- OE-11 Phase 4: advisory critic verdict storage + cross-runtime critic codes.
-- Columns (not events) are the render source: cheap for dashboard/briefing and
-- for the later gating threshold. An AGENT CRITIC event is also written for the
-- audit trail. Advisory only in v1; the verdict never moves task status.
-- The timestamped prefix keeps replay order after the Phase 2 Needs Operator
-- migrations: this recreate of the event-type CHECK includes their values,
-- and nothing sorted later recreates the CHECK without AGENT CRITIC.

alter table public.agent_tasks
  add column if not exists critic_verdict text
    constraint agent_tasks_critic_verdict_check
    check (critic_verdict is null or critic_verdict in ('clean','flagged')),
  add column if not exists critic_flags jsonb not null default '[]'::jsonb,
  add column if not exists critic_reviewed_by text,
  add column if not exists critic_reviewed_at timestamptz;

alter table public.agent_task_events
  drop constraint agent_task_events_event_type_check;
alter table public.agent_task_events
  add constraint agent_task_events_event_type_check
  check (event_type in (
    'AGENT CLAIMED','AGENT DONE','AGENT BLOCKED','AGENT UNBLOCKED',
    'AGENT HUMAN HOLD','AGENT HUMAN ANSWERED','AGENT RESUMED','AGENT FAILED',
    'AGENT APPLIED','AGENT NEEDS OPERATOR','OPERATOR DONE','AGENT CRITIC',
    'AGENT SKILL SUBSCRIBED','AGENT SKILL INSTALLED','AGENT SKILL UPDATED',
    'AGENT SKILL DECLINED','AGENT FOLLOW-UP','AGENT STATUS'
  ));

-- Critic independence relies on exact runtime equality. Normalize the public
-- starter rows before adding critic rows so "Claude Code" and "claude" cannot
-- accidentally pass as different runtimes.
update public.agent_task_ledger
set runtime = case
  when agent_code in ('local-claude-code', 'claude-code', 'claude-critic')
    then 'claude'
  when agent_code in ('local-codex', 'codex', 'codex-critic')
    then 'codex'
  when lower(runtime) like '%claude%' then 'claude'
  when lower(runtime) like '%codex%' then 'codex'
  else runtime
end;

alter table public.agent_task_ledger
  alter column runtime set not null;

alter table public.agent_task_ledger
  drop constraint if exists agent_task_ledger_runtime_check;

alter table public.agent_task_ledger
  add constraint agent_task_ledger_runtime_check
  check (runtime in ('claude', 'codex'));

insert into public.agent_task_ledger (agent_code, operator, runtime, automation, automation_state, notes)
values
  ('codex-critic', 'Local Operator', 'codex', 'manual', 'manual-required', 'OE-11 Phase 4 critic lane: Codex reviews Claude-executed Agent Review and Needs Operator tasks.'),
  ('claude-critic', 'Local Operator', 'claude', 'manual', 'manual-required', 'OE-11 Phase 4 critic lane: Claude reviews Codex-executed Agent Review and Needs Operator tasks.')
on conflict (agent_code) do nothing;

notify pgrst, 'reload schema';
