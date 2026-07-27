---
name: routines-cloud-tasks
description: Use when creating, editing, or debugging scheduled cloud routines (claude.ai/code/routines, formerly "cloud scheduled tasks") that run Brain Bank lanes — triage, critic, sentinel, or executor routine prompts from integrations/. Covers RemoteTrigger and trig_* IDs, environment-level env vars, prompt voice, webhook triggers, and why MCP connectors do not inject tools into remote sessions.
---

# Routines (Scheduled Cloud Agents)

The Open Engine cloud lanes (`integrations/open-engine-triage/`, `-critic/`,
`-sentinel/`, `-executor/`) are designed to run as scheduled cloud routines at
claude.ai/code/routines. Each run is a fresh session with no state carryover.
Existing trigger IDs (`trig_*`) and the RemoteTrigger API drive them
programmatically; the per-routine API webhook at
`https://api.anthropic.com/v1/claude_code/routines/{routine_id}/fire` (Bearer
auth) fires one on demand. Minimum schedule: 1 hour.

**Hard-won facts:**

- **Env vars are NOT per-routine. They live on the cloud ENVIRONMENT.** In a
  routine's edit modal, open the environment picker, then "Update cloud
  environment" → Environment variables (.env format). Set your board
  credentials (`BRAIN_BANK_MCP_URL`, `BRAIN_BANK_MCP_KEY`) there once; every
  routine sharing that environment sees them. The environment needs Full
  network access to curl your Supabase endpoint. There is no vault: the field
  warns against secrets, so decide deliberately whether that trade is
  acceptable for your deployment. Changes apply to NEW sessions only.
- **Prompts must be in plain task-agent voice.** Security-hardened prompts
  (self-referential overrides, ANTI-SPOOFING absolutes, identity-adoption
  framing next to curl-with-key instructions) get REFUSED by the cloud model
  as prompt-injection. Keep routine prompts boring and procedural; the shipped
  routine prompts follow this voice.
- **MCP connectors do NOT inject tools into routine runs.** A connector
  attached to a routine displays in the UI but its `mcp__*` tools never appear
  in the remote session. The curl-with-env-var pattern in the shipped prompts
  is the only working path; an attached connector is dead weight.
- **Never put the access key in a connector or webhook URL.** The RemoteTrigger
  `update` API ignores `mcp_connections: []` and `null` (silently treated as
  not-provided) but HONORS a non-empty array as a full replacement — so you
  cannot clear connectors to zero via the API, but you can rewrite the list to
  strip a key from a URL or drop one connector of several.
- **The routine holds its own COPY of the prompt.** Editing the
  `routine-prompt.txt` file in this repo changes nothing about what fires on
  schedule — push the edit to the live routine (UI, or RemoteTrigger `update`
  sending the full `job_config` to preserve environment, model, and allowed
  tools) every time the file changes.
- **RemoteTrigger `/run` is slow, not broken.** A fired run can take several
  minutes to boot and complete. Do not conclude failure from an early check of
  your ledger; the scheduled cron path fires normally.
- **Scheduling:** run every lane that feeds your morning digest before the
  digest's cron hour, and schedule the sentinel after your last overnight lane
  so its verdict describes a finished night.
