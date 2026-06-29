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

const HANDOFF_SECTION_KEYS = {
  goal: "desired_outcome",
  "recommended scope": "do_steps",
  scope: "do_steps",
  verification: "acceptance_criteria",
  acceptance: "acceptance_criteria",
  closeout: "output_handoff",
  handoff: "output_handoff",
  "stop before": "boundaries",
  boundaries: "boundaries",
};

function normalizeSectionKey(value) {
  return value.toLowerCase().replace(/\s+/g, " ");
}

function sectionHeader(line) {
  const normalizedLine = line.trim().replace(/^#{1,6}\s+/, "");
  const boldMatch = normalizedLine.match(/^\*\*([A-Za-z][A-Za-z /-]{1,40}):\*\*\s*(.*)$/);
  if (boldMatch) {
    return {
      key: normalizeSectionKey(boldMatch[1]),
      content: boldMatch[2].trim() || null,
    };
  }

  const match = normalizedLine.match(/^([A-Za-z][A-Za-z /-]{1,40}):(?:\s+(.*))?$/);
  if (!match) return null;
  return {
    key: normalizeSectionKey(match[1]),
    content: match[2]?.trim() || null,
  };
}

function parseHandoffSections(text) {
  const sections = {};
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const header = sectionHeader(line);
    if (header && HANDOFF_SECTION_KEYS[header.key]) {
      current = HANDOFF_SECTION_KEYS[header.key];
      sections[current] ??= [];
      if (header.content) sections[current].push(header.content);
      continue;
    }
    if (current) sections[current].push(line);
  }

  return Object.fromEntries(
    Object.entries(sections).map(([key, lines]) => [
      key,
      lines.join("\n").trim() || null,
    ])
  );
}

function firstContentLine(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.endsWith(":")) ?? null;
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

export function buildHandoffDraftInsert(formData) {
  const handoffText = requireText(formData, "handoff_text");
  const sections = parseHandoffSections(handoffText);
  const desiredOutcome =
    textValue(formData, "desired_outcome") ??
    sections.desired_outcome ??
    firstContentLine(handoffText) ??
    requireText(formData, "title");

  return {
    title: requireText(formData, "title"),
    label: "agent-instructions",
    agent_code: textValue(formData, "agent_code"),
    project_slug: textValue(formData, "project_slug"),
    status: "Standing",
    priority: parsePriority(textValue(formData, "priority")),
    risk: parseRisk(textValue(formData, "risk")),
    requested_by: textValue(formData, "requested_by"),
    intake_source: "handoff-doc",
    desired_outcome: desiredOutcome,
    context: handoffText,
    sources: [{ type: "handoff-doc", label: "pasted handoff", chars: handoffText.length }],
    do_steps: sections.do_steps ?? null,
    acceptance_criteria: sections.acceptance_criteria ?? null,
    output_handoff: sections.output_handoff ?? null,
    boundaries: sections.boundaries ?? null,
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
