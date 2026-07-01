import assert from "node:assert/strict";
import test from "node:test";

import {
  buildApplyReviewRpcArgs,
  buildFollowUpDraftInsert,
  isGenericStatusMoveDisabled,
  shouldShowLinkedActionResolutionControl,
  shouldShowReviewApplyControls,
} from "../src/lib/agent-task-review-controls.js";

test("review apply controls appear only for Agent Review tasks", () => {
  assert.equal(shouldShowReviewApplyControls("Agent Review"), true);
  assert.equal(shouldShowReviewApplyControls("Agent Working"), false);
  assert.equal(shouldShowReviewApplyControls("Agent Done"), false);
});

test("linked action resolution appears only for review tasks with a linked action item", () => {
  assert.equal(
    shouldShowLinkedActionResolutionControl({
      status: "Agent Review",
      linked_action_item_id: "11111111-1111-4111-8111-111111111111",
    }),
    true
  );
  assert.equal(
    shouldShowLinkedActionResolutionControl({
      status: "Agent Review",
      linked_action_item_id: null,
    }),
    false
  );
  assert.equal(
    shouldShowLinkedActionResolutionControl({
      status: "Agent Working",
      linked_action_item_id: "11111111-1111-4111-8111-111111111111",
    }),
    false
  );
});

test("generic status move cannot apply Agent Review to done", () => {
  assert.equal(
    isGenericStatusMoveDisabled({
      currentStatus: "Agent Review",
      targetStatus: "Agent Done",
      approvalNeeded: false,
    }),
    true
  );
  assert.equal(
    isGenericStatusMoveDisabled({
      currentStatus: "Agent Review",
      targetStatus: "Agent Working",
      approvalNeeded: false,
    }),
    false
  );
  assert.equal(
    isGenericStatusMoveDisabled({
      currentStatus: "Standing",
      targetStatus: "Agent Todo",
      approvalNeeded: false,
    }),
    true
  );
  assert.equal(
    isGenericStatusMoveDisabled({
      currentStatus: "Agent Todo",
      targetStatus: "Agent Working",
      approvalNeeded: true,
    }),
    true
  );
});

test("apply review RPC args enforce accepted follow-up and linked action rules", () => {
  const accepted = new FormData();
  accepted.set("task_id", "11111111-1111-4111-8111-111111111111");
  accepted.set("applied_by", "dashboard");
  accepted.set("resolution", "accepted");
  accepted.set("note", "Reviewed and accepted.");
  accepted.set("resolve_linked_action_item", "on");
  accepted.set("work_summary", "Work was completed.");
  accepted.set("verification", "Focused tests passed.");

  assert.deepEqual(buildApplyReviewRpcArgs(accepted), {
    p_task_id: "11111111-1111-4111-8111-111111111111",
    p_applied_by: "dashboard",
    p_resolution: "accepted",
    p_note: "Reviewed and accepted.",
    p_resolve_linked_action_item: true,
    p_child_task_ids: [],
    p_closeout_evidence: {
      work_summary: "Work was completed.",
      verification: "Focused tests passed.",
    },
  });

  const followUp = new FormData();
  followUp.set("task_id", "11111111-1111-4111-8111-111111111111");
  followUp.set("resolution", "accepted_with_follow_up");
  followUp.set("child_task_ids", "22222222-2222-4222-8222-222222222222");

  assert.deepEqual(buildApplyReviewRpcArgs(followUp).p_child_task_ids, [
    "22222222-2222-4222-8222-222222222222",
  ]);

  const invalidFollowUp = new FormData();
  invalidFollowUp.set("task_id", "11111111-1111-4111-8111-111111111111");
  invalidFollowUp.set("resolution", "accepted_with_follow_up");
  assert.throws(
    () => buildApplyReviewRpcArgs(invalidFollowUp),
    /requires at least one child task/
  );

  const invalidResolution = new FormData();
  invalidResolution.set("task_id", "11111111-1111-4111-8111-111111111111");
  invalidResolution.set("resolution", "accepted_with_follow_up");
  invalidResolution.set("child_task_ids", "22222222-2222-4222-8222-222222222222");
  invalidResolution.set("resolve_linked_action_item", "on");
  assert.throws(
    () => buildApplyReviewRpcArgs(invalidResolution),
    /only be resolved when review resolution is accepted/
  );
});

test("follow-up draft insert creates a child Standing task", () => {
  const form = new FormData();
  form.set("parent_task_id", "11111111-1111-4111-8111-111111111111");
  form.set("agent_code", "local-codex");
  form.set("project_slug", "website");
  form.set("requested_by", "dashboard");
  form.set("desired_outcome", "Check live answer surfaces.");
  form.set("context", "Parent task lacked live UI access.");

  assert.deepEqual(buildFollowUpDraftInsert(form), {
    title: "[agent instructions][local-codex][follow-up] Check live answer surfaces.",
    label: "agent-instructions",
    agent_code: "local-codex",
    parent_task_id: "11111111-1111-4111-8111-111111111111",
    project_slug: "website",
    status: "Standing",
    priority: "medium",
    risk: "low",
    requested_by: "dashboard",
    intake_source: "agent-follow-up",
    desired_outcome: "Check live answer surfaces.",
    context: "Parent task lacked live UI access.",
    sources: [
      {
        kind: "agent_task",
        id: "11111111-1111-4111-8111-111111111111",
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
  });
});
