-- Phase 15.5 F4: covering index for the action_items foreign key.
-- Unindexed foreign keys slow cascade checks and force sequential scans on
-- resolved_by_thought_id lookups. Non-destructive and idempotent.

CREATE INDEX IF NOT EXISTS action_items_resolved_by_thought_id_idx
  ON public.action_items (resolved_by_thought_id);
