import {
  AGENT_TASK_STATUSES,
  formatTaskAge,
  taskStatusColor,
  type AgentTaskEvent,
  type AgentRuntime,
  type AgentTask,
  type AgentTaskStatus,
} from "@/lib/agent-tasks";
import {
  isGenericStatusMoveDisabled,
  shouldShowLinkedActionResolutionControl,
  shouldShowReviewApplyControls,
} from "@/lib/agent-task-review-controls";
import {
  applyReviewedTask,
  completeOperatorAction,
  createFollowUpDraft,
  moveAgentTaskStatus,
  promoteAgentTaskIntake,
  updateAgentTask,
} from "@/app/tasks/actions";

interface Props {
  task: AgentTask;
  events: AgentTaskEvent[];
  runtimes: AgentRuntime[];
  currentPath: string;
  stagger?: number;
}

export default function AgentTaskCard({
  task,
  events,
  runtimes,
  currentPath,
  stagger = 0,
}: Props) {
  const color = taskStatusColor(task.status);
  const approvalNeeded = task.risk === "high" && !task.explicit_approval;

  return (
    <article
      className={`card scanline-hover border-l-2 animate-in stagger-${Math.min(stagger, 8)}`}
      style={{ borderLeftColor: color }}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="font-terminal text-xl text-[var(--text-primary)]">
            {task.title}
          </h2>
          <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)] mt-1">
            [{task.status}] · {task.agent_code ?? "unassigned"} · risk {task.risk} · priority {task.priority} · {formatTaskAge(task.updated_at)}
          </div>
        </div>
        <div className="text-right text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
          {task.project_slug && <div>{task.project_slug}</div>}
          {task.intake_source && <div>{task.intake_source}</div>}
        </div>
      </div>

      {approvalNeeded && (
        <div className="mt-3 border border-[var(--warning)] bg-[rgba(251,191,36,0.06)] px-3 py-2 text-xs font-mono text-[var(--warning)]">
          HIGH RISK :: explicit approval required before Agent Working
        </div>
      )}

      {task.status === "Standing" && (
        <form
          action={promoteAgentTaskIntake}
          className="mt-3 border border-[var(--border)] bg-[rgba(95,247,157,0.05)] px-3 py-3"
        >
          <input type="hidden" name="task_id" value={task.id} />
          <input type="hidden" name="redirect_path" value={currentPath} />
          <div className="grid grid-cols-1 md:grid-cols-[minmax(8rem,12rem)_1fr_auto] gap-2">
            <input
              name="promoted_by"
              defaultValue={task.requested_by ?? "dashboard"}
              aria-label="promoted by"
              className="task-input h-9 text-[10px]"
            />
            <input
              name="promotion_note"
              aria-label="promotion note"
              placeholder="human promotion note"
              className="task-input h-9 text-[10px]"
            />
            <button type="submit" className="task-button">
              [PROMOTE TO TODO]
            </button>
          </div>
        </form>
      )}

      <p className="mt-4 text-sm font-mono text-[var(--text-body)] whitespace-pre-wrap">
        {task.desired_outcome}
      </p>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs font-mono">
        <Packet label="context" value={task.context} />
        <Packet label="do" value={task.do_steps} />
        <Packet label="acceptance" value={task.acceptance_criteria} />
        <Packet label="handoff" value={task.output_handoff} />
        <Packet label="boundaries" value={task.boundaries} />
        <Packet label="reason" value={task.blocked_reason ?? task.review_reason ?? task.last_failure_reason} />
      </div>

      {task.status === "Needs Operator" ? (
        <NeedsOperatorPanel task={task} currentPath={currentPath} />
      ) : (
        <div className="mt-4 flex gap-2 flex-wrap">
          {AGENT_TASK_STATUSES.map((status) =>
            // "Needs Operator" is never a generic move target — the only routes in
            // are the apply gate (operator_action) and the backfill seed; the
            // only routes out are Mark done / MCP reroute.
            status === "Needs Operator" ||
            (task.status === "Agent Review" && status === "Agent Done") ? null : (
              <StatusButton
                key={status}
                task={task}
                target={status}
                currentPath={currentPath}
                disabled={isGenericStatusMoveDisabled({
                  currentStatus: task.status,
                  targetStatus: status,
                  approvalNeeded,
                })}
              />
            )
          )}
        </div>
      )}

      {shouldShowReviewApplyControls(task.status) && (
        <ReviewApplyControls task={task} currentPath={currentPath} />
      )}

      {events.length > 0 && (
        <div className="mt-4 border-t border-[var(--border)] pt-3">
          <h3 className="font-terminal text-sm uppercase tracking-wider text-[var(--text-muted)]">
            receipt history
          </h3>
          <div className="mt-2 space-y-2">
            {events.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </div>
        </div>
      )}

      <details className="mt-4 border-t border-[var(--border)] pt-3">
        <summary className="cursor-pointer font-terminal text-sm uppercase tracking-wider text-[var(--text-muted)]">
          edit packet
        </summary>
        <form action={updateAgentTask} className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
          <input type="hidden" name="task_id" value={task.id} />
          <Field name="title" label="title" defaultValue={task.title} required />
          <label className="space-y-1">
            <span className="label">agent</span>
            <select name="agent_code" defaultValue={task.agent_code ?? ""} className="task-input">
              <option value="">unassigned</option>
              {runtimes.map((runtime) => (
                <option key={runtime.agent_code} value={runtime.agent_code}>
                  {runtime.agent_code}
                </option>
              ))}
            </select>
          </label>
          <Field name="project_slug" label="project slug" defaultValue={task.project_slug ?? ""} />
          <Field name="requested_by" label="requested by" defaultValue={task.requested_by ?? ""} />
          <Field name="intake_source" label="intake source" defaultValue={task.intake_source ?? ""} />
          <Select name="priority" label="priority" defaultValue={task.priority} />
          <Select name="risk" label="risk" defaultValue={task.risk} />
          <label className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-[var(--text-muted)] md:col-span-2">
            <input name="explicit_approval" type="checkbox" defaultChecked={task.explicit_approval} />
            explicit approval for high-risk work
          </label>
          <Textarea name="desired_outcome" label="desired outcome" defaultValue={task.desired_outcome} required />
          <Textarea name="context" label="context" defaultValue={task.context ?? ""} />
          <Textarea name="do_steps" label="do steps" defaultValue={task.do_steps ?? ""} />
          <Textarea name="acceptance_criteria" label="acceptance criteria" defaultValue={task.acceptance_criteria ?? ""} />
          <Textarea name="output_handoff" label="output handoff" defaultValue={task.output_handoff ?? ""} />
          <Textarea name="boundaries" label="boundaries" defaultValue={task.boundaries ?? ""} />
          <Textarea name="sources" label="sources json array" defaultValue={JSON.stringify(task.sources ?? [])} />
          <div className="md:col-span-2">
            <button type="submit" className="task-button">
              [SAVE PACKET]
            </button>
          </div>
        </form>
      </details>
    </article>
  );
}

function ReviewApplyControls({
  task,
  currentPath,
}: {
  task: AgentTask;
  currentPath: string;
}) {
  const showLinkedResolve = shouldShowLinkedActionResolutionControl(task);

  return (
    <div className="mt-4 border border-[var(--phosphor-glow)] bg-[rgba(95,247,157,0.05)] px-3 py-3">
      <h3 className="font-terminal text-sm uppercase tracking-wider text-[var(--text-primary)]">
        review apply
      </h3>

      <form action={applyReviewedTask} className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
        <input type="hidden" name="task_id" value={task.id} />
        <input type="hidden" name="redirect_path" value={currentPath} />
        <input type="hidden" name="resolution" value="accepted" />
        <input type="hidden" name="applied_by" value="dashboard" />
        <Field name="note" label="apply note" defaultValue="" />
        {showLinkedResolve && (
          <label className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-[var(--text-muted)]">
            <input name="resolve_linked_action_item" type="checkbox" />
            resolve linked action item
          </label>
        )}
        <Textarea name="work_summary" label="work summary" defaultValue="" />
        <Textarea name="verification" label="verification" defaultValue="" />
        <Textarea name="touched_files_or_records" label="touched files or records" defaultValue="" />
        <Textarea name="tracker_draft" label="tracker draft" defaultValue="" />
        <Textarea name="session_log_draft" label="session-log draft" defaultValue="" />
        <Textarea name="open_brain_capture_draft" label="Open Brain capture draft" defaultValue="" />
        <div className="md:col-span-2">
          <button type="submit" className="task-button">
            [APPLY ACCEPTED]
          </button>
        </div>
      </form>

      <form action={createFollowUpDraft} className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-2 border-t border-[var(--border)] pt-3">
        <input type="hidden" name="parent_task_id" value={task.id} />
        <input type="hidden" name="redirect_path" value={currentPath} />
        <input type="hidden" name="agent_code" value={task.agent_code ?? ""} />
        <input type="hidden" name="project_slug" value={task.project_slug ?? ""} />
        <input type="hidden" name="requested_by" value="dashboard" />
        <Field name="desired_outcome" label="follow-up outcome" defaultValue="" required />
        <Textarea name="context" label="follow-up context" defaultValue="" required />
        <div className="md:col-span-2">
          <button type="submit" className="task-button">
            [CREATE FOLLOW-UP DRAFT]
          </button>
        </div>
      </form>

      <form action={applyReviewedTask} className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-2 border-t border-[var(--border)] pt-3">
        <input type="hidden" name="task_id" value={task.id} />
        <input type="hidden" name="redirect_path" value={currentPath} />
        <input type="hidden" name="resolution" value="accepted_with_follow_up" />
        <input type="hidden" name="applied_by" value="dashboard" />
        <Field name="child_task_ids" label="child task ids" defaultValue="" required />
        <Field name="note" label="apply note" defaultValue="" />
        <Textarea name="work_summary" label="work summary" defaultValue="" />
        <Textarea name="verification" label="verification" defaultValue="" />
        <Textarea name="tracker_draft" label="tracker draft" defaultValue="" />
        <Textarea name="session_log_draft" label="session-log draft" defaultValue="" />
        <Textarea name="open_brain_capture_draft" label="Open Brain capture draft" defaultValue="" />
        <div className="md:col-span-2">
          <button type="submit" className="task-button">
            [APPLY WITH FOLLOW-UP]
          </button>
        </div>
      </form>

      <form action={moveAgentTaskStatus} className="mt-4 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2 border-t border-[var(--border)] pt-3">
        <input type="hidden" name="task_id" value={task.id} />
        <input type="hidden" name="target_status" value="Agent Working" />
        <input type="hidden" name="current_status" value={task.status} />
        <input type="hidden" name="agent_code" value={task.agent_code ?? ""} />
        <input type="hidden" name="redirect_path" value={currentPath} />
        <input
          name="reason"
          aria-label="return for work note"
          placeholder="return for work note"
          className="task-input h-9 text-[10px]"
        />
        <button type="submit" className="task-button">
          [RETURN FOR WORK]
        </button>
      </form>
    </div>
  );
}

function NeedsOperatorPanel({
  task,
  currentPath,
}: {
  task: AgentTask;
  currentPath: string;
}) {
  const target = task.operator_target;
  const isUrl = Boolean(target && /^https?:\/\//i.test(target));

  return (
    <div className="mt-4 border border-[var(--warning)] bg-[rgba(251,191,36,0.06)] px-3 py-3">
      <h3 className="font-terminal text-sm uppercase tracking-wider text-[var(--warning)]">
        needs operator :: your hands
      </h3>
      <p className="mt-2 text-sm font-mono text-[var(--text-body)] whitespace-pre-wrap">
        {task.operator_action ?? "operator step pending"}
      </p>
      {target && (
        <div className="mt-2 text-xs font-mono">
          <span className="uppercase tracking-wider text-[var(--text-muted)]">where: </span>
          {isUrl ? (
            <a
              href={target}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--phosphor-glow)] underline break-all"
            >
              {target}
            </a>
          ) : (
            <span className="text-[var(--text-body)] break-all">{target}</span>
          )}
        </div>
      )}
      <form
        action={completeOperatorAction}
        className="mt-3 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2 border-t border-[var(--border)] pt-3"
      >
        <input type="hidden" name="task_id" value={task.id} />
        <input type="hidden" name="redirect_path" value={currentPath} />
        <input
          name="note"
          aria-label="what the operator did"
          placeholder="what you did (optional)"
          className="task-input h-9 text-[10px]"
        />
        <button type="submit" className="task-button">
          [MARK DONE]
        </button>
      </form>
    </div>
  );
}

function Packet({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <div className="font-terminal uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </div>
      <div className="mt-1 text-[var(--text-body)] whitespace-pre-wrap line-clamp-4">
        {value}
      </div>
    </div>
  );
}

function StatusButton({
  task,
  target,
  currentPath,
  disabled,
}: {
  task: AgentTask;
  target: AgentTaskStatus;
  currentPath: string;
  disabled: boolean;
}) {
  return (
    <form action={moveAgentTaskStatus}>
      <input type="hidden" name="task_id" value={task.id} />
      <input type="hidden" name="target_status" value={target} />
      <input type="hidden" name="current_status" value={task.status} />
      <input type="hidden" name="agent_code" value={task.agent_code ?? ""} />
      <input type="hidden" name="redirect_path" value={currentPath} />
      <input
        name="reason"
        aria-label={`${shortStatus(target)} receipt note`}
        placeholder="receipt note"
        className="task-input mb-1 h-8 text-[10px]"
      />
      <button
        type="submit"
        disabled={disabled}
        className="task-button disabled:opacity-30 disabled:cursor-not-allowed"
      >
        [{shortStatus(target)}]
      </button>
    </form>
  );
}

function EventRow({ event }: { event: AgentTaskEvent }) {
  const payload = event.payload ?? {};
  const reason = typeof payload.reason === "string" ? payload.reason : null;
  const status = typeof payload.status === "string" ? payload.status : null;

  return (
    <div className="border border-[var(--border)] bg-[rgba(15,23,42,0.28)] px-3 py-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="font-terminal text-sm text-[var(--text-primary)]">
          {event.event_type}
        </span>
        <span className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
          {event.agent_code ?? "human"} · {new Date(event.created_at).toLocaleString()}
        </span>
      </div>
      {(reason || status || event.evidence_url) && (
        <div className="mt-1 text-xs font-mono text-[var(--text-body)] whitespace-pre-wrap">
          {status && <span>[{status}] </span>}
          {reason}
          {event.evidence_url && (
            <span>
              {" "}
              <a href={event.evidence_url} className="underline">
                evidence
              </a>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function shortStatus(status: AgentTaskStatus): string {
  switch (status) {
    case "Standing":
      return "standing";
    case "Agent Todo":
      return "todo";
    case "Agent Working":
      return "working";
    case "Agent Needs Input":
      return "needs input";
    case "Agent Review":
      return "review";
    case "Needs Operator":
      return "needs operator";
    case "Agent Done":
      return "done";
  }
}

function Field({
  name,
  label,
  defaultValue,
  required = false,
}: {
  name: string;
  label: string;
  defaultValue: string;
  required?: boolean;
}) {
  return (
    <label className="space-y-1">
      <span className="label">{label}</span>
      <input name={name} required={required} defaultValue={defaultValue} className="task-input" />
    </label>
  );
}

function Select({
  name,
  label,
  defaultValue,
}: {
  name: string;
  label: string;
  defaultValue: string;
}) {
  return (
    <label className="space-y-1">
      <span className="label">{label}</span>
      <select name={name} defaultValue={defaultValue} className="task-input">
        <option value="low">low</option>
        <option value="medium">medium</option>
        <option value="high">high</option>
      </select>
    </label>
  );
}

function Textarea({
  name,
  label,
  defaultValue,
  required = false,
}: {
  name: string;
  label: string;
  defaultValue: string;
  required?: boolean;
}) {
  return (
    <label className="space-y-1 md:col-span-2">
      <span className="label">{label}</span>
      <textarea name={name} required={required} defaultValue={defaultValue} rows={3} className="task-input" />
    </label>
  );
}
