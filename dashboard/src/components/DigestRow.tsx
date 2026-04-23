import Link from "next/link";
import type { DigestRow as DigestRowType } from "@/lib/digest";

interface Props {
  digest: DigestRowType;
  stagger?: number;
}

const DENSITY_THRESHOLDS = [3, 8, 15, 25, 40];

function densityBar(count: number): string {
  const filled = DENSITY_THRESHOLDS.filter((t) => count >= t).length;
  const empty = 5 - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

function dayOfWeek(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "America/New_York",
  });
}

export default function DigestRow({ digest, stagger = 0 }: Props) {
  const { digest_date, digest_type, metadata } = digest;
  const briefings = metadata.briefing_count ?? 0;
  const actions = metadata.open_actions_count ?? 0;
  const captures = metadata.source_thought_count ?? 0;
  const bar = densityBar(captures);

  return (
    <div
      className={`relative scanline-hover animate-in stagger-${Math.min(stagger, 8)} transition-colors`}
      style={{
        borderTop: "1px solid var(--border)",
        paddingTop: "0.75rem",
        paddingBottom: "0.75rem",
      }}
    >
      <Link
        href={`/digest/${digest_date}?type=${digest_type}`}
        aria-label={`Digest ${digest_date}`}
        className="absolute inset-0 z-10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <span className="sr-only">Digest {digest_date}</span>
      </Link>

      <div
        className="relative z-20 pointer-events-none flex items-center gap-4 flex-wrap text-sm"
        style={{ fontFamily: "'IBM Plex Mono', monospace" }}
      >
        <span
          className="tabular-nums"
          style={{ color: "var(--text-primary)" }}
        >
          {digest_date}
        </span>
        <span
          className="text-xs uppercase"
          style={{ color: "var(--text-muted)" }}
        >
          {dayOfWeek(digest_date)}
        </span>
        <span
          aria-label={`density ${captures} captures`}
          style={{ color: "var(--text-secondary)", letterSpacing: "0.05em" }}
        >
          {bar}
        </span>
        <span style={{ color: "var(--text-muted)" }}>
          briefings:
          <span style={{ color: "var(--text-body)" }}>{briefings}</span>
        </span>
        <span style={{ color: "var(--text-muted)" }}>
          actions:
          <span style={{ color: "var(--text-body)" }}>{actions}</span>
        </span>
        <span style={{ color: "var(--text-muted)" }}>
          captures:
          <span style={{ color: "var(--text-body)" }}>{captures}</span>
        </span>
        <span
          className="ml-auto"
          style={{ color: "var(--text-muted)" }}
          aria-hidden="true"
        >
          &gt;
        </span>
      </div>
    </div>
  );
}
