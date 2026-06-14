-- Extend action_items.status with an archival state. Existing consumers query
-- status = 'open' explicitly, so widening the constraint is non-breaking.

alter table public.action_items
  drop constraint if exists action_items_status_check;

alter table public.action_items
  add constraint action_items_status_check
  check (status in ('open', 'resolved', 'archived'));
