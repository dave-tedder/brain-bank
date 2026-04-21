# Changelog

All notable changes to Brain Bank are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it leaves pre-release.

Entries are written for operators considering a fork. If you see "Breaking" on a change, upgrading will require action on your side (schema migration, env var addition, config edit). Anything else is a quiet improvement.

## [Unreleased]

## [0.1.0-pre] - 2026-04-21

First pre-release snapshot. Everything below represents the initial open-sourcing cut of an engine that has been running in production for the author since March 2026. No prior public release, so nothing here is flagged Breaking.

### Added

- **Database schema as 11 migration files** under `supabase/migrations/`. Includes the `thoughts` table (pgvector embedding column and HNSW index), the `digests` archive, the `compiled_pages` wiki table, auto-resolve action item tables, required extensions (pgvector, pg_cron, pg_net, supabase_vault), RLS policies, and the `call_edge_function` vault wrapper that lets pg_cron call Edge Functions without secrets on disk. Running `supabase db push` from a fresh Supabase project replays the full schema.
- **Four Edge Functions** under `supabase/functions/`: `ingest-thought` (Slack plus thread routing plus the auto-resolve pipeline), `open-brain-mcp` (MCP server with 19 tools plus a REST `/capture` endpoint), `brain-digest` (daily and weekly synthesis), and `compile-pages` (wiki compilation engine). All four run on the Deno runtime with no build step.
- **Profile config layer.** A `profile.example.json` schema with a `loadProfile()` helper and Zod validation. Operators copy the example to `profile.json` (gitignored) and edit it once; the engine reads operator identity, capture prefixes, calendar event types, content types, and LLM persona strings from this file at runtime. Three fixtures under `tests/_shared/fixtures/` exercise the valid, missing-required, and tattoo-studio variants. Why this matters: the engine stays neutral in the public repo. A tattoo studio and a software consultancy can share the same codebase without vocabulary from one bleeding into the other's digests.
- **Root-level `deno.json`** with a Deno 2.x `workspace` field pointing at the four function directories. Lets you run `deno check supabase/functions/*/index.ts` from the repo root and get honest type coverage across all four at once.
- **README** rewritten as a fork-and-deploy pitch. Five-step quickstart, "where to find" pointers on prerequisites, concrete error-recovery hints (for example, if `supabase functions deploy` returns 500, run `supabase functions logs <name>`).
- **`.env.example`** at the repo root enumerating all 11 Edge Function env vars, grouped by domain (Supabase, OpenRouter, MCP access key, Slack, Notion). Each variable carries a "where to find" pointer. Non-obvious ones also carry a "WHY" line. Dashboard env vars are flagged as Phase 5 placeholders and will land when the dashboard merges into the monorepo.

### Changed

- **All four Edge Functions genericized from the author's personal fork.** Six sweep passes across `brain-digest`, `compile-pages`, `open-brain-mcp`, and `ingest-thought` replaced hardcoded tattoo-studio vocabulary, operator emails, mechanical-capture prefixes, and enum values (event types, content types, client event types) with reads from `profile.json`. A final prose-neutralization pass caught framing strings inside LLM prompt templates. Behavior is byte-identical against the author's `profile.json`, and neutral against the shipped example.
- **TypeScript baseline cleaned.** 13 real errors across `brain-digest` and `ingest-thought` cleared via three small type-only edits (row-type broadening, lambda parameter annotations, an `EdgeRuntime` ambient declaration). `deno check` from the repo root now reports zero errors across all four functions.
- **Live production Edge Functions now deploy from the Brain Bank repo** instead of the author's private working archive. Versions after the swap: `ingest-thought` v30, `open-brain-mcp` v33, `brain-digest` v26, `compile-pages` v10. The cutover happened on 2026-04-21 and is being validated through a parallel drift window (silent-observer `-v2` slugs fed from the private archive, compared against the live brain-bank outputs).

### Fixed

- **Edge Function deploys now include `profile.json` in the upload bundle.** The first attempted brain-bank swap returned 500 WORKER_ERROR because the Supabase CLI bundler only uploads files reachable through the import graph, and the earlier runtime `Deno.readTextFileSync` approach left `profile.json` outside that graph. Replaced with a JSON module import (`import profileDefaults from "./profile.json" with { type: "json" }`), which the bundler recognizes as a module-graph edge. A throwaway test function verified the fix before the retry deploy. Why this matters: if you build anything that reads a local file from an Edge Function, make it a module import, not a filesystem read.

### Notes for future readers

- This is a pre-release. The engine is live for the author, but the deploy-from-scratch walkthrough (`docs/deploy-from-scratch.md`) is still being written. The first tagged release (`v0.1.0`) ships once a friend deploys successfully from a cold clone using only the shipped docs.
- The dashboard (Next.js on Railway) is still a separate private repo. It will merge into `dashboard/` via `git subtree add` during Phase 5, after which dashboard env vars get added to `.env.example`.

[Unreleased]: https://github.com/dave-tedder/brain-bank/compare/v0.1.0-pre...HEAD
[0.1.0-pre]: https://github.com/dave-tedder/brain-bank/releases/tag/v0.1.0-pre
