export interface ProjectsIndexParams {
  type?: string;
  status?: string;
  view?: string;
  sort?: string;
  offset?: string;
  include?: string;
}

export interface ProjectsIndexState {
  selectedTypes: string[];
  selectedStatuses: string[];
  view: "grid" | "log";
  sort: "updated" | "name";
  offset: number;
  includeArchived: boolean;
}

export interface BuildProjectsUrlOpts {
  types?: string[];
  statuses?: string[];
  view?: "grid" | "log";
  sort?: "updated" | "name";
  offset?: number;
  includeArchived?: boolean;
}

export function normalizeProjectsIndexParams(
  params: ProjectsIndexParams,
  typeTokens: string[],
  statusTokens: string[]
): ProjectsIndexState;

export function buildProjectsUrl(opts: BuildProjectsUrlOpts): string;
