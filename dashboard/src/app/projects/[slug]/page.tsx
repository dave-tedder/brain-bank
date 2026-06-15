import Link from "next/link";
import {
  getProjectBySlug,
  getProjectVision,
  listProjectTimeline,
  listProjectOpenActions,
} from "@/lib/projects";
import { statusColor } from "@/components/ProjectRow";
import ProjectTimeline from "@/components/ProjectTimeline";
import ProjectMetadataRail from "@/components/ProjectMetadataRail";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ history?: string }>;
}

const DEFAULT_TIMELINE_LIMIT = 20;
const EXPANDED_TIMELINE_LIMIT = 1000;

export default async function ProjectDetailPage({
  params,
  searchParams,
}: Props) {
  const { slug } = await params;
  const { history } = await searchParams;
  const expanded = history === "all";

  const project = await getProjectBySlug(slug);
  if (!project) {
    return (
      <div className="space-y-6 max-w-6xl">
        <div
          className="card text-center py-12 animate-in"
          style={{ fontFamily: "'IBM Plex Mono', monospace" }}
        >
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            &gt; NO PROJECT :: {slug}
          </p>
          <Link
            href="/projects"
            className="text-xs inline-block mt-4"
            style={{ color: "var(--text-muted)" }}
          >
            &larr; back to projects
          </Link>
        </div>
      </div>
    );
  }

  const limit = expanded
    ? EXPANDED_TIMELINE_LIMIT
    : DEFAULT_TIMELINE_LIMIT + 1;

  const [timelineRows, openActions, vision] = await Promise.all([
    listProjectTimeline(slug, limit),
    listProjectOpenActions(slug),
    getProjectVision(slug),
  ]);
  const hasMoreCaptures = !expanded && timelineRows.length > DEFAULT_TIMELINE_LIMIT;
  const captures = expanded
    ? timelineRows
    : timelineRows.slice(0, DEFAULT_TIMELINE_LIMIT);
  // The canonical RPC is row-only, so the detail page avoids displaying an
  // invented exact count. Collapsed mode fetches one extra row to detect more.
  const total = captures.length;

  const color = statusColor(project.status);

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Breadcrumb */}
      <div
        className="animate-in"
        style={{ fontFamily: "'IBM Plex Mono', monospace" }}
      >
        <div
          className="flex items-center gap-2 text-xs"
          style={{ color: "var(--text-muted)" }}
        >
          <Link
            href="/projects"
            style={{ color: "var(--text-muted)" }}
            className="hover:underline"
          >
            PROJECTS
          </Link>
          <span>/</span>
          <span style={{ color: "var(--text-primary)" }}>{slug}</span>
        </div>
      </div>

      {/* Header */}
      <div className="animate-in stagger-1">
        <div className="flex items-center gap-3 mb-2 flex-wrap">
          <span
            className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded"
            style={{
              background: "var(--accent-dim)",
              color: "var(--text-secondary)",
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            {project.type}
          </span>
          <span
            className="text-[10px] uppercase tracking-wider"
            style={{
              color,
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            [{project.status}]
          </span>
        </div>
        <h1
          className="font-terminal text-3xl text-glow"
          style={{ color: "var(--text-primary)" }}
        >
          {project.display_name}
        </h1>
      </div>

      {/* Vision (collapsed by default) */}
      {vision && (
        <details
          className="card animate-in stagger-2"
          style={{ fontFamily: "'IBM Plex Mono', monospace" }}
        >
          <summary
            className="font-terminal text-sm uppercase tracking-wider cursor-pointer"
            style={{ color: "var(--text-secondary)" }}
          >
            <span style={{ color: "var(--text-muted)" }}>&gt; </span>
            VISION
          </summary>
          <p
            className="text-sm whitespace-pre-wrap mt-3"
            style={{ color: "var(--text-body)" }}
          >
            {vision}
          </p>
        </details>
      )}

      {/* Two-column 70/30 layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6 animate-in stagger-3">
        <div className="card">
          <ProjectTimeline
            captures={captures}
            total={total}
            slug={slug}
            expanded={expanded}
            hasMore={hasMoreCaptures}
          />
        </div>
        <div>
          <ProjectMetadataRail project={project} openActions={openActions} />
        </div>
      </div>
    </div>
  );
}
