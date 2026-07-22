---
name: open-engine-sentinel
description: Use when running the OE-14 Operations Sentinel + Learning Eval as the sentinel runtime. Reads Open Engine runtime health, stale claims, old Standing drafts, and the agent_scorecard view, then emits one PASS/FAIL operations report. Read-only on the board; never claims, promotes, resolves, archives, applies, or edits project files.
---

# Open Engine Sentinel (OE-14)

One watchdog heartbeat for Open Engine. It answers: did the scheduled lanes fire
today, is anything stuck, are Standing drafts rotting, and what does the weekly
scorecard say about unattended reliability?

Tool names below are bare; the MCP server prefix varies by runtime
(`mcp__brain-bank__*`, UUID-prefixed connector, etc.). Load tools through
ToolSearch when deferred.

## Hard Rules

- Identity: `sentinel`. Fail closed if the ledger row is missing.
- READ-ONLY on the board. Never call any tool that claims, promotes, answers,
  unblocks, resolves, archives, applies, fails, or creates tasks.
- The only writes in a run are:
  1. one Slack operations report, after the channel is confirmed;
  2. one `write_agent_ledger` heartbeat for `sentinel`;
  3. one `capture_thought` summary.
- Scheduled runs do NOT edit `PROJECT-TRACKER.md` or `SESSION-LOG.md`.
  Report the Phase 4 readiness streak from `oe_triage_watch_streak`
  (read-only `execute_sql`) instead of a paste-row: the views are the system
  of record now. Flag any `MISSING` day in `oe_triage_watch_days` loudly —
  a MISSING day means a scheduled lane left no durable run record, and this
  flag is the check that would have caught a dead triage lane the same
  morning rather than days later in conversation.
- One honest exit. If any required read fails, post/report `FAIL` with the
  missing surface named. Do not paper over partial data.
- Operator-facing voice: plain, natural prose.

## One-Time Preflight

`write_agent_ledger` cannot create the ledger identity. Before the first run,
verify with `read_agent_ledger` that `sentinel` is absent, then ask the operator
for explicit approval to run this idempotent Supabase `execute_sql` insert:

```sql
insert into public.agent_task_ledger
  (agent_code, operator, runtime, automation, automation_state, notes)
values
  ('sentinel', 'operator', 'codex',
   'daily operations sentinel', 'installed',
   'OE-14 Operations Sentinel. Read-only board watchdog; reports scheduled lane health, stale claims, old Standing drafts, and agent_scorecard learning trends. Never claims or mutates tasks.')
on conflict (agent_code) do nothing;
```

`runtime` is CHECK-constrained to exactly `claude` or `codex`; set it to
whichever runtime owns your scheduled sentinel.

After approval and insert, verify with `read_agent_ledger(agent_code:
"sentinel")` before any manual or scheduled run.

## Procedure

1. **Preflight.** `read_agent_ledger`. Required rows: the scheduled lane codes
   configured on this board (for example `triage`, `claude-code`, `codex`) and
   `sentinel`. A `briefing` row, if present, is useful context but not a
   sentinel dependency. Critic rows (`claude-critic` and `codex-critic`) are
   WARN-level checks: stale critics never fail the sentinel by themselves
   because critic verdicts are advisory, but they must be named.
2. **Lane freshness.** Compare each lane's `last_heartbeat` or
   `last_successful_run` against its configured slot for today in the operator's
   timezone. Example slots: a triage lane in the early morning, an executor lane
   at a few points through the day, a queue-runner/audit lane at its scheduled
   time. WARN-only: the critic lanes (`claude-critic`, `codex-critic`) at their
   configured slot when registered/active. Treat a lane as fresh if its last
   activity is after its expected slot for today and before the sentinel run.
   Name stale or missing required lanes in `FAIL`; name stale or missing critic
   lanes under `WARN`.
3. **Board health.** Use `list_agent_tasks` for `Agent Working` and `Standing`,
   or `execute_sql` read-only if a compact result is safer:
   - Agent Working where `claim_expires_at < now()` = would-reap rows. Report
     count and short ids; do not reap.
   - Standing drafts older than 7 days = old drafts. Report count and short
     ids. Known canaries or smoke rows can be named as known, but still list
     them.
   - **Stranded unclaimable rows.** Count `Agent Todo` rows that no scheduled
     lane can claim. There are TWO independent reasons a row is unclaimable, and
     a count that sees only one of them under-reports:
     1. `risk` in (`medium`, `high`). Every scheduled lane claims with
        `max_risk=low`, so these are never claimed.
     2. `requires_local = true`. A scheduled lane must not pass `runtime_local`,
        so LOCAL RUNTIME ONLY rows are invisible to `claim_next_agent_task` by
        design, whatever their risk. A low-risk `requires_local` row looks
        exactly like queued work and is not.
     So the predicate is `risk in (medium, high) OR requires_local = true`, and
     the reported label names both reasons: "unclaimable by scheduled lanes
     (medium/high risk or requires_local)". The number and the label must agree;
     never say "medium/high" over a set that also holds `requires_local` rows.
     Report the count even when 0, and name ids when not. This is a COUNT,
     deliberately: the briefing's CLAIMABILITY SPLIT rule is instruction-shaped
     and a render can forget it, but a ledger figure the digest surfaces cannot.
     Report it; never grade it. A stranded row is the operator's call, not a
     sentinel failure, and must never change the verdict word.
     The second reason was added after a real incident: an operator promoted six
     drafts, five of them low-risk `requires_local`. The risk-only count reported
     zero unclaimable rows while six sat there that nothing would ever pick up.
     Literally true, materially false, and an under-reporting metric is the one
     failure mode this surface cannot have.
   - **Stale claims outside Agent Working.** The expired-claim check above only
     looks at `Agent Working`. A row in any other status can carry a
     `claimed_by` that no longer means anything, and the severity depends
     entirely on the status:
     - `Agent Needs Input` / `Agent Review` are RESUMABLE. A LIVE claim here is
       legitimate and load-bearing: it is what makes `answer_agent_task`,
       `resume_agent_task` and `unblock_agent_task` work at all, since each one
       needs a caller that owns the claim. Never flag a live claim on these.
     - A DEAD claim on a resumable row is the high-severity case. Dead means
       `claim_expires_at < now()` OR `claim_expires_at is null` while
       `claimed_by` is still set. Both shapes occur: the reaper's dead-letter
       branch (max attempts) folds the row to `Agent Needs Input`, keeps
       `claimed_by`, and NULLS `claim_expires_at` and `claim_token`, so a check
       that keys only on `claim_expires_at < now()` will not see it. Such a row
       is held and effectively unowned: answer, resume, unblock and
       `update_agent_task` all refuse because none of them can act on a task
       nobody holds, and `admin_amend_agent_task` cannot move Needs Input to
       Done. Clearing one takes manual SQL. Report these FIRST, with ids, and
       call them blocking.
     - `Needs Operator`, `Agent Todo`, `Standing`, `Agent Done`: a claim here is
       harmless leftover. Those cards close through `complete_operator_action`
       or a fresh claim, not through the stale one. Report quietly as a count,
       with ids when there are few.
     Both figures are REPORTED, not graded. Whether a dead claim on a resumable
     row should move the verdict word is a deployment decision; the default here
     is to report it loudly and grade nothing.
3b. **Auto-promote watch state (if the Phase 4 auto-promote lever is enabled).**
   A gate whose start condition may never occur has to say so on a read surface,
   or it silently becomes "wait forever". The 7-day watch's day-0 is the FIRST
   auto-promotion, so if the intake funnel is in steady state and triage drafts
   nothing, the clock never starts and nothing reports that fact. Compute it:

```sql
select
  (select count(*) from agent_task_events
    where payload->>'action' = 'auto-promoted')     as auto_promotions_ever,
  (select min(created_at) from agent_task_events
    where payload->>'action' = 'auto-promoted')     as day0,
  (select enabled from oe_auto_promote_config)      as enabled,
  (select daily_cap from oe_auto_promote_config)    as daily_cap;
```

   - `auto_promotions_ever = 0`: report `phase4 watch NOT STARTED, N days since
     enable, 0 auto-promotions`. Do not report a day count.
   - Otherwise day K = (today - day0::date) + 1; report `phase4 watch day K of
     7`. K > 7 means the window elapsed and awaits the operator's ruling.
   A cloud/curl-only variant of this lane cannot run SQL. It should instead read
   a `PHASE4_WATCH_DAY0=YYYY-MM-DD` marker from the `triage-auto` ledger row's
   notes, and report NOT STARTED when the marker is absent (the correct
   fail-safe). If both exist and disagree, the marker is the one that is wrong.
4. **Learning eval.** Query `public.agent_scorecard` with `execute_sql`:

```sql
select
  agent_code,
  task_type,
  attempts_resolved,
  first_try_passes,
  setbacks,
  in_flight,
  first_try_pass_pct
from public.agent_scorecard
order by agent_code, task_type;
```

   Render the weekly first-try trend per `(agent_code, task_type)`. With the
   current OE-13 view this is the latest grid, not a historical time series.
   State that explicitly. Flag regressions when a cell has meaningful sample
   size and the pass rate is falling versus the prior captured sentinel report
   or prior tracker note; otherwise say "no trend baseline yet."
5. **Decide.**
   - PASS: all required scheduled lanes fresh, no expired active Working claims,
     and no unexpected old Standing drafts.
   - FAIL: any required lane stale/missing, any expired active Working claim, or
     old Standing drafts needing the operator's decision. Name the exact cause.
   - INCONCLUSIVE: a required read failed or a required tool was unavailable.
6. **Slack report.** Post exactly one line/report to the confirmed ops channel.
   If the channel has not been confirmed in this runtime, draft or print the
   report and ask the operator to confirm the channel before the first live
   post. Shape:

```text
Open Engine Sentinel: PASS
Lane health: triage fresh at <time>; executor fresh at <time>; codex fresh at <time>.
Critic warn: claude-critic <fresh/stale/not registered>; codex-critic <fresh/stale>.
Board health: expired Working 0; old Standing 1 known canary (<id>).
Learning eval: claude-code action-item-promotion 10/13 first-try (77%), triage-agent 1/1 (100%), ...
Phase 4 row text: | <n> | <date> | natural/manual | <draft ids/count> | <mis-tier?> | <PASS/FAIL/RESET> | sentinel |
```

7. **Ledger + capture.** Only after the report is complete:
   - `write_agent_ledger` for `sentinel` with `last_successful_run` as the
     current UTC datetime in `Z` form, and `last_queue_result` set to ONE
     line in this exact shape — a contract, not a style choice, because the
     daily digest's sentinel-report parser keys on the literal `OE-SENTINEL `
     prefix (`supabase/functions/brain-digest/sentinel-report.ts`), so every
     run of this lane must produce the same `last_queue_result` shape:
     `OE-SENTINEL <PASS|WARN|FAIL> <date>: <detail>` (under 300 chars, name
     every missed or warned lane). If a run's verdict is inconclusive, write
     it as `WARN` and say "inconclusive" in `<detail>`, since the contract
     vocabulary is only PASS/WARN/FAIL. Notes only if there is something
     actionable.
     `<detail>` must end with the reported figures from step 3 / 3b, in this
     order, and every variant of this lane must match verbatim:
     `; phase4 watch <day K of 7 | NOT STARTED, 0 auto-promotions>, <N> auto-promoted today; <M> in Agent Todo unclaimable by scheduled lanes (medium/high risk or requires_local)<ids>; stale claims <X> blocking (<ids>), <Y> leftover`
     Name the ids when M > 0, and always name the blocking ids. Omit the
     `phase4 watch` clause entirely if the auto-promote lever is not enabled in
     this deployment. Example:
     `OE-SENTINEL WARN 2026-01-09: 1 old Standing draft abc12345; spine + local 4/4 fresh; phase4 watch day 1 of 7, 5 auto-promoted today; 2 in Agent Todo unclaimable by scheduled lanes (medium/high risk or requires_local) (def67890, 1a2b3c4d); stale claims 0 blocking, 1 leftover (5e6f7a8b)`
     If the line would pass 300 characters, shorten in this order and say what
     was dropped: leftover ids first, then unclaimable ids past the first three
     with a `+N more`. Never drop a blocking id, and never drop a figure.
     The parser only keys on the `OE-SENTINEL ` prefix and passes the rest
     through verbatim, so extending the detail is safe.
     ALSO set `last_successful_run` on every run that completes the checks and
     writes a verdict, whatever the verdict word is: PASS/WARN/FAIL describe the
     BOARD, not this run, so a FAIL you successfully detected and reported is
     still a successful sentinel run. A variant that never sets this field leaves
     it frozen while heartbeats advance daily, which is a signal that lies to
     anyone who gates on it.
   - The Slack report in step 6 is NOT part of this contract and may stay in
     its richer multi-line shape — only the ledger line above must match the
     `OE-SENTINEL ` prefix and level vocabulary the digest reads.
   - `capture_thought` with tags `["open-engine","sentinel","oe-14"]`.

## Suggested Read-Only SQL Bundle

Use this when the runtime can call Supabase `execute_sql` and a compact read is
cleaner than full task packets:

```sql
select jsonb_build_object(
  'now_utc', now(),
  'counts', (
    select jsonb_object_agg(status, active_count order by status)
    from (
      select status, count(*) as active_count
      from public.agent_tasks
      where archived_at is null
      group by status
    ) c
  ),
  'expired_working', coalesce((
    select jsonb_agg(jsonb_build_object(
      'short_id', left(id::text, 8),
      'title', title,
      'claimed_by', claimed_by,
      'claim_expires_at', claim_expires_at
    ) order by claim_expires_at)
    from public.agent_tasks
    where archived_at is null
      and status = 'Agent Working'
      and claim_expires_at is not null
      and claim_expires_at < now()
  ), '[]'::jsonb),
  'old_standing', coalesce((
    select jsonb_agg(jsonb_build_object(
      'short_id', left(id::text, 8),
      'created_at', created_at,
      'age_days', floor(extract(epoch from (now() - created_at)) / 86400),
      'title', title
    ) order by created_at)
    from public.agent_tasks
    where archived_at is null
      and status = 'Standing'
      and created_at < now() - interval '7 days'
  ), '[]'::jsonb),
  'stranded_unclaimable', coalesce((
    select jsonb_agg(jsonb_build_object(
      'short_id', left(id::text, 8),
      'risk', risk,
      'requires_local', requires_local,
      'reason', case
        when risk in ('medium', 'high') and requires_local then 'risk+local'
        when risk in ('medium', 'high') then 'risk'
        else 'local'
      end,
      'title', title
    ) order by created_at)
    from public.agent_tasks
    where archived_at is null
      and status = 'Agent Todo'
      and (risk in ('medium', 'high') or requires_local)
  ), '[]'::jsonb),
  'stale_claims_outside_working', coalesce((
    select jsonb_agg(jsonb_build_object(
      'short_id', left(id::text, 8),
      'status', status,
      'claimed_by', claimed_by,
      'claim_expires_at', claim_expires_at,
      'severity', case
        when status in ('Agent Needs Input', 'Agent Review') then 'blocking'
        else 'leftover'
      end,
      'title', title
    ) order by status, claim_expires_at nulls first)
    from public.agent_tasks
    where archived_at is null
      and status <> 'Agent Working'
      and claimed_by is not null
      and (claim_expires_at is null or claim_expires_at < now())
  ), '[]'::jsonb)
) as sentinel_board_health;
```

`stale_claims_outside_working` deliberately treats `claim_expires_at is null`
with a live `claimed_by` as dead, not as "no claim". That is the reaper's
dead-letter shape, and it is why this class stays invisible to a check that
keys only on `claim_expires_at < now()`. A live claim on a resumable row has
`claim_expires_at > now()` and is excluded by the predicate, which is correct:
that claim is doing its job.

## Scheduling

A scheduled runtime owns the sentinel. Run daily after the triage and executor
slots have fired, so the sentinel observes a completed morning rather than an
in-progress one.

If the automation system has timezone ambiguity, schedule by explicit UTC for
the current season and note the daylight-saving follow-up.
