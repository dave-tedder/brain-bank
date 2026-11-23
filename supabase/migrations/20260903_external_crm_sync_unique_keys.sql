-- external-crm-sync: make the database the arbiter of "one row per CRM id".
--
-- The new Edge Function upserts clients on metadata->>'crm_id' and
-- business_events on metadata->>'crm_appointment_id'. supabase-js has
-- no transaction, so the function cannot hold an advisory lock across its
-- lookup and write; instead it relies on these two partial unique indexes and
-- retries once on 23505 (insert-then-select with a retry). Neither table had
-- any unique constraint before this (idempotency was entirely the writer's
-- job), and no existing row carries either key before the CRM push starts, so both build clean.
--
-- Partial: rows without the key (every row written by the Apps Script calendar
-- sync, the chat-bot bridge bridge, add_client, or the REST /client route) are not in
-- the index and are unaffected. A duplicate Brain Bank row that maps to an
-- already-claimed card gets metadata.crm_duplicate_of, never a second
-- crm_id, so the clients index holds by construction.

create unique index if not exists idx_clients_crm_id_unique
  on public.clients ((metadata->>'crm_id'))
  where metadata->>'crm_id' is not null;

create unique index if not exists idx_business_events_crm_appointment_id_unique
  on public.business_events ((metadata->>'crm_appointment_id'))
  where metadata->>'crm_appointment_id' is not null;
