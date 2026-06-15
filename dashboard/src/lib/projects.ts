import { supabase } from "@/lib/supabase";

// Server-only data access for the /projects route. Reads the projects_rollup
// Postgres view (see Open Brain migration 20260518_create_projects_table_and_rollup.sql)
// plus the thoughts and action_items tables for the detail page.

export type ProjectStatusDerived = "ACTIVE" | "STALE" | "BLOCKER" | "DORMANT";

// The unified status the view exposes: the computed activity status, OR a
// terminal operator lifecycle state (projects.status done/paused/archive)
// when one is set. The dashboard renders and sorts on this, not status_derived.
export type ProjectStatus =
  | ProjectStatusDerived
  | "DONE"
  | "PAUSED"
  | "ARCHIVE";

export type ProjectType =
  | "llm-build"
  | "client"
  | "ops"
  | "content"
  | "idea"
  | "uncategorized";

export interface ProjectRollup {
  slug: string;
  display_name: string;
  type: ProjectType;
  status_derived: ProjectStatusDerived;
  status_explicit: string;
  status: ProjectStatus;
  status_rank: number;
  last_activity_at: string;
  captures: number;
  captures_7d: number;
  next_step: string | null;
  blocker_text: string | null;
  blocked_at: string | null;
  pinned: boolean | null;
  roi_band: string | null;
  working_dirs: string[] | null;
  sources: string[] | null;
}

export interface ProjectCapture {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ProjectAction {
  id: string;
  description: string;
  created_at: string;
}

// Filter pills. The URL carries short tokens (?type=llm,client); the rollup's
// `type` column carries the real values, so "llm" maps to "llm-build".
export const PROJECT_TYPE_FILTERS: {
  token: string;
  value: ProjectType;
  label: string;
}[] = [
  { token: "llm", value: "llm-build", label: "LLM" },
  { token: "client", value: "client", label: "CLIENT" },
  { token: "ops", value: "ops", label: "OPS" },
  { token: "content", value: "content", label: "CONTENT" },
  { token: "idea", value: "idea", label: "IDEA" },
];

export const PROJECT_STATUS_FILTERS: {
  token: string;
  value: ProjectStatusDerived;
  label: string;
}[] = [
  { token: "active", value: "ACTIVE", label: "ACTIVE" },
  { token: "stale", value: "STALE", label: "STALE" },
  { token: "blocker", value: "BLOCKER", label: "BLOCKER" },
  { token: "dormant", value: "DORMANT", label: "DORMANT" },
];

// Single string literal (not concatenated) so supabase-js can parse the
// column list at the type level — same convention as lib/digest.ts.
const ROLLUP_COLS =
  "slug, display_name, type, status_derived, status_explicit, status, status_rank, last_activity_at, captures, captures_7d, next_step, blocker_text, blocked_at, pinned, roi_band, working_dirs, sources";

interface ListProjectsOpts {
  type?: string[];
  status?: string[];
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export async function listProjects(
  opts: ListProjectsOpts = {}
): Promise<ProjectRollup[]> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  let query = supabase()
    .from("projects_rollup")
    .select(ROLLUP_COLS)
    .order("status_rank", { ascending: true })
    .order("last_activity_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (opts.type && opts.type.length > 0) {
    query = query.in("type", opts.type);
  }
  if (opts.status && opts.status.length > 0) {
    query = query.in("status", opts.status);
  }
  if (!opts.includeArchived) {
    query = query.not("status_explicit", "in", "(done,archive)");
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data as ProjectRollup[] | null) ?? [];
}

export async function getProjectBySlug(
  slug: string
): Promise<ProjectRollup | null> {
  const { data } = await supabase()
    .from("projects_rollup")
    .select(ROLLUP_COLS)
    .eq("slug", slug)
    .maybeSingle();

  return (data as ProjectRollup | null) ?? null;
}

export async function listProjectTimeline(
  slug: string,
  limit = 20
): Promise<ProjectCapture[]> {
  const { data, error } = await supabase().rpc("get_project_page_thoughts", {
    p_slug: slug,
    p_since: "epoch",
    p_limit: limit,
    p_ascending: false,
  });

  if (error) throw error;
  return (data as ProjectCapture[] | null) ?? [];
}

export async function listProjectOpenActions(
  slug: string,
  limit = 8
): Promise<ProjectAction[]> {
  // Bounded server-side join (get_project_open_actions RPC) replaces the old
  // unbounded two-query fetch (all thought IDs for the slug, then a large
  // IN(...) against action_items). Slug normalization inside the RPC matches
  // the projects_rollup view's thought_facts CTE.
  const { data, error } = await supabase().rpc("get_project_open_actions", {
    p_slug: slug,
    p_limit: limit,
  });

  if (error) throw error;
  return (data as ProjectAction[] | null) ?? [];
}

// vision_md lives on the projects table, not the projects_rollup view, so
// the detail page fetches it separately. Returns null for implicit projects
// (topics with no explicit projects row).
export async function getProjectVision(slug: string): Promise<string | null> {
  const { data } = await supabase()
    .from("projects")
    .select("vision_md")
    .eq("slug", slug)
    .maybeSingle();

  return (data as { vision_md: string | null } | null)?.vision_md ?? null;
}

// Compact age label for index rows: "2h", "3d", "42d".
export function formatAge(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "now";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
