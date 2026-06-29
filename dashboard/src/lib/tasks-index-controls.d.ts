export interface TasksIndexParams {
  status?: string;
  agent?: string;
  risk?: string;
  sort?: string;
  offset?: string;
}

export interface TasksIndexState {
  selectedStatuses: string[];
  selectedAgents: string[];
  risk: "all" | "low" | "medium" | "high";
  sort: "updated" | "oldest";
  offset: number;
}

export interface BuildTasksUrlOpts {
  statuses?: string[];
  agents?: string[];
  risk?: "all" | "low" | "medium" | "high";
  sort?: "updated" | "oldest";
  offset?: number;
}

export function normalizeTasksIndexParams(
  params: TasksIndexParams,
  statusTokens: string[],
  agentTokens: string[]
): TasksIndexState;

export function buildTasksUrl(opts: BuildTasksUrlOpts): string;
