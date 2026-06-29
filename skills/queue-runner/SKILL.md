---
name: queue-runner
description: Use when manually running one Open Engine Queue Runner heartbeat from the agent task board, especially when claiming, resuming, blocking, completing, or writing ledger receipts through the Brain Bank MCP task tools. Keeps the run manual, one-task-only, and parent-session-owned.
type: skill
---

# Queue Runner

Run one manual Open Engine heartbeat for one runtime, then stop. Start with the runtime `agent_code` configured in the task ledger. Add another runtime only after the first one has passed the smoke tests and the build plan says to expand.

This skill does not create cron jobs, scheduled runners, background loops, Slack sends, credential changes, billing changes, deletes, deploys, client-facing messages, WordPress changes, or autonomous execution.

## Runtime Identity

Default runtime:

- `agent_code`: the runtime code requested by the user, such as `your-codex`
- `operator`: the user
- `automation_state`: `manual-required`

Use an `agent_code` only after the ledger confirms it exists. Never invent a new ledger identity during a heartbeat.

## Mandatory Preflight

Before touching a task:

1. Read the project guidance file.
2. Read `PROJECT-TRACKER.md`.
3. Read the latest `SESSION-LOG.md` entry.
4. Read the active Open Engine build plan or project equivalent.
5. Read the public/private workflow before edits in shared surfaces.
6. Run `git status --short --branch`.
7. Read the runtime ledger with `read_agent_ledger`.
8. Confirm the run is still manual-only and scoped to one task.

If the repo has unknown dirty work, stop and report it. Do not claim new work until the dirty state is understood.

## Heartbeat Order

Follow this order exactly:

1. Identify the runtime `agent_code`.
2. Read the ledger.
3. Run the standing context preflight above.
4. Check human-hold and blocked tasks before new work.
5. Resume exactly one ready hold or block if possible.
6. Otherwise claim the oldest eligible `Agent Todo` task for this `agent_code`.
7. Re-read the task after claim or resume.
8. Do only the scoped work in the task packet.
9. Post one receipt.
10. Update the ledger.
11. Stop after one task.

No second claim in the same heartbeat. No "while I am here" follow-up work. If the completed task reveals more work, write an `AGENT FOLLOW-UP` receipt or ask the parent session to create a child task.

## Queue Selection

Check in this order:

1. `Agent Needs Input` assigned to or claimed by the runtime.
2. `Agent Review` assigned to or claimed by the runtime.
3. `Agent Todo` assigned to the runtime, oldest first.
4. Unassigned `Agent Todo`, oldest first, only if the task is low or medium risk and clearly eligible for this runtime.

Human-hold and blocked work comes before new claims because it is already in flight and may be waiting on the current runtime. Resume only when the task packet or latest event contains enough information to proceed without guessing.

## Refusal Gates

Do not claim or resume a task when any of these are true:

- The task is high risk and does not show explicit approval.
- The desired outcome, do steps, boundaries, or acceptance criteria are ambiguous.
- The work would require deletes, credential changes, billing or spend changes, client-facing messages, Slack sends, deploys, WordPress changes, or production data edits not explicitly approved in the task.
- Required tools, repository context, secrets, or source files are unavailable.
- The task asks a worker or subagent to update `PROJECT-TRACKER.md`, `SESSION-LOG.md`, commit, push, or capture the project closeout.
- The task would require claiming a second task in the same heartbeat.

When a refusal gate triggers on a claimed task, use `block_agent_task` with a specific blocker. When it triggers before claim, leave the task unclaimed and report the reason to the parent session.

## Receipts

Use exactly one task receipt for the heartbeat result:

- `AGENT STATUS` for a progress heartbeat while still working.
- `AGENT DONE` through `complete_agent_task` or `request_agent_review` when the scoped task is ready for review. This moves the task to `Agent Review`, not final done.
- `AGENT BLOCKED` through `block_agent_task` when work cannot safely continue.
- `AGENT FOLLOW-UP` only when recording a follow-up is the scoped output and the tool path supports it.

Receipt notes must include:

- What was done.
- Verification evidence.
- Files or records touched.
- Remaining blocker or review request, if any.

Keep receipts factual. Do not claim tracker, session-log, commit, push, or project capture work was done by a worker if the parent session still needs to do it.

## Ledger Update

After the one task receipt, update the runtime ledger with `write_agent_ledger`.

Set:

- `last_queue_result`: one compact summary of the heartbeat result.
- `local_context`: repository path and relevant branch or task ID.
- `automation_state`: keep `manual-required` unless the runtime itself is blocked or paused.
- `notes`: next manual checkpoint, if useful.

The ledger row must update in place. Never delete ledger rows. Never create a duplicate `agent_code`.

## Parent Session Boundaries

The parent session owns:

- Decisions and risk calls.
- File edits unless the task explicitly delegates them.
- `PROJECT-TRACKER.md` updates.
- `SESSION-LOG.md` updates.
- Project closeout capture.
- Git commits and pushes.
- Public/private classification and port decisions.

Worker subagents may do independent read-only audits or scoped task work when a task grants that authority. Their output is a receipt, not canonical project state.

## Required Smoke Tests

Before treating the manual Queue Runner pilot as complete, the parent session must create new harmless test tasks and verify all three:

- Hello-world task: claimed once, scoped result posted once, ledger updated in place.
- Blocked-resume task: blocked or human-hold work is checked before new claim, then one ready blocked task is resumed or deliberately blocked with a clear reason.
- Human-hold task: human-hold work is prioritized before new claims and does not silently turn into ordinary `Agent Todo` work.

DB evidence must confirm:

- Status transitions match the receipt.
- Exactly one event row exists per successful receipt.
- `agent_task_ledger` still has one row per `agent_code`.
- Prior smoke evidence rows were not deleted or altered unexpectedly.

## Stop Conditions

Stop immediately after one task receipt and one ledger update. Report the task ID, receipt, verification, and next manual action to the parent session.
