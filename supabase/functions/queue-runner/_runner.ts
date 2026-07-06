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

// Claim-and-hold contract (locked decision 2, 2026-07-02): the scheduled
// runner claims, validates the packet, and posts AGENT HUMAN HOLD. It never
// writes AGENT DONE — there is no executor on the scheduled path.
export interface QueueRunnerResult {
  status:
    | "no_task"
    | "held"
    | "blocked"
    | "failed_before_claim"
    | "failed_after_claim";
  agent_code: string;
  task_id: string | null;
  receipt: string;
  summary: string;
  reaped_count: number;
  open_holds: { needs_input: number; review: number };
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

interface ReapResponse {
  reaped_count: number;
  reaped: Array<Record<string, unknown>>;
}

interface ListTasksResponse {
  count: number;
  tasks: Array<{
    id: string;
    status: string;
    claimed_by?: string | null;
    agent_code?: string | null;
  }>;
}

const DEFAULT_AGENT_CODE = "local-codex";
const DEFAULT_PROJECT_PATH =
  "<local-brain-bank-checkout>";

export async function runQueueRunnerHeartbeat(
  options: QueueRunnerOptions,
): Promise<QueueRunnerResult> {
  const agentCode = options.agentCode ?? DEFAULT_AGENT_CODE;
  const maxRisk = options.maxRisk ?? "low";
  const projectPath = options.projectPath ?? DEFAULT_PROJECT_PATH;

  let reapedCount = 0;
  let openHolds = { needs_input: 0, review: 0 };
  let claimedTask: AgentTask | null = null;

  const base = () => ({
    agent_code: agentCode,
    reaped_count: reapedCount,
    open_holds: openHolds,
    slack: { attempted: false, ok: false },
  });

  try {
    const ledger = await options.mcp.callTool<LedgerResponse>(
      "read_agent_ledger",
      { agent_code: agentCode },
    );
    if (ledger.count !== 1) {
      return await finish(options, {
        ...base(),
        status: "failed_before_claim",
        task_id: null,
        receipt: "NO_RECEIPT",
        summary:
          `Queue Runner stopped before claim: expected one ledger row for ${agentCode}, found ${ledger.count}. No receipt was written.`,
      });
    }

    // Heartbeat step 4: release expired claims before touching new work, so
    // reaped tasks are back in Agent Todo (with an honest AGENT FAILED trail)
    // rather than stranded in Agent Working.
    const reap = await options.mcp.callTool<ReapResponse>(
      "release_expired_agent_claims",
      {},
    );
    reapedCount = reap.reaped_count ?? 0;

    // Heartbeat step 5: report this runtime's held/blocked and in-review work
    // before claiming anything new. The scheduled path has no executor, so it
    // reports for humans; it never resumes held work itself.
    const open = await options.mcp.callTool<ListTasksResponse>(
      "list_agent_tasks",
      { statuses: ["Agent Needs Input", "Agent Review"], limit: 50 },
    );
    const own = (open.tasks ?? []).filter((task) =>
      task.claimed_by === agentCode || task.agent_code === agentCode
    );
    openHolds = {
      needs_input: own.filter((task) => task.status === "Agent Needs Input")
        .length,
      review: own.filter((task) => task.status === "Agent Review").length,
    };

    const claim = await options.mcp.callTool<ClaimResponse>(
      "claim_next_agent_task",
      { agent_code: agentCode, max_risk: maxRisk },
    );
    if (claim.receipt === "NO_ELIGIBLE_TASK" || !claim.task) {
      const summary =
        `Queue Runner found no eligible ${maxRisk}-risk task for ${agentCode}. Reaped ${reapedCount} expired claim(s); ${openHolds.needs_input} held/blocked and ${openHolds.review} in-review task(s) are waiting on humans.`;
      await writeLedger(options.mcp, agentCode, summary, projectPath);
      return await finish(options, {
        ...base(),
        status: "no_task",
        task_id: null,
        receipt: "NO_ELIGIBLE_TASK",
        summary,
      });
    }
    claimedTask = claim.task;

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
        base,
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
        base,
      );
    }

    // Honest claim-and-hold: the packet is valid, but nothing executes here.
    // AGENT HUMAN HOLD moves the task to Agent Needs Input, which is stable
    // against the claim reaper (only Agent Working claims expire).
    const holdReason = renderHoldReceiptDraft(task, maxRisk);
    const held = await options.mcp.callTool<MoveResponse>(
      "hold_agent_task",
      {
        task_id: task.id,
        agent_code: agentCode,
        reason: holdReason,
      },
    );
    const summary =
      `Queue Runner claimed and held task ${task.id} with ${held.receipt}. Packet validated; no execution performed (the scheduled path has no executor). Waiting for a human or local runtime.`;
    await writeLedger(options.mcp, agentCode, summary, projectPath, task.id);
    return await finish(options, {
      ...base(),
      status: "held",
      task_id: task.id,
      receipt: held.receipt,
      summary,
    });
  } catch (err) {
    const message = (err as Error).message;
    if (claimedTask) {
      // Post-claim failure: write AGENT FAILED on the claimed task so it
      // returns to Agent Todo with attempt_count incremented, instead of
      // stranding it in Agent Working under a failed_before_claim label.
      try {
        const failed = await options.mcp.callTool<MoveResponse>(
          "fail_agent_task",
          {
            task_id: claimedTask.id,
            agent_code: agentCode,
            reason: `Scheduled Queue Runner failed after claim: ${message}`,
          },
        );
        const summary =
          `Queue Runner failed task ${claimedTask.id} after claim and returned it to Agent Todo with ${failed.receipt}: ${message}`;
        try {
          await writeLedger(
            options.mcp,
            agentCode,
            summary,
            projectPath,
            claimedTask.id,
          );
        } catch (_ledgerErr) {
          // Ledger update is best-effort on the failure path.
        }
        return await finish(options, {
          ...base(),
          status: "failed_after_claim",
          task_id: claimedTask.id,
          receipt: failed.receipt,
          summary,
        });
      } catch (failErr) {
        return await finish(options, {
          ...base(),
          status: "failed_after_claim",
          task_id: claimedTask.id,
          receipt: "NO_RECEIPT",
          summary:
            `Queue Runner failed after claim on task ${claimedTask.id} and could not write AGENT FAILED (${
              (failErr as Error).message
            }). Check the task's current status manually; if it is still Agent Working, the claim reaper recovers it after expiry. Original error: ${message}`,
        });
      }
    }
    return await finish(options, {
      ...base(),
      status: "failed_before_claim",
      task_id: null,
      receipt: "NO_RECEIPT",
      summary:
        `Queue Runner stopped on tool error before any claim: ${message}. No receipt was written.`,
    });
  }
}

// Producer side of the canonical 8-section OE-8 receipt contract. Any honest
// receipt draft the runner emits uses these headings in this order:
// Work summary / Verification / Touched files or records / Limitations /
// Tracker draft / Session-log draft / Brain Bank capture draft /
// Follow-up recommendation.
function renderHoldReceiptDraft(
  task: AgentTask,
  maxRisk: AgentTaskRisk,
): string {
  return [
    "Work summary:",
    `Scheduled Queue Runner claimed ${task.risk}-risk task ${task.id} (max_risk=${maxRisk}) and validated the task packet. No task execution was performed; the scheduled path has no executor.`,
    "",
    "Verification:",
    "Claimed through the guarded MCP path, re-read the task packet, confirmed desired_outcome, do_steps, acceptance_criteria, and boundaries are present, and posted this single hold receipt.",
    "",
    "Touched files or records:",
    `agent_tasks.id ${task.id}; agent_task_events via hold_agent_task; agent_task_ledger updated after the receipt. No project files or external systems were touched.`,
    "",
    "Limitations:",
    "Packet validation only. The acceptance criteria are NOT met and no work product exists yet.",
    "",
    "Tracker draft:",
    "No tracker change. Record an outcome only after a real executor completes the task and review passes.",
    "",
    "Session-log draft:",
    `Scheduled Queue Runner claimed and held task ${task.id} for human or local-runtime execution (AGENT HUMAN HOLD).`,
    "",
    "Brain Bank capture draft:",
    `Open Engine scheduled runner claimed and held task ${task.id}; capture a closeout only after an executed rep passes review.`,
    "",
    "Follow-up recommendation:",
    "A human or local runtime should answer or resume this task from Agent Needs Input, execute the packet, and post an honest AGENT DONE using the 8-section receipt contract.",
  ].join("\n");
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
  base: () => Pick<
    QueueRunnerResult,
    "agent_code" | "reaped_count" | "open_holds" | "slack"
  >,
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
    ...base(),
    status,
    task_id: task.id,
    receipt: blocked.receipt,
    summary,
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
      "OE-5 daily scheduled runner. Claim-and-hold contract: validates the packet and posts AGENT HUMAN HOLD; never writes AGENT DONE. One task max.",
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
    `Expired claims reaped: ${result.reaped_count}`,
    `Own open holds: ${result.open_holds.needs_input} needs-input, ${result.open_holds.review} in review`,
    result.summary,
  ].join("\n");
}
