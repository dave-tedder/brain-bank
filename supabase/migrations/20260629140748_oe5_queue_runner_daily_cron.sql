-- OE-5: first scheduled Queue Runner heartbeat.
-- Daily only. Do not increase frequency until seven clean days are verified.
-- Secret stays in Vault through public.call_edge_function(...); no inline key.

select cron.schedule(
  'open-engine-local-codex-daily',
  '30 11 * * *',
  $$SELECT public.call_edge_function('queue-runner', '', 'POST') AS request_id;$$
);
