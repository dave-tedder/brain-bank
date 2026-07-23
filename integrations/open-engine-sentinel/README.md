# Open Engine Cloud Sentinel

Cloud-routine variant of the OE-14 Operations Sentinel (`skills/open-engine-sentinel/SKILL.md`).
Run it as a scheduled cloud routine (for example a claude.ai/code routine) so it can
detect machine-off misses — the one failure a locally hosted sentinel cannot see.
Schedule it after your last overnight lane and before your morning digest so the
digest surfaces a verdict about a finished night.

Differences from the local OE-14 skill:
- No Supabase `execute_sql`: the scorecard / watch-view learning eval stays a
  local-run capability. The cloud sentinel covers lane freshness + board health.
- No Slack post: the verdict is written to `agent_task_ledger.last_queue_result`
  and surfaced by the daily digest (single morning report surface). The digest's
  sentinel line parser lives at `supabase/functions/brain-digest/sentinel-report.ts`.

Setup: create a routine from `routine-prompt.txt`, edit its "Expected slots" table
to your actual lane schedule, and set env vars `BRAIN_BANK_MCP_URL` and
`BRAIN_BANK_MCP_KEY` on the routine's environment (paste values in the routine UI
only, never into files this repo tracks). Record the trigger ID in your operator
notes. Before the first run, seed the `sentinel` ledger identity per the
one-time preflight in `skills/open-engine-sentinel/SKILL.md`.
