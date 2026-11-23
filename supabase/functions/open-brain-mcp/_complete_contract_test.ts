// Loop-closing Task 5.4: complete-time receipt validation.
//   deno test --no-lock --allow-read --allow-env supabase/functions/open-brain-mcp
import { assert, assertEquals, assertMatch, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import {
  evaluateCompletion,
  evaluateRoute,
  ROUTE_REPAIR_HINT,
  ROUTE_SNAPSHOT_MAX_AGE_MS,
  type RouteLookup,
  type RouteSnapshotRow,
} from "./_complete_contract.ts";
import {
  canonicalHeading,
  REASON_ALIASES,
  REQUIRED_RECEIPT_SECTIONS,
} from "../_shared/receipt-shape.js";

const NOW = new Date("2026-11-20T12:00:00Z");
const ROOT = new URL("../../../", import.meta.url);

function freshRow(slug: string, over: Partial<RouteSnapshotRow> = {}): RouteSnapshotRow {
  return {
    slug,
    has_workspace: true,
    has_tracker: true,
    has_session_log: true,
    has_capture_tag: true,
    published_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    ...over,
  };
}
const fresh = (slug: string, over: Partial<RouteSnapshotRow> = {}): RouteLookup => ({
  row: freshRow(slug, over),
});

function receipt(follow: string, touched = "none outside this receipt"): string {
  return [
    "Work summary: did the thing",
    "Verification: ran it",
    `Touched files or records: ${touched}`,
    "Limitations: none",
    "Tracker draft: - [x] did the thing",
    "Session-log draft: did the thing",
    "Brain Bank capture draft: did the thing",
    "Follow-up recommendation:",
    follow,
  ].join("\n");
}
const CLEAN = receipt("none");
const TASK = { project_slug: "brain-bank", desired_outcome: "A working fix", title: "t" };

function refused(v: ReturnType<typeof evaluateCompletion>) {
  if (v.ok) throw new Error(`expected a refusal, got ok with ${JSON.stringify(v.warnings)}`);
  return v;
}

// --- The 7 receipts held on 2026-11-03 (Task 2.1), reconstructed ----------

type HeldCase = {
  card: string;
  project_slug: string | null;
  desired_outcome: string;
  receipt: string;
  expected_complete_refusal: string[];
};
const HELD = JSON.parse(
  await Deno.readTextFile(
    new URL("scripts/open-engine/fixtures/complete-contract-held-receipts.json", ROOT),
  ),
) as { fixture_route: string; cases: HeldCase[] };

Deno.test("held receipts: the fixture holds exactly the seven Task 2.1 cards", () => {
  assertEquals(
    HELD.cases.map((c) => c.card).sort(),
    ["02b30e4d", "145d662a", "381943e7", "6e1395cf", "83a4acfa", "a92be35b", "d055613a"],
  );
});

for (const c of HELD.cases) {
  Deno.test(`held receipts: ${c.card} is refused at complete time with its actual reason`, () => {
    const v = refused(evaluateCompletion({
      receipt: c.receipt,
      task: { project_slug: c.project_slug, desired_outcome: c.desired_outcome, title: c.card },
      route: c.project_slug ? fresh(c.project_slug) : null,
      now: NOW,
    }));
    assertEquals(v.reasons, c.expected_complete_refusal);
    assertMatch(v.message, /^COMPLETE_REFUSED \(/);
    assertStringIncludes(v.message, "Nothing was written");
    assertEquals(v.repairable, true);
  });
}

Deno.test("held receipts: d055613a is refused for the deliverable, and the reference-only marker is what clears it", () => {
  const d = HELD.cases.find((c) => c.card === "d055613a")!;
  const task = { project_slug: d.project_slug, desired_outcome: d.desired_outcome, title: d.card };
  const before = refused(evaluateCompletion({ receipt: d.receipt, task, route: fresh("fixture-route"), now: NOW }));
  assertEquals(before.reasons, ["DELIVERABLE_WITHOUT_OPERATOR_ACTION"]);
  assertMatch(before.message, /staged a deliverable under deliverables\/ but carries no OPERATOR-ACTION marker/);
  const repaired = d.receipt.replace(
    "All acceptance points passed; nothing further is needed.",
    "All acceptance points passed.\nOPERATOR-ACTION: none (reference only)",
  );
  assertEquals(evaluateCompletion({ receipt: repaired, task, route: fresh("fixture-route"), now: NOW }), {
    ok: true,
    warnings: [],
  });
});

// --- Clean and compatible receipts -------------------------------------

Deno.test("clean: a full receipt on a fresh complete route passes with no warnings", () => {
  assertEquals(evaluateCompletion({ receipt: CLEAN, task: TASK, route: fresh("brain-bank"), now: NOW }), {
    ok: true,
    warnings: [],
  });
});

Deno.test("clean: an install marker with a URL, an absolute path or a relative path passes", () => {
  for (const target of ["https://example.com/x", "/abs/path/file.md", "deliverables/x/y.md"]) {
    const v = evaluateCompletion({
      receipt: receipt(`OPERATOR-ACTION: install it || OPERATOR-TARGET: ${target}`, "deliverables/x/y.md"),
      task: TASK,
      route: fresh("brain-bank"),
      now: NOW,
    });
    assertEquals(v, { ok: true, warnings: [] }, target);
  }
});

// Receipts that the closeout controller accepted before this change: every
// APPLYABLE fixture's latest AGENT DONE receipt passes at complete time.
for (
  const name of [
    "closeout-controller-applyable.json",
    "closeout-controller-operator-action-only.json",
    "closeout-controller-operator-action.json",
    "closeout-controller-inline-headings.json",
    "closeout-controller-duplicate-done-latest-wins.json",
  ]
) {
  Deno.test(`compat: the receipt that passed the old controller in ${name} passes at complete time`, async () => {
    const fx = JSON.parse(
      await Deno.readTextFile(new URL(`scripts/open-engine/fixtures/${name}`, ROOT)),
    );
    const tasks = (fx.tasks || []) as Array<Record<string, unknown>>;
    const task = tasks.find((t) => t.id === "9708e713-6f98-420a-9a39-22bbae011ec1") ?? tasks[0];
    const done = ((task.events || []) as Array<Record<string, unknown>>)
      .filter((e) => e.event_type === "AGENT DONE")
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    const payload = done.payload as Record<string, unknown>;
    const text = String(payload.reason ?? payload.result ?? done.text ?? "");
    assert(text.length > 0, "fixture receipt found");
    const v = evaluateCompletion({
      receipt: text,
      task: {
        project_slug: task.project_slug as string,
        desired_outcome: (task.desired_outcome as string) ?? null,
        title: (task.title as string) ?? null,
      },
      route: fresh(String(task.project_slug)),
      now: NOW,
    });
    assertEquals(v, { ok: true, warnings: [] });
  });
}

// --- Static refusals: each one the plan names ---------------------------

Deno.test("refusal: each of the 8 headings missing is refused, naming the heading (read from the shared list)", () => {
  assertEquals(REQUIRED_RECEIPT_SECTIONS.length, 8);
  for (const heading of REQUIRED_RECEIPT_SECTIONS) {
    const text = CLEAN.split("\n").filter((l) => !l.startsWith(`${heading}:`)).join("\n");
    const v = refused(evaluateCompletion({ receipt: text, task: TASK, route: fresh("brain-bank"), now: NOW }));
    assert(v.reasons.includes("RECEIPT_MISSING_SECTION"), heading);
    assertStringIncludes(v.message, canonicalHeading(heading));
  }
});

Deno.test("refusal: OPERATOR-TARGET present and not a URL or path", () => {
  const v = refused(evaluateCompletion({
    receipt: receipt("OPERATOR-ACTION: review || OPERATOR-TARGET: the client's intake page"),
    task: TASK,
    route: fresh("brain-bank"),
    now: NOW,
  }));
  assertEquals(v.reasons, ["OPERATOR_TARGET_NOT_URL_OR_PATH"]);
  assertMatch(v.message, /OPERATOR-TARGET must be a plain http\(s\) URL or filesystem path/);
  assertEquals(REASON_ALIASES.OPERATOR_TARGET_UNSAFE_SCHEME, "OPERATOR_TARGET_NOT_URL_OR_PATH");
  assert(!v.reasons.includes("OPERATOR_TARGET_UNSAFE_SCHEME"));
});

Deno.test("refusal: marker not line-anchored", () => {
  const v = refused(evaluateCompletion({
    receipt: receipt("Read it first. OPERATOR-ACTION: review || OPERATOR-TARGET: https://example.com"),
    task: TASK,
    route: fresh("brain-bank"),
    now: NOW,
  }));
  assertEquals(v.reasons, ["OPERATOR_MARKER_NOT_LINE_ANCHORED"]);
  assertMatch(v.message, /not on its own line/);
});

Deno.test("refusal: marker outside Follow-up recommendation", () => {
  const text = CLEAN.replace(
    "Limitations: none",
    "Limitations: none\nOPERATOR-ACTION: review || OPERATOR-TARGET: https://example.com",
  );
  const v = refused(evaluateCompletion({ receipt: text, task: TASK, route: fresh("brain-bank"), now: NOW }));
  assertEquals(v.reasons, ["OPERATOR_MARKER_OUTSIDE_FOLLOW_UP"]);
  assertMatch(v.message, /outside the Follow-up recommendation section/);
});

Deno.test("refusal: a named deliverables/ file with neither marker", () => {
  const v = refused(evaluateCompletion({
    receipt: receipt("none", "deliverables/brain-bank/x.md"),
    task: TASK,
    route: fresh("brain-bank"),
    now: NOW,
  }));
  assertEquals(v.reasons, ["DELIVERABLE_WITHOUT_OPERATOR_ACTION"]);
});

Deno.test("refusal: reference-only guards from Task 2.2 run at complete time too", () => {
  const ref = receipt("OPERATOR-ACTION: none (reference only)", "deliverables/brain-bank/r.md");
  assertEquals(
    evaluateCompletion({
      receipt: ref,
      task: { ...TASK, desired_outcome: "A verification report on x" },
      route: fresh("brain-bank"),
      now: NOW,
    }),
    { ok: true, warnings: [] },
  );
  assertEquals(
    refused(evaluateCompletion({
      receipt: ref,
      task: { ...TASK, desired_outcome: "A revised title tag ready to paste" },
      route: fresh("brain-bank"),
      now: NOW,
    })).reasons,
    ["REFERENCE_ONLY_SCOPE_MISMATCH"],
  );
  assertEquals(
    refused(evaluateCompletion({
      receipt: receipt("OPERATOR-ACTION: none (reference only)", "deliverables/brain-bank/patch.php"),
      task: { ...TASK, desired_outcome: "A verification report on x" },
      route: fresh("brain-bank"),
      now: NOW,
    })).reasons,
    ["REFERENCE_ONLY_ON_INSTALLABLE"],
  );
});

// --- Route check -----------------------------------------------------------

Deno.test("route: a null or blank project_slug is refused as repairable, with the route hint", () => {
  for (const slug of [null, undefined, "", "   "]) {
    const v = refused(evaluateCompletion({
      receipt: CLEAN,
      task: { ...TASK, project_slug: slug as string | null },
      route: null,
      now: NOW,
    }));
    assertEquals(v.reasons, ["MISSING_PROJECT_SLUG"]);
    assertEquals(v.route_reasons, ["MISSING_PROJECT_SLUG"]);
    assertEquals(v.static_reasons, []);
    assertStringIncludes(v.message, ROUTE_REPAIR_HINT);
  }
});

Deno.test("route: each capability false on a fresh snapshot is refused with the controller's reason", () => {
  const cases: Array<[keyof RouteSnapshotRow, string]> = [
    ["has_workspace", "UNRESOLVED_WORKSPACE_PATH"],
    ["has_tracker", "UNRESOLVED_TRACKER_PATH"],
    ["has_session_log", "UNRESOLVED_SESSION_LOG_PATH"],
    ["has_capture_tag", "MISSING_CAPTURE_TAG"],
  ];
  for (const [field, reason] of cases) {
    const v = refused(evaluateCompletion({
      receipt: CLEAN,
      task: TASK,
      route: fresh("brain-bank", { [field]: false }),
      now: NOW,
    }));
    assertEquals(v.reasons, [reason], field);
    assertStringIncludes(v.message, ROUTE_REPAIR_HINT);
  }
  // A null capability is not true: refused the same way.
  assertEquals(
    refused(evaluateCompletion({ receipt: CLEAN, task: TASK, route: fresh("brain-bank", { has_tracker: null }), now: NOW })).reasons,
    ["UNRESOLVED_TRACKER_PATH"],
  );
});

Deno.test("route: static and route reasons are reported together, static first", () => {
  const v = refused(evaluateCompletion({
    receipt: receipt("none", "deliverables/x/y.md"),
    task: { ...TASK, project_slug: null },
    route: null,
    now: NOW,
  }));
  assertEquals(v.reasons, ["DELIVERABLE_WITHOUT_OPERATOR_ACTION", "MISSING_PROJECT_SLUG"]);
});

// --- ROUTE_SNAPSHOT_UNAVAILABLE: accept with a warning, never refuse ---------

function warned(v: ReturnType<typeof evaluateCompletion>, pattern: RegExp) {
  if (!v.ok) throw new Error(`expected accept-with-warning, got refusal ${v.reasons.join(",")}`);
  assertEquals(v.warnings.length, 1);
  assertEquals(v.warnings[0].code, "ROUTE_SNAPSHOT_UNAVAILABLE");
  assertMatch(v.warnings[0].message, pattern);
}

Deno.test("unavailable: a snapshot older than 7 days accepts with a warning", () => {
  const stale = new Date(NOW.getTime() - ROUTE_SNAPSHOT_MAX_AGE_MS - 1).toISOString();
  warned(
    evaluateCompletion({ receipt: CLEAN, task: TASK, route: fresh("brain-bank", { published_at: stale }), now: NOW }),
    /older than 7 days/,
  );
});

Deno.test("unavailable: a stale snapshot with a false capability still accepts (stale is checked first)", () => {
  const stale = new Date(NOW.getTime() - 8 * 86400000).toISOString();
  warned(
    evaluateCompletion({
      receipt: CLEAN,
      task: TASK,
      route: fresh("brain-bank", { published_at: stale, has_tracker: false }),
      now: NOW,
    }),
    /older than 7 days/,
  );
});

Deno.test("unavailable: exactly at the 7-day edge the snapshot is still fresh", () => {
  const edge = new Date(NOW.getTime() - ROUTE_SNAPSHOT_MAX_AGE_MS).toISOString();
  assertEquals(
    evaluateCompletion({ receipt: CLEAN, task: TASK, route: fresh("brain-bank", { published_at: edge }), now: NOW }),
    { ok: true, warnings: [] },
  );
  assertEquals(
    refused(evaluateCompletion({
      receipt: CLEAN,
      task: TASK,
      route: fresh("brain-bank", { published_at: edge, has_capture_tag: false }),
      now: NOW,
    })).reasons,
    ["MISSING_CAPTURE_TAG"],
  );
});

Deno.test("unavailable: a slug absent from closeout_routes accepts with a warning", () => {
  warned(
    evaluateCompletion({ receipt: CLEAN, task: TASK, route: { row: null }, now: NOW }),
    /no row in closeout_routes/,
  );
});

Deno.test("unavailable: a failed snapshot read accepts with a warning", () => {
  warned(
    evaluateCompletion({
      receipt: CLEAN,
      task: TASK,
      route: { row: null, error: 'relation "public.closeout_routes" does not exist' },
      now: NOW,
    }),
    /snapshot read failed/,
  );
  warned(evaluateCompletion({ receipt: CLEAN, task: TASK, route: null, now: NOW }), /snapshot read failed/);
});

Deno.test("unavailable: an unparseable or far-future published_at accepts with a warning", () => {
  warned(
    evaluateCompletion({ receipt: CLEAN, task: TASK, route: fresh("brain-bank", { published_at: null }), now: NOW }),
    /not a timestamp/,
  );
  warned(
    evaluateCompletion({ receipt: CLEAN, task: TASK, route: fresh("brain-bank", { published_at: "yesterday" }), now: NOW }),
    /not a timestamp/,
  );
  const future = new Date(NOW.getTime() + 2 * 3600000).toISOString();
  warned(
    evaluateCompletion({ receipt: CLEAN, task: TASK, route: fresh("brain-bank", { published_at: future }), now: NOW }),
    /in the future/,
  );
  const nearFuture = new Date(NOW.getTime() + 30 * 60000).toISOString();
  assertEquals(
    evaluateCompletion({ receipt: CLEAN, task: TASK, route: fresh("brain-bank", { published_at: nearFuture }), now: NOW }),
    { ok: true, warnings: [] },
  );
});

Deno.test("unavailable: a receipt defect is still refused when the snapshot is unavailable", () => {
  const v = refused(evaluateCompletion({
    receipt: receipt("none", "deliverables/x/y.md"),
    task: TASK,
    route: { row: null },
    now: NOW,
  }));
  assertEquals(v.reasons, ["DELIVERABLE_WITHOUT_OPERATOR_ACTION"]);
});

Deno.test("evaluateRoute: the warning names the slug and never a path", () => {
  const r = evaluateRoute("brain-bank", { row: null }, NOW);
  assertEquals(r.reasons, []);
  assertStringIncludes(r.warnings[0].message, "'brain-bank'");
  assert(!/\/Users\//.test(r.warnings[0].message));
});

// --- Wiring in index.ts (source contract; the end-to-end proof is
// scripts/open-engine/complete-contract-probe-harness.ts) -------------------

Deno.test("wiring: moveAgentTaskViaTool evaluates the completion before move_agent_task_status", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const fnStart = src.indexOf("async function moveAgentTaskViaTool(");
  const fnEnd = src.indexOf("\nasync function ", fnStart + 10);
  const body = src.slice(fnStart, fnEnd);
  const check = body.indexOf("evaluateCompletion({");
  const rpc = body.indexOf('supabase.rpc("move_agent_task_status"');
  assert(fnStart > 0 && check > 0 && rpc > 0, "both calls present inside moveAgentTaskViaTool");
  assert(check < rpc, "the contract check runs before the write");
  assertStringIncludes(body, 'if (args.action === "complete" || args.action === "request-review") {');
  assertStringIncludes(body, "      throw new Error(verdict.message);");
});
