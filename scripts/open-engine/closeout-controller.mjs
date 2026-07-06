#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REGISTRY_PATH = join(__dirname, "project-closeout-registry.json");
// Draft output is anchored to this repo, never to process.cwd() — routing and
// output location must not depend on where the controller is invoked from.
const REPO_ROOT = join(__dirname, "..", "..");
const DEFAULT_DRAFTS_DIR = join(REPO_ROOT, "docs", "handoffs", "pending-closeouts");

const REQUIRED_RECEIPT_SECTIONS = [
  "Work summary",
  "Verification",
  "Touched files or records",
  "Limitations",
  "Tracker draft",
  "Session-log draft",
  "Brain Bank capture draft",
  "Follow-up recommendation",
];

const SAFE_STATUSES = new Set(["Agent Review"]);
const SAFE_RISKS = new Set(["low"]);
const EXPECTED_STATUSES = new Set(["APPLYABLE", "HELD", "MIXED"]);

function usage() {
  return `Usage:
  node scripts/open-engine/closeout-controller.mjs --fixture <file.json> [--task-id <uuid>] [--expect APPLYABLE|HELD|MIXED]
  node scripts/open-engine/closeout-controller.mjs --input <file.json> [--task-id <uuid>] [--expect APPLYABLE|HELD|MIXED]
  node scripts/open-engine/closeout-controller.mjs --input <file.json> --write-drafts [--drafts-dir <dir>]
  node scripts/open-engine/closeout-controller.mjs --task-id <uuid> --live-check
  node scripts/open-engine/closeout-controller.mjs --task-id <uuid> --apply
  node scripts/open-engine/closeout-controller.mjs --sql

OE-8A is dry-run only. It reads saved Agent Review evidence, validates receipt
quality, routes by project_slug, and prints proposed closeout output. It does
not connect to Supabase, call apply_agent_task_review, edit trackers/session
logs, capture to Brain Bank, fire cron, promote tasks, deploy, or mutate data.

OE-8B (--write-drafts) additionally writes one pending-closeout draft file per
APPLYABLE project batch to docs/handoffs/pending-closeouts/YYYY-MM-DD-<slug>.md
(this repo, or --drafts-dir). The written bytes are exactly the
projects[].pending_closeout.content string the dry run prints. Held tasks are
reported as exceptions and produce no file. Nothing else is mutated: no tracker
or session-log writes, no task status changes, no captures, no apply calls. An
existing draft with different content is a DRAFT_CONFLICT, never overwritten.

OE-8C live modes need BRAIN_BANK_MCP_URL and BRAIN_BANK_MCP_KEY in the
environment and a --task-id (single-task discipline). --live-check fetches the
task packet through the guarded MCP get_agent_task and prints the evaluation
READ-ONLY. --apply, for an APPLYABLE task only: calls apply_agent_task_review
(exactly one AGENT APPLIED, resolution accepted, never resolves linked action
items), appends the receipt's tracker/session-log drafts to the routed project
files (marker-guarded, append-only, never overwrites), and captures one Open
Brain thought per project batch. The controller never runs git - committing
closeout writes stays human/session-side (locked decision, Session 268). A
non-APPLYABLE task is reported and NOT applied; the gate is never relaxed.`;
}

function parseArgs(argv) {
  const args = {
    source: null,
    taskId: null,
    expect: null,
    registry: DEFAULT_REGISTRY_PATH,
    printSql: false,
    writeDrafts: false,
    draftsDir: DEFAULT_DRAFTS_DIR,
    liveCheck: false,
    apply: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fixture" || arg === "--input") {
      args.source = argv[++i];
    } else if (arg === "--task-id") {
      args.taskId = argv[++i];
    } else if (arg === "--expect") {
      args.expect = argv[++i];
    } else if (arg === "--registry") {
      args.registry = argv[++i];
    } else if (arg === "--sql") {
      args.printSql = true;
    } else if (arg === "--write-drafts") {
      args.writeDrafts = true;
    } else if (arg === "--drafts-dir") {
      args.draftsDir = argv[++i];
    } else if (arg === "--live-check") {
      args.liveCheck = true;
    } else if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.expect && !EXPECTED_STATUSES.has(args.expect)) {
    throw new Error(`Invalid --expect value: ${args.expect}`);
  }
  if (args.liveCheck && args.apply) {
    throw new Error("--live-check and --apply are mutually exclusive.");
  }
  if ((args.liveCheck || args.apply) && (args.source || args.writeDrafts)) {
    throw new Error("--live-check/--apply fetch live packets; they cannot combine with --fixture, --input, or --write-drafts.");
  }
  if ((args.liveCheck || args.apply) && !args.taskId) {
    throw new Error("--live-check/--apply require --task-id (OE-8C runs single-task).");
  }
  return args;
}

function parseJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadRegistry(path) {
  return parseJson(path);
}

function normalizeInput(input) {
  if (Array.isArray(input.tasks)) {
    return {
      generated_at: input.generated_at || null,
      tasks: input.tasks.map(normalizeTask),
      actionItems: input.actionItems || input.action_items || [],
    };
  }

  if (input.task) {
    return {
      generated_at: input.generated_at || null,
      tasks: [normalizeTask({ ...input.task, events: input.events || input.task.events })],
      actionItems: input.actionItems || input.action_items || [],
    };
  }

  throw new Error("Input must include tasks[] or task.");
}

function normalizeTask(task) {
  const events = Array.isArray(task.events) ? task.events : [];
  return {
    ...task,
    project_slug: task.project_slug || task.projectSlug || null,
    linked_action_item_id: task.linked_action_item_id || task.linkedActionItemId || null,
    explicit_approval: Boolean(task.explicit_approval ?? task.explicitApproval),
    events,
  };
}

function evaluate(input, registry, options = {}) {
  const data = normalizeInput(input);
  const selectedTasks = options.taskId
    ? data.tasks.filter((task) => task.id === options.taskId)
    : data.tasks;

  const apply = [];
  const hold = [];

  if (options.taskId && selectedTasks.length === 0) {
    hold.push({
      task_id: options.taskId,
      reasons: ["TASK_NOT_FOUND"],
      message: `No task with id ${options.taskId} exists in the supplied input.`,
    });
  }

  for (const task of selectedTasks) {
    const result = evaluateTask(task, registry, data.actionItems);
    if (result.applyable) {
      apply.push(result.proposed);
    } else {
      hold.push({
        task_id: task.id,
        project_slug: task.project_slug || null,
        reasons: result.reasons,
        message: result.message,
      });
    }
  }

  const draftDate = draftDateFrom(data.generated_at);
  const projects = buildProjectBatches(apply, registry, draftDate, data.generated_at);
  const status = finalStatus(apply, hold);
  return {
    status,
    mode: options.writeDrafts ? "write-drafts" : "dry-run",
    dry_run: !options.writeDrafts,
    board_mutations: false,
    would_call_apply_agent_task_review: false,
    generated_at: data.generated_at,
    draft_date: draftDate,
    apply,
    hold,
    projects,
  };
}

function draftDateFrom(generatedAt) {
  // Prefer the evidence timestamp so the same input always yields the same
  // file name and bytes; fall back to today only when the input has no stamp.
  const fromInput = typeof generatedAt === "string" ? generatedAt.slice(0, 10) : null;
  if (fromInput && /^\d{4}-\d{2}-\d{2}$/.test(fromInput)) return fromInput;
  return new Date().toISOString().slice(0, 10);
}

function evaluateTask(task, registry, actionItems) {
  const reasons = [];
  if (!SAFE_STATUSES.has(task.status)) reasons.push("STATUS_NOT_AGENT_REVIEW");
  if (!SAFE_RISKS.has(task.risk)) reasons.push("RISK_NOT_LOW");
  if (!task.project_slug) reasons.push("MISSING_PROJECT_SLUG");

  const route = task.project_slug ? registry[task.project_slug] : null;
  if (!route) {
    reasons.push("UNKNOWN_PROJECT_ROUTE");
  } else {
    for (const [field, path] of Object.entries({
      workspace_path: route.workspace_path,
      tracker_path: route.tracker_path,
      session_log_path: route.session_log_path,
    })) {
      if (!path || !existsSync(path)) reasons.push(`UNRESOLVED_${field.toUpperCase()}`);
    }
    if (!route.capture_tag) reasons.push("MISSING_CAPTURE_TAG");
  }

  const doneEvents = task.events.filter((event) => event.event_type === "AGENT DONE");
  if (doneEvents.length !== 1) reasons.push("AGENT_DONE_EVENT_COUNT");
  const receiptText = doneEvents.length === 1 ? receiptFromEvent(doneEvents[0]) : "";
  const receipt = parseReceipt(receiptText);

  // Review-note augmentation path: a human review note stored on the task row
  // (agent_tasks.review_reason) may supply sections the AGENT DONE receipt is
  // missing. Only missing sections are taken from it — the immutable AGENT DONE
  // event stays authoritative for every section it already carries, and the
  // 8-section gate itself is unchanged: all 8 must be present somewhere.
  const augmentation = augmentFromReviewNote(receipt, task.review_reason);
  if (augmentation.missing.length > 0) reasons.push("RECEIPT_MISSING_SECTION");

  if (reasons.length > 0) {
    return {
      applyable: false,
      reasons,
      message: holdMessage(reasons, augmentation),
    };
  }

  const linkedActionItem = findActionItem(actionItems, task.linked_action_item_id);
  return {
    applyable: true,
    reasons: [],
    proposed: {
      task_id: task.id,
      project_slug: task.project_slug,
      title: task.title || null,
      applied_by: "closeout-controller",
      resolution: "accepted",
      resolve_linked_action_item: false,
      linked_action_item_id: task.linked_action_item_id,
      linked_action_item_status: linkedActionItem?.status || null,
      receipt_sections: augmentation.sections,
      augmented_sections: augmentation.augmented,
      augmentation_text: augmentation.augmented.length > 0 ? String(task.review_reason) : null,
      closeout_evidence: {
        dry_run_only: true,
        source: "oe8-closeout-controller",
        required_sections_present: REQUIRED_RECEIPT_SECTIONS,
      },
    },
  };
}

function augmentFromReviewNote(receipt, reviewReason) {
  const sections = { ...receipt.sections };
  const augmented = [];
  const note = typeof reviewReason === "string" ? reviewReason : "";

  if (receipt.missing.length > 0 && note.trim()) {
    const noteSections = parseReceipt(note).sections;
    for (const heading of receipt.missing) {
      const candidate = String(noteSections[heading] || "").trim();
      if (candidate) {
        sections[heading] = candidate;
        augmented.push(heading);
      }
    }
  }

  const missing = REQUIRED_RECEIPT_SECTIONS
    .map(canonicalHeading)
    .filter((heading) => !String(sections[heading] || "").trim());
  return { sections, missing, augmented };
}

function receiptFromEvent(event) {
  // move_agent_task_status writes the receipt body to payload.reason — the
  // field the --sql bundle selects. The remaining keys are legacy fallbacks.
  if (typeof event.payload?.reason === "string") return event.payload.reason;
  if (typeof event.text === "string") return event.text;
  if (typeof event.result === "string") return event.result;
  if (typeof event.note === "string") return event.note;
  if (typeof event.payload?.result === "string") return event.payload.result;
  if (typeof event.payload?.receipt === "string") return event.payload.receipt;
  if (typeof event.payload?.note === "string") return event.payload.note;
  return "";
}

function parseReceipt(text) {
  const sections = {};
  const headingPattern = new RegExp(
    `^(${REQUIRED_RECEIPT_SECTIONS.map(escapeRegExp).join("|")}):\\s*$`,
    "i",
  );
  let current = null;

  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(headingPattern);
    if (match) {
      current = canonicalHeading(match[1]);
      sections[current] = "";
      continue;
    }
    if (current) {
      sections[current] = `${sections[current]}${sections[current] ? "\n" : ""}${line}`;
    }
  }

  for (const heading of REQUIRED_RECEIPT_SECTIONS) {
    const canonical = canonicalHeading(heading);
    if (sections[canonical] !== undefined) {
      sections[canonical] = sections[canonical].trim();
    }
  }

  const missing = REQUIRED_RECEIPT_SECTIONS
    .map(canonicalHeading)
    .filter((heading) => !String(sections[heading] || "").trim());
  return { sections, missing };
}

function canonicalHeading(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function holdMessage(reasons, receipt) {
  if (reasons.includes("RECEIPT_MISSING_SECTION")) {
    return `Receipt is missing required sections: ${receipt.missing.join(", ")}.`;
  }
  return `Task held by dry-run safety gates: ${reasons.join(", ")}.`;
}

function findActionItem(actionItems, id) {
  if (!id) return null;
  return (actionItems || []).find((item) => item.id === id) || null;
}

function buildProjectBatches(apply, registry, draftDate, generatedAt) {
  const grouped = new Map();
  for (const item of apply) {
    if (!grouped.has(item.project_slug)) grouped.set(item.project_slug, []);
    grouped.get(item.project_slug).push(item);
  }

  return [...grouped.entries()].map(([projectSlug, items]) => {
    const route = registry[projectSlug];
    const trackerDraft = items.map((item) => item.receipt_sections.tracker_draft).join("\n\n");
    const sessionLogDraft = items.map((item) => item.receipt_sections.session_log_draft).join("\n\n");
    const captureDraft = items.map((item) => item.receipt_sections.brain_bank_capture_draft).join("\n\n");

    const batch = {
      project_slug: projectSlug,
      workspace_path: route.workspace_path,
      tracker_path: route.tracker_path,
      session_log_path: route.session_log_path,
      capture_tag: route.capture_tag,
      tasks: items.map((item) => item.task_id),
      tracker_draft: trackerDraft,
      session_log_draft: sessionLogDraft,
      brain_bank_capture_draft: captureDraft,
    };
    batch.pending_closeout = {
      file_name: `${draftDate}-${sanitizeSlug(projectSlug)}.md`,
      content: renderPendingCloseoutDraft(batch, items, draftDate, generatedAt),
    };
    return batch;
  });
}

function sanitizeSlug(slug) {
  return String(slug).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

function renderPendingCloseoutDraft(batch, items, draftDate, generatedAt) {
  const taskLines = items.map(
    (item) => `- \`${item.task_id}\` — ${item.title || "(untitled)"} [resolution: ${item.resolution}]`,
  );
  return [
    `# Pending closeout draft — ${batch.project_slug}`,
    "",
    `- Draft date: ${draftDate}`,
    `- Evidence generated_at: ${generatedAt || "(not stamped)"}`,
    "- Written by: scripts/open-engine/closeout-controller.mjs (OE-8B draft writer)",
    "- State: PENDING — nothing has been applied. No apply_agent_task_review call, no task",
    "  status change, no tracker/session-log write, no Brain Bank capture has occurred.",
    "- Routing: resolved from project-closeout-registry.json by project_slug (never cwd).",
    "  OE-8C consumes this draft; until then it is staging material only.",
    "",
    "## Route",
    "",
    `- workspace_path: ${batch.workspace_path}`,
    `- tracker_path: ${batch.tracker_path}`,
    `- session_log_path: ${batch.session_log_path}`,
    `- capture_tag: ${batch.capture_tag}`,
    "",
    `## Tasks in this batch (${items.length})`,
    "",
    ...taskLines,
    "",
    "## Tracker draft",
    "",
    batch.tracker_draft,
    "",
    "## Session-log draft",
    "",
    batch.session_log_draft,
    "",
    "## Brain Bank capture draft",
    "",
    batch.brain_bank_capture_draft,
    "",
  ].join("\n");
}

function writeDraftFiles(result, draftsDir) {
  const writes = [];
  const conflicts = [];

  for (const batch of result.projects) {
    const target = join(draftsDir, batch.pending_closeout.file_name);
    const content = batch.pending_closeout.content;

    if (existsSync(target)) {
      const existing = readFileSync(target, "utf8");
      if (existing === content) {
        writes.push({ project_slug: batch.project_slug, path: target, action: "unchanged", bytes: Buffer.byteLength(content) });
        continue;
      }
      conflicts.push({
        project_slug: batch.project_slug,
        path: target,
        reason: "DRAFT_CONFLICT",
        message: "A draft with different content already exists at this path; not overwriting.",
      });
      continue;
    }

    mkdirSync(draftsDir, { recursive: true });
    writeFileSync(target, content, "utf8");
    writes.push({ project_slug: batch.project_slug, path: target, action: "written", bytes: Buffer.byteLength(content) });
  }

  return { writes, conflicts };
}

function finalStatus(apply, hold) {
  if (apply.length > 0 && hold.length === 0) return "APPLYABLE";
  if (apply.length > 0 && hold.length > 0) return "MIXED";
  return "HELD";
}

// --- OE-8C live modes ---------------------------------------------------

function mcpConfigFromEnv() {
  const url = process.env.BRAIN_BANK_MCP_URL;
  const key = process.env.BRAIN_BANK_MCP_KEY;
  if (!url || !key) {
    throw new Error(
      "Live modes need BRAIN_BANK_MCP_URL and BRAIN_BANK_MCP_KEY in the environment (never stored in files).",
    );
  }
  return { url, key };
}

let mcpRequestId = 0;

async function mcpCall(config, name, toolArgs) {
  mcpRequestId += 1;
  const res = await fetch(config.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-brain-key": config.key,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: mcpRequestId,
      method: "tools/call",
      params: { name, arguments: toolArgs },
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`MCP ${name} HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const rpc = parseMcpBody(body);
  if (rpc.error) throw new Error(`MCP ${name} error: ${rpc.error.message}`);
  const textItem = (rpc.result?.content || []).find((c) => c.type === "text");
  const text = textItem?.text ?? "";
  if (rpc.result?.isError) {
    throw new Error(`MCP ${name} tool error: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseMcpBody(body) {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  // SSE envelope: the JSON-RPC response is the last data: line that parses.
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  for (let i = dataLines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(dataLines[i]);
    } catch {
      // keep scanning
    }
  }
  throw new Error(`Unparseable MCP response: ${trimmed.slice(0, 200)}`);
}

function liveInputFromPacket(packet) {
  let obj = packet;
  if (typeof obj === "string") {
    throw new Error(`get_agent_task returned non-JSON text: ${obj.slice(0, 200)}`);
  }
  const task = obj.task || obj;
  if (!task || !task.id) {
    throw new Error("get_agent_task packet has no task.id; cannot evaluate.");
  }
  const events = obj.events || task.events || [];
  return {
    generated_at: new Date().toISOString(),
    tasks: [{ ...task, events }],
    actionItems: obj.actionItems || obj.action_items || [],
  };
}

function closeoutMarker(batch, draftDate) {
  return `<!-- open-engine closeout ${draftDate} tasks: ${batch.tasks.join(", ")} -->`;
}

function appendCloseoutBlock(path, heading, marker, draftContent) {
  const existing = readFileSync(path, "utf8");
  if (existing.includes(marker)) {
    return { path, action: "unchanged", reason: "marker already present" };
  }
  const block = [
    "",
    "---",
    "",
    heading,
    "",
    marker,
    "",
    draftContent.trim(),
    "",
  ].join("\n");
  writeFileSync(path, `${existing.replace(/\n*$/, "\n")}${block}`, "utf8");
  return { path, action: "appended", bytes: Buffer.byteLength(block) };
}

async function runLive(args, registry) {
  const config = mcpConfigFromEnv();
  const packet = await mcpCall(config, "get_agent_task", { task_id: args.taskId });
  const input = liveInputFromPacket(packet);
  const result = evaluate(input, registry, { taskId: args.taskId });
  result.mode = args.apply ? "apply" : "live-check";
  result.dry_run = !args.apply;

  if (!args.apply) {
    printResult(result);
    if (args.expect && result.status !== args.expect) {
      throw new Error(`Expected ${args.expect}, got ${result.status}.`);
    }
    return;
  }

  if (result.status !== "APPLYABLE") {
    printResult(result);
    throw new Error(
      "Refusing to apply: evaluation is not APPLYABLE. Held tasks stay in Agent Review with the reasons above.",
    );
  }

  // Ordering per the OE-8 contract: apply gate first (one AGENT APPLIED per
  // task), then one tracker/session-log write per project batch, then one
  // Brain Bank capture per project batch. The controller never runs git.
  result.applied = [];
  for (const item of result.apply) {
    const applyResult = await mcpCall(config, "apply_agent_task_review", {
      task_id: item.task_id,
      applied_by: "closeout-controller",
      resolution: "accepted",
      resolve_linked_action_item: false,
      // No note: apply_agent_task_review would overwrite review_reason with
      // it. The augmentation is made durable on the immutable AGENT APPLIED
      // event via closeout_evidence instead.
      closeout_evidence: {
        source: "oe8-closeout-controller",
        mode: "oe8c-single-task",
        required_sections_present: REQUIRED_RECEIPT_SECTIONS,
        augmented_sections: item.augmented_sections,
        review_note_augmentation: item.augmentation_text || undefined,
      },
    });
    result.applied.push({ task_id: item.task_id, apply_result: applyResult });
  }
  result.board_mutations = true;

  result.closeout_writes = [];
  result.captures = [];
  for (const batch of result.projects) {
    const marker = closeoutMarker(batch, result.draft_date);
    result.closeout_writes.push(
      appendCloseoutBlock(
        batch.tracker_path,
        `## Agent closeout — ${result.draft_date} (Open Engine OE-8C)`,
        marker,
        batch.tracker_draft,
      ),
      appendCloseoutBlock(
        batch.session_log_path,
        `## Agent closeout — ${result.draft_date} (Open Engine OE-8C)`,
        marker,
        batch.session_log_draft,
      ),
    );
    const capture = await mcpCall(config, "capture_thought", {
      content: batch.brain_bank_capture_draft,
      tags: [batch.capture_tag, "open_engine"],
    });
    result.captures.push({ project_slug: batch.project_slug, capture_result: capture });
  }

  printResult(result);
}

function printSql() {
  console.log(`-- OE-8A read-only Agent Review evidence collection.
-- Paste results into a JSON file matching scripts/open-engine/closeout-controller.mjs input shape.
-- These queries do not mutate task state, cron, action_items, trackers, or captures.

select
  t.id,
  t.title,
  t.status,
  t.risk,
  t.project_slug,
  t.explicit_approval,
  t.claimed_by,
  t.linked_action_item_id,
  t.review_reason,
  t.updated_at
from public.agent_tasks t
where t.status = 'Agent Review'
  and t.archived_at is null
order by t.updated_at asc;

select
  e.task_id,
  e.event_type,
  e.agent_code,
  e.payload,
  e.created_at
from public.agent_task_events e
join public.agent_tasks t on t.id = e.task_id
where t.status = 'Agent Review'
  and t.archived_at is null
order by e.task_id, e.created_at asc;

select
  a.id,
  a.status,
  a.resolved_at
from public.action_items a
where a.id in (
  select linked_action_item_id
  from public.agent_tasks
  where status = 'Agent Review'
    and archived_at is null
    and linked_action_item_id is not null
)
order by a.id;`);
}

function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.printSql) {
    printSql();
    return;
  }
  if (args.liveCheck || args.apply) {
    await runLive(args, loadRegistry(args.registry));
    return;
  }
  if (!args.source) {
    throw new Error("Missing --fixture or --input. Use --help for usage.");
  }

  const registry = loadRegistry(args.registry);
  const input = parseJson(args.source);
  const result = evaluate(input, registry, { taskId: args.taskId, writeDrafts: args.writeDrafts });

  if (args.writeDrafts) {
    const report = writeDraftFiles(result, args.draftsDir);
    result.drafts_dir = args.draftsDir;
    result.draft_writes = report.writes;
    result.draft_conflicts = report.conflicts;
    printResult(result);
    if (report.conflicts.length > 0) {
      throw new Error(`Draft conflict: ${report.conflicts.map((c) => c.path).join(", ")}`);
    }
  } else {
    printResult(result);
  }

  if (args.expect && result.status !== args.expect) {
    throw new Error(`Expected ${args.expect}, got ${result.status}.`);
  }
}

main().catch((err) => {
  console.error(`closeout-controller: ${(err).message}`);
  process.exit(1);
});
