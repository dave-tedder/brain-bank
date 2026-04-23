export interface CompiledPageRow {
  id: string;
  slug: string;
  title: string;
  page_type: string;
  backlinks: string[] | null;
  last_compiled: string | null;
}

export interface GraphNode {
  id: string;
  slug: string;
  title: string;
  pageType: string;
  val: number;
}

export interface GraphLink {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

const TYPE_COLORS: Record<string, string> = {
  client: "#4ade80",
  topic: "#00ff41",
  project: "#fbbf24",
};

export function getNodeColor(pageType: string): string {
  return TYPE_COLORS[pageType] || "#22543d";
}

export function buildGraphData(pages: CompiledPageRow[]): GraphData {
  const slugToId = new Map<string, string>();
  for (const p of pages) {
    slugToId.set(p.slug, p.id);
  }

  const connectionCount = new Map<string, number>();
  const links: GraphLink[] = [];

  for (const p of pages) {
    if (!connectionCount.has(p.id)) connectionCount.set(p.id, 0);

    for (const backlink of p.backlinks || []) {
      const targetId = slugToId.get(backlink);
      if (!targetId || targetId === p.id) continue;
      links.push({ source: p.id, target: targetId });
      connectionCount.set(p.id, (connectionCount.get(p.id) || 0) + 1);
      connectionCount.set(targetId, (connectionCount.get(targetId) || 0) + 1);
    }
  }

  const nodes: GraphNode[] = pages.map((p) => ({
    id: p.id,
    slug: p.slug,
    title: p.title,
    pageType: p.page_type,
    val: Math.max(1, connectionCount.get(p.id) || 0),
  }));

  return { nodes, links };
}

export function buildMiniGraphData(pages: CompiledPageRow[], maxNodes = 25): GraphData {
  const full = buildGraphData(pages);
  const sorted = [...full.nodes].sort((a, b) => b.val - a.val).slice(0, maxNodes);
  const keepIds = new Set(sorted.map((n) => n.id));
  const filteredLinks = full.links.filter(
    (l) => keepIds.has(l.source as string) && keepIds.has(l.target as string)
  );
  return { nodes: sorted, links: filteredLinks };
}
