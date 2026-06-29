import Link from "next/link";
import AgentTaskCard from "@/components/AgentTaskCard";
import AgentTaskFilters from "@/components/AgentTaskFilters";
import AgentTaskForm from "@/components/AgentTaskForm";
import {
  AGENT_TASK_STATUS_FILTERS,
  getAgentTaskCounts,
  listAgentRuntimes,
  listAgentTasks,
  type AgentTaskRisk,
} from "@/lib/agent-tasks";
import {
  buildTasksUrl,
  normalizeTasksIndexParams,
} from "@/lib/tasks-index-controls";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{
    status?: string;
    agent?: string;
    risk?: string;
    sort?: string;
    offset?: string;
  }>;
}

const PAGE_SIZE = 50;
const STATUS_TOKENS = AGENT_TASK_STATUS_FILTERS.map((filter) => filter.token);

export default async function TasksPage({ searchParams }: Props) {
  const params = await searchParams;

  let runtimes: Awaited<ReturnType<typeof listAgentRuntimes>> = [];
  let counts: Awaited<ReturnType<typeof getAgentTaskCounts>> = [];
  let tasks: Awaited<ReturnType<typeof listAgentTasks>> = [];
  let loadError = false;

  try {
    runtimes = await listAgentRuntimes();
    const agentTokens = runtimes.map((runtime) => runtime.agent_code);
    const state = normalizeTasksIndexParams(params, STATUS_TOKENS, agentTokens);
    const statusValues = AGENT_TASK_STATUS_FILTERS.filter((filter) =>
      state.selectedStatuses.includes(filter.token)
    ).map((filter) => filter.value);
    const risk = state.risk === "all" ? undefined : (state.risk as AgentTaskRisk);

    [counts, tasks] = await Promise.all([
      getAgentTaskCounts(),
      listAgentTasks({
        statuses: statusValues,
        agentCodes: state.selectedAgents,
        risk,
        sort: state.sort,
        limit: PAGE_SIZE,
        offset: state.offset,
      }),
    ]);

    const hasMore = tasks.length === PAGE_SIZE;
    const nextOffset = state.offset + PAGE_SIZE;
    const currentPath = buildTasksUrl({
      statuses: state.selectedStatuses,
      agents: state.selectedAgents,
      risk: state.risk,
      sort: state.sort,
      offset: state.offset,
    });

    return (
      <div className="space-y-6">
        <Header
          count={tasks.length}
          offset={state.offset}
          sort={state.sort}
          selectedStatuses={state.selectedStatuses}
          selectedAgents={state.selectedAgents}
          risk={state.risk}
          counts={counts}
        />

        <AgentTaskFilters
          selectedStatuses={state.selectedStatuses}
          selectedAgents={state.selectedAgents}
          runtimes={runtimes}
          risk={state.risk}
          sort={state.sort}
        />

        <AgentTaskForm runtimes={runtimes} />

        {tasks.length === 0 ? (
          <div className="card text-center py-12 animate-in stagger-3">
            <p className="text-sm font-mono text-[var(--text-muted)]">
              &gt; NO TASKS MATCH :: CREATE A TASK PACKET
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4">
            {tasks.map((task, i) => (
              <AgentTaskCard
                key={task.id}
                task={task}
                runtimes={runtimes}
                currentPath={currentPath}
                stagger={i + 3}
              />
            ))}
          </div>
        )}

        {hasMore && (
          <Link
            href={buildTasksUrl({
              statuses: state.selectedStatuses,
              agents: state.selectedAgents,
              risk: state.risk,
              sort: state.sort,
              offset: nextOffset,
            })}
            className="font-terminal text-xs inline-block py-2 uppercase tracking-wider text-[var(--text-muted)]"
          >
            &gt; LOAD EARLIER TASKS_
          </Link>
        )}
      </div>
    );
  } catch (err) {
    console.error("tasks board load failed:", err);
    loadError = true;
  }

  return (
    <div className="space-y-6">
      <Header
        count={0}
        offset={0}
        sort="updated"
        selectedStatuses={[]}
        selectedAgents={[]}
        risk="all"
        counts={[]}
      />
      <div
        className="card text-center py-12 animate-in stagger-2"
        style={{ borderLeftColor: "rgba(239, 68, 68, 0.4)" }}
      >
        <p className="text-sm font-mono text-[var(--danger)]">
          &gt; TASK BOARD FETCH FAILED :: CHECK SUPABASE LOGS
        </p>
        {loadError && (
          <p className="mt-2 text-xs font-mono text-[var(--text-muted)]">
            agent_tasks schema or dashboard env may be missing
          </p>
        )}
      </div>
    </div>
  );
}

function Header({
  count,
  offset,
  sort,
  selectedStatuses,
  selectedAgents,
  risk,
  counts,
}: {
  count: number;
  offset: number;
  sort: "updated" | "oldest";
  selectedStatuses: string[];
  selectedAgents: string[];
  risk: "all" | "low" | "medium" | "high";
  counts: { status: string; count: number }[];
}) {
  const filtered =
    selectedStatuses.length > 0 || selectedAgents.length > 0 || risk !== "all";

  return (
    <div className="animate-in flex items-start justify-between gap-4 flex-wrap">
      <div>
        <h1 className="font-terminal text-3xl text-[var(--text-primary)] text-glow">
          <span className="text-[var(--text-muted)]">&gt; </span>
          TASKS :: OPEN ENGINE
        </h1>
        <p className="text-sm mt-1 font-mono text-[var(--text-muted)]">
          {count} task{count === 1 ? "" : "s"}{offset > 0 ? ` (offset ${offset})` : ""}{filtered ? " · filtered" : ""}
        </p>
      </div>

      <div className="flex flex-col items-end gap-2">
        <div className="flex items-center gap-1 text-xs font-terminal uppercase tracking-wider text-[var(--text-muted)]">
          <span>sort</span>
          {(["updated", "oldest"] as const).map((nextSort, i) => (
            <span key={nextSort} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden="true">/</span>}
              <Link
                href={buildTasksUrl({
                  statuses: selectedStatuses,
                  agents: selectedAgents,
                  risk,
                  sort: nextSort,
                })}
                className={sort === nextSort ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}
              >
                [{nextSort}]
              </Link>
            </span>
          ))}
        </div>

        <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
          {counts.map((row) => `${row.status}: ${row.count}`).join(" · ")}
        </div>
      </div>
    </div>
  );
}
