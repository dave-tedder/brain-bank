-- Canonical project-page thought resolution.
--
-- Project captures may use display names, hyphenated slugs, or underscore
-- tags. Normalize all forms to the compiled page's canonical project slug so
-- compile-pages and get_compiled_page read the same thought set as the
-- projects rollup.

create or replace function public.get_project_page_thoughts(
  p_slug text,
  p_since timestamptz default 'epoch'::timestamptz,
  p_limit integer default 50,
  p_ascending boolean default false
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with params as (
    select nullif(
      trim(both '-' from regexp_replace(
        lower(trim(regexp_replace(coalesce(p_slug, ''), '^project/', ''))),
        '[^a-z0-9]+', '-', 'g'
      )),
      ''
    ) as canonical_slug
  )
  select t.id, t.content, t.metadata, t.created_at
  from public.thoughts t
  cross join params p
  where p.canonical_slug is not null
    and t.created_at > coalesce(p_since, 'epoch'::timestamptz)
    and (
      nullif(
        trim(both '-' from regexp_replace(
          lower(trim(coalesce(t.metadata->>'project', ''))),
          '[^a-z0-9]+', '-', 'g'
        )),
        ''
      ) = p.canonical_slug
      or exists (
        select 1
        from jsonb_array_elements_text(
          case
            when jsonb_typeof(t.metadata->'topics') = 'array'
              then t.metadata->'topics'
            else '[]'::jsonb
          end
        ) topic(value)
        where nullif(
          trim(both '-' from regexp_replace(
            lower(trim(topic.value)),
            '[^a-z0-9]+', '-', 'g'
          )),
          ''
        ) = p.canonical_slug
      )
    )
  order by
    case when p_ascending then t.created_at end asc,
    case when not p_ascending then t.created_at end desc
  limit greatest(1, least(coalesce(p_limit, 50), 1000));
$$;

revoke execute on function public.get_project_page_thoughts(text, timestamptz, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.get_project_page_thoughts(text, timestamptz, integer, boolean)
  to service_role;
