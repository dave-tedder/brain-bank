import { supabase } from "@/lib/supabase";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ThoughtDetailPage({ params }: Props) {
  const { id } = await params;

  const { data: thought, error } = await supabase()
    .from("thoughts")
    .select("id, content, metadata, created_at, updated_at, content_hash")
    .eq("id", id)
    .maybeSingle();

  if (error || !thought) return notFound();

  const m = (thought.metadata || {}) as Record<string, unknown>;
  const topics = Array.isArray(m.topics) ? (m.topics as string[]) : [];
  const people = Array.isArray(m.people) ? (m.people as string[]) : [];
  const actionItems = Array.isArray(m.action_items)
    ? (m.action_items as string[])
    : [];
  const dates = Array.isArray(m.dates_mentioned)
    ? (m.dates_mentioned as string[])
    : [];
  const type = (m.type as string) || "unknown";
  const source = m.source as string | undefined;
  const project = m.project as string | undefined;
  const priority = m.priority as string | undefined;

  // Related action items from the action_items table (if this thought spawned any)
  const { data: spawnedActions } = await supabase()
    .from("action_items")
    .select("id, description, status, created_at, resolved_at, resolved_by_thought_id")
    .eq("source_thought_id", thought.id)
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="animate-in">
        <Link
          href="/thoughts"
          className="text-xs font-mono text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
        >
          <span className="text-[var(--text-muted)]">&lt; </span>
          back to thought log
        </Link>
      </div>

      {/* Header */}
      <div className="animate-in stagger-1">
        <h1 className="font-terminal text-3xl text-[var(--text-primary)] text-glow">
          <span className="text-[var(--text-muted)]">&gt; </span>
          THOUGHT
        </h1>
        <p className="text-xs font-mono text-[var(--text-muted)] mt-1 uppercase tracking-wider">
          {new Date(thought.created_at).toLocaleString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </p>
      </div>

      {/* Metadata badges */}
      <div className="animate-in stagger-2 card">
        <div className="flex flex-wrap gap-2 items-center">
          <Link
            href={`/thoughts?type=${encodeURIComponent(type)}`}
            className="px-2 py-0.5 rounded text-xs font-terminal uppercase tracking-wider bg-[var(--accent-dim)] text-[var(--text-primary)] hover:bg-[var(--accent-glow)] transition-colors"
          >
            {type}
          </Link>
          {source && (
            <Link
              href={`/thoughts?source=${encodeURIComponent(source)}`}
              className="px-2 py-0.5 rounded text-xs font-mono bg-[var(--accent-dim)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              via {source}
            </Link>
          )}
          {priority && priority !== "normal" && (
            <span
              className={`text-xs font-terminal uppercase tracking-wider px-2 py-0.5 rounded ${
                priority === "high"
                  ? "bg-[rgba(239,68,68,0.12)] text-[var(--danger)]"
                  : "bg-[var(--accent-dim)] text-[var(--text-muted)]"
              }`}
            >
              {priority}
            </span>
          )}
          {project && (
            <span className="px-2 py-0.5 rounded text-xs font-mono bg-[var(--accent-dim)] text-[var(--text-secondary)]">
              project: {project}
            </span>
          )}
          {topics.map((tp) => (
            <Link
              key={tp}
              href={`/thoughts?topic=${encodeURIComponent(tp)}`}
              className="px-2 py-0.5 rounded text-xs font-mono bg-[var(--accent-dim)] text-[var(--text-primary)] hover:bg-[var(--accent-glow)] transition-colors"
            >
              #{tp}
            </Link>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="animate-in stagger-3 card scanline-hover border-l-2" style={{ borderLeftColor: "rgba(0, 255, 65, 0.4)" }}>
        <div className="text-[10px] font-terminal uppercase tracking-[0.2em] text-[var(--text-muted)] mb-3">
          <span className="text-[var(--text-muted)]">&gt; </span>
          content
        </div>
        <p className="text-sm leading-relaxed whitespace-pre-wrap font-mono text-[var(--text-body)]">
          {thought.content}
        </p>
      </div>

      {/* People */}
      {people.length > 0 && (
        <div className="animate-in stagger-4 card">
          <div className="text-[10px] font-terminal uppercase tracking-[0.2em] text-[var(--text-muted)] mb-3">
            <span className="text-[var(--text-muted)]">&gt; </span>
            people mentioned
          </div>
          <div className="flex flex-wrap gap-2">
            {people.map((p) => (
              <Link
                key={p}
                href={`/thoughts?person=${encodeURIComponent(p)}`}
                className="px-2 py-0.5 rounded text-xs font-mono bg-[var(--accent-dim)] text-[var(--text-secondary)] border border-[var(--border)] hover:border-[var(--accent)] hover:text-[var(--text-primary)] transition-colors"
              >
                {p}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Action items (inline) */}
      {actionItems.length > 0 && (
        <div className="animate-in stagger-5 card">
          <div className="text-[10px] font-terminal uppercase tracking-[0.2em] text-[var(--text-muted)] mb-3">
            <span className="text-[var(--text-muted)]">&gt; </span>
            action items
          </div>
          <ul className="space-y-1.5">
            {actionItems.map((item, i) => (
              <li
                key={i}
                className="text-xs font-mono text-[var(--text-body)] flex items-start gap-2"
              >
                <span className="text-[var(--text-primary)]">&gt;</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Tracked actions (from action_items table) */}
      {spawnedActions && spawnedActions.length > 0 && (
        <div className="animate-in stagger-6 card">
          <div className="text-[10px] font-terminal uppercase tracking-[0.2em] text-[var(--text-muted)] mb-3">
            <span className="text-[var(--text-muted)]">&gt; </span>
            tracked actions
          </div>
          <ul className="space-y-2">
            {spawnedActions.map((a) => (
              <li
                key={a.id}
                className="flex items-start gap-2 text-xs font-mono"
              >
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-terminal uppercase tracking-wider ${
                    a.status === "resolved"
                      ? "bg-[rgba(0,255,65,0.1)] text-[var(--text-secondary)]"
                      : "bg-[rgba(251,191,36,0.12)] text-[var(--warning)]"
                  }`}
                >
                  {a.status}
                </span>
                <span className="text-[var(--text-body)] flex-1">
                  {a.description}
                </span>
                {a.resolved_by_thought_id && (
                  <Link
                    href={`/thoughts/${a.resolved_by_thought_id}`}
                    className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    resolved &rarr;
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Dates mentioned */}
      {dates.length > 0 && (
        <div className="animate-in stagger-7 card">
          <div className="text-[10px] font-terminal uppercase tracking-[0.2em] text-[var(--text-muted)] mb-3">
            <span className="text-[var(--text-muted)]">&gt; </span>
            dates mentioned
          </div>
          <div className="flex flex-wrap gap-2">
            {dates.map((d) => (
              <span
                key={d}
                className="px-2 py-0.5 rounded text-xs font-mono bg-[var(--accent-dim)] text-[var(--text-muted)]"
              >
                {d}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Footer identity */}
      <div className="animate-in stagger-8 text-[10px] font-mono text-[var(--text-muted)] opacity-60">
        id: {thought.id} · hash: {thought.content_hash?.slice(0, 12)}
      </div>
    </div>
  );
}
