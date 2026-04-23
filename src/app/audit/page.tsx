import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const { data: recent } = await supabase()
    .from("thoughts")
    .select("id, content, metadata, created_at, content_hash")
    .order("created_at", { ascending: false })
    .limit(50);

  const { data: all } = await supabase()
    .from("thoughts")
    .select("id, content, content_hash, metadata, created_at")
    .order("created_at", { ascending: false });

  const nearDupes: {
    a: NonNullable<typeof all>[number];
    b: NonNullable<typeof all>[number];
    similarity: string;
  }[] = [];

  if (all && all.length > 0) {
    const normalize = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80);
    const groups = new Map<string, typeof all>();
    for (const t of all) {
      const key = normalize(t.content);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(t);
    }
    for (const [, group] of groups) {
      if (group.length > 1) {
        for (let i = 1; i < group.length; i++) {
          nearDupes.push({
            a: group[0],
            b: group[i],
            similarity: "near-exact",
          });
        }
      }
    }
  }

  const bySource: Record<string, NonNullable<typeof recent>> = {};
  for (const t of recent || []) {
    const src =
      ((t.metadata as Record<string, unknown>)?.source as string) || "unknown";
    if (!bySource[src]) bySource[src] = [];
    bySource[src].push(t);
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="animate-in">
        <h1 className="text-3xl font-terminal text-[var(--text-primary)] text-glow tracking-wide">
          AUDIT
        </h1>
        <p className="text-sm font-mono text-[var(--text-muted)] mt-1">
          Data quality monitoring across {all?.length || 0} thoughts.
        </p>
      </div>

      {/* Duplicate detection */}
      <section className="animate-in stagger-1 card">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-sm font-terminal text-[var(--text-primary)] uppercase tracking-widest flex items-center gap-2">
            <span className="w-1 h-4 rounded-full bg-[var(--accent)]" />
            POTENTIAL DUPLICATES
          </h2>
          <span
            className={`text-xs font-terminal px-2.5 py-1 rounded-[var(--radius-sm)] border ${
              nearDupes.length === 0
                ? "bg-[rgba(0,255,65,0.1)] text-[var(--text-secondary)] border-[rgba(0,255,65,0.2)]"
                : "bg-[rgba(251,191,36,0.1)] text-[var(--warning)] border-[rgba(251,191,36,0.2)]"
            }`}
          >
            {nearDupes.length} FOUND
          </span>
        </div>

        {nearDupes.length === 0 ? (
          <div className="text-center py-8">
            <div className="text-xl font-terminal text-[var(--text-primary)] text-glow mb-2">CLEAN</div>
            <p className="text-sm font-mono text-[var(--text-secondary)]">
              No duplicates detected. Brain integrity verified.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {nearDupes.map((d, i) => (
              <div
                key={i}
                className="border border-[var(--border)] rounded-[var(--radius)] p-4 hover:border-[var(--warning)] transition-colors duration-200"
              >
                <div className="flex items-center gap-2 mb-3">
                  <span className="px-2 py-0.5 rounded-[var(--radius-sm)] text-[10px] uppercase tracking-wider font-terminal bg-[rgba(251,191,36,0.1)] text-[var(--warning)] border border-[rgba(251,191,36,0.2)]">
                    {d.similarity}
                  </span>
                  <span className="text-[10px] font-mono text-[var(--text-muted)]">
                    Pair {i + 1}
                  </span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <DupeSide thought={d.a} label="Original" />
                  <DupeSide thought={d.b} label="Duplicate" />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Recent by source */}
      <section className="space-y-4">
        <div className="animate-in stagger-2 flex items-baseline gap-2">
          <h2 className="text-sm font-terminal text-[var(--text-primary)] uppercase tracking-widest flex items-center gap-2">
            <span className="w-1 h-4 rounded-full bg-[var(--accent)]" />
            RECENT CAPTURES BY SOURCE
          </h2>
          <span className="text-xs font-mono text-[var(--text-muted)]">Last 50</span>
        </div>

        <div className="grid grid-cols-1 gap-4">
          {Object.entries(bySource)
            .sort((a, b) => b[1].length - a[1].length)
            .map(([source, items], si) => (
              <div
                key={source}
                className={`animate-in stagger-${Math.min(si + 3, 8)} card`}
              >
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-terminal text-[var(--text-primary)] flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-[var(--accent)]" />
                    {source.toUpperCase()}
                  </h3>
                  <span className="text-xs font-terminal text-[var(--text-muted)] bg-[var(--accent-dim)] px-2.5 py-1 rounded-[var(--radius-sm)] border border-[var(--border)]">
                    {items.length} RECENT
                  </span>
                </div>
                <div className="space-y-2">
                  {items.slice(0, 5).map((t) => (
                    <div
                      key={t.id}
                      className="flex gap-3 text-sm py-1.5 border-b border-[var(--border)] last:border-0"
                    >
                      <span className="text-xs font-mono text-[var(--text-muted)] whitespace-nowrap w-20 shrink-0 tabular-nums">
                        {new Date(t.created_at).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                      <p className="truncate text-[var(--text-body)] font-mono">
                        {t.content}
                      </p>
                    </div>
                  ))}
                  {items.length > 5 && (
                    <p className="text-xs font-mono text-[var(--text-muted)] pt-1">
                      +{items.length - 5} more
                    </p>
                  )}
                </div>
              </div>
            ))}
        </div>
      </section>
    </div>
  );
}

function DupeSide({
  thought,
  label,
}: {
  thought: { content: string; created_at: string; metadata: unknown };
  label: string;
}) {
  const m = (thought.metadata || {}) as Record<string, unknown>;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-terminal">
          {label}
        </span>
        <span className="text-[10px] text-[var(--text-muted)] font-mono tabular-nums">
          {new Date(thought.created_at).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
        </span>
      </div>
      <p className="text-sm text-[var(--text-body)] font-mono line-clamp-4 leading-relaxed">
        {thought.content}
      </p>
      {typeof m.source === "string" && (
        <span className="inline-block text-[10px] px-2 py-0.5 rounded-[var(--radius-sm)] bg-[var(--accent-dim)] text-[var(--text-muted)] font-mono border border-[var(--border)]">
          {m.source}
        </span>
      )}
    </div>
  );
}
