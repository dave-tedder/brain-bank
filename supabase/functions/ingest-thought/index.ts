import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { loadProfile } from "../_shared/profile.ts";
import {
  coerceMetadata,
  loadKnownSlugs,
  shouldExtractActionItems,
} from "../_shared/metadata-validation.ts";
import { filterCandidatesForDone } from "../_shared/done-filter.ts";
import { stillOwedAdjacencyVeto } from "../_shared/still-owed-veto.ts";

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN")!;
const SLACK_CAPTURE_CHANNEL = Deno.env.get("SLACK_CAPTURE_CHANNEL")!;
const SLACK_BRAIN_CHANNEL = Deno.env.get("SLACK_BRAIN_CHANNEL") || "";
const SLACK_QUERY_CHANNEL = Deno.env.get("SLACK_QUERY_CHANNEL") || "";
const SLACK_SIGNING_SECRET = Deno.env.get("SLACK_SIGNING_SECRET") || "";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- HMAC-SHA256 Signature Verification ---

async function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null
): Promise<boolean> {
  if (!SLACK_SIGNING_SECRET || !timestamp || !signature) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(sigBasestring));
  const hexSig = "v0=" + Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return constantTimeEqual(hexSig, signature);
}

// Compares two strings in constant time relative to their length. Defense
// against timing-side-channel attacks on Slack signature verification: `===`
// short-circuits at the first byte mismatch, leaking position via response
// time. Practical attack surface is negligible at this layer (network jitter
// dominates), but the constant-time comparison is best practice and costs one
// loop. Always returns false if lengths differ.
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// --- Shared Utilities ---

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
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
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text }),
  });
  const d = await r.json();
  return d.data[0].embedding;
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
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
- "topics": array of 1-3 short lowercase topic tags, e.g. "${loadProfile().domain.vocabulary[0]}" not "${titleCase(loadProfile().domain.vocabulary[0])}", "project management" not "Project Management" (always at least one). Preserve hyphenated tokens as a single tag: "fitness-training" stays as one tag, never split into ["fitness", "training"].
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

async function replyInSlack(channel: string, threadTs: string, text: string): Promise<void> {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  });
}

// --- Slack Thread Helpers ---

async function fetchSlackThread(
  channel: string,
  threadTs: string
): Promise<Array<{ text: string; user?: string; ts: string; bot_id?: string }>> {
  const url = `https://slack.com/api/conversations.replies?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs)}&limit=50`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });
  const d = await r.json();
  if (!d.ok) {
    console.error("Slack conversations.replies error:", d.error);
    return [];
  }
  return d.messages || [];
}

async function synthesizeContextualQuery(
  threadHistory: string,
  latestMessage: string
): Promise<string> {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You generate search queries for a personal knowledge base. Given a conversation thread and the user's latest follow-up, produce a single concise search query that captures what the user wants, incorporating relevant context from the conversation. Return ONLY the query text, nothing else.",
        },
        {
          role: "user",
          content: `Previous conversation:\n${threadHistory}\n\nLatest follow-up: ${latestMessage}\n\nGenerate a contextual search query.`,
        },
      ],
    }),
  });
  const d = await r.json();
  return d.choices[0].message.content.trim();
}

// --- Answer Synthesis ---

async function synthesizeAnswer(
  query: string,
  results: Array<{ content: string; metadata: Record<string, unknown>; similarity: number; created_at: string }>
): Promise<string> {
  const context = results
    .map((t, i) => {
      const date = new Date(t.created_at).toLocaleDateString();
      const topics = Array.isArray(t.metadata?.topics) ? (t.metadata.topics as string[]).join(", ") : "";
      return `[${i + 1}] (${date}${topics ? ", " + topics : ""}) ${t.content}`;
    })
    .join("\n\n");

  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a personal memory assistant responding to queries about someone's captured thoughts and notes. Given the search results below, synthesize a natural conversational answer. Be direct and concise. Speak as if you're a knowledgeable friend recalling details. Only use information from the provided results. If the results only partially answer the question, share what you have and note what's missing. Do not use bullet points or numbered lists. Do not mention similarity scores or search mechanics.`,
        },
        {
          role: "user",
          content: `Query: ${query}\n\nSearch results:\n${context}`,
        },
      ],
    }),
  });
  const d = await r.json();
  return d.choices[0].message.content.trim();
}

// --- Query Handling ---

function parseQuery(text: string): string | null {
  const match = text.match(/^(?:search|ask):\s*(.+)/i);
  return match ? match[1].trim() : null;
}

async function handleQuery(queryText: string, channel: string, messageTs: string, threshold: number = 0.4): Promise<void> {
  try {
    const qEmb = await getEmbedding(queryText);
    const { data, error } = await supabase.rpc("match_thoughts", {
      query_embedding: qEmb,
      match_threshold: threshold,
      match_count: 5,
      filter: {},
    });

    if (error) {
      await replyInSlack(channel, messageTs, `Search error: ${error.message}`);
      return;
    }

    if (!data || data.length === 0) {
      await replyInSlack(channel, messageTs, `Nothing in the brain about "${queryText}".`);
      return;
    }

    const answer = await synthesizeAnswer(queryText, data);
    await replyInSlack(channel, messageTs, answer);
  } catch (err) {
    console.error("Query error:", err);
    await replyInSlack(channel, messageTs, "Something went wrong searching your brain.");
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
  metadata: Record<string, unknown>,
  content: string
): Promise<void> {
  // Observations, references, and email-sourced captures are descriptive,
  // not commitment-shaped, so they must not create open action items.
  if (!shouldExtractActionItems(metadata)) return;

  // Mirror of LAYER 0 in checkAutoResolve: mechanical captures (sync jobs, email
  // threads, weekly reviews) are observation-shaped, not commitment-shaped. The
  // extraction LLM may still pick up advisory phrases ("should reduce volume",
  // "needs more sleep") from prose summaries; suppress storing those as open
  // action items so they don't pollute the digest's open-items section.
  if (isMechanicalCapture(content)) return;

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

  // Scope by project, topic, or person in SQL before LIMIT so older matching
  // items remain reachable without loading the full open queue.
  type EnrichedItem = {
    id: string;
    description: string;
    source_thought_id: string;
    src_project: string | null;
    src_topics: string[];
    src_people: string[];
  };

  const { data: enrichedRaw, error } = await supabase.rpc("find_candidate_action_items", {
    p_project: newProject,
    p_topics: newTopics,
    p_people: newPeople,
    p_exclude_source_ids: excludeSourceThoughtIds,
  });

  if (error || !enrichedRaw || (enrichedRaw as EnrichedItem[]).length === 0) return [];

  let candidateItems = enrichedRaw as EnrichedItem[];

  // LAYER 1.5: restatement guard. If the new thought's own extracted action_items
  // are semantically similar to a candidate's description, the new thought is
  // RE-CAPTURING that work, not completing it. Drop those candidates before the
  // LLM sees them. Prevents the classic "I really need to research X" capture
  // from being mistakenly read as completion of a pending action item just
  // because both share topical vocabulary.
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

  // LAYER 2: stricter LLM prompt with per-candidate context so the model
  // can see cross-context mismatches and must justify each claimed resolution.
  const itemList = candidateItems
    .map((item, i) => {
      const ctx = [
        item.src_project ? `project=${item.src_project}` : null,
        item.src_topics.length > 0 ? `topics=${item.src_topics.join("/")}` : null,
        item.src_people.length > 0 ? `people=${item.src_people.join("/")}` : null,
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
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
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
5. READINESS, UNBLOCKING, or STILL-TO-DO SIGNALS NEVER resolve anything. A note phrased with a verb or marker that describes the PRE-WORK state — "unblocked", "cleared", "un-gated", "ready", "readied", "prepped", "prepared", "queued", "slated", "planned", "staged", "teed up", "lined up", "kicked off", "approved", or "authorized" — OR a marker that explicitly frames work as NOT YET DONE — "remaining", "outstanding", "to-do", "todo", "deferred", "pending", "yet to", "still to", "still need", "next", "follows", "to follow" — is announcing that work is about to BEGIN or is still owed, not that it has been completed. Even if the subject matches a candidate exactly, do NOT resolve — "X unblocked" or "Remaining: X" means X is still on the list, not that X has been done. Return [] for this entry.
6. When unsure, do NOT resolve. Empty array is the correct default.

For each match you return, the "reason" field must quote the specific phrase in the note that PROVES completion. The quote must contain an explicit past-tense completion verb ("shipped", "fixed", "finished", "deployed", "merged", "submitted", "completed", "cancelled", "closed", "sent") or an explicit forward-reference ("scheduled for Friday"). Readiness or still-to-do markers — "unblocked", "cleared", "ready", "prepped", "queued", "staged", "kicked off", "approved", "remaining", "outstanding", "pending", "to-do", "deferred", "yet to", "still to", "still need", "next", "follows" — do NOT count as completion; they describe the state before the work, or work that is still owed. If you cannot produce such a quote, do not include the match.`,
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
  // resolved by "Notion token rotation COMPLETE").
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
    const stillOwed = stillOwedAdjacencyVeto(newThoughtContent, item.description, stem);
    if (stillOwed.vetoed) {
      console.log(
        `checkAutoResolve: LAYER 3.5 still-owed veto dropped item ${item.id} ` +
          `(marker=${stillOwed.marker}, subject=${stillOwed.subject}, dist=${stillOwed.distance}, ` +
          `note=${JSON.stringify(newThoughtContent.slice(0, LOG_TRUNC))})`
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
  // Store any new action items from this thought
  await extractAndStoreActionItems(thoughtId, metadata, content);

  // Check if this thought resolves any existing open items
  // Exclusion list prevents same-thread items from being falsely resolved
  const resolved = await checkAutoResolve(content, thoughtId, metadata, excludeSourceThoughtIds);
  return resolved;
}

// --- "done:" Command ---

async function handleDoneCommand(
  text: string,
  channel: string,
  messageTs: string
): Promise<void> {
  const doneText = text.replace(/^done:\s*/i, "").trim();
  if (!doneText) {
    await replyInSlack(channel, messageTs, "What was completed? Use: `done: description of what's done`");
    return;
  }

  const { data: openItems, error } = await supabase
    .from("action_items")
    .select("id, description")
    .eq("status", "open")
    .order("created_at", { ascending: false });

  if (error || !openItems || openItems.length === 0) {
    await replyInSlack(channel, messageTs, "No open action items to close.");
    return;
  }

  const filteredItems = filterCandidatesForDone(doneText, openItems, 200);
  const itemList = filteredItems
    .map((item, i) => `${i + 1}. ${item.description}`)
    .join("\n");

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
          content: `The user says they completed something. Match their description against the open action items list. Return JSON: {"matched": [1, 3]} with the numbers of items that match what the user says is done. If no clear match, return {"matched": []}.`,
        },
        {
          role: "user",
          content: `User says done: "${doneText}"\n\nOpen action items:\n${itemList}`,
        },
      ],
    }),
  });

  const d = await r.json();
  let matched: number[] = [];
  try {
    const parsed = JSON.parse(d.choices[0].message.content);
    matched = Array.isArray(parsed.matched) ? parsed.matched : [];
  } catch {
    await replyInSlack(channel, messageTs, "Couldn't parse the response. Try being more specific.");
    return;
  }

  if (matched.length === 0) {
    await replyInSlack(channel, messageTs, `No matching open items found for "${doneText}".`);
    return;
  }

  const closed: string[] = [];
  const now = new Date().toISOString();
  for (const num of matched) {
    const idx = num - 1;
    if (idx >= 0 && idx < filteredItems.length) {
      const item = filteredItems[idx];
      await supabase
        .from("action_items")
        .update({ status: "resolved", resolved_at: now })
        .eq("id", item.id);
      closed.push(item.description);
    }
  }

  await replyInSlack(
    channel,
    messageTs,
    `Marked ${closed.length} item${closed.length > 1 ? "s" : ""} as done:\n${closed.map((d) => `- ${d}`).join("\n")}`
  );
}

// --- Capture Processing ---

async function processCaptureMessage(
  messageText: string,
  channel: string,
  messageTs: string
): Promise<void> {
  try {
    const hash = await contentHash(messageText);
    if (await isDuplicate(hash)) {
      await replyInSlack(channel, messageTs, "Already in the brain (duplicate detected).");
      return;
    }

    const [embedding, rawMetadata] = await Promise.all([
      getEmbedding(messageText),
      extractMetadata(messageText),
    ]);
    const knownSlugs = await loadKnownSlugs(supabase);
    const coerced = coerceMetadata(rawMetadata, knownSlugs, messageText);
    const finalMetadata = { ...coerced, source: "slack", slack_ts: messageTs } as Record<string, unknown>;

    const insertData = {
      content: messageText,
      embedding,
      content_hash: hash,
      metadata: finalMetadata,
    };
    const { data: inserted, error } = await supabase.from("thoughts").insert(insertData).select("id").single();

    if (error || !inserted) {
      console.error("Supabase insert error:", error);
      await replyInSlack(channel, messageTs, `Failed to capture: ${error?.message || "unknown error"}`);
      return;
    }

    // Post-capture: track action items and auto-resolve
    const resolved = await postCaptureHook(inserted.id, messageText, finalMetadata, [inserted.id]);

    const meta = finalMetadata;
    let confirmation = `Captured as *${meta.type || "thought"}*`;
    if (Array.isArray(meta.topics) && meta.topics.length > 0)
      confirmation += ` - ${meta.topics.join(", ")}`;
    if (Array.isArray(meta.people) && meta.people.length > 0)
      confirmation += `\nPeople: ${meta.people.join(", ")}`;
    if (Array.isArray(meta.action_items) && meta.action_items.length > 0)
      confirmation += `\nAction items: ${meta.action_items.join("; ")}`;
    if (resolved.length > 0)
      confirmation += `\n:white_check_mark: Auto-resolved: ${resolved.join("; ")}`;

    await replyInSlack(channel, messageTs, confirmation);
  } catch (err) {
    console.error("Capture processing error:", err);
  }
}

// --- Thread-Aware Capture (Feature 1) ---

async function processCaptureThreadReply(
  replyText: string,
  channel: string,
  messageTs: string,
  threadTs: string
): Promise<void> {
  try {
    // Fetch parent message for context
    const threadMessages = await fetchSlackThread(channel, threadTs);
    const parentText = threadMessages.length > 0 ? threadMessages[0].text : null;

    // Combine parent context with reply for richer embedding. Metadata is
    // extracted from the reply alone so parent language cannot contaminate it.
    const contextualText = parentText
      ? `${parentText}\n\n${replyText}`
      : replyText;

    const hash = await contentHash(contextualText);
    if (await isDuplicate(hash)) {
      await replyInSlack(channel, threadTs, "Already in the brain (duplicate detected).");
      return;
    }

    const [embedding, rawMetadata] = await Promise.all([
      getEmbedding(contextualText),
      extractMetadata(replyText),
    ]);
    const knownSlugs = await loadKnownSlugs(supabase);
    const coerced = coerceMetadata(rawMetadata, knownSlugs, replyText);
    const finalMetadata = {
      ...coerced,
      source: "slack",
      slack_ts: messageTs,
      parent_slack_ts: threadTs,
    } as Record<string, unknown>;

    const insertData = {
      content: contextualText,
      embedding,
      content_hash: hash,
      metadata: finalMetadata,
    };
    const { data: inserted, error } = await supabase.from("thoughts").insert(insertData).select("id").single();

    if (error || !inserted) {
      console.error("Supabase insert error:", error);
      await replyInSlack(channel, threadTs, `Failed to capture: ${error?.message || "unknown error"}`);
      return;
    }

    // Look up the parent thought's ID so we can exclude its action items from auto-resolve
    const excludeIds = [inserted.id]; // always exclude self
    const { data: parentThought } = await supabase
      .from("thoughts")
      .select("id")
      .eq("metadata->>slack_ts", threadTs)
      .limit(1)
      .single();
    if (parentThought?.id) excludeIds.push(parentThought.id);

    // Post-capture: track action items and auto-resolve
    // Layer A: excludeIds prevents same-thread items from being candidates
    // Layer B: replyText (not contextualText) prevents parent language from poisoning the LLM
    const resolved = await postCaptureHook(inserted.id, replyText, finalMetadata, excludeIds);

    const meta = finalMetadata;
    let confirmation = `Captured as *${meta.type || "thought"}* (with thread context)`;
    if (Array.isArray(meta.topics) && meta.topics.length > 0)
      confirmation += ` - ${meta.topics.join(", ")}`;
    if (Array.isArray(meta.people) && meta.people.length > 0)
      confirmation += `\nPeople: ${meta.people.join(", ")}`;
    if (Array.isArray(meta.action_items) && meta.action_items.length > 0)
      confirmation += `\nAction items: ${meta.action_items.join("; ")}`;
    if (resolved.length > 0)
      confirmation += `\n:white_check_mark: Auto-resolved: ${resolved.join("; ")}`;

    await replyInSlack(channel, threadTs, confirmation);
  } catch (err) {
    console.error("Thread capture processing error:", err);
  }
}

// --- Thread-Aware Query (Feature 2) ---

async function handleQueryThreadReply(
  replyText: string,
  channel: string,
  messageTs: string,
  threadTs: string
): Promise<void> {
  try {
    const threadMessages = await fetchSlackThread(channel, threadTs);

    // Build conversation history, excluding the current reply
    const history = threadMessages
      .filter((m) => m.ts !== messageTs)
      .map((m) => {
        const role = m.bot_id ? "Brain-Bot" : "User";
        return `${role}: ${m.text}`;
      })
      .join("\n");

    const synthesizedQuery = await synthesizeContextualQuery(history, replyText);
    console.log(
      `Thread query synthesized: "${replyText.slice(0, LOG_TRUNC)}" → "${synthesizedQuery.slice(0, LOG_TRUNC)}"`,
    );

    await handleQuery(synthesizedQuery, channel, threadTs, 0.3);
  } catch (err) {
    console.error("Query thread reply error:", err);
    await replyInSlack(channel, threadTs, "Something went wrong processing your follow-up question.");
  }
}

// --- Silent Brain Channel Processing ---

async function processBrainMessage(messageText: string, messageTs: string): Promise<void> {
  try {
    const hash = await contentHash(messageText);
    if (await isDuplicate(hash)) return; // silent channel, silent skip

    const [embedding, rawMetadata] = await Promise.all([
      getEmbedding(messageText),
      extractMetadata(messageText),
    ]);
    const knownSlugs = await loadKnownSlugs(supabase);
    const coerced = coerceMetadata(rawMetadata, knownSlugs, messageText);
    const finalMetadata = { ...coerced, source: "brain-channel", slack_ts: messageTs } as Record<string, unknown>;

    const { data: inserted, error } = await supabase.from("thoughts").insert({
      content: messageText,
      embedding,
      content_hash: hash,
      metadata: finalMetadata,
    }).select("id").single();

    if (error || !inserted) {
      console.error("Brain channel insert error:", error);
      return;
    }

    // Post-capture: track action items and auto-resolve (silent, no Slack reply)
    await postCaptureHook(inserted.id, messageText, finalMetadata, [inserted.id]);
  } catch (err) {
    console.error("Brain channel processing error:", err);
  }
}

// --- Main Handler ---

Deno.serve(async (req: Request): Promise<Response> => {
  try {
    const rawBody = await req.text();

    if (SLACK_SIGNING_SECRET) {
      const timestamp = req.headers.get("x-slack-request-timestamp");
      const signature = req.headers.get("x-slack-signature");
      const valid = await verifySlackSignature(rawBody, timestamp, signature);
      if (!valid) {
        console.error("HMAC verification failed");
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const body = JSON.parse(rawBody);

    if (body.type === "url_verification") {
      return new Response(JSON.stringify({ challenge: body.challenge }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const event = body.event;
    if (!event || event.type !== "message" || event.subtype || event.bot_id) {
      return new Response("ok", { status: 200 });
    }

    const messageText: string = event.text;
    const channel: string = event.channel;
    const messageTs: string = event.ts;
    const threadTs: string | undefined = event.thread_ts;

    if (!messageText || messageText.trim() === "") {
      return new Response("ok", { status: 200 });
    }

    // Route based on channel and thread context
    if (channel === SLACK_CAPTURE_CHANNEL) {
      const queryText = parseQuery(messageText);
      const isDoneCommand = /^done:\s*/i.test(messageText);
      if (isDoneCommand) {
        EdgeRuntime.waitUntil(handleDoneCommand(messageText, channel, messageTs));
      } else if (queryText) {
        EdgeRuntime.waitUntil(handleQuery(queryText, channel, messageTs, 0.4));
      } else if (threadTs) {
        // Thread reply: capture with parent context baked into embedding
        EdgeRuntime.waitUntil(processCaptureThreadReply(messageText, channel, messageTs, threadTs));
      } else {
        EdgeRuntime.waitUntil(processCaptureMessage(messageText, channel, messageTs));
      }
    } else if (channel === SLACK_QUERY_CHANNEL) {
      if (threadTs) {
        // Thread reply: synthesize contextual query from conversation history
        EdgeRuntime.waitUntil(handleQueryThreadReply(messageText, channel, messageTs, threadTs));
      } else {
        // Top-level message: direct search
        EdgeRuntime.waitUntil(handleQuery(messageText, channel, messageTs, 0.3));
      }
    } else if (channel === SLACK_BRAIN_CHANNEL) {
      EdgeRuntime.waitUntil(processBrainMessage(messageText, messageTs));
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("Function error:", err);
    return new Response("error", { status: 500 });
  }
});
