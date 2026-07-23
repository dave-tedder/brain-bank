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

## STEP 0.7 — PRIOR-BRIEFING RECALL (BEFORE RENDERING "WHAT NEEDS YOU")

The briefing has memory: every run ends in a capture_thought tagged
["open-engine","briefing"] carrying the full rendered map. Read it back.
Before rendering, search_thoughts for the last 1-2 briefing captures (tag
"briefing"; bounded — never walk the full history) and thread them in:

1. AGE every waiting item. An item in "What needs you" that also appeared in
   the prior briefing and is still waiting renders with "carried N briefings".
   Aging is a signal the operator should see, not a fresh line each run.
2. TRACK SPAWN-OUTS. For a bucket-C / [session-spawnable] item whose Goal
   Prompt was already issued in a prior briefing:
   - its task has since moved (claimed / working / done) => render as
     "in flight, likely spawned (goal prompt issued <YYYY-MM-DD>)", NOT as
     needing the operator;
   - it has NOT moved after 2+ briefings => flag "goal prompt issued
     <YYYY-MM-DD>, task has not moved — did the spawn happen?". Inference,
     not proof: phrase it as the question, never as an assertion.
3. COLLAPSE DUPLICATES. Two waiting items pointing at the same task id,
   action item, or deliverable merge into one line that says it merged them.
4. EMIT THE DELTA. One line in or directly under the Board pulse: what is new
   since the last briefing, what cleared, what still waits.
This step is READ-ONLY and adds zero writes; the end-of-run capture (unchanged)
is what makes the next run's recall possible. It is also where the "DO NOT
RE-SURFACE SETTLED STEPS" check runs: a mined step that appeared in a prior
briefing and has no tracking card is dropped once outside its watermark window.
If no prior capture is found (first run, or captures purged), say so in the
Board pulse and render without annotations rather than guessing.

## STEP 0.5 — DISCOVERY BEFORE DIALOGUE

Front-load. Every mid-run question costs the operator a context switch. The goal
is ONE consolidated decision gate, then uninterrupted execution.

1. Read the packet/deliverable END TO END, including the bottom. Limitations,
   re-target logs, and flagged questions live there and change the work.
2. VERIFY every resource the packet names, before using it. Paths (against the
   canonical map: `search_thoughts "PROJECT PATH MAP"`), internal link targets,
   post IDs, folders, media. A packet that names a resource with no verified
   path is a PACKET BUG: resolve it, use the real thing, and say so in the
   receipt. Never spider the disk hunting for it.
3. RESOLVE WHAT YOU CAN before escalating. Distinguish:
   - "I don't know" -> YOUR problem. Go find out.
   - "The operator must choose" -> THEIR problem. Escalate it.
   A fact already published on the operator's own website, or already captured
   in the brain, is NOT a decision. Look before you ask. A prior agent escalated
   the operator's own travel cadence as an open question while two of their live
   pages stated it.
4. BUILD THE ARTIFACT BEFORE ASKING. If the operator must choose between things,
   produce the thing to choose from first: contact sheets with pick IDs, a
   before/after diff, an option table. One round trip, not three.
5. ENUMERATE EVERY decision that genuinely needs the operator, then present them
   in ONE block. Do not trickle.
6. FACT-APPLICATION INTAKES: when a task applies a confirmed fact (a name, a
   date, an address) to content, the packet's acceptance_criteria must enumerate
   EVERY artifact that carries the fact: local markdown draft, CMS post/page,
   schema meta. A drafts-only scope must NAME the live artifact it deliberately
   does not touch, so the untouched half shows on the receipt instead of
   drifting silently. A drafts-only task once closed Agent Done correctly while
   the live CMS draft kept the stale value for days, and a second confirmed fact
   from the same operator confirmation had no application task at all and
   reached zero artifacts until an attended session noticed.

What is NOT an interruption to be optimized away: choices that are genuinely the
operator's. Publishing public content, selecting client-facing photos, spending
money, asserting facts about their business. Batch these; never skip them.

## RISK RATING RUBRIC (for any intake you create)

Risk = **BLAST RADIUS OF THE AGENT'S ACTIONS.** NOT sensitivity of the subject.

- `low` — draft-and-propose. Research -> report; content/copy drafted but never
  sent; local documentation draft; read-only verification -> report. Touches
  nothing live. Worst case: a proposal the operator rejects.
- `medium` — mutates something real but reversible.
- `high` — irreversible, public, or financial.

**CRITICAL:** scheduled OE-5 runners pass `max_risk=low` to
`claim_next_agent_task`. A task rated `medium` or `high` is INVISIBLE to every
scheduled lane. It sits in Agent Todo forever: not blocked, not failed, not
flagged, never claimed. Promoting it looks identical to queuing it and silently
does nothing. Only an attended manual claim (default `max_risk=medium`) sees it.

So: rate draft-and-propose work `low`, even when the SUBJECT feels weighty. Put
subject-matter caution in `boundaries`, which travels with the packet regardless
of the risk field. An image-sourcing task was once rated `medium` because the
topic touched copyright; the task could only ever write a proposal, and the
rating quietly made it unrunnable.

**Risk is FROZEN at intake.** No verb amends it (`admin_amend_agent_task` covers
project_slug, add_sources, operator_action, operator_target, requires_local
only). A mis-rated task must be RECREATED at the right risk and the old one
superseded via `admin_amend_agent_task` with a DO-NOT-WORK reason plus an
`add_sources` pointer. Do NOT use `block_agent_task` for this: it requires a
claimed/assigned task and would write a false AGENT BLOCKED receipt under an
agent code with no run behind it.

Also always set `project_slug` on intake. The closeout controller routes strictly
by slug and holds anything it cannot resolve.

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
  board should never lag what the operator already decided in chat. When a
  Standing draft being archived was seeded from a project plan doc (its
  `sources` carry a `plan-doc:` entry and its doc line is tagged
  `[OE:<shortid> …]`), the archive is not complete until that doc line's tag is
  flipped to `[OE:<shortid> archived <date>]` (Edit the plan doc + any co-located
  tracker line) so the line reads open again and can be re-carded deliberately.
  This is the escape-hatch half of the closeout doc-sync (the apply path flips
  carded→done; archiving flips carded→archived).
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
- SHOW TASK LINEAGE, do not scatter it. When an applied or Done task spawned
  follow-up work (Standing drafts or Agent Todo cards created from its receipt
  or in the same closeout), render those children UNDER the parent that
  produced them, naming the link: "Yesterday's audit <parent-task-id> produced
  these two follow-ups." The reader must never have to reassemble the
  parent/child chain themselves. Detect lineage from the child's
  context/sources naming a prior task id, a shared project_slug created in the
  same window, or an AGENT FOLLOW-UP event. In particular, a batch of Standing
  drafts in bucket D is almost always the harvest of the tasks that finished in
  the same window; group them by their parent, not as a flat list.
- NEVER POINT AT WORK THAT DOES NOT EXIST YET. Before linking a deliverable or
  telling the operator to apply/use one, confirm it exists. A Needs Operator or
  Agent Review card that depends on another task's output (a walkthrough, a
  kit, a draft) is BLOCKED if that other task is still Standing or Agent Todo
  and has not run. Say so plainly ("depends on <blocking-task-id>, which has
  not executed yet, so no file exists") instead of handing the operator a dead
  link or a file path that is not there. A `deliverables/` path only counts as
  real after the producing task reached Agent Review/Done; a Standing draft
  describing the work is the request, not the deliverable.
- DO NOT RE-SURFACE SETTLED STEPS. A follow-up step MINED from an applied
  task's receipt (the Phase-1 fallback) has no tracking card, so nothing
  records when the operator does it, and it re-appears every run reading as
  stale. Surface a mined step ONLY in the watermark window right after its task
  was applied; after that, drop it. Genuine recurring outside-system steps
  belong on a Needs Operator card (which IS closeable), not mined every
  briefing. When unsure whether a mined step is already done, say it may
  already be handled rather than presenting it as open work.
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
- CLAIMABILITY SPLIT. Agent Todo is NOT one thing, and rendering it as one is a
  lie the operator acts on. Two independent columns decide whether a row moves
  without them, and BOTH have to be checked: every scheduled lane claims with
  `max_risk=low`, and no scheduled lane passes `runtime_local`:
  - `risk = low` AND `requires_local` is false => it is genuinely queued. Render
    under "What happens next without you" as happening on the next scheduled run.
  - `risk = medium` or `high` => NO scheduled lane will EVER claim it. Render it
    in bucket C, worded as needing an attended session (not as queued work), WITH
    the Goal Prompt the generator already produces. Say plainly that nothing is
    coming for it on its own.
  - `requires_local = true` => same bucket C treatment, whatever the risk. A
    scheduled lane must not pass `runtime_local`, so these rows are invisible to
    `claim_next_agent_task` by design. Word it as needing an attended session on
    the local machine, not as queued work. A low-risk `requires_local` row is
    the sneaky one: every field the operator scans reads "queued and low risk"
    while nothing will ever pick it up.
  NEVER emit "the executors will claim these" (or any equivalent) over a set that
  contains a medium or high row, or a `requires_local` row. Check the risk AND
  the `requires_local` flag of every Agent Todo row before writing that sentence,
  not after.
  Why this is a hard rule: a real briefing put Agent Todo rows in bucket C and
  told the operator the overnight executors would claim them. That was true of
  the low rows and FALSE of a medium that had been sitting in the same column for
  days. A stranded medium therefore read as handled on the one surface the
  operator actually reads, which is worse than not mentioning it at all.
  The `requires_local` half was added after a second incident of the same shape:
  an operator promoted six drafts and five were low-risk `requires_local` rows.
  Under the risk-only version of this rule every one of them would have rendered
  as happening on the next scheduled run, and the sentinel's stranded count read
  zero at the same time, so both surfaces agreed and both were wrong.
  `claim_gating_warning` covers the promote MOMENT; this rule covers the ongoing
  state after it, and the sentinel's stranded count is the backstop for when a
  render forgets anyway.
- A DEAD CLAIM MAKES A HELD CARD UNANSWERABLE. Before handing the operator a
  one-step action on an `Agent Needs Input` or `Agent Review` card, check
  `claimed_by` and `claim_expires_at`. The claim is DEAD when `claimed_by` is
  set AND `claim_expires_at` is either past or NULL — null alongside a live
  `claimed_by` is the reaper's dead-letter shape, not an unclaimed row. On a
  dead claim `answer_agent_task`, `resume_agent_task`, `unblock_agent_task`
  and `update_agent_task` ALL REFUSE, because every one of them requires the
  caller to own the claim. So the card is STUCK, not merely waiting, and the
  render must say so.
  The step to give instead is the release-claim fold: `admin_amend_agent_task`
  with `release_claim: true` (which returns the row to Agent Todo and clears
  `agent_code`), then `claim_specific_agent_task`, then the real verb. Never
  render "answer this" or "resume this" over a dead-claimed card.
  A LIVE claim on those two statuses is normal and is exactly what makes the
  answer and resume calls work. Say nothing about it.
  Why this is a hard rule: the SENTINEL already counts these (its "stale claims
  N blocking" figure) while this skill had no claim-liveness rule at all, so the
  two surfaces disagreed and the wrong one was the briefing, which is the
  surface the operator actually reads each morning. A held card carrying a dead
  claim is the same trap as a card that is held AND unclaimed: no verb can touch
  it, and without this check the only way out anyone finds is raw SQL.
- THE NEEDS OPERATOR DESK IS ALWAYS SHOWN. Every task in the Needs Operator column
  renders under bucket B ("Needs you present") on EVERY run, regardless of the
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
- Date discipline in the rendered map and the end-of-run capture: every
  relative date term is immediately followed by the absolute date, e.g.
  "tonight (2026-07-18)". The capture is durable text read by later runs.
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
   and still belong in the diff window).
   TRUNCATION CHECK, and read this before flagging one. Rows come back sorted
   `updated_at desc`, so a capped call drops the OLDEST rows, never the newest.
   A call that returns exactly 50 is therefore only a real truncation risk when
   the OLDEST row it returned is still NEWER than the watermark, because only
   then could a row inside the diff window have fallen off the bottom. Check
   that oldest row before saying anything: if it is older than the watermark,
   the window is fully covered and you say nothing. If it is newer, the status
   is genuinely truncated, say so in the board pulse and never render silently
   over it. Do NOT flag on the bare row count alone. Retired smoke tasks and
   old closeouts accumulate under `include_archived` forever, and a board that
   has been through a build phase can easily hold dozens of them in a single
   column, so a count-only rule turns into a permanent possibly-incomplete
   caveat on every render, which trains the reader to ignore the one case that
   is real. Partition the union:
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

## OPERATOR RENDERING CONTRACT (governs every render and every reply)

Added after a session where a rules-correct render was still unworkable for
the operator: items unnumbered, task ids buried mid-line, context assumed
from the morning render, "spawn a session" executed as background subagents,
and per-card board links that never landed on the card. Where these conflict
with older habits elsewhere in this skill, these win.

1. ONE GLOBAL NUMBER SEQUENCE. Number every item in the briefing 1..N in
   render order, across "What happened" AND all four "What needs you" buckets
   (buckets stay as subheadings). The operator works and answers by number.
2. ID FIRST, THEN CONTEXT, EVERY ITEM. Each item opens exactly:
   `N. <short-id> — <project>:` followed by 2-3 plain sentences covering (a)
   which project this belongs to, (b) what the task actually is, and (c) why
   it waits / what just happened — written so the operator can decide with
   zero memory of any prior render. Then EXACTLY ONE next step.
3. LINK THE EVIDENCE IN CHAT. Every deliverable or context file that helps
   the operator decide is a clickable markdown link in the chat text
   (relative local path, or external URL). The chat is the primary link
   surface: it can open local files; the Artifact cannot.
4. THE ARTIFACT CARRIES NO LINKS. Local paths cannot resolve from a hosted
   page, and status-filtered board views rarely land the eye on the intended
   card, so the Artifact renders ids and file paths as plain text only. It
   is an orientation surface, not a navigation surface.
5. EVERY LATER REPLY KEEPS THE SHAPE. For the rest of the session, any reply
   that reports on, asks about, or acts on a board item re-introduces it as
   `N. <short-id> — <one-or-two-sentence recap>` before the new information.
   The operator cannot recall a task from its short-id alone, even minutes
   later in the same chat. A bare short-id with no recap is a render bug.
6. SIDE-SESSION VOCABULARY. When the operator says "spawn a session" (or
   "side chat"), they mean an OPERATOR SIDE SESSION: a fresh session THEY
   open and drive, NOT a background subagent. When the runtime exposes a
   task-chip tool (e.g. `spawn_task` in the desktop app), prefer it: it
   drops a chip the operator clicks once to approve and spin into a session
   they drive — set `cwd` to the right project, `prompt` to the
   self-contained Goal Prompt, `title` to the chip label, `tldr` to the
   one-line what/why. Fall back to a paste-ready Goal Prompt when no chip
   tool exists. NEVER a background subagent: those run invisibly inside the
   briefing chat where the operator cannot steer, approve, authorize OAuth,
   pick images, or click anything, so every interactive step dies. Use
   background subagents only when the operator explicitly asks for
   background work.
7. FLAGS ARE EXPLAINED, NEVER JUST NAMED. When a card carries a critic
   verdict of `flagged` (or any warning/limitation gating the operator's
   decision), the render and every later reply explain each flag in plain
   words: what the reviewer actually found, why it matters, and what the
   operator should check or decide because of it. A bare "flagged" tag, or
   flag text compressed past comprehension, is a render bug — the operator
   cannot weigh a risk they cannot read.
8. AGENT-PROPOSED CONTENT IS LABELED AS SUCH. When a deliverable contains
   answers, facts, or copy an agent drafted ON THE OPERATOR'S BEHALF
   (proposed answers to questions addressed to them, placeholder personal
   memories, inferred history), the render says plainly that the operator
   has not confirmed it and it may be wrong. Never present agent-proposed
   answers as settled.

## Session Operating Map structure

1. **Board pulse.** One line: window covered, counts by status, health flags.
   Plus the STEP 0.7 delta line: new since last briefing / cleared / still
   waiting.
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
   - **B. Needs you present** - the item cannot move without the operator, but
     that does NOT mean the operator has to do it themselves. TAG every card in
     this bucket as one of two kinds, and never leave a card untagged:
     - `[hands-only]` - only the operator can do this: make the call, confirm a
       fact only they know, pick images by eye, sign something, click a button in
       an account no agent can reach. Action: the one concrete step + the exact
       target (URL, phone, address, or file path).
     - `[session-spawnable]` - this is agent work that merely needs the operator
       PRESENT, for a credential, an approval, or a live-surface write (publish
       the posts, drive their logged-in dashboard, install a deliverable into a
       live file). Action: the one concrete step AND a paste-ready Goal Prompt,
       exactly like bucket C. They spawn a session from the briefing and supervise.
     Driven by the Needs Operator column: every Needs Operator card renders here
     every run (see the always-shown hard rule), showing its stored
     operator_action + operator_target. Any item not yet routed to Needs Operator
     is still mined from applied / Agent Review receipts whose Follow-up
     recommendation hands operator a personal step (the Phase 1 fallback). This is
     the bucket that used to vanish; it renders every run until cleared.
     The old framing here was "No Claude session needed." That is retired: it was
     FALSE in practice, because operators routinely spawn a session straight from
     the briefing to clear a Needs Operator card. The real axis is not
     operator-vs-agent, it is hands-only vs session-spawnable-with-the-operator.
     When a card is genuinely ambiguous, tag it `[session-spawnable]`. The errors
     are not symmetric: mis-tagging hands-only work as spawnable wastes one
     session, but mis-tagging spawnable work as hands-only silently pushes
     agent-executable work back onto the operator's hands, which is the entire
     thing Open Engine exists to prevent.
   - **C. Fresh Claude session** - local-runtime work (write a post, run
     LOCAL-runtime drafts), PLUS every Agent Todo row that no scheduled lane can
     ever claim (see the CLAIMABILITY SPLIT rule). Action: a paste-ready Goal
     Prompt (generator below). Link: the board view + short-id.
   - **D. Promote from Standing** - an intake promotion decision. Action:
     promote or archive the Standing draft. Link: the standing board view.
     FOLLOW-UP STUB GUARD: before recommending or executing a promote on any
     `agent-follow-up` draft, read its `do_steps`. If it still starts "Review
     the parent task result", the packet is an unmodified template stub;
     promoting it for execution GUARANTEES a PACKET_INVALID bounce (each
     burns an executor rep). No verb amends a packet body, so the fix is a
     fresh execution-shaped intake (`create_agent_task_intake`, or
     `create_agent_task_follow_up` with the executable-packet params) that
     supersedes the stub — never a promote. The server refuses these
     promotions outright (PROMOTION_REFUSED_TEMPLATE_BODY) unless
     `allow_template_body: true` is passed deliberately.
   Paused-project items are excluded per the hard rule and shown only as the
   one-line suppressed count.
4. **What happens next without you.** The scheduled lanes' next runs
   (executors, queue runner, closeout controller, triage), so silence reads
   as normal instead of broken. Name ONLY the Agent Todo rows that are low risk
   AND not `requires_local` as happening on the next scheduled run (per the
   CLAIMABILITY SPLIT rule). Never describe Agent Todo as a whole here: the
   moment one medium or one `requires_local` row sits in that column, "the
   executors will claim these" becomes a false promise about a row nothing is
   coming for.

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
  four-bucket order as the markdown (A board decisions, B needs you present,
  C fresh Claude session, D promote from Standing), with any held questions
  floated to the top. Each card carries its ONE action inline, its global item
  number and short-id, and its file path or URL as PLAIN TEXT — no links of
  any kind in the Artifact, per the OPERATOR RENDERING CONTRACT — plus its
  reviewer verdict tag when present. Bucket C items put the
  Goal Prompt in a `<pre>` block with a short "copy this into a fresh session"
  note above it. Bucket B cards show their `[hands-only]` / `[session-spawnable]`
  tag on the card, and every `[session-spawnable]` card gets the same `<pre>`
  Goal Prompt treatment as bucket C. Bucket B items whose deliverable is only in
  the receipt embed the draft excerpt in a `<pre>` block. Paused-project items
  appear only as the one-line suppressed count, not as cards.
- In the board-state column view, tag each Agent Todo card with whether a lane
  can claim it (low = claimable on the next scheduled run, medium/high = needs an
  attended session), so the orientation view cannot imply the column is uniformly
  queued either.
- Wide content (any Goal Prompt, long titles) scrolls inside its own
  `overflow-x: auto` container; the page body never scrolls sideways.
- Keep it private / default-unshared (operator board state is not public).

The Artifact is a leaf: nothing downstream reads it, and it must match the
in-chat markdown 1:1 (same items, same actions, same counts). If the two
would disagree, the markdown is canonical and the Artifact is wrong.
