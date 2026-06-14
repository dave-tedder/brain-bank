-- Bundle B (audit Finding 3a): give the wiki index its own daily cron tick
-- separate from the entity-page compile cron. The entity cron at 09:45 UTC
-- can run up to 150s and routinely defers the index synthesis when it does
-- any entity work (auto-mode requires compiled === 0 && errors === 0).
-- This dedicated tick fires at 10:00 UTC (15 min after entity work) with
-- mode=index&index=force so it always attempts the synthesis. Costs ~$0.01/day
-- in OpenRouter usage and one pg_cron slot.
--
-- Wrapper shape mirrors the existing `compile-pages-daily` cron row
-- (see 20260419_pg_cron_vault_key_lookup.sql): GET method, query-string
-- params, vault-resolved `mcp_access_key`. No JSON body — the Edge Function
-- reads mode/index from URL query params.

SELECT cron.schedule(
  'compile-pages-index-daily',
  '0 10 * * *',
  'SELECT public.call_edge_function(''compile-pages'', ''mode=index&index=force'', ''GET'') AS request_id;'
);
