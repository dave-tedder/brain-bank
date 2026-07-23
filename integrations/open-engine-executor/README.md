# Open Engine Executor (scheduled Claude Code routine)

The first execution lane for the Open Engine board: a daily Claude Code routine that claims ONE low-risk `claude-code` task, executes it with cloud-session tools (web research, drafting), and exits through an honest receipt — `AGENT DONE` into Agent Review only when the acceptance criteria are genuinely met, otherwise `AGENT HUMAN HOLD` or `AGENT FAILED`. The daily closeout controller (`scripts/open-engine/closeout-controller.mjs`) then reviews/applies whatever lands in Agent Review.

This is the OE-9 lane in the Open Engine build sequence, and the point where the board gains its first scheduled EXECUTION path. Everything before it (OE-1 through OE-8) keeps execution human-controlled; this lane is an opt-in scheduled executor for operators who want the board to handle real low-risk work daily. It is bounded on every side (one claim per run, low risk only, agent-code scoped, no canonical-state writes) so the autonomy stays narrow.

## How it relates to the existing lanes

| Lane | Runtime | Behavior |
|------|---------|----------|
| `open-engine-codex-daily` (pg_cron scheduled Queue Runner) | Supabase Edge Function | Claim-and-hold, no executor. Unchanged. |
| Closeout controller (scheduled review/apply) | Node script | Review/apply of Agent Review tasks. Unchanged. |
| **Open Engine Executor (this lane, daily)** | Claude Code scheduled routine | Claims one low-risk `claude-code` task and actually executes it. |

Scoping keeps the lanes from colliding: the pg_cron runner claims for `codex` (plus unassigned tasks); this executor claims only `claude-code` tasks at `max_risk=low`. Medium/high-risk tasks are untouchable by both scheduled paths.

Schedule the executor slot ahead of the closeout controller so an executed task can be reviewed the same day it runs.

## Two ways to run it

### Local scheduled task (full local toolset)

Run it as a Claude Code **local scheduled task** (a `SKILL.md` under `~/.claude/scheduled-tasks/`, e.g. cron `0 7 * * *` local time). This runs with the full local MCP toolset — direct `mcp__*` board calls, no curl/env plumbing. Trade-off: local tasks only run while the Claude app is open on the host machine (a missed slot fires on next launch). Start from `local-task-skill-template.md` in this directory: it is the hardened SKILL body (unattended-safe tool discipline, the three permission gates, the write-safe policy, deliverables durability push, the receipt contract) with placeholders for your agent code, paths, and voice rules.

Operator step (once): click "Run now" on the task in the Scheduled sidebar section and approve its tool prompts, so future runs don't pause on permissions.

### Cloud routine (machine-independent)

`routine-prompt.txt` in this directory is a curl/JSON-RPC variant of the same heartbeat for claude.ai/code/routines, so it runs independent of any one machine. To activate: create the routine in the UI with that prompt on your chosen daily schedule, and add env vars `BRAIN_BANK_MCP_URL` + `BRAIN_BANK_MCP_KEY` in the routine settings (values from your deployment; never commit them to the repo). It is fail-closed (`NO_RECEIPT` stop) until env is set. If you activate the cloud routine, pause the local task so the two lanes don't both claim daily.

## Safety properties

- Fail-closed preflight (env check + ledger read) before any claim.
- One claim per run, low risk only, agent-code scoped.
- 40-minute execution budget against the 60-minute claim expiry; overruns exit as honest holds, never silent claim expiry.
- The routine never applies reviews, never resolves action items, never edits trackers/session logs, never runs git — the OE-7/OE-8 apply layer owns canonical state.
- Cloud-unexecutable packets (LOCAL RUNTIME ONLY, WordPress MCP work, anything requiring logins/sends/spend) are held for a local runtime, not attempted.
