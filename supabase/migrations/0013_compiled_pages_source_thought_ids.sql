-- Phase 12.D: page-to-thought citations.
-- Add a uuid[] column to compiled_pages capturing every thought row that
-- has contributed to the page across compile passes. Cumulative (set union
-- on each compile). Defaults to empty array so existing rows pre-12.D remain
-- queryable; they backfill organically as their next compile pass lands.

ALTER TABLE public.compiled_pages
  ADD COLUMN source_thought_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

-- GIN index for "which pages cite thought X" queries (used by drill-back
-- analytics, weekly lint, contradiction detection).
CREATE INDEX idx_compiled_pages_source_thought_ids
  ON public.compiled_pages USING GIN (source_thought_ids);

COMMENT ON COLUMN public.compiled_pages.source_thought_ids IS
  'Cumulative list of thoughts.id values that have contributed to this page across all compile passes. See Phase 12.D plan.';
