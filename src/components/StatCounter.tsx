"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";

interface StatCounterProps {
  label: string;
  value: number;
  delay?: number;
  accent?: boolean;
  href?: string;
}

export default function StatCounter({
  label,
  value,
  delay = 0,
  accent = false,
  href,
}: StatCounterProps) {
  const [displayValue, setDisplayValue] = useState(0);
  const startTime = useRef<number | null>(null);
  const rafId = useRef<number>(0);

  useEffect(() => {
    // Reset on value change
    startTime.current = null;
    setDisplayValue(0);

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplayValue(value);
      return;
    }

    const timeout = setTimeout(() => {
      function animate(timestamp: number) {
        if (!startTime.current) startTime.current = timestamp;
        const elapsed = timestamp - startTime.current;
        const progress = Math.min(elapsed / 1200, 1);
        const eased = 1 - Math.pow(2, -10 * progress);
        setDisplayValue(Math.round(eased * value));
        if (progress < 1) {
          rafId.current = requestAnimationFrame(animate);
        }
      }
      rafId.current = requestAnimationFrame(animate);
    }, delay);

    return () => {
      clearTimeout(timeout);
      cancelAnimationFrame(rafId.current);
    };
  }, [value, delay]);

  const formatted = new Intl.NumberFormat("en-US").format(displayValue);
  const color = accent ? "var(--warning)" : "var(--text-primary)";
  const glow = accent
    ? "0 0 10px rgba(251, 191, 36, 0.3)"
    : "0 0 10px rgba(0, 255, 65, 0.3)";

  const inner = (
    <>
      <div
        className="text-[10px] uppercase tracking-[0.2em] mb-2"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </div>
      <div
        className="font-terminal text-4xl tabular-nums"
        style={{ color, textShadow: glow }}
      >
        {formatted}
      </div>
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="card scanline-hover p-4 block transition-all duration-200 hover:border-[var(--accent)] hover:-translate-y-0.5"
      >
        {inner}
      </Link>
    );
  }

  return <div className="card scanline-hover p-4">{inner}</div>;
}
