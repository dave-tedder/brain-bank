-- Near-duplicate capture guard.
-- Reworded re-captures of the same fact (session closeouts captured twice,
-- task-packet echoes) slip past the SHA-256 content_hash dedup because the
-- bytes differ. This RPC lets the capture paths ask, post-embedding and
-- pre-insert: "is there a very-similar thought from the same source in the
-- last hour?" Callers exempt mechanical captures (daily sync/receipt
-- templates), which legitimately score high similarity across runs.

create or replace function public.find_recent_near_duplicate(
  query_embedding vector(1536),
  source_filter text,
  sim_threshold double precision default 0.95,
  window_minutes integer default 60
)
returns table(id uuid, similarity double precision)
language sql
stable
-- extensions must be on the path: pgvector's <=> operator lives there
set search_path = pg_catalog, public, extensions
as $$
  select t.id, 1 - (t.embedding <=> query_embedding) as similarity
  from thoughts t
  where t.created_at > now() - make_interval(mins => window_minutes)
    and t.metadata->>'source' = source_filter
    and t.embedding is not null
    and 1 - (t.embedding <=> query_embedding) > sim_threshold
  order by t.embedding <=> query_embedding
  limit 1;
$$;

-- Service-role / pg_cron only; not a web-exposed surface.
revoke execute on function public.find_recent_near_duplicate(vector, text, double precision, integer)
  from anon, authenticated, public;
