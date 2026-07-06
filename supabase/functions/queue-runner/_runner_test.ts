import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  type AgentTask,
  renderSlackSummary,
  runQueueRunnerHeartbeat,
  type ToolClient,
} from "./_runner.ts";

class FakeMcp implements ToolClient {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  private responses: Record<string, unknown[]>;

  constructor(responses: Record<string, unknown[]>) {
    this.responses = responses;
  }

  async callTool<T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    this.calls.push({ name, args });
    const queue = this.responses[name] ?? [];
    if (queue.length === 0) {
      throw new Error(`unexpected tool call: ${name}`);
    }
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next as T;
  }
}

const RECEIPT_HEADINGS = [
  "Work summary:",
  "Verification:",
  "Touched files or records:",
  "Limitations:",
  "Tracker draft:",
  "Session-log draft:",
  "Brain Bank capture draft:",
  "Follow-up recommendation:",
];

const validTask: AgentTask = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "[agent instructions][local-codex][task] harmless scheduled smoke",
  status: "Agent Working",
  risk: "low",
  explicit_approval: false,
  desired_outcome: "Prove the scheduled Queue Runner can process one task.",
  do_steps: "Validate the task packet and hold for a real executor.",
  acceptance_criteria:
    "The runner stops after one task and updates the ledger.",
  boundaries:
    "No client data, deploys, deletes, credentials, billing, or WordPress.",
};

function ledger() {
  return { count: 1, ledger: [{ agent_code: "local-codex" }] };
}

function noReap() {
  return { reaped_count: 0, reaped: [] };
}

function noOpenTasks() {
  return { count: 0, tasks: [] };
}

Deno.test("runner reaps, reports holds, and writes ledger when no task is available", async () => {
  const mcp = new FakeMcp({
    read_agent_ledger: [ledger()],
    release_expired_agent_claims: [{
      reaped_count: 1,
      reaped: [{ reaped_task_id: "00000000-0000-4000-8000-00000000000a" }],
    }],
    list_agent_tasks: [{
      count: 3,
      tasks: [
        {
          id: "00000000-0000-4000-8000-00000000000b",
          status: "Agent Needs Input",
          claimed_by: "local-codex",
        },
        {
          id: "00000000-0000-4000-8000-00000000000c",
          status: "Agent Review",
          claimed_by: null,
          agent_code: "local-codex",
        },
        {
          id: "00000000-0000-4000-8000-00000000000d",
          status: "Agent Needs Input",
          claimed_by: "someone-else",
          agent_code: null,
        },
      ],
    }],
    claim_next_agent_task: [{ receipt: "NO_ELIGIBLE_TASK", task: null }],
    write_agent_ledger: [{}],
  });
  const messages: string[] = [];

  const result = await runQueueRunnerHeartbeat({
    mcp,
    sendSlack: true,
    slack: {
      post: (text) => {
        messages.push(text);
        return Promise.resolve({ ok: true });
      },
    },
  });

  assertEquals(result.status, "no_task");
  assertEquals(result.receipt, "NO_ELIGIBLE_TASK");
  assertEquals(result.reaped_count, 1);
  assertEquals(result.open_holds, { needs_input: 1, review: 1 });
  assertEquals(messages.length, 1);
  assert(messages[0].includes("no eligible low-risk task"));
  assert(messages[0].includes("Expired claims reaped: 1"));
  assert(messages[0].includes("Own open holds: 1 needs-input, 1 in review"));
  assertEquals(
    mcp.calls.map((call) => call.name),
    [
      "read_agent_ledger",
      "release_expired_agent_claims",
      "list_agent_tasks",
      "claim_next_agent_task",
      "write_agent_ledger",
    ],
  );
  assertEquals(mcp.calls[3].args.max_risk, "low");
  const listArgs = mcp.calls[2].args;
  assertEquals(listArgs.statuses, ["Agent Needs Input", "Agent Review"]);
});

Deno.test("runner claims exactly one task, holds it honestly, and never writes AGENT DONE", async () => {
  const mcp = new FakeMcp({
    read_agent_ledger: [ledger()],
    release_expired_agent_claims: [noReap()],
    list_agent_tasks: [noOpenTasks()],
    claim_next_agent_task: [{ receipt: "AGENT CLAIMED", task: validTask }],
    get_agent_task: [{ task: validTask, events: [] }],
    hold_agent_task: [{ receipt: "AGENT HUMAN HOLD", task: validTask }],
    write_agent_ledger: [{}],
  });

  const result = await runQueueRunnerHeartbeat({ mcp, sendSlack: false });

  assertEquals(result.status, "held");
  assertEquals(result.task_id, validTask.id);
  assertEquals(result.receipt, "AGENT HUMAN HOLD");
  assertEquals(
    mcp.calls.map((call) => call.name),
    [
      "read_agent_ledger",
      "release_expired_agent_claims",
      "list_agent_tasks",
      "claim_next_agent_task",
      "get_agent_task",
      "hold_agent_task",
      "write_agent_ledger",
    ],
  );
  assertEquals(
    mcp.calls.filter((call) => call.name === "complete_agent_task").length,
    0,
  );
  assertEquals(
    mcp.calls.filter((call) => call.name === "claim_next_agent_task").length,
    1,
  );
  const holdCall = mcp.calls.find((call) => call.name === "hold_agent_task")!;
  const holdReason = String(holdCall.args.reason);
  for (const heading of RECEIPT_HEADINGS) {
    assert(
      holdReason.includes(heading),
      `hold receipt draft is missing heading: ${heading}`,
    );
  }
  assert(holdReason.includes("No task execution was performed"));
  assert(result.summary.includes("claimed and held"));
  assert(!result.summary.includes("completed"));
  const ledgerCall = mcp.calls.find((call) =>
    call.name === "write_agent_ledger"
  )!;
  assert(
    String(ledgerCall.args.last_queue_result).includes("claimed and held"),
  );
  assert(typeof ledgerCall.args.last_successful_run === "string");
});

Deno.test("runner blocks a claimed task above the low-risk cap", async () => {
  const task = { ...validTask, risk: "high" as const };
  const mcp = new FakeMcp({
    read_agent_ledger: [ledger()],
    release_expired_agent_claims: [noReap()],
    list_agent_tasks: [noOpenTasks()],
    claim_next_agent_task: [{ receipt: "AGENT CLAIMED", task }],
    get_agent_task: [{ task, events: [] }],
    block_agent_task: [{ receipt: "AGENT BLOCKED", task }],
    write_agent_ledger: [{}],
  });

  const result = await runQueueRunnerHeartbeat({ mcp, sendSlack: false });

  assertEquals(result.status, "failed_after_claim");
  assertEquals(result.receipt, "AGENT BLOCKED");
  const blockCall = mcp.calls.find((call) => call.name === "block_agent_task")!;
  assert(String(blockCall.args.blocker).includes("refuses high-risk"));
});

Deno.test("runner blocks ambiguous claimed task packets", async () => {
  const task = { ...validTask, acceptance_criteria: "" };
  const mcp = new FakeMcp({
    read_agent_ledger: [ledger()],
    release_expired_agent_claims: [noReap()],
    list_agent_tasks: [noOpenTasks()],
    claim_next_agent_task: [{ receipt: "AGENT CLAIMED", task }],
    get_agent_task: [{ task, events: [] }],
    block_agent_task: [{ receipt: "AGENT BLOCKED", task }],
    write_agent_ledger: [{}],
  });

  const result = await runQueueRunnerHeartbeat({ mcp, sendSlack: false });

  assertEquals(result.status, "blocked");
  const blockCall = mcp.calls.find((call) => call.name === "block_agent_task")!;
  assert(String(blockCall.args.blocker).includes("acceptance_criteria"));
});

Deno.test("runner stops before claim when required tools are unavailable", async () => {
  const mcp = new FakeMcp({
    read_agent_ledger: [new Error("MCP unavailable")],
  });
  const messages: string[] = [];

  const result = await runQueueRunnerHeartbeat({
    mcp,
    sendSlack: true,
    slack: {
      post: (text) => {
        messages.push(text);
        return Promise.resolve({ ok: true });
      },
    },
  });

  assertEquals(result.status, "failed_before_claim");
  assertEquals(result.receipt, "NO_RECEIPT");
  assertEquals(mcp.calls.length, 1);
  assert(messages[0].includes("MCP unavailable"));
});

Deno.test("runner writes AGENT FAILED on the claimed task when a post-claim step dies", async () => {
  const mcp = new FakeMcp({
    read_agent_ledger: [ledger()],
    release_expired_agent_claims: [noReap()],
    list_agent_tasks: [noOpenTasks()],
    claim_next_agent_task: [{ receipt: "AGENT CLAIMED", task: validTask }],
    get_agent_task: [new Error("task reload failed")],
    fail_agent_task: [{ receipt: "AGENT FAILED", task: validTask }],
    write_agent_ledger: [{}],
  });

  const result = await runQueueRunnerHeartbeat({ mcp, sendSlack: false });

  assertEquals(result.status, "failed_after_claim");
  assertEquals(result.task_id, validTask.id);
  assertEquals(result.receipt, "AGENT FAILED");
  const failCall = mcp.calls.find((call) => call.name === "fail_agent_task")!;
  assertEquals(failCall.args.task_id, validTask.id);
  assert(String(failCall.args.reason).includes("task reload failed"));
  assert(result.summary.includes("returned it to Agent Todo"));
});

Deno.test("runner reports honestly when even the AGENT FAILED write dies", async () => {
  const mcp = new FakeMcp({
    read_agent_ledger: [ledger()],
    release_expired_agent_claims: [noReap()],
    list_agent_tasks: [noOpenTasks()],
    claim_next_agent_task: [{ receipt: "AGENT CLAIMED", task: validTask }],
    get_agent_task: [new Error("task reload failed")],
    fail_agent_task: [new Error("fail write also failed")],
  });

  const result = await runQueueRunnerHeartbeat({ mcp, sendSlack: false });

  assertEquals(result.status, "failed_after_claim");
  assertEquals(result.receipt, "NO_RECEIPT");
  assert(result.summary.includes("could not write AGENT FAILED"));
  assert(result.summary.includes("task reload failed"));
});

Deno.test("Slack summary carries the honest hold result and heartbeat counters", () => {
  const text = renderSlackSummary({
    status: "held",
    agent_code: "local-codex",
    task_id: validTask.id,
    receipt: "AGENT HUMAN HOLD",
    summary:
      "Queue Runner claimed and held task with AGENT HUMAN HOLD. Packet validated; no execution performed.",
    reaped_count: 2,
    open_holds: { needs_input: 1, review: 0 },
    slack: { attempted: false, ok: false },
  });

  assert(text.includes("Open Engine Queue Runner: held"));
  assert(text.includes(`task ${validTask.id}`));
  assert(text.includes("AGENT HUMAN HOLD"));
  assert(text.includes("Expired claims reaped: 2"));
  assert(text.includes("Own open holds: 1 needs-input, 0 in review"));
  assert(!text.includes("AGENT DONE"));
});
