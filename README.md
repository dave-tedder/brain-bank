# Brain Bank

Personal semantic memory for knowledge workers. Capture thoughts from anywhere, search them back when you need them, and wake up to a synthesized digest of what mattered yesterday delivered to Slack every morning. A self-hosted Next.js dashboard at `dashboard/` is the primary surface for browsing captures, projects, wiki pages, search, and the manual Open Engine task board.

## What it does

Every thought that passes through your day (a Slack note to yourself, an email you flagged, a calendar event, a voice memo, a note you pasted into an MCP client) gets an embedding, a set of extracted metadata, and a permanent home in Postgres. From there:

- **Semantic search** over everything you've captured, via an MCP server or REST API.
- **Proactive morning digests** delivered to Slack with yesterday's narrative, today's meeting briefings, open action items, and client cross-references.
- **Auto-compiled wiki pages** for people, topics, and projects that come up often, regenerated as the underlying captures change.
- **Action-item tracking with auto-resolution** that recognizes when a follow-up thought indicates something got done and closes the loop without manual bookkeeping.
- **Open Engine task board** at `dashboard/tasks` for queuing agent work packets with explicit risk, claim, and receipt rules. The Queue Runner skill at [`skills/queue-runner/SKILL.md`](skills/queue-runner/SKILL.md) walks an operator-driven runtime through one heartbeat at a time, and an opt-in scheduled executor lane ([`integrations/open-engine-executor/`](integrations/open-engine-executor/README.md)) can run one low-risk task per day autonomously. Every lane is bounded to one claim per run, and canonical state stays behind the human/controlled apply layer.

Brain Bank is an engine plus a dashboard. You bring the captures (Slack, Gmail, calendar, voice, Apple Notes, Notion, a ChatGPT custom GPT, or anything that speaks MCP or a plain REST POST). It stores, synthesizes, and surfaces the rest, and you drive the manual task board from the dashboard or the MCP task tools.

Release notes for every cut, including the current one, live in [`CHANGELOG.md`](CHANGELOG.md).

## Architecture

At a glance:

- **Postgres + pgvector** on Supabase for storage and HNSW vector indexing
- **Supabase Edge Functions** (Deno) for four worker services: `ingest-thought` (capture router), `open-brain-mcp` (MCP server + REST API), `brain-digest` (morning synthesis), `compile-pages` (wiki builder)
- **pg_cron + pg_net** for scheduled work (daily and weekly digests, nightly page compilation)
- **OpenRouter** for model access (OpenAI embeddings, GPT-4o-mini for metadata extraction, Claude Sonnet for digest prose)
- **Next.js dashboard** (in `dashboard/`) for browsing captures, projects, wiki pages, search, past digests, chat over your memory, and the manual Open Engine task board
- **Slack** as the primary capture surface and delivery channel for the digest

Everything on the backend is stateless. Secrets live in Supabase's vault, so key rotation is a one-row update.

## Hosted dashboard

The `dashboard/` directory is a Next.js app that runs as a long-lived web service, not part of the Supabase Edge Function deploy. It is the primary surface for day-to-day operator use: browsing captures, projects, wiki pages, search, past digests, chat over your memory, and the manual Open Engine `/tasks` board.

**Deploy guide: [`docs/dashboard-deploy.md`](docs/dashboard-deploy.md)**, covering Railway and Vercel step by step, the six required env vars and which surface each one breaks, and the middleware check you should run after your first deploy.

The reference deployment runs on Railway with the standalone Next.js output target. Vercel works too; set the root directory to `dashboard/` and leave `output: "standalone"` alone if you plan to contribute back, since it is there for Railway.

- Build root: `dashboard/` (not the repo root, on either platform)
- Watch pattern: `dashboard/**` (Railway only rebuilds when files under this path change)
- Required env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`, `DASHBOARD_PASSWORD`, `BRAIN_BANK_URL`, `BRAIN_BANK_API_KEY`
- Node 20 (see `dashboard/.nvmrc`)

The last two env vars do not fail the build when missing; they fail `/chat` at request time, which is why they are the two people forget.

See [`dashboard/README.md`](dashboard/README.md) for env-var details, the Railway watch pattern, the standalone-output gotcha, and the local-dev quickstart. [`dashboard/AGENTS.md`](dashboard/AGENTS.md) is the agent-facing companion with file-by-file conventions.

The dashboard is optional for the engine itself. If you only want Slack capture and morning digests, you can skip `dashboard/` entirely.

## Personal customization via profile.json

Every part of the engine that references your specific vocabulary (what you call your clients, what kinds of content you produce, which calendar events count as "business") reads from a gitignored `profile.json`. The repo ships `profile.example.json` with neutral defaults. Copy, edit the fields to match your work, save. That's it.

This is why a tattoo studio and a software consultancy can share the same engine without either one leaking through the other's digest prose. See [`profile.example.json`](profile.example.json) for the schema.

## Prerequisites

Needed:

- A [Supabase](https://supabase.com) account (free tier works for a personal instance)
- An [OpenRouter](https://openrouter.ai) account (set a monthly spend cap; typical usage runs $5-$15/month)
- Node 18+ and the [Supabase CLI](https://supabase.com/docs/guides/cli)
- Git

Needed for the Slack capture and digest delivery flow (the main way to use it):

- A [Slack workspace](https://slack.com) where you can create an app

No local Docker, no Postgres install, nothing else.

## Quickstart

The short path to a working backend:

1. Clone the repo and link it to a fresh Supabase project.
2. Copy `profile.example.json` to `supabase/functions/_shared/profile.json` and `.env.example` to `.env`. Edit both.
3. Run the migrations against your Supabase project.
4. Deploy the four Edge Functions.
5. Configure the Slack app and point it at your function URLs.

```bash
git clone https://github.com/dave-tedder/brain-bank.git
cd brain-bank
# profile.json MUST live next to the loader that imports it — the Supabase
# bundler resolves the import relative to the source file, so any other path
# fails the deploy with "Failed to bundle ... Module not found".
cp profile.example.json supabase/functions/_shared/profile.json
cp .env.example .env
# Edit both files with your values

supabase login
supabase link --project-ref <your-project-ref>
supabase db push
supabase functions deploy ingest-thought open-brain-mcp brain-digest compile-pages
```

The full end-to-end setup (Slack app, cron jobs, dashboard, capture integrations) is covered in [`docs/deploy-from-scratch.md`](docs/deploy-from-scratch.md) and takes about thirty minutes start to finish.

If `supabase functions deploy` fails with "Project not found," check that `supabase link` finished successfully. If an Edge Function returns 500, open the Supabase Dashboard at Project → Edge Functions → [function] → **Logs** to see the real error (the `supabase functions logs` CLI subcommand was removed in CLI v2.75; see `docs/troubleshooting.md` Section 1).

## Project Structure

```
brain-bank/
├── supabase/
│   ├── migrations/       # SQL migrations, applied in order by `supabase db push`
│   └── functions/        # Edge Functions (Deno). The quickstart deploys the 4 core ones.
│       ├── _shared/
│       │   └── profile.json   # your copy of profile.example.json (gitignored)
│       ├── ingest-thought/    # core: capture router
│       ├── open-brain-mcp/    # core: MCP server + REST API
│       ├── brain-digest/      # core: morning synthesis
│       ├── compile-pages/     # core: wiki builder
│       ├── classify-edges/    # optional: typed thought-to-thought relations
│       └── queue-runner/      # optional: Open Engine claim heartbeat
├── dashboard/            # Next.js app (merged via git subtree)
├── docs/                 # deploy walkthrough, Slack setup, per-source guides
├── integrations/         # per-source capture bridges and scheduled-lane prompts
├── scripts/open-engine/  # closeout controller, probes, deliverables push/sweep,
│                         #   worktree rescue + read-only janitor
├── scripts/hooks/        # PreToolUse guards (opt-in; wire in .claude/settings.json)
├── skills/               # Claude Code skills, one folder each (see the table in skills/README.md)
│   └── brain-bank-setup/                    # guided first-deploy wizard
│       ├── SKILL.md
│       ├── references/                      # slack-branch, cron-branch, error-recovery
│       └── scripts/byte-check.sh            # Tier 1 static analysis
├── profile.example.json  # copy to supabase/functions/_shared/profile.json and edit
├── .env.example          # every env var required by the deploy
└── CHANGELOG.md
```

**Skills:** Claude Code skills live in `skills/<name>/SKILL.md`. They are auto-discovered when brain-bank is installed as a plugin, but Claude Code does NOT scan a repo-root `skills/` folder when simply running inside a clone — the committed `.claude/skills/<name>` symlinks register them for the Skill tool. Fresh clones on macOS/Linux get working symlinks from git automatically; on Windows, enable Developer Mode (or `git config core.symlinks true` before cloning) so git checks them out as real symlinks.

## Open Engine task board

Open Engine is Nate B. Jones' framework for human-controlled, queued agent work. Brain Bank's adaptation keeps the human in control of what enters the queue and how canonical state changes, while offering progressively more automation for claiming and executing work. It ships as:

- **Schema:** `agent_tasks`, `agent_task_events`, `agent_task_ledger` (service-role-only RLS). Each task carries a status (`Standing`, `Agent Todo`, `Doing`, `Human Hold`, `Blocked`, `Review`, `Needs Operator`, `Done`, `Archived`), a risk band (`low`, `medium`, `high`), an `agent_code` runtime, and a receipt history.
- **Dashboard board:** the protected `dashboard/tasks` page lets you create packets, move tasks through Open Engine statuses, edit core fields, filter by status / agent / risk, and inspect a per-task event timeline plus a runtime ledger panel.
- **MCP task tools:** ~34 guarded tools surface the board through MCP, spanning **task lifecycle** (`list_agent_tasks`, `get_agent_task`, `claim_next_agent_task` / `claim_specific_agent_task`, `update_agent_task`, `complete_agent_task`, `block_agent_task` / `unblock_agent_task`, `hold_agent_task`, `fail_agent_task`), **review/apply** (`request_agent_review`, `apply_agent_task_review`, `resume_agent_task`, `answer_agent_task`), **intake** (`create_agent_task_from_action_item` / `_from_thought` / `_intake`, `promote_agent_task_intake`, `create_agent_task_follow_up`), **operator actions** (`complete_operator_action`, `reroute_operator_action_task`), the **advisory critic** (`record_critic_verdict`), **action-item defer** (`list_open_action_items`, `resolve_action_item`, `defer_action_item`, `restore_action_item`), **ledger receipts** (`read_agent_ledger`, `write_agent_ledger`), **claim maintenance** (`release_expired_agent_claims`), the **ops-correction escape hatch** (`admin_amend_agent_task`, human/ops only, which also authors or clears a `close_check`), the opt-in **auto-promote** path (`auto_promote_agent_task_intake`), and **deliverable artifacts** (`put_deliverable`, `get_deliverable`, `list_deliverables`) for a runtime with no local disk. A heartbeat guard prevents `update_agent_task` from silently resuming a `Human Hold` or `Blocked` task; resume / unblock / answer are explicit transitions.
- **Queue Runner skill:** [`skills/queue-runner/SKILL.md`](skills/queue-runner/SKILL.md) walks an operator-driven runtime through one heartbeat at a time: read the project guidance, claim the oldest eligible task, do exactly one task, write a receipt, stop.
- **Scheduled executor lane (OE-9):** [`integrations/open-engine-executor/`](integrations/open-engine-executor/README.md) is an opt-in daily routine that claims one low-risk `claude-code` task and actually executes it, exiting through an honest receipt into Agent Review. It is bounded to one claim per run, low risk only, agent-code scoped, and never touches canonical state — the OE-7/OE-8 apply layer stays human/controlled. Run it as a local scheduled task or a machine-independent cloud routine.

- **Board-hygiene reconciler lane (optional, ships disarmed):** [`skills/open-engine-reconciler/SKILL.md`](skills/open-engine-reconciler/SKILL.md) plus `scripts/open-engine/reconcile-probe.mjs`. It exists for the drift that has no other fix: you publish the page or claim the listing by hand, nothing tells the board, and the card re-surfaces as "needs you" forever. A card opts in by carrying a packet-authored `close_check` (a probe from a fixed four-verb allowlist: `http_contains`, `wp_post_status`, `git_path_exists`, `git_commit_contains`), and the lane closes it only on an exact match, through the ordinary `complete_operator_action` path with the evidence in the note. **Close-only by construction:** there is no code path that reopens, re-flags, re-prioritizes or otherwise mutates a card, and none that touches any status other than `Needs Operator`, so the whole risk surface is a single failure mode. A card with no `close_check` is never probed. Setup, including the permission grants that do not travel with a clone, is in the skill; the recommended first move is to schedule it with zero eligible cards so every run is a provable no-op while you watch the unattended path.
- **Worktree-stranded deliverables (three layers, all opt-in except the write rule):** if your runtime executes sessions in a git worktree — Claude Code spawns one per task chip — a deliverable written there is unreachable by every reader in this system while the receipt naming it stays perfectly honest, and it dies with the worktree. Deliverables are therefore written to the main checkout by absolute path and the receipt asserts reachability with `@ MAIN-VERIFIED`; [`scripts/hooks/block-worktree-deliverable-write.sh`](scripts/hooks/block-worktree-deliverable-write.sh) denies a worktree-local write and returns the corrected path (fail-open by construction — any internal error allows the write); and [`scripts/open-engine/worktree-rescue.sh`](scripts/open-engine/worktree-rescue.sh) adopts stranded files while **never** overwriting a file that differs on both sides. Setup, including the permission grants that do not travel with a clone, is in [`scripts/open-engine/README.md`](scripts/open-engine/README.md).
- **Honest out-of-band close (no lane required):** if you would rather not run the reconciler at all, `admin_amend_agent_task` can move a held card onto the Needs Operator desk stating which step was performed, and `complete_operator_action` closes it. That is the whole Track A path, and it is what stops the alternative: an agent writing a receipt that claims it did work you did by hand.

For deeper background, see Nate's posts and the Open Engine specification text Brain Bank's adaptation is built against.

## Trust model

Brain Bank assumes a **single trusted operator**. Every Edge Function endpoint is gated by a shared secret (`MCP_ACCESS_KEY` for MCP / REST, the Slack signing secret for Slack inbound), but the engine does not implement per-key rate limiting, per-tenant isolation, or quotas. A leaked key allows an attacker to write captures and read all stored thoughts until the key is rotated. The mitigations are upstream:

- Set a per-month spend cap on your OpenRouter account so a leaked key cannot drain unlimited LLM credits.
- Rotate `MCP_ACCESS_KEY` immediately if you suspect a leak (see [`docs/troubleshooting.md`](docs/troubleshooting.md) for the full rotation path).
- Set `DASHBOARD_ORIGIN` in `.env` to your dashboard's origin (e.g. `https://brain.example.com`) to scope browser-callable origins instead of the open `*` default.

If you intend to expose Brain Bank to multiple users or untrusted callers, place a Cloudflare Worker, API Gateway, or similar enforcement layer in front of the Edge Functions. The full threat model is documented in [`SECURITY.md`](SECURITY.md), and security reports go through GitHub Security Advisories.

## Status

**v0.8.3 current stable** (2026-07-29): three fixes for agents and contributors reporting things they had not actually checked. A critic lane could declare a deliverable unreachable without ever attempting the fetch, on a guess about its own capabilities; flagging "unverifiable" now requires naming each path actually tried with the concrete failure it returned, since a path you did not run is not a path that failed. A new daily repo-read probe makes the read path visible before a card depends on it, and it reports token presence, HTTP status and response body rather than a status code alone, because `403` covers a token scope refusal, an anonymous rate limit and a sandbox egress-proxy block, and only the body separates them. Metadata extraction could split one request into two action items, orphaning a delivery clause that later read as unhandled work and spawned a duplicate card; a one-request-is-one-item rule now sits in both capture paths. Contributor-facing: the root `deno.json` is finally explained, because it is three lines, nothing visibly references it, and deleting it makes a root-level `deno check` report 79 phantom errors while CI stays green. See [`CHANGELOG.md`](CHANGELOG.md) for the full entry.

**v0.8.2** (2026-07-28): fixes a way for finished work to close cleanly and leave no trace in project history. Closing a card writes two independent systems — `apply_agent_task_review` (an Edge Function, no filesystem) closes the board, and the tracker append, session-log append and capture all live in the local closeout controller. Nothing coupled them and nothing detected a missing second half, so a card applied any way other than through the controller closed **perfectly** — right status, real `AGENT APPLIED` event, honest `applied_by` — while writing no project history at all. The only trace was an absence in a file nobody re-reads. On the origin deployment 7 of 34 non-controller applies had no record, and **two of the seven were low risk**, which killed the obvious theory that the controller's low-only risk gate was the cause; it is the most common route in, not the cause. Two additions close it: `--operator-apply` gives a human a controller path for a non-low card, widening to *every* risk level on purpose because capping it at medium would recreate the hole for high cards, and `--audit-unrecorded` reports applied cards with no record. The `RISK_NOT_LOW` hold message now names the consequence of stepping around it rather than just the gate. See [`CHANGELOG.md`](CHANGELOG.md) for the full entry.

**v0.8.1** (2026-07-27): states the canonical eight-heading receipt contract in `AGENTS.md`, where a session that completes a card will actually see it. It previously lived only in the executor surfaces, which an ad-hoc or chip-spawned session never loads, so such a session invents a reasonable-looking format and the card is unappliable from birth — held on every closeout run, indefinitely, while the critic verdict and the work itself read as fine.

**v0.8.0** (2026-07-27): stops finished work from becoming unreachable without anyone noticing. Some agent runtimes execute a session inside a git worktree and do not tell it. A worktree is a separate working directory, and every reader here resolves the main checkout only — so a deliverable written into one is physically real, is named honestly in the receipt, and cannot be found by the closeout controller, either critic lane, or the deliverables push, then is destroyed when the worktree is removed. The writer cannot detect it either, because every check available inside that session passes. Worse, when the path also exists in main the stranded copy reads as a modified file rather than a new one, so a reader finds a file and reviews the **stale** version with no flag at all. Three layers now cover it: deliverables are written to the main checkout by absolute path and the receipt asserts reachability with `@ MAIN-VERIFIED`; a fail-open `PreToolUse` hook denies a worktree-local write and hands back the corrected path; and a rescue sweep adopts stranded files while **never** overwriting, because a file that differs on both sides has been measured going each direction and copy-newest-wins would destroy live draft content. The critic now separates a missing artifact from an unreachable one and reports `STRANDED_IN_WORKTREE` as a delivery defect rather than "the work was not done". Also here: a read-only worktree janitor with no removal mode by design, and CI finally running the repo's shell test suites, which had passed green by omission since they were written. See [`CHANGELOG.md`](CHANGELOG.md) for the full entry.

**v0.7.0** (2026-07-27): closes the loop on work you finish by hand. Publishing a page, claiming a listing or merging a branch used to leave the board none the wiser — the card sat in a held status and re-surfaced in every briefing as "needs you" forever, and the only route that closed it made an agent write a receipt asserting it had done work a human did. Out-of-band completion now has an honest close path: one widened predicate on `admin_amend_agent_task` (fenced against live claims), the card landing on the desk stating which step was performed, and the existing `complete_operator_action` closing it. No new verb, no new event type. On top of that sits an **optional** reconciler lane that probes real-world state against cards carrying a packet-authored `close_check` and auto-closes only exact matches — close-only by construction, with no code path that reopens, re-flags or touches any status but `Needs Operator`. Also here: the OE-13B executed-check closeout lane for a narrow class of low-risk code task, six new reference skills, four capture integrations, the Phase 4 readiness gate re-based on observed auto-promotions rather than elapsed days, dashboard dependency patches, and a CI fix for a gap that had let most of the test suite go unrun. Every new lane is opt-in, every migration ships unapplied, and canonical state still only changes through the human-controlled apply layer. See [`CHANGELOG.md`](CHANGELOG.md) for the full entry.

**v0.6.0** (2026-07-20) was a hardening and correctness release: constant-time key auth everywhere, method guards, bounded numeric params, fail-closed Slack signature verification, embedding-level near-duplicate rejection on capture, a cloud on-ramp for deliverables, and Open Engine soft-affinity routing, per-run claim tokens, a hard local-runtime constraint, an ops-correction verb, and the opt-in Phase 4 auto-promote path (which ships OFF).

**v0.5.0** (2026-07-10): adds the Open Engine human-facing layer. A read-only operator briefing renders a Session Operating Map — what happened on the board, then what needs you — with every waiting item bucketed by action type and its work one click away, backed by a persistent `Needs Operator` board status that gives personal-action items a home between review and done. A draft-safe `triage` lane reads open action items and creates Standing drafts only (never promotes), with an append-only `agent_run_log` and the `oe_triage_watch_days` / `oe_triage_watch_streak` views making clean-day evidence query-backed and immutable — the gate for the still-opt-in auto-promote path (five consecutive clean days). An advisory cross-runtime critic records one verdict per finished task from a different runtime than the executor (advisory only: it never moves task status); a read-only operations sentinel reports board health and expired claims; and a `security_invoker` scorecard view grades first-try pass-rate per agent and task type. Operator-gated `resolve_action_item` / `defer_action_item` / `restore_action_item` tools plus a `deferred` status let paused work leave the open pool reversibly. Under the hood: closeout-controller hardening (journaling before apply, marker-guarded appends, tighter operator-target validation) now covered by a node test suite in CI, compile-pages fairness and quarantine improvements, and capture-side reliability fixes. The OE-12 Phase 4 auto-promote tool itself is **not** in this release — v0.5.0 ships only the readiness watch that gates it. This continues the Open Engine line from the 0.4.x releases (OE-5 through OE-10: scheduled Queue Runner, draft-safe intake, the OE-7 review/apply contract, state-guard hardening, the OE-8 closeout controller, the OE-9 scheduled executor lane, and `claim_specific_agent_task`). Canonical state still only changes through the human-controlled OE-7/OE-8 apply layer; nothing in this release promotes or executes on its own. See [`CHANGELOG.md`](CHANGELOG.md) for the full entry. Prior releases (v0.4.x, v0.3.x, v0.2.x, v0.1.x) are summarized there too.

## Inspired by

Nate Jones' semantic memory build series was the starting point and remains the clearest introduction to the underlying design. Brain Bank is an independent implementation of those ideas, extended with proactive digest delivery, cross-reference briefings, a wiki compilation layer, and auto-resolution of action items.

## Contributing

Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) for the workflow, then [`docs/new-contributor-notes.md`](docs/new-contributor-notes.md) for the traps: Windows setup, the gitignored `profile.json` that has to exist before anything type-checks, and what CI actually enforces.

## Contributors

- Dave Tedder, maintainer and original operator.
- Claude Code and Codex, AI coding collaborators used for implementation, audits, docs, release preparation, and verification under human review.

## License

MIT. See [LICENSE](LICENSE).
