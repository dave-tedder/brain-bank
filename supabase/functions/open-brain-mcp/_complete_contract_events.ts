// Loop-closing Task 5.4 follow-up (the operator's PR 32 decision 7): durable counts of
// complete-time refusals and warnings.
//
// moveAgentTaskViaTool prints one "[complete-contract] ..." line per refusal and
// per warning. Function logs expire, so each of those lines also gets one row
// in public.complete_contract_events (migration
// 20261121c_complete_contract_events.sql). The write is best-effort and off the
// critical path: writeContractEvent never throws and never rejects, and
// index.ts hands its promise to EdgeRuntime.waitUntil, so an insert that fails,
// rejects or throws is logged and can never change the tool's answer or block
// a completion.
//
// occurred_at is the moment the log line was emitted, taken in the function
// (correction 1 of PR 37). The insert runs later under waitUntil, so the
// database's own created_at can fall after the card's AGENT DONE repair or in
// the next UTC week; the weekly queries bucket and order by occurred_at.
//
// Pure apart from the injected insert and log functions, so it is unit-tested
// without the Edge Function (_complete_contract_events_test.ts).

export const COMPLETE_CONTRACT_EVENTS_TABLE = "complete_contract_events";

// The migration's CHECK on reason, character for character (a test reads the
// migration and asserts it carries this pattern). Reason codes joined by ','
// only: no receipt text, no free text.
export const CONTRACT_EVENT_REASON_PATTERN =
  "^[A-Z][A-Z0-9_]{0,63}(,[A-Z][A-Z0-9_]{0,63}){0,31}$";

export type ContractEventTool = "complete_agent_task" | "request_agent_review";
export type ContractEventAction = "complete" | "request-review";

export type ContractEventRow = {
  tool: ContractEventTool;
  task_id: string | null;
  agent_code: string | null;
  outcome: "refused" | "warned";
  reason: string;
  project_slug: string | null;
  occurred_at: string;
};

// The MCP tool behind each moveAgentTaskViaTool action that runs the contract.
// complete is only reached from complete_agent_task and request-review only
// from request_agent_review.
export function contractEventTool(action: ContractEventAction): ContractEventTool {
  return action === "request-review" ? "request_agent_review" : "complete_agent_task";
}

function slugOrNull(slug: string | null | undefined): string | null {
  const s = typeof slug === "string" ? slug.trim() : "";
  return s ? s : null;
}

function textOrNull(v: string | null | undefined): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// The row for one "[complete-contract] COMPLETE_REFUSED ... reasons=<a,b>" line:
// reason is the same comma-joined list the line prints.
export function refusalEventRow(args: {
  action: ContractEventAction;
  taskId: string | null | undefined;
  agentCode: string | null | undefined;
  slug: string | null | undefined;
  reasons: string[];
  occurredAt: Date;
}): ContractEventRow {
  return {
    tool: contractEventTool(args.action),
    task_id: textOrNull(args.taskId),
    agent_code: textOrNull(args.agentCode),
    outcome: "refused",
    reason: args.reasons.join(","),
    project_slug: slugOrNull(args.slug),
    occurred_at: args.occurredAt.toISOString(),
  };
}

// The row for one "[complete-contract] <CODE> task=... slug=..." warning line.
export function warningEventRow(args: {
  action: ContractEventAction;
  taskId: string | null | undefined;
  agentCode: string | null | undefined;
  slug: string | null | undefined;
  code: string;
  occurredAt: Date;
}): ContractEventRow {
  return {
    tool: contractEventTool(args.action),
    task_id: textOrNull(args.taskId),
    agent_code: textOrNull(args.agentCode),
    outcome: "warned",
    reason: args.code,
    project_slug: slugOrNull(args.slug),
    occurred_at: args.occurredAt.toISOString(),
  };
}

export type ContractEventInsertResult = {
  error?: { message?: string } | null;
} | null | undefined;
export type ContractEventInsert = (
  row: ContractEventRow,
) => PromiseLike<ContractEventInsertResult>;
export type ContractEventLog = (line: string) => void;

// Text for any thrown or returned value. Never throws: a value with no
// primitive conversion (Object.create(null)), or a message getter that throws,
// reads as a fixed placeholder instead of escaping the caller's guard.
export function describeError(err: unknown): string {
  try {
    if (err !== null && typeof err === "object" && "message" in err) {
      return String((err as { message?: unknown }).message);
    }
    return String(err);
  } catch {
    return "(error value could not be formatted)";
  }
}

// Insert one row. Resolves in every case, never rejects, never throws: an error
// result, a rejected promise and a synchronous throw from insert are each logged
// once as "[complete-contract] event write failed ..."; formatting the detail
// and calling the logger happen inside the same guard, so neither a value that
// cannot be formatted nor a failing logger escapes.
export function writeContractEvent(
  insert: ContractEventInsert,
  row: ContractEventRow,
  log: ContractEventLog = (line) => console.error(line),
): Promise<void> {
  const report = (detail: unknown) => {
    try {
      log(
        `[complete-contract] event write failed outcome=${row.outcome} reason=${row.reason} task=${row.task_id}: ${
          describeError(detail)
        }`,
      );
    } catch {
      // a failing logger must not turn a best-effort write into a thrown one
    }
  };
  try {
    return Promise.resolve(insert(row)).then(
      (result) => {
        try {
          const error = result ? result.error : null;
          if (error) report(error);
        } catch (err) {
          report(err);
        }
      },
      (err) => {
        report(err);
      },
    );
  } catch (err) {
    report(err);
    return Promise.resolve();
  }
}
