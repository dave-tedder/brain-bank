-- 20260713_resolve_project_slug_revoke_anon.sql
-- Revoke anon EXECUTE on resolve_project_slug.
--
-- 20260519_resolve_project_slug.sql granted anon EXECUTE as a deliberate
-- capture-hook convenience, and 20260519_projects_security_hardening.sql
-- already revoked authenticated. Upstream later reversed the anon grant
-- entirely (key-exposure cleanup): the RPC is only ever called with the
-- service-role key, so there is no reason to leave it callable through
-- PostgREST by unauthenticated clients. Exploitability is low (it returns
-- only a project slug string), but the grant serves no caller.

revoke execute on function public.resolve_project_slug(text)
  from public, anon, authenticated;
