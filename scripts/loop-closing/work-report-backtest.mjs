#!/usr/bin/env node
// Loop-closing Task 1.2 Step 6: read-only backtest of isWorkReportCapture
// against production action_items created since 2026-07-06.
//
// Reports item-weighted and thought-weighted recall against the synthesis's
// work_report class (the metrics.sql regex), and lists every STILL-OPEN item
// the gate would have suppressed, for the operator to read before Task 1.2 deploys.
//
// Credentials: SUPABASE_ACCESS_TOKEN (a Supabase personal access token) in the
// environment, never argv. Reads through the management API's database/query
// endpoint, the same transport the Supabase MCP uses. Nothing is written.
//
//   SUPABASE_ACCESS_TOKEN=... node scripts/loop-closing/work-report-backtest.mjs [--since 2026-07-06] [--ref <project ref>]
//
// MIRROR RULE: WORK_REPORT_SHAPES below is a port of the TypeScript list in
// supabase/functions/_shared/metadata-validation.ts. Change both together.

// Shipped set: the plan's seven plus the two the operator adopted 2026-11-05.
const WORK_REPORT_SHAPES = [
  /\bsession \d+\b/i,
  /\bhandoff\b/i,
  /(?:\bcommit\s+[0-9a-f]{7,40}\b|\([0-9a-f]{7,40}\))/i,
  /\b(?:PROJECT-TRACKER\.md|SESSION-LOG\.md)\b/,
  /\bdeliverables\/[\w./-]+\.\w+/,
  /\[OE:[0-9a-f]{8}/,
  /\b(?:closed|paused|built|deployed|shipped) (?:2026|2027)-\d\d-\d\d\b/i,
  /\bsession \d+\b[^\n]{0,24}?\b\d{4}-\d\d-\d\d\b/i,
  /\btask [0-9a-f]{8}\b/i,
];
const WORK_REPORT_MIN_SHAPES = 2;
// Mirror of the TypeScript future-date rule (Codex review of PR 16,
// 2026-11-05): the dated header counts only when its date is not after the
// capture day plus one day of slack. The backtest uses the thought's own
// created_at as the capture time.
const WORK_REPORT_DATED_HEADER_INDEX = 7;
const WORK_REPORT_FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;
const ISO_DATE_RE = /\b(\d{4})-(\d\d)-(\d\d)\b/;
function datedHeaderIsFuture(headerMatch, capturedAt) {
  const m = ISO_DATE_RE.exec(headerMatch);
  if (!m) return true;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  // Mirror of metadata-validation.ts: Date.UTC normalizes a mistyped date
  // instead of failing, so the components must round-trip. Years 0000 to
  // 0099 fail it (Date.UTC reads them as 1900 to 1999) and count as not real.
  if (Number.isNaN(t)) return true;
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return true;
  return t > capturedAt.getTime() + WORK_REPORT_FUTURE_SLACK_MS;
}
// The plan's original seven, kept as the comparison column so the report
// still shows what the amendment bought.
const PLAN_ORIGINAL_SHAPES = WORK_REPORT_SHAPES.slice(0, 7);

function classifierFor(shapes) {
  return (content, capturedAt) => {
    let hits = 0;
    shapes.forEach((shape, i) => {
      if (i !== WORK_REPORT_DATED_HEADER_INDEX) {
        if (shape.test(content)) hits += 1;
        return;
      }
      const all = new RegExp(shape.source, shape.flags + "g");
      for (const m of String(content ?? "").matchAll(all)) {
        if (!datedHeaderIsFuture(m[0], capturedAt)) { hits += 1; break; }
      }
    });
    return hits >= WORK_REPORT_MIN_SHAPES;
  };
}
const isWorkReportCapture = classifierFor(WORK_REPORT_SHAPES);
const isWorkReportPlanOriginal = classifierFor(PLAN_ORIGINAL_SHAPES);

const OPERATOR_LINE_RE = /^\s*FOR OPERATOR:\s*(.+?)\s*$/;
function extractOperatorLines(content) {
  const out = [];
  for (const line of String(content ?? "").split(/\r?\n/)) {
    const m = OPERATOR_LINE_RE.exec(line);
    if (m && m[1]) out.push(m[1]);
  }
  return out;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SINCE = arg("--since", "2026-07-06");
const REF = arg("--ref", process.env.BRAIN_BANK_PROJECT_REF ?? "");
if (!REF) {
  console.error("Pass --ref <your-project-ref> or set BRAIN_BANK_PROJECT_REF.");
  process.exit(2);
}
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error("SUPABASE_ACCESS_TOKEN is not set (export it; never pass it as an argument).");
  process.exit(2);
}
if (!/^\d{4}-\d\d-\d\d$/.test(SINCE)) {
  console.error("--since must be YYYY-MM-DD");
  process.exit(2);
}

// The synthesis class, verbatim from scripts/loop-closing/metrics.sql
// (created_by_week_and_class), computed in SQL so the baseline and this
// backtest agree on what "work-report born" means.
const SQL = `
select a.id, a.status, a.description, a.created_at, a.source_thought_id,
       t.content, t.created_at as thought_created_at,
       (t.content ~* 'session \\d+|handoff|closed \\(|commit [0-9a-f]{6,}|tracker|deliverables/|task [0-9a-f]{8}\\y|\\[OE:') as synthesis_work_report
from action_items a
left join thoughts t on t.id = a.source_thought_id
where a.created_at >= '${SINCE}'
order by a.created_at`;

const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL, read_only: true }),
});
if (!res.ok) {
  console.error(`query failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const rows = await res.json();
const collectedAt = new Date().toISOString();

function measure(classify) {
  let items = 0, itemsNoSource = 0, synthItems = 0, synthCaught = 0, otherCaught = 0, classifierCaught = 0;
  const synthThoughts = new Set(), synthThoughtsCaught = new Set(), allThoughts = new Set(), caughtThoughts = new Set();
  const suppressedOpen = [];
  for (const r of rows) {
    items += 1;
    if (!r.source_thought_id || r.content == null) { itemsNoSource += 1; continue; }
    allThoughts.add(r.source_thought_id);
    const caught = classify(r.content, new Date(r.thought_created_at ?? r.created_at));
    if (caught) { classifierCaught += 1; caughtThoughts.add(r.source_thought_id); }
    if (r.synthesis_work_report) {
      synthItems += 1; synthThoughts.add(r.source_thought_id);
      if (caught) { synthCaught += 1; synthThoughtsCaught.add(r.source_thought_id); }
    } else if (caught) {
      otherCaught += 1;
    }
    if (caught && r.status === "open") {
      suppressedOpen.push({
        id: r.id, created: String(r.created_at).slice(0, 10), description: r.description,
        forOperator: extractOperatorLines(r.content).length,
      });
    }
  }
  return { items, itemsNoSource, synthItems, synthCaught, otherCaught, classifierCaught, synthThoughts, synthThoughtsCaught, allThoughts, caughtThoughts, suppressedOpen };
}

const pct = (a, b) => b === 0 ? "n/a" : `${((100 * a) / b).toFixed(1)}%`;
console.log(`# Work-report gate backtest`);
console.log(``);
console.log(`Collected ${collectedAt}, read-only, items created since ${SINCE}, project ${REF}. Two shapes required in every set.`);
console.log(``);
console.log(`The plan's expected recall (Task 1.2 Step 6) was 270 to 320 of 369 items and roughly 120 to 150 of about 170 thoughts. The synthesis class used here is the metrics.sql regex, which matches a lone "session N" or "tracker" mention; the plan's original seven shapes need two hits, and 54 of the 109 work-report thoughts carry only the dated "Session N (YYYY-MM-DD)" header. The shipped set (the operator, 2026-11-05) adds that header and the "task <8hex>" reference; the original seven are the comparison column.`);
console.log(``);
console.log(`| measure | plan's original seven | shipped set (9) |`);
console.log(`| --- | --- | --- |`);
const A = measure(isWorkReportPlanOriginal), B = measure(isWorkReportCapture);
console.log(`| items since ${SINCE} | ${A.items} | ${B.items} |`);
console.log(`| items with no source thought (unclassifiable) | ${A.itemsNoSource} | ${B.itemsNoSource} |`);
console.log(`| distinct source thoughts | ${A.allThoughts.size} | ${B.allThoughts.size} |`);
console.log(`| synthesis work_report items | ${A.synthItems} | ${B.synthItems} |`);
console.log(`| item-weighted recall | ${A.synthCaught} of ${A.synthItems} (${pct(A.synthCaught, A.synthItems)}) | ${B.synthCaught} of ${B.synthItems} (${pct(B.synthCaught, B.synthItems)}) |`);
console.log(`| synthesis work_report distinct thoughts | ${A.synthThoughts.size} | ${B.synthThoughts.size} |`);
console.log(`| thought-weighted recall | ${A.synthThoughtsCaught.size} of ${A.synthThoughts.size} (${pct(A.synthThoughtsCaught.size, A.synthThoughts.size)}) | ${B.synthThoughtsCaught.size} of ${B.synthThoughts.size} (${pct(B.synthThoughtsCaught.size, B.synthThoughts.size)}) |`);
console.log(`| classifier catches outside the synthesis class | ${A.otherCaught} | ${B.otherCaught} |`);
console.log(`| still-open items the gate would have suppressed | ${A.suppressedOpen.length} | ${B.suppressedOpen.length} |`);
console.log(``);
for (const [name, M] of [["the plan's original seven shapes", A], ["the shipped set", B]]) {
  console.log(`## Still-open items suppressed under ${name} (for the operator to read before Task 1.2 deploys)`);
  console.log(``);
  console.log(`| # | item | created | FOR OPERATOR lines in source | description |`);
  console.log(`| --- | --- | --- | --- | --- |`);
  M.suppressedOpen.forEach((s, i) => {
    console.log(`| ${i + 1} | ${s.id.slice(0, 8)} | ${s.created} | ${s.forOperator} | ${s.description.replace(/\|/g, "\\|").replace(/\s+/g, " ")} |`);
  });
  console.log(``);
}
