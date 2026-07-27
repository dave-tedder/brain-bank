-- Security advisor cleanup: clears Supabase database-linter findings for
-- tables, views, and SECURITY DEFINER functions introduced in earlier
-- migrations without RLS, security_invoker, or revoked anon/authenticated
-- EXECUTE. The checklist applied here, and worth repeating in every new
-- migration: enable RLS on each new table (service-role policies only),
-- set security_invoker on views, pin search_path on SECURITY DEFINER
-- functions, and revoke EXECUTE from public/anon/authenticated on any
-- function those roles should not call.
--
-- All consumers in brain-bank use service_role (Edge Functions) or postgres
-- (pg_cron). Anon and authenticated roles are not expected callers for any
-- of these objects.

-- 1. compile_pages_runs (from 20260510_compile_pages_runs.sql) — enable RLS,
-- add service_role policy
ALTER TABLE public.compile_pages_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on compile_pages_runs"
  ON public.compile_pages_runs
  FOR ALL
  USING (auth.role() = 'service_role'::text);

-- 2. digests (0009), mcp_tool_invocations (0016) — add explicit
-- service_role policy. RLS was already enabled but no policies existed;
-- this matches the pattern used on every other table in this schema.
CREATE POLICY "Service role full access on digests"
  ON public.digests
  FOR ALL
  USING (auth.role() = 'service_role'::text);

CREATE POLICY "Service role full access on mcp_tool_invocations"
  ON public.mcp_tool_invocations
  FOR ALL
  USING (auth.role() = 'service_role'::text);

-- 3. wiki views (from 20260510_wiki_soak_views.sql) — switch to
-- security_invoker so they honor the caller's RLS context instead of
-- bypassing it through definer-style execution.
ALTER VIEW public.wiki_soak_status SET (security_invoker = true);
ALTER VIEW public.wiki_framing_signal SET (security_invoker = true);

-- 4. SECURITY DEFINER functions — revoke EXECUTE from anon, authenticated,
-- public. postgres and service_role retain EXECUTE, so pg_cron (runs as
-- postgres) and Edge Functions (run as service_role) are unaffected.
-- call_edge_function is the vault-aware cron wrapper that reads
-- vault.decrypted_secrets.mcp_access_key; sample_candidate_pairs and
-- thought_edges_upsert are auto-resolve helpers called by classify-edges.
-- None should be reachable from PostgREST.
REVOKE EXECUTE ON FUNCTION public.call_edge_function(text, text, text)
  FROM anon, authenticated, public;

REVOKE EXECUTE ON FUNCTION public.sample_candidate_pairs(integer, integer, integer)
  FROM anon, authenticated, public;

REVOKE EXECUTE ON FUNCTION public.thought_edges_upsert(
  uuid, uuid, text, numeric, integer, text, timestamptz, timestamptz, jsonb
) FROM anon, authenticated, public;

-- 5. thought_edges_set_updated_at — pin search_path
ALTER FUNCTION public.thought_edges_set_updated_at()
  SET search_path = pg_catalog, public;
