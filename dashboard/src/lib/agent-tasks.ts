import { supabase } from "@/lib/supabase";

export const AGENT_TASK_STATUSES = [
  "Standing",
  "Agent Todo",
  "Agent Working",
  "Agent Needs Input",
  "Agent Review",
  "Agent Done",
] as const;

export type AgentTaskStatus = (typeof AGENT_TASK_STATUSES)[number];
export type AgentTaskRisk = "low" | "medium" | "high";
export type AgentTaskPriority = "low" | "medium" | "high";

export const AGENT_TASK_STATUS_FILTERS: {
  token: string;
  value: AgentTaskStatus;
  label: string;
}[] = [
  { token: "standing", value: "Standing", label: "STANDING" },
  { token: "todo", value: "Agent Todo", label: "TODO" },
  { token: "working", value: "Agent Working", label: "WORKING" },
  { token: "input", value: "Agent Needs Input", label: "NEEDS INPUT" },
  { token: "review", value: "Agent Review", label: "REVIEW" },
  { token: "done", value: "Agent Done", label: "DONE" },
];

export interface AgentRuntime {
  agent_code: string;
  operator: string | null;
  runtime: string | null;
  automation_state: string;
}

export interface AgentTask {
  id: string;
  created_at: string;
  updated_at: string;
  title: string;
  label: string;
  agent_code: string | null;
  parent_task_id: string | null;
  project_slug: string | null;
  status: AgentTaskStatus;
  priority: AgentTaskPriority;
  risk: AgentTaskRisk;
  requested_by: string | null;
  intake_source: string | null;
  desired_outcome: string;
  context: string | null;
  sources: unknown[];
  do_steps: string | null;
  acceptance_criteria: string | null;
  output_handoff: string | null;
  boundaries: string | null;
  explicit_approval: boolean;
  claimed_at: string | null;
  claimed_by: string | null;
  claim_expires_at: string | null;
  completed_at: string | null;
  blocked_reason: string | null;
  review_reason: string | null;
  attempt_count: number;
  last_failed_at: string | null;
  last_failure_reason: string | null;
  source_thought_id: string | null;
  linked_action_item_id: string | null;
}

export interface AgentTaskCounts {
  status: AgentTaskStatus;
  count: number;
}

const TASK_COLS =
  "id, created_at, updated_at, title, label, agent_code, parent_task_id, project_slug, status, priority, risk, requested_by, intake_source, desired_outcome, context, sources, do_steps, acceptance_criteria, output_handoff, boundaries, explicit_approval, claimed_at, claimed_by, claim_expires_at, completed_at, blocked_reason, review_reason, attempt_count, last_failed_at, last_failure_reason, source_thought_id, linked_action_item_id";

export async function listAgentRuntimes(): Promise<AgentRuntime[]> {
  const { data, error } = await supabase()
    .from("agent_task_ledger")
    .select("agent_code, operator, runtime, automation_state")
    .order("agent_code", { ascending: true });

  if (error) throw error;
  return (data as AgentRuntime[] | null) ?? [];
}

export async function listAgentTasks(opts: {
  statuses?: AgentTaskStatus[];
  agentCodes?: string[];
  risk?: AgentTaskRisk;
  sort?: "updated" | "oldest";
  limit?: number;
  offset?: number;
} = {}): Promise<AgentTask[]> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  let query = supabase()
    .from("agent_tasks")
    .select(TASK_COLS)
    .range(offset, offset + limit - 1);

  if (opts.statuses && opts.statuses.length > 0) {
    query = query.in("status", opts.statuses);
  }
  if (opts.agentCodes && opts.agentCodes.length > 0) {
    query = query.in("agent_code", opts.agentCodes);
  }
  if (opts.risk) {
    query = query.eq("risk", opts.risk);
  }

  query =
    opts.sort === "oldest"
      ? query.order("created_at", { ascending: true })
      : query.order("updated_at", { ascending: false });

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw error;
  return (data as AgentTask[] | null) ?? [];
}

export async function getAgentTaskCounts(): Promise<AgentTaskCounts[]> {
  const { data, error } = await supabase()
    .from("agent_tasks")
    .select("status");

  if (error) throw error;

  const counts = new Map<AgentTaskStatus, number>();
  for (const status of AGENT_TASK_STATUSES) counts.set(status, 0);
  for (const row of (data as { status: AgentTaskStatus }[] | null) ?? []) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }

  return AGENT_TASK_STATUSES.map((status) => ({
    status,
    count: counts.get(status) ?? 0,
  }));
}

export function formatTaskAge(iso: string | null): string {
  if (!iso) return "-";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "now";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function taskStatusColor(status: AgentTaskStatus): string {
  switch (status) {
    case "Standing":
      return "var(--status-paused)";
    case "Agent Todo":
      return "var(--warning)";
    case "Agent Working":
      return "var(--status-active)";
    case "Agent Needs Input":
      return "var(--status-blocker)";
    case "Agent Review":
      return "var(--phosphor-glow)";
    case "Agent Done":
      return "var(--status-done)";
    default:
      return "var(--text-muted)";
  }
}
