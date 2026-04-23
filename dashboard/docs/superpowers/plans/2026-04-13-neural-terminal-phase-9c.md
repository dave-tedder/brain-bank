# Neural Terminal Phase 9c: Chat Agent + Search + Thoughts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a conversational chat agent (OpenRouter + Open Brain REST), rebuild /search and /thoughts pages with the Neural Terminal theme, and wire up a slide-out chat panel (desktop) + /chat page (mobile).

**Architecture:** Chat API route proxies user messages to Claude Sonnet via OpenRouter, injecting context from Open Brain's REST API (semantic search + wiki pages + stats). The ChatPanel is a client component that streams responses via the Vercel AI SDK's `useChat` hook. ThoughtCard gets reskinned with the green phosphor palette. Search and thoughts pages are server components that reuse ThoughtCard.

**Tech Stack:** Next.js 15 App Router, Vercel AI SDK (`ai` + `@ai-sdk/openai`), OpenRouter API, Tailwind CSS 4, VT323 + IBM Plex Mono fonts.

**Existing theme reference:** `src/app/globals.css` has all CSS variables (`--bg-primary`, `--bg-surface`, `--border`, `--text-primary`, `--accent`, etc.), utility classes (`.card`, `.scanline-hover`, `.font-terminal`, `.text-glow`, `.border-glow`), and animations (`fadeSlideUp`, `terminalBlink`, `glowPulse`).

**Open Brain REST API:**
- Base: `https://dvsvzlwxhmqwhmknwmdr.supabase.co/functions/v1/open-brain-mcp`
- Auth header: `x-brain-key: de383f8c091bedab1fe8a961fba9388caf6e7333461f68641a2ac1001e3e98bc`
- `GET /search?query=...&limit=10&threshold=0.3` returns `{ results: [{ content, similarity, metadata, created_at }] }`
- `GET /pages?query=...` returns `{ pages: [{ slug, title, page_type, content, backlinks }] }`
- `GET /stats` returns `{ total_thoughts, sources, types, ... }`

**Environment variables** (already in Railway, use `process.env` server-side only):
- `OPENROUTER_API_KEY` (for chat LLM + embeddings)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (for direct DB queries on thoughts/search pages)
- `OPEN_BRAIN_API_KEY` = `de383f8c091bedab1fe8a961fba9388caf6e7333461f68641a2ac1001e3e98bc` (for chat API route to call Open Brain REST; will add to Railway if not present, or hardcode since it's not a secret per se, it's already in the public CLAUDE.md)

---

### Task 1: Open Brain API helper (`src/lib/openBrainApi.ts`)

**Files:**
- Create: `src/lib/openBrainApi.ts`

This module centralizes calls to the Open Brain REST API so the chat route doesn't have inline fetch logic.

- [ ] **Step 1: Create the API helper**

```typescript
// src/lib/openBrainApi.ts

const BASE_URL =
  "https://dvsvzlwxhmqwhmknwmdr.supabase.co/functions/v1/open-brain-mcp";
const API_KEY =
  process.env.OPEN_BRAIN_API_KEY ||
  "de383f8c091bedab1fe8a961fba9388caf6e7333461f68641a2ac1001e3e98bc";

async function brainFetch(path: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "x-brain-key": API_KEY },
  });
  if (!res.ok) return null;
  return res.json();
}

export async function searchThoughts(
  query: string,
  limit = 8
): Promise<{ content: string; similarity: number; metadata: Record<string, unknown> }[]> {
  const data = (await brainFetch(
    `/search?query=${encodeURIComponent(query)}&limit=${limit}&threshold=0.3`
  )) as { results?: { content: string; similarity: number; metadata: Record<string, unknown> }[] } | null;
  return data?.results ?? [];
}

export async function searchPages(
  query: string
): Promise<{ slug: string; title: string; page_type: string; content: string }[]> {
  const data = (await brainFetch(
    `/pages?query=${encodeURIComponent(query)}`
  )) as { pages?: { slug: string; title: string; page_type: string; content: string }[] } | null;
  return data?.pages ?? [];
}

export async function getStats(): Promise<Record<string, unknown> | null> {
  return (await brainFetch("/stats")) as Record<string, unknown> | null;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /tmp/open-brain-dashboard && npx tsc --noEmit src/lib/openBrainApi.ts 2>&1 || npm run build 2>&1 | tail -20`
Expected: No type errors related to this file.

- [ ] **Step 3: Commit**

```bash
cd /tmp/open-brain-dashboard
git add src/lib/openBrainApi.ts
git commit -m "feat: Open Brain REST API helper for chat context"
```

---

### Task 2: Chat API route (`src/app/api/chat/route.ts`)

**Files:**
- Create: `src/app/api/chat/route.ts`

Uses the Vercel AI SDK's `streamText` with `@ai-sdk/openai` pointed at OpenRouter. Gathers context from Open Brain in parallel, injects it as a system message, streams the response.

- [ ] **Step 1: Create the chat API route**

```typescript
// src/app/api/chat/route.ts

import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";
import { searchThoughts, searchPages } from "@/lib/openBrainApi";

export const maxDuration = 30;

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

const SYSTEM_PROMPT = `You are the Open Brain neural interface. You have access to Dave Tedder's semantic memory system containing thoughts, wiki pages, client records, and business context.

Answer questions using the provided context. Be direct, specific, and reference the source material when relevant. If the context doesn't contain the answer, say so honestly.

Use a slightly technical, terminal-friendly tone. Keep responses concise but thorough. Format with markdown when it helps readability.`;

export async function POST(req: Request) {
  const { messages } = await req.json();

  // Extract the latest user message for context gathering
  const lastUserMessage = [...messages]
    .reverse()
    .find((m: { role: string }) => m.role === "user");
  const query = lastUserMessage?.content ?? "";

  // Gather context from Open Brain in parallel
  const [thoughts, pages] = await Promise.all([
    searchThoughts(query, 8),
    searchPages(query),
  ]);

  // Build context block
  const contextParts: string[] = [];

  if (thoughts.length > 0) {
    contextParts.push("## Relevant Thoughts\n");
    for (const t of thoughts) {
      const sim = (t.similarity * 100).toFixed(0);
      const meta = t.metadata;
      const tags = [
        meta.type && `type:${meta.type}`,
        meta.project && `project:${meta.project}`,
        Array.isArray(meta.topics) && meta.topics.length > 0 && `topics:${(meta.topics as string[]).join(",")}`,
      ]
        .filter(Boolean)
        .join(" | ");
      contextParts.push(`[${sim}% match${tags ? " | " + tags : ""}]\n${t.content}\n`);
    }
  }

  if (pages.length > 0) {
    contextParts.push("## Relevant Wiki Pages\n");
    for (const p of pages.slice(0, 3)) {
      // Truncate long page content to avoid token overflow
      const content =
        p.content.length > 1500
          ? p.content.slice(0, 1500) + "\n...[truncated]"
          : p.content;
      contextParts.push(`### ${p.title} (${p.page_type})\n${content}\n`);
    }
  }

  const contextBlock =
    contextParts.length > 0
      ? `\n\n<context>\n${contextParts.join("\n")}</context>`
      : "\n\n<context>No relevant context found in Open Brain.</context>";

  const result = streamText({
    model: openrouter("anthropic/claude-sonnet-4"),
    system: SYSTEM_PROMPT + contextBlock,
    messages,
  });

  return result.toDataStreamResponse();
}
```

- [ ] **Step 2: Verify build**

Run: `cd /tmp/open-brain-dashboard && npm run build 2>&1 | tail -20`
Expected: Build succeeds. The `/api/chat` route appears in the output.

- [ ] **Step 3: Commit**

```bash
cd /tmp/open-brain-dashboard
git add src/app/api/chat/route.ts
git commit -m "feat: chat API route with OpenRouter + Open Brain context"
```

---

### Task 3: ChatPanel + ChatFAB (`src/components/ChatPanel.tsx`, `src/components/ChatFAB.tsx`)

**Files:**
- Create: `src/components/ChatPanel.tsx`
- Create: `src/components/ChatFAB.tsx`
- Modify: `src/app/layout.tsx` (add ChatFAB to the layout)

ChatPanel is a slide-out panel (right side on desktop, full-screen on mobile) with a terminal-style chat UI. ChatFAB is a floating action button that toggles it. Both are client components.

- [ ] **Step 1: Create ChatPanel.tsx**

```tsx
// src/components/ChatPanel.tsx
"use client";

import { useChat } from "ai/react";
import { useRef, useEffect } from "react";

interface ChatPanelProps {
  open: boolean;
  onClose: () => void;
}

export default function ChatPanel({ open, onClose }: ChatPanelProps) {
  const { messages, input, handleInputChange, handleSubmit, isLoading } =
    useChat({ api: "/api/chat" });
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Focus input when panel opens
  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [open]);

  return (
    <>
      {/* Backdrop (mobile) */}
      {open && (
        <div
          className="fixed inset-0 bg-black/60 z-[60] md:hidden"
          onClick={onClose}
        />
      )}

      {/* Panel */}
      <div
        className={`
          fixed z-[70] flex flex-col
          bg-[var(--bg-primary)] border-l border-[var(--border)]
          transition-transform duration-300 ease-out
          /* Mobile: full screen from bottom */
          inset-0 md:inset-auto
          /* Desktop: right side panel */
          md:top-0 md:right-0 md:bottom-0 md:w-[420px]
          ${open ? "translate-x-0" : "translate-x-full"}
        `}
        style={{
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]"
          style={{ background: "var(--bg-surface)" }}
        >
          <div className="flex items-center gap-2">
            <span className="font-terminal text-lg text-[var(--text-primary)]">
              NEURAL INTERFACE
            </span>
            <span
              className="inline-block w-2 h-2 rounded-full bg-[var(--accent)]"
              style={{ animation: "glowPulse 2s ease-in-out infinite" }}
            />
          </div>
          <button
            onClick={onClose}
            className="font-terminal text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors text-xl px-2"
          >
            [X]
          </button>
        </div>

        {/* Messages */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-4 space-y-4"
        >
          {messages.length === 0 && (
            <div className="text-center py-12">
              <div className="font-terminal text-2xl text-[var(--text-primary)] text-glow mb-3">
                {">"}_
              </div>
              <p className="text-sm text-[var(--text-muted)] font-mono">
                Query the neural network.
              </p>
              <p className="text-xs text-[var(--text-muted)] font-mono mt-1 opacity-60">
                Ask about thoughts, clients, projects, or anything in memory.
              </p>
            </div>
          )}

          {messages.map((m) => (
            <div key={m.id} className="animate-in">
              {m.role === "user" ? (
                <div className="flex gap-2">
                  <span className="font-terminal text-[var(--text-muted)] shrink-0 pt-0.5">
                    {">"}
                  </span>
                  <p className="text-sm font-mono text-[var(--text-secondary)] whitespace-pre-wrap">
                    {m.content}
                  </p>
                </div>
              ) : (
                <div className="pl-4 border-l border-[var(--border)]">
                  <div className="text-sm font-mono text-[var(--text-body)] whitespace-pre-wrap leading-relaxed prose-terminal">
                    {m.content}
                  </div>
                </div>
              )}
            </div>
          ))}

          {isLoading && messages[messages.length - 1]?.role === "user" && (
            <div className="pl-4 border-l border-[var(--border)]">
              <span
                className="font-terminal text-[var(--text-primary)]"
                style={{ animation: "terminalBlink steps(1) 0.8s infinite" }}
              >
                _
              </span>
            </div>
          )}
        </div>

        {/* Input */}
        <form
          onSubmit={handleSubmit}
          className="border-t border-[var(--border)] p-3 flex gap-2"
          style={{ background: "var(--bg-surface)" }}
        >
          <span className="font-terminal text-[var(--text-primary)] pt-2 shrink-0">
            {">"}
          </span>
          <input
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            placeholder="query..."
            disabled={isLoading}
            className="flex-1 bg-transparent border-none outline-none text-sm font-mono text-[var(--text-secondary)] placeholder:text-[var(--text-muted)] disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="font-terminal text-sm px-3 py-1.5 rounded-md border border-[var(--border)] text-[var(--text-primary)] hover:border-[var(--accent)] hover:text-glow disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          >
            SEND
          </button>
        </form>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Create ChatFAB.tsx**

```tsx
// src/components/ChatFAB.tsx
"use client";

import { useState } from "react";
import ChatPanel from "./ChatPanel";

export default function ChatFAB() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* FAB button - hidden when panel is open */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed z-50 bottom-20 right-4 md:bottom-6 md:right-6 w-12 h-12 rounded-full bg-[var(--bg-surface)] border border-[var(--border)] flex items-center justify-center hover:border-[var(--accent)] hover:shadow-[0_0_16px_rgba(0,255,65,0.2)] transition-all duration-300 group"
          aria-label="Open chat"
        >
          <span className="font-terminal text-lg text-[var(--text-primary)] group-hover:text-glow">
            {">_"}
          </span>
        </button>
      )}

      <ChatPanel open={open} onClose={() => setOpen(false)} />
    </>
  );
}
```

- [ ] **Step 3: Add ChatFAB to layout.tsx**

In `src/app/layout.tsx`, import and render `<ChatFAB />` inside the `<body>`, after `<NavBottom />`:

Add import: `import ChatFAB from "@/components/ChatFAB";`

Add `<ChatFAB />` right after `<NavBottom />` inside the `relative z-10` div.

- [ ] **Step 4: Verify build**

Run: `cd /tmp/open-brain-dashboard && npm run build 2>&1 | tail -20`
Expected: Build succeeds. No type errors.

- [ ] **Step 5: Commit**

```bash
cd /tmp/open-brain-dashboard
git add src/components/ChatPanel.tsx src/components/ChatFAB.tsx src/app/layout.tsx
git commit -m "feat: ChatPanel slide-out + ChatFAB floating button"
```

---

### Task 4: Mobile /chat page (`src/app/chat/page.tsx`)

**Files:**
- Create: `src/app/chat/page.tsx`
- Modify: `src/components/NavBottom.tsx` (add CHAT tab)

A dedicated full-screen chat page for mobile. Reuses the same `/api/chat` endpoint and `useChat` hook.

- [ ] **Step 1: Create the /chat page**

```tsx
// src/app/chat/page.tsx
"use client";

import { useChat } from "ai/react";
import { useRef, useEffect } from "react";

export default function ChatPage() {
  const { messages, input, handleInputChange, handleSubmit, isLoading } =
    useChat({ api: "/api/chat" });
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 120px)" }}>
      {/* Header */}
      <div className="animate-in mb-4">
        <h1 className="font-terminal text-2xl text-[var(--text-primary)] text-glow">
          NEURAL INTERFACE
        </h1>
        <p className="text-xs font-mono text-[var(--text-muted)] mt-1">
          Query the semantic memory network
        </p>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-4 mb-4">
        {messages.length === 0 && (
          <div className="text-center py-16">
            <div
              className="font-terminal text-4xl text-[var(--text-primary)] text-glow mb-4"
              style={{ animation: "terminalBlink steps(1) 1.2s infinite" }}
            >
              {">"}_
            </div>
            <p className="text-sm text-[var(--text-muted)] font-mono">
              Ask about thoughts, clients, projects, or anything in memory.
            </p>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className="animate-in">
            {m.role === "user" ? (
              <div className="flex gap-2">
                <span className="font-terminal text-[var(--text-muted)] shrink-0 pt-0.5">
                  {">"}
                </span>
                <p className="text-sm font-mono text-[var(--text-secondary)] whitespace-pre-wrap">
                  {m.content}
                </p>
              </div>
            ) : (
              <div className="pl-4 border-l border-[var(--border)]">
                <div className="text-sm font-mono text-[var(--text-body)] whitespace-pre-wrap leading-relaxed">
                  {m.content}
                </div>
              </div>
            )}
          </div>
        ))}

        {isLoading && messages[messages.length - 1]?.role === "user" && (
          <div className="pl-4 border-l border-[var(--border)]">
            <span
              className="font-terminal text-[var(--text-primary)]"
              style={{ animation: "terminalBlink steps(1) 0.8s infinite" }}
            >
              _
            </span>
          </div>
        )}
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="flex gap-2 p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)]"
      >
        <span className="font-terminal text-[var(--text-primary)] pt-1.5 shrink-0">
          {">"}
        </span>
        <input
          ref={inputRef}
          value={input}
          onChange={handleInputChange}
          placeholder="query..."
          disabled={isLoading}
          className="flex-1 bg-transparent border-none outline-none text-sm font-mono text-[var(--text-secondary)] placeholder:text-[var(--text-muted)] disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          className="font-terminal text-sm px-3 py-1.5 rounded-md border border-[var(--border)] text-[var(--text-primary)] hover:border-[var(--accent)] hover:text-glow disabled:opacity-30 disabled:cursor-not-allowed transition-all"
        >
          SEND
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Add CHAT tab to NavBottom.tsx**

In `src/components/NavBottom.tsx`, add a new entry to the `TABS` array:

```typescript
{ href: "/chat", label: "CHAT", char: ">" },
```

Place it after the FIND entry so it's the last tab on the right.

- [ ] **Step 3: Verify build**

Run: `cd /tmp/open-brain-dashboard && npm run build 2>&1 | tail -20`
Expected: Build succeeds. `/chat` route appears in output.

- [ ] **Step 4: Commit**

```bash
cd /tmp/open-brain-dashboard
git add src/app/chat/page.tsx src/components/NavBottom.tsx
git commit -m "feat: /chat mobile page + bottom nav tab"
```

---

### Task 5: Reskin ThoughtCard.tsx with Neural Terminal theme

**Files:**
- Modify: `src/components/ThoughtCard.tsx`

Replace all old gold/warm theme references with the Neural Terminal palette. Keep the same props interface and expand/collapse behavior.

- [ ] **Step 1: Rewrite ThoughtCard.tsx**

Replace the full file content. Key changes:
- Type badge colors: green-tinted variants instead of warm colors
- Topic badges: green accent instead of gold
- Hover/active borders: `var(--accent)` green glow instead of gold
- Similarity badges: green gradient scale
- Scanline hover effect on cards
- VT323 for labels, IBM Plex Mono for content
- All `var(--gold)` references replaced with `var(--accent)` or `var(--text-primary)`

```tsx
"use client";

import { useState } from "react";

interface ThoughtCardProps {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  similarity?: number;
  topicBaseUrl?: string;
}

export default function ThoughtCard({
  content,
  metadata,
  created_at,
  similarity,
  topicBaseUrl,
}: ThoughtCardProps) {
  const [expanded, setExpanded] = useState(false);
  const m = metadata || {};
  const topics = Array.isArray(m.topics) ? (m.topics as string[]) : [];
  const people = Array.isArray(m.people) ? (m.people as string[]) : [];
  const actionItems = Array.isArray(m.action_items)
    ? (m.action_items as string[])
    : [];
  const type = (m.type as string) || "unknown";
  const source = m.source as string;
  const project = m.project as string;
  const priority = m.priority as string;
  const isLong = content.length > 200;
  const displayContent =
    !expanded && isLong ? content.slice(0, 200) + "..." : content;

  const typeColors: Record<string, string> = {
    observation: "bg-[rgba(0,255,65,0.1)] text-[#4ade80]",
    task: "bg-[rgba(251,191,36,0.1)] text-[var(--warning)]",
    idea: "bg-[rgba(139,92,246,0.15)] text-[#a78bfa]",
    reference: "bg-[rgba(0,255,65,0.06)] text-[var(--text-muted)]",
    person_note: "bg-[rgba(0,255,65,0.08)] text-[var(--text-secondary)]",
  };

  return (
    <div
      className={`
        card scanline-hover cursor-pointer
        ${expanded ? "border-[var(--border-active)] border-glow" : ""}
      `}
      onClick={() => setExpanded(!expanded)}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex gap-2 flex-wrap items-center">
          {/* Similarity badge */}
          {similarity !== undefined && (
            <span
              className={`
                px-2 py-0.5 rounded text-xs font-terminal
                ${
                  similarity > 0.7
                    ? "bg-[rgba(0,255,65,0.15)] text-[var(--text-primary)]"
                    : similarity > 0.5
                    ? "bg-[rgba(0,255,65,0.08)] text-[var(--text-secondary)]"
                    : "bg-[rgba(0,255,65,0.04)] text-[var(--text-muted)]"
                }
              `}
            >
              {(similarity * 100).toFixed(0)}%
            </span>
          )}

          {/* Type badge */}
          <span
            className={`px-2 py-0.5 rounded text-xs font-terminal uppercase tracking-wider ${typeColors[type] || "bg-[var(--accent-dim)] text-[var(--text-muted)]"}`}
          >
            {type}
          </span>

          {/* Source */}
          {source && (
            <span className="px-2 py-0.5 rounded text-xs font-mono bg-[var(--accent-dim)] text-[var(--text-muted)]">
              {source}
            </span>
          )}

          {/* Priority */}
          {priority && priority !== "normal" && (
            <span
              className={`text-xs font-terminal uppercase tracking-wider ${
                priority === "high"
                  ? "text-[var(--danger)]"
                  : "text-[var(--text-muted)] opacity-60"
              }`}
            >
              {priority === "high" ? "HIGH" : priority}
            </span>
          )}

          {/* Topics */}
          {topics.map((tp) =>
            topicBaseUrl ? (
              <a
                key={tp}
                href={`${topicBaseUrl}${encodeURIComponent(tp)}`}
                onClick={(e) => e.stopPropagation()}
                className="px-2 py-0.5 rounded text-xs font-mono bg-[var(--accent-dim)] text-[var(--text-primary)] hover:bg-[var(--accent-glow)] transition-colors"
              >
                {tp}
              </a>
            ) : (
              <span
                key={tp}
                className="px-2 py-0.5 rounded text-xs font-mono bg-[var(--accent-dim)] text-[var(--text-primary)]"
              >
                {tp}
              </span>
            )
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs font-mono text-[var(--text-muted)]">
            {new Date(created_at).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year:
                new Date(created_at).getFullYear() !== new Date().getFullYear()
                  ? "numeric"
                  : undefined,
            })}
          </span>
          <span
            className={`text-[var(--text-muted)] text-xs font-terminal transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
          >
            ▾
          </span>
        </div>
      </div>

      {/* Content */}
      <p className="text-sm leading-relaxed whitespace-pre-wrap font-mono text-[var(--text-body)]">
        {displayContent}
      </p>

      {/* Expanded details */}
      {expanded && (
        <div className="mt-4 pt-4 border-t border-[var(--border)] space-y-3 animate-in">
          {people.length > 0 && (
            <div className="flex items-start gap-2">
              <span className="text-xs font-terminal uppercase tracking-wider text-[var(--text-muted)] w-16 shrink-0 pt-0.5">
                People
              </span>
              <div className="flex gap-1.5 flex-wrap">
                {people.map((p) => (
                  <span
                    key={p}
                    className="px-2 py-0.5 rounded text-xs font-mono bg-[var(--accent-dim)] text-[var(--text-secondary)] border border-[var(--border)]"
                  >
                    {p}
                  </span>
                ))}
              </div>
            </div>
          )}

          {project && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-terminal uppercase tracking-wider text-[var(--text-muted)] w-16 shrink-0">
                Project
              </span>
              <span className="text-xs font-mono text-[var(--text-primary)]">
                {project}
              </span>
            </div>
          )}

          {actionItems.length > 0 && (
            <div className="flex items-start gap-2">
              <span className="text-xs font-terminal uppercase tracking-wider text-[var(--text-muted)] w-16 shrink-0 pt-0.5">
                Actions
              </span>
              <div className="space-y-1">
                {actionItems.map((item, i) => (
                  <div
                    key={i}
                    className="text-xs font-mono text-[var(--text-body)] flex items-start gap-1.5"
                  >
                    <span className="text-[var(--text-primary)] mt-px">
                      &gt;
                    </span>
                    {item}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <span className="text-xs font-terminal uppercase tracking-wider text-[var(--text-muted)] w-16 shrink-0">
              Captured
            </span>
            <span className="text-xs font-mono text-[var(--text-muted)]">
              {new Date(created_at).toLocaleString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          </div>
        </div>
      )}

      {isLong && !expanded && (
        <div className="mt-2 text-xs font-terminal text-[var(--text-muted)] uppercase tracking-wider">
          [expand]
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `cd /tmp/open-brain-dashboard && npm run build 2>&1 | tail -20`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
cd /tmp/open-brain-dashboard
git add src/components/ThoughtCard.tsx
git commit -m "feat: ThoughtCard reskinned with Neural Terminal theme"
```

---

### Task 6: Rebuild /thoughts page with Neural Terminal theme

**Files:**
- Modify: `src/app/thoughts/page.tsx`

Replace all old theme references. Keep the same server-side data fetching and filtering logic. Restyle with terminal aesthetic: VT323 headers, green filter pills, `.card` utility for filter bar, pagination with terminal styling.

- [ ] **Step 1: Rewrite thoughts/page.tsx**

Replace full file content. Key changes:
- Page header: VT323 font, green text-glow
- Filter bar: uses `.card` class, green active pills instead of gold
- FilterLink component: green active state with border-glow
- Pagination: terminal-style `[PREV]` `[NEXT]` buttons
- Remove all Playfair Display, `var(--gold)`, warm color references
- Count display in terminal format: `> 847 THOUGHTS`

```tsx
import { supabase } from "@/lib/supabase";
import Link from "next/link";
import ThoughtCard from "@/components/ThoughtCard";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{
    type?: string;
    topic?: string;
    person?: string;
    days?: string;
    page?: string;
  }>;
}

const PAGE_SIZE = 25;

export default async function ThoughtsPage({ searchParams }: Props) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page || "1"));
  const offset = (page - 1) * PAGE_SIZE;

  let query = supabase()
    .from("thoughts")
    .select("id, content, metadata, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (params.type) query = query.contains("metadata", { type: params.type });
  if (params.topic)
    query = query.contains("metadata", { topics: [params.topic] });
  if (params.person)
    query = query.contains("metadata", { people: [params.person] });
  if (params.days) {
    const since = new Date();
    since.setDate(since.getDate() - parseInt(params.days));
    query = query.gte("created_at", since.toISOString());
  }

  const { data, count } = await query;
  const totalPages = Math.ceil((count || 0) / PAGE_SIZE);

  const { data: allThoughts } = await supabase()
    .from("thoughts")
    .select("metadata");
  const allTypes = new Set<string>();
  const allTopics = new Set<string>();
  for (const t of allThoughts || []) {
    const m = (t.metadata || {}) as Record<string, unknown>;
    if (m.type) allTypes.add(m.type as string);
    if (Array.isArray(m.topics))
      for (const tp of m.topics) allTopics.add(tp as string);
  }

  function buildUrl(overrides: Record<string, string | undefined>) {
    const p = { ...params, ...overrides, page: undefined };
    const qs = Object.entries(p)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
      .join("&");
    return `/thoughts${qs ? "?" + qs : ""}`;
  }

  const hasFilters = params.type || params.topic || params.days;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-in">
        <h1 className="font-terminal text-3xl text-[var(--text-primary)] text-glow">
          THOUGHT LOG
        </h1>
        <p className="text-xs font-mono text-[var(--text-muted)] mt-1 uppercase tracking-wider">
          {count} record{count !== 1 ? "s" : ""}
          {params.type && ` | type:${params.type}`}
          {params.topic && ` | topic:${params.topic}`}
          {params.days && ` | last ${params.days}d`}
        </p>
      </div>

      {/* Filters */}
      <div className="animate-in stagger-1 card">
        <div className="flex gap-2 flex-wrap items-center">
          <FilterLink
            href={buildUrl({
              type: undefined,
              topic: undefined,
              person: undefined,
              days: undefined,
            })}
            active={!hasFilters}
            label="ALL"
          />

          <span className="w-px h-4 bg-[var(--border)] mx-1" />
          <span className="text-[10px] font-terminal uppercase tracking-widest text-[var(--text-muted)] mr-1">
            TYPE
          </span>
          {[...allTypes].sort().map((t) => (
            <FilterLink
              key={t}
              href={buildUrl({ type: params.type === t ? undefined : t })}
              active={params.type === t}
              label={t.toUpperCase()}
            />
          ))}

          <span className="w-px h-4 bg-[var(--border)] mx-1" />
          <span className="text-[10px] font-terminal uppercase tracking-widest text-[var(--text-muted)] mr-1">
            TIME
          </span>
          {["7", "30", "90"].map((d) => (
            <FilterLink
              key={d}
              href={buildUrl({ days: params.days === d ? undefined : d })}
              active={params.days === d}
              label={`${d}D`}
            />
          ))}
        </div>
      </div>

      {/* Results */}
      <div className="space-y-3">
        {(data || []).map((t, i) => (
          <div
            key={t.id}
            className={`animate-in stagger-${Math.min(i, 8)}`}
          >
            <ThoughtCard
              id={t.id}
              content={t.content}
              metadata={t.metadata as Record<string, unknown>}
              created_at={t.created_at}
              topicBaseUrl="/thoughts?topic="
            />
          </div>
        ))}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex gap-3 justify-center items-center animate-in">
          {page > 1 && (
            <Link
              href={buildUrl({ page: String(page - 1) })}
              className="font-terminal text-sm px-4 py-2 rounded-md border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] transition-all"
            >
              [PREV]
            </Link>
          )}
          <span className="font-terminal text-sm text-[var(--text-muted)]">
            {page}/{totalPages}
          </span>
          {page < totalPages && (
            <Link
              href={buildUrl({ page: String(page + 1) })}
              className="font-terminal text-sm px-4 py-2 rounded-md border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] transition-all"
            >
              [NEXT]
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function FilterLink({
  href,
  active,
  label,
}: {
  href: string;
  active: boolean;
  label: string;
}) {
  return (
    <Link
      href={href}
      className={`
        px-3 py-1 rounded text-xs font-terminal uppercase tracking-wider transition-all duration-200
        ${
          active
            ? "bg-[var(--accent-dim)] text-[var(--text-primary)] border border-[var(--accent)] border-glow"
            : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] border border-transparent hover:border-[var(--border)]"
        }
      `}
    >
      {label}
    </Link>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `cd /tmp/open-brain-dashboard && npm run build 2>&1 | tail -20`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
cd /tmp/open-brain-dashboard
git add src/app/thoughts/page.tsx
git commit -m "feat: thoughts page rebuilt with Neural Terminal theme"
```

---

### Task 7: Rebuild /search page with Neural Terminal theme

**Files:**
- Modify: `src/app/search/page.tsx`

Replace all old theme references. Keep the same server-side embedding + RPC logic. Restyle with terminal aesthetic: blinking cursor in input, terminal prompt prefix, green-tinted result cards.

- [ ] **Step 1: Rewrite search/page.tsx**

Replace full file content. Key changes:
- Header: VT323, green glow
- Search input: terminal prompt `>` prefix, green border on focus, no gold references
- Button: green border + text instead of gold fill
- Empty states: terminal aesthetic with `>_` prompt
- Remove all Playfair Display, `var(--gold)`, warm color references

```tsx
import { supabase } from "@/lib/supabase";
import ThoughtCard from "@/components/ThoughtCard";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ q?: string }>;
}

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  const d = await r.json();
  return d.data[0].embedding;
}

export default async function SearchPage({ searchParams }: Props) {
  const params = await searchParams;
  const query = params.q || "";

  let results: {
    id: string;
    content: string;
    similarity: number;
    metadata: Record<string, unknown>;
    created_at: string;
  }[] = [];

  if (query) {
    const embedding = await getEmbedding(query);
    const { data } = await supabase().rpc("match_thoughts", {
      query_embedding: embedding,
      match_threshold: 0.3,
      match_count: 20,
      filter: {},
    });
    results = data || [];
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-in">
        <h1 className="font-terminal text-3xl text-[var(--text-primary)] text-glow">
          SEMANTIC SEARCH
        </h1>
        <p className="text-xs font-mono text-[var(--text-muted)] mt-1 uppercase tracking-wider">
          Vector similarity search across all thoughts
        </p>
      </div>

      {/* Search form */}
      <form className="animate-in stagger-1 flex gap-3">
        <div className="flex-1 relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 font-terminal text-[var(--text-primary)]">
            {">"}
          </span>
          <input
            name="q"
            type="text"
            defaultValue={query}
            placeholder="query..."
            autoFocus
            className="w-full pl-8 pr-4 py-3 rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-sm font-mono text-[var(--text-secondary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] focus:shadow-[0_0_16px_rgba(0,255,65,0.1)] transition-all duration-300"
          />
        </div>
        <button
          type="submit"
          className="font-terminal text-sm px-5 py-3 rounded-lg border border-[var(--border)] text-[var(--text-primary)] hover:border-[var(--accent)] hover:text-glow active:scale-[0.98] transition-all duration-200"
        >
          SEARCH
        </button>
      </form>

      {/* Results count */}
      {query && (
        <p className="text-xs font-mono text-[var(--text-muted)] animate-in stagger-2 uppercase tracking-wider">
          {results.length} result{results.length !== 1 ? "s" : ""} for &ldquo;{query}&rdquo;
        </p>
      )}

      {/* Results */}
      <div className="space-y-3">
        {results.map((r, i) => (
          <div
            key={r.id || i}
            className={`animate-in stagger-${Math.min(i + 2, 8)}`}
          >
            <ThoughtCard
              id={r.id || String(i)}
              content={r.content}
              metadata={r.metadata}
              created_at={r.created_at}
              similarity={r.similarity}
            />
          </div>
        ))}
      </div>

      {/* Empty state */}
      {query && results.length === 0 && (
        <div className="text-center py-16 animate-in">
          <div className="font-terminal text-2xl text-[var(--text-muted)] mb-3">
            NO MATCHES
          </div>
          <p className="text-xs font-mono text-[var(--text-muted)]">
            Try different phrasing or broader terms.
          </p>
        </div>
      )}

      {/* No query state */}
      {!query && (
        <div className="text-center py-16 animate-in stagger-2">
          <div
            className="font-terminal text-3xl text-[var(--text-primary)] text-glow mb-4"
            style={{ animation: "terminalBlink steps(1) 1.2s infinite" }}
          >
            {">_"}
          </div>
          <p className="text-sm font-mono text-[var(--text-muted)]">
            Search by meaning, not keywords.
          </p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `cd /tmp/open-brain-dashboard && npm run build 2>&1 | tail -20`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
cd /tmp/open-brain-dashboard
git add src/app/search/page.tsx
git commit -m "feat: search page rebuilt with Neural Terminal theme"
```

---

### Task 8: Final verification

**Files:** None (read-only checks)

- [ ] **Step 1: Full build**

Run: `cd /tmp/open-brain-dashboard && npm run build 2>&1`
Expected: Build succeeds with zero errors. All routes listed: `/`, `/graph`, `/wiki`, `/wiki/[slug]`, `/thoughts`, `/search`, `/chat`, `/audit`, `/clients`, `/clients/[id]`, `/api/chat`, `/api/wiki/[slug]`.

- [ ] **Step 2: Verify no old theme leaks in modified files**

Run: `cd /tmp/open-brain-dashboard && grep -rn "Playfair\|var(--gold)\|var(--bg-card)\|var(--bg-hover)\|var(--border-subtle)\|var(--gold-dim)\|var(--gold-hover)" src/app/thoughts/page.tsx src/app/search/page.tsx src/components/ThoughtCard.tsx src/components/ChatPanel.tsx src/components/ChatFAB.tsx src/app/chat/page.tsx`
Expected: No matches. (Old pages like audit/clients still have old references, that's Phase 9d.)

- [ ] **Step 3: Verify git status is clean**

Run: `cd /tmp/open-brain-dashboard && git status && git log --oneline -10`
Expected: Clean working tree with new commits for each task.
