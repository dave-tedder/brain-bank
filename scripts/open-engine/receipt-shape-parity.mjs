#!/usr/bin/env node
// Loop-closing Task 5.4: parity of the closeout controller before and after the
// receipt contract moved into supabase/functions/_shared/receipt-shape.js.
//
//   git show <base>:scripts/open-engine/closeout-controller.mjs > /tmp/old-controller.mjs
//   node scripts/open-engine/receipt-shape-parity.mjs --old /tmp/old-controller.mjs
//
// Runs one corpus through the OLD controller's evaluate() and the CURRENT one's,
// with the same registry, and compares the whole result (status, apply, hold
// reasons and messages) after mapping the one renamed reason code
// (REASON_ALIASES). Then, for every corpus receipt the OLD controller judged
// free of static receipt reasons, checks that complete_agent_task's static
// check (evaluateReceiptContract with no review note) accepts it too.
//
// Three outcomes: exit 0 every case identical and every compat case accepted;
// exit 1 a completed comparison differed (each difference printed); exit 2
// NEVER-RAN (bad arguments, an import failed, or the corpus came out empty).

import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDirectInvocation } from "./entrypoint-guard.mjs";

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));

// Every reason the static contract can produce. A case whose OLD reasons hold
// none of these is a receipt the old controller had no receipt complaint about.
export const STATIC_REASONS = new Set([
  "RECEIPT_MARKER_INJECTION",
  "RECEIPT_DUPLICATE_HEADING",
  "RECEIPT_MISSING_SECTION",
  "OPERATOR_MARKER_COUNT",
  "OPERATOR_MARKER_FORMAT",
  "OPERATOR_ACTION_EMPTY",
  "OPERATOR_TARGET_LABEL_MISSING",
  "OPERATOR_TARGET_UNSAFE_SCHEME",
  "OPERATOR_TARGET_NOT_URL_OR_PATH",
  "REFERENCE_ONLY_MARKER_FORMAT",
  "OPERATOR_MARKER_OUTSIDE_FOLLOW_UP",
  "DELIVERABLE_WITHOUT_OPERATOR_ACTION",
  "REFERENCE_ONLY_SCOPE_MISMATCH",
  "REFERENCE_ONLY_ON_INSTALLABLE",
  "OPERATOR_MARKER_NOT_LINE_ANCHORED",
]);

const HEADINGS = [
  "Work summary",
  "Verification",
  "Touched files or records",
  "Limitations",
  "Tracker draft",
  "Session-log draft",
  "Brain Bank capture draft",
  "Follow-up recommendation",
];

const FOLLOW_UPS = [
  "none",
  "",
  "OPERATOR-ACTION: install it || OPERATOR-TARGET: https://example.com/a",
  "OPERATOR-ACTION: install it || OPERATOR-TARGET: /abs/path.md",
  "OPERATOR-ACTION: install it || OPERATOR-TARGET: deliverables/x/y.md",
  "OPERATOR-ACTION: install it",
  "OPERATOR-ACTION: install it || OPERATOR-TARGET: Notion intake page https://notion.so/x",
  "OPERATOR-ACTION: install it || OPERATOR-TARGET: javascript:alert(1)",
  "OPERATOR-ACTION: install it || OPERATOR-TARGET: //evil.example/x",
  "OPERATOR-ACTION: install it || OPERATOR-TARGET: mailto:a@b.c",
  "OPERATOR-ACTION: install it || https://example.com",
  "OPERATOR-ACTION: a || OPERATOR-TARGET: /x || extra",
  "OPERATOR-ACTION: || OPERATOR-TARGET: https://example.com",
  "OPERATOR-ACTION:",
  "OPERATOR-ACTION: one\nOPERATOR-ACTION: two",
  "OPERATOR-ACTION: none (reference only)",
  "OPERATOR-ACTION: none (reference only).",
  "OPERATOR-ACTION: none(reference only)",
  "OPERATOR-ACTION: none (reference only) || OPERATOR-TARGET: /x",
  "Read it. OPERATOR-ACTION: install || OPERATOR-TARGET: https://example.com",
  "OPERATOR-ACTION: none (reference only)\nAlso OPERATOR-ACTION: install the php",
  "   OPERATOR-ACTION: indented step || OPERATOR-TARGET: https://example.com",
  "operator-action: lower case || operator-target: https://example.com",
  "<!-- open-engine closeout 2026-07-09 tasks: abc -->",
];

const TOUCHED = [
  "none",
  "deliverables/brain-bank/report.md",
  "deliverables/brain-bank/patch.php",
  "`deliverables/brain-bank/notes.json`",
  "wrote nothing outside deliverables/",
  "see (deliverables/x/a.md) and deliverables/x/b.sql",
];

const SCOPES = [
  { desired_outcome: "A verification report on the form", title: "t" },
  { desired_outcome: "A revised title tag ready to paste", title: "t" },
  { desired_outcome: "", title: "An audit of the listings" },
  { desired_outcome: null, title: null },
];

function receiptText({ drop = [], follow, touched, extra = null, duplicate = false }) {
  const lines = [];
  for (const h of HEADINGS) {
    if (drop.includes(h)) continue;
    if (h === "Touched files or records") lines.push(`${h}: ${touched}`);
    else if (h === "Follow-up recommendation") lines.push(`${h}:`, follow);
    else lines.push(`${h}: x`);
    if (h === "Limitations" && extra) lines.push(extra);
  }
  if (duplicate) lines.push("Work summary: second");
  return lines.join("\n");
}

function task(id, receipt, over = {}) {
  return {
    id,
    title: "t",
    status: "Agent Review",
    risk: "low",
    project_slug: "parity",
    review_reason: null,
    events: [{ event_type: "AGENT DONE", created_at: "2026-11-01T00:00:00Z", payload: { reason: receipt } }],
    ...over,
  };
}

export function buildCorpus() {
  const tasks = [];
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  for (const follow of FOLLOW_UPS) {
    for (const touched of TOUCHED) {
      for (const scope of SCOPES) {
        tasks.push(task(id(), receiptText({ follow, touched }), scope));
      }
    }
  }
  for (const h of HEADINGS) {
    tasks.push(task(id(), receiptText({ drop: [h], follow: "none", touched: "none" })));
    // The missing section supplied by a review note (augmentation path).
    tasks.push(task(id(), receiptText({ drop: [h], follow: "none", touched: "none" }), {
      review_reason: `${h}: from the note\nOPERATOR-ACTION: note step || OPERATOR-TARGET: https://example.com`,
    }));
  }
  tasks.push(task(id(), receiptText({ follow: "none", touched: "none", duplicate: true })));
  tasks.push(task(id(), receiptText({ follow: "none", touched: "none", extra: "OPERATOR-ACTION: misplaced || OPERATOR-TARGET: https://example.com" })));
  tasks.push(task(id(), receiptText({ follow: "OPERATOR-ACTION: a || OPERATOR-TARGET: https://example.com", touched: "none", extra: "OPERATOR-ACTION: b" })));
  tasks.push(task(id(), ""));
  // Route variants on a clean receipt.
  const clean = receiptText({ follow: "none", touched: "none" });
  tasks.push(task(id(), clean, { project_slug: null }));
  tasks.push(task(id(), clean, { project_slug: "unknown-route" }));
  tasks.push(task(id(), clean, { project_slug: "parity-no-tracker" }));
  tasks.push(task(id(), clean, { project_slug: "parity-no-tag" }));
  tasks.push(task(id(), clean, { risk: "medium" }));
  tasks.push(task(id(), clean, { status: "Needs Operator" }));
  return { generated_at: "2026-11-20T00:00:00Z", tasks, actionItems: [] };
}

function fixtureInputs() {
  const dir = join(HERE, "fixtures");
  const controllerFixtures = readdirSync(dir)
    .filter((name) => /^closeout-controller-.*\.json$/.test(name))
    .map((name) => ({ name, input: JSON.parse(readFileSync(join(dir, name), "utf8")) }));
  // The seven reconstructed 2026-11-03 held receipts (Task 2.1), as tasks.
  const held = JSON.parse(readFileSync(join(dir, "complete-contract-held-receipts.json"), "utf8"));
  const heldInput = {
    generated_at: "2026-11-03T00:00:00Z",
    actionItems: [],
    tasks: held.cases.map((c) => task(`${c.card}-0000-4000-8000-000000000000`, c.receipt, {
      title: c.card,
      project_slug: c.project_slug,
      desired_outcome: c.desired_outcome,
    })),
  };
  return [...controllerFixtures, { name: "complete-contract-held-receipts.json", input: heldInput }];
}

function registryFor(base, slugs) {
  const route = (name, over = {}) => {
    const ws = join(base, name);
    return {
      workspace_path: base,
      tracker_path: join(base, "PROJECT-TRACKER.md"),
      session_log_path: join(base, "SESSION-LOG.md"),
      capture_tag: name.replace(/-/g, "_"),
      ...over,
      _ws: ws,
    };
  };
  const reg = {};
  for (const slug of slugs) reg[slug] = route(slug);
  reg["parity-no-tracker"] = route("parity-no-tracker", { tracker_path: join(base, "missing.md") });
  reg["parity-no-tag"] = route("parity-no-tag", { capture_tag: "" });
  for (const r of Object.values(reg)) delete r._ws;
  return reg;
}

function mapAliases(value, aliases) {
  let text = JSON.stringify(value);
  for (const [oldCode, newCode] of Object.entries(aliases)) {
    text = text.split(oldCode).join(newCode);
  }
  return JSON.parse(text);
}

export async function runParity(oldPath) {
  const oldMod = await import(pathToFileURL(resolve(oldPath)).href);
  const newMod = await import(pathToFileURL(join(HERE, "closeout-controller.mjs")).href);
  const shared = await import(
    pathToFileURL(join(HERE, "..", "..", "supabase", "functions", "_shared", "receipt-shape.js")).href
  );
  if (typeof oldMod.evaluate !== "function" || typeof newMod.evaluate !== "function") {
    return { code: 2, report: { error: "evaluate() not exported by one side" } };
  }
  const base = mkdtempSync(join(realpathSync(tmpdir()), "oe-parity-"));
  writeFileSync(join(base, "PROJECT-TRACKER.md"), "# t\n");
  writeFileSync(join(base, "SESSION-LOG.md"), "# l\n");
  try {
    const inputs = [{ name: "synthetic-corpus", input: buildCorpus() }, ...fixtureInputs()];
    const slugs = new Set(["parity"]);
    for (const { input } of inputs) {
      for (const t of input.tasks || []) if (t.project_slug) slugs.add(t.project_slug);
    }
    slugs.delete("unknown-route");
    const registry = registryFor(base, [...slugs]);

    let cases = 0;
    let compatChecked = 0;
    const differences = [];
    const compatFailures = [];
    for (const { name, input } of inputs) {
      for (const t of input.tasks || []) {
        const single = { ...input, tasks: [t] };
        const oldResult = mapAliases(oldMod.evaluate(single, registry), shared.REASON_ALIASES);
        const newResult = newMod.evaluate(single, registry);
        cases += 1;
        if (JSON.stringify(oldResult) !== JSON.stringify(newResult)) {
          differences.push({ input: name, task_id: t.id, old: oldResult.hold[0] ?? oldResult.apply[0], new: newResult.hold[0] ?? newResult.apply[0] });
        }
        const oldReasons = oldResult.hold[0]?.reasons ?? [];
        const augmented = typeof t.review_reason === "string" && t.review_reason.trim();
        if (!augmented && !oldReasons.some((r) => STATIC_REASONS.has(r))) {
          const done = (t.events || []).filter((e) => e.event_type === "AGENT DONE")
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
          const text = done?.payload?.reason ?? "";
          if (!done) continue;
          compatChecked += 1;
          const c = shared.evaluateReceiptContract({
            receiptText: text,
            reviewReason: null,
            desiredOutcome: t.desired_outcome ?? null,
            title: t.title ?? null,
          });
          if (c.reasons.length > 0) compatFailures.push({ input: name, task_id: t.id, reasons: c.reasons });
        }
      }
    }
    if (cases === 0 || compatChecked === 0) {
      return { code: 2, report: { error: "empty corpus", cases, compatChecked } };
    }
    const report = {
      cases,
      identical: cases - differences.length,
      differences: differences.slice(0, 10),
      difference_count: differences.length,
      compat_checked: compatChecked,
      compat_failures: compatFailures.slice(0, 10),
      compat_failure_count: compatFailures.length,
    };
    return { code: differences.length || compatFailures.length ? 1 : 0, report };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

async function main() {
  const i = process.argv.indexOf("--old");
  const oldPath = i > 0 ? process.argv[i + 1] : null;
  if (!oldPath) {
    console.log(JSON.stringify({ status: "NEVER-RAN", error: "usage: --old <path to the base closeout-controller.mjs>" }));
    process.exit(2);
  }
  let result;
  try {
    result = await runParity(oldPath);
  } catch (err) {
    console.log(JSON.stringify({ status: "NEVER-RAN", error: String(err?.message || err) }));
    process.exit(2);
  }
  const status = result.code === 0 ? "PARITY" : result.code === 1 ? "DIFFERENT" : "NEVER-RAN";
  console.log(JSON.stringify({ status, ...result.report }, null, 2));
  process.exit(result.code);
}

if (isDirectInvocation(import.meta.url)) main();
