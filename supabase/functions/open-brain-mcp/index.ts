import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { loadProfile } from "../_shared/profile.ts";
import {
  coerceMetadata,
  isOperationCommandCapture,
  loadKnownSlugs,
  shouldExtractActionItems,
} from "../_shared/metadata-validation.ts";
import { stillOwedAdjacencyVeto } from "../_shared/still-owed-veto.ts";
import { extractJsonObject } from "../_shared/extract-json.ts";
import { callOpenRouter } from "../_shared/openrouter.ts";
import {
  AGENT_TASK_INTAKE_SOURCES,
  type AgentTaskIntakeSource,
  buildAgentTaskIntakeRecord,
} from "./_agent_intake.ts";
import {
  AGENT_TASK_STATUSES,
  type AgentTaskAccessRow,
  type AgentTaskRisk,
  type AgentTaskStatus,
  type AgentTaskToolAction,
  assertAgentCanWriteTask,
  assertClaimAllowed,
  assertIntakePromotionAllowed,
  assertResumeTransitionAllowed,
  assertStatusHeartbeatAllowed,
  compactObject,
  isAgentTaskRisk,
  isLedgerAutomationState,
  receiptForTaskTool,
} from "./_agent_tasks.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const FUNCTION_SLUG = "open-brain-mcp";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Deno Edge Runtime exposes EdgeRuntime as a global; declare it for the type
// checker so the workspace deno check stays at 0 errors.
declare const EdgeRuntime: {
  waitUntil: (p: PromiseLike<unknown>) => void;
};

// Fire-and-forget telemetry write to public.mcp_tool_invocations. Never throws,
// never blocks the tool response. Called from registered MCP tool handlers.
// EdgeRuntime.waitUntil follows the project's existing pattern (see
// ingest-thought handler dispatch).
function logToolInvocation(
  toolName: string,
  args: Record<string, unknown>,
  source: "mcp" | "rest",
): void {
  const writePromise = supabase
    .from("mcp_tool_invocations")
    .insert({ tool_name: toolName, args, source })
    .then((r: { error?: { message?: string } | null }) => {
      if (r.error) {
        console.error(
          `[mcp-tool-log] insert failed for ${toolName}: ${r.error.message}`,
        );
      }
    });
  EdgeRuntime.waitUntil(writePromise);
}

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

// Sync-source captures (e.g. a Notion database sync) dedup on the source
// record's identity + last-edited timestamp instead of content hash. A sync
// re-renders each record into a capture string that drifts on cosmetic
// changes (whitespace, em-dash vs double-dash, a field toggling to/from
// "N/A"), defeating the SHA-256 content hash. The source's last-edited
// timestamp only advances when the record actually changes, so an unchanged
// re-sync is correctly skipped while a genuine edit still lands a fresh
// capture.
async function isNotionDuplicate(
  pageId: string,
  lastEdited: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("thoughts")
    .select("id")
    .eq("metadata->>notion_page_id", pageId)
    .eq("metadata->>notion_last_edited", lastEdited)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

async function getEmbedding(text: string): Promise<number[]> {
  const { data } = await callOpenRouter({
    function_slug: FUNCTION_SLUG,
    call_site: "getEmbedding",
    model: "openai/text-embedding-3-small",
    endpoint: "embeddings",
    input: text,
  });
  return data.data![0].embedding!;
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const { data } = await callOpenRouter({
    function_slug: FUNCTION_SLUG,
    call_site: "extractMetadata",
    model: "openai/gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned by full name when possible, e.g. "${loadProfile().example_person_name}" (use full name when possible) (empty if none)
- "action_items": array of FUTURE to-dos the user still needs to do. STRICT RULES:
    * Only include items phrased as future work: "need to X", "should X", "TODO: X", an imperative about something not yet done, or an explicit open question.
    * NEVER include work described in past tense. If the note says "I updated X", "fixed Y", "shipped Z", "changed the ratio to 3px/1px", "replaced the background", those are DONE and must be excluded.
    * NEVER restate completed work as an imperative. Do not turn "updated the ratio to 3px" into "Update the ratio to 3px".
    * Session logs, changelogs, retrospectives, and "here's what I just did" summaries almost always have an empty action_items array. Default to [] when in doubt.
    * A commitment to do something later ("I'll test this tomorrow") IS an action item. A description of something already tested is NOT.
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short lowercase topic tags, e.g. "${
            loadProfile().domain.vocabulary[0]
          }" not "${
            titleCase(loadProfile().domain.vocabulary[0])
          }", "project management" not "Project Management" (always at least one). Preserve hyphenated tokens as a single tag: "fitness-training" stays as one tag, never split into ["fitness", "training"].
- "type": one of "observation", "task", "idea", "reference", "person_note". Past-tense summaries are "observation", not "task".
- "project": the project or system this note is ABOUT, e.g. ${
            loadProfile().example_projects.map((p) => `"${p}"`).join(", ")
          }, "${loadProfile().example_domain}". Only fill this when the note explicitly references a known project by name or is clearly session-log content for one. If the note is a marketing email, utility bill, tax reminder, or random inbox item with no project context, return null. Do NOT guess a project from topical similarity.
- "priority": "high" if urgent/time-sensitive/revenue-impacting, "low" if informational/FYI, "normal" otherwise (null if unclear)

Template prefix hints: if the thought starts with DECISION:, CLIENT:, IDEA:, or MEETING:, use that to inform the type field (decision->observation, CLIENT->person_note, IDEA->idea, MEETING->observation) and extract structured fields accordingly.

Only extract what's explicitly there. Be conservative — empty arrays and null fields are fine.`,
      },
      { role: "user", content: text },
    ],
  });
  const d = data as { choices: Array<{ message: { content: string } }> };
  try {
    return JSON.parse(d.choices![0].message!.content!);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

// --- Action Item Tracking ---

function normalizeActionText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ")
    .trim();
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

// MCP tool-surface enum values sourced from profile. See task 3.8 spec at
// docs/superpowers/specs/2026-04-20-event-type-enum-profile-wiring-design.md
const eventTypes = loadProfile().event_types;
const contentTypes = loadProfile().content_types;

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
        .map(stem),
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
  content: string,
): Promise<void> {
  // Observations, references, and email-sourced captures are descriptive,
  // not commitment-shaped, so they must not create open action items.
  if (!shouldExtractActionItems(metadata)) return;

  if (isOperationCommandCapture(content, String(metadata?.source ?? ""))) {
    return;
  }

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
    (existingItems || []).map((item) => normalizeActionText(item.description)),
  );

  const rows = items
    .map((desc: unknown) => ({
      source_thought_id: thoughtId,
      description: String(desc),
      status: "open",
    }))
    .filter((row) =>
      !existingNormalized.has(normalizeActionText(row.description))
    );

  if (rows.length === 0) return;
  const { error } = await supabase.from("action_items").insert(rows);
  if (error) console.error("Action item insert error:", error);
}

async function checkAutoResolve(
  newThoughtContent: string,
  newThoughtId: string,
  newMetadata: Record<string, unknown>,
  excludeSourceThoughtIds: string[] = [],
): Promise<string[]> {
  // LAYER 0: structural-source block. Mechanical captures (sync jobs, email
  // threads, weekly reviews, failure reports) carry topic/person metadata that
  // scope-matches real action items but are NOT evidence of completion. Skip
  // auto-resolve entirely — completion signals from these sources must come
  // via a manual `done:` command or a dedicated session-log thought.
  if (isMechanicalCapture(newThoughtContent)) {
    console.log(
      `checkAutoResolve: blocked mechanical capture (prefix match): ${
        newThoughtContent
          .trimStart()
          .slice(0, 80)
      }`,
    );
    return [];
  }

  // Scoping axes from the NEW thought. Auto-resolve is only safe when we can
  // scope candidates by project / topic / person — otherwise we fall back to
  // doing nothing rather than risk a cross-project false positive.
  const newProject = (newMetadata?.project as string | null | undefined) ||
    null;
  const newTopicsRaw = newMetadata?.topics;
  const newTopics: string[] = Array.isArray(newTopicsRaw)
    ? (newTopicsRaw as string[])
    : [];
  const newPeopleRaw = newMetadata?.people;
  const newPeople: string[] = Array.isArray(newPeopleRaw)
    ? (newPeopleRaw as string[])
    : [];

  if (!newProject && newTopics.length === 0 && newPeople.length === 0) {
    return [];
  }

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

  const { data: enrichedRaw, error } = await supabase.rpc(
    "find_candidate_action_items",
    {
      p_project: newProject,
      p_topics: newTopics,
      p_people: newPeople,
      p_exclude_source_ids: excludeSourceThoughtIds,
    },
  );

  if (error || !enrichedRaw || (enrichedRaw as EnrichedItem[]).length === 0) {
    return [];
  }

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
      console.log(
        `checkAutoResolve: restatement guard dropped ${droppedCount} candidate(s)`,
      );
    }
    if (candidateItems.length === 0) return [];
  }

  // LAYER 2: stricter LLM prompt. Include per-candidate context so the model
  // can see cross-context mismatches and must justify each claimed resolution.
  const itemList = candidateItems
    .map((item, i) => {
      const ctx = [
        item.src_project ? `project=${item.src_project}` : null,
        item.src_topics.length > 0
          ? `topics=${item.src_topics.join("/")}`
          : null,
        item.src_people.length > 0
          ? `people=${item.src_people.join("/")}`
          : null,
      ].filter(Boolean).join(", ");
      return `${i + 1}. [${ctx || "no-context"}] ${item.description}`;
    })
    .join("\n");

  const newCtx = [
    newProject ? `project=${newProject}` : null,
    newTopics.length > 0 ? `topics=${newTopics.join("/")}` : null,
    newPeople.length > 0 ? `people=${newPeople.join("/")}` : null,
  ].filter(Boolean).join(", ");

  const { data } = await callOpenRouter({
    function_slug: FUNCTION_SLUG,
    call_site: "checkAutoResolve",
    model: "anthropic/claude-sonnet-4.6",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          `You check whether a new note explicitly resolves any open action items.

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
        content: `New note context: ${
          newCtx || "no-context"
        }\n\nNew note:\n${newThoughtContent}\n\nOpen action items (numbered, with source context):\n${itemList}`,
      },
    ],
  });
  const d = data as { choices: Array<{ message: { content: string } }> };
  type Claim = { num: number; reason: string };
  let claims: Claim[] = [];
  try {
    const parsed = JSON.parse(extractJsonObject(d.choices[0].message.content));
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
  } catch (error) {
    console.log(
      `checkAutoResolve: LAYER 2 JSON parse failed: ${
        error instanceof Error ? error.message : String(error)
      } ` +
        `(raw=${
          JSON.stringify(
            (d.choices?.[0]?.message?.content ?? "").slice(0, LOG_TRUNC),
          )
        })`,
    );
    return [];
  }

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
        `checkAutoResolve: LAYER 3 blocked item ${item.id}: no quote returned by LLM (legacy bare-number response)`,
      );
      continue;
    }
    const overlap = quoteOverlap(claim.reason, item.description);
    if (overlap < QUOTE_OVERLAP_THRESHOLD) {
      console.log(
        `checkAutoResolve: LAYER 3 quote-overlap guard dropped item ${item.id} ` +
          `(overlap=${overlap.toFixed(3)}, quote=${
            JSON.stringify(claim.reason.slice(0, LOG_TRUNC))
          }, ` +
          `desc=${JSON.stringify(item.description.slice(0, LOG_TRUNC))})`,
      );
      continue;
    }
    const stillOwed = stillOwedAdjacencyVeto(
      newThoughtContent,
      item.description,
      stem,
    );
    if (stillOwed.vetoed) {
      console.log(
        `checkAutoResolve: LAYER 3.5 still-owed veto dropped item ${item.id} ` +
          `(marker=${stillOwed.marker}, subject=${stillOwed.subject}, dist=${stillOwed.distance}, ` +
          `note=${JSON.stringify(newThoughtContent.slice(0, LOG_TRUNC))})`,
      );
      continue;
    }
    await supabase
      .from("action_items")
      .update({
        status: "resolved",
        resolved_by_thought_id: newThoughtId,
        resolved_at: now,
      })
      .eq("id", item.id);
    resolvedDescriptions.push(item.description);
  }
  return resolvedDescriptions;
}

async function postCaptureHook(
  thoughtId: string,
  content: string,
  metadata: Record<string, unknown>,
  excludeSourceThoughtIds: string[] = [],
): Promise<string[]> {
  await extractAndStoreActionItems(thoughtId, metadata, content);
  return await checkAutoResolve(
    content,
    thoughtId,
    metadata,
    excludeSourceThoughtIds,
  );
}

// --- REST API helpers (for ChatGPT custom GPT Actions) ---

// Defense-in-depth: if the operator deploys a browser-based dashboard at a
// known origin, set DASHBOARD_ORIGIN to that origin (e.g. "https://brain.example.com")
// to scope browser-callable origins instead of accepting any. Falls back to "*"
// when unset so the existing MCP / REST / ChatGPT GPT flows (none of which go
// through a browser CORS preflight) keep working out of the box. Real auth
// gating still happens via x-brain-key on every request; tightening CORS only
// closes the leaked-key + malicious-origin browser-exfiltration vector.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": Deno.env.get("DASHBOARD_ORIGIN") || "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-brain-key",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

const AGENT_TASK_SELECT =
  "id, created_at, updated_at, title, label, agent_code, parent_task_id, project_slug, status, priority, risk, requested_by, intake_source, desired_outcome, context, sources, do_steps, acceptance_criteria, output_handoff, boundaries, explicit_approval, claimed_at, claimed_by, claim_expires_at, completed_at, blocked_reason, review_reason, attempt_count, last_failed_at, last_failure_reason, source_thought_id, linked_action_item_id";

const AGENT_LEDGER_SELECT =
  "agent_code, operator, runtime, automation, automation_state, last_heartbeat, last_queue_result, last_successful_run, local_context, optional_skills, notes, updated_at";

function textToolResponse(data: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
    }],
  };
}

function errorToolResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

async function loadAgentTaskForTool(taskId: string): Promise<
  (AgentTaskAccessRow & Record<string, unknown>) | null
> {
  const { data, error } = await supabase
    .from("agent_tasks")
    .select(AGENT_TASK_SELECT)
    .eq("id", taskId)
    .single();
  if (error) throw error;
  return data as (AgentTaskAccessRow & Record<string, unknown>) | null;
}

async function moveAgentTaskViaTool(args: {
  taskId: string;
  agentCode: string;
  action: AgentTaskToolAction;
  reason?: string;
}) {
  const task = await loadAgentTaskForTool(args.taskId);
  if (!task) throw new Error(`Task not found: ${args.taskId}`);
  assertAgentCanWriteTask(task, args.agentCode);
  if (args.action === "update") {
    assertStatusHeartbeatAllowed(task);
    assertClaimAllowed(task);
  }
  if (
    args.action === "resume" || args.action === "unblock" ||
    args.action === "answer"
  ) {
    assertResumeTransitionAllowed(task, args.action);
    assertClaimAllowed(task);
  }

  const { status, receipt } = receiptForTaskTool(args.action);
  const { data, error } = await supabase.rpc("move_agent_task_status", {
    p_task_id: args.taskId,
    p_status: status,
    p_event_type: receipt,
    p_agent_code: args.agentCode,
    p_reason: args.reason ?? null,
  });
  if (error) throw error;
  return { receipt, task: data };
}

// Hard caps on user-supplied string lengths in REST handler bodies. The
// thought `content` field gets a generous cap because operators paste long
// passages and full meeting transcripts; small string fields (name, title,
// notes, etc.) get a tight cap so a single curl can't pump megabytes of
// text into a paid LLM call. Real auth still gates access via x-brain-key;
// these caps are defense against a leaked key spending unbounded credits.
const MAX_CONTENT_LENGTH = 32_000;
const MAX_FIELD_LENGTH = 1_000;

function tooLong(value: unknown, max: number): boolean {
  return typeof value === "string" && value.length > max;
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
      results: (data || []).map((
        t: {
          content: string;
          similarity: number;
          metadata: Record<string, unknown>;
          created_at: string;
        },
      ) => ({
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
  const days = url.searchParams.get("days")
    ? parseInt(url.searchParams.get("days")!)
    : null;
  try {
    let q = supabase.from("thoughts").select("content, metadata, created_at")
      .order("created_at", { ascending: false }).limit(limit);
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
      results: (data || []).map((
        t: {
          content: string;
          metadata: Record<string, unknown>;
          created_at: string;
        },
      ) => ({
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
    const { count } = await supabase.from("thoughts").select("*", {
      count: "exact",
      head: true,
    });
    const { data } = await supabase.from("thoughts").select(
      "metadata, created_at",
    ).order("created_at", { ascending: false });
    const types: Record<string, number> = {};
    const topics: Record<string, number> = {};
    const people: Record<string, number> = {};
    for (const r of data || []) {
      const m = (r.metadata || {}) as Record<string, unknown>;
      if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
      if (Array.isArray(m.topics)) {
        for (const t of m.topics) {
          topics[t as string] = (topics[t as string] || 0) + 1;
        }
      }
      if (Array.isArray(m.people)) {
        for (const p of m.people) {
          people[p as string] = (people[p as string] || 0) + 1;
        }
      }
    }
    const sort = (o: Record<string, number>) =>
      Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10).map((
        [name, count],
      ) => ({ name, count }));
    return jsonResponse({
      total: count,
      date_range: data?.length
        ? {
          oldest: data[data.length - 1].created_at,
          newest: data[0].created_at,
        }
        : null,
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
    if (!content || typeof content !== "string") {
      return jsonResponse({ error: "content field required" }, 400);
    }
    if (tooLong(content, MAX_CONTENT_LENGTH)) {
      return jsonResponse({
        error: `content exceeds ${MAX_CONTENT_LENGTH} chars`,
      }, 413);
    }

    // Optional caller-supplied tags merge into topics. Lets sync-source
    // integrations (calendar sync, notion sync, fitness sync) tag captures
    // authoritatively instead of relying solely on metadata-extraction LLM
    // re-deriving topics from prose.
    const explicitTags = Array.isArray(body?.tags)
      ? (body.tags as unknown[])
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.toLowerCase().trim())
        .filter(Boolean)
      : [];
    const source = typeof body?.source === "string" && body.source.length > 0
      ? body.source
      : "chatgpt";

    // Optional Notion-sync identity fields. When both are present, dedup runs
    // on the record identity instead of the content hash (see isNotionDuplicate).
    const notionPageId =
      typeof body?.notion_page_id === "string" && body.notion_page_id.trim()
        ? body.notion_page_id.trim()
        : null;
    const notionLastEdited = typeof body?.notion_last_edited === "string" &&
        body.notion_last_edited.trim()
      ? body.notion_last_edited.trim()
      : null;

    const hash = await contentHash(content);
    if (notionPageId && notionLastEdited) {
      if (await isNotionDuplicate(notionPageId, notionLastEdited)) {
        return jsonResponse({
          status: "duplicate",
          message: "Already in the brain.",
        });
      }
    } else if (await isDuplicate(hash)) {
      return jsonResponse({
        status: "duplicate",
        message: "Already in the brain.",
      });
    }
    const [embedding, rawMetadata] = await Promise.all([
      getEmbedding(content),
      extractMetadata(content),
    ]);
    const knownSlugs = await loadKnownSlugs(supabase);
    const coerced = coerceMetadata(rawMetadata, knownSlugs, content);
    const extractedTopics = coerced.topics;
    const mergedTopics = Array.from(
      new Set([...extractedTopics, ...explicitTags]),
    );
    const finalMetadata: Record<string, unknown> = {
      ...coerced,
      topics: mergedTopics,
      source,
    };
    if (notionPageId) finalMetadata.notion_page_id = notionPageId;
    if (notionLastEdited) finalMetadata.notion_last_edited = notionLastEdited;

    const { data: inserted, error } = await supabase.from("thoughts").insert({
      content,
      embedding,
      content_hash: hash,
      metadata: finalMetadata,
    }).select("id").single();
    if (error || !inserted) {
      return jsonResponse({ error: error?.message || "unknown error" }, 500);
    }

    // Post-capture: track action items and auto-resolve (self-exclusion prevents resolving own items)
    const resolved = await postCaptureHook(
      inserted.id,
      content,
      finalMetadata,
      [inserted.id],
    );

    return jsonResponse({
      status: "captured",
      type: finalMetadata.type,
      topics: finalMetadata.topics,
      people: finalMetadata.people,
      action_items: finalMetadata.action_items,
      auto_resolved: resolved.length > 0 ? resolved : undefined,
    });
  } catch (err: unknown) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }
}

async function handleRestClient(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const {
      name,
      email,
      phone,
      instagram,
      preferred_styles,
      notes,
      first_contact,
      last_contact,
    } = body || {};
    if (!name || typeof name !== "string") {
      return jsonResponse({ error: "name field required" }, 400);
    }
    for (
      const [field, value] of Object.entries({
        name,
        email,
        phone,
        instagram,
        notes,
      })
    ) {
      if (tooLong(value, MAX_FIELD_LENGTH)) {
        return jsonResponse({
          error: `${field} exceeds ${MAX_FIELD_LENGTH} chars`,
        }, 413);
      }
    }

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
      return jsonResponse({
        status: "exists",
        id: existing[0].id,
        name: existing[0].name,
      });
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
    return jsonResponse({
      status: "created",
      id: inserted.id,
      name: inserted.name,
    });
  } catch (err: unknown) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }
}

async function handleRestEvent(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const {
      title,
      event_type,
      date_start,
      date_end,
      location,
      notes,
      metadata,
    } = body || {};
    if (!title || typeof title !== "string") {
      return jsonResponse({ error: "title field required" }, 400);
    }
    for (
      const [field, value] of Object.entries({
        title,
        event_type,
        location,
        notes,
      })
    ) {
      if (tooLong(value, MAX_FIELD_LENGTH)) {
        return jsonResponse({
          error: `${field} exceeds ${MAX_FIELD_LENGTH} chars`,
        }, 413);
      }
    }

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
    if (error || !inserted) {
      return jsonResponse({ error: error?.message || "unknown error" }, 500);
    }
    return jsonResponse({ status: "created", id: inserted.id });
  } catch (err: unknown) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }
}

// --- MCP Server Setup ---

const server = new McpServer(
  {
    name: "brain-bank",
    version: "1.0.0",
  },
  {
    instructions: `# Brain Bank — How to use these tools

Brain Bank exposes two retrieval surfaces. Choose based on the shape of the question.

**Wiki (compiled pages)** — \`get_compiled_page\`, \`search_compiled_pages\`, \`list_compiled_pages\`. Pre-synthesized markdown reference docs about specific entities: a client, a topic, a project. One page per entity, regenerated daily, plus a read-time tail of activity captured since the last compile. Use the wiki when the question is entity-shaped: "what do we know about Alex?", "what's our position on knowledge retention?", "where are we with the Phoenix project?". The wiki gives you a synthesized summary in one call instead of forcing you to re-read 50 raw thoughts.

**Thoughts (raw captures)** — \`search_thoughts\`, \`list_thoughts\`. Individual captured moments: an email, a note, a Slack message, a calendar event. Use thoughts when the question is moment-shaped: "what did I think about that estimate yesterday?", "did anyone DM about the booth?", "find the message where we agreed on color palette". Wiki pages don't preserve the texture of an individual moment; thoughts do.

**Drill between them.** Wiki pages list the thought IDs that contributed to them in a "Sources" section. When the wiki gives you a synthesized fact and you need the underlying capture, follow the citation — \`get_thought_by_id\` returns the raw thought. Going the other way: a raw thought matching a known entity is summarized into that entity's wiki page on the next compile run.

**Edges between thoughts.** Some thoughts are linked by typed semantic relations: \`supports\`, \`contradicts\`, \`supersedes\`, \`evolved_into\`, \`depends_on\`, \`related_to\`. \`get_thought_by_id\` shows a brief Relationships summary; \`get_thought_edges\` returns the full edge list with counterpart previews. Edges enrich retrieval — they are one signal among many, not a primary surface. The wiki and raw thoughts remain the first thing to check.

**Default heuristic.** Try \`search_compiled_pages\` or \`get_compiled_page\` first when a known entity is named in the question. Fall back to \`search_thoughts\` if no compiled page exists or if the question is moment-shaped.`,
  },
);

server.registerTool(
  "search_thoughts",
  {
    title: "Search Thoughts",
    description:
      "Semantic vector search across all captured raw thoughts. Use this when the question is moment-shaped ('what did I write about X yesterday?', 'find the message where Y was decided'). For entity-shaped questions about a known client / topic / project, prefer `get_compiled_page` or `search_compiled_pages` first — those return synthesized summaries instead of forcing you to re-read individual captures.",
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.coerce.number().optional().default(10),
      threshold: z.coerce.number().optional().default(0.5),
    },
  },
  async ({ query, limit, threshold }) => {
    logToolInvocation("search_thoughts", { query, limit, threshold }, "mcp");
    try {
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("match_thoughts", {
        query_embedding: qEmb,
        match_threshold: threshold,
        match_count: limit,
        filter: {},
      });
      if (error) {
        return {
          content: [{
            type: "text" as const,
            text: `Search error: ${error.message}`,
          }],
          isError: true,
        };
      }
      if (!data || data.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `No thoughts found matching "${query}".`,
          }],
        };
      }
      const results = data.map(
        (
          t: {
            content: string;
            metadata: Record<string, unknown>;
            similarity: number;
            created_at: string;
          },
          i: number,
        ) => {
          const m = t.metadata || {};
          const parts = [
            `--- Result ${i + 1} (${
              (t.similarity * 100).toFixed(1)
            }% match) ---`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
            `Type: ${m.type || "unknown"}`,
          ];
          if (Array.isArray(m.topics) && m.topics.length) {
            parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
          }
          if (Array.isArray(m.people) && m.people.length) {
            parts.push(`People: ${(m.people as string[]).join(", ")}`);
          }
          if (Array.isArray(m.action_items) && m.action_items.length) {
            parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
          }
          parts.push(`\n${t.content}`);
          return parts.join("\n");
        },
      );
      return {
        content: [{
          type: "text" as const,
          text: `Found ${data.length} thought(s):\n\n${results.join("\n\n")}`,
        }],
      };
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Thoughts",
    description:
      "List recently captured thoughts with optional filters by type, topic, person, or time range.",
    inputSchema: {
      limit: z.coerce.number().optional().default(10),
      type: z.string().optional().describe(
        "Filter by type: observation, task, idea, reference, person_note",
      ),
      topic: z.string().optional().describe("Filter by topic tag"),
      person: z.string().optional().describe("Filter by person mentioned"),
      days: z.coerce.number().optional().describe(
        "Only thoughts from the last N days",
      ),
    },
  },
  async ({ limit, type, topic, person, days }) => {
    logToolInvocation(
      "list_thoughts",
      { limit, type, topic, person, days },
      "mcp",
    );
    try {
      let q = supabase.from("thoughts").select("content, metadata, created_at")
        .order("created_at", { ascending: false }).limit(limit);
      if (type) q = q.contains("metadata", { type });
      if (topic) q = q.contains("metadata", { topics: [topic] });
      if (person) q = q.contains("metadata", { people: [person] });
      if (days) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        q = q.gte("created_at", since.toISOString());
      }
      const { data, error } = await q;
      if (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }
      if (!data || !data.length) {
        return {
          content: [{ type: "text" as const, text: "No thoughts found." }],
        };
      }
      const results = data.map(
        (
          t: {
            content: string;
            metadata: Record<string, unknown>;
            created_at: string;
          },
          i: number,
        ) => {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics)
            ? (m.topics as string[]).join(", ")
            : "";
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${
            m.type || "??"
          }${tags ? " - " + tags : ""})\n   ${t.content}`;
        },
      );
      return {
        content: [{
          type: "text" as const,
          text: `${data.length} recent thought(s):\n\n${results.join("\n\n")}`,
        }],
      };
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "get_thought_by_id",
  {
    title: "Get Thought By ID",
    description:
      "Fetch a single raw thought by its UUID. **Use this when drilling from a wiki page's 'Sources' section to inspect the original capture** — the get_compiled_page output lists the source thought IDs and this tool reads them back. Returns the full content + metadata + capture date + source. After Phase 13, also includes a brief 'Relationships' section listing typed edges (supports / contradicts / supersedes / etc.) to other thoughts; use `get_thought_edges` for full edge inspection.",
    inputSchema: {
      id: z.string().describe(
        "Thought UUID. Get these from the 'Sources' section of a get_compiled_page response.",
      ),
    },
  },
  async ({ id }) => {
    logToolInvocation("get_thought_by_id", { id }, "mcp");
    try {
      const uuidPattern =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidPattern.test(id)) {
        return {
          content: [{
            type: "text" as const,
            text: `Invalid thought ID format. Expected a UUID; got "${id}".`,
          }],
          isError: true,
        };
      }
      const { data, error } = await supabase
        .from("thoughts")
        .select("id, content, metadata, created_at")
        .eq("id", id)
        .single();
      if (error || !data) {
        return {
          content: [{
            type: "text" as const,
            text: `No thought found with id "${id}".`,
          }],
        };
      }
      const m = (data.metadata || {}) as Record<string, unknown>;
      const parts = [
        `## Thought ${data.id}`,
        `Captured: ${new Date(data.created_at).toLocaleString()}`,
        `Source: ${(m.source as string) || "unknown"}`,
        `Type: ${m.type || "unknown"}`,
      ];
      if (Array.isArray(m.topics) && m.topics.length) {
        parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
      }
      if (Array.isArray(m.people) && m.people.length) {
        parts.push(`People: ${(m.people as string[]).join(", ")}`);
      }
      if (m.project) parts.push(`Project: ${m.project}`);
      if (Array.isArray(m.action_items) && m.action_items.length) {
        parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
      }
      parts.push("", data.content);

      // Phase 13.5: append a brief Relationships section if the thought has
      // any typed edges. Best-effort: errors swallowed, since this is an
      // enrichment to the primary thought-content response. Edges are one
      // signal among many; the wiki and raw thoughts remain primary.
      try {
        const { data: edges, error: eErr } = await supabase
          .from("thought_edges")
          .select(
            "relation, from_thought_id, to_thought_id, confidence, classifier_version",
          )
          .or(`from_thought_id.eq.${id},to_thought_id.eq.${id}`)
          .order("confidence", { ascending: false })
          .limit(20);
        if (!eErr && edges && edges.length > 0) {
          const byRelation: Record<
            string,
            Array<
              {
                counterpart: string;
                confidence: number;
                direction: "out" | "in";
              }
            >
          > = {};
          for (const e of edges) {
            const isOutgoing = e.from_thought_id === id;
            const counterpart = isOutgoing
              ? e.to_thought_id
              : e.from_thought_id;
            const direction: "out" | "in" = isOutgoing ? "out" : "in";
            byRelation[e.relation] = byRelation[e.relation] || [];
            byRelation[e.relation].push({
              counterpart,
              confidence: e.confidence ?? 0,
              direction,
            });
          }
          parts.push(
            "",
            `## Relationships (${edges.length} edge${
              edges.length === 1 ? "" : "s"
            })`,
          );
          const rOrder = [
            "contradicts",
            "supersedes",
            "depends_on",
            "supports",
            "evolved_into",
            "related_to",
          ];
          for (const r of rOrder) {
            const list = byRelation[r];
            if (!list || list.length === 0) continue;
            const top = list.slice(0, 3);
            const formatted = top.map((x) =>
              `${x.direction === "out" ? "->" : "<-"} ${x.counterpart} (${
                (x.confidence * 100).toFixed(0)
              }%)`
            ).join(", ");
            const more = list.length > 3 ? ` +${list.length - 3} more` : "";
            parts.push(`- **${r}** (${list.length}): ${formatted}${more}`);
          }
          parts.push(
            "",
            `_Use \`get_thought_edges(id="${id}")\` to inspect all relationships in detail._`,
          );
        }
      } catch {
        // Silent: edge enrichment is best-effort.
      }

      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "get_thought_edges",
  {
    title: "Get Thought Edges",
    description:
      "Inspect the typed semantic edges for a single thought. Returns each edge's relation, direction, confidence, and a short preview of the counterpart thought. Use this when the **'Relationships'** summary in `get_thought_by_id` flags an interesting edge and you want details. Optional filters: `relation` (one of supports/contradicts/evolved_into/supersedes/depends_on/related_to), `min_confidence`, `limit`. Edges are an enrichment signal — fall back to `search_thoughts` or `get_compiled_page` for primary retrieval.",
    inputSchema: {
      id: z.string().describe(
        "Thought UUID. Get these from get_thought_by_id, get_compiled_page Sources, or list_thoughts.",
      ),
      relation: z.enum([
        "supports",
        "contradicts",
        "evolved_into",
        "supersedes",
        "depends_on",
        "related_to",
      ]).optional().describe("Optional: filter by edge relation type."),
      min_confidence: z.coerce.number().optional().default(0.0).describe(
        "Optional: minimum confidence floor (0.0-1.0).",
      ),
      limit: z.coerce.number().optional().default(50).describe(
        "Max edges to return (capped at 100).",
      ),
    },
  },
  async ({ id, relation, min_confidence, limit }) => {
    logToolInvocation("get_thought_edges", {
      id,
      relation,
      min_confidence,
      limit,
    }, "mcp");
    try {
      const uuidPattern =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidPattern.test(id)) {
        return {
          content: [{
            type: "text" as const,
            text: `Invalid thought ID format. Expected a UUID; got "${id}".`,
          }],
          isError: true,
        };
      }
      const cap = Math.min(100, Math.max(1, limit ?? 50));
      const conf = Math.max(0, Math.min(1, min_confidence ?? 0.0));

      let q = supabase
        .from("thought_edges")
        .select(
          "relation, from_thought_id, to_thought_id, confidence, valid_from, valid_until, classifier_version, support_count, metadata, created_at",
        )
        .or(`from_thought_id.eq.${id},to_thought_id.eq.${id}`)
        .gte("confidence", conf)
        .order("confidence", { ascending: false })
        .limit(cap);
      if (relation) q = q.eq("relation", relation);

      const { data: edges, error } = await q;
      if (error) {
        return {
          content: [{
            type: "text" as const,
            text: `Error fetching edges: ${error.message}`,
          }],
          isError: true,
        };
      }
      if (!edges || edges.length === 0) {
        const filterDesc = relation ? ` of type '${relation}'` : "";
        return {
          content: [{
            type: "text" as const,
            text: `No edges${filterDesc} found for thought "${id}".`,
          }],
        };
      }

      // Fetch counterpart previews
      const counterpartIds = Array.from(
        new Set(
          edges.map((e) =>
            e.from_thought_id === id ? e.to_thought_id : e.from_thought_id
          ),
        ),
      );
      const { data: counterparts } = await supabase
        .from("thoughts")
        .select("id, content, created_at")
        .in("id", counterpartIds);
      const cMap = new Map((counterparts || []).map((t) => [t.id, t]));

      const lines: string[] = [
        `## Edges for thought ${id}`,
        `Total: ${edges.length} edge${edges.length === 1 ? "" : "s"}${
          relation ? ` (filtered: ${relation})` : ""
        }, min_confidence=${conf}`,
        "",
      ];
      for (const e of edges) {
        const isOut = e.from_thought_id === id;
        const counterpartId = isOut ? e.to_thought_id : e.from_thought_id;
        const cp = cMap.get(counterpartId);
        const arrow = isOut ? "->" : "<-";
        lines.push(`### ${e.relation} ${arrow} ${counterpartId}`);
        lines.push(
          `Confidence: ${
            (e.confidence ?? 0).toFixed(2)
          } | Support: ${e.support_count} | Classifier: ${
            e.classifier_version || "unknown"
          }`,
        );
        if (e.valid_from || e.valid_until) {
          lines.push(
            `Validity: ${e.valid_from || "always"} -> ${
              e.valid_until || "current"
            }`,
          );
        }
        const rationale = (e.metadata as Record<string, unknown> | null)
          ?.rationale;
        if (typeof rationale === "string" && rationale.length > 0) {
          lines.push(`Rationale: ${rationale}`);
        }
        if (cp) {
          const preview = cp.content.length > 200
            ? cp.content.slice(0, 200) + "..."
            : cp.content;
          lines.push(`Counterpart preview: ${preview}`);
        }
        lines.push("");
      }
      lines.push(
        `_Use \`get_thought_by_id(id="<counterpart_id>")\` to read a counterpart in full._`,
      );

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "thought_stats",
  {
    title: "Thought Statistics",
    description:
      "Get a summary of all captured thoughts: totals, types, top topics, and people.",
    inputSchema: {},
  },
  async () => {
    logToolInvocation("thought_stats", {}, "mcp");
    try {
      const { count } = await supabase.from("thoughts").select("*", {
        count: "exact",
        head: true,
      });
      const { data } = await supabase.from("thoughts").select(
        "metadata, created_at",
      ).order("created_at", { ascending: false });
      const types: Record<string, number> = {};
      const topics: Record<string, number> = {};
      const people: Record<string, number> = {};
      for (const r of data || []) {
        const m = (r.metadata || {}) as Record<string, unknown>;
        if (m.type) {
          types[m.type as string] = (types[m.type as string] || 0) + 1;
        }
        if (Array.isArray(m.topics)) {
          for (const t of m.topics) {
            topics[t as string] = (topics[t as string] || 0) + 1;
          }
        }
        if (Array.isArray(m.people)) {
          for (const p of m.people) {
            people[p as string] = (people[p as string] || 0) + 1;
          }
        }
      }
      const sort = (o: Record<string, number>): [string, number][] =>
        Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10);
      const lines: string[] = [
        `Total thoughts: ${count}`,
        `Date range: ${
          data?.length
            ? new Date(data[data.length - 1].created_at).toLocaleDateString() +
              " to " + new Date(data[0].created_at).toLocaleDateString()
            : "N/A"
        }`,
        "",
        "Types:",
        ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
      ];
      if (Object.keys(topics).length) {
        lines.push("", "Top topics:");
        for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
      }
      if (Object.keys(people).length) {
        lines.push("", "People mentioned:");
        for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "list_agent_tasks",
  {
    title: "List Agent Tasks",
    description:
      "List Open Engine task-board records with optional filters. Use before claiming work or checking blocked/review queues.",
    inputSchema: {
      statuses: z.array(z.enum(AGENT_TASK_STATUSES)).optional().describe(
        "Optional status filters. Defaults to active non-done tasks.",
      ),
      agent_code: z.string().optional().describe(
        "Optional runtime code filter, e.g. dave-codex.",
      ),
      risk: z.enum(["low", "medium", "high"]).optional(),
      project_slug: z.string().optional(),
      include_done: z.boolean().optional().describe(
        "Set true to include Agent Done tasks when statuses is omitted.",
      ),
      limit: z.number().int().min(1).max(50).optional(),
    },
  },
  async (
    {
      statuses,
      agent_code,
      risk,
      project_slug,
      include_done,
      limit,
    }: {
      statuses?: AgentTaskStatus[];
      agent_code?: string;
      risk?: "low" | "medium" | "high";
      project_slug?: string;
      include_done?: boolean;
      limit?: number;
    },
  ) => {
    logToolInvocation("list_agent_tasks", {
      statuses,
      agent_code,
      risk,
      project_slug,
      include_done,
      limit,
    }, "mcp");
    try {
      const cap = Math.max(1, Math.min(50, limit ?? 20));
      let query = supabase
        .from("agent_tasks")
        .select(AGENT_TASK_SELECT)
        .order("updated_at", { ascending: false })
        .limit(cap);
      if (statuses && statuses.length > 0) {
        query = query.in("status", statuses);
      } else if (!include_done) {
        query = query.neq("status", "Agent Done");
      }
      if (agent_code) query = query.eq("agent_code", agent_code);
      if (risk) query = query.eq("risk", risk);
      if (project_slug) query = query.eq("project_slug", project_slug);

      const { data, error } = await query;
      if (error) throw error;
      return textToolResponse({ count: data?.length ?? 0, tasks: data ?? [] });
    } catch (err: unknown) {
      return errorToolResponse(
        `Error listing agent tasks: ${(err as Error).message}`,
      );
    }
  },
);

server.registerTool(
  "get_agent_task",
  {
    title: "Get Agent Task",
    description:
      "Read one Open Engine task packet plus its immutable receipt/event history.",
    inputSchema: {
      task_id: z.string().uuid(),
    },
  },
  async ({ task_id }: { task_id: string }) => {
    logToolInvocation("get_agent_task", { task_id }, "mcp");
    try {
      const { data: task, error: taskError } = await supabase
        .from("agent_tasks")
        .select(AGENT_TASK_SELECT)
        .eq("id", task_id)
        .single();
      if (taskError) throw taskError;
      const { data: events, error: eventsError } = await supabase
        .from("agent_task_events")
        .select(
          "id, task_id, created_at, event_type, agent_code, payload, evidence_url",
        )
        .eq("task_id", task_id)
        .order("created_at", { ascending: true });
      if (eventsError) throw eventsError;
      return textToolResponse({ task, events: events ?? [] });
    } catch (err: unknown) {
      return errorToolResponse(
        `Error fetching agent task: ${(err as Error).message}`,
      );
    }
  },
);

server.registerTool(
  "create_agent_task_intake",
  {
    title: "Create Agent Task Intake",
    description:
      "Create a draft-safe Open Engine intake record. This always creates a Standing task, never Agent Todo, and never grants explicit approval.",
    inputSchema: {
      desired_outcome: z.string().min(1),
      context: z.string().min(1),
      sources: z.array(z.unknown()).describe(
        "Source references for the task packet, such as handoff docs, capture IDs, or session-log paths.",
      ),
      do_steps: z.string().min(1),
      acceptance_criteria: z.string().min(1),
      output_handoff: z.string().min(1),
      boundaries: z.string().min(1),
      intake_source: z.enum(AGENT_TASK_INTAKE_SOURCES).describe(
        "Allowed OE-6 intake source. Slack is intake-only; action-item promotion is manual-only.",
      ),
      agent_code: z.string().min(1).optional(),
      project_slug: z.string().min(1).optional(),
      priority: z.enum(["low", "medium", "high"]).optional(),
      risk: z.enum(["low", "medium", "high"]).optional(),
      requested_by: z.string().min(1).optional(),
      title: z.string().min(1).optional(),
      source_thought_id: z.string().uuid().optional(),
      linked_action_item_id: z.string().uuid().optional(),
    },
  },
  async (
    args: {
      desired_outcome: string;
      context: string;
      sources: unknown[];
      do_steps: string;
      acceptance_criteria: string;
      output_handoff: string;
      boundaries: string;
      intake_source: AgentTaskIntakeSource;
      agent_code?: string;
      project_slug?: string;
      priority?: "low" | "medium" | "high";
      risk?: AgentTaskRisk;
      requested_by?: string;
      title?: string;
      source_thought_id?: string;
      linked_action_item_id?: string;
    },
  ) => {
    logToolInvocation("create_agent_task_intake", {
      intake_source: args.intake_source,
      agent_code: args.agent_code,
      project_slug: args.project_slug,
      priority: args.priority,
      risk: args.risk,
      source_thought_id: args.source_thought_id,
      linked_action_item_id: args.linked_action_item_id,
    }, "mcp");
    try {
      const record = buildAgentTaskIntakeRecord(args);
      const { data, error } = await supabase
        .from("agent_tasks")
        .insert(record)
        .select(AGENT_TASK_SELECT)
        .single();
      if (error) throw error;
      return textToolResponse({
        receipt: "INTAKE_DRAFT_CREATED",
        claimable_by_runner: false,
        promotion_required: true,
        task: data,
      });
    } catch (err: unknown) {
      return errorToolResponse(
        `Error creating agent task intake: ${(err as Error).message}`,
      );
    }
  },
);

server.registerTool(
  "promote_agent_task_intake",
  {
    title: "Promote Agent Task Intake",
    description:
      "Human-controlled promotion for one Standing intake draft. Moves it to Agent Todo so normal Queue Runner claim rules can see it. Does not grant explicit approval.",
    inputSchema: {
      task_id: z.string().uuid(),
      promoted_by: z.string().min(1).optional(),
      note: z.string().min(1).optional(),
    },
  },
  async (
    { task_id, promoted_by, note }: {
      task_id: string;
      promoted_by?: string;
      note?: string;
    },
  ) => {
    logToolInvocation("promote_agent_task_intake", {
      task_id,
      promoted_by,
    }, "mcp");
    try {
      const task = await loadAgentTaskForTool(task_id);
      if (!task) throw new Error(`Task not found: ${task_id}`);
      assertIntakePromotionAllowed(task);
      const { data, error } = await supabase.rpc(
        "promote_agent_task_intake",
        {
          p_task_id: task_id,
          p_promoted_by: promoted_by ?? null,
          p_note: note ?? null,
        },
      );
      if (error) throw error;
      return textToolResponse({
        receipt: "INTAKE_PROMOTED",
        audit_event_written: false,
        explicit_approval_granted: false,
        task: data,
      });
    } catch (err: unknown) {
      return errorToolResponse(
        `Error promoting agent task intake: ${(err as Error).message}`,
      );
    }
  },
);

server.registerTool(
  "claim_next_agent_task",
  {
    title: "Claim Next Agent Task",
    description:
      "Atomically claim the oldest eligible Agent Todo task for an agent code through the SQL helper. Returns no task when none is eligible.",
    inputSchema: {
      agent_code: z.string().min(1),
      max_risk: z.enum(["low", "medium", "high"]).optional().describe(
        "Highest task risk this claim may select. Defaults to medium for manual callers; scheduled OE-5 runners pass low.",
      ),
    },
  },
  async (
    { agent_code, max_risk }: {
      agent_code: string;
      max_risk?: AgentTaskRisk;
    },
  ) => {
    const effectiveMaxRisk = isAgentTaskRisk(max_risk || "")
      ? max_risk
      : "medium";
    logToolInvocation("claim_next_agent_task", {
      agent_code,
      max_risk: effectiveMaxRisk,
    }, "mcp");
    try {
      const { data, error } = await supabase.rpc("claim_next_agent_task", {
        p_agent_code: agent_code,
        p_max_risk: effectiveMaxRisk,
      });
      if (error) throw error;
      const tasks = Array.isArray(data) ? data : data ? [data] : [];
      if (tasks.length === 0) {
        return textToolResponse({
          receipt: "NO_ELIGIBLE_TASK",
          agent_code,
          max_risk: effectiveMaxRisk,
          task: null,
        });
      }
      return textToolResponse({
        receipt: "AGENT CLAIMED",
        agent_code,
        max_risk: effectiveMaxRisk,
        task: tasks[0],
      });
    } catch (err: unknown) {
      return errorToolResponse(
        `Error claiming agent task: ${(err as Error).message}`,
      );
    }
  },
);

server.registerTool(
  "update_agent_task",
  {
    title: "Update Agent Task",
    description:
      "Write an AGENT STATUS heartbeat/update for a task the runtime has claimed or is explicitly assigned to.",
    inputSchema: {
      task_id: z.string().uuid(),
      agent_code: z.string().min(1),
      status_note: z.string().min(1).describe(
        "Short receipt note describing current progress or next checkpoint.",
      ),
    },
  },
  async (
    { task_id, agent_code, status_note }: {
      task_id: string;
      agent_code: string;
      status_note: string;
    },
  ) => {
    logToolInvocation("update_agent_task", {
      task_id,
      agent_code,
      status_note,
    }, "mcp");
    try {
      return textToolResponse(
        await moveAgentTaskViaTool({
          taskId: task_id,
          agentCode: agent_code,
          action: "update",
          reason: status_note,
        }),
      );
    } catch (err: unknown) {
      return errorToolResponse(
        `Error updating agent task: ${(err as Error).message}`,
      );
    }
  },
);

server.registerTool(
  "complete_agent_task",
  {
    title: "Complete Agent Task",
    description:
      "Mark a claimed or assigned task as agent-done and ready for human review. This writes AGENT DONE and moves the task to Agent Review, not Agent Done.",
    inputSchema: {
      task_id: z.string().uuid(),
      agent_code: z.string().min(1),
      result: z.string().min(1).describe("Completion receipt for Dave."),
    },
  },
  async (
    { task_id, agent_code, result }: {
      task_id: string;
      agent_code: string;
      result: string;
    },
  ) => {
    logToolInvocation("complete_agent_task", { task_id, agent_code }, "mcp");
    try {
      return textToolResponse(
        await moveAgentTaskViaTool({
          taskId: task_id,
          agentCode: agent_code,
          action: "complete",
          reason: result,
        }),
      );
    } catch (err: unknown) {
      return errorToolResponse(
        `Error completing agent task: ${(err as Error).message}`,
      );
    }
  },
);

server.registerTool(
  "block_agent_task",
  {
    title: "Block Agent Task",
    description:
      "Move a claimed or assigned task to Agent Needs Input with an AGENT BLOCKED receipt.",
    inputSchema: {
      task_id: z.string().uuid(),
      agent_code: z.string().min(1),
      blocker: z.string().min(1).describe(
        "The exact blocker or question that needs human input.",
      ),
    },
  },
  async (
    { task_id, agent_code, blocker }: {
      task_id: string;
      agent_code: string;
      blocker: string;
    },
  ) => {
    logToolInvocation("block_agent_task", { task_id, agent_code }, "mcp");
    try {
      return textToolResponse(
        await moveAgentTaskViaTool({
          taskId: task_id,
          agentCode: agent_code,
          action: "block",
          reason: blocker,
        }),
      );
    } catch (err: unknown) {
      return errorToolResponse(
        `Error blocking agent task: ${(err as Error).message}`,
      );
    }
  },
);

server.registerTool(
  "request_agent_review",
  {
    title: "Request Agent Review",
    description:
      "Move a claimed or assigned task to Agent Review with an AGENT DONE receipt when the runtime needs Dave to inspect the result.",
    inputSchema: {
      task_id: z.string().uuid(),
      agent_code: z.string().min(1),
      review_note: z.string().min(1),
    },
  },
  async (
    { task_id, agent_code, review_note }: {
      task_id: string;
      agent_code: string;
      review_note: string;
    },
  ) => {
    logToolInvocation("request_agent_review", { task_id, agent_code }, "mcp");
    try {
      return textToolResponse(
        await moveAgentTaskViaTool({
          taskId: task_id,
          agentCode: agent_code,
          action: "request-review",
          reason: review_note,
        }),
      );
    } catch (err: unknown) {
      return errorToolResponse(
        `Error requesting agent review: ${(err as Error).message}`,
      );
    }
  },
);

server.registerTool(
  "resume_agent_task",
  {
    title: "Resume Agent Task",
    description:
      "Resume a claimed or assigned Agent Needs Input or Agent Review task back to Agent Working with an AGENT RESUMED receipt.",
    inputSchema: {
      task_id: z.string().uuid(),
      agent_code: z.string().min(1),
      resume_note: z.string().min(1).describe(
        "Short receipt note explaining why this task is ready to resume.",
      ),
    },
  },
  async (
    { task_id, agent_code, resume_note }: {
      task_id: string;
      agent_code: string;
      resume_note: string;
    },
  ) => {
    logToolInvocation("resume_agent_task", { task_id, agent_code }, "mcp");
    try {
      return textToolResponse(
        await moveAgentTaskViaTool({
          taskId: task_id,
          agentCode: agent_code,
          action: "resume",
          reason: resume_note,
        }),
      );
    } catch (err: unknown) {
      return errorToolResponse(
        `Error resuming agent task: ${(err as Error).message}`,
      );
    }
  },
);

server.registerTool(
  "unblock_agent_task",
  {
    title: "Unblock Agent Task",
    description:
      "Move a claimed or assigned Agent Needs Input task back to Agent Working with an AGENT UNBLOCKED receipt.",
    inputSchema: {
      task_id: z.string().uuid(),
      agent_code: z.string().min(1),
      unblock_note: z.string().min(1).describe(
        "Short receipt note explaining what cleared the blocker.",
      ),
    },
  },
  async (
    { task_id, agent_code, unblock_note }: {
      task_id: string;
      agent_code: string;
      unblock_note: string;
    },
  ) => {
    logToolInvocation("unblock_agent_task", { task_id, agent_code }, "mcp");
    try {
      return textToolResponse(
        await moveAgentTaskViaTool({
          taskId: task_id,
          agentCode: agent_code,
          action: "unblock",
          reason: unblock_note,
        }),
      );
    } catch (err: unknown) {
      return errorToolResponse(
        `Error unblocking agent task: ${(err as Error).message}`,
      );
    }
  },
);

server.registerTool(
  "answer_agent_task",
  {
    title: "Answer Agent Task",
    description:
      "Move a claimed or assigned Agent Needs Input task back to Agent Working with an AGENT HUMAN ANSWERED receipt.",
    inputSchema: {
      task_id: z.string().uuid(),
      agent_code: z.string().min(1),
      answer_note: z.string().min(1).describe(
        "Short receipt note with the human answer or local input that cleared the hold.",
      ),
    },
  },
  async (
    { task_id, agent_code, answer_note }: {
      task_id: string;
      agent_code: string;
      answer_note: string;
    },
  ) => {
    logToolInvocation("answer_agent_task", { task_id, agent_code }, "mcp");
    try {
      return textToolResponse(
        await moveAgentTaskViaTool({
          taskId: task_id,
          agentCode: agent_code,
          action: "answer",
          reason: answer_note,
        }),
      );
    } catch (err: unknown) {
      return errorToolResponse(
        `Error answering agent task: ${(err as Error).message}`,
      );
    }
  },
);

server.registerTool(
  "read_agent_ledger",
  {
    title: "Read Agent Ledger",
    description:
      "Read Open Engine runtime ledger rows, optionally filtered to one agent code.",
    inputSchema: {
      agent_code: z.string().optional(),
    },
  },
  async ({ agent_code }: { agent_code?: string }) => {
    logToolInvocation("read_agent_ledger", { agent_code }, "mcp");
    try {
      let query = supabase
        .from("agent_task_ledger")
        .select(AGENT_LEDGER_SELECT)
        .order("agent_code", { ascending: true });
      if (agent_code) query = query.eq("agent_code", agent_code);
      const { data, error } = await query;
      if (error) throw error;
      return textToolResponse({ count: data?.length ?? 0, ledger: data ?? [] });
    } catch (err: unknown) {
      return errorToolResponse(
        `Error reading agent ledger: ${(err as Error).message}`,
      );
    }
  },
);

server.registerTool(
  "write_agent_ledger",
  {
    title: "Write Agent Ledger",
    description:
      "Update an existing Open Engine runtime ledger row. This never creates or deletes ledger identities.",
    inputSchema: {
      agent_code: z.string().min(1),
      automation_state: z
        .enum(["installed", "manual-required", "blocked", "paused"])
        .optional(),
      last_queue_result: z.string().optional(),
      local_context: z.string().optional(),
      optional_skills: z.array(z.string()).optional(),
      notes: z.string().optional(),
    },
  },
  async (
    {
      agent_code,
      automation_state,
      last_queue_result,
      local_context,
      optional_skills,
      notes,
    }: {
      agent_code: string;
      automation_state?: string;
      last_queue_result?: string;
      local_context?: string;
      optional_skills?: string[];
      notes?: string;
    },
  ) => {
    logToolInvocation("write_agent_ledger", {
      agent_code,
      automation_state,
      last_queue_result,
      local_context,
      optional_skills,
    }, "mcp");
    try {
      if (automation_state && !isLedgerAutomationState(automation_state)) {
        throw new Error(`Invalid automation_state: ${automation_state}`);
      }
      const patch = compactObject({
        automation_state,
        last_queue_result,
        local_context,
        optional_skills,
        notes,
        last_heartbeat: new Date().toISOString(),
      });
      const { data, error } = await supabase
        .from("agent_task_ledger")
        .update(patch)
        .eq("agent_code", agent_code)
        .select(AGENT_LEDGER_SELECT)
        .single();
      if (error) throw error;
      return textToolResponse({ receipt: "AGENT STATUS", ledger: data });
    } catch (err: unknown) {
      return errorToolResponse(
        `Error writing agent ledger: ${(err as Error).message}`,
      );
    }
  },
);

server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description:
      "Save a new thought to Brain Bank. Generates an embedding and extracts metadata automatically. Use this when the user wants to save something to their brain directly from any AI client. Pass `tags` to pin explicit topic tags (e.g. a project slug) onto the capture — they merge with the auto-extracted topics.",
    inputSchema: {
      content: z.string().describe("The thought to capture"),
      tags: z.array(z.string()).optional().describe(
        "Optional explicit topic tags to attach (merged with the auto-extracted topics). Use underscores, not hyphens, for multi-word slugs.",
      ),
    },
  },
  async ({ content, tags }: { content: string; tags?: string[] }) => {
    logToolInvocation("capture_thought", { content }, "mcp");
    try {
      const hash = await contentHash(content);
      if (await isDuplicate(hash)) {
        return {
          content: [{
            type: "text" as const,
            text: "Already in the brain (duplicate detected).",
          }],
        };
      }
      // Optional caller-supplied tags merge into the auto-extracted topics —
      // mirrors the explicitTags logic in handleRestCapture.
      const explicitTags = Array.isArray(tags)
        ? tags
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.toLowerCase().trim())
          .filter(Boolean)
        : [];
      const [embedding, rawMetadata] = await Promise.all([
        getEmbedding(content),
        extractMetadata(content),
      ]);
      const knownSlugs = await loadKnownSlugs(supabase);
      const coerced = coerceMetadata(rawMetadata, knownSlugs, content);
      const extractedTopics = coerced.topics;
      const mergedTopics = Array.from(
        new Set([...extractedTopics, ...explicitTags]),
      );
      const finalMetadata: Record<string, unknown> = {
        ...coerced,
        topics: mergedTopics,
        source: "mcp",
      };
      const { data: inserted, error } = await supabase.from("thoughts").insert({
        content,
        embedding,
        content_hash: hash,
        metadata: finalMetadata,
      }).select("id").single();
      if (error || !inserted) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to capture: ${error?.message || "unknown error"}`,
          }],
          isError: true,
        };
      }

      // Post-capture: track action items and auto-resolve (self-exclusion prevents resolving own items)
      const resolved = await postCaptureHook(
        inserted.id,
        content,
        finalMetadata,
        [inserted.id],
      );

      let confirmation = `Captured as ${finalMetadata.type || "thought"}`;
      if (mergedTopics.length) confirmation += ` - ${mergedTopics.join(", ")}`;
      if (Array.isArray(finalMetadata.people) && finalMetadata.people.length) {
        confirmation += ` | People: ${
          (finalMetadata.people as string[]).join(", ")
        }`;
      }
      if (
        Array.isArray(finalMetadata.action_items) &&
        finalMetadata.action_items.length
      ) {
        confirmation += ` | Actions: ${
          (finalMetadata.action_items as string[]).join("; ")
        }`;
      }
      if (resolved.length > 0) {
        confirmation += ` | Auto-resolved: ${resolved.join("; ")}`;
      }
      return { content: [{ type: "text" as const, text: confirmation }] };
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
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
      notes: z.string().optional().describe(
        "Any initial notes about this client",
      ),
    },
  },
  async ({ name, email, phone, instagram, preferred_styles, notes }) => {
    logToolInvocation("add_client", {
      name,
      email,
      phone,
      instagram,
      preferred_styles,
      notes,
    }, "mcp");
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
              text: `A client named "${
                existing[0].name
              }" already exists. Use find_client to look them up or use a more specific name.`,
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
        return {
          content: [{
            type: "text" as const,
            text: `Failed to add client: ${error.message}`,
          }],
          isError: true,
        };
      }
      let msg = `Client "${data.name}" added (${data.id}).`;
      if (preferred_styles?.length) {
        msg += ` Styles: ${preferred_styles.join(", ")}.`;
      }
      return { content: [{ type: "text" as const, text: msg }] };
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
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
    logToolInvocation("find_client", { name }, "mcp");
    try {
      const { data, error } = await supabase
        .from("clients")
        .select(
          "id, name, email, phone, instagram, preferred_styles, notes, first_contact, last_contact",
        )
        .ilike("name", `%${name}%`)
        .order("last_contact", { ascending: false })
        .limit(10);
      if (error) {
        return {
          content: [{
            type: "text" as const,
            text: `Search error: ${error.message}`,
          }],
          isError: true,
        };
      }
      if (!data || data.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `No clients found matching "${name}".`,
          }],
        };
      }
      const results = data.map((c) => {
        const lines = [`Name: ${c.name} (${c.id})`];
        if (c.email) lines.push(`Email: ${c.email}`);
        if (c.phone) lines.push(`Phone: ${c.phone}`);
        if (c.instagram) lines.push(`Instagram: ${c.instagram}`);
        if (c.preferred_styles?.length) {
          lines.push(`Styles: ${c.preferred_styles.join(", ")}`);
        }
        if (c.notes) lines.push(`Notes: ${c.notes}`);
        if (c.first_contact) {
          lines.push(
            `First contact: ${new Date(c.first_contact).toLocaleDateString()}`,
          );
        }
        if (c.last_contact) {
          lines.push(
            `Last contact: ${new Date(c.last_contact).toLocaleDateString()}`,
          );
        }
        return lines.join("\n");
      });
      return {
        content: [{
          type: "text" as const,
          text: `Found ${data.length} client(s):\n\n${
            results.join("\n\n---\n\n")
          }`,
        }],
      };
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "client_context",
  {
    title: "Client Context",
    description:
      `Get full context on a client: profile and related brain thoughts. Use before a ${loadProfile().domain.singular_noun} or when a client reaches out.`,
    inputSchema: {
      client_id: z.string().optional().describe("Client UUID (if known)"),
      name: z.string().optional().describe(
        "Client name (used if client_id not provided)",
      ),
    },
  },
  async ({ client_id, name }) => {
    logToolInvocation("client_context", { client_id, name }, "mcp");
    try {
      if (!client_id && !name) {
        return {
          content: [{
            type: "text" as const,
            text: "Provide either client_id or name.",
          }],
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
          return {
            content: [{
              type: "text" as const,
              text: `Client not found: ${error?.message || "no match"}`,
            }],
            isError: true,
          };
        }
        client = data;
      } else {
        const { data, error } = await supabase
          .from("clients")
          .select("*")
          .ilike("name", `%${name}%`)
          .limit(1);
        if (error || !data?.length) {
          return {
            content: [{
              type: "text" as const,
              text: `No client found matching "${name}".`,
            }],
          };
        }
        client = data[0];
      }

      // Cross-reference thoughts table for mentions of this client's name
      const clientNameParts = client.name.split(" ");
      const searchName = clientNameParts.length > 1
        ? client.name
        : clientNameParts[0];
      let relatedThoughts: {
        content: string;
        metadata: Record<string, unknown>;
        created_at: string;
      }[] = [];
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
          const lowerParts = clientNameParts.map((p: string) =>
            p.toLowerCase()
          );
          relatedThoughts = thoughts.filter((t: { content: string }) =>
            lowerParts.some((part: string) =>
              t.content.toLowerCase().includes(part)
            )
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
      const allThoughts = new Map<
        string,
        {
          content: string;
          metadata: Record<string, unknown>;
          created_at: string;
        }
      >();
      for (const t of [...relatedThoughts, ...(peopleThoughts || [])]) {
        allThoughts.set(t.content, t);
      }
      const uniqueThoughts = Array.from(allThoughts.values())
        .sort((a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        )
        .slice(0, 10);

      // Build response
      const lines: string[] = [];

      // Profile
      lines.push("## Client Profile");
      lines.push(`Name: ${client.name}`);
      if (client.email) lines.push(`Email: ${client.email}`);
      if (client.phone) lines.push(`Phone: ${client.phone}`);
      if (client.instagram) lines.push(`Instagram: ${client.instagram}`);
      if (client.preferred_styles?.length) {
        lines.push(`Preferred styles: ${client.preferred_styles.join(", ")}`);
      }
      if (client.notes) lines.push(`Notes: ${client.notes}`);
      if (client.first_contact) {
        lines.push(
          `First contact: ${
            new Date(client.first_contact).toLocaleDateString()
          }`,
        );
      }
      if (client.last_contact) {
        lines.push(
          `Last contact: ${new Date(client.last_contact).toLocaleDateString()}`,
        );
      }

      // Related thoughts
      if (uniqueThoughts.length > 0) {
        lines.push("", "## Related Brain Thoughts");
        for (const t of uniqueThoughts) {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics)
            ? ` (${(m.topics as string[]).join(", ")})`
            : "";
          lines.push(
            `- [${
              new Date(t.created_at).toLocaleDateString()
            }]${tags} ${t.content}`,
          );
        }
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
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
        .enum(contentTypes as [string, ...string[]])
        .describe("Type of content"),
      subject: z.string().optional().describe(
        "What the content shows, e.g. 'in-progress work'",
      ),
      client_id: z.string().optional().describe(
        "Client UUID if content features a specific client's work",
      ),
      stage: z
        .enum(["captured", "edited", "scheduled", "published", "archived"])
        .optional()
        .default("captured")
        .describe("Current pipeline stage"),
      platform: z.string().optional().describe(
        "Target platform: instagram, facebook, wordpress, all",
      ),
      notes: z.string().optional().describe("Notes about this content"),
    },
  },
  async (
    { title, content_type, subject, client_id, stage, platform, notes },
  ) => {
    logToolInvocation("log_content", {
      title,
      content_type,
      subject,
      client_id,
      stage,
      platform,
      notes,
    }, "mcp");
    try {
      const record: Record<string, unknown> = {
        content_type,
        stage: stage || "captured",
      };
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
        return {
          content: [{
            type: "text" as const,
            text: `Failed to log content: ${error.message}`,
          }],
          isError: true,
        };
      }
      let msg = `Content logged: ${data.content_type} (${data.stage})`;
      if (data.title) msg += ` "${data.title}"`;
      msg += ` [${data.id}]`;
      return { content: [{ type: "text" as const, text: msg }] };
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
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
      scheduled_date: z.string().optional().describe(
        "Scheduled date YYYY-MM-DD",
      ),
      published_date: z.string().optional().describe(
        "Published date YYYY-MM-DD",
      ),
      performance: z
        .object({
          likes: z.coerce.number().optional(),
          saves: z.coerce.number().optional(),
          comments: z.coerce.number().optional(),
          reach: z.coerce.number().optional(),
        })
        .optional()
        .describe("Performance metrics"),
      notes: z.string().optional().describe("Updated notes"),
    },
  },
  async (
    {
      content_id,
      stage,
      platform,
      scheduled_date,
      published_date,
      performance,
      notes,
    },
  ) => {
    logToolInvocation("update_content", {
      content_id,
      stage,
      platform,
      scheduled_date,
      published_date,
      performance,
      notes,
    }, "mcp");
    try {
      const updates: Record<string, unknown> = {};
      if (stage) updates.stage = stage;
      if (platform) updates.platform = platform;
      if (scheduled_date) updates.scheduled_date = scheduled_date;
      if (published_date) updates.published_date = published_date;
      if (performance) updates.performance = performance;
      if (notes) updates.notes = notes;

      if (Object.keys(updates).length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "Nothing to update. Provide at least one field.",
          }],
        };
      }

      const { data, error } = await supabase
        .from("content_items")
        .update(updates)
        .eq("id", content_id)
        .select("id, title, content_type, stage")
        .single();
      if (error) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to update: ${error.message}`,
          }],
          isError: true,
        };
      }
      let msg = `Updated: ${data.content_type}`;
      if (data.title) msg += ` "${data.title}"`;
      if (stage) msg += ` -> ${stage}`;
      return { content: [{ type: "text" as const, text: msg }] };
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "content_status",
  {
    title: "Content Pipeline Status",
    description:
      "See what's in the content pipeline at each stage. Optionally filter by content type or platform.",
    inputSchema: {
      content_type: z.string().optional().describe(
        `Filter by type: ${contentTypes.join(", ")}`,
      ),
      platform: z.string().optional().describe("Filter by platform"),
      limit: z.coerce.number().optional().default(20),
    },
  },
  async ({ content_type, platform, limit }) => {
    logToolInvocation(
      "content_status",
      { content_type, platform, limit },
      "mcp",
    );
    try {
      let q = supabase
        .from("content_items")
        .select(
          "id, title, content_type, subject, stage, platform, scheduled_date, published_date, performance, notes, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(limit);
      if (content_type) q = q.eq("content_type", content_type);
      if (platform) q = q.eq("platform", platform);

      const { data, error } = await q;
      if (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }
      if (!data?.length) {
        return {
          content: [{
            type: "text" as const,
            text: "No content in the pipeline.",
          }],
        };
      }

      // Group by stage
      const stages = [
        "captured",
        "edited",
        "scheduled",
        "published",
        "archived",
      ];
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
          if (item.scheduled_date) {
            parts.push(`scheduled: ${item.scheduled_date}`);
          }
          if (item.published_date) {
            parts.push(`published: ${item.published_date}`);
          }
          const perf = item.performance as Record<string, number> | null;
          if (perf && Object.keys(perf).length > 0) {
            const metrics = Object.entries(perf).map(([k, v]) => `${k}: ${v}`)
              .join(", ");
            parts.push(`{${metrics}}`);
          }
          lines.push(parts.join(" "));
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: `Content pipeline (${data.length} items):${lines.join("\n")}`,
        }],
      };
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "content_performance",
  {
    title: "Content Performance",
    description:
      "See how published content is performing. Shows top content by engagement metrics.",
    inputSchema: {
      days: z.coerce.number().optional().default(30).describe(
        "Look back N days",
      ),
      limit: z.coerce.number().optional().default(10),
    },
  },
  async ({ days, limit }) => {
    logToolInvocation("content_performance", { days, limit }, "mcp");
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
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }
      if (!data?.length) {
        return {
          content: [{
            type: "text" as const,
            text: `No published content in the last ${days} days.`,
          }],
        };
      }

      const lines = data.map((item) => {
        const parts = [`${item.published_date} - ${item.content_type}`];
        if (item.title) parts.push(`"${item.title}"`);
        if (item.subject) parts.push(`(${item.subject})`);
        if (item.platform) parts.push(`[${item.platform}]`);
        const perf = item.performance as Record<string, number> | null;
        if (perf && Object.keys(perf).length > 0) {
          const metrics = Object.entries(perf).map(([k, v]) => `${k}: ${v}`)
            .join(", ");
          parts.push(`{${metrics}}`);
        }
        return parts.join(" ");
      });

      return {
        content: [{
          type: "text" as const,
          text: `Published content (last ${days} days):\n\n${lines.join("\n")}`,
        }],
      };
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);

// --- Business Operations Extension MCP Tools ---

server.registerTool(
  "log_event",
  {
    title: "Log Business Event",
    description: `Record a business event: ${eventTypes.join(", ")}.`,
    inputSchema: {
      event_type: z
        .enum(eventTypes as [string, ...string[]])
        .describe("Type of event"),
      title: z.string().describe("Event title"),
      date_start: z.string().optional().describe("Start date YYYY-MM-DD"),
      date_end: z.string().optional().describe(
        "End date YYYY-MM-DD (for multi-day events)",
      ),
      location: z.string().optional().describe("Event location"),
      notes: z.string().optional().describe("Notes about the event"),
    },
  },
  async ({ event_type, title, date_start, date_end, location, notes }) => {
    logToolInvocation("log_event", {
      event_type,
      title,
      date_start,
      date_end,
      location,
      notes,
    }, "mcp");
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
        return {
          content: [{
            type: "text" as const,
            text: `Failed to log event: ${error.message}`,
          }],
          isError: true,
        };
      }
      let msg = `Event logged: ${data.event_type} "${data.title}"`;
      if (date_start) {
        msg += ` (${date_start}${date_end ? " to " + date_end : ""})`;
      }
      if (location) msg += ` at ${location}`;
      return { content: [{ type: "text" as const, text: msg }] };
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "upcoming_events",
  {
    title: "Upcoming Events",
    description:
      "Show upcoming business events. Optionally filter by event type.",
    inputSchema: {
      event_type: z.string().optional().describe(
        `Filter: ${eventTypes.join(", ")}`,
      ),
      days: z.coerce.number().optional().default(90).describe(
        "Look ahead N days",
      ),
    },
  },
  async ({ event_type, days }) => {
    logToolInvocation("upcoming_events", { event_type, days }, "mcp");
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
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }
      if (!data?.length) {
        return {
          content: [{
            type: "text" as const,
            text: `No upcoming events in the next ${days} days.`,
          }],
        };
      }

      const lines = data.map((e) => {
        const parts = [
          `${e.date_start}${e.date_end ? " to " + e.date_end : ""}`,
        ];
        parts.push(`[${e.event_type}]`);
        parts.push(e.title);
        if (e.location) parts.push(`at ${e.location}`);
        if (e.notes) parts.push(`(${e.notes})`);
        return parts.join(" ");
      });

      return {
        content: [{
          type: "text" as const,
          text: `Upcoming events (next ${days} days):\n\n${lines.join("\n")}`,
        }],
      };
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
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
    logToolInvocation("business_context", {}, "mcp");
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
      lines.push(
        `\nClients: ${totalClients || 0} total, ${
          activeClients || 0
        } active (last 30 days)`,
      );

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
          lines.push(
            `  ${e.date_start}${
              e.date_end ? "-" + e.date_end : ""
            } [${e.event_type}] ${e.title}${
              e.location ? " at " + e.location : ""
            }`,
          );
        }
      } else {
        lines.push("\nNo upcoming events.");
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);

// --- Cross-Extension Intelligence ---

server.registerTool(
  "full_context",
  {
    title: "Full Context",
    description:
      "Get everything the brain knows about a person, topic, or subject. Searches across all tables: thoughts, clients, content, and events. Use this before a client meeting, when preparing for a convention, or when you need the complete picture on anything.",
    inputSchema: {
      query: z.string().describe("Person name, topic, or subject to look up"),
    },
  },
  async ({ query }) => {
    logToolInvocation("full_context", { query }, "mcp");
    try {
      const sections: string[] = [`## Full Context: "${query}"\n`];

      // 1. Semantic search on thoughts
      let relatedThoughts: {
        content: string;
        similarity: number;
        metadata: Record<string, unknown>;
        created_at: string;
      }[] = [];
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
      const thoughtMap = new Map<
        string,
        {
          content: string;
          metadata: Record<string, unknown>;
          created_at: string;
          similarity?: number;
        }
      >();
      for (const t of relatedThoughts) {
        thoughtMap.set(t.content, { ...t });
      }
      for (const t of [...(peopleThoughts || []), ...(topicThoughts || [])]) {
        if (!thoughtMap.has(t.content)) {
          thoughtMap.set(t.content, t);
        }
      }
      const allThoughts = Array.from(thoughtMap.values())
        .sort((a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        )
        .slice(0, 15);

      // 2. Client match
      const { data: clients } = await supabase
        .from("clients")
        .select("*")
        .ilike("name", `%${query}%`)
        .limit(5);

      const clientIds = (clients || []).map((c) => c.id);

      // 3. Content items matching query in title, subject, or linked to matched clients
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

      // 4. Business events matching query
      const { data: events } = await supabase
        .from("business_events")
        .select("*")
        .or(
          `title.ilike.%${query}%,location.ilike.%${query}%,notes.ilike.%${query}%`,
        )
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
          if (c.preferred_styles?.length) {
            lines.push(`Styles: ${c.preferred_styles.join(", ")}`);
          }
          if (c.notes) lines.push(`Notes: ${c.notes}`);
          if (c.last_contact) {
            lines.push(
              `Last contact: ${new Date(c.last_contact).toLocaleDateString()}`,
            );
          }
          sections.push(lines.join("\n"));
        }
      }

      if (allContent.length > 0) {
        sections.push("\n### Related Content");
        for (
          const c of allContent as {
            content_type: string;
            title?: string;
            subject?: string;
            stage: string;
            platform?: string;
            published_date?: string;
          }[]
        ) {
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
          const parts = [
            `${e.date_start || "TBD"}${e.date_end ? " to " + e.date_end : ""}`,
          ];
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
          const tags = Array.isArray(m.topics)
            ? ` (${(m.topics as string[]).join(", ")})`
            : "";
          const sim = (t as { similarity?: number }).similarity;
          const simStr = sim ? ` [${(sim * 100).toFixed(0)}%]` : "";
          sections.push(
            `- [${
              new Date(t.created_at).toLocaleDateString()
            }]${tags}${simStr} ${t.content}`,
          );
        }
      }

      // Summary line
      const counts = [
        clients?.length ? `${clients.length} client(s)` : null,
        allContent.length ? `${allContent.length} content item(s)` : null,
        events?.length ? `${events.length} event(s)` : null,
        allThoughts.length ? `${allThoughts.length} thought(s)` : null,
      ].filter(Boolean);

      if (counts.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `No information found for "${query}" across any table.`,
          }],
        };
      }

      sections.splice(1, 0, `Found: ${counts.join(", ")}\n`);

      return {
        content: [{ type: "text" as const, text: sections.join("\n") }],
      };
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);

// --- Wiki Compiled Pages MCP Tools ---

server.registerTool(
  "get_compiled_page",
  {
    title: "Get Compiled Page",
    description:
      "Read a pre-synthesized wiki page about a known entity (client, topic, or project). **Prefer this over `search_thoughts` when the question is entity-shaped** ('what do we know about X?', 'what's our history with Y?'). Returns synthesized markdown plus a tail of new activity captured since the last compile. After Phase 12.D, includes a 'Sources' section with thought IDs you can drill into via `get_thought_by_id`. If no compiled page exists, fall back to `search_thoughts`.",
    inputSchema: {
      slug: z.string().optional().describe(
        `Page slug, e.g. 'client/${
          slugify(loadProfile().example_person_name)
        }' or 'topic/${slugify(loadProfile().domain.vocabulary[0])}'`,
      ),
      name: z.string().optional().describe(
        "Page title to search for (used if slug not provided)",
      ),
      page_type: z.string().optional().describe(
        "Filter by type: client, topic, project (used with name search)",
      ),
    },
  },
  async ({ slug, name, page_type }) => {
    try {
      logToolInvocation("get_compiled_page", { slug, name, page_type }, "mcp");
      if (!slug && !name) {
        return {
          content: [{
            type: "text" as const,
            text: "Provide either slug or name.",
          }],
          isError: true,
        };
      }

      let page;
      if (slug) {
        const { data, error } = await supabase
          .from("compiled_pages")
          .select(
            "slug, title, page_type, content, backlinks, last_compiled, source_thought_ids",
          )
          .eq("slug", slug)
          .single();
        if (error || !data) {
          return {
            content: [{
              type: "text" as const,
              text: `No compiled page found for slug "${slug}".`,
            }],
          };
        }
        page = data;
      } else {
        let q = supabase
          .from("compiled_pages")
          .select(
            "slug, title, page_type, content, backlinks, last_compiled, source_thought_ids",
          )
          .ilike("title", `%${name}%`);
        if (page_type) q = q.eq("page_type", page_type);
        const { data, error } = await q.limit(1);
        if (error || !data?.length) {
          return {
            content: [{
              type: "text" as const,
              text: `No compiled page found matching "${name}".`,
            }],
          };
        }
        page = data[0];
      }

      const lines = [
        `## ${page.title}`,
        `Type: ${page.page_type} | Slug: ${page.slug}`,
        `Last compiled: ${
          page.last_compiled
            ? new Date(page.last_compiled).toLocaleString()
            : "never"
        }`,
      ];
      if (page.backlinks?.length) {
        lines.push(`Backlinks: ${page.backlinks.join(", ")}`);
      }
      lines.push("", page.content || "(empty page, not yet compiled)");

      // Phase 12.D: Sources section. Drill from synthesized page → raw thought.
      // Show up to 20 most-recent source thought IDs with truncated previews.
      // Hint at get_thought_by_id for full reads. Best-effort: errors swallowed
      // so the page read never fails on Sources alone.
      if (
        Array.isArray(
          (page as { source_thought_ids?: string[] }).source_thought_ids,
        ) &&
        (page as { source_thought_ids: string[] }).source_thought_ids.length > 0
      ) {
        try {
          const allIds =
            (page as { source_thought_ids: string[] }).source_thought_ids;
          // Most-recent 20 by capture order: query thoughts by id, take 20 most recent.
          const { data: sources } = await supabase
            .from("thoughts")
            .select("id, content, created_at")
            .in("id", allIds)
            .order("created_at", { ascending: false })
            .limit(20);
          if (sources && sources.length > 0) {
            lines.push(
              "",
              `## Sources (${allIds.length} total, showing ${sources.length} most recent)`,
            );
            for (const s of sources) {
              const d = new Date(s.created_at).toLocaleDateString();
              const preview = s.content.length > 200
                ? s.content.substring(0, 200) + "..."
                : s.content;
              lines.push(`- \`${s.id}\` [${d}] ${preview}`);
            }
            lines.push(
              "",
              `_Drill into any source with \`get_thought_by_id(id)\`._`,
            );
          }
        } catch (_err) {
          // Sources is best-effort.
        }
      }

      // Read-time freshness: append context captured since last_compiled.
      //
      // For client/topic/project: append matching thoughts (mirrors compile-pages
      // filter logic). For index: append a list of entity pages compiled since the
      // index's own last_compiled (audit Finding 14c — previously this fell
      // through to an unfiltered thoughts dump that leaked unrelated activity).
      if (page.last_compiled && page.page_type !== "index") {
        try {
          let recent: Array<{ content: string; created_at: string }> | null;

          if (page.page_type === "project") {
            const { data } = await supabase.rpc("get_project_page_thoughts", {
              p_slug: page.slug.replace(/^project\//, ""),
              p_since: page.last_compiled,
              p_limit: 20,
              p_ascending: false,
            });
            recent = data;
          } else {
            let recentQ = supabase
              .from("thoughts")
              .select("content, created_at")
              .gt("created_at", page.last_compiled)
              .order("created_at", { ascending: false })
              .limit(20);

            if (page.page_type === "client") {
              recentQ = recentQ.contains("metadata", { people: [page.title] });
            } else {
              recentQ = recentQ.contains("metadata", {
                topics: [page.title.toLowerCase()],
              });
            }

            const result = await recentQ;
            recent = result.data;
          }

          if (recent && recent.length > 0) {
            lines.push(
              "",
              `## Recent activity since last compile (${recent.length})`,
            );
            for (const t of recent) {
              const d = new Date(t.created_at).toLocaleString();
              const preview = t.content.length > 300
                ? t.content.substring(0, 300) + "..."
                : t.content;
              lines.push(`- [${d}] ${preview}`);
            }
          }
        } catch (_err) {
          // Freshness is best-effort; never fail the page read on freshness errors.
        }
      } else if (page.last_compiled && page.page_type === "index") {
        try {
          const { data: changedPages } = await supabase
            .from("compiled_pages")
            .select("slug, title, page_type, last_compiled")
            .gt("last_compiled", page.last_compiled)
            .neq("slug", "index/wiki")
            .order("last_compiled", { ascending: false })
            .limit(20);
          if (changedPages && changedPages.length > 0) {
            lines.push(
              "",
              `## Pages compiled since ${
                new Date(page.last_compiled).toLocaleDateString()
              } (${changedPages.length})`,
            );
            for (const p of changedPages) {
              const d = new Date(p.last_compiled!).toLocaleDateString();
              lines.push(
                `- **${p.title}** (\`${p.slug}\`, ${p.page_type}) — compiled ${d}`,
              );
            }
          }
        } catch (_err) {
          // Freshness is best-effort.
        }
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "search_compiled_pages",
  {
    title: "Search Compiled Pages",
    description:
      "Find which wiki pages exist on a subject. Returns titles + 150-char previews (use `get_compiled_page` for full content). **Prefer this over `search_thoughts` when you want to know whether an entity is written up at all** ('is there a page on X?', 'what topics have I been logging about?').",
    inputSchema: {
      query: z.string().describe("Search term"),
      page_type: z.string().optional().describe(
        "Filter by type: client, topic, project",
      ),
      limit: z.coerce.number().optional().default(10),
    },
  },
  async ({ query, page_type, limit }) => {
    try {
      logToolInvocation(
        "search_compiled_pages",
        { query, page_type, limit },
        "mcp",
      );
      let q = supabase
        .from("compiled_pages")
        .select("slug, title, page_type, last_compiled, content")
        .or(`title.ilike.%${query}%,content.ilike.%${query}%`)
        .order("last_compiled", { ascending: false, nullsFirst: false })
        .limit(limit);
      if (page_type) q = q.eq("page_type", page_type);

      const { data, error } = await q;
      if (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }
      if (!data?.length) {
        return {
          content: [{
            type: "text" as const,
            text: `No compiled pages found matching "${query}".`,
          }],
        };
      }

      const results = data.map((p) => {
        const preview = p.content
          ? p.content.substring(0, 150).replace(/\n/g, " ") + "..."
          : "(not yet compiled)";
        const compiled = p.last_compiled
          ? new Date(p.last_compiled).toLocaleDateString()
          : "never";
        return `- **${p.title}** [${p.page_type}] (${p.slug}) - compiled ${compiled}\n  ${preview}`;
      });

      return {
        content: [{
          type: "text" as const,
          text: `Found ${data.length} page(s):\n\n${results.join("\n\n")}`,
        }],
      };
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "list_compiled_pages",
  {
    title: "List Compiled Pages",
    description:
      "Browse the wiki's full table of contents, optionally filtered by type (client / topic / project / index). **Use this for orientation when starting a session** — gives a one-screen view of every entity the wiki tracks. For a curated narrative version, get the page at slug `index/wiki` (auto-compiled).",
    inputSchema: {
      page_type: z.string().optional().describe(
        "Filter by type: client, topic, project",
      ),
      limit: z.coerce.number().optional().default(50),
    },
  },
  async ({ page_type, limit }) => {
    try {
      logToolInvocation("list_compiled_pages", { page_type, limit }, "mcp");
      let q = supabase
        .from("compiled_pages")
        .select("slug, title, page_type, last_compiled")
        .order("page_type", { ascending: true })
        .order("title", { ascending: true })
        .limit(limit);
      if (page_type) q = q.eq("page_type", page_type);

      const { data, error } = await q;
      if (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }
      if (!data?.length) {
        return {
          content: [{
            type: "text" as const,
            text: "No compiled pages exist yet.",
          }],
        };
      }

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
          const compiled = p.last_compiled
            ? new Date(p.last_compiled).toLocaleDateString()
            : "never";
          lines.push(`- ${p.title} (${p.slug}) - compiled ${compiled}`);
        }
        lines.push("");
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  },
);

// --- REST handler for compiled pages ---

async function handleRestPages(url: URL): Promise<Response> {
  try {
    const slug = url.searchParams.get("slug");
    const type = url.searchParams.get("type");
    const query = url.searchParams.get("query");
    const limit = parseInt(url.searchParams.get("limit") || "20");

    if (slug) {
      logToolInvocation("get_compiled_page", { slug }, "rest");
      // Get specific page by slug
      const { data, error } = await supabase
        .from("compiled_pages")
        .select("slug, title, page_type, content, backlinks, last_compiled")
        .eq("slug", slug)
        .single();
      if (error || !data) return jsonResponse({ error: "Page not found" }, 404);
      return jsonResponse(data);
    }

    if (query) {
      logToolInvocation(
        "search_compiled_pages",
        { query, type, limit },
        "rest",
      );
    } else {
      logToolInvocation("list_compiled_pages", { type, limit }, "rest");
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
  const provided = c.req.header("x-brain-key");
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
  if (
    path === "/search" || path === "/list" || path === "/stats" ||
    path === "/capture" || path === "/event" || path === "/client" ||
    path === "/pages"
  ) {
    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    // Accept auth via x-brain-key header or Authorization Bearer.
    const authHeader = req.headers.get("authorization") || "";
    const bearerKey = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;
    const provided = req.headers.get("x-brain-key") || bearerKey;
    if (!provided || provided !== MCP_ACCESS_KEY) {
      return jsonResponse({ error: "Invalid or missing access key" }, 401);
    }
    if (req.method === "GET" && path === "/search") {
      return handleRestSearch(url);
    }
    if (req.method === "GET" && path === "/list") return handleRestList(url);
    if (req.method === "GET" && path === "/stats") return handleRestStats();
    if (req.method === "POST" && path === "/capture") {
      return handleRestCapture(req);
    }
    if (req.method === "POST" && path === "/event") return handleRestEvent(req);
    if (req.method === "POST" && path === "/client") {
      return handleRestClient(req);
    }
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
          : "application/json, text/event-stream",
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
