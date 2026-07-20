-- Phase 2 deliverables artifact bucket (decision D4).
-- Target file: supabase/migrations/20260719_deliverables_bucket.sql
--
-- Additive and INERT to the running board: no existing tool touches storage,
-- and no RLS policy is added for anon/authenticated roles — the bucket is
-- reachable ONLY through the service-role client inside open-brain-mcp
-- (put/get/list_deliverables), which enforces the path shape.
--
-- file_size_limit matches DELIVERABLE_MAX_BYTES (512 KB).

insert into storage.buckets (id, name, public, file_size_limit)
values ('deliverables', 'deliverables', false, 524288)
on conflict (id) do nothing;

-- Verification (run after apply):
--   select id, public, file_size_limit from storage.buckets where id = 'deliverables';
-- Expect exactly one row: public = false, file_size_limit = 524288.
--   select count(*) from storage.objects where bucket_id = 'deliverables';
-- Expect 0 until the first cloud put.
