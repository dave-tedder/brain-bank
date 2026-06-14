-- supabase/migrations/0014_thought_edges.sql
--
-- Phase 13.1: Typed Reasoning Edges
--
-- Adds a `thought_edges` table holding semantic relations between thoughts
-- (supports, contradicts, evolved_into, supersedes, depends_on, related_to)
-- plus an UPSERT RPC for accumulating evidence on repeat classifications,
-- and a candidate-pair sampling RPC used by the classify-edges Edge Function.
--
-- Ports OB1 PR #208 (https://github.com/NateBJones-Projects/OB1/pull/208)
-- minus the entity-edges temporal validity columns and the thoughts.supersedes
-- denormalization (we have neither). The classifier in
-- supabase/functions/classify-edges/ writes to this table.

-- 0. PREREQUISITE CHECK
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'thoughts'
  ) THEN
    RAISE EXCEPTION 'thought_edges requires the public.thoughts table. Run the brain-bank engine migrations first.';
  END IF;
END $$;

-- 1. THOUGHT EDGES TABLE
CREATE TABLE IF NOT EXISTS public.thought_edges (
  id BIGSERIAL PRIMARY KEY,
  from_thought_id UUID NOT NULL REFERENCES public.thoughts(id) ON DELETE CASCADE,
  to_thought_id UUID NOT NULL REFERENCES public.thoughts(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (
    relation IN ('supports', 'contradicts', 'evolved_into', 'supersedes', 'depends_on', 'related_to')
  ),
  confidence NUMERIC(3,2) CHECK (confidence >= 0 AND confidence <= 1),
  decay_weight NUMERIC(3,2) CHECK (decay_weight IS NULL OR (decay_weight >= 0 AND decay_weight <= 1)),
  valid_from TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  classifier_version TEXT,
  support_count INT NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_thought_id, to_thought_id, relation),
  CHECK (from_thought_id <> to_thought_id)
);

COMMENT ON TABLE public.thought_edges IS 'Phase 13: typed semantic relations between thoughts. Populated by the classify-edges Edge Function.';
COMMENT ON COLUMN public.thought_edges.confidence IS 'Classifier confidence 0-1';
COMMENT ON COLUMN public.thought_edges.decay_weight IS 'Current temporal weight 0-1; lower = less relevant';
COMMENT ON COLUMN public.thought_edges.valid_from IS 'When the relation became true (NULL = unknown/always)';
COMMENT ON COLUMN public.thought_edges.valid_until IS 'When the relation stopped being true (NULL = still current)';
COMMENT ON COLUMN public.thought_edges.classifier_version IS 'Tag identifying the classifier vocabulary/version that produced the row';

-- 2. INDEXES
CREATE INDEX IF NOT EXISTS idx_thought_edges_from_relation
  ON public.thought_edges (from_thought_id, relation);

CREATE INDEX IF NOT EXISTS idx_thought_edges_to_relation
  ON public.thought_edges (to_thought_id, relation);

-- Partial index: "currently valid" edges are the most common read path
CREATE INDEX IF NOT EXISTS idx_thought_edges_current
  ON public.thought_edges (from_thought_id, to_thought_id)
  WHERE valid_until IS NULL;

-- Partial index for decay sweeps: rows with a valid_until we might expire
CREATE INDEX IF NOT EXISTS idx_thought_edges_valid_until
  ON public.thought_edges (valid_until)
  WHERE valid_until IS NOT NULL;

-- 3. updated_at TRIGGER
CREATE OR REPLACE FUNCTION public.thought_edges_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_thought_edges_updated_at ON public.thought_edges;
CREATE TRIGGER trg_thought_edges_updated_at
  BEFORE UPDATE ON public.thought_edges
  FOR EACH ROW EXECUTE FUNCTION public.thought_edges_set_updated_at();

-- 4. ROW LEVEL SECURITY
--    Mirror public.thoughts: service_role only. Edge rows expose derived
--    relationships between private thoughts; the posture must match.
ALTER TABLE public.thought_edges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role full access" ON public.thought_edges;
CREATE POLICY "service_role full access"
  ON public.thought_edges
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Defensive: drop any previously-granted authenticated read policy
DROP POLICY IF EXISTS "authenticated read" ON public.thought_edges;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.thought_edges TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.thought_edges_id_seq TO service_role;
REVOKE ALL ON public.thought_edges FROM authenticated;
REVOKE ALL ON public.thought_edges FROM anon;

-- 5. UPSERT RPC
--    INSERT-or-bump-support-count for repeat classifications.
CREATE OR REPLACE FUNCTION public.thought_edges_upsert(
  p_from_thought_id UUID,
  p_to_thought_id UUID,
  p_relation TEXT,
  p_confidence NUMERIC,
  p_support_count INT,
  p_classifier_version TEXT,
  p_valid_from TIMESTAMPTZ,
  p_valid_until TIMESTAMPTZ,
  p_metadata JSONB
)
RETURNS public.thought_edges
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.thought_edges;
BEGIN
  INSERT INTO public.thought_edges (
    from_thought_id, to_thought_id, relation,
    confidence, support_count, classifier_version,
    valid_from, valid_until, metadata
  )
  VALUES (
    p_from_thought_id, p_to_thought_id, p_relation,
    p_confidence, COALESCE(p_support_count, 1), p_classifier_version,
    p_valid_from, p_valid_until, COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (from_thought_id, to_thought_id, relation)
  DO UPDATE SET
    support_count = public.thought_edges.support_count + COALESCE(EXCLUDED.support_count, 1),
    confidence = GREATEST(public.thought_edges.confidence, EXCLUDED.confidence),
    valid_until = CASE
      WHEN public.thought_edges.valid_until IS NULL OR EXCLUDED.valid_until IS NULL THEN NULL
      ELSE GREATEST(public.thought_edges.valid_until, EXCLUDED.valid_until)
    END,
    valid_from = CASE
      WHEN public.thought_edges.valid_from IS NULL THEN EXCLUDED.valid_from
      WHEN EXCLUDED.valid_from IS NULL THEN public.thought_edges.valid_from
      ELSE LEAST(public.thought_edges.valid_from, EXCLUDED.valid_from)
    END,
    classifier_version = EXCLUDED.classifier_version,
    metadata = public.thought_edges.metadata || EXCLUDED.metadata,
    updated_at = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.thought_edges_upsert IS 'Phase 13: insert or bump support_count + refresh temporal bounds. Use instead of plain INSERT to let repeat classifications accumulate evidence.';

REVOKE ALL ON FUNCTION public.thought_edges_upsert(
  UUID, UUID, TEXT, NUMERIC, INT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, JSONB
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.thought_edges_upsert(
  UUID, UUID, TEXT, NUMERIC, INT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, JSONB
) TO service_role;

-- 6. CANDIDATE PAIR SAMPLING RPC
--    Two-arm OR: same-project (counts as overlap=1), OR
--    >= p_min_overlap shared topics. p_since_days NULL means full backfill.
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
    )
    SELECT
      COALESCE(tp.a_id, pp.a_id) AS a_id,
      COALESCE(tp.b_id, pp.b_id) AS b_id,
      GREATEST(coalesce(tp.shared_topic_count, 0),
               CASE WHEN pp.a_id IS NOT NULL THEN 1 ELSE 0 END) AS overlap
    FROM topic_pairs tp
    FULL OUTER JOIN project_pairs pp
      ON tp.a_id = pp.a_id AND tp.b_id = pp.b_id
    WHERE
      coalesce(tp.shared_topic_count, 0) >= p_min_overlap
      OR pp.a_id IS NOT NULL
    ORDER BY overlap DESC, a_id, b_id
    LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION public.sample_candidate_pairs IS 'Phase 13: returns candidate thought pairs for typed-edge classification. Used by supabase/functions/classify-edges/. p_since_days NULL means full backfill.';

REVOKE ALL ON FUNCTION public.sample_candidate_pairs(INT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sample_candidate_pairs(INT, INT, INT) TO service_role;

-- 7. RELOAD POSTGREST SCHEMA CACHE
NOTIFY pgrst, 'reload schema';
