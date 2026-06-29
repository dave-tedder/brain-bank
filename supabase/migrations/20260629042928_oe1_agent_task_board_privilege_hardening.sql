-- OE-1 follow-up: narrow generated/default table grants for the manual board.
-- The manual dashboard needs read/create/update. Deletes and truncates are out
-- of scope for OE-1 and should not be exposed through the service-role client.

revoke all on public.agent_task_ledger from service_role;
revoke all on public.agent_tasks from service_role;
revoke all on public.agent_task_events from service_role;

grant select, insert, update on public.agent_task_ledger to service_role;
grant select, insert, update on public.agent_tasks to service_role;
grant select, insert, update on public.agent_task_events to service_role;

notify pgrst, 'reload schema';
