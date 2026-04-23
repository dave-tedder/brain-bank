import { supabase } from "@/lib/supabase";
import Link from "next/link";
import ThoughtCard from "@/components/ThoughtCard";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{
    type?: string;
    topic?: string;
    person?: string;
    source?: string;
    date?: string;
    client?: string;
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
  if (params.source)
    query = query.contains("metadata", { source: params.source });
  if (params.client)
    query = query.contains("metadata", { people: [params.client] });
  if (params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date)) {
    const start = new Date(`${params.date}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    query = query
      .gte("created_at", start.toISOString())
      .lt("created_at", end.toISOString());
  }
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

  const hasFilters =
    params.type ||
    params.topic ||
    params.person ||
    params.source ||
    params.date ||
    params.client ||
    params.days;

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
          {params.person && ` | person:${params.person}`}
          {params.source && ` | source:${params.source}`}
          {params.client && ` | client:${params.client}`}
          {params.date && ` | date:${params.date}`}
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
