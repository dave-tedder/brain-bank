import { type AgentTaskRisk, isAgentTaskRisk } from "./_agent_tasks.ts";

export const AGENT_TASK_INTAKE_SOURCES = [
  "dashboard-button",
  "brain-bank-capture",
  "session-log-closeout",
  "handoff-doc",
  "slack-intake",
  "action-item-promotion",
] as const;

export type AgentTaskIntakeSource = (typeof AGENT_TASK_INTAKE_SOURCES)[number];

export interface AgentTaskIntakeInput {
  desired_outcome: string;
  context: string;
  sources: unknown[];
  do_steps: string;
  acceptance_criteria: string;
  output_handoff: string;
  boundaries: string;
  intake_source: AgentTaskIntakeSource;
  agent_code?: string | null;
  project_slug?: string | null;
  priority?: "low" | "medium" | "high";
  risk?: AgentTaskRisk;
  requested_by?: string | null;
  title?: string | null;
  source_thought_id?: string | null;
  linked_action_item_id?: string | null;
}

export interface AgentTaskIntakeRecord {
  title: string;
  label: "agent-instructions";
  status: "Standing";
  agent_code: string | null;
  project_slug: string | null;
  priority: "low" | "medium" | "high";
  risk: AgentTaskRisk;
  requested_by: string;
  intake_source: AgentTaskIntakeSource;
  desired_outcome: string;
  context: string;
  sources: unknown[];
  do_steps: string;
  acceptance_criteria: string;
  output_handoff: string;
  boundaries: string;
  explicit_approval: false;
  source_thought_id: string | null;
  linked_action_item_id: string | null;
}

export interface ActionItemPromotionRow {
  id: string;
  description: string;
  status: string;
  source_thought_id?: string | null;
}

export interface ActionItemPromotionInput {
  action_item: ActionItemPromotionRow;
  agent_code?: string | null;
  project_slug?: string | null;
  requested_by?: string | null;
}

export interface LinkedActionItemDraftRow {
  id: string;
  status: string;
}

export const ACTIVE_ACTION_ITEM_DRAFT_STATUSES = [
  "Standing",
  "Agent Todo",
  "Agent Working",
] as const;

const VALID_PRIORITIES = new Set(["low", "medium", "high"]);

function cleanText(value: string, field: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${field} is required.`);
  return cleaned;
}

function titleAgentCode(agentCode: string | null): string {
  return agentCode && agentCode.trim() ? agentCode.trim() : "unassigned";
}

function fallbackTitle(
  agentCode: string | null,
  desiredOutcome: string,
): string {
  const outcome = desiredOutcome.replace(/\s+/g, " ").trim();
  const shortOutcome = outcome.length > 96
    ? `${outcome.slice(0, 93).trim()}...`
    : outcome;
  return `[agent instructions][${
    titleAgentCode(agentCode)
  }][task] ${shortOutcome}`;
}

export function buildAgentTaskIntakeRecord(
  input: AgentTaskIntakeInput,
): AgentTaskIntakeRecord {
  if (!Array.isArray(input.sources)) {
    throw new Error("sources must be an array.");
  }

  const desiredOutcome = cleanText(input.desired_outcome, "desired_outcome");
  const agentCode = input.agent_code?.trim() || null;
  const priority = input.priority && VALID_PRIORITIES.has(input.priority)
    ? input.priority
    : "medium";
  const risk: AgentTaskRisk = isAgentTaskRisk(input.risk || "")
    ? input.risk!
    : "medium";
  const title = input.title?.trim() ||
    fallbackTitle(agentCode, desiredOutcome);

  return {
    title,
    label: "agent-instructions",
    status: "Standing",
    agent_code: agentCode,
    project_slug: input.project_slug?.trim() || null,
    priority,
    risk,
    requested_by: input.requested_by?.trim() || "codex",
    intake_source: input.intake_source,
    desired_outcome: desiredOutcome,
    context: cleanText(input.context, "context"),
    sources: input.sources,
    do_steps: cleanText(input.do_steps, "do_steps"),
    acceptance_criteria: cleanText(
      input.acceptance_criteria,
      "acceptance_criteria",
    ),
    output_handoff: cleanText(input.output_handoff, "output_handoff"),
    boundaries: cleanText(input.boundaries, "boundaries"),
    explicit_approval: false,
    source_thought_id: input.source_thought_id?.trim() || null,
    linked_action_item_id: input.linked_action_item_id?.trim() || null,
  };
}

export function assertNoActiveActionItemDraft(
  existingTasks: LinkedActionItemDraftRow[],
  actionItemId: string,
): void {
  const activeTask = existingTasks.find((task) =>
    (ACTIVE_ACTION_ITEM_DRAFT_STATUSES as readonly string[]).includes(
      task.status,
    )
  );
  if (activeTask) {
    throw new Error(
      `Action item ${actionItemId} already has an active agent task draft: ${activeTask.id} (${activeTask.status}).`,
    );
  }
}

export function buildActionItemPromotionIntakeRecord(
  input: ActionItemPromotionInput,
): AgentTaskIntakeRecord {
  const actionItem = input.action_item;
  if (actionItem.status !== "open") {
    throw new Error("Only open action_items can be promoted to intake drafts.");
  }

  const description = cleanText(actionItem.description, "description");
  const actionItemId = cleanText(actionItem.id, "action_item.id");
  const sourceThoughtId = actionItem.source_thought_id?.trim() || null;

  return buildAgentTaskIntakeRecord({
    desired_outcome: description,
    context:
      `Manual action-item promotion draft for action_items.id ${actionItemId}.\n\nAction item: ${description}`,
    sources: [
      {
        kind: "action_item",
        id: actionItemId,
        source_thought_id: sourceThoughtId,
      },
    ],
    do_steps:
      "Review the linked action item, expand this draft into a complete task packet if it is still worth doing, then use the normal human promotion path when ready.",
    acceptance_criteria:
      "The Standing draft is reviewed by a human and remains unclaimable until explicitly promoted later.",
    output_handoff:
      "Leave notes on what changed, what evidence was checked, and whether the draft should be promoted, rewritten, or left Standing.",
    boundaries:
      "Manual draft only. Do not promote, claim, run, deploy, send messages, spend money, delete data, or mark the linked action item resolved from this intake step.",
    intake_source: "action-item-promotion",
    agent_code: input.agent_code,
    project_slug: input.project_slug,
    priority: "medium",
    risk: "low",
    requested_by: input.requested_by,
    title: `[agent instructions][${
      titleAgentCode(input.agent_code ?? null)
    }][action-item] ${description}`,
    source_thought_id: sourceThoughtId,
    linked_action_item_id: actionItemId,
  });
}
