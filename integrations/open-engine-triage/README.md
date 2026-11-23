# Open Engine Triage (scheduled OE-12 lane)

The intake lane for the Open Engine board: a daily pass as agent code `triage` that reads the oldest unreviewed open action items (`list_open_action_items` with `unreviewed_days: 14`), classifies them, creates full-packet **Standing** drafts for the board-eligible ones, and records a durable review on every item it read with `review_action_item`: `keep` for real open work, or a `proposal` with a disposition (stale, duplicate, vague, done, paused) and its evidence, which the morning digest shows as a tag beside the item. Its one promotion power is the guarded stage-4 auto-promote (live since 2026-07-15): for drafts it created in the same run, it may call `auto_promote_agent_task_intake`, and the server itself enforces the safety allowlist (low-risk, action-item-linked, full-packet, non-local, non-live-surface) plus the daily cap, declining anything else. It never calls the human promote path, never resolves, archives or defers action items (a review is a tag, not a status change), never edits files, never runs git, never sends anything. The next OE-11 briefing surfaces whatever it drafted so the operator can decide what else to promote.

## How it relates to the other lanes

Triage creates **Standing** drafts, which are unclaimable until promoted (by the operator, or by the guarded auto-promote for a qualifying draft). Executor lanes claim only **Agent Todo** tasks, so a draft that did not auto-promote can never be picked up by a scheduled run. Schedule triage before your morning digest so the digest reports on a board that is already triaged, and before your daytime executor slots so promoted drafts get picked up the same day.

## Running it

`routine-prompt.txt` in this directory is a curl/JSON-RPC variant of the heartbeat for a scheduled cloud routine (machine-independent). Because a cloud session has no local repo and cannot load the `open-engine-triage` skill, this variant **embeds** the rubric and procedure inline — it is the one place the rubric is duplicated, and it must be kept in sync with `skills/open-engine-triage/SKILL.md` whenever either changes. To activate: create the routine with that prompt and set env vars `BRAIN_BANK_MCP_URL` + `BRAIN_BANK_MCP_KEY` on the routine's environment (values never come from this repo). It is fail-closed (`NO_RECEIPT` stop) until env is set. See `skills/routines-cloud-tasks/SKILL.md` for the platform gotchas.

Alternative: run it as a local scheduled task pointing at the `open-engine-triage` skill (single source of the rubric, full local MCP toolset), accepting that local tasks only fire while the app is open on that machine. If you run both, pause one so two lanes don't draft daily.

## Safety properties

- Fail-closed preflight (env/tool check + ledger read) before any draft.
- Draft-safe by default: every write is a **Standing** `create_agent_task_intake`. The only promotion is `auto_promote_agent_task_intake` on same-run drafts, where the server re-checks the allowlist and daily cap itself and declines non-qualifying calls.
- Never calls `promote_agent_task_intake`, never grants `explicit_approval`, never assigns an `agent_code` at draft time.
- Never resolves, archives, defers, restores, or creates action items or thoughts — resolution is the auto-resolve pipeline's and the operator's job. Its one write to an action item is `review_action_item`, which records the review columns and cannot change a status; a proposal waits for the operator.
- An item triage did not finish (past the draft cap, or a failed draft call) is left unreviewed so it leads the next run.
- Never edits trackers/session logs, never runs git, never deploys, never sends email/Slack/posts.
- Draft cap per run and a bounded read; overflow is reported in the ledger summary, not silently dropped.
- Risk is fail-closed: anything not clearly low per the rubric is medium, which the auto-promote allowlist can never touch.
