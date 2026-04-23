import Link from "next/link";
import { supabase } from "@/lib/supabase";
import StatCounter from "@/components/StatCounter";
import MiniGraph from "@/components/MiniGraph";
import ClickableCard from "@/components/ClickableCard";
import DigestHeroCard from "@/components/DigestHeroCard";
import { CompiledPageRow } from "@/lib/graph-data";

interface ThoughtRow {
  id?: string;
  metadata: Record<string, unknown>;
  created_at: string;
  content?: string;
}

export const dynamic = "force-dynamic";

export default async function StatsPage() {
  const { count } = await supabase()
    .from("thoughts")
    .select("*", { count: "exact", head: true });

  const { data: thoughts } = await supabase()
    .from("thoughts")
    .select("id, content, metadata, created_at")
    .order("created_at", { ascending: false });

  const { count: clientCount } = await supabase()
    .from("clients")
    .select("*", { count: "exact", head: true });

  const { count: actionCount } = await supabase()
    .from("action_items")
    .select("*", { count: "exact", head: true })
    .eq("status", "open");

  const { count: wikiCount } = await supabase()
    .from("compiled_pages")
    .select("*", { count: "exact", head: true });

  const { data: wikiPages } = await supabase()
    .from("compiled_pages")
    .select("id, slug, title, page_type, backlinks, last_compiled")
    .order("title");

  const types: Record<string, number> = {};
  const topics: Record<string, number> = {};
  const people: Record<string, number> = {};
  const sources: Record<string, number> = {};
  const byDay: Record<string, number> = {};

  for (const r of (thoughts || []) as ThoughtRow[]) {
    const m = r.metadata || {};
    if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
    if (m.source)
      sources[m.source as string] = (sources[m.source as string] || 0) + 1;
    if (Array.isArray(m.topics))
      for (const t of m.topics)
        topics[t as string] = (topics[t as string] || 0) + 1;
    if (Array.isArray(m.people))
      for (const p of m.people)
        people[p as string] = (people[p as string] || 0) + 1;
    const day = new Date(r.created_at).toISOString().split("T")[0];
    byDay[day] = (byDay[day] || 0) + 1;
  }

  const sort = (o: Record<string, number>, n = 8) =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);

  const oldest = thoughts?.length
    ? thoughts[thoughts.length - 1].created_at
    : null;
  const newest = thoughts?.length ? thoughts[0].created_at : null;

  const days14 = last14Days();
  const maxDay = Math.max(...days14.map((d) => byDay[d] || 0), 1);

  const recentThoughts = (thoughts || []).slice(0, 5) as ThoughtRow[];

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="animate-in">
        <h1 className="font-terminal text-3xl text-glow" style={{ color: "var(--text-primary)" }}>
          <span style={{ color: "var(--text-muted)" }}>&gt; </span>
          DASHBOARD
        </h1>
        {oldest && newest && (
          <p className="text-sm mt-1" style={{ color: "var(--text-muted)", fontFamily: "'IBM Plex Mono', monospace" }}>
            {fmt(oldest)} to {fmt(newest)}
          </p>
        )}
      </div>

      {/* Daily digest hero */}
      <DigestHeroCard />

      {/* Stat counters */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCounter label="THOUGHTS" value={count ?? 0} delay={0} href="/thoughts" />
        <StatCounter label="CLIENTS" value={clientCount ?? 0} delay={100} href="/clients" />
        <StatCounter label="WIKI PAGES" value={wikiCount ?? 0} delay={200} href="/wiki" />
        <StatCounter
          label="OPEN ACTIONS"
          value={actionCount ?? 0}
          delay={300}
          accent={!!actionCount && actionCount > 0}
          href="/actions"
        />
      </div>

      {/* Activity chart */}
      <ClickableCard
        title="Activity"
        subtitle="Last 14 days"
        href="/thoughts"
        stagger={0}
      >
        <div className="flex items-end gap-1.5 h-32 pt-2">
          {days14.map((day, i) => {
            const c = byDay[day] || 0;
            const pct = (c / maxDay) * 100;
            return (
              <Link
                key={day}
                href={`/thoughts?date=${day}`}
                className="flex-1 flex flex-col items-center gap-1.5 group"
              >
                <div
                  className="text-[10px] opacity-0 group-hover:opacity-100 transition-opacity tabular-nums"
                  style={{ color: "var(--text-secondary)", fontFamily: "'IBM Plex Mono', monospace" }}
                >
                  {c}
                </div>
                <div className="w-full relative">
                  <div
                    className="w-full rounded-t-md transition-all duration-500 group-hover:opacity-100"
                    style={{
                      height: `${Math.max(pct * 0.9, c ? 4 : 0)}px`,
                      background: c
                        ? "repeating-linear-gradient(to bottom, var(--accent) 0px, var(--accent) 3px, rgba(0, 0, 0, 0.75) 3px, rgba(0, 0, 0, 0.75) 4px)"
                        : "transparent",
                      opacity: c ? 0.85 : 0,
                      animationDelay: `${i * 0.03}s`,
                    }}
                  />
                  <div className="w-full h-px" style={{ backgroundColor: "var(--border)" }} />
                </div>
                <span
                  className="text-[10px] tabular-nums"
                  style={{ color: "var(--text-muted)", fontFamily: "'IBM Plex Mono', monospace" }}
                >
                  {day.slice(5)}
                </span>
              </Link>
            );
          })}
        </div>
      </ClickableCard>

      {/* Knowledge graph preview */}
      <ClickableCard
        title="Knowledge Graph"
        subtitle={`${(wikiPages || []).length} pages`}
        href="/graph"
        stagger={1}
      >
        <MiniGraph pages={(wikiPages || []) as CompiledPageRow[]} />
        <div
          className="block text-xs mt-2 py-1"
          style={{ color: "var(--text-muted)", fontFamily: "'IBM Plex Mono', monospace" }}
        >
          <span style={{ color: "var(--text-muted)" }}>&gt; </span>
          explore full graph
          <span style={{ color: "var(--text-primary)" }}>_</span>
        </div>
      </ClickableCard>

      {/* Two-column: Source + Type */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ClickableCard title="By Source" href="/thoughts" stagger={2}>
          <BarList items={sort(sources)} hrefPrefix="/thoughts?source=" />
        </ClickableCard>
        <ClickableCard title="By Type" href="/thoughts" stagger={3}>
          <BarList items={sort(types)} hrefPrefix="/thoughts?type=" />
        </ClickableCard>
      </div>

      {/* Two-column: Topics + People */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ClickableCard title="Top Topics" href="/thoughts" stagger={4}>
          <TagCloud items={sort(topics, 15)} />
        </ClickableCard>
        <ClickableCard title="People Mentioned" href="/thoughts" stagger={5}>
          <BarList items={sort(people)} hrefPrefix="/thoughts?person=" />
        </ClickableCard>
      </div>

      {/* Recent captures */}
      <ClickableCard title="Recent Captures" href="/thoughts" stagger={6}>
        <div className="space-y-2">
          {recentThoughts.map((t, i) => {
            const m = t.metadata || {};
            const type = (m.type as string) || "unknown";
            const source = m.source as string;
            return (
              <Link
                key={i}
                href={t.id ? `/thoughts/${t.id}` : "/thoughts"}
                className="flex items-start gap-3 py-2 border-b last:border-0 -mx-2 px-2 rounded transition-colors hover:bg-[rgba(0,255,65,0.04)]"
                style={{ borderColor: "var(--border)" }}
              >
                <div
                  className="w-0.5 h-8 shrink-0 mt-0.5 rounded-full"
                  style={{ backgroundColor: "rgba(0, 255, 65, 0.3)" }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span
                      className="text-[10px] tabular-nums"
                      style={{ color: "rgba(0, 255, 65, 0.5)", fontFamily: "'IBM Plex Mono', monospace" }}
                    >
                      [{terminalTime(t.created_at)}]
                    </span>
                    <span
                      className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                      style={{
                        backgroundColor: "var(--accent-dim)",
                        color: "var(--text-secondary)",
                      }}
                    >
                      {type}
                    </span>
                    {source && (
                      <span
                        className="text-[10px]"
                        style={{ color: "var(--text-muted)", fontFamily: "'IBM Plex Mono', monospace" }}
                      >
                        via {source}
                      </span>
                    )}
                  </div>
                  <p
                    className="text-sm truncate"
                    style={{ color: "var(--text-body)" }}
                  >
                    {t.content || "No content"}
                  </p>
                </div>
              </Link>
            );
          })}
        </div>
        <div
          className="block text-xs mt-4 py-2"
          style={{ color: "var(--text-muted)", fontFamily: "'IBM Plex Mono', monospace" }}
        >
          <span style={{ color: "var(--text-muted)" }}>&gt; </span>
          view all thoughts
          <span style={{ color: "var(--text-primary)" }}>_</span>
        </div>
      </ClickableCard>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Components                                                         */
/* ------------------------------------------------------------------ */

function BarList({
  items,
  hrefPrefix,
}: {
  items: [string, number][];
  hrefPrefix?: string;
}) {
  const max = items.length ? items[0][1] : 1;
  return (
    <div className="space-y-2.5">
      {items.map(([name, count]) => {
        const row = (
          <div className="flex items-center gap-3 text-sm group">
            <span
              className="w-24 truncate text-xs transition-colors group-hover:text-[var(--text-primary)]"
              style={{
                color: "var(--text-muted)",
                fontFamily: "'IBM Plex Mono', monospace",
              }}
            >
              {name}
            </span>
            <div
              className="flex-1 h-6 rounded-md overflow-hidden"
              style={{ backgroundColor: "var(--bg-input)" }}
            >
              <div
                className="h-full rounded-md transition-all duration-700"
                style={{
                  width: `${(count / max) * 100}%`,
                  background:
                    "repeating-linear-gradient(to right, var(--accent) 0px, var(--accent) 3px, rgba(0, 0, 0, 0.75) 3px, rgba(0, 0, 0, 0.75) 4px)",
                }}
              />
            </div>
            <span
              className="w-8 text-right tabular-nums text-xs"
              style={{ color: "var(--text-muted)", fontFamily: "'IBM Plex Mono', monospace" }}
            >
              {count}
            </span>
          </div>
        );
        return hrefPrefix ? (
          <Link
            key={name}
            href={`${hrefPrefix}${encodeURIComponent(name)}`}
            className="block -mx-2 px-2 py-0.5 rounded hover:bg-[rgba(0,255,65,0.04)] transition-colors"
          >
            {row}
          </Link>
        ) : (
          <div key={name}>{row}</div>
        );
      })}
      {items.length === 0 && (
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>No data yet.</p>
      )}
    </div>
  );
}

function TagCloud({ items }: { items: [string, number][] }) {
  const max = items.length ? items[0][1] : 1;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(([name, count]) => {
        const intensity = Math.max(0.4, count / max);
        return (
          <Link
            key={name}
            href={`/thoughts?topic=${encodeURIComponent(name)}`}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 hover:scale-105"
            style={{
              backgroundColor: `rgba(0, 255, 65, ${intensity * 0.12})`,
              color: `rgba(0, 255, 65, ${0.5 + intensity * 0.5})`,
              borderWidth: "1px",
              borderColor: `rgba(0, 255, 65, ${intensity * 0.25})`,
            }}
          >
            {name}
            <span className="ml-1.5 opacity-60">{count}</span>
          </Link>
        );
      })}
      {items.length === 0 && (
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>No topics yet.</p>
      )}
    </div>
  );
}

function fmt(d: string) {
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function terminalTime(d: string) {
  const date = new Date(d);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}

function last14Days() {
  const days: string[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().split("T")[0]);
  }
  return days;
}
