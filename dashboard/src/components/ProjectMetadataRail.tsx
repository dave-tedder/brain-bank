import Link from "next/link";
import { daysSince } from "@/lib/staleness";
import type { ProjectRollup, ProjectAction } from "@/lib/projects";

interface Props {
  project: ProjectRollup;
  openActions: ProjectAction[];
}

function Rule() {
  return (
    <div
      className="my-4"
      style={{
        color: "var(--text-muted)",
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: "12px",
        letterSpacing: "0.02em",
      }}
      aria-hidden="true"
    >
      ──────────
    </div>
  );
}

function SectionHeader({
  label,
  count,
  color,
}: {
  label: string;
  count?: number;
  color?: string;
}) {
  return (
    <h3
      className="font-terminal text-sm uppercase tracking-wider mb-2"
      style={{ color: color ?? "var(--text-secondary)" }}
    >
      <span style={{ color: "var(--text-muted)" }}>&gt; </span>
      {label}
      {typeof count === "number" && (
        <span style={{ color: "var(--text-muted)" }}> [{count}]</span>
      )}
    </h3>
  );
}

/**
 * Sticky right rail for the project detail page. OPEN BLOCKER, OPEN ACTIONS,
 * SOURCES, WORKING DIRS, CROSS-LINKS — sections divided by a horizontal rule.
 */
export default function ProjectMetadataRail({ project, openActions }: Props) {
  const {
    slug,
    blocker_text,
    blocked_at,
    captures,
    captures_7d,
    sources,
    working_dirs,
  } = project;

  const blockerDays = daysSince(blocked_at);
  const hasBlocker = !!blocker_text;
  const hasActions = openActions.length > 0;
  const sourceList = sources ?? [];
  const dirs = working_dirs ?? [];

  return (
    <aside
      className="space-y-0 pb-24 lg:sticky lg:top-6 lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto lg:pr-2"
      style={{ fontFamily: "'IBM Plex Mono', monospace" }}
    >
      {hasBlocker && (
        <div>
          <SectionHeader label="OPEN BLOCKER" color="#ff8c42" />
          <p className="text-sm" style={{ color: "var(--text-body)" }}>
            {blocker_text}
          </p>
          {blockerDays !== null && (
            <p
              className="text-xs mt-1"
              style={{ color: "var(--text-muted)" }}
            >
              open {blockerDays} day{blockerDays === 1 ? "" : "s"}
            </p>
          )}
          <Rule />
        </div>
      )}

      <div>
        <SectionHeader label="OPEN ACTIONS" count={openActions.length} />
        {hasActions ? (
          <ul className="space-y-1 text-sm max-h-64 overflow-y-auto pr-1">
            {openActions.map((a) => (
              <li key={a.id} className="flex items-start gap-2">
                <span
                  style={{ color: "var(--warning)" }}
                  className="text-xs mt-0.5"
                  aria-hidden="true"
                >
                  [ ]
                </span>
                <span style={{ color: "var(--text-body)" }}>
                  {a.description}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            &gt; NONE OPEN
          </p>
        )}
        <Rule />
      </div>

      <div>
        <SectionHeader label="SOURCES" />
        <p className="text-sm" style={{ color: "var(--text-body)" }}>
          {captures} capture{captures === 1 ? "" : "s"}
          <span style={{ color: "var(--text-muted)" }}>
            {" "}
            · {captures_7d} last 7d
          </span>
        </p>
        {sourceList.length > 0 && (
          <p
            className="text-xs mt-1"
            style={{ color: "var(--text-muted)" }}
          >
            {sourceList.join(" · ")}
          </p>
        )}
        <Rule />
      </div>

      {dirs.length > 0 && (
        <div>
          <SectionHeader label="WORKING DIRS" count={dirs.length} />
          <ul className="space-y-1 text-xs">
            {dirs.map((d) => (
              <li
                key={d}
                className="break-all"
                style={{ color: "var(--text-body)" }}
              >
                <span style={{ color: "var(--text-muted)" }}>├─ </span>
                {d}
              </li>
            ))}
          </ul>
          <Rule />
        </div>
      )}

      <div>
        <SectionHeader label="CROSS-LINKS" />
        <ul className="space-y-1 text-sm">
          {[
            {
              href: `/wiki/${encodeURIComponent(`project/${slug}`)}`,
              label: "wiki page",
            },
            { href: `/thoughts?topic=${slug}`, label: "all thoughts" },
            { href: `/actions?project=${slug}`, label: "all actions" },
          ].map((link) => (
            <li key={link.href} className="flex gap-2">
              <span style={{ color: "var(--text-muted)" }} aria-hidden="true">
                ├─
              </span>
              <Link
                href={link.href}
                className="underline underline-offset-2 decoration-1 hover:text-[var(--text-primary)] transition-colors"
                style={{
                  color: "var(--text-secondary)",
                  textDecorationColor: "var(--text-muted)",
                }}
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
