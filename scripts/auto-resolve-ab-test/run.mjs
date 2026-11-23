#!/usr/bin/env -S deno run --allow-net --allow-env
// Auto-resolve A/B harness: LAYER 2 model replay PLUS the deterministic gates.
//
// Runs the SAME LAYER 2 prompt from checkAutoResolve() against one or more
// models on OpenRouter, then applies the real LAYER 3 subject-coverage guard
// and the real LAYER 3.5 still-owed veto (imported from the Edge Function
// sources, not ported) to the model's claims, and scores the final outcome
// against the test corpus below (7 cases: 4 FPs that MUST NOT resolve, 3
// legits that MUST resolve). For each FP it reports which gate stopped it.
//
// Usage (Deno, so the .ts gates import directly):
//   export OPENROUTER_API_KEY=sk-or-...      # never on the command line
//   deno run --allow-net --allow-env scripts/auto-resolve-ab-test/run.mjs \
//     --models anthropic/claude-sonnet-4.6 [--reruns 10]
//   deno run scripts/auto-resolve-ab-test/run.mjs --layer3-only   # metric only, no network
//
// Add more models with --models (comma-separated). Add more test cases by
// appending to TEST_CASES (each case carries the new thought, scope, candidate
// list, and expected resolution indexes). LAYER3_CASES holds the full logged
// quote/description pairs the metric is scored on.

import process from "node:process";
import {
  SUBJECT_COVERAGE_THRESHOLD,
  stem,
  subjectCoverage,
} from "../../supabase/functions/_shared/quote-coverage.ts";
import { stillOwedAdjacencyVeto } from "../../supabase/functions/_shared/still-owed-veto.ts";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
// Read lazily so --layer3-only runs with no env permission at all.
const OPENROUTER_API_KEY = () => process.env.OPENROUTER_API_KEY;

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const LAYER3_ONLY = process.argv.includes("--layer3-only");

// Models under test. Production is anthropic/claude-sonnet-4.6; override with
// --models a,b,c for an ablation.
const MODELS = argValue("--models", "anthropic/claude-sonnet-4.6").split(",").map((m) => m.trim()).filter(Boolean);

// Keep this snapshot byte-identical to the prompt in both capture functions.
const SYSTEM_PROMPT = `You check whether a new note explicitly resolves any open action items.

Return JSON shaped as: {"resolved": [{"num": 1, "reason": "short quote from the note"}]}
If no items are clearly resolved, return {"resolved": []}.

HARD RULES — a match requires ALL of these:
1. The new note explicitly and specifically references the action item's subject. Vague overlap ("I shipped some stuff", "polished the UI") does NOT resolve anything. A generic verb match ("fix", "update", "deploy", "check", "monitor") is NEVER enough on its own.
2. The note describes the action as DONE, SCHEDULED, or EXPLICITLY CANCELLED. Progress reports, related work, or similar-sounding updates do not count.
3. The new note and the action item must be about the same concrete thing. If the action item is a specific bug, file, feature, client, or errand, the note must name or unambiguously describe that same thing.
4. If the candidate context says "project=X" and the note's context is a different project, do NOT mark it resolved even if wording overlaps. Cross-project auto-resolves are forbidden unless the note explicitly names the other project.
5. READINESS, UNBLOCKING, or STILL-TO-DO SIGNALS NEVER resolve anything. A note phrased with a verb or marker that describes the PRE-WORK state — "unblocked", "cleared", "un-gated", "ready", "readied", "prepped", "prepared", "queued", "slated", "planned", "staged", "teed up", "lined up", "kicked off", "approved", or "authorized" — OR a marker that explicitly frames work as NOT YET DONE — "remaining", "outstanding", "to-do", "todo", "deferred", "pending", "yet to", "still to", "still need", "next", "follows", "to follow" — is announcing that work is about to BEGIN or is still owed, not that it has been completed. Even if the subject matches a candidate exactly, do NOT resolve — "X unblocked" or "Remaining: X" means X is still on the list, not that X has been done. Return [] for this entry.
6. When unsure, do NOT resolve. Empty array is the correct default.

For each match you return, the "reason" field must quote the specific phrase in the note that PROVES completion. The quote must contain an explicit past-tense completion verb ("shipped", "fixed", "finished", "deployed", "merged", "submitted", "completed", "cancelled", "closed", "sent") or an explicit forward-reference ("scheduled for Friday"). Readiness or still-to-do markers — "unblocked", "cleared", "ready", "prepped", "queued", "staged", "kicked off", "approved", "remaining", "outstanding", "pending", "to-do", "deferred", "yet to", "still to", "still need", "next", "follows" — do NOT count as completion; they describe the state before the work, or work that is still owed. If you cannot produce such a quote, do not include the match.`;

const TEST_CASES = [
  {
    label: "FP #1 — umbrella completion",
    kind: "FP",
    newThought: "The calendar integration was deployed and its token rotation is complete.",
    newCtx: "project=example-app, topics=calendar/security",
    items: [
      { ctx: "project=example-app, topics=security", description: "rotate all integration secrets" },
    ],
    expectedResolved: [],
  },
  {
    label: "FP #2 — readiness verb",
    kind: "FP",
    newThought: "The export migration is unblocked and ready to start after the schema fix shipped.",
    newCtx: "project=example-app, topics=export/status",
    items: [
      { ctx: "project=example-app, topics=export", description: "run the export migration" },
    ],
    expectedResolved: [],
  },
  {
    label: "FP #3 — subject mismatch",
    kind: "FP",
    newThought: "The readiness-rule update shipped. Next: run the export migration.",
    newCtx: "project=example-app, topics=auto-resolve/export",
    items: [
      { ctx: "project=example-app, topics=export", description: "run the export migration" },
    ],
    expectedResolved: [],
  },
  {
    label: "FP #4 — still-to-do marker",
    kind: "FP",
    newThought: "The candidate-scoping RPC shipped. Remaining: email sender blocklist cleanup and quote-overlap tuning.",
    newCtx: "project=example-app, topics=auto-resolve/email",
    items: [
      { ctx: "project=example-app, topics=email/blocklist", description: "email sender blocklist cleanup" },
    ],
    expectedResolved: [],
  },
  {
    label: "LEGIT #1 — explicit completion",
    kind: "LEGIT",
    newThought: "Finished writing the integration-test summary and committed it.",
    newCtx: "project=example-app, topics=testing/docs",
    items: [
      { ctx: "project=example-app, topics=testing/docs", description: "write the integration-test summary" },
    ],
    expectedResolved: [1],
  },
  {
    label: "LEGIT #2 — explicit cancellation",
    kind: "LEGIT",
    newThought: "Cancelled the obsolete export migration after the replacement path was approved.",
    newCtx: "project=example-app, topics=export",
    items: [
      { ctx: "project=example-app, topics=export", description: "run the obsolete export migration" },
    ],
    expectedResolved: [1],
  },
  {
    label: "LEGIT #3 — explicit scheduling",
    kind: "LEGIT",
    newThought: "The database maintenance is scheduled for Friday at 09:00 UTC.",
    newCtx: "project=example-app, topics=database/maintenance",
    items: [
      { ctx: "project=example-app, topics=database/maintenance", description: "schedule database maintenance" },
    ],
    expectedResolved: [1],
  },
];

// LAYER 3 metric corpus: quote and description pairs scored against
// SUBJECT_COVERAGE_THRESHOLD with no model call. `expect` is the side of the
// threshold the metric must land on; "known miss" marks a real completion the
// metric cannot recover (an ids-only quote, a quote naming different nouns),
// which a later re-check of aged items owns rather than a looser threshold.
const LAYER3_CASES = [
  { id: "migration applied", expect: "pass", quote: "migration 063 applied live on the production database via psql", description: "Awaiting the operator to apply migration 063" },
  { id: "patch deploy", expect: "pass", quote: "deployed d024025 (npm audit patch bumps) to live (health 200) and to the demo (health 200)", description: "deploy the npm audit patch bumps to live and demo" },
  { id: "no-op closes item", expect: "pass", quote: "No CMS edit needed per the deliverable; nothing to install.", description: "needs to paste it in the CMS" },
  { id: "ids-only (known miss)", expect: "block", quote: "intake 13204d35 (intakes 628 -> 627) and sheet row 36, each deleted by exact id", description: "remove the duplicate test request from the intake queue" },
  { id: "umbrella FP", expect: "block", quote: "Notion token rotation COMPLETE", description: "rotate 4 live secrets before publishing the repo" },
  { id: "generic-verb FP", expect: "block", quote: "deployed the dashboard fix", description: "deploy the app and the demo" },
];

function scoreLayer3Cases() {
  console.log(`\nLAYER 3 subject-coverage metric, threshold ${SUBJECT_COVERAGE_THRESHOLD} (no model calls)`);
  let bad = 0;
  for (const c of LAYER3_CASES) {
    const cov = subjectCoverage(c.quote, c.description);
    const got = cov >= SUBJECT_COVERAGE_THRESHOLD ? "pass" : "block";
    const ok = got === c.expect;
    if (!ok) bad++;
    console.log(`  ${ok ? "ok " : "BAD"} ${c.id.padEnd(24)} coverage ${cov.toFixed(3)}  expected ${c.expect}`);
  }
  console.log(bad === 0 ? "  all LAYER 3 cases as expected" : `  ${bad} LAYER 3 case(s) off`);
  return bad === 0;
}

// Apply the deterministic gates to the model's claims exactly as
// checkAutoResolve does after LAYER 2: LAYER 3 subject coverage on the quote,
// then the LAYER 3.5 still-owed veto on the note. Returns the surviving
// candidate numbers and, per claim, which gate stopped it.
function applyGates(testCase, claims) {
  const survivors = [];
  const stops = [];
  for (const claim of claims) {
    const item = testCase.items[claim.num - 1];
    if (!item) continue;
    if (claim.reason === "") { stops.push({ num: claim.num, gate: "L3 no_quote" }); continue; }
    const cov = subjectCoverage(claim.reason, item.description);
    if (cov < SUBJECT_COVERAGE_THRESHOLD) { stops.push({ num: claim.num, gate: `L3 coverage ${cov.toFixed(2)}` }); continue; }
    const veto = stillOwedAdjacencyVeto(testCase.newThought, item.description, stem);
    if (veto.vetoed) { stops.push({ num: claim.num, gate: `L3.5 ${veto.marker}` }); continue; }
    survivors.push(claim.num);
  }
  return { survivors, stops };
}

// Run one test case against one model. Returns { claims: [{num, reason}], raw: string, error?: string }.
async function runOne(model, testCase) {
  const itemList = testCase.items
    .map((it, i) => `${i + 1}. [${it.ctx || "no-context"}] ${it.description}`)
    .join("\n");
  const userContent =
    `New note context: ${testCase.newCtx || "no-context"}\n\n` +
    `New note:\n${testCase.newThought}\n\n` +
    `Open action items (numbered, with source context):\n${itemList}`;

  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY()}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/dave-tedder/brain-bank",
      "X-Title": "Brain Bank auto-resolve A/B harness",
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    return { claims: [], raw: "", error: `HTTP ${res.status}: ${await res.text()}` };
  }

  const body = await res.json();
  const raw = body?.choices?.[0]?.message?.content ?? "";
  let claims = [];
  // Some models (notably Anthropic via OpenRouter) ignore json_object mode and
  // wrap JSON in ```json ... ``` fences with trailing prose. Extract the first
  // balanced JSON object before parsing.
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenceMatch ? fenceMatch[1] : raw;
  const braceStart = candidate.indexOf("{");
  const braceEnd = candidate.lastIndexOf("}");
  const jsonStr = braceStart >= 0 && braceEnd > braceStart ? candidate.slice(braceStart, braceEnd + 1) : candidate;
  try {
    const parsed = JSON.parse(jsonStr);
    const arr = Array.isArray(parsed.resolved) ? parsed.resolved : [];
    claims = arr
      .map((e) => (typeof e === "number" ? { num: e, reason: "" } : typeof e?.num === "number" ? { num: e.num, reason: typeof e.reason === "string" ? e.reason : "" } : null))
      .filter((c) => c !== null && Number.isFinite(c.num));
  } catch {
    return { claims: [], raw, error: "parse error" };
  }
  return { claims, raw };
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

const RERUNS = Number(argValue("--reruns", "10"));

// Per-cell: run each (case, model) RERUNS times. A cell "passes" only if
// it returns the expected result on ALL reruns AFTER the gates. FP gate = a
// model clears only if every FP AND every LEGIT cell is RERUNS/RERUNS.
async function main() {
  const l3ok = scoreLayer3Cases();
  if (LAYER3_ONLY) process.exit(l3ok ? 0 : 1);
  if (!OPENROUTER_API_KEY()) {
    console.error("Missing OPENROUTER_API_KEY env var. See the usage comment at the top of this file.");
    process.exit(1);
  }
  console.log(`\nAuto-resolve A/B harness: LAYER 2 model replay plus LAYER 3 and LAYER 3.5 gates`);
  console.log(`Models under test: ${MODELS.join(", ")}`);
  console.log(
    `Cases: ${TEST_CASES.length} (${TEST_CASES.filter((c) => c.kind === "FP").length} FP, ${TEST_CASES.filter((c) => c.kind === "LEGIT").length} LEGIT)`
  );
  console.log(`Reruns per cell: ${RERUNS}\n`);

  const rows = [];
  for (const testCase of TEST_CASES) {
    const row = {
      label: testCase.label,
      kind: testCase.kind,
      expected: testCase.expectedResolved,
      perModel: {},
    };
    for (const model of MODELS) {
      let passes = 0;
      let lastRaw = "";
      let lastErr = "";
      const gateTally = {};   // which gate stopped a claim (FP cases): "L2" when the model claimed nothing
      for (let r = 0; r < RERUNS; r++) {
        try {
          const result = await runOne(model, testCase);
          const { survivors, stops } = applyGates(testCase, result.claims);
          if (testCase.kind === "FP") {
            if (result.claims.length === 0) gateTally["L2"] = (gateTally["L2"] || 0) + 1;
            for (const s of stops) gateTally[s.gate] = (gateTally[s.gate] || 0) + 1;
            if (survivors.length > 0) gateTally["NONE (resolved)"] = (gateTally["NONE (resolved)"] || 0) + 1;
          } else {
            for (const s of stops) gateTally[`stopped by ${s.gate}`] = (gateTally[`stopped by ${s.gate}`] || 0) + 1;
          }
          const ok = !result.error && sameSet(survivors, testCase.expectedResolved);
          if (ok) {
            passes++;
            process.stdout.write(".");
          } else {
            lastRaw = result.raw || lastRaw;
            lastErr = result.error || lastErr;
            process.stdout.write(result.error ? "X" : "x");
          }
        } catch (err) {
          lastErr = String(err);
          process.stdout.write("X");
        }
      }
      row.perModel[model] = { passes, reruns: RERUNS, lastRaw, lastErr, gateTally };
    }
    rows.push(row);
  }
  console.log("\n");

  // Results table: each cell shows passes/reruns.
  const pad = (s, n) => (s.length >= n ? s : s + " ".repeat(n - s.length));
  const labelCol = Math.max(...rows.map((r) => r.label.length), "Test".length);
  const modelCols = MODELS.map((m) => {
    const short = m.split("/").pop();
    return { key: m, label: short, width: Math.max(short.length, 8) };
  });

  const header = pad("Test", labelCol) + "  Expect  " + modelCols.map((c) => pad(c.label, c.width)).join("  ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const row of rows) {
    const exp = row.expected.length === 0 ? "SKIP" : `[${row.expected.join(",")}]`;
    const cols = modelCols.map((c) => {
      const r = row.perModel[c.key];
      return pad(`${r.passes}/${r.reruns}`, c.width);
    });
    console.log(pad(row.label, labelCol) + "  " + pad(exp, 6) + "  " + cols.join("  "));
  }

  // Which gate stopped each FP (and what, if anything, stopped a LEGIT).
  console.log(`\nGate that stopped each case, per model (counts over ${RERUNS} reruns):`);
  for (const row of rows) {
    for (const model of MODELS) {
      const t = row.perModel[model].gateTally;
      const parts = Object.entries(t).map(([g, n]) => `${g} x${n}`).join(", ");
      console.log(`  ${row.kind.padEnd(5)} ${row.label}  [${model.split("/").pop()}]  ${parts || "(no claims, no stops)"}`);
    }
  }

  // Gate verdict.
  console.log(`\nGate verdict (CLEARS = ${RERUNS}/${RERUNS} on EVERY FP and EVERY LEGIT case):`);
  for (const model of MODELS) {
    const fpOk = rows.filter((r) => r.kind === "FP").every((r) => r.perModel[model].passes === RERUNS);
    const legitOk = rows.filter((r) => r.kind === "LEGIT").every((r) => r.perModel[model].passes === RERUNS);
    const clears = fpOk && legitOk;
    console.log(`  ${model}: ${clears ? "CLEARS" : "FAILS"} (FP ${fpOk ? "ok" : "miss"}, LEGIT ${legitOk ? "ok" : "miss"})`);
  }

  // Miss details: last failing sample per imperfect cell.
  const misses = [];
  for (const row of rows) {
    for (const model of MODELS) {
      const r = row.perModel[model];
      if (r.passes < r.reruns) misses.push({ label: row.label, model, r });
    }
  }
  if (misses.length > 0) {
    console.log("\nMiss details (last failing sample per imperfect cell):");
    for (const m of misses) {
      console.log(`\n  [${m.model}] ${m.label} — ${m.r.passes}/${m.r.reruns}`);
      if (m.r.lastErr) console.log(`    error: ${m.r.lastErr}`);
      if (m.r.lastRaw) console.log(`    raw: ${m.r.lastRaw.slice(0, 400)}`);
    }
    console.log();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
