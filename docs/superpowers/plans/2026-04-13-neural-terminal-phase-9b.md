# Neural Terminal Phase 9b: Knowledge Graph + Wiki

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the interactive knowledge graph visualization and wiki pages for the Open Brain dashboard, letting Dave explore compiled pages and their backlink connections visually.

**Architecture:** Server components fetch compiled_pages from Supabase and pass lightweight graph data (no content) to client-side force-graph components. A thin API route serves individual page content on demand for the graph side panel. Wiki pages use server-side rendering with react-markdown for compiled page content.

**Tech Stack:** Next.js 15 App Router, react-force-graph-2d (already installed), react-markdown + remark-gfm (to install), Supabase server client, Tailwind CSS 4.

---

## File Structure

```
src/
  app/
    api/
      wiki/
        [slug]/
          route.ts          # GET handler: fetch single compiled_page content by slug
    graph/
      page.tsx              # Server component: fetch all pages (no content), render GraphClient
    wiki/
      page.tsx              # Server component: list all compiled pages, filterable by type
      [slug]/
        page.tsx            # Server component: fetch one page by slug, render markdown + backlinks
  components/
    KnowledgeGraph.tsx      # Client component: react-force-graph-2d wrapper, full-size
    MiniGraph.tsx           # Client component: small graph preview for dashboard
    PageContent.tsx         # Client component: rendered markdown with react-markdown
  lib/
    graph-data.ts           # Shared types + transform function (compiled_pages -> nodes/links)
```

**What changes in existing files:**
- `src/app/page.tsx` (dashboard): add MiniGraph preview section after the Activity chart

---

### Task 1: Install react-markdown + remark-gfm

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install dependencies**

```bash
cd /tmp/open-brain-dashboard && npm install react-markdown remark-gfm
```

- [ ] **Step 2: Verify install**

```bash
cd /tmp/open-brain-dashboard && npm run build 2>&1 | tail -3
```

Expected: build succeeds (no new code yet, just deps).

- [ ] **Step 3: Commit**

```bash
cd /tmp/open-brain-dashboard && git add package.json package-lock.json && git commit -m "deps: add react-markdown and remark-gfm for wiki pages"
```

---

### Task 2: Build graph-data.ts (shared types + transform)

**Files:**
- Create: `src/lib/graph-data.ts`

This module defines the TypeScript types used by both KnowledgeGraph and MiniGraph, and the function that transforms raw compiled_pages rows into the node/link format react-force-graph-2d expects.

- [ ] **Step 1: Create the graph data module**

```ts
// src/lib/graph-data.ts

export interface CompiledPageRow {
  id: string;
  slug: string;
  title: string;
  page_type: string;
  backlinks: string[] | null;
  last_compiled: string | null;
}

export interface GraphNode {
  id: string;
  slug: string;
  title: string;
  pageType: string;
  val: number; // node size (connection count)
}

export interface GraphLink {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

const TYPE_COLORS: Record<string, string> = {
  client: "#4ade80",   // softer green
  topic: "#00ff41",    // phosphor green
  project: "#fbbf24",  // amber
};

export function getNodeColor(pageType: string): string {
  return TYPE_COLORS[pageType] || "#22543d";
}

/**
 * Transform raw compiled_pages rows into react-force-graph-2d data.
 * Filters out links that reference slugs not present in the dataset.
 */
export function buildGraphData(pages: CompiledPageRow[]): GraphData {
  const slugToId = new Map<string, string>();
  for (const p of pages) {
    slugToId.set(p.slug, p.id);
  }

  // Count inbound + outbound connections per node
  const connectionCount = new Map<string, number>();
  const links: GraphLink[] = [];

  for (const p of pages) {
    if (!connectionCount.has(p.id)) connectionCount.set(p.id, 0);

    for (const backlink of p.backlinks || []) {
      const targetId = slugToId.get(backlink);
      if (!targetId || targetId === p.id) continue;
      links.push({ source: p.id, target: targetId });
      connectionCount.set(p.id, (connectionCount.get(p.id) || 0) + 1);
      connectionCount.set(targetId, (connectionCount.get(targetId) || 0) + 1);
    }
  }

  const nodes: GraphNode[] = pages.map((p) => ({
    id: p.id,
    slug: p.slug,
    title: p.title,
    pageType: p.page_type,
    val: Math.max(1, connectionCount.get(p.id) || 0),
  }));

  return { nodes, links };
}

/**
 * Return the top N most-connected nodes and their inter-links.
 * Used by MiniGraph on the dashboard.
 */
export function buildMiniGraphData(pages: CompiledPageRow[], maxNodes = 25): GraphData {
  const full = buildGraphData(pages);
  const sorted = [...full.nodes].sort((a, b) => b.val - a.val).slice(0, maxNodes);
  const keepIds = new Set(sorted.map((n) => n.id));
  const filteredLinks = full.links.filter(
    (l) => keepIds.has(l.source as string) && keepIds.has(l.target as string)
  );
  return { nodes: sorted, links: filteredLinks };
}
```

- [ ] **Step 2: Verify build**

```bash
cd /tmp/open-brain-dashboard && npm run build 2>&1 | tail -3
```

Expected: build succeeds. The module is pure TypeScript with no imports outside the project.

- [ ] **Step 3: Commit**

```bash
cd /tmp/open-brain-dashboard && git add src/lib/graph-data.ts && git commit -m "feat: graph data types and transform utilities"
```

---

### Task 3: Build KnowledgeGraph.tsx

**Files:**
- Create: `src/components/KnowledgeGraph.tsx`

A client component wrapping react-force-graph-2d. Accepts graph data, filter state, and an onNodeClick callback. Handles canvas rendering with the Neural Terminal color scheme.

- [ ] **Step 1: Create the component**

```tsx
// src/components/KnowledgeGraph.tsx
"use client";

import { useRef, useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { GraphData, GraphNode, getNodeColor } from "@/lib/graph-data";

// react-force-graph-2d uses canvas + requestAnimationFrame, must be client-only
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
});

interface KnowledgeGraphProps {
  data: GraphData;
  activeTypes: Set<string>;
  highlightSlug?: string | null;
  onNodeClick?: (node: GraphNode) => void;
  width?: number;
  height?: number;
}

export default function KnowledgeGraph({
  data,
  activeTypes,
  highlightSlug,
  onNodeClick,
  width,
  height,
}: KnowledgeGraphProps) {
  const graphRef = useRef<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [dimensions, setDimensions] = useState({ w: width || 800, h: height || 600 });
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-size to container when width/height not provided
  useEffect(() => {
    if (width && height) {
      setDimensions({ w: width, h: height });
      return;
    }
    function measure() {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setDimensions({ w: rect.width, h: rect.height });
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [width, height]);

  // Filter nodes and links by active types
  const filtered = useCallback(() => {
    const nodes = data.nodes.filter((n) => activeTypes.has(n.pageType));
    const nodeIds = new Set(nodes.map((n) => n.id));
    const links = data.links.filter(
      (l) =>
        nodeIds.has(l.source as string) && nodeIds.has(l.target as string)
    );
    return { nodes, links };
  }, [data, activeTypes]);

  const handleNodeClick = useCallback(
    (node: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (onNodeClick) onNodeClick(node as GraphNode);
    },
    [onNodeClick]
  );

  const paintNode = useCallback(
    (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const n = node as GraphNode & { x: number; y: number };
      const size = Math.max(3, Math.sqrt(n.val) * 2.5);
      const color = getNodeColor(n.pageType);
      const isHighlighted = highlightSlug && n.slug === highlightSlug;

      // Glow for highlighted node
      if (isHighlighted) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, size + 4, 0, 2 * Math.PI);
        ctx.fillStyle = "rgba(0, 255, 65, 0.2)";
        ctx.fill();
      }

      // Node circle
      ctx.beginPath();
      ctx.arc(n.x, n.y, size, 0, 2 * Math.PI);
      ctx.fillStyle = isHighlighted ? "#00ff41" : color;
      ctx.fill();

      // Label (only when zoomed in enough)
      if (globalScale > 1.5 || isHighlighted) {
        const label = n.title;
        const fontSize = Math.max(10, 12 / globalScale);
        ctx.font = `${fontSize}px 'IBM Plex Mono', monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = isHighlighted ? "#00ff41" : "rgba(176, 196, 176, 0.8)";
        ctx.fillText(label, n.x, n.y + size + 2);
      }
    },
    [highlightSlug]
  );

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%" }}>
      <ForceGraph2D
        ref={graphRef}
        graphData={filtered()}
        width={dimensions.w}
        height={dimensions.h}
        nodeCanvasObject={paintNode}
        nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
          const n = node as GraphNode & { x: number; y: number };
          const size = Math.max(3, Math.sqrt(n.val) * 2.5) + 2;
          ctx.beginPath();
          ctx.arc(n.x, n.y, size, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
        }}
        onNodeClick={handleNodeClick}
        linkColor={() => "rgba(0, 255, 65, 0.12)"}
        linkWidth={0.5}
        backgroundColor="transparent"
        cooldownTicks={80}
        d3AlphaDecay={0.03}
        d3VelocityDecay={0.3}
      />
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
cd /tmp/open-brain-dashboard && npm run build 2>&1 | tail -5
```

Expected: build succeeds. The dynamic import of react-force-graph-2d with `ssr: false` avoids server-side canvas issues.

- [ ] **Step 3: Commit**

```bash
cd /tmp/open-brain-dashboard && git add src/components/KnowledgeGraph.tsx && git commit -m "feat: KnowledgeGraph component with force-directed visualization"
```

---

### Task 4: Build the wiki API route + /graph page

**Files:**
- Create: `src/app/api/wiki/[slug]/route.ts`
- Create: `src/app/graph/page.tsx`

The API route serves individual page content by slug (used by the graph side panel on node click). The graph page fetches all pages without content server-side, renders the full-screen graph client component with type filters and a slide-in side panel.

- [ ] **Step 1: Create the wiki API route**

```ts
// src/app/api/wiki/[slug]/route.ts
import { supabase } from "@/lib/supabase";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const decoded = decodeURIComponent(slug);

  const { data, error } = await supabase()
    .from("compiled_pages")
    .select("id, slug, title, page_type, content, backlinks, last_compiled")
    .eq("slug", decoded)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Page not found" }, { status: 404 });
  }

  return NextResponse.json(data);
}
```

- [ ] **Step 2: Create the graph page**

```tsx
// src/app/graph/page.tsx
import { supabase } from "@/lib/supabase";
import { CompiledPageRow } from "@/lib/graph-data";
import GraphClient from "./GraphClient";

export const dynamic = "force-dynamic";

export default async function GraphPage() {
  const { data } = await supabase()
    .from("compiled_pages")
    .select("id, slug, title, page_type, backlinks, last_compiled")
    .order("title");

  const pages = (data || []) as CompiledPageRow[];

  return <GraphClient pages={pages} />;
}
```

- [ ] **Step 3: Create GraphClient (the client component with filters + side panel)**

This is the largest file in the phase. It manages filter state, the selected node, fetching page content on click, and rendering the side panel.

```tsx
// src/app/graph/GraphClient.tsx
"use client";

import { useState, useCallback, useMemo } from "react";
import KnowledgeGraph from "@/components/KnowledgeGraph";
import PageContent from "@/components/PageContent";
import { CompiledPageRow, GraphNode, buildGraphData } from "@/lib/graph-data";

const PAGE_TYPES = ["client", "topic", "project"];
const TYPE_LABELS: Record<string, string> = {
  client: "CLIENTS",
  topic: "TOPICS",
  project: "PROJECTS",
};

interface PageDetail {
  title: string;
  page_type: string;
  slug: string;
  content: string;
  backlinks: string[] | null;
  last_compiled: string | null;
}

export default function GraphClient({ pages }: { pages: CompiledPageRow[] }) {
  const [activeTypes, setActiveTypes] = useState<Set<string>>(
    new Set(PAGE_TYPES)
  );
  const [search, setSearch] = useState("");
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [pageDetail, setPageDetail] = useState<PageDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  const graphData = useMemo(() => buildGraphData(pages), [pages]);

  const highlightSlug = useMemo(() => {
    if (!search.trim()) return null;
    const lower = search.toLowerCase();
    const match = pages.find((p) => p.title.toLowerCase().includes(lower));
    return match?.slug || null;
  }, [search, pages]);

  const toggleType = useCallback((type: string) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        if (next.size > 1) next.delete(type); // keep at least one
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  const handleNodeClick = useCallback(async (node: GraphNode) => {
    setSelectedNode(node);
    setPanelOpen(true);
    setLoading(true);
    setPageDetail(null);
    try {
      const res = await fetch(`/api/wiki/${encodeURIComponent(node.slug)}`);
      if (res.ok) {
        const data = await res.json();
        setPageDetail(data);
      }
    } catch {
      // silently fail, panel shows loading state
    } finally {
      setLoading(false);
    }
  }, []);

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    setSelectedNode(null);
    setPageDetail(null);
  }, []);

  return (
    <div className="fixed inset-0 md:left-[220px]" style={{ background: "var(--bg-primary)" }}>
      {/* Controls overlay */}
      <div
        className="absolute top-0 left-0 right-0 z-20 flex items-center gap-3 px-4 py-3"
        style={{
          background: "linear-gradient(to bottom, rgba(10,10,10,0.95), transparent)",
          paddingTop: "calc(env(safe-area-inset-top) + 12px)",
        }}
      >
        {/* Type filters */}
        <div className="flex gap-2">
          {PAGE_TYPES.map((type) => {
            const active = activeTypes.has(type);
            const count = pages.filter((p) => p.page_type === type).length;
            return (
              <button
                key={type}
                onClick={() => toggleType(type)}
                className="font-terminal text-xs px-3 py-1.5 rounded transition-all"
                style={{
                  background: active ? "var(--accent-dim)" : "transparent",
                  border: `1px solid ${active ? "var(--border-active)" : "var(--border)"}`,
                  color: active ? "var(--text-primary)" : "var(--text-muted)",
                  opacity: active ? 1 : 0.6,
                }}
              >
                {TYPE_LABELS[type] || type.toUpperCase()} ({count})
              </button>
            );
          })}
        </div>

        {/* Search */}
        <div className="flex-1 max-w-xs">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="find node..."
            className="w-full font-terminal text-sm px-3 py-1.5 rounded outline-none"
            style={{
              background: "var(--bg-input)",
              border: "1px solid var(--border)",
              color: "var(--text-primary)",
            }}
          />
        </div>

        {/* Stats */}
        <span
          className="text-xs hidden md:inline"
          style={{ color: "var(--text-muted)", fontFamily: "'IBM Plex Mono', monospace" }}
        >
          {graphData.nodes.length} nodes / {graphData.links.length} links
        </span>
      </div>

      {/* Graph canvas */}
      <KnowledgeGraph
        data={graphData}
        activeTypes={activeTypes}
        highlightSlug={highlightSlug}
        onNodeClick={handleNodeClick}
      />

      {/* Side panel (desktop) / Bottom sheet (mobile) */}
      {panelOpen && (
        <>
          {/* Backdrop on mobile */}
          <div
            className="md:hidden fixed inset-0 z-30"
            style={{ background: "rgba(0,0,0,0.6)" }}
            onClick={closePanel}
          />

          <div
            className={`fixed z-40 overflow-y-auto transition-transform duration-300 ${
              panelOpen ? "translate-x-0 translate-y-0" : ""
            }`}
            style={{
              background: "var(--bg-surface)",
              borderLeft: "1px solid var(--border)",
              /* Desktop: right panel */
              top: 0,
              right: 0,
              bottom: 0,
              width: "min(420px, 100vw)",
            }}
          >
            {/* Panel header */}
            <div
              className="sticky top-0 z-10 flex items-center justify-between px-4 py-3"
              style={{
                background: "var(--bg-surface)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <div>
                {selectedNode && (
                  <>
                    <span
                      className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded mr-2"
                      style={{
                        background: "var(--accent-dim)",
                        color: "var(--text-secondary)",
                      }}
                    >
                      {selectedNode.pageType}
                    </span>
                    <span
                      className="font-terminal text-lg"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {selectedNode.title}
                    </span>
                  </>
                )}
              </div>
              <button
                onClick={closePanel}
                className="font-terminal text-lg px-2 py-1 rounded transition-colors"
                style={{ color: "var(--text-muted)" }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--danger)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
              >
                [X]
              </button>
            </div>

            {/* Panel body */}
            <div className="p-4">
              {loading && (
                <div className="font-terminal text-sm animate-pulse" style={{ color: "var(--text-muted)" }}>
                  Loading page content...
                </div>
              )}
              {pageDetail && (
                <div className="space-y-4">
                  {/* Last compiled */}
                  {pageDetail.last_compiled && (
                    <div
                      className="text-[10px]"
                      style={{ color: "var(--text-muted)", fontFamily: "'IBM Plex Mono', monospace" }}
                    >
                      compiled {new Date(pageDetail.last_compiled).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </div>
                  )}

                  {/* Content */}
                  <PageContent content={pageDetail.content} />

                  {/* Backlinks */}
                  {pageDetail.backlinks && pageDetail.backlinks.length > 0 && (
                    <div className="pt-4" style={{ borderTop: "1px solid var(--border)" }}>
                      <div
                        className="font-terminal text-xs uppercase tracking-wider mb-2"
                        style={{ color: "var(--text-muted)" }}
                      >
                        &gt; BACKLINKS
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {pageDetail.backlinks.map((slug) => (
                          <a
                            key={slug}
                            href={`/wiki/${encodeURIComponent(slug)}`}
                            className="text-xs px-2 py-1 rounded transition-all"
                            style={{
                              background: "var(--accent-dim)",
                              border: "1px solid var(--border)",
                              color: "var(--text-secondary)",
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.borderColor = "var(--border-active)";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.borderColor = "var(--border)";
                            }}
                          >
                            {slug.replace(/^(client|topic|project)\//, "")}
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Verify build**

```bash
cd /tmp/open-brain-dashboard && npm run build 2>&1 | tail -5
```

Expected: build succeeds. The /graph route is dynamic (force-dynamic). The API route responds to GET requests.

- [ ] **Step 5: Commit**

```bash
cd /tmp/open-brain-dashboard && git add src/app/api/wiki/ src/app/graph/ && git commit -m "feat: knowledge graph page with filters and content side panel"
```

---

### Task 5: Build PageContent.tsx (markdown renderer)

**Files:**
- Create: `src/components/PageContent.tsx`

Renders markdown content from compiled pages using react-markdown with remark-gfm. Styled to match the Neural Terminal theme.

- [ ] **Step 1: Create the component**

```tsx
// src/components/PageContent.tsx
"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface PageContentProps {
  content: string;
}

export default function PageContent({ content }: PageContentProps) {
  return (
    <div className="wiki-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1
              className="font-terminal text-2xl mb-3 mt-6 first:mt-0"
              style={{ color: "var(--text-primary)" }}
            >
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2
              className="font-terminal text-xl mb-2 mt-5"
              style={{ color: "var(--text-primary)" }}
            >
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3
              className="font-terminal text-lg mb-2 mt-4"
              style={{ color: "var(--text-secondary)" }}
            >
              {children}
            </h3>
          ),
          p: ({ children }) => (
            <p className="mb-3 leading-relaxed text-sm" style={{ color: "var(--text-body)" }}>
              {children}
            </p>
          ),
          ul: ({ children }) => (
            <ul className="mb-3 ml-4 space-y-1 text-sm list-none" style={{ color: "var(--text-body)" }}>
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-3 ml-4 space-y-1 text-sm list-decimal" style={{ color: "var(--text-body)" }}>
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="leading-relaxed">
              <span style={{ color: "var(--text-muted)", marginRight: 6 }}>-</span>
              {children}
            </li>
          ),
          strong: ({ children }) => (
            <strong style={{ color: "var(--text-secondary)", fontWeight: 600 }}>
              {children}
            </strong>
          ),
          em: ({ children }) => (
            <em style={{ color: "var(--text-secondary)", fontStyle: "italic" }}>
              {children}
            </em>
          ),
          code: ({ children, className }) => {
            const isBlock = className?.startsWith("language-");
            if (isBlock) {
              return (
                <code
                  className="block p-3 rounded text-xs overflow-x-auto mb-3"
                  style={{
                    background: "var(--bg-input)",
                    border: "1px solid var(--border)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {children}
                </code>
              );
            }
            return (
              <code
                className="px-1.5 py-0.5 rounded text-xs"
                style={{
                  background: "var(--accent-dim)",
                  color: "var(--text-primary)",
                }}
              >
                {children}
              </code>
            );
          },
          a: ({ href, children }) => (
            <a
              href={href}
              style={{ color: "var(--text-primary)" }}
              className="underline underline-offset-2 decoration-1"
              style={{ color: "var(--text-primary)", textDecorationColor: "var(--text-muted)" }}
            >
              {children}
            </a>
          ),
          hr: () => (
            <hr className="my-4" style={{ borderColor: "var(--border)" }} />
          ),
          blockquote: ({ children }) => (
            <blockquote
              className="pl-3 my-3 text-sm"
              style={{
                borderLeft: "2px solid var(--text-muted)",
                color: "var(--text-muted)",
              }}
            >
              {children}
            </blockquote>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
```

**Note:** The `a` component has a duplicate `style` prop. The implementing agent should merge them into a single style: `style={{ color: "var(--text-primary)", textDecorationColor: "var(--text-muted)" }}` and remove the `className` underline classes since the style handles it.

- [ ] **Step 2: Verify build**

```bash
cd /tmp/open-brain-dashboard && npm run build 2>&1 | tail -5
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
cd /tmp/open-brain-dashboard && git add src/components/PageContent.tsx && git commit -m "feat: PageContent markdown renderer with Neural Terminal styling"
```

---

### Task 6: Build /wiki list page

**Files:**
- Create: `src/app/wiki/page.tsx`

Server component that fetches all compiled pages (without full content) and renders a filterable list grouped by type. Each entry links to the detail page.

- [ ] **Step 1: Create the wiki list page**

```tsx
// src/app/wiki/page.tsx
import { supabase } from "@/lib/supabase";
import WikiList from "./WikiList";

export const dynamic = "force-dynamic";

interface WikiPageRow {
  id: string;
  slug: string;
  title: string;
  page_type: string;
  backlinks: string[] | null;
  last_compiled: string | null;
}

export default async function WikiPage() {
  const { data } = await supabase()
    .from("compiled_pages")
    .select("id, slug, title, page_type, backlinks, last_compiled")
    .order("title");

  const pages = (data || []) as WikiPageRow[];

  return (
    <div className="space-y-6">
      <div className="animate-in">
        <h1 className="font-terminal text-3xl text-glow" style={{ color: "var(--text-primary)" }}>
          <span style={{ color: "var(--text-muted)" }}>&gt; </span>
          WIKI
        </h1>
        <p
          className="text-sm mt-1"
          style={{ color: "var(--text-muted)", fontFamily: "'IBM Plex Mono', monospace" }}
        >
          {pages.length} compiled pages
        </p>
      </div>
      <WikiList pages={pages} />
    </div>
  );
}
```

- [ ] **Step 2: Create the WikiList client component**

```tsx
// src/app/wiki/WikiList.tsx
"use client";

import { useState, useMemo } from "react";
import Link from "next/link";

interface WikiPageRow {
  id: string;
  slug: string;
  title: string;
  page_type: string;
  backlinks: string[] | null;
  last_compiled: string | null;
}

const PAGE_TYPES = ["client", "topic", "project"];

export default function WikiList({ pages }: { pages: WikiPageRow[] }) {
  const [activeType, setActiveType] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    let result = pages;
    if (activeType) {
      result = result.filter((p) => p.page_type === activeType);
    }
    if (search.trim()) {
      const lower = search.toLowerCase();
      result = result.filter((p) => p.title.toLowerCase().includes(lower));
    }
    return result;
  }, [pages, activeType, search]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of pages) {
      c[p.page_type] = (c[p.page_type] || 0) + 1;
    }
    return c;
  }, [pages]);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 animate-in stagger-1">
        <button
          onClick={() => setActiveType(null)}
          className="font-terminal text-xs px-3 py-1.5 rounded transition-all"
          style={{
            background: activeType === null ? "var(--accent-dim)" : "transparent",
            border: `1px solid ${activeType === null ? "var(--border-active)" : "var(--border)"}`,
            color: activeType === null ? "var(--text-primary)" : "var(--text-muted)",
          }}
        >
          ALL ({pages.length})
        </button>
        {PAGE_TYPES.map((type) => (
          <button
            key={type}
            onClick={() => setActiveType(activeType === type ? null : type)}
            className="font-terminal text-xs px-3 py-1.5 rounded transition-all"
            style={{
              background: activeType === type ? "var(--accent-dim)" : "transparent",
              border: `1px solid ${activeType === type ? "var(--border-active)" : "var(--border)"}`,
              color: activeType === type ? "var(--text-primary)" : "var(--text-muted)",
            }}
          >
            {type.toUpperCase()} ({counts[type] || 0})
          </button>
        ))}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search pages..."
          className="font-terminal text-sm px-3 py-1.5 rounded outline-none flex-1 min-w-[200px]"
          style={{
            background: "var(--bg-input)",
            border: "1px solid var(--border)",
            color: "var(--text-primary)",
          }}
        />
      </div>

      {/* Results */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 animate-in stagger-2">
        {filtered.map((page) => (
          <Link
            key={page.id}
            href={`/wiki/${encodeURIComponent(page.slug)}`}
            className="card scanline-hover block group"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <span
                  className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                  style={{
                    background: "var(--accent-dim)",
                    color: "var(--text-muted)",
                  }}
                >
                  {page.page_type}
                </span>
                <h3
                  className="font-terminal text-base mt-1.5 truncate group-hover:text-glow transition-all"
                  style={{ color: "var(--text-primary)" }}
                >
                  {page.title}
                </h3>
              </div>
              {page.backlinks && page.backlinks.length > 0 && (
                <span
                  className="text-[10px] tabular-nums shrink-0 mt-1"
                  style={{ color: "var(--text-muted)", fontFamily: "'IBM Plex Mono', monospace" }}
                >
                  {page.backlinks.length} links
                </span>
              )}
            </div>
            {page.last_compiled && (
              <div
                className="text-[10px] mt-2"
                style={{ color: "var(--text-muted)", fontFamily: "'IBM Plex Mono', monospace" }}
              >
                compiled {new Date(page.last_compiled).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </div>
            )}
          </Link>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12">
          <p className="font-terminal text-sm" style={{ color: "var(--text-muted)" }}>
            No pages match your filters.
          </p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
cd /tmp/open-brain-dashboard && npm run build 2>&1 | tail -5
```

Expected: build succeeds. The /wiki route shows in the output.

- [ ] **Step 4: Commit**

```bash
cd /tmp/open-brain-dashboard && git add src/app/wiki/page.tsx src/app/wiki/WikiList.tsx && git commit -m "feat: wiki list page with type filters and search"
```

---

### Task 7: Build /wiki/[slug] detail page

**Files:**
- Create: `src/app/wiki/[slug]/page.tsx`

Server component that fetches a single compiled page by slug, renders the full markdown content with PageContent, and shows backlink chips that link to other wiki pages.

- [ ] **Step 1: Create the wiki detail page**

```tsx
// src/app/wiki/[slug]/page.tsx
import { supabase } from "@/lib/supabase";
import { notFound } from "next/navigation";
import PageContent from "@/components/PageContent";
import Link from "next/link";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ slug: string }>;
}

export default async function WikiDetailPage({ params }: Props) {
  const { slug } = await params;
  const decoded = decodeURIComponent(slug);

  const { data: page } = await supabase()
    .from("compiled_pages")
    .select("id, slug, title, page_type, content, backlinks, last_compiled")
    .eq("slug", decoded)
    .single();

  if (!page) notFound();

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Breadcrumb */}
      <div className="animate-in" style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
        <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
          <Link href="/wiki" style={{ color: "var(--text-muted)" }} className="hover:underline">
            WIKI
          </Link>
          <span>/</span>
          <span style={{ color: "var(--text-secondary)" }}>{page.page_type.toUpperCase()}</span>
          <span>/</span>
          <span style={{ color: "var(--text-primary)" }}>{page.title}</span>
        </div>
      </div>

      {/* Title */}
      <div className="animate-in stagger-1">
        <div className="flex items-center gap-3 mb-2">
          <span
            className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded"
            style={{ background: "var(--accent-dim)", color: "var(--text-secondary)" }}
          >
            {page.page_type}
          </span>
          {page.last_compiled && (
            <span
              className="text-[10px]"
              style={{ color: "var(--text-muted)", fontFamily: "'IBM Plex Mono', monospace" }}
            >
              compiled {new Date(page.last_compiled).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          )}
        </div>
        <h1
          className="font-terminal text-3xl text-glow"
          style={{ color: "var(--text-primary)" }}
        >
          {page.title}
        </h1>
      </div>

      {/* Content */}
      <div className="card animate-in stagger-2">
        <PageContent content={page.content || ""} />
      </div>

      {/* Backlinks */}
      {page.backlinks && page.backlinks.length > 0 && (
        <div className="animate-in stagger-3">
          <h2
            className="font-terminal text-sm uppercase tracking-wider mb-3"
            style={{ color: "var(--text-muted)" }}
          >
            <span>&gt; </span>BACKLINKS ({page.backlinks.length})
          </h2>
          <div className="flex flex-wrap gap-2">
            {page.backlinks.map((bl: string) => (
              <Link
                key={bl}
                href={`/wiki/${encodeURIComponent(bl)}`}
                className="text-xs px-3 py-1.5 rounded transition-all"
                style={{
                  background: "var(--accent-dim)",
                  border: "1px solid var(--border)",
                  color: "var(--text-secondary)",
                }}
                onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => {
                  (e.currentTarget as HTMLAnchorElement).style.borderColor = "var(--border-active)";
                }}
                onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => {
                  (e.currentTarget as HTMLAnchorElement).style.borderColor = "var(--border)";
                }}
              >
                {bl.replace(/^(client|topic|project)\//, "")}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Link to graph view */}
      <div className="animate-in stagger-4">
        <Link
          href="/graph"
          className="font-terminal text-xs inline-block py-2 transition-colors"
          style={{ color: "var(--text-muted)" }}
        >
          &gt; view in graph_
        </Link>
      </div>
    </div>
  );
}
```

**Implementation note:** The backlink chips use inline `onMouseEnter`/`onMouseLeave` handlers. Since this is a server component, the implementing agent must either: (a) make the backlinks section a separate small client component, or (b) remove the hover handlers and use CSS-only hover via the existing `.scanline-hover` or a new utility class. Option (b) is simpler. Add this to globals.css:

```css
.backlink-chip {
  transition: border-color 0.2s;
}
.backlink-chip:hover {
  border-color: var(--border-active) !important;
}
```

Then replace the onMouseEnter/onMouseLeave with `className="backlink-chip ..."` and remove the event handlers.

- [ ] **Step 2: Verify build**

```bash
cd /tmp/open-brain-dashboard && npm run build 2>&1 | tail -5
```

Expected: build succeeds. The /wiki/[slug] route shows as dynamic.

- [ ] **Step 3: Commit**

```bash
cd /tmp/open-brain-dashboard && git add src/app/wiki/\[slug\]/page.tsx src/app/globals.css && git commit -m "feat: wiki detail page with markdown rendering and backlink chips"
```

---

### Task 8: Build MiniGraph.tsx and add to dashboard

**Files:**
- Create: `src/components/MiniGraph.tsx`
- Modify: `src/app/page.tsx` (dashboard)

MiniGraph is a small, non-interactive graph preview for the dashboard. Shows the top 25 most-connected nodes. Clicking it navigates to /graph.

- [ ] **Step 1: Create MiniGraph component**

```tsx
// src/components/MiniGraph.tsx
"use client";

import { useMemo, useRef, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { CompiledPageRow, buildMiniGraphData, getNodeColor, GraphNode } from "@/lib/graph-data";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
});

interface MiniGraphProps {
  pages: CompiledPageRow[];
}

export default function MiniGraph({ pages }: MiniGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ w: 400, h: 250 });

  useEffect(() => {
    function measure() {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setDimensions({ w: rect.width, h: 250 });
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const graphData = useMemo(() => buildMiniGraphData(pages, 25), [pages]);

  const paintNode = (node: any, ctx: CanvasRenderingContext2D) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const n = node as GraphNode & { x: number; y: number };
    const size = Math.max(2, Math.sqrt(n.val) * 2);
    ctx.beginPath();
    ctx.arc(n.x, n.y, size, 0, 2 * Math.PI);
    ctx.fillStyle = getNodeColor(n.pageType);
    ctx.fill();
  };

  return (
    <div ref={containerRef} style={{ width: "100%", height: 250, cursor: "pointer" }}>
      <a href="/graph" style={{ display: "block", width: "100%", height: "100%" }}>
        <ForceGraph2D
          graphData={graphData}
          width={dimensions.w}
          height={250}
          nodeCanvasObject={paintNode}
          nodePointerAreaPaint={() => {}}
          linkColor={() => "rgba(0, 255, 65, 0.1)"}
          linkWidth={0.3}
          backgroundColor="transparent"
          cooldownTicks={60}
          enableZoomInteraction={false}
          enablePanInteraction={false}
          enableNodeDrag={false}
          d3AlphaDecay={0.05}
          d3VelocityDecay={0.4}
        />
      </a>
    </div>
  );
}
```

- [ ] **Step 2: Add MiniGraph to dashboard page.tsx**

In `src/app/page.tsx`, add a new query for compiled_pages and a Section containing MiniGraph. Insert this after the Activity chart section and before the "Two-column: Source + Type" section.

Add this import at the top of page.tsx:

```tsx
import MiniGraph from "@/components/MiniGraph";
import { CompiledPageRow } from "@/lib/graph-data";
```

Add this query after the existing `wikiCount` query:

```tsx
const { data: wikiPages } = await supabase()
  .from("compiled_pages")
  .select("id, slug, title, page_type, backlinks, last_compiled")
  .order("title");
```

Add this JSX block between the Activity `</Section>` and the Source/Type grid:

```tsx
{/* Knowledge graph preview */}
<Section title="Knowledge Graph" subtitle={`${(wikiPages || []).length} pages`} stagger={1}>
  <MiniGraph pages={(wikiPages || []) as CompiledPageRow[]} />
  <a
    href="/graph"
    className="block text-xs mt-2 py-1 transition-colors"
    style={{ color: "var(--text-muted)", fontFamily: "'IBM Plex Mono', monospace" }}
  >
    <span style={{ color: "var(--text-muted)" }}>&gt; </span>
    explore full graph
    <span style={{ color: "var(--text-primary)" }}>_</span>
  </a>
</Section>
```

- [ ] **Step 3: Verify build**

```bash
cd /tmp/open-brain-dashboard && npm run build 2>&1 | tail -5
```

Expected: build succeeds. Dashboard page renders with the graph preview section.

- [ ] **Step 4: Commit**

```bash
cd /tmp/open-brain-dashboard && git add src/components/MiniGraph.tsx src/app/page.tsx && git commit -m "feat: MiniGraph dashboard preview with top 25 connected nodes"
```

---

### Task 9: Final build verification and visual check

- [ ] **Step 1: Full build**

```bash
cd /tmp/open-brain-dashboard && npm run build 2>&1
```

Expected: zero errors. All new routes show in the output:
- `/graph` (dynamic)
- `/wiki` (dynamic)
- `/wiki/[slug]` (dynamic)
- `/api/wiki/[slug]` (dynamic)

- [ ] **Step 2: Start dev server and visual check**

```bash
cd /tmp/open-brain-dashboard && nohup npx next dev -p 3001 > /tmp/ob-dash-dev.log 2>&1 & echo "PID: $!"
```

Wait a few seconds, then verify the pages load:

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/graph
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/wiki
```

Expected: 200 for both (or 307 redirect to login if auth middleware fires, which is correct behavior).

Kill the dev server when done:

```bash
kill $(pgrep -f "next dev -p 3001")
```

- [ ] **Step 3: Commit any final fixes from build/visual check, if needed**

Only if build or visual check revealed issues that needed fixing.
