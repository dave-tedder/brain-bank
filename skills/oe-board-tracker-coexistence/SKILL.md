---
name: oe-board-tracker-coexistence
description: Use when a piece of work exists both in a project tracker or plan doc AND on the Open Engine board — carding a tracker line onto the board, writing or reading an `[OE:<shortid> …]` doc tag, deciding whether a board task needs `linked_action_item_id` or a `plan-doc:` source entry, or answering "why does the tracker say open when the board says done". Also fires when tempted to list open board tasks inside a tracker. Skip for ordinary tracker and session-log work with no board involvement.
type: skill
---

# Open Engine board and project trackers, coexisting

Some projects run work through both a project tracker and the cross-project Open Engine board (`agent_tasks`). To keep them from becoming two sources of truth, one piece of work has exactly one status owner at every stage: the plan doc or tracker owns planned work until it is carded to the board, the board owns live status from carding through apply, and the doc or tracker is the durable record again after closeout.

## The `[OE:<shortid> …]` tag

When a plan-doc or tracker line is carded onto the board, annotate that line in the same session with a visible inline tag. Three states only:

- Carded: `- [ ] 6.15 Build the press-kit page [OE:6a98f7fd carded 2026-07-12]`
- Done: `- [x] 6.15 Build the press-kit page [OE:6a98f7fd done 2026-07-15]`
- Archived (draft killed unpromoted, line reads open again): `- [ ] … [OE:6a98f7fd archived 2026-07-15]`

It is an ownership pointer, not a status mirror. It never carries the board's live column (Standing / Working / Review), only carded, done, or archived. Mirroring live status into the doc is the drift machine this convention kills.

Visible rather than an HTML comment, so any session sees at a glance which lines already live on the board. Greppable by `OE:<shortid>` so closeout can flip it mechanically.

**Carding is atomic:** `create_agent_task_intake` with a `plan-doc: <path>` source entry AND the doc-line tag, in the same session. If you cannot do both, do neither.

At closeout apply, the closeout controller flips carded to done automatically for a task whose packet carries a `plan-doc:` source (checkbox `[ ]` to `[x]`, tag `carded` to `done`, every occurrence across plan doc plus co-located tracker), and HOLDs rather than applying if the tagged line is missing. No apply without doc sync. Archiving an unpromoted draft flips the tag to `archived`.

## Two-path provenance invariant

Every board task carries exactly one upstream pointer. Never zero, never both:

- **Captured work** (emails, digests, thoughts, no plan doc): `linked_action_item_id` set (action item → triage → Standing). `has_active_draft` is the duplicate guard.
- **Planned work** (a plan doc is the spec): a `plan-doc: <path>` source entry, seeded directly via `create_agent_task_intake`. No synthetic action item — routing planned work through `action_items` double-books and pollutes the digest's open-loose-ends view. The `OE:` doc tag is this path's duplicate guard.

## Trackers never list open board tasks

This extends the existing "don't transcribe the watch views into the tracker" rule. Each tracker carries one standing pointer line instead, added lazily as the tracker is next touched, not as a one-time sweep:

`Live agent work: Open Engine board, project_slug=<slug> (query the board or ask for a briefing; open board tasks are not mirrored here).`

For board-executed work, the closeout controller's tracker-draft append IS the project's session-log record. One write at one sync point. Executors never write project trackers or session logs live; they write to `deliverables/` only.

Attended project sessions are unchanged: tracker plus session log, per-task commits, verification before completion, memory captures. Tracker-driven multi-session program lanes are just Stage-1 work (planned, not yet carded); nothing here forces carding.

## Why this is its own skill

The rules above only matter when a piece of work lives in two places at once. Bundling them into a general tracker-and-session-log skill means they load on every project, including ones with no board, which is most of them. Keep the trigger narrow: it should fire when a doc line and a board card describe the same work, and stay quiet otherwise.
