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

const completeTask: AgentTask = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "[agent instructions][dave-codex][task] harmless scheduled smoke",
  status: "Agent Working",
  risk: "low",
  explicit_approval: false,
  desired_outcome: "Prove the scheduled Queue Runner can process one task.",
  do_steps: "Validate the task packet and write one completion receipt.",
  acceptance_criteria:
    "The runner stops after one task and updates the ledger.",
  boundaries:
    "No client data, deploys, deletes, credentials, billing, or WordPress.",
};

function ledger() {
  return { count: 1, ledger: [{ agent_code: "dave-codex" }] };
}

Deno.test("runner writes ledger and Slack summary when no low-risk task is available", async () => {
  const mcp = new FakeMcp({
    read_agent_ledger: [ledger()],
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
  assertEquals(messages.length, 1);
  assert(messages[0].includes("no eligible low-risk task"));
  assertEquals(
    mcp.calls.map((call) => call.name),
    ["read_agent_ledger", "claim_next_agent_task", "write_agent_ledger"],
  );
  assertEquals(mcp.calls[1].args.max_risk, "low");
});

Deno.test("runner completes exactly one low-risk task and stops", async () => {
  const mcp = new FakeMcp({
    read_agent_ledger: [ledger()],
    claim_next_agent_task: [{ receipt: "AGENT CLAIMED", task: completeTask }],
    get_agent_task: [{ task: completeTask, events: [] }],
    complete_agent_task: [{ receipt: "AGENT DONE", task: completeTask }],
    write_agent_ledger: [{}],
  });

  const result = await runQueueRunnerHeartbeat({ mcp, sendSlack: false });

  assertEquals(result.status, "completed");
  assertEquals(result.task_id, completeTask.id);
  assertEquals(result.receipt, "AGENT DONE");
  assertEquals(
    mcp.calls.map((call) => call.name),
    [
      "read_agent_ledger",
      "claim_next_agent_task",
      "get_agent_task",
      "complete_agent_task",
      "write_agent_ledger",
    ],
  );
  assertEquals(
    mcp.calls.filter((call) => call.name === "claim_next_agent_task").length,
    1,
  );
  assert(typeof mcp.calls[4].args.last_successful_run === "string");
});

Deno.test("runner blocks a claimed task above the low-risk cap", async () => {
  const task = { ...completeTask, risk: "high" as const };
  const mcp = new FakeMcp({
    read_agent_ledger: [ledger()],
    claim_next_agent_task: [{ receipt: "AGENT CLAIMED", task }],
    get_agent_task: [{ task, events: [] }],
    block_agent_task: [{ receipt: "AGENT BLOCKED", task }],
    write_agent_ledger: [{}],
  });

  const result = await runQueueRunnerHeartbeat({ mcp, sendSlack: false });

  assertEquals(result.status, "failed_after_claim");
  assertEquals(result.receipt, "AGENT BLOCKED");
  assert(String(mcp.calls[3].args.blocker).includes("refuses high-risk"));
});

Deno.test("runner blocks ambiguous claimed task packets", async () => {
  const task = { ...completeTask, acceptance_criteria: "" };
  const mcp = new FakeMcp({
    read_agent_ledger: [ledger()],
    claim_next_agent_task: [{ receipt: "AGENT CLAIMED", task }],
    get_agent_task: [{ task, events: [] }],
    block_agent_task: [{ receipt: "AGENT BLOCKED", task }],
    write_agent_ledger: [{}],
  });

  const result = await runQueueRunnerHeartbeat({ mcp, sendSlack: false });

  assertEquals(result.status, "blocked");
  assert(String(mcp.calls[3].args.blocker).includes("acceptance_criteria"));
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
  assertEquals(mcp.calls.length, 1);
  assert(messages[0].includes("MCP unavailable"));
});

Deno.test("Slack summary contains the final task result, not a pre-run notice", () => {
  const text = renderSlackSummary({
    status: "completed",
    agent_code: "dave-codex",
    task_id: completeTask.id,
    receipt: "AGENT DONE",
    summary: "Queue Runner completed task with AGENT DONE.",
    slack: { attempted: false, ok: false },
  });

  assert(text.includes("Open Engine Queue Runner: completed"));
  assert(text.includes(`task ${completeTask.id}`));
  assert(text.includes("AGENT DONE"));
});
