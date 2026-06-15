import Link from "next/link";
import {
  listProjects,
  PROJECT_TYPE_FILTERS,
  PROJECT_STATUS_FILTERS,
} from "@/lib/projects";
import ProjectFilters from "@/components/ProjectFilters";
import ProjectRow from "@/components/ProjectRow";
import ProjectCard from "@/components/ProjectCard";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{
    type?: string;
    status?: string;
    view?: string;
    offset?: string;
    include?: string;
  }>;
}

const PAGE_SIZE = 50;

const TYPE_TOKENS = PROJECT_TYPE_FILTERS.map((f) => f.token);
const STATUS_TOKENS = PROJECT_STATUS_FILTERS.map((f) => f.token);
const CLOSED_STATUS_TOKENS = new Set(["done", "archive"]);

function parseTokens(raw: string | undefined, valid: string[]): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => valid.includes(t));
}

function parseOffset(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function hasClosedStatus(statuses: string[]): boolean {
  return statuses.some((status) => CLOSED_STATUS_TOKENS.has(status));
}

interface UrlOpts {
  types: string[];
  statuses: string[];
  view: string;
  offset?: number;
  includeArchived?: boolean;
}

function buildUrl(opts: UrlOpts): string {
  const parts: string[] = [];
  if (opts.types.length > 0) parts.push(`type=${opts.types.join(",")}`);
  if (opts.statuses.length > 0)
    parts.push(`status=${opts.statuses.join(",")}`);
  if (opts.view === "grid") parts.push("view=grid");
  if (opts.includeArchived) parts.push("include=archived");
  if (opts.offset && opts.offset > 0) parts.push(`offset=${opts.offset}`);
  return `/projects${parts.length > 0 ? `?${parts.join("&")}` : ""}`;
}

export default async function ProjectsIndexPage({ searchParams }: Props) {
  const params = await searchParams;
  const selectedTypes = parseTokens(params.type, TYPE_TOKENS);
  const selectedStatuses = parseTokens(params.status, STATUS_TOKENS);
  const view = params.view === "grid" ? "grid" : "log";
  const offset = parseOffset(params.offset);
  const includeArchived =
    params.include === "archived" || hasClosedStatus(selectedStatuses);

  const typeValues = PROJECT_TYPE_FILTERS.filter((f) =>
    selectedTypes.includes(f.token)
  ).map((f) => f.value);
  const statusValues = PROJECT_STATUS_FILTERS.filter((f) =>
    selectedStatuses.includes(f.token)
  ).map((f) => f.value);

  let projects: Awaited<ReturnType<typeof listProjects>> = [];
  let loadError = false;
  try {
    projects = await listProjects({
      type: typeValues,
      status: statusValues,
      includeArchived,
      limit: PAGE_SIZE,
      offset,
    });
  } catch (err) {
    console.error("projects index load failed:", err);
    loadError = true;
  }

  const hasMore = projects.length === PAGE_SIZE;
  const nextOffset = offset + PAGE_SIZE;
  const hasFilters =
    selectedTypes.length > 0 || selectedStatuses.length > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-in flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1
            className="font-terminal text-3xl text-glow"
            style={{ color: "var(--text-primary)" }}
          >
            <span style={{ color: "var(--text-muted)" }}>&gt; </span>
            LOG :: PROJECTS
          </h1>
          <p
            className="text-sm mt-1"
            style={{
              color: "var(--text-muted)",
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            {loadError
              ? "load error"
              : `${projects.length} project${projects.length === 1 ? "" : "s"}${offset > 0 ? ` (offset ${offset})` : ""}${hasFilters ? " · filtered" : ""}`}
          </p>
        </div>

        {/* LOG / GRID toggle */}
        <div
          className="flex items-center gap-1 text-xs font-terminal uppercase tracking-wider"
          style={{ color: "var(--text-muted)" }}
        >
          {(["log", "grid"] as const).map((v, i) => {
            const active = view === v;
            return (
              <span key={v} className="flex items-center gap-1">
                {i > 0 && <span aria-hidden="true">/</span>}
                <Link
                  href={buildUrl({
                    types: selectedTypes,
                    statuses: selectedStatuses,
                    view: v,
                    includeArchived,
                  })}
                  style={{
                    color: active
                      ? "var(--text-primary)"
                      : "var(--text-muted)",
                  }}
                >
                  [{v}]
                </Link>
              </span>
            );
          })}
        </div>
      </div>

      <ProjectFilters
        selectedTypes={selectedTypes}
        selectedStatuses={selectedStatuses}
        view={view}
        includeArchived={includeArchived}
      />

      {loadError ? (
        <div
          className="card text-center py-12 animate-in stagger-2"
          style={{ borderLeftColor: "rgba(239, 68, 68, 0.4)" }}
        >
          <p
            className="text-sm"
            style={{
              color: "var(--danger)",
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            &gt; PROJECTS ROLLUP FETCH FAILED :: CHECK SUPABASE LOGS
          </p>
        </div>
      ) : projects.length === 0 ? (
        <div className="card text-center py-12 animate-in stagger-2">
          <p
            className="text-sm"
            style={{
              color: "var(--text-muted)",
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            &gt;{" "}
            {hasFilters
              ? "NO PROJECTS MATCH :: CLEAR FILTERS"
              : "NO PROJECTS YET :: CAPTURE SOMETHING WITH A TOPIC"}
          </p>
        </div>
      ) : view === "grid" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 animate-in stagger-2">
          {projects.map((p, i) => (
            <ProjectCard key={p.slug} project={p} stagger={i + 2} />
          ))}
        </div>
      ) : (
        <div
          className="animate-in stagger-2"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          {projects.map((p, i) => (
            <ProjectRow key={p.slug} project={p} stagger={i + 2} />
          ))}
        </div>
      )}

      {hasMore && (
        <div className="animate-in">
          <Link
            href={buildUrl({
              types: selectedTypes,
              statuses: selectedStatuses,
              view,
              includeArchived,
              offset: nextOffset,
            })}
            className="font-terminal text-xs inline-block py-2 uppercase tracking-wider"
            style={{ color: "var(--text-muted)" }}
          >
            &gt; LOAD EARLIER ENTRIES_
          </Link>
        </div>
      )}

      {offset > 0 && (
        <div>
          <Link
            href={buildUrl({
              types: selectedTypes,
              statuses: selectedStatuses,
              view,
              includeArchived,
            })}
            className="text-xs"
            style={{
              color: "var(--text-muted)",
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            &larr; back to latest
          </Link>
        </div>
      )}
    </div>
  );
}
