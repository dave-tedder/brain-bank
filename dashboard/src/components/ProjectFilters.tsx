import Link from "next/link";
import {
  PROJECT_TYPE_FILTERS,
  PROJECT_STATUS_FILTERS,
} from "@/lib/projects";

interface Props {
  selectedTypes: string[];
  selectedStatuses: string[];
  view: string;
  includeArchived: boolean;
}

/**
 * Pill row for /projects. Multi-select: each pill is a <Link> whose href is
 * the current URL with that pill's token toggled in a comma-separated param
 * (?type=llm,client&status=active,stale). No onClick — safe in a server
 * component. Changing a filter drops ?offset so paging resets to the top.
 * The [+ closed] pill toggles ?include=archived, which reveals the otherwise-
 * hidden done/archive projects.
 */
export default function ProjectFilters({
  selectedTypes,
  selectedStatuses,
  view,
  includeArchived,
}: Props) {
  function buildHref(
    types: string[],
    statuses: string[],
    archived: boolean
  ): string {
    const parts: string[] = [];
    if (types.length > 0) parts.push(`type=${types.join(",")}`);
    if (statuses.length > 0) parts.push(`status=${statuses.join(",")}`);
    if (view === "grid") parts.push("view=grid");
    if (archived) parts.push("include=archived");
    return `/projects${parts.length > 0 ? `?${parts.join("&")}` : ""}`;
  }

  function toggle(list: string[], token: string): string[] {
    return list.includes(token)
      ? list.filter((t) => t !== token)
      : [...list, token];
  }

  const noFilters =
    selectedTypes.length === 0 && selectedStatuses.length === 0;

  return (
    <div className="animate-in stagger-1 card">
      <div className="flex gap-2 flex-wrap items-center">
        <Pill
          href={buildHref([], [], includeArchived)}
          active={noFilters}
          label="ALL"
        />

        <span className="w-px h-4 bg-[var(--border)] mx-1" aria-hidden="true" />

        {PROJECT_TYPE_FILTERS.map(({ token, label }) => {
          const active = selectedTypes.includes(token);
          return (
            <Pill
              key={token}
              href={buildHref(
                toggle(selectedTypes, token),
                selectedStatuses,
                includeArchived
              )}
              active={active}
              label={label}
            />
          );
        })}

        <span
          className="mx-1 text-[var(--text-muted)] select-none"
          aria-hidden="true"
        >
          ·
        </span>

        {PROJECT_STATUS_FILTERS.map(({ token, label }) => {
          const active = selectedStatuses.includes(token);
          return (
            <Pill
              key={token}
              href={buildHref(
                selectedTypes,
                toggle(selectedStatuses, token),
                includeArchived
              )}
              active={active}
              label={label}
            />
          );
        })}

        <span
          className="mx-1 text-[var(--text-muted)] select-none"
          aria-hidden="true"
        >
          ·
        </span>

        <Pill
          href={buildHref(selectedTypes, selectedStatuses, !includeArchived)}
          active={includeArchived}
          label="+ closed"
        />
      </div>
    </div>
  );
}

function Pill({
  href,
  active,
  label,
}: {
  href: string;
  active: boolean;
  label: string;
}) {
  return (
    <Link
      href={href}
      className={`px-3 py-1 rounded text-xs font-terminal uppercase tracking-wider transition-all duration-200 ${
        active
          ? "bg-[var(--accent-dim)] text-[var(--text-primary)] border border-[var(--accent)] border-glow"
          : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] border border-transparent hover:border-[var(--border)]"
      }`}
    >
      [{label}]
    </Link>
  );
}
