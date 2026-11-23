// Loop-closing Task 5.1, Codex review 1, F3: replay the rollout's live probe
// (step 6) through the REAL shared extraction function, against a stateful
// in-memory database, before anyone runs it against production.
//
//   deno run --no-lock --allow-read scripts/loop-closing/fragment-gate-rollout-replay.ts
//
// ORIGINAL replays the step as first published (the same kept item text for
// both capture paths, only the Session number changed). It is informational:
// it shows the second capture loses its item and its suspect to the open-item
// dedup, which is correct application behavior and why the step was changed.
//
// CORRECTED replays the corrected step 6: a unique per-run, per-capture-path
// token in the kept item, looked up by that token and by id. It runs twice on
// the same state (two rollout attempts, the first never closed) after seeding
// an open item with the original probe text, and asserts, for every capture:
// one new action_items row carrying the capture's token, one
// fragment/dropped/one_token row for "deploy" with item_id null, one
// fragment/proposed/pronoun_object row whose item_id is the new row's id, and
// that the emulated fragment_pending_proposals read lists every probe item.
//
// The two capture paths share one function in production for MCP and REST
// (_shared/capture-pipeline.ts); the Slack path runs ingest-thought's copy,
// which the mirror test proves equal and ingest-probe-harness.ts probe 12
// drives with the same corrected text.
//
// Exit 0 when every CORRECTED assertion passed, 1 when one completed and
// failed, 2 when the replay could not run.

import { extractAndStoreActionItems } from "../../supabase/functions/_shared/capture-pipeline.ts";
import { isWorkReportCapture } from "../../supabase/functions/_shared/metadata-validation.ts";
import { validateDecisionRow } from "../../supabase/functions/_shared/decisions.ts";

type Item = { id: string; description: string; status: string; source_thought_id: string };
type Decision = Record<string, unknown>;

const items: Item[] = [];
const decisions: Decision[] = [];

// The two supabase-js shapes extractAndStoreActionItems uses, with state:
// select(..).eq(col, value) filters by equality; insert(rows).select(..)
// returns the inserted rows with fresh ids; a decision insert is validated
// against the legal triples, as the database CHECK would.
const db = {
  from(table: string) {
    return {
      select(_cols: string) {
        return {
          eq(col: string, value: string) {
            if (table !== "action_items") throw new Error(`replay: unexpected select on ${table}`);
            return Promise.resolve({ data: items.filter((r) => (r as Record<string, unknown>)[col] === value), error: null });
          },
        };
      },
      insert(rows: unknown) {
        const batch = (Array.isArray(rows) ? rows : [rows]) as Array<Record<string, unknown>>;
        if (table === "auto_resolve_decisions") {
          for (const r of batch) {
            const bad = validateDecisionRow(r);
            if (bad !== null) return Promise.resolve({ error: { message: `CHECK: ${bad}` } });
          }
          decisions.push(...batch);
          return Promise.resolve({ error: null });
        }
        if (table !== "action_items") throw new Error(`replay: unexpected insert on ${table}`);
        return {
          select(_cols: string) {
            const back = batch.map((r) => ({ ...(r as Omit<Item, "id">), id: crypto.randomUUID() }));
            items.push(...back);
            return Promise.resolve({ data: back.map((r) => ({ id: r.id, description: r.description })), error: null });
          },
        };
      },
    };
  },
};

// open-brain-mcp's mechanical-prefix test, by its prefixes; the probe text
// starts with none of them.
const MECHANICAL = ["[Calendar Sync]", "[Notion Sync]", "[Fitness Tracker] Daily sync", "[Fitness Tracker] Trend Analysis", "[Meta DM Scan]", "[Weekly Review]", "Email thread:", "Meta DM Scan failed", "[Open Engine Closeout]"];
const isMechanical = (c: string) => MECHANICAL.some((p) => c.trimStart().startsWith(p));

async function capture(content: string, source: string) {
  const thoughtId = crypto.randomUUID();
  const beforeItems = items.length, beforeDecisions = decisions.length;
  // What the model might extract from the text; the work-report gate replaces
  // it with the FOR OPERATOR lines whatever it is.
  const metadata = { type: "task", source, action_items: ["deploy", "send the fragment probe explainer PDF"] };
  await extractAndStoreActionItems(db, thoughtId, metadata, content, isMechanical);
  return { thoughtId, newItems: items.slice(beforeItems), newDecisions: decisions.slice(beforeDecisions) };
}

// The corrected step 6 text. RUN is the probe's per-run id (the rollout
// command takes it from `date -u +%Y%m%d%H%M%S`), PATH the capture path.
export function probeText(session: number, runDate: string, run: string, path: "slack" | "mcp"): string {
  return `Fragment gate probe, handoff for Session ${session} (${runDate}).\nFOR OPERATOR: deploy\nFOR OPERATOR: send her the fragment probe explainer PDF fgprobe${run}${path}`;
}

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) failures++;
}

const summary = (r: Awaited<ReturnType<typeof capture>>) =>
  JSON.stringify({ newItems: r.newItems.map((i) => i.description), decisions: r.newDecisions.map((d) => [d.layer, d.outcome, d.reason, d.item_id === null ? null : "item"]) });

try {
  const runDate = new Date().toISOString().slice(0, 10);

  // --- ORIGINAL (informational) ---
  for (const session of [999, 998]) {
    const content = `Fragment gate probe, handoff for Session ${session} (2026-11-20).\nFOR OPERATOR: deploy\nFOR OPERATOR: send her the fragment probe explainer PDF`;
    const r = await capture(content, session === 999 ? "slack" : "mcp");
    console.log(`ORIGINAL session ${session} workReport=${isWorkReportCapture(content)} ${summary(r)}`);
  }
  const originalOpen = items.filter((i) => i.description === "send her the fragment probe explainer PDF").length;
  console.log(`ORIGINAL open items with the shared probe text: ${originalOpen} (the second capture is deduplicated against the first)`);

  // --- CORRECTED: state already holds the original probe's open item. ---
  check(originalOpen === 1, "CORRECTED setup: an open item with the original probe text is already present");
  const allProbeIds: string[] = [];
  for (const run of ["20261121093000", "20261121094500"]) {
    for (const [session, path] of [[999, "slack"], [998, "mcp"]] as const) {
      const content = probeText(session, runDate, run, path);
      const token = `fgprobe${run}${path}`;
      check(isWorkReportCapture(content), `run ${run} ${path}: the probe text is a work report (only its FOR OPERATOR lines are stored)`);
      const r = await capture(content, path);
      console.log(`CORRECTED run ${run} ${path} ${summary(r)}`);
      // Step 6 lookup 1: the item, by its token.
      const byToken = items.filter((i) => i.description.includes(token));
      check(byToken.length === 1 && byToken[0].status === "open" && byToken[0].source_thought_id === r.thoughtId,
        `run ${run} ${path}: exactly one open action_items row carries ${token}, from this capture`);
      const item = byToken[0];
      if (item === undefined) continue;
      allProbeIds.push(item.id);
      // Step 6 lookup 2: the capture's decision rows, by thought id.
      const rows = decisions.filter((d) => d.thought_id === r.thoughtId && d.layer === "fragment");
      check(rows.length === 2, `run ${run} ${path}: exactly two fragment rows for the probe thought (${rows.length})`);
      const drop = rows.filter((d) => d.outcome === "dropped");
      check(drop.length === 1 && drop[0].reason === "one_token" && drop[0].candidate_description === "deploy" && drop[0].item_id === null,
        `run ${run} ${path}: one fragment/dropped/one_token row for "deploy", item_id null`);
      const sus = rows.filter((d) => d.outcome === "proposed");
      check(sus.length === 1 && sus[0].reason === "pronoun_object" && sus[0].item_id === item.id && sus[0].candidate_description === item.description,
        `run ${run} ${path}: one fragment/proposed/pronoun_object row whose item_id is the new row's id`);
      check(!decisions.some((d) => d.thought_id === r.thoughtId && d.outcome === "resolved"),
        `run ${run} ${path}: no resolved row for the probe thought`);
    }
  }
  // Step 6 lookup 3: the pending read, emulated as fragment_pending_proposals
  // defines it (fragment/proposed/pronoun_object on an open item, one per
  // item), filtered by the probe ids rather than its first five rows.
  const pendingIds = new Set(decisions.filter((d) => d.layer === "fragment" && d.outcome === "proposed" && d.reason === "pronoun_object" &&
    items.some((i) => i.id === d.item_id && i.status === "open")).map((d) => d.item_id));
  check(allProbeIds.length === 4 && allProbeIds.every((id) => pendingIds.has(id)), "every corrected probe item is pending in the emulated fragment_pending_proposals read");
} catch (e) {
  console.log(`REPLAY NEVER-RAN: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  Deno.exit(2);
}

if (failures > 0) {
  console.log(`ROLLOUT REPLAY FAILED: ${failures} assertion(s)`);
  Deno.exit(1);
}
console.log("ROLLOUT REPLAY PASSED");
Deno.exit(0);
