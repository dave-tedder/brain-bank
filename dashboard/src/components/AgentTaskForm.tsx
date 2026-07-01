import { createAgentTask, createHandoffAgentTask } from "@/app/tasks/actions";
import type { AgentRuntime } from "@/lib/agent-tasks";

interface Props {
  runtimes: AgentRuntime[];
}

export default function AgentTaskForm({ runtimes }: Props) {
  return (
    <div className="space-y-4 animate-in stagger-2">
      <details className="card">
        <summary className="cursor-pointer font-terminal text-lg text-[var(--text-primary)] uppercase tracking-wider">
          &gt; NEW HANDOFF DRAFT
        </summary>

        <form action={createHandoffAgentTask} className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field name="title" label="title" required />
          <label className="space-y-1">
            <span className="label">agent</span>
            <select name="agent_code" className="task-input">
              <option value="">unassigned</option>
              {runtimes.map((runtime) => (
                <option key={runtime.agent_code} value={runtime.agent_code}>
                  {runtime.agent_code}
                </option>
              ))}
            </select>
          </label>

          <Field name="project_slug" label="project slug" />
          <Field name="requested_by" label="requested by" />

          <label className="space-y-1">
            <span className="label">priority</span>
            <select name="priority" defaultValue="medium" className="task-input">
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>

          <label className="space-y-1">
            <span className="label">risk</span>
            <select name="risk" defaultValue="medium" className="task-input">
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>

          <Textarea name="desired_outcome" label="desired outcome override" />
          <Textarea name="handoff_text" label="handoff/session text" required rows={8} />

          <div className="md:col-span-2">
            <button type="submit" className="task-button">
              [CREATE HANDOFF DRAFT]
            </button>
          </div>
        </form>
      </details>

      <details className="card">
        <summary className="cursor-pointer font-terminal text-lg text-[var(--text-primary)] uppercase tracking-wider">
          &gt; NEW STANDING DRAFT
        </summary>

        <form action={createAgentTask} className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field name="title" label="title" required />
          <label className="space-y-1">
            <span className="label">agent</span>
            <select name="agent_code" className="task-input">
              <option value="">unassigned</option>
              {runtimes.map((runtime) => (
                <option key={runtime.agent_code} value={runtime.agent_code}>
                  {runtime.agent_code}
                </option>
              ))}
            </select>
          </label>

          <Field name="project_slug" label="project slug" />
          <Field name="requested_by" label="requested by" />
          <Field name="intake_source" label="intake source" defaultValue="dashboard-button" />

          <label className="space-y-1">
            <span className="label">priority</span>
            <select name="priority" defaultValue="medium" className="task-input">
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>

          <label className="space-y-1">
            <span className="label">risk</span>
            <select name="risk" defaultValue="medium" className="task-input">
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>

          <Textarea name="desired_outcome" label="desired outcome" required />
          <Textarea name="context" label="context" />
          <Textarea name="do_steps" label="do steps" />
          <Textarea name="acceptance_criteria" label="acceptance criteria" />
          <Textarea name="output_handoff" label="output handoff" />
          <Textarea name="boundaries" label="boundaries" />
          <Textarea
            name="sources"
            label="sources json array"
            defaultValue="[]"
          />

          <div className="md:col-span-2">
            <button type="submit" className="task-button">
              [CREATE STANDING DRAFT]
            </button>
          </div>
        </form>
      </details>
    </div>
  );
}

function Field({
  name,
  label,
  required = false,
  defaultValue = "",
}: {
  name: string;
  label: string;
  required?: boolean;
  defaultValue?: string;
}) {
  return (
    <label className="space-y-1">
      <span className="label">{label}</span>
      <input
        name={name}
        required={required}
        defaultValue={defaultValue}
        className="task-input"
      />
    </label>
  );
}

function Textarea({
  name,
  label,
  required = false,
  defaultValue = "",
  rows = 3,
}: {
  name: string;
  label: string;
  required?: boolean;
  defaultValue?: string;
  rows?: number;
}) {
  return (
    <label className="space-y-1 md:col-span-2">
      <span className="label">{label}</span>
      <textarea
        name={name}
        required={required}
        defaultValue={defaultValue}
        rows={rows}
        className="task-input"
      />
    </label>
  );
}
