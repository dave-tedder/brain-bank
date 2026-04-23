"use client";
import { useEffect, useRef } from "react";

const CHARS = (() => {
  let str = "";
  // Katakana block (0x30A0–0x30FF)
  for (let i = 0x30a0; i <= 0x30ff; i++) str += String.fromCharCode(i);
  // Latin uppercase + digits
  str += "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return str;
})();

export default function MatrixRain() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Respect reduced motion preference
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const fontSize = 14;
    let animId: number;
    let columns: number[] = [];
    let speeds: number[] = [];
    let fades: number[] = [];
    let lastRows: number[] = [];
    let colCount = 0;
    let resizeTimer: ReturnType<typeof setTimeout>;

    function getSpacing(): number {
      return window.innerWidth >= 768 ? 20 : 40;
    }

    // Per-column speed in rows per frame. Lower = slower.
    // Exponential bias (^3) heavily skews the distribution toward the
    // slow end — the majority of columns creep, a few drift faster.
    // Range: 0.005 (≈1 char every 3–4 seconds) to 0.12 (≈7 chars/sec).
    function randomSpeed(): number {
      return 0.005 + Math.pow(Math.random(), 3) * 0.115;
    }

    // Per-column trail fade alpha. Lower = longer visible trail.
    // Wide range means some columns leave long glowing tails while
    // others fade to black almost immediately.
    function randomFade(): number {
      return 0.015 + Math.random() * 0.1; // 0.015 – 0.115
    }

    function resize() {
      canvas!.width = window.innerWidth;
      canvas!.height = window.innerHeight;
      const spacing = getSpacing();
      colCount = Math.floor(canvas!.width / spacing);
      // Preserve existing column state; randomize any new ones
      const newCols: number[] = [];
      const newSpeeds: number[] = [];
      const newFades: number[] = [];
      const newLastRows: number[] = [];
      for (let i = 0; i < colCount; i++) {
        newCols.push(
          columns[i] !== undefined
            ? columns[i]
            : (Math.random() * canvas!.height) / fontSize
        );
        newSpeeds.push(speeds[i] !== undefined ? speeds[i] : randomSpeed());
        newFades.push(fades[i] !== undefined ? fades[i] : randomFade());
        newLastRows.push(lastRows[i] !== undefined ? lastRows[i] : -1);
      }
      columns = newCols;
      speeds = newSpeeds;
      fades = newFades;
      lastRows = newLastRows;
    }

    const handleResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 200);
    };

    resize();
    window.addEventListener("resize", handleResize);

    function draw() {
      const h = canvas!.height;
      const spacing = getSpacing();

      ctx!.font = `${fontSize}px monospace`;

      for (let i = 0; i < colCount; i++) {
        const x = i * spacing;

        // Per-column fade: paint a black rect only over this column's
        // slice of the canvas. Each column gets its own fade rate, so
        // some trails linger much longer than others.
        ctx!.fillStyle = `rgba(0, 0, 0, ${fades[i]})`;
        ctx!.fillRect(x, 0, spacing, h);

        // Advance this column at its own speed
        columns[i] += speeds[i];
        const row = Math.floor(columns[i]);

        // Only paint a new glyph when the column has moved to a new row.
        // Prevents stacking the same character at the same pixel every frame.
        if (row !== lastRows[i]) {
          const char = CHARS[Math.floor(Math.random() * CHARS.length)];
          const y = row * fontSize;

          // Dimmer lead character
          ctx!.fillStyle = spacing > 20 ? "rgba(0, 255, 65, 0.28)" : "rgba(0, 255, 65, 0.45)";
          ctx!.fillText(char, x, y);

          lastRows[i] = row;
        }

        // Reset column when it has scrolled past the canvas
        if (columns[i] * fontSize > h && Math.random() > 0.975) {
          columns[i] = 0;
          lastRows[i] = -1;
          // Re-randomize speed + fade on reset so the pattern keeps varying
          speeds[i] = randomSpeed();
          fades[i] = randomFade();
        }
      }

      animId = requestAnimationFrame(draw);
    }

    animId = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", handleResize);
      clearTimeout(resizeTimer);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 z-0 pointer-events-none"
      aria-hidden="true"
    />
  );
}
