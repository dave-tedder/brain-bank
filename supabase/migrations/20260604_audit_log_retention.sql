-- Phase 15.5 F1: audit-log retention sweep.
-- Caps the three unbounded operational audit logs at a 90-day rolling window
-- through a weekly pg_cron job. Durable user and business records are not
-- included in this maintenance policy.

-- Internal maintenance function with per-table delete counts for observability.
create or replace function public.purge_old_audit_logs(retention_days int default 90)
returns table(table_name text, deleted_count bigint)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  cutoff timestamptz := now() - make_interval(days => retention_days);
  n bigint;
begin
  -- openrouter_calls is introduced by a later optional telemetry batch. Keep
  -- this migration replayable before or after that table is installed.
  if to_regclass('public.openrouter_calls') is not null then
    execute 'delete from public.openrouter_calls where created_at < $1' using cutoff;
    get diagnostics n = row_count;
    table_name := 'openrouter_calls'; deleted_count := n; return next;
  end if;

  delete from public.mcp_tool_invocations where created_at < cutoff;
  get diagnostics n = row_count;
  table_name := 'mcp_tool_invocations'; deleted_count := n; return next;

  delete from public.compile_pages_runs where created_at < cutoff;
  get diagnostics n = row_count;
  table_name := 'compile_pages_runs'; deleted_count := n; return next;
end;
$$;

-- This function is for trusted maintenance contexts, never the Data API.
revoke all on function public.purge_old_audit_logs(int) from public;
revoke all on function public.purge_old_audit_logs(int) from anon;
revoke all on function public.purge_old_audit_logs(int) from authenticated;

-- Sundays at 08:00 UTC, outside the default compile and digest schedule.
select cron.schedule(
  'purge-audit-logs-weekly',
  '0 8 * * 0',
  $cron$select public.purge_old_audit_logs()$cron$
);
