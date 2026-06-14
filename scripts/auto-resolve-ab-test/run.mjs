#!/usr/bin/env node
// Auto-resolve A/B harness for the mirrored LAYER 2 prompt.
//
// Usage:
//   export OPENROUTER_API_KEY=sk-or-...
//   node scripts/auto-resolve-ab-test/run.mjs

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
  console.error("Missing OPENROUTER_API_KEY env var.");
  process.exit(1);
}

const MODELS = [
  "openai/gpt-4o-mini",
  "openai/gpt-4.1-mini",
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-sonnet-4.6",
];

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

async function runOne(model, testCase) {
  const itemList = testCase.items
    .map((item, index) => `${index + 1}. [${item.ctx || "no-context"}] ${item.description}`)
    .join("\n");
  const userContent =
    `New note context: ${testCase.newCtx || "no-context"}\n\n` +
    `New note:\n${testCase.newThought}\n\n` +
    `Open action items (numbered, with source context):\n${itemList}`;

  const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
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

  if (!response.ok) {
    return { resolved: [], raw: "", error: `HTTP ${response.status}: ${await response.text()}` };
  }

  const body = await response.json();
  const raw = body?.choices?.[0]?.message?.content ?? "";
  try {
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const candidate = fenceMatch ? fenceMatch[1] : raw;
    const braceStart = candidate.indexOf("{");
    const braceEnd = candidate.lastIndexOf("}");
    const json = braceStart >= 0 && braceEnd > braceStart
      ? candidate.slice(braceStart, braceEnd + 1)
      : candidate.trim();
    const parsed = JSON.parse(json);
    const entries = Array.isArray(parsed.resolved) ? parsed.resolved : [];
    const resolved = entries
      .map((entry) => typeof entry === "number" ? entry : entry?.num)
      .filter((value) => typeof value === "number" && Number.isFinite(value));
    return { resolved, raw };
  } catch {
    return { resolved: [], raw, error: "parse error" };
  }
}

function sameSet(actual, expected) {
  if (actual.length !== expected.length) return false;
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.every((value, index) => value === right[index]);
}

async function main() {
  console.log(`\nAuto-resolve A/B harness`);
  console.log(`Models: ${MODELS.join(", ")}`);
  console.log(`Cases: ${TEST_CASES.length}\n`);

  const rows = [];
  for (const testCase of TEST_CASES) {
    const results = {};
    for (const model of MODELS) {
      const result = await runOne(model, testCase);
      results[model] = {
        ...result,
        pass: !result.error && sameSet(result.resolved, testCase.expectedResolved),
      };
      process.stdout.write(results[model].pass ? "." : "X");
    }
    rows.push({ testCase, results });
  }

  console.log("\n");
  for (const model of MODELS) {
    const passes = rows.filter((row) => row.results[model].pass).length;
    console.log(`${model}: ${passes}/${rows.length}`);
  }

  for (const row of rows) {
    for (const model of MODELS) {
      const result = row.results[model];
      if (!result.pass) {
        console.log(`\n[${model}] ${row.testCase.label}`);
        if (result.error) console.log(`error: ${result.error}`);
        if (result.raw) console.log(`raw: ${result.raw.slice(0, 400)}`);
      }
    }
  }
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
