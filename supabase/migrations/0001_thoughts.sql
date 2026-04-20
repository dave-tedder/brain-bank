-- 0001_thoughts.sql
-- Core capture table. Every thought gets an embedding (1536-dim, OpenAI
-- text-embedding-3-small), a SHA-256 content_hash for dedup, and a jsonb
-- metadata blob extracted by the ingest pipeline.

CREATE TABLE public.thoughts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content text NOT NULL,
  embedding extensions.vector(1536),
  metadata jsonb DEFAULT '{}'::jsonb,
  content_hash text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Dedup on content_hash. SHA-256 hex (64 chars) computed pre-insert in
-- ingest-thought / open-brain-mcp. The UNIQUE constraint is the enforcement
-- point; the app-side check is just a fast-path to avoid embedding calls.
CREATE UNIQUE INDEX idx_thoughts_content_hash ON public.thoughts (content_hash);

-- HNSW cosine index for match_thoughts() similarity search.
CREATE INDEX thoughts_embedding_idx ON public.thoughts
  USING hnsw (embedding extensions.vector_cosine_ops);

-- GIN on metadata for `metadata @> filter` and `metadata->'topics'` lookups.
CREATE INDEX thoughts_metadata_idx ON public.thoughts USING gin (metadata);

-- Newest-first scans (dashboard, list_thoughts tool, digest windows).
CREATE INDEX thoughts_created_at_idx ON public.thoughts (created_at DESC);

-- updated_at maintenance.
CREATE TRIGGER thoughts_updated_at
  BEFORE UPDATE ON public.thoughts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- RLS: enabled, service_role full access. Brain Bank is single-tenant per
-- deploy; Edge Functions use the service_role key which bypasses RLS
-- automatically. The explicit policy is for advisor compliance + defense
-- in depth if an operator later exposes `anon` to a web client.
ALTER TABLE public.thoughts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on thoughts"
  ON public.thoughts
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
