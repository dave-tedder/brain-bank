import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { buildAgentTaskIntakeRecord } from "./_agent_intake.ts";

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
