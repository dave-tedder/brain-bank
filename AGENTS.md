# Brain Bank

Personal semantic memory system. Captures thoughts from multiple sources (Slack, MCP, REST, Gmail, Calendar, Notion, voice, ChatGPT GPT), exposes them via semantic search, delivers proactive morning digests, and auto-maintains Karpathy-style compiled wiki pages. Designed to be forked, customized via `profile.json`, and deployed against the operator's own Supabase + OpenRouter.

## Current Status

**v0.6.0 shipped 2026-07-20.** Repo is public. The four Edge Functions and the Next.js dashboard are merged into this monorepo and verified end-to-end against fresh-deploy throwaway Supabase projects. Pre-public adversarial audit findings (BLOCKERs, HIGHs, MEDIUMs, LOWs) all landed before the visibility flip. Going forward, `CHANGELOG.md` is the source of truth. `[Unreleased]` covers in-flight work, dated sections cover shipped releases. New work branches from `dev`; `main` carries tagged releases only.

## Tech Stack

- **Database:** Supabase (PostgreSQL + pgvector + pg_cron + pg_net + supabase_vault)
- **Compute:** Supabase Edge Functions (Deno runtime, no build step)
- **Scheduling:** pg_cron + pg_net via the `public.call_edge_function()` vault wrapper
- **Embeddings:** OpenRouter → OpenAI text-embedding-3-small (1536 dims)
- **Metadata + auto-resolve:** OpenRouter → gpt-4o-mini (metadata) + anthropic/claude-sonnet-4.6 (auto-resolve LAYER 2)
- **Digest synthesis:** OpenRouter → Claude Sonnet
- **Dashboard:** Next.js 15 + React 19 + Tailwind 4, deployed on Railway
- **Capture sources:** Slack (signed webhook), MCP, REST, Gmail (Apps Script), Calendar (Apps Script), Apple Notes (Shortcut), voice (Siri Shortcut), Notion (Claude Code routine), ChatGPT GPT

## Project Structure

```
brain-bank/
├── README.md                  # elevator pitch, quickstart, architecture
├── CHANGELOG.md               # release-by-release ground truth
├── LICENSE                    # MIT
├── AGENTS.md                  # this file (CLAUDE.md is a one-line @AGENTS.md shim)
├── .env.example               # every env var the engine + dashboard read
├── profile.example.json       # neutral profile defaults (operators copy to profile.json, gitignored)
├── deno.json                  # Deno workspace config for the Edge Functions
├── .claude-plugin/            # Claude Code plugin marketplace + plugin manifests
├── supabase/
│   ├── migrations/            # SQL migrations, YYYYMMDD_snake_case.sql (75 as of v0.6.0)
│   └── functions/
│       ├── ingest-thought/    # Slack webhook + auto-resolve LAYER 0-3 pipeline
│       ├── open-brain-mcp/    # MCP server (54 tools) + REST API
│       ├── brain-digest/      # daily / weekly digest synthesis + Slack post
│       ├── compile-pages/     # Karpathy-style wiki compilation
│       └── _shared/           # profile loader + profile.json bundled at deploy
├── dashboard/                 # Next.js dashboard, see dashboard/AGENTS.md
├── skills/
│   └── brain-bank-setup/      # slash-command-driven first-deploy guide
├── integrations/              # capture-source bridges (Gmail, Calendar, Notion, etc.)
├── docs/
│   ├── deploy-from-scratch.md # 12-step cold-clone-to-deploy walkthrough
│   ├── slack-setup.md         # 9-step Slack app + channel setup
│   ├── troubleshooting.md     # cross-cutting symptom-organized recipes
│   └── capture-sources/       # one guide per integration
└── tests/_shared/             # Deno tests (profile loader)
```

## Conventions

- **Commit per task.** Each finished task is its own commit and a rollback point. No batching.
- **Migrations:** new schema work lives in `supabase/migrations/` as `YYYYMMDD_snake_case_description.sql`. Write the file first, apply via Supabase MCP or CLI, then commit.
- **Secrets:** every secret is an env var read via `Deno.env.get()` (Edge Functions) or `process.env.*` (dashboard). Never hardcoded. `.env.example` is the canonical inventory.
- **Profile customization:** operator-specific vocabulary, personas, and calendar filters live in `profile.json` (gitignored). The repo ships `profile.example.json` with neutral defaults.
- **Mirror invariant:** the auto-resolve pipeline lives in both `supabase/functions/ingest-thought/index.ts` and `supabase/functions/open-brain-mcp/index.ts`. Any change to the LAYER 2 prompt block, `MECHANICAL_CAPTURE_PREFIXES`, the stemmer, `jaccardTokens`, `quoteOverlap`, or the LOG_TRUNC / RESTATEMENT_THRESHOLD / QUOTE_OVERLAP_THRESHOLD constants must be behavior-identical in both files.
- **SHA-256 content fingerprinting** dedups all capture paths. Dedup runs before embedding/metadata API calls (cheap rejection).
- **Async via `EdgeRuntime.waitUntil()`** to avoid Slack's 3-second timeout.
- **Metadata always returns 7 standard fields:** `people`, `action_items`, `dates_mentioned`, `topics`, `type`, `project`, `priority`, `source`.
- **Edge Function logs URL-encode** — when debugging auth, look for `%60` (backtick), `%20` (space), `%22` (quote) appended to keys.
- **Branching:** `main` = tagged stable releases only. `dev` = active work. Feature branches cut from `dev`. Tags drive releases (`v0.1.0`, etc.); friends pin to tags, not to `main`.
- **Session logs:** Codex-authored sessions should update the relevant session log/tracker surfaces before closeout, just as Claude-authored sessions did. If a repo has no local tracker files, record the session in the controlling Open Brain tracker/session log.

## Five capture paths — verify each independently

`processCaptureMessage` (Slack capture channel), `processCaptureThreadReply` (Slack thread replies), `processBrainMessage` (Slack brain channel) in `ingest-thought/index.ts`; `handleRestCapture` (REST `/capture`) and `capture_thought` (MCP tool) in `open-brain-mcp/index.ts`. Both files have parallel `extractMetadata()`, `checkAutoResolve()`, `extractAndStoreActionItems()`, `postCaptureHook()` — any fix must be mirrored. Verification must exercise at least one path per file.

## Where to find what

- **What is Brain Bank, what does it do?** [`README.md`](./README.md)
- **How do I deploy a fresh copy?** [`docs/deploy-from-scratch.md`](./docs/deploy-from-scratch.md), or run `/brain-bank-setup` in Claude Code
- **How do I wire up a capture source?** [`docs/capture-sources/`](./docs/capture-sources/)
- **Something is broken.** [`docs/troubleshooting.md`](./docs/troubleshooting.md)
- **What changed in this release?** [`CHANGELOG.md`](./CHANGELOG.md)
- **Dashboard-specific guidance.** [`dashboard/AGENTS.md`](./dashboard/AGENTS.md)
