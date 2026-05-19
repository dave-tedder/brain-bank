-- Phase 14 Projects Dashboard — security hardening for the Task 1 + Task 2
-- schema objects, closing the advisor lints that raw-SQL migrations do not
-- get for free (only the dashboard Table Editor auto-applies them).

-- projects table — rls_enabled_no_policy (INFO).
-- Add the explicit service_role policy every other table in this schema
-- carries. service_role bypasses RLS regardless; the policy documents intent
-- and silences the lint.
create policy "Service role full access on projects"
  on public.projects for all
  using (auth.role() = 'service_role'::text);

-- projects_rollup view — security_definer_view (ERROR).
-- Postgres views default to definer-style execution, running with the view
-- owner's privileges and bypassing RLS on the underlying tables. security_invoker
-- makes the view honor the caller's RLS context. The dashboard reads it with
-- the service_role key (bypasses RLS either way); this just removes the
-- footgun where an anon-role query could read underlying rows it should not.
alter view public.projects_rollup set (security_invoker = true);

-- resolve_project_slug — pin a hardened search_path and drop the unused
-- authenticated grant. anon EXECUTE is INTENTIONAL and stays: the capture
-- hooks call this via the PostgREST RPC endpoint with the public anon key
-- (see 20260519_resolve_project_slug.sql). The function returns only a
-- project slug for an exact cwd match — it cannot enumerate the table — so
-- the remaining anon SECURITY DEFINER advisor WARN is an accepted exception.
alter function public.resolve_project_slug(text) set search_path = pg_catalog, public;
revoke execute on function public.resolve_project_slug(text) from authenticated;
