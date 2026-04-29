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

  const [thoughtsResult, pagesResult] = await Promise.all([
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

  const relatedThoughts = thoughtsResult.data;
  const pages = pagesResult.data || [];

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

