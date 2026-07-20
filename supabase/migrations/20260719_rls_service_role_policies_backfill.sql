-- Security advisor cleanup: clears 3 rls_enabled_no_policy INFO lints.
--
-- agent_run_log, oe_watch_rulings, and openrouter_calls shipped with RLS
-- enabled but no policy. All consumers are service_role (Edge Functions) or
-- postgres (pg_cron), which bypass RLS regardless — the explicit policy
-- matches every other table in this schema and silences the lint.

CREATE POLICY "Service role full access on agent_run_log"
  ON public.agent_run_log
  FOR ALL
  USING (auth.role() = 'service_role'::text);

CREATE POLICY "Service role full access on oe_watch_rulings"
  ON public.oe_watch_rulings
  FOR ALL
  USING (auth.role() = 'service_role'::text);

CREATE POLICY "Service role full access on openrouter_calls"
  ON public.openrouter_calls
  FOR ALL
  USING (auth.role() = 'service_role'::text);
