---
name: open-engine-briefing
description: Use when the operator asks for a briefing, "what happened on the board", "what needs me", a session operating map, or invokes /open-engine-briefing. Reads the Open Engine board via MCP and renders a plain-language Session Operating Map - what happened since the last briefing, then what needs the operator. Read-only on the board. Skip for direct board mutations (claiming, promoting, applying); those use the queue-runner or OE-7 flows.
---

# Open Engine Briefing (OE-11)

Render a Session Operating Map from the Open Engine board. Two questions, in
order: what happened since the last briefing, then what needs the operator.
Assume the reader has ZERO context on the underlying work: every item is
explained in plain words (what it was, what the agent did, what is needed),
never in board vocabulary alone.

Tool names below are bare; the MCP server prefix varies by runtime
(`mcp__brain-bank__*`, UUID-prefixed connector, etc.). Load via ToolSearch
if deferred.

## Hard rules

- READ-ONLY while rendering the briefing. The only writes in the briefing run:
  one `write_agent_ledger` heartbeat for `briefing` at the END, and one
  `capture_thought` record. Zero task mutations, zero events. Any
  promote/answer/unblock/update the operator chooses happens after the render,
  through existing guarded tools, initiated by the operator.
- KEEP THE BOARD CURRENT when the operator settles items in the same chat.
  The briefing's own render is read-only, but the moment the operator settles
  something in the conversation (answers a held question, promotes or archives
  a draft, confirms a fact, makes a decision), reflect it on the board THAT
  SESSION via the guarded tools after the briefing render: `answer_agent_task`
  + `complete_agent_task` for confirmations; `promote_agent_task_intake` then
  `update_agent_task` to set `agent_code` so the executor can claim (the
  promote path does not assign one); `capture_thought` for a settled fact (it
  auto-resolves the linked action item); archive settled Standing drafts. The
  board should never lag what the operator already decided in chat.
- EVERY item the operator sees carries an explicit next action, including
  applied-and-filed ones. "Applied" means done on the board, NOT done for the
  operator: a research/draft task almost always leaves the operator a real next step
  (send the drafted email, make the flagged phone call, claim the listing,
  paste the copy, do the editorial pass). Mine each moved task's receipt
  Follow-up-recommendation / Limitations sections for that step and state it.
  Never present an applied item as "handled" when its receipt hands the
  operator work. Needs-Input items state the EXACT input required, in one line.
- LINK every actionable item to where the work lives so the operator can
  confirm without hunting. There is no per-task dashboard detail route, so
  link the status-filtered board view
  (`https://<your-dashboard-host>/tasks?status=<token>`, tokens: `standing`,
  `agent-todo`, `agent-working`, `agent-needs-input`, `agent-review`,
  `needs-operator`, `agent-done`) plus the task short-id to locate the card (its receipt shows
  inline). When the work product is external (a live listing, a site page) or
  a local file, link/point at THAT directly instead. In the Artifact, every
  card's id and its links are real anchors, not plain text.
- EMBED THE WORK, do not just point at it. When a waiting item's real
  deliverable lives inside the receipt (an AGENT DONE / AGENT APPLIED event
  whose "Touched files or records" says "None written"), quote the
  substantive draft inline in a fenced block so operator reviews it without
  opening the board - the listing pack, the directory bio, the review-site
  field-by-field. When a real file path or external URL exists (a
  `deliverables/` file, a live listing, a project commit/diff), link THAT
  instead of quoting. One source of the work per item: file/URL if it exists,
  inline excerpt otherwise. Never present an item as reviewable while hiding
  its content behind a board click.
- WORK-PRODUCT LINK PRECEDENCE, in order: (1) a real file - the receipt's
  "Touched files or records" names a deliverables/<project>/<id>-<slug>.md
  path: link it as a file path operator can open. (2) A code change - the receipt
  names a project repo + branch/commit: link that diff, verified in that
  repo, not quoted here. (3) No file - quote the substantive draft inline in
  a fenced block (the pre-Phase-3 receipts and cloud-fallback receipts). Never
  quote a code change; never leave a standalone draft unreviewable.
- CRITIC VERDICT (advisory, when present). An independent cross-runtime critic
  (Codex reviews Claude-executed work and vice versa) may leave an advisory
  verdict on an Agent Review or Needs Operator task, stored on `critic_verdict` /
  `critic_flags` (an AGENT CRITIC event backs it). Render it inline on the card:
  if `critic_verdict = 'flagged'`, LEAD the item with "Reviewer flagged: <the
  flags joined, compressed>" prominently - operator reads this first, before the
  rest of the line. If `'clean'`, tag "Reviewer: clean". If null (the critic has
  not reached the task), render no tag and say nothing about it. The verdict is
  advisory only in v1: it NEVER changes the item's status or which bucket it
  sits in, it only informs the eye. Within bucket A, a flagged medium/high
  Agent Review sorts above a clean or unreviewed one so flagged work surfaces
  first.
- THE NEEDS OPERATOR DESK IS ALWAYS SHOWN. Every task in the Needs Operator column
  renders under bucket B ("Your hands") on EVERY run, regardless of the
  watermark window, until operator closes it. Each card shows its stored
  operator_action as the one step and operator_target as the link. Closing
  is complete_operator_action (or the dashboard "Mark done"); until then it
  persists. Paused-project Needs Operator cards collapse into the suppressed
  count like everything else.
- PAUSED PROJECTS are suppressed. Honor the "Paused Projects" list in
  `CLAUDE.local.md`. Any moved task, Standing draft, or open decision tied to
  a paused project is pulled OUT of "What needs you" and collapsed into a
  single "Paused (suppressed): <project> - N items held until unpaused" line.
  Do not itemize paused work as if it needs the operator now.
- Operator-facing voice: no em dashes, no banned words, natural prose.
- Never render a confident briefing over partial reads. If a tool fails, say
  exactly what could not be read.
- If the render fails, do NOT advance the watermark (re-covering a window is
  safe; a silent gap is not). If the watermark write fails after a good
  render, tell the operator the next briefing will overlap.

## Procedure

1. **Watermark + ledger preflight.** `read_agent_ledger`; watermark = the
   `briefing` row's `last_successful_run`. If the row is missing, ask the operator
   for explicit approval to run this idempotent Supabase `execute_sql` insert,
   then verify the row before rendering:

```sql
insert into public.agent_task_ledger
  (agent_code, operator, runtime, automation, automation_state, notes)
values
  ('briefing', 'the operator', 'claude', 'manual briefing skill',
   'manual-required',
   'OE-11 briefing renderer. Reads the Open Engine board, advances the briefing watermark after a successful render, and captures the rendered session operating map.')
on conflict (agent_code) do nothing;
```

   Missing row or null after the approved insert: use a 7-day lookback and say
   so. Also scan all ledger rows: any executor/runner `last_heartbeat` older
   than 36h is itself briefing content (runtime health flag).
2. **Board read.** `list_agent_tasks` hides `Agent Done` by default and caps
   every call at 50 rows (default 20, sorted updated_at desc), so one bare
   call is an incomplete board. Call it once PER STATUS —
   `statuses: ["<status>"]`, `limit: 50` — across all seven statuses
   (Standing, Agent Todo, Agent Working, Agent Needs Input, Agent Review,
   Needs Operator, Agent Done), with `include_done: true` on the Agent Done call and
   `include_archived: true` on every call (applied closeouts may be archived
   and still belong in the diff window). If any single call returns exactly
   50 rows, treat that status as possibly truncated and say so in the board
   pulse; never render silently over a truncated read. Partition the union:
   - MOVED: `updated_at > watermark`. For each, `get_agent_task` and read the
     events newer than the watermark. The updated_at trigger fires on EVERY
     row update, including claim heartbeats and reaper housekeeping, so a
     moved task can carry zero new events: report those under one
     housekeeping line at most; never invent activity for them.
   - NEW DRAFTS: `created_at > watermark` and status `Standing`. Drafts write
     zero events by design, so they never show up in event diffs; this
     created_at check is the only way they surface.
   - STANDING INVENTORY: every Standing draft regardless of age. "What needs
     you" lists all open promote decisions, not just this window's.
3. **Classify moved tasks** by newest receipt: applied and filed (`AGENT
   APPLIED`), done awaiting review (`AGENT DONE`), held (`AGENT HUMAN HOLD` /
   `AGENT BLOCKED`), failed or reaped (`AGENT FAILED`), claimed in flight
   (`AGENT CLAIMED` with no terminal receipt), promoted on its own
   (`AGENT STATUS` with `payload.action='auto-promoted'`).
4. **Render the Session Operating Map** (structure below).
5. **Phase 4 readiness streak (query-backed).** Read the watch views via
   Supabase `execute_sql` (read-only):

   ```sql
   select clean_streak, terminated_by_day, terminated_by_verdict, latest_settled_day
   from oe_triage_watch_streak;
   select et_day, drafts_created, mechanical_verdict, effective_verdict
   from oe_triage_watch_days
   where effective_verdict <> 'CLEAN' or et_day > (now() at time zone 'America/New_York')::date - 7
   order by et_day;
   ```

   Render the streak WITH its terminating day and verdict, never as a bare
   integer — verdicts are retroactive (a draft archived days later can drop
   the number without anyone editing anything), and a drop must be legible
   instead of alarming. Any `PENDING_REVIEW` day is a "needs you" item: the
   operator rules it via `oe_watch_rulings` (promoted draft → clean; archived
   unpromoted → dirty; untouched → leave pending). The views are the system
   of record for the streak; do NOT transcribe rows into PROJECT-TRACKER.md.
   The gate itself is unchanged: 5 consecutive CLEAN days AND the operator's
   explicit go.
6. **Close out, only after a successful render:** `write_agent_ledger` for
   `briefing` with `last_successful_run` = the MAXIMUM event/task
   timestamp observed this run (not now()), converted to UTC `Z` datetime form
   (for example `2026-07-09T20:30:30.123456Z`, never a `+00:00` offset).
   Carry the full microsecond precision of that timestamp: a truncated
   watermark sits just below the newest event, so that task re-reports on every
   following run. Set `last_queue_result` = compact
   counts (e.g. "moved 6 / needs-you 3 / new drafts 2"). Then
   `capture_thought` with the briefing text, tags `["open-engine","briefing"]`.

## Session Operating Map structure

1. **Board pulse.** One line: window covered, counts by status, health flags.
2. **What happened.** Grouped, plain language: finished and filed; finished
   awaiting your review; held with a question; failed or retried; new drafts
   created; promoted on its own. Held items use Delegate-and-Verify framing:
   what was attempted, what still needs verification. For each finished-and-
   filed item, name the operator's resulting next step in the same breath (it
   is repeated as an action in "What needs you"); a filed research/draft task
   is rarely the end of the line.
3. **What needs you.** Group every waiting item into one of four buckets, in
   this order. Each item: one plain-language line of what it is and why it
   waits, EXACTLY ONE next step, and a link to the actual work (or the inline
   excerpt when no file exists, per the EMBED rule). Held questions blocking
   claimed work always float to the very top regardless of bucket.
   - **A. Board decision** - needs a decision to progress on the board (apply
     a medium/high Agent Review, answer a held question). Resolves in seconds
     in this chat. Action: the one guarded tool call with the task id
     prefilled (or the dashboard action). Link: the status-filtered board view
     + short-id. Its receipt draft shows inline per the EMBED rule. Order within
     this bucket by the advisory critic verdict: a flagged medium/high Agent
     Review sorts above a clean or unreviewed one (per the CRITIC VERDICT rule).
   - **B. Your hands** - operator personally acts on an outside system (claim a
     listing and paste, make a call, confirm a fact, send a drafted email). No
     Claude session needed. Action: the one concrete step + the exact target
     (URL, phone, address, or file path). Driven by the Needs Operator column: every
     Needs Operator card renders here every run (see the always-shown hard rule),
     showing its stored operator_action + operator_target. Any item not yet
     routed to Needs Operator is still mined from applied / Agent Review receipts
     whose Follow-up recommendation hands operator a personal step (the Phase 1
     fallback). This is the bucket that used to vanish; it renders every run
     until cleared.
   - **C. Fresh Claude session** - local-runtime work (write a post, run
     LOCAL-runtime drafts). Action: a paste-ready Goal Prompt (generator
     below). Link: the board view + short-id.
   - **D. Promote from Standing** - an intake promotion decision. Action:
     promote or archive the Standing draft. Link: the standing board view.
   Paused-project items are excluded per the hard rule and shown only as the
   one-line suppressed count.
4. **What happens next without you.** The scheduled lanes' next runs
   (executors, queue runner, closeout controller, triage), so silence reads
   as normal instead of broken.

## Goal Prompt Generator (separate-chat items)

Build the prompt from the task packet so a fresh session can run without this
conversation. Fenced block, this shape:

```text
I'm working on <project> at <repo path if known from project_slug>.
Open Engine task <task-id>: <title>.
Desired outcome: <desired_outcome>.
Context: <context, compressed to what a fresh session needs>.
Sources: <sources>.
Acceptance criteria: <acceptance_criteria>.
Boundaries: <boundaries, plus: claim it with claim_specific_agent_task
as claude-code before working; exit through one honest receipt>.
```

## Artifact render (optional enhancement)

Trigger only when BOTH hold: this runtime actually exposes an Artifact or
hosted-page tool, AND the map is heavy (5+ items in "What needs you", or the
operator asks for it). No such tool present: skip silently and say nothing
about it. The in-chat markdown map is always complete on its own; the
Artifact supplements the render, it never replaces it. Render the markdown
FIRST, every run; only then, if the trigger holds, also publish the page.

When you do render, one self-contained HTML page, no external assets of any
kind (no CDN scripts, fonts, or remote images; inline all CSS):

- Write the HTML to a file in the scratchpad directory, then publish it.
- `<title>Open Engine Briefing</title>`; a stable favicon (same emoji every
  run, e.g. a clipboard, so the operator's tab keeps its identity).
- Theme-aware: style both light and dark (`prefers-color-scheme` plus the
  viewer's theme-toggle override); never hardcode one palette.
- **Board pulse** as a one-line header band: window covered + counts by
  status + any health flags.
- **Board columns** as a flex row that wraps: one column per status
  (Standing, Agent Todo, Agent Working, Agent Needs Input, Agent Review,
  Needs Operator, Agent Done), each a stack of compact task cards (id short-hash,
  title, risk). This is orientation, not the action list.
- **What needs you** as the primary section: a card list in the same
  four-bucket order as the markdown (A board decisions, B your hands, C fresh
  Claude session, D promote from Standing), with any held questions floated to
  the top. Each card carries its ONE action inline AND its link as a real
  `<a href>` (the status-filtered board view, or the external/file work
  product), plus its reviewer verdict tag when present. Bucket C items put the
  Goal Prompt in a `<pre>` block with a short "copy this into a fresh session"
  note above it. Bucket B items whose deliverable is only in the receipt embed
  the draft excerpt in a `<pre>` block. Paused-project items appear only as the
  one-line suppressed count, not as cards.
- Wide content (any Goal Prompt, long titles) scrolls inside its own
  `overflow-x: auto` container; the page body never scrolls sideways.
- Keep it private / default-unshared (operator board state is not public).

The Artifact is a leaf: nothing downstream reads it, and it must match the
in-chat markdown 1:1 (same items, same actions, same counts). If the two
would disagree, the markdown is canonical and the Artifact is wrong.
