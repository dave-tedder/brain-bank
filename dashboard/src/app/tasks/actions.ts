"use server";

import { revalidatePath } from "next/cache";
import { supabase } from "@/lib/supabase";
import type {
  AgentTaskPriority,
  AgentTaskRisk,
  AgentTaskStatus,
} from "@/lib/agent-tasks";

const PRIORITIES = new Set(["low", "medium", "high"]);
const RISKS = new Set(["low", "medium", "high"]);
const STATUSES = new Set([
  "Standing",
  "Agent Todo",
  "Agent Working",
  "Agent Needs Input",
  "Agent Review",
  "Agent Done",
]);

function textValue(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requireText(formData: FormData, key: string): string {
  const value = textValue(formData, key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function parsePriority(value: string | null): AgentTaskPriority {
  return PRIORITIES.has(value ?? "") ? (value as AgentTaskPriority) : "medium";
}

function parseRisk(value: string | null): AgentTaskRisk {
  return RISKS.has(value ?? "") ? (value as AgentTaskRisk) : "medium";
}

function parseSources(value: string | null): unknown[] {
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error("sources must be a JSON array");
  }
  return parsed;
}

function statusReceipt(target: AgentTaskStatus, current: AgentTaskStatus): string {
  switch (target) {
    case "Standing":
      return "AGENT STATUS";
    case "Agent Todo":
      return "AGENT FOLLOW-UP";
    case "Agent Working":
      return current === "Agent Needs Input"
        ? "AGENT HUMAN ANSWERED"
        : "AGENT RESUMED";
    case "Agent Needs Input":
      return "AGENT HUMAN HOLD";
    case "Agent Review":
      return "AGENT DONE";
    case "Agent Done":
      return "AGENT APPLIED";
    default:
      return "AGENT STATUS";
  }
}

function redirectPath(formData: FormData): string {
  return textValue(formData, "redirect_path") ?? "/tasks";
}

export async function createAgentTask(formData: FormData) {
  const title = requireText(formData, "title");
  const desired_outcome = requireText(formData, "desired_outcome");
  const sources = parseSources(textValue(formData, "sources"));

  const { error } = await supabase().from("agent_tasks").insert({
    title,
    label: "agent-instructions",
    agent_code: textValue(formData, "agent_code"),
    project_slug: textValue(formData, "project_slug"),
    priority: parsePriority(textValue(formData, "priority")),
    risk: parseRisk(textValue(formData, "risk")),
    requested_by: textValue(formData, "requested_by"),
    intake_source: textValue(formData, "intake_source"),
    desired_outcome,
    context: textValue(formData, "context"),
    sources,
    do_steps: textValue(formData, "do_steps"),
    acceptance_criteria: textValue(formData, "acceptance_criteria"),
    output_handoff: textValue(formData, "output_handoff"),
    boundaries: textValue(formData, "boundaries"),
    explicit_approval: formData.get("explicit_approval") === "on",
  });

  if (error) throw error;
  revalidatePath("/tasks");
}

export async function updateAgentTask(formData: FormData) {
  const id = requireText(formData, "task_id");
  const title = requireText(formData, "title");
  const desired_outcome = requireText(formData, "desired_outcome");
  const sources = parseSources(textValue(formData, "sources"));

  const { error } = await supabase()
    .from("agent_tasks")
    .update({
      title,
      agent_code: textValue(formData, "agent_code"),
      project_slug: textValue(formData, "project_slug"),
      priority: parsePriority(textValue(formData, "priority")),
      risk: parseRisk(textValue(formData, "risk")),
      requested_by: textValue(formData, "requested_by"),
      intake_source: textValue(formData, "intake_source"),
      desired_outcome,
      context: textValue(formData, "context"),
      sources,
      do_steps: textValue(formData, "do_steps"),
      acceptance_criteria: textValue(formData, "acceptance_criteria"),
      output_handoff: textValue(formData, "output_handoff"),
      boundaries: textValue(formData, "boundaries"),
      explicit_approval: formData.get("explicit_approval") === "on",
    })
    .eq("id", id);

  if (error) throw error;
  revalidatePath("/tasks");
}

export async function moveAgentTaskStatus(formData: FormData) {
  const taskId = requireText(formData, "task_id");
  const target = requireText(formData, "target_status");
  const current = requireText(formData, "current_status");
  const agentCode = textValue(formData, "agent_code");
  const reason = textValue(formData, "reason");

  if (!STATUSES.has(target) || !STATUSES.has(current)) {
    throw new Error("invalid task status");
  }

  const { error } = await supabase().rpc("move_agent_task_status", {
    p_task_id: taskId,
    p_status: target,
    p_event_type: statusReceipt(
      target as AgentTaskStatus,
      current as AgentTaskStatus
    ),
    p_agent_code: agentCode,
    p_reason: reason,
  });

  if (error) throw error;
  revalidatePath(redirectPath(formData));
}
