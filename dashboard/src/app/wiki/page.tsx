import { supabase } from "@/lib/supabase";
import { CompiledPageRow } from "@/lib/graph-data";
import WikiList from "./WikiList";

export const dynamic = "force-dynamic";

export default async function WikiPage() {
  const { data } = await supabase()
    .from("compiled_pages")
    .select("id, slug, title, page_type, backlinks, last_compiled")
    .order("title");

  const pages = (data || []) as CompiledPageRow[];

  return (
    <div className="space-y-6">
      <div className="animate-in">
        <h1 className="font-terminal text-3xl text-glow" style={{ color: "var(--text-primary)" }}>
          <span style={{ color: "var(--text-muted)" }}>&gt; </span>
          WIKI
        </h1>
        <p
          className="text-sm mt-1"
          style={{ color: "var(--text-muted)", fontFamily: "'IBM Plex Mono', monospace" }}
        >
          {pages.length} compiled pages
        </p>
      </div>
      <WikiList pages={pages} />
    </div>
  );
}
