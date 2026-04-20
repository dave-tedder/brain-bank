-- 0009_digests.sql
-- Persisted daily/weekly digests written by the brain-digest Edge Function
-- before Slack delivery, so the dashboard can render an archive. One row per
-- (date, type); re-fires upsert over the same row. No updated_at — digests
-- are append-only for a given key; a second synth just overwrites in place.

CREATE TABLE public.digests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  digest_date date NOT NULL,
  digest_type text NOT NULL
    CHECK (digest_type = ANY (ARRAY['daily', 'weekly'])),
  markdown text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  UNIQUE (digest_date, digest_type)
);

CREATE INDEX digests_date_desc ON public.digests (digest_date DESC, digest_type);

ALTER TABLE public.digests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on digests"
  ON public.digests
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
