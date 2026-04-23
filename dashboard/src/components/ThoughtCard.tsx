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
            &#x25BE;
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
