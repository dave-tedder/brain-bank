"use client";

import { useMemo, useRef, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { CompiledPageRow, buildMiniGraphData, getNodeColor, GraphNode } from "@/lib/graph-data";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
});

interface MiniGraphProps {
  pages: CompiledPageRow[];
}

export default function MiniGraph({ pages }: MiniGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ w: 400, h: 250 });

  useEffect(() => {
    function measure() {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setDimensions({ w: rect.width, h: 250 });
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const graphData = useMemo(() => buildMiniGraphData(pages, 25), [pages]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const paintNode = (node: any, ctx: CanvasRenderingContext2D) => {
    const n = node as GraphNode & { x: number; y: number };
    const size = Math.max(2, Math.sqrt(n.val) * 2);
    ctx.beginPath();
    ctx.arc(n.x, n.y, size, 0, 2 * Math.PI);
    ctx.fillStyle = getNodeColor(n.pageType);
    ctx.fill();
  };

  return (
    <div ref={containerRef} style={{ width: "100%", height: 250, cursor: "pointer" }}>
      <a href="/graph" style={{ display: "block", width: "100%", height: "100%" }}>
        <ForceGraph2D
          graphData={graphData}
          width={dimensions.w}
          height={250}
          nodeCanvasObject={paintNode}
          nodePointerAreaPaint={() => {}}
          linkColor={() => "rgba(0, 255, 65, 0.1)"}
          linkWidth={0.3}
          backgroundColor="transparent"
          cooldownTicks={60}
          enableZoomInteraction={false}
          enablePanInteraction={false}
          enableNodeDrag={false}
          d3AlphaDecay={0.05}
          d3VelocityDecay={0.4}
        />
      </a>
    </div>
  );
}
