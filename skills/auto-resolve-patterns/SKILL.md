---
name: auto-resolve-patterns
description: Use when editing checkAutoResolve, any LAYER 0/1/1.5/2/3/3.5 guard, the auto-resolve prompt or model, or either mirrored capture function at supabase/functions/ingest-thought/index.ts and supabase/functions/open-brain-mcp/index.ts.
type: skill
---

# Auto-Resolve Patterns

`checkAutoResolve()` uses six defenses in order. Do not remove or reorder them without a regression test that proves the replacement behavior.

1. **LAYER 0, mechanical-source block.** Sync jobs, email threads, weekly reviews, and profile-defined mechanical prefixes cannot resolve action items.
2. **LAYER 1, candidate scoping.** The SQL RPC filters open items by project, topic, or person overlap and excludes the current source thought.
3. **LAYER 1.5, restatement guard.** A new note that repeats its own extracted action item is treated as another capture of the work, not completion.
4. **LAYER 2, LLM decision.** `anthropic/claude-sonnet-4.6` receives the byte-identical six-rule prompt from both capture functions. Readiness and still-to-do markers never prove completion. Responses are parsed with `_shared/extract-json.ts` and parse failures return no matches.
5. **LAYER 3, subject-coverage guard.** `subjectCoverage()` in `_shared/quote-coverage.ts` (single source) requires that at least `SUBJECT_COVERAGE_THRESHOLD` (0.4) of the candidate description's content tokens (generic verbs and function words dropped, then stemmed) appear in the model's quoted completion reason. It replaced Jaccard overlap against the quote, which punished the long, precise quotes LAYER 2 asks for. Every LAYER 0 to 3.5 outcome is written to `auto_resolve_decisions` through `_shared/decisions.ts`, so a dropped or accepted candidate is auditable after the fact.
6. **LAYER 3.5, still-owed adjacency veto.** `_shared/still-owed-veto.ts` blocks a resolution when a candidate subject sits within six tokens of a conservative still-owed marker such as `queued`, `remaining`, `pending`, or `deferred`.

## Mirror Invariants

Keep these behavior-identical in both capture functions:

- The LAYER 2 model string and prompt block.
- The stemmer and subject-coverage threshold (single-source in `_shared/quote-coverage.ts`; test there, not in both capture files).
- The LAYER 3.5 invocation and fail-closed parse wiring.
- Candidate scoping, exclusions, and update behavior.

Shared helpers under `supabase/functions/_shared/` are single-source and do not need duplicated implementations.

## Required Verification

Run the focused helper and source-contract tests, the existing metadata/RPC/done-filter wiring tests, and `deno check` for both Edge Functions. The paid comparison harness at `scripts/auto-resolve-ab-test/run.mjs` is optional unless a local gitignored `OPENROUTER_API_KEY` is already available or the operator explicitly approves API spend.

Do not deploy functions while performing an OSS-only port. Never retrieve production credentials merely to run the paid harness.
