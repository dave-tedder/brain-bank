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
  const [fetchError, setFetchError] = useState(false);
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
        if (next.size > 1) next.delete(type);
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
    setFetchError(false);
    try {
      const res = await fetch(`/api/wiki/${encodeURIComponent(node.slug)}`);
      if (res.ok) {
        const data = await res.json();
        setPageDetail(data);
      } else {
        setFetchError(true);
      }
    } catch {
      setFetchError(true);
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

      {/* Side panel */}
      {panelOpen && (
        <>
          {/* Backdrop on mobile */}
          <div
            className="md:hidden fixed inset-0 z-30"
            style={{ background: "rgba(0,0,0,0.6)" }}
            onClick={closePanel}
          />

          <div
            className="fixed z-40 overflow-y-auto transition-transform duration-300"
            style={{
              background: "var(--bg-surface)",
              borderLeft: "1px solid var(--border)",
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
              {fetchError && !loading && (
                <div className="font-terminal text-sm" style={{ color: "var(--danger)" }}>
                  Failed to load page content.
                </div>
              )}
              {pageDetail && (
                <div className="space-y-4">
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

                  <PageContent content={pageDetail.content} />

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
                            className="text-xs px-2 py-1 rounded transition-all hover:border-[var(--border-active)]"
                            style={{
                              background: "var(--accent-dim)",
                              border: "1px solid var(--border)",
                              color: "var(--text-secondary)",
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
