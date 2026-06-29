const PRIORITIES = new Set(["low", "medium", "high"]);
const RISKS = new Set(["low", "medium", "high"]);

function textValue(formData, key) {
  const value = formData.get(key);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requireText(formData, key) {
  const value = textValue(formData, key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function parsePriority(value) {
  return PRIORITIES.has(value ?? "") ? value : "medium";
}

function parseRisk(value) {
  return RISKS.has(value ?? "") ? value : "medium";
}

function parseSources(value) {
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error("sources must be a JSON array");
  }
  return parsed;
}

function parseIntakeSource(value) {
  if (!value || value === "dashboard") return "dashboard-button";
  return value;
}

export function buildIntakeDraftInsert(formData) {
  return {
    title: requireText(formData, "title"),
    label: "agent-instructions",
    agent_code: textValue(formData, "agent_code"),
    project_slug: textValue(formData, "project_slug"),
    status: "Standing",
    priority: parsePriority(textValue(formData, "priority")),
    risk: parseRisk(textValue(formData, "risk")),
    requested_by: textValue(formData, "requested_by"),
    intake_source: parseIntakeSource(textValue(formData, "intake_source")),
    desired_outcome: requireText(formData, "desired_outcome"),
    context: textValue(formData, "context"),
    sources: parseSources(textValue(formData, "sources")),
    do_steps: textValue(formData, "do_steps"),
    acceptance_criteria: textValue(formData, "acceptance_criteria"),
    output_handoff: textValue(formData, "output_handoff"),
    boundaries: textValue(formData, "boundaries"),
    explicit_approval: false,
  };
}

export function buildPromotionRpcArgs(formData) {
  return {
    p_task_id: requireText(formData, "task_id"),
    p_promoted_by: textValue(formData, "promoted_by") ?? "dashboard",
    p_note: textValue(formData, "promotion_note"),
  };
}
