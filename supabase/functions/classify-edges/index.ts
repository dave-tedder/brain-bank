// supabase/functions/classify-edges/index.ts
//
// Phase 13.2: Typed Reasoning Edges classifier.
//
// Two-stage pipeline that populates public.thought_edges from candidate pairs
// scoped against flat metadata (same project AND/OR shared topics):
//
//   1. Filter (gpt-4.1-mini, ~$0.0004/pair): "is there ANY meaningful relation
//      beyond simple co-mention?". Cheap pre-filter to drop ~70% of candidates.
//   2. Classify (claude-sonnet-4.6, ~$0.0101/pair): pick exactly one of the
//      six relation types (or 'none'), with direction + confidence + temporal
//      bounds. Returns strict JSON.
//
// Modes:
//   ?mode=backfill     - one-time historical pass over all thoughts
//   ?mode=incremental  - weekly cron over last `since_days` of new captures
//
// Auth: x-brain-key header or ?key= matching MCP_ACCESS_KEY (mirrors
// compile-pages and brain-digest auth patterns).
//
// Cost cap: hard worst-case-per-pair budgeting. Function stops scheduling
// new pairs when costSpent + WORST_PER_PAIR would exceed max_cost_usd.
//
// Default dry_run=true. Set ?dry_run=false explicitly to write rows.
//
// Ports OB1 PR #208's classify-edges.mjs shape, swapping Anthropic direct
// (Haiku + Opus) for OpenRouter (gpt-4.1-mini + claude-sonnet-4.6) and
// re-implementing as a Deno Edge Function instead of a Node CLI.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callOpenRouter, computeCost } from "../_shared/openrouter.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const FUNCTION_SLUG = "classify-edges";
const FILTER_MODEL = "openai/gpt-4.1-mini";
const CLASSIFY_MODEL = "anthropic/claude-sonnet-4.6";
const CLASSIFIER_VERSION = "phase-13-classifier-1.0.0";

// Worst case: filter at full max_tokens (128) + classify at full max_tokens (512),
// using the upper bound on input chars converted to tokens. Unknown-model
// pricing still falls back to zero, preserving the existing cap behavior.
const WORST_PER_PAIR =
  (computeCost(FILTER_MODEL, 500, 128) ?? 0) +
  (computeCost(CLASSIFY_MODEL, 800, 512) ?? 0);

const ALLOWED_RELATIONS = new Set([
  "supports",
  "contradicts",
  "evolved_into",
  "supersedes",
  "depends_on",
  "related_to",
]);

interface CandidatePair {
  a_id: string;
  b_id: string;
  overlap: number;
}

async function sampleCandidatePairs(
  mode: "backfill" | "incremental",
  minOverlap: number,
  sinceDays: number,
  limit: number,
): Promise<CandidatePair[]> {
  // Returns up to limit*4 candidates so post-filter (alreadyClassified)
  // doesn't strip the top-N if many already have edges.
  const { data, error } = await supabase.rpc("sample_candidate_pairs", {
    p_min_overlap: minOverlap,
    p_since_days: mode === "incremental" ? sinceDays : null,
    p_limit: limit * 4,
  });
  if (error) throw new Error(`Pair sampling: ${error.message}`);
  return (data || []) as CandidatePair[];
}

async function alreadyClassified(a: string, b: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("thought_edges")
    .select("relation")
    .or(
      `and(from_thought_id.eq.${a},to_thought_id.eq.${b}),and(from_thought_id.eq.${b},to_thought_id.eq.${a})`,
    )
    .limit(1);
  if (error) return false; // permissive: don't skip on transient errors
  return (data?.length ?? 0) > 0;
}

interface LlmResponse {
  raw: string;
  inTokens: number;
  outTokens: number;
}

async function classifyEdgesCall(
  callSite: "filter_pair" | "classify_pair",
  model: string,
  systemPrompt: string,
  userMsg: string,
  maxTokens: number,
): Promise<LlmResponse> {
  const { data, prompt_tokens, completion_tokens } = await callOpenRouter({
    function_slug: FUNCTION_SLUG,
    call_site: callSite,
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMsg },
    ],
    max_tokens: maxTokens,
  });
  return {
    raw: (data.choices?.[0]?.message?.content ?? "").trim(),
    inTokens: prompt_tokens,
    outTokens: completion_tokens,
  };
}

// Permissive JSON parse: strips markdown fences + tolerates trailing prose.
// Per ~/.claude/rules/openrouter-anthropic-json-mode.md — Anthropic models on
// OpenRouter do not honor response_format json_object, so we fence-strip and
// brace-slice as a defensive measure.
function parseJsonStrict(raw: string): Record<string, unknown> {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenceMatch ? fenceMatch[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  const jsonStr = start >= 0 && end > start
    ? candidate.slice(start, end + 1)
    : candidate;
  return JSON.parse(jsonStr);
}

const FILTER_SYSTEM =
  `You are a fast pre-filter for a typed-edge classifier on a personal knowledge base.
Given two captured thoughts, decide whether there is ANY meaningful semantic relation
beyond simple co-mention (one of: supports, contradicts, evolved_into, supersedes,
depends_on). Be conservative: if the pair only shares a topic or person without
a directional relation, answer false.

Reply with strict JSON only. No markdown. No commentary.
{"worth_classifying": true|false, "hunch": "<one-word relation or none>"}`;

async function filterPair(
  a: { id: string; content: string; created_at: string },
  b: { id: string; content: string; created_at: string },
): Promise<{ worth: boolean; hunch: string; cost: number }> {
  const userMsg = `Thought A (id=${a.id}, date=${a.created_at.slice(0, 10)}):\n` +
    `${a.content.slice(0, 400)}\n\n` +
    `Thought B (id=${b.id}, date=${b.created_at.slice(0, 10)}):\n` +
    `${b.content.slice(0, 400)}\n\n` +
    `Is there a meaningful relation? Return strict JSON.`;
  const { raw, inTokens, outTokens } = await classifyEdgesCall(
    "filter_pair",
    FILTER_MODEL,
    FILTER_SYSTEM,
    userMsg,
    128,
  );
  const parsed = parseJsonStrict(raw);
  return {
    worth: Boolean(parsed.worth_classifying),
    hunch: typeof parsed.hunch === "string" ? parsed.hunch : "none",
    cost: computeCost(FILTER_MODEL, inTokens, outTokens) ?? 0,
  };
}

const CLASSIFY_SYSTEM =
  `You classify the semantic relationship between two thoughts from a personal knowledge base.

ALLOWED RELATION TYPES (pick exactly one, or 'none'):

  supports      - A strengthens or provides evidence for B.
                  YES: "slept 8h Tuesday" -> "felt sharp Tuesday morning"
                  NO: generic topical overlap (use related_to or none).

  contradicts   - A disagrees with or disproves B.
                  YES: "ran 5mi Tuesday" vs "rested Tuesday"
                  Be rare with this label. Only when conflict is direct.

  evolved_into  - A was replaced by a refined/updated B over time.
                  YES: v1 design note -> v2 design note with explicit iteration
                  NO: same idea restated (use 'none').

  supersedes    - A is the newer replacement for B for decisions or versions.
                  YES: "switched to Supabase" -> supersedes -> "decided on Firebase"
                  The subject is the newer/surviving thought.

  depends_on    - A is conditional on B being true or completing first.
                  YES: "ship Friday" -> depends_on -> "tests pass"

  related_to    - Generic association; no specific label fits.
                  Use sparingly. Prefer 'none' when in doubt.

RETURN 'none' WHEN:
  - thoughts merely co-mention an entity without a directional relation
  - no specific label is clearly better than related_to
  - evidence is ambiguous or contradictory within the pair itself

DIRECTION: pick whichever makes the sentence true when you substitute:
  A <relation> B  (e.g. "Tuesday sleep supports Tuesday sharpness")
  If direction should be flipped, set direction='B_to_A'.
  If the relation is inherently symmetric, set direction='symmetric'.

TEMPORALITY: if the relation has a clear start or end, populate
valid_from and/or valid_until as ISO YYYY-MM-DD; otherwise null.

Do not use the words: delve, tapestry, robust, synergy, holistic, leverage, realm,
landscape (metaphorical), inked, inking. No em dashes. No emojis.

OUTPUT strict valid JSON, no markdown, no commentary:
{"relation": "<type|none>", "direction": "A_to_B|B_to_A|symmetric",
 "confidence": 0.0-1.0, "rationale": "...",
 "valid_from": "YYYY-MM-DD|null", "valid_until": "YYYY-MM-DD|null"}`;

async function classifyPair(
  a: { id: string; content: string; created_at: string },
  b: { id: string; content: string; created_at: string },
): Promise<{
  relation: string;
  direction: "A_to_B" | "B_to_A" | "symmetric";
  confidence: number;
  rationale: string;
  valid_from: string | null;
  valid_until: string | null;
  cost: number;
}> {
  const userMsg = `Thought A (id=${a.id}, date=${a.created_at.slice(0, 10)}):\n` +
    `${a.content.slice(0, 800)}\n\n` +
    `Thought B (id=${b.id}, date=${b.created_at.slice(0, 10)}):\n` +
    `${b.content.slice(0, 800)}\n\n` +
    `Classify the relationship.`;
  const { raw, inTokens, outTokens } = await classifyEdgesCall(
    "classify_pair",
    CLASSIFY_MODEL,
    CLASSIFY_SYSTEM,
    userMsg,
    512,
  );
  const parsed = parseJsonStrict(raw);
  return {
    relation: typeof parsed.relation === "string" ? parsed.relation : "none",
    direction: ["A_to_B", "B_to_A", "symmetric"].includes(parsed.direction as string)
      ? (parsed.direction as "A_to_B" | "B_to_A" | "symmetric")
      : "A_to_B",
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
    valid_from: typeof parsed.valid_from === "string" && parsed.valid_from !== "null"
      ? parsed.valid_from
      : null,
    valid_until: typeof parsed.valid_until === "string" && parsed.valid_until !== "null"
      ? parsed.valid_until
      : null,
    cost: computeCost(CLASSIFY_MODEL, inTokens, outTokens) ?? 0,
  };
}

async function insertEdge(
  a: { id: string },
  b: { id: string },
  cls: Awaited<ReturnType<typeof classifyPair>>,
  filterHunch: string,
): Promise<{ ok: boolean; error?: string }> {
  // Resolve direction to from/to. For 'symmetric', preserve a.id < b.id ordering
  // (which the candidate sampling RPC already enforces) for canonical form.
  let fromId = a.id;
  let toId = b.id;
  if (cls.direction === "B_to_A") {
    fromId = b.id;
    toId = a.id;
  }

  const { error } = await supabase.rpc("thought_edges_upsert", {
    p_from_thought_id: fromId,
    p_to_thought_id: toId,
    p_relation: cls.relation,
    p_confidence: cls.confidence,
    p_support_count: 1,
    p_classifier_version: CLASSIFIER_VERSION,
    p_valid_from: cls.valid_from,
    p_valid_until: cls.valid_until,
    p_metadata: {
      rationale: cls.rationale.slice(0, 500),
      direction: cls.direction,
      filter_hunch: filterHunch,
    },
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

Deno.serve(async (req: Request): Promise<Response> => {
  try {
    const url = new URL(req.url);
    const provided = req.headers.get("x-brain-key") || url.searchParams.get("key");
    if (!provided || provided !== MCP_ACCESS_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }

    const mode = (url.searchParams.get("mode") || "incremental") as
      | "backfill"
      | "incremental";
    const minOverlap = Math.max(1, parseInt(url.searchParams.get("min_overlap") || "2"));
    const limit = Math.min(500, parseInt(url.searchParams.get("limit") || "100"));
    const sinceDays = Math.max(1, parseInt(url.searchParams.get("since_days") || "8"));
    const dryRun = (url.searchParams.get("dry_run") || "true") !== "false";
    const maxCostUsd = parseFloat(url.searchParams.get("max_cost_usd") || "1.00");
    const minConfidence = parseFloat(
      url.searchParams.get("min_confidence") || "0.7",
    );

    const candidates = await sampleCandidatePairs(mode, minOverlap, sinceDays, limit);

    let costSpent = 0;
    const stats = {
      candidates_total: candidates.length,
      filter_called: 0,
      filter_passed: 0,
      classified: 0,
      inserted: 0,
      skipped_already_classified: 0,
      skipped_low_confidence: 0,
      skipped_none: 0,
      errors: 0,
      cost_usd: 0,
      cap_reached: false,
      relation_counts: {} as Record<string, number>,
    };
    const sample_inserts: Array<{
      a: string;
      b: string;
      relation: string;
      confidence: number;
      rationale: string;
    }> = [];

    for (const pair of candidates) {
      // Cost cap pre-check (worst-case budgeting).
      if (costSpent + WORST_PER_PAIR > maxCostUsd) {
        stats.cap_reached = true;
        break;
      }

      // Skip if already classified with any relation in either direction.
      if (await alreadyClassified(pair.a_id, pair.b_id)) {
        stats.skipped_already_classified++;
        continue;
      }

      // Fetch thought content.
      const { data: thoughtsData } = await supabase
        .from("thoughts")
        .select("id, content, created_at")
        .in("id", [pair.a_id, pair.b_id]);
      if (!thoughtsData || thoughtsData.length !== 2) continue;
      const a = thoughtsData.find((t) => t.id === pair.a_id)!;
      const b = thoughtsData.find((t) => t.id === pair.b_id)!;

      // Stage 1: filter.
      stats.filter_called++;
      let filterResult: Awaited<ReturnType<typeof filterPair>>;
      try {
        filterResult = await filterPair(a, b);
        costSpent += filterResult.cost;
      } catch (err) {
        console.error(`Filter error on pair ${a.id}/${b.id}: ${(err as Error).message}`);
        stats.errors++;
        continue;
      }
      if (!filterResult.worth) continue;
      stats.filter_passed++;

      // Stage 2: classify.
      let cls: Awaited<ReturnType<typeof classifyPair>>;
      try {
        cls = await classifyPair(a, b);
        costSpent += cls.cost;
        stats.classified++;
      } catch (err) {
        console.error(`Classify error on pair ${a.id}/${b.id}: ${(err as Error).message}`);
        stats.errors++;
        continue;
      }

      if (cls.relation === "none" || !ALLOWED_RELATIONS.has(cls.relation)) {
        stats.skipped_none++;
        continue;
      }
      if (cls.confidence < minConfidence) {
        stats.skipped_low_confidence++;
        continue;
      }

      // Insert (or skip if dry_run).
      if (!dryRun) {
        const ins = await insertEdge(a, b, cls, filterResult.hunch);
        if (!ins.ok) {
          console.error(`Insert error on pair ${a.id}/${b.id}: ${ins.error}`);
          stats.errors++;
          continue;
        }
        stats.inserted++;
      }
      stats.relation_counts[cls.relation] = (stats.relation_counts[cls.relation] || 0) + 1;
      if (sample_inserts.length < 10) {
        sample_inserts.push({
          a: a.id,
          b: b.id,
          relation: cls.relation,
          confidence: cls.confidence,
          rationale: cls.rationale.slice(0, 120),
        });
      }
    }

    stats.cost_usd = Math.round(costSpent * 10000) / 10000;

    return new Response(
      JSON.stringify(
        {
          status: "complete",
          mode,
          dry_run: dryRun,
          stats,
          sample_inserts,
        },
        null,
        2,
      ),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("classify-edges error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
