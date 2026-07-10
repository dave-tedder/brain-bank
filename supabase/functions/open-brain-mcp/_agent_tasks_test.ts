import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  AGENT_TASK_RECEIPTS,
  type AgentTaskAccessRow,
  assertAgentCanWriteTask,
  assertClaimAllowed,
  assertIntakePromotionAllowed,
  assertPromotionCallerAllowed,
  assertResumeTransitionAllowed,
  assertReviewApplyAllowed,
  assertStatusHeartbeatAllowed,
  assertWorkingExitAllowed,
  canAgentWriteTask,
  isAgentTaskRisk,
  isLedgerAutomationState,
  isReviewResolution,
  operatorTargetHasAllowedScheme,
  receiptForAppliedStatus,
  receiptForTaskTool,
} from "./_agent_tasks.ts";

const baseTask: AgentTaskAccessRow = {
  agent_code: "local-codex",
  claimed_by: "local-codex",
  risk: "medium",
  explicit_approval: false,
  status: "Agent Working",
};

Deno.test("task write guard allows claimed or assigned agent only", () => {
  assertEquals(canAgentWriteTask(baseTask, "local-codex"), true);
  assertEquals(
    canAgentWriteTask({ ...baseTask, claimed_by: null }, "local-codex"),
    true,
  );
  assertEquals(canAgentWriteTask(baseTask, "local-claude-code"), false);

  assertThrows(
    () => assertAgentCanWriteTask(baseTask, "local-claude-code"),
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

Deno.test("promotion caller guard requires a named human operator", () => {
  for (const value of [undefined, null, "", "   "]) {
    assertThrows(
      () => assertPromotionCallerAllowed(value, ["local-codex"]),
      Error,
      "requires promoted_by",
    );
  }
});

Deno.test("promotion caller guard rejects registered agent codes", () => {
  const codes = ["local-codex", "local-claude-code"];
  for (const value of ["local-codex", "LOCAL-CODEX", " local-claude-code "]) {
    assertThrows(
      () => assertPromotionCallerAllowed(value, codes),
      Error,
      "registered agent code",
    );
  }
});

Deno.test("promotion caller guard rejects runner self-identification", () => {
  for (
    const value of [
      "queue-runner",
      "Queue Runner",
      "queue_runner",
      "scheduled-runner",
      "automation",
      "cron",
      "bot",
      "agent",
    ]
  ) {
    assertThrows(
      () => assertPromotionCallerAllowed(value, []),
      Error,
      "cannot promote",
    );
  }
});

Deno.test("promotion caller guard passes human attributions", () => {
  const codes = ["local-codex", "local-claude-code"];
  assertPromotionCallerAllowed("Jane", codes);
  assertPromotionCallerAllowed("Jane Doe (Session 12, Claude Code)", codes);
  assertPromotionCallerAllowed("Jane via Codex parent session", codes);
  assertPromotionCallerAllowed("Jane", []);
});

Deno.test("review apply guard only allows Agent Review tasks", () => {
  assertReviewApplyAllowed({ ...baseTask, status: "Agent Review" });

  for (
    const status of [
      "Standing",
      "Agent Todo",
      "Agent Working",
      "Agent Needs Input",
      "Agent Done",
    ] as const
  ) {
    assertThrows(
      () => assertReviewApplyAllowed({ ...baseTask, status }),
      Error,
      "AGENT APPLIED requires Agent Review",
    );
  }
});

Deno.test("review resolution accepts only canonical OE-7 values", () => {
  assertEquals(isReviewResolution("accepted"), true);
  assertEquals(isReviewResolution("accepted_with_follow_up"), true);
  assertEquals(isReviewResolution("partial-follow-up"), false);
  assertEquals(isReviewResolution("rejected-needs-work"), false);
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
  assertEquals(receiptForTaskTool("hold"), {
    status: "Agent Needs Input",
    receipt: "AGENT HUMAN HOLD",
  });
  assertEquals(receiptForTaskTool("fail"), {
    status: "Agent Todo",
    receipt: "AGENT FAILED",
  });
});

Deno.test("hold and fail tools only allow Agent Working tasks out", () => {
  assertWorkingExitAllowed(baseTask, "hold");
  assertWorkingExitAllowed(baseTask, "fail");

  for (
    const status of [
      "Standing",
      "Agent Todo",
      "Agent Needs Input",
      "Agent Review",
      "Agent Done",
    ] as const
  ) {
    assertThrows(
      () => assertWorkingExitAllowed({ ...baseTask, status }, "hold"),
      Error,
      "AGENT HUMAN HOLD requires Agent Working",
    );
    assertThrows(
      () => assertWorkingExitAllowed({ ...baseTask, status }, "fail"),
      Error,
      "AGENT FAILED requires Agent Working",
    );
  }
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

Deno.test("receipt allowlist includes OE-11 Needs Dave board event types", () => {
  assertEquals(AGENT_TASK_RECEIPTS.includes("AGENT NEEDS DAVE"), true);
  assertEquals(AGENT_TASK_RECEIPTS.includes("OPERATOR DONE"), true);
});

Deno.test("apply receipt follows returned task status", () => {
  assertEquals(receiptForAppliedStatus("Agent Done"), "AGENT APPLIED");
  assertEquals(receiptForAppliedStatus("Needs Dave"), "AGENT NEEDS DAVE");
});

Deno.test("operator target allows http(s) schemes and rejects unsafe schemes", () => {
  assertEquals(operatorTargetHasAllowedScheme("https://example.com"), true);
  assertEquals(operatorTargetHasAllowedScheme("http://example.com"), true);
  assertEquals(
    operatorTargetHasAllowedScheme("deliverables/notes/file.md"),
    true,
  );
  assertEquals(operatorTargetHasAllowedScheme("/home/operator/file.md"), true);
  assertEquals(operatorTargetHasAllowedScheme("javascript:alert(1)"), false);
  assertEquals(operatorTargetHasAllowedScheme("data:text/html,test"), false);
  assertEquals(operatorTargetHasAllowedScheme("//evil.com/phish"), false);
  assertEquals(operatorTargetHasAllowedScheme("  //evil.com"), false);
});
