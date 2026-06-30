# Brain Bank Dashboard

Next.js dashboard for browsing, searching, and operating the Brain Bank semantic memory system. Single-user, password-protected, server-rendered.

This README covers env vars, the Railway deploy pattern, and local-dev quickstart. For the file-by-file conventions, theming notes, and middleware gotchas that agents working in this tree need, see [`AGENTS.md`](AGENTS.md).

## What you get

- Home stats dashboard (capture counts, sources, 14-day activity)
- `/thoughts`: raw capture stream
- `/search`: semantic search powered by `match_thoughts` and OpenRouter embeddings
- `/projects` and `/projects/[slug]`: rolled-up project pages with timelines and metadata
- `/digest`, `/digest/[date]`: daily and weekly digest archive
- `/clients`, `/clients/[id]`: client profiles with cross-referenced thoughts
- `/tasks`: the manual Open Engine task board (added in v0.3.0)
- `/audit`: near-duplicate detection and recent captures by source
- Chat over your memory backed by the engine's MCP / REST surface

## Tech stack

- **Framework:** Next.js 15 (App Router), React 19
- **Styling:** Tailwind CSS 4
- **Database:** Supabase (shares the same project as the Brain Bank engine)
- **Hosting:** Railway, standalone Next.js output
- **Auth:** password-gated middleware cookie (HMAC-signed; see `src/lib/auth.ts`)

## Environment variables

All six are required at runtime. Set them in your hosting platform (Railway, Vercel, or local `.env.local`):

| Variable | What it is |
|---|---|
| `SUPABASE_URL` | Brain Bank Supabase project URL (`https://<ref>.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key for server-side reads. Never exposed to the browser. |
| `OPENROUTER_API_KEY` | OpenRouter key used by `/search` to generate embeddings |
| `DASHBOARD_PASSWORD` | Single shared password the middleware checks against the `bb-auth` cookie |
| `BRAIN_BANK_URL` | `https://<ref>.supabase.co/functions/v1/open-brain-mcp` — the engine REST surface used by the dashboard chat route |
| `BRAIN_BANK_API_KEY` | The dashboard's copy of `MCP_ACCESS_KEY` for calling the engine REST surface |

`BRAIN_BANK_URL` and `BRAIN_BANK_API_KEY` are only needed if you want the in-dashboard chat to work; the rest of the dashboard runs on the four core vars.

## Local dev

```bash
cd dashboard
npm install
cp .env.local.example .env.local   # if present in your fork; otherwise create one with the six vars above
npm run dev
```

Local dev runs on `http://localhost:3000` (or `3100` if 3000 is taken). The middleware redirects to `/login` until the `bb-auth` cookie matches `DASHBOARD_PASSWORD`. To skip the login form during a curl session, set the cookie directly:

```bash
PW=$(grep DASHBOARD_PASSWORD .env.local | cut -d= -f2-)
curl -s "http://localhost:3000/" -H "Cookie: bb-auth=$PW" -o /tmp/home.html
```

## Tests and type checks

```bash
node --test tests/*.test.mjs   # node:test suites (projects + tasks index controls)
npx tsc --noEmit               # type-check without emitting
npm run build                  # full production build (standalone output)
```

CI runs all three on every PR; see [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) in the repo root.

## Railway deployment

The reference deployment uses Railway's GitHub integration with a watch pattern so unrelated engine changes do not trigger a dashboard rebuild:

- **Root directory:** `dashboard/`
- **Watch pattern:** `dashboard/**`
- **Build command:** `npm install && npm run build`
- **Start command:** `npm run start`
- **Output mode:** standalone (`next.config.ts` sets `output: "standalone"` so Railway can run `.next/standalone/server.js`)

Set the six env vars listed above in the Railway service. Pushes to the default branch trigger a redeploy automatically once the watch pattern matches.

A custom domain CNAMEs to the Railway `up.railway.app` hostname; the default Railway URL keeps working as a fallback.

## Why some files live where they do

A few non-obvious conventions are explained in [`AGENTS.md`](AGENTS.md):

- Middleware **must** live at `src/middleware.ts`, not the project root. Next.js silently ignores root-level middleware when the app directory is `src/app/` — no warning, no build failure, just unauthenticated traffic served to your whole dashboard.
- Server-component pages cannot pass `onClick` handlers to children without crashing at request time; the dashboard uses an overlay-link pattern for clickable cards.
- All Supabase calls must happen inside route handlers via the lazy-init `supabase()` getter; top-level `createClient()` crashes Railway builds because env vars are absent at build time.

Read `AGENTS.md` before making changes to middleware, auth, or any cross-cutting page convention.
