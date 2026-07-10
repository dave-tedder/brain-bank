-- Keep public.agent_scorecard private to service_role callers.
--
-- The attribution migration revoked SELECT from anon/authenticated, which is the
-- load-bearing access guard. This follow-up also removes the harmless but noisy
-- default view privileges Supabase/Postgres exposed for those roles.

revoke all privileges on public.agent_scorecard from public;
revoke all privileges on public.agent_scorecard from anon, authenticated, service_role;

grant select on public.agent_scorecard to service_role;
