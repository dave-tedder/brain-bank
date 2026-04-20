-- 0010_match_thoughts_rpc.sql
-- Semantic search RPC: cosine distance against the HNSW index on
-- thoughts.embedding, with optional jsonb containment filter on metadata.
-- Called by the /search REST endpoint, search_thoughts MCP tool, and the
-- digest context build. Returns similarity (1 - cosine_distance) so callers
-- can threshold on "how close."

CREATE OR REPLACE FUNCTION public.match_thoughts(
  query_embedding extensions.vector,
  match_threshold double precision DEFAULT 0.7,
  match_count integer DEFAULT 10,
  filter jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  similarity double precision,
  created_at timestamptz
)
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id,
    t.content,
    t.metadata,
    1 - (t.embedding <=> query_embedding) AS similarity,
    t.created_at
  FROM public.thoughts t
  WHERE 1 - (t.embedding <=> query_embedding) > match_threshold
    AND (filter = '{}'::jsonb OR t.metadata @> filter)
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
