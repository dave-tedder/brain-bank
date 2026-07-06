export const AGENT_TASK_STATUSES = [
  "Standing",
  "Agent Todo",
  "Agent Working",
  "Agent Needs Input",
  "Agent Review",
  "Agent Done",
] as const;

export const AGENT_TASK_RECEIPTS = [
  "AGENT CLAIMED",
  "AGENT DONE",
  "AGENT BLOCKED",
  "AGENT UNBLOCKED",
  "AGENT HUMAN HOLD",
  "AGENT HUMAN ANSWERED",
  "AGENT RESUMED",
  "AGENT FAILED",
  "AGENT APPLIED",
  "AGENT SKILL SUBSCRIBED",
  "AGENT SKILL INSTALLED",
  "AGENT SKILL UPDATED",
  "AGENT SKILL DECLINED",
  "AGENT FOLLOW-UP",
  "AGENT STATUS",
] as const;

export const AGENT_LEDGER_AUTOMATION_STATES = [
  "installed",
  "manual-required",
  "blocked",
  "paused",
] as const;

export type AgentTaskStatus = (typeof AGENT_TASK_STATUSES)[number];
export type AgentTaskReceipt = (typeof AGENT_TASK_RECEIPTS)[number];
export type AgentLedgerAutomationState =
  (typeof AGENT_LEDGER_AUTOMATION_STATES)[number];
export type AgentTaskRisk = "low" | "medium" | "high";
export type AgentTaskReviewResolution =
  | "accepted"
  | "accepted_with_follow_up";
export type AgentTaskToolAction =
  | "update"
  | "complete"
  | "block"
  | "request-review"
  | "resume"
  | "unblock"
  | "answer";
export type AgentTaskResumeAction = "resume" | "unblock" | "answer";

export interface AgentTaskAccessRow {
  agent_code: string | null;
  claimed_by: string | null;
  risk: AgentTaskRisk;
  explicit_approval: boolean;
  status: AgentTaskStatus;
}

export function isAgentTaskStatus(value: string): value is AgentTaskStatus {
  return (AGENT_TASK_STATUSES as readonly string[]).includes(value);
}

export function isLedgerAutomationState(
  value: string,
): value is AgentLedgerAutomationState {
  return (AGENT_LEDGER_AUTOMATION_STATES as readonly string[]).includes(value);
}

export function isAgentTaskRisk(value: string): value is AgentTaskRisk {
  return value === "low" || value === "medium" || value === "high";
}

export function isReviewResolution(
  value: string,
): value is AgentTaskReviewResolution {
  return value === "accepted" || value === "accepted_with_follow_up";
}

export function canAgentWriteTask(
  task: AgentTaskAccessRow,
  agentCode: string,
): boolean {
  return task.claimed_by === agentCode || task.agent_code === agentCode;
}

export function assertAgentCanWriteTask(
  task: AgentTaskAccessRow,
  agentCode: string,
): void {
  if (!canAgentWriteTask(task, agentCode)) {
    throw new Error(
      "Agent can only update tasks it has claimed or tasks assigned to its agent_code.",
    );
  }
}

export function assertClaimAllowed(task: AgentTaskAccessRow): void {
  if (task.risk === "high" && task.explicit_approval !== true) {
    throw new Error("High-risk task requires explicit approval before claim.");
  }
}

export function assertStatusHeartbeatAllowed(task: AgentTaskAccessRow): void {
  if (task.status !== "Agent Working") {
    throw new Error(
      "AGENT STATUS heartbeat is only allowed while the task is Agent Working.",
    );
  }
}

export function assertIntakePromotionAllowed(task: AgentTaskAccessRow): void {
  if (task.status !== "Standing") {
    throw new Error(
      "Only Standing intake drafts can be promoted to Agent Todo.",
    );
  }
}

export function assertReviewApplyAllowed(task: AgentTaskAccessRow): void {
  if (task.status !== "Agent Review") {
    throw new Error("AGENT APPLIED requires Agent Review.");
  }
}

export function assertResumeTransitionAllowed(
  task: AgentTaskAccessRow,
  action: AgentTaskResumeAction,
): void {
  if (action === "resume") {
    if (task.status !== "Agent Needs Input" && task.status !== "Agent Review") {
      throw new Error(
        "AGENT RESUMED requires Agent Needs Input or Agent Review.",
      );
    }
    return;
  }

  if (task.status !== "Agent Needs Input") {
    const receipt = action === "unblock"
      ? "AGENT UNBLOCKED"
      : "AGENT HUMAN ANSWERED";
    throw new Error(`${receipt} requires Agent Needs Input.`);
  }
}

export function receiptForTaskTool(
  action: AgentTaskToolAction,
): { status: AgentTaskStatus; receipt: AgentTaskReceipt } {
  switch (action) {
    case "update":
      return { status: "Agent Working", receipt: "AGENT STATUS" };
    case "complete":
    case "request-review":
      return { status: "Agent Review", receipt: "AGENT DONE" };
    case "block":
      return { status: "Agent Needs Input", receipt: "AGENT BLOCKED" };
    case "resume":
      return { status: "Agent Working", receipt: "AGENT RESUMED" };
    case "unblock":
      return { status: "Agent Working", receipt: "AGENT UNBLOCKED" };
    case "answer":
      return { status: "Agent Working", receipt: "AGENT HUMAN ANSWERED" };
  }
}

export function compactObject<T extends Record<string, unknown>>(value: T): T {
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined && entry !== null && entry !== "") {
      copy[key] = entry;
    }
  }
  return copy as T;
}
