"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { CompiledPageRow } from "@/lib/graph-data";

const PAGE_TYPES = ["client", "topic", "project"];

export default function WikiList({ pages }: { pages: CompiledPageRow[] }) {
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

      {/* Results grid */}
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
