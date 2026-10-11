-- external-crm-sync capture_intake: make the database the arbiter of "one
-- thought per CRM intake".
--
-- capture_intake keys on thoughts.metadata->>'crm_intake_id'. Same pattern as
-- 20260903_external_crm_sync_unique_keys: supabase-js has no transaction, so
-- the function looks up first, inserts, and on 23505 re-finds and answers
-- `duplicate` with the existing thought's id. No existing row carries the key
-- before the CRM starts pushing intakes, so the index builds clean.
--
-- Partial: every thought written by any other capture path lacks the key and
-- is not in the index.
--
-- Note: thoughts.content_hash is ALSO unique (idx_thoughts_content_hash). The
-- function does not let that index reject an intake; on a content-hash
-- collision with no intake-id winner it re-inserts with the hash salted by the
-- intake id. See captureIntake in supabase/functions/external-crm-sync/_sync.ts.

create unique index if not exists idx_thoughts_crm_intake_id_unique
  on public.thoughts ((metadata->>'crm_intake_id'))
  where metadata->>'crm_intake_id' is not null;
