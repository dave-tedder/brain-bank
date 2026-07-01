export type AgentTaskRisk = "low" | "medium" | "high";

export interface AgentTask {
  id: string;
  title: string;
  status: string;
  risk: AgentTaskRisk;
  explicit_approval: boolean;
  desired_outcome?: string | null;
  do_steps?: string | null;
  acceptance_criteria?: string | null;
  boundaries?: string | null;
}

export interface ToolClient {
  callTool<T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T>;
}

export interface SlackClient {
  post(text: string): Promise<{ ok: boolean; error?: string }>;
}

export interface QueueRunnerOptions {
  agentCode?: string;
  maxRisk?: AgentTaskRisk;
  projectPath?: string;
  mcp: ToolClient;
  slack?: SlackClient;
  sendSlack?: boolean;
}

export interface QueueRunnerResult {
  status:
    | "no_task"
    | "completed"
    | "blocked"
    | "failed_before_claim"
    | "failed_after_claim";
  agent_code: string;
  task_id: string | null;
  receipt: string;
  summary: string;
  slack: { attempted: boolean; ok: boolean; error?: string };
}

interface LedgerResponse {
  count: number;
  ledger: Array<Record<string, unknown>>;
}

interface ClaimResponse {
  receipt: "AGENT CLAIMED" | "NO_ELIGIBLE_TASK" | string;
  task: AgentTask | null;
}

interface MoveResponse {
  receipt: string;
  task?: AgentTask;
}

interface GetTaskResponse {
  task: AgentTask;
  events: Array<Record<string, unknown>>;
}

const DEFAULT_AGENT_CODE = "local-codex";
const DEFAULT_PROJECT_PATH = "<local-brain-bank-checkout>";

export async function runQueueRunnerHeartbeat(
  options: QueueRunnerOptions,
): Promise<QueueRunnerResult> {
  const agentCode = options.agentCode ?? DEFAULT_AGENT_CODE;
  const maxRisk = options.maxRisk ?? "low";
  const projectPath = options.projectPath ?? DEFAULT_PROJECT_PATH;

  try {
    const ledger = await options.mcp.callTool<LedgerResponse>(
      "read_agent_ledger",
      { agent_code: agentCode },
    );
    if (ledger.count !== 1) {
      return await finish(options, {
        status: "failed_before_claim",
        agent_code: agentCode,
        task_id: null,
        receipt: "AGENT BLOCKED",
        summary:
          `Queue Runner stopped before claim: expected one ledger row for ${agentCode}, found ${ledger.count}.`,
        slack: { attempted: false, ok: false },
      });
    }

    const claim = await options.mcp.callTool<ClaimResponse>(
      "claim_next_agent_task",
      { agent_code: agentCode, max_risk: maxRisk },
    );
    if (claim.receipt === "NO_ELIGIBLE_TASK" || !claim.task) {
      const summary =
        `Queue Runner found no eligible ${maxRisk}-risk task for ${agentCode}.`;
      await writeLedger(options.mcp, agentCode, summary, projectPath);
      return await finish(options, {
        status: "no_task",
        agent_code: agentCode,
        task_id: null,
        receipt: "NO_ELIGIBLE_TASK",
        summary,
        slack: { attempted: false, ok: false },
      });
    }

    const reloaded = await options.mcp.callTool<GetTaskResponse>(
      "get_agent_task",
      { task_id: claim.task.id },
    );
    const task = reloaded.task;
    const riskProblem = validateRisk(task, maxRisk);
    if (riskProblem) {
      return await blockClaimedTask(
        options,
        agentCode,
        projectPath,
        task,
        riskProblem,
        "failed_after_claim",
      );
    }

    const ambiguity = validateTaskPacket(task);
    if (ambiguity) {
      return await blockClaimedTask(
        options,
        agentCode,
        projectPath,
        task,
        ambiguity,
        "blocked",
      );
    }

    const result =
      `Scheduled Queue Runner completed one supported low-risk heartbeat task. Verification: claimed through MCP with max_risk=${maxRisk}, re-read task packet, validated required fields, and stopped after this one receipt.`;
    const completed = await options.mcp.callTool<MoveResponse>(
      "complete_agent_task",
      {
        task_id: task.id,
        agent_code: agentCode,
        result,
      },
    );
    const summary =
      `Queue Runner completed task ${task.id} with ${completed.receipt}.`;
    await writeLedger(options.mcp, agentCode, summary, projectPath, task.id);
    return await finish(options, {
      status: "completed",
      agent_code: agentCode,
      task_id: task.id,
      receipt: completed.receipt,
      summary,
      slack: { attempted: false, ok: false },
    });
  } catch (err) {
    return await finish(options, {
      status: "failed_before_claim",
      agent_code: agentCode,
      task_id: null,
      receipt: "AGENT BLOCKED",
      summary: `Queue Runner stopped on tool error: ${(err as Error).message}`,
      slack: { attempted: false, ok: false },
    });
  }
}

function riskRank(risk: AgentTaskRisk): number {
  return risk === "low" ? 1 : risk === "medium" ? 2 : 3;
}

function validateRisk(task: AgentTask, maxRisk: AgentTaskRisk): string | null {
  if (riskRank(task.risk) > riskRank(maxRisk)) {
    return `Scheduled Queue Runner refuses ${task.risk}-risk task ${task.id}; max risk is ${maxRisk}.`;
  }
  if (task.risk === "high" && task.explicit_approval !== true) {
    return `Scheduled Queue Runner refuses high-risk task ${task.id} without explicit approval.`;
  }
  return null;
}

function validateTaskPacket(task: AgentTask): string | null {
  const missing = [
    ["desired_outcome", task.desired_outcome],
    ["do_steps", task.do_steps],
    ["acceptance_criteria", task.acceptance_criteria],
    ["boundaries", task.boundaries],
  ].filter(([, value]) => !String(value ?? "").trim()).map(([field]) => field);

  if (missing.length > 0) {
    return `Scheduled Queue Runner needs a complete task packet before execution. Missing: ${
      missing.join(", ")
    }.`;
  }

  return null;
}

async function blockClaimedTask(
  options: QueueRunnerOptions,
  agentCode: string,
  projectPath: string,
  task: AgentTask,
  blocker: string,
  status: QueueRunnerResult["status"],
): Promise<QueueRunnerResult> {
  const blocked = await options.mcp.callTool<MoveResponse>(
    "block_agent_task",
    {
      task_id: task.id,
      agent_code: agentCode,
      blocker,
    },
  );
  const summary =
    `Queue Runner blocked task ${task.id} with ${blocked.receipt}: ${blocker}`;
  await writeLedger(options.mcp, agentCode, summary, projectPath, task.id);
  return await finish(options, {
    status,
    agent_code: agentCode,
    task_id: task.id,
    receipt: blocked.receipt,
    summary,
    slack: { attempted: false, ok: false },
  });
}

async function writeLedger(
  mcp: ToolClient,
  agentCode: string,
  result: string,
  projectPath: string,
  taskId?: string,
): Promise<void> {
  await mcp.callTool("write_agent_ledger", {
    agent_code: agentCode,
    automation_state: "installed",
    last_queue_result: result,
    last_successful_run: new Date().toISOString(),
    local_context: taskId ? `${projectPath} | task ${taskId}` : projectPath,
    notes:
      "OE-5 daily scheduled runner. One task max. Seven clean days required before frequency increase.",
  });
}

async function finish(
  options: QueueRunnerOptions,
  result: QueueRunnerResult,
): Promise<QueueRunnerResult> {
  if (!options.sendSlack || !options.slack) {
    return { ...result, slack: { attempted: false, ok: false } };
  }
  const slack = await options.slack.post(renderSlackSummary(result));
  return { ...result, slack: { attempted: true, ...slack } };
}

export function renderSlackSummary(result: QueueRunnerResult): string {
  const task = result.task_id ? `task ${result.task_id}` : "no task";
  return [
    `Open Engine Queue Runner: ${result.status}`,
    `Runtime: ${result.agent_code}`,
    `Receipt: ${result.receipt}`,
    `Target: ${task}`,
    result.summary,
  ].join("\n");
}
