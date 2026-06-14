-- supabase/migrations/0015_sample_candidate_pairs_exclude_classified.sql
--
-- Phase 13 carry-over: advance candidate sampling across repeated
-- classify-edges runs by excluding every pair that already has any
-- thought_edges row, including related_to rows.

CREATE OR REPLACE FUNCTION public.sample_candidate_pairs(
  p_min_overlap INT,
  p_since_days INT,
  p_limit INT
)
RETURNS TABLE (a_id UUID, b_id UUID, overlap INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_since TIMESTAMPTZ;
BEGIN
  v_since := CASE WHEN p_since_days IS NULL
                  THEN '1970-01-01T00:00:00Z'::timestamptz
                  ELSE now() - (p_since_days::text || ' days')::interval
             END;

  RETURN QUERY
    WITH topic_pairs AS (
      SELECT a.id AS a_id, b.id AS b_id, count(*)::int AS shared_topic_count
      FROM thoughts a
      JOIN thoughts b ON a.id < b.id
      JOIN LATERAL jsonb_array_elements_text(coalesce(a.metadata->'topics', '[]'::jsonb)) ta(t) ON TRUE
      JOIN LATERAL jsonb_array_elements_text(coalesce(b.metadata->'topics', '[]'::jsonb)) tb(t) ON ta.t = tb.t
      WHERE (a.created_at >= v_since OR b.created_at >= v_since)
      GROUP BY a.id, b.id
    ),
    project_pairs AS (
      SELECT a.id AS a_id, b.id AS b_id
      FROM thoughts a
      JOIN thoughts b ON a.id < b.id
        AND a.metadata->>'project' IS NOT NULL
        AND a.metadata->>'project' <> ''
        AND a.metadata->>'project' = b.metadata->>'project'
      WHERE (a.created_at >= v_since OR b.created_at >= v_since)
    ),
    combined_pairs AS (
      SELECT
        COALESCE(tp.a_id, pp.a_id) AS a_id,
        COALESCE(tp.b_id, pp.b_id) AS b_id,
        GREATEST(coalesce(tp.shared_topic_count, 0),
                 CASE WHEN pp.a_id IS NOT NULL THEN 1 ELSE 0 END) AS overlap,
        pp.a_id IS NOT NULL AS same_project
      FROM topic_pairs tp
      FULL OUTER JOIN project_pairs pp
        ON tp.a_id = pp.a_id AND tp.b_id = pp.b_id
    )
    SELECT cp.a_id, cp.b_id, cp.overlap
    FROM combined_pairs cp
    WHERE
      (cp.overlap >= p_min_overlap OR cp.same_project)
      AND NOT EXISTS (
        SELECT 1
        FROM thought_edges te
        WHERE
          (te.from_thought_id = cp.a_id AND te.to_thought_id = cp.b_id)
          OR (te.from_thought_id = cp.b_id AND te.to_thought_id = cp.a_id)
      )
    ORDER BY cp.overlap DESC, cp.a_id, cp.b_id
    LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION public.sample_candidate_pairs IS 'Phase 13: returns unclassified candidate thought pairs for typed-edge classification. Excludes pairs with any existing thought_edges row, including related_to. Used by supabase/functions/classify-edges/. p_since_days NULL means full backfill.';

REVOKE ALL ON FUNCTION public.sample_candidate_pairs(INT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sample_candidate_pairs(INT, INT, INT) TO service_role;

NOTIFY pgrst, 'reload schema';
