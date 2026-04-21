import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { loadProfile } from "../_shared/profile.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-");
}

async function contentHash(text: string): Promise<string> {
  const data = new TextEncoder().encode(text.trim());
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function isDuplicate(hash: string): Promise<boolean> {
  const { data } = await supabase
    .from("thoughts")
    .select("id")
    .eq("content_hash", hash)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.data[0].embedding;
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned by full name when possible, e.g. "${loadProfile().example_person_name}" (use full name when possible) (empty if none)
- "action_items": array of FUTURE to-dos the user still needs to do. STRICT RULES:
    * Only include items phrased as future work: "need to X", "should X", "TODO: X", an imperative about something not yet done, or an explicit open question.
    * NEVER include work described in past tense. If the note says "I updated X", "fixed Y", "shipped Z", "changed the ratio to 3px/1px", "replaced the background", those are DONE and must be excluded.
    * NEVER restate completed work as an imperative. Do not turn "updated the ratio to 3px" into "Update the ratio to 3px".
    * Session logs, changelogs, retrospectives, and "here's what I just did" summaries almost always have an empty action_items array. Default to [] when in doubt.
    * A commitment to do something later ("I'll test this tomorrow") IS an action item. A description of something already tested is NOT.
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short lowercase topic tags, e.g. "${loadProfile().domain.vocabulary[0]}" not "${titleCase(loadProfile().domain.vocabulary[0])}", "project management" not "Project Management" (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note". Past-tense summaries are "observation", not "task".
- "project": the project or system this note is ABOUT, e.g. ${loadProfile().example_projects.map((p) => `"${p}"`).join(", ")}, "${loadProfile().example_domain}". Only fill this when the note explicitly references a known project by name or is clearly session-log content for one. If the note is a marketing email, utility bill, tax reminder, or random inbox item with no project context, return null. Do NOT guess a project from topical similarity.
- "priority": "high" if urgent/time-sensitive/revenue-impacting, "low" if informational/FYI, "normal" otherwise (null if unclear)

Template prefix hints: if the thought starts with DECISION:, CLIENT:, IDEA:, or MEETING:, use that to inform the type field (decision->observation, CLIENT->person_note, IDEA->idea, MEETING->observation) and extract structured fields accordingly.

Only extract what's explicitly there. Be conservative — empty arrays and null fields are fine.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  const d = await r.json();
  try {
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

// --- Action Item Tracking ---

function normalizeActionText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

// Content starting with any of these prefixes is a mechanical/informational capture
// (calendar sync, notion sync, email thread, weekly review, trend analysis, Meta DM
// failure report). These captures describe STATE or EVENTS, not completion of action
// items, so auto-resolve is unsafe — they carry topic/person metadata that scope-
// matches real action items but aren't evidence of anything being done. Completion
// signals from these sources must come through a manual `done:` command or a
// dedicated session-log thought, not this path. Adding a pattern here means
// "this source never resolves action items."
// Structural prefixes are universal (every operator has these sync sources).
// Operator-specific bridge prefixes come from profile.json — see
// `supabase/functions/_shared/profile.example.json`.
const MECHANICAL_CAPTURE_PREFIXES = [
  "[Calendar Sync]",
  "[Notion Sync]",
  "[Meta DM Scan]",
  "[Weekly Review]",
  "Email thread:",
  "Meta DM Scan failed",
  ...loadProfile().mechanical_capture_prefixes,
];

function isMechanicalCapture(content: string): boolean {
  const head = content.trimStart();
  return MECHANICAL_CAPTURE_PREFIXES.some((p) => head.startsWith(p));
}

// Token-set Jaccard similarity on 3+-char lowercased words. Used as a restatement
// guard: if a new thought's own extracted action_item is highly similar to a
// candidate open action item, the new thought is RE-CAPTURING that work, not
// completing it, and must not resolve the candidate.
function jaccardTokens(a: string, b: string): number {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3);
  const setA = new Set(norm(a));
  const setB = new Set(norm(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const uni = setA.size + setB.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

const RESTATEMENT_THRESHOLD = 0.5;

// Minimal stemmer for LAYER 3 quote-overlap. Collapses common English
// verb/noun alternation so "rotation"/"rotate"/"rotating"/"rotated" all
// converge on "rotat". Deliberately not a full Porter stemmer — only the
// families that matter for the umbrella-item FP pattern and comparable
// cases. Rules applied in order, chaining allowed.
//
// Known English surprises (documented, not bugs at the 0.25 threshold —
// but worth knowing if you see a confusing stem in a drop log):
//   - `notion` → `not`. The -tion rule fires on any word of length ≥ 5
//     ending in "tion"; `notion` (6 chars) and `noting` both collapse.
//     Shared stem is harmless at current threshold.
//   - `-ment` is NOT covered. `deployment` stays whole while
//     `deploy`/`deployed`/`deploying` collapse to `deploy`. A quote
//     saying "deployed" vs a description saying "deployment" loses
//     one overlap token.
//   - `fixes` → `fixe` (diverges from `fix`/`fixing`/`fixed` which all
//     collapse to `fix`). The length-5 floor on the final-e strip
//     blocks `fixe` → `fix`, so that family splits across two stems.
// If the 0.25 threshold ever gets tightened, revisit these cases.
function stem(token: string): string {
  let t = token;
  if (t.length >= 4 && t.endsWith("s")) t = t.slice(0, -1);
  if (t.length >= 5 && t.endsWith("ing")) t = t.slice(0, -3);
  if (t.length >= 4 && t.endsWith("ed")) t = t.slice(0, -2);
  if (t.length >= 5 && t.endsWith("tion")) t = t.slice(0, -4) + "t";
  if (t.length >= 5 && t.endsWith("e")) t = t.slice(0, -1);
  return t;
}

// LAYER 3 helper: Jaccard overlap on stemmed 3+-char tokens between the
// LLM's past-tense `reason` quote and the candidate action item's
// description. Used to prove the quote substantively addresses the item.
function quoteOverlap(quote: string, description: string): number {
  const toSet = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3)
        .map(stem)
    );
  const a = toSet(quote);
  const b = toSet(description);
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

const QUOTE_OVERLAP_THRESHOLD = 0.25;
const LOG_TRUNC = 200;

async function extractAndStoreActionItems(
  thoughtId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const items = metadata.action_items;
  if (!Array.isArray(items) || items.length === 0) return;

  // Fetch existing open items to dedup against
  const { data: existingItems } = await supabase
    .from("action_items")
    .select("description")
    .eq("status", "open");

  const existingNormalized = new Set(
    (existingItems || []).map((item) => normalizeActionText(item.description))
  );

  const rows = items
    .map((desc: unknown) => ({
      source_thought_id: thoughtId,
      description: String(desc),
      status: "open",
    }))
    .filter((row) => !existingNormalized.has(normalizeActionText(row.description)));

  if (rows.length === 0) return;
  const { error } = await supabase.from("action_items").insert(rows);
  if (error) console.error("Action item insert error:", error);
}

async function checkAutoResolve(
  newThoughtContent: string,
  newThoughtId: string,
  newMetadata: Record<string, unknown>,
  excludeSourceThoughtIds: string[] = []
): Promise<string[]> {
  // LAYER 0: structural-source block. Mechanical captures (sync jobs, email
  // threads, weekly reviews, failure reports) carry topic/person metadata that
  // scope-matches real action items but are NOT evidence of completion. Skip
  // auto-resolve entirely — completion signals from these sources must come
  // via a manual `done:` command or a dedicated session-log thought.
  if (isMechanicalCapture(newThoughtContent)) {
    console.log(
      `checkAutoResolve: blocked mechanical capture (prefix match): ${newThoughtContent
        .trimStart()
        .slice(0, 80)}`
    );
    return [];
  }

  // Scoping axes from the NEW thought. Auto-resolve is only safe when we can
  // scope candidates by project / topic / person — otherwise we fall back to
  // doing nothing rather than risk a cross-project false positive.
  const newProject = (newMetadata?.project as string | null | undefined) || null;
  const newTopicsRaw = newMetadata?.topics;
  const newTopics: string[] = Array.isArray(newTopicsRaw) ? (newTopicsRaw as string[]) : [];
  const newPeopleRaw = newMetadata?.people;
  const newPeople: string[] = Array.isArray(newPeopleRaw) ? (newPeopleRaw as string[]) : [];

  if (!newProject && newTopics.length === 0 && newPeople.length === 0) return [];

  // Pull recent open items (cap at 100, newest first). Descriptions only at this stage.
  const { data: openItems, error } = await supabase
    .from("action_items")
    .select("id, description, source_thought_id")
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error || !openItems || openItems.length === 0) return [];

  // Drop excluded (self / thread parent) and rows with no source thought.
  const preFiltered = openItems.filter(
    (item) =>
      !!item.source_thought_id &&
      !excludeSourceThoughtIds.includes(item.source_thought_id)
  );
  if (preFiltered.length === 0) return [];

  // Batch-fetch source thought metadata for scoping.
  const sourceIds = Array.from(new Set(preFiltered.map((i) => i.source_thought_id as string)));
  const { data: sourceThoughts } = await supabase
    .from("thoughts")
    .select("id, metadata")
    .in("id", sourceIds);

  const sourceMetaById = new Map<string, Record<string, unknown>>();
  for (const t of sourceThoughts || []) {
    sourceMetaById.set(t.id as string, (t.metadata as Record<string, unknown>) || {});
  }

  type EnrichedItem = {
    id: string;
    description: string;
    source_thought_id: string;
    srcProject: string | null;
    srcTopics: string[];
    srcPeople: string[];
  };

  const enriched: EnrichedItem[] = preFiltered.map((row) => {
    const meta = sourceMetaById.get(row.source_thought_id as string) || {};
    const srcTopicsRaw = meta.topics;
    const srcPeopleRaw = meta.people;
    return {
      id: row.id as string,
      description: row.description as string,
      source_thought_id: row.source_thought_id as string,
      srcProject: (meta.project as string | null) ?? null,
      srcTopics: Array.isArray(srcTopicsRaw) ? (srcTopicsRaw as string[]) : [],
      srcPeople: Array.isArray(srcPeopleRaw) ? (srcPeopleRaw as string[]) : [],
    };
  });

  // LAYER 1: hard scoping.
  // Keep an item only if it shares a project, a topic, or a person with the new thought.
  // Items whose source thought has none of those three fields are unscoped and excluded.
  let candidateItems = enriched.filter((item) => {
    const projectMatch = !!newProject && !!item.srcProject && newProject === item.srcProject;
    const topicMatch = item.srcTopics.some((t) => newTopics.includes(t));
    const personMatch = item.srcPeople.some((p) => newPeople.includes(p));
    return projectMatch || topicMatch || personMatch;
  });

  if (candidateItems.length === 0) return [];

  // LAYER 1.5: restatement guard. If the new thought's own extracted action_items
  // are semantically similar to a candidate's description, the new thought is
  // RE-CAPTURING that work, not completing it. Drop those candidates before the
  // LLM sees them. Prevents the classic "Dave says 'I really need to research
  // Virginia permits'" case where the LLM reads topical overlap as completion.
  const newOwnActionItemsRaw = newMetadata?.action_items;
  const newOwnActionItems: string[] = Array.isArray(newOwnActionItemsRaw)
    ? (newOwnActionItemsRaw as unknown[]).map((x) => String(x))
    : [];

  if (newOwnActionItems.length > 0) {
    const beforeCount = candidateItems.length;
    candidateItems = candidateItems.filter((cand) => {
      for (const own of newOwnActionItems) {
        if (jaccardTokens(own, cand.description) >= RESTATEMENT_THRESHOLD) {
          return false;
        }
      }
      return true;
    });
    const droppedCount = beforeCount - candidateItems.length;
    if (droppedCount > 0) {
      console.log(`checkAutoResolve: restatement guard dropped ${droppedCount} candidate(s)`);
    }
    if (candidateItems.length === 0) return [];
  }

  // LAYER 2: stricter LLM prompt. Include per-candidate context so the model
  // can see cross-context mismatches and must justify each claimed resolution.
  const itemList = candidateItems
    .map((item, i) => {
      const ctx = [
        item.srcProject ? `project=${item.srcProject}` : null,
        item.srcTopics.length > 0 ? `topics=${item.srcTopics.join("/")}` : null,
        item.srcPeople.length > 0 ? `people=${item.srcPeople.join("/")}` : null,
      ].filter(Boolean).join(", ");
      return `${i + 1}. [${ctx || "no-context"}] ${item.description}`;
    })
    .join("\n");

  const newCtx = [
    newProject ? `project=${newProject}` : null,
    newTopics.length > 0 ? `topics=${newTopics.join("/")}` : null,
    newPeople.length > 0 ? `people=${newPeople.join("/")}` : null,
  ].filter(Boolean).join(", ");

  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You check whether a new note explicitly resolves any open action items.

Return JSON shaped as: {"resolved": [{"num": 1, "reason": "short quote from the note"}]}
If no items are clearly resolved, return {"resolved": []}.

HARD RULES — a match requires ALL of these:
1. The new note explicitly and specifically references the action item's subject. Vague overlap ("I shipped some stuff", "polished the UI") does NOT resolve anything. A generic verb match ("fix", "update", "deploy", "check", "monitor") is NEVER enough on its own.
2. The note describes the action as DONE, SCHEDULED, or EXPLICITLY CANCELLED. Progress reports, related work, or similar-sounding updates do not count.
3. The new note and the action item must be about the same concrete thing. If the action item is a specific bug, file, feature, client, or errand, the note must name or unambiguously describe that same thing.
4. If the candidate context says "project=X" and the note's context is a different project, do NOT mark it resolved even if wording overlaps. Cross-project auto-resolves are forbidden unless the note explicitly names the other project.
5. READINESS or UNBLOCKING SIGNALS NEVER resolve anything. A note phrased with a verb that describes the PRE-WORK state — "unblocked", "cleared", "un-gated", "ready", "readied", "prepped", "prepared", "queued", "slated", "planned", "staged", "teed up", "lined up", "kicked off", "approved", or "authorized" — is announcing that work is about to BEGIN, not that it has been completed. Even if the subject matches a candidate exactly, do NOT resolve — "X unblocked" means X is now doable, not that X has been done. Return [] for this entry.
6. When unsure, do NOT resolve. Empty array is the correct default.

For each match you return, the "reason" field must quote the specific phrase in the note that PROVES completion. The quote must contain an explicit past-tense completion verb ("shipped", "fixed", "finished", "deployed", "merged", "submitted", "completed", "cancelled", "closed", "sent") or an explicit forward-reference ("scheduled for Friday"). Readiness verbs — "unblocked", "cleared", "ready", "prepped", "queued", "staged", "kicked off", "approved" — do NOT count as completion; they describe the state before the work, not the work being done. If you cannot produce such a quote, do not include the match.`,
        },
        {
          role: "user",
          content: `New note context: ${newCtx || "no-context"}\n\nNew note:\n${newThoughtContent}\n\nOpen action items (numbered, with source context):\n${itemList}`,
        },
      ],
    }),
  });
  const d = await r.json();
  type Claim = { num: number; reason: string };
  let claims: Claim[] = [];
  try {
    const parsed = JSON.parse(d.choices[0].message.content);
    const arr = Array.isArray(parsed.resolved) ? parsed.resolved : [];
    claims = arr
      .map((entry: unknown): Claim | null => {
        if (typeof entry === "number") return { num: entry, reason: "" };
        if (entry && typeof entry === "object") {
          const obj = entry as Record<string, unknown>;
          const n = obj.num;
          const reason = obj.reason;
          if (typeof n === "number" && Number.isFinite(n)) {
            return { num: n, reason: typeof reason === "string" ? reason : "" };
          }
        }
        return null;
      })
      .filter((c: Claim | null): c is Claim => c !== null);
  } catch { return []; }

  // LAYER 3: quote-overlap guard. The LLM's `reason` quote must share
  // substantive vocabulary with the candidate's description (stemmed
  // Jaccard ≥ QUOTE_OVERLAP_THRESHOLD). Blocks umbrella-item FPs where
  // the quote is a truthful past-tense completion of a SPECIFIC subtask
  // but the candidate description is BROAD (e.g., "rotate 4 live secrets"
  // resolved by "Notion token rotation COMPLETE"). Session 55/56 bug.
  const resolvedDescriptions: string[] = [];
  // shared across the batch — intentional, do not move inside loop
  const now = new Date().toISOString();
  for (const claim of claims) {
    const idx = claim.num - 1;
    if (idx < 0 || idx >= candidateItems.length) continue;
    const item = candidateItems[idx];
    if (claim.reason === "") {
      console.log(
        `checkAutoResolve: LAYER 3 blocked item ${item.id}: no quote returned by LLM (legacy bare-number response)`
      );
      continue;
    }
    const overlap = quoteOverlap(claim.reason, item.description);
    if (overlap < QUOTE_OVERLAP_THRESHOLD) {
      console.log(
        `checkAutoResolve: LAYER 3 quote-overlap guard dropped item ${item.id} ` +
          `(overlap=${overlap.toFixed(3)}, quote=${JSON.stringify(claim.reason.slice(0, LOG_TRUNC))}, ` +
          `desc=${JSON.stringify(item.description.slice(0, LOG_TRUNC))})`
      );
      continue;
    }
    await supabase
      .from("action_items")
      .update({ status: "resolved", resolved_by_thought_id: newThoughtId, resolved_at: now })
      .eq("id", item.id);
    resolvedDescriptions.push(item.description);
  }
  return resolvedDescriptions;
}

async function postCaptureHook(
  thoughtId: string,
  content: string,
  metadata: Record<string, unknown>,
  excludeSourceThoughtIds: string[] = []
): Promise<string[]> {
  await extractAndStoreActionItems(thoughtId, metadata);
  return await checkAutoResolve(content, thoughtId, metadata, excludeSourceThoughtIds);
}

// --- REST API helpers (for ChatGPT custom GPT Actions) ---

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-brain-key",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function handleRestSearch(url: URL): Promise<Response> {
  const query = url.searchParams.get("query");
  if (!query) return jsonResponse({ error: "query parameter required" }, 400);
  const limit = parseInt(url.searchParams.get("limit") || "10");
  const threshold = parseFloat(url.searchParams.get("threshold") || "0.5");
  try {
    const qEmb = await getEmbedding(query);
    const { data, error } = await supabase.rpc("match_thoughts", {
      query_embedding: qEmb,
      match_threshold: threshold,
      match_count: limit,
      filter: {},
    });
    if (error) return jsonResponse({ error: error.message }, 500);
    return jsonResponse({
      count: data?.length || 0,
      results: (data || []).map((t: { content: string; similarity: number; metadata: Record<string, unknown>; created_at: string }) => ({
        content: t.content,
        similarity: Math.round(t.similarity * 1000) / 1000,
        type: t.metadata?.type,
        topics: t.metadata?.topics,
        people: t.metadata?.people,
        action_items: t.metadata?.action_items,
        created_at: t.created_at,
      })),
    });
  } catch (err: unknown) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }
}

async function handleRestList(url: URL): Promise<Response> {
  const limit = parseInt(url.searchParams.get("limit") || "10");
  const type = url.searchParams.get("type");
  const topic = url.searchParams.get("topic");
  const person = url.searchParams.get("person");
  const days = url.searchParams.get("days") ? parseInt(url.searchParams.get("days")!) : null;
  try {
    let q = supabase.from("thoughts").select("content, metadata, created_at").order("created_at", { ascending: false }).limit(limit);
    if (type) q = q.contains("metadata", { type });
    if (topic) q = q.contains("metadata", { topics: [topic] });
    if (person) q = q.contains("metadata", { people: [person] });
    if (days) {
      const since = new Date();
      since.setDate(since.getDate() - days);
      q = q.gte("created_at", since.toISOString());
    }
    const { data, error } = await q;
    if (error) return jsonResponse({ error: error.message }, 500);
    return jsonResponse({
      count: data?.length || 0,
      results: (data || []).map((t: { content: string; metadata: Record<string, unknown>; created_at: string }) => ({
        content: t.content,
        type: t.metadata?.type,
        topics: t.metadata?.topics,
        people: t.metadata?.people,
        action_items: t.metadata?.action_items,
        created_at: t.created_at,
      })),
    });
  } catch (err: unknown) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }
}

async function handleRestStats(): Promise<Response> {
  try {
    const { count } = await supabase.from("thoughts").select("*", { count: "exact", head: true });
    const { data } = await supabase.from("thoughts").select("metadata, created_at").order("created_at", { ascending: false });
    const types: Record<string, number> = {};
    const topics: Record<string, number> = {};
    const people: Record<string, number> = {};
    for (const r of data || []) {
      const m = (r.metadata || {}) as Record<string, unknown>;
      if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
      if (Array.isArray(m.topics)) for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
      if (Array.isArray(m.people)) for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
    }
    const sort = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));
    return jsonResponse({
      total: count,
      date_range: data?.length ? { oldest: data[data.length - 1].created_at, newest: data[0].created_at } : null,
      types: sort(types),
      top_topics: sort(topics),
      people_mentioned: sort(people),
    });
  } catch (err: unknown) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }
}

async function handleRestCapture(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const content = body?.content;
    if (!content || typeof content !== "string") return jsonResponse({ error: "content field required" }, 400);
    const hash = await contentHash(content);
    if (await isDuplicate(hash)) return jsonResponse({ status: "duplicate", message: "Already in the brain." });
    const [embedding, metadata] = await Promise.all([getEmbedding(content), extractMetadata(content)]);
    const { data: inserted, error } = await supabase.from("thoughts").insert({ content, embedding, content_hash: hash, metadata: { ...metadata, source: "chatgpt" } }).select("id").single();
    if (error || !inserted) return jsonResponse({ error: error?.message || "unknown error" }, 500);

    // Post-capture: track action items and auto-resolve (self-exclusion prevents resolving own items)
    const resolved = await postCaptureHook(inserted.id, content, metadata as Record<string, unknown>, [inserted.id]);

    const meta = metadata as Record<string, unknown>;
    return jsonResponse({
      status: "captured",
      type: meta.type,
      topics: meta.topics,
      people: meta.people,
      action_items: meta.action_items,
      auto_resolved: resolved.length > 0 ? resolved : undefined,
    });
  } catch (err: unknown) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }
}

async function handleRestClient(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { name, email, phone, instagram, preferred_styles, notes, first_contact, last_contact } = body || {};
    if (!name || typeof name !== "string") return jsonResponse({ error: "name field required" }, 400);

    // Check if client with same name already exists (case-insensitive)
    const { data: existing } = await supabase
      .from("clients")
      .select("id, name, email, phone")
      .ilike("name", name)
      .limit(1);

    if (existing && existing.length > 0) {
      // Update last_contact and merge any new fields
      const updates: Record<string, unknown> = {};
      if (last_contact) updates.last_contact = last_contact;
      if (email && !existing[0].email) updates.email = email;
      if (phone && !existing[0].phone) updates.phone = phone;
      if (Object.keys(updates).length > 0) {
        await supabase.from("clients").update(updates).eq("id", existing[0].id);
      }
      return jsonResponse({ status: "exists", id: existing[0].id, name: existing[0].name });
    }

    // Insert new client
    const record: Record<string, unknown> = {
      name,
      first_contact: first_contact || new Date().toISOString(),
      last_contact: last_contact || new Date().toISOString(),
    };
    if (email) record.email = email;
    if (phone) record.phone = phone;
    if (instagram) record.instagram = instagram;
    if (preferred_styles) record.preferred_styles = preferred_styles;
    if (notes) record.notes = notes;

    const { data: inserted, error } = await supabase
      .from("clients")
      .insert(record)
      .select("id, name")
      .single();
    if (error) return jsonResponse({ error: error.message }, 500);
    return jsonResponse({ status: "created", id: inserted.id, name: inserted.name });
  } catch (err: unknown) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }
}

async function handleRestEvent(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { title, event_type, date_start, date_end, location, notes, metadata } = body || {};
    if (!title || typeof title !== "string") return jsonResponse({ error: "title field required" }, 400);

    // Upsert by Google Calendar event ID if provided
    const gcalId = metadata?.gcal_event_id;
    if (gcalId) {
      const { data: existing } = await supabase
        .from("business_events")
        .select("id")
        .contains("metadata", { gcal_event_id: gcalId })
        .limit(1);
      if (existing && existing.length > 0) {
        // Update existing event
        const { error } = await supabase
          .from("business_events")
          .update({
            title,
            event_type: event_type || null,
            date_start: date_start || null,
            date_end: date_end || null,
            location: location || null,
            notes: notes || null,
            metadata: metadata || null,
          })
          .eq("id", existing[0].id);
        if (error) return jsonResponse({ error: error.message }, 500);
        return jsonResponse({ status: "updated", id: existing[0].id });
      }
    }

    // Insert new event
    const record: Record<string, unknown> = { title };
    if (event_type) record.event_type = event_type;
    if (date_start) record.date_start = date_start;
    if (date_end) record.date_end = date_end;
    if (location) record.location = location;
    if (notes) record.notes = notes;
    if (metadata) record.metadata = metadata;

    const { data: inserted, error } = await supabase
      .from("business_events")
      .insert(record)
      .select("id")
      .single();
    if (error || !inserted) return jsonResponse({ error: error?.message || "unknown error" }, 500);
    return jsonResponse({ status: "created", id: inserted.id });
  } catch (err: unknown) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }
}

// --- MCP Server Setup ---

const server = new McpServer({
  name: "open-brain",
  version: "1.0.0",
});

server.registerTool(
  "search_thoughts",
  {
    title: "Search Thoughts",
    description:
      "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5),
    },
  },
  async ({ query, limit, threshold }) => {
    try {
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("match_thoughts", {
        query_embedding: qEmb,
        match_threshold: threshold,
        match_count: limit,
        filter: {},
      });
      if (error) {
        return { content: [{ type: "text" as const, text: `Search error: ${error.message}` }], isError: true };
      }
      if (!data || data.length === 0) {
        return { content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }] };
      }
      const results = data.map(
        (t: { content: string; metadata: Record<string, unknown>; similarity: number; created_at: string }, i: number) => {
          const m = t.metadata || {};
          const parts = [
            `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
            `Type: ${m.type || "unknown"}`,
          ];
          if (Array.isArray(m.topics) && m.topics.length) parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
          if (Array.isArray(m.people) && m.people.length) parts.push(`People: ${(m.people as string[]).join(", ")}`);
          if (Array.isArray(m.action_items) && m.action_items.length) parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
          parts.push(`\n${t.content}`);
          return parts.join("\n");
        }
      );
      return { content: [{ type: "text" as const, text: `Found ${data.length} thought(s):\n\n${results.join("\n\n")}` }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Thoughts",
    description: "List recently captured thoughts with optional filters by type, topic, person, or time range.",
    inputSchema: {
      limit: z.number().optional().default(10),
      type: z.string().optional().describe("Filter by type: observation, task, idea, reference, person_note"),
      topic: z.string().optional().describe("Filter by topic tag"),
      person: z.string().optional().describe("Filter by person mentioned"),
      days: z.number().optional().describe("Only thoughts from the last N days"),
    },
  },
  async ({ limit, type, topic, person, days }) => {
    try {
      let q = supabase.from("thoughts").select("content, metadata, created_at").order("created_at", { ascending: false }).limit(limit);
      if (type) q = q.contains("metadata", { type });
      if (topic) q = q.contains("metadata", { topics: [topic] });
      if (person) q = q.contains("metadata", { people: [person] });
      if (days) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        q = q.gte("created_at", since.toISOString());
      }
      const { data, error } = await q;
      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
      if (!data || !data.length) return { content: [{ type: "text" as const, text: "No thoughts found." }] };
      const results = data.map(
        (t: { content: string; metadata: Record<string, unknown>; created_at: string }, i: number) => {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " - " + tags : ""})\n   ${t.content}`;
        }
      );
      return { content: [{ type: "text" as const, text: `${data.length} recent thought(s):\n\n${results.join("\n\n")}` }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "thought_stats",
  {
    title: "Thought Statistics",
    description: "Get a summary of all captured thoughts: totals, types, top topics, and people.",
    inputSchema: {},
  },
  async () => {
    try {
      const { count } = await supabase.from("thoughts").select("*", { count: "exact", head: true });
      const { data } = await supabase.from("thoughts").select("metadata, created_at").order("created_at", { ascending: false });
      const types: Record<string, number> = {};
      const topics: Record<string, number> = {};
      const people: Record<string, number> = {};
      for (const r of data || []) {
        const m = (r.metadata || {}) as Record<string, unknown>;
        if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
        if (Array.isArray(m.topics)) for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
        if (Array.isArray(m.people)) for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
      }
      const sort = (o: Record<string, number>): [string, number][] => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10);
      const lines: string[] = [
        `Total thoughts: ${count}`,
        `Date range: ${data?.length ? new Date(data[data.length - 1].created_at).toLocaleDateString() + " to " + new Date(data[0].created_at).toLocaleDateString() : "N/A"}`,
        "", "Types:", ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
      ];
      if (Object.keys(topics).length) { lines.push("", "Top topics:"); for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`); }
      if (Object.keys(people).length) { lines.push("", "People mentioned:"); for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`); }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description: "Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically. Use this when the user wants to save something to their brain directly from any AI client.",
    inputSchema: {
      content: z.string().describe("The thought to capture"),
    },
  },
  async ({ content }) => {
    try {
      const hash = await contentHash(content);
      if (await isDuplicate(hash)) {
        return { content: [{ type: "text" as const, text: "Already in the brain (duplicate detected)." }] };
      }
      const [embedding, metadata] = await Promise.all([getEmbedding(content), extractMetadata(content)]);
      const { data: inserted, error } = await supabase.from("thoughts").insert({ content, embedding, content_hash: hash, metadata: { ...metadata, source: "mcp" } }).select("id").single();
      if (error || !inserted) return { content: [{ type: "text" as const, text: `Failed to capture: ${error?.message || "unknown error"}` }], isError: true };

      // Post-capture: track action items and auto-resolve (self-exclusion prevents resolving own items)
      const resolved = await postCaptureHook(inserted.id, content, metadata as Record<string, unknown>, [inserted.id]);

      const meta = metadata as Record<string, unknown>;
      let confirmation = `Captured as ${meta.type || "thought"}`;
      if (Array.isArray(meta.topics) && meta.topics.length) confirmation += ` - ${(meta.topics as string[]).join(", ")}`;
      if (Array.isArray(meta.people) && meta.people.length) confirmation += ` | People: ${(meta.people as string[]).join(", ")}`;
      if (Array.isArray(meta.action_items) && meta.action_items.length) confirmation += ` | Actions: ${(meta.action_items as string[]).join("; ")}`;
      if (resolved.length > 0) confirmation += ` | Auto-resolved: ${resolved.join("; ")}`;
      return { content: [{ type: "text" as const, text: confirmation }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// --- Client Extension MCP Tools ---

server.registerTool(
  "add_client",
  {
    title: "Add Client",
    description:
      "Create a new client record. Use when a new client reaches out or is mentioned for the first time.",
    inputSchema: {
      name: z.string().describe("Client's name"),
      email: z.string().optional().describe("Email address"),
      phone: z.string().optional().describe("Phone number"),
      instagram: z.string().optional().describe("Instagram handle"),
      preferred_styles: z
        .array(z.string())
        .optional()
        .describe("Style preferences"),
      notes: z.string().optional().describe("Any initial notes about this client"),
    },
  },
  async ({ name, email, phone, instagram, preferred_styles, notes }) => {
    try {
      // Check if client with same name already exists
      const { data: existing } = await supabase
        .from("clients")
        .select("id, name")
        .ilike("name", name)
        .limit(1);
      if (existing && existing.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `A client named "${existing[0].name}" already exists. Use find_client to look them up or use a more specific name.`,
            },
          ],
        };
      }
      const record: Record<string, unknown> = {
        name,
        first_contact: new Date().toISOString(),
        last_contact: new Date().toISOString(),
      };
      if (email) record.email = email;
      if (phone) record.phone = phone;
      if (instagram) record.instagram = instagram;
      if (preferred_styles) record.preferred_styles = preferred_styles;
      if (notes) record.notes = notes;

      const { data, error } = await supabase
        .from("clients")
        .insert(record)
        .select("id, name")
        .single();
      if (error) {
        return { content: [{ type: "text" as const, text: `Failed to add client: ${error.message}` }], isError: true };
      }
      let msg = `Client "${data.name}" added (${data.id}).`;
      if (preferred_styles?.length) msg += ` Styles: ${preferred_styles.join(", ")}.`;
      return { content: [{ type: "text" as const, text: msg }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "find_client",
  {
    title: "Find Client",
    description:
      "Search for a client by name (case-insensitive partial match). Returns matching client records.",
    inputSchema: {
      name: z.string().describe("Client name or partial name to search for"),
    },
  },
  async ({ name }) => {
    try {
      const { data, error } = await supabase
        .from("clients")
        .select("id, name, email, phone, instagram, preferred_styles, notes, first_contact, last_contact")
        .ilike("name", `%${name}%`)
        .order("last_contact", { ascending: false })
        .limit(10);
      if (error) {
        return { content: [{ type: "text" as const, text: `Search error: ${error.message}` }], isError: true };
      }
      if (!data || data.length === 0) {
        return { content: [{ type: "text" as const, text: `No clients found matching "${name}".` }] };
      }
      const results = data.map((c) => {
        const lines = [`Name: ${c.name} (${c.id})`];
        if (c.email) lines.push(`Email: ${c.email}`);
        if (c.phone) lines.push(`Phone: ${c.phone}`);
        if (c.instagram) lines.push(`Instagram: ${c.instagram}`);
        if (c.preferred_styles?.length) lines.push(`Styles: ${c.preferred_styles.join(", ")}`);
        if (c.notes) lines.push(`Notes: ${c.notes}`);
        if (c.first_contact) lines.push(`First contact: ${new Date(c.first_contact).toLocaleDateString()}`);
        if (c.last_contact) lines.push(`Last contact: ${new Date(c.last_contact).toLocaleDateString()}`);
        return lines.join("\n");
      });
      return {
        content: [{ type: "text" as const, text: `Found ${data.length} client(s):\n\n${results.join("\n\n---\n\n")}` }],
      };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "client_context",
  {
    title: "Client Context",
    description:
      `Get full context on a client: profile, session history, and related brain thoughts. Use before a ${loadProfile().domain.singular_noun} or when a client reaches out.`,
    inputSchema: {
      client_id: z.string().optional().describe("Client UUID (if known)"),
      name: z.string().optional().describe("Client name (used if client_id not provided)"),
    },
  },
  async ({ client_id, name }) => {
    try {
      if (!client_id && !name) {
        return {
          content: [{ type: "text" as const, text: "Provide either client_id or name." }],
          isError: true,
        };
      }

      // Find the client
      let client;
      if (client_id) {
        const { data, error } = await supabase
          .from("clients")
          .select("*")
          .eq("id", client_id)
          .single();
        if (error || !data) {
          return { content: [{ type: "text" as const, text: `Client not found: ${error?.message || "no match"}` }], isError: true };
        }
        client = data;
      } else {
        const { data, error } = await supabase
          .from("clients")
          .select("*")
          .ilike("name", `%${name}%`)
          .limit(1);
        if (error || !data?.length) {
          return { content: [{ type: "text" as const, text: `No client found matching "${name}".` }] };
        }
        client = data[0];
      }

      // Get session history
      const { data: sessions } = await supabase
        .from("client_sessions")
        .select("*")
        .eq("client_id", client.id)
        .order("session_date", { ascending: false })
        .limit(20);

      // Cross-reference thoughts table for mentions of this client's name
      const clientNameParts = client.name.split(" ");
      const searchName = clientNameParts.length > 1 ? client.name : clientNameParts[0];
      let relatedThoughts: { content: string; metadata: Record<string, unknown>; created_at: string }[] = [];
      try {
        const nameEmb = await getEmbedding(searchName);
        const { data: thoughts } = await supabase.rpc("match_thoughts", {
          query_embedding: nameEmb,
          match_threshold: 0.4,
          match_count: 10,
          filter: {},
        });
        // Filter to thoughts that actually mention the client's name (any part)
        if (thoughts) {
          const lowerParts = clientNameParts.map((p: string) => p.toLowerCase());
          relatedThoughts = thoughts.filter((t: { content: string }) =>
            lowerParts.some((part: string) => t.content.toLowerCase().includes(part))
          );
        }
      } catch {
        // Non-fatal: thoughts cross-reference is a bonus
      }

      // Also check metadata.people for exact name mentions
      const { data: peopleThoughts } = await supabase
        .from("thoughts")
        .select("content, metadata, created_at")
        .contains("metadata", { people: [client.name] })
        .order("created_at", { ascending: false })
        .limit(10);

      // Merge and deduplicate thoughts
      const allThoughts = new Map<string, { content: string; metadata: Record<string, unknown>; created_at: string }>();
      for (const t of [...relatedThoughts, ...(peopleThoughts || [])]) {
        allThoughts.set(t.content, t);
      }
      const uniqueThoughts = Array.from(allThoughts.values())
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 10);

      // Build response
      const lines: string[] = [];

      // Profile
      lines.push("## Client Profile");
      lines.push(`Name: ${client.name}`);
      if (client.email) lines.push(`Email: ${client.email}`);
      if (client.phone) lines.push(`Phone: ${client.phone}`);
      if (client.instagram) lines.push(`Instagram: ${client.instagram}`);
      if (client.preferred_styles?.length) lines.push(`Preferred styles: ${client.preferred_styles.join(", ")}`);
      if (client.notes) lines.push(`Notes: ${client.notes}`);
      if (client.first_contact) lines.push(`First contact: ${new Date(client.first_contact).toLocaleDateString()}`);
      if (client.last_contact) lines.push(`Last contact: ${new Date(client.last_contact).toLocaleDateString()}`);

      // Sessions
      if (sessions && sessions.length > 0) {
        lines.push("", "## Session History");
        for (const s of sessions) {
          const parts = [`${s.session_date || "No date"} - ${s.status}`];
          if (s.piece_description) parts.push(`Piece: ${s.piece_description}`);
          if (s.placement) parts.push(`Placement: ${s.placement}`);
          if (s.style) parts.push(`Style: ${s.style}`);
          if (s.duration_hours) parts.push(`Duration: ${s.duration_hours}h`);
          if (s.notes) parts.push(`Notes: ${s.notes}`);
          lines.push(parts.join(" | "));
        }
      } else {
        lines.push("", "No session history yet.");
      }

      // Related thoughts
      if (uniqueThoughts.length > 0) {
        lines.push("", "## Related Brain Thoughts");
        for (const t of uniqueThoughts) {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics) ? ` (${(m.topics as string[]).join(", ")})` : "";
          lines.push(`- [${new Date(t.created_at).toLocaleDateString()}]${tags} ${t.content}`);
        }
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "log_session",
  {
    title: `Log ${titleCase(loadProfile().domain.singular_noun)}`,
    description:
      `Record a ${loadProfile().domain.singular_noun} for a client. Updates the client's last_contact date automatically.`,
    inputSchema: {
      client_id: z.string().optional().describe("Client UUID (if known)"),
      client_name: z.string().optional().describe("Client name (used if client_id not provided)"),
      session_date: z.string().optional().describe("Date of session YYYY-MM-DD (defaults to today)"),
      duration_hours: z.number().optional().describe("Session duration in hours"),
      piece_description: z.string().optional().describe("Description of the work performed"),
      placement: z.string().optional().describe("Body placement"),
      style: z.string().optional().describe("Style"),
      status: z
        .enum(["scheduled", "completed", "cancelled", "no-show"])
        .optional()
        .default("completed")
        .describe("Session status"),
      notes: z.string().optional().describe("Session notes"),
    },
  },
  async ({ client_id, client_name, session_date, duration_hours, piece_description, placement, style, status, notes }) => {
    try {
      if (!client_id && !client_name) {
        return {
          content: [{ type: "text" as const, text: "Provide either client_id or client_name." }],
          isError: true,
        };
      }

      // Resolve client
      let resolvedId = client_id;
      let resolvedName = client_name;
      if (!resolvedId) {
        const { data } = await supabase
          .from("clients")
          .select("id, name")
          .ilike("name", `%${client_name}%`)
          .limit(1);
        if (!data?.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No client found matching "${client_name}". Use add_client first.`,
              },
            ],
          };
        }
        resolvedId = data[0].id;
        resolvedName = data[0].name;
      }

      const dateStr = session_date || new Date().toISOString().split("T")[0];
      const record: Record<string, unknown> = {
        client_id: resolvedId,
        session_date: dateStr,
        status: status || "completed",
      };
      if (duration_hours) record.duration_hours = duration_hours;
      if (piece_description) record.piece_description = piece_description;
      if (placement) record.placement = placement;
      if (style) record.style = style;
      if (notes) record.notes = notes;

      const { error } = await supabase.from("client_sessions").insert(record);
      if (error) {
        return { content: [{ type: "text" as const, text: `Failed to log session: ${error.message}` }], isError: true };
      }

      // Update client's last_contact
      await supabase
        .from("clients")
        .update({ last_contact: new Date(dateStr).toISOString() })
        .eq("id", resolvedId);

      let msg = `Session logged for ${resolvedName || resolvedId} on ${dateStr} (${status || "completed"}).`;
      if (piece_description) msg += ` Piece: ${piece_description}.`;
      if (placement) msg += ` Placement: ${placement}.`;
      return { content: [{ type: "text" as const, text: msg }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// --- Content Pipeline Extension MCP Tools ---

server.registerTool(
  "log_content",
  {
    title: "Log Content",
    description:
      "Add a new piece of content to the pipeline. Use when a photo is taken, a design is created, or content enters the workflow.",
    inputSchema: {
      title: z.string().optional().describe("Content title or description"),
      content_type: z
        .enum(["photo", "video", "flash_sheet", "portfolio_piece", "blog_post"])
        .describe("Type of content"),
      subject: z.string().optional().describe("What the content shows, e.g. 'in-progress work'"),
      client_id: z.string().optional().describe("Client UUID if content features a specific client's work"),
      stage: z
        .enum(["captured", "edited", "scheduled", "published", "archived"])
        .optional()
        .default("captured")
        .describe("Current pipeline stage"),
      platform: z.string().optional().describe("Target platform: instagram, facebook, wordpress, all"),
      notes: z.string().optional().describe("Notes about this content"),
    },
  },
  async ({ title, content_type, subject, client_id, stage, platform, notes }) => {
    try {
      const record: Record<string, unknown> = { content_type, stage: stage || "captured" };
      if (title) record.title = title;
      if (subject) record.subject = subject;
      if (client_id) record.client_id = client_id;
      if (platform) record.platform = platform;
      if (notes) record.notes = notes;

      const { data, error } = await supabase
        .from("content_items")
        .insert(record)
        .select("id, title, content_type, stage")
        .single();
      if (error) {
        return { content: [{ type: "text" as const, text: `Failed to log content: ${error.message}` }], isError: true };
      }
      let msg = `Content logged: ${data.content_type} (${data.stage})`;
      if (data.title) msg += ` "${data.title}"`;
      msg += ` [${data.id}]`;
      return { content: [{ type: "text" as const, text: msg }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "update_content",
  {
    title: "Update Content",
    description:
      "Move content through the pipeline or add performance data. Use to advance stage, set publish date, or record metrics.",
    inputSchema: {
      content_id: z.string().describe("Content item UUID"),
      stage: z
        .enum(["captured", "edited", "scheduled", "published", "archived"])
        .optional()
        .describe("New pipeline stage"),
      platform: z.string().optional().describe("Platform published to"),
      scheduled_date: z.string().optional().describe("Scheduled date YYYY-MM-DD"),
      published_date: z.string().optional().describe("Published date YYYY-MM-DD"),
      performance: z
        .object({
          likes: z.number().optional(),
          saves: z.number().optional(),
          comments: z.number().optional(),
          reach: z.number().optional(),
        })
        .optional()
        .describe("Performance metrics"),
      notes: z.string().optional().describe("Updated notes"),
    },
  },
  async ({ content_id, stage, platform, scheduled_date, published_date, performance, notes }) => {
    try {
      const updates: Record<string, unknown> = {};
      if (stage) updates.stage = stage;
      if (platform) updates.platform = platform;
      if (scheduled_date) updates.scheduled_date = scheduled_date;
      if (published_date) updates.published_date = published_date;
      if (performance) updates.performance = performance;
      if (notes) updates.notes = notes;

      if (Object.keys(updates).length === 0) {
        return { content: [{ type: "text" as const, text: "Nothing to update. Provide at least one field." }] };
      }

      const { data, error } = await supabase
        .from("content_items")
        .update(updates)
        .eq("id", content_id)
        .select("id, title, content_type, stage")
        .single();
      if (error) {
        return { content: [{ type: "text" as const, text: `Failed to update: ${error.message}` }], isError: true };
      }
      let msg = `Updated: ${data.content_type}`;
      if (data.title) msg += ` "${data.title}"`;
      if (stage) msg += ` -> ${stage}`;
      return { content: [{ type: "text" as const, text: msg }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "content_status",
  {
    title: "Content Pipeline Status",
    description:
      "See what's in the content pipeline at each stage. Optionally filter by content type or platform.",
    inputSchema: {
      content_type: z.string().optional().describe("Filter by type: photo, video, flash_sheet, portfolio_piece, blog_post"),
      platform: z.string().optional().describe("Filter by platform"),
      limit: z.number().optional().default(20),
    },
  },
  async ({ content_type, platform, limit }) => {
    try {
      let q = supabase
        .from("content_items")
        .select("id, title, content_type, subject, stage, platform, scheduled_date, published_date, performance, notes, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (content_type) q = q.eq("content_type", content_type);
      if (platform) q = q.eq("platform", platform);

      const { data, error } = await q;
      if (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
      }
      if (!data?.length) {
        return { content: [{ type: "text" as const, text: "No content in the pipeline." }] };
      }

      // Group by stage
      const stages = ["captured", "edited", "scheduled", "published", "archived"];
      const grouped: Record<string, typeof data> = {};
      for (const item of data) {
        const s = item.stage || "captured";
        if (!grouped[s]) grouped[s] = [];
        grouped[s].push(item);
      }

      const lines: string[] = [];
      for (const stage of stages) {
        const items = grouped[stage];
        if (!items?.length) continue;
        lines.push(`\n## ${stage.toUpperCase()} (${items.length})`);
        for (const item of items) {
          const parts = [`- ${item.content_type}`];
          if (item.title) parts.push(`"${item.title}"`);
          if (item.subject) parts.push(`(${item.subject})`);
          if (item.platform) parts.push(`[${item.platform}]`);
          if (item.scheduled_date) parts.push(`scheduled: ${item.scheduled_date}`);
          if (item.published_date) parts.push(`published: ${item.published_date}`);
          const perf = item.performance as Record<string, number> | null;
          if (perf && Object.keys(perf).length > 0) {
            const metrics = Object.entries(perf).map(([k, v]) => `${k}: ${v}`).join(", ");
            parts.push(`{${metrics}}`);
          }
          lines.push(parts.join(" "));
        }
      }

      return { content: [{ type: "text" as const, text: `Content pipeline (${data.length} items):${lines.join("\n")}` }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "content_performance",
  {
    title: "Content Performance",
    description:
      "See how published content is performing. Shows top content by engagement metrics.",
    inputSchema: {
      days: z.number().optional().default(30).describe("Look back N days"),
      limit: z.number().optional().default(10),
    },
  },
  async ({ days, limit }) => {
    try {
      const since = new Date();
      since.setDate(since.getDate() - days);

      const { data, error } = await supabase
        .from("content_items")
        .select("*")
        .eq("stage", "published")
        .gte("published_date", since.toISOString().split("T")[0])
        .order("published_date", { ascending: false })
        .limit(limit);
      if (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
      }
      if (!data?.length) {
        return { content: [{ type: "text" as const, text: `No published content in the last ${days} days.` }] };
      }

      const lines = data.map((item) => {
        const parts = [`${item.published_date} - ${item.content_type}`];
        if (item.title) parts.push(`"${item.title}"`);
        if (item.subject) parts.push(`(${item.subject})`);
        if (item.platform) parts.push(`[${item.platform}]`);
        const perf = item.performance as Record<string, number> | null;
        if (perf && Object.keys(perf).length > 0) {
          const metrics = Object.entries(perf).map(([k, v]) => `${k}: ${v}`).join(", ");
          parts.push(`{${metrics}}`);
        }
        return parts.join(" ");
      });

      return { content: [{ type: "text" as const, text: `Published content (last ${days} days):\n\n${lines.join("\n")}` }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// --- Business Operations Extension MCP Tools ---

server.registerTool(
  "log_event",
  {
    title: "Log Business Event",
    description:
      "Record a business event: convention, guest spot, shop event, supply order, or maintenance.",
    inputSchema: {
      event_type: z
        .enum(["convention", "guest_spot", "shop_event", "supply_order", "maintenance"])
        .describe("Type of event"),
      title: z.string().describe("Event title"),
      date_start: z.string().optional().describe("Start date YYYY-MM-DD"),
      date_end: z.string().optional().describe("End date YYYY-MM-DD (for multi-day events)"),
      location: z.string().optional().describe("Event location"),
      notes: z.string().optional().describe("Notes about the event"),
    },
  },
  async ({ event_type, title, date_start, date_end, location, notes }) => {
    try {
      const record: Record<string, unknown> = { event_type, title };
      if (date_start) record.date_start = date_start;
      if (date_end) record.date_end = date_end;
      if (location) record.location = location;
      if (notes) record.notes = notes;

      const { data, error } = await supabase
        .from("business_events")
        .insert(record)
        .select("id, event_type, title")
        .single();
      if (error) {
        return { content: [{ type: "text" as const, text: `Failed to log event: ${error.message}` }], isError: true };
      }
      let msg = `Event logged: ${data.event_type} "${data.title}"`;
      if (date_start) msg += ` (${date_start}${date_end ? " to " + date_end : ""})`;
      if (location) msg += ` at ${location}`;
      return { content: [{ type: "text" as const, text: msg }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "upcoming_events",
  {
    title: "Upcoming Events",
    description:
      "Show upcoming business events. Optionally filter by event type.",
    inputSchema: {
      event_type: z.string().optional().describe("Filter: convention, guest_spot, shop_event, supply_order, maintenance"),
      days: z.number().optional().default(90).describe("Look ahead N days"),
    },
  },
  async ({ event_type, days }) => {
    try {
      const today = new Date().toISOString().split("T")[0];
      const until = new Date();
      until.setDate(until.getDate() + days);
      const untilStr = until.toISOString().split("T")[0];

      let q = supabase
        .from("business_events")
        .select("*")
        .gte("date_start", today)
        .lte("date_start", untilStr)
        .order("date_start", { ascending: true });
      if (event_type) q = q.eq("event_type", event_type);

      const { data, error } = await q;
      if (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
      }
      if (!data?.length) {
        return { content: [{ type: "text" as const, text: `No upcoming events in the next ${days} days.` }] };
      }

      const lines = data.map((e) => {
        const parts = [`${e.date_start}${e.date_end ? " to " + e.date_end : ""}`];
        parts.push(`[${e.event_type}]`);
        parts.push(e.title);
        if (e.location) parts.push(`at ${e.location}`);
        if (e.notes) parts.push(`(${e.notes})`);
        return parts.join(" ");
      });

      return { content: [{ type: "text" as const, text: `Upcoming events (next ${days} days):\n\n${lines.join("\n")}` }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "business_context",
  {
    title: "Business Context",
    description:
      "Get a snapshot of the business: upcoming events, active client count, recent sessions, content pipeline summary, and related brain thoughts.",
    inputSchema: {},
  },
  async () => {
    try {
      const today = new Date().toISOString().split("T")[0];
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const thirtyAgoStr = thirtyDaysAgo.toISOString().split("T")[0];
      const ninetyDaysOut = new Date();
      ninetyDaysOut.setDate(ninetyDaysOut.getDate() + 90);
      const ninetyOutStr = ninetyDaysOut.toISOString().split("T")[0];

      // Upcoming events
      const { data: events } = await supabase
        .from("business_events")
        .select("*")
        .gte("date_start", today)
        .lte("date_start", ninetyOutStr)
        .order("date_start", { ascending: true })
        .limit(10);

      // Active clients (contacted in last 90 days)
      const { count: activeClients } = await supabase
        .from("clients")
        .select("*", { count: "exact", head: true })
        .gte("last_contact", thirtyDaysAgo.toISOString());

      // Recent sessions
      const { data: recentSessions } = await supabase
        .from("client_sessions")
        .select("session_date, status, piece_description, client_id")
        .gte("session_date", thirtyAgoStr)
        .order("session_date", { ascending: false })
        .limit(10);

      // Content pipeline counts by stage
      const { data: contentItems } = await supabase
        .from("content_items")
        .select("stage");
      const stageCounts: Record<string, number> = {};
      for (const item of contentItems || []) {
        const s = item.stage || "captured";
        stageCounts[s] = (stageCounts[s] || 0) + 1;
      }

      // Total counts
      const { count: totalClients } = await supabase
        .from("clients")
        .select("*", { count: "exact", head: true });

      const lines: string[] = ["## Business Snapshot"];

      // Clients
      lines.push(`\nClients: ${totalClients || 0} total, ${activeClients || 0} active (last 30 days)`);

      // Recent sessions
      if (recentSessions?.length) {
        lines.push(`\nRecent sessions (last 30 days): ${recentSessions.length}`);
        for (const s of recentSessions.slice(0, 5)) {
          lines.push(`  ${s.session_date} - ${s.status}${s.piece_description ? ": " + s.piece_description : ""}`);
        }
      }

      // Content pipeline
      if (Object.keys(stageCounts).length > 0) {
        lines.push("\nContent pipeline:");
        for (const [stage, count] of Object.entries(stageCounts)) {
          lines.push(`  ${stage}: ${count}`);
        }
      }

      // Upcoming events
      if (events?.length) {
        lines.push("\nUpcoming events:");
        for (const e of events) {
          lines.push(`  ${e.date_start}${e.date_end ? "-" + e.date_end : ""} [${e.event_type}] ${e.title}${e.location ? " at " + e.location : ""}`);
        }
      } else {
        lines.push("\nNo upcoming events.");
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// --- Cross-Extension Intelligence ---

server.registerTool(
  "full_context",
  {
    title: "Full Context",
    description:
      "Get everything the brain knows about a person, topic, or subject. Searches across all tables: thoughts, clients, sessions, content, and events. Use this before a client meeting, when preparing for a convention, or when you need the complete picture on anything.",
    inputSchema: {
      query: z.string().describe("Person name, topic, or subject to look up"),
    },
  },
  async ({ query }) => {
    try {
      const sections: string[] = [`## Full Context: "${query}"\n`];

      // 1. Semantic search on thoughts
      let relatedThoughts: { content: string; similarity: number; metadata: Record<string, unknown>; created_at: string }[] = [];
      try {
        const qEmb = await getEmbedding(query);
        const { data } = await supabase.rpc("match_thoughts", {
          query_embedding: qEmb,
          match_threshold: 0.35,
          match_count: 15,
          filter: {},
        });
        relatedThoughts = data || [];
      } catch {
        // Non-fatal
      }

      // Also check metadata.people for the query as a person name
      const { data: peopleThoughts } = await supabase
        .from("thoughts")
        .select("content, metadata, created_at")
        .contains("metadata", { people: [query] })
        .order("created_at", { ascending: false })
        .limit(10);

      // Also check metadata.topics
      const { data: topicThoughts } = await supabase
        .from("thoughts")
        .select("content, metadata, created_at")
        .contains("metadata", { topics: [query.toLowerCase()] })
        .order("created_at", { ascending: false })
        .limit(10);

      // Merge and dedup thoughts
      const thoughtMap = new Map<string, { content: string; metadata: Record<string, unknown>; created_at: string; similarity?: number }>();
      for (const t of relatedThoughts) {
        thoughtMap.set(t.content, { ...t });
      }
      for (const t of [...(peopleThoughts || []), ...(topicThoughts || [])]) {
        if (!thoughtMap.has(t.content)) {
          thoughtMap.set(t.content, t);
        }
      }
      const allThoughts = Array.from(thoughtMap.values())
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 15);

      // 2. Client match
      const { data: clients } = await supabase
        .from("clients")
        .select("*")
        .ilike("name", `%${query}%`)
        .limit(5);

      // 3. Sessions for matched clients
      const clientIds = (clients || []).map((c) => c.id);
      let sessions: Record<string, unknown>[] = [];
      if (clientIds.length > 0) {
        const { data } = await supabase
          .from("client_sessions")
          .select("*")
          .in("client_id", clientIds)
          .order("session_date", { ascending: false })
          .limit(10);
        sessions = data || [];
      }

      // 4. Content items matching query in title, subject, or linked to matched clients
      const { data: contentBySubject } = await supabase
        .from("content_items")
        .select("*")
        .or(`title.ilike.%${query}%,subject.ilike.%${query}%`)
        .order("created_at", { ascending: false })
        .limit(10);

      let contentByClient: Record<string, unknown>[] = [];
      if (clientIds.length > 0) {
        const { data } = await supabase
          .from("content_items")
          .select("*")
          .in("client_id", clientIds)
          .order("created_at", { ascending: false })
          .limit(10);
        contentByClient = data || [];
      }

      // Merge content
      const contentMap = new Map<string, Record<string, unknown>>();
      for (const c of [...(contentBySubject || []), ...contentByClient]) {
        contentMap.set(c.id as string, c);
      }
      const allContent = Array.from(contentMap.values()).slice(0, 10);

      // 5. Business events matching query
      const { data: events } = await supabase
        .from("business_events")
        .select("*")
        .or(`title.ilike.%${query}%,location.ilike.%${query}%,notes.ilike.%${query}%`)
        .order("date_start", { ascending: false })
        .limit(10);

      // Assemble response
      if (clients && clients.length > 0) {
        sections.push("### Clients");
        for (const c of clients) {
          const lines = [`**${c.name}**`];
          if (c.email) lines.push(`Email: ${c.email}`);
          if (c.phone) lines.push(`Phone: ${c.phone}`);
          if (c.instagram) lines.push(`Instagram: @${c.instagram}`);
          if (c.preferred_styles?.length) lines.push(`Styles: ${c.preferred_styles.join(", ")}`);
          if (c.notes) lines.push(`Notes: ${c.notes}`);
          if (c.last_contact) lines.push(`Last contact: ${new Date(c.last_contact).toLocaleDateString()}`);
          sections.push(lines.join("\n"));
        }
      }

      if (sessions.length > 0) {
        sections.push("\n### Session History");
        for (const s of sessions as { session_date: string; status: string; piece_description?: string; placement?: string; style?: string; duration_hours?: number; notes?: string }[]) {
          const parts = [`${s.session_date || "TBD"} - ${s.status}`];
          if (s.piece_description) parts.push(`| ${s.piece_description}`);
          if (s.placement) parts.push(`| ${s.placement}`);
          if (s.style) parts.push(`| ${s.style}`);
          if (s.duration_hours) parts.push(`| ${s.duration_hours}h`);
          if (s.notes) parts.push(`| ${s.notes}`);
          sections.push(parts.join(" "));
        }
      }

      if (allContent.length > 0) {
        sections.push("\n### Related Content");
        for (const c of allContent as { content_type: string; title?: string; subject?: string; stage: string; platform?: string; published_date?: string }[]) {
          const parts = [`${c.content_type}`];
          if (c.title) parts.push(`"${c.title}"`);
          if (c.subject) parts.push(`(${c.subject})`);
          parts.push(`[${c.stage}]`);
          if (c.platform) parts.push(`on ${c.platform}`);
          if (c.published_date) parts.push(`published ${c.published_date}`);
          sections.push(`- ${parts.join(" ")}`);
        }
      }

      if (events && events.length > 0) {
        sections.push("\n### Business Events");
        for (const e of events) {
          const parts = [`${e.date_start || "TBD"}${e.date_end ? " to " + e.date_end : ""}`];
          parts.push(`[${e.event_type}]`);
          parts.push(e.title);
          if (e.location) parts.push(`at ${e.location}`);
          sections.push(`- ${parts.join(" ")}`);
        }
      }

      if (allThoughts.length > 0) {
        sections.push("\n### Brain Thoughts");
        for (const t of allThoughts) {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics) ? ` (${(m.topics as string[]).join(", ")})` : "";
          const sim = (t as { similarity?: number }).similarity;
          const simStr = sim ? ` [${(sim * 100).toFixed(0)}%]` : "";
          sections.push(`- [${new Date(t.created_at).toLocaleDateString()}]${tags}${simStr} ${t.content}`);
        }
      }

      // Summary line
      const counts = [
        clients?.length ? `${clients.length} client(s)` : null,
        sessions.length ? `${sessions.length} session(s)` : null,
        allContent.length ? `${allContent.length} content item(s)` : null,
        events?.length ? `${events.length} event(s)` : null,
        allThoughts.length ? `${allThoughts.length} thought(s)` : null,
      ].filter(Boolean);

      if (counts.length === 0) {
        return { content: [{ type: "text" as const, text: `No information found for "${query}" across any table.` }] };
      }

      sections.splice(1, 0, `Found: ${counts.join(", ")}\n`);

      return { content: [{ type: "text" as const, text: sections.join("\n") }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// --- Wiki Compiled Pages MCP Tools ---

server.registerTool(
  "get_compiled_page",
  {
    title: "Get Compiled Page",
    description:
      "Read a pre-synthesized wiki page by slug or by name and type. Compiled pages are persistent reference documents maintained by the digest engine. Use this for client context, topic overviews, or project summaries instead of searching raw thoughts.",
    inputSchema: {
      slug: z.string().optional().describe(`Page slug, e.g. 'client/${slugify(loadProfile().example_person_name)}' or 'topic/${slugify(loadProfile().domain.vocabulary[0])}'`),
      name: z.string().optional().describe("Page title to search for (used if slug not provided)"),
      page_type: z.string().optional().describe("Filter by type: client, topic, project (used with name search)"),
    },
  },
  async ({ slug, name, page_type }) => {
    try {
      if (!slug && !name) {
        return { content: [{ type: "text" as const, text: "Provide either slug or name." }], isError: true };
      }

      let page;
      if (slug) {
        const { data, error } = await supabase
          .from("compiled_pages")
          .select("slug, title, page_type, content, backlinks, last_compiled")
          .eq("slug", slug)
          .single();
        if (error || !data) {
          return { content: [{ type: "text" as const, text: `No compiled page found for slug "${slug}".` }] };
        }
        page = data;
      } else {
        let q = supabase
          .from("compiled_pages")
          .select("slug, title, page_type, content, backlinks, last_compiled")
          .ilike("title", `%${name}%`);
        if (page_type) q = q.eq("page_type", page_type);
        const { data, error } = await q.limit(1);
        if (error || !data?.length) {
          return { content: [{ type: "text" as const, text: `No compiled page found matching "${name}".` }] };
        }
        page = data[0];
      }

      const lines = [
        `## ${page.title}`,
        `Type: ${page.page_type} | Slug: ${page.slug}`,
        `Last compiled: ${page.last_compiled ? new Date(page.last_compiled).toLocaleString() : "never"}`,
      ];
      if (page.backlinks?.length) {
        lines.push(`Backlinks: ${page.backlinks.join(", ")}`);
      }
      lines.push("", page.content || "(empty page, not yet compiled)");

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "search_compiled_pages",
  {
    title: "Search Compiled Pages",
    description:
      "Search wiki pages by keyword in title or content. Returns page summaries, not full content. Use to find which compiled pages exist on a subject.",
    inputSchema: {
      query: z.string().describe("Search term"),
      page_type: z.string().optional().describe("Filter by type: client, topic, project"),
      limit: z.number().optional().default(10),
    },
  },
  async ({ query, page_type, limit }) => {
    try {
      let q = supabase
        .from("compiled_pages")
        .select("slug, title, page_type, last_compiled, content")
        .or(`title.ilike.%${query}%,content.ilike.%${query}%`)
        .order("last_compiled", { ascending: false, nullsFirst: false })
        .limit(limit);
      if (page_type) q = q.eq("page_type", page_type);

      const { data, error } = await q;
      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
      if (!data?.length) return { content: [{ type: "text" as const, text: `No compiled pages found matching "${query}".` }] };

      const results = data.map((p) => {
        const preview = p.content ? p.content.substring(0, 150).replace(/\n/g, " ") + "..." : "(not yet compiled)";
        const compiled = p.last_compiled ? new Date(p.last_compiled).toLocaleDateString() : "never";
        return `- **${p.title}** [${p.page_type}] (${p.slug}) - compiled ${compiled}\n  ${preview}`;
      });

      return { content: [{ type: "text" as const, text: `Found ${data.length} page(s):\n\n${results.join("\n\n")}` }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "list_compiled_pages",
  {
    title: "List Compiled Pages",
    description:
      "List all wiki pages, optionally filtered by type. Shows titles, types, and compilation status.",
    inputSchema: {
      page_type: z.string().optional().describe("Filter by type: client, topic, project"),
      limit: z.number().optional().default(50),
    },
  },
  async ({ page_type, limit }) => {
    try {
      let q = supabase
        .from("compiled_pages")
        .select("slug, title, page_type, last_compiled")
        .order("page_type", { ascending: true })
        .order("title", { ascending: true })
        .limit(limit);
      if (page_type) q = q.eq("page_type", page_type);

      const { data, error } = await q;
      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
      if (!data?.length) return { content: [{ type: "text" as const, text: "No compiled pages exist yet." }] };

      // Group by type
      const grouped: Record<string, typeof data> = {};
      for (const p of data) {
        if (!grouped[p.page_type]) grouped[p.page_type] = [];
        grouped[p.page_type].push(p);
      }

      const lines: string[] = [`${data.length} compiled page(s):\n`];
      for (const [type, pages] of Object.entries(grouped)) {
        lines.push(`### ${type.toUpperCase()} (${pages.length})`);
        for (const p of pages) {
          const compiled = p.last_compiled ? new Date(p.last_compiled).toLocaleDateString() : "never";
          lines.push(`- ${p.title} (${p.slug}) - compiled ${compiled}`);
        }
        lines.push("");
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// --- REST handler for compiled pages ---

async function handleRestPages(url: URL): Promise<Response> {
  try {
    const slug = url.searchParams.get("slug");
    const type = url.searchParams.get("type");
    const query = url.searchParams.get("query");
    const limit = parseInt(url.searchParams.get("limit") || "20");

    if (slug) {
      // Get specific page by slug
      const { data, error } = await supabase
        .from("compiled_pages")
        .select("slug, title, page_type, content, backlinks, last_compiled")
        .eq("slug", slug)
        .single();
      if (error || !data) return jsonResponse({ error: "Page not found" }, 404);
      return jsonResponse(data);
    }

    // List/search pages
    let q = supabase
      .from("compiled_pages")
      .select("slug, title, page_type, last_compiled")
      .order("title", { ascending: true })
      .limit(limit);
    if (type) q = q.eq("page_type", type);
    if (query) q = q.or(`title.ilike.%${query}%,content.ilike.%${query}%`);

    const { data, error } = await q;
    if (error) return jsonResponse({ error: error.message }, 500);
    return jsonResponse({ count: data?.length || 0, pages: data || [] });
  } catch (err: unknown) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }
}

// --- Hono App with Auth Check ---

const app = new Hono();

app.all("*", async (c) => {
  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Invalid or missing access key" }, 401);
  }
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

// Route REST API requests before MCP protocol.
// REST routes serve ChatGPT custom GPT Actions and other REST clients.
// MCP protocol (JSON-RPC over HTTP) continues to serve Claude and other MCP clients.
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname.split("/open-brain-mcp").pop() || "/";

  // REST API routes
  if (path === "/search" || path === "/list" || path === "/stats" || path === "/capture" || path === "/event" || path === "/client" || path === "/pages") {
    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    // Accept auth via: x-brain-key header, Authorization Bearer, or key URL param
    const authHeader = req.headers.get("authorization") || "";
    const bearerKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const provided = req.headers.get("x-brain-key") || bearerKey || url.searchParams.get("key");
    if (!provided || provided !== MCP_ACCESS_KEY) {
      return jsonResponse({ error: "Invalid or missing access key" }, 401);
    }
    if (req.method === "GET" && path === "/search") return handleRestSearch(url);
    if (req.method === "GET" && path === "/list") return handleRestList(url);
    if (req.method === "GET" && path === "/stats") return handleRestStats();
    if (req.method === "POST" && path === "/capture") return handleRestCapture(req);
    if (req.method === "POST" && path === "/event") return handleRestEvent(req);
    if (req.method === "POST" && path === "/client") return handleRestClient(req);
    if (req.method === "GET" && path === "/pages") return handleRestPages(url);
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // MCP protocol (existing behavior)
  // mcp-remote and Claude Desktop may omit the Accept: text/event-stream
  // header that @hono/mcp's StreamableHTTPTransport requires, causing
  // silent 406 failures. This injects the header before Hono sees the request.
  if (req.method === "POST") {
    const accept = req.headers.get("accept") || "";
    if (!accept.includes("text/event-stream")) {
      const newHeaders = new Headers(req.headers);
      newHeaders.set(
        "accept",
        accept
          ? `${accept}, text/event-stream`
          : "application/json, text/event-stream"
      );
      const patched = new Request(req.url, {
        method: req.method,
        headers: newHeaders,
        body: req.body,
      });
      return app.fetch(patched);
    }
  }
  return app.fetch(req);
});
