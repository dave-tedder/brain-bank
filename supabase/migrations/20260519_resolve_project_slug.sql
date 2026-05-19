-- Phase 14 Projects Dashboard, Phase 1 Task 2.
-- resolve_project_slug(cwd): maps a working directory to a project slug.
--
-- The projects table is RLS service-role-only, so the capture hooks (bash
-- scripts) cannot query working_dirs directly. This SECURITY DEFINER
-- function exposes ONLY the slug-resolution lookup — not the table — and is
-- granted to anon so the hook can call it via the PostgREST RPC endpoint
-- with the public anon key. No service_role key ever lands on disk.

create or replace function public.resolve_project_slug(p_cwd text)
returns text
language sql
security definer
set search_path = public
as $$
  select slug
  from public.projects
  where p_cwd = any(working_dirs)
  order by slug
  limit 1;
$$;

-- Lock down the default PUBLIC execute grant, then re-grant only to anon.
revoke all on function public.resolve_project_slug(text) from public;
grant execute on function public.resolve_project_slug(text) to anon;
