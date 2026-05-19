import Link from "next/link";
import { formatAge, type ProjectRollup } from "@/lib/projects";
import { statusColor } from "@/components/ProjectRow";

interface Props {
  project: ProjectRollup;
  stagger?: number;
}

/**
 * Grid-layout card variant — same data as ProjectRow, denser visual. The
 * status-colored left border is the differentiator. Full-bleed background
 * <Link> (no onClick) navigates to /projects/<slug>.
 */
export default function ProjectCard({ project, stagger = 0 }: Props) {
  const {
    slug,
    display_name,
    type,
    status_derived,
    last_activity_at,
    next_step,
    blocker_text,
    captures,
    captures_7d,
  } = project;

  const isBlocked = status_derived === "BLOCKER";
  const detail = isBlocked
    ? blocker_text ?? "blocked"
    : next_step ?? "no open next step";
  const marker = isBlocked ? "⚠" : next_step ? "⟶" : "·";
  const color = statusColor(status_derived);

  return (
    <div
      className={`card scanline-hover border-l-2 animate-in stagger-${Math.min(stagger, 8)} relative transition-all duration-200 hover:border-[var(--accent)]`}
      style={{ borderLeftColor: color }}
    >
      <Link
        href={`/projects/${slug}`}
        aria-label={`Project ${display_name}`}
        className="absolute inset-0 z-10 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <span className="sr-only">Project {display_name}</span>
      </Link>

      <div
        className="relative z-20 pointer-events-none"
        style={{ fontFamily: "'IBM Plex Mono', monospace" }}
      >
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <h2
            className="font-terminal text-lg truncate"
            style={{ color: "var(--text-primary)" }}
          >
            {display_name}
          </h2>
          <span
            className="text-[10px] uppercase tracking-wider shrink-0"
            style={{ color }}
          >
            [{status_derived}]
          </span>
        </div>

        <div
          className="text-[10px] uppercase tracking-wider mb-3"
          style={{ color: "var(--text-muted)" }}
        >
          {type} · {formatAge(last_activity_at)}
        </div>

        <p
          className="text-sm mb-3 line-clamp-2"
          style={{ color: isBlocked ? color : "var(--text-body)" }}
        >
          <span style={{ color: "var(--text-muted)" }}>{marker} </span>
          {detail}
        </p>

        <div
          className="text-xs tabular-nums"
          style={{ color: "var(--text-muted)" }}
        >
          {captures} capture{captures === 1 ? "" : "s"} · {captures_7d} last 7d
        </div>
      </div>
    </div>
  );
}
