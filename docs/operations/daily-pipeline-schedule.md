# Daily Pipeline Schedule (Template)

> Source of truth for the SHAPE of Brain Bank's scheduled capture, delivery, and Open Engine pipeline: the windows, the ordering invariants, and the lane list. This is a TEMPLATE — the example times below are one reference grid, not a requirement. Brain Bank ships no live cron schedule or routine trigger IDs of its own; you create your own pg_cron jobs, Claude Code scheduled tasks, and cloud routines (or Codex-side automations) following `docs/deploy-from-scratch.md` and the per-lane integration READMEs, and you keep your own operator notes on trigger IDs and live status (an operator-local file outside this repo, analogous to how you'd track any other deployment's secrets and IDs).

## Example schedule (illustrative times — substitute your own timezone and preferences)

Overnight (device may be closed; local-scheduler lanes can miss — the sentinel records misses):

- 12:00 AM — Notion sync, or any other capture-source sync you've put on a schedule
- 12:30 / 1:20 / 2:10 AM — Claude executor slots n1-n3 (local scheduler; run one slot or several parallel slots for higher throughput, see `integrations/open-engine-executor/README.md`)
- 12:40 AM — Codex executor n1 = queue-runner (pg_cron, device-independent)
- 1:30 / 2:20 AM — Codex executor slots n2-n3 (Codex app, if you run Codex alongside Claude Code)
- 2:30 AM — Deliverables sweep (repair net; deliberately after the whole executor grid, before the critics)
- 3:00 AM — Critic, Codex lane (Codex app)
- 3:15 AM — Critic, Claude lane (cloud routine)
- 3:45 AM — Closeout, morning (Codex app or local scheduler)
- 4:30 AM — Triage (cloud routine)
- 5:00 AM — Sentinel (cloud routine) — verdict feeds the digest
- 6:00 AM — Brain digest (pg_cron, Slack delivery), includes the `*Ops sentinel:*` line

Afternoon (example second window, e.g. if you're away from your primary device overnight):

- 1:30 PM — Claude executor day (local scheduler)
- 1:45 PM — Codex executor day (Codex app)
- 1:45 PM — compile-pages second slot (pg_cron)
- 4:45 PM — Closeout, afternoon (local scheduler)

Any additional scheduled capture lane you build yourself (a browser-automation agent reading an authenticated web surface on a timer, for example) slots into whichever overnight window finishes before the 6 AM digest — see `integrations/_template/README.md` for the scaffold.

## Invariants

These hold regardless of your actual clock times:

- Every capture/lane that feeds the digest completes before the digest runs.
- Triage runs BEFORE the digest, so the digest reports on an already-triaged board; you promote Standing drafts during your own morning check for the daytime executors to pick up.
- Executors finish before the deliverables sweep, which finishes before the critics; the closeout runs after the critics. Moving the sweep earlier recreates the unpushed-deliverable critic flags it exists to fix.
- The sentinel runs after the last overnight lane so its verdict describes a finished night.
- Pick your own no-automation windows (times you don't want scheduled lanes claiming work — e.g. while you're actively working the board yourself). Local-lane misses during those windows are acceptable; a RECORDED miss (`agent_run_log` + sentinel + digest) is required so a miss is visible, not silent.
- DST: local cron/scheduled-task times on your device never change; any cloud-routine or pg_cron UTC anchor shifts by an hour when your local timezone leaves or enters daylight time.

## Related

- pg_cron patterns (scheduling): `skills/pg-cron-patterns/SKILL.md`
- Cloud-routine platform gotchas: `skills/routines-cloud-tasks/SKILL.md`
- Deploying from scratch (cron/routine setup mechanics, including the digest): `docs/deploy-from-scratch.md`
