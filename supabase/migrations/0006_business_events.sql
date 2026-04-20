-- 0006_business_events.sql
-- Business operations extension: date-anchored events the digest references
-- (travel, conventions, guest spots, shop closures, product drops). The
-- `event_type` column is free text in brain-bank (live OB had a tattoo-
-- specific enum that Phase 3 task 3.8 will genericize in the Edge Function
-- layer, not the schema).

CREATE TABLE public.business_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text,
  title text NOT NULL,
  date_start date,
  date_end date,
  location text,
  notes text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_business_events_type ON public.business_events (event_type);
CREATE INDEX idx_business_events_date_start ON public.business_events (date_start DESC);
CREATE INDEX idx_business_events_metadata ON public.business_events USING gin (metadata);

CREATE TRIGGER update_business_events_updated_at
  BEFORE UPDATE ON public.business_events
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.business_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on business_events"
  ON public.business_events
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
