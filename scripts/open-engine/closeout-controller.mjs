#!/usr/bin/env node
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REGISTRY_PATH = join(__dirname, "project-closeout-registry.json");
// Draft output is anchored to this repo, never to process.cwd() — routing and
// output location must not depend on where the controller is invoked from.
const REPO_ROOT = join(__dirname, "..", "..");
const DEFAULT_DRAFTS_DIR = join(
  REPO_ROOT,
  "docs",
  "handoffs",
  "pending-closeouts",
);
const DEFAULT_JOURNAL_DIR = join(DEFAULT_DRAFTS_DIR, "journal");
const FETCH_TIMEOUT_MS = 60_000;

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

// OE-8E operator-resolution sweep. An OPERATOR DONE note shorter than this
// (trimmed) is treated as non-substantive ("done", "sent") and skipped rather
// than spamming one tracker block per trivial resolution.
const RESOLUTION_NOTE_MIN_CHARS = 80;
const RESOLUTION_LOOKBACK_DAYS_DEFAULT = 7;
// list_agent_tasks caps at 50; the sweep reports this so a truncated scan is
// never mistaken for full coverage (no-silent-caps).
const RESOLUTION_SCAN_LIMIT = 50;

function usage() {
  return `Usage:
  node scripts/open-engine/closeout-controller.mjs --fixture <file.json> [--task-id <uuid>] [--expect APPLYABLE|HELD|MIXED]
  node scripts/open-engine/closeout-controller.mjs --input <file.json> [--task-id <uuid>] [--expect APPLYABLE|HELD|MIXED]
  node scripts/open-engine/closeout-controller.mjs --input <file.json> --write-drafts [--drafts-dir <dir>]
  node scripts/open-engine/closeout-controller.mjs --task-id <uuid> --live-check
  node scripts/open-engine/closeout-controller.mjs --task-id <uuid> --apply
  node scripts/open-engine/closeout-controller.mjs --resume <uuid>
  node scripts/open-engine/closeout-controller.mjs --capture-run-summary --remaining-agent-review <n> [--applied-task-ids <ids>] [--held-tasks <id:reason;...>] [--notable <text>] [--run-timestamp <iso>] [--summary-preview]
  node scripts/open-engine/closeout-controller.mjs --operator-resolution-sweep [--live-check] [--lookback-days <n>] [--no-capture]
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

OE-8C live modes need BB_MCP_URL and BB_MCP_KEY in the
environment and a --task-id (single-task discipline). --live-check fetches the
task packet through the guarded MCP get_agent_task and prints the evaluation
READ-ONLY. --apply, for an APPLYABLE task only: calls apply_agent_task_review
(exactly one AGENT APPLIED, resolution accepted, never resolves linked action
items), appends the receipt's tracker/session-log drafts to the routed project
files (marker-guarded, append-only, never overwrites), and captures one Open
Brain thought per project batch. The controller never runs git - committing
closeout writes stays human/session-side (locked decision, Session 268). A
non-APPLYABLE task is reported and NOT applied; the gate is never relaxed. An
APPLYABLE task whose receipt carries an OPERATOR-ACTION marker (a line
"OPERATOR-ACTION: <step> || OPERATOR-TARGET: <url-or-path>" inside the Follow-up
recommendation) routes to Needs Operator with the operator step preserved;
otherwise it closes to Agent Done as before. An OPERATOR-ACTION marker found
anywhere OUTSIDE the Follow-up recommendation section holds the task
(OPERATOR_MARKER_OUTSIDE_FOLLOW_UP) instead of silently dropping the step. A
task seeded from a project plan doc (a "plan-doc: <path>" entry in its sources)
is reconciled at apply: the controller greps that plan-doc's folder for the
task short-id tag [OE:<shortid>] and flips every carded line to done
(checkbox [ ]->[x] and "carded <date>"->"done <apply-date>"), skipping session
logs. If the tagged line cannot be located the task HOLDs
(PLAN_DOC_LINE_NOT_FOUND) instead of applying, and an unresolvable plan-doc path
HOLDs (PLAN_DOC_PATH_UNRESOLVED) — no apply without doc sync. Before --apply
calls the board, it
writes a local journal under docs/handoffs/pending-closeouts/journal/. If board
apply succeeds but file/capture closeout fails, --resume <uuid> confirms the
live task has an AGENT APPLIED event and replays the pending file/capture phase
from that journal.

OE-8D run-summary capture is additive logging only. It calls capture_thought
once for the whole automation run, tagged open-engine/closeout/oe-8d, using
counts, short ids, hold reasons, remaining Agent Review count, and one notable
clause. It never applies tasks, edits project files, changes gates, or resolves
linked action items.

OE-8E (--operator-resolution-sweep) closes the operator-decision gap: closeout
writes trackers at Agent Review time with the EXECUTOR's drafts, so a decision
made later at the Needs Operator step (defer, reject, scope change) lives only
on the OPERATOR DONE board event. The sweep lists recent Agent Done tasks,
keeps only ones whose FINAL status-bearing event is a human OPERATOR DONE with
a note of ${RESOLUTION_NOTE_MIN_CHARS}+ trimmed chars inside the lookback
window (default ${RESOLUTION_LOOKBACK_DAYS_DEFAULT} days), routes by
project_slug through the registry, and appends the note verbatim to the routed
tracker under a per-task date-free marker (idempotent, append-only). One Brain
Bank capture per appended task unless --no-capture. --live-check prints the
would-append report without writing. NO board mutations, no session-log
writes, no git, no journal (a single marker-guarded append re-runs cleanly).`;
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
    resumeTaskId: null,
    journalDir: DEFAULT_JOURNAL_DIR,
    captureRunSummary: false,
    summaryPreview: false,
    appliedTaskIds: "",
    heldTasks: "",
    remainingAgentReview: null,
    notable: "nominal",
    runTimestamp: null,
    operatorResolutionSweep: false,
    lookbackDays: RESOLUTION_LOOKBACK_DAYS_DEFAULT,
    noCapture: false,
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
    } else if (arg === "--resume") {
      args.resumeTaskId = argv[++i];
    } else if (arg === "--journal-dir") {
      args.journalDir = argv[++i];
    } else if (arg === "--capture-run-summary") {
      args.captureRunSummary = true;
    } else if (arg === "--summary-preview") {
      args.summaryPreview = true;
    } else if (arg === "--applied-task-ids") {
      args.appliedTaskIds = argv[++i] || "";
    } else if (arg === "--held-tasks") {
      args.heldTasks = argv[++i] || "";
    } else if (arg === "--remaining-agent-review") {
      args.remainingAgentReview = argv[++i];
    } else if (arg === "--notable") {
      args.notable = argv[++i] || "nominal";
    } else if (arg === "--run-timestamp") {
      args.runTimestamp = argv[++i];
    } else if (arg === "--operator-resolution-sweep") {
      args.operatorResolutionSweep = true;
    } else if (arg === "--lookback-days") {
      args.lookbackDays = argv[++i];
    } else if (arg === "--no-capture") {
      args.noCapture = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.expect && !EXPECTED_STATUSES.has(args.expect)) {
    throw new Error(`Invalid --expect value: ${args.expect}`);
  }
  if (
    [args.liveCheck, args.apply, Boolean(args.resumeTaskId)].filter(Boolean)
      .length > 1
  ) {
    throw new Error(
      "--live-check, --apply, and --resume are mutually exclusive.",
    );
  }
  if (
    args.captureRunSummary &&
    (args.liveCheck || args.apply || args.resumeTaskId || args.source ||
      args.writeDrafts || args.printSql)
  ) {
    throw new Error(
      "--capture-run-summary cannot combine with task evaluation, --sql, or draft modes.",
    );
  }
  if (
    (args.liveCheck || args.apply || args.resumeTaskId) &&
    (args.source || args.writeDrafts)
  ) {
    throw new Error(
      "--live-check/--apply/--resume fetch live packets; they cannot combine with --fixture, --input, or --write-drafts.",
    );
  }
  if ((args.liveCheck || args.apply) && !args.taskId && !args.operatorResolutionSweep) {
    throw new Error(
      "--live-check/--apply require --task-id (OE-8C runs single-task).",
    );
  }
  if (args.operatorResolutionSweep) {
    if (
      args.apply || args.resumeTaskId || args.source || args.writeDrafts ||
      args.captureRunSummary || args.printSql || args.taskId
    ) {
      throw new Error(
        "--operator-resolution-sweep combines only with --live-check, --lookback-days, and --no-capture.",
      );
    }
    if (!/^\d+$/.test(String(args.lookbackDays)) || Number(args.lookbackDays) < 1) {
      throw new Error("--lookback-days must be a positive integer.");
    }
    args.lookbackDays = Number(args.lookbackDays);
  }
  if (args.resumeTaskId && !isUuidish(args.resumeTaskId)) {
    throw new Error("--resume requires a task id.");
  }
  if (args.captureRunSummary && args.remainingAgentReview === null) {
    throw new Error("--capture-run-summary requires --remaining-agent-review.");
  }
  if (
    args.captureRunSummary && !/^\d+$/.test(String(args.remainingAgentReview))
  ) {
    throw new Error("--remaining-agent-review must be a non-negative integer.");
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
      tasks: [
        normalizeTask({
          ...input.task,
          events: input.events || input.task.events,
        }),
      ],
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
    linked_action_item_id: task.linked_action_item_id ||
      task.linkedActionItemId || null,
    explicit_approval: Boolean(task.explicit_approval ?? task.explicitApproval),
    sources: Array.isArray(task.sources) ? task.sources : [],
    events,
  };
}

export function evaluate(input, registry, options = {}) {
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
      message:
        `No task with id ${options.taskId} exists in the supplied input.`,
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
  const projects = buildProjectBatches(
    apply,
    registry,
    draftDate,
    data.generated_at,
  );
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
  const fromInput = typeof generatedAt === "string"
    ? generatedAt.slice(0, 10)
    : null;
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
    for (
      const [field, path] of Object.entries({
        workspace_path: route.workspace_path,
        tracker_path: route.tracker_path,
        session_log_path: route.session_log_path,
      })
    ) {
      if (!path || !existsSync(path)) {
        reasons.push(`UNRESOLVED_${field.toUpperCase()}`);
      }
    }
    if (!route.capture_tag) reasons.push("MISSING_CAPTURE_TAG");
  }

  const doneEvents = task.events.filter((event) =>
    event.event_type === "AGENT DONE"
  );
  if (doneEvents.length < 1) reasons.push("AGENT_DONE_EVENT_COUNT");
  const latestDoneEvent = latestEvent(doneEvents);
  // Post-DONE ops-amend corrections are invisible to the receipt build (it
  // reads only the latest AGENT DONE; review-note augmentation fills only
  // missing sections). If an ops-amend is NEWER than the receipt about to be
  // applied, the tracker draft may be stale — hold for a human instead of
  // silently applying it. Author fix: post a superseding AGENT DONE that folds
  // the corrections in, then re-run.
  if (latestDoneEvent) {
    const doneAt = new Date(latestDoneEvent.created_at).getTime();
    const hasNewerOpsAmend = task.events.some((event) =>
      event.event_type === "AGENT STATUS" &&
      event.payload?.action === "ops-amend" &&
      new Date(event.created_at).getTime() > doneAt
    );
    if (hasNewerOpsAmend) reasons.push("OPS_AMEND_NEWER_THAN_DONE");
  }
  const receiptText = latestDoneEvent ? receiptFromEvent(latestDoneEvent) : "";
  const receipt = parseReceipt(receiptText);
  reasons.push(...receipt.reasons);

  // Review-note augmentation path: a human review note stored on the task row
  // (agent_tasks.review_reason) may supply sections the AGENT DONE receipt is
  // missing. Only missing sections are taken from it — the immutable AGENT DONE
  // event stays authoritative for every section it already carries, and the
  // 8-section gate itself is unchanged: all 8 must be present somewhere.
  const augmentation = augmentFromReviewNote(receipt, task.review_reason);
  reasons.push(...augmentation.reasons);
  if (augmentation.missing.length > 0) reasons.push("RECEIPT_MISSING_SECTION");
  const followUpHeading = canonicalHeading("Follow-up recommendation");
  const operator = parseOperatorAction(augmentation.sections[followUpHeading]);
  reasons.push(...operator.reasons);
  // A marker outside Follow-up recommendation holds the task instead of
  // silently closing it to Agent Done — the operator step must never be lost
  // to a placement mistake (Fix Session A decision, 2026-07-10).
  const markerSources = [receiptText];
  if (augmentation.augmented.length > 0) {
    markerSources.push(String(task.review_reason || ""));
  }
  const totalMarkers = markerSources.reduce(
    (count, text) => count + countOperatorMarkers(text),
    0,
  );
  if (
    totalMarkers > countOperatorMarkers(augmentation.sections[followUpHeading])
  ) {
    reasons.push("OPERATOR_MARKER_OUTSIDE_FOLLOW_UP");
  }

  // Operator-install gate (Session 344): the write-safe policy means an executor
  // never installs its own output — it stages a file under deliverables/ that a
  // human must move. Applying such a task with no operator step recorded closes
  // it to Agent Done while the staged file sits uninstalled and untracked (the
  // Session 343 strand). Evidence of a staged deliverable therefore makes the
  // operator marker mandatory. Fails closed: a HOLD is recoverable, a strand is
  // invisible.
  const stagedDeliverable = markerSources.some(receiptNamesDeliverable);
  if (stagedDeliverable && !operator.operator) {
    reasons.push("DELIVERABLE_WITHOUT_OPERATOR_ACTION");
  }

  // A marker appended mid-line to a prose sentence ("...decide first.
  // OPERATOR-ACTION: call the vendor ...") is invisible to the line-anchored
  // parser, so the task applies with its operator step silently dropped. The
  // parser stays strict (the anchor is what makes marker injection detectable);
  // the malformed marker becomes a visible HOLD instead of a silent loss.
  if (
    !operator.operator &&
    /OPERATOR-ACTION:\s*\S/i.test(augmentation.sections[followUpHeading] || "")
  ) {
    reasons.push("OPERATOR_MARKER_NOT_LINE_ANCHORED");
  }

  // Plan-doc reconciliation gate (Session 335): a task seeded directly from a
  // project plan doc carries a `plan-doc: <path>` source entry. Applying it
  // must flip that doc's carded line to done, so the line's existence is a hard
  // apply gate — the same gate-integrity behavior as a missing receipt section.
  // The scan is read-only here; the actual flip runs only in the apply path.
  const planDocFlip = evaluatePlanDocGate(task, route, reasons);

  const uniqueReasons = [...new Set(reasons)];
  if (uniqueReasons.length > 0) {
    return {
      applyable: false,
      reasons: uniqueReasons,
      message: holdMessage(uniqueReasons, augmentation),
    };
  }

  const linkedActionItem = findActionItem(
    actionItems,
    task.linked_action_item_id,
  );
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
      // Set when the task carries a locatable plan-doc line; the apply path
      // flips its checkbox + carded->done tag. Null for captured-work tasks.
      plan_doc_flip: planDocFlip,
      receipt_sections: augmentation.sections,
      augmented_sections: augmentation.augmented,
      augmentation_text: augmentation.augmented.length > 0
        ? String(task.review_reason)
        : null,
      // parseReceipt keys sections by canonicalHeading() (snake_case), e.g.
      // "Follow-up recommendation" -> "follow_up_recommendation". Use the same
      // canonicalizer so the accessor can never drift from the parser.
      operator: operator.operator,
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
  const reasons = [...(receipt.reasons || [])];
  const note = typeof reviewReason === "string" ? reviewReason : "";

  if (receipt.missing.length > 0 && note.trim()) {
    const noteReceipt = parseReceipt(note);
    reasons.push(...noteReceipt.reasons);
    const noteSections = noteReceipt.sections;
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
  return { sections, missing, augmented, reasons: [...new Set(reasons)] };
}

// --- Plan-doc reconciliation (Session 335) ------------------------------
//
// Board tasks seeded straight from a project plan doc carry a machine-readable
// back-reference in their sources array: "plan-doc: <path>". At closeout apply
// the controller flips the doc's carded line to done, keeping the plan doc and
// the board from drifting into two sources of truth. The line is located by
// grepping the plan-doc's own folder for the task short-id tag [OE:<shortid>],
// which flips every occurrence (an item is usually on both the plan-doc line
// and the project tracker todo). Session logs are append-only history, never a
// live checklist, so they are excluded from the flip.

// SESSION-LOG.md / SESSION-LOG-ARCHIVE.md are durable history; flipping a tag
// quoted there would corrupt the record, so the scan skips them.
const SESSION_LOG_NAME = /^SESSION-LOG(-ARCHIVE)?\.md$/i;

export function planDocRefs(sources) {
  if (!Array.isArray(sources)) return [];
  const refs = [];
  for (const entry of sources) {
    const match = String(entry ?? "").match(/^\s*plan-doc:\s*(.+?)\s*$/i);
    if (match) refs.push(match[1]);
  }
  return refs;
}

export function resolvePlanDocPath(relPath, route) {
  if (!relPath) return null;
  if (isAbsolute(relPath)) return relPath;
  // A stored plan-doc path is relative to the Projects root (e.g.
  // "Projects/example-site/seo/PLAN.md"). Anchor it to the parent of
  // the route's /Projects/ segment so it resolves regardless of how deep the
  // workspace nests under Projects.
  const workspace = route?.workspace_path || "";
  const idx = workspace.indexOf("/Projects/");
  if (idx === -1) return null;
  return join(workspace.slice(0, idx), relPath);
}

export function flipDocLineText(line, shortId, doneDate) {
  const sid = escapeRegExp(shortId);
  const cardedTag = new RegExp(`OE:${sid}\\s+carded\\s+\\d{4}-\\d{2}-\\d{2}`);
  if (!cardedTag.test(line)) return { changed: false, line };
  let next = line.replace(cardedTag, `OE:${shortId} done ${doneDate}`);
  // Flip a markdown list checkbox only on the tagged line, never the [OE:...]
  // bracket. Heading lines have no checkbox and get the tag flip alone.
  next = next.replace(/^(\s*[-*]\s+)\[ \]/, "$1[x]");
  return { changed: next !== line, line: next };
}

function markdownFilesToScan(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((name) => {
    if (!name.toLowerCase().endsWith(".md")) return false;
    if (SESSION_LOG_NAME.test(name)) return false;
    const full = join(dir, name);
    try {
      return statSync(full).isFile();
    } catch {
      return false;
    }
  });
}

export function scanPlanDocDir(dir, shortId) {
  const occurrences = [];
  if (!dir || !existsSync(dir)) return { found: false, occurrences };
  const sid = escapeRegExp(shortId);
  // Any tag state (carded/done/archived) counts as "found" for the apply gate.
  const tagAnywhere = new RegExp(`OE:${sid}(?=[\\s\\]])`);
  for (const name of markdownFilesToScan(dir)) {
    const lines = readFileSync(join(dir, name), "utf8").split(/\r?\n/);
    lines.forEach((text, i) => {
      if (tagAnywhere.test(text)) {
        occurrences.push({ file: name, line: i + 1, text });
      }
    });
  }
  return { found: occurrences.length > 0, occurrences };
}

export function applyDocFlip(dirs, shortId, doneDate) {
  const files = [];
  let flipped = 0;
  for (const dir of dirs || []) {
    if (!dir || !existsSync(dir)) continue;
    for (const name of markdownFilesToScan(dir)) {
      const full = join(dir, name);
      const lines = readFileSync(full, "utf8").split(/\r?\n/);
      let fileFlips = 0;
      const nextLines = lines.map((line) => {
        const result = flipDocLineText(line, shortId, doneDate);
        if (result.changed) fileFlips += 1;
        return result.line;
      });
      if (fileFlips > 0) {
        writeFileSync(full, nextLines.join("\n"), "utf8");
        files.push({ path: full, flipped: fileFlips });
        flipped += fileFlips;
      }
    }
  }
  return { flipped, files };
}

// Read-only apply gate: if the task carries plan-doc source(s), confirm the
// carded line is locatable so the apply can flip it. Pushes a hold reason (and
// returns null) when the path cannot be resolved or the tag cannot be found;
// returns the flip target ({short_id, dirs}) when the line exists.
function evaluatePlanDocGate(task, route, reasons) {
  const planDocs = planDocRefs(task.sources);
  if (planDocs.length === 0) return null;
  const shortId = shortTaskId(task.id);
  const resolved = planDocs.map((relPath) => resolvePlanDocPath(relPath, route));
  if (resolved.some((path) => !path)) {
    reasons.push("PLAN_DOC_PATH_UNRESOLVED");
    return null;
  }
  const dirs = [...new Set(resolved.map((path) => dirname(path)))];
  const found = dirs.some((dir) => scanPlanDocDir(dir, shortId).found);
  if (!found) {
    reasons.push("PLAN_DOC_LINE_NOT_FOUND");
    return null;
  }
  return { short_id: shortId, dirs };
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

export function extractOperatorAction(followUpText) {
  return parseOperatorAction(followUpText).operator;
}

// A named file under deliverables/ is the receipt's own evidence that the run
// staged a file it did not install. A bare "deliverables/" mention in prose is
// not: only a path with a file extension counts, so a receipt that says nothing
// was written outside deliverables/ stays clean.
const DELIVERABLE_PATH = /(?:^|[\s`"'(<[])deliverables\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,8}\b/;

export function receiptNamesDeliverable(text) {
  return DELIVERABLE_PATH.test(String(text || ""));
}

function parseOperatorAction(followUpText) {
  // Explicit marker only — never fuzzy NLP. Line form:
  //   OPERATOR-ACTION: <step> || OPERATOR-TARGET: <url-or-path>
  // OPERATOR-TARGET (and the ||) are optional.
  const lines = String(followUpText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^OPERATOR-ACTION:/i.test(l));
  if (lines.length === 0) return { operator: null, reasons: [] };
  if (lines.length > 1) {
    return { operator: null, reasons: ["OPERATOR_MARKER_COUNT"] };
  }
  const line = lines[0];
  if (!line) return { operator: null, reasons: [] };
  const body = line.replace(/^OPERATOR-ACTION:/i, "").trim();
  const parts = body.split(/\s*\|\|\s*/);
  if (parts.length > 2) {
    return { operator: null, reasons: ["OPERATOR_MARKER_FORMAT"] };
  }
  const [actionPart, targetPart] = parts;
  const operator_action = actionPart.trim();
  if (!operator_action) return { operator: null, reasons: [] };
  let operator_target = null;
  if (targetPart) {
    if (!/^OPERATOR-TARGET:/i.test(targetPart.trim())) {
      return { operator: null, reasons: ["OPERATOR_TARGET_LABEL_MISSING"] };
    }
    operator_target = targetPart.replace(/^OPERATOR-TARGET:/i, "").trim() ||
      null;
    if (operator_target && !isAllowedOperatorTarget(operator_target)) {
      return { operator: null, reasons: ["OPERATOR_TARGET_UNSAFE_SCHEME"] };
    }
  }
  return { operator: { operator_action, operator_target }, reasons: [] };
}

export function parseReceipt(text) {
  const sections = {};
  const seen = new Set();
  const reasons = [];
  if (String(text || "").includes("<!-- open-engine closeout")) {
    reasons.push("RECEIPT_MARKER_INJECTION");
  }
  // A heading may carry its content inline after the colon ("Limitations: none
  // beyond ...") — real receipts write both forms. The line-start anchor is
  // load-bearing: mid-sentence "Verification:" in prose must not open a section.
  const headingPattern = new RegExp(
    `^(${REQUIRED_RECEIPT_SECTIONS.map(escapeRegExp).join("|")}):\\s*(.*)$`,
    "i",
  );
  let current = null;

  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(headingPattern);
    if (match) {
      current = canonicalHeading(match[1]);
      if (seen.has(current)) reasons.push("RECEIPT_DUPLICATE_HEADING");
      seen.add(current);
      sections[current] = match[2].trim();
      continue;
    }
    if (current) {
      sections[current] = `${sections[current]}${
        sections[current] ? "\n" : ""
      }${line}`;
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
  return { sections, missing, reasons: [...new Set(reasons)] };
}

function latestEvent(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  return [...events].sort((a, b) =>
    String(b.created_at || "").localeCompare(String(a.created_at || ""))
  )[0];
}

function countOperatorMarkers(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => /^OPERATOR-ACTION:/i.test(line.trim()))
    .length;
}

function isAllowedOperatorTarget(value) {
  const target = String(value || "").trim();
  if (!target) return true;
  if (/^https?:\/\//i.test(target)) return true;
  // Protocol-relative //host resolves to an external host in a browser, so it
  // must be rejected before the absolute-path branch can accept it.
  if (/^\/\//.test(target)) return false;
  if (/^\/[^\0]+/.test(target)) return true;
  if (
    /^[A-Za-z0-9._/-]+$/.test(target) && !/^[a-z][a-z0-9+.-]*:/i.test(target)
  ) return true;
  return false;
}

function canonicalHeading(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function holdMessage(reasons, receipt) {
  if (reasons.includes("RECEIPT_MARKER_INJECTION")) {
    return "Receipt contains an open-engine closeout marker; held to prevent marker injection.";
  }
  if (reasons.includes("RECEIPT_DUPLICATE_HEADING")) {
    return "Receipt contains duplicate canonical headings; held to prevent section overwrite.";
  }
  if (reasons.includes("OPERATOR_MARKER_OUTSIDE_FOLLOW_UP")) {
    return "Receipt carries an OPERATOR-ACTION marker outside the Follow-up recommendation section; held so the operator step is not silently dropped. Move the marker into Follow-up recommendation and re-run.";
  }
  if (reasons.includes("OPERATOR_MARKER_NOT_LINE_ANCHORED")) {
    return "Receipt's Follow-up recommendation contains an OPERATOR-ACTION marker that is not on its own line (it is appended to a prose sentence), so the parser cannot read it; held so the operator step is not silently dropped. Put the marker on its own line and re-run.";
  }
  if (reasons.includes("DELIVERABLE_WITHOUT_OPERATOR_ACTION")) {
    return "Receipt shows the run staged a deliverable under deliverables/ but carries no OPERATOR-ACTION marker; held so the install step is not lost. Add 'OPERATOR-ACTION: install <deliverable-path> || OPERATOR-TARGET: <install target>' to Follow-up recommendation and re-run.";
  }
  if (reasons.some((reason) => reason.startsWith("OPERATOR_"))) {
    return `Receipt has an invalid operator marker: ${
      reasons.filter((reason) => reason.startsWith("OPERATOR_")).join(", ")
    }.`;
  }
  if (reasons.includes("RECEIPT_MISSING_SECTION")) {
    return `Receipt is missing required sections: ${
      receipt.missing.join(", ")
    }.`;
  }
  if (reasons.includes("OPS_AMEND_NEWER_THAN_DONE")) {
    return "A human correction (ops-amend) was posted after the AGENT DONE this apply would use; its Tracker/Session-log drafts may be stale. Post a superseding AGENT DONE folding the corrections in, then re-run.";
  }
  if (reasons.includes("PLAN_DOC_PATH_UNRESOLVED")) {
    return "Task carries a plan-doc source whose path cannot be resolved to a project folder; held so the doc line is not left un-synced. Fix the plan-doc source path and re-run.";
  }
  if (reasons.includes("PLAN_DOC_LINE_NOT_FOUND")) {
    return "Task carries a plan-doc source but no [OE:<shortid>] carded line was found in that plan-doc folder; held so applying cannot silently skip the doc sync. Restore the tagged doc line (or flip it by hand) and re-run.";
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
    const trackerDraft = items.map((item) =>
      item.receipt_sections.tracker_draft
    ).join("\n\n");
    const sessionLogDraft = items.map((item) =>
      item.receipt_sections.session_log_draft
    ).join("\n\n");
    const captureDraft = items.map((item) =>
      item.receipt_sections.open_brain_capture_draft
    ).join("\n\n");

    const batch = {
      project_slug: projectSlug,
      workspace_path: route.workspace_path,
      tracker_path: route.tracker_path,
      session_log_path: route.session_log_path,
      capture_tag: route.capture_tag,
      tasks: items.map((item) => item.task_id),
      // Plan-doc lines to flip carded->done when this batch applies (one entry
      // per plan-doc-seeded task; empty for captured-work batches).
      plan_doc_flips: items.map((item) => item.plan_doc_flip).filter(Boolean),
      tracker_draft: trackerDraft,
      session_log_draft: sessionLogDraft,
      open_brain_capture_draft: captureDraft,
    };
    batch.pending_closeout = {
      file_name: `${draftDate}-${sanitizeSlug(projectSlug)}.md`,
      content: renderPendingCloseoutDraft(batch, items, draftDate, generatedAt),
    };
    return batch;
  });
}

function sanitizeSlug(slug) {
  return String(slug).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
}

function renderPendingCloseoutDraft(batch, items, draftDate, generatedAt) {
  const taskLines = items.map(
    (item) =>
      `- \`${item.task_id}\` — ${
        item.title || "(untitled)"
      } [resolution: ${item.resolution}]`,
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
    batch.open_brain_capture_draft,
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
        writes.push({
          project_slug: batch.project_slug,
          path: target,
          action: "unchanged",
          bytes: Buffer.byteLength(content),
        });
        continue;
      }
      conflicts.push({
        project_slug: batch.project_slug,
        path: target,
        reason: "DRAFT_CONFLICT",
        message:
          "A draft with different content already exists at this path; not overwriting.",
      });
      continue;
    }

    mkdirSync(draftsDir, { recursive: true });
    writeFileSync(target, content, "utf8");
    writes.push({
      project_slug: batch.project_slug,
      path: target,
      action: "written",
      bytes: Buffer.byteLength(content),
    });
  }

  return { writes, conflicts };
}

function finalStatus(apply, hold) {
  if (apply.length > 0 && hold.length === 0) return "APPLYABLE";
  if (apply.length > 0 && hold.length > 0) return "MIXED";
  return "HELD";
}

function splitList(value) {
  return String(value || "")
    .split(/[,\n;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitHeldList(value) {
  return String(value || "")
    .split(/[\n;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function shortTaskId(value) {
  return String(value || "").trim().slice(0, 8);
}

function parseHeldTasks(value) {
  return splitHeldList(value).map((entry) => {
    const match = entry.match(/^([^:]+):(.+)$/);
    if (!match) {
      return { id: shortTaskId(entry), reasons: "UNKNOWN_HOLD_REASON" };
    }
    return {
      id: shortTaskId(match[1]),
      reasons: match[2].trim().replace(/\s+/g, " "),
    };
  });
}

function bracketedList(items) {
  return `[${items.join(", ")}]`;
}

function buildRunSummary(args) {
  const timestamp = args.runTimestamp || new Date().toISOString();
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(
      "--run-timestamp must be parseable as an ISO/UTC timestamp.",
    );
  }

  const applied = splitList(args.appliedTaskIds).map(shortTaskId);
  const held = parseHeldTasks(args.heldTasks);
  const heldItems = held.map((item) => `${item.id}: ${item.reasons}`);
  const remaining = Number.parseInt(args.remainingAgentReview, 10);
  const notable = (String(args.notable || "nominal").trim() || "nominal")
    .replace(/\.+$/, "");

  return {
    content: `OE-8D closeout run ${
      new Date(timestamp).toISOString()
    }: applied ${applied.length} ${
      bracketedList(applied)
    }, held ${held.length} ${
      bracketedList(heldItems)
    }, ${remaining} Agent Review rows remaining. ${notable}.`,
    tags: ["open-engine", "closeout", "oe-8d"],
  };
}

// --- OE-8C live modes ---------------------------------------------------

function mcpConfigFromEnv() {
  const url = process.env.BB_MCP_URL;
  const key = process.env.BB_MCP_KEY;
  if (!url || !key) {
    throw new Error(
      "Live modes need BB_MCP_URL and BB_MCP_KEY in the environment (never stored in files).",
    );
  }
  return { url, key };
}

let mcpRequestId = 0;

async function mcpCall(config, name, toolArgs) {
  mcpRequestId += 1;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(config.url, {
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
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(
        `MCP ${name} timed out after ${FETCH_TIMEOUT_MS / 1000}s`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
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
    throw new Error(
      `get_agent_task returned non-JSON text: ${obj.slice(0, 200)}`,
    );
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
  return `<!-- open-engine closeout ${draftDate} tasks: ${
    batch.tasks.join(", ")
  } -->`;
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
  appendFileSync(
    path,
    `${existing.endsWith("\n") ? "" : "\n"}${block}`,
    "utf8",
  );
  return { path, action: "appended", bytes: Buffer.byteLength(block) };
}

// ---------------------------------------------------------------------------
// OE-8E operator-resolution sweep. Pure evaluation is exported for tests; the
// live runner below wires it to list_agent_tasks/get_agent_task.
// ---------------------------------------------------------------------------

export function resolutionMarker(taskId) {
  // Date-free and per-task: a resolution happens once, so the marker must not
  // vary with when the sweep runs (a dated marker would re-append on a later
  // sweep of the same task).
  return `<!-- open-engine operator-resolution task: ${taskId} -->`;
}

// packets: array of { task, events } shaped like get_agent_task output.
// Returns { appendable: [...], skipped: [{ task_id, reason }] }. Read-only.
export function evaluateResolutionSweep(packets, registry, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const lookbackDays = options.lookbackDays ?? RESOLUTION_LOOKBACK_DAYS_DEFAULT;
  const noteMin = options.noteMin ?? RESOLUTION_NOTE_MIN_CHARS;
  const cutoffMs = now.getTime() - lookbackDays * 24 * 60 * 60 * 1000;

  const appendable = [];
  const skipped = [];

  for (const packet of packets) {
    const task = packet.task || packet;
    const events = Array.isArray(packet.events)
      ? packet.events
      : (task.events || []);
    const skip = (reason) => skipped.push({ task_id: task.id, reason });

    // The FINAL status-bearing event must be the OPERATOR DONE — if any later
    // event moved status again (ops correction, C3 fold), the note is no
    // longer the last word on this task and hand-repair owns the record.
    const statusEvents = events
      .filter((event) => event?.payload?.status)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const last = statusEvents[statusEvents.length - 1];
    if (
      !last || last.event_type !== "OPERATOR DONE" ||
      last.payload.status !== "Agent Done"
    ) {
      skip("NOT_OPERATOR_DONE");
      continue;
    }
    // The server refuses non-human completed_by on complete_operator_action;
    // this client-side check is belt-and-suspenders, not the real gate.
    const completedBy = String(last.payload.completed_by || "").trim();
    if (!completedBy) {
      skip("NO_COMPLETED_BY");
      continue;
    }
    const note = String(last.payload.note || "").trim();
    if (note.length < noteMin) {
      skip("NOTE_TOO_SHORT");
      continue;
    }
    const eventMs = new Date(last.created_at).getTime();
    if (!Number.isFinite(eventMs) || eventMs < cutoffMs) {
      skip("OUTSIDE_LOOKBACK");
      continue;
    }
    if (!task.project_slug) {
      skip("MISSING_PROJECT_SLUG");
      continue;
    }
    const route = registry[task.project_slug];
    if (!route) {
      skip("UNKNOWN_PROJECT_ROUTE");
      continue;
    }

    // Dated by the OPERATOR DONE event (the decision date), never the sweep
    // run date — a sweep running days later must not misdate the decision.
    const eventDate = String(last.created_at).slice(0, 10);
    appendable.push({
      task_id: task.id,
      project_slug: task.project_slug,
      tracker_path: route.tracker_path,
      capture_tag: route.capture_tag,
      event_date: eventDate,
      heading: `## Operator resolution — ${eventDate} (Open Engine OE-8E)`,
      marker: resolutionMarker(task.id),
      body: `Resolved by ${completedBy} on ${eventDate}: ${note}`,
    });
  }

  return { appendable, skipped };
}

// Tracker only, by design: the resolution is a status/decision record. The
// session log already carries the executor narrative from the original
// closeout; duplicating a long operator note into both files doubles noise
// for zero retrieval gain.
export function appendResolutionBlock(item) {
  return appendCloseoutBlock(
    item.tracker_path,
    item.heading,
    item.marker,
    item.body,
  );
}

async function runOperatorResolutionSweep(args, registry) {
  const config = mcpConfigFromEnv();
  const listed = await mcpCall(config, "list_agent_tasks", {
    statuses: ["Agent Done"],
    include_done: true,
    limit: RESOLUTION_SCAN_LIMIT,
  });
  const rows = Array.isArray(listed) ? listed : (listed?.tasks || []);
  const cutoffMs = Date.now() - args.lookbackDays * 24 * 60 * 60 * 1000;
  const candidates = rows.filter((row) => {
    const completedMs = new Date(row.completed_at || 0).getTime();
    return Number.isFinite(completedMs) && completedMs >= cutoffMs;
  });

  const packets = [];
  for (const row of candidates) {
    packets.push(await mcpCall(config, "get_agent_task", { task_id: row.id }));
  }

  const evaluated = evaluateResolutionSweep(packets, registry, {
    lookbackDays: args.lookbackDays,
  });
  const result = {
    mode: "operator-resolution-sweep",
    dry_run: !!args.liveCheck,
    lookback_days: args.lookbackDays,
    scan_limit: RESOLUTION_SCAN_LIMIT,
    scan_truncated: rows.length >= RESOLUTION_SCAN_LIMIT,
    swept: packets.length,
    appended: [],
    skipped: evaluated.skipped,
    captures: [],
  };

  for (const item of evaluated.appendable) {
    if (args.liveCheck) {
      result.appended.push({
        task_id: item.task_id,
        path: item.tracker_path,
        action: "would-append",
      });
      continue;
    }
    const write = appendResolutionBlock(item);
    result.appended.push({ task_id: item.task_id, ...write });
    // Capture only on a real first append: a marker-skipped task was already
    // captured (or deliberately pre-seeded) on a prior run.
    if (write.action === "appended" && !args.noCapture) {
      const capture = await mcpCall(config, "capture_thought", {
        content: item.body,
        tags: [item.capture_tag, "open_engine", "operator-resolution"],
      });
      result.captures.push({
        task_id: item.task_id,
        capture_result: capture,
      });
    }
  }

  console.log(JSON.stringify(result, null, 2));
}

async function runLive(args, registry) {
  const config = mcpConfigFromEnv();
  const packet = await mcpCall(config, "get_agent_task", {
    task_id: args.taskId,
  });
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
  if (args.expect && result.status !== args.expect) {
    printResult(result);
    throw new Error(`Expected ${args.expect}, got ${result.status}.`);
  }

  const journal = writeApplyJournal(args.journalDir, args.taskId, result);
  result.journal = { path: journal.path, state: journal.state };

  // Ordering per the OE-8 contract: apply gate first (one AGENT APPLIED per
  // task), then one tracker/session-log write per project batch, then one
  // Brain Bank capture per project batch. The controller never runs git.
  try {
    result.applied = [];
    for (const item of result.apply) {
      const applyResult = await mcpCall(config, "apply_agent_task_review", {
        task_id: item.task_id,
        applied_by: "closeout-controller",
        resolution: "accepted",
        resolve_linked_action_item: false,
        // When the receipt carried an OPERATOR-ACTION marker, route to Needs Operator
        // (operator step preserved) instead of closing to Agent Done.
        operator_action: item.operator?.operator_action ?? undefined,
        operator_target: item.operator?.operator_target ?? undefined,
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
      updateApplyJournal(journal.path, {
        state: "board-applied",
        applied: result.applied,
      });
    }
    result.board_mutations = true;
    await completeCloseoutFromJournal(config, journal.path, result);
    updateApplyJournal(journal.path, {
      state: "complete",
      completed_at: new Date().toISOString(),
    });
  } finally {
    printResult(result);
  }
}

async function completeCloseoutFromJournal(config, journalPath, result = null) {
  const journal = parseJson(journalPath);
  const target = result || journal.result;
  target.closeout_writes = target.closeout_writes || [];
  target.captures = target.captures || [];
  target.doc_flips = target.doc_flips || [];
  // Resume idempotence consults the journal's own progress instead of
  // replaying blindly: file appends are marker-guarded, but captures are not,
  // so any batch whose capture is already journaled is skipped explicitly
  // rather than leaning on Brain Bank's SHA-256 dedup.
  const capturedSlugs = new Set(
    (journal.captures || []).map((capture) => capture.project_slug),
  );

  for (const batch of journal.result.projects) {
    const marker = closeoutMarker(batch, journal.result.draft_date);
    const trackerWrite = appendCloseoutBlock(
      batch.tracker_path,
      `## Agent closeout — ${journal.result.draft_date} (Open Engine OE-8C)`,
      marker,
      batch.tracker_draft,
    );
    const sessionWrite = appendCloseoutBlock(
      batch.session_log_path,
      `## Agent closeout — ${journal.result.draft_date} (Open Engine OE-8C)`,
      marker,
      batch.session_log_draft,
    );
    target.closeout_writes.push(trackerWrite, sessionWrite);
    updateApplyJournal(journalPath, {
      state: "files-written",
      closeout_writes: target.closeout_writes,
    });

    // Plan-doc sync (Session 335): flip each plan-doc-seeded task's carded line
    // to done in its plan-doc folder. Idempotent — a re-run (or --resume) finds
    // no carded tag left and flips nothing. The gate in evaluate() already
    // proved the line exists, so this cannot silently no-op on a first apply.
    for (const flip of batch.plan_doc_flips || []) {
      const flipReport = applyDocFlip(
        flip.dirs,
        flip.short_id,
        journal.result.draft_date,
      );
      target.doc_flips.push({ short_id: flip.short_id, ...flipReport });
    }
    if ((batch.plan_doc_flips || []).length > 0) {
      updateApplyJournal(journalPath, {
        state: "doc-flipped",
        doc_flips: target.doc_flips,
      });
    }

    if (capturedSlugs.has(batch.project_slug)) {
      target.captures.push({
        project_slug: batch.project_slug,
        capture_result: "skipped: capture already journaled for this batch",
      });
      continue;
    }
    const capture = await mcpCall(config, "capture_thought", {
      content: batch.open_brain_capture_draft,
      tags: [batch.capture_tag, "open_engine"],
    });
    target.captures.push({
      project_slug: batch.project_slug,
      capture_result: capture,
    });
    updateApplyJournal(journalPath, {
      state: "captures-written",
      captures: target.captures,
    });
  }
}

async function resumeCloseout(args) {
  const config = mcpConfigFromEnv();
  const journalPath = journalPathFor(args.journalDir, args.resumeTaskId);
  if (!existsSync(journalPath)) {
    throw new Error(
      `No closeout journal found for ${args.resumeTaskId}: ${journalPath}`,
    );
  }
  const journalState = parseJson(journalPath).state;
  if (journalState === "complete") {
    printResult({
      status: "ALREADY_COMPLETE",
      mode: "resume",
      dry_run: true,
      board_mutations: false,
      task_id: args.resumeTaskId,
      journal: { path: journalPath, state: journalState },
      message: "Journal state is complete; nothing to replay.",
    });
    return;
  }
  const packet = await mcpCall(config, "get_agent_task", {
    task_id: args.resumeTaskId,
  });
  const input = liveInputFromPacket(packet);
  const task = input.tasks[0];
  const hasApplied = task.events.some((event) =>
    event.event_type === "AGENT APPLIED"
  );
  if (!hasApplied) {
    throw new Error(
      `Refusing resume: task ${args.resumeTaskId} has no AGENT APPLIED event.`,
    );
  }
  const result = {
    status: "RESUME_READY",
    mode: "resume",
    dry_run: false,
    board_mutations: false,
    task_id: args.resumeTaskId,
    journal: { path: journalPath },
  };
  try {
    await completeCloseoutFromJournal(config, journalPath, result);
    result.status = "RESUMED";
    updateApplyJournal(journalPath, {
      state: "complete",
      resumed_at: new Date().toISOString(),
    });
  } finally {
    printResult(result);
  }
}

function journalPathFor(journalDir, taskId) {
  return join(journalDir, `${taskId}.json`);
}

function writeApplyJournal(journalDir, taskId, result) {
  mkdirSync(journalDir, { recursive: true });
  const path = journalPathFor(journalDir, taskId);
  const journal = {
    version: 1,
    state: "intent-written",
    task_id: taskId,
    created_at: new Date().toISOString(),
    result,
  };
  writeFileSync(path, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  return { path, state: journal.state };
}

function updateApplyJournal(path, patch) {
  const current = parseJson(path);
  const next = { ...current, ...patch, updated_at: new Date().toISOString() };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function isUuidish(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value || ""),
  );
}

async function captureRunSummary(args) {
  const summary = buildRunSummary(args);
  const result = {
    status: "CAPTURE_READY",
    mode: args.summaryPreview ? "summary-preview" : "capture-run-summary",
    dry_run: Boolean(args.summaryPreview),
    content: summary.content,
    tags: summary.tags,
  };

  if (args.summaryPreview) {
    printResult(result);
    return;
  }

  const config = mcpConfigFromEnv();
  result.capture_result = await mcpCall(config, "capture_thought", summary);
  result.status = "CAPTURED";
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
  if (args.captureRunSummary) {
    await captureRunSummary(args);
    return;
  }
  if (args.resumeTaskId) {
    await resumeCloseout(args);
    return;
  }
  if (args.operatorResolutionSweep) {
    await runOperatorResolutionSweep(args, loadRegistry(args.registry));
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
  const result = evaluate(input, registry, {
    taskId: args.taskId,
    writeDrafts: args.writeDrafts,
  });

  if (args.writeDrafts) {
    const report = writeDraftFiles(result, args.draftsDir);
    result.drafts_dir = args.draftsDir;
    result.draft_writes = report.writes;
    result.draft_conflicts = report.conflicts;
    printResult(result);
    if (report.conflicts.length > 0) {
      throw new Error(
        `Draft conflict: ${report.conflicts.map((c) => c.path).join(", ")}`,
      );
    }
  } else {
    printResult(result);
  }

  if (args.expect && result.status !== args.expect) {
    throw new Error(`Expected ${args.expect}, got ${result.status}.`);
  }
}

// Main guard: run the CLI only when invoked directly, so the module is
// importable from tests. process.argv[1] carries literal spaces (this repo
// path has them); pathToFileURL matches import.meta.url's %20 encoding.
if (
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err) => {
    console.error(`closeout-controller: ${err.message}`);
    process.exit(1);
  });
}
