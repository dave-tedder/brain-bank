-- 0005_content_items.sql
-- Content pipeline extension: tracks work from captured idea through
-- published output. The `performance` jsonb holds platform-specific metrics
-- (views, likes, saves) so the shape is loose. Operators wire their own
-- publishing pipelines into the MCP `log_content` / `update_content` tools.

CREATE TABLE public.content_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text,
  content_type text,
  subject text,
  client_id uuid REFERENCES public.clients(id),
  stage text DEFAULT 'captured',
  platform text,
  scheduled_date date,
  published_date date,
  performance jsonb DEFAULT '{}'::jsonb,
  notes text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_content_items_client_id ON public.content_items (client_id);
CREATE INDEX idx_content_items_content_type ON public.content_items (content_type);
CREATE INDEX idx_content_items_stage ON public.content_items (stage);
CREATE INDEX idx_content_items_created_at ON public.content_items (created_at DESC);
CREATE INDEX idx_content_items_metadata ON public.content_items USING gin (metadata);
CREATE INDEX idx_content_items_performance ON public.content_items USING gin (performance);

CREATE TRIGGER update_content_items_updated_at
  BEFORE UPDATE ON public.content_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.content_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on content_items"
  ON public.content_items
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
