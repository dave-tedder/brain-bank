---
name: open-engine-critic
description: Use when running one OE-11 cross-runtime critic heartbeat — the morning adversarial review of the Open Engine board (or a manual "run the critic"). Reads finished work on Agent Review / Needs Operator tasks and records one advisory verdict per task from the OPPOSITE runtime (Codex reviews Claude-executed work, Claude reviews Codex-executed work). Advisory only: the verdict never moves task status. Read-only on the board except the single record_critic_verdict write per task and one ledger heartbeat. Never claims, promotes, resolves, applies, or edits files.
---

# Open Engine Critic (OE-11 Phase 4)

An independent adversarial reviewer. Each morning it looks at the work an
executor just finished and records an advisory verdict — `clean` or
`flagged` with a short flag list — so the operator's briefing can surface
"reviewer flagged this" before the operator reads the card. It never blocks and never
moves a task; in v1 the verdict is pure signal.

The point is cross-runtime independence: a runtime does not review its own
work. The Codex lane reviews Claude-executed tasks; the Claude lane reviews
Codex-executed tasks. The SQL enforces this by comparing ledger runtime
strings, but it cannot tell who actually ran — so the anti-spoofing rule below
is what makes the independence real.

Tool names below are bare; the MCP server prefix varies by runtime
(`mcp__open-brain__*`, `mcp__brain-bank__*`, UUID-prefixed connector, etc.). Load tools through
ToolSearch when deferred.

## Identity per lane

- Codex lane → critic code `codex-critic` (ledger runtime `codex`).
- Claude lane → critic code `claude-critic` (ledger runtime `claude`).

Ledger runtime values are exactly `claude` or `codex` (two-value CHECK
constraint since WS-1).

Fail closed if this lane's critic ledger row is missing.

## Hard Rules

- ADVISORY ONLY. `record_critic_verdict` sets four columns and writes one
  `AGENT CRITIC` event. It NEVER changes `status`. Never call any tool that
  claims, promotes, answers, unblocks, resolves, archives, applies, fails, or
  creates tasks. No git, no file edits, no deploys, no captures of other work.
- ANTI-SPOOFING (the whole point of the lane): a verdict is recorded under a
  critic code ONLY by that code's real runtime. NEVER write `codex-critic`
  from a Claude session, and NEVER write `claude-critic` from a Codex
  session. The SQL independence guard only compares ledger runtime strings; it
  cannot detect a spoofed identity. Cross-runtime independence lives or dies on
  this rule. If you are Claude, you are the Claude lane, full stop.
- The only writes in a run are: one `record_critic_verdict` per reviewed task,
  and one `write_agent_ledger` heartbeat for this lane's critic code.
- DEFAULT TO FLAG on any doubt. A clean verdict is a positive assertion that
  you checked and found nothing; if you are unsure, flag it with the specific
  doubt.
- One honest exit. If a required read fails, stop and report the missing
  surface; do not record a verdict on data you could not read.
- Operator-facing voice: no em dashes, no banned words, natural prose.

## Which tasks this lane reviews

Select tasks where ALL hold:
1. `status` in (`Agent Review`, `Needs Operator`) — a card routed to the
   operator desk before the critic ran still deserves a verdict.
2. `archived_at` is null.
3. `critic_verdict` is null (not yet reviewed).
4. The EXECUTOR runtime differs from THIS lane's runtime. Resolve the executor
   from `claimed_by`; if it is null (routing to Needs Operator clears the claim),
   use the most recent `AGENT DONE` event's `agent_code` — and only that event.
   This matches the `record_critic_verdict` SQL guard exactly (`claimed_by`
   else newest `AGENT DONE`; it refuses tasks whose executor it cannot
   resolve), so any wider fallback picks tasks the SQL then rejects as
   `write_failed`. Map that agent code to its ledger `runtime`. The Codex lane
   picks tasks whose executor runtime is `claude`; the Claude lane picks tasks
   whose executor runtime is `codex`.

A compact read-only pick query (`execute_sql` when available):

```sql
select t.id, t.title, t.status,
  coalesce(
    t.claimed_by,
    (select e.agent_code from public.agent_task_events e
     where e.task_id = t.id
       and e.event_type = 'AGENT DONE'
       and e.agent_code is not null
     order by e.created_at desc limit 1)
  ) as executor_code,
  l.runtime as executor_runtime
from public.agent_tasks t
left join public.agent_task_ledger l on l.agent_code = coalesce(
  t.claimed_by,
  (select e2.agent_code from public.agent_task_events e2
   where e2.task_id = t.id
     and e2.event_type = 'AGENT DONE'
     and e2.agent_code is not null
   order by e2.created_at desc limit 1))
where t.status in ('Agent Review','Needs Operator')
  and t.archived_at is null
  and t.critic_verdict is null;
-- Then keep only rows whose executor_runtime differs from THIS lane's runtime.
```

Without `execute_sql`, use `list_agent_tasks` for `Agent Review` and
`Needs Operator`, then read `claimed_by` / the receipt agent code and
`read_agent_ledger` to map runtime.

## The adversarial review

For each eligible task, read the whole picture before judging:
- the executor's `AGENT DONE` (or `AGENT NEEDS OPERATOR`) receipt;
- the deliverable, resolved in this order:
  1. LOCAL DISK — if this runtime can read the repo checkout, read the
     `deliverables/<slug>/...` file named under "Touched files or records:".
  2. GITHUB API — otherwise fetch it from `main` (executors do not push per
     artifact under architecture B; the sweep lane pushes the batch, so the
     current `main` copy is the reviewed target):
     ```
     curl -sS -H "Authorization: Bearer $BB_REPO_READ_TOKEN" \
       -H "Accept: application/vnd.github.raw+json" \
       "https://api.github.com/repos/<your-org>/<your-repo>/contents/deliverables/<path>?ref=main"
     ```
     A 404 usually means the sweep has not pushed it yet; fall through if so.
  3. BUCKET — `get_deliverable {"path": "<slug>/<file>"}` (receipts that say
     `@ BUCKET`).
  4. INLINE — the draft left in "Work summary" (cloud fallback).

  Flag "unverifiable" ONLY when every applicable path above actually failed,
  and name which ones you tried. An unread artifact is a fetch failure to
  report, not a work defect — "flagged: unverifiable" must never again mean
  "I did not have the file.";
- the task's `acceptance_criteria` and `boundaries` (via `get_agent_task`).

Then run this check, defaulting to FLAG on any doubt:

```
Check, defaulting to FLAG on any doubt:
- Voice/brand: banned words (inked, tapestry, delve, realm, metaphorical
  landscape, leverage-as-verb, synergy, holistic, robust), em dashes in
  operator-facing copy, hype/marketing language, pricing framed as hidden/gated.
- Unverified or hallucinated facts: any specific claim (dates like "since
  1983", awards, counts, addresses) not supported by the task's sources.
- Scope drift: output that does not match the task's acceptance_criteria /
  boundaries.
- Obvious errors: broken structure, wrong client, contradictions.
Output: verdict clean|flagged + a short specific flag list (empty if clean).
```

A code-change task with no readable client-facing deliverable (the work is a
diff) is reviewed on the receipt's claims and the boundaries only; if you
cannot see the diff, flag it as unverifiable rather than passing it clean.

## Record the verdict

Call `record_critic_verdict` with:
- `task_id`
- `critic_agent_code`: this lane's code (`codex-critic` or
  `claude-critic`) — and ONLY from that code's real runtime.
- `verdict`: `clean` or `flagged`.
- `flags`: the specific short flag list (empty array for clean).

The SQL rejects a same-runtime critic, an archived task, and any status other
than Agent Review / Needs Operator. Status is never touched.

If one verdict write fails after a successful preflight, skip that task, count
it as `write_failed`, and continue with the rest of the batch. Keep the final
ledger heartbeat honest: include reviewed clean/flagged counts, skipped counts,
and write_failed count. Do not retry by spoofing another critic code or moving
the task yourself.

## Ledger heartbeat

After the pass, `write_agent_ledger` for this lane's critic code with
`last_successful_run` as the current UTC datetime in `Z` form and
`last_queue_result` a compact line, for example:
`Critic (Codex lane): reviewed 3 (2 clean, 1 flagged), 4 skipped same-runtime`.

## Scheduling

Both lanes are intended to run about 7:20 AM ET — after the 7:04 AM executor,
before the operator's morning briefing, so a fresh verdict is on the card when
they read it.

The Claude lane is intended to run natively in the Claude scheduler as
`claude-critic`. The Codex lane must genuinely run in Codex (its verdict
cannot come from a Claude session). See the operator's local scheduled-task and
Codex automation notes for how each lane is wired on this machine.

If the automation system has timezone ambiguity, schedule by explicit UTC for
the current season and note the daylight-saving follow-up. In July, 7:20 AM ET
is 11:20 UTC.
