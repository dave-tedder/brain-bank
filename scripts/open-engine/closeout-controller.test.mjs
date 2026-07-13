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
  applyDocFlip,
  evaluate,
  extractOperatorAction,
  flipDocLineText,
  parseReceipt,
  planDocRefs,
  resolvePlanDocPath,
  scanPlanDocDir,
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
