---
name: open-engine-triage
description: Use when running one OE-12 triage heartbeat as the triage lane - the scheduled morning pass (or a manual "run triage") that reads open action items via list_open_action_items and creates full-packet Standing drafts on the Open Engine board. It then runs stage-4 guarded auto-promote: only drafts that pass the strict server-side allowlist (low-risk, action-item-linked, full-packet, non-local, non-live-surface) move to Agent Todo on their own, at most the daily cap. It never calls the human promote path, never resolves action items, never edits files, never runs git. Skip for manual single-item intake (use create_agent_task_from_action_item directly) and for queue-runner work.
---

# Open Engine Triage (OE-12)

One heartbeat: read open action items, classify, draft the board-eligible
ones as Standing, report. The briefing (OE-11) is the human surface for
everything this run produces.

Tool names below are bare; the MCP server prefix varies by runtime
(`mcp__brain-bank__*`, UUID-prefixed connector, etc.). Load via ToolSearch
if deferred.

## Hard rules

- Identity: `triage`. One run per invocation. Fail closed: any preflight
  or tool error ends the run with a final `NO_RECEIPT: triage preflight failed
  (<detail>)` message; if the ledger write is available, also write the failure
  there. Never improvise around a missing tool.
- NEVER: resolve or archive action items; call `promote_agent_task_intake`
  (the HUMAN promote path - this rule is the binding control, and it stays
  absolute; the promotion guard only refuses `promoted_by` strings that match
  registered agent codes; it cannot see who is calling, so do not treat it as
  a safety net); grant explicit_approval; assign agent_code at draft time;
  edit files; run git; send anything (Slack, email, posts). The ONE promotion
  triage may do is the stage-4 guarded `auto_promote_agent_task_intake` (step 6,
  server-gated) - a different, deliberately narrow tool. `promote_agent_task_intake`
  remains off-limits even when a draft looks obviously promotable.
- Draft cap 20 per run. Read bound 100 items. Beyond either cap, report the
  remainder in the ledger summary instead of processing it.
- Risk is fail-closed: anything not CLEARLY low per the rubric is medium.

## Procedure

1. **Preflight.** `read_agent_ledger`; the `triage` row must exist. Read
   the "Paused Projects" list from the operator's local instructions file
   (e.g. `CLAUDE.local.md`) if one exists and use that as the only
   paused-project source of truth for this run; if no list exists, treat no
   projects as paused.
2. **Read.** `list_open_action_items` (limit 100). Skip every item with
   `has_active_draft: true`.
3. **Classify each item** (rubric below) into: BOARD-ELIGIBLE, NEEDS-OPERATOR,
   SKIP. When useful, pull the source thought via `get_thought_by_id` for
   packet context.
4. **Draft** each BOARD-ELIGIBLE item via `create_agent_task_intake`:
   - full packet, all seven required fields written from the item + source
     thought: desired_outcome, context, sources (JSON array of source strings,
     never one prose string), do_steps,
     acceptance_criteria, output_handoff, boundaries;
   - `intake_source: "triage-agent"`, `linked_action_item_id` set,
     `requested_by: "triage"`, `risk` per rubric, `priority` your
     judgment, no `agent_code`, OMIT `title` (the intake builder generates
     `[agent instructions][unassigned][task] <outcome>` automatically;
     hand-built titles just risk drifting from the board format);
   - **`project_slug` — set it whenever the item clearly belongs to a project.**
     Action items carry no project field, so infer the slug from the item's
     subject and its source thought, the same way you already infer paused
     projects. The ONLY valid values are the route keys in your closeout
     registry (`scripts/open-engine/project-closeout-registry.json`; see
     `project-closeout-registry.example.json` for the shape). Read those keys
     and pick from them.
     If NOTHING clearly matches, LEAVE IT UNSET. Never invent a slug and never
     force a rough fit — a wrong slug appends a closeout receipt to the wrong
     project's tracker and session log, which is worse than leaving it null.
     WHY THIS MATTERS: a task with a null `project_slug` can never be applied.
     The closeout controller routes strictly by slug and holds anything it
     cannot resolve (`MISSING_PROJECT_SLUG` / `UNKNOWN_PROJECT_ROUTE`). A
     triage lane that sets no slug will produce tasks that get executed and
     reviewed and then pile up in Agent Review forever, finished but
     structurally unappliable, with nothing in the logs explaining why.
     Setting the slug here is what lets finished work land.
   - boundaries always include: "Exit through one honest receipt. No sends,
     no canonical-file edits, no git."
5. **Stage 4 — guarded auto-promote (auto-promote allowlist below).** AFTER all
   drafting this run, walk TWO sets: the drafts you created in THIS run, and
   your own earlier `triage-agent` Standing drafts created in the last 72 hours
   that are still Standing (you already have these from the step-2 board read; an
   already-promoted draft has left Standing and an archived one is excluded by
   the default board read, so neither reappears). Do this run's drafts first,
   then the carried-over set. For each,
   decide whether it clears every rubric-side condition (J category fit, K live-
   surface veto, L not-redoing-finished-work). For the ones that do, call
   `auto_promote_agent_task_intake(task_id, caller_agent_code: "triage",
   allowlist_category: <1-4>, rationale: "<one sentence>")`. The server enforces
   the row conditions (low risk, no explicit_approval, Standing, triage-agent,
   linked action item, full packet, `requires_local=false`) and the daily cap;
   you supply the category and a one-sentence reason. A refusal (any condition,
   or the cap) leaves that draft Standing - RECORD it in the summary, never
   retry it in-run, and never fall back to `promote_agent_task_intake`. The new
   drafts and the carried-over ones share the one daily cap. Skip this step only
   when there are neither new drafts nor carried-over `triage-agent` Standing
   drafts from the last 72 hours.
6. **Report.** `write_agent_ledger` for `triage`:
   `last_queue_result` = "drafted N / auto-promoted N / needs-operator N / skipped N / capped N",
   `last_successful_run` = now (pass it in the `Z` datetime form,
   e.g. `2026-07-08T03:33:39.995Z`; the `+00:00` offset form is rejected as
   an invalid datetime and fails the write), `notes` = one line per
   NEEDS-OPERATOR item (id + why); on a first-ever run that sweeps a large legacy
   backlog, group NEEDS-OPERATOR by category with representative ids instead
   (steady-state daily runs see a small delta and can list each). No Slack;
   the next briefing carries this to the operator.

## Classification rubric

**Risk tier** (from the build plan, verbatim): LOW = read-only research,
drafts, documentation updates, tracker/session-log planning, local-only code
inspection, non-live design plans. MEDIUM = code edits with tests, dashboard
UI, new MCP tools, unapplied migrations, schema design. HIGH = live Supabase
writes, deploys, deletes/archives, credentials, billing, client-facing
posts/emails/Slack/WordPress, anything changing active client or business
data. Not clearly low means medium. Mentioning a live surface in the outcome
means at least medium.

**Agent-executable test:** could an OE-9 executor finish this with MCP/web
tools only, with no context that lives only in the operator's head, no
credentials, no outward-facing sends? Unsure means NO.

**Buckets:**
- BOARD-ELIGIBLE: actionable, agent-executable, a full honest packet can be
  written from the item + its source thought.
- NEEDS-OPERATOR: real work but fails the agent-executable test (needs the
  operator's judgment, hands, relationships, or approvals).
- SKIP: stale, duplicate, vague beyond repair, already done, or tied to a
  PAUSED project. Report only; resolving action items is the auto-resolve
  pipeline's and the operator's job, not yours.

**Paused projects.** Honor the operator's "Paused Projects" list when one
exists. Any item whose subject clearly belongs to a paused project goes
straight to SKIP (paused), never BOARD-ELIGIBLE, even if it would otherwise
be a clean draftable packet. Match by subject, named people/orgs,
venue/vendor terms, thread titles, and source-thought context, not a project
field (action items carry no project_slug). Group each paused project under
one `skipped (paused: <pause-tag>)` line in the ledger note rather than
listing each item.

**Duplicate action items.** Two action items can describe the same real task
from different source captures (e.g. two daily digests a week apart both
raising the same research request). `has_active_draft` is per-item, so a
second draft still slips through and an executor burns a rep on redundant
work. Before drafting, scan the current BOARD-ELIGIBLE set AND
recently-applied work for a semantic twin; if one exists, SKIP the duplicate
and name it in the ledger note instead of drafting.

**Doc-seeded duplicates.** Some board tasks are planned work seeded straight
from a project plan doc, not from an action item: their `sources` carry a
`plan-doc: <path>` entry and their doc line is tagged `[OE:<shortid> …]` (the
two-path provenance model — captured work links an action item; planned work
carries one `plan-doc:` source). That path sets no `linked_action_item_id`, so
`has_active_draft` never fires for it and an open action item describing the
same planned work slips through. Extend the semantic-twin scan to the board's
doc-seeded tasks: if an item duplicates a Standing/active task carrying a
`plan-doc:` source (or a plan-doc line you can see is already `OE:`-tagged
carded or done, not archived), SKIP it as a duplicate and name the short-id in
the ledger note. An `archived` tag is deliberately re-cardable, so it does not
suppress.

## Auto-promote allowlist (stage 4)

Default launch config: **all four categories, cap 5 per UTC day** (tune via the
`oe_auto_promote_config` row). Auto-promote removes the operator's *promote*
click, not their *install* click - every auto-promoted task still exits through
a staged deliverable that routes to Needs Operator (operator-install
enforcement), so nothing an auto-promoted task does reaches a live surface
without the operator installing it.

The SQL fails closed on the row/cap conditions; your job is the three judgments
SQL cannot make. Promote a same-run draft ONLY when all three hold:

- **J — it fits exactly one category, name it:** (1) read-only research/lookup
  that produces a *report*; (2) content/email/copy *draft* that is created and
  never sent; (3) local documentation *draft* (no canonical tracker/session-log
  edits, no git); (4) read-only verification/audit that produces a *report*.
- **K — the absolute veto:** never auto-promote anything that, in its own
  desired outcome, touches WordPress or any live site, sends email/Slack/social,
  writes client or business records, deploys, migrates, spends, deletes, or
  reaches any live surface. If in doubt, it fails K.
- **L — not redoing finished work:** never auto-promote an SEO or content-
  metadata task aimed at an existing live page ("redo already-done work" / the
  stale-open-action-item trap). No column can see this; it is your call. Such
  drafts stay Standing for a human promote. "I recently did this" is a valid
  reason to hold, never a reason the server can check.

Anything that does not clearly clear J+K+L stays Standing - leave it for the
operator. When unsure, do NOT auto-promote; a missed auto-promotion costs one
click, a wrong one costs a watch veto and a reset. The 7-day watch reads every
auto-promotion in the briefing; a single item the operator would have vetoed
resets it.
