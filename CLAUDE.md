# Brain Bank

Personal semantic memory system. Captures thoughts from multiple sources, exposes them via semantic search, delivers proactive morning digests, and auto-maintains compiled wiki pages. Destined for public open-source release under MIT once sanitized.

## Current Status

**Phase 0 — scaffolding.** Repo is initialized with LICENSE, README, .gitignore, and this file. No code yet. The project management and session history for this work lives in the parent Open Brain directory (sibling path `../Open Brain/`), which is the private working archive tracking the open-sourcing effort.

This repo will be populated in sequence:

- Phase 1: Security — rotate secrets in the live instance (happens in the Open Brain working archive, not here)
- Phase 2: Schema capture — commit backfill migrations for all tables
- Phase 3: Engine build — sanitized edge function code + profile config layer
- Phase 4: Docs — README expansion, per-capture-point dummies guides
- Phase 5: Dashboard merge — `git subtree add` the dashboard repo
- Phase 6: Fresh deploy test — stand this up from scratch against a throwaway Supabase
- Phase 7: Go public — flip visibility

Tracking happens in `../Open Brain/PROJECT-TRACKER.md` (Phase 11) and `../Open Brain/SESSION-LOG.md`.

## Workflow

- **Branching:** `main` = tagged stable releases only. `dev` = active work. Feature branches cut from `dev`.
- **Releases:** tag-based (`v0.1.0`, `v0.2.0`, etc.) with CHANGELOG.md entries. Friends pin to tags, not to `main`.
- **Secrets:** every secret is an env var read via `Deno.env.get()` or `process.env.*`. Never hardcoded. `.env.example` documents required vars.
- **Personal customization:** tattoo-specific vocab, personas, and calendar filters live in `profile.json` (gitignored). Public repo ships `profile.example.json` with neutral defaults.

## Tech Stack (planned)

- **Database:** Supabase (PostgreSQL + pgvector)
- **Compute:** Supabase Edge Functions (Deno)
- **Scheduling:** pg_cron + pg_net
- **Embeddings + metadata:** OpenRouter (text-embedding-3-small + gpt-4o-mini)
- **Digest synthesis:** OpenRouter (Claude Sonnet)
- **Dashboard:** Next.js on Railway
- **Auth (dashboard):** cookie-gate with shared password
- **Capture interfaces:** Slack, MCP, REST API

## Project Structure (planned)

```
brain-bank/
├── README.md
├── LICENSE
├── CLAUDE.md
├── .env.example
├── .gitignore
├── CHANGELOG.md
├── profile.example.json           # neutral defaults; users copy to profile.json
├── supabase/
│   ├── migrations/                # full schema as SQL migrations
│   └── functions/
│       ├── ingest-thought/
│       ├── brain-mcp/             # renamed from open-brain-mcp for public
│       ├── brain-digest/
│       └── compile-pages/
├── dashboard/                     # Next.js app (merged via git subtree from separate repo)
└── docs/
    ├── deploy-from-scratch.md
    ├── slack-setup.md
    ├── capture-sources/
    │   ├── gmail-bridge.md
    │   ├── calendar-sync.md
    │   ├── apple-notes.md
    │   ├── voice-capture.md
    │   ├── notion-sync.md
    │   └── chatgpt-gpt.md
    └── troubleshooting.md
```

## Conventions

- One commit per completed task. No batching.
- Each task is a rollback point.
- Migrations live in `supabase/migrations/` as `YYYYMMDD_snake_case_description.sql`. Always write the `.sql` file first, apply, then commit.
- All function renames, schema changes, and env var additions go in CHANGELOG.md with a "Breaking" tag.
- No personal data, client names, or Tedder-specific references in any committed file.

## Privacy / Publication Gate

This repo is PRIVATE and stays that way until the owner explicitly says to publish. Before flipping visibility:

- All live secrets rotated (never appeared in this repo's git history)
- Fresh-deploy walkthrough verified by standing up a throwaway Supabase from just this repo
- `.env.example` complete
- README, LICENSE, CHANGELOG.md in place
- Dashboard merged as monorepo
- Third-party inspiration (Nate Jones) credited in README

Until all six are true: DO NOT make this repo public.
