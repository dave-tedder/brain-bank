import Link from "next/link";
import {
  formatAge,
  type ProjectRollup,
  type ProjectStatusDerived,
} from "@/lib/projects";

// Status colors for the index/detail surfaces. Resolves to the --status-*
// tokens in globals.css; ProjectRow, ProjectCard and the detail header all
// share this one source.
export function statusColor(status: ProjectStatusDerived): string {
  switch (status) {
    case "ACTIVE":
      return "var(--status-active)";
    case "STALE":
      return "var(--status-stale)";
    case "BLOCKER":
      return "var(--status-blocker)";
    case "DORMANT":
      return "var(--status-dormant)";
    default:
      return "var(--status-dormant)";
  }
}

interface Props {
  project: ProjectRollup;
  stagger?: number;
}

/**
 * Single index row, log layout. Flat bordered row with a full-bleed
 * background <Link> (the DigestRow / ClickableCard no-JS pattern) so the
 * whole row navigates to /projects/<slug> without an onClick handler.
 */
export default function ProjectRow({ project, stagger = 0 }: Props) {
  const {
    slug,
    display_name,
    status_derived,
    last_activity_at,
    next_step,
    blocker_text,
  } = project;

  const isBlocked = status_derived === "BLOCKER";
  const detail = isBlocked
    ? blocker_text ?? "blocked"
    : next_step ?? "no open next step";
  const marker = isBlocked ? "⚠" : next_step ? "⟶" : "·";
  const color = statusColor(status_derived);

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
        href={`/projects/${slug}`}
        aria-label={`Project ${display_name}`}
        className="absolute inset-0 z-10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <span className="sr-only">Project {display_name}</span>
      </Link>

      <div
        className="relative z-20 pointer-events-none flex items-center gap-3 flex-wrap text-sm"
        style={{ fontFamily: "'IBM Plex Mono', monospace" }}
      >
        <span
          className="truncate"
          style={{ color: "var(--text-primary)", minWidth: "10rem" }}
        >
          {display_name}
        </span>

        <span
          className="text-[10px] uppercase tracking-wider tabular-nums"
          style={{ color }}
        >
          [{status_derived}]
        </span>

        <span
          className="text-xs tabular-nums"
          style={{ color: "var(--text-muted)" }}
        >
          {formatAge(last_activity_at)}
        </span>

        <span
          className="flex-1 min-w-0 truncate"
          style={{ color: isBlocked ? color : "var(--text-body)" }}
        >
          <span style={{ color: "var(--text-muted)" }}>{marker} </span>
          {detail}
        </span>

        <span style={{ color: "var(--text-muted)" }} aria-hidden="true">
          &gt;
        </span>
      </div>
    </div>
  );
}
