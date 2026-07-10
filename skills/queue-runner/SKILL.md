---
name: queue-runner
description: Use when manually running one Open Engine Queue Runner heartbeat from the agent task board, especially when claiming, resuming, blocking, completing, or writing ledger receipts for `codex` tasks through the Brain Bank MCP task tools. Keeps the run manual, one-task-only, and parent-session-owned.
type: skill
---

# Queue Runner

Run one manual Open Engine heartbeat for one runtime, then stop. This skill is for `codex` first. Add another runtime only after `codex` has passed the smoke tests and the build plan says to expand.

This skill does not create cron jobs, scheduled runners, background loops, Slack sends, credential changes, billing changes, deletes, deploys, client-facing messages, WordPress changes, or autonomous execution.

This skill is behavioral guidance for the agent running the heartbeat. It is not an enforcement boundary by itself. Real enforcement must stay in the SQL helpers, MCP task tools, and runtime tests so a scheduled or misbehaving runtime cannot bypass risk and transition guards by ignoring prose.

## Runtime Identity

Default runtime:

- `agent_code`: `codex`
- `operator`: operator
- `automation_state`: `manual-required`

If the user explicitly assigns a different runtime, use that `agent_code` only after the ledger confirms it exists. Never invent a new ledger identity during a heartbeat.

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
4. Release expired claims with `release_expired_agent_claims` and note the reaped count.
5. Check human-hold and blocked tasks before new work.
6. Resume exactly one ready hold or block if possible.
7. Otherwise claim the oldest eligible `Agent Todo` task for this `agent_code`.
8. Re-read the task after claim or resume.
9. Do only the scoped work in the task packet.
10. Post one receipt.
11. Update the ledger.
12. Stop after one task.

No second claim in the same heartbeat. No "while I am here" follow-up work. If the completed task reveals more work, write an `AGENT FOLLOW-UP` receipt or ask the parent session to create a child task.

## Queue Selection

Check in this order:

1. `Agent Needs Input` assigned to or claimed by the runtime.
2. `Agent Review` assigned to or claimed by the runtime.
3. `Agent Todo` assigned to the runtime, oldest first.
4. Unassigned `Agent Todo`, oldest first, only if the task is low or medium risk and clearly eligible for this runtime.

Human-hold and blocked work comes before new claims because it is already in flight and may be waiting on the current runtime. Resume only when the task packet or latest event contains enough information to proceed without guessing.

## Specific Claim From A Goal Prompt

When a briefing Goal Prompt names a task id, use `claim_specific_agent_task`
instead of the general queue claim. All normal gates still apply: one claim per
heartbeat, risk must be allowed for the runtime, the packet must be coherent,
and required tools/context must be available. If the named task fails a refusal
gate, do not claim another task "while here"; report the refusal and stop.

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
- `AGENT DONE` through `complete_agent_task` or `request_agent_review` only when the task packet's acceptance criteria are met and the scoped task is ready for review. This moves the task to `Agent Review`, not final done.
- `AGENT HUMAN HOLD` through `hold_agent_task` when the packet validates but this heartbeat has no executor for the work. The task moves to `Agent Needs Input` for a human or local runtime.
- `AGENT BLOCKED` through `block_agent_task` when work cannot safely continue.
- `AGENT FAILED` through `fail_agent_task` when a post-claim step fails. The task returns to `Agent Todo` with `attempt_count` incremented and the claim cleared.
- `AGENT FOLLOW-UP` only when recording a follow-up is the scoped output and the tool path supports it.

If a required source, browser surface, credential, tool, file, approval, or verification surface is missing, use `block_agent_task` with the missing requirement. Honest partial work belongs in the blocker or handoff text, not in an `AGENT DONE` receipt.

For long-running work, post an `AGENT STATUS` heartbeat at least every 30
minutes before the claim TTL can reap the task. The status note must say what is
still running and the next checkpoint. If you cannot keep the claim alive, exit
through hold or block with the partial findings.

Receipt notes must include:

- What was done.
- Verification evidence.
- Files or records touched.
- Remaining blocker or review request, if any.

Every `AGENT DONE` receipt (and every hold receipt draft the scheduled runner posts) uses the canonical 8-section OE-8 contract, in this order:

```text
Work summary:
Verification:
Touched files or records:
Limitations:
Tracker draft:
Session-log draft:
Brain Bank capture draft:
Follow-up recommendation:
```

The OE-8 closeout controller consumes these headings; a receipt missing a section is held out of auto-closeout, not guessed at. Keep receipts factual. Do not claim tracker, session-log, commit, push, or project capture work was done by a worker if the parent session still needs to do it.

DELIVERABLES-TO-FILE (local runtime): when the task produces a client-facing standalone draft (a listing pack, a bio, a directory field-by-field, blog copy), write it to `deliverables/<project_slug>/<task-shortid>-<slug>.md` in the Brain Bank repo and record that exact path under "Touched files or records:". `deliverables/` is gitignored — the draft never ships to brain-bank. Do NOT use `deliverables/` for code/config changes to a project: those are a commit/diff in that project's own repo; record the repo + branch under "Touched files or records:" instead.

CLOUD-RUNTIME FALLBACK: a cloud session that cannot reach the operator's disk leaves the full draft inline in "Work summary" and records `Touched files or records: None written (cloud runtime — draft inline above)`. No task is ever unreviewable.

OPERATOR STEP MARKER: when accepting the work leaves the operator a personal outside-system step (claim a listing and paste, make a call, confirm a fact), add this line inside "Follow-up recommendation:":

```text
OPERATOR-ACTION: <one-line step> || OPERATOR-TARGET: <url-or-path>
```

(OPERATOR-TARGET and the `||` are optional.) The closeout-controller reads this verbatim to route the task to the Needs Operator desk. No marker => terminal task, closes to Agent Done. The marker is valid ONLY inside "Follow-up recommendation:" — a marker in any other section holds the task (`OPERATOR_MARKER_OUTSIDE_FOLLOW_UP`) instead of closing it, so the step is never silently lost.

VOICE RULES for any drafted client-facing or operator-voice content inside a task
(blog drafts, emails, titles/metas): no em dashes; never use the words
"inked", "inking", "tapestry", "delve", "delving", "realm", metaphorical
"landscape", "leverage" as a verb, "synergy", "holistic", "robust";
craft-first tone, no hype.

## Scheduled Path: Claim-and-Hold

The scheduled `queue-runner` Edge Function follows this same heartbeat with one hard difference: it has no executor, so it never writes `AGENT DONE`. Its claim-and-hold contract is: claim through the guarded MCP path, validate the packet, then post `AGENT HUMAN HOLD` with an honest 8-section hold receipt draft. Post-claim failures write `AGENT FAILED` on the claimed task instead of stranding it in `Agent Working`. The scheduled path reports held/blocked work in its summary; it never resumes held work itself.

## Ledger Update

After the one task receipt, update the runtime ledger with `write_agent_ledger`.

Set:

- `last_queue_result`: one compact summary of the heartbeat result.
- `last_successful_run`: current UTC datetime in `Z` form, never a `+00:00`
  offset.
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
- Brain Bank public/private classification and port decisions.

Worker subagents may do independent read-only audits or scoped task work when a task grants that authority. Their output is a receipt, not canonical project state.

A standalone fresh chat that manually claims a board task is the parent session for that task unless the task packet explicitly says `worker_only=true` in `sources` or `context`. Parent sessions are responsible for tracker/session-log/project-capture closeout when the task touches a project with those records. Scheduled runners and worker subagents leave review evidence and closeout drafts only.

## Required Smoke Tests

Before treating OE-4 as complete, the parent session must create new harmless test tasks and verify all three:

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
