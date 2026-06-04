-- Phase 15.3 — Projects model rebuild (audit Decision B).
-- A project is a curated `projects` row, never an auto-promoted topic.
-- Fixes audit findings D1, D5, D6, D7, D10.
--
-- Applied live via the Supabase MCP; this file is the record per the
-- migrations convention.

-- D2 support: columns the projects-sync script needs.
alter table public.projects add column if not exists notion_page_id text;
alter table public.projects add column if not exists last_synced_at timestamptz;

-- D10: GIN index for the dashboard's metadata->topics containment queries.
create index if not exists thoughts_metadata_gin
  on public.thoughts using gin (metadata jsonb_path_ops);

-- D1 + D5 + D6 + D7: projects_rollup, project-driven.
-- security_invoker is re-declared inline so CREATE OR REPLACE cannot regress
-- the 20260519 hardening (security_definer_view ERROR lint).
create or replace view public.projects_rollup
with (security_invoker = true) as
with thought_facts as (
  select
    nullif(trim(both '-' from
      regexp_replace(lower(trim(topic.value)), '[^a-z0-9]+', '-', 'g')), '') as slug,
    t.id as thought_id,
    t.created_at,
    t.content,
    t.metadata->>'source' as source
  from public.thoughts t
  cross join lateral
    jsonb_array_elements_text(coalesce(t.metadata->'topics', '[]'::jsonb))
      as topic(value)
),
agg as (
  select
    slug,
    count(*) as captures,
    max(created_at) as last_activity_at,
    count(*) filter (where created_at > now() - interval '7 days') as captures_7d,
    array_agg(distinct source) filter (where source is not null) as sources
  from thought_facts
  where slug is not null
  group by slug
),
next_steps as (
  select distinct on (tf.slug)
    tf.slug,
    ai.description as next_step,
    ai.created_at as ns_created_at
  from thought_facts tf
  join public.action_items ai on ai.source_thought_id = tf.thought_id
  where ai.status = 'open' and tf.slug is not null
  order by tf.slug, ai.created_at desc
),
blockers as (
  select distinct on (tf_outer.slug)
    tf_outer.slug,
    regexp_replace(tf_outer.content, '^BLOCKER:\s*', '') as blocker_text,
    tf_outer.created_at as blocked_at
  from thought_facts tf_outer
  where tf_outer.content ~* '^BLOCKER:'
    and tf_outer.slug is not null
    and not exists (
      select 1 from thought_facts tf2
      where tf2.slug = tf_outer.slug
        and tf2.created_at > tf_outer.created_at
        and tf2.content ~* '^BLOCKER RESOLVED:'
    )
  order by tf_outer.slug, tf_outer.created_at desc
),
classified as (
  select
    p.slug,
    coalesce(p.display_name, p.slug) as display_name,
    coalesce(p.type, 'uncategorized') as type,
    coalesce(p.status, 'active') as status_explicit,
    p.pinned,
    p.roi_band,
    p.working_dirs,
    p.created_at as project_created_at,
    p.manual_next_step,
    a.slug as agg_slug,
    a.captures,
    a.captures_7d,
    a.last_activity_at,
    a.sources,
    ns.next_step,
    ns.ns_created_at,
    b.slug as blocker_slug,
    b.blocker_text,
    b.blocked_at,
    case
      when b.slug is not null then 'BLOCKER'
      when ns.ns_created_at < now() - interval '3 days'
        and coalesce(a.captures_7d, 0) = 0 then 'STALE'
      when a.slug is not null and a.captures_7d = 0
        and a.last_activity_at < now() - interval '7 days'
        and a.last_activity_at >= now() - interval '30 days' then 'STALE'
      when a.slug is null
        or a.last_activity_at < now() - interval '30 days' then 'DORMANT'
      else 'ACTIVE'
    end as status_derived
  from public.projects p
  left join agg a on a.slug = p.slug
  left join next_steps ns on ns.slug = p.slug
  left join blockers b on b.slug = p.slug
)
-- Column order matches the prior projects_rollup definition (15 columns) so
-- CREATE OR REPLACE VIEW succeeds; the new `status` column is appended last
-- (CREATE OR REPLACE can add trailing columns but cannot reorder existing ones).
select
  slug,
  display_name,
  type,
  status_derived,
  status_explicit,
  coalesce(last_activity_at, project_created_at) as last_activity_at,
  coalesce(captures, 0) as captures,
  coalesce(captures_7d, 0) as captures_7d,
  coalesce(manual_next_step, next_step) as next_step,
  blocker_text,
  blocked_at,
  pinned,
  roi_band,
  working_dirs,
  sources,
  case
    when status_explicit in ('done','archive','paused') then upper(status_explicit)
    else status_derived
  end as status
from classified;
