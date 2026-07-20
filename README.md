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
│   ├── migrations/       # 11 SQL migrations, applied in order
│   └── functions/        # 4 Edge Functions (Deno)
│       ├── _shared/
│       │   └── profile.json   # your copy of profile.example.json (gitignored)
│       ├── ingest-thought/
│       ├── open-brain-mcp/
│       ├── brain-digest/
│       └── compile-pages/
├── dashboard/            # Next.js app (merged via git subtree)
├── docs/                 # deploy walkthrough, Slack setup, per-source guides
├── skills/
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
- **MCP task tools:** ~29 guarded tools surface the board through MCP, spanning **task lifecycle** (`list_agent_tasks`, `get_agent_task`, `claim_next_agent_task` / `claim_specific_agent_task`, `update_agent_task`, `complete_agent_task`, `block_agent_task` / `unblock_agent_task`, `hold_agent_task`, `fail_agent_task`), **review/apply** (`request_agent_review`, `apply_agent_task_review`, `resume_agent_task`, `answer_agent_task`), **intake** (`create_agent_task_from_action_item` / `_from_thought` / `_intake`, `promote_agent_task_intake`, `create_agent_task_follow_up`), **operator actions** (`complete_operator_action`, `reroute_operator_action_task`), the **advisory critic** (`record_critic_verdict`), **action-item defer** (`list_open_action_items`, `resolve_action_item`, `defer_action_item`, `restore_action_item`), **ledger receipts** (`read_agent_ledger`, `write_agent_ledger`), and **claim maintenance** (`release_expired_agent_claims`). A heartbeat guard prevents `update_agent_task` from silently resuming a `Human Hold` or `Blocked` task; resume / unblock / answer are explicit transitions.
- **Queue Runner skill:** [`skills/queue-runner/SKILL.md`](skills/queue-runner/SKILL.md) walks an operator-driven runtime through one heartbeat at a time: read the project guidance, claim the oldest eligible task, do exactly one task, write a receipt, stop.
- **Scheduled executor lane (OE-9):** [`integrations/open-engine-executor/`](integrations/open-engine-executor/README.md) is an opt-in daily routine that claims one low-risk `claude-code` task and actually executes it, exiting through an honest receipt into Agent Review. It is bounded to one claim per run, low risk only, agent-code scoped, and never touches canonical state — the OE-7/OE-8 apply layer stays human/controlled. Run it as a local scheduled task or a machine-independent cloud routine.

For deeper background, see Nate's posts and the Open Engine specification text Brain Bank's adaptation is built against.

## Trust model

Brain Bank assumes a **single trusted operator**. Every Edge Function endpoint is gated by a shared secret (`MCP_ACCESS_KEY` for MCP / REST, the Slack signing secret for Slack inbound), but the engine does not implement per-key rate limiting, per-tenant isolation, or quotas. A leaked key allows an attacker to write captures and read all stored thoughts until the key is rotated. The mitigations are upstream:

- Set a per-month spend cap on your OpenRouter account so a leaked key cannot drain unlimited LLM credits.
- Rotate `MCP_ACCESS_KEY` immediately if you suspect a leak (see [`docs/troubleshooting.md`](docs/troubleshooting.md) for the full rotation path).
- Set `DASHBOARD_ORIGIN` in `.env` to your dashboard's origin (e.g. `https://brain.example.com`) to scope browser-callable origins instead of the open `*` default.

If you intend to expose Brain Bank to multiple users or untrusted callers, place a Cloudflare Worker, API Gateway, or similar enforcement layer in front of the Edge Functions. The full threat model is documented in [`SECURITY.md`](SECURITY.md), and security reports go through GitHub Security Advisories.

## Status

**v0.5.0 current stable** (2026-07-10): adds the Open Engine human-facing layer. A read-only operator briefing renders a Session Operating Map — what happened on the board, then what needs you — with every waiting item bucketed by action type and its work one click away, backed by a persistent `Needs Operator` board status that gives personal-action items a home between review and done. A draft-safe `triage` lane reads open action items and creates Standing drafts only (never promotes), with an append-only `agent_run_log` and the `oe_triage_watch_days` / `oe_triage_watch_streak` views making clean-day evidence query-backed and immutable — the gate for the still-opt-in auto-promote path (five consecutive clean days). An advisory cross-runtime critic records one verdict per finished task from a different runtime than the executor (advisory only: it never moves task status); a read-only operations sentinel reports board health and expired claims; and a `security_invoker` scorecard view grades first-try pass-rate per agent and task type. Operator-gated `resolve_action_item` / `defer_action_item` / `restore_action_item` tools plus a `deferred` status let paused work leave the open pool reversibly. Under the hood: closeout-controller hardening (journaling before apply, marker-guarded appends, tighter operator-target validation) now covered by a node test suite in CI, compile-pages fairness and quarantine improvements, and capture-side reliability fixes. The OE-12 Phase 4 auto-promote tool itself is **not** in this release — v0.5.0 ships only the readiness watch that gates it. This continues the Open Engine line from the 0.4.x releases (OE-5 through OE-10: scheduled Queue Runner, draft-safe intake, the OE-7 review/apply contract, state-guard hardening, the OE-8 closeout controller, the OE-9 scheduled executor lane, and `claim_specific_agent_task`). Canonical state still only changes through the human-controlled OE-7/OE-8 apply layer; nothing in this release promotes or executes on its own. See [`CHANGELOG.md`](CHANGELOG.md) for the full entry. Prior releases (v0.4.x, v0.3.x, v0.2.x, v0.1.x) are summarized there too.

## Inspired by

Nate Jones' semantic memory build series was the starting point and remains the clearest introduction to the underlying design. Brain Bank is an independent implementation of those ideas, extended with proactive digest delivery, cross-reference briefings, a wiki compilation layer, and auto-resolution of action items.

## Contributing

Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) for the workflow, then [`docs/new-contributor-notes.md`](docs/new-contributor-notes.md) for the traps: Windows setup, the gitignored `profile.json` that has to exist before anything type-checks, and what CI actually enforces.

## Contributors

- Dave Tedder, maintainer and original operator.
- Claude Code and Codex, AI coding collaborators used for implementation, audits, docs, release preparation, and verification under human review.

## License

MIT. See [LICENSE](LICENSE).
