import {
  type AgentTaskRisk,
  isAgentTaskRisk,
  resolveRequiresLocal,
} from "./_agent_tasks.ts";

export const AGENT_TASK_INTAKE_SOURCES = [
  "dashboard-button",
  "brain-bank-capture",
  "session-log-closeout",
  "handoff-doc",
  "slack-intake",
  "action-item-promotion",
  "agent-follow-up",
  "triage-agent",
] as const;

export type AgentTaskIntakeSource = (typeof AGENT_TASK_INTAKE_SOURCES)[number];

// OE-13 Sub-phase B (spec §3.1, Fork B): check_spec is a fixed allowlist of
// runner commands with bounded args. This is the SERVER mirror of the
// controller's parseCheckSpec (scripts/open-engine/closeout-controller.mjs):
// same runners, same bounds, same arg pattern. It THROWS (intake rejects
// loudly); the controller version classifies (gate holds quietly). If either
// allowlist ever changes, change BOTH (mirror-style discipline, same as the
// capture-path mirror rule).
export const CHECK_SPEC_RUNNERS: Record<
  string,
  { minArgs: number; maxArgs: number }
> = {
  "deno-test": { minArgs: 0, maxArgs: 8 },
  "deno-check": { minArgs: 1, maxArgs: 8 },
  "node-test": { minArgs: 0, maxArgs: 8 },
  "npm-test": { minArgs: 0, maxArgs: 0 },
  "npm-run": { minArgs: 1, maxArgs: 1 },
};

const CHECK_SPEC_ARG_PATTERN = /^[A-Za-z0-9@._/:=,-]+$/;

export interface AgentTaskCheckSpec {
  runner: string;
  args: string[];
}

export function validateCheckSpec(
  value: unknown,
): AgentTaskCheckSpec | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("check_spec must be a {runner, args[]} object.");
  }
  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(
    (key) => key !== "runner" && key !== "args",
  );
  if (unknownKeys.length > 0) {
    throw new Error(`check_spec has unknown keys: ${unknownKeys.join(", ")}.`);
  }
  const runner = record.runner;
  if (typeof runner !== "string" || !(runner in CHECK_SPEC_RUNNERS)) {
    throw new Error(
      `check_spec.runner must be one of: ${
        Object.keys(CHECK_SPEC_RUNNERS).join(", ")
      }.`,
    );
  }
  const bounds = CHECK_SPEC_RUNNERS[runner];
  const args = record.args === undefined ? [] : record.args;
  if (!Array.isArray(args)) {
    throw new Error("check_spec.args must be an array of strings.");
  }
  if (args.length < bounds.minArgs || args.length > bounds.maxArgs) {
    throw new Error(
      `check_spec.args for ${runner} must have between ${bounds.minArgs} and ${bounds.maxArgs} entries.`,
    );
  }
  for (const arg of args) {
    if (
      typeof arg !== "string" || arg.length === 0 || arg.length > 128 ||
      !CHECK_SPEC_ARG_PATTERN.test(arg)
    ) {
      throw new Error(
        "check_spec.args entries must be short plain tokens (no spaces or shell metacharacters).",
      );
    }
  }
  return { runner, args: args as string[] };
}

// OE board-hygiene: close_check is a fixed allowlist of probe verbs with exact,
// bounded assertions. Same authorship rule as check_spec, opposite isolation
// posture: check_spec runs AGENT-PRODUCED code in a scrubbed no-network sandbox;
// close_check runs NO agent code at all, only these four controller-authored
// probes, against the network with read-only credentials. The two never share an
// execution path.
//
// Enforced here rather than in SQL, mirroring check_spec: the column is plain
// jsonb and service_role-only, and this validator is shared by BOTH authoring
// paths (create_agent_task_intake and admin_amend_agent_task). It THROWS.
export const CLOSE_CHECK_PROBES = [
  "http_contains",
  "wp_post_status",
  "git_path_exists",
  "git_commit_contains",
] as const;

export type CloseCheckProbe = (typeof CLOSE_CHECK_PROBES)[number];

const CLOSE_CHECK_WP_STATUSES = [
  "publish",
  "draft",
  "pending",
  "private",
  "future",
] as const;

// git_path_exists asserts ONE thing and only one thing: a NEW file appeared
// under this path AFTER the card entered the desk. A bare existence check is a
// defect, not a simplification -- desk cards routinely point operator_target at
// a deliverables/ file the executor itself wrote, which existed before the card
// ever reached the desk, so bare existence would falsely close every one of them.
const GIT_PATH_EXISTS_ASSERT = "new_file_since_card_entered_desk";

// A drop-box probe may only target a folder that is EXCLUSIVELY an operator
// drop-box, never one any lane writes into. deliverables/ fails that test:
// scripts/open-engine/deliverables-push.sh stages ALL of deliverables/, so an
// executor lane's own push would satisfy a "new file since" assertion and close
// a card the operator never touched. A real drop-box card needs a path outside
// deliverables/.
const LANE_WRITTEN_PATH_PREFIXES = ["deliverables/"];

const CLOSE_CHECK_REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const CLOSE_CHECK_REF_PATTERN = /^[A-Za-z0-9._/-]+$/;
// No shell metacharacters in a STRUCTURAL close_check string. The probe runner
// is a bash script; a value that survives into a command line must be inert.
const SHELL_METACHARACTERS = /[;&|`$(){}<>\\\n\r'"]/;

export interface AgentTaskCloseCheck {
  probe: CloseCheckProbe;
  [key: string]: unknown;
}

// CONTENT assertions are held to a different, deliberately looser standard than
// STRUCTURAL fields, and the distinction is the whole point.
//
// A structural field (url, site, repo, ref, path, measured_by) names WHERE to
// look. Those flow into fetch() URLs, map keys, and `gh` argv, so they stay under
// assertPlainString's strict ban below.
//
// http_contains.assert names WHAT to look for, and its only consumer is
// `body.includes(assert)` in reconcile-probe.mjs -- a pure string comparison with
// no injection surface at all. The `gh` calls use execFile, which spawns no
// shell, so even the structural ban is defense in depth rather than a live need.
//
// WHY THIS EXISTS: a blanket ban across every field makes the feature unable to
// express its own primary use case. It rejects `"Monday"` (pinning a day name to
// a JSON-LD token rather than matching the bare word in prose) and it rejects
// `<title>Some Page`, because angle brackets are banned too. Asserting against
// HTML means asserting against quotes, angle brackets, ampersands and braces; a
// validator that forbids them can only express vague assertions, and a vague
// assertion is exactly the false-positive risk the whole design exists to bound.
// The ban was making the safe thing unbuildable.
//
// Still refused: control characters. An assertion is one line of page content.
// Length is capped by the caller.
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

function assertContentString(
  value: unknown,
  field: string,
  maxLength = 512,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`close_check.${field} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new Error(
      `close_check.${field} must be at most ${maxLength} characters.`,
    );
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new Error(
      `close_check.${field} must not contain control characters or line breaks. An assertion is a single line of page content.`,
    );
  }
  return value;
}

function assertPlainString(
  value: unknown,
  field: string,
  maxLength = 512,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`close_check.${field} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new Error(
      `close_check.${field} must be at most ${maxLength} characters.`,
    );
  }
  if (SHELL_METACHARACTERS.test(value)) {
    throw new Error(
      `close_check.${field} must not contain shell metacharacters. A close_check is a structured assertion, never a command.`,
    );
  }
  return value;
}

function assertExactKeys(
  record: Record<string, unknown>,
  required: string[],
  optional: string[],
): void {
  const allowed = new Set([...required, ...optional, "probe"]);
  const unknownKeys = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `close_check has unknown keys for this probe: ${
        unknownKeys.join(", ")
      }. Allowed: ${[...allowed].join(", ")}.`,
    );
  }
  const missing = required.filter((key) => record[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `close_check is missing required keys for this probe: ${
        missing.join(", ")
      }.`,
    );
  }
}

export function validateCloseCheck(
  value: unknown,
  // Site handles a wp_post_status probe may name. Injected rather than imported
  // so this validator stays a pure function and the tests need no profile file.
  // Defaults to EMPTY, which fails closed: a fork that has wired no WordPress
  // credentials refuses every wp_post_status probe at authorship.
  wordpressSites: readonly string[] = [],
): AgentTaskCloseCheck | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("close_check must be an object with a probe field.");
  }
  const record = value as Record<string, unknown>;
  const probe = record.probe;
  if (
    typeof probe !== "string" ||
    !(CLOSE_CHECK_PROBES as readonly string[]).includes(probe)
  ) {
    throw new Error(
      `close_check.probe must be one of: ${CLOSE_CHECK_PROBES.join(", ")}.`,
    );
  }

  switch (probe as CloseCheckProbe) {
    case "http_contains": {
      assertExactKeys(record, ["url", "assert"], ["measured_by"]);
      const url = assertPlainString(record.url, "url", 2048);
      if (!url.startsWith("https://")) {
        throw new Error(
          "close_check.url must be an https:// URL. A probe measures a public surface, never a local or plaintext one.",
        );
      }
      // CONTENT, not structure: this is the only field in the whole allowlist
      // whose consumer is a plain body.includes(). See assertContentString.
      assertContentString(record.assert, "assert");
      if (record.measured_by !== undefined) {
        assertPlainString(record.measured_by, "measured_by", 128);
      }
      return { probe, url, assert: record.assert, ...(record.measured_by !== undefined ? { measured_by: record.measured_by } : {}) } as AgentTaskCloseCheck;
    }
    case "wp_post_status": {
      assertExactKeys(record, ["site", "post_id", "assert"], ["measured_by"]);
      const site = assertPlainString(record.site, "site", 64);
      if (wordpressSites.length === 0) {
        throw new Error(
          "close_check.probe 'wp_post_status' requires at least one configured WordPress site. Set profile.json's wordpress_sites to the site handles you have credentials for, or use a different probe.",
        );
      }
      if (!wordpressSites.includes(site)) {
        throw new Error(
          `close_check.site must be one of: ${wordpressSites.join(", ")}.`,
        );
      }
      const postId = record.post_id;
      if (
        typeof postId !== "number" || !Number.isInteger(postId) || postId <= 0
      ) {
        throw new Error("close_check.post_id must be a positive integer.");
      }
      const assertion = assertPlainString(record.assert, "assert", 32);
      if (!(CLOSE_CHECK_WP_STATUSES as readonly string[]).includes(assertion)) {
        throw new Error(
          `close_check.assert for wp_post_status must be one of: ${
            CLOSE_CHECK_WP_STATUSES.join(", ")
          }.`,
        );
      }
      if (record.measured_by !== undefined) {
        assertPlainString(record.measured_by, "measured_by", 128);
      }
      return { probe, site, post_id: postId, assert: assertion, ...(record.measured_by !== undefined ? { measured_by: record.measured_by } : {}) } as AgentTaskCloseCheck;
    }
    case "git_path_exists": {
      assertExactKeys(record, ["repo", "path", "assert"], ["measured_by"]);
      const repo = assertPlainString(record.repo, "repo", 128);
      if (!CLOSE_CHECK_REPO_PATTERN.test(repo)) {
        throw new Error("close_check.repo must be in owner/name form.");
      }
      const path = assertPlainString(record.path, "path", 512);
      if (path.startsWith("/") || path.includes("..")) {
        throw new Error(
          "close_check.path must be a repo-relative path with no parent traversal.",
        );
      }
      const laneWritten = LANE_WRITTEN_PATH_PREFIXES.find((prefix) =>
        path.startsWith(prefix)
      );
      if (laneWritten) {
        throw new Error(
          `close_check.path '${path}' is under '${laneWritten}', which agent lanes write into (deliverables-push.sh stages all of deliverables/). A git_path_exists probe may only target a folder that is exclusively an operator drop-box, or a lane's own push would close the card.`,
        );
      }
      if (record.assert !== GIT_PATH_EXISTS_ASSERT) {
        throw new Error(
          `close_check.assert for git_path_exists must be exactly '${GIT_PATH_EXISTS_ASSERT}'. A bare existence check would close a card on an artifact that predates it.`,
        );
      }
      if (record.measured_by !== undefined) {
        assertPlainString(record.measured_by, "measured_by", 128);
      }
      return { probe, repo, path, assert: GIT_PATH_EXISTS_ASSERT, ...(record.measured_by !== undefined ? { measured_by: record.measured_by } : {}) } as AgentTaskCloseCheck;
    }
    case "git_commit_contains": {
      assertExactKeys(record, ["repo", "ref", "assert"], ["measured_by"]);
      const repo = assertPlainString(record.repo, "repo", 128);
      if (!CLOSE_CHECK_REPO_PATTERN.test(repo)) {
        throw new Error("close_check.repo must be in owner/name form.");
      }
      const ref = assertPlainString(record.ref, "ref", 128);
      if (!CLOSE_CHECK_REF_PATTERN.test(ref)) {
        throw new Error(
          "close_check.ref must be a plain git ref (letters, digits, dot, dash, slash, underscore).",
        );
      }
      const assertion = assertPlainString(record.assert, "assert");
      if (!assertion.startsWith("path:")) {
        throw new Error(
          "close_check.assert for git_commit_contains must be 'path:<repo-relative-path>'.",
        );
      }
      const assertedPath = assertion.slice("path:".length);
      if (
        assertedPath.length === 0 || assertedPath.startsWith("/") ||
        assertedPath.includes("..")
      ) {
        throw new Error(
          "close_check.assert path must be a non-empty repo-relative path with no parent traversal.",
        );
      }
      if (record.measured_by !== undefined) {
        assertPlainString(record.measured_by, "measured_by", 128);
      }
      return { probe, repo, ref, assert: assertion, ...(record.measured_by !== undefined ? { measured_by: record.measured_by } : {}) } as AgentTaskCloseCheck;
    }
  }
  // Unreachable: the probe allowlist above is exhaustive.
  throw new Error(
    `close_check.probe must be one of: ${CLOSE_CHECK_PROBES.join(", ")}.`,
  );
}

// A close_check is OPERATOR-AUTHORED ONLY in first scope.
//
// Where Phase 4 auto-promote is enabled, a fully zero-human close loop becomes
// constructible: triage authors a card carrying a close_check -> auto-promote
// moves it to Agent Todo with no human in the path -> an executor runs it ->
// closeout routes it to the desk -> the reconciler closes it, and nobody decided
// anything. auto_promote_agent_task_intake requires intake_source =
// 'triage-agent' (its condition G), so refusing that exact pair severs the loop
// at its single source.
//
// THIS IS THE ONLY LAYER, and it is the one that matters. Do NOT add a second
// gate in the lane that skips auto-promoted cards: the risk being guarded is a
// BADLY WRITTEN ASSERTION, so the question is who AUTHORED the note, not who
// moved the card. Since triage is refused here and admin_amend_agent_task is
// human/ops-only, a close_check on ANY card already proves a human wrote it, and
// a lane-side auto-promote gate would skip precisely those cards. Measured on a
// live board, that gate disqualified 6 of 7 eligible candidates before it was
// removed. Keep THIS check strict: it is the whole loop guard.
export function assertCloseCheckAuthorAllowed(
  intakeSource: string,
  closeCheck: unknown,
): void {
  if (closeCheck === null || closeCheck === undefined) return;
  if (intakeSource === "triage-agent") {
    throw new Error(
      "close_check is operator-authored only in first scope: a triage-agent intake cannot carry one. A triage-authored close_check on an auto-promotable draft would complete a close loop with no human in it. Author the check with admin_amend_agent_task after the card reaches the desk.",
    );
  }
}

export interface AgentTaskIntakeInput {
  desired_outcome: string;
  context: string;
  sources: unknown[];
  do_steps: string;
  acceptance_criteria: string;
  output_handoff: string;
  boundaries: string;
  intake_source: AgentTaskIntakeSource;
  agent_code?: string | null;
  preferred_agent?: string | null;
  requires_local?: boolean | null;
  project_slug?: string | null;
  priority?: "low" | "medium" | "high";
  risk?: AgentTaskRisk;
  requested_by?: string | null;
  title?: string | null;
  source_thought_id?: string | null;
  linked_action_item_id?: string | null;
  parent_task_id?: string | null;
  check_spec?: unknown;
  close_check?: unknown;
  // Site handles a wp_post_status close_check may name. Supplied by the caller
  // (index.ts reads profile.json); empty means every wp_post_status probe is
  // refused, which is the correct default for an unconfigured fork.
  wordpress_sites?: readonly string[];
}

export interface AgentTaskIntakeRecord {
  title: string;
  label: "agent-instructions";
  status: "Standing";
  agent_code: string | null;
  preferred_agent: string | null;
  requires_local: boolean;
  project_slug: string | null;
  priority: "low" | "medium" | "high";
  risk: AgentTaskRisk;
  requested_by: string | null;
  intake_source: AgentTaskIntakeSource;
  desired_outcome: string;
  context: string;
  sources: unknown[];
  do_steps: string;
  acceptance_criteria: string;
  output_handoff: string;
  boundaries: string;
  explicit_approval: false;
  source_thought_id: string | null;
  linked_action_item_id: string | null;
  parent_task_id: string | null;
  check_spec: AgentTaskCheckSpec | null;
  close_check: AgentTaskCloseCheck | null;
}

export interface ActionItemPromotionRow {
  id: string;
  description: string;
  status: string;
  source_thought_id?: string | null;
}

export interface ActionItemPromotionInput {
  action_item: ActionItemPromotionRow;
  agent_code?: string | null;
  preferred_agent?: string | null;
  project_slug?: string | null;
  requested_by?: string | null;
}

export interface ThoughtIntakeRow {
  id: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
}

export interface ThoughtIntakeInput {
  thought: ThoughtIntakeRow;
  agent_code?: string | null;
  preferred_agent?: string | null;
  project_slug?: string | null;
  requested_by?: string | null;
}

export interface FollowUpTaskInput {
  parent_task_id: string;
  desired_outcome: string;
  context: string;
  do_steps?: string | null;
  acceptance_criteria?: string | null;
  boundaries?: string | null;
  output_handoff?: string | null;
  agent_code?: string | null;
  preferred_agent?: string | null;
  project_slug?: string | null;
  requested_by?: string | null;
  priority?: "low" | "medium" | "high";
  risk?: AgentTaskRisk;
}

export interface LinkedActionItemDraftRow {
  id: string;
  status: string;
}

export interface ParentTaskRow {
  id: string;
  archived_at?: string | null;
}

export interface FollowUpChildRow {
  id: string;
  status: string;
  desired_outcome?: string | null;
}

export const ACTIVE_ACTION_ITEM_DRAFT_STATUSES = [
  "Standing",
  "Agent Todo",
  "Agent Working",
  "Agent Needs Input",
  "Agent Review",
  "Needs Operator",
] as const;

export const ACTIVE_THOUGHT_DRAFT_STATUSES = [
  "Standing",
  "Agent Todo",
  "Agent Working",
  "Agent Needs Input",
  "Agent Review",
  "Needs Operator",
] as const;

const VALID_PRIORITIES = new Set(["low", "medium", "high"]);
const THOUGHT_CONTEXT_EXCERPT_CHARS = 1600;
const TEXT_LIMITS = {
  title: 240,
  desired_outcome: 4000,
  context: 12000,
  do_steps: 6000,
  acceptance_criteria: 6000,
  output_handoff: 6000,
  boundaries: 6000,
} as const;

function cleanText(value: string, field: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${field} is required.`);
  const limit = TEXT_LIMITS[field as keyof typeof TEXT_LIMITS];
  if (limit && cleaned.length > limit) {
    throw new Error(`${field} must be ${limit} characters or fewer.`);
  }
  return cleaned;
}

function cleanOptionalText(
  value: string | null | undefined,
  field: keyof typeof TEXT_LIMITS,
): string | null {
  const cleaned = value?.trim() || null;
  if (cleaned && cleaned.length > TEXT_LIMITS[field]) {
    throw new Error(
      `${field} must be ${TEXT_LIMITS[field]} characters or fewer.`,
    );
  }
  return cleaned;
}

function titleAgentCode(agentCode: string | null): string {
  return agentCode && agentCode.trim() ? agentCode.trim() : "unassigned";
}

function fallbackTitle(
  agentCode: string | null,
  desiredOutcome: string,
): string {
  const outcome = desiredOutcome.replace(/\s+/g, " ").trim();
  const shortOutcome = outcome.length > 96
    ? `${outcome.slice(0, 93).trim()}...`
    : outcome;
  return `[agent instructions][${
    titleAgentCode(agentCode)
  }][task] ${shortOutcome}`;
}

export function buildAgentTaskIntakeRecord(
  input: AgentTaskIntakeInput,
): AgentTaskIntakeRecord {
  if (!Array.isArray(input.sources)) {
    throw new Error("sources must be an array.");
  }

  const desiredOutcome = cleanText(input.desired_outcome, "desired_outcome");
  const agentCode = input.agent_code?.trim() || null;
  const preferredAgent = input.preferred_agent?.trim() || null;
  const projectSlug = input.project_slug?.trim() || null;
  const requiresLocal = resolveRequiresLocal(input.requires_local, projectSlug);
  const priority = input.priority && VALID_PRIORITIES.has(input.priority)
    ? input.priority
    : "medium";
  const risk: AgentTaskRisk = isAgentTaskRisk(input.risk || "")
    ? input.risk!
    : "medium";
  const title = cleanOptionalText(input.title, "title") ||
    fallbackTitle(agentCode, desiredOutcome);

  return {
    title,
    label: "agent-instructions",
    status: "Standing",
    agent_code: agentCode,
    preferred_agent: preferredAgent,
    requires_local: requiresLocal,
    project_slug: projectSlug,
    priority,
    risk,
    requested_by: input.requested_by?.trim() || null,
    intake_source: input.intake_source,
    desired_outcome: desiredOutcome,
    context: cleanText(input.context, "context"),
    sources: input.sources,
    do_steps: cleanText(input.do_steps, "do_steps"),
    acceptance_criteria: cleanText(
      input.acceptance_criteria,
      "acceptance_criteria",
    ),
    output_handoff: cleanText(input.output_handoff, "output_handoff"),
    boundaries: cleanText(input.boundaries, "boundaries"),
    explicit_approval: false,
    source_thought_id: input.source_thought_id?.trim() || null,
    linked_action_item_id: input.linked_action_item_id?.trim() || null,
    parent_task_id: input.parent_task_id?.trim() || null,
    check_spec: validateCheckSpec(input.check_spec),
    close_check: (() => {
      assertCloseCheckAuthorAllowed(input.intake_source, input.close_check);
      return validateCloseCheck(input.close_check, input.wordpress_sites ?? []);
    })(),
  };
}

export function assertNoActiveActionItemDraft(
  existingTasks: LinkedActionItemDraftRow[],
  actionItemId: string,
): void {
  const activeTask = existingTasks.find((task) =>
    (ACTIVE_ACTION_ITEM_DRAFT_STATUSES as readonly string[]).includes(
      task.status,
    )
  );
  if (activeTask) {
    throw new Error(
      `Action item ${actionItemId} already has an active agent task draft: ${activeTask.id} (${activeTask.status}).`,
    );
  }
}

export function assertNoActiveThoughtDraft(
  existingTasks: LinkedActionItemDraftRow[],
  thoughtId: string,
): void {
  const activeTask = existingTasks.find((task) =>
    (ACTIVE_THOUGHT_DRAFT_STATUSES as readonly string[]).includes(task.status)
  );
  if (activeTask) {
    throw new Error(
      `Thought ${thoughtId} already has an active agent task draft: ${activeTask.id} (${activeTask.status}).`,
    );
  }
}

export function assertFollowUpParentAllowed(parentTask: ParentTaskRow): void {
  if (parentTask.archived_at) {
    throw new Error(
      `Parent task ${parentTask.id} is archived and cannot receive follow-up drafts.`,
    );
  }
}

export function assertNoDuplicateOpenFollowUp(
  existingChildren: FollowUpChildRow[],
  parentTaskId: string,
  desiredOutcome: string,
): void {
  const normalizedOutcome = desiredOutcome.replace(/\s+/g, " ").trim()
    .toLowerCase();
  const duplicate = existingChildren.find((child) =>
    (ACTIVE_THOUGHT_DRAFT_STATUSES as readonly string[]).includes(
      child.status,
    ) &&
    (child.desired_outcome ?? "").replace(/\s+/g, " ").trim().toLowerCase() ===
      normalizedOutcome
  );
  if (duplicate) {
    throw new Error(
      `Parent task ${parentTaskId} already has an active follow-up draft with the same desired_outcome: ${duplicate.id} (${duplicate.status}).`,
    );
  }
}

export function buildActionItemPromotionIntakeRecord(
  input: ActionItemPromotionInput,
): AgentTaskIntakeRecord {
  const actionItem = input.action_item;
  if (actionItem.status !== "open") {
    throw new Error("Only open action_items can be promoted to intake drafts.");
  }

  const description = cleanText(actionItem.description, "description");
  const actionItemId = cleanText(actionItem.id, "action_item.id");
  const sourceThoughtId = actionItem.source_thought_id?.trim() || null;

  return buildAgentTaskIntakeRecord({
    desired_outcome: description,
    context:
      `Manual action-item promotion draft for action_items.id ${actionItemId}.\n\nAction item: ${description}`,
    sources: [
      {
        kind: "action_item",
        id: actionItemId,
        source_thought_id: sourceThoughtId,
      },
    ],
    do_steps:
      "Review the linked action item, expand this draft into a complete task packet if it is still worth doing, then use the normal human promotion path when ready.",
    acceptance_criteria:
      "The Standing draft is reviewed by a human and remains unclaimable until explicitly promoted later.",
    output_handoff:
      "Leave notes on what changed, what evidence was checked, and whether the draft should be promoted, rewritten, or left Standing.",
    boundaries:
      "Manual draft only. Do not promote, claim, run, deploy, send messages, spend money, delete data, or mark the linked action item resolved from this intake step.",
    intake_source: "action-item-promotion",
    agent_code: input.agent_code,
    preferred_agent: input.preferred_agent,
    project_slug: input.project_slug,
    priority: "medium",
    risk: "low",
    requested_by: input.requested_by,
    title: `[agent instructions][${
      titleAgentCode(input.agent_code ?? null)
    }][action-item] ${description}`,
    source_thought_id: sourceThoughtId,
    linked_action_item_id: actionItemId,
  });
}

function thoughtIntakeSource(
  metadata: Record<string, unknown> | null | undefined,
): AgentTaskIntakeSource {
  const source = typeof metadata?.source === "string"
    ? metadata.source.toLowerCase()
    : "";
  return source.includes("session-log") || source.includes("session_log")
    ? "session-log-closeout"
    : "brain-bank-capture";
}

function thoughtSourceLabel(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  return typeof metadata?.source === "string" && metadata.source.trim()
    ? metadata.source.trim()
    : null;
}

function boundedThoughtExcerpt(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > THOUGHT_CONTEXT_EXCERPT_CHARS
    ? `${compact.slice(0, THOUGHT_CONTEXT_EXCERPT_CHARS - 3).trim()}...`
    : compact;
}

export function buildThoughtIntakeRecord(
  input: ThoughtIntakeInput,
): AgentTaskIntakeRecord {
  const thought = input.thought;
  const thoughtId = cleanText(thought.id, "thought.id");
  const content = cleanText(thought.content, "thought.content");
  const excerpt = boundedThoughtExcerpt(content);
  const source = thoughtSourceLabel(thought.metadata);

  return buildAgentTaskIntakeRecord({
    desired_outcome:
      `Review source thought ${thoughtId} and draft a manual agent task if it is still worth doing.`,
    context:
      `Manual thought intake draft for thoughts.id ${thoughtId}.\n\nSource thought excerpt:\n${excerpt}`,
    sources: [
      {
        kind: "thought",
        id: thoughtId,
        source,
        created_at: thought.created_at ?? null,
      },
    ],
    do_steps:
      "Review the source thought, decide whether it represents actionable work, rewrite this draft into a complete task packet if needed, then use the normal human promotion path when ready.",
    acceptance_criteria:
      "The Standing draft is reviewed by a human and remains unclaimable until explicitly promoted later.",
    output_handoff:
      "Leave notes on what source was reviewed, what evidence was checked, and whether the draft should be promoted, rewritten, or left Standing.",
    boundaries:
      "Manual draft only. Do not promote, claim, run, deploy, send messages, spend money, delete data, or mark related work complete from this intake step.",
    intake_source: thoughtIntakeSource(thought.metadata),
    agent_code: input.agent_code,
    preferred_agent: input.preferred_agent,
    project_slug: input.project_slug,
    priority: "medium",
    risk: "low",
    requested_by: input.requested_by,
    title: `[agent instructions][${
      titleAgentCode(input.agent_code ?? null)
    }][thought] Review source thought ${thoughtId}`,
    source_thought_id: thoughtId,
  });
}

// GAP B (spec 2026-07-19 §5.2 + §5.3, decision D3 = REFUSE with override):
// a Standing follow-up draft still defaults to this template when no
// execution fields are provided, so it stays a manual-review-only stub
// unless the caller deliberately supplies an executable packet.
export const FOLLOW_UP_TEMPLATE_DO_STEPS =
  "Review the parent task result, confirm this child work is still needed, expand this draft into a complete task packet if needed, then use the normal human promotion path when ready.";
export const FOLLOW_UP_TEMPLATE_ACCEPTANCE_CRITERIA =
  "The child Standing draft is reviewed by a human and remains unclaimable until explicitly promoted later.";
export const FOLLOW_UP_TEMPLATE_OUTPUT_HANDOFF =
  "Leave notes on the parent task, what follow-up remains, what evidence was checked, and whether this child draft should be promoted, rewritten, or left Standing.";
export const FOLLOW_UP_TEMPLATE_BOUNDARIES =
  "Manual follow-up draft only. Do not promote, claim, run, deploy, send messages, spend money, delete data, resolve linked action items, or mark project records complete from this draft step.";

// Template-detection prefixes for the promote-time gate. The action-item
// prefix already exists inline in index.ts's intake_shape_warning; the checks
// converge on these constants so a future template rewording cannot silently
// blind the gate.
export const ACTION_ITEM_TEMPLATE_PREFIX = "Review the linked action item";
export const THOUGHT_TEMPLATE_PREFIX = "Review the source thought";
export const FOLLOW_UP_TEMPLATE_PREFIX = "Review the parent task result";

export function buildFollowUpTaskRecord(
  input: FollowUpTaskInput,
): AgentTaskIntakeRecord {
  const parentTaskId = cleanText(input.parent_task_id, "parent_task_id");
  const desiredOutcome = cleanText(input.desired_outcome, "desired_outcome");
  const context = cleanText(input.context, "context");

  const doSteps = input.do_steps?.trim() || null;
  const acceptanceCriteria = input.acceptance_criteria?.trim() || null;
  const boundaries = input.boundaries?.trim() || null;
  const outputHandoff = input.output_handoff?.trim() || null;
  const anyExecutionField = Boolean(
    doSteps || acceptanceCriteria || boundaries || outputHandoff,
  );
  if (
    anyExecutionField && !(doSteps && acceptanceCriteria && boundaries)
  ) {
    throw new Error(
      "Executable follow-up packets must provide do_steps, acceptance_criteria, and boundaries together (output_handoff optional). A partial override recreates the claimable-but-unrunnable packet this parameter set exists to prevent.",
    );
  }

  return buildAgentTaskIntakeRecord({
    desired_outcome: desiredOutcome,
    context:
      `Manual follow-up draft for parent agent_tasks.id ${parentTaskId}.\n\n${context}`,
    sources: [
      {
        kind: "agent_task",
        id: parentTaskId,
        relationship: "parent",
      },
    ],
    do_steps: doSteps ?? FOLLOW_UP_TEMPLATE_DO_STEPS,
    acceptance_criteria: acceptanceCriteria ??
      FOLLOW_UP_TEMPLATE_ACCEPTANCE_CRITERIA,
    output_handoff: outputHandoff ?? FOLLOW_UP_TEMPLATE_OUTPUT_HANDOFF,
    boundaries: boundaries ?? FOLLOW_UP_TEMPLATE_BOUNDARIES,
    intake_source: "agent-follow-up",
    agent_code: input.agent_code,
    preferred_agent: input.preferred_agent,
    project_slug: input.project_slug,
    priority: input.priority ?? "medium",
    risk: input.risk ?? "low",
    requested_by: input.requested_by,
    title: `[agent instructions][${
      titleAgentCode(input.agent_code ?? null)
    }][follow-up] ${desiredOutcome}`,
    parent_task_id: parentTaskId,
  });
}

// GAP B — promote-time refusal guard (pure, D3 = REFUSE). Wired into
// index.ts's promote_agent_task_intake BEFORE the RPC call.
// Refuses ONLY the follow-up template: action-item and thought stubs keep
// their warn-only behavior by decision D3.
export function assertPromotablePacketShape(
  task: { intake_source?: string | null; do_steps?: string | null },
  allowTemplateBody: boolean,
): void {
  if (allowTemplateBody) return;
  const doSteps = (task.do_steps ?? "").trim();
  if (
    task.intake_source === "agent-follow-up" &&
    doSteps.startsWith(FOLLOW_UP_TEMPLATE_PREFIX)
  ) {
    throw new Error(
      "PROMOTION_REFUSED_TEMPLATE_BODY: this follow-up draft still carries the Standing-template do_steps/boundaries, which forbid execution — promoting it guarantees a PACKET_INVALID bounce. Repair paths: (1) recreate it as an execution-shaped packet via create_agent_task_follow_up with do_steps + acceptance_criteria + boundaries, or via create_agent_task_intake, then archive this stub; (2) pass allow_template_body: true ONLY if you deliberately want the template stub in Agent Todo for attended human review.",
    );
  }
}
