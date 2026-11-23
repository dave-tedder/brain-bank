// @ts-self-types="./receipt-shape.d.ts"
// The Open Engine receipt contract, shared by the closeout controller (Node,
// scripts/open-engine/closeout-controller.mjs) and complete_agent_task (Deno,
// supabase/functions/open-brain-mcp). Loop-closing Task 5.4 (D3).
//
// Plain ESM with no imports, so both runtimes load the same bytes: Deno through
// the .d.ts named on line 1, Node by ESM syntax detection (there is no
// package.json on the way up). Everything here is pure: no filesystem, no
// network, no clock. The one filesystem question the contract asks (does a
// route's path exist) is answered by the caller and passed in.
//
// Moved out of closeout-controller.mjs verbatim except for one rename:
// OPERATOR_TARGET_UNSAFE_SCHEME is now OPERATOR_TARGET_NOT_URL_OR_PATH, because
// the targets it held were prose descriptions, not hostile schemes (Codex audit
// 2026-11-03, section 4). REASON_ALIASES keeps the old code readable for one
// release.

export const REQUIRED_RECEIPT_SECTIONS = Object.freeze([
  "Work summary",
  "Verification",
  "Touched files or records",
  "Limitations",
  "Tracker draft",
  "Session-log draft",
  "Brain Bank capture draft",
  "Follow-up recommendation",
]);

// Old reason code -> current code. Read by tests for one release after the
// rename; nothing emits the old code any more.
export const REASON_ALIASES = Object.freeze({
  OPERATOR_TARGET_UNSAFE_SCHEME: "OPERATOR_TARGET_NOT_URL_OR_PATH",
});

// Task 2.2: the packet scope that makes a reference-only close legal.
export const REFERENCE_SCOPE_PATTERN =
  /^(A|An) (report|research|verification|recommendation|specification|brief|reference|summary|audit|plan)\b/i;
// Task 2.2: a staged file with one of these extensions is never reference-only.
export const INSTALLABLE_DELIVERABLE_PATTERN =
  /\.(php|js|mjs|ts|sql|html|css|json)$/i;

// The four route capabilities the controller checks before an apply, in the
// order it reports them, with the reason each one's absence produces. The
// route snapshot table (closeout_routes) stores exactly these four booleans.
export const ROUTE_CAPABILITIES = Object.freeze([
  Object.freeze({ field: "has_workspace", path: "workspace_path", reason: "UNRESOLVED_WORKSPACE_PATH" }),
  Object.freeze({ field: "has_tracker", path: "tracker_path", reason: "UNRESOLVED_TRACKER_PATH" }),
  Object.freeze({ field: "has_session_log", path: "session_log_path", reason: "UNRESOLVED_SESSION_LOG_PATH" }),
  Object.freeze({ field: "has_capture_tag", path: null, reason: "MISSING_CAPTURE_TAG" }),
]);

// A named file under deliverables/ is the receipt's own evidence that the run
// staged a file it did not install. A bare "deliverables/" mention in prose is
// not: only a path with a file extension counts, so a receipt that says nothing
// was written outside deliverables/ stays clean.
const DELIVERABLE_PATH = /(?:^|[\s`"'(<[])deliverables\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,8}\b/;

export function receiptNamesDeliverable(text) {
  return DELIVERABLE_PATH.test(String(text || ""));
}

export function referenceDeliverables(text) {
  return [...String(text || "").matchAll(/deliverables\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,8}\b/g)].map((m) => m[0]);
}

export function canonicalHeading(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isSafeOperatorTarget(value) {
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

export function parseOperatorAction(followUpText) {
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
  if (/^none \(reference only\)$/i.test(body)) {
    return { operator: { operator_action: "none", reference_only: true }, reasons: [] };
  }
  // A near miss of the reference-only form ("none (reference only).",
  // "none(reference only)", "none (reference-only)", or the exact form with a
  // "|| OPERATOR-TARGET:" suffix) must not fall through to the ordinary parser:
  // it would route to Needs Operator with the literal step "none (reference
  // only)." and skip both reference-only guards. Hold it as a format error.
  if (/^none\b/i.test(body) && /reference/i.test(body)) {
    return { operator: null, reasons: ["REFERENCE_ONLY_MARKER_FORMAT"] };
  }
  const parts = body.split(/\s*\|\|\s*/);
  if (parts.length > 2) {
    return { operator: null, reasons: ["OPERATOR_MARKER_FORMAT"] };
  }
  const [actionPart, targetPart] = parts;
  const operator_action = actionPart.trim();
  if (!operator_action) {
    // A bare "OPERATOR-ACTION:" with nothing after it is treated as no marker
    // (unchanged). But an anchored line whose action is empty while something
    // else follows the label ("OPERATOR-ACTION: || OPERATOR-TARGET: <url>")
    // is a marker the author meant to write, so it must HOLD rather than apply
    // with the target silently dropped. Before the line-anchored check was
    // narrowed, this case was held (under the wrong reason); keep it held.
    if (body) return { operator: null, reasons: ["OPERATOR_ACTION_EMPTY"] };
    return { operator: null, reasons: [] };
  }
  let operator_target = null;
  if (targetPart) {
    if (!/^OPERATOR-TARGET:/i.test(targetPart.trim())) {
      return { operator: null, reasons: ["OPERATOR_TARGET_LABEL_MISSING"] };
    }
    operator_target = targetPart.replace(/^OPERATOR-TARGET:/i, "").trim() ||
      null;
    if (operator_target && !isSafeOperatorTarget(operator_target)) {
      return { operator: null, reasons: ["OPERATOR_TARGET_NOT_URL_OR_PATH"] };
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

export function countOperatorMarkers(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => /^OPERATOR-ACTION:/i.test(line.trim()))
    .length;
}

// Review-note augmentation: a human review note stored on the task row
// (agent_tasks.review_reason) may supply sections the AGENT DONE receipt is
// missing. Only missing sections are taken from it. At complete time there is
// no separate note (move_agent_task_status writes the receipt itself into
// review_reason), so complete_agent_task passes reviewReason null.
export function augmentFromReviewNote(receipt, reviewReason) {
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

// The static receipt contract: every reason that depends only on the receipt
// text and on two immutable packet fields (desired_outcome, title). The
// controller runs this inside evaluateTask at apply time, with the task's
// review note; complete_agent_task runs it at complete time with none. Reasons
// come back in the order the controller has always reported them, duplicates
// included (the caller dedups).
export function evaluateReceiptContract({
  receiptText = "",
  reviewReason = null,
  desiredOutcome = null,
  title = null,
} = {}) {
  const reasons = [];
  const receipt = parseReceipt(receiptText);
  reasons.push(...receipt.reasons);

  const augmentation = augmentFromReviewNote(receipt, reviewReason);
  reasons.push(...augmentation.reasons);
  if (augmentation.missing.length > 0) reasons.push("RECEIPT_MISSING_SECTION");
  const followUpHeading = canonicalHeading("Follow-up recommendation");
  const followUp = augmentation.sections[followUpHeading];
  const operator = parseOperatorAction(followUp);
  reasons.push(...operator.reasons);
  // A marker outside Follow-up recommendation holds the task instead of
  // silently closing it to Agent Done — the operator step must never be lost
  // to a placement mistake (Fix Session A decision, 2026-07-10).
  const markerSources = [String(receiptText || "")];
  if (augmentation.augmented.length > 0) {
    markerSources.push(String(reviewReason || ""));
  }
  const totalMarkers = markerSources.reduce(
    (count, text) => count + countOperatorMarkers(text),
    0,
  );
  if (totalMarkers > countOperatorMarkers(followUp)) {
    reasons.push("OPERATOR_MARKER_OUTSIDE_FOLLOW_UP");
  }

  // Operator-install gate (Session 344): the write-safe policy means an executor
  // never installs its own output — it stages a file under deliverables/ that a
  // human must move. Evidence of a staged deliverable therefore makes the
  // operator marker mandatory. Fails closed: a HOLD is recoverable, a strand is
  // invisible.
  const stagedDeliverable = markerSources.some(receiptNamesDeliverable);
  if (stagedDeliverable && !operator.operator) {
    reasons.push("DELIVERABLE_WITHOUT_OPERATOR_ACTION");
  }
  if (operator.operator?.reference_only) {
    const scope = String(desiredOutcome || title || "").trim();
    if (!REFERENCE_SCOPE_PATTERN.test(scope)) {
      reasons.push("REFERENCE_ONLY_SCOPE_MISMATCH");
    }
    if (markerSources.some((text) => referenceDeliverables(text).some(
      (path) => INSTALLABLE_DELIVERABLE_PATTERN.test(path),
    ))) {
      reasons.push("REFERENCE_ONLY_ON_INSTALLABLE");
    }
  }

  // A marker appended mid-line to a prose sentence is invisible to the
  // line-anchored parser, so the task would apply with its operator step
  // silently dropped (735ea27d and 7008187d, 2026-07-14). The scan also runs
  // when the anchored marker is the reference-only form (Session 422 review).
  if (
    (!operator.operator || operator.operator.reference_only) &&
    String(followUp || "").split(/\r?\n/).some(
      (line) => /OPERATOR-ACTION:\s*\S/i.test(line) &&
        !/^\s*OPERATOR-ACTION:/i.test(line),
    )
  ) {
    reasons.push("OPERATOR_MARKER_NOT_LINE_ANCHORED");
  }

  return { reasons, receipt, augmentation, operator, stagedDeliverable };
}

// Route capabilities from a registry entry. pathExists is the caller's
// filesystem check (the controller passes existsSync); the publisher stores
// the result in closeout_routes so the Edge Function can read it without ever
// seeing a path.
export function routeCapabilities(route, pathExists) {
  const caps = {};
  for (const { field, path } of ROUTE_CAPABILITIES) {
    caps[field] = path === null
      ? Boolean(route?.capture_tag)
      : Boolean(route?.[path]) && Boolean(pathExists(route[path]));
  }
  return caps;
}

export function routeCapabilityReasons(caps) {
  return ROUTE_CAPABILITIES
    .filter(({ field }) => caps?.[field] !== true)
    .map(({ reason }) => reason);
}

export function holdMessage(reasons, receipt) {
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
  if (reasons.includes("OPERATOR_ACTION_EMPTY")) {
    return "Receipt's OPERATOR-ACTION marker has no action text before the '||' separator, so the operator step cannot be read; held so it is not silently dropped. Write the step after 'OPERATOR-ACTION:' and re-run.";
  }
  if (reasons.includes("OPERATOR_TARGET_NOT_URL_OR_PATH")) {
    return "OPERATOR-TARGET must be a plain http(s) URL or filesystem path, not a description. Put descriptive text in OPERATOR-ACTION and re-run; the task remains held.";
  }
  if (reasons.includes("REFERENCE_ONLY_MARKER_FORMAT")) {
    return "Receipt's OPERATOR-ACTION marker is a near miss of the reference-only form; held so it is not applied as a literal operator step. The only accepted spelling is exactly 'OPERATOR-ACTION: none (reference only)' on its own line with nothing after it (no period, no || OPERATOR-TARGET). Fix the marker, or replace it with a real install step, and re-run.";
  }
  if (reasons.includes("REFERENCE_ONLY_SCOPE_MISMATCH")) {
    return "Receipt says 'none (reference only)' but the packet's accepted scope (desired_outcome, or title when that is empty) does not begin 'A' or 'An' followed by report, research, verification, recommendation, specification, brief, reference, summary, audit or plan; held. Either the output is really a report and the packet scope needs correcting through admin_amend_agent_task, or it is not and the receipt needs a real 'OPERATOR-ACTION: install <path> || OPERATOR-TARGET: <where>' step. Do NOT apply this by hand with apply_agent_task_review.";
  }
  if (reasons.includes("REFERENCE_ONLY_ON_INSTALLABLE")) {
    return "Receipt says 'none (reference only)' but names a staged php/js/mjs/ts/sql/html/css/json file under deliverables/; a file with an installable extension is never reference-only. Held. Replace the marker with 'OPERATOR-ACTION: install <path> || OPERATOR-TARGET: <where>' and re-run. Do NOT apply this by hand with apply_agent_task_review.";
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
    return "A human correction (ops-amend) was posted after the AGENT DONE this apply would use; its Tracker/Session-log drafts may be stale. A superseding AGENT DONE will NOT work from here: complete_agent_task refuses Agent Review -> Agent Review. Repair route, three calls: admin_amend_agent_task with release_claim true (returns the row to Agent Todo and clears agent_code), then claim_specific_agent_task, then complete_agent_task with the corrected receipt folding the ops-amend in. Then re-run. The row sits unclaimed in Agent Todo between the fold and the re-claim, so run the three back to back if the task is not requires_local and a lane could be awake.";
  }
  if (reasons.includes("PLAN_DOC_PATH_UNRESOLVED")) {
    return "Task carries a plan-doc source whose path cannot be resolved to a project folder; held so the doc line is not left un-synced. Fix the plan-doc source path and re-run.";
  }
  if (reasons.includes("PLAN_DOC_LINE_NOT_FOUND")) {
    return "Task carries a plan-doc source but no [OE:<shortid>] carded line was found in that plan-doc folder; held so applying cannot silently skip the doc sync. Restore the tagged doc line (or flip it by hand) and re-run.";
  }
  if (reasons.includes("EXECUTED_CHECK_FAILED")) {
    return "The packet's executed check ran in isolation and exited non-zero; held, not applied. Fix the code (or the check) and post a fresh AGENT DONE with a new CHECK-REF.";
  }
  if (reasons.includes("EXECUTED_CHECK_DISABLED")) {
    return "Task carries a check_spec but the executed-check lane is disabled (EXECUTED_CHECK_ENABLED=false); held for the human-read gate.";
  }
  if (reasons.includes("CHECK_SPEC_UNPARSEABLE")) {
    return "Task carries a check_spec that is not a valid allowlisted {runner, args[]} value; held and never executed. Fix the packet's check_spec.";
  }
  if (reasons.includes("AUTO_PROMOTED_CHECK_TASK_EXCLUDED")) {
    return "Task was auto-promoted (triage-auto) and also carries a check_spec; machine-promote and machine-apply never stack (spec §8), so it is held for a human.";
  }
  if (reasons.includes("CHECK_SPEC_ON_CONTENT_TASK")) {
    return "Task carries a check_spec but its receipt stages a deliverables/ file — content work has no executable check; held for the human-read gate.";
  }
  if (reasons.some((reason) => reason.startsWith("CHECK_REF"))) {
    return "Task carries a check_spec but the receipt does not carry exactly one line-anchored 'CHECK-REF: <40-hex commit sha>'; held. Add the marker line naming the produced commit and re-run.";
  }
  if (reasons.includes("RISK_NOT_LOW")) {
    // Named explicitly because the generic fallback below is what let this
    // become a silent data-loss bug: a human read "RISK_NOT_LOW", applied the
    // card by hand with apply_agent_task_review, and got a clean-looking close
    // with NO tracker entry, NO session-log entry, and NO capture -- because
    // those three writes live in the controller, not in the Edge Function.
    // Seven cards were closed that way before anyone noticed. Do not shorten
    // this message to the reason code.
    return "Task risk is not low, so the unattended lane holds it. Do NOT apply this by hand with apply_agent_task_review: that Edge Function has no filesystem, so it closes the card while writing NO tracker entry, NO session-log entry, and NO Brain Bank capture, and nothing reports the omission. Re-run this same command with --operator-apply to apply it through the controller and get all three writes.";
  }
  return `Task held by dry-run safety gates: ${reasons.join(", ")}.`;
}
