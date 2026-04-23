import { supabase } from "@/lib/supabase";
import { notFound } from "next/navigation";
import PageContent from "@/components/PageContent";
import Link from "next/link";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ slug: string }>;
}

export default async function WikiDetailPage({ params }: Props) {
  const { slug } = await params;
  const decoded = decodeURIComponent(slug);

  const { data: page } = await supabase()
    .from("compiled_pages")
    .select("id, slug, title, page_type, content, backlinks, last_compiled")
    .eq("slug", decoded)
    .single();

  if (!page) notFound();

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Breadcrumb */}
      <div className="animate-in" style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
        <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
          <Link href="/wiki" style={{ color: "var(--text-muted)" }} className="hover:underline">
            WIKI
          </Link>
          <span>/</span>
          <span style={{ color: "var(--text-secondary)" }}>{page.page_type.toUpperCase()}</span>
          <span>/</span>
          <span style={{ color: "var(--text-primary)" }}>{page.title}</span>
        </div>
      </div>

      {/* Title */}
      <div className="animate-in stagger-1">
        <div className="flex items-center gap-3 mb-2">
          <span
            className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded"
            style={{ background: "var(--accent-dim)", color: "var(--text-secondary)" }}
          >
            {page.page_type}
          </span>
          {page.last_compiled && (
            <span
              className="text-[10px]"
              style={{ color: "var(--text-muted)", fontFamily: "'IBM Plex Mono', monospace" }}
            >
              compiled {new Date(page.last_compiled).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          )}
        </div>
        <h1
          className="font-terminal text-3xl text-glow"
          style={{ color: "var(--text-primary)" }}
        >
          {page.title}
        </h1>
      </div>

      {/* Content */}
      <div className="card animate-in stagger-2">
        <PageContent content={page.content || ""} />
      </div>

      {/* Backlinks */}
      {page.backlinks && page.backlinks.length > 0 && (
        <div className="animate-in stagger-3">
          <h2
            className="font-terminal text-sm uppercase tracking-wider mb-3"
            style={{ color: "var(--text-muted)" }}
          >
            <span>&gt; </span>BACKLINKS ({page.backlinks.length})
          </h2>
          <div className="flex flex-wrap gap-2">
            {page.backlinks.map((bl: string) => (
              <Link
                key={bl}
                href={`/wiki/${encodeURIComponent(bl)}`}
                className="backlink-chip text-xs px-3 py-1.5 rounded"
                style={{
                  background: "var(--accent-dim)",
                  border: "1px solid var(--border)",
                  color: "var(--text-secondary)",
                }}
              >
                {bl.replace(/^(client|topic|project)\//, "")}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Graph link */}
      <div className="animate-in stagger-4">
        <Link
          href="/graph"
          className="font-terminal text-xs inline-block py-2 transition-colors"
          style={{ color: "var(--text-muted)" }}
        >
          &gt; view in graph_
        </Link>
      </div>
    </div>
  );
}
