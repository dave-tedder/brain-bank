import { supabase } from "@/lib/supabase";
import { CompiledPageRow } from "@/lib/graph-data";
import GraphClient from "./GraphClient";

export const dynamic = "force-dynamic";

export default async function GraphPage() {
  const { data } = await supabase()
    .from("compiled_pages")
    .select("id, slug, title, page_type, backlinks, last_compiled")
    .order("title");

  const pages = (data || []) as CompiledPageRow[];

  return <GraphClient pages={pages} />;
}
