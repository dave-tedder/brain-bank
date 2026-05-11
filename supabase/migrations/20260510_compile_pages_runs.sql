-- Audit Finding 6: durable per-run audit trail for compile-pages.
-- Written at end of every Deno.serve handler in compile-pages/index.ts
-- (success path + outer catch), via EdgeRuntime.waitUntil.
--
-- Solves the 2026-05-08 zero-compile mystery class of problem: when
-- pg_cron status says "succeeded" (dispatch worked) but compiled_pages
-- shows zero mutations, this table records what the Edge Function actually
-- returned. Replaces the unreliable net._http_response surface (Finding 19).

CREATE TABLE public.compile_pages_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  mode          text NOT NULL,                          -- compile / lint / index
  index_mode    text NOT NULL,                          -- auto / force / skip
  batch         integer,
  pages_total   integer,
  auto_created  integer,
  compiled      integer,
  skipped       integer,
  errors        integer,
  index_compiled       boolean,
  index_skipped_reason text,
  compiled_slugs       text[],
  status        text NOT NULL,                          -- complete / errored
  error_message text,
  duration_ms   integer,
  invoker       text                                    -- 'pg_cron' / 'manual'
);

CREATE INDEX compile_pages_runs_created_at_idx
  ON public.compile_pages_runs (created_at DESC);
