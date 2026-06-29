import type { AgentTaskPriority, AgentTaskRisk } from "./agent-tasks";

export interface IntakeDraftInsert {
  title: string;
  label: "agent-instructions";
  agent_code: string | null;
  project_slug: string | null;
  status: "Standing";
  priority: AgentTaskPriority;
  risk: AgentTaskRisk;
  requested_by: string | null;
  intake_source: string;
  desired_outcome: string;
  context: string | null;
  sources: unknown[];
  do_steps: string | null;
  acceptance_criteria: string | null;
  output_handoff: string | null;
  boundaries: string | null;
  explicit_approval: false;
}

export interface PromotionRpcArgs {
  p_task_id: string;
  p_promoted_by: string;
  p_note: string | null;
}

export function buildIntakeDraftInsert(formData: FormData): IntakeDraftInsert;
export function buildPromotionRpcArgs(formData: FormData): PromotionRpcArgs;
