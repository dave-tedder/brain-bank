# Contributing to Brain Bank

Thanks for your interest. Brain Bank is an open-source semantic memory engine maintained as a single-maintainer project, so contributions are welcome but the bar for merging is "this fits the engine's direction" plus "this is testable enough to verify."

This document covers how to file an issue, how to submit a pull request, the conventions the codebase follows, and what to expect from the review process. For security issues, see [SECURITY.md](SECURITY.md) instead — those go through GitHub Security Advisories, not public PRs.

## Discussions Before Code

If you are about to write more than ~50 lines, please open a GitHub issue first describing the change and the problem it solves. Engine-level changes (new Edge Functions, new MCP tools, schema changes, prompt changes) benefit most from upfront alignment. Bug fixes and doc improvements can go directly to a PR.

## Development Setup

The full first-deploy walkthrough is in [docs/deploy-from-scratch.md](docs/deploy-from-scratch.md). At minimum, contributors need:

- A Supabase project (free tier is fine for dev work).
- Node.js 18+ for the dashboard, Deno 2.x for the Edge Functions.
- An OpenRouter account with a low spend cap if you want to exercise capture/digest end-to-end.
- A copy of `profile.example.json` saved as `profile.json` at `supabase/functions/_shared/profile.json` (gitignored). Edit values to match your own use case.

## Submitting a Pull Request

1. Fork the repo and clone your fork.
2. Branch from `dev` (not `main`). The `dev` branch carries the in-progress `[Unreleased]` work; `main` only moves on tagged releases.
3. Make your changes following the conventions below.
4. Run the verification commands below before pushing.
5. Open a PR targeting `dev`. Include a short description of what changed and why.
6. Reference any related issue (e.g., "closes #42").

PRs that touch live behavior should describe the test plan: what you ran, what you observed, and how a reviewer can repeat it.

## Conventions

These are the same conventions documented in [AGENTS.md](AGENTS.md) at the repo root.

- **Commit per task.** Each finished task is its own commit and a rollback point. Do not batch unrelated changes into one commit. Cosmetic sweeps (typo fixes, single-line tweaks across multiple files) can share one commit if they are clearly one task.
- **Migrations.** Schema changes live in `supabase/migrations/` as `<NNNN>_snake_case_description.sql`. Write the file first, apply it (via the Supabase CLI or Supabase MCP), then commit.
- **Secrets.** Every secret is an env var read via `Deno.env.get()` (Edge Functions) or `process.env.*` (dashboard). Never hardcoded. `.env.example` is the canonical inventory; new secrets must land there with a "where to find" pointer and a "WHY" line.
- **Profile customization.** Operator-specific vocabulary, personas, and calendar filters live in `profile.json` (gitignored). The repo ships `profile.example.json` with neutral defaults. Do not commit operator-specific strings to source.
- **Mirror invariants.** Two Edge Functions (`ingest-thought` and `open-brain-mcp`) share parallel implementations of `checkAutoResolve`, `extractMetadata`, the `MECHANICAL_CAPTURE_PREFIXES` block, and the LAYER 0-3 auto-resolve guards. Any change to one must land in lockstep in the other. The audit log at `docs/superpowers/specs/2026-04-20-auto-resolve-byte-identity-audit.md` has the full inventory.

## Verification Before You Push

Run all of these from the repo root. All must pass.

```bash
# Edge Function type check (4 functions in one pass)
deno check supabase/functions/*/index.ts

# Dashboard type check
cd dashboard && npx tsc --noEmit

# Unit tests
deno test --allow-read tests/_shared/profile_test.ts

# Plugin manifest validation
claude plugin validate .
```

If you change Edge Function code, also redeploy to a throwaway Supabase project and exercise the changed code path before opening the PR. "Type-check passes" is not the same as "the function still works." See [docs/deploy-from-scratch.md](docs/deploy-from-scratch.md) for the throwaway-project recipe.

If you change the auto-resolve pipeline (LAYER 0-3 guards, the LLM prompt block, or the mirror invariants), also run the byte-identity check at `tests/_shared/byte_identity_*` if relevant, and document the test plan explicitly in the PR.

## Code Style

There is no strict formatter required at this point. Match the surrounding style of the file you are editing. Specifics:

- TypeScript / TSX: existing files use 2-space indentation, double quotes for strings, trailing commas in multi-line literals.
- SQL: lowercase keywords, snake_case identifiers, one statement per line.
- Markdown: GitHub-flavored. Code blocks need language tags. No em dashes; use commas, periods, or parentheses instead.
- Comments: explain WHY, not WHAT. Skip a comment if removing it wouldn't confuse a future reader.

## Documentation Changes

Doc-only PRs are welcome. The most useful are:

- Fixes to `docs/deploy-from-scratch.md` when a step has drifted from CLI behavior or the Supabase dashboard UI.
- Additional troubleshooting symptoms in `docs/troubleshooting.md` based on issues you actually hit.
- New capture-source guides under `docs/capture-sources/` if you wire up an integration the project does not yet cover.

For doc-only PRs, the verification commands above can be skipped, but `claude plugin validate .` is still cheap insurance.

## What Will Get Rejected

- Large, unscoped refactors with no preceding issue.
- Changes that introduce operator-specific vocabulary or domain assumptions into engine code (move them to `profile.json` instead).
- Changes that pass type-check but were not actually exercised against a Supabase deploy.
- New runtime dependencies in Edge Functions without a clear rationale (Deno + supabase-js + zod is the current surface).
- Changes that break the mirror invariants between `ingest-thought` and `open-brain-mcp` without updating both files in lockstep.

## Review Timeline

Best-effort, typically within 1-2 weeks for non-trivial PRs. Doc fixes and small bug fixes usually move faster.

## License

By contributing, you agree that your contributions are licensed under the MIT License (see [LICENSE](LICENSE)). Do not contribute code you do not have the right to license under MIT.
