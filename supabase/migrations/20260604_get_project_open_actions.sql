-- Phase 15.3 cosmetic polish (D9): bound the detail-page open-actions fetch.
-- Replaces the dashboard's unbounded two-query pattern (all thought IDs for a
-- slug, then a large IN(...) against action_items) with one server-side join.
-- Slug normalization is identical to projects_rollup.thought_facts so it
-- matches the same messy historical tags. SECURITY INVOKER: an anon RPC call
-- runs as anon, RLS (service-role-only) returns nothing; execute is revoked
-- from anon anyway. The dashboard's service_role client retains execute.
--
-- Applied live via the Supabase MCP; this file is the record per the
-- migrations convention.
create or replace function public.get_project_open_actions(p_slug text, p_limit int default 8)
returns table (id uuid, description text, created_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  with tf as (
    select distinct t.id as thought_id
    from public.thoughts t
    cross join lateral
      jsonb_array_elements_text(coalesce(t.metadata->'topics', '[]'::jsonb)) as topic(value)
    where nullif(trim(both '-' from
      regexp_replace(lower(trim(topic.value)), '[^a-z0-9]+', '-', 'g')), '') = p_slug
  )
  select ai.id, ai.description, ai.created_at
  from public.action_items ai
  join tf on tf.thought_id = ai.source_thought_id
  where ai.status = 'open'
  order by ai.created_at desc
  limit p_limit;
$$;

revoke execute on function public.get_project_open_actions(text, int) from public, anon, authenticated;
grant execute on function public.get_project_open_actions(text, int) to service_role;
