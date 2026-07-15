export const AGENT_TASK_STATUSES = [
  "Standing",
  "Agent Todo",
  "Agent Working",
  "Agent Needs Input",
  "Agent Review",
  "Needs Operator",
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
  "AGENT NEEDS OPERATOR",
  "OPERATOR DONE",
  "AGENT CRITIC",
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
  | "answer"
  | "hold"
  | "fail";
export type AgentTaskResumeAction = "resume" | "unblock" | "answer";
export type AgentTaskWorkingExitAction = "hold" | "fail";

export interface AgentTaskAccessRow {
  agent_code: string | null;
  claimed_by: string | null;
  risk: AgentTaskRisk;
  explicit_approval: boolean;
  claim_token?: string | null;
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

// OE-15: run-side receipt actions that must present the current claim_token
// while the task carries one. Resume-family actions (resume/unblock/answer)
// are human-gated and mint a fresh token instead. This mirrors the SQL guard
// in move_agent_task_status — SQL is the enforcement source of truth; this
// pre-check exists for a clearer tool-level error message.
export const CLAIM_TOKEN_GUARDED_ACTIONS = [
  "update",
  "complete",
  "block",
  "request-review",
  "hold",
  "fail",
] as const;

export function assertClaimTokenMatches(
  task: AgentTaskAccessRow,
  presentedToken: string | null | undefined,
  action: AgentTaskToolAction,
): void {
  if (
    !(CLAIM_TOKEN_GUARDED_ACTIONS as readonly string[]).includes(action)
  ) return;
  if (!task.claim_token) return;
  if (!presentedToken || presentedToken !== task.claim_token) {
    throw new Error(
      "This task is held by a different run: pass the claim_token returned by the claim (or resume) call this run made. A run that does not hold the current claim cannot write receipts on it.",
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

// Promotion (Standing -> Agent Todo) is a human-only decision (OE-6). All MCP
// callers share one key, so identity is self-reported — this guard is the
// tool-layer chokepoint an autonomous runtime cannot pass while being honest:
// anonymous calls, registered agent codes, and runner self-identifications are
// refused; only a named human attribution goes through.
const RUNNER_CALLER_PATTERN =
  /^(queue[-_ ]?runner|scheduled([-_ ]runner)?|runner|automation|cron([-_ ]job)?|bot|agent)$/i;

export function assertPromotionCallerAllowed(
  promotedBy: string | null | undefined,
  registeredAgentCodes: string[],
): void {
  const value = typeof promotedBy === "string" ? promotedBy.trim() : "";
  if (!value) {
    throw new Error(
      "Promotion requires promoted_by naming the human operator who approved it. Anonymous callers cannot promote intake drafts.",
    );
  }
  const normalized = value.toLowerCase();
  const codes = registeredAgentCodes
    .map((code) => (code ?? "").trim().toLowerCase())
    .filter(Boolean);
  if (codes.includes(normalized)) {
    throw new Error(
      `promoted_by matches registered agent code '${value}'. Agent runtimes cannot promote intake drafts; promotion is a human decision.`,
    );
  }
  if (RUNNER_CALLER_PATTERN.test(value)) {
    throw new Error(
      `promoted_by '${value}' identifies an automated runtime. Automated runtimes cannot promote intake drafts; promotion is a human decision.`,
    );
  }
}

// OE-12 Phase 4 auto-promote is the INVERSE of the human promote check: it is
// the one path where an agent runtime IS the allowed caller — but ONLY the
// triage identity, and only as the tool-layer echo of the SQL's condition G.
// The SQL enforces the same string; both fail closed, so a dishonest key still
// cannot widen the caller set. This is deliberately NOT a substitute for
// assertPromotionCallerAllowed (the human path) — the two guards protect
// opposite lanes.
export function assertAutoPromotionCallerAllowed(
  callerAgentCode: string | null | undefined,
): void {
  const value = typeof callerAgentCode === "string" ? callerAgentCode.trim() : "";
  if (value !== "triage") {
    throw new Error(
      `auto_promote_agent_task_intake is callable only by agent_code 'triage'; got '${
        value || "<none>"
      }'. Auto-promote is the triage stage-4 action, not a general promote path.`,
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

export function assertWorkingExitAllowed(
  task: AgentTaskAccessRow,
  action: AgentTaskWorkingExitAction,
): void {
  if (task.status !== "Agent Working") {
    const receipt = action === "hold" ? "AGENT HUMAN HOLD" : "AGENT FAILED";
    throw new Error(`${receipt} requires Agent Working.`);
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
    case "hold":
      return { status: "Agent Needs Input", receipt: "AGENT HUMAN HOLD" };
    case "fail":
      return { status: "Agent Todo", receipt: "AGENT FAILED" };
  }
}

export function receiptForAppliedStatus(
  status: AgentTaskStatus,
): Extract<AgentTaskReceipt, "AGENT APPLIED" | "AGENT NEEDS OPERATOR"> {
  if (status === "Needs Operator") return "AGENT NEEDS OPERATOR";
  return "AGENT APPLIED";
}

export function compactObject<T extends Record<string, unknown>>(value: T): T {
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined && entry !== "") {
      copy[key] = entry;
    }
  }
  return copy as T;
}

// C2 hard runtime constraint. Project slugs that are entirely LOCAL RUNTIME ONLY:
// intake defaults requires_local=true for these so a task is protected the moment
// it is drafted, without threading an explicit flag through every builder. The
// column is still per-task and an explicit value always wins. Ships empty — a
// fork adds its own local-only slugs here.
export const KNOWN_LOCAL_PROJECT_SLUGS = [] as const;

// Resolve the requires_local value at intake time. An explicit boolean (from the
// human/triage caller) always wins; otherwise a known-local project defaults to
// true, everything else to false. Overridable: pass explicit=false to force a
// known-local project's task onto the shared pool.
export function resolveRequiresLocal(
  explicit: boolean | null | undefined,
  projectSlug: string | null | undefined,
): boolean {
  if (typeof explicit === "boolean") return explicit;
  const slug = (projectSlug ?? "").trim().toLowerCase();
  return (KNOWN_LOCAL_PROJECT_SLUGS as readonly string[]).includes(slug);
}

export function operatorTargetHasAllowedScheme(value: string): boolean {
  const trimmed = value.trim();
  // Protocol-relative //host resolves to an external host in a browser, so it
  // must be rejected even though it carries no explicit scheme.
  if (trimmed.startsWith("//")) return false;
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!schemeMatch) return true;
  const scheme = schemeMatch[1].toLowerCase();
  return scheme === "http" || scheme === "https";
}
