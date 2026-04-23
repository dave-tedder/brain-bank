import { supabase } from "@/lib/supabase";
import Link from "next/link";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ status?: string }>;
}

interface ActionRow {
  id: string;
  description: string;
  status: string;
  source_thought_id: string | null;
  resolved_by_thought_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface SourceThought {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export default async function ActionsPage({ searchParams }: Props) {
  const params = await searchParams;
  const filter = params.status === "resolved" ? "resolved" : "open";

  const { data: actions, count } = await supabase()
    .from("action_items")
    .select("*", { count: "exact" })
    .eq("status", filter)
    .order("created_at", { ascending: false })
    .limit(200);

  const rows = (actions || []) as ActionRow[];

  // Pull source thoughts for backlink context
  const sourceIds = Array.from(
    new Set(rows.map((r) => r.source_thought_id).filter((x): x is string => !!x))
  );
  let sourceMap = new Map<string, SourceThought>();
  if (sourceIds.length > 0) {
    const { data: sources } = await supabase()
      .from("thoughts")
      .select("id, content, metadata, created_at")
      .in("id", sourceIds);
    sourceMap = new Map(((sources || []) as SourceThought[]).map((s) => [s.id, s]));
  }

  // Aggregate counts for tab labels
  const { count: openCount } = await supabase()
    .from("action_items")
    .select("*", { count: "exact", head: true })
    .eq("status", "open");
  const { count: resolvedCount } = await supabase()
    .from("action_items")
    .select("*", { count: "exact", head: true })
    .eq("status", "resolved");

  // Group by source thought for synthesis
  const grouped = new Map<string, ActionRow[]>();
  for (const r of rows) {
    const key = r.source_thought_id || "_unknown";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(r);
  }
  const groupedEntries = Array.from(grouped.entries()).sort((a, b) => {
    const at = sourceMap.get(a[0])?.created_at || "";
    const bt = sourceMap.get(b[0])?.created_at || "";
    return bt.localeCompare(at);
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-in">
        <h1 className="font-terminal text-3xl text-[var(--text-primary)] text-glow">
          <span className="text-[var(--text-muted)]">&gt; </span>
          OPEN ACTIONS
        </h1>
        <p className="text-xs font-mono text-[var(--text-muted)] mt-1 uppercase tracking-wider">
          {count} {filter} item{count !== 1 ? "s" : ""}
        </p>
      </div>

      {/* Tabs */}
      <div className="animate-in stagger-1 card">
        <div className="flex gap-2 items-center">
          <Link
            href="/actions"
            className={`px-3 py-1 rounded text-xs font-terminal uppercase tracking-wider transition-all duration-200 ${
              filter === "open"
                ? "bg-[var(--accent-dim)] text-[var(--text-primary)] border border-[var(--accent)] border-glow"
                : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] border border-transparent hover:border-[var(--border)]"
            }`}
          >
            OPEN [{openCount ?? 0}]
          </Link>
          <Link
            href="/actions?status=resolved"
            className={`px-3 py-1 rounded text-xs font-terminal uppercase tracking-wider transition-all duration-200 ${
              filter === "resolved"
                ? "bg-[var(--accent-dim)] text-[var(--text-primary)] border border-[var(--accent)] border-glow"
                : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] border border-transparent hover:border-[var(--border)]"
            }`}
          >
            RESOLVED [{resolvedCount ?? 0}]
          </Link>
        </div>
      </div>

      {/* Grouped action items */}
      {groupedEntries.length === 0 && (
        <div className="card text-center py-12">
          <p className="text-sm font-mono text-[var(--text-muted)]">
            No {filter} actions.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {groupedEntries.map(([sourceId, items], i) => {
          const source = sourceId !== "_unknown" ? sourceMap.get(sourceId) : null;
          const sm = (source?.metadata || {}) as Record<string, unknown>;
          const people = Array.isArray(sm.people) ? (sm.people as string[]) : [];
          const project = sm.project as string | undefined;

          return (
            <div
              key={sourceId}
              className={`card scanline-hover border-l-2 animate-in stagger-${Math.min(i + 2, 8)}`}
              style={{ borderLeftColor: filter === "open" ? "rgba(251,191,36,0.5)" : "rgba(0,255,65,0.4)" }}
            >
              {/* Action items */}
              <ul className="space-y-2">
                {items.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-start gap-3 text-sm font-mono text-[var(--text-body)]"
                  >
                    <span
                      className={`mt-0.5 text-xs ${
                        filter === "open"
                          ? "text-[var(--warning)]"
                          : "text-[var(--text-secondary)] line-through opacity-70"
                      }`}
                    >
                      {filter === "open" ? "[ ]" : "[x]"}
                    </span>
                    <span
                      className={
                        filter === "resolved"
                          ? "line-through opacity-60 flex-1"
                          : "flex-1"
                      }
                    >
                      {a.description}
                    </span>
                    {a.resolved_by_thought_id && (
                      <Link
                        href={`/thoughts/${a.resolved_by_thought_id}`}
                        className="text-[10px] font-terminal uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors shrink-0"
                      >
                        resolved by &rarr;
                      </Link>
                    )}
                  </li>
                ))}
              </ul>

              {/* Source thought backlink */}
              {source && (
                <div className="mt-3 pt-3 border-t border-[var(--border)]">
                  <Link
                    href={`/thoughts/${source.id}`}
                    className="block group"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-terminal uppercase tracking-wider text-[var(--text-muted)]">
                        from
                      </span>
                      <span className="text-[10px] font-mono text-[var(--text-muted)] tabular-nums">
                        {new Date(source.created_at).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </span>
                      {project && (
                        <span className="text-[10px] font-mono text-[var(--text-muted)]">
                          · {project}
                        </span>
                      )}
                      {people.length > 0 && (
                        <span className="text-[10px] font-mono text-[var(--text-muted)]">
                          · {people.slice(0, 3).join(", ")}
                        </span>
                      )}
                    </div>
                    <p className="text-xs font-mono text-[var(--text-muted)] group-hover:text-[var(--text-secondary)] transition-colors line-clamp-2">
                      {source.content.slice(0, 220)}
                      {source.content.length > 220 && "..."}
                    </p>
                  </Link>
                </div>
              )}

              {!source && sourceId !== "_unknown" && (
                <div className="mt-3 pt-3 border-t border-[var(--border)] text-[10px] font-mono text-[var(--text-muted)] opacity-60">
                  source thought unavailable
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
