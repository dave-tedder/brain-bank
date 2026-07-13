---
name: open-engine-triage
description: Use when running one OE-12 triage heartbeat as the triage lane - the scheduled morning pass (or a manual "run triage") that reads open action items via list_open_action_items and creates full-packet Standing drafts on the Open Engine board. Draft-safe only; it never promotes (until the stage-4 gate ships), never resolves action items, never edits files, never runs git. Skip for manual single-item intake (use create_agent_task_from_action_item directly) and for queue-runner work.
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
  (this rule is the binding control - the promotion guard only refuses
  `promoted_by` strings that match registered agent codes; it cannot see
  who is calling, so do not treat it as a safety net); grant
  explicit_approval; assign agent_code at draft time; edit files; run git;
  send anything (Slack, email, posts).
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
   - boundaries always include: "Exit through one honest receipt. No sends,
     no canonical-file edits, no git."
5. **Report.** `write_agent_ledger` for `triage`:
   `last_queue_result` = "drafted N / needs-operator N / skipped N / capped N",
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
