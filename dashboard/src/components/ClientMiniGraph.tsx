"use client";

import { useMemo, useRef, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { CompiledPageRow, buildGraphData, getNodeColor, GraphNode } from "@/lib/graph-data";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
});

interface ClientMiniGraphProps {
  pages: CompiledPageRow[];
  clientSlug: string;
}

export default function ClientMiniGraph({ pages, clientSlug }: ClientMiniGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ w: 400, h: 280 });

  useEffect(() => {
    function measure() {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setDimensions({ w: rect.width, h: 280 });
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const graphData = useMemo(() => {
    const full = buildGraphData(pages);
    const clientNode = full.nodes.find((n) => n.slug === clientSlug);
    if (!clientNode) return { nodes: [], links: [] };

    const neighborIds = new Set<string>();
    neighborIds.add(clientNode.id);
    for (const link of full.links) {
      const src = typeof link.source === "string" ? link.source : (link.source as unknown as GraphNode).id;
      const tgt = typeof link.target === "string" ? link.target : (link.target as unknown as GraphNode).id;
      if (src === clientNode.id) neighborIds.add(tgt);
      if (tgt === clientNode.id) neighborIds.add(src);
    }

    const nodes = full.nodes.filter((n) => neighborIds.has(n.id));
    const links = full.links.filter((l) => {
      const src = typeof l.source === "string" ? l.source : (l.source as unknown as GraphNode).id;
      const tgt = typeof l.target === "string" ? l.target : (l.target as unknown as GraphNode).id;
      return neighborIds.has(src) && neighborIds.has(tgt);
    });

    return { nodes, links };
  }, [pages, clientSlug]);

  const paintNode = (node: unknown, ctx: CanvasRenderingContext2D) => {
    const n = node as GraphNode & { x: number; y: number };
    const isClient = n.slug === clientSlug;
    const size = isClient ? 6 : Math.max(2, Math.sqrt(n.val) * 2);

    if (isClient) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, size + 4, 0, 2 * Math.PI);
      ctx.fillStyle = "rgba(0, 255, 65, 0.15)";
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(n.x, n.y, size, 0, 2 * Math.PI);
    ctx.fillStyle = getNodeColor(n.pageType);
    ctx.fill();

    if (isClient) {
      ctx.font = "10px VT323";
      ctx.fillStyle = "#00ff41";
      ctx.textAlign = "center";
      ctx.fillText(n.title, n.x, n.y - size - 6);
    }
  };

  if (graphData.nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-[280px] text-[var(--text-muted)] font-terminal text-sm">
        NO WIKI PAGE LINKED
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ width: "100%", height: 280 }}>
      <ForceGraph2D
        graphData={graphData}
        width={dimensions.w}
        height={280}
        nodeCanvasObject={paintNode}
        nodePointerAreaPaint={() => {}}
        linkColor={() => "rgba(0, 255, 65, 0.15)"}
        linkWidth={0.5}
        backgroundColor="transparent"
        cooldownTicks={80}
        enableZoomInteraction={false}
        enablePanInteraction={false}
        enableNodeDrag={false}
        d3AlphaDecay={0.04}
        d3VelocityDecay={0.3}
      />
    </div>
  );
}
