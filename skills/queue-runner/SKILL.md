---
name: queue-runner
description: Use when manually running one Open Engine Queue Runner heartbeat from the agent task board, especially when claiming, resuming, blocking, completing, or writing ledger receipts for `codex` tasks through the Brain Bank MCP task tools. Keeps the run manual, one-task-only, and parent-session-owned.
type: skill
---

# Queue Runner

Run one manual Open Engine heartbeat for one runtime, then stop. This skill is for `codex` first. Add another runtime only after `codex` has passed the smoke tests and the build plan says to expand.

This skill does not create cron jobs, scheduled runners, background loops, Slack sends, credential changes, billing changes, deletes, deploys, client-facing messages, WordPress changes, or autonomous execution.

This skill is behavioral guidance for the agent running the heartbeat. It is not an enforcement boundary by itself. Real enforcement must stay in the SQL helpers, MCP task tools, and runtime tests so a scheduled or misbehaving runtime cannot bypass risk and transition guards by ignoring prose.

## STEP 0 — MCP PREFLIGHT (MANDATORY, BEFORE ANYTHING ELSE)

Run this before reading the board, the packet, or any deliverable. It is a
procedure, not advice. Do not skip it because the tools "look fine".

1. List every MCP this run may need. Always the Brain Bank board tools. Plus any
   the task names: WordPress servers, Notion, or any other integration.
2. ToolSearch each one, then make a CHEAP LIVE CALL to confirm it answers:
   `mcp__<server>__mcp_ping` for the WordPress servers; any read verb for others.
3. If ToolSearch returns "No matching deferred tools found", that is **NOT**
   evidence of absence. Desktop-configured MCP servers connect ASYNCHRONOUSLY and
   routinely surface minutes into a session with no action taken. Wait, then
   re-run ToolSearch. **Retry up to 3 times.**
4. Only a LIVE CALL that still fails after 3 retries may be reported as
   unavailable. Report it; do not fix it.

Because the pings are cheap and the connect window is short, fire them first and
then read the packet. By the time you need a tool it is warm, and the
false-negative window never opens.

### Forbidden while diagnosing a "missing" MCP

- Do NOT run `claude mcp list`. It lists ONLY Code-registered servers and never
  lists Desktop servers. Its output is not evidence of anything.
- Do NOT read `~/.claude.json`, `claude_desktop_config.json`, or check for a
  project `.mcp.json`. Those describe **registration**. Registration is not
  **reachability**. A Desktop server is genuinely reachable from a Code session.
- Do NOT run `claude mcp add` or `claude mcp remove`. The servers are already
  live; you would duplicate working servers. A PreToolUse hook can block this
  (see `scripts/hooks/block-mcp-registration.sh`).
- Do NOT build a causal story about WHY the MCP is missing. If you catch yourself
  explaining why, that IS the tell. Stop and re-run ToolSearch.

**The rule is about the KIND of evidence, not the specific command.** No static
artifact (CLI listing, JSON config, worktree state, missing `.mcp.json`) can prove
an MCP is unavailable. Only a live call can, and only after the retries above.

This exists because the misdiagnosis recurred in two separate sessions on the
same day **while a memory note describing it was in context**, each time
reasoning confidently from a different artifact. Treat any "the MCP isn't here"
conclusion as a red flag about your own reasoning first.

## STEP 0.6 — PRIOR-ART RECALL (MANDATORY BEFORE ANY DIAGNOSIS)

Before forming ANY theory about a symptom, block, failure, or "X is
broken/blocked/missing" claim (from a packet, a probe you just ran, or your own
observation):

1. `search_thoughts` the symptom in Brain Bank. Query with the concrete nouns:
   the domain, the tool, the error ("crawler 403 CDN <domain>", not "website
   problem"). Limit 5.
2. If a prior capture DIAGNOSES, CORRECTS, or WITHDRAWS the same finding, that
   capture outranks your fresh reasoning. Follow its method. A withdrawal
   reverses the burden of proof: you need NEW evidence of a kind the withdrawal
   did not already discredit before re-raising the alarm.
3. The recall applies to the PACKET'S premise too. A packet can encode a false
   alarm and send several sessions chasing it across weeks.
4. Only after the search comes up empty may you investigate from scratch.

This exists because a bot-blocking false alarm was diagnosed and formally
withdrawn in the brain, then re-derived from scratch twice afterward, with the
withdrawal sitting in the brain the whole time. Confidence in a freshly built
causal story is the tell, exactly as in STEP 0.

## Runtime Identity

Default runtime:

- `agent_code`: `codex`
- `operator`: operator
- `automation_state`: `manual-required`

If the user explicitly assigns a different runtime, use that `agent_code` only after the ledger confirms it exists. Never invent a new ledger identity during a heartbeat.

Task drafts are born UNASSIGNED (`agent_code = NULL`) so any local executor can claim them (OE-9 shared-pool decision). Never stamp an `agent_code` on a draft by default; a hard `agent_code` is a capability or quality lock only. Routing preferences use `preferred_agent`, which reorders claims but never restricts them.

**C2 hard runtime constraint.** A task flagged `requires_local = true` (LOCAL RUNTIME ONLY: needs git + local files) is claimable ONLY by a claim that asserts `runtime_local: true` on `claim_next_agent_task` / `claim_specific_agent_task`. A scheduled/cloud heartbeat MUST NOT pass `runtime_local` — omit it (defaults false), so local-only tasks are invisible to the heartbeat by design and can never be mis-claimed. Only an attended local session working a specific known-local task passes `runtime_local: true`. This is distinct from `preferred_agent`: `requires_local` is a HARD filter, `preferred_agent` only reorders. Ops corrections that need to set `requires_local`, `project_slug`, `sources`, or operator fields, move a terminal task to Needs Operator, or release a stuck claim use `admin_amend_agent_task` (human/ops only — never from a heartbeat).

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
8. Re-read the task after claim or resume, and record the `claim_token` from the claim/resume response. Every later receipt on this task (`update`, `complete`, `block`, `request-review`, `hold`, `fail`) must pass that exact token; the board rejects receipts from a run that does not hold the current claim, even under the same `agent_code`.
   **PASS the token as a tool argument. NEVER write it into receipt text.** The token is a per-run secret: it is the one thing proving you are the run holding this claim, and it is deliberately kept off every read surface (never returned by list/get reads, never in event payloads). A receipt is a published surface — its text lands in `agent_task_events.payload` and `agent_tasks.review_reason`, both readable by anything with board access — so echoing the token there hands the proof-of-holding to every other run and undoes the guard for that task. Seen in practice: a scheduled executor run wrote `used claim_token <uuid> for this receipt` into its Verification section, and the token was still live on that Agent Review row afterward. The run was not misbehaving; the contract said "record the token" and "pass that exact token", which describe a tool ARGUMENT, and nothing said not to print it — so a run being thorough about its Verification section would do exactly this. Say *that* you used the token, never its value. Same rule as any credential: naming it is fine, printing it is not.
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
- `AGENT HUMAN HOLD` through `hold_agent_task` when the packet validates but this heartbeat has no executor for the work (say WHICH runner: "the scheduled queue-runner Edge Function performs claim-and-hold only". Local executor lanes DO execute; never write a receipt sentence that reads as a claim about the whole scheduled grid). The task moves to `Agent Needs Input` for a human or local runtime.
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

OPERATOR STEP MARKER: when accepting the work leaves the operator a step outside the system (claim a listing and paste, make a call, confirm a fact) — OR leaves a file you staged that a human must still install — add this line inside "Follow-up recommendation:":

```text
OPERATOR-ACTION: <one-line step> || OPERATOR-TARGET: <url-or-path>
```

(OPERATOR-TARGET and the `||` are optional.) **The marker must stand alone on its own line.** The controller only reads a marker at the START of a line, so a marker tacked onto the end of a prose sentence is invisible to it and the operator step is silently lost on apply. Write the prose, end the line, then put the marker on a line by itself.

**Mandatory whenever the run stages a deliverable:** if the run wrote any file under `deliverables/` (see DELIVERABLES-TO-FILE), the task is NOT terminal — the staged file does nothing until a human installs it. Emit exactly:

```text
OPERATOR-ACTION: install <the deliverables/ path written> || OPERATOR-TARGET: <absolute path or URL the file must be installed to>
```

Stamp the install target at completion time; the run already knows it (it is the file the packet asked to modify, or the page/post/repo the draft is for). If the target is genuinely unknowable, name what is known in the target slot rather than dropping the marker.

The closeout-controller reads the marker verbatim to route the task to the Needs Operator desk. It HOLDS any receipt that names a `deliverables/` file but carries no marker (`DELIVERABLE_WITHOUT_OPERATOR_ACTION`), and any receipt whose marker is mid-line (`OPERATOR_MARKER_NOT_LINE_ANCHORED`) — held and visible, never applied-and-lost. No deliverable and no operator step => terminal task, closes to Agent Done. The marker is valid ONLY inside "Follow-up recommendation:" — a marker in any other section holds the task (`OPERATOR_MARKER_OUTSIDE_FOLLOW_UP`) instead of closing it, so the step is never silently lost.

VOICE RULES for any drafted client-facing or operator-voice content inside a task
(blog drafts, emails, titles/metas): no em dashes; never use the words
"inked", "inking", "tapestry", "delve", "delving", "realm", metaphorical
"landscape", "leverage" as a verb, "synergy", "holistic", "robust";
craft-first tone, no hype.

## Scheduled Path: Claim-and-Hold

The scheduled `queue-runner` Edge Function follows this same heartbeat with one hard difference: the queue-runner Edge Function itself has no executor, so it never writes `AGENT DONE`. Its claim-and-hold contract is: claim through the guarded MCP path, validate the packet, then post `AGENT HUMAN HOLD` with an honest 8-section hold receipt draft. Post-claim failures write `AGENT FAILED` on the claimed task instead of stranding it in `Agent Working`. The scheduled path reports held/blocked work in its summary; it never resumes held work itself. Hold receipts must name the queue-runner specifically and state the packet-specific reason for the hold (e.g. "this intake draft's acceptance criteria require human review"). A receipt phrase like "the scheduled path has no executor" reads as a global capability claim and has already misled an attended session into reporting that scheduled lanes cannot execute content work at all.

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
