import { supabase } from "@/lib/supabase";
import Link from "next/link";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ q?: string }>;
}

export default async function ClientsPage({ searchParams }: Props) {
  const params = await searchParams;
  const query = params.q || "";

  let q = supabase()
    .from("clients")
    .select("id, name, email, phone, instagram, preferred_styles, last_contact")
    .order("last_contact", { ascending: false, nullsFirst: false });

  if (query) {
    q = q.ilike("name", `%${query}%`);
  }

  const { data: clients } = await q;

  const { data: sessions } = await supabase()
    .from("client_sessions")
    .select("client_id");
  const sessionCounts: Record<string, number> = {};
  for (const s of sessions || []) {
    sessionCounts[s.client_id] = (sessionCounts[s.client_id] || 0) + 1;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-in">
        <h1 className="text-3xl font-terminal text-[var(--text-primary)] text-glow tracking-wide">
          CLIENTS
        </h1>
        <p className="text-sm font-mono text-[var(--text-muted)] mt-1">
          {clients?.length || 0} records loaded
        </p>
      </div>

      {/* Search */}
      <form className="animate-in stagger-1 flex gap-3">
        <div className="flex-1 relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-muted)] font-terminal text-lg">
            &gt;
          </span>
          <input
            name="q"
            type="text"
            defaultValue={query}
            placeholder="search clients..."
            className="w-full pl-10 pr-4 py-3 rounded-[var(--radius-sm)] bg-[var(--bg-input)] border border-[var(--border)] text-[var(--text-body)] font-mono placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-active)] focus:shadow-[0_0_12px_rgba(0,255,65,0.15)] transition-all duration-300"
          />
        </div>
        <button
          type="submit"
          className="px-6 py-3 rounded-[var(--radius-sm)] bg-[var(--accent-dim)] border border-[var(--border)] text-[var(--text-primary)] font-terminal text-lg hover:border-[var(--border-active)] hover:shadow-[0_0_12px_rgba(0,255,65,0.15)] active:scale-[0.98] transition-all duration-200"
        >
          SEARCH
        </button>
      </form>

      {/* Client list */}
      {!clients || clients.length === 0 ? (
        <div className="animate-in stagger-2 card text-center py-12">
          <div className="text-2xl font-terminal text-[var(--text-muted)] mb-2">NO MATCHES</div>
          <p className="text-sm font-mono text-[var(--text-muted)]">
            {query
              ? `No clients matching "${query}".`
              : "No clients yet. Add clients via the MCP tools."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {clients.map((c, i) => (
            <Link
              key={c.id}
              href={`/clients/${c.id}`}
              className={`animate-in stagger-${Math.min(i + 2, 8)} block card scanline-hover group`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {/* Avatar circle */}
                  <div className="w-10 h-10 rounded-full bg-[var(--accent-dim)] border border-[var(--border)] flex items-center justify-center text-[var(--text-primary)] font-terminal text-sm group-hover:border-[var(--border-active)] group-hover:shadow-[0_0_8px_rgba(0,255,65,0.2)] transition-all">
                    {c.name
                      .split(" ")
                      .map((w: string) => w[0])
                      .join("")
                      .slice(0, 2)
                      .toUpperCase()}
                  </div>
                  <div>
                    <span className="font-terminal text-lg text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] group-hover:text-glow transition-all">
                      {c.name}
                    </span>
                    {c.preferred_styles?.length > 0 && (
                      <div className="flex gap-1.5 mt-1">
                        {c.preferred_styles.map((s: string) => (
                          <span
                            key={s}
                            className="text-[10px] px-2 py-0.5 rounded-[var(--radius-sm)] bg-[var(--accent-dim)] text-[var(--text-muted)] font-mono border border-[var(--border)]"
                          >
                            {s}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-4 text-xs text-[var(--text-muted)] font-mono">
                  {sessionCounts[c.id] && (
                    <span className="bg-[var(--accent-dim)] px-2.5 py-1 rounded-[var(--radius-sm)] border border-[var(--border)]">
                      {sessionCounts[c.id]} session
                      {sessionCounts[c.id] > 1 ? "s" : ""}
                    </span>
                  )}
                  {c.last_contact && (
                    <span className="tabular-nums">
                      {new Date(c.last_contact).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  )}
                  <span className="text-[var(--text-muted)] opacity-40 group-hover:opacity-100 group-hover:text-[var(--text-primary)] transition-all font-terminal">
                    &gt;
                  </span>
                </div>
              </div>
              {/* Contact info */}
              <div className="flex gap-4 mt-2 ml-13 text-xs text-[var(--text-muted)] font-mono">
                {c.email && <span>{c.email}</span>}
                {c.phone && <span>{c.phone}</span>}
                {c.instagram && <span>@{c.instagram}</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
