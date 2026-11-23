-- Loop-closing Task 4.1: the nightly schedule of the aged-item re-check.
--
-- APPLY ONLY AFTER (plan Task 4.1, Steps 3 and 4):
--   1. 20261119c_action_items_recheck.sql is applied,
--   2. the action-item-recheck Edge Function is deployed,
--   3. a dry run (POST ...?dry_run=1) has been read and its precision recorded.
-- Until then the function exists and can be called by hand; nothing calls it.
--
-- 04:00 UTC daily, before triage (09:30 UTC) and the digest (11:00 UTC). It
-- only needs to finish before them, so it is not a DST anchor. The call goes
-- through public.call_edge_function, which reads the access key from the vault;
-- no key appears in cron.job.command (pg-cron-patterns).
--
-- The job's own status in cron.job_run_details says only that the HTTP request
-- was queued. The run's verdict is the row the function writes to
-- public.action_item_recheck_runs, which the digest prints when the last run is
-- missing, stale, failed or incomplete.
--
-- Rollback: select cron.unschedule('action-item-recheck-nightly');
select cron.schedule(
  'action-item-recheck-nightly',
  '0 4 * * *',
  $cron$select public.call_edge_function('action-item-recheck', '', 'POST') as request_id;$cron$
);
