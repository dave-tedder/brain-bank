# Open Engine OE-1 Through OE-4 Promotion Readiness

Date: 2026-06-30

This note audits the Brain Bank `personal-staging` Open Engine stack after the `v0.2.3` release. It prepares an OE-1 through OE-4 promotion checklist only. It does not promote to `dev` or `main`.

## Current Branch State

- Source checkout: `<local-brain-bank-checkout>`
- Source branch: `personal-staging`
- Source head: `5e61497` (`Genericize Open Engine runtime examples`)
- Remote target base: `origin/dev` and `origin/main` at `af978e2` (`docs: prepare v0.2.3 release notes`)
- Local `dev` and `main` are stale relative to origin after the `v0.2.3` promotion. Use `origin/dev`, not local `dev`, as the promotion base.
- Current checkout has known untracked iCloud duplicate `* 2.*` files. Leave them untouched.

## Recommended Safe Batch

Promote OE-1 through OE-4 only, in dependency order:

1. `119d648` `feat(dashboard): add Open Engine tasks board`
2. `7ee9d4a` `fix(dashboard): align task status receipts`
3. `640362a` `fix(dashboard): ignore stale task status submits`
4. `0b4f71a` `Add Open Engine task tools and ledger UI`
5. `f3081fc` `Guard agent task status heartbeats`
6. `9281a69` `port: add queue runner skill from open-brain 53754ca`
7. `2d771e6` `port: add guarded task resume tools from open-brain e8bdded`
8. `5e61497` `Genericize Open Engine runtime examples`

Do not cherry-pick the full `personal-staging` range onto `dev`. `git cherry -v origin/dev personal-staging` shows the older reliability/project commits are patch-equivalent to the `v0.2.3` release, while later OE-5/OE-6 commits remain intentionally held.

## Files Touched By The Recommended Batch

- `CHANGELOG.md`
- `dashboard/src/app/globals.css`
- `dashboard/src/app/tasks/actions.ts`
- `dashboard/src/app/tasks/page.tsx`
- `dashboard/src/components/AgentLedgerPanel.tsx`
- `dashboard/src/components/AgentTaskCard.tsx`
- `dashboard/src/components/AgentTaskFilters.tsx`
- `dashboard/src/components/AgentTaskForm.tsx`
- `dashboard/src/components/NavBottom.tsx`
- `dashboard/src/components/NavSidebar.tsx`
- `dashboard/src/lib/agent-tasks.ts`
- `dashboard/src/lib/tasks-index-controls.d.ts`
- `dashboard/src/lib/tasks-index-controls.js`
- `dashboard/tests/tasks-index-controls.test.mjs`
- `skills/queue-runner/SKILL.md`
- `skills/queue-runner/verify.mjs`
- `supabase/functions/open-brain-mcp/_agent_tasks.ts`
- `supabase/functions/open-brain-mcp/_agent_tasks_test.ts`
- `supabase/functions/open-brain-mcp/index.ts`
- `supabase/migrations/20260629042442_oe1_agent_task_board_schema.sql`
- `supabase/migrations/20260629042928_oe1_agent_task_board_privilege_hardening.sql`
- `supabase/migrations/20260629043243_oe1_agent_task_status_high_risk_guard.sql`
- `supabase/migrations/20260629110739_oe1_agent_task_status_receipt_alignment.sql`
- `supabase/migrations/20260629111411_oe1_agent_task_claimed_status_alignment.sql`

## Safety Read

This batch adds the manual task board, guarded receipt/status rules, protected MCP task tools, ledger UI, manual Queue Runner skill, and neutral public runtime examples. It does not include scheduled cron automation, the `queue-runner` Edge Function, OE-6 intake tools, intake dashboard callers, autonomous promotion, Slack intake behavior, function deploys, migration applies, or live Supabase writes.

## Verification Already Run

From Brain Bank `personal-staging` at `5e61497`:

```bash
git diff --check origin/dev..personal-staging -- . ':!**/* 2.*'
deno test supabase/functions/open-brain-mcp/_agent_tasks_test.ts
deno check supabase/functions/open-brain-mcp/index.ts
node dashboard/tests/tasks-index-controls.test.mjs
node skills/queue-runner/verify.mjs
```

Results:

- `git diff --check` passed.
- `_agent_tasks_test.ts` passed 8/8.
- `deno check` passed.
- `tasks-index-controls.test.mjs` passed 4/4 with the existing module-type warning.
- `skills/queue-runner/verify.mjs` passed.
- Public hygiene scan found no OE-1 through OE-4 private runtime examples. Remaining hits are in held OE-5/OE-6 files and tests.

## Additional Checks Before Promotion

Run these on a disposable clone or freshly rebuilt promotion branch based on `origin/dev`:

```bash
git status --short --branch
git diff --check
deno test supabase/functions/open-brain-mcp/_agent_tasks_test.ts
deno check supabase/functions/open-brain-mcp/index.ts
node dashboard/tests/tasks-index-controls.test.mjs
node skills/queue-runner/verify.mjs
cd dashboard && npm run build && npx tsc --noEmit
```

Repeat the public hygiene scan from the session prompt before staging.

Expected result for OE-1 through OE-4 promotion: no Dave-specific runtime examples in the files being promoted. If held OE-5/OE-6 files are present in the branch, do not promote that branch.

## Explicit Holds

Hold OE-5 until Open Brain cron job `9` natural-run evidence is reviewed:

- `827fc07` `port: OE-5 queue runner base from Open Brain`

Hold OE-6 until the same job `9` evidence is reviewed, unless Dave explicitly approves a separate split:

- `b719859` `feat(dashboard): add OE-6 intake promotion controls`
- `8b4aac4` `fix(dashboard): normalize OE-6 intake source label`
- `cfaeced` `feat(dashboard): add OE-6 handoff draft intake`
- `d1dd32b` `fix(dashboard): parse markdown handoff headings`
- `f36f37f` `port: OE-6 intake MCP parity from Open Brain`
- `77b5b07` `port: OE-6 action-item intake from Open Brain`
- `7d684c1` `port: OE-6 thought intake from Open Brain`

## Stop Lines

Stop and ask Dave before pushing, promoting to `dev` or `main`, rewriting migration history, editing cron or Queue Runner behavior, touching OE-5/OE-6 code, applying migrations, deploying functions, mutating live Supabase state, creating Slack intake behavior, adding autonomous promotion, expanding receipt/event vocabulary, or modifying any protected `* 2.*` duplicate file.
