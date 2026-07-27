---
name: open-engine-reconciler
description: Use when running one board-hygiene reconciliation heartbeat as reconciler - the scheduled early-morning pass (or a manual "run the reconciler") that probes real-world state against Needs Operator cards carrying a packet-authored close_check and auto-closes only the ones whose probe returns an exact match. Close-only by construction: it has no path that reopens, re-flags, re-prioritizes, or otherwise mutates a card, and no path that touches any status other than Needs Operator. Skip for authoring close_check values (that is the operator's call via admin_amend_agent_task) and for any other board mutation.
---

# Open Engine Reconciler

One heartbeat that stops work the operator already finished from re-surfacing forever.

The problem it solves: the operator publishes a page, claims a listing, or drops a file,
and no lane learns about it. The card stays on the desk and renders in every
briefing as "needs you" until a human notices. This lane checks the world against
the card and retires the ones that are demonstrably done.

Spec: `docs/superpowers/specs/2026-07-22-board-hygiene-reconciliation-design.md`.
Plan: `docs/superpowers/plans/2026-07-22-board-hygiene-reconciliation.md`.

Tool names below are bare; the MCP server prefix varies by runtime
(`mcp__open-brain__*`, UUID-prefixed connector). Load tools through ToolSearch
when deferred.

## The asymmetry rule

**A probe may only ever auto-close. It may never auto-reopen, auto-escalate,
auto-flag, or change a card in any other way.**

A green probe closes the card. A red probe, an ambiguous probe, a network error,
a timeout, a moved page, a page whose markup the fetch cannot see: every one of
those is a no-op. The card stays on the desk exactly as it does today.

This is what makes false negatives free and confines the entire risk surface to
one failure mode: a false positive that retires a step the operator still owes. It is the
first thing implemented and the last thing anyone is allowed to relax.

## Hard rules

- Identity: `reconciler`. Fail closed if the ledger row is missing.
- The ONLY board write in a run is `complete_operator_action`, and only on a card
  whose probe returned `match:true`. Nothing else. No claim, no promote, no
  answer, no unblock, no resolve, no archive, no apply, no fail, no create, no
  `admin_amend`, no `update_agent_task`, no raw SQL.
- Never author or edit a `close_check`. Authorship is the operator's, through
  `admin_amend_agent_task`. This lane only reads it.
- Never perform the operator step itself. It observes; it does not act on the
  world.
- Never write to a project file, a plan doc, or a tracker. Doc-tag flips stay
  with the closeout controller.
- Never touch `Agent Todo`, `Agent Working`, `Agent Review`, `Agent Needs Input`,
  or `Standing`. `Needs Operator` only.
- One honest exit. If a required read fails, say so in the ledger line with the
  missing surface named. Never paper over partial data.
- Operator-facing voice: no em dashes, no banned words, natural prose.

## Operator setup, required before the first unattended run

This lane stalls on its very first command without these, and the failure looks
like a hang rather than an error. None of it travels with a clone.

**1. Permission allowlist.** The scheduled runner needs three entries in the
project's `.claude/settings.json` under `permissions.allow`:

```
"mcp__open-brain__complete_operator_action"
"Bash(bash scripts/open-engine/reconcile-run.sh:*)"
"Bash(git rev-parse:*)"
```

`git rev-parse` is the one most likely to be missed: it is step 1 of the
preflight, inherited from the house pattern rather than added by this lane, so
an audit that checks "did I allowlist what this build added" misses it.
Enumerate the commands the run actually emits, top to bottom, not the diff.
Clicking "allow for this session" is session-scoped and NEVER persists to a
scheduled run; the settings file is the only durable grant.

**2. Ledger row.** The lane fails closed without one, and `agent_task_events`
has a foreign key onto it:

```sql
insert into public.agent_task_ledger (agent_code, operator, runtime, automation, automation_state)
values ('reconciler', '<your name>', '<runtime>', 'scheduled', 'active');
```

**3. Probe credentials, only for the probes you actually use.**
- `git_path_exists` / `git_commit_contains` need the `gh` CLI authenticated with
  `repo` scope. No token is stored by this build and there is nothing to rotate.
- `http_contains` needs nothing.
- `wp_post_status` needs `OE_WP_SITE_BASE_URLS` plus one application password per
  site. See the header of `scripts/open-engine/reconcile-run.sh`. A missing one
  fails closed and the card just stays on the desk.

**4. Arm it with ZERO eligible cards first.** Schedule the lane while no card
carries a `close_check`. Every run is then a provable no-op that still exercises
the unattended path, the permission grants, the ledger write and the digest line,
before any real card is at stake. That evidence is unobtainable once cards are
eligible, which is why arming comes first.

## TOOL DISCIPLINE, unattended-safe

The harness shape gate runs BEFORE `permissions.allow`, so no allowlist entry can
rescue a compound command. A scheduled run that emits one hangs on a prompt
nobody is there to click (the 2026-07-13 stall class), and session approvals
never persist to scheduled runs.

- One flat command per Bash call. Never `cd`, `&&`, `;`, `|`, `$( )`, backticks,
  redirection, or loops.
- The only Bash command this lane runs is:
  `bash scripts/open-engine/reconcile-run.sh --task-id <uuid>`
- Do not post-process its output with `python3 -c` or `jq`. It prints one JSON
  line. Read it directly.
- Run from the MAIN checkout, by absolute path. Confirm with
  `git rev-parse --git-dir` before anything else.

## CLOCK

Omit `last_successful_run` when writing the ledger and let the server stamp it.
This is the opposite of the older lane instructions, deliberately: `ddc28e6`
server-stamps the field when the caller omits it, and a model has no clock, so a
self-reported value is a guess that has run hours into the lane's own future. Use
`date -u +%Y-%m-%dT%H:%M:%SZ` only for prose in the run log, where no server
stamp exists.

## The run

### 1. Preflight

- `git rev-parse --git-dir` confirms the main checkout.
- `read_agent_ledger(agent_code: "reconciler")` confirms the identity row.
  If it is missing, stop and report. An event author with no ledger row fails the
  foreign key.

### 2. List the desk

`list_agent_tasks(statuses: ["Needs Operator"], limit: 50, view: "compact")`.

**Pass `view: "compact"`.** It is not optional and not a preference. The full
projection carries every card's `review_reason`, which holds the AGENT DONE
receipt, and the desk outgrew the MCP response cap: the 2026-07-27 run measured
296,561 characters across 26 rows, and recovering the ids took five chunked
reads of the saved tool-result file, one of which blew the per-read cap too.
`view: "compact"` drops the long prose and keeps ids, routing, `operator_action`,
`check_spec` and `close_check`, which is the entire set this lane reads. Same 26
rows, 39,896 characters (measured 2026-07-27 after deploy). If you ever need a
whole packet, call `get_agent_task` on that one id.

The server caps this at 50 rows ordered `updated_at DESC`. Judge coverage by the
oldest row's date, never by the row count. If the desk is at the cap, say so in
the ledger line rather than implying the whole desk was scanned.

### 3. Probe each card

For every card on the desk, run exactly one flat command:

```
bash scripts/open-engine/reconcile-run.sh --task-id <uuid>
```

**Do not pre-filter the list yourself.** Every eligibility gate lives inside the
runner, where it is auditable and unit tested, and the runner reports which gate
it hit in a `skipped` field. The gates are:

1. status is not `Needs Operator`
2. the card carries no `close_check` (not opted in)
3. the card carries a `plan-doc:` source (fork R2 (a): the closeout controller
   owns plan docs, and this lane never writes one)

A skipped card is a silent no-op. It is not an error and does not need reporting
beyond the run tally.

**An auto-promoted card is NOT skipped** (deliberate). There
was a fourth gate here that skipped any card bearing a `triage-auto` event.
It was removed because it asked the wrong question.

The risk this design guards against is a badly written assertion, one that is
trivially true or becomes true for an unrelated reason, silently retiring a step
the operator still owes. So what matters is whether a HUMAN READ AND AGREED TO THE NOTE,
not whether a human moved the card. Triage cannot author a `close_check` at all
(the intake validator refuses one on `intake_source='triage-agent'`, which is
exactly and only what auto-promote requires), and the sole remaining authoring
path is `admin_amend_agent_task`, which is human and ops use only and absent from
every executor allowlist. So a `close_check` on an auto-promoted card is PROOF a
human authored it. The old gate skipped precisely those cards.

Measured cost before removal: 6 of 7 machine-checkable candidates on the live
desk, because Phase 4 auto-promotes most website work. A guard meant to let the
lane earn trust safely was suppressing nearly all the evidence it would earn it
from.

Do not restore it on the reasoning that the critic lane is a backstop. It is not:
the critic reviews the agent's deliverable BEFORE the operator step exists, so it
never sees whether the real-world step happened, and its verdict is advisory and
moves no status.

### 4. Close only on an exact match

When and only when the runner prints `"match": true`:

```
complete_operator_action(
  task_id: <uuid>,
  completed_by: "reconciler",
  note: "<probe> asserted <assert>; measured <measured>; measured_by <measured_by>; desk entry <desk_entered_at>"
)
```

`completed_by` names the lane, never the operator. An `OPERATOR DONE` from this lane
means "evidence was observed," not "a human reported it," and the note is what
makes that claim auditable. The server refuses the call if the card has no
`close_check` or the note is empty, so a malformed close cannot land.

On anything other than `match:true`, do nothing at all. Do not re-flag, do not
comment, do not re-prioritize, do not create a follow-up.

### 5. Ledger heartbeat, which is also the run log

One `write_agent_ledger` for `reconciler`, omitting `last_successful_run`:

```
OE-RECONCILE <n> closed (<shortids>); <m> probed no match; <k> skipped; <e> errors
```

Add `; desk at cap, oldest row <date>` when the list hit 50 rows.

**Do not try to write `agent_run_log` separately. There is no verb for it and you do not need one.** `agent_task_ledger` carries `AFTER INSERT OR UPDATE` triggers (`agent_task_ledger_log_run_insert` / `_log_run_update`, firing `log_agent_run()` whenever `last_heartbeat` changes) that insert the `agent_run_log` row for you, copying `runtime`, `queue_result`, and `automation_state` off the ledger. Verified live 2026-07-25: one `write_agent_ledger` produced exactly one run-log row, `ran_at` and `succeeded_at` both matching the server-stamped heartbeat.

An earlier draft of this skill listed the run log as its own step. That was wrong in the way that matters for an unattended lane: hunting for a verb that does not exist ends either in a stall or in reaching for raw SQL, which this lane's stop lines forbid.

## Reporting

Two surfaces, both required, because a silent auto-close is strictly worse than a
re-surfacing card. A re-surfacing card at least tells the truth about being open.

- **Digest**, beside `*Ops sentinel:*`:
  `*Reconciled:* 2 desk cards auto-closed (a1b2c3d4, e5f6a7b8); 3 probed, no match.`
- **Briefing**, a "Closed without you" section covering the last 7 days, id first,
  with the recap and the evidence. A 7-day window rather than one morning, so
  the operator has a standing chance to dispute rather than a single one.

## Undo

`admin_amend_agent_task(task_id, reason, move_to_needs_operator: true)` returns a
wrongly closed card to the desk with an honest event. No new code, no raw SQL.

To disarm a bad probe without touching the lane:
`admin_amend_agent_task(task_id, reason, clear_close_check: true)`. The card
returns to the human-read desk and is never probed again until the operator authors a new
check.

To stop the lane entirely: disable the cron. Nothing else changes, and every card
it closed stays reversible.

## The watch

7 days of visible reporting with zero disputed closes.

**A single disputed close is a stop-the-lane event.** Disable the cron, diagnose
whether the fault was probe quality (a bad assertion) or lane behavior (a bug in
the asymmetry rule or the since-desk clause), fix it, and re-enable only on
the operator's go. Same posture as the executed check's first false pass, because the
failure mode is identical in kind: a machine retired work on evidence that did
not mean what it appeared to mean.

## What this lane will never be able to do

Recorded as limits, not as a backlog.

- A probe proves its assertion and nothing beyond it. A published page proves a
  page is published, not that it is correct, complete, or the thing the operator meant.
- The judgment-call cards ("make the go-to-market call") can never carry a
  `close_check` and will never be machine-checkable.
- The install-shape cards, where `operator_target` points at a file the executor
  itself wrote, are the single largest trap on this desk. The runner refuses any
  `git_path_exists` path under `deliverables/` for exactly this reason: the
  executor lanes push there, so a lane's own commit would satisfy a "new file
  since" assertion and close a card the operator never touched.
- Third-party-gated cards get no `close_check` at all where the card's own text
  conditions completion on an outside actor. A live profile page proves the
  profile exists, not that the confirmation the operator is waiting on arrived.
- Out-of-band work that was never carded at all is invisible to this lane. That
  is the intake side of the same problem and needs its own design.
