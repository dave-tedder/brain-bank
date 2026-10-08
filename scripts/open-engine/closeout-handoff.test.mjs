import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, evaluateUnrecordedAudit } from "./closeout-controller.mjs";

const TASK_ID = "11111111-2222-4333-8444-555555555555";
function withProject(fn) {
  const dir = mkdtempSync(join(tmpdir(), "oe-handoff-"));
  const route = {
    workspace_path: dir,
    tracker_path: join(dir, "PROJECT-TRACKER.md"),
    session_log_path: join(dir, "SESSION-LOG.md"),
    capture_tag: "fixture",
  };
  writeFileSync(route.tracker_path, "# Fixture tracker\n");
  writeFileSync(route.session_log_path, "# Fixture log\n");
  try { return fn({ fixture: route }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function input(followUp, touched = "deliverables/fixture/draft.md") {
  const receipt = [
    "Work summary: Wrote a private draft.",
    "Verification: Read the draft back locally.",
    `Touched files or records: ${touched}`,
    "Limitations: Not installed or published.",
    "Tracker draft: Private draft ready for review.",
    "Session-log draft: Draft prepared without installation.",
    "Brain Bank capture draft: Draft ready for review.",
    "Follow-up recommendation:", followUp,
  ].join("\n");
  return {
    generated_at: "2026-10-07T12:00:00Z", actionItems: [],
    tasks: [{
      id: TASK_ID, project_slug: "fixture", status: "Agent Review", risk: "low",
      events: [{ event_type: "AGENT DONE", created_at: "2026-10-06T12:00:00Z", payload: { reason: receipt } }],
    }],
  };
}

for (const [name, target] of [
  ["prose target", "Client intake notes (https://example.com/intake)"],
  ["unsafe scheme", "javascript:alert(1)"],
  ["protocol relative target", "//example.com/intake"],
]) {
  test(`handoff: anchored marker with ${name} keeps target hold without false line warning`, () => {
    withProject((registry) => {
      const result = evaluate(input(`OPERATOR-ACTION: Review draft || OPERATOR-TARGET: ${target}`), registry);
      assert.deepEqual({ status: result.status, apply: result.apply, reasons: result.hold[0]?.reasons }, {
        status: "HELD", apply: [],
        reasons: ["OPERATOR_TARGET_UNSAFE_SCHEME", "DELIVERABLE_WITHOUT_OPERATOR_ACTION"],
      });
      assert.match(result.hold[0].message, /^OPERATOR-TARGET must be a plain http\(s\) URL or filesystem path/);
    });
  });
}

test("handoff: genuinely mid-line marker remains held", () => {
  withProject((registry) => {
    const result = evaluate(input("Read the draft. OPERATOR-ACTION: Review || OPERATOR-TARGET: https://example.com"), registry);
    assert.deepEqual({ status: result.status, apply: result.apply, reasons: result.hold[0]?.reasons }, {
      status: "HELD", apply: [],
      reasons: ["DELIVERABLE_WITHOUT_OPERATOR_ACTION", "OPERATOR_MARKER_NOT_LINE_ANCHORED"],
    });
  });
});

test("handoff: valid anchored marker preserves exact review handoff", () => {
  withProject((registry) => {
    const result = evaluate(input("Read the draft.\n  OPERATOR-ACTION: Review draft || OPERATOR-TARGET: https://example.com/intake"), registry);
    assert.deepEqual({ status: result.status, hold: result.hold, count: result.apply.length, operator: result.apply[0]?.operator }, {
      status: "APPLYABLE", hold: [], count: 1,
      operator: { operator_action: "Review draft", operator_target: "https://example.com/intake" },
    });
  });
});

// An anchored marker whose action is empty but which still carries a target
// ("OPERATOR-ACTION: || OPERATOR-TARGET: <url>") used to be held by the
// line-anchored check (under the wrong reason). Narrowing that check must not
// let it apply with the target silently dropped: it holds under its own reason.
const NO_DELIVERABLE = "docs/notes.md (read only)";

for (const [name, followUp] of [
  ["empty action with target", "OPERATOR-ACTION: || OPERATOR-TARGET: https://example.com/intake"],
  ["empty action with bare separator", "OPERATOR-ACTION: ||"],
  ["empty action with trailing prose", "OPERATOR-ACTION:  || OPERATOR-TARGET: https://example.com\nThen stop."],
]) {
  test(`handoff: ${name} holds even without a staged deliverable`, () => {
    withProject((registry) => {
      const result = evaluate(input(followUp, NO_DELIVERABLE), registry);
      assert.deepEqual({ status: result.status, apply: result.apply, reasons: result.hold[0]?.reasons }, {
        status: "HELD", apply: [], reasons: ["OPERATOR_ACTION_EMPTY"],
      });
      assert.match(result.hold[0].message, /^Receipt's OPERATOR-ACTION marker has no action text/);
    });
  });
}

test("handoff: empty action with target and a staged deliverable reports both reasons", () => {
  withProject((registry) => {
    const result = evaluate(input("OPERATOR-ACTION: || OPERATOR-TARGET: https://example.com/intake"), registry);
    assert.deepEqual({ status: result.status, apply: result.apply, reasons: result.hold[0]?.reasons }, {
      status: "HELD", apply: [], reasons: ["OPERATOR_ACTION_EMPTY", "DELIVERABLE_WITHOUT_OPERATOR_ACTION"],
    });
  });
});

// Control for the block above: the same no-deliverable receipt with a bare
// "OPERATOR-ACTION:" label (nothing after it) is still treated as no marker and
// applies, so the hold above is attributable to the body after the label.
test("handoff: bare OPERATOR-ACTION label with nothing after it still applies without a deliverable", () => {
  withProject((registry) => {
    const result = evaluate(input("OPERATOR-ACTION:", NO_DELIVERABLE), registry);
    assert.deepEqual({ status: result.status, hold: result.hold, count: result.apply.length, operator: result.apply[0]?.operator },
      { status: "APPLYABLE", hold: [], count: 1, operator: null });
  });
});

test("handoff: report prose alone does not bypass the deliverables gate", () => {
  withProject((registry) => {
    const result = evaluate(input("No operator action is required; this is a report only."), registry);
    assert.deepEqual({ status: result.status, apply: result.apply, reasons: result.hold[0]?.reasons }, {
      status: "HELD", apply: [], reasons: ["DELIVERABLE_WITHOUT_OPERATOR_ACTION"],
    });
  });
});

function auditPacket(eventType, payload = {}) {
  return {
    task: { id: TASK_ID, project_slug: "fixture", status: "Needs Operator", risk: "low" },
    events: [{ event_type: eventType, created_at: "2026-09-24T20:50:09Z", payload: {
      from_status: "Agent Review",
      status: eventType === "AGENT NEEDS DAVE" ? "Needs Dave" : "Needs Operator",
      resolution: "accepted", applied_by: "closeout-controller", ...payload,
    } }],
  };
}

for (const eventType of ["AGENT APPLIED", "AGENT NEEDS OPERATOR", "AGENT NEEDS DAVE"]) {
  for (const recorded of [false, true]) {
    test(`handoff: audit ${eventType} reports ${recorded ? "recorded" : "unrecorded"} history`, () => {
      withProject((registry) => {
        if (recorded) writeFileSync(registry.fixture.session_log_path, `Recorded ${TASK_ID}\n`);
        const result = evaluateUnrecordedAudit([auditPacket(eventType)], registry);
        assert.deepEqual({
          recorded: result.recorded.map(r => r.task_id),
          unrecorded: result.unrecorded.map(r => r.task_id), skipped: result.skipped,
        }, {
          recorded: recorded ? [TASK_ID] : [],
          unrecorded: recorded ? [] : [TASK_ID], skipped: [],
        });
      });
    });
  }
}

for (const eventType of ["AGENT DONE", "OPERATOR DONE", "AGENT STATUS"]) {
  test(`handoff: audit does not classify ${eventType} alone as an apply`, () => {
    withProject((registry) => {
      const result = evaluateUnrecordedAudit([auditPacket(eventType)], registry);
      assert.deepEqual(result, {
        recorded: [], unrecorded: [], skipped: [{ task_id: TASK_ID, reason: "NOT_APPLIED" }],
      });
    });
  });
}

test("handoff: controller desk apply without history is a partial apply", () => {
  withProject((registry) => {
    const result = evaluateUnrecordedAudit([
      auditPacket("AGENT NEEDS OPERATOR", { closeout_evidence: { source: "oe8-closeout-controller" } }),
    ], registry);
    assert.deepEqual({ count: result.unrecorded.length, severity: result.unrecorded[0]?.severity, skipped: result.skipped }, {
      count: 1, severity: "PARTIAL_APPLY", skipped: [],
    });
  });
});

const deskMove = {
  event_type: "AGENT NEEDS OPERATOR", created_at: "2026-10-07T12:00:00Z",
  payload: { action: "ops-amend", from_status: "Agent Review", status: "Needs Operator", actor: "operator", reason: "Move to desk" },
};

test("handoff: an administrative desk move alone is not an apply", () => {
  withProject((registry) => {
    const packet = auditPacket("AGENT NEEDS OPERATOR");
    packet.events = [deskMove];
    assert.deepEqual(evaluateUnrecordedAudit([packet], registry), {
      recorded: [], unrecorded: [], skipped: [{ task_id: TASK_ID, reason: "NOT_APPLIED" }],
    });
  });
});

for (const applyType of ["AGENT APPLIED", "AGENT NEEDS OPERATOR", "AGENT NEEDS DAVE"]) {
  test(`handoff: ${applyType} then desk move retains original apply provenance`, () => {
    withProject((registry) => {
      const packet = auditPacket(applyType, {
        closeout_evidence: { source: "oe8-closeout-controller" },
      });
      packet.events.push(deskMove);
      const result = evaluateUnrecordedAudit([packet], registry);
      const row = result.unrecorded[0];
      assert.deepEqual({
        count: result.unrecorded.length, recorded: result.recorded, skipped: result.skipped,
        applied_at: row?.applied_at, applied_by: row?.applied_by,
        via_controller: row?.via_controller, severity: row?.severity, status: row?.status,
      }, {
        count: 1, recorded: [], skipped: [], applied_at: "2026-09-24T20:50:09Z",
        applied_by: "closeout-controller", via_controller: true,
        severity: "PARTIAL_APPLY", status: "Needs Operator",
      });
    });
  });
}

for (const eventType of ["AGENT NEEDS OPERATOR", "AGENT NEEDS DAVE"]) {
  const status = eventType === "AGENT NEEDS DAVE" ? "Needs Dave" : "Needs Operator";
  const valid = { from_status: "Agent Review", status, resolution: "accepted", applied_by: "operator" };
  for (const [label, payload] of [
    ["null payload", null], ["string payload", "accepted"], ["array payload", []],
    ["missing origin", { ...valid, from_status: undefined }],
    ["wrong origin", { ...valid, from_status: "Agent Needs Input" }],
    ["missing resolution", { ...valid, resolution: undefined }],
    ["invalid resolution", { ...valid, resolution: "rejected" }],
    ["missing destination", { ...valid, status: undefined }],
    ["wrong destination", { ...valid, status: "Agent Todo" }],
    ["amendment with apply-shaped fields", { ...valid, action: "ops-amend" }],
  ]) {
    test(`handoff: ${eventType} rejects ${label}`, () => {
      withProject((registry) => {
        const packet = auditPacket(eventType);
        packet.events[0].payload = payload;
        assert.deepEqual(evaluateUnrecordedAudit([packet], registry), {
          recorded: [], unrecorded: [], skipped: [{ task_id: TASK_ID, reason: "NOT_APPLIED" }],
        });
      });
    });
  }
  test(`handoff: ${eventType} accepted_with_follow_up is a reviewed apply`, () => {
    withProject((registry) => {
      const result = evaluateUnrecordedAudit([auditPacket(eventType, { resolution: "accepted_with_follow_up" })], registry);
      assert.deepEqual({ unrecorded: result.unrecorded.map(r => r.task_id), skipped: result.skipped }, {
        unrecorded: [TASK_ID], skipped: [],
      });
    });
  });
}
