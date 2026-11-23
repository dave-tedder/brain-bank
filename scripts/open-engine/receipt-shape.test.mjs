// Loop-closing Task 5.4: the shared receipt contract, from the Node side.
//   node --test scripts/open-engine/receipt-shape.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as controller from "./closeout-controller.mjs";
import * as shared from "../../supabase/functions/_shared/receipt-shape.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HELD = JSON.parse(
  readFileSync(join(HERE, "fixtures", "complete-contract-held-receipts.json"), "utf8"),
);

test("the controller's receipt parsers ARE the shared module's (same function objects)", () => {
  // This is what makes the unchanged controller suite a test of the shared
  // module: every parser it imports from the controller is the shared one.
  for (const name of ["parseReceipt", "parseOperatorAction", "receiptNamesDeliverable", "isSafeOperatorTarget"]) {
    assert.equal(typeof shared[name], "function", name);
    assert.equal(controller[name], shared[name], name);
  }
  assert.equal(controller.REQUIRED_RECEIPT_SECTIONS, shared.REQUIRED_RECEIPT_SECTIONS);
  assert.equal(controller.REASON_ALIASES, shared.REASON_ALIASES);
});

test("the controller source no longer defines its own copy of any moved function", () => {
  const src = readFileSync(join(HERE, "closeout-controller.mjs"), "utf8");
  for (
    const name of [
      "parseReceipt",
      "parseOperatorAction",
      "receiptNamesDeliverable",
      "isAllowedOperatorTarget",
      "isSafeOperatorTarget",
      "augmentFromReviewNote",
      "holdMessage",
      "countOperatorMarkers",
      "referenceDeliverables",
    ]
  ) {
    assert.doesNotMatch(src, new RegExp(`function ${name}\\(`), name);
  }
  assert.doesNotMatch(src, /const REQUIRED_RECEIPT_SECTIONS = \[/);
  assert.doesNotMatch(src, /"OPERATOR_TARGET_UNSAFE_SCHEME"/);
});

test("rename: the old target code is an alias only; nothing emits it", () => {
  assert.equal(shared.REASON_ALIASES.OPERATOR_TARGET_UNSAFE_SCHEME, "OPERATOR_TARGET_NOT_URL_OR_PATH");
  const parsed = shared.parseOperatorAction("OPERATOR-ACTION: x || OPERATOR-TARGET: a description");
  assert.deepEqual(parsed, { operator: null, reasons: ["OPERATOR_TARGET_NOT_URL_OR_PATH"] });
  assert.match(
    shared.holdMessage(["OPERATOR_TARGET_NOT_URL_OR_PATH"], { missing: [] }),
    /^OPERATOR-TARGET must be a plain http\(s\) URL or filesystem path, not a description\./,
  );
});

function withRoute(fn) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "oe-receipt-shape-"));
  writeFileSync(join(dir, "PROJECT-TRACKER.md"), "# t\n");
  writeFileSync(join(dir, "SESSION-LOG.md"), "# l\n");
  try {
    return fn({
      [HELD.fixture_route]: {
        workspace_path: dir,
        tracker_path: join(dir, "PROJECT-TRACKER.md"),
        session_log_path: join(dir, "SESSION-LOG.md"),
        capture_tag: "fixture_route",
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const c of HELD.cases) {
  test(`held receipts: the controller holds reconstructed ${c.card} with its recorded 2026-11-03 reasons`, () => {
    withRoute((registry) => {
      const result = controller.evaluate({
        generated_at: "2026-11-03T00:00:00Z",
        actionItems: [],
        tasks: [{
          id: `${c.card}-0000-4000-8000-000000000000`,
          title: c.card,
          status: "Agent Review",
          risk: "low",
          project_slug: c.project_slug,
          desired_outcome: c.desired_outcome,
          review_reason: c.receipt,
          events: [{ event_type: "AGENT DONE", created_at: "2026-11-01T00:00:00Z", payload: { reason: c.receipt } }],
        }],
      }, registry);
      assert.equal(result.status, "HELD");
      const recorded = c.recorded_reasons_2026_11_03.map((r) => shared.REASON_ALIASES[r] ?? r);
      assert.deepEqual([...result.hold[0].reasons].sort(), [...recorded].sort());
    });
  });
}

test("route capabilities: the shared mapping reproduces the controller's four route reasons in order", () => {
  const exists = (p) => p.endsWith("present");
  assert.deepEqual(
    shared.routeCapabilityReasons(shared.routeCapabilities({
      workspace_path: "/missing",
      tracker_path: "/missing",
      session_log_path: "/missing",
      capture_tag: "",
    }, exists)),
    ["UNRESOLVED_WORKSPACE_PATH", "UNRESOLVED_TRACKER_PATH", "UNRESOLVED_SESSION_LOG_PATH", "MISSING_CAPTURE_TAG"],
  );
  assert.deepEqual(
    shared.routeCapabilities({ workspace_path: "/present", tracker_path: "/present", session_log_path: "", capture_tag: "x" }, exists),
    { has_workspace: true, has_tracker: true, has_session_log: false, has_capture_tag: true },
  );
  assert.deepEqual(shared.routeCapabilityReasons({ has_workspace: true, has_tracker: true, has_session_log: true, has_capture_tag: true }), []);
  // Anything but literal true is a missing capability.
  assert.deepEqual(shared.routeCapabilityReasons({ has_workspace: 1, has_tracker: "true", has_session_log: null }), [
    "UNRESOLVED_WORKSPACE_PATH",
    "UNRESOLVED_TRACKER_PATH",
    "UNRESOLVED_SESSION_LOG_PATH",
    "MISSING_CAPTURE_TAG",
  ]);
});

test("static contract: no review note means no augmentation, and the reasons equal the controller's static ones", () => {
  const receipt = [
    "Work summary: x",
    "Verification: x",
    "Touched files or records: deliverables/x/y.md",
    "Limitations: x",
    "Tracker draft: x",
    "Session-log draft: x",
    "Brain Bank capture draft: x",
    "Follow-up recommendation:",
    "Read it. OPERATOR-ACTION: install || OPERATOR-TARGET: https://example.com",
  ].join("\n");
  const c = shared.evaluateReceiptContract({ receiptText: receipt });
  assert.deepEqual([...new Set(c.reasons)], ["DELIVERABLE_WITHOUT_OPERATOR_ACTION", "OPERATOR_MARKER_NOT_LINE_ANCHORED"]);
  assert.deepEqual(c.augmentation.augmented, []);
  assert.equal(c.stagedDeliverable, true);
});

test("parity script: the current controller matches itself (the script can run and compare)", async () => {
  const { runParity } = await import("./receipt-shape-parity.mjs");
  const r = await runParity(join(HERE, "closeout-controller.mjs"));
  assert.equal(r.code, 0, JSON.stringify(r.report).slice(0, 400));
  assert.ok(r.report.cases > 500, `corpus size ${r.report.cases}`);
  assert.ok(r.report.compat_checked > 100, `compat cases ${r.report.compat_checked}`);
});

test("parity script: a doctored old controller (one hold message changed) is reported DIFFERENT", async () => {
  const { runParity } = await import("./receipt-shape-parity.mjs");
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "oe-parity-doctored-"));
  try {
    // A self-contained stand-in for the old controller: the current evaluate()
    // with one hold message rewritten, so exactly the message comparison differs.
    const doctored = join(dir, "old-controller.mjs");
    writeFileSync(doctored, [
      `import { evaluate as real } from ${JSON.stringify(join(HERE, "closeout-controller.mjs"))};`,
      "export function evaluate(input, registry, options) {",
      "  const r = real(input, registry, options);",
      "  for (const h of r.hold) h.message = h.message.replace('Task held by dry-run safety gates', 'Task held');",
      "  return r;",
      "}",
    ].join("\n"));
    const r = await runParity(doctored);
    assert.equal(r.code, 1, JSON.stringify(r.report).slice(0, 300));
    assert.ok(r.report.difference_count > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutant runner: its suite reader tells a completed failure from a run that never finished", async () => {
  const { failuresOf } = await import("./receipt-contract-mutants.mjs");
  const run = (stdout, stderr = "") => ({ stdout, stderr });
  assert.deepEqual(failuresOf("shape", run("✔ a (1ms)\n✖ refusal: x (2ms)\nℹ tests 2\nℹ pass 1\nℹ fail 1\n✖ failing tests:\n✖ refusal: x (2ms)\n")),
    { complete: true, total: 2, failures: ["refusal: x"] });
  assert.deepEqual(failuresOf("deno", run("ok | 34 passed | 0 failed (15ms)\n")), { complete: true, total: 34, failures: [] });
  assert.deepEqual(failuresOf("deno", run("route: y ... FAILED (1ms)\nFAILED | 33 passed | 1 failed (15ms)\n")),
    { complete: true, total: 34, failures: ["route: y"] });
  // A type-check failure prints no count: not complete, so never a catch.
  assert.equal(failuresOf("deno", run("", "TS18047 [ERROR]: 'row' is possibly 'null'.\nerror: Type checking failed.\n")).complete, false);
  assert.equal(failuresOf("shape", run("")).complete, false);
  assert.deepEqual(failuresOf("probe", run("PASS P1 x\nCOMPLETE CONTRACT PROBE PASSED\n")), { complete: true, total: 1, failures: [] });
  assert.deepEqual(failuresOf("probe", run("PASS P1 x\nFAIL P2 d055613a: accepted\n")), { complete: true, total: 1, failures: ["FAIL P2 d055613a: accepted"] });
  assert.equal(failuresOf("probe", run("NEVER-RAN: the open-brain-mcp module did not start: x\n")).complete, false);
  assert.deepEqual(failuresOf("parity", run('{\n  "status": "DIFFERENT",\n')), { complete: true, total: 1, failures: ["DIFFERENT"] });
  assert.deepEqual(failuresOf("parity", run('{\n  "status": "PARITY",\n')), { complete: true, total: 1, failures: [] });
  assert.equal(failuresOf("parity", run('{"status":"NEVER-RAN","error":"x"}')).complete, false);
});
