-- Widen the Open Engine ledger CHECK constraints so a new executor runtime and
-- reserved (registered-but-not-yet-live) lanes are admissible.
--
-- runtime: the two-value CHECK ('claude','codex') is widened to admit a third
-- runtime. 'antigravity' is shown as the concrete example; substitute or add
-- your own runtime string here when you wire up a new executor. The critic SQL
-- guard compares an executor's runtime to a critic lane's target runtime and
-- simply never matches a runtime that has no critic lane yet, so widening the
-- CHECK is safe on its own.
--
-- automation_state: 'reserved' is added so a lane can be registered as planned
-- but not yet running; the operations sentinel treats automation_state =
-- 'reserved' as an expected gap, never a stale-lane miss.
--
-- (This is the schema-widening half of the scheduling-identities change; the
-- operator-specific ledger identity seed rows are intentionally omitted — seed
-- your own ledger identities with write_agent_ledger / a local insert.)

alter table public.agent_task_ledger
  drop constraint if exists agent_task_ledger_runtime_check;
alter table public.agent_task_ledger
  add constraint agent_task_ledger_runtime_check
  check (runtime in ('claude', 'codex', 'antigravity'));

alter table public.agent_task_ledger
  drop constraint if exists agent_task_ledger_automation_state_check;
alter table public.agent_task_ledger
  add constraint agent_task_ledger_automation_state_check
  check (automation_state in ('installed', 'manual-required', 'blocked', 'paused', 'reserved'));
