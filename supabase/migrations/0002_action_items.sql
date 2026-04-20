-- 0002_action_items.sql
-- Open tasks extracted from thoughts. Each row links back to its source
-- thought; when resolved, links forward to the thought that resolved it
-- (see the auto-resolve pipeline documented in docs/architecture/).

CREATE TABLE public.action_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_thought_id uuid REFERENCES public.thoughts(id),
  description text NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status = ANY (ARRAY['open', 'resolved'])),
  resolved_by_thought_id uuid REFERENCES public.thoughts(id),
  created_at timestamptz DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX idx_action_items_source ON public.action_items (source_thought_id);
CREATE INDEX idx_action_items_status ON public.action_items (status);
CREATE INDEX idx_action_items_created ON public.action_items (created_at DESC);

-- No updated_at column / no trigger by design — action_items moves through
-- exactly one state transition (open → resolved), captured in resolved_at.

ALTER TABLE public.action_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on action_items"
  ON public.action_items
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
