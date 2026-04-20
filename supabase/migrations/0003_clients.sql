-- 0003_clients.sql
-- Part of the client-context extension. Populated by Notion sync + auto
-- client creation from calendar/email signals. Neutral schema — operators
-- customize `preferred_styles` and `metadata` for their domain via
-- profile.json (see Phase 3).

CREATE TABLE public.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text,
  phone text,
  instagram text,
  preferred_styles text[],
  notes text,
  metadata jsonb DEFAULT '{}'::jsonb,
  first_contact timestamptz,
  last_contact timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_clients_name ON public.clients (name);
CREATE INDEX idx_clients_metadata ON public.clients USING gin (metadata);

CREATE TRIGGER update_clients_updated_at
  BEFORE UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on clients"
  ON public.clients
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
