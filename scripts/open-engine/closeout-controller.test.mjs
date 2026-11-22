import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendResolutionBlock,
  applyCaptureArgs,
  applyOperatorFields,
  applyReviewArgs,
  applyDocFlip,
  asCloseoutCapture,
  buildRunSummary,
  captureRunSummary,
  CLOSEOUT_CAPTURE_PREFIX,
  evaluate,
  evaluateResolutionSweep,
  evaluateSupersede,
  evaluateSupersedeHistoryAudit,
  reconcileSupersedeInventory,
  indexSupersedeGenerations,
  evaluateUnrecordedAudit,
  extractOperatorAction,
  scanCoversWindow,
  flipDocLineText,
  parseArgs,
  parseCheckRef,
  parseCheckSpec,
  parseReceipt,
  planDocRefs,
  receiptNamesDeliverable,
  resolutionCaptureArgs,
  resolvePlanDocPath,
  runExecutedCheck,
  runLive,
  runOperatorResolutionSweep,
  runSupersede,
  runSupersedeRepair,
  runUnrecordedAudit,
  supersedeAlreadyDone,
  supersedeMarker,
  scanPlanDocDir,
  wasAutoPromoted,
} from "./closeout-controller.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLAN_DOC_FIXTURE_DIR = join(HERE, "fixtures", "plan-doc-flip");

function withTempCopy(fn) {
  const dir = mkdtempSync(join(tmpdir(), "oe-plandoc-"));
  try {
    cpSync(PLAN_DOC_FIXTURE_DIR, dir, { recursive: true });
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function validReceipt() {
  return [
    "Work summary: did the thing",
    "Verification: ran it",
    "Touched files or records: none",
    "Limitations: none",
    "Tracker draft: - [x] did the thing",
    "Session-log draft: did the thing",
    "Brain Bank capture draft: did the thing",
    "Follow-up recommendation: none",
  ].join("\n");
}

function planDocTask(shortId, planDocSource) {
  const id = `${shortId}-e270-44dc-b414-d75e00080ae4`;
  return {
    generated_at: "2026-07-15T12:00:00.000Z",
    tasks: [{
      id,
      title: "plan-doc-seeded task",
      status: "Agent Review",
      risk: "low",
      project_slug: "tmp-proj",
      explicit_approval: false,
      linked_action_item_id: null,
      review_reason: null,
      sources: [planDocSource],
      events: [{
        task_id: id,
        event_type: "AGENT DONE",
        agent_code: "claude-code",
        payload: {
          reason: validReceipt(),
          status: "Agent Review",
          from_status: "Agent Working",
        },
        created_at: "2026-07-15T11:00:00.000Z",
      }],
    }],
    actionItems: [],
  };
}

function tmpRegistry(dir) {
  return {
    "tmp-proj": {
      workspace_path: dir,
      tracker_path: join(dir, "PROJECT-TRACKER.md"),
      session_log_path: join(dir, "SESSION-LOG.md"),
      capture_tag: "tmp_proj",
    },
  };
}

test("extractOperatorAction parses action + target from the marker line", () => {
  const followUp = "The operator finishes the last step.\n" +
    "OPERATOR-ACTION: Claim the listing and paste the optimization pack || OPERATOR-TARGET: https://example.com/listing";
  assert.deepEqual(extractOperatorAction(followUp), {
    operator_action: "Claim the listing and paste the optimization pack",
    operator_target: "https://example.com/listing",
  });
});

test("extractOperatorAction parses action-only (no target, no ||)", () => {
  const followUp = "OPERATOR-ACTION: Confirm contact's surname";
  assert.deepEqual(extractOperatorAction(followUp), {
    operator_action: "Confirm contact's surname",
    operator_target: null,
  });
});

test("extractOperatorAction rejects target segment without OPERATOR-TARGET label", () => {
  const followUp = "OPERATOR-ACTION: Claim the listing || https://example.com/listing";
  assert.equal(extractOperatorAction(followUp), null);
});

test("extractOperatorAction rejects unsafe target schemes", () => {
  const followUp =
    "OPERATOR-ACTION: Open the target || OPERATOR-TARGET: javascript:alert(1)";
  assert.equal(extractOperatorAction(followUp), null);
});

test("extractOperatorAction rejects protocol-relative //host targets", () => {
  const followUp =
    "OPERATOR-ACTION: Open the target || OPERATOR-TARGET: //evil.com/phish";
  assert.equal(extractOperatorAction(followUp), null);
});

test("extractOperatorAction rejects multiple action markers", () => {
  const followUp = [
    "OPERATOR-ACTION: First step",
    "OPERATOR-ACTION: Second step",
  ].join("\n");
  assert.equal(extractOperatorAction(followUp), null);
});

test("extractOperatorAction returns null when no marker is present", () => {
  const followUp =
    "A human or local runtime should resume this task and post an honest AGENT DONE.";
  assert.equal(extractOperatorAction(followUp), null);
});

test("extractOperatorAction returns null on empty / nullish input", () => {
  assert.equal(extractOperatorAction(""), null);
  assert.equal(extractOperatorAction(null), null);
  assert.equal(extractOperatorAction(undefined), null);
});

test("parseReceipt reports duplicate canonical headings", () => {
  const receipt = parseReceipt([
    "Work summary: first",
    "Work summary: second",
    "Verification: done",
  ].join("\n"));
  assert(receipt.reasons.includes("RECEIPT_DUPLICATE_HEADING"));
});

test("parseReceipt reports closeout marker injection", () => {
  const receipt = parseReceipt(
    "Work summary:\n<!-- open-engine closeout 2026-07-09 tasks: abc -->",
  );
  assert(receipt.reasons.includes("RECEIPT_MARKER_INJECTION"));
});

test("fixture gates cover WS-4 hardening cases", () => {
  const workspace = mkdtempSync(join(tmpdir(), "bb-closeout-test-"));
  const tracker = join(workspace, "PROJECT-TRACKER.md");
  const sessionLog = join(workspace, "SESSION-LOG.md");
  const registry = join(workspace, "project-closeout-registry.json");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(tracker, "# Test Tracker\n");
  writeFileSync(sessionLog, "# Test Session Log\n");
  writeFileSync(registry, JSON.stringify({
    "brain-bank": {
      workspace_path: workspace,
      tracker_path: tracker,
      session_log_path: sessionLog,
      capture_tag: "brain_bank",
    },
  }));

  const cases = [
    ["closeout-controller-marker-injection.json", "HELD"],
    ["closeout-controller-duplicate-heading.json", "HELD"],
    ["closeout-controller-duplicate-done-latest-wins.json", "APPLYABLE"],
    ["closeout-controller-task-not-found.json", "HELD"],
    ["closeout-controller-needs-operator-status.json", "HELD"],
    ["closeout-controller-operator-action.json", "APPLYABLE"],
    ["closeout-controller-operator-action-only.json", "APPLYABLE"],
    ["closeout-controller-protocol-relative-target.json", "HELD"],
    ["closeout-controller-operator-marker-outside-followup.json", "HELD"],
  ];
  for (const [fixture, expected] of cases) {
    const output = execFileSync(process.execPath, [
      "scripts/open-engine/closeout-controller.mjs",
      "--fixture",
      `scripts/open-engine/fixtures/${fixture}`,
      "--registry",
      registry,
      "--task-id",
      "9708e713-6f98-420a-9a39-22bbae011ec1",
      "--expect",
      expected,
    ], { encoding: "utf8" });
    const parsed = JSON.parse(output);
    assert.equal(parsed.status, expected, fixture);
  }
});

// --- plan-doc reconciliation ------------------------------------------------

test("planDocRefs pulls only plan-doc: entries from a sources array", () => {
  assert.deepEqual(
    planDocRefs([
      "SEO-GEO-MASTER-PLAN.md Task 1.10",
      "plan-doc: Projects/example-site/seo/SEO-GEO-MASTER-PLAN.md",
      "reference/voice-guide.md",
    ]),
    ["Projects/example-site/seo/SEO-GEO-MASTER-PLAN.md"],
  );
  assert.deepEqual(planDocRefs([]), []);
  assert.deepEqual(planDocRefs(undefined), []);
});

test("resolvePlanDocPath anchors a Projects-relative path to the Projects root", () => {
  const route = {
    workspace_path: "/home/user/Projects/example-site",
  };
  assert.equal(
    resolvePlanDocPath(
      "Projects/example-site/seo/SEO-GEO-MASTER-PLAN.md",
      route,
    ),
    "/home/user/Projects/example-site/seo/SEO-GEO-MASTER-PLAN.md",
  );
});

test("resolvePlanDocPath passes an absolute plan-doc path through unchanged", () => {
  assert.equal(
    resolvePlanDocPath("/abs/plan.md", { workspace_path: "/anything" }),
    "/abs/plan.md",
  );
});

test("resolvePlanDocPath returns null when the workspace is not under /Projects/", () => {
  assert.equal(resolvePlanDocPath("Projects/x/plan.md", { workspace_path: "/tmp/x" }), null);
});

test("flipDocLineText flips a checkbox line's [ ]->[x] and carded->done", () => {
  const { changed, line } = flipDocLineText(
    "- [ ] 6.8 Research outreach targets by tier [OE:dfca5ca0 carded 2026-07-12]",
    "dfca5ca0",
    "2026-07-15",
  );
  assert.equal(changed, true);
  assert.equal(
    line,
    "- [x] 6.8 Research outreach targets by tier [OE:dfca5ca0 done 2026-07-15]",
  );
});

test("flipDocLineText flips a heading line's tag only (no checkbox present)", () => {
  const { changed, line } = flipDocLineText(
    "**1.10 AI-crawler reachability gate** [OE:e0487fc7 carded 2026-07-12]",
    "e0487fc7",
    "2026-07-15",
  );
  assert.equal(changed, true);
  assert.equal(
    line,
    "**1.10 AI-crawler reachability gate** [OE:e0487fc7 done 2026-07-15]",
  );
});

test("flipDocLineText preserves trailing text after the tag date", () => {
  const { line } = flipDocLineText(
    "- [ ] PREP NOW ... [OE:f78c4a07 carded 2026-07-12, regional landing-page drafts]; more",
    "f78c4a07",
    "2026-07-15",
  );
  assert.equal(
    line,
    "- [x] PREP NOW ... [OE:f78c4a07 done 2026-07-15, regional landing-page drafts]; more",
  );
});

test("flipDocLineText leaves an already-done line unchanged (idempotent)", () => {
  const original =
    "- [x] 6.8 Research outreach targets by tier [OE:dfca5ca0 done 2026-07-15]";
  const { changed, line } = flipDocLineText(original, "dfca5ca0", "2026-07-16");
  assert.equal(changed, false);
  assert.equal(line, original);
});

test("flipDocLineText ignores a line whose short-id does not match", () => {
  const original = "- [ ] 6.8 ... [OE:dfca5ca0 carded 2026-07-12]";
  const { changed } = flipDocLineText(original, "e0487fc7", "2026-07-15");
  assert.equal(changed, false);
});

test("scanPlanDocDir finds a tagged short-id across plan doc + tracker, skipping session logs", () => {
  const scan = scanPlanDocDir(PLAN_DOC_FIXTURE_DIR, "af4bd457");
  assert.equal(scan.found, true);
  const files = scan.occurrences.map((o) => o.file).sort();
  // af4bd457 is tagged in BOTH the master plan and the tracker...
  assert.deepEqual(files, ["PROJECT-TRACKER.md", "SEO-GEO-MASTER-PLAN.md"]);
  // ...and in SESSION-LOG.md too, but that file is excluded from the scan.
  assert.ok(!files.includes("SESSION-LOG.md"));
});

test("scanPlanDocDir reports not-found for an untagged short-id", () => {
  const scan = scanPlanDocDir(PLAN_DOC_FIXTURE_DIR, "deadbeef");
  assert.equal(scan.found, false);
  assert.equal(scan.occurrences.length, 0);
});

test("applyDocFlip flips every occurrence in plan doc + tracker and never the session log", () => {
  withTempCopy((dir) => {
    const report = applyDocFlip([dir], "dfca5ca0", "2026-07-15");
    assert.equal(report.flipped, 6); // 3 in the master plan + 3 in the tracker

    const plan = readFileSync(join(dir, "SEO-GEO-MASTER-PLAN.md"), "utf8");
    const tracker = readFileSync(join(dir, "PROJECT-TRACKER.md"), "utf8");
    assert.ok(!plan.includes("OE:dfca5ca0 carded"));
    assert.ok(!tracker.includes("OE:dfca5ca0 carded"));
    assert.match(tracker, /- \[x\] 6\.8 Research outreach targets by tier \[OE:dfca5ca0 done 2026-07-15\]/);
    assert.match(plan, /\*\*6\.8 Research outreach targets by tier\*\* \[OE:dfca5ca0 done 2026-07-15\]/);

    // untouched short-ids stay carded
    assert.ok(tracker.includes("OE:e0487fc7 carded 2026-07-12"));

    // session log history is never rewritten
    const log = readFileSync(join(dir, "SESSION-LOG.md"), "utf8");
    assert.ok(log.includes("OE:af4bd457 carded 2026-07-12"));
  });
});

test("applyDocFlip is idempotent — re-running flips nothing more", () => {
  withTempCopy((dir) => {
    applyDocFlip([dir], "dfca5ca0", "2026-07-15");
    const report2 = applyDocFlip([dir], "dfca5ca0", "2026-07-16");
    assert.equal(report2.flipped, 0);
    const tracker = readFileSync(join(dir, "PROJECT-TRACKER.md"), "utf8");
    // first flip's date stands; the second run does not touch it
    assert.ok(tracker.includes("OE:dfca5ca0 done 2026-07-15"));
    assert.ok(!tracker.includes("done 2026-07-16"));
  });
});

test("evaluate gates a plan-doc task APPLYABLE when its tagged line is present", () => {
  withTempCopy((dir) => {
    const input = planDocTask("e0487fc7", `plan-doc: ${join(dir, "SEO-GEO-MASTER-PLAN.md")}`);
    const result = evaluate(input, tmpRegistry(dir), {
      taskId: input.tasks[0].id,
    });
    assert.equal(result.status, "APPLYABLE", JSON.stringify(result.hold));
    const proposed = result.apply[0];
    assert.equal(proposed.plan_doc_flip.short_id, "e0487fc7");
    assert.deepEqual(proposed.plan_doc_flip.dirs, [dir]);
    // The flip target must reach the project batch — that is what the apply
    // path (completeCloseoutFromJournal) reads to actually flip the doc lines.
    assert.deepEqual(result.projects[0].plan_doc_flips, [{
      short_id: "e0487fc7",
      dirs: [dir],
    }]);
  });
});

test("evaluate HOLDs a plan-doc task whose tagged line is missing", () => {
  withTempCopy((dir) => {
    // short-id deadbeef is not tagged anywhere in the fixture docs
    const input = planDocTask("deadbeef", `plan-doc: ${join(dir, "SEO-GEO-MASTER-PLAN.md")}`);
    const result = evaluate(input, tmpRegistry(dir), {
      taskId: input.tasks[0].id,
    });
    assert.equal(result.status, "HELD");
    assert.ok(result.hold[0].reasons.includes("PLAN_DOC_LINE_NOT_FOUND"));
  });
});

// --- operator-install enforcement (Session 344) -----------------------------
//
// Write-safe executors never edit project files in place: they stage a revised
// file under deliverables/ that a human must install. Before this gate, such a
// task could close to Agent Done with no operator step recorded anywhere, so
// the staged file sat uninstalled and invisible to sentinel/digest/briefing
// (the Session 343 strand). A receipt that names a staged deliverable and
// carries no operator marker now HOLDs.

function deliverableTask(receiptLines, reviewReason = null) {
  const id = "5f0d1a77-e270-44dc-b414-d75e00080ae4";
  return {
    generated_at: "2026-07-15T12:00:00.000Z",
    tasks: [{
      id,
      title: "write-safe deliverable task",
      status: "Agent Review",
      risk: "low",
      project_slug: "tmp-proj",
      explicit_approval: false,
      linked_action_item_id: null,
      review_reason: reviewReason,
      sources: [],
      events: [{
        task_id: id,
        event_type: "AGENT DONE",
        agent_code: "claude-code",
        payload: {
          reason: receiptLines.join("\n"),
          status: "Agent Review",
          from_status: "Agent Working",
        },
        created_at: "2026-07-15T11:00:00.000Z",
      }],
    }],
    actionItems: [],
  };
}

function receiptWith(touched, followUp) {
  return [
    "Work summary: staged the revised file",
    "Verification: read it back",
    `Touched files or records: ${touched}`,
    "Limitations: none",
    "Tracker draft: - [x] staged the revised file",
    "Session-log draft: staged the revised file",
    "Brain Bank capture draft: staged the revised file",
    `Follow-up recommendation: ${followUp}`,
  ];
}

test("receiptNamesDeliverable detects a staged deliverable path", () => {
  assert.equal(
    receiptNamesDeliverable(
      "Touched files or records:\ndeliverables/example-seo/aggregator-audit-2026-07-11.md",
    ),
    true,
  );
});

test("receiptNamesDeliverable ignores a bare deliverables/ mention with no file", () => {
  // Prose like "this lane is write-safe so nothing went outside deliverables/"
  // must not trip the gate — only a named file is evidence of a staged file.
  assert.equal(
    receiptNamesDeliverable("Limitations: nothing was written under deliverables/"),
    false,
  );
  assert.equal(receiptNamesDeliverable("Touched files or records: none"), false);
  assert.equal(receiptNamesDeliverable(""), false);
  assert.equal(receiptNamesDeliverable(null), false);
});

function referenceCase(path, followUp = "OPERATOR-ACTION: none (reference only)", outcome = "A verification report") {
  return withTempCopy((dir) => {
    const input = deliverableTask(receiptWith(path, followUp));
    input.tasks[0].desired_outcome = outcome;
    return evaluate(input, tmpRegistry(dir), { taskId: input.tasks[0].id });
  });
}

test("reference-only report applies with no operator action and a tracker reading note", () => {
  const result = referenceCase("deliverables/x/report.md");
  assert.equal(result.status, "APPLYABLE");
  assert.deepEqual(applyOperatorFields(result.apply[0].operator), {});
  assert.equal(result.apply[0].operator.reference_only, true);
  assert.match(result.projects[0].tracker_draft, /Reference deliverable, nothing to install: deliverables\/x\/report.md/);
});

test("reference-only marker refuses a non-reference scope", () => {
  const result = referenceCase("deliverables/x/report.md", undefined, "A revised title tag ready to paste");
  assert.ok(result.hold[0]?.reasons.includes("REFERENCE_ONLY_SCOPE_MISMATCH"));
});

test("reference-only marker refuses installable deliverables", () => {
  // "PHP" pins the /i flag: an uppercase extension must hold too.
  for (const ext of ["php", "PHP", "js", "mjs", "ts", "sql", "html", "css", "json"]) {
    const result = referenceCase(`deliverables/x/patch.${ext}`);
    assert.equal(result.status, "HELD", ext);
    assert.ok(result.hold[0]?.reasons.includes("REFERENCE_ONLY_ON_INSTALLABLE"), ext);
  }
});

test("reference-only marker still must be line anchored", () => {
  const result = referenceCase("deliverables/x/report.md", "Read this. OPERATOR-ACTION: none (reference only)");
  assert.ok(result.hold[0]?.reasons.includes("OPERATOR_MARKER_NOT_LINE_ANCHORED"));
});

test("reference-only close cannot swallow a mid-line install marker beside it", () => {
  // Session 422 review: with the reference form anchored, operator.operator is
  // truthy, so the mid-line scan used to be skipped and this receipt closed to
  // Agent Done with the install step gone. The install-only variant of the
  // same prose already held; the reference form must hold the same way.
  const result = referenceCase(
    "deliverables/x/report.md",
    "Read the report. Then OPERATOR-ACTION: install deliverables/x/report.md || OPERATOR-TARGET: https://example.com/admin\n" +
      "OPERATOR-ACTION: none (reference only)",
  );
  assert.equal(result.status, "HELD");
  assert.ok(result.hold[0]?.reasons.includes("OPERATOR_MARKER_NOT_LINE_ANCHORED"), JSON.stringify(result.hold));
});

test("near-miss reference-only spellings hold as a format error instead of routing a literal step", () => {
  for (const followUp of [
    "OPERATOR-ACTION: none (reference only).",
    "OPERATOR-ACTION: none(reference only)",
    "OPERATOR-ACTION: none (reference-only)",
    "OPERATOR-ACTION: None  (Reference Only)",
    "OPERATOR-ACTION: none (reference only) || OPERATOR-TARGET: deliverables/x/report.md",
  ]) {
    const result = referenceCase("deliverables/x/report.md", followUp);
    assert.equal(result.status, "HELD", followUp);
    // The format hold yields no operator, so the deliverable gate fires too;
    // that is the same pairing every other marker format error produces.
    assert.ok(result.hold[0]?.reasons.includes("REFERENCE_ONLY_MARKER_FORMAT"), followUp);
    assert.ok(!result.hold[0].reasons.includes("REFERENCE_ONLY_SCOPE_MISMATCH"), followUp);
    assert.ok(result.apply.length === 0, followUp);
  }
  // The exact form, with surrounding whitespace and any letter case, still applies.
  for (const followUp of ["  OPERATOR-ACTION: None (Reference Only)  ", "OPERATOR-ACTION: none (reference only)"]) {
    const result = referenceCase("deliverables/x/report.md", followUp);
    assert.equal(result.status, "APPLYABLE", followUp);
    assert.equal(result.apply[0].operator.reference_only, true, followUp);
  }
});

test("reference-only scope match is case-insensitive and falls back to the title", () => {
  assert.equal(referenceCase("deliverables/x/report.md", undefined, "a report on the release form").status, "APPLYABLE");
  withTempCopy((dir) => {
    const input = deliverableTask(receiptWith("deliverables/x/report.md", "OPERATOR-ACTION: none (reference only)"));
    input.tasks[0].desired_outcome = "";
    input.tasks[0].title = "A verification report on /releaseform";
    const result = evaluate(input, tmpRegistry(dir), { taskId: input.tasks[0].id });
    assert.equal(result.status, "APPLYABLE", JSON.stringify(result.hold));
  });
});

test("applyReviewArgs omits the operator fields for a reference-only close and sends them for an install step", () => {
  // This is the exact apply_agent_task_review payload runLive sends, so it is
  // the line that decides Agent Done vs Needs Operator in production.
  const reference = referenceCase("deliverables/x/report.md").apply[0];
  const refArgs = applyReviewArgs(reference);
  assert.equal(refArgs.task_id, reference.task_id);
  assert.equal(refArgs.applied_by, "closeout-controller");
  assert.equal(refArgs.resolve_linked_action_item, false);
  assert.ok(!("operator_action" in refArgs), JSON.stringify(refArgs));
  assert.ok(!("operator_target" in refArgs), JSON.stringify(refArgs));
  assert.equal(refArgs.closeout_evidence.reference_only, true);

  const install = withTempCopy((dir) => {
    const input = deliverableTask(receiptWith(
      "deliverables/x/patch.php",
      "OPERATOR-ACTION: install deliverables/x/patch.php || OPERATOR-TARGET: https://example.com/admin",
    ));
    return evaluate(input, tmpRegistry(dir), { taskId: input.tasks[0].id });
  });
  assert.equal(install.status, "APPLYABLE", JSON.stringify(install.hold));
  const installArgs = applyReviewArgs(install.apply[0]);
  assert.equal(installArgs.operator_action, "install deliverables/x/patch.php");
  assert.equal(installArgs.operator_target, "https://example.com/admin");
  assert.equal(installArgs.closeout_evidence.reference_only, undefined);
});

test("reference-only hold reasons carry a remedy, never the bare reason code", () => {
  const cases = [
    [referenceCase("deliverables/x/report.md", undefined, "A revised title tag ready to paste"), "REFERENCE_ONLY_SCOPE_MISMATCH", /admin_amend_agent_task|OPERATOR-ACTION: install/],
    [referenceCase("deliverables/x/patch.php"), "REFERENCE_ONLY_ON_INSTALLABLE", /OPERATOR-ACTION: install/],
    [referenceCase("deliverables/x/report.md", "OPERATOR-ACTION: none (reference only)."), "REFERENCE_ONLY_MARKER_FORMAT", /exactly 'OPERATOR-ACTION: none \(reference only\)'/],
  ];
  for (const [result, reason, remedy] of cases) {
    const hold = result.hold[0];
    assert.ok(hold?.reasons.includes(reason), reason);
    assert.ok(!hold.message.startsWith("Task held by dry-run safety gates"), `${reason}: ${hold.message}`);
    assert.match(hold.message, remedy, reason);
  }
});

test("reference-only tracker note lists each named path once and is omitted when none is named", () => {
  const multi = withTempCopy((dir) => {
    const lines = receiptWith("deliverables/x/report.md and deliverables/x/appendix.md", "OPERATOR-ACTION: none (reference only)");
    lines[3] = "Limitations: see deliverables/x/report.md";
    const input = deliverableTask(lines);
    input.tasks[0].desired_outcome = "A verification report";
    return evaluate(input, tmpRegistry(dir), { taskId: input.tasks[0].id });
  });
  assert.equal(multi.status, "APPLYABLE", JSON.stringify(multi.hold));
  const notes = multi.projects[0].tracker_draft.split("\n").filter((l) => l.startsWith("Reference deliverable, nothing to install:"));
  assert.equal(notes.length, 1);
  assert.equal(notes[0], "Reference deliverable, nothing to install: deliverables/x/report.md, deliverables/x/appendix.md");

  const none = referenceCase("none");
  assert.equal(none.status, "APPLYABLE", JSON.stringify(none.hold));
  assert.ok(!none.projects[0].tracker_draft.includes("nothing to install"), none.projects[0].tracker_draft);
});

test("evaluate HOLDs a deliverable receipt with no operator marker", () => {
  withTempCopy((dir) => {
    const input = deliverableTask(receiptWith(
      "deliverables/example-website/post-1-founding.md",
      "none",
    ));
    const result = evaluate(input, tmpRegistry(dir), {
      taskId: input.tasks[0].id,
    });
    assert.equal(result.status, "HELD");
    assert.ok(
      result.hold[0].reasons.includes("DELIVERABLE_WITHOUT_OPERATOR_ACTION"),
      JSON.stringify(result.hold[0].reasons),
    );
    assert.match(result.hold[0].message, /staged a deliverable/i);
  });
});

test("evaluate APPLYABLE for a deliverable receipt carrying an install marker", () => {
  withTempCopy((dir) => {
    const input = deliverableTask(receiptWith(
      "deliverables/example-website/post-1-founding.md",
      "OPERATOR-ACTION: install deliverables/example-website/post-1-founding.md || OPERATOR-TARGET: /tmp/drafts/post-1-founding.md",
    ));
    const result = evaluate(input, tmpRegistry(dir), {
      taskId: input.tasks[0].id,
    });
    assert.equal(result.status, "APPLYABLE", JSON.stringify(result.hold));
    assert.equal(
      result.apply[0].operator.operator_action,
      "install deliverables/example-website/post-1-founding.md",
    );
  });
});

test("evaluate leaves a no-deliverable receipt APPLYABLE without a marker", () => {
  withTempCopy((dir) => {
    const input = deliverableTask(receiptWith("none", "none"));
    const result = evaluate(input, tmpRegistry(dir), {
      taskId: input.tasks[0].id,
    });
    assert.equal(result.status, "APPLYABLE", JSON.stringify(result.hold));
  });
});

test("evaluate reads the install marker through review-note augmentation", () => {
  withTempCopy((dir) => {
    // Receipt is missing Follow-up recommendation; the review note supplies it,
    // marker included. The augmented section is what the gate must read.
    const partial = receiptWith(
      "deliverables/example-seo/title-meta-rewrites.md",
      "",
    ).slice(0, 7);
    const input = deliverableTask(
      partial,
      "Follow-up recommendation: OPERATOR-ACTION: install deliverables/example-seo/title-meta-rewrites.md || OPERATOR-TARGET: https://example.com/wp-admin",
    );
    const result = evaluate(input, tmpRegistry(dir), {
      taskId: input.tasks[0].id,
    });
    assert.equal(result.status, "APPLYABLE", JSON.stringify(result.hold));
  });
});

test("evaluate HOLDs a marker appended mid-line to prose", () => {
  withTempCopy((dir) => {
    // Shape of a receipt that strands a task: a real marker, but tacked onto the
    // end of a sentence, so the line-anchored parser never saw it and the task
    // applied with its operator step dropped.
    const input = deliverableTask(receiptWith(
      "deliverables/example-seo/aggregator-audit-2026-07-11.md",
      "Review the report, then decide which directory to pursue first. OPERATOR-ACTION: check whether the directory accepts a guest-spot listing || OPERATOR-TARGET: https://example.com",
    ));
    const result = evaluate(input, tmpRegistry(dir), {
      taskId: input.tasks[0].id,
    });
    assert.equal(result.status, "HELD");
    assert.ok(
      result.hold[0].reasons.includes("OPERATOR_MARKER_NOT_LINE_ANCHORED"),
      JSON.stringify(result.hold[0].reasons),
    );
  });
});

test("evaluate does not trip the line-anchor gate on a clean receipt", () => {
  withTempCopy((dir) => {
    const input = deliverableTask(receiptWith("none", "no operator step needed"));
    const result = evaluate(input, tmpRegistry(dir), {
      taskId: input.tasks[0].id,
    });
    assert.equal(result.status, "APPLYABLE", JSON.stringify(result.hold));
  });
});

test("evaluate HOLDs a plan-doc task whose path cannot be resolved", () => {
  withTempCopy((dir) => {
    const input = planDocTask("e0487fc7", "plan-doc: Projects/Nope/plan.md");
    // workspace_path has no /Projects/ segment, so the relative ref is unresolvable
    const registry = {
      "tmp-proj": {
        workspace_path: dir,
        tracker_path: join(dir, "PROJECT-TRACKER.md"),
        session_log_path: join(dir, "SESSION-LOG.md"),
        capture_tag: "tmp_proj",
      },
    };
    const result = evaluate(input, registry, { taskId: input.tasks[0].id });
    assert.equal(result.status, "HELD");
    assert.ok(result.hold[0].reasons.includes("PLAN_DOC_PATH_UNRESOLVED"));
  });
});

// ---------------------------------------------------------------------------
// OE-8E operator-resolution sweep. Pure evaluation only — live listing and
// fetching are exercised manually against a running Brain Bank MCP.
// ---------------------------------------------------------------------------

function operatorDonePacket(overrides = {}) {
  const taskId = overrides.task_id ||
    "1a2b3c4d-0000-4000-8000-000000000001";
  const note = overrides.note ??
    "DEFERRED by operator decision - the campaign was NOT sent. Data gap found at review time; fold the content into next month's send instead.";
  return {
    task: {
      id: taskId,
      project_slug: overrides.project_slug === undefined
        ? "example-project"
        : overrides.project_slug,
      status: "Agent Done",
      completed_at: overrides.completed_at || "2026-07-18T04:06:14.474145+00:00",
    },
    events: overrides.events || [
      {
        event_type: "AGENT DONE",
        agent_code: "runner-a",
        created_at: "2026-07-17T17:36:43.025486+00:00",
        payload: { status: "Agent Review", from_status: "Agent Working" },
      },
      {
        event_type: "AGENT NEEDS OPERATOR",
        agent_code: "runner-a",
        created_at: "2026-07-17T20:54:24.014253+00:00",
        payload: { status: "Needs Operator", from_status: "Agent Review" },
      },
      {
        event_type: "OPERATOR DONE",
        agent_code: null,
        created_at: "2026-07-18T04:06:14.474145+00:00",
        payload: {
          note,
          status: "Agent Done",
          from_status: "Needs Operator",
          completed_by: "Sam Operator",
        },
      },
    ],
  };
}

function sweepRegistry() {
  return {
    "example-project": {
      workspace_path: "/tmp/x",
      tracker_path: "/tmp/x/PROJECT-TRACKER.md",
      session_log_path: "/tmp/x/SESSION-LOG.md",
      capture_tag: "example_project",
    },
  };
}

const SWEEP_NOW = "2026-07-23T12:00:00.000Z";

test("resolution sweep: qualifying OPERATOR DONE task is appendable with event-date stamping", () => {
  const result = evaluateResolutionSweep(
    [operatorDonePacket()],
    sweepRegistry(),
    { now: SWEEP_NOW },
  );
  assert.equal(result.skipped.length, 0);
  assert.equal(result.appendable.length, 1);
  const item = result.appendable[0];
  assert.equal(item.task_id, "1a2b3c4d-0000-4000-8000-000000000001");
  assert.equal(item.tracker_path, "/tmp/x/PROJECT-TRACKER.md");
  assert.equal(item.capture_tag, "example_project");
  // Dated by the OPERATOR DONE event, not the sweep run date.
  assert.equal(item.event_date, "2026-07-18");
  assert.equal(
    item.heading,
    "## Operator resolution — 2026-07-18 (Open Engine OE-8E)",
  );
  assert.equal(
    item.marker,
    "<!-- open-engine operator-resolution task: 1a2b3c4d-0000-4000-8000-000000000001 -->",
  );
  assert.ok(item.body.startsWith("Resolved by Sam Operator on 2026-07-18 (task 1a2b3c4d, "));
  assert.ok(item.body.includes("DEFERRED by operator decision"));
});

test("resolution sweep: capture body names the card so identical notes do not dedup into one record", () => {
  // Byte-identical operator notes on several cards collapse to ONE stored
  // thought under SHA-256 content dedup, and that thought names none of them.
  const packet = operatorDonePacket();
  packet.task.title = "Local content research";
  const item = evaluateResolutionSweep([packet], sweepRegistry(), { now: SWEEP_NOW }).appendable[0];
  assert.ok(item.body.startsWith(
    "Resolved by Sam Operator on 2026-07-18 (task 1a2b3c4d, Local content research): DEFERRED",
  ), item.body);
  const other = operatorDonePacket({ task_id: "5e6f7a8b-0000-4000-8000-000000000002" });
  other.task.title = "Competitor listing research";
  const otherItem = evaluateResolutionSweep([other], sweepRegistry(), { now: SWEEP_NOW }).appendable[0];
  assert.notEqual(item.body, otherItem.body);
});

test("resolution sweep: task whose final status event is not OPERATOR DONE is skipped", () => {
  const packet = operatorDonePacket({
    events: [
      {
        event_type: "AGENT NEEDS OPERATOR",
        agent_code: "runner-a",
        created_at: "2026-07-17T20:54:24.014253+00:00",
        payload: { status: "Needs Operator", from_status: "Agent Review" },
      },
      {
        event_type: "OPERATOR DONE",
        agent_code: null,
        created_at: "2026-07-18T04:06:14.474145+00:00",
        payload: {
          note: "x".repeat(100),
          status: "Agent Done",
          from_status: "Needs Operator",
          completed_by: "Sam Operator",
        },
      },
      // A later ops correction moved status again — the OPERATOR DONE note is
      // no longer the final word, so the sweep must not treat it as such.
      {
        event_type: "AGENT STATUS",
        agent_code: "triage-auto",
        created_at: "2026-07-19T04:06:14.474145+00:00",
        payload: { status: "Agent Todo", from_status: "Agent Done" },
      },
    ],
  });
  const result = evaluateResolutionSweep([packet], sweepRegistry(), {
    now: SWEEP_NOW,
  });
  assert.equal(result.appendable.length, 0);
  assert.equal(result.skipped[0].reason, "NOT_OPERATOR_DONE");
});

test("resolution sweep: substance gate boundary — 79 chars skipped, 80 appendable", () => {
  const short = evaluateResolutionSweep(
    [operatorDonePacket({ note: "x".repeat(79) })],
    sweepRegistry(),
    { now: SWEEP_NOW },
  );
  assert.equal(short.appendable.length, 0);
  assert.equal(short.skipped[0].reason, "NOTE_TOO_SHORT");

  const enough = evaluateResolutionSweep(
    [operatorDonePacket({ note: "x".repeat(80) })],
    sweepRegistry(),
    { now: SWEEP_NOW },
  );
  assert.equal(enough.appendable.length, 1);
});

test("resolution sweep: whitespace does not count toward the substance gate", () => {
  const padded = evaluateResolutionSweep(
    [operatorDonePacket({ note: `   ${"x".repeat(79)}   ` })],
    sweepRegistry(),
    { now: SWEEP_NOW },
  );
  assert.equal(padded.appendable.length, 0);
  assert.equal(padded.skipped[0].reason, "NOTE_TOO_SHORT");
});

test("resolution sweep: missing completed_by is skipped (never a machine resolution)", () => {
  const packet = operatorDonePacket();
  packet.events[2].payload.completed_by = "";
  const result = evaluateResolutionSweep([packet], sweepRegistry(), {
    now: SWEEP_NOW,
  });
  assert.equal(result.appendable.length, 0);
  assert.equal(result.skipped[0].reason, "NO_COMPLETED_BY");
});

test("resolution sweep: null project_slug is reported, never routed", () => {
  const result = evaluateResolutionSweep(
    [operatorDonePacket({ project_slug: null })],
    sweepRegistry(),
    { now: SWEEP_NOW },
  );
  assert.equal(result.appendable.length, 0);
  assert.equal(result.skipped[0].reason, "MISSING_PROJECT_SLUG");
});

test("resolution sweep: unroutable project_slug is reported, never written", () => {
  const result = evaluateResolutionSweep(
    [operatorDonePacket({ project_slug: "no-such-project" })],
    sweepRegistry(),
    { now: SWEEP_NOW },
  );
  assert.equal(result.appendable.length, 0);
  assert.equal(result.skipped[0].reason, "UNKNOWN_PROJECT_ROUTE");
});

test("resolution sweep: resolution outside the lookback window is skipped", () => {
  const result = evaluateResolutionSweep(
    [operatorDonePacket()],
    sweepRegistry(),
    { now: "2026-08-30T12:00:00.000Z", lookbackDays: 7 },
  );
  assert.equal(result.appendable.length, 0);
  assert.equal(result.skipped[0].reason, "OUTSIDE_LOOKBACK");
});

test("resolution sweep: appendResolutionBlock is marker-idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "oe-opres-"));
  try {
    const tracker = join(dir, "PROJECT-TRACKER.md");
    writeFileSync(tracker, "# Tracker\n", "utf8");
    const item = evaluateResolutionSweep(
      [operatorDonePacket()],
      {
        "example-project": {
          workspace_path: dir,
          tracker_path: tracker,
          session_log_path: join(dir, "SESSION-LOG.md"),
          capture_tag: "example_project",
        },
      },
      { now: SWEEP_NOW },
    ).appendable[0];

    const first = appendResolutionBlock(item);
    assert.equal(first.action, "appended");
    const afterFirst = readFileSync(tracker, "utf8");
    assert.ok(afterFirst.includes(item.marker));
    assert.ok(afterFirst.includes("## Operator resolution — 2026-07-18"));

    const second = appendResolutionBlock(item);
    assert.equal(second.action, "unchanged");
    assert.equal(readFileSync(tracker, "utf8"), afterFirst);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// scan_truncated must be an HONEST signal, not a permanently-true flag. The
// naive version (rows.length >= limit) is true forever once the board has 50
// Agent Done tasks, which is always — a flag nobody can act on.
test("scanCoversWindow: a short page always covers the window", () => {
  const rows = [{ updated_at: "2026-07-22T00:00:00Z" }];
  assert.equal(scanCoversWindow(rows, Date.parse("2026-07-16T00:00:00Z"), 50), true);
});

test("scanCoversWindow: a FULL page whose oldest row predates the cutoff still covers the window", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({
    updated_at: i === 49 ? "2026-07-10T00:00:00Z" : "2026-07-22T00:00:00Z",
  }));
  assert.equal(scanCoversWindow(rows, Date.parse("2026-07-16T00:00:00Z"), 50), true);
});

test("scanCoversWindow: a FULL page that never reached the cutoff is real truncation", () => {
  const rows = Array.from({ length: 50 }, () => ({
    updated_at: "2026-07-22T00:00:00Z",
  }));
  assert.equal(scanCoversWindow(rows, Date.parse("2026-07-16T00:00:00Z"), 50), false);
});

test("scanCoversWindow: an unparseable oldest timestamp is treated as truncated", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({
    updated_at: i === 49 ? "not-a-date" : "2026-07-22T00:00:00Z",
  }));
  assert.equal(scanCoversWindow(rows, Date.parse("2026-07-16T00:00:00Z"), 50), false);
});

// ==========================================================================
// OE-13 Sub-phase B — executed-check lane (Tasks 1-4)
// ==========================================================================

const CHECK_SHA = "a".repeat(40);

function checkSpecReceipt(ref = CHECK_SHA) {
  return [
    "Work summary: implemented parseThing + its test",
    "Verification: node --test passed locally",
    `Touched files or records: src/parse-thing.mjs\nCHECK-REF: ${ref}`,
    "Limitations: none",
    "Tracker draft: - [x] parseThing shipped",
    "Session-log draft: parseThing shipped",
    "Brain Bank capture draft: parseThing shipped",
    "Follow-up recommendation: none",
  ].join("\n");
}

function checkSpecTask(overrides = {}) {
  const id = "cccccccc-e270-44dc-b414-d75e00080ae4";
  const {
    check_spec = { runner: "node-test", args: ["parse-thing.test.mjs"] },
    receipt = checkSpecReceipt(),
    events = [],
  } = overrides;
  return {
    generated_at: "2026-07-15T12:00:00.000Z",
    tasks: [{
      id,
      title: "check_spec code task",
      status: "Agent Review",
      risk: "low",
      project_slug: "tmp-proj",
      explicit_approval: false,
      linked_action_item_id: null,
      review_reason: null,
      sources: [],
      check_spec,
      events: [
        ...events,
        {
          task_id: id,
          event_type: "AGENT DONE",
          agent_code: "claude-code",
          payload: {
            reason: receipt,
            status: "Agent Review",
            from_status: "Agent Working",
          },
          created_at: "2026-07-15T11:00:00.000Z",
        },
      ],
    }],
    actionItems: [],
  };
}

// --------------------------------------------------------------------------
// Task 1 — parseCheckSpec / parseCheckRef / wasAutoPromoted (pure units)
// --------------------------------------------------------------------------

test("parseCheckSpec: absent means not present", () => {
  assert.deepEqual(parseCheckSpec(null), { present: false });
  assert.deepEqual(parseCheckSpec(undefined), { present: false });
});

test("parseCheckSpec: valid node-test spec builds argv", () => {
  const parsed = parseCheckSpec({
    runner: "node-test",
    args: ["parse-thing.test.mjs"],
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.argv, ["node", "--test", "parse-thing.test.mjs"]);
});

test("parseCheckSpec: deno-test argv carries --no-prompt", () => {
  const parsed = parseCheckSpec({ runner: "deno-test", args: [] });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.argv, ["deno", "test", "--no-prompt"]);
});

test("parseCheckSpec: npm-run requires exactly one plain script name", () => {
  assert.equal(parseCheckSpec({ runner: "npm-run", args: ["check"] }).ok, true);
  assert.equal(parseCheckSpec({ runner: "npm-run", args: [] }).ok, false);
  assert.equal(
    parseCheckSpec({ runner: "npm-run", args: ["a", "b"] }).ok,
    false,
  );
});

test("parseCheckSpec: rejects unknown runner, shell metacharacters, extra keys, non-object", () => {
  for (
    const bad of [
      { runner: "bash", args: ["-c", "true"] },
      { runner: "node-test", args: ["a; rm -rf /"] },
      { runner: "node-test", args: ["a b"] },
      { runner: "node-test", args: ["$(id)"] },
      { runner: "node-test", args: [""], },
      { runner: "node-test", args: ["x".repeat(129)] },
      { runner: "node-test", args: [], cwd: "/" },
      "deno test",
      ["deno", "test"],
      42,
    ]
  ) {
    const parsed = parseCheckSpec(bad);
    assert.equal(parsed.present, true, JSON.stringify(bad));
    assert.equal(parsed.ok, false, JSON.stringify(bad));
    assert.equal(parsed.reason, "CHECK_SPEC_UNPARSEABLE");
  }
});

test("parseCheckRef: exactly one line-anchored 40-hex marker", () => {
  assert.deepEqual(parseCheckRef(`CHECK-REF: ${CHECK_SHA}`), {
    ref: CHECK_SHA,
    reasons: [],
  });
  assert.deepEqual(parseCheckRef("no marker here").reasons, [
    "CHECK_REF_MISSING",
  ]);
  assert.deepEqual(
    parseCheckRef(`CHECK-REF: ${CHECK_SHA}\nCHECK-REF: ${CHECK_SHA}`).reasons,
    ["CHECK_REF_COUNT"],
  );
  assert.deepEqual(parseCheckRef("CHECK-REF: main").reasons, [
    "CHECK_REF_FORMAT",
  ]);
  // Mid-line marker is invisible by design (line-anchored parser).
  assert.deepEqual(
    parseCheckRef(`the commit is CHECK-REF: ${CHECK_SHA} thanks`).reasons,
    ["CHECK_REF_MISSING"],
  );
});

test("wasAutoPromoted: keys on the triage-auto event author", () => {
  assert.equal(wasAutoPromoted([]), false);
  assert.equal(
    wasAutoPromoted([{ event_type: "AGENT STATUS", agent_code: "triage" }]),
    false,
  );
  assert.equal(
    wasAutoPromoted([
      {
        event_type: "AGENT STATUS",
        agent_code: "triage-auto",
        payload: { action: "auto-promoted" },
      },
    ]),
    true,
  );
});

// --------------------------------------------------------------------------
// Task 2 — check-run.sh + runExecutedCheck against a scratch git repo.
// Integration tests; they run git + node for real. scratchCheckRepo() writes
// a repo whose HEAD carries the named test files.
// --------------------------------------------------------------------------

function scratchCheckRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), "oe-check-repo-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.email=oe@test",
    "-c",
    "user.name=oe-test",
    "commit",
    "-q",
    "-m",
    "scratch",
  ]);
  const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  return { dir, sha };
}

const PASSING_TEST = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'test("passes", () => { assert.equal(1 + 1, 2); });',
  "",
].join("\n");

const FAILING_TEST = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'test("fails", () => { assert.equal(1 + 1, 3); });',
  "",
].join("\n");

// Spec §9 probe 6 (env scrub): this check PASSES only when the credential is
// NOT visible — if the scrub ever leaks, the check fails and the task holds.
const ENV_SCRUB_TEST = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'test("cred is not visible in the check env", () => {',
  "  assert.equal(process.env.BB_MCP_KEY, undefined);",
  "});",
  "",
].join("\n");

// Spec §9 probe 6 (network deny): the check PASSES only when an outbound
// connect is denied by the sandbox (EPERM-class), not merely refused.
// Discriminating only on a machine with real network access.
const NET_DENY_TEST = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'import { connect } from "node:net";',
  'test("outbound network is denied", async () => {',
  "  const err = await new Promise((resolve) => {",
  '    const sock = connect({ host: "1.1.1.1", port: 443 });',
  '    sock.setTimeout(3000, () => { sock.destroy(); resolve(new Error("TIMEOUT")); });',
  '    sock.on("error", (e) => resolve(e));',
  '    sock.on("connect", () => { sock.destroy(); resolve(null); });',
  "  });",
  '  assert.ok(err, "connect unexpectedly succeeded - network not denied");',
  "});",
  "",
].join("\n");

// check-run.sh enforces its outbound-network deny with `sandbox-exec`, which
// exists only on macOS. On any other host the script FAILS CLOSED: exit 67,
// CHECK_ISOLATION_UNAVAILABLE, refusing to run a check without the isolation it
// promises rather than silently downgrading to scrub-only. That is the correct
// behavior and is NOT what these tests are here to challenge.
//
// The consequence is that the five tests below can only assert a passing check
// on a macOS host, so they SKIP elsewhere (Linux CI included). They are skipped
// loudly rather than deleted or weakened: a skip that reads as a pass is how a
// real regression hides, and these cover the isolation guarantees (env scrub,
// network deny) that make the executed-check lane safe to trust at all.
//
// If you are running the OE-13B lane on Linux, it does not work there yet --
// see the note in the skill. This is a portability gap, not a test bug.
const SANDBOX_EXEC_AVAILABLE = (() => {
  try {
    execFileSync("sh", ["-c", "command -v sandbox-exec"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const SANDBOX_SKIP = SANDBOX_EXEC_AVAILABLE
  ? false
  : "requires macOS sandbox-exec; check-run.sh fails closed (exit 67) without it";

function runCheck(repo, sha, argv) {
  return runExecutedCheck({
    runner: "node-test",
    args: argv.slice(2),
    argv,
    ref: sha,
    repo,
  });
}

test("check-run.sh: passing check exits 0 in an isolated worktree", { skip: SANDBOX_SKIP }, () => {
  const { dir, sha } = scratchCheckRepo({ "pass.test.mjs": PASSING_TEST });
  try {
    const verdict = runCheck(dir, sha, ["node", "--test", "pass.test.mjs"]);
    assert.equal(verdict.passed, true, verdict.output);
    assert.equal(verdict.exit_code, 0);
    // Teardown assert: no worktree left behind.
    const list = execFileSync("git", ["-C", dir, "worktree", "list"], {
      encoding: "utf8",
    });
    assert.equal(list.trim().split("\n").length, 1, list);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-run.sh: failing check maps to EXECUTED_CHECK_FAILED", { skip: SANDBOX_SKIP }, () => {
  const { dir, sha } = scratchCheckRepo({ "fail.test.mjs": FAILING_TEST });
  try {
    const verdict = runCheck(dir, sha, ["node", "--test", "fail.test.mjs"]);
    assert.equal(verdict.passed, false);
    assert.equal(verdict.reason, "EXECUTED_CHECK_FAILED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-run.sh: env is scrubbed — credential never visible (probe 6)", { skip: SANDBOX_SKIP }, () => {
  const { dir, sha } = scratchCheckRepo({ "scrub.test.mjs": ENV_SCRUB_TEST });
  const previous = process.env.BB_MCP_KEY;
  process.env.BB_MCP_KEY = "leak-canary-not-a-real-key";
  try {
    const verdict = runCheck(dir, sha, ["node", "--test", "scrub.test.mjs"]);
    assert.equal(verdict.passed, true, verdict.output);
  } finally {
    if (previous === undefined) delete process.env.BB_MCP_KEY;
    else process.env.BB_MCP_KEY = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-run.sh: outbound network is denied (probe 6)", { skip: SANDBOX_SKIP }, () => {
  const { dir, sha } = scratchCheckRepo({ "net.test.mjs": NET_DENY_TEST });
  try {
    const verdict = runCheck(dir, sha, ["node", "--test", "net.test.mjs"]);
    assert.equal(verdict.passed, true, verdict.output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-run.sh: unknown ref maps to CHECK_REF_UNRESOLVED", { skip: SANDBOX_SKIP }, () => {
  const { dir } = scratchCheckRepo({ "pass.test.mjs": PASSING_TEST });
  try {
    const verdict = runCheck(dir, "b".repeat(40), [
      "node",
      "--test",
      "pass.test.mjs",
    ]);
    assert.equal(verdict.passed, false);
    assert.equal(verdict.reason, "CHECK_REF_UNRESOLVED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Task 3 — evaluate() classification branch (probes 2, 3, 4, 5 + eligibility)
// --------------------------------------------------------------------------

test("evaluate: eligible check_spec task is APPLYABLE with pending executed_check", () => {
  withTempCopy((dir) => {
    const result = evaluate(checkSpecTask(), tmpRegistry(dir), {});
    assert.equal(result.status, "APPLYABLE", JSON.stringify(result.hold));
    const check = result.apply[0].executed_check;
    assert.equal(check.pending, true);
    assert.equal(check.ref, CHECK_SHA);
    assert.equal(check.repo, dir);
    assert.deepEqual(check.argv, ["node", "--test", "parse-thing.test.mjs"]);
  });
});

test("evaluate: task without check_spec has null executed_check (additive)", () => {
  withTempCopy((dir) => {
    const input = checkSpecTask({ check_spec: null });
    const result = evaluate(input, tmpRegistry(dir), {});
    assert.equal(result.status, "APPLYABLE");
    assert.equal(result.apply[0].executed_check, null);
  });
});

test("evaluate: malformed check_spec holds CHECK_SPEC_UNPARSEABLE (probe 2)", () => {
  withTempCopy((dir) => {
    const input = checkSpecTask({
      check_spec: { runner: "bash", args: ["-c", "true"] },
    });
    const result = evaluate(input, tmpRegistry(dir), {});
    assert.equal(result.status, "HELD");
    assert.ok(result.hold[0].reasons.includes("CHECK_SPEC_UNPARSEABLE"));
  });
});

test("evaluate: auto-promoted check_spec task holds (probe 5, do-not-stack)", () => {
  withTempCopy((dir) => {
    const input = checkSpecTask({
      events: [{
        task_id: "cccccccc-e270-44dc-b414-d75e00080ae4",
        event_type: "AGENT STATUS",
        agent_code: "triage-auto",
        payload: { action: "auto-promoted" },
        created_at: "2026-07-15T08:35:00.000Z",
      }],
    });
    const result = evaluate(input, tmpRegistry(dir), {});
    assert.equal(result.status, "HELD");
    assert.ok(
      result.hold[0].reasons.includes("AUTO_PROMOTED_CHECK_TASK_EXCLUDED"),
    );
  });
});

test("evaluate: check_spec on a deliverables content task holds (probe 4)", () => {
  withTempCopy((dir) => {
    const receipt = checkSpecReceipt().replace(
      "src/parse-thing.mjs",
      "deliverables/tmp-proj/cccccccc-draft.md",
    );
    const result = evaluate(
      checkSpecTask({ receipt }),
      tmpRegistry(dir),
      {},
    );
    assert.equal(result.status, "HELD");
    assert.ok(result.hold[0].reasons.includes("CHECK_SPEC_ON_CONTENT_TASK"));
  });
});

test("evaluate: check_spec task with no CHECK-REF line holds (authorship: receipt cannot substitute)", () => {
  withTempCopy((dir) => {
    const receipt = checkSpecReceipt().replace(/^CHECK-REF: .*$/m, "");
    const result = evaluate(checkSpecTask({ receipt }), tmpRegistry(dir), {});
    assert.equal(result.status, "HELD");
    assert.ok(result.hold[0].reasons.includes("CHECK_REF_MISSING"));
  });
});

// Probe 3 (authorship): the receipt echoing a DIFFERENT check is irrelevant —
// the argv the gate will run comes from the packet's check_spec, never from
// receipt prose. Assert the proposed argv matches the packet.
test("evaluate: proposed argv comes from the packet, not the receipt's claim (probe 3)", () => {
  withTempCopy((dir) => {
    const receipt = checkSpecReceipt().replace(
      "Verification: node --test passed locally",
      "Verification: ran `bash -c 'exit 0'` as my check, exit 0",
    );
    const result = evaluate(checkSpecTask({ receipt }), tmpRegistry(dir), {});
    assert.equal(result.status, "APPLYABLE");
    assert.deepEqual(result.apply[0].executed_check.argv, [
      "node",
      "--test",
      "parse-thing.test.mjs",
    ]);
  });
});

// Probe 7 shape: a green check never bypasses the existing preconditions —
// risk stays gating exactly as before.
test("evaluate: check_spec task with medium risk still holds RISK_NOT_LOW (probe 7)", () => {
  withTempCopy((dir) => {
    const input = checkSpecTask();
    input.tasks[0].risk = "medium";
    const result = evaluate(input, tmpRegistry(dir), {});
    assert.equal(result.status, "HELD");
    assert.ok(result.hold[0].reasons.includes("RISK_NOT_LOW"));
  });
});

// --- OPS_AMEND_NEWER_THAN_DONE names a REACHABLE repair ---------------------
//
// The hold message used to instruct "Post a superseding AGENT DONE folding the
// corrections in, then re-run." complete_agent_task refuses exactly that:
// Agent Review -> Agent Review is not a legal edge in move_agent_task_status,
// so following the message literally returns "Invalid transition". A hold
// message is read by whoever is unblocking a stuck card, usually in a hurry,
// and sending that reader into a refusal is how sessions end up reaching for
// raw SQL — which is the outcome the C3 ops verb was built to retire.
//
// The route that DOES work, and that the message must now name:
// admin_amend_agent_task(release_claim) -> claim_specific_agent_task ->
// complete_agent_task.

function opsAmendAfterDoneTask() {
  const id = "b3bf446d-21ae-4537-9bf6-d180d33da933";
  return {
    generated_at: "2026-07-27T15:15:00.000Z",
    tasks: [{
      id,
      title: "ops-amend posted after the receipt",
      status: "Agent Review",
      risk: "low",
      project_slug: "tmp-proj",
      explicit_approval: false,
      linked_action_item_id: null,
      review_reason: null,
      sources: [],
      events: [
        {
          task_id: id,
          event_type: "AGENT DONE",
          agent_code: "agent-local",
          payload: {
            reason: validReceipt(),
            status: "Agent Review",
            from_status: "Agent Working",
          },
          created_at: "2026-07-27T15:14:53.000Z",
        },
        {
          task_id: id,
          event_type: "AGENT STATUS",
          agent_code: null,
          payload: { action: "ops-amend", reason: "a human correction" },
          created_at: "2026-07-27T15:15:04.000Z",
        },
      ],
    }],
    actionItems: [],
  };
}

test("evaluate HOLDs when an ops-amend is newer than the AGENT DONE", () => {
  withTempCopy((dir) => {
    const input = opsAmendAfterDoneTask();
    const result = evaluate(input, tmpRegistry(dir), {
      taskId: input.tasks[0].id,
    });
    assert.equal(result.status, "HELD");
    assert.ok(result.hold[0].reasons.includes("OPS_AMEND_NEWER_THAN_DONE"));
  });
});

test("OPS_AMEND_NEWER_THAN_DONE hold message names only reachable verbs", () => {
  withTempCopy((dir) => {
    const input = opsAmendAfterDoneTask();
    const { message } = evaluate(input, tmpRegistry(dir), {
      taskId: input.tasks[0].id,
    }).hold[0];

    // The three verbs of the route that actually succeeds, in order.
    const route = [
      "admin_amend_agent_task",
      "claim_specific_agent_task",
      "complete_agent_task",
    ];
    let cursor = -1;
    for (const verb of route) {
      const at = message.indexOf(verb, cursor + 1);
      assert.ok(at > cursor, `hold message must name ${verb} after the prior step`);
      cursor = at;
    }
    assert.match(message, /release_claim/);

    // It must NOT send the reader at the transition the RPC refuses. Guard on
    // the instruction shape, not the bare phrase: the message legitimately
    // mentions "superseding" while telling the reader it does not work.
    assert.doesNotMatch(
      message,
      /Post a superseding AGENT DONE folding the corrections in/i,
      "hold message still instructs the unreachable Agent Review -> Agent Review transition",
    );
  });
});

// ---------------------------------------------------------------------------
// Human-apply gap.
//
// The board write and the project-history writes are separate systems. These
// pin BOTH halves of the fix: --operator-apply (so a human has a controller
// path for a non-low card) and --audit-unrecorded (so a card that skipped the
// history write is detectable instead of reading as cleanly closed).
// ---------------------------------------------------------------------------

function riskTask(risk, overrides = {}) {
  const id = "dddddddd-e270-44dc-b414-d75e00080ae4";
  return {
    generated_at: "2026-07-27T12:00:00.000Z",
    tasks: [{
      id,
      title: `${risk}-risk task`,
      status: "Agent Review",
      risk,
      project_slug: "tmp-proj",
      explicit_approval: false,
      linked_action_item_id: null,
      review_reason: null,
      sources: [],
      ...overrides,
      events: [{
        task_id: id,
        event_type: "AGENT DONE",
        agent_code: "claude-code",
        payload: {
          reason: validReceipt(),
          status: "Agent Review",
          from_status: "Agent Working",
        },
        created_at: "2026-07-27T11:00:00.000Z",
      }],
    }],
    actionItems: [],
  };
}

test("operator-apply: medium risk HOLDs by default (unattended behavior unchanged)", () => {
  withTempCopy((dir) => {
    const result = evaluate(riskTask("medium"), tmpRegistry(dir), {});
    assert.equal(result.status, "HELD");
    assert.ok(result.hold[0].reasons.includes("RISK_NOT_LOW"));
  });
});

test("operator-apply: medium risk becomes APPLYABLE under the flag", () => {
  withTempCopy((dir) => {
    const result = evaluate(riskTask("medium"), tmpRegistry(dir), {
      operatorApply: true,
    });
    assert.equal(result.status, "APPLYABLE");
    assert.equal(result.apply[0].operator_apply, true);
    assert.equal(result.apply[0].risk, "medium");
  });
});

test("operator-apply: high risk is NOT a second excluded tier", () => {
  // Capping the flag at medium would recreate the bug for the highest-stakes
  // cards: a high card applied by hand would again write no project history.
  withTempCopy((dir) => {
    const result = evaluate(riskTask("high"), tmpRegistry(dir), {
      operatorApply: true,
    });
    assert.equal(result.status, "APPLYABLE");
    assert.equal(result.apply[0].operator_apply, true);
    assert.equal(result.apply[0].risk, "high");
  });
});

test("operator-apply: a LOW task under the flag is not counted as human-widened", () => {
  // The flag changed nothing for it, so stamping operator_apply would inflate
  // the board's count of cards a human waved past the risk gate.
  withTempCopy((dir) => {
    const result = evaluate(riskTask("low"), tmpRegistry(dir), {
      operatorApply: true,
    });
    assert.equal(result.status, "APPLYABLE");
    assert.equal(result.apply[0].operator_apply, false);
  });
});

test("operator-apply: widens ONLY risk, never the other gates", () => {
  withTempCopy((dir) => {
    // Wrong status AND non-low risk: the flag must clear the risk reason and
    // leave the status reason standing.
    const input = riskTask("medium", { status: "Agent Working" });
    const result = evaluate(input, tmpRegistry(dir), { operatorApply: true });
    assert.equal(result.status, "HELD");
    assert.ok(result.hold[0].reasons.includes("STATUS_NOT_AGENT_REVIEW"));
    assert.ok(!result.hold[0].reasons.includes("RISK_NOT_LOW"));
  });
});

test("operator-apply: flag does not rescue a task with a broken receipt", () => {
  withTempCopy((dir) => {
    const input = riskTask("medium");
    input.tasks[0].events[0].payload.reason = "What I did: some stuff";
    const result = evaluate(input, tmpRegistry(dir), { operatorApply: true });
    assert.equal(result.status, "HELD");
    assert.ok(result.hold[0].reasons.includes("RECEIPT_MISSING_SECTION"));
  });
});

test("RISK_NOT_LOW hold message warns that a hand-apply writes no history", () => {
  // This message IS the fix for the discoverability half of the bug: the old
  // generic fallback printed the reason code and nothing else, so a human read
  // it, applied by hand, and lost the record with no warning.
  withTempCopy((dir) => {
    const result = evaluate(riskTask("medium"), tmpRegistry(dir), {});
    const message = result.hold[0].message;
    assert.match(message, /--operator-apply/, "names the escape hatch");
    assert.match(message, /apply_agent_task_review/, "names the trap verb");
    assert.match(message, /tracker/i);
    assert.match(message, /session-log/i);
    assert.match(message, /capture/i);
  });
});

// --- --audit-unrecorded -----------------------------------------------------

function appliedPacket(overrides = {}) {
  const {
    id = "eeeeeeee-e270-44dc-b414-d75e00080ae4",
    project_slug = "tmp-proj",
    risk = "medium",
    applied_by = "operator",
    closeout_evidence = undefined,
    events = null,
  } = overrides;
  return {
    task: { id, project_slug, risk, status: "Agent Done" },
    events: events || [{
      event_type: "AGENT APPLIED",
      created_at: "2026-07-27T12:00:00.000Z",
      payload: { applied_by, closeout_evidence },
    }],
  };
}

const AUDIT_REGISTRY = {
  "tmp-proj": {
    workspace_path: "/nope",
    tracker_path: "/nope/PROJECT-TRACKER.md",
    session_log_path: "/nope/SESSION-LOG.md",
    capture_tag: "tmp_proj",
  },
};

function readerFor(map) {
  return (path) => (path in map ? map[path] : null);
}

test("audit: applied card whose FULL id is in the tracker is recorded", () => {
  const packet = appliedPacket();
  const result = evaluateUnrecordedAudit([packet], AUDIT_REGISTRY, {
    readText: readerFor({
      "/nope/PROJECT-TRACKER.md": `closeout tasks: ${packet.task.id}`,
    }),
  });
  assert.equal(result.unrecorded.length, 0);
  assert.equal(result.recorded[0].found_by, "full-id");
});

test("audit: a hand-written entry carrying only the SHORT id still counts", () => {
  const result = evaluateUnrecordedAudit([appliedPacket()], AUDIT_REGISTRY, {
    readText: readerFor({
      "/nope/SESSION-LOG.md": "Applied card eeeeeeee by hand.",
    }),
  });
  assert.equal(result.unrecorded.length, 0);
  assert.equal(result.recorded[0].found_by, "short-id");
});

test("audit: applied card absent from both files is unrecorded", () => {
  const result = evaluateUnrecordedAudit([appliedPacket()], AUDIT_REGISTRY, {
    readText: readerFor({
      "/nope/PROJECT-TRACKER.md": "unrelated content",
      "/nope/SESSION-LOG.md": "also unrelated",
    }),
  });
  assert.equal(result.unrecorded.length, 1);
  assert.equal(result.unrecorded[0].severity, "NO_RECORD_WRITTEN");
  assert.equal(result.unrecorded[0].via_controller, false);
});

test("audit: a CONTROLLER-applied card with no record is PARTIAL_APPLY, not the same bug", () => {
  // The controller writes board + files in one run, so a missing record there
  // means a half-completed apply. Triaging it with the hand-apply pile would
  // hide a real partial-write failure.
  const packet = appliedPacket({
    applied_by: "closeout-controller",
    closeout_evidence: { source: "oe8-closeout-controller" },
  });
  const result = evaluateUnrecordedAudit([packet], AUDIT_REGISTRY, {
    readText: readerFor({ "/nope/PROJECT-TRACKER.md": "nothing here" }),
  });
  assert.equal(result.unrecorded[0].severity, "PARTIAL_APPLY");
  assert.equal(result.unrecorded[0].via_controller, true);
});

test("audit: a task that was never applied is skipped, not reported", () => {
  const packet = appliedPacket({
    events: [{
      event_type: "AGENT DONE",
      created_at: "2026-07-27T11:00:00.000Z",
      payload: {},
    }],
  });
  const result = evaluateUnrecordedAudit([packet], AUDIT_REGISTRY, {
    readText: readerFor({}),
  });
  assert.equal(result.unrecorded.length, 0);
  assert.equal(result.skipped[0].reason, "NOT_APPLIED");
});

test("audit: null slug and unknown route are reported as skipped, never dropped", () => {
  const noSlug = appliedPacket({
    id: "11111111-e270-44dc-b414-d75e00080ae4",
    project_slug: null,
  });
  const badRoute = appliedPacket({
    id: "22222222-e270-44dc-b414-d75e00080ae4",
    project_slug: "does-not-exist",
  });
  const result = evaluateUnrecordedAudit(
    [noSlug, badRoute],
    AUDIT_REGISTRY,
    { readText: readerFor({}) },
  );
  assert.equal(result.unrecorded.length, 0);
  const reasons = result.skipped.map((row) => row.reason).sort();
  assert.deepEqual(reasons, ["MISSING_PROJECT_SLUG", "UNKNOWN_PROJECT_ROUTE"]);
});

test("audit: an unreadable history file does not crash or fake a record", () => {
  // readText returns null for every path (missing files, permissions). The
  // card must fall through to unrecorded, never be silently treated as found.
  const result = evaluateUnrecordedAudit([appliedPacket()], AUDIT_REGISTRY, {
    readText: () => null,
  });
  assert.equal(result.unrecorded.length, 1);
  assert.equal(result.unrecorded[0].severity, "NO_RECORD_WRITTEN");
});

test("audit: a card recorded ONLY in a subproject tracker counts as recorded", () => {
  // Real projects do this: a card can be recorded only in a per-workstream
  // tracker nested under the workspace, not the routed root tracker.
  // Reporting it missing forever would make the detector cry wolf.
  const packet = appliedPacket();
  const sub = "/nope/workstream-a/PROJECT-TRACKER.md";
  const result = evaluateUnrecordedAudit([packet], AUDIT_REGISTRY, {
    listHistoryFiles: (route) => ({
      routed: [route.tracker_path, route.session_log_path],
      all: [route.tracker_path, route.session_log_path, sub],
    }),
    readText: readerFor({ [sub]: `closed ${packet.task.id}` }),
  });
  assert.equal(result.unrecorded.length, 0);
  assert.equal(result.recorded[0].found_scope, "subproject");
});

test("audit: a routed hit outranks a subproject hit", () => {
  const packet = appliedPacket();
  const sub = "/nope/sub/PROJECT-TRACKER.md";
  const result = evaluateUnrecordedAudit([packet], AUDIT_REGISTRY, {
    listHistoryFiles: (route) => ({
      routed: [route.tracker_path, route.session_log_path],
      all: [route.tracker_path, route.session_log_path, sub],
    }),
    readText: readerFor({
      "/nope/PROJECT-TRACKER.md": `closed ${packet.task.id}`,
      [sub]: `also mentions ${packet.task.id}`,
    }),
  });
  assert.equal(result.recorded[0].found_scope, "routed");
});

test("audit: a deliverables file must NOT be able to satisfy the check", () => {
  // deliverables/<slug>/<shortid>-<name>.md embeds the short id in its own
  // filename, so counting that directory would make every card read as
  // recorded and the detector could never fail. Guarded by excluding the
  // directory from discovery -- pinned here because the failure is silent.
  const packet = appliedPacket();
  const deliverable = "/nope/deliverables/tmp-proj/eeeeeeee-thing.md";
  const result = evaluateUnrecordedAudit([packet], AUDIT_REGISTRY, {
    listHistoryFiles: (route) => ({
      routed: [route.tracker_path, route.session_log_path],
      // Discovery excludes deliverables/, so it never reaches `all`.
      all: [route.tracker_path, route.session_log_path],
    }),
    readText: readerFor({ [deliverable]: `content for ${packet.task.id}` }),
  });
  assert.equal(result.unrecorded.length, 1, "deliverable must not count");
});

// ---------------------------------------------------------------------------
// Closeout captures are bookkeeping records (plan 2026-11-05 post-review
// follow-through, Task 1). Every capture_thought body the controller sends
// carries CLOSEOUT_CAPTURE_PREFIX, which both capture handlers list in
// MECHANICAL_CAPTURE_PREFIXES, so a controller record never extracts action
// items and never auto-resolves one. The live call sites are driven here with
// fetch stubbed, not just the helper in isolation.
// ---------------------------------------------------------------------------

const PREFIX_LINE = "[Open Engine Closeout]\n";

test("closeout prefix: asCloseoutCapture prefixes once and keeps the body byte for byte", () => {
  assert.equal(CLOSEOUT_CAPTURE_PREFIX, "[Open Engine Closeout]");
  const body = "Jordan Lee backyard garden concept brief drafted 2026-09-30 (task 83a4acfa).\nFOR OPERATOR: draw it\n  trailing  ";
  const out = asCloseoutCapture(body);
  assert.ok(out.startsWith(PREFIX_LINE), out);
  assert.equal(out.slice(PREFIX_LINE.length), body);
});

test("closeout prefix: asCloseoutCapture is idempotent, including with leading whitespace", () => {
  const once = asCloseoutCapture("sweep body");
  assert.equal(asCloseoutCapture(once), once);
  const padded = "  \n[Open Engine Closeout]\nalready marked";
  assert.equal(asCloseoutCapture(padded), padded);
  // A near-miss spelling is NOT the prefix and gets the real one in front.
  assert.ok(asCloseoutCapture("[Open Engine Closeout:] x").startsWith(PREFIX_LINE));
});

test("closeout prefix: nullish and non-string input become a prefixed empty or stringified body", () => {
  assert.equal(asCloseoutCapture(undefined), PREFIX_LINE);
  assert.equal(asCloseoutCapture(null), PREFIX_LINE);
  assert.equal(asCloseoutCapture(42), `${PREFIX_LINE}42`);
});

test("closeout prefix: the exact literal is listed in BOTH capture handlers' MECHANICAL_CAPTURE_PREFIXES", () => {
  for (const fn of ["open-brain-mcp", "ingest-thought"]) {
    const src = readFileSync(
      join(HERE, "..", "..", "supabase", "functions", fn, "index.ts"),
      "utf8",
    );
    const start = src.indexOf("const MECHANICAL_CAPTURE_PREFIXES = [");
    assert.ok(start >= 0, `${fn}: list not found`);
    const block = src.slice(start, src.indexOf("];", start));
    assert.ok(
      block.includes(`"${CLOSEOUT_CAPTURE_PREFIX}",`),
      `${fn}: MECHANICAL_CAPTURE_PREFIXES lacks ${CLOSEOUT_CAPTURE_PREFIX}`,
    );
  }
});

test("closeout prefix: applyCaptureArgs prefixes the batch capture and leaves the tracker/log drafts alone", () => {
  const batch = {
    project_slug: "tmp-proj",
    capture_tag: "tmp_proj",
    tracker_draft: "- [x] did the thing",
    session_log_draft: "did the thing",
    open_brain_capture_draft: "did the thing\nFOR OPERATOR: install it",
  };
  const args = applyCaptureArgs(batch);
  assert.deepEqual(Object.keys(args).sort(), ["content", "tags"]);
  assert.equal(args.content, `${PREFIX_LINE}did the thing\nFOR OPERATOR: install it`);
  assert.deepEqual(args.tags, ["tmp_proj", "open_engine"]);
  // Prose destined for project files is not marked.
  assert.equal(batch.tracker_draft, "- [x] did the thing");
  assert.equal(batch.session_log_draft, "did the thing");
  assert.equal(batch.open_brain_capture_draft, "did the thing\nFOR OPERATOR: install it");
});

test("closeout prefix: resolutionCaptureArgs prefixes the sweep capture, item.body (the tracker text) stays unprefixed", () => {
  const item = evaluateResolutionSweep([operatorDonePacket()], sweepRegistry(), { now: SWEEP_NOW }).appendable[0];
  const args = resolutionCaptureArgs(item);
  assert.equal(args.content, `${PREFIX_LINE}${item.body}`);
  assert.deepEqual(args.tags, ["example_project", "open_engine", "operator-resolution"]);
  assert.ok(item.body.startsWith("Resolved by Sam Operator on 2026-07-18"), item.body);
  assert.ok(!item.body.includes(CLOSEOUT_CAPTURE_PREFIX));
});

test("closeout prefix: buildRunSummary content is prefixed and keeps its tags and wording", () => {
  const summary = buildRunSummary({
    runTimestamp: "2026-11-05T21:51:20.842Z",
    appliedTaskIds: "",
    heldTasks: "381943e7-aaaa-bbbb-cccc-dddddddddddd:MISSING_PROJECT_SLUG",
    remainingAgentReview: "3",
    notable: "afternoon closeout lane",
  });
  assert.equal(
    summary.content,
    `${PREFIX_LINE}OE-8D closeout run 2026-11-05T21:51:20.842Z: applied 0 [], held 1 [381943e7: MISSING_PROJECT_SLUG], 3 Agent Review rows remaining. afternoon closeout lane.`,
  );
  assert.deepEqual(summary.tags, ["open-engine", "closeout", "oe-8d"]);
});

// Drive a live entry point with fetch replaced by a JSON-RPC stub that records
// every tools/call and answers by tool name. Env creds are dummies; nothing
// leaves the process. Returns the recorded calls.
async function withMcpStub(handlers, fn) {
  const calls = [];
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const printed = [];
  const env = { url: process.env.BB_MCP_URL, key: process.env.BB_MCP_KEY };
  process.env.BB_MCP_URL = "http://mcp.stub.invalid/";
  process.env.BB_MCP_KEY = "stub-key";
  globalThis.fetch = async (_url, init) => {
    const rpc = JSON.parse(init.body);
    const name = rpc.params.name;
    calls.push({ name, args: rpc.params.arguments });
    const handler = handlers[name];
    if (!handler) throw new Error(`stub: no handler for ${name}`);
    const payload = await handler(rpc.params.arguments);
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: rpc.id,
      result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  console.log = (...a) => { printed.push(a.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
    if (env.url === undefined) delete process.env.BB_MCP_URL; else process.env.BB_MCP_URL = env.url;
    if (env.key === undefined) delete process.env.BB_MCP_KEY; else process.env.BB_MCP_KEY = env.key;
  }
  return { calls, printed };
}

test("closeout prefix (call site): captureRunSummary sends the prefixed body and --summary-preview prints the same body", async () => {
  const args = {
    runTimestamp: "2026-11-05T21:51:20.842Z",
    appliedTaskIds: "",
    heldTasks: "",
    remainingAgentReview: "0",
    notable: "nominal",
    summaryPreview: false,
  };
  const live = await withMcpStub({ capture_thought: () => "Captured as observation" }, () => captureRunSummary(args));
  assert.equal(live.calls.length, 1);
  assert.equal(live.calls[0].name, "capture_thought");
  assert.ok(live.calls[0].args.content.startsWith(`${PREFIX_LINE}OE-8D closeout run 2026-11-05T21:51:20.842Z`), live.calls[0].args.content);
  assert.deepEqual(live.calls[0].args.tags, ["open-engine", "closeout", "oe-8d"]);

  const preview = await withMcpStub({}, () => captureRunSummary({ ...args, summaryPreview: true }));
  assert.equal(preview.calls.length, 0, "preview must not call the MCP");
  const shown = JSON.parse(preview.printed.join("\n"));
  assert.equal(shown.mode, "summary-preview");
  assert.equal(shown.content, live.calls[0].args.content, "preview shows the exact outbound body");
});

test("closeout prefix (call site): the operator-resolution sweep captures the prefixed body and appends the unprefixed note to the tracker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oe-sweep-live-"));
  try {
    writeFileSync(join(dir, "PROJECT-TRACKER.md"), "# Tracker\n", "utf8");
    const registry = {
      "tmp-proj": {
        workspace_path: dir,
        tracker_path: join(dir, "PROJECT-TRACKER.md"),
        session_log_path: join(dir, "SESSION-LOG.md"),
        capture_tag: "tmp_proj",
      },
    };
    const doneAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const packet = operatorDonePacket({ project_slug: "tmp-proj", completed_at: doneAt });
    packet.events[2].created_at = doneAt;
    packet.task.title = "Local content research";
    const { calls } = await withMcpStub({
      list_agent_tasks: () => [{ id: packet.task.id, status: "Agent Done", completed_at: doneAt }],
      get_agent_task: () => packet,
      capture_thought: () => "Captured as observation",
    }, () => runOperatorResolutionSweep({ lookbackDays: 7, liveCheck: false, noCapture: false }, registry));
    const capture = calls.find((c) => c.name === "capture_thought");
    assert.ok(capture, JSON.stringify(calls.map((c) => c.name)));
    assert.ok(capture.args.content.startsWith(`${PREFIX_LINE}Resolved by Sam Operator on `), capture.args.content);
    assert.ok(capture.args.content.includes("DEFERRED by operator decision"));
    assert.deepEqual(capture.args.tags, ["tmp_proj", "open_engine", "operator-resolution"]);
    const tracker = readFileSync(join(dir, "PROJECT-TRACKER.md"), "utf8");
    assert.ok(tracker.includes("DEFERRED by operator decision"), tracker);
    assert.ok(!tracker.includes(CLOSEOUT_CAPTURE_PREFIX), "tracker prose must not carry the capture prefix");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("closeout prefix (call site): --apply captures the prefixed batch draft after the board apply, files stay unprefixed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oe-apply-live-"));
  try {
    writeFileSync(join(dir, "PROJECT-TRACKER.md"), "# Tracker\n", "utf8");
    writeFileSync(join(dir, "SESSION-LOG.md"), "# Log\n", "utf8");
    const journalDir = join(dir, "journals");
    const taskId = "0a1b2c3d-e270-44dc-b414-d75e00080ae4";
    const packet = {
      task: {
        id: taskId,
        title: "live apply fixture",
        status: "Agent Review",
        risk: "low",
        project_slug: "tmp-proj",
        explicit_approval: false,
        linked_action_item_id: null,
        review_reason: null,
        sources: [],
      },
      events: [{
        task_id: taskId,
        event_type: "AGENT DONE",
        agent_code: "claude-code",
        payload: { reason: validReceipt(), status: "Agent Review", from_status: "Agent Working" },
        created_at: "2026-11-05T11:00:00.000Z",
      }],
      actionItems: [],
    };
    const { calls } = await withMcpStub({
      get_agent_task: () => packet,
      apply_agent_task_review: () => ({ ok: true, status: "Agent Done" }),
      capture_thought: () => "Captured as observation",
    }, () => runLive({ taskId, apply: true, liveCheck: false, operatorApply: false, expect: null, journalDir }, tmpRegistry(dir)));
    assert.deepEqual(calls.map((c) => c.name), ["get_agent_task", "apply_agent_task_review", "capture_thought"]);
    const capture = calls[2];
    assert.equal(capture.args.content, `${PREFIX_LINE}did the thing`);
    assert.deepEqual(capture.args.tags, ["tmp_proj", "open_engine"]);
    // Apply payload unchanged by the capture change.
    assert.equal(calls[1].args.task_id, taskId);
    assert.equal(calls[1].args.resolve_linked_action_item, false);
    for (const file of ["PROJECT-TRACKER.md", "SESSION-LOG.md"]) {
      const text = readFileSync(join(dir, file), "utf8");
      assert.ok(text.includes("did the thing"), `${file}: ${text}`);
      assert.ok(!text.includes(CLOSEOUT_CAPTURE_PREFIX), `${file} must not carry the capture prefix`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Task 3.4: --supersede ---------------------------------------------------

const SUPERSEDE_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const REPLACEMENT_ID = "bbbbbbbb-2222-4222-8222-222222222222";

function heldCard(overrides = {}) {
  return {
    id: SUPERSEDE_ID,
    title: "held fixture",
    status: "Agent Needs Input",
    project_slug: "tmp-proj",
    blocked_reason: "AGENT HUMAN HOLD: PACKET_PREMISE_STALE, the option was killed",
    review_reason: null,
    operator_action: null,
    archived_at: null,
    superseded_at: null,
    superseded_reason: null,
    superseded_by: null,
    superseded_closed_generation: null,
    ...overrides,
  };
}

function supersedeDir() {
  const dir = mkdtempSync(join(tmpdir(), "oe-supersede-"));
  writeFileSync(join(dir, "PROJECT-TRACKER.md"), "# Tracker\n", "utf8");
  writeFileSync(join(dir, "SESSION-LOG.md"), "# Log\n", "utf8");
  return dir;
}

function supersedeCli(dir, overrides = {}) {
  return {
    supersedeTaskId: SUPERSEDE_ID,
    supersedeBy: REPLACEMENT_ID,
    supersedeReason: "duplicate of the replacement",
    supersedePremise: null,
    journalDir: join(dir, "journals"),
    liveCheck: false,
    ...overrides,
  };
}

function closedRow(cli) {
  return heldCard({
    status: "Agent Done",
    completed_at: "2026-11-06T12:00:00.000Z",
    superseded_at: "2026-11-06T12:00:00.000Z",
    superseded_reason: cli.supersedeReason,
    superseded_by: cli.supersedeBy,
    superseded_closed_generation: 1,
    blocked_reason: null,
  });
}

function supersededEvent(generation, reason, by, at) {
  return {
    id: `event-${generation}`,
    event_type: "TASK SUPERSEDED",
    created_at: at,
    payload: { status: "Agent Done", generation, reason, superseded_by: by },
  };
}

// What a reopen leaves behind: the status writer clears completed_at on any move off
// Done, the trigger clears superseded_closed_generation, and the superseded_* columns
// stay.
function reopenCard(board, status = "Agent Review") {
  board.state.row = { ...board.state.row, status, completed_at: null, superseded_closed_generation: null };
}

// A stub board: get_agent_task reads whatever the verb last wrote.
function stubBoard(cli, overrides = {}) {
  const state = { row: overrides.row || heldCard(), events: overrides.events || [] };
  return {
    state,
    handlers: {
      get_agent_task: ({ task_id }) => {
        if (task_id === SUPERSEDE_ID) return { task: state.row, events: state.events };
        return { task: overrides.replacement || { id: REPLACEMENT_ID, title: "the replacement", archived_at: null }, events: [] };
      },
      supersede_agent_task: (a) => {
        const generation = state.events.length + 1;
        const at = `2026-11-06T12:00:0${generation}.000Z`;
        state.row = {
          ...closedRow(cli),
          completed_at: at,
          superseded_at: at,
          superseded_reason: a.reason,
          superseded_by: a.superseded_by ?? null,
          superseded_closed_generation: generation,
        };
        state.events = [...state.events, supersededEvent(generation, a.reason, a.superseded_by ?? null, at)];
        return { receipt: "TASK SUPERSEDED", task: state.row };
      },
      capture_thought: overrides.capture || (() => "Captured as observation"),
    },
  };
}

test("supersede parseArgs: reason required, --by or --premise required, full uuids, no mixing", () => {
  const base = ["--supersede", SUPERSEDE_ID, "--reason", "r"];
  assert.throws(() => parseArgs(["--supersede", SUPERSEDE_ID, "--by", REPLACEMENT_ID]), /requires --reason/);
  assert.throws(() => parseArgs(base), /requires --premise/);
  assert.throws(() => parseArgs(["--supersede", "aaaaaaaa", "--reason", "r", "--premise", "p"]), /full task uuid/);
  assert.throws(() => parseArgs([...base, "--by", "bbbbbbbb"]), /full task uuid/);
  assert.throws(() => parseArgs([...base, "--by", REPLACEMENT_ID, "--apply", "--task-id", SUPERSEDE_ID]), /combines only/);
  assert.throws(() => parseArgs(["--reason", "r"]), /require --supersede/);
  assert.throws(() => parseArgs(["--generation", "2"]), /require --supersede/);
  assert.throws(() => parseArgs([...base, "--by", REPLACEMENT_ID, "--generation", "0"]), /positive integer/);
  assert.throws(() => parseArgs([...base, "--by", REPLACEMENT_ID, "--generation", "two"]), /positive integer/);
  assert.equal(parseArgs([...base, "--by", REPLACEMENT_ID, "--generation", "2"]).supersedeGeneration, 2);
  assert.equal(parseArgs([...base, "--by", REPLACEMENT_ID]).supersedeGeneration, null);
  assert.equal(parseArgs([...base, "--premise", "p"]).supersedePremise, "p");
  assert.equal(parseArgs([...base, "--by", REPLACEMENT_ID, "--live-check"]).liveCheck, true);
});

test("supersede gates: each hold fires on the input only it can catch", () => {
  const dir = supersedeDir();
  try {
    const registry = tmpRegistry(dir);
    const replacement = { id: REPLACEMENT_ID, archived_at: null };
    const run = (task, args, repl = replacement, reg = registry) =>
      evaluateSupersede({ task, events: [], replacement: repl, args: { reason: "r", ...args }, registry: reg }).reasons;
    assert.deepEqual(run(heldCard(), { by: REPLACEMENT_ID }), []);
    assert.deepEqual(run(heldCard(), { premise: "packet_premise_stale,   the OPTION" }), [], "premise is whitespace and case tolerant");
    assert.deepEqual(run(heldCard({ status: "Agent Todo" }), { by: REPLACEMENT_ID }), ["SUPERSEDE_STATUS_NOT_LEGAL"]);
    assert.deepEqual(run(heldCard({ status: "Agent Done" }), { by: REPLACEMENT_ID }), ["SUPERSEDE_STATUS_NOT_LEGAL"]);
    assert.deepEqual(run(heldCard({ archived_at: "2026-01-01" }), { by: REPLACEMENT_ID }), ["TASK_ARCHIVED"]);
    assert.deepEqual(run(heldCard(), { by: SUPERSEDE_ID }), ["REPLACEMENT_IS_SELF"]);
    assert.deepEqual(run(heldCard(), { by: REPLACEMENT_ID }, null), ["REPLACEMENT_NOT_FOUND"]);
    assert.deepEqual(run(heldCard(), { by: REPLACEMENT_ID }, { id: REPLACEMENT_ID, archived_at: "2026-01-01" }), ["REPLACEMENT_ARCHIVED"]);
    assert.deepEqual(run(heldCard({ blocked_reason: "a different hold now" }), { premise: "PACKET_PREMISE_STALE" }), ["PREMISE_NOTE_MISMATCH"]);
    assert.deepEqual(run(heldCard({ project_slug: null }), { by: REPLACEMENT_ID }), ["MISSING_PROJECT_SLUG"]);
    assert.deepEqual(run(heldCard({ project_slug: "nope" }), { by: REPLACEMENT_ID }), ["UNKNOWN_PROJECT_ROUTE"]);
    const inWorktree = { "tmp-proj": { ...registry["tmp-proj"], tracker_path: "/x/.claude/worktrees/w/PROJECT-TRACKER.md" } };
    assert.deepEqual(run(heldCard(), { by: REPLACEMENT_ID }, replacement, inWorktree), ["APPEND_TARGET_IN_WORKTREE"]);
    const missing = { "tmp-proj": { ...registry["tmp-proj"], session_log_path: join(dir, "absent.md") } };
    assert.deepEqual(run(heldCard(), { by: REPLACEMENT_ID }, replacement, missing), ["APPEND_TARGET_MISSING"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supersedeAlreadyDone needs the closed generation, that generation's own event, and equal arguments", () => {
  const args = { reason: "r", by: REPLACEMENT_ID };
  const row = heldCard({ status: "Agent Done", completed_at: "x", superseded_at: "x", superseded_reason: "r", superseded_by: REPLACEMENT_ID, superseded_closed_generation: 1 });
  const events = [supersededEvent(1, "r", REPLACEMENT_ID, "x")];
  assert.equal(supersedeAlreadyDone(row, events, args), true);
  assert.equal(supersedeAlreadyDone(row, [], args), false, "no event");
  assert.equal(supersedeAlreadyDone({ ...row, superseded_by: null }, [], { reason: "", by: null }), false, "no event, even when the arguments are empty");
  assert.equal(supersedeAlreadyDone({ ...row, status: "Needs Operator" }, events, args), false, "not Done");
  assert.equal(supersedeAlreadyDone({ ...row, superseded_closed_generation: null }, events, args), false, "finished normally after a reopen");
  assert.equal(supersedeAlreadyDone(row, events, { ...args, reason: "other" }), false, "other reason");
  assert.equal(supersedeAlreadyDone(row, events, { ...args, by: null }), false, "other replacement");
  // The closed generation's event decides, not whichever event comes first.
  const two = [supersededEvent(1, "first", null, "x"), supersededEvent(2, "r", REPLACEMENT_ID, "x")];
  assert.equal(supersedeAlreadyDone({ ...row, superseded_closed_generation: 2 }, two, args), true);
  assert.equal(supersedeAlreadyDone({ ...row, superseded_closed_generation: 2 }, [...two].reverse(), args), true, "array order means nothing");
  assert.equal(supersedeAlreadyDone({ ...row, superseded_closed_generation: 1 }, two, args), false, "generation 1 had other arguments");
});

test("supersede: journal is written before the verb, then tracker, log and prefixed capture", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    const board = stubBoard(cli);
    const journalPath = join(cli.journalDir, `${SUPERSEDE_ID}.supersede.g1.json`);
    let journalStateAtVerb = null;
    const verb = board.handlers.supersede_agent_task;
    board.handlers.supersede_agent_task = (a) => {
      journalStateAtVerb = JSON.parse(readFileSync(journalPath, "utf8")).state;
      return verb(a);
    };
    const { calls } = await withMcpStub(board.handlers, () => runSupersede(cli, tmpRegistry(dir)));
    assert.equal(journalStateAtVerb, "intent-written", "journal must exist before the verb runs");
    assert.deepEqual(calls.map((c) => c.name), ["get_agent_task", "get_agent_task", "supersede_agent_task", "get_agent_task", "capture_thought"]);
    const verbCall = calls[2];
    assert.deepEqual(verbCall.args, { task_id: SUPERSEDE_ID, reason: cli.supersedeReason, actor: "operator", superseded_by: REPLACEMENT_ID, expected_generation: 1 });
    for (const file of ["PROJECT-TRACKER.md", "SESSION-LOG.md"]) {
      const text = readFileSync(join(dir, file), "utf8");
      assert.ok(text.includes("## Superseded"), `${file} heading`);
      assert.ok(text.includes(supersedeMarker(SUPERSEDE_ID, 1)), `${file} marker`);
      assert.ok(text.includes(cli.supersedeReason), `${file} reason`);
      assert.ok(text.includes("bbbbbbbb"), `${file} names the replacement`);
      assert.ok(!text.includes(CLOSEOUT_CAPTURE_PREFIX), `${file} must not carry the capture prefix`);
    }
    assert.ok(calls[4].args.content.startsWith(`${CLOSEOUT_CAPTURE_PREFIX}\n`), "capture is bookkeeping");
    assert.deepEqual(calls[4].args.tags, ["tmp_proj", "open_engine", "superseded"]);
    assert.equal(JSON.parse(readFileSync(journalPath, "utf8")).state, "complete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supersede: a failed append followed by a retry completes without a second verb call", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    const board = stubBoard(cli);
    const registry = tmpRegistry(dir);
    // The session log is gone at the moment of the append, after the gate passed.
    const verb = board.handlers.supersede_agent_task;
    board.handlers.supersede_agent_task = (a) => {
      rmSync(join(dir, "SESSION-LOG.md"));
      return verb(a);
    };
    await assert.rejects(
      withMcpStub(board.handlers, () => runSupersede(cli, registry)),
      /ENOENT/,
    );
    assert.equal(board.state.row.status, "Agent Done", "the verb landed before the failure");
    writeFileSync(join(dir, "SESSION-LOG.md"), "# Log\n", "utf8");
    board.handlers.supersede_agent_task = verb;
    const { calls } = await withMcpStub(board.handlers, () => runSupersede(cli, registry));
    assert.equal(calls.filter((c) => c.name === "supersede_agent_task").length, 0, "retry must not call the verb");
    assert.equal(calls.filter((c) => c.name === "capture_thought").length, 1);
    const tracker = readFileSync(join(dir, "PROJECT-TRACKER.md"), "utf8");
    assert.equal(tracker.split(supersedeMarker(SUPERSEDE_ID, 1)).length, 2, "tracker appended exactly once across both runs");
    assert.ok(readFileSync(join(dir, "SESSION-LOG.md"), "utf8").includes(supersedeMarker(SUPERSEDE_ID, 1)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supersede: a capture failure retries the capture only; a completed journal writes nothing", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    const registry = tmpRegistry(dir);
    const board = stubBoard(cli, { capture: () => { throw new Error("capture down"); } });
    await assert.rejects(withMcpStub(board.handlers, () => runSupersede(cli, registry)));
    board.handlers.capture_thought = () => "Captured as observation";
    const second = await withMcpStub(board.handlers, () => runSupersede(cli, registry));
    assert.deepEqual(second.calls.map((c) => c.name).filter((n) => n !== "get_agent_task"), ["capture_thought"]);
    const third = await withMcpStub(board.handlers, () => runSupersede(cli, registry));
    assert.deepEqual([...new Set(third.calls.map((c) => c.name))], ["get_agent_task"], "a complete journal reads the card and writes nothing");
    assert.ok(third.printed.join("\n").includes("ALREADY_COMPLETE"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supersede: a card closed by the bare MCP verb gets its missing history without a second verb call", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    const board = stubBoard(cli, { row: closedRow(cli), events: [supersededEvent(1, cli.supersedeReason, cli.supersedeBy, closedRow(cli).superseded_at)] });
    const { calls } = await withMcpStub(board.handlers, () => runSupersede(cli, tmpRegistry(dir)));
    assert.equal(calls.filter((c) => c.name === "supersede_agent_task").length, 0);
    assert.ok(readFileSync(join(dir, "PROJECT-TRACKER.md"), "utf8").includes(supersedeMarker(SUPERSEDE_ID, 1)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supersede refuses before any write: archived replacement, changed hold note, and a different retry", async () => {
  const dir = supersedeDir();
  try {
    const registry = tmpRegistry(dir);
    const cli = supersedeCli(dir);
    const archived = stubBoard(cli, { replacement: { id: REPLACEMENT_ID, archived_at: "2026-01-01" } });
    await assert.rejects(withMcpStub(archived.handlers, () => runSupersede(cli, registry)), /REPLACEMENT_ARCHIVED/);
    assert.equal(existsSync(join(cli.journalDir, `${SUPERSEDE_ID}.supersede.g1.json`)), false, "no journal on a refusal");

    const stale = supersedeCli(dir, { supersedeBy: null, supersedePremise: "PACKET_PREMISE_STALE" });
    const changed = stubBoard(stale, { row: heldCard({ blocked_reason: "something else now" }) });
    await assert.rejects(withMcpStub(changed.handlers, () => runSupersede(stale, registry)), /PREMISE_NOTE_MISMATCH/);
    assert.equal(readFileSync(join(dir, "PROJECT-TRACKER.md"), "utf8"), "# Tracker\n", "nothing appended");

    const ok = stubBoard(cli);
    await withMcpStub(ok.handlers, () => runSupersede(cli, registry));
    const different = supersedeCli(dir, { supersedeReason: "another reason" });
    await assert.rejects(withMcpStub(ok.handlers, () => runSupersede(different, registry)), /ALREADY_SUPERSEDED_DIFFERENTLY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supersede --live-check writes nothing and calls no writer", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir, { liveCheck: true });
    const board = stubBoard(cli);
    const { calls, printed } = await withMcpStub(board.handlers, () => runSupersede(cli, tmpRegistry(dir)));
    assert.deepEqual([...new Set(calls.map((c) => c.name))], ["get_agent_task"]);
    assert.ok(printed.join("\n").includes("SUPERSEDE_READY"));
    assert.equal(existsSync(cli.journalDir), false);
    assert.equal(readFileSync(join(dir, "PROJECT-TRACKER.md"), "utf8"), "# Tracker\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a superseded card is skipped by the operator-resolution sweep, even with an earlier OPERATOR DONE", () => {
  const dir = supersedeDir();
  try {
    const task = heldCard({ status: "Agent Done" });
    const events = [
      { event_type: "OPERATOR DONE", created_at: "2026-11-05T00:00:00Z", payload: { status: "Agent Done", completed_by: "The operator", note: "n".repeat(90) } },
      { event_type: "TASK SUPERSEDED", created_at: "2026-11-06T00:00:00Z", payload: { status: "Agent Done", from_status: "Needs Operator" } },
    ];
    const result = evaluateResolutionSweep([{ task, events }], tmpRegistry(dir), { now: "2026-11-06T12:00:00Z" });
    assert.deepEqual(result.appendable, []);
    assert.deepEqual(result.skipped.map((s) => s.reason), ["NOT_OPERATOR_DONE"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supersede: a capture already journaled is not sent again when only the complete stamp was lost", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    mkdirSync(cli.journalDir, { recursive: true });
    writeFileSync(join(cli.journalDir, `${SUPERSEDE_ID}.supersede.g1.json`), JSON.stringify({
      version: 3,
      kind: "supersede",
      state: "captures-written",
      task_id: SUPERSEDE_ID,
      generation: 1,
      event_id: "event-1",
      args: { reason: cli.supersedeReason, by: cli.supersedeBy },
      capture_result: "Captured as observation",
    }), "utf8");
    const board = stubBoard(cli, { row: closedRow(cli), events: [supersededEvent(1, cli.supersedeReason, cli.supersedeBy, closedRow(cli).superseded_at)] });
    const { calls, printed } = await withMcpStub(board.handlers, () => runSupersede(cli, tmpRegistry(dir)));
    assert.equal(calls.filter((c) => c.name === "capture_thought").length, 0, "must not capture twice");
    assert.ok(printed.join("\n").includes("SUPERSEDED"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supersede: zero rows reads as a missing replacement; any other read failure stays an error", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    const failing = (message) => {
      const board = stubBoard(cli);
      const read = board.handlers.get_agent_task;
      board.handlers.get_agent_task = (a) => {
        if (a.task_id === REPLACEMENT_ID) throw new Error(message);
        return read(a);
      };
      return board.handlers;
    };
    await assert.rejects(
      withMcpStub(failing("MCP get_agent_task tool error: Error fetching agent task: Cannot coerce the result to a single JSON object"), () => runSupersede(cli, tmpRegistry(dir))),
      /REPLACEMENT_NOT_FOUND/,
    );
    await assert.rejects(
      withMcpStub(failing("MCP get_agent_task HTTP 503: upstream down"), () => runSupersede(cli, tmpRegistry(dir))),
      /HTTP 503/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- PR 19 amendment: generations, reopened cards, external worktrees ----------

const supersedeCalls = (calls) => calls.filter((c) => c.name === "supersede_agent_task");
const trackerText = (dir) => readFileSync(join(dir, "PROJECT-TRACKER.md"), "utf8");
const occurrences = (text, needle) => text.split(needle).length - 1;
const journalFile = (cli, generation) => join(cli.journalDir, `${SUPERSEDE_ID}.supersede.g${generation}.json`);
const journalOf = (cli, generation) => JSON.parse(readFileSync(journalFile(cli, generation), "utf8"));

test("regression: a partial retry repairs generation 1 and never closes the reopened card", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    const registry = tmpRegistry(dir);
    const board = stubBoard(cli, { capture: () => { throw new Error("capture down"); } });
    await assert.rejects(withMcpStub(board.handlers, () => runSupersede(cli, registry)), /capture down/);
    reopenCard(board);
    board.handlers.capture_thought = () => "Captured as observation";
    const retry = await withMcpStub(board.handlers, () => runSupersede(cli, registry));
    assert.equal(supersedeCalls(retry.calls).length, 0, "the verb must not run again");
    assert.equal(board.state.row.status, "Agent Review", "the reopened card stays open");
    assert.equal(retry.calls.filter((c) => c.name === "capture_thought").length, 1, "history is finished");
    const output = retry.printed.join("\n");
    assert.ok(output.includes("HISTORY_REPAIRED_CARD_CHANGED"), output);
    assert.ok(output.includes('"card_changed_since_generation": true'), output);
    assert.equal(occurrences(trackerText(dir), supersedeMarker(SUPERSEDE_ID, 1)), 1);
    assert.equal(journalOf(cli, 1).state, "complete");
    assert.equal(journalOf(cli, 1).event_id, "event-1", "the landed event is journaled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: a lost verb response is adopted from the event even if the card was reopened", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    const registry = tmpRegistry(dir);
    const board = stubBoard(cli);
    const verb = board.handlers.supersede_agent_task;
    board.handlers.supersede_agent_task = (a) => {
      verb(a);
      throw new Error("MCP supersede_agent_task HTTP 503: response lost");
    };
    await assert.rejects(withMcpStub(board.handlers, () => runSupersede(cli, registry)), /response lost/);
    assert.equal(journalOf(cli, 1).state, "intent-written", "the client never learned the verb landed");
    reopenCard(board);
    board.handlers.supersede_agent_task = verb;
    const retry = await withMcpStub(board.handlers, () => runSupersede(cli, registry));
    assert.equal(supersedeCalls(retry.calls).length, 0);
    assert.equal(board.state.row.status, "Agent Review");
    assert.equal(occurrences(trackerText(dir), supersedeMarker(SUPERSEDE_ID, 1)), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: replaying a completed command reads the card and holds a reopened one", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    const registry = tmpRegistry(dir);
    const board = stubBoard(cli);
    await withMcpStub(board.handlers, () => runSupersede(cli, registry));
    reopenCard(board);
    const replay = await withMcpStub(board.handlers, () =>
      assert.rejects(runSupersede(cli, registry), /REOPENED_CARD_NEEDS_GENERATION/));
    assert.ok(replay.calls.some((c) => c.name === "get_agent_task"), "the live card is read first");
    assert.equal(supersedeCalls(replay.calls).length, 0, "no second verb call");
    assert.ok(replay.printed.join("\n").includes("--generation 2"), "the hold names the next generation");
    assert.ok(!replay.printed.join("\n").includes("ALREADY_COMPLETE"));
    assert.equal(board.state.row.status, "Agent Review", "no second close");
    assert.equal(board.state.events.length, 1, "no second event");
    const after = await withMcpStub(board.handlers, () =>
      runSupersede(supersedeCli(dir, { liveCheck: true, supersedeGeneration: 2 }), registry));
    assert.ok(after.printed.join("\n").includes("SUPERSEDE_READY"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: a second generation with --generation writes its own journal, history and capture", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    const registry = tmpRegistry(dir);
    const board = stubBoard(cli);
    const first = await withMcpStub(board.handlers, () => runSupersede(cli, registry));
    reopenCard(board);
    const second = await withMcpStub(board.handlers, () =>
      runSupersede(supersedeCli(dir, { supersedeGeneration: 2 }), registry));
    assert.deepEqual(supersedeCalls(second.calls).map((c) => c.args.expected_generation), [2]);
    assert.equal(board.state.events.length, 2);
    assert.equal(occurrences(trackerText(dir), supersedeMarker(SUPERSEDE_ID, 1)), 1);
    assert.equal(occurrences(trackerText(dir), supersedeMarker(SUPERSEDE_ID, 2)), 1);
    assert.equal(occurrences(readFileSync(join(dir, "SESSION-LOG.md"), "utf8"), supersedeMarker(SUPERSEDE_ID, 2)), 1);
    assert.equal(journalOf(cli, 1).state, "complete", "generation 1's journal is left as it was");
    assert.equal(journalOf(cli, 2).state, "complete");
    const captures = [first, second].map((run) => run.calls.find((c) => c.name === "capture_thought").args.content);
    assert.notEqual(captures[0], captures[1], "the fingerprint dedup must not swallow generation 2's capture");
    assert.ok(captures[1].includes("supersede generation 2"));

    const replay = await withMcpStub(board.handlers, () =>
      runSupersede(supersedeCli(dir, { supersedeGeneration: 2 }), registry));
    assert.equal(supersedeCalls(replay.calls).length, 0);
    assert.ok(replay.printed.join("\n").includes("ALREADY_COMPLETE"));
    assert.ok(replay.printed.join("\n").includes('"generation": 2'));

    reopenCard(board);
    await assert.rejects(
      withMcpStub(board.handlers, () => runSupersede(supersedeCli(dir, { supersedeGeneration: 2 }), registry)),
      /GENERATION_MISMATCH/,
      "the old authorization does not close the card a third time",
    );
    assert.equal(board.state.events.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: a new reason on a reopened card is not stuck behind the old journal", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    const registry = tmpRegistry(dir);
    const board = stubBoard(cli);
    await withMcpStub(board.handlers, () => runSupersede(cli, registry));
    reopenCard(board);
    const fresh = supersedeCli(dir, { supersedeReason: "a new reason", supersedeGeneration: 2 });
    const run = await withMcpStub(board.handlers, () => runSupersede(fresh, registry));
    assert.deepEqual(supersedeCalls(run.calls).map((c) => c.args.reason), ["a new reason"]);
    assert.ok(trackerText(dir).includes("a new reason"));
    assert.equal(journalOf(cli, 1).args.reason, cli.supersedeReason);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: a replay on a card still closed reads it, then answers ALREADY_COMPLETE with a stale generation refused", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    const registry = tmpRegistry(dir);
    const board = stubBoard(cli);
    await withMcpStub(board.handlers, () => runSupersede(cli, registry));
    const replay = await withMcpStub(board.handlers, () => runSupersede(cli, registry));
    assert.ok(replay.calls.some((c) => c.name === "get_agent_task"));
    assert.ok(replay.printed.join("\n").includes("ALREADY_COMPLETE"));
    await assert.rejects(
      withMcpStub(board.handlers, () => runSupersede(supersedeCli(dir, { supersedeGeneration: 2 }), registry)),
      /GENERATION_MISMATCH/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: a card reopened and then finished normally is not treated as superseded", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    const registry = tmpRegistry(dir);
    const board = stubBoard(cli);
    await withMcpStub(board.handlers, () => runSupersede(cli, registry));
    // Stale columns, same arguments, the old event still there. Only the cleared
    // closed generation tells; a timestamp could not inside one transaction.
    board.state.row = { ...board.state.row, status: "Agent Done", completed_at: board.state.row.superseded_at, superseded_closed_generation: null };
    await assert.rejects(
      withMcpStub(board.handlers, () => runSupersede(cli, registry)),
      /SUPERSEDE_STATUS_NOT_LEGAL/,
    );
    assert.equal(supersedeAlreadyDone(board.state.row, board.state.events, { reason: cli.supersedeReason, by: cli.supersedeBy }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: an unlanded intent can be retried or replaced; a landed one cannot be remixed", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    const registry = tmpRegistry(dir);
    const board = stubBoard(cli);
    const verb = board.handlers.supersede_agent_task;
    board.handlers.supersede_agent_task = () => { throw new Error("MCP supersede_agent_task HTTP 503: never reached"); };
    await assert.rejects(withMcpStub(board.handlers, () => runSupersede(cli, registry)), /never reached/);
    assert.equal(journalOf(cli, 1).state, "intent-written");

    // --live-check reports the replacement and leaves the file where it is.
    const fresh = supersedeCli(dir, { supersedeReason: "a better reason" });
    const preview = await withMcpStub(board.handlers, () =>
      runSupersede({ ...fresh, liveCheck: true }, registry));
    assert.ok(preview.printed.join("\n").includes("replace-intent"));
    assert.equal(journalOf(cli, 1).args.reason, cli.supersedeReason);

    board.handlers.supersede_agent_task = verb;
    const run = await withMcpStub(board.handlers, () => runSupersede(fresh, registry));
    assert.deepEqual(supersedeCalls(run.calls).map((c) => c.args.reason), ["a better reason"]);
    assert.equal(journalOf(cli, 1).args.reason, "a better reason");
    assert.ok(
      readdirSync(cli.journalDir).some((name) => name.startsWith(`${SUPERSEDE_ID}.supersede.g1.json.replace-intent-`)),
      "the replaced intent is kept as evidence",
    );

    const landedDir = supersedeDir();
    try {
      const landed = supersedeCli(landedDir);
      const landedRegistry = tmpRegistry(landedDir);
      const partial = stubBoard(landed, { capture: () => { throw new Error("capture down"); } });
      await assert.rejects(withMcpStub(partial.handlers, () => runSupersede(landed, landedRegistry)));
      const before = partial.state.events.length;
      await assert.rejects(
        withMcpStub(partial.handlers, () =>
          runSupersede(supersedeCli(landedDir, { supersedeReason: "another reason" }), landedRegistry)),
        /different reason or replacement/,
      );
      assert.equal(partial.state.events.length, before);
    } finally {
      rmSync(landedDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: an intent another writer beat is retired, and no history is written from it", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    const registry = tmpRegistry(dir);
    const other = "somebody else's reason";
    const board = stubBoard(cli, {
      row: { ...closedRow(cli), superseded_reason: other },
      events: [supersededEvent(1, other, cli.supersedeBy, closedRow(cli).superseded_at)],
    });
    mkdirSync(cli.journalDir, { recursive: true });
    writeFileSync(journalFile(cli, 1), JSON.stringify({
      version: 3, kind: "supersede", state: "intent-written", task_id: SUPERSEDE_ID, generation: 1,
      args: { reason: cli.supersedeReason, by: cli.supersedeBy },
    }), "utf8");
    await assert.rejects(
      withMcpStub(board.handlers, () => runSupersede(cli, registry)),
      /ALREADY_SUPERSEDED_DIFFERENTLY/,
    );
    assert.equal(existsSync(journalFile(cli, 1)), false);
    assert.equal(trackerText(dir), "# Tracker\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: a journal the board does not back is refused, never written as history", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    const registry = tmpRegistry(dir);
    mkdirSync(cli.journalDir, { recursive: true });
    const seed = (state) => writeFileSync(journalFile(cli, 1), JSON.stringify({
      version: 3, kind: "supersede", state, task_id: SUPERSEDE_ID, generation: 1, event_id: "event-1",
      args: { reason: cli.supersedeReason, by: cli.supersedeBy },
    }), "utf8");
    for (const state of ["board-superseded", "complete"]) {
      seed(state);
      const board = stubBoard(cli);
      await assert.rejects(withMcpStub(board.handlers, () => runSupersede(cli, registry)), /Refusing/);
      assert.equal(trackerText(dir), "# Tracker\n", state);
      assert.equal(board.state.events.length, 0, state);
    }
    seed("board-superseded");
    const mismatched = stubBoard(cli, {
      row: { ...closedRow(cli), superseded_reason: "some other reason" },
      events: [supersededEvent(1, "some other reason", cli.supersedeBy, "2026-11-06T12:00:00.000Z")],
    });
    await assert.rejects(withMcpStub(mismatched.handlers, () => runSupersede(cli, registry)), /event-mismatch/);
    assert.equal(trackerText(dir), "# Tracker\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: GAP C reads the real checkout, not a directory name", () => {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "oe-gapc-"));
  try {
    const main = join(base, "main");
    mkdirSync(main);
    const git = (...args) => execFileSync("git", ["-C", main, "-c", "user.email=oe@test", "-c", "user.name=oe-test", ...args], { stdio: "pipe" });
    git("init", "-q");
    writeFileSync(join(main, "PROJECT-TRACKER.md"), "# T\n");
    writeFileSync(join(main, "SESSION-LOG.md"), "# L\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    const external = join(base, "plain-named-folder");
    git("worktree", "add", "-q", "--detach", external);
    const reasonsFor = (trackerPath, logPath = trackerPath) => evaluateSupersede({
      task: heldCard(),
      events: [],
      replacement: { id: REPLACEMENT_ID },
      args: { reason: "r", by: REPLACEMENT_ID },
      registry: { "tmp-proj": { tracker_path: trackerPath, session_log_path: logPath } },
    }).reasons;

    assert.deepEqual(reasonsFor(join(main, "PROJECT-TRACKER.md"), join(main, "SESSION-LOG.md")), [], "main checkout passes");
    assert.deepEqual(
      [...new Set(reasonsFor(join(external, "PROJECT-TRACKER.md"), join(external, "SESSION-LOG.md")))],
      ["APPEND_TARGET_IN_WORKTREE"],
      "a worktree with an ordinary name is refused",
    );
    assert.deepEqual(reasonsFor(join(main, "PROJECT-TRACKER.md"), join(external, "SESSION-LOG.md")), ["APPEND_TARGET_IN_WORKTREE"], "one bad path is enough");

    const links = join(base, "links");
    mkdirSync(links);
    symlinkSync(join(external, "PROJECT-TRACKER.md"), join(links, "tracker.md"));
    symlinkSync(external, join(links, "dir"));
    assert.deepEqual(reasonsFor(join(links, "tracker.md"), join(main, "SESSION-LOG.md")), ["APPEND_TARGET_IN_WORKTREE"], "a symlink to a worktree file");
    assert.deepEqual(reasonsFor(join(links, "dir", "SESSION-LOG.md"), join(main, "SESSION-LOG.md")), ["APPEND_TARGET_IN_WORKTREE"], "a symlinked worktree directory");
    symlinkSync(join(main, "PROJECT-TRACKER.md"), join(links, "main-tracker.md"));
    assert.deepEqual(reasonsFor(join(links, "main-tracker.md"), join(main, "SESSION-LOG.md")), [], "a symlink into main is main");

    mkdirSync(join(external, "sub"));
    writeFileSync(join(external, "sub", "T.md"), "# T\n");
    assert.deepEqual(reasonsFor(join(external, "sub", "T.md"), join(main, "SESSION-LOG.md")), ["APPEND_TARGET_IN_WORKTREE"], "a nested path");

    const bare = join(base, "not-git");
    mkdirSync(bare);
    writeFileSync(join(bare, "T.md"), "# T\n");
    assert.deepEqual(reasonsFor(join(bare, "T.md"), join(main, "SESSION-LOG.md")), [], "no repository at all is not a worktree");

    const submodule = join(base, "sub-checkout");
    mkdirSync(submodule);
    // A gitdir of its own, as .git/modules/<name> is. It has to be a real one now: an
    // empty directory is not a git directory, to git or to this check.
    execFileSync("git", ["init", "-q", "--bare", join(base, "modules-gitdir")], { stdio: "pipe" });
    writeFileSync(join(submodule, ".git"), `gitdir: ${join(base, "modules-gitdir")}\n`);
    writeFileSync(join(submodule, "T.md"), "# T\n");
    assert.deepEqual(reasonsFor(join(submodule, "T.md"), join(main, "SESSION-LOG.md")), [], "a submodule has a .git file but no commondir");

    for (const [name, content] of [
      ["pruned", `gitdir: ${join(base, "gone")}\n`],
      ["garbled", "not a gitdir line\n"],
    ]) {
      const odd = join(base, name);
      mkdirSync(odd);
      writeFileSync(join(odd, ".git"), content);
      writeFileSync(join(odd, "T.md"), "# T\n");
      assert.deepEqual(reasonsFor(join(odd, "T.md"), join(main, "SESSION-LOG.md")), ["APPEND_TARGET_IN_WORKTREE"], `${name} fails closed`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("regression: premise wording claims only what a fragment match proves", async () => {
  const dir = supersedeDir();
  try {
    const registry = tmpRegistry(dir);
    // The documented limit: everything but the quoted text changed, and it still passes.
    const changed = heldCard({
      blocked_reason: "AGENT HUMAN HOLD: PACKET_PREMISE_STALE, plus a brand new instruction",
      operator_action: "a different operator step",
      review_reason: "a new review note",
    });
    assert.deepEqual(
      evaluateSupersede({ task: changed, events: [], replacement: null, args: { reason: "r", premise: "PACKET_PREMISE_STALE" }, registry }).reasons,
      [],
    );
    let parseMessage = "";
    try {
      parseArgs(["--supersede", SUPERSEDE_ID, "--reason", "r"]);
    } catch (err) {
      parseMessage = err.message;
    }
    assert.match(parseMessage, /does not prove the rest of the card is unchanged/);
    assert.doesNotMatch(parseMessage, /card that changed since you read it is refused/);

    const stale = supersedeCli(dir, { supersedeBy: null, supersedePremise: "gone text" });
    const board = stubBoard(stale);
    const { printed } = await withMcpStub(board.handlers, () =>
      assert.rejects(runSupersede(stale, registry), /PREMISE_NOTE_MISMATCH/));
    const held = printed.join("\n");
    assert.match(held, /quoted text is gone/);
    assert.doesNotMatch(held, /card changed since it was read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: repairing generation 1 after a bare close of generation 2 dates and reports the right one", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    const registry = tmpRegistry(dir);
    const board = stubBoard(cli);
    // The session log is gone at the moment of the append, so generation 1's log
    // block is still to be written when the retry comes.
    const verb = board.handlers.supersede_agent_task;
    board.handlers.supersede_agent_task = (a) => {
      rmSync(join(dir, "SESSION-LOG.md"));
      return verb(a);
    };
    await assert.rejects(withMcpStub(board.handlers, () => runSupersede(cli, registry)), /ENOENT/);
    writeFileSync(join(dir, "SESSION-LOG.md"), "# Log\n", "utf8");
    board.handlers.supersede_agent_task = verb;
    // Someone reopened the card and closed it again through the bare MCP tool, same
    // arguments, two weeks later. The card reads closed, by a different generation.
    const later = "2026-11-20T09:00:00.000Z";
    board.state.row = { ...board.state.row, status: "Agent Done", completed_at: later, superseded_at: later, superseded_closed_generation: 2 };
    board.state.events = [...board.state.events, supersededEvent(2, cli.supersedeReason, cli.supersedeBy, later)];
    const retry = await withMcpStub(board.handlers, () => runSupersede(cli, registry));
    assert.equal(supersedeCalls(retry.calls).length, 0);
    const output = retry.printed.join("\n");
    assert.ok(output.includes("HISTORY_REPAIRED_CARD_CHANGED"), "generation 2 is not this run's to report as done");
    assert.ok(output.includes("2 generation(s)"), output);
    const log = readFileSync(join(dir, "SESSION-LOG.md"), "utf8");
    assert.ok(log.includes("## Superseded — 2026-11-06"), "dated from generation 1's own event");
    assert.ok(!log.includes("2026-11-20"), "the columns already describe generation 2");
    assert.equal(occurrences(log, supersedeMarker(SUPERSEDE_ID, 2)), 0, "generation 2's history is a separate run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- PR 19 second amendment: explicit generation identity, checkout ancestry ------

// One card through three generations, read back in the order PostgreSQL produced for
// serialized closes whose transactions started out of order: 1, 3, 2.
function threeGenerationBoard(cli, reasons = ["reason one", "reason two", "reason three"]) {
  const events = [
    supersededEvent(1, reasons[0], cli.supersedeBy, "2026-11-01T12:00:00.000Z"),
    supersededEvent(3, reasons[2], cli.supersedeBy, "2026-11-03T12:00:00.000Z"),
    supersededEvent(2, reasons[1], cli.supersedeBy, "2026-11-02T12:00:00.000Z"),
  ];
  return stubBoard(cli, {
    events,
    row: { ...closedRow(cli), superseded_reason: reasons[2], superseded_closed_generation: 3, superseded_at: events[1].created_at, completed_at: events[1].created_at },
  });
}

function seedJournal(cli, generation, fields) {
  mkdirSync(cli.journalDir, { recursive: true });
  writeFileSync(journalFile(cli, generation), JSON.stringify({
    version: 3, kind: "supersede", task_id: SUPERSEDE_ID, generation,
    args: { reason: cli.supersedeReason, by: cli.supersedeBy },
    ...fields,
  }), "utf8");
}

test("indexSupersedeGenerations keys on payload.generation and reports every malformed history", () => {
  const ev = (generation, id = `e${generation}`) => ({ id, event_type: "TASK SUPERSEDED", payload: { generation } });
  const index = indexSupersedeGenerations([ev(3), { event_type: "AGENT STATUS", payload: { generation: 99 } }, ev(1), ev(2)]);
  assert.deepEqual(index.problems, []);
  assert.equal(index.latest, 3);
  assert.equal(index.byGeneration.get(2).id, "e2");
  assert.deepEqual(indexSupersedeGenerations([]), { byGeneration: new Map(), latest: 0, problems: [] });
  const problems = (events) => indexSupersedeGenerations(events).problems;
  assert.match(problems([ev(1), ev(1, "other")]).join(), /generation 1 appears on more than one event/);
  assert.match(problems([ev(1), ev(3)]).join(), /run to 3 but only 2/);
  assert.match(problems([ev(2)]).join(), /run to 2 but only 1/);
  for (const bad of ["2", null, undefined, 0, -1, 1.5, true, {}]) {
    assert.match(problems([ev(bad, "bad")]).join(), /event bad names no valid generation/, JSON.stringify(bad));
  }
  assert.match(problems([{ event_type: "TASK SUPERSEDED", payload: {} }]).join(), /\(no id\) names no valid generation/);
  assert.match(problems([{ event_type: "TASK SUPERSEDED" }]).join(), /names no valid generation/);
});

for (const [label, reasons] of [
  ["different reasons", ["reason one", "reason two", "reason three"]],
  ["identical reasons", ["same reason", "same reason", "same reason"]],
]) {
  test(`regression: events read back 1, 3, 2 with ${label}: repairing generation 2 uses generation 2's event`, async () => {
    const dir = supersedeDir();
    try {
      const cli = supersedeCli(dir, { supersedeReason: reasons[1] });
      const board = threeGenerationBoard(cli, reasons);
      seedJournal(cli, 2, { state: "board-superseded", event_id: "event-2" });
      const { calls, printed } = await withMcpStub(board.handlers, () => runSupersede(cli, tmpRegistry(dir)));
      assert.equal(supersedeCalls(calls).length, 0, "the verb must not run");
      const journal = journalOf(cli, 2);
      assert.equal(journal.state, "complete");
      assert.equal(journal.event_id, "event-2", "array slot 1 holds generation 3's event");
      assert.equal(journal.superseded_at, "2026-11-02T12:00:00.000Z", "dated from generation 2's event");
      const log = readFileSync(join(dir, "SESSION-LOG.md"), "utf8");
      assert.ok(log.includes("## Superseded — 2026-11-02"), log);
      assert.ok(!log.includes("2026-11-03"), "generation 3's date must not appear");
      assert.equal(occurrences(log, supersedeMarker(SUPERSEDE_ID, 2)), 1);
      assert.equal(occurrences(log, supersedeMarker(SUPERSEDE_ID, 3)), 0);
      assert.ok(printed.join("\n").includes("HISTORY_REPAIRED_CARD_CHANGED"), "generation 3 closed it, not this run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`regression: tied timestamps with ${label}: a lost response adopts the journaled generation`, async () => {
    const dir = supersedeDir();
    try {
      const cli = supersedeCli(dir, { supersedeReason: reasons[1] });
      const tie = "2026-11-02T12:00:00.000Z";
      const events = [3, 1, 2].map((g) => ({ ...supersededEvent(g, reasons[g - 1], cli.supersedeBy, tie) }));
      const board = stubBoard(cli, {
        events,
        row: { ...closedRow(cli), superseded_reason: reasons[2], superseded_closed_generation: 3, superseded_at: tie, completed_at: tie },
      });
      seedJournal(cli, 2, { state: "intent-written" });
      const { calls } = await withMcpStub(board.handlers, () => runSupersede(cli, tmpRegistry(dir)));
      assert.equal(supersedeCalls(calls).length, 0);
      assert.equal(journalOf(cli, 2).event_id, "event-2");
      assert.equal(occurrences(trackerText(dir), supersedeMarker(SUPERSEDE_ID, 2)), 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("regression: a replay of the live close finds its event by the closed generation in any order", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir, { supersedeReason: "reason three" });
    const board = threeGenerationBoard(cli);
    const { calls } = await withMcpStub(board.handlers, () => runSupersede(cli, tmpRegistry(dir)));
    assert.equal(supersedeCalls(calls).length, 0);
    assert.equal(journalOf(cli, 3).event_id, "event-3");
    assert.ok(trackerText(dir).includes("## Superseded — 2026-11-03"));
    assert.equal(occurrences(trackerText(dir), supersedeMarker(SUPERSEDE_ID, 3)), 1);
    // A reopened card's next generation is the highest number plus one, in any order.
    reopenCard(board);
    await assert.rejects(withMcpStub(board.handlers, () => runSupersede(cli, tmpRegistry(dir))), /REOPENED_CARD_NEEDS_GENERATION/);
    assert.equal(evaluateSupersede({ task: board.state.row, events: board.state.events, replacement: { id: REPLACEMENT_ID }, args: { reason: "x", by: REPLACEMENT_ID, generation: 4 }, registry: tmpRegistry(dir) }).generation, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: a malformed generation history holds every path before any journal or write", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    const registry = tmpRegistry(dir);
    const e = (generation, id) => ({ ...supersededEvent(generation, cli.supersedeReason, cli.supersedeBy, "2026-11-01T00:00:00Z"), id });
    const histories = {
      missing: [{ id: "x", event_type: "TASK SUPERSEDED", created_at: "2026-11-01T00:00:00Z", payload: { reason: cli.supersedeReason, superseded_by: cli.supersedeBy } }],
      string: [e("1", "x")],
      duplicate: [e(1, "x"), e(1, "y")],
      gap: [e(1, "x"), e(3, "y")],
    };
    for (const [label, events] of Object.entries(histories)) {
      for (const state of ["intent-written", "board-superseded", "complete"]) {
        seedJournal(cli, 1, { state, event_id: "x" });
        const before = readFileSync(journalFile(cli, 1), "utf8");
        const board = stubBoard(cli, { row: heldCard({ status: "Needs Operator" }), events });
        const { calls, printed } = await withMcpStub(board.handlers, () =>
          assert.rejects(runSupersede(cli, registry), /SUPERSEDE_HISTORY_INVALID/, `${label} ${state}`));
        assert.deepEqual(calls.map((c) => c.name), ["get_agent_task"], `${label} ${state}: nothing but the read`);
        assert.ok(printed.join("\n").includes('"problems"'), "the hold says what is wrong");
        assert.equal(readFileSync(journalFile(cli, 1), "utf8"), before, `${label} ${state}: journal untouched`);
        assert.equal(trackerText(dir), "# Tracker\n", `${label} ${state}`);
      }
    }
    const gated = evaluateSupersede({ task: heldCard(), events: histories.gap, replacement: { id: REPLACEMENT_ID }, args: { reason: "r", by: REPLACEMENT_ID }, registry });
    assert.deepEqual(gated.reasons, ["SUPERSEDE_HISTORY_INVALID"]);
    assert.equal(gated.generation, null, "no number is offered from a broken history");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: the card and its events must agree on which generation closed it", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    const registry = tmpRegistry(dir);
    const events = [supersededEvent(1, cli.supersedeReason, cli.supersedeBy, "2026-11-01T00:00:00Z")];
    const held = async (row, boardEvents, pattern) => {
      const board = stubBoard(cli, { row, events: boardEvents });
      const { calls, printed } = await withMcpStub(board.handlers, () =>
        assert.rejects(runSupersede(cli, registry), /SUPERSEDE_HISTORY_INVALID/));
      assert.deepEqual(calls.map((c) => c.name), ["get_agent_task"]);
      assert.match(printed.join("\n"), pattern);
    };
    await held({ ...closedRow(cli), superseded_closed_generation: 2 }, events, /says generation 2 closed it, but its events end at generation 1/);
    await held({ ...closedRow(cli), superseded_closed_generation: 1 }, [...events, supersededEvent(2, cli.supersedeReason, cli.supersedeBy, "2026-11-02T00:00:00Z")], /says generation 1 closed it, but its events end at generation 2/);
    await held({ ...closedRow(cli), superseded_closed_generation: 1 }, [], /says generation 1 closed it, but its events end at generation 0/);
    await held({ ...closedRow(cli), superseded_reason: "edited by hand" }, events, /reason or replacement differs/);
    await held({ ...closedRow(cli), superseded_by: null }, events, /reason or replacement differs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: a journal past its intent must name the very event it saw", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    const registry = tmpRegistry(dir);
    const board = () => stubBoard(cli, {
      row: closedRow(cli),
      events: [supersededEvent(1, cli.supersedeReason, cli.supersedeBy, "2026-11-01T00:00:00Z")],
    });
    seedJournal(cli, 1, { state: "complete", event_id: "not-event-1" });
    await assert.rejects(withMcpStub(board().handlers, () => runSupersede(cli, registry)), /completed, but the board's events do not back it \(event-mismatch/);
    seedJournal(cli, 1, { state: "complete", event_id: "event-1", args: { reason: "another", by: cli.supersedeBy } });
    await assert.rejects(withMcpStub(board().handlers, () => runSupersede(cli, registry)), /event-mismatch/);
    seedJournal(cli, 1, { state: "board-superseded", event_id: "not-event-1" });
    await assert.rejects(withMcpStub(board().handlers, () => runSupersede(cli, registry)), /event-mismatch/);
    assert.equal(trackerText(dir), "# Tracker\n");
    // The positive control: the same journal naming the right event finishes.
    seedJournal(cli, 1, { state: "board-superseded", event_id: "event-1" });
    await withMcpStub(board().handlers, () => runSupersede(cli, registry));
    assert.equal(journalOf(cli, 1).state, "complete");
    // A completed journal with no event id at all is not trusted either.
    seedJournal(cli, 1, { state: "complete" });
    await assert.rejects(withMcpStub(board().handlers, () => runSupersede(cli, registry)), /event-mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: a journal whose body disagrees with its file name is refused", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    const registry = tmpRegistry(dir);
    for (const fields of [{ generation: 2 }, { generation: "1" }, { task_id: REPLACEMENT_ID }]) {
      seedJournal(cli, 1, { state: "intent-written", ...fields });
      const board = stubBoard(cli);
      const { calls } = await withMcpStub(board.handlers, () =>
        assert.rejects(runSupersede(cli, registry), /does not describe generation 1/));
      assert.equal(supersedeCalls(calls).length, 0, JSON.stringify(fields));
    }
    rmSync(journalFile(cli, 1));
    writeFileSync(join(cli.journalDir, `${SUPERSEDE_ID}.supersede.g0.json`), JSON.stringify({ state: "intent-written", task_id: SUPERSEDE_ID, generation: 0, args: {} }), "utf8");
    await withMcpStub(stubBoard(cli).handlers, () =>
      assert.rejects(runSupersede(cli, registry), /does not describe generation 0/));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: a read-back lost after the verb resumes from the event, once", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    const registry = tmpRegistry(dir);
    const board = stubBoard(cli);
    const read = board.handlers.get_agent_task;
    let verbRan = false;
    const verb = board.handlers.supersede_agent_task;
    board.handlers.supersede_agent_task = (a) => { verbRan = true; return verb(a); };
    board.handlers.get_agent_task = (a) => {
      if (verbRan && a.task_id === SUPERSEDE_ID) throw new Error("MCP get_agent_task HTTP 503: read-back lost");
      return read(a);
    };
    await assert.rejects(withMcpStub(board.handlers, () => runSupersede(cli, registry)), /read-back lost/);
    assert.equal(journalOf(cli, 1).state, "intent-written", "no history from a close it could not see");
    assert.equal(trackerText(dir), "# Tracker\n");
    board.handlers.get_agent_task = read;
    const retry = await withMcpStub(board.handlers, () => runSupersede(cli, registry));
    assert.equal(supersedeCalls(retry.calls).length, 0);
    assert.equal(journalOf(cli, 1).event_id, "event-1");
    assert.equal(occurrences(trackerText(dir), supersedeMarker(SUPERSEDE_ID, 1)), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: the verb returning without its event, or with another writer's, writes no history", async () => {
  const dir = supersedeDir();
  try {
    const cli = supersedeCli(dir);
    const registry = tmpRegistry(dir);
    const noEvent = stubBoard(cli);
    noEvent.handlers.supersede_agent_task = () => ({ receipt: "TASK SUPERSEDED", task: noEvent.state.row });
    await assert.rejects(withMcpStub(noEvent.handlers, () => runSupersede(cli, registry)), /event is not readable/);
    assert.equal(trackerText(dir), "# Tracker\n");
    rmSync(cli.journalDir, { recursive: true, force: true });
    const otherArgs = stubBoard(cli);
    const verb = otherArgs.handlers.supersede_agent_task;
    otherArgs.handlers.supersede_agent_task = (a) => verb({ ...a, reason: "another writer's reason" });
    await assert.rejects(withMcpStub(otherArgs.handlers, () => runSupersede(cli, registry)), /event is not readable/);
    assert.equal(trackerText(dir), "# Tracker\n");
    rmSync(cli.journalDir, { recursive: true, force: true });
    const broken = stubBoard(cli);
    const brokenVerb = broken.handlers.supersede_agent_task;
    broken.handlers.supersede_agent_task = (a) => {
      const out = brokenVerb(a);
      broken.state.events = [...broken.state.events, supersededEvent(1, a.reason, a.superseded_by, "2026-11-01T00:00:00Z")];
      return out;
    };
    await assert.rejects(withMcpStub(broken.handlers, () => runSupersede(cli, registry)), /event is not readable/);
    assert.equal(trackerText(dir), "# Tracker\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: GAP C walks every containing checkout: nested repositories and submodules", () => {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "oe-gapc-ancestry-"));
  try {
    const run = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=oe@test", "-c", "user.name=oe-test", "-c", "protocol.file.allow=always", ...args], { stdio: "pipe" });
    const seedRepo = (path) => {
      mkdirSync(path, { recursive: true });
      run(path, "init", "-q");
      writeFileSync(join(path, "T.md"), "# T\n");
      run(path, "add", "-A");
      run(path, "commit", "-q", "-m", "seed");
    };
    const main = join(base, "main");
    const source = join(base, "module-source");
    seedRepo(main);
    seedRepo(source);
    run(main, "submodule", "add", "-q", source, "module");
    run(main, "commit", "-q", "-m", "add module");
    const linked = join(base, "plain-named-folder");
    run(main, "worktree", "add", "-q", "--detach", linked);
    run(linked, "submodule", "update", "--init", "-q");
    assert.ok(existsSync(join(linked, "module", "T.md")), "fixture: the submodule really is initialized in the linked worktree");
    assert.ok(statSync(join(linked, "module", ".git")).isFile(), "fixture: a real submodule has a .git file");
    assert.ok(statSync(join(linked, ".git")).isFile(), "fixture: a real linked worktree has a .git file");

    const mainSafe = join(main, "T.md");
    const reasonsFor = (tracker) => evaluateSupersede({
      task: heldCard(),
      events: [],
      replacement: { id: REPLACEMENT_ID },
      args: { reason: "r", by: REPLACEMENT_ID },
      registry: { "tmp-proj": { tracker_path: tracker, session_log_path: mainSafe } },
    }).reasons;
    const refused = ["APPEND_TARGET_IN_WORKTREE"];

    // The controls: the same shapes inside the main checkout are durable.
    assert.deepEqual(reasonsFor(mainSafe), [], "main checkout");
    assert.deepEqual(reasonsFor(join(main, "module", "T.md")), [], "initialized submodule in main");
    seedRepo(join(main, "nested"));
    assert.deepEqual(reasonsFor(join(main, "nested", "T.md")), [], "nested repository in main");

    // The defect.
    seedRepo(join(linked, "nested"));
    assert.deepEqual(reasonsFor(join(linked, "T.md")), refused, "the linked worktree itself");
    assert.deepEqual(reasonsFor(join(linked, "nested", "T.md")), refused, "nested repository in a linked worktree");
    assert.deepEqual(reasonsFor(join(linked, "module", "T.md")), refused, "initialized submodule in a linked worktree");
    seedRepo(join(linked, "nested", "deeper"));
    assert.deepEqual(reasonsFor(join(linked, "nested", "deeper", "T.md")), refused, "two nested repositories deep");
    seedRepo(join(linked, "module", "inner"));
    assert.deepEqual(reasonsFor(join(linked, "module", "inner", "T.md")), refused, "a repository inside the submodule inside the worktree");

    // A linked worktree of the submodule itself, even though it sits under main.
    const moduleLinked = join(main, "module-linked");
    run(join(main, "module"), "worktree", "add", "-q", "--detach", moduleLinked);
    assert.deepEqual(reasonsFor(join(moduleLinked, "T.md")), refused, "a linked worktree under main is still a linked worktree");

    // Symlinks resolve to where the file really is, in both directions.
    const links = join(base, "links");
    mkdirSync(links);
    symlinkSync(join(linked, "module", "T.md"), join(links, "to-module.md"));
    symlinkSync(join(linked, "nested"), join(links, "to-nested"));
    symlinkSync(join(main, "module", "T.md"), join(links, "to-main-module.md"));
    symlinkSync(mainSafe, join(linked, "nested", "to-main.md"));
    assert.deepEqual(reasonsFor(join(links, "to-module.md")), refused, "symlink to a linked worktree's submodule");
    assert.deepEqual(reasonsFor(join(links, "to-nested", "T.md")), refused, "symlinked nested directory");
    assert.deepEqual(reasonsFor(join(links, "to-main-module.md")), [], "symlink into main's submodule");
    assert.deepEqual(reasonsFor(join(linked, "nested", "to-main.md")), [], "symlink out of a worktree into main is main");

    // Relative paths resolve from the working directory.
    assert.deepEqual(reasonsFor(relative(process.cwd(), join(linked, "module", "T.md"))), refused, "relative submodule path");
    assert.deepEqual(reasonsFor(relative(process.cwd(), join(linked, "nested", "T.md"))), refused, "relative nested path");
    assert.deepEqual(reasonsFor(relative(process.cwd(), join(main, "module", "T.md"))), [], "relative main submodule path");

    // A genuinely pruned worktree: moved away, then pruned by git, a nested repository inside.
    const moved = join(base, "moved-away");
    const prunable = join(base, "prunable");
    run(main, "worktree", "add", "-q", "--detach", prunable);
    seedRepo(join(prunable, "nested"));
    renameSync(prunable, moved);
    run(main, "worktree", "prune", "--expire", "now");
    assert.equal(run(main, "worktree", "list").toString().includes("prunable"), false, "fixture: git forgot it");
    assert.deepEqual(reasonsFor(join(moved, "T.md")), refused, "pruned worktree");
    assert.deepEqual(reasonsFor(join(moved, "nested", "T.md")), refused, "nested repository in a pruned worktree");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- PR 19 third amendment: every form of .git, the bare-tool audit, the repair ---

test("regression: GAP C inspects .git in every form: directory-form metadata, symlinks and dangling entries", () => {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "oe-gapc-forms-"));
  try {
    const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=oe@test", "-c", "user.name=oe-test", ...args], { encoding: "utf8", stdio: "pipe" }).trim();
    const seed = (path) => {
      mkdirSync(path, { recursive: true });
      git(path, "init", "-q");
      writeFileSync(join(path, "T.md"), "# T\n");
      git(path, "add", "-A");
      git(path, "commit", "-q", "-m", "seed");
    };
    const main = join(base, "main");
    seed(main);
    const safe = join(main, "T.md");
    const reasonsFor = (path) => evaluateSupersede({
      task: heldCard(),
      events: [],
      replacement: { id: REPLACEMENT_ID },
      args: { reason: "r", by: REPLACEMENT_ID },
      registry: { "tmp-proj": { tracker_path: path, session_log_path: safe } },
    }).reasons;
    const refused = ["APPEND_TARGET_IN_WORKTREE"];
    const linked = (name) => {
      const wt = join(base, name);
      git(main, "worktree", "add", "-q", "--detach", wt);
      const metadata = readFileSync(join(wt, ".git"), "utf8").trim().replace("gitdir: ", "");
      return { wt, metadata, file: join(wt, "T.md") };
    };

    // The finding as reviewed: git still resolves the linked worktree through the link.
    const direct = linked("direct");
    unlinkSync(join(direct.wt, ".git"));
    symlinkSync(direct.metadata, join(direct.wt, ".git"), "dir");
    assert.equal(git(direct.wt, "rev-parse", "--absolute-git-dir"), direct.metadata, "fixture: git resolves the same metadata");
    assert.equal(git(direct.wt, "rev-parse", "--path-format=absolute", "--git-common-dir"), join(main, ".git"), "fixture: and the main repository's common dir");
    assert.deepEqual(reasonsFor(direct.file), refused, "absolute .git symlink to the metadata");
    assert.deepEqual(reasonsFor(relative(process.cwd(), direct.file)), refused, "and through a relative destination");
    assert.deepEqual(reasonsFor(safe), [], "the same repository's main checkout still passes");

    const rel = linked("relative-link");
    unlinkSync(join(rel.wt, ".git"));
    symlinkSync(relative(rel.wt, rel.metadata), join(rel.wt, ".git"), "dir");
    assert.deepEqual(reasonsFor(rel.file), refused, "relative .git symlink");

    const chained = linked("chained");
    unlinkSync(join(chained.wt, ".git"));
    symlinkSync(chained.metadata, join(base, "chain"), "dir");
    symlinkSync(join(base, "chain"), join(chained.wt, ".git"), "dir");
    assert.deepEqual(reasonsFor(chained.file), refused, "a chain of symlinks");

    const nested = linked("nested-under-link");
    unlinkSync(join(nested.wt, ".git"));
    symlinkSync(nested.metadata, join(nested.wt, ".git"), "dir");
    seed(join(nested.wt, "inner"));
    assert.deepEqual(reasonsFor(join(nested.wt, "inner", "T.md")), refused, "a repository nested inside it");

    const fileLink = linked("gitfile-link");
    copyFileSync(join(fileLink.wt, ".git"), join(base, "gitfile-copy"));
    unlinkSync(join(fileLink.wt, ".git"));
    symlinkSync(join(base, "gitfile-copy"), join(fileLink.wt, ".git"), "file");
    assert.deepEqual(reasonsFor(fileLink.file), refused, "a .git symlink to a gitfile");

    const toLink = linked("gitfile-to-link");
    symlinkSync(toLink.metadata, join(base, "metadata-link"), "dir");
    writeFileSync(join(toLink.wt, ".git"), `gitdir: ${join(base, "metadata-link")}\n`);
    assert.deepEqual(reasonsFor(toLink.file), refused, "a gitfile naming a symlink to the metadata");

    const copied = linked("copied-metadata");
    unlinkSync(join(copied.wt, ".git"));
    cpSync(copied.metadata, join(copied.wt, ".git"), { recursive: true });
    assert.deepEqual(reasonsFor(copied.file), refused, "a real .git directory holding commondir");

    // A second working tree over another checkout's repository, either form.
    for (const [name, make] of [
      ["symlink", (dir) => symlinkSync(join(main, ".git"), join(dir, ".git"), "dir")],
      ["file", (dir) => writeFileSync(join(dir, ".git"), `gitdir: ${join(main, ".git")}\n`)],
    ]) {
      const dir = join(base, `second-${name}`);
      mkdirSync(dir);
      writeFileSync(join(dir, "T.md"), "# T\n");
      make(dir);
      assert.equal(git(dir, "rev-parse", "--absolute-git-dir"), join(main, ".git"), `fixture: git uses main's repository (${name})`);
      assert.deepEqual(reasonsFor(join(dir, "T.md")), refused, `a ${name} pointing at another checkout's .git`);
    }

    // Dangling metadata: nothing here is readable, so it fails closed, never skipped.
    const dangling = linked("dangling");
    unlinkSync(join(dangling.wt, ".git"));
    symlinkSync(join(base, "gone"), join(dangling.wt, ".git"), "dir");
    assert.deepEqual(reasonsFor(dangling.file), refused, "dangling .git symlink");

    const looped = linked("looped");
    unlinkSync(join(looped.wt, ".git"));
    symlinkSync(join(looped.wt, ".git"), join(looped.wt, ".git"));
    assert.deepEqual(reasonsFor(looped.file), refused, "a .git symlink to itself");

    // A dangling link inside a repository that also encloses it: the parent's .git must
    // not rescue it, and a link above a clean repository still counts.
    const danglingUnder = join(main, "dangling-child");
    mkdirSync(danglingUnder);
    writeFileSync(join(danglingUnder, "T.md"), "# T\n");
    symlinkSync(join(base, "gone"), join(danglingUnder, ".git"), "dir");
    assert.deepEqual(reasonsFor(join(danglingUnder, "T.md")), refused, "dangling .git inside main is still dangling");

    const removed = linked("metadata-removed");
    unlinkSync(join(removed.wt, ".git"));
    symlinkSync(removed.metadata, join(removed.wt, ".git"), "dir");
    rmSync(removed.metadata, { recursive: true, force: true });
    assert.deepEqual(reasonsFor(removed.file), refused, "the metadata removed behind the link");

    const noCommondir = linked("commondir-removed");
    unlinkSync(join(noCommondir.wt, ".git"));
    symlinkSync(noCommondir.metadata, join(noCommondir.wt, ".git"), "dir");
    rmSync(join(noCommondir.metadata, "commondir"));
    assert.deepEqual(reasonsFor(noCommondir.file), refused, "linked metadata that lost commondir is not a repository");

    const danglingCommondir = join(base, "dangling-commondir");
    mkdirSync(join(danglingCommondir, "meta", "objects"), { recursive: true });
    mkdirSync(join(danglingCommondir, "meta", "refs"));
    writeFileSync(join(danglingCommondir, "meta", "HEAD"), "ref: refs/heads/main\n");
    symlinkSync(join(base, "gone"), join(danglingCommondir, "meta", "commondir"));
    writeFileSync(join(danglingCommondir, ".git"), `gitdir: ${join(danglingCommondir, "meta")}\n`);
    writeFileSync(join(danglingCommondir, "T.md"), "# T\n");
    assert.deepEqual(reasonsFor(join(danglingCommondir, "T.md")), refused, "commondir that is itself a dangling symlink");

    for (const [name, build] of [
      ["empty .git directory", (dir) => mkdirSync(join(dir, ".git"))],
      ["gitfile naming a non-git directory", (dir) => { mkdirSync(join(dir, "empty")); writeFileSync(join(dir, ".git"), `gitdir: ${join(dir, "empty")}\n`); }],
      ["gitfile naming a regular file", (dir) => { writeFileSync(join(dir, "plain"), "x\n"); writeFileSync(join(dir, ".git"), `gitdir: ${join(dir, "plain")}\n`); }],
      ["gitfile whose first line is not gitdir", (dir) => { execFileSync("git", ["init", "-q", "--bare", join(dir, "own.git")], { stdio: "pipe" }); writeFileSync(join(dir, ".git"), `noise\ngitdir: ${join(dir, "own.git")}\n`); }],
      ["a .git that is neither file nor directory", (dir) => execFileSync("mkfifo", [join(dir, ".git")], { stdio: "pipe" })],
      ["a gitdir missing HEAD", (dir) => { mkdirSync(join(dir, "m", "objects"), { recursive: true }); mkdirSync(join(dir, "m", "refs")); writeFileSync(join(dir, ".git"), `gitdir: ${join(dir, "m")}\n`); }],
      ["a gitdir missing objects", (dir) => { mkdirSync(join(dir, "m", "refs"), { recursive: true }); writeFileSync(join(dir, "m", "HEAD"), "x\n"); writeFileSync(join(dir, ".git"), `gitdir: ${join(dir, "m")}\n`); }],
      ["a gitdir missing refs", (dir) => { mkdirSync(join(dir, "m", "objects"), { recursive: true }); writeFileSync(join(dir, "m", "HEAD"), "x\n"); writeFileSync(join(dir, ".git"), `gitdir: ${join(dir, "m")}\n`); }],
    ]) {
      const dir = join(base, `odd-${name.replace(/\W+/g, "-")}`);
      mkdirSync(dir);
      writeFileSync(join(dir, "T.md"), "# T\n");
      build(dir);
      assert.deepEqual(reasonsFor(join(dir, "T.md")), refused, `${name} fails closed`);
    }

    // The controls these rules must not break.
    const separate = join(base, "separate");
    mkdirSync(separate);
    git(separate, "init", "-q", `--separate-git-dir=${join(base, "separate.git")}`);
    writeFileSync(join(separate, "T.md"), "# T\n");
    assert.deepEqual(reasonsFor(join(separate, "T.md")), [], "a separate-git-dir repository");
    const relocated = join(base, "relocated");
    seed(relocated);
    renameSync(join(relocated, ".git"), join(base, "relocated-meta.git"));
    symlinkSync(join(base, "relocated-meta.git"), join(relocated, ".git"), "dir");
    assert.equal(git(relocated, "rev-parse", "--absolute-git-dir"), join(base, "relocated-meta.git"), "fixture");
    assert.deepEqual(reasonsFor(join(relocated, "T.md")), [], "a .git symlink to its own relocated repository");
    const relGitfile = join(base, "relative-gitfile");
    mkdirSync(relGitfile);
    git(relGitfile, "init", "-q", `--separate-git-dir=${join(base, "relative-gitfile.git")}`);
    writeFileSync(join(relGitfile, ".git"), "gitdir: ../relative-gitfile.git\n");
    writeFileSync(join(relGitfile, "T.md"), "# T\n");
    assert.deepEqual(reasonsFor(join(relGitfile, "T.md")), [], "a relative gitfile resolves from its own directory");
    seed(join(main, "nested-ok"));
    assert.deepEqual(reasonsFor(join(main, "nested-ok", "T.md")), [], "a nested repository in main");
    const noRepo = join(base, "no-repo");
    mkdirSync(noRepo);
    writeFileSync(join(noRepo, "T.md"), "# T\n");
    assert.deepEqual(reasonsFor(join(noRepo, "T.md")), [], "no repository at all");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// A card closed twice by the bare tool, reopened since, with no journal and no history.
function bareClosedBoard(cli, overrides = {}) {
  const events = overrides.events || [
    supersededEvent(2, "second reason", null, "2026-11-02T12:00:00.000Z"),
    supersededEvent(1, "first reason", REPLACEMENT_ID, "2026-11-01T12:00:00.000Z"),
  ];
  const board = stubBoard(cli, {
    events,
    row: overrides.row || heldCard({ status: "Needs Operator", superseded_at: "2026-11-02T12:00:00.000Z", superseded_reason: "second reason" }),
  });
  board.handlers.list_supersede_events = () => ({ count: events.length, total: events.length, limit: 500, events: events.map((e) => ({ id: e.id, task_id: SUPERSEDE_ID, created_at: e.created_at })) });
  board.handlers.list_agent_tasks = () => ({ count: 0, tasks: [] });
  return board;
}

const repairCli = (dir, generation, overrides = {}) => ({
  repairSupersedeTaskId: SUPERSEDE_ID,
  supersedeGeneration: generation,
  journalDir: join(dir, "journals"),
  liveCheck: false,
  ...overrides,
});
const historyOf = (dir) => ({
  tracker: readFileSync(join(dir, "PROJECT-TRACKER.md"), "utf8"),
  log: readFileSync(join(dir, "SESSION-LOG.md"), "utf8"),
});
const captureCalls = (calls) => calls.filter((c) => c.name === "capture_thought");
const repairFile = (dir, generation) => join(dir, "journals", `${SUPERSEDE_ID}.supersede.g${generation}.json`);

test("supersede history audit: each generation is compared, in both files, by its own marker", () => {
  const dir = supersedeDir();
  try {
    const registry = tmpRegistry(dir);
    const packet = { task: heldCard({ status: "Needs Operator" }), events: [
      supersededEvent(3, "c", null, "2026-11-03T00:00:00.000Z"),
      supersededEvent(1, "a", null, "2026-11-01T00:00:00.000Z"),
      supersededEvent(2, "b", null, "2026-11-02T00:00:00.000Z"),
    ] };
    const audit = () => evaluateSupersedeHistoryAudit([packet], registry);
    assert.deepEqual(audit().unrecorded.map((r) => [r.generation, r.severity, r.missing]), [
      [1, "SUPERSEDE_NO_HISTORY", ["tracker", "session_log"]],
      [2, "SUPERSEDE_NO_HISTORY", ["tracker", "session_log"]],
      [3, "SUPERSEDE_NO_HISTORY", ["tracker", "session_log"]],
    ]);
    assert.match(audit().unrecorded[1].repair, new RegExp(`--repair-supersede ${SUPERSEDE_ID} --generation 2$`));
    assert.equal(audit().unrecorded[1].event_id, "event-2", "the row names that generation's event, whatever the array order");

    // Generation 1 fully recorded, 2 only in the tracker, 3 only in the log.
    writeFileSync(join(dir, "PROJECT-TRACKER.md"), `${supersedeMarker(SUPERSEDE_ID, 1)}\n${supersedeMarker(SUPERSEDE_ID, 2)}\n`);
    writeFileSync(join(dir, "SESSION-LOG.md"), `${supersedeMarker(SUPERSEDE_ID, 1)}\n${supersedeMarker(SUPERSEDE_ID, 3)}\n`);
    assert.deepEqual(audit().recorded.map((r) => r.generation), [1]);
    assert.deepEqual(audit().unrecorded.map((r) => [r.generation, r.severity, r.missing]), [
      [2, "SUPERSEDE_PARTIAL_HISTORY", ["session_log"]],
      [3, "SUPERSEDE_PARTIAL_HISTORY", ["tracker"]],
    ]);

    // The bare card id is not the marker: a hand note naming the card does not count,
    // and neither does another card's or another generation's marker.
    writeFileSync(join(dir, "PROJECT-TRACKER.md"), `${SUPERSEDE_ID} ${supersedeMarker(REPLACEMENT_ID, 1)} ${supersedeMarker(SUPERSEDE_ID, 9)}\n`);
    writeFileSync(join(dir, "SESSION-LOG.md"), `${SUPERSEDE_ID}\n`);
    assert.equal(audit().recorded.length, 0);

    // A marker moved to an archive file is still a record.
    writeFileSync(join(dir, "PROJECT-TRACKER-ARCHIVE.md"), supersedeMarker(SUPERSEDE_ID, 1));
    writeFileSync(join(dir, "SESSION-LOG-ARCHIVE.md"), supersedeMarker(SUPERSEDE_ID, 1));
    assert.deepEqual(audit().recorded.map((r) => r.generation), [1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supersede history audit: no route and a broken history are reported, never dropped", () => {
  const dir = supersedeDir();
  try {
    const registry = tmpRegistry(dir);
    const events = [supersededEvent(1, "a", null, "2026-11-01T00:00:00.000Z")];
    const unrecorded = (task, ev = events) => evaluateSupersedeHistoryAudit([{ task, events: ev }], registry).unrecorded;
    assert.deepEqual(unrecorded(heldCard({ project_slug: null })).map((r) => [r.severity, r.reason, r.generation]), [["SUPERSEDE_NO_ROUTE", "MISSING_PROJECT_SLUG", 1]]);
    assert.deepEqual(unrecorded(heldCard({ project_slug: "nope" })).map((r) => [r.severity, r.reason]), [["SUPERSEDE_NO_ROUTE", "UNKNOWN_PROJECT_ROUTE"]]);
    const broken = unrecorded(heldCard(), [{ ...events[0], payload: { generation: "1" } }]);
    assert.equal(broken[0].severity, "SUPERSEDE_HISTORY_INVALID");
    assert.match(broken[0].problems.join(), /names no valid generation/);
    assert.equal(broken[0].repair, undefined, "a broken history has no mechanical repair");
    // A card closed by a generation its events do not back is the same class.
    const disagree = unrecorded(heldCard({ status: "Agent Done", superseded_closed_generation: 2 }));
    assert.equal(disagree[0].severity, "SUPERSEDE_HISTORY_INVALID");
    assert.deepEqual(evaluateSupersedeHistoryAudit([{ task: heldCard(), events: [{ event_type: "AGENT STATUS", payload: {} }] }], registry), { unrecorded: [], recorded: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: --audit-unrecorded finds a bare close that was reopened, on a card no status list returns", async () => {
  const dir = supersedeDir();
  try {
    const registry = tmpRegistry(dir);
    const board = bareClosedBoard(supersedeCli(dir));
    const run = await withMcpStub(board.handlers, () => runUnrecordedAudit({ lookbackDays: 7 }, registry));
    const result = JSON.parse(run.printed.join("\n"));
    assert.equal(result.unrecorded_count, 2);
    assert.deepEqual(result.unrecorded.map((r) => [r.short_id, r.generation, r.severity]), [
      [SUPERSEDE_ID.slice(0, 8), 1, "SUPERSEDE_NO_HISTORY"],
      [SUPERSEDE_ID.slice(0, 8), 2, "SUPERSEDE_NO_HISTORY"],
    ]);
    assert.deepEqual(result.scan_truncated, []);
    assert.equal(result.supersede_scan.events_read, 2);
    assert.equal(result.supersede_scan.error, null);
    assert.equal(run.calls.filter((c) => c.name === "get_agent_task" && c.args.task_id === SUPERSEDE_ID).length, 1, "one read per card");
    assert.deepEqual(run.calls.filter((c) => !["get_agent_task", "list_agent_tasks", "list_supersede_events"].includes(c.name)), [], "the audit is read-only");
    assert.equal(historyOf(dir).tracker, "# Tracker\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: a failed or cut-short supersede scan is named in scan_truncated, and the apply audit survives it", async () => {
  const dir = supersedeDir();
  try {
    const registry = tmpRegistry(dir);
    const applied = { id: "cccccccc-3333-4333-8333-333333333333", status: "Agent Done", project_slug: "tmp-proj", updated_at: new Date().toISOString() };
    const handlers = (list) => ({
      list_agent_tasks: ({ statuses }) => ({ tasks: statuses[0] === "Agent Done" ? [applied] : [] }),
      // Carries every id the listing below names, so what these cases measure is the ceiling.
      get_agent_task: () => ({ task: applied, events: [
        { event_type: "AGENT APPLIED", created_at: applied.updated_at, payload: { applied_by: "x" } },
        ...Array.from({ length: 500 }, (_, i) => ({ id: `e${i}`, event_type: "AGENT STATUS", created_at: applied.updated_at, payload: {} })),
      ] }),
      list_supersede_events: list,
    });
    const run = async (list) => JSON.parse((await withMcpStub(handlers(list), () => runUnrecordedAudit({ lookbackDays: 7 }, registry))).printed.join("\n"));

    const failed = await run(() => { throw new Error("tool not deployed"); });
    assert.equal(failed.unrecorded_count, 1, "the apply audit's finding is not lost");
    assert.equal(failed.scan_truncated.length, 1);
    assert.match(failed.scan_truncated[0], /TASK SUPERSEDED events \(scan failed: .*tool not deployed/);
    assert.match(failed.supersede_scan.error, /tool not deployed/);

    const shapeless = await run(() => ({ nope: true }));
    assert.match(shapeless.scan_truncated[0], /scan failed: list_supersede_events returned no events array/);

    const page = (length) => Array.from({ length }, (_, i) => ({ id: `e${i}`, task_id: applied.id }));
    const short = await run(() => ({ total: 499, events: page(499) }));
    assert.deepEqual(short.scan_truncated, [], "under the limit is complete");
    assert.equal(short.supersede_scan.coverage_complete, true);
    const full = await run(() => ({ total: 500, events: page(500) }));
    assert.deepEqual(full.scan_truncated, ["TASK SUPERSEDED events"], "at the limit it may be cut short, even when the total agrees");
    assert.equal(full.supersede_scan.coverage_complete, false);

    // A server-side cap below the ceiling: the page looks short and complete, the total says otherwise.
    const capped = await run(() => ({ total: 900, events: page(100) }));
    assert.deepEqual(capped.scan_truncated, ["TASK SUPERSEDED events"], "a total above the page is cut short");
    assert.equal(capped.supersede_scan.total_events, 900);
    assert.equal(capped.supersede_scan.coverage_complete, false);
    const untold = await run(() => ({ events: page(100) }));
    assert.deepEqual(untold.scan_truncated, ["TASK SUPERSEDED events"], "no total is no proof");
    assert.equal(untold.supersede_scan.coverage_complete, false);

    assert.equal(failed.supersede_scan.coverage_complete, false, "a failed scan is not complete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: a listed supersede event missing from its card's packet is never a clean audit", async () => {
  const dir = supersedeDir();
  try {
    const registry = tmpRegistry(dir);
    const board = bareClosedBoard(supersedeCli(dir));
    const audit = async (packet) => {
      const handlers = { ...board.handlers, get_agent_task: packet };
      return JSON.parse((await withMcpStub(handlers, () => runUnrecordedAudit({ lookbackDays: 7 }, registry))).printed.join("\n"));
    };
    const [newest, oldest] = board.state.events;

    const complete = await audit(() => ({ task: board.state.row, events: board.state.events }));
    assert.equal(complete.supersede_scan.coverage_complete, true, "the control is complete");
    assert.equal(complete.supersede_scan.cards_with_missing_history, 0);
    assert.deepEqual(complete.scan_truncated, []);
    assert.deepEqual(complete.unrecorded.map((r) => r.severity), ["SUPERSEDE_NO_HISTORY", "SUPERSEDE_NO_HISTORY"]);

    // Oldest first and capped: the newest event is the one that goes.
    const capped = await audit(() => ({ task: board.state.row, events: [oldest] }));
    assert.equal(capped.supersede_scan.error, null, "a null error, which is exactly why it cannot be the test");
    assert.equal(capped.supersede_scan.coverage_complete, false);
    assert.equal(capped.supersede_scan.cards_with_missing_history, 1);
    assert.deepEqual(capped.scan_truncated, ["TASK SUPERSEDED events (1 listed event(s) absent from fetched history on 1 card(s))"]);
    const gap = capped.unrecorded.find((r) => r.severity === "SUPERSEDE_COVERAGE_INCOMPLETE");
    assert.equal(gap.task_id, SUPERSEDE_ID);
    assert.deepEqual(gap.missing_event_ids, [newest.id]);
    assert.equal(gap.listed_events, 2);
    assert.equal(gap.fetched_events, 1);
    assert.deepEqual(capped.unrecorded.filter((r) => r.generation).map((r) => r.generation), [1], "what was fetched is still compared");

    // Not one supersede event in the packet at all: the shape the review reproduced.
    const none = await audit(() => ({ task: board.state.row, events: [{ id: "older", event_type: "AGENT STATUS", payload: {} }] }));
    assert.equal(none.unrecorded_count, 1);
    assert.deepEqual(none.unrecorded[0].missing_event_ids, [newest.id, oldest.id]);
    assert.equal(none.supersede_scan.coverage_complete, false);

    for (const [label, packet] of Object.entries({
      "no events array": () => ({ task: board.state.row }),
      "another card's packet": () => ({ task: { ...board.state.row, id: REPLACEMENT_ID }, events: board.state.events }),
      "no task": () => ({ events: board.state.events }),
    })) {
      const short = await audit(packet);
      assert.equal(short.supersede_scan.coverage_complete, false, label);
      const row = short.unrecorded.find((r) => r.severity === "SUPERSEDE_COVERAGE_INCOMPLETE");
      assert.equal(row.missing_event_ids.length, 2, label);
      assert.equal(short.unrecorded.filter((r) => r.generation).length, 0, `${label}: it is not compared as this card`);
    }
    assert.equal(board.state.events.length, 2, "the audit is read-only");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract, source text only: list_supersede_events asks PostgREST for an exact count and returns it as total", () => {
  // No real PostgREST here. This pins that the wrapper asks; a rollout check must prove it answers.
  const source = readFileSync(join(HERE, "..", "..", "supabase", "functions", "open-brain-mcp", "index.ts"), "utf8");
  const start = source.indexOf('"list_supersede_events",');
  const block = source.slice(start, source.indexOf("server.registerTool(", start));
  assert.match(block, /const \{ data, error, count \} = await supabase/);
  assert.match(block, /\.select\("id, task_id, created_at", \{ count: "exact" \}\)/);
  assert.match(block, /total: count \?\? null,/);
});

test("reconcileSupersedeInventory: a listed row with no id cannot match and is not dropped", () => {
  const task = { id: SUPERSEDE_ID, project_slug: "tmp-proj", status: "Agent Done" };
  const { packets, gaps } = reconcileSupersedeInventory(
    [{ id: "known", task_id: SUPERSEDE_ID }, { task_id: SUPERSEDE_ID }, { id: "elsewhere", task_id: REPLACEMENT_ID }],
    [{ task_id: SUPERSEDE_ID, packet: { task, events: [{ id: "known" }, { id: undefined }] } }],
  );
  assert.equal(packets.length, 1);
  assert.deepEqual(gaps.map((g) => g.missing_event_ids), [[null]]);
  assert.equal(gaps[0].listed_events, 2, "only this card's listed rows");
});

// A card the bare tool closed: its generation exists, nothing has been written for it.
function closedGenerationBoard(cli, overrides = {}) {
  const at = "2026-11-06T12:00:01.000Z";
  return stubBoard(cli, {
    row: { ...closedRow(cli), completed_at: at, superseded_at: at, superseded_reason: cli.supersedeReason, superseded_by: REPLACEMENT_ID, superseded_closed_generation: 1 },
    events: [supersededEvent(1, cli.supersedeReason, REPLACEMENT_ID, at)],
    ...overrides,
  });
}

const leaseFiles = (cli) => (existsSync(cli.journalDir) ? readdirSync(cli.journalDir).filter((n) => n.includes(".lease.")) : []);
const leasePath = (cli, token) => join(cli.journalDir, `${SUPERSEDE_ID}.supersede.lease.${token}.json`);
function plantLease(cli, token, claim) {
  mkdirSync(cli.journalDir, { recursive: true });
  writeFileSync(leasePath(cli, token), typeof claim === "string" ? claim : JSON.stringify({ version: 1, task_id: SUPERSEDE_ID, token, mode: "supersede", claimed_at: "2026-11-06T00:00:00.000Z", ...claim }));
}
// In the controller's pinned form: a claim records its start time with LC_ALL=C and TZ=UTC.
const ownStart = () => execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim();
const deadPid = () => Number(execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).trim());

function holdFirstCapture(overrideReply = "Captured as observation") {
  let entered;
  let release;
  const seen = new Promise((r) => { entered = r; });
  const gate = new Promise((r) => { release = r; });
  const contents = [];
  return {
    seen,
    release,
    contents,
    capture: async ({ content }) => {
      contents.push(content);
      if (contents.length === 1) {
        entered();
        await gate;
      }
      return overrideReply;
    },
  };
}

for (const [label, first, second] of [
  ["ordinary closeout, then repair", "ordinary", "repair"],
  ["repair, then ordinary closeout", "repair", "ordinary"],
  ["repair, then repair", "repair", "repair"],
  ["ordinary closeout, then ordinary closeout", "ordinary", "ordinary"],
]) {
  test(`regression: overlap on one generation sends one capture and the second writes nothing: ${label}`, async () => {
    const dir = supersedeDir();
    try {
      const registry = tmpRegistry(dir);
      const cli = supersedeCli(dir);
      const held = holdFirstCapture();
      const board = closedGenerationBoard(cli, { capture: held.capture });
      const before = JSON.stringify(board.state);
      const go = (kind) => (kind === "repair" ? runSupersedeRepair(repairCli(dir, 1), registry) : runSupersede(supersedeCli(dir), registry));
      const run = await withMcpStub(board.handlers, async () => {
        const a = go(first);
        await held.seen;
        const journalAtOverlap = readFileSync(repairFile(dir, 1), "utf8");
        const trackerAtOverlap = historyOf(dir).tracker;
        assert.equal(leaseFiles(cli).length, 1, "the first command holds it");
        await assert.rejects(go(second), /SUPERSEDE_HISTORY_BUSY/);
        assert.equal(readFileSync(repairFile(dir, 1), "utf8"), journalAtOverlap, "the second did not touch the journal");
        assert.equal(historyOf(dir).tracker, trackerAtOverlap, "or the history");
        assert.equal(leaseFiles(cli).length, 1, "it withdrew its own claim and left the holder's");
        held.release();
        await a;
      });
      assert.equal(captureCalls(run.calls).length, 1, "one capture");
      assert.equal(supersedeCalls(run.calls).length, 0, "and no verb: the generation already landed");
      assert.equal(JSON.stringify(board.state), before, "the card did not move");
      const { tracker, log } = historyOf(dir);
      assert.equal(occurrences(tracker, supersedeMarker(SUPERSEDE_ID, 1)), 1);
      assert.equal(occurrences(log, supersedeMarker(SUPERSEDE_ID, 1)), 1);
      assert.equal(JSON.parse(readFileSync(repairFile(dir, 1), "utf8")).state, "complete");
      assert.deepEqual(leaseFiles(cli), [], "released");
      const printedHold = run.printed.find((line) => line.includes("SUPERSEDE_HISTORY_BUSY"));
      assert.match(printedHold, /holders/);
      assert.ok(!printedHold.includes('"status": "PARTIAL"'));

      const replay = await withMcpStub(board.handlers, () => runSupersedeRepair(repairCli(dir, 1), registry));
      assert.equal(captureCalls(replay.calls).length, 0, "a later sequential run sends nothing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("regression: an overlapping close of a new generation reaches the verb once", async () => {
  const dir = supersedeDir();
  try {
    const registry = tmpRegistry(dir);
    const cli = supersedeCli(dir);
    const held = holdFirstCapture();
    const board = stubBoard(cli, { capture: held.capture });
    const run = await withMcpStub(board.handlers, async () => {
      const a = runSupersede(cli, registry);
      await held.seen;
      await assert.rejects(runSupersede(cli, registry), /SUPERSEDE_HISTORY_BUSY/);
      held.release();
      await a;
    });
    assert.equal(supersedeCalls(run.calls).length, 1);
    assert.equal(captureCalls(run.calls).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the claim covers the first read: a hold at the very start leaves no read, no write and no directory change", async () => {
  const dir = supersedeDir();
  try {
    const registry = tmpRegistry(dir);
    const cli = supersedeCli(dir);
    const board = closedGenerationBoard(cli);
    plantLease(cli, "11111111-1111-4111-8111-111111111111", { pid: process.pid, host: hostname(), process_started: ownStart() });
    for (const go of [() => runSupersede(cli, registry), () => runSupersedeRepair(repairCli(dir, 1), registry)]) {
      const run = await withMcpStub(board.handlers, () => assert.rejects(go(), /SUPERSEDE_HISTORY_BUSY/));
      assert.deepEqual(run.calls, [], "no MCP call at all");
      assert.deepEqual(readdirSync(cli.journalDir), [`${SUPERSEDE_ID}.supersede.lease.11111111-1111-4111-8111-111111111111.json`]);
    }
    assert.equal(historyOf(dir).tracker, "# Tracker\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--live-check takes no claim and is not stopped by one", async () => {
  const dir = supersedeDir();
  try {
    const registry = tmpRegistry(dir);
    const cli = supersedeCli(dir, { liveCheck: true });
    const board = closedGenerationBoard(cli);
    const token = "22222222-2222-4222-8222-222222222222";
    plantLease(cli, token, { pid: process.pid, host: hostname(), process_started: ownStart() });
    const run = await withMcpStub(board.handlers, () => runSupersede(cli, registry));
    assert.match(run.printed.join("\n"), /SUPERSEDE_READY/);
    assert.deepEqual(leaseFiles(cli), [`${SUPERSEDE_ID}.supersede.lease.${token}.json`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim recovery: a dead or recycled owner is recovered; live, other-host and unreadable claims refuse", async () => {
  const token = "33333333-3333-4333-8333-333333333333";
  for (const [label, claim, recovered] of [
    ["dead pid", () => ({ pid: deadPid(), host: hostname(), process_started: "x" }), true],
    ["recycled pid", () => ({ pid: process.pid, host: hostname(), process_started: "Thu Jan  1 00:00:00 1970" }), true],
    ["live owner", () => ({ pid: process.pid, host: hostname(), process_started: ownStart() }), false],
    ["live pid, start unknown", () => ({ pid: process.pid, host: hostname(), process_started: null }), false],
    ["another host, dead pid", () => ({ pid: deadPid(), host: "some-other-host.invalid", process_started: "x" }), false],
    ["no pid", () => ({ host: hostname() }), false],
    ["unreadable", () => "{ torn", false],
  ]) {
    for (const entry of ["ordinary", "repair"]) {
      const dir = supersedeDir();
      try {
        const registry = tmpRegistry(dir);
        const cli = supersedeCli(dir);
        const board = closedGenerationBoard(cli);
        plantLease(cli, token, claim());
        const go = () => (entry === "repair" ? runSupersedeRepair(repairCli(dir, 1), registry) : runSupersede(cli, registry));
        if (recovered) {
          const run = await withMcpStub(board.handlers, go);
          assert.equal(captureCalls(run.calls).length, 1, `${label}/${entry}: it finishes`);
          assert.deepEqual(leaseFiles(cli), [], `${label}/${entry}: the dead claim is gone`);
          assert.match(run.printed.join("\n"), /recovered_leases/, `${label}/${entry}: and that is said`);
        } else {
          const run = await withMcpStub(board.handlers, () => assert.rejects(go(), /SUPERSEDE_HISTORY_BUSY/));
          assert.deepEqual(run.calls, [], `${label}/${entry}: no read`);
          assert.equal(leaseFiles(cli).length, 1, `${label}/${entry}: the claim stays`);
          assert.equal(historyOf(dir).tracker, "# Tracker\n", `${label}/${entry}: nothing written`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});

test("a claim on another card does not block this one", async () => {
  const dir = supersedeDir();
  try {
    const registry = tmpRegistry(dir);
    const cli = supersedeCli(dir);
    const board = closedGenerationBoard(cli);
    mkdirSync(cli.journalDir, { recursive: true });
    const other = join(cli.journalDir, `${REPLACEMENT_ID}.supersede.lease.44444444-4444-4444-8444-444444444444.json`);
    writeFileSync(other, JSON.stringify({ pid: process.pid, host: hostname(), process_started: ownStart() }));
    const run = await withMcpStub(board.handlers, () => runSupersede(cli, registry));
    assert.equal(captureCalls(run.calls).length, 1);
    assert.equal(existsSync(other), true, "and is left alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a claim removed mid-run stops the command before it writes history or captures", async () => {
  const dir = supersedeDir();
  try {
    const registry = tmpRegistry(dir);
    const cli = supersedeCli(dir);
    const board = closedGenerationBoard(cli);
    const handlers = {
      ...board.handlers,
      get_agent_task: (a) => {
        if (a.task_id === SUPERSEDE_ID) for (const name of leaseFiles(cli)) rmSync(join(cli.journalDir, name));
        return board.handlers.get_agent_task(a);
      },
    };
    const run = await withMcpStub(handlers, () => assert.rejects(runSupersede(cli, registry), /SUPERSEDE_LEASE_LOST/));
    assert.equal(captureCalls(run.calls).length, 0);
    assert.equal(historyOf(dir).tracker, "# Tracker\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failure: a capture error releases the claim, and the retry resends the pinned bytes whatever the card says now", async () => {
  const dir = supersedeDir();
  try {
    const registry = tmpRegistry(dir);
    const cli = supersedeCli(dir);
    const board = closedGenerationBoard(cli);
    let fail = true;
    const sent = [];
    const handlers = {
      ...board.handlers,
      capture_thought: (a) => {
        sent.push(a);
        if (fail) throw new Error("capture response lost");
        return "Captured as observation";
      },
    };
    await withMcpStub(handlers, () => assert.rejects(runSupersede(cli, registry), /capture response lost/));
    assert.deepEqual(leaseFiles(cli), [], "released on the way out");
    const pinned = JSON.parse(readFileSync(repairFile(dir, 1), "utf8"));
    assert.equal(pinned.state, "files-written");
    assert.equal(pinned.capture_content, sent[0].content, "pinned before it went out");

    fail = false;
    board.state.row = { ...board.state.row, title: "retitled since" };
    await withMcpStub(handlers, () => runSupersedeRepair(repairCli(dir, 1), registry));
    assert.equal(sent.length, 2, "at least once: the retry does send");
    assert.equal(sent[1].content, sent[0].content, "the same bytes, so the content hash collapses them");
    assert.deepEqual(sent[1].tags, sent[0].tags);
    assert.equal(createHash("sha256").update(sent[0].content).digest("hex"), createHash("sha256").update(sent[1].content).digest("hex"));
    assert.equal(JSON.parse(readFileSync(repairFile(dir, 1), "utf8")).state, "complete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the capture belongs to the event: same bytes from ordinary and repair, different across generations, file prose unchanged", async () => {
  const [ordinaryDir, repairDir] = [supersedeDir(), supersedeDir()];
  try {
    const content = {};
    const seed = supersedeCli(ordinaryDir);
    for (const [kind, dir] of [["ordinary", ordinaryDir], ["repair", repairDir]]) {
      const board = closedGenerationBoard(seed, { capture: ({ content: c }) => { content[kind] = c; return "ok"; } });
      await withMcpStub(board.handlers, () => (kind === "ordinary"
        ? runSupersede(supersedeCli(dir), tmpRegistry(dir))
        : runSupersedeRepair(repairCli(dir, 1), tmpRegistry(dir))));
    }
    assert.equal(content.ordinary, content.repair, "the two paths send one body");
    assert.match(content.ordinary, /Event event-1\./, "and it names the event");
    assert.ok(!content.repair.includes("--repair-supersede"), "no run-specific prose");
    assert.ok(trackerText(repairDir).includes("--repair-supersede"), "the file still says it was written later");
    assert.ok(!trackerText(ordinaryDir).includes("--repair-supersede"));

    // Two generations with identical arguments on one date must not collapse into one capture.
    const dir = supersedeDir();
    try {
      const cli = supersedeCli(dir);
      const contents = [];
      const at = "2026-11-06T12:00:01.000Z";
      const board = bareClosedBoard(cli, { events: [supersededEvent(2, "same", null, at), supersededEvent(1, "same", null, at)] });
      board.handlers.capture_thought = ({ content: c }) => { contents.push(c); return "ok"; };
      for (const generation of [1, 2]) await withMcpStub(board.handlers, () => runSupersedeRepair(repairCli(dir, generation), tmpRegistry(dir)));
      assert.equal(new Set(contents).size, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(ordinaryDir, { recursive: true, force: true });
    rmSync(repairDir, { recursive: true, force: true });
  }
});

for (const [label, owner, other] of [
  ["time zone", { TZ: "Asia/Tokyo" }, { TZ: "America/New_York" }],
  ["locale", { LC_ALL: "fr_FR.UTF-8" }, { LC_ALL: "C" }],
]) {
  test(`a live owner is not judged gone by a command in another time zone or locale: ${label}`, async () => {
    const dir = supersedeDir();
    const saved = Object.fromEntries(["TZ", "LC_ALL"].map((key) => [key, process.env[key]]));
    const restore = () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    try {
      const registry = tmpRegistry(dir);
      const cli = supersedeCli(dir);
      const held = holdFirstCapture();
      const board = closedGenerationBoard(cli, { capture: held.capture });
      const run = await withMcpStub(board.handlers, async () => {
        Object.assign(process.env, owner);
        const a = runSupersede(supersedeCli(dir), registry);
        await held.seen;
        Object.assign(process.env, other);
        await assert.rejects(runSupersedeRepair(repairCli(dir, 1), registry), /SUPERSEDE_HISTORY_BUSY/);
        assert.equal(leaseFiles(cli).length, 1, "the owner's claim survives");
        restore();
        held.release();
        await a;
      });
      assert.equal(captureCalls(run.calls).length, 1, "one capture");
      assert.deepEqual(leaseFiles(cli), []);
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a pinned capture naming another event is refused, not sent", async () => {
  const dir = supersedeDir();
  try {
    const registry = tmpRegistry(dir);
    const cli = supersedeCli(dir);
    const board = closedGenerationBoard(cli);
    mkdirSync(cli.journalDir, { recursive: true });
    writeFileSync(repairFile(dir, 1), JSON.stringify({
      version: 3, kind: "supersede", state: "files-written", task_id: SUPERSEDE_ID, generation: 1, project_slug: "tmp-proj",
      event_id: "event-1", superseded_at: "2026-11-06T12:00:01.000Z", args: { reason: cli.supersedeReason, by: REPLACEMENT_ID },
      capture_content: "OE closeout for event-9", capture_tags: ["x"],
    }));
    const run = await withMcpStub(board.handlers, () => assert.rejects(runSupersede(cli, registry), /does not name generation 1's event/));
    assert.equal(captureCalls(run.calls).length, 0);
    assert.deepEqual(leaseFiles(cli), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("documented limit: a separate git dir literally named .git is refused, while other separate-git-dir layouts pass", () => {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "oe-supersede-gitname-"));
  try {
    const reasonsFor = (path) => evaluateSupersede({
      task: heldCard(),
      events: [],
      replacement: { id: REPLACEMENT_ID },
      args: { reason: "r", by: REPLACEMENT_ID },
      registry: { "tmp-proj": { tracker_path: path, session_log_path: path } },
    }).reasons;
    const seed = (work, metadata) => {
      mkdirSync(dirname(metadata), { recursive: true });
      execFileSync("git", ["init", "-q", `--separate-git-dir=${metadata}`, work], { stdio: "ignore" });
      writeFileSync(join(work, "T.md"), "# T\n");
      return join(work, "T.md");
    };
    assert.deepEqual(reasonsFor(seed(join(base, "named"), join(base, "store", "named-metadata"))), [], "a metadata directory with any other name passes");
    assert.deepEqual(reasonsFor(seed(join(base, "literal"), join(base, "store", ".git"))), ["APPEND_TARGET_IN_WORKTREE", "APPEND_TARGET_IN_WORKTREE"], "both destinations: an accepted conservative refusal, not a passing layout");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("regression: --repair-supersede writes one generation from its own event and never calls the verb", async () => {
  const dir = supersedeDir();
  try {
    const registry = tmpRegistry(dir);
    const board = bareClosedBoard(supersedeCli(dir));
    const before = JSON.stringify(board.state);

    // Generation 2 first, out of order, in an array that holds it first.
    const two = await withMcpStub(board.handlers, () => runSupersedeRepair(repairCli(dir, 2), registry));
    assert.equal(supersedeCalls(two.calls).length, 0, "the verb is never reached");
    assert.equal(JSON.stringify(board.state), before, "the card and its events are untouched");
    assert.equal(captureCalls(two.calls).length, 1);
    assert.match(two.printed.join("\n"), /HISTORY_REPAIRED_CARD_CHANGED/, "the reopened card is reported, not closed");
    let { tracker, log } = historyOf(dir);
    assert.equal(occurrences(tracker, supersedeMarker(SUPERSEDE_ID, 2)), 1);
    assert.equal(occurrences(log, supersedeMarker(SUPERSEDE_ID, 2)), 1);
    assert.equal(occurrences(tracker, supersedeMarker(SUPERSEDE_ID, 1)), 0, "generation 1 is a separate repair");
    assert.ok(tracker.includes("## Superseded — 2026-11-02"), "dated from generation 2's event");
    assert.ok(tracker.includes("Reason: second reason"));
    assert.ok(!tracker.includes("first reason"));
    assert.ok(tracker.includes("No replacement; the premise no longer holds."));
    assert.ok(tracker.includes("--repair-supersede"), "the history says it was written later");
    const journal = JSON.parse(readFileSync(repairFile(dir, 2), "utf8"));
    assert.equal(journal.state, "complete");
    assert.equal(journal.event_id, "event-2");
    assert.equal(journal.version, 3);
    assert.deepEqual(journal.args, { reason: "second reason", by: null });
    assert.equal(existsSync(repairFile(dir, 1)), false);

    // Generation 1 names a replacement, and its body says so.
    const one = await withMcpStub(board.handlers, () => runSupersedeRepair(repairCli(dir, 1), registry));
    assert.equal(supersedeCalls(one.calls).length, 0);
    ({ tracker, log } = historyOf(dir));
    assert.ok(tracker.includes("## Superseded — 2026-11-01"));
    assert.ok(tracker.includes(`Replaced by ${REPLACEMENT_ID.slice(0, 8)} (the replacement).`));
    assert.ok(log.includes("Reason: first reason"));
    assert.equal(JSON.parse(readFileSync(repairFile(dir, 1), "utf8")).event_id, "event-1");

    // Running it again changes nothing and sends nothing.
    const snapshot = historyOf(dir);
    const again = await withMcpStub(board.handlers, () => runSupersedeRepair(repairCli(dir, 1), registry));
    assert.match(again.printed.join("\n"), /ALREADY_RECORDED/);
    assert.equal(captureCalls(again.calls).length, 0);
    assert.deepEqual(historyOf(dir), snapshot);

    // The audit now reads clean.
    const audit = await withMcpStub(board.handlers, () => runUnrecordedAudit({ lookbackDays: 7 }, registry));
    const result = JSON.parse(audit.printed.join("\n"));
    assert.equal(result.unrecorded_count, 0);
    assert.equal(result.supersede_scan.recorded_generations, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: --repair-supersede on a card still closed by that generation leaves it closed and says so", async () => {
  const dir = supersedeDir();
  try {
    const registry = tmpRegistry(dir);
    const cli = supersedeCli(dir);
    const board = bareClosedBoard(cli, {
      events: [supersededEvent(1, cli.supersedeReason, cli.supersedeBy, "2026-11-01T12:00:00.000Z")],
      row: closedRow(cli),
    });
    const run = await withMcpStub(board.handlers, () => runSupersedeRepair(repairCli(dir, 1), registry));
    assert.equal(supersedeCalls(run.calls).length, 0);
    assert.match(run.printed.join("\n"), /"status": "HISTORY_REPAIRED"/);
    assert.equal(board.state.row.status, "Agent Done");
    assert.equal(occurrences(historyOf(dir).log, supersedeMarker(SUPERSEDE_ID, 1)), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--repair-supersede --live-check says what it would do and writes nothing", async () => {
  const dir = supersedeDir();
  try {
    const board = bareClosedBoard(supersedeCli(dir));
    const run = await withMcpStub(board.handlers, () => runSupersedeRepair(repairCli(dir, 1, { liveCheck: true }), tmpRegistry(dir)));
    const output = JSON.parse(run.printed.join("\n"));
    assert.equal(output.status, "REPAIR_READY");
    assert.equal(output.event_id, "event-1");
    assert.equal(output.reason, "first reason");
    assert.equal(run.calls.length, 1, "only the read");
    assert.equal(existsSync(join(dir, "journals")), false);
    assert.equal(historyOf(dir).tracker, "# Tracker\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--repair-supersede holds on anything it cannot write from the event, before any write", async () => {
  const dir = supersedeDir();
  try {
    const registry = tmpRegistry(dir);
    const cli = supersedeCli(dir);
    const attempt = async (board, generation, reg = registry) => {
      const printed = [];
      let error = null;
      try {
        printed.push(...(await withMcpStub(board.handlers, () => runSupersedeRepair(repairCli(dir, generation), reg))).printed);
      } catch (err) {
        error = err;
      }
      assert.equal(existsSync(join(dir, "journals")), false, "no journal");
      assert.equal(historyOf(dir).tracker, "# Tracker\n", "no history");
      return String(error?.message);
    };
    assert.match(await attempt(bareClosedBoard(cli), 3), /REPAIR_GENERATION_NOT_FOUND/);
    assert.match(await attempt(bareClosedBoard(cli), 2, {}), /UNKNOWN_PROJECT_ROUTE/);
    assert.match(await attempt(bareClosedBoard(cli, { row: heldCard({ project_slug: null, status: "Needs Operator" }) }), 2), /MISSING_PROJECT_SLUG/);
    assert.match(await attempt(bareClosedBoard(cli, { events: [supersededEvent(2, "gap", null, "2026-11-02T00:00:00.000Z")] }), 2), /SUPERSEDE_HISTORY_INVALID/);
    assert.match(await attempt(bareClosedBoard(cli, { events: [supersededEvent(1, "   ", null, "2026-11-01T00:00:00.000Z")] }), 1), /SUPERSEDE_HISTORY_INVALID/);
    assert.match(await attempt(bareClosedBoard(cli, { events: [supersededEvent(1, undefined, null, "2026-11-01T00:00:00.000Z")] }), 1), /SUPERSEDE_HISTORY_INVALID/);
    const noFiles = mkdtempSync(join(tmpdir(), "oe-supersede-nofiles-"));
    try {
      assert.match(await attempt(bareClosedBoard(cli), 1, tmpRegistry(noFiles)), /APPEND_TARGET_MISSING/);
    } finally {
      rmSync(noFiles, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--repair-supersede finishes partial history without duplicating the half that exists", async () => {
  const dir = supersedeDir();
  try {
    const registry = tmpRegistry(dir);
    const board = bareClosedBoard(supersedeCli(dir));
    writeFileSync(join(dir, "PROJECT-TRACKER.md"), `# Tracker\n${supersedeMarker(SUPERSEDE_ID, 1)}\n`);
    const run = await withMcpStub(board.handlers, () => runSupersedeRepair(repairCli(dir, 1), registry));
    assert.equal(supersedeCalls(run.calls).length, 0);
    const { tracker, log } = historyOf(dir);
    assert.equal(tracker, `# Tracker\n${supersedeMarker(SUPERSEDE_ID, 1)}\n`, "the tracker is not touched");
    assert.equal(occurrences(log, supersedeMarker(SUPERSEDE_ID, 1)), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--repair-supersede with a journal: resumes an honest one, retires a lost intent, refuses a mismatch", async () => {
  const dir = supersedeDir();
  try {
    const registry = tmpRegistry(dir);
    const board = bareClosedBoard(supersedeCli(dir));
    const seed = (generation, fields) => {
      mkdirSync(join(dir, "journals"), { recursive: true });
      writeFileSync(repairFile(dir, generation), JSON.stringify({ version: 3, kind: "supersede", task_id: SUPERSEDE_ID, generation, project_slug: "tmp-proj", ...fields }), "utf8");
    };
    const repair = (generation) => withMcpStub(board.handlers, () => runSupersedeRepair(repairCli(dir, generation), registry));

    // A lost response: the intent matches the event, so it is simply finished.
    seed(1, { state: "intent-written", args: { reason: "first reason", by: REPLACEMENT_ID } });
    const adopted = await repair(1);
    assert.equal(supersedeCalls(adopted.calls).length, 0);
    assert.equal(JSON.parse(readFileSync(repairFile(dir, 1), "utf8")).state, "complete");

    // An intent another writer beat: retired, and the event is what gets written.
    seed(2, { state: "intent-written", args: { reason: "lost the race", by: null } });
    const beaten = await repair(2);
    assert.equal(supersedeCalls(beaten.calls).length, 0);
    assert.equal(JSON.parse(readFileSync(repairFile(dir, 2), "utf8")).args.reason, "second reason");
    assert.ok(readdirSync(join(dir, "journals")).some((name) => name.includes(".g2.json.lost-to-another-")), "the old intent is kept, renamed");
    const { tracker } = historyOf(dir);
    assert.ok(tracker.includes("Reason: second reason"));
    assert.ok(!tracker.includes("lost the race"));

    // A journal past its intent naming another event, or other arguments: both refused.
    const other = supersedeDir();
    try {
      const reg = tmpRegistry(other);
      const seedOther = (fields) => {
        mkdirSync(join(other, "journals"), { recursive: true });
        writeFileSync(repairFile(other, 1), JSON.stringify({ version: 3, kind: "supersede", task_id: SUPERSEDE_ID, generation: 1, args: { reason: "first reason", by: REPLACEMENT_ID }, ...fields }), "utf8");
      };
      for (const fields of [
        { state: "board-superseded", event_id: "event-2" },
        { state: "complete", event_id: "event-2" },
        { state: "board-superseded", event_id: "event-1", args: { reason: "other", by: null } },
        { state: "board-superseded", event_id: "event-1", task_id: "someone-else" },
      ]) {
        seedOther(fields);
        await assert.rejects(withMcpStub(board.handlers, () => runSupersedeRepair(repairCli(other, 1), reg)), /Refusing/, JSON.stringify(fields));
        assert.equal(historyOf(other).tracker, "# Tracker\n", JSON.stringify(fields));
      }
      // A complete journal for another card, with this generation's markers already on
      // file: the repair would otherwise answer "recorded" without reaching the resume
      // path's own check, so it reads the journal's body itself.
      for (const fields of [{ task_id: "someone-else" }, { generation: 7 }]) {
        seedOther({ state: "complete", event_id: "event-1", ...fields });
        writeFileSync(join(other, "PROJECT-TRACKER.md"), supersedeMarker(SUPERSEDE_ID, 1));
        writeFileSync(join(other, "SESSION-LOG.md"), supersedeMarker(SUPERSEDE_ID, 1));
        await assert.rejects(withMcpStub(board.handlers, () => runSupersedeRepair(repairCli(other, 1), reg)), /does not describe generation 1/, JSON.stringify(fields));
      }
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--repair-supersede rewrites history a complete journal claims but the files lost, without a second capture", async () => {
  const dir = supersedeDir();
  try {
    const registry = tmpRegistry(dir);
    const board = bareClosedBoard(supersedeCli(dir));
    await withMcpStub(board.handlers, () => runSupersedeRepair(repairCli(dir, 1), registry));
    writeFileSync(join(dir, "SESSION-LOG.md"), "# Log, rewritten by hand\n");
    const run = await withMcpStub(board.handlers, () => runSupersedeRepair(repairCli(dir, 1), registry));
    assert.equal(captureCalls(run.calls).length, 0, "the capture is already journaled");
    const { tracker, log } = historyOf(dir);
    assert.equal(occurrences(log, supersedeMarker(SUPERSEDE_ID, 1)), 1);
    assert.equal(occurrences(tracker, supersedeMarker(SUPERSEDE_ID, 1)), 1, "the file that had it is unchanged");
    assert.equal(JSON.parse(readFileSync(repairFile(dir, 1), "utf8")).state, "complete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--repair-supersede finishes only the generation it names: another generation's open journal is left alone", async () => {
  const dir = supersedeDir();
  try {
    const registry = tmpRegistry(dir);
    const board = bareClosedBoard(supersedeCli(dir));
    mkdirSync(join(dir, "journals"));
    writeFileSync(repairFile(dir, 1), JSON.stringify({ version: 3, kind: "supersede", task_id: SUPERSEDE_ID, generation: 1, state: "board-superseded", event_id: "event-1", project_slug: "tmp-proj", args: { reason: "first reason", by: REPLACEMENT_ID } }), "utf8");
    await withMcpStub(board.handlers, () => runSupersedeRepair(repairCli(dir, 2), registry));
    assert.equal(JSON.parse(readFileSync(repairFile(dir, 1), "utf8")).state, "board-superseded", "generation 1's journal did not move");
    assert.equal(JSON.parse(readFileSync(repairFile(dir, 2), "utf8")).state, "complete");
    assert.equal(occurrences(historyOf(dir).tracker, supersedeMarker(SUPERSEDE_ID, 1)), 0);
    assert.equal(occurrences(historyOf(dir).tracker, supersedeMarker(SUPERSEDE_ID, 2)), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--repair-supersede parseArgs: a full uuid and a generation, and nothing the event already says", () => {
  const ok = parseArgs(["--repair-supersede", SUPERSEDE_ID, "--generation", "2", "--live-check"]);
  assert.equal(ok.repairSupersedeTaskId, SUPERSEDE_ID);
  assert.equal(ok.supersedeGeneration, 2);
  assert.equal(ok.liveCheck, true);
  assert.throws(() => parseArgs(["--repair-supersede", SUPERSEDE_ID]), /requires --generation/);
  assert.throws(() => parseArgs(["--repair-supersede", SUPERSEDE_ID, "--generation", "0"]), /requires --generation/);
  assert.throws(() => parseArgs(["--repair-supersede", SUPERSEDE_ID, "--generation", "x"]), /requires --generation/);
  assert.throws(() => parseArgs(["--repair-supersede", "aaaaaaaa", "--generation", "1"]), /full task uuid/);
  for (const extra of [["--reason", "r"], ["--by", REPLACEMENT_ID], ["--premise", "p"], ["--apply"], ["--audit-unrecorded"], ["--supersede", SUPERSEDE_ID]]) {
    assert.throws(() => parseArgs(["--repair-supersede", SUPERSEDE_ID, "--generation", "1", ...extra]), /combines only|mutually exclusive/, extra.join(" "));
  }
  assert.throws(() => parseArgs(["--generation", "1"]), /require --supersede/);
});
