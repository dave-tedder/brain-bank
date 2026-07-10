import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  AGENT_TASK_INTAKE_SOURCES,
  type AgentTaskIntakeSource,
  assertFollowUpParentAllowed,
  assertNoActiveActionItemDraft,
  assertNoActiveThoughtDraft,
  assertNoDuplicateOpenFollowUp,
  buildActionItemPromotionIntakeRecord,
  buildAgentTaskIntakeRecord,
  buildFollowUpTaskRecord,
  buildThoughtIntakeRecord,
} from "./_agent_intake.ts";

const baseInput = {
  desired_outcome: "Create a draft intake task for OE-6 smoke verification.",
  context: "Harmless test context.",
  sources: [{ kind: "test", path: "_agent_intake_test.ts" }],
  do_steps: "Create a draft-safe task packet only.",
  acceptance_criteria: "Record is Standing and not claimable.",
  output_handoff: "Review the draft manually before promotion.",
  boundaries: "No automation, deploys, deletes, sends, or private data.",
  intake_source: "handoff-doc" as const,
};

Deno.test("intake creates Standing draft records with safe defaults", () => {
  const record = buildAgentTaskIntakeRecord(baseInput);

  assertEquals(record.status, "Standing");
  assertEquals(record.label, "agent-instructions");
  assertEquals(record.priority, "medium");
  assertEquals(record.risk, "medium");
  assertEquals(record.explicit_approval, false);
  assertEquals(record.requested_by, null);
  assertEquals(
    record.title.startsWith("[agent instructions][unassigned][task]"),
    true,
  );
});

Deno.test("intake preserves full task packet fields and optional linkage", () => {
  const record = buildAgentTaskIntakeRecord({
    ...baseInput,
    agent_code: "local-codex",
    project_slug: "brain-bank",
    priority: "high",
    risk: "low",
    requested_by: "oe6-test",
    source_thought_id: "11111111-1111-4111-8111-111111111111",
    linked_action_item_id: "22222222-2222-4222-8222-222222222222",
  });

  assertEquals(record.agent_code, "local-codex");
  assertEquals(record.project_slug, "brain-bank");
  assertEquals(record.priority, "high");
  assertEquals(record.risk, "low");
  assertEquals(
    record.source_thought_id,
    "11111111-1111-4111-8111-111111111111",
  );
  assertEquals(
    record.linked_action_item_id,
    "22222222-2222-4222-8222-222222222222",
  );
  assertEquals(record.desired_outcome, baseInput.desired_outcome);
  assertEquals(record.context, baseInput.context);
  assertEquals(record.do_steps, baseInput.do_steps);
  assertEquals(record.acceptance_criteria, baseInput.acceptance_criteria);
  assertEquals(record.output_handoff, baseInput.output_handoff);
  assertEquals(record.boundaries, baseInput.boundaries);
});

Deno.test("intake never grants explicit approval even for high-risk drafts", () => {
  const record = buildAgentTaskIntakeRecord({
    ...baseInput,
    risk: "high",
  });

  assertEquals(record.status, "Standing");
  assertEquals(record.risk, "high");
  assertEquals(record.explicit_approval, false);
});

Deno.test("intake requires packet fields and array sources", () => {
  assertThrows(
    () => buildAgentTaskIntakeRecord({ ...baseInput, desired_outcome: " " }),
    Error,
    "desired_outcome is required",
  );
  assertThrows(
    () =>
      buildAgentTaskIntakeRecord({
        ...baseInput,
        sources: "not-array" as unknown as unknown[],
      }),
    Error,
    "sources must be an array",
  );
  assertThrows(
    () =>
      buildAgentTaskIntakeRecord({
        ...baseInput,
        desired_outcome: "x".repeat(4001),
      }),
    Error,
    "desired_outcome must be 4000 characters or fewer",
  );
  assertThrows(
    () =>
      buildAgentTaskIntakeRecord({
        ...baseInput,
        title: "x".repeat(241),
      }),
    Error,
    "title must be 240 characters or fewer",
  );
});

Deno.test("action-item promotion creates a conservative Standing draft packet", () => {
  const record = buildActionItemPromotionIntakeRecord({
    action_item: {
      id: "33333333-3333-4333-8333-333333333333",
      description: "Review the OE-6 manual action-item promotion path.",
      status: "open",
      source_thought_id: "44444444-4444-4444-8444-444444444444",
    },
    agent_code: "local-codex",
    project_slug: "brain-bank",
    requested_by: "oe6-test",
  });

  assertEquals(record.status, "Standing");
  assertEquals(record.intake_source, "action-item-promotion");
  assertEquals(
    record.linked_action_item_id,
    "33333333-3333-4333-8333-333333333333",
  );
  assertEquals(
    record.source_thought_id,
    "44444444-4444-4444-8444-444444444444",
  );
  assertEquals(record.agent_code, "local-codex");
  assertEquals(record.project_slug, "brain-bank");
  assertEquals(record.risk, "low");
  assertEquals(record.priority, "medium");
  assertEquals(record.explicit_approval, false);
  assertEquals(Object.hasOwn(record, "claimed_by"), false);
  assertEquals(Object.hasOwn(record, "claim_expires_at"), false);
  assertEquals(
    record.desired_outcome,
    "Review the OE-6 manual action-item promotion path.",
  );
  assertEquals(record.sources, [
    {
      kind: "action_item",
      id: "33333333-3333-4333-8333-333333333333",
      source_thought_id: "44444444-4444-4444-8444-444444444444",
    },
  ]);
  assertEquals(
    record.boundaries.includes("Do not promote, claim, run, deploy, send"),
    true,
  );
});

Deno.test("action-item promotion rejects unsafe or invalid input", () => {
  assertThrows(
    () =>
      buildActionItemPromotionIntakeRecord({
        action_item: {
          id: "33333333-3333-4333-8333-333333333333",
          description: "Already handled.",
          status: "resolved",
        },
      }),
    Error,
    "Only open action_items",
  );

  assertThrows(
    () =>
      buildActionItemPromotionIntakeRecord({
        action_item: {
          id: "33333333-3333-4333-8333-333333333333",
          description: " ",
          status: "open",
        },
      }),
    Error,
    "description is required",
  );
});

Deno.test("action-item promotion rejects duplicate active linked drafts", () => {
  for (
    const status of [
      "Standing",
      "Agent Todo",
      "Agent Working",
      "Agent Needs Input",
      "Agent Review",
      "Needs Operator",
    ]
  ) {
    assertThrows(
      () =>
        assertNoActiveActionItemDraft(
          [{ id: "55555555-5555-4555-8555-555555555555", status }],
          "33333333-3333-4333-8333-333333333333",
        ),
      Error,
      "already has an active agent task draft",
    );
  }

  assertNoActiveActionItemDraft(
    [{ id: "66666666-6666-4666-8666-666666666666", status: "Agent Done" }],
    "33333333-3333-4333-8333-333333333333",
  );
});

Deno.test("thought intake creates a conservative Standing draft packet", () => {
  const record = buildThoughtIntakeRecord({
    thought: {
      id: "77777777-7777-4777-8777-777777777777",
      content:
        "Session closeout: Continue OE-6 by drafting a manual thought intake surface.",
      metadata: {
        source: "session-log",
        project: "brain-bank",
        topics: ["open-engine", "oe-6"],
      },
      created_at: "2026-06-29T16:20:00Z",
    },
    agent_code: "local-codex",
    project_slug: "brain-bank",
    requested_by: "session-233",
  });

  assertEquals(record.status, "Standing");
  assertEquals(record.intake_source, "session-log-closeout");
  assertEquals(
    record.source_thought_id,
    "77777777-7777-4777-8777-777777777777",
  );
  assertEquals(record.linked_action_item_id, null);
  assertEquals(record.agent_code, "local-codex");
  assertEquals(record.project_slug, "brain-bank");
  assertEquals(record.risk, "low");
  assertEquals(record.priority, "medium");
  assertEquals(record.explicit_approval, false);
  assertEquals(Object.hasOwn(record, "claimed_by"), false);
  assertEquals(Object.hasOwn(record, "claim_expires_at"), false);
  assertEquals(
    record.desired_outcome,
    "Review source thought 77777777-7777-4777-8777-777777777777 and draft a manual agent task if it is still worth doing.",
  );
  assertEquals(record.sources, [
    {
      kind: "thought",
      id: "77777777-7777-4777-8777-777777777777",
      source: "session-log",
      created_at: "2026-06-29T16:20:00Z",
    },
  ]);
  assertEquals(
    record.context.includes("Source thought excerpt:"),
    true,
  );
  assertEquals(record.context.includes("Continue OE-6"), true);
  assertEquals(
    record.boundaries.includes("Do not promote, claim, run, deploy, send"),
    true,
  );
});

Deno.test("thought intake maps non-session captures to brain-bank-capture", () => {
  const record = buildThoughtIntakeRecord({
    thought: {
      id: "77777777-7777-4777-8777-777777777777",
      content: "Captured idea for a future Brain Bank task.",
      metadata: { source: "rest-api" },
    },
  });

  assertEquals(record.intake_source, "brain-bank-capture");
  assertEquals(record.sources, [
    {
      kind: "thought",
      id: "77777777-7777-4777-8777-777777777777",
      source: "rest-api",
      created_at: null,
    },
  ]);
});

Deno.test("thought intake bounds source excerpts", () => {
  const longContent = `${"Review ".repeat(400)}final note`;
  const record = buildThoughtIntakeRecord({
    thought: {
      id: "77777777-7777-4777-8777-777777777777",
      content: longContent,
    },
  });

  assertEquals(record.context.length < longContent.length, true);
  assertEquals(record.context.endsWith("..."), true);
});

Deno.test("thought intake rejects missing or invalid thought input", () => {
  assertThrows(
    () =>
      buildThoughtIntakeRecord({
        thought: {
          id: " ",
          content: "Session closeout text.",
        },
      }),
    Error,
    "thought.id is required",
  );

  assertThrows(
    () =>
      buildThoughtIntakeRecord({
        thought: {
          id: "77777777-7777-4777-8777-777777777777",
          content: " ",
        },
      }),
    Error,
    "thought.content is required",
  );
});

Deno.test("thought intake rejects duplicate active source-thought drafts", () => {
  for (
    const status of [
      "Standing",
      "Agent Todo",
      "Agent Working",
      "Agent Needs Input",
      "Agent Review",
      "Needs Operator",
    ]
  ) {
    assertThrows(
      () =>
        assertNoActiveThoughtDraft(
          [{ id: "88888888-8888-4888-8888-888888888888", status }],
          "77777777-7777-4777-8777-777777777777",
        ),
      Error,
      "already has an active agent task draft",
    );
  }

  assertNoActiveThoughtDraft(
    [{ id: "99999999-9999-4999-8999-999999999999", status: "Agent Done" }],
    "77777777-7777-4777-8777-777777777777",
  );
});

Deno.test("follow-up intake creates child Standing drafts with safe defaults", () => {
  const record = buildFollowUpTaskRecord({
    parent_task_id: "11111111-1111-4111-8111-111111111111",
    agent_code: "local-codex",
    project_slug: "brain-bank",
    requested_by: "oe7-test",
    desired_outcome:
      "Browser-check live AI answer surfaces for four GEO terms.",
    context:
      "Parent task completed web-index checks but lacked live AI answer UI access.",
  });

  assertEquals(record.status, "Standing");
  assertEquals(
    record.parent_task_id,
    "11111111-1111-4111-8111-111111111111",
  );
  assertEquals(record.intake_source, "agent-follow-up");
  assertEquals(record.explicit_approval, false);
  assertEquals(record.agent_code, "local-codex");
  assertEquals(record.project_slug, "brain-bank");
  assertEquals(record.risk, "low");
  assertEquals(record.priority, "medium");
  assertEquals(record.linked_action_item_id, null);
  assertEquals(record.source_thought_id, null);
  assertEquals(Object.hasOwn(record, "claimed_by"), false);
  assertEquals(Object.hasOwn(record, "claim_expires_at"), false);
  assertEquals(record.sources, [
    {
      kind: "agent_task",
      id: "11111111-1111-4111-8111-111111111111",
      relationship: "parent",
    },
  ]);
});

Deno.test("follow-up intake rejects missing parent task or packet fields", () => {
  assertThrows(
    () =>
      buildFollowUpTaskRecord({
        parent_task_id: " ",
        desired_outcome: "Do the child work.",
        context: "Parent found follow-up work.",
      }),
    Error,
    "parent_task_id is required",
  );

  assertThrows(
    () =>
      buildFollowUpTaskRecord({
        parent_task_id: "11111111-1111-4111-8111-111111111111",
        desired_outcome: " ",
        context: "Parent found follow-up work.",
      }),
    Error,
    "desired_outcome is required",
  );
});

Deno.test("follow-up intake rejects archived parents and duplicate active children", () => {
  assertFollowUpParentAllowed({
    id: "11111111-1111-4111-8111-111111111111",
    archived_at: null,
  });
  assertThrows(
    () =>
      assertFollowUpParentAllowed({
        id: "11111111-1111-4111-8111-111111111111",
        archived_at: "2026-07-09T12:00:00Z",
      }),
    Error,
    "archived and cannot receive follow-up drafts",
  );

  assertThrows(
    () =>
      assertNoDuplicateOpenFollowUp(
        [{
          id: "22222222-2222-4222-8222-222222222222",
          status: "Needs Operator",
          desired_outcome:
            "Browser-check live AI answer surfaces for four GEO terms.",
        }],
        "11111111-1111-4111-8111-111111111111",
        "Browser-check live AI answer surfaces for four GEO terms.",
      ),
    Error,
    "already has an active follow-up draft",
  );

  assertNoDuplicateOpenFollowUp(
    [{
      id: "33333333-3333-4333-8333-333333333333",
      status: "Agent Done",
      desired_outcome:
        "Browser-check live AI answer surfaces for four GEO terms.",
    }],
    "11111111-1111-4111-8111-111111111111",
    "Browser-check live AI answer surfaces for four GEO terms.",
  );
});

Deno.test("intake source list remains Brain Bank neutral", () => {
  assert(
    AGENT_TASK_INTAKE_SOURCES.includes(
      "brain-bank-capture" as AgentTaskIntakeSource,
    ),
  );
  assertEquals(
    AGENT_TASK_INTAKE_SOURCES.includes(
      "open-brain-capture" as AgentTaskIntakeSource,
    ),
    false,
  );
});
