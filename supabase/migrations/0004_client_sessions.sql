-- 0004_client_sessions.sql
-- Deprecated in the live Open Brain deployment (0 rows, no active population
-- path). Kept in the schema for schema-completeness and because operators
-- may wire up their own population from the MCP `log_session` tool. No
-- updated_at column — sessions are append-only event records.

CREATE TABLE public.client_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES public.clients(id),
  session_date date,
  duration_hours numeric,
  piece_description text,
  placement text,
  style text,
  status text DEFAULT 'scheduled',
  notes text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_client_sessions_client_id ON public.client_sessions (client_id);
CREATE INDEX idx_client_sessions_date ON public.client_sessions (session_date DESC);
CREATE INDEX idx_client_sessions_metadata ON public.client_sessions USING gin (metadata);

ALTER TABLE public.client_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on client_sessions"
  ON public.client_sessions
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
