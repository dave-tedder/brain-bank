-- 0007_compiled_pages.sql
-- Wiki compilation layer (Phase 8). The compile-pages Edge Function
-- synthesizes per-client, per-topic, and per-project pages from the
-- underlying thoughts + action_items + clients + business_events, and
-- maintains a backlink graph in the `backlinks` array. `source_entity_id`
-- points to the driving row (clients.id for `page_type = 'client'`, etc.)
-- when the page type has a canonical entity, and is null for topic pages.

CREATE TABLE public.compiled_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  page_type text NOT NULL
    CHECK (page_type = ANY (ARRAY['client', 'topic', 'project'])),
  content text NOT NULL DEFAULT '',
  backlinks text[] NOT NULL DEFAULT '{}'::text[],
  source_entity_id uuid,
  last_compiled timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_compiled_pages_page_type ON public.compiled_pages (page_type);

CREATE TRIGGER update_compiled_pages_updated_at
  BEFORE UPDATE ON public.compiled_pages
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.compiled_pages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on compiled_pages"
  ON public.compiled_pages
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
