-- Scope auto-resolve candidates in SQL before LIMIT so older matching items
-- remain reachable without loading the full open-action queue into a function.

create or replace function public.find_candidate_action_items(
  p_project text,
  p_topics text[],
  p_people text[],
  p_exclude_source_ids uuid[],
  p_max_items int default 500
) returns table (
  id uuid,
  description text,
  source_thought_id uuid,
  src_project text,
  src_topics text[],
  src_people text[]
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select
    ai.id,
    ai.description,
    ai.source_thought_id,
    t.metadata->>'project' as src_project,
    coalesce(array(select jsonb_array_elements_text(t.metadata->'topics')), '{}'::text[]) as src_topics,
    coalesce(array(select jsonb_array_elements_text(t.metadata->'people')), '{}'::text[]) as src_people
  from public.action_items ai
  join public.thoughts t on t.id = ai.source_thought_id
  where ai.status = 'open'
    and ai.source_thought_id is not null
    and not (
      ai.source_thought_id = any(coalesce(p_exclude_source_ids, '{}'::uuid[]))
    )
    and (
      (p_project is not null and t.metadata->>'project' = p_project)
      or (cardinality(p_topics) > 0 and t.metadata->'topics' ?| p_topics)
      or (cardinality(p_people) > 0 and t.metadata->'people' ?| p_people)
    )
  order by ai.created_at desc
  limit p_max_items;
$$;

revoke all on function public.find_candidate_action_items(
  text, text[], text[], uuid[], int
) from public, anon, authenticated;
grant execute on function public.find_candidate_action_items(
  text, text[], text[], uuid[], int
) to service_role;
