# Neural Terminal Phase 9a: Foundation + Theme + Layout

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the warm-gold Tedder Trainer dashboard aesthetic with the "Neural Terminal" theme (Matrix/DOS, phosphor green on black) and build the responsive mobile-first shell with PWA support.

**Architecture:** Complete visual overhaul of the existing Next.js 15 dashboard. Replace all CSS variables, fonts, and animations. Add MatrixRain canvas background, responsive sidebar/bottom-nav shell, animated stat counters, and PWA manifest. Keep existing data-fetching logic and auth mechanism intact. New pages (graph, wiki, chat) are NOT in this phase.

**Tech Stack:** Next.js 15, React 19, Tailwind CSS 4, Google Fonts (VT323 + IBM Plex Mono), Canvas API for Matrix rain, CSS animations for scanlines/glow/typewriter effects.

---

## File Structure

```
src/
  app/
    layout.tsx              # MODIFY: New shell with responsive nav, Matrix rain, PWA meta tags, new fonts
    globals.css             # MODIFY: Complete rewrite with Neural Terminal CSS vars, animations, scanlines
    page.tsx                # MODIFY: Dashboard with animated StatCounter components, terminal-style sections
    login/page.tsx          # MODIFY: Terminal-style login with ACCESS GRANTED/DENIED feedback
  components/
    MatrixRain.tsx          # CREATE: Canvas-based falling character animation (client component)
    StatCounter.tsx         # CREATE: Animated counting number component (client component)
    NavSidebar.tsx          # CREATE: Desktop sidebar navigation (client component for active state)
    NavBottom.tsx           # CREATE: Mobile bottom tab navigation (client component for active state)
  public/
    manifest.json           # CREATE: PWA manifest
middleware.ts               # MODIFY: Add /api/* to public matcher so chat API works later
```

---

### Task 1: Install Dependencies + Create Branch

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install new dependencies**

```bash
cd /tmp/open-brain-dashboard
npm install react-force-graph-2d ai @ai-sdk/openai
```

These are needed for later phases but installing now avoids merge conflicts. `react-force-graph-2d` for the knowledge graph, `ai` + `@ai-sdk/openai` for the chat agent.

- [ ] **Step 2: Verify install succeeded**

Run: `cd /tmp/open-brain-dashboard && cat package.json | grep -E "react-force-graph|\"ai\"|@ai-sdk"`
Expected: All three packages appear in dependencies.

- [ ] **Step 3: Commit**

```bash
cd /tmp/open-brain-dashboard
git add package.json package-lock.json
git commit -m "feat: install dependencies for Neural Terminal redesign

Add react-force-graph-2d, ai, @ai-sdk/openai for knowledge graph and chat agent."
```

---

### Task 2: Neural Terminal Theme (globals.css)

**Files:**
- Modify: `src/app/globals.css` (complete rewrite)

- [ ] **Step 1: Replace globals.css with Neural Terminal theme**

Complete replacement. Every CSS variable changes from warm gold to phosphor green. New animations for scanlines, typewriter, terminal cursor blink, glow pulse, and staggered fade-in. The file must include:

**CSS Variables:**
```css
:root {
  --bg-primary: #0a0a0a;
  --bg-surface: #0d1117;
  --bg-input: #0a0f14;
  --border: #1a2332;
  --border-active: #00ff41;
  --text-primary: #00ff41;
  --text-secondary: #4ade80;
  --text-muted: #22543d;
  --text-body: #b0c4b0;
  --accent: #00ff41;
  --accent-dim: rgba(0, 255, 65, 0.08);
  --accent-glow: rgba(0, 255, 65, 0.15);
  --warning: #fbbf24;
  --danger: #ef4444;
  --success: #00ff41;
  --selection: rgba(0, 255, 65, 0.2);
  --radius: 8px;
  --radius-sm: 6px;
}
```

**Body styles:**
```css
body {
  background: var(--bg-primary);
  color: var(--text-body);
  font-family: 'IBM Plex Mono', 'Courier New', monospace;
  -webkit-font-smoothing: antialiased;
}
```

**Animations to define:**
- `@keyframes fadeSlideUp` - content entrance (translateY 12px to 0, opacity)
- `@keyframes terminalBlink` - cursor blink (opacity 1 to 0, steps(1))
- `@keyframes countUp` - used by JS, just a marker
- `@keyframes scanlineHover` - horizontal scanline sweeps down on hover
- `@keyframes glowPulse` - box-shadow green glow pulse
- `@keyframes typewriter` - width 0 to 100% with steps

**Stagger classes:** `.stagger-0` through `.stagger-8` with 60ms increments.

**Scrollbar:** Green thumb on transparent track.

**Selection:** Green highlight.

**Utility classes:**
- `.font-terminal` - `font-family: 'VT323', monospace`
- `.text-glow` - `text-shadow: 0 0 10px rgba(0, 255, 65, 0.5)`
- `.border-glow` - `box-shadow: 0 0 10px rgba(0, 255, 65, 0.1), inset 0 0 10px rgba(0, 255, 65, 0.05)`
- `.scanline-hover` - on hover, applies a repeating-linear-gradient of 1px semi-transparent lines
- `.card` - standard card style: bg-surface, 1px border, radius, hover border-active + glow
- `.animate-in` - fadeSlideUp 0.4s ease-out both

**Link styles:** Green default, brighter green on hover with subtle glow.

- [ ] **Step 2: Verify CSS parses**

Run: `cd /tmp/open-brain-dashboard && npx tailwindcss --help > /dev/null 2>&1 && echo "OK"`

- [ ] **Step 3: Commit**

```bash
cd /tmp/open-brain-dashboard
git add src/app/globals.css
git commit -m "feat: Neural Terminal theme - phosphor green on black

Complete CSS variable overhaul, scanline animations, glow effects,
terminal cursor blink, VT323 + IBM Plex Mono font classes."
```

---

### Task 3: MatrixRain Canvas Component

**Files:**
- Create: `src/components/MatrixRain.tsx`

- [ ] **Step 1: Create MatrixRain.tsx**

Client component (`"use client"`) that renders a fixed-position full-screen canvas behind all content. Requirements:

- `position: fixed`, `inset: 0`, `z-index: 0`, `pointer-events: none`
- Character set: katakana range (0x30A0-0x30FF), latin uppercase, digits
- Each column has: current y position, speed (random 0.5-2), character (changes randomly)
- Column width: 20px on desktop, 28px on mobile (fewer columns = better perf)
- Lead character is brighter (opacity 0.6-0.8), trail fades (opacity 0.03-0.05)
- Green color: `#00ff41`
- Uses `requestAnimationFrame` with delta time for smooth animation
- Respects `prefers-reduced-motion` media query (disable if set)
- Canvas resizes on window resize (debounced 200ms)
- Cleanup: cancels animation frame and removes resize listener on unmount
- Font: 14px monospace

Key implementation detail: each frame, for each column, draw the lead character at higher opacity, then draw a semi-transparent black rect over the entire column to create the fade trail effect. This is the classic Matrix rain technique.

```tsx
"use client";
import { useEffect, useRef } from "react";

export default function MatrixRain() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // ... full implementation with RAF loop, column state, resize handler
}
```

- [ ] **Step 2: Verify file exists and is valid TSX**

Run: `cd /tmp/open-brain-dashboard && npx tsc --noEmit src/components/MatrixRain.tsx 2>&1 | head -5`

Note: This may show import errors since it's not in the full build context yet. That's fine. The real verification is in the full build at the end.

- [ ] **Step 3: Commit**

```bash
cd /tmp/open-brain-dashboard
git add src/components/MatrixRain.tsx
git commit -m "feat: MatrixRain canvas background component

Falling katakana/latin/digit characters, variable speed columns,
lead character brightness, reduced motion support, mobile density scaling."
```

---

### Task 4: Navigation Components (NavSidebar + NavBottom)

**Files:**
- Create: `src/components/NavSidebar.tsx`
- Create: `src/components/NavBottom.tsx`

- [ ] **Step 1: Create NavSidebar.tsx**

Client component for desktop sidebar (hidden below 768px). Requirements:

- `"use client"` with `usePathname()` from `next/navigation`
- Fixed left sidebar, width 220px, full height
- Background: `var(--bg-surface)` with 1px right border
- Logo area: "OPEN BRAIN" in VT323 font, phosphor green, with "SEMANTIC MEMORY" subtitle in tiny tracked-out uppercase IBM Plex Mono
- Nav items array (shared constant):
  ```
  { href: "/", label: "Dashboard", icon: ">" }
  { href: "/graph", label: "Graph", icon: ">" }
  { href: "/wiki", label: "Wiki", icon: ">" }
  { href: "/thoughts", label: "Thoughts", icon: ">" }
  { href: "/search", label: "Search", icon: ">" }
  { href: "/clients", label: "Clients", icon: ">" }
  { href: "/audit", label: "Audit", icon: ">" }
  ```
- Active item: green text, green left border (2px), blinking `_` cursor after label
- Inactive: muted green text, hover brightens
- All text in VT323 font
- Footer: version "v3.0" in tiny muted text
- Uses `<Link>` from `next/link` for client-side navigation

- [ ] **Step 2: Create NavBottom.tsx**

Client component for mobile bottom tabs (visible below 768px, hidden above). Requirements:

- `"use client"` with `usePathname()`
- Fixed bottom, full width, safe-area padding bottom: `env(safe-area-inset-bottom)`
- Background: `var(--bg-surface)` with 1px top border, backdrop-blur
- Shows 5 tabs (Dashboard, Graph, Wiki, Thoughts, Search) with single-character labels:
  ```
  { href: "/", label: "HOME", shortLabel: "~" }
  { href: "/graph", label: "GRAPH", shortLabel: "G" }
  { href: "/wiki", label: "WIKI", shortLabel: "W" }
  { href: "/thoughts", label: "LOG", shortLabel: "T" }
  { href: "/search", label: "FIND", shortLabel: "?" }
  ```
- Active tab: green text + green dot indicator above
- Minimum 44x44px touch targets
- VT323 font, 10px uppercase labels below the short label character
- More menu (...) for Clients and Audit (or just 5 primary tabs is enough)

- [ ] **Step 3: Commit**

```bash
cd /tmp/open-brain-dashboard
git add src/components/NavSidebar.tsx src/components/NavBottom.tsx
git commit -m "feat: responsive navigation - desktop sidebar + mobile bottom tabs

NavSidebar: VT323 terminal labels, active cursor blink, green accents.
NavBottom: safe-area aware, 44px touch targets, 5 primary tabs."
```

---

### Task 5: Layout Shell + PWA Meta Tags

**Files:**
- Modify: `src/app/layout.tsx` (major rewrite)
- Create: `public/manifest.json`
- Modify: `middleware.ts` (add API route exclusion)

- [ ] **Step 1: Create PWA manifest**

Create `public/manifest.json`:
```json
{
  "name": "Open Brain",
  "short_name": "Brain",
  "description": "Neural Terminal - Semantic Memory System",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0a0a0a",
  "theme_color": "#0a0a0a",
  "icons": [
    {
      "src": "/icon-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/icon-512.png",
      "sizes": "512x512",
      "type": "image/png"
    }
  ]
}
```

Note: Icon files don't exist yet. The manifest is valid without them, icons can be added later.

- [ ] **Step 2: Rewrite layout.tsx**

Complete replacement. New layout must:

- Import Google Fonts: VT323 (weight 400) and IBM Plex Mono (weights 400, 500, 600)
- Use `viewport-fit=cover` in the viewport meta tag (via Next.js `viewport` export)
- Add apple-mobile-web-app meta tags: `apple-mobile-web-app-capable: yes`, `apple-mobile-web-app-status-bar-style: black-translucent`, `apple-mobile-web-app-title: Open Brain`
- Link to `/manifest.json`
- Set `theme-color` meta tag to `#0a0a0a`
- Keep `robots: "noindex, nofollow"` in metadata
- Render `<MatrixRain />` as first child of body (behind everything, z-0)
- Desktop (>=768px): `<NavSidebar />` on left, main content to the right with `ml-[220px]`
- Mobile (<768px): content fills screen, `<NavBottom />` fixed at bottom, content has bottom padding to clear the nav
- Main content area: `max-w-6xl mx-auto` with padding, safe-area-inset-top padding on mobile
- No inline nav in layout.tsx (delegated to NavSidebar and NavBottom components)

```tsx
import type { Metadata, Viewport } from "next";
import "./globals.css";
import MatrixRain from "@/components/MatrixRain";
import NavSidebar from "@/components/NavSidebar";
import NavBottom from "@/components/NavBottom";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0a0a",
};

export const metadata: Metadata = {
  title: "Open Brain",
  description: "Neural Terminal - Semantic Memory System",
  robots: "noindex, nofollow",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Open Brain",
  },
  manifest: "/manifest.json",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=VT323&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen">
        <MatrixRain />
        <div className="relative z-10 min-h-screen">
          {/* Desktop sidebar - hidden on mobile via CSS */}
          <NavSidebar />
          {/* Main content */}
          <main className="md:ml-[220px] min-h-screen pb-20 md:pb-0">
            <div className="max-w-6xl mx-auto p-4 md:p-8 pt-[calc(env(safe-area-inset-top)+1rem)] md:pt-8">
              {children}
            </div>
          </main>
          {/* Mobile bottom nav - hidden on desktop via CSS */}
          <NavBottom />
        </div>
      </body>
    </html>
  );
}
```

- [ ] **Step 3: Update middleware to exclude API routes**

Add `/api/*` to the matcher exclusion so the chat API route (built in a later phase) isn't blocked by the auth cookie check:

In `middleware.ts`, change the matcher from:
```ts
matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
```
to:
```ts
matcher: ["/((?!_next/static|_next/image|favicon.ico|api|manifest.json|icon-).*)"],
```

- [ ] **Step 4: Commit**

```bash
cd /tmp/open-brain-dashboard
git add src/app/layout.tsx public/manifest.json middleware.ts
git commit -m "feat: responsive layout shell with PWA support

MatrixRain background, NavSidebar (desktop), NavBottom (mobile),
viewport-fit cover, safe-area insets, PWA manifest, apple-mobile-web-app tags."
```

---

### Task 6: Terminal Login Page

**Files:**
- Modify: `src/app/login/page.tsx`

- [ ] **Step 1: Rewrite login page with terminal aesthetic**

Keep the existing server action (`login` function) and cookie mechanism exactly as-is. Only change the visual presentation:

- Black background with subtle green radial gradient center glow
- No MatrixRain needed (layout already provides it)
- Title: "OPEN BRAIN" in VT323, large (text-5xl), phosphor green with text-glow
- Subtitle: "NEURAL TERMINAL v3.0" in IBM Plex Mono, tiny uppercase tracked-out, muted green
- Terminal-style prompt before the input: `root@brain:~$ ` in green
- Password input: monospace font, green text on dark bg, green border on focus, no rounded corners (use 4px), styled like a terminal input field
- Submit button: bordered green outline (not filled), text "AUTHENTICATE", VT323 font, hover fills green with black text
- Error state: "ACCESS DENIED" in red (var(--danger)), flickers once with a CSS animation
- Success state handled by redirect (no visual needed)
- The whole form card has the `.card` class treatment with scanline-hover
- Staggered entrance animation on the form elements

The server action stays identical:
```tsx
async function login(formData: FormData) {
  "use server";
  const password = formData.get("password") as string;
  if (password === process.env.DASHBOARD_PASSWORD) {
    const cookieStore = await cookies();
    cookieStore.set("ob-auth", password, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30,
    });
    redirect("/");
  }
  redirect("/login?error=1");
}
```

- [ ] **Step 2: Commit**

```bash
cd /tmp/open-brain-dashboard
git add src/app/login/page.tsx
git commit -m "feat: terminal-style login page

ACCESS DENIED/GRANTED feedback, VT323 typography, green-on-black
terminal prompt, scanline hover effect on form card."
```

---

### Task 7: StatCounter Component

**Files:**
- Create: `src/components/StatCounter.tsx`

- [ ] **Step 1: Create animated counter component**

Client component that animates a number from 0 to the target value on mount, like a boot sequence readout.

Props:
```tsx
interface StatCounterProps {
  label: string;       // e.g. "THOUGHTS"
  value: number;       // target number
  delay?: number;      // ms before animation starts (for stagger)
  accent?: boolean;    // use warning color instead of green
}
```

Implementation:
- Uses `useEffect` + `requestAnimationFrame` to animate from 0 to `value` over 1200ms with easeOutExpo curve
- Number displayed in VT323 font, text-4xl, phosphor green (or warning amber if `accent`)
- Label is tiny (text-[10px]) uppercase tracked-out IBM Plex Mono, muted green, above the number
- Wrapping card: `bg-[var(--bg-surface)]`, 1px border, 6px radius, hover border glows green
- Number has subtle text-shadow glow
- Respects `prefers-reduced-motion` (shows final value immediately)
- Uses `Intl.NumberFormat` for comma separators on large numbers

- [ ] **Step 2: Commit**

```bash
cd /tmp/open-brain-dashboard
git add src/components/StatCounter.tsx
git commit -m "feat: StatCounter component with animated boot sequence

Animates 0 to target over 1200ms, easeOutExpo, VT323 display,
green glow, reduced motion support."
```

---

### Task 8: Dashboard Command Center

**Files:**
- Modify: `src/app/page.tsx` (major rewrite)

- [ ] **Step 1: Rewrite dashboard page**

Keep ALL existing data-fetching queries (they work correctly). Replace the visual presentation entirely:

**Stats row:** Replace `StatCard` inline component with `<StatCounter>` imports. Grid: 5 columns on desktop (xl), 3 on medium, 2 on mobile. Stats:
- Thoughts (count)
- Clients (clientCount)
- Sessions (sessionCount)
- Wiki Pages (new query: `compiled_pages` count)
- Open Actions (actionCount, accent=true if > 0)

Add a new query for wiki pages count:
```tsx
const { count: wikiCount } = await supabase()
  .from("compiled_pages")
  .select("*", { count: "exact", head: true });
```

**Activity sparkline:** Keep the 14-day logic. Replace gold bars with green bars on black. Bar styling:
- Background: `var(--accent)` with 0.8 opacity
- Hover: full brightness + count tooltip
- Base line: 1px `var(--border)`
- Day labels in IBM Plex Mono, text-[10px], muted

**Section component:** Terminal-style. Each section has:
- Title prefix: `>` character in green
- Title in VT323, uppercase
- 1px border card with scanline-hover class
- Subtle green left border accent (2px solid var(--accent) at 0.3 opacity)

**Breakdown grids:** Same data (sources, types, topics, people) but:
- Bar charts: green gradient bars instead of gold
- Tag cloud: green-tinted chips with green borders
- Labels in IBM Plex Mono

**Recent captures feed:** Keep the 5-item slice. Style as terminal log output:
- Each entry prefixed with timestamp in muted green: `[04-13 08:32]`
- Type badge in small green pill
- Source in muted text
- Content in `var(--text-body)` (readable light green-gray)
- Left accent bar: green instead of gold

**"View all thoughts" link:** Terminal-style: `> view all thoughts_` with blinking cursor

- [ ] **Step 2: Verify build succeeds**

Run: `cd /tmp/open-brain-dashboard && npm run build 2>&1 | tail -20`
Expected: Build completes without errors. Warnings about missing icon files are acceptable.

- [ ] **Step 3: Commit**

```bash
cd /tmp/open-brain-dashboard
git add src/app/page.tsx
git commit -m "feat: dashboard command center with Neural Terminal aesthetic

Animated stat counters, green-on-black activity sparkline,
terminal-style sections, wiki page count, boot sequence feel."
```

---

### Task 9: Full Build Verification + Dev Server Test

**Files:** None (verification only)

- [ ] **Step 1: Run full build**

```bash
cd /tmp/open-brain-dashboard && npm run build 2>&1 | tail -30
```

Expected: Build succeeds. All pages compile. No TypeScript errors.

- [ ] **Step 2: Start dev server and verify rendering**

```bash
cd /tmp/open-brain-dashboard && nohup npx next dev --port 3099 > /tmp/neural-terminal-dev.log 2>&1 & echo "PID: $!"
sleep 3
curl -s http://localhost:3099/login | head -50
```

Expected: HTML response with Neural Terminal themed login page (VT323 font references, green color variables, OPEN BRAIN title).

- [ ] **Step 3: Kill dev server**

```bash
pkill -f "next dev.*3099" 2>/dev/null
```

- [ ] **Step 4: Final commit (if any fixes needed)**

Only if build/verification revealed issues that needed fixing.

---

## Verification Checklist

Before claiming Phase 9a complete:

- [ ] `npm run build` succeeds with zero errors
- [ ] All CSS variables use the Neural Terminal green palette (no gold references remain)
- [ ] MatrixRain canvas renders (verified via dev server or build output)
- [ ] Layout is responsive: sidebar on desktop, bottom tabs on mobile
- [ ] Login page has terminal aesthetic with ACCESS DENIED on bad password
- [ ] Dashboard stat counters use VT323 font and animate on load
- [ ] PWA manifest.json exists and is linked in layout
- [ ] Viewport uses `viewport-fit=cover` for safe areas
- [ ] No references to Playfair Display, gold, or warm-theme variables in any modified file
- [ ] middleware.ts excludes `/api/*` routes from auth check

## What's NOT in This Phase

- Knowledge graph (/graph page, KnowledgeGraph.tsx, MiniGraph.tsx) - Phase 9b
- Wiki browser (/wiki pages) - Phase 9b
- Chat agent (API route, ChatPanel, ChatFAB) - Phase 9c
- Thoughts/Search page rebuilds - Phase 9c
- Clients/Audit page rebuilds - Phase 9d
- PWA icons (192x192, 512x512 PNGs) - can be added anytime
- Railway deployment - Phase 9d
