# Brain Bank Dashboard

Internal Next.js dashboard for browsing, searching, and auditing the Brain Bank semantic memory system. Single-user, password-protected.

## Tech Stack

- **Framework:** Next.js 15, App Router, React 19
- **Styling:** Tailwind CSS 4
- **Database:** Supabase (shared with the Brain Bank engine)
- **Hosting:** Railway (standalone output mode)
- **Auth:** Simple password gate via middleware cookie

## Project Structure

```
dashboard/
├── AGENTS.md
├── next.config.ts             # standalone output for Railway
├── package.json
├── postcss.config.mjs
├── tsconfig.json
├── src/
│   ├── middleware.ts          # Auth: password cookie check. MUST live here (see Conventions)
│   ├── lib/
│   │   ├── supabase.ts        # Server-side Supabase client (service_role, lazy-init)
│   │   ├── digest.ts          # Digest data-access helpers
│   │   └── projects.ts        # Projects rollup data-access helpers
│   ├── components/
│   │   ├── NavSidebar.tsx     # Client component: sidebar nav, LOGOUT form
│   │   ├── ThoughtCard.tsx
│   │   ├── DigestHeroCard.tsx # Homepage digest hero (ASCII frame, 4 states)
│   │   ├── DigestMarkdown.tsx
│   │   ├── DigestRow.tsx
│   │   ├── DigestMetadataRail.tsx
│   │   ├── ProjectFilters.tsx # /projects type + status filter pills
│   │   ├── ProjectRow.tsx     # /projects log-layout row; exports statusColor()
│   │   ├── ProjectCard.tsx    # /projects grid-layout card
│   │   ├── ProjectTimeline.tsx
│   │   └── ProjectMetadataRail.tsx
│   └── app/
│       ├── layout.tsx
│       ├── globals.css
│       ├── page.tsx
│       ├── login/page.tsx      # Password form (server action)
│       ├── logout/route.ts     # POST handler: clears bb-auth, 303 to /login
│       ├── thoughts/page.tsx
│       ├── search/page.tsx
│       ├── audit/page.tsx
│       ├── clients/page.tsx
│       ├── clients/[id]/page.tsx
│       ├── digest/page.tsx
│       ├── digest/[date]/page.tsx
│       ├── projects/page.tsx        # Projects index (log/grid, filters)
│       └── projects/[slug]/page.tsx # Project detail (70/30, timeline + rail)
```

## Key Files

- `src/middleware.ts`: Checks `bb-auth` cookie against `DASHBOARD_PASSWORD` env var. Redirects to `/login` if the env var is unset OR the cookie is missing OR the value mismatches. **MUST live at `src/middleware.ts`, never at project root** (see Conventions).
- `src/app/logout/route.ts`: POST-only handler. Returns 303 with `Set-Cookie: bb-auth=; Max-Age=0` and relative `Location: /login`. Triggered by the LOGOUT button in `NavSidebar`.
- `src/lib/supabase.ts`: Single server-side Supabase client using service_role key.
- `src/app/page.tsx`: Stats dashboard. Aggregates types, topics, people, sources, 14-day activity chart.
- `src/app/search/page.tsx`: Semantic search. Calls OpenRouter for embeddings, then match_thoughts RPC.
- `src/app/audit/page.tsx`: Near-duplicate detection (normalized first-80-chars comparison) + recent captures by source.
- `src/app/clients/[id]/page.tsx`: Client detail with session history table and cross-referenced thoughts from metadata.people.
- `src/lib/digest.ts`: Server-only digest helpers. `getLatestDigest(type)`, `getDigestByDate(date, type)`, `listDigests({type,limit,offset})`, `getAdjacentDigests(date,type)`, `resolveClientLinks(metadata)`. `listDigests` throws on real DB errors; archive page try/catches to distinguish empty vs fetch failure.
- `src/components/DigestHeroCard.tsx`: Server component, renders four states: (a) `today` (ASCII-framed digest with truncated markdown + `READ FULL DIGEST >` link), (b) `pending` (pre-6 AM ET amber `[PENDING]` tag + latest fallback), (c) `empty` (`[EMPTY]`), (d) `error` (red `[ERROR]`). Uses ClickableCard-style overlay-link pattern inline (no `onClick` handlers; see Conventions).
- `src/components/DigestMarkdown.tsx`: Client component wrapping `react-markdown` + `remark-gfm`. Neural-terminal component overrides (VT323 headers, IBM Plex Mono body, tree-character lists, `[REF :: <name>]` phosphor chips for `/clients/<id>` links). `linkifyClients()` pre-processes markdown with a case-insensitive regex to wrap client-name matches in chip anchors; passes the matched text through so case variants in prose (e.g., "jane doe" vs canonical "Jane Doe") still render naturally.
- `src/app/digest/page.tsx`: Archive. `?type=daily|weekly` tabs, paginated via `?offset=N`. Differentiates "fetch failed" (DB error) from "no entries" (cron not running / wrong type) in the terminal log.
- `src/app/digest/[date]/page.tsx`: Detail. `getDigestByDate(date, type)` → 404 if null. `resolveClientLinks()` looks up `metadata.referenced_client_names` against the `clients` table and passes matched pairs to `DigestMarkdown` for auto-linking.
- `src/lib/projects.ts`: Server-only projects data access against the `projects_rollup` view. `listProjects({type,status,includeArchived,limit,offset})`, `getProjectBySlug`, `getProjectVision`, `listProjectTimeline`, `countProjectTimeline`, `listProjectOpenActions`, plus a `formatAge` helper. Exports the `PROJECT_TYPE_FILTERS` / `PROJECT_STATUS_FILTERS` pill config (URL token ↔ rollup value mapping, e.g. token `llm` ↔ type `llm-build`). `ROLLUP_COLS` must stay a single string literal so supabase-js parses the column list at the type level.
- `src/app/projects/page.tsx`: Projects index. Reads `?type/&status/&view/&offset/&include`, renders `ProjectFilters` + log rows or `?view=grid` card grid, `[LOG / GRID]` toggle, `LOAD EARLIER ENTRIES` pagination. Empty + error states inline (`NO PROJECTS YET` / `NO PROJECTS MATCH` / `ROLLUP FETCH FAILED`). Archived rows hidden unless `?include=archived`.
- `src/app/projects/[slug]/page.tsx`: Project detail. `getProjectBySlug(slug)` → inline themed `> NO PROJECT :: <slug>` block if null. 70/30 layout: `ProjectTimeline` main column + sticky `ProjectMetadataRail`. `vision_md` collapsed in a native `<details>`; `?history=all` expands the full capture timeline.

## Environment Variables

All required, set via Railway environment variables:
- `SUPABASE_URL`: Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Server-side only, never exposed to browser
- `OPENROUTER_API_KEY`: For semantic search embeddings
- `DASHBOARD_PASSWORD`: Single shared password for access

## Run / Build / Deploy

```bash
npm install
npm run dev          # Local dev on port 3000
npm run build        # Production build (standalone output)
npm run start        # Start production server
```

Railway deployment: push to repo, Railway auto-builds. Needs env vars set in Railway dashboard.

## Database Access

Reads from the Brain Bank Supabase project (read-only from the dashboard):
- `thoughts`: core captured content
- `clients`: client profiles
- `action_items`: open / resolved tracked actions
- `compiled_pages`: Karpathy-style wiki pages
- `digests`: persisted daily / weekly digest markdown + metadata (populated by the brain-digest Edge Function; powers the hero card, `/digest` archive, `/digest/[date]` detail)
- `projects`: tracked projects (slug, type, status, vision_md, working_dirs); rows are auto-promoted from topics with enough captures
- `projects_rollup`: view joining `projects` to `thoughts` — derives `status_derived` (ACTIVE / STALE / BLOCKER / DORMANT), `next_step`, `blocker_text`, capture counts. Powers `/projects` and `/projects/[slug]`.

Uses `match_thoughts` RPC for semantic search.

## Conventions

- **Middleware MUST live at `src/middleware.ts`, not project root.** Next.js silently ignores a root-level `middleware.ts` when the app directory is at `src/app/`. No warning, no error, no `next build` failure, just the entire site served to anonymous traffic. Detection: `npm run build` output must include a `ƒ Middleware  NN kB` line. If absent, middleware isn't running.
- **Auth check must explicitly handle unset env var.** `cookie !== process.env.DASHBOARD_PASSWORD` fails open when the env var is missing (`undefined !== undefined` is `false`). Use `!expected || !auth || auth !== expected` instead.
- **Route handler redirects must use relative `Location` headers.** On Railway standalone, `request.url` inside Route Handlers dereferences the internal bind (`http://localhost:8080`). `NextResponse.redirect(new URL("/login", request.url))` leaks `localhost:8080` into production `Location` headers. Middleware's `NextRequest.url` is fine; the same syntactic call only breaks in route handlers.
- All pages use `export const dynamic = "force-dynamic"` (no caching, always fresh data)
- Neural-terminal phosphor-green theme (VT323 + IBM Plex Mono, Matrix-rain background, `--phosphor-glow: #5ff79d` for hot accents, scanline-hover utility). See CSS variables in `globals.css`.
- Server components for data fetching, client components for interactivity. Markdown rendering in DigestMarkdown is a client component so `react-markdown` hydrates; the data prop is server-computed.
- All Supabase calls happen server-side (service_role key never in browser). Always call `supabase()` (lazy-init, imported from `@/lib/supabase`) inside route handlers; never at module top level. Railway builds without env vars and top-level `createClient()` crashes the build.
- For clickable cards over server-component pages, use the overlay-link pattern (absolute `<Link className="absolute inset-0 z-10" />` + relative content layer with `className="relative z-20 pointer-events-none [&_a]:pointer-events-auto"`). Never add `onClick` handlers to children of a server component (request-time 500 with opaque digest). `next build` does NOT catch it.
- `prefers-reduced-motion: reduce` disables the digest cursor blink and hero `.ascii-frame .animate-in` stagger; respect it when adding new animations.
- Narrow viewports (`max-width: 640px`) collapse the `.ascii-frame__top` and `.ascii-frame__bottom` pseudo-header/footer; layout falls back to a flat phosphor left border on the card.

## Local dev auth shortcut

`middleware.ts` compares the `bb-auth` cookie value directly against `DASHBOARD_PASSWORD`. Bypass the `/login` form in local dev by setting the cookie header directly on curl:

```bash
PW=$(grep DASHBOARD_PASSWORD .env.local | cut -d= -f2-)
curl -s "http://localhost:3100/" -H "Cookie: bb-auth=$PW" -o /tmp/home.html
```

This is the reliable way to exercise authenticated routes in local dev without touching `/login`.
