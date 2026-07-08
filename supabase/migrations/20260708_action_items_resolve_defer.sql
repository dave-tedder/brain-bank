-- Operator-gated action-item resolve/defer path.
--
-- Adds a reversible 'deferred' status plus operator metadata so paused-project
-- items can drop out of list_open_action_items and return on unpause, and so a
-- genuinely-done item can be resolved with an audit note. Backs the manual MCP
-- tools resolve_action_item, defer_action_item, and restore_action_item.
--
-- Non-breaking: every current consumer filters status = 'open' explicitly, so
-- widening the constraint and adding nullable columns changes no existing read
-- path. No RLS change — action_items already has its service_role policy and
-- this migration only adds columns / constraint / index.

alter table public.action_items
  drop constraint if exists action_items_status_check;

alter table public.action_items
  add constraint action_items_status_check
  check (status in ('open', 'resolved', 'archived', 'deferred'));

alter table public.action_items
  add column if not exists resolution_note text,
  add column if not exists deferred_at timestamptz,
  add column if not exists defer_reason text;

-- Covers restore_action_item(defer_reason) — the unpause path flips every
-- deferred row carrying one pause tag back to 'open' in a single statement.
create index if not exists action_items_defer_reason_idx
  on public.action_items (defer_reason)
  where status = 'deferred';

notify pgrst, 'reload schema';
