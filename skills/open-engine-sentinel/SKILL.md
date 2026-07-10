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
  Include a ready-to-paste Phase 4 readiness-watch row in the Slack report
  instead. A human session can paste it into the tracker if desired.
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
     current UTC datetime in `Z` form, `last_queue_result` as the compact
     PASS/FAIL line, and notes only if there is something actionable.
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
  ), '[]'::jsonb)
) as sentinel_board_health;
```

## Scheduling

A scheduled runtime owns the sentinel. Run daily after the triage and executor
slots have fired, so the sentinel observes a completed morning rather than an
in-progress one.

If the automation system has timezone ambiguity, schedule by explicit UTC for
the current season and note the daylight-saving follow-up.
