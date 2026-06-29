import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  type AgentTaskAccessRow,
  assertAgentCanWriteTask,
  assertClaimAllowed,
  assertIntakePromotionAllowed,
  assertResumeTransitionAllowed,
  assertStatusHeartbeatAllowed,
  canAgentWriteTask,
  isAgentTaskRisk,
  isLedgerAutomationState,
  receiptForTaskTool,
} from "./_agent_tasks.ts";

const baseTask: AgentTaskAccessRow = {
  agent_code: "dave-codex",
  claimed_by: "dave-codex",
  risk: "medium",
  explicit_approval: false,
  status: "Agent Working",
};

Deno.test("task write guard allows claimed or assigned agent only", () => {
  assertEquals(canAgentWriteTask(baseTask, "dave-codex"), true);
  assertEquals(
    canAgentWriteTask({ ...baseTask, claimed_by: null }, "dave-codex"),
    true,
  );
  assertEquals(canAgentWriteTask(baseTask, "dave-claude-code"), false);

  assertThrows(
    () => assertAgentCanWriteTask(baseTask, "dave-claude-code"),
    Error,
    "claimed or tasks assigned",
  );
});

Deno.test("claim guard fails high-risk tasks without explicit approval", () => {
  assertThrows(
    () =>
      assertClaimAllowed({
        ...baseTask,
        risk: "high",
        explicit_approval: false,
      }),
    Error,
    "explicit approval",
  );

  assertClaimAllowed({ ...baseTask, risk: "high", explicit_approval: true });
});

Deno.test("status heartbeat guard only allows active working tasks", () => {
  assertStatusHeartbeatAllowed(baseTask);

  for (const status of ["Agent Needs Input", "Agent Review"] as const) {
    assertThrows(
      () => assertStatusHeartbeatAllowed({ ...baseTask, status }),
      Error,
      "only allowed while the task is Agent Working",
    );
  }
});

Deno.test("intake promotion guard only allows Standing drafts", () => {
  assertIntakePromotionAllowed({ ...baseTask, status: "Standing" });

  for (
    const status of [
      "Agent Todo",
      "Agent Working",
      "Agent Needs Input",
      "Agent Review",
      "Agent Done",
    ] as const
  ) {
    assertThrows(
      () => assertIntakePromotionAllowed({ ...baseTask, status }),
      Error,
      "Only Standing intake drafts",
    );
  }
});

Deno.test("task tool actions map to canonical receipts", () => {
  assertEquals(receiptForTaskTool("update"), {
    status: "Agent Working",
    receipt: "AGENT STATUS",
  });
  assertEquals(receiptForTaskTool("complete"), {
    status: "Agent Review",
    receipt: "AGENT DONE",
  });
  assertEquals(receiptForTaskTool("block"), {
    status: "Agent Needs Input",
    receipt: "AGENT BLOCKED",
  });
  assertEquals(receiptForTaskTool("request-review"), {
    status: "Agent Review",
    receipt: "AGENT DONE",
  });
  assertEquals(receiptForTaskTool("resume"), {
    status: "Agent Working",
    receipt: "AGENT RESUMED",
  });
  assertEquals(receiptForTaskTool("unblock"), {
    status: "Agent Working",
    receipt: "AGENT UNBLOCKED",
  });
  assertEquals(receiptForTaskTool("answer"), {
    status: "Agent Working",
    receipt: "AGENT HUMAN ANSWERED",
  });
});

Deno.test("ledger writes accept only canonical automation states", () => {
  assertEquals(isLedgerAutomationState("manual-required"), true);
  assertEquals(isLedgerAutomationState("paused"), true);
  assertEquals(isLedgerAutomationState("autonomous-now"), false);
});

Deno.test("claim risk caps accept only canonical risk tiers", () => {
  assertEquals(isAgentTaskRisk("low"), true);
  assertEquals(isAgentTaskRisk("medium"), true);
  assertEquals(isAgentTaskRisk("high"), true);
  assertEquals(isAgentTaskRisk("urgent"), false);
});

Deno.test("resume tools only allow blocked or review work back to working", () => {
  assertResumeTransitionAllowed(
    { ...baseTask, status: "Agent Needs Input" },
    "resume",
  );
  assertResumeTransitionAllowed(
    { ...baseTask, status: "Agent Review" },
    "resume",
  );
  assertResumeTransitionAllowed(
    { ...baseTask, status: "Agent Needs Input" },
    "unblock",
  );
  assertResumeTransitionAllowed(
    { ...baseTask, status: "Agent Needs Input" },
    "answer",
  );

  assertThrows(
    () => assertResumeTransitionAllowed(baseTask, "resume"),
    Error,
    "requires Agent Needs Input or Agent Review",
  );
  assertThrows(
    () =>
      assertResumeTransitionAllowed(
        { ...baseTask, status: "Agent Review" },
        "unblock",
      ),
    Error,
    "requires Agent Needs Input",
  );
  assertThrows(
    () =>
      assertResumeTransitionAllowed(
        { ...baseTask, status: "Agent Review" },
        "answer",
      ),
    Error,
    "requires Agent Needs Input",
  );
});
