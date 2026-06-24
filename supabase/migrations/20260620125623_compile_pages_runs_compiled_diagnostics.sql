-- Session 200 follow-up: durable per-page diagnostics for successful fallback compiles.
--
-- `errored` already records failed per-page diagnostics. This companion field
-- records successful pages only when compile-pages had to shrink an expensive
-- catch-up prompt before synthesis, so the next scheduled cron audit can see
-- which slugs used fallback and why without relying on an HTTP response body.

ALTER TABLE public.compile_pages_runs
  ADD COLUMN compiled_diagnostics jsonb;
