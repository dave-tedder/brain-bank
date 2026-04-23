import { supabase } from "@/lib/supabase";
import Link from "next/link";
import { notFound } from "next/navigation";
import ThoughtCard from "@/components/ThoughtCard";
import ClientMiniGraph from "@/components/ClientMiniGraph";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ClientDetailPage({ params }: Props) {
  const { id } = await params;

  const { data: client } = await supabase()
    .from("clients")
    .select("*")
    .eq("id", id)
    .single();

  if (!client) notFound();

  const [sessionsResult, thoughtsResult, pagesResult] = await Promise.all([
    supabase()
      .from("client_sessions")
      .select("*")
      .eq("client_id", id)
      .order("session_date", { ascending: false }),
    supabase()
      .from("thoughts")
      .select("id, content, metadata, created_at")
      .contains("metadata", { people: [client.name] })
      .order("created_at", { ascending: false })
      .limit(15),
    supabase()
      .from("compiled_pages")
      .select("id, slug, title, page_type, backlinks, last_compiled"),
  ]);

  const sessions = sessionsResult.data;
  const relatedThoughts = thoughtsResult.data;
  const pages = pagesResult.data || [];

  const totalHours = (sessions || [])
    .filter((s) => s.status === "completed" && s.duration_hours)
    .reduce((sum, s) => sum + Number(s.duration_hours), 0);

  const clientSlug = `client/${client.name.toLowerCase().replace(/\s+/g, "-")}`;

  return (
    <div className="space-y-8">
      {/* Breadcrumb + name */}
      <div className="animate-in">
        <div className="flex items-center gap-2 text-sm font-mono text-[var(--text-muted)] mb-3">
          <Link href="/clients" className="hover:text-[var(--text-primary)] transition-colors">
            CLIENTS
          </Link>
          <span className="font-terminal">/</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-[var(--accent-dim)] border border-[var(--border)] flex items-center justify-center text-[var(--text-primary)] font-terminal text-xl">
            {client.name
              .split(" ")
              .map((w: string) => w[0])
              .join("")
              .slice(0, 2)
              .toUpperCase()}
          </div>
          <div>
            <h1 className="text-3xl font-terminal text-[var(--text-primary)] text-glow tracking-wide">
              {client.name.toUpperCase()}
            </h1>
            {client.preferred_styles?.length > 0 && (
              <div className="flex gap-1.5 mt-1">
                {client.preferred_styles.map((s: string) => (
                  <span
                    key={s}
                    className="text-xs px-2.5 py-0.5 rounded-[var(--radius-sm)] bg-[var(--accent-dim)] text-[var(--text-secondary)] font-mono border border-[var(--border)]"
                  >
                    {s}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Profile + Summary grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Profile */}
        <div className="animate-in stagger-1 card space-y-4">
          <h2 className="text-sm font-terminal text-[var(--text-primary)] uppercase tracking-widest flex items-center gap-2">
            <span className="w-1 h-4 rounded-full bg-[var(--accent)]" />
            PROFILE
          </h2>
          <dl className="space-y-3 text-sm font-mono">
            {client.email && <Row label="Email" value={client.email} />}
            {client.phone && <Row label="Phone" value={client.phone} />}
            {client.instagram && <Row label="Instagram" value={`@${client.instagram}`} />}
            {client.first_contact && (
              <Row
                label="First Contact"
                value={new Date(client.first_contact).toLocaleDateString("en-US", {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })}
              />
            )}
            {client.last_contact && (
              <Row
                label="Last Contact"
                value={new Date(client.last_contact).toLocaleDateString("en-US", {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })}
              />
            )}
          </dl>
          {client.notes && (
            <div className="pt-3 border-t border-[var(--border)]">
              <p className="text-sm text-[var(--text-body)] font-mono leading-relaxed">
                {client.notes}
              </p>
            </div>
          )}
        </div>

        {/* Summary stats */}
        <div className="animate-in stagger-2 card">
          <h2 className="text-sm font-terminal text-[var(--text-primary)] uppercase tracking-widest flex items-center gap-2 mb-4">
            <span className="w-1 h-4 rounded-full bg-[var(--accent)]" />
            SUMMARY
          </h2>
          <div className="grid grid-cols-2 gap-6">
            <Stat label="Sessions" value={sessions?.length || 0} />
            <Stat label="Total Hours" value={totalHours} />
            <Stat
              label="Completed"
              value={sessions?.filter((s) => s.status === "completed").length || 0}
            />
            <Stat label="Related Thoughts" value={relatedThoughts?.length || 0} />
          </div>
        </div>
      </div>

      {/* Knowledge Graph */}
      <section className="animate-in stagger-3 card">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-terminal text-[var(--text-primary)] uppercase tracking-widest flex items-center gap-2">
            <span className="w-1 h-4 rounded-full bg-[var(--accent)]" />
            KNOWLEDGE GRAPH
          </h2>
          <Link
            href="/graph"
            className="text-xs font-terminal text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          >
            [FULL MAP]
          </Link>
        </div>
        <ClientMiniGraph pages={pages} clientSlug={clientSlug} />
      </section>

      {/* Session History */}
      <section className="animate-in stagger-4 card">
        <h2 className="text-sm font-terminal text-[var(--text-primary)] uppercase tracking-widest flex items-center gap-2 mb-4">
          <span className="w-1 h-4 rounded-full bg-[var(--accent)]" />
          SESSION HISTORY
        </h2>
        {!sessions?.length ? (
          <div className="text-center py-8">
            <div className="text-xl font-terminal text-[var(--text-muted)] mb-2">NO SESSIONS</div>
            <p className="text-sm font-mono text-[var(--text-muted)]">No sessions recorded yet.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm font-mono">
              <thead>
                <tr className="border-b border-[var(--border)] text-left">
                  <th className="pb-3 pr-4 font-terminal text-xs text-[var(--text-primary)] uppercase tracking-widest">Date</th>
                  <th className="pb-3 pr-4 font-terminal text-xs text-[var(--text-primary)] uppercase tracking-widest">Status</th>
                  <th className="pb-3 pr-4 font-terminal text-xs text-[var(--text-primary)] uppercase tracking-widest">Piece</th>
                  <th className="pb-3 pr-4 font-terminal text-xs text-[var(--text-primary)] uppercase tracking-widest">Placement</th>
                  <th className="pb-3 pr-4 font-terminal text-xs text-[var(--text-primary)] uppercase tracking-widest">Style</th>
                  <th className="pb-3 pr-4 font-terminal text-xs text-[var(--text-primary)] uppercase tracking-widest">Hours</th>
                  <th className="pb-3 font-terminal text-xs text-[var(--text-primary)] uppercase tracking-widest">Notes</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr
                    key={s.id}
                    className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--accent-dim)] transition-colors"
                  >
                    <td className="py-3 pr-4 whitespace-nowrap tabular-nums text-[var(--text-body)]">
                      {s.session_date
                        ? new Date(s.session_date + "T12:00:00").toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })
                        : "TBD"}
                    </td>
                    <td className="py-3 pr-4">
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="py-3 pr-4 text-[var(--text-body)]">{s.piece_description || "-"}</td>
                    <td className="py-3 pr-4 text-[var(--text-body)]">{s.placement || "-"}</td>
                    <td className="py-3 pr-4 text-[var(--text-body)]">{s.style || "-"}</td>
                    <td className="py-3 pr-4 tabular-nums text-[var(--text-body)]">{s.duration_hours || "-"}</td>
                    <td className="py-3 text-[var(--text-muted)] max-w-48 truncate">{s.notes || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Related Thoughts */}
      {relatedThoughts && relatedThoughts.length > 0 && (
        <section className="space-y-4">
          <div className="animate-in stagger-5 flex items-baseline gap-2">
            <h2 className="text-sm font-terminal text-[var(--text-primary)] uppercase tracking-widest flex items-center gap-2">
              <span className="w-1 h-4 rounded-full bg-[var(--accent)]" />
              RELATED THOUGHTS
            </h2>
            <span className="text-xs font-mono text-[var(--text-muted)]">
              {relatedThoughts.length} found
            </span>
          </div>
          <div className="space-y-3">
            {relatedThoughts.map((t, i) => (
              <div key={t.id} className={`animate-in stagger-${Math.min(i + 6, 8)}`}>
                <ThoughtCard
                  id={t.id}
                  content={t.content}
                  metadata={t.metadata as Record<string, unknown>}
                  created_at={t.created_at}
                />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 items-baseline">
      <dt className="w-28 text-[var(--text-muted)] text-xs font-terminal uppercase tracking-widest shrink-0">
        {label}
      </dt>
      <dd className="text-[var(--text-body)]">{value}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-xs font-terminal text-[var(--text-muted)] uppercase tracking-widest mb-1">
        {label}
      </div>
      <div className="text-2xl font-terminal text-[var(--text-primary)] text-glow tabular-nums">
        {value}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    completed: "bg-[rgba(0,255,65,0.1)] text-[var(--text-secondary)] border-[rgba(0,255,65,0.2)]",
    scheduled: "bg-[rgba(251,191,36,0.1)] text-[var(--warning)] border-[rgba(251,191,36,0.2)]",
    cancelled: "bg-[var(--accent-dim)] text-[var(--text-muted)] border-[var(--border)]",
    "no-show": "bg-[rgba(239,68,68,0.1)] text-[var(--danger)] border-[rgba(239,68,68,0.2)]",
  };
  return (
    <span
      className={`px-2.5 py-1 rounded-[var(--radius-sm)] text-[10px] uppercase tracking-wider font-terminal border ${styles[status] || "bg-[var(--accent-dim)] text-[var(--text-muted)] border-[var(--border)]"}`}
    >
      {status}
    </span>
  );
}
