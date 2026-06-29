import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  assertNoActiveActionItemDraft,
  buildActionItemPromotionIntakeRecord,
  buildAgentTaskIntakeRecord,
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
  assertEquals(record.requested_by, "codex");
  assertEquals(
    record.title.startsWith("[agent instructions][unassigned][task]"),
    true,
  );
});

Deno.test("intake preserves full task packet fields and optional linkage", () => {
  const record = buildAgentTaskIntakeRecord({
    ...baseInput,
    agent_code: "dave-codex",
    project_slug: "brain-bank",
    priority: "high",
    risk: "low",
    requested_by: "oe6-test",
    source_thought_id: "11111111-1111-4111-8111-111111111111",
    linked_action_item_id: "22222222-2222-4222-8222-222222222222",
  });

  assertEquals(record.agent_code, "dave-codex");
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
});

Deno.test("action-item promotion creates a conservative Standing draft packet", () => {
  const record = buildActionItemPromotionIntakeRecord({
    action_item: {
      id: "33333333-3333-4333-8333-333333333333",
      description: "Review the OE-6 manual action-item promotion path.",
      status: "open",
      source_thought_id: "44444444-4444-4444-8444-444444444444",
    },
    agent_code: "dave-codex",
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
  assertEquals(record.agent_code, "dave-codex");
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
  assertThrows(
    () =>
      assertNoActiveActionItemDraft(
        [{ id: "55555555-5555-4555-8555-555555555555", status: "Standing" }],
        "33333333-3333-4333-8333-333333333333",
      ),
    Error,
    "already has an active agent task draft",
  );

  assertNoActiveActionItemDraft(
    [{ id: "66666666-6666-4666-8666-666666666666", status: "Agent Review" }],
    "33333333-3333-4333-8333-333333333333",
  );
});
