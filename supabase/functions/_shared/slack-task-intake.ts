// OE-6 Slack intake surface (Session 276). A capture-channel message starting
// with "task:" captures as a normal thought AND creates a conservative
// Standing agent-task draft linked by source_thought_id. Slack is intake
// only (build plan OE-6): drafts are never promoted, claimed, or evented
// from this path, and human promotion stays required before any runner
// can see the task.
import {
  type AgentTaskIntakeRecord,
  buildAgentTaskIntakeRecord,
} from "../open-brain-mcp/_agent_intake.ts";

const SLACK_TASK_INTAKE_RE = /^task:\s*/i;
const CONTEXT_EXCERPT_CHARS = 1600;
const TITLE_CHARS = 96;

export interface SlackTaskIntakeParse {
  isIntake: boolean;
  body: string;
}

// "task: <body>" (case-insensitive) marks an intake message. A bare "task:"
// with no body is NOT intake — it captures as an ordinary thought.
export function parseSlackTaskIntake(text: string): SlackTaskIntakeParse {
  const match = text.match(SLACK_TASK_INTAKE_RE);
  if (!match) return { isIntake: false, body: text };
  const body = text.slice(match[0].length).trim();
  if (!body) return { isIntake: false, body: text };
  return { isIntake: true, body };
}

function boundedExcerpt(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > CONTEXT_EXCERPT_CHARS
    ? `${compact.slice(0, CONTEXT_EXCERPT_CHARS - 3).trim()}...`
    : compact;
}

function boundedTitle(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  const short = compact.length > TITLE_CHARS
    ? `${compact.slice(0, TITLE_CHARS - 3).trim()}...`
    : compact;
  return `[agent instructions][unassigned][slack] ${short}`;
}

export function buildSlackTaskIntakeRecord(input: {
  body: string;
  thoughtId: string;
  projectSlug?: string | null;
}): AgentTaskIntakeRecord {
  return buildAgentTaskIntakeRecord({
    desired_outcome: input.body,
    context:
      `Slack capture-channel task intake draft from thoughts.id ${input.thoughtId}.\n\nOriginal message body:\n${
        boundedExcerpt(input.body)
      }`,
    sources: [
      {
        kind: "thought",
        id: input.thoughtId,
        source: "slack",
        relationship: "intake-origin",
      },
    ],
    do_steps:
      "Review this Slack-originated draft, expand it into a complete task packet if it is still worth doing, then use the normal human promotion path when ready.",
    acceptance_criteria:
      "The Standing draft is reviewed by a human and remains unclaimable until explicitly promoted later.",
    output_handoff:
      "Leave notes on what changed, what evidence was checked, and whether the draft should be promoted, rewritten, or left Standing.",
    boundaries:
      "Slack intake draft only. Do not promote, claim, run, deploy, send messages, spend money, delete data, or mark related work complete from this intake step.",
    intake_source: "slack-intake",
    project_slug: input.projectSlug ?? null,
    priority: "medium",
    risk: "low",
    requested_by: "operator (Slack)",
    title: boundedTitle(input.body),
    source_thought_id: input.thoughtId,
  });
}
