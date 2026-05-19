-- Phase 14: Projects Dashboard — projects table + projects_rollup view.
-- Surfaces every Open Brain topic with >=3 captures as a filterable project,
-- plus any explicitly-pinned/annotated project regardless of capture count.

-- ---------------------------------------------------------------------------
-- Table: projects
-- Holds operator metadata for topics Dave wants to pin, override, or annotate.
-- Topics auto-surface in the rollup without a row here; this table is the
-- optional explicit layer. slug joins to a thoughts.metadata->'topics' element.
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
  slug text primary key,
  display_name text,
  type text default 'uncategorized'
    check (type in ('llm-build','client','ops','content','idea','uncategorized')),
  status text default 'active'
    check (status in ('active','paused','done','archive')),
  pinned boolean default false,
  vision_md text,
  roi_band text check (roi_band in ('high','medium','low')),
  manual_next_step text,
  working_dirs text[] default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists projects_type_idx
  on public.projects(type) where status != 'archive';
create index if not exists projects_working_dirs_gin
  on public.projects using gin(working_dirs);

alter table public.projects enable row level security;
-- No policy = service-role-only access, matches the existing Open Brain
-- table pattern (mcp_tool_invocations, compile_pages_runs, openrouter_calls).

-- ---------------------------------------------------------------------------
-- View: projects_rollup
-- Aggregates thoughts by topic, classifies status, exposes the per-project
-- fields the dashboard needs.
--
-- Schema reality (differs from the original plan doc, which assumed columns
-- that do not exist):
--   * thoughts has no topics/source/action_items columns — topics and source
--     live in the metadata jsonb (metadata->'topics' array, metadata->>'source').
--   * action_items is its own table (source_thought_id, description, status
--     'open'|'resolved', created_at), not a jsonb array on thoughts.
-- The next_steps CTE joins the action_items table; topics/source read jsonb.
-- ---------------------------------------------------------------------------
create or replace view public.projects_rollup as
with thought_facts as (
  select
    topic.slug,
    t.id as thought_id,
    t.created_at,
    t.content,
    t.metadata->>'source' as source
  from public.thoughts t
  cross join lateral
    jsonb_array_elements_text(coalesce(t.metadata->'topics', '[]'::jsonb))
      as topic(slug)
),
agg as (
  select
    slug,
    count(*) as captures,
    max(created_at) as last_activity_at,
    count(*) filter (where created_at > now() - interval '7 days') as captures_7d,
    array_agg(distinct source) filter (where source is not null) as sources
  from thought_facts
  group by slug
),
next_steps as (
  select distinct on (tf.slug)
    tf.slug,
    ai.description as next_step,
    ai.created_at as ns_created_at
  from thought_facts tf
  join public.action_items ai on ai.source_thought_id = tf.thought_id
  where ai.status = 'open'
  order by tf.slug, ai.created_at desc
),
blockers as (
  select distinct on (tf_outer.slug)
    tf_outer.slug,
    regexp_replace(tf_outer.content, '^BLOCKER:\s*', '') as blocker_text,
    tf_outer.created_at as blocked_at
  from thought_facts tf_outer
  where tf_outer.content ~* '^BLOCKER:'
    and not exists (
      select 1 from thought_facts tf2
      where tf2.slug = tf_outer.slug
        and tf2.created_at > tf_outer.created_at
        and tf2.content ~* '^(BLOCKER RESOLVED|DONE):'
    )
  order by tf_outer.slug, tf_outer.created_at desc
)
select
  a.slug,
  coalesce(p.display_name, a.slug) as display_name,
  coalesce(p.type, 'uncategorized') as type,
  case
    when b.slug is not null then 'BLOCKER'
    when ns.ns_created_at < now() - interval '3 days' and a.captures_7d = 0
      then 'STALE'
    when a.last_activity_at < now() - interval '30 days' and ns.next_step is null
      then 'DORMANT'
    else 'ACTIVE'
  end as status_derived,
  coalesce(p.status, 'active') as status_explicit,
  a.last_activity_at,
  a.captures,
  a.captures_7d,
  coalesce(p.manual_next_step, ns.next_step) as next_step,
  b.blocker_text,
  b.blocked_at,
  p.pinned,
  p.roi_band,
  p.working_dirs,
  a.sources
from agg a
left join public.projects p on p.slug = a.slug
left join next_steps ns on ns.slug = a.slug
left join blockers b on b.slug = a.slug
where p.slug is not null or a.captures >= 3;
