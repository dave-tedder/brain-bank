# Deploying the dashboard

The dashboard at `dashboard/` is a Next.js 15 App Router app. It is a separate deploy target from the Edge Functions: the engine runs on Supabase, the dashboard runs wherever you put it. You can run the whole system with no dashboard at all.

This guide covers Railway (what the maintainer runs) and Vercel. The app is not tied to either one.

## Before you start

You need a working Brain Bank backend first. Finish `docs/deploy-from-scratch.md` through Step 10, so you have a Supabase project with the schema pushed and `open-brain-mcp` deployed. The dashboard reads that database directly and calls that function for chat.

## The six environment variables

All six are required at runtime. The build will succeed without some of them and then fail at request time, which is the main way people get this wrong.

| Variable | Value | Breaks if missing |
|---|---|---|
| `SUPABASE_URL` | `https://<your-project-ref>.supabase.co` | Everything |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key from Supabase, Settings → API | Everything |
| `OPENROUTER_API_KEY` | OpenRouter key | `/search` |
| `DASHBOARD_PASSWORD` | A password you choose | Auth fails closed, you cannot log in |
| `BRAIN_BANK_URL` | `https://<your-project-ref>.supabase.co/functions/v1/open-brain-mcp` | `/chat` |
| `BRAIN_BANK_API_KEY` | Same value as your `MCP_ACCESS_KEY` | `/chat` |

Two rules that matter more than they look:

**Never prefix the service-role key with `NEXT_PUBLIC_`.** That key bypasses row-level security. `NEXT_PUBLIC_` ships it to the browser. Every Supabase call in this app is server-side for exactly this reason.

**Set the variables for preview and production builds, not just production.** The Next.js build evaluates server code. If a build environment has no env vars at all, the build crashes. This is why CI passes six placeholder values (`https://ci.invalid`, `ci-placeholder`) before running `npm run build`.

## Railway

Root directory is `dashboard/`, not the repo root.

1. New project, deploy from your GitHub repo.
2. Settings → Root Directory: `dashboard`
3. Settings → Watch Paths: `dashboard/**` so engine-only commits do not trigger a rebuild.
4. Build command: `npm install && npm run build`
5. Start command: `npm run start`
6. Variables: add all six from the table above.
7. Optional: Settings → Networking → Custom Domain, then point a CNAME at the Railway target.

`next.config.ts` sets `output: "standalone"`, which is there for Railway.

Two Railway-specific notes. The build queue can sit at `INITIALIZING` for five to ten minutes or more under load; that is capacity, not failure, so do not retry into it. And the Railway MCP's `custom-domain-create` / `custom-domain-status` tools fail with GraphQL subfield errors, so use the `railway domain` CLI instead.

## Vercel

Root directory is `dashboard/`, not the repo root. This is the setting people miss; without it the build cannot find the app.

1. Import the repo in Vercel.
2. Root Directory: `dashboard`
3. Framework preset: Next.js (detected automatically once the root directory is right).
4. Node version: 20, matching `dashboard/.nvmrc` and CI.
5. Environment Variables: add all six, for Production **and** Preview.
6. Deploy.

Leave the build and output settings at the framework defaults. Do not set a custom build or start command; `npm run start` is a Railway-shaped instruction and does not apply here.

### `output: "standalone"` on Vercel

`next.config.ts` declares `output: "standalone"` so Railway can run `.next/standalone/server.js`. Vercel produces its own output format and does not need it.

Leaving it in place is not fatal and is the safer default for a shared repo, since removing it would break the Railway deploy. If you are forking for Vercel only, you can drop it. If you are contributing back, leave it.

### Things that differ on Vercel

**Function duration limits.** `/api/chat` streams a response through the AI SDK. Vercel caps function duration (10 seconds on Hobby, 60 with Fluid compute); Railway does not cap it. A long chat answer can be cut off mid-stream on a small plan. If you see truncated chat responses and nothing in the logs, this is the first thing to check.

**Middleware runs at the edge.** `src/middleware.ts` is the entire authentication layer. Vercel runs it as edge middleware rather than in-process. The behavior is equivalent for this app's cookie check, but see the warning below before you touch that file.

**Preview deployments are new ground.** The maintainer's Railway setup has only ever had a `production` environment wired to `main`; feature branches never produced a deploy. Vercel gives you per-branch previews for free. That is an improvement, not a restoration of something that existed before, so treat the first few as unproven.

**Every route is dynamic.** All pages set `export const dynamic = "force-dynamic"`, so nothing is statically prerendered and every request is a function invocation. That is intended (the dashboard shows live data), but it does shape your usage numbers.

## Do not move `src/middleware.ts`

This is the highest-consequence mistake available in this codebase, on any platform.

Middleware is the only thing standing between the open internet and your entire memory system. Next.js **silently ignores** a root-level `middleware.ts` when the app directory is at `src/app/`. There is no warning, no error, and no build failure. The site just serves to anonymous traffic.

The check: `npm run build` output must include a line like `ƒ Middleware  NN kB`. If that line is absent, middleware is not running and your dashboard is public. Verify this after any restructuring, and after your first deploy on a new platform.

## Local development

```bash
cd dashboard
npm install
cp ../.env.example .env.local   # then trim to the six dashboard vars and fill them
npm run dev
```

The app comes up on port 3000. There is no `.env.local.example`; build yours from the dashboard block in the repo-root `.env.example`.

To exercise authenticated routes without going through the login form, set the cookie directly. `src/middleware.ts` compares the `bb-auth` cookie value against `DASHBOARD_PASSWORD`:

```bash
PW=$(grep DASHBOARD_PASSWORD .env.local | cut -d= -f2-)
curl -s "http://localhost:3000/" -H "Cookie: bb-auth=$PW" -o /tmp/home.html
```

## Verifying a deploy

1. Hitting the root URL unauthenticated redirects to `/login`. If it does not, stop and read the middleware section above.
2. Log in with `DASHBOARD_PASSWORD`.
3. `/thoughts` lists captures. If this is empty but the database has rows, check `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
4. `/search` returns semantic results. Failure here points at `OPENROUTER_API_KEY`.
5. `/chat` answers a question. Failure here points at `BRAIN_BANK_URL` or `BRAIN_BANK_API_KEY`, the two that are easiest to forget.
6. `/digest` shows entries once the digest cron has run at least once.
