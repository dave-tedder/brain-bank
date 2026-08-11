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

Annotations only — the entries themselves are what `ls` shows, so this map exists to say
what each one is FOR. Counts are deliberately omitted: they rot, and one command answers
them. Re-verify against `git ls-files` before editing a line here.

```
brain-bank/
├── README.md                  # elevator pitch, quickstart, architecture
├── CHANGELOG.md               # release-by-release ground truth
├── LICENSE                    # MIT
├── AGENTS.md                  # this file (CLAUDE.md is a one-line @AGENTS.md shim)
├── CONTRIBUTING.md            # PR etiquette, what belongs upstream
├── SECURITY.md                # vulnerability disclosure
├── .env.example               # every env var the engine + dashboard read
├── profile.example.json       # neutral profile defaults (operators copy to profile.json, gitignored)
├── deno.json                  # Deno workspace config for the Edge Functions
├── .claude-plugin/            # Claude Code plugin marketplace + plugin manifests
├── .claude/                   # slash commands + skill symlinks that register skills/ with the Skill tool
├── .github/workflows/ci.yml   # the CI that gates every PR
├── supabase/
│   ├── migrations/            # SQL migrations, YYYYMMDD_snake_case.sql
│   └── functions/
│       ├── ingest-thought/    # Slack webhook + auto-resolve LAYER 0-3 pipeline
│       ├── open-brain-mcp/    # MCP server + REST API (tool count: grep -c 'server.registerTool(')
│       ├── brain-digest/      # daily / weekly digest synthesis + Slack post
│       ├── compile-pages/     # Karpathy-style wiki compilation
│       ├── classify-edges/    # typed semantic edges between thoughts
│       ├── queue-runner/      # Open Engine heartbeat: claims / blocks / fails agent tasks
│       └── _shared/           # profile loader + profile.json bundled at deploy
├── dashboard/                 # Next.js dashboard, see dashboard/AGENTS.md
├── skills/                    # triggered skill packs; see skills/README.md for the index
│   ├── brain-bank-setup/      # slash-command-driven first-deploy guide
│   └── _template/             # starting point for a new skill
├── integrations/              # capture-source bridges + Open Engine lane prompts
│   └── _template/             # starting point for a new integration
├── scripts/
│   ├── open-engine/           # closeout controller, deliverables sweep, lane runners
│   ├── auto-resolve-ab-test/  # A/B harness for the mirrored LAYER 2 prompt
│   └── hooks/                 # PreToolUse guards (MCP registration, worktree writes)
├── docs/
│   ├── deploy-from-scratch.md # cold-clone-to-deploy walkthrough
│   ├── slack-setup.md         # Slack app + channel setup
│   ├── troubleshooting.md     # cross-cutting symptom-organized recipes
│   ├── dashboard-deploy.md    # dashboard hosting + env wiring
│   ├── capture-templates.md   # structured prefixes that improve metadata extraction
│   ├── new-contributor-notes.md  # environment traps the maintainer's setup hid
│   ├── capture-sources/       # one guide per integration
│   └── operations/            # daily pipeline schedule, wiki refresh, promotion readiness
└── tests/                     # Deno tests — wiring + contract suites at top level
    └── _shared/               # profile loader tests
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
- **Completing a board card requires the canonical receipt headings.** `complete_agent_task` accepts any text, but the closeout controller parses `REQUIRED_RECEIPT_SECTIONS` as line-anchored headings — Work summary, Verification, Touched files or records, Limitations, Tracker draft, Session-log draft, Brain Bank capture draft, Follow-up recommendation — and an `OPERATOR-ACTION:` marker must sit on its own line INSIDE Follow-up recommendation, unwrapped, with its `|| OPERATOR-TARGET:` on that same line. Plausible substitutes ("What I did", numbered headings) score as missing and the card is held indefinitely while every other signal — the critic verdict, the deliverable, the work itself — reads as fine. Read the list from `scripts/open-engine/closeout-controller.mjs` rather than recalling it, and prove the receipt with `bash scripts/open-engine/closeout-run.sh --task-id <uuid> --live-check` (empty `"hold": []`). This applies to ANY session that completes a card, not just the scheduled lanes: the contract otherwise lives only in `skills/queue-runner/SKILL.md` and the executor surfaces, which an ad-hoc or chip-spawned session never loads. A single batch of chip-spawned sessions once stranded six cards this way at once.
- **Applying a card writes the board; it does NOT write project history.** Those are two independent systems: `apply_agent_task_review` is an Edge Function with no filesystem, and the tracker append, session-log append, and Brain Bank capture all live in `scripts/open-engine/closeout-controller.mjs`. So calling the MCP verb directly closes the card perfectly — right status, real `AGENT APPLIED` event, honest `applied_by` — while writing NO project history, and nothing anywhere reports the omission. Measured on a live board: 7 of 34 non-controller applies left no record, **two of them low risk**, so this is not a medium-risk-only trap; a low card applied by hand from an ad-hoc session hits it identically. Apply through the controller (`bash scripts/open-engine/closeout-run.sh --task-id <uuid> --apply`), adding `--operator-apply` when the card's risk is not low. Never reach for `apply_agent_task_review` to get around a `RISK_NOT_LOW` hold. Detect stragglers with `--audit-unrecorded`. Scheduled lanes must never pass `--operator-apply`: a hold reason is a report, not a command.
- **Deliverables are written to the MAIN checkout, never to a git worktree copy.** Some agent runtimes run a session in a worktree without telling it (Claude Code spawns one per task chip). Every reader — the closeout controller, both critic lanes, the deliverables sweep — resolves the main checkout only, so a file written into a worktree is real, is named honestly in the receipt, and is unreachable by all of them; it is destroyed if the worktree is removed. Worse, when the path ALSO exists in main the stranded copy reads as modified rather than untracked, so a reader finds a file and reviews the stale version with no flag at all. Write by absolute path, then read the file back from main before naming it in a receipt and stamp it `@ MAIN-VERIFIED` (`@ NOT-VERIFIED-FROM-MAIN (<reason>)` if you could not). "I just wrote it" is not verification — it is the exact check that passes while a file is stranded. Enforced by `scripts/hooks/block-worktree-deliverable-write.sh`; `scripts/open-engine/worktree-rescue.sh` is the backstop.
- **Branching:** `main` = tagged stable releases only. `dev` = active work. Feature branches cut from `dev`. Tags drive releases (`v0.1.0`, etc.); friends pin to tags, not to `main`.
- **Session logs:** Codex-authored sessions should update the relevant session log/tracker surfaces before closeout, just as Claude-authored sessions did. If a repo has no local tracker files, record the session in the controlling Open Brain tracker/session log.

## Five capture paths — verify each independently

`processCaptureMessage` (Slack capture channel), `processCaptureThreadReply` (Slack thread replies), `processBrainMessage` (Slack brain channel) in `ingest-thought/index.ts`; `handleRestCapture` (REST `/capture`) and `capture_thought` (MCP tool) in `open-brain-mcp/index.ts`. Both files have parallel `extractMetadata()`, `checkAutoResolve()`, `extractAndStoreActionItems()`, `postCaptureHook()` — any fix must be mirrored. Verification must exercise at least one path per file.

## Where to find what

- **What is Brain Bank, what does it do?** [`README.md`](./README.md)
- **How do I deploy a fresh copy?** [`docs/deploy-from-scratch.md`](./docs/deploy-from-scratch.md), or run `/brain-bank-setup` in Claude Code
- **How do I wire up a capture source?** [`docs/capture-sources/`](./docs/capture-sources/)
- **What capture prefixes improve extraction accuracy?** [`docs/capture-templates.md`](./docs/capture-templates.md)
- **What does a full lane schedule look like?** [`docs/operations/daily-pipeline-schedule.md`](./docs/operations/daily-pipeline-schedule.md)
- **Something is broken.** [`docs/troubleshooting.md`](./docs/troubleshooting.md)
- **What changed in this release?** [`CHANGELOG.md`](./CHANGELOG.md)
- **Dashboard-specific guidance.** [`dashboard/AGENTS.md`](./dashboard/AGENTS.md)

## Windows Local Development Learnings

- **Path Separators in Unit Tests:** Node's native path functions (such as `isAbsolute` and `join`) output Windows-style backslashes (`\`) when running on Windows. Hardcoded unit tests comparing absolute paths against POSIX strings will fail. When asserting path structures, conditionally normalize paths by replacing backslashes with forward slashes (e.g. `path.replace(/\\/g, "/")`) if the mock root uses POSIX slashes or if POSIX outputs are expected.
- **PowerShell Script Execution Policy Locks:** In Windows environments, PowerShell execution policies can prevent the execution of Node.js / CLI script wrappers (npm commands). Use `cmd /c` to execute commands securely and reliably.

## Google Cloud Platform (GCP) Deployment Learnings

- **Windows Secret Injection:** Always write secrets using direct stdin file buffers/parameters in Python rather than command-line `echo` pipes on Windows to prevent trailing space/newline (`\r\n`) validation crashes inside Deno's URL parser.
- **Deno Cloud Run Port Configuration:** Deno 2.x `Deno.serve()` defaults to port `8000`. Cloud Run services deploying Deno containers must specify `--port=8000` to prevent TCP startup health check failures.
- **Cloud Run Deploy Secret Check:** Cloud Run requires all referenced secrets to exist in GCP Secret Manager at deploy time. Dummy secrets (e.g. `"optional"`) must be provisioned on first deploy for optional integrations like Slack.
- **PostgREST Client Suffix Override:** In standalone PostgREST environments, override the internal `client.rest.url` property directly to remove the `/rest/v1` path suffix.
- **Database Role Grants:** On standard vanilla PostgreSQL deployments (like Cloud SQL), you must explicitly run `GRANT [role] TO postgres;` (specifically for `anon`, `authenticated`, and `service_role`) and set `ALTER ROLE service_role BYPASSRLS;` so PostgREST can assume those identities when parsing JWTs.


