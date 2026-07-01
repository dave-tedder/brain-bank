import type { AgentTaskStatus } from "./agent-tasks";

export interface ReviewTaskLinkState {
  status: AgentTaskStatus;
  linked_action_item_id: string | null;
}

export interface GenericStatusMoveState {
  currentStatus: AgentTaskStatus;
  targetStatus: AgentTaskStatus;
  approvalNeeded?: boolean;
}

export interface ApplyReviewRpcArgs {
  p_task_id: string;
  p_applied_by: string;
  p_resolution: "accepted" | "accepted_with_follow_up";
  p_note: string | null;
  p_resolve_linked_action_item: boolean;
  p_child_task_ids: string[];
  p_closeout_evidence: Record<string, string>;
}

export interface FollowUpDraftInsert {
  title: string;
  label: "agent-instructions";
  agent_code: string | null;
  parent_task_id: string;
  project_slug: string | null;
  status: "Standing";
  priority: "medium";
  risk: "low";
  requested_by: string;
  intake_source: "agent-follow-up";
  desired_outcome: string;
  context: string;
  sources: Array<{
    kind: "agent_task";
    id: string;
    relationship: "parent";
  }>;
  do_steps: string;
  acceptance_criteria: string;
  output_handoff: string;
  boundaries: string;
  explicit_approval: false;
}

export function shouldShowReviewApplyControls(
  status: AgentTaskStatus
): boolean;

export function shouldShowLinkedActionResolutionControl(
  task: ReviewTaskLinkState
): boolean;

export function isGenericStatusMoveDisabled(
  state: GenericStatusMoveState
): boolean;

export function buildApplyReviewRpcArgs(
  formData: FormData
): ApplyReviewRpcArgs;

export function buildFollowUpDraftInsert(
  formData: FormData
): FollowUpDraftInsert;
