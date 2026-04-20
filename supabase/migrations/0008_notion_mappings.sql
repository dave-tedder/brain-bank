-- 0008_notion_mappings.sql
-- Maps local entities (clients, projects, etc.) to their Notion page IDs so
-- the Notion sync routine can round-trip updates without duplicating rows.
-- (entity_type, entity_name) must be unique — one Notion page per named
-- entity per type.

CREATE TABLE public.notion_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_name text NOT NULL,
  notion_page_id text NOT NULL,
  last_synced timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (entity_type, entity_name)
);

CREATE TRIGGER update_notion_mappings_updated_at
  BEFORE UPDATE ON public.notion_mappings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.notion_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on notion_mappings"
  ON public.notion_mappings
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
