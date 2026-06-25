import Link from "next/link";
import {
  listProjects,
  PROJECT_TYPE_FILTERS,
  PROJECT_STATUS_FILTERS,
} from "@/lib/projects";
import ProjectFilters from "@/components/ProjectFilters";
import ProjectRow from "@/components/ProjectRow";
import ProjectCard from "@/components/ProjectCard";
import {
  buildProjectsUrl,
  normalizeProjectsIndexParams,
} from "@/lib/projects-index-controls";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{
    type?: string;
    status?: string;
    view?: string;
    sort?: string;
    offset?: string;
    include?: string;
  }>;
}

const PAGE_SIZE = 50;

const TYPE_TOKENS = PROJECT_TYPE_FILTERS.map((f) => f.token);
const STATUS_TOKENS = PROJECT_STATUS_FILTERS.map((f) => f.token);

export default async function ProjectsIndexPage({ searchParams }: Props) {
  const params = await searchParams;
  const {
    selectedTypes,
    selectedStatuses,
    view,
    sort,
    offset,
    includeArchived,
  } = normalizeProjectsIndexParams(params, TYPE_TOKENS, STATUS_TOKENS);
  const projectSort = sort === "name" ? "name" : "updated";

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
      sort: projectSort,
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
            {view.toUpperCase()} :: PROJECTS
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

        <div className="flex flex-col items-end gap-2">
          {/* LOG / GRID toggle */}
          <div
            className="flex items-center gap-1 text-xs font-terminal uppercase tracking-wider"
            style={{ color: "var(--text-muted)" }}
          >
            {(["grid", "log"] as const).map((v, i) => {
              const active = view === v;
              return (
                <span key={v} className="flex items-center gap-1">
                  {i > 0 && <span aria-hidden="true">/</span>}
                  <Link
                    href={buildProjectsUrl({
                      types: selectedTypes,
                      statuses: selectedStatuses,
                      view: v,
                      sort: projectSort,
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

          {/* Sort toggle */}
          <div
            className="flex items-center gap-1 text-xs font-terminal uppercase tracking-wider"
            style={{ color: "var(--text-muted)" }}
          >
            <span>sort</span>
            {(["updated", "name"] as const).map((nextSort, i) => {
              const active = sort === nextSort;
              return (
                <span key={nextSort} className="flex items-center gap-1">
                  {i > 0 && <span aria-hidden="true">/</span>}
                  <Link
                    href={buildProjectsUrl({
                      types: selectedTypes,
                      statuses: selectedStatuses,
                      view,
                      sort: nextSort,
                      includeArchived,
                    })}
                    style={{
                      color: active
                        ? "var(--text-primary)"
                        : "var(--text-muted)",
                    }}
                  >
                    [{nextSort === "name" ? "name a-z" : "updated"}]
                  </Link>
                </span>
              );
            })}
          </div>
        </div>
      </div>

      <ProjectFilters
        selectedTypes={selectedTypes}
        selectedStatuses={selectedStatuses}
        view={view}
        sort={projectSort}
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
            href={buildProjectsUrl({
              types: selectedTypes,
              statuses: selectedStatuses,
              view,
              sort: projectSort,
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
            href={buildProjectsUrl({
              types: selectedTypes,
              statuses: selectedStatuses,
              view,
              sort: projectSort,
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
