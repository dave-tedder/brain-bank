# New contributor notes

Things that will cost you an hour if you find them the hard way. This is the stuff that was never written down because the maintainer's environment (macOS, Railway, a live Supabase project) hid it.

Read this alongside `CONTRIBUTING.md`, which covers the normal workflow. This file covers the traps.

## Windows setup

The repo is developed on macOS. Nothing here is hostile to Windows on purpose, but three things need handling before you start.

**Use Git Bash or WSL, not PowerShell or cmd.** This is stated in `skills/brain-bank-setup/SKILL.md` and it is real. Several documented commands use shell globs (`deno check supabase/functions/*/index.ts`) that PowerShell and cmd do not expand, and the repo's shell scripts assume a POSIX shell.

**Enable symlinks before you clone.** Seven paths under `.claude/skills/` are committed as real symlinks. Without symlink support, Git checks them out as one-line text files containing a path, and the skills silently never load. You get no error, just agents that behave as if the skills do not exist.

```bash
git config --global core.symlinks true
```

That requires Windows Developer Mode to be on, or an elevated shell. Turn it on first, then clone. If you already cloned, re-clone; fixing it in place is more annoying than starting over.

**Line endings are handled for you now, but check your config.** The repo ships a `.gitattributes` that forces LF on checkout everywhere. If you cloned before that landed, or you have an aggressive global setting, confirm you are not getting CRLF:

```bash
git config --global core.autocrlf input
```

CRLF breaks the bash scripts, and it breaks `skills/queue-runner/verify.mjs`, which is a required CI step that parses markdown with LF-literal regexes. The symptom is CI failing on a change you did not make.

## Seed `profile.json` before anything type-checks

This is the single most common first stumble.

`supabase/functions/_shared/profile.json` is gitignored. Only `profile.example.json` is tracked. `profile.ts` does `import ... from "./profile.json"`, so the file has to exist as its sibling, and a fresh clone does not have it.

```bash
cp profile.example.json supabase/functions/_shared/profile.json
```

A copy at the repo root type-checks nowhere and deploys nowhere; the path matters. Skip this step and `deno check` gives you a missing-module error that reads like broken code but is just a missing file. CI does this same copy as its first step.

## What CI actually enforces

The workflow is `.github/workflows/ci.yml`, job name `Engine + skill + dashboard`. It is a required check, and so is CodeQL.

To reproduce it locally you need **both Deno 2.x and Node 20**. Note that `docs/deploy-from-scratch.md` says you need no Deno tooling. That is true for deploying and false for contributing.

The steps, in order:

1. Seed `profile.json`
2. `deno test` on the MCP agent-tasks suite
3. `deno check` on `open-brain-mcp/index.ts`
4. `node skills/queue-runner/verify.mjs`
5. `node --test scripts/open-engine/closeout-controller.test.mjs`
6. `npm ci`, then `node --test tests/*.test.mjs` in `dashboard`
7. `npx tsc --noEmit` in `dashboard`
8. `npm run build` in `dashboard`, with six placeholder env vars

Three things about this that are not obvious:

**`verify.mjs` is a prose contract.** It greps `skills/queue-runner/SKILL.md` for exact phrases, enforces a 12-step count, and does a deep-equality check on an 8-heading block. Rewording that file fails CI even when the change is an improvement. It has already failed once over backtick formatting. If you need to edit it, run `node skills/queue-runner/verify.mjs` locally before pushing.

**CodeQL has failed real PRs.** Most recently on two high-severity `js/incomplete-sanitization` findings. It is a gate, not advisory.

**Case-sensitivity runs against you on Windows.** NTFS will happily resolve `@/components/thoughtCard` when the file is `ThoughtCard.tsx`. The Ubuntu CI runner will not. If CI fails with a module-not-found on a file that plainly exists, check the casing of your import.

Also worth knowing: the 13 Deno test files in the root `tests/` directory are **not** run by CI, so there is no current signal on whether they pass. `CONTRIBUTING.md` asks you to run one of them locally.

## Pull requests

Branch from `dev` and target `dev`. Not `main`. `main` carries tagged releases and reaches them through a PR from `dev`.

As of v0.6.0, `main`, `dev`, and `personal-staging` are all at the same commit, so you are starting from a clean and current base.

`CONTRIBUTING.md` asks that Edge Function changes be redeployed to a throwaway Supabase project before the PR. That is a real requirement for engine work. A dashboard-only or docs-only PR does not need it.

## Deploying the dashboard

See `docs/dashboard-deploy.md`, which covers both Railway and Vercel. The short version of the traps:

- Root directory is `dashboard/`, not the repo root, on either platform.
- All six env vars are required at runtime, and preview builds need them too.
- Never prefix the service-role key with `NEXT_PUBLIC_`.
- Never call `supabase()` at module top level. Builds run without env vars and it crashes them with a misleading error.
- Do not move `src/middleware.ts`. Next.js silently ignores root-level middleware when the app dir is `src/app/`, and middleware is the only auth on the dashboard. The failure mode is a fully public dashboard with no warning anywhere.
- `output: "standalone"` in `next.config.ts` exists for Railway. Vercel does not need it. Leave it if you are contributing back.

## The Antigravity lane

If you are working on Antigravity as an Open Engine runtime, the schema is further along than the docs.

`supabase/migrations/20260710_oe_scheduling_identities.sql` already widens the `runtime` constraint to accept `'antigravity'` and `automation_state` to accept `'reserved'`. There is no prose documentation of any of this; grepping the migrations is currently the only way to find it. The migration ships unapplied, because this repo has no live infrastructure, so you need your own Supabase project to exercise it.

What is settled in the design:

- Antigravity is lane 3 of 4 in a 16-run-per-day executor grid. Lanes stagger in the order Claude, Codex, Antigravity, then a fourth runtime that is still to be named.
- Its slots are reserved at 12:50 AM, 1:40 AM, 2:30 AM, and 2:00 PM (three overnight, one daytime).
- Its ledger identity is a reserved row. Absence of runs is expected and must never be graded as stale by the sentinel.
- It is a local-required lane. It claims tasks, writes deliverables to disk, and runs code and git, so it needs a machine that is awake. It is not a cloud lane. The `requires_local` hard claim filter exists for exactly this.
- Every lane owes a `write_agent_ledger` heartbeat per run.

What is **not** settled, and is the most useful thing you could answer:

> Does Antigravity report as one ledger identity or three?

The scheduling design leaves this open because it depends on how the runtime actually posts heartbeats. It determines how many slots the lane needs and how the sentinel counts it. Nobody can answer it from the outside; whoever runs Antigravity first finds out empirically.

One naming note: agent codes in this repo follow `local-*`, `claude-code`, `codex`. If you see a `dave-*` prefix anywhere, that is upstream residue and should not be copied.

## Docs that are wrong or incomplete

Flagged so you do not waste time reconciling them:

- **`README.md` documents Railway only** for the dashboard. Vercel is supported, just newer. See `docs/dashboard-deploy.md`.
- **`docs/deploy-from-scratch.md` gives macOS-specific install commands** (`brew install supabase/tap/supabase`, `xcode-select --install`) and tells other platforms to consult the CLI install page.
- **There is no `.env.local.example`** despite `dashboard/README.md` referencing one. Build yours from the dashboard block in the root `.env.example`.
- **`AGENTS.md` was stale until v0.6.0** on version, migration count, and tool count. If you find another stale count, it is a bug worth a PR.

## If something in this file is wrong

It is a doc bug, not a user bug. Open an issue or fix it in your PR. This file exists because the first outside contributor hit these; it should get shorter over time, not longer.
