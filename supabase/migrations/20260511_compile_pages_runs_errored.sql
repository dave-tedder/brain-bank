-- Bundle C follow-up: capture per-page error detail in compile-pages audit rows.
--
-- The 2026-05-11 audit row showed errors=10 with compiled_slugs=[] and no way
-- to know which 10 pages erred or why -- console.error output is not visible
-- through Supabase's edge-function log surface (only HTTP request envelopes).
--
-- jsonb chosen over parallel text[] columns so slug stays paired with message.
-- Nullable, no default: existing rows stay null (= pre-column), new runs with
-- zero errors get an empty array, runs with errors get [{slug, error}, ...].

ALTER TABLE public.compile_pages_runs
  ADD COLUMN errored jsonb;
