import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  appendResolutionBlock,
  applyDocFlip,
  evaluate,
  evaluateResolutionSweep,
  evaluateUnrecordedAudit,
  extractOperatorAction,
  scanCoversWindow,
  flipDocLineText,
  parseCheckRef,
  parseCheckSpec,
  parseReceipt,
  planDocRefs,
  receiptNamesDeliverable,
  resolvePlanDocPath,
  runExecutedCheck,
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
  assert.ok(item.body.startsWith("Resolved by Sam Operator on 2026-07-18: "));
  assert.ok(item.body.includes("DEFERRED by operator decision"));
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
        agent_code: "dave-claude-code",
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
