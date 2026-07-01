import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHandoffDraftInsert,
  buildIntakeDraftInsert,
  buildPromotionRpcArgs,
} from "../src/lib/agent-task-intake.js";

test("buildIntakeDraftInsert creates a Standing-only draft with safe defaults", () => {
  const form = new FormData();
  form.set("title", "[agent instructions][local-codex][task] Draft caller smoke");
  form.set("agent_code", "local-codex");
  form.set("requested_by", "operator");
  form.set("priority", "high");
  form.set("risk", "high");
  form.set("desired_outcome", "Create a harmless draft from the dashboard.");
  form.set("sources", JSON.stringify([{ type: "dashboard", label: "manual" }]));

  assert.deepEqual(buildIntakeDraftInsert(form), {
    title: "[agent instructions][local-codex][task] Draft caller smoke",
    label: "agent-instructions",
    agent_code: "local-codex",
    project_slug: null,
    status: "Standing",
    priority: "high",
    risk: "high",
    requested_by: "operator",
    intake_source: "dashboard-button",
    desired_outcome: "Create a harmless draft from the dashboard.",
    context: null,
    sources: [{ type: "dashboard", label: "manual" }],
    do_steps: null,
    acceptance_criteria: null,
    output_handoff: null,
    boundaries: null,
    explicit_approval: false,
  });
});

test("buildIntakeDraftInsert normalizes legacy dashboard source labels", () => {
  const form = new FormData();
  form.set("title", "[agent instructions][local-codex][task] Legacy source");
  form.set("intake_source", "dashboard");
  form.set("desired_outcome", "Normalize old dashboard source labels.");

  assert.equal(buildIntakeDraftInsert(form).intake_source, "dashboard-button");
});

test("buildHandoffDraftInsert creates a conservative Standing draft from pasted handoff text", () => {
  const form = new FormData();
  form.set("title", "[agent instructions][local-codex][task] Build handoff intake helper");
  form.set("agent_code", "local-codex");
  form.set("project_slug", "open_brain");
  form.set("requested_by", "operator");
  form.set("priority", "high");
  form.set("risk", "medium");
  form.set(
    "handoff_text",
    [
      "Goal:",
      "Build a small safe helper for pasted session handoffs.",
      "",
      "Recommended scope:",
      "- Parse the pasted text into a draft packet.",
      "- Keep the result manual-only.",
      "",
      "Verification:",
      "- Create one harmless Standing draft.",
      "- Confirm events stay empty.",
      "",
      "Closeout:",
      "- Update tracker and session log.",
      "",
      "Stop before:",
      "- Do not auto-promote.",
      "- Do not set explicit approval.",
    ].join("\n")
  );

  assert.deepEqual(buildHandoffDraftInsert(form), {
    title: "[agent instructions][local-codex][task] Build handoff intake helper",
    label: "agent-instructions",
    agent_code: "local-codex",
    project_slug: "open_brain",
    status: "Standing",
    priority: "high",
    risk: "medium",
    requested_by: "operator",
    intake_source: "handoff-doc",
    desired_outcome: "Build a small safe helper for pasted session handoffs.",
    context: [
      "Goal:",
      "Build a small safe helper for pasted session handoffs.",
      "",
      "Recommended scope:",
      "- Parse the pasted text into a draft packet.",
      "- Keep the result manual-only.",
      "",
      "Verification:",
      "- Create one harmless Standing draft.",
      "- Confirm events stay empty.",
      "",
      "Closeout:",
      "- Update tracker and session log.",
      "",
      "Stop before:",
      "- Do not auto-promote.",
      "- Do not set explicit approval.",
    ].join("\n"),
    sources: [{ type: "handoff-doc", label: "pasted handoff", chars: 352 }],
    do_steps: "- Parse the pasted text into a draft packet.\n- Keep the result manual-only.",
    acceptance_criteria: "- Create one harmless Standing draft.\n- Confirm events stay empty.",
    output_handoff: "- Update tracker and session log.",
    boundaries: "- Do not auto-promote.\n- Do not set explicit approval.",
    explicit_approval: false,
  });
});

test("buildHandoffDraftInsert parses common markdown handoff headings", () => {
  const form = new FormData();
  form.set("title", "[agent instructions][local-codex][task] Markdown headings");
  form.set(
    "handoff_text",
    [
      "## Goal: Build from markdown headings.",
      "",
      "**Recommended scope:**",
      "- Preserve deterministic parsing.",
      "",
      "### Verification:",
      "- Confirm parsed fields are populated.",
      "",
      "**Closeout:** Record the smoke row.",
      "",
      "## Stop before:",
      "- Do not auto-promote.",
    ].join("\n")
  );

  const draft = buildHandoffDraftInsert(form);

  assert.equal(draft.desired_outcome, "Build from markdown headings.");
  assert.equal(draft.do_steps, "- Preserve deterministic parsing.");
  assert.equal(draft.acceptance_criteria, "- Confirm parsed fields are populated.");
  assert.equal(draft.output_handoff, "Record the smoke row.");
  assert.equal(draft.boundaries, "- Do not auto-promote.");
  assert.equal(draft.context, form.get("handoff_text"));
});

test("buildPromotionRpcArgs preserves the human actor and optional note", () => {
  const form = new FormData();
  form.set("task_id", "92400e1e-5d20-4aa1-8975-2619c56ce265");
  form.set("promoted_by", "dave");
  form.set("promotion_note", "Approved for the manual todo queue.");

  assert.deepEqual(buildPromotionRpcArgs(form), {
    p_task_id: "92400e1e-5d20-4aa1-8975-2619c56ce265",
    p_promoted_by: "dave",
    p_note: "Approved for the manual todo queue.",
  });
});
