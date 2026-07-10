-- OE-11 Phase 2: "Needs Operator" board status + operator-action routing.
-- Additive. A task whose closeout carries a concrete operator step lands in
-- Needs Operator (a persistent personal-action desk) instead of Agent Done, and
-- only the operator's complete_operator_action closes it.

-- 1. Status domain: insert 'Needs Operator' between review and done.
alter table public.agent_tasks
  drop constraint agent_tasks_status_check;
alter table public.agent_tasks
  add constraint agent_tasks_status_check
  check (status in (
    'Standing','Agent Todo','Agent Working','Agent Needs Input',
    'Agent Review','Needs Operator','Agent Done'
  ));

-- 2. Operator-step columns (set when a task routes to Needs Operator; RETAINED
-- after close as the audit trail — complete_operator_action does not clear them).
alter table public.agent_tasks
  add column if not exists operator_action text,
  add column if not exists operator_target text;

-- 3. Event vocabulary: routing-in and operator-close receipts.
alter table public.agent_task_events
  drop constraint agent_task_events_event_type_check;
alter table public.agent_task_events
  add constraint agent_task_events_event_type_check
  check (event_type in (
    'AGENT CLAIMED','AGENT DONE','AGENT BLOCKED','AGENT UNBLOCKED',
    'AGENT HUMAN HOLD','AGENT HUMAN ANSWERED','AGENT RESUMED','AGENT FAILED',
    'AGENT APPLIED','AGENT NEEDS OPERATOR','OPERATOR DONE',
    'AGENT SKILL SUBSCRIBED','AGENT SKILL INSTALLED','AGENT SKILL UPDATED',
    'AGENT SKILL DECLINED','AGENT FOLLOW-UP','AGENT STATUS'
  ));

-- 4. Index the desk so the briefing/dashboard read it cheaply.
create index if not exists agent_tasks_needs_operator_idx
  on public.agent_tasks (status, updated_at desc)
  where status = 'Needs Operator';

notify pgrst, 'reload schema';
