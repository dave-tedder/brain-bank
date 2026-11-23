#!/usr/bin/env node
// Loop-closing Task 5.4: mutants for the complete-time receipt contract, the
// shared module, the controller wiring, the publisher and the parity script.
//
//   node scripts/open-engine/receipt-contract-mutants.mjs --old <base closeout-controller.mjs>
//   (optional) --only <name,name>
//
// Each mutant edits ONE site (the edit must match exactly once, or the mutant is
// NEVER-RAN) in a fresh copy of the tree, then runs the ONE suite named for it.
// It counts as CAUGHT only when that suite completes and the check named for the
// mutant is among its failures; a different failure, a suite that does not
// finish, or a suite with no test count is NEVER-RAN, never a catch. Before any
// mutant, every suite must pass on an unmutated copy (the controls).
//
// Three outcomes: exit 0 every mutant CAUGHT; exit 1 a mutant SURVIVED (or was
// caught only by an unrelated check); exit 2 NEVER-RAN (a control failed or a
// mutant did not run to a verdict).

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectInvocation } from "./entrypoint-guard.mjs";

const ROOT = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "..", "..");
const SUITE_TIMEOUT_MS = 600_000;

const S = "supabase/functions/_shared/receipt-shape.js";
const C = "supabase/functions/open-brain-mcp/_complete_contract.ts";
const I = "supabase/functions/open-brain-mcp/index.ts";
const K = "scripts/open-engine/closeout-controller.mjs";
const P = "scripts/open-engine/publish-route-snapshot.mjs";
const Y = "scripts/open-engine/receipt-shape-parity.mjs";

export const SUITES = {
  deno: (old) => ["deno", ["test", "--no-lock", "--allow-read", "--allow-env", "supabase/functions/open-brain-mcp/_complete_contract_test.ts"]],
  shape: () => ["node", ["--test", "scripts/open-engine/receipt-shape.test.mjs"]],
  controller: () => ["node", ["--test", "scripts/open-engine/closeout-controller.test.mjs", "scripts/open-engine/closeout-handoff.test.mjs"]],
  publisher: () => ["node", ["--test", "scripts/open-engine/publish-route-snapshot.test.mjs"]],
  probe: () => ["deno", ["run", "--config", "scripts/loop-closing/closeout-capture-probe.deno.json", "--no-lock", "--allow-net", "--allow-env", "--allow-read", "scripts/open-engine/complete-contract-probe-harness.ts"]],
  parity: (old) => ["node", ["scripts/open-engine/receipt-shape-parity.mjs", "--old", old]],
};

// [name, file, from, to, suite, check]: check is a regex over the suite's
// failing test names (node/deno), its FAIL lines (probe) or its status (parity).
export const MUTANTS = [
  // Static refusal paths, in the shared module.
  ["missing-section-unchecked", S, `  if (augmentation.missing.length > 0) reasons.push("RECEIPT_MISSING_SECTION");`, ``, "deno", /each of the 8 headings missing/],
  ["target-check-dropped", S, `    if (operator_target && !isSafeOperatorTarget(operator_target)) {`, `    if (false) {`, "deno", /OPERATOR-TARGET present and not a URL or path/],
  ["rename-reverted", S, `      return { operator: null, reasons: ["OPERATOR_TARGET_NOT_URL_OR_PATH"] };`, `      return { operator: null, reasons: ["OPERATOR_TARGET_UNSAFE_SCHEME"] };`, "controller", /anchored marker with prose target/],
  ["line-anchor-dropped", S, `    reasons.push("OPERATOR_MARKER_NOT_LINE_ANCHORED");`, `    void 0;`, "deno", /marker not line-anchored/],
  ["outside-follow-up-dropped", S, `    reasons.push("OPERATOR_MARKER_OUTSIDE_FOLLOW_UP");`, `    void 0;`, "deno", /marker outside Follow-up recommendation/],
  ["deliverable-gate-dropped", S, `  if (stagedDeliverable && !operator.operator) {`, `  if (false) {`, "deno", /a named deliverables\/ file with neither marker/],
  ["scope-guard-dropped", S, `      reasons.push("REFERENCE_ONLY_SCOPE_MISMATCH");`, `      void 0;`, "deno", /reference-only guards from Task 2\.2/],
  ["capability-truthy", S, `    .filter(({ field }) => caps?.[field] !== true)`, `    .filter(({ field }) => !caps?.[field])`, "shape", /route capabilities: the shared mapping/],
  ["capability-ignores-filesystem", S, `      : Boolean(route?.[path]) && Boolean(pathExists(route[path]));`, `      : Boolean(route?.[path]);`, "publisher", /snapshot: four booleans per key/],
  // Route check and the warning path, in _complete_contract.ts.
  ["null-slug-accepted", C, `    routeReasons = ["MISSING_PROJECT_SLUG"];`, `    routeReasons = [];`, "deno", /a null or blank project_slug is refused/],
  ["capability-false-accepted", C, `  return { reasons: routeCapabilityReasons(caps), warnings: [] };`, `  return { reasons: [], warnings: [] };`, "deno", /each capability false on a fresh snapshot/],
  ["stale-not-checked", C, `  if (age > ROUTE_SNAPSHOT_MAX_AGE_MS) {`, `  if (age > Infinity) {`, "deno", /a snapshot older than 7 days accepts with a warning/],
  ["stale-edge-inclusive", C, `  if (age > ROUTE_SNAPSHOT_MAX_AGE_MS) {`, `  if (age >= ROUTE_SNAPSHOT_MAX_AGE_MS) {`, "deno", /exactly at the 7-day edge/],
  ["stale-refuses", C, "      reasons: [],\n      warnings: [snapshotWarning(slug, `published ${row.published_at}, older than 7 days`)],", "      reasons: [\"ROUTE_SNAPSHOT_UNAVAILABLE\"],\n      warnings: [snapshotWarning(slug, `published ${row.published_at}, older than 7 days`)],", "deno", /a snapshot older than 7 days accepts with a warning/],
  ["stale-reads-capabilities", C, "      reasons: [],\n      warnings: [snapshotWarning(slug, `published ${row.published_at}, older than 7 days`)],", "      reasons: routeCapabilityReasons(row),\n      warnings: [snapshotWarning(slug, `published ${row.published_at}, older than 7 days`)],", "deno", /a stale snapshot with a false capability still accepts/],
  ["absent-refuses", C, `    return { reasons: [], warnings: [snapshotWarning(slug, "no row in closeout_routes")] };`, `    return { reasons: ["UNKNOWN_PROJECT_ROUTE"], warnings: [snapshotWarning(slug, "no row in closeout_routes")] };`, "deno", /a slug absent from closeout_routes accepts with a warning/],
  ["read-error-refuses", C, "      reasons: [],\n      warnings: [snapshotWarning(slug, `the snapshot read failed", "      reasons: [\"ROUTE_SNAPSHOT_UNAVAILABLE\"],\n      warnings: [snapshotWarning(slug, `the snapshot read failed", "deno", /a failed snapshot read accepts with a warning/],
  ["future-trusted", C, `  if (age < -ROUTE_SNAPSHOT_FUTURE_SKEW_MS) {`, `  if (age < -Infinity) {`, "deno", /an unparseable or far-future published_at/],
  ["warning-dropped", C, `  if (reasons.length === 0) return { ok: true, warnings };`, `  if (reasons.length === 0) return { ok: true, warnings: [] };`, "deno", /a snapshot older than 7 days accepts with a warning/],
  // The wiring in index.ts, judged end to end by the probe harness.
  // The refusal turned into a pass-through: the write then happens.
  ["refusal-still-writes", I, `      throw new Error(verdict.message);\n    }\n    warnings = verdict.warnings;`, `      void verdict.message;\n    }\n    warnings = verdict.ok ? verdict.warnings : [];`, "probe", /^FAIL P2 [0-9a-f]{8}: accepted/],
  ["check-skipped", I, `  if (args.action === "complete" || args.action === "request-review") {`, `  if (args.action === ("never" as string)) {`, "probe", /^FAIL P[12][ :]/],
  ["request-review-unchecked", I, `  if (args.action === "complete" || args.action === "request-review") {`, `  if (args.action === "complete") {`, "probe", /^FAIL P7:/],
  ["refusal-not-logged", I, "        `[complete-contract] COMPLETE_REFUSED task=${args.taskId} action=${args.action} reasons=${", "        `[complete-contract] refused task=${args.taskId} action=${args.action} reasons=${", "probe", /^FAIL P2 /],
  ["warning-not-logged", I, "    for (const w of warnings) {\n      console.log(", "    for (const w of [] as CompletionWarning[]) {\n      console.log(", "probe", /^FAIL P5 /],
  ["warnings-not-returned", I, "  return warnings.length > 0\n    ? { receipt, task: data, warnings }\n    : { receipt, task: data };", "  return { receipt, task: data };", "probe", /^FAIL P5 /],
  ["route-read-wrong-slug", I, `      .select(ROUTE_SNAPSHOT_COLUMNS)\n      .eq("slug", slug)`, `      .select(ROUTE_SNAPSHOT_COLUMNS)\n      .eq("slug", slug.toUpperCase())`, "probe", /^FAIL P1:/],
  // A read error reported as "no row" (the warning would say the route is
  // missing when the read failed). The catch block below it is defensive only:
  // supabase-js returns fetch failures as `error`, so a throw never reaches it.
  ["route-read-error-as-absent", I, `    if (error) return { row: null, error: error.message || String(error) };`, `    if (error) return { row: null };`, "probe", /^FAIL P5 read error/],
  // The controller's use of the shared module, judged by parity with the base.
  ["controller-route-check-dropped", K, `    reasons.push(...routeCapabilityReasons(routeCapabilities(route, existsSync)));`, ``, "parity", /^DIFFERENT$/],
  ["controller-drops-review-note", K, `    reviewReason: task.review_reason,`, `    reviewReason: null,`, "parity", /^DIFFERENT$/],
  ["hold-message-reworded", S, "  return `Task held by dry-run safety gates: ${reasons.join(\", \")}.`;", "  return `Task held: ${reasons.join(\", \")}.`;", "parity", /^DIFFERENT$/],
  // The publisher.
  ["publisher-leaks-path", P, `      has_capture_tag: caps.has_capture_tag === true,\n    });`, `      has_capture_tag: caps.has_capture_tag === true,\n      workspace_path: entry.workspace_path,\n    });`, "publisher", /five fields only/],
  ["publisher-ignores-4xx", P, `  if (!response.ok) {`, `  if (false) {`, "publisher", /^outcomes: PARTIAL/],
  ["publisher-partial-exits-0", P, `    code: skipped.length > 0 ? 1 : 0,`, `    code: 0,`, "publisher", /^outcomes: PARTIAL/],
  ["publisher-publishes-bad-key", P, `    if (!ROUTE_KEY_PATTERN.test(key)) {`, `    if (false) {`, "publisher", /keys that are not route-key shaped/],
  ["publisher-raw-argv-guard", P, `if (isDirectInvocation(import.meta.url)) main();`, `if (process.argv[1] === fileURLToPath(import.meta.url)) main();`, "publisher", /symlinked directory whose path has spaces/],
  // The parity script itself.
  ["parity-blind", Y, `        if (JSON.stringify(oldResult) !== JSON.stringify(newResult)) {`, `        if (false) {`, "shape", /doctored old controller/],
];

function copyTree() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "oe-receipt-mut-"));
  cpSync(join(ROOT, "supabase", "functions"), join(dir, "supabase", "functions"), { recursive: true });
  cpSync(join(ROOT, "scripts", "open-engine"), join(dir, "scripts", "open-engine"), { recursive: true, verbatimSymlinks: true });
  cpSync(join(ROOT, "scripts", "loop-closing", "closeout-capture-probe.deno.json"), join(dir, "scripts", "loop-closing", "closeout-capture-probe.deno.json"));
  cpSync(join(ROOT, "deno.json"), join(dir, "deno.json"));
  return dir;
}

export function failuresOf(suite, run) {
  const text = `${run.stdout || ""}\n${run.stderr || ""}`.replace(/\u001b\[[0-9;]*m/g, "");
  if (suite === "probe") {
    const fails = [...text.matchAll(/^FAIL .*$/gm)].map((m) => m[0]);
    const complete = /^COMPLETE CONTRACT PROBE PASSED$/m.test(text) || fails.length > 0;
    return { complete, total: complete ? 1 : null, failures: fails };
  }
  if (suite === "parity") {
    const m = text.match(/"status": "([A-Z-]+)"/);
    const status = m ? m[1] : null;
    return { complete: status === "PARITY" || status === "DIFFERENT", total: status ? 1 : null, failures: status === "DIFFERENT" ? ["DIFFERENT"] : [] };
  }
  const node = text.match(/^ℹ tests (\d+)$/m);
  const deno = text.match(/(?:ok|FAILED) \| (\d+) passed(?: \([^)]*\))? \| (\d+) failed/);
  const total = node ? Number(node[1]) : deno ? Number(deno[1]) + Number(deno[2]) : null;
  const failures = [...new Set(
    [...text.matchAll(/^(?:✖ (.+?)(?: \(\d[^)]*\))?|(.+?) \.\.\. FAILED.*)$/gm)].map((m) => (m[1] || m[2]).trim()),
  )].filter((name) => name !== "failing tests:");
  return { complete: total !== null, total, failures };
}

function runSuite(dir, suite, old) {
  const [cmd, args] = SUITES[suite](old);
  const run = spawnSync(cmd, args, { cwd: dir, encoding: "utf8", timeout: SUITE_TIMEOUT_MS, killSignal: "SIGKILL" });
  return { run, ...failuresOf(suite, run), timedOut: run.error?.code === "ETIMEDOUT" || run.signal === "SIGKILL" };
}

function applyMutant(dir, file, from, to) {
  const path = join(dir, file);
  const src = readFileSync(path, "utf8");
  const count = src.split(from).length - 1;
  if (count !== 1) return `the edit matched ${count} sites, not exactly one`;
  writeFileSync(path, src.replace(from, to));
  return null;
}

export async function main(argv = process.argv.slice(2)) {
  const oi = argv.indexOf("--old");
  const old = oi >= 0 ? resolve(argv[oi + 1] || "") : null;
  if (!old || !existsSync(old)) {
    console.log("NEVER-RAN: --old <path to the base closeout-controller.mjs> is required");
    return 2;
  }
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1].split(",") : null;
  const mutants = only ? MUTANTS.filter(([name]) => only.includes(name)) : MUTANTS;
  if (mutants.length === 0) { console.log("NEVER-RAN: no mutant selected"); return 2; }

  // Controls: every suite a selected mutant uses must pass on an unmutated copy.
  const control = copyTree();
  try {
    for (const suite of [...new Set(mutants.map((m) => m[4]))]) {
      const r = runSuite(control, suite, old);
      if (r.timedOut || !r.complete || r.run.status !== 0 || r.failures.length > 0) {
        console.log(`NEVER-RAN: control for suite ${suite} did not pass (exit ${r.run.status}, ${r.failures[0] || "no test count"})`);
        return 2;
      }
      console.log(`CONTROL ok ${suite} (${r.total} ${suite === "probe" || suite === "parity" ? "run" : "tests"})`);
    }
  } finally {
    rmSync(control, { recursive: true, force: true });
  }

  let caught = 0, survived = 0, never = 0;
  for (const [name, file, from, to, suite, check] of mutants) {
    const dir = copyTree();
    try {
      const bad = applyMutant(dir, file, from, to);
      if (bad) { never += 1; console.log(`NEVER-RAN ${name}: ${bad}`); continue; }
      const r = runSuite(dir, suite, old);
      if (r.timedOut || !r.complete) {
        never += 1; console.log(`NEVER-RAN ${name}: suite ${suite} did not complete (exit ${r.run.status})`); continue;
      }
      const hit = r.failures.find((f) => check.test(f));
      if (hit) { caught += 1; console.log(`CAUGHT    ${name}: ${suite}: ${hit.slice(0, 160)}`); }
      else if (r.failures.length > 0) { survived += 1; console.log(`SURVIVED  ${name}: ${suite} failed only unrelated checks: ${r.failures.slice(0, 3).join(" | ").slice(0, 200)}`); }
      else { survived += 1; console.log(`SURVIVED  ${name}: ${suite} passed`); }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(`SWEEP: ${mutants.length} mutants, ${caught} caught, ${survived} survived, ${never} never ran`);
  if (never > 0) return 2;
  if (survived > 0) return 1;
  console.log(`ALL ${mutants.length} MUTANTS CAUGHT`);
  return 0;
}

if (isDirectInvocation(import.meta.url)) main().then((code) => process.exit(code));
