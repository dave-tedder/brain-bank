import Link from "next/link";
import {
  AGENT_TASK_STATUS_FILTERS,
  type AgentRuntime,
} from "@/lib/agent-tasks";
import { buildTasksUrl } from "@/lib/tasks-index-controls";

interface Props {
  selectedStatuses: string[];
  selectedAgents: string[];
  runtimes: AgentRuntime[];
  risk: "all" | "low" | "medium" | "high";
  sort: "updated" | "oldest";
}

export default function AgentTaskFilters({
  selectedStatuses,
  selectedAgents,
  runtimes,
  risk,
  sort,
}: Props) {
  function toggle(list: string[], token: string): string[] {
    return list.includes(token)
      ? list.filter((t) => t !== token)
      : [...list, token];
  }

  const noFilters =
    selectedStatuses.length === 0 &&
    selectedAgents.length === 0 &&
    risk === "all";

  return (
    <div className="animate-in stagger-1 card">
      <div className="flex gap-2 flex-wrap items-center">
        <Pill
          href={buildTasksUrl({ sort })}
          active={noFilters}
          label="ALL"
        />
        <span className="w-px h-4 bg-[var(--border)] mx-1" aria-hidden="true" />
        {AGENT_TASK_STATUS_FILTERS.map(({ token, label }) => (
          <Pill
            key={token}
            href={buildTasksUrl({
              statuses: toggle(selectedStatuses, token),
              agents: selectedAgents,
              risk,
              sort,
            })}
            active={selectedStatuses.includes(token)}
            label={label}
          />
        ))}
        <span className="mx-1 text-[var(--text-muted)]" aria-hidden="true">
          ·
        </span>
        {runtimes.map((runtime) => (
          <Pill
            key={runtime.agent_code}
            href={buildTasksUrl({
              statuses: selectedStatuses,
              agents: toggle(selectedAgents, runtime.agent_code),
              risk,
              sort,
            })}
            active={selectedAgents.includes(runtime.agent_code)}
            label={runtime.agent_code}
          />
        ))}
        <span className="mx-1 text-[var(--text-muted)]" aria-hidden="true">
          ·
        </span>
        {(["low", "medium", "high"] as const).map((nextRisk) => (
          <Pill
            key={nextRisk}
            href={buildTasksUrl({
              statuses: selectedStatuses,
              agents: selectedAgents,
              risk: risk === nextRisk ? "all" : nextRisk,
              sort,
            })}
            active={risk === nextRisk}
            label={`risk ${nextRisk}`}
          />
        ))}
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
