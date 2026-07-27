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
  Report the Phase 4 readiness figure as observed auto-promotions, not a day
  streak: read the authoritative `oe_phase4_watch_tally` per the detailed step
  below (the day-shaped `oe_triage_watch_*` views are retained for rollback
  only and are no longer the reported readiness figure). Still flag any
  `MISSING` day in `oe_triage_watch_days` loudly as a lane run-record check —
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
   or `execute_sql` read-only if a compact result is safer.

   **Pass `view: "compact"` on every `list_agent_tasks` call in this skill.**
   The full projection returns each card's `review_reason` (the AGENT DONE
   receipt), and once a board has history a whole-status listing exceeds the
   MCP response cap. Compact keeps every field this skill reads —
   `claim_expires_at`, `claimed_by`, `risk`, `requires_local`,
   `critic_verdict`, `title` and `desired_outcome` — so the perpetual-canary
   rule below still matches on it. It drops only long-form prose. For a full
   packet on one card, call `get_agent_task` with that id.
   - Agent Working where `claim_expires_at < now()` = would-reap rows. Report
     count and short ids; do not reap.
   - Standing drafts older than 7 days = old drafts. Report count and short
     ids. **Split perpetual canaries out of this figure.** A Standing draft
     whose title or `desired_outcome` contains "perpetual" together with
     "canary" or "tripwire" (case-insensitive) is a deliberate standing
     tripwire, meant to sit there forever and never be promoted or resolved.
     Count those separately, report them in their own clause ("1 known canary
     (<id>)"), and never let them drive the verdict word. Match on the marker,
     never on a hardcoded task id, so any fork's own canaries behave the same.
     Why this matters: a permanent fixture that forces WARN every single day
     makes the verdict word carry no information, and a watchdog that is always
     yellow is one the reader stops reading. If you keep a standing tripwire on
     your board, this split is what lets the check ever report PASS.
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
     - The one BLOCKING shape is `claim_expires_at is null` while `claimed_by`
       is still set, on `Agent Needs Input` / `Agent Review`. That is the shape
       the reaper's dead-letter branch (max attempts) used to manufacture: it
       kept `claimed_by` and NULLed `claim_expires_at` and `claim_token`, and a
       check keying only on `claim_expires_at < now()` never saw it. Such a row
       is held and effectively unowned: answer, resume, unblock and
       `update_agent_task` all refuse because none of them can act on a task
       nobody holds, and `admin_amend_agent_task` cannot move Needs Input to
       Done. The reaper's dead-letter fix (`20260724_reaper_deadletter_clears_claim`)
       stops it being created, so this count should read 0; if it is ever
       non-zero, some other path minted a null-expiry claim and it needs a look.
       Report these FIRST, with ids.
     - A PAST (non-null) expiry with a live `claimed_by`, on ANY status
       including `Agent Needs Input` / `Agent Review`, is LEFTOVER, not
       blocking. It is not stuck: an `Agent Review` row is applied by the
       closeout by task id regardless of its claim, an `Agent Needs Input` hold
       is still resumable by its owner (resume/answer match the `claimed_by`
       string, not the expiry), and either folds to `Agent Todo` via
       `admin_amend_agent_task(release_claim)`. This is the class that used to
       be over-reported as blocking. Report quietly as a count with ids.
     - `Needs Operator`, `Agent Todo`, `Standing`, `Agent Done`: a dead claim
       here is harmless leftover too. Those cards close through
       `complete_operator_action` or a fresh claim, not through the stale one.
       Report quietly as a count, with ids when there are few.
     Both figures are REPORTED, not graded. Whether a dead claim on a resumable
     row should move the verdict word is a deployment decision; the default here
     is to report it loudly and grade nothing.
3b. **Auto-promote watch state (if the Phase 4 auto-promote lever is enabled),
   measured in OBSERVED AUTO-PROMOTIONS, not calendar days.** A rep count asks
   "have we seen enough?" where a day streak asks "has enough time passed?". A
   gate whose start condition may never occur still has to say so on a read
   surface, or it silently becomes "wait forever" — so NOT STARTED is still
   reported when zero promotions exist. A local run with `execute_sql` reads
   the authoritative tally directly:

```sql
select observed, vetoed, clean_observed, target, remaining_to_target, day0_et
from oe_phase4_watch_tally;
```

   - `observed = 0`: report `phase4 watch NOT STARTED, 0 auto-promotions`. Do
     not report a day count.
   - Otherwise report `phase4 watch <observed> of <target> observed, <vetoed>
     vetoed`. `target` comes from the `PHASE4_WATCH_TARGET` marker via the
     view; if it is null the marker is missing, so report `target unset` and
     flag it. Reaching the target only makes the gate ELIGIBLE for the
     operator's go; it never graduates on its own, and this run must never
     imply it did.
   - Each auto-promotion is INDIVIDUALLY rulable, not merely counted. List the
     un-ruled ones from `oe_phase4_promotions where verdict = 'unruled'`
     (task short-id, ET day, rationale) so the operator can rule each good or
     vetoed via `oe_promotion_rulings`. A veto is the operator's cue to reset
     `PHASE4_WATCH_DAY0`; it never silently reduces a total, it shows as the M
     in "N observed, M vetoed".
   Cross-check that `day0_et` matches the `PHASE4_WATCH_DAY0` marker in the
   `triage-auto` ledger notes (that marker is what a no-SQL cloud sentinel
   variant reads). If they disagree, the marker is the one that is wrong: say
   so plainly and correct it. The day-shaped views (`oe_triage_watch_days`,
   `oe_triage_watch_streak`, `oe_watch_rulings`) are left intact for rollback
   but are no longer the reported readiness figure; read them only when
   diagnosing the old streak.
   TRANSITIONAL: if `oe_phase4_watch_tally` does not exist yet (migration
   `20260725_oe_phase4_promotion_watch.sql` not applied), report the
   `PHASE4_WATCH_TARGET` + `PHASE4_WATCH_DAY0` markers and today's
   auto-promotions as a best-effort line and flag the pending migration; never
   fabricate a tally.
   A cloud/curl-only variant of this lane cannot run SQL. It should instead
   read the `PHASE4_WATCH_TARGET` + `PHASE4_WATCH_DAY0=YYYY-MM-DD` markers from
   the `triage-auto` ledger row's notes, report a best-effort
   `target T, day0 D, N auto-promoted today`, and defer the authoritative
   observed/vetoed tally to the briefing. Report NOT STARTED when the day0
   marker is absent (the correct fail-safe).
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
     and no non-canary old Standing drafts. A board whose only old Standing
     drafts are perpetual canaries is a clean board and reports PASS.
   - FAIL: any required lane stale/missing, any expired active Working claim, or
     non-canary old Standing drafts needing the operator's decision. Name the
     exact cause. Perpetual canaries are reported in the detail, never graded.
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
     order:
     `; phase4 watch <observed> of <target> observed, <vetoed> vetoed | NOT STARTED, 0 auto-promotions; <M> in Agent Todo unclaimable by scheduled lanes (medium/high risk or requires_local)<ids>; stale claims <X> blocking (<ids>), <Y> leftover`
     The phase4 figure is the ONE field that legitimately differs between a
     local run and a cloud routine variant: a local run has `execute_sql`, so
     it reports the AUTHORITATIVE `N of T observed, M vetoed` from
     `oe_phase4_watch_tally`; a cloud routine has no SQL, so it reports a
     best-effort `target T, day0 D, N auto-promoted today` and defers the
     observed/vetoed tally to the briefing. The other two figures (unclaimable,
     stale claims) still match verbatim between variants.
     Name the ids when M > 0, and always name the blocking ids. Omit the
     `phase4 watch` clause entirely if the auto-promote lever is not enabled in
     this deployment. Example:
     `OE-SENTINEL WARN 2026-01-09: 1 old Standing draft abc12345; spine + local 4/4 fresh; phase4 watch 6 of 15 observed, 0 vetoed; 2 in Agent Todo unclaimable by scheduled lanes (medium/high risk or requires_local) (def67890, 1a2b3c4d); stale claims 0 blocking, 1 leftover (5e6f7a8b)`
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
      'title', title,
      -- perpetual canaries are deliberate standing tripwires: report them,
      -- never grade them. Marker-matched, never a hardcoded id, so any
      -- fork's own canaries get the same split.
      'is_canary', (coalesce(title, '') || ' ' || coalesce(desired_outcome, ''))
                     ~* 'perpetual'
                   and (coalesce(title, '') || ' ' || coalesce(desired_outcome, ''))
                     ~* '(canary|tripwire)'
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
        when status in ('Agent Needs Input', 'Agent Review')
          and claim_expires_at is null then 'blocking'
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

`stale_claims_outside_working` reports every non-Working row that carries a
`claimed_by` with an expired or null expiry, but `severity` separates two
genuinely different shapes:

- **`blocking`** is reserved for `claim_expires_at is null` on a resumable
  status. That is the reaper's manufactured-dead shape (`claimed_by` retained,
  expiry NULLed) and the only one no verb could historically move. The
  reaper's dead-letter fix (`20260724_reaper_deadletter_clears_claim`) stops
  the reaper from creating it, so this count should now sit at 0; a non-zero
  `blocking` is a real tripwire that some other path minted a null-expiry
  claim.
- **`leftover`** covers a `claim_expires_at < now()` (past, non-null) claim on
  ANY status, including `Agent Needs Input` / `Agent Review`. A past expiry
  there is NOT stuck: an `Agent Review` row is applied by the closeout by task
  id regardless of its claim, an `Agent Needs Input` hold is still resumable by
  its owner (resume/answer match on the `claimed_by` string, not the expiry),
  and either is foldable to `Agent Todo` by
  `admin_amend_agent_task(release_claim)`. Report these quietly with ids.

A LIVE claim on a resumable row (`claim_expires_at > now()`) is excluded by the
predicate entirely, which is correct: that claim is doing its job.

## Scheduling

A scheduled runtime owns the sentinel. Run daily after the triage and executor
slots have fired, so the sentinel observes a completed morning rather than an
in-progress one.

If the automation system has timezone ambiguity, schedule by explicit UTC for
the current season and note the daylight-saving follow-up.
