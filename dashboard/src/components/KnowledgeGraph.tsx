"use client";

import { useRef, useCallback, useEffect, useState, useMemo } from "react";
import dynamic from "next/dynamic";
import { GraphData, GraphNode, getNodeColor } from "@/lib/graph-data";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
});

interface KnowledgeGraphProps {
  data: GraphData;
  activeTypes: Set<string>;
  highlightSlug?: string | null;
  onNodeClick?: (node: GraphNode) => void;
  width?: number;
  height?: number;
}

export default function KnowledgeGraph({
  data,
  activeTypes,
  highlightSlug,
  onNodeClick,
  width,
  height,
}: KnowledgeGraphProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(null);
  const [dimensions, setDimensions] = useState({ w: width || 800, h: height || 600 });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (width && height) {
      setDimensions({ w: width, h: height });
      return;
    }
    function measure() {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setDimensions({ w: rect.width, h: rect.height });
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [width, height]);

  const filteredData = useMemo(() => {
    const nodes = data.nodes.filter((n) => activeTypes.has(n.pageType));
    const nodeIds = new Set(nodes.map((n) => n.id));
    const links = data.links.filter(
      (l) =>
        nodeIds.has(l.source as string) && nodeIds.has(l.target as string)
    );
    return { nodes, links };
  }, [data, activeTypes]);

  const handleNodeClick = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node: any) => {
      if (onNodeClick) onNodeClick(node as GraphNode);
    },
    [onNodeClick]
  );

  const paintNode = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const n = node as GraphNode & { x: number; y: number };
      const size = Math.max(3, Math.sqrt(n.val) * 2.5);
      const color = getNodeColor(n.pageType);
      const isHighlighted = highlightSlug && n.slug === highlightSlug;

      if (isHighlighted) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, size + 4, 0, 2 * Math.PI);
        ctx.fillStyle = "rgba(0, 255, 65, 0.2)";
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(n.x, n.y, size, 0, 2 * Math.PI);
      ctx.fillStyle = isHighlighted ? "#00ff41" : color;
      ctx.fill();

      if (globalScale > 1.5 || isHighlighted) {
        const label = n.title;
        const fontSize = Math.max(10, 12 / globalScale);
        ctx.font = `${fontSize}px 'IBM Plex Mono', monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = isHighlighted ? "#00ff41" : "rgba(176, 196, 176, 0.8)";
        ctx.fillText(label, n.x, n.y + size + 2);
      }
    },
    [highlightSlug]
  );

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%" }}>
      <ForceGraph2D
        ref={graphRef}
        graphData={filteredData}
        width={dimensions.w}
        height={dimensions.h}
        nodeCanvasObject={paintNode}
        nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          const n = node as GraphNode & { x: number; y: number };
          const size = Math.max(3, Math.sqrt(n.val) * 2.5) + 2;
          ctx.beginPath();
          ctx.arc(n.x, n.y, size, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
        }}
        onNodeClick={handleNodeClick}
        linkColor={() => "rgba(0, 255, 65, 0.12)"}
        linkWidth={0.5}
        backgroundColor="transparent"
        cooldownTicks={80}
        d3AlphaDecay={0.03}
        d3VelocityDecay={0.3}
      />
    </div>
  );
}
