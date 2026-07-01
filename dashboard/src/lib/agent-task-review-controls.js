const REVIEW_RESOLUTIONS = new Set(["accepted", "accepted_with_follow_up"]);

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

function parseChildTaskIds(value) {
  if (!value) return [];
  return value
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean);
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null)
  );
}

function titleAgentCode(agentCode) {
  return agentCode && agentCode.trim() ? agentCode.trim() : "unassigned";
}

function fallbackTitle(agentCode, desiredOutcome) {
  const compact = desiredOutcome.replace(/\s+/g, " ").trim();
  const shortOutcome =
    compact.length > 96 ? `${compact.slice(0, 93).trim()}...` : compact;
  return `[agent instructions][${titleAgentCode(agentCode)}][follow-up] ${shortOutcome}`;
}

export function shouldShowReviewApplyControls(status) {
  return status === "Agent Review";
}

export function shouldShowLinkedActionResolutionControl(task) {
  return task.status === "Agent Review" && Boolean(task.linked_action_item_id);
}

export function isGenericStatusMoveDisabled({
  currentStatus,
  targetStatus,
  approvalNeeded = false,
}) {
  return (
    targetStatus === currentStatus ||
    (targetStatus === "Agent Working" && approvalNeeded) ||
    (currentStatus === "Standing" && targetStatus === "Agent Todo") ||
    (currentStatus === "Agent Review" && targetStatus === "Agent Done")
  );
}

export function buildApplyReviewRpcArgs(formData) {
  const resolution = requireText(formData, "resolution");
  if (!REVIEW_RESOLUTIONS.has(resolution)) {
    throw new Error(`invalid review resolution: ${resolution}`);
  }

  const childTaskIds = parseChildTaskIds(textValue(formData, "child_task_ids"));
  const resolveLinked = formData.get("resolve_linked_action_item") === "on";
  if (resolution === "accepted_with_follow_up" && childTaskIds.length === 0) {
    throw new Error("accepted_with_follow_up requires at least one child task");
  }
  if (resolveLinked && resolution !== "accepted") {
    throw new Error(
      "linked action item can only be resolved when review resolution is accepted"
    );
  }

  return {
    p_task_id: requireText(formData, "task_id"),
    p_applied_by: textValue(formData, "applied_by") ?? "dashboard",
    p_resolution: resolution,
    p_note: textValue(formData, "note"),
    p_resolve_linked_action_item: resolveLinked,
    p_child_task_ids: childTaskIds,
    p_closeout_evidence: compactObject({
      work_summary: textValue(formData, "work_summary"),
      verification: textValue(formData, "verification"),
      touched_files_or_records: textValue(
        formData,
        "touched_files_or_records"
      ),
      tracker_draft: textValue(formData, "tracker_draft"),
      session_log_draft: textValue(formData, "session_log_draft"),
      open_brain_capture_draft: textValue(
        formData,
        "open_brain_capture_draft"
      ),
    }),
  };
}

export function buildFollowUpDraftInsert(formData) {
  const parentTaskId = requireText(formData, "parent_task_id");
  const agentCode = textValue(formData, "agent_code");
  const desiredOutcome = requireText(formData, "desired_outcome");
  return {
    title:
      textValue(formData, "title") ?? fallbackTitle(agentCode, desiredOutcome),
    label: "agent-instructions",
    agent_code: agentCode,
    parent_task_id: parentTaskId,
    project_slug: textValue(formData, "project_slug"),
    status: "Standing",
    priority: "medium",
    risk: "low",
    requested_by: textValue(formData, "requested_by") ?? "dashboard",
    intake_source: "agent-follow-up",
    desired_outcome: desiredOutcome,
    context: requireText(formData, "context"),
    sources: [
      {
        kind: "agent_task",
        id: parentTaskId,
        relationship: "parent",
      },
    ],
    do_steps:
      "Review the parent task result, confirm this child work is still needed, expand this draft into a complete task packet if needed, then use the normal human promotion path when ready.",
    acceptance_criteria:
      "The child Standing draft is reviewed by a human and remains unclaimable until explicitly promoted later.",
    output_handoff:
      "Leave notes on the parent task, what follow-up remains, what evidence was checked, and whether this child draft should be promoted, rewritten, or left Standing.",
    boundaries:
      "Manual follow-up draft only. Do not promote, claim, run, deploy, send messages, spend money, delete data, resolve linked action items, or mark project records complete from this draft step.",
    explicit_approval: false,
  };
}
