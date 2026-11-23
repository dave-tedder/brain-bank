// Shared capture-pipeline pieces: content hash, embedding, metadata
// extraction, and action-item storage.
//
// Moved here from open-brain-mcp/index.ts so external-crm-sync's
// `capture_intake` builds a thought exactly the way REST /capture and the MCP
// `capture_thought` tool do, instead of carrying a third copy. open-brain-mcp
// imports these; behaviour there is unchanged (same prompt, same model, same
// gates, same call_site names for the openrouter_calls audit).
//
// ingest-thought/index.ts still carries its own copies of getEmbedding,
// extractMetadata and extractAndStoreActionItems. Until it imports from here
// too, a fix to any of the three must land in BOTH this file and
// ingest-thought, per the mirror rule in AGENTS.md.
//
// normalizeActionText and the log truncation length come from
// ./capture-helpers.ts, which ingest-thought imports too (Task 5.2, correction
// 3); normalizeActionText is re-exported here so existing importers keep it.
//
// No supabase-js import: callers pass their own client, typed structurally,
// so this module resolves the same from every function's import map.

import { callOpenRouter } from "./openrouter.ts";
import {
  EMBEDDING_TIMEOUT_MS,
  METADATA_TIMEOUT_MS,
  withTimeout,
} from "./capture-timeouts.ts";
import { loadProfile } from "./profile.ts";
import {
  extractOperatorLines,
  isDescriptiveType,
  isExcludedSource,
  isOperationCommandCapture,
  isWorkReportCapture,
} from "./metadata-validation.ts";
import { isUnanchoredAppointmentItem } from "./appointment-guard.ts";
import { recordDecision } from "./decisions.ts";
import { applyFragmentGate, recordPronounSuspects } from "./fragment-gate.ts";
import {
  createBatchDedup,
  loadSemanticCandidates,
  proposeSemanticDuplicates,
  recordBatchDuplicates,
} from "./dedup.ts";
import { LOG_TRUNC, normalizeActionText } from "./capture-helpers.ts";

export { normalizeActionText };

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function contentHash(text: string): Promise<string> {
  const data = new TextEncoder().encode(text.trim());
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function getEmbedding(
  functionSlug: string,
  text: string,
): Promise<number[]> {
  const { data } = await withTimeout(EMBEDDING_TIMEOUT_MS, (signal) =>
    callOpenRouter({
    signal,
    function_slug: functionSlug,
    call_site: "getEmbedding",
    model: "openai/text-embedding-3-small",
    endpoint: "embeddings",
    input: text,
  }));
  return data.data![0].embedding!;
}

// The metadata-extraction system prompt, built once from the profile. Single
// source: ingest-thought imports it too, so the two capture files cannot
// drift (fragment-gate.test.ts pins that).
export const EXTRACT_METADATA_SYSTEM_PROMPT =
  `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned by full name when possible, e.g. "${loadProfile().example_person_name}" (use full name when possible) (empty if none)
- "action_items": array of FUTURE to-dos the user still needs to do. STRICT RULES:
    * Only include items phrased as future work: "need to X", "should X", "TODO: X", an imperative about something not yet done, or an explicit open question.
    * NEVER include work described in past tense. If the note says "I updated X", "fixed Y", "shipped Z", "changed the ratio to 3px/1px", "replaced the background", those are DONE and must be excluded.
    * NEVER restate completed work as an imperative. Do not turn "updated the ratio to 3px" into "Update the ratio to 3px".
    * Session logs, changelogs, retrospectives, and "here's what I just did" summaries almost always have an empty action_items array. Default to [] when in doubt.
    * A commitment to do something later ("I'll test this tomorrow") IS an action item. A description of something already tested is NOT.
    * Each item must stand alone: name the person and the thing. Never use her, him, it, that, or this as the object.
    * ONE request is ONE item. Never split a single instruction into its parts: the work itself, the output format, and where to deliver it all belong to the SAME item. "Research X and deliver the report under deliverables/foo/" is ONE action item, not two. A stranded clause like "Deliver the report under deliverables/<project-slug>/" is not work on its own, and it does real damage: when its sibling ships and resolves, the clause stays open and reads to downstream automation as an unhandled request, which is how a single request silently becomes a duplicate task-board card days later.
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

Only extract what's explicitly there. Be conservative — empty arrays and null fields are fine.`;

export async function extractMetadata(
  functionSlug: string,
  text: string,
): Promise<Record<string, unknown>> {
  const { data } = await withTimeout(METADATA_TIMEOUT_MS, (signal) =>
    callOpenRouter({
    signal,
    function_slug: functionSlug,
    call_site: "extractMetadata",
    model: "openai/gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          EXTRACT_METADATA_SYSTEM_PROMPT,
      },
      { role: "user", content: text },
    ],
  }));
  const d = data as { choices: Array<{ message: { content: string } }> };
  try {
    return JSON.parse(d.choices![0].message!.content!);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

// --- Action Item Tracking ---

/** The supabase-js calls this module makes, typed structurally. `rpc` is
 * optional in the type so a test fake may omit it; Task 5.2's semantic dedup
 * then reads no candidates and writes no proposal (logged, never thrown). */
export type ActionItemDb = {
  // deno-lint-ignore no-explicit-any
  from(table: string): any;
  // deno-lint-ignore no-explicit-any
  rpc?: (fn: string, args: Record<string, unknown>) => any;
};

/** `isMechanical` is the caller's mechanical-capture test: open-brain-mcp passes
 * isMechanicalCapture from ./capture-helpers.ts, the one ingest-thought calls
 * and that also gates checkAutoResolve in both capture files. */
export async function extractAndStoreActionItems(
  db: ActionItemDb,
  thoughtId: string,
  metadata: Record<string, unknown>,
  content: string,
  isMechanical: (content: string) => boolean,
): Promise<void> {
  // Precedence (loop-closing Task 1.2, amended round 4): mechanical prefix,
  // operation command, excluded source, then the operator marker (profile work_report_marker), then the
  // descriptive-type gate for everything else. The marker overrides the type
  // gate and nothing else.

  // Mirror of LAYER 0 in checkAutoResolve: mechanical captures (sync jobs, email
  // threads, weekly reviews) are observation-shaped, not commitment-shaped. The
  // extraction LLM may still pick up advisory phrases ("should reduce volume",
  // "needs more sleep") from prose summaries; suppress storing those as open
  // action items so they don't pollute the digest's open-items section.
  if (isMechanical(content)) return;

  if (isOperationCommandCapture(content, String(metadata?.source ?? ""))) {
    return;
  }

  // B2 part 1: task-intake captures already become board drafts; gmail/email
  // captures are advisory marketing copy. Neither stores items, marker or not.
  if (isExcludedSource(metadata)) return;

  let items: unknown[];
  if (isWorkReportCapture(content)) {
    // Work-report gate: a session close-out stores ONLY its explicit
    // operator-marker lines (`FOR OPERATOR:` by default); the LLM's extracted imperatives are discarded even
    // when the report is typed task/idea, and the lines are kept even when it
    // is typed observation.
    const extracted = Array.isArray(metadata.action_items)
      ? (metadata.action_items as unknown[])
      : [];
    items = extractOperatorLines(content);
    console.log(
      `work-report gate: replaced ${extracted.length} extracted items with ${items.length} operator-marker lines`,
    );
    // One decision row per replaced item, so the suppressed text is auditable
    // (loop-closing Task 1.4; layer gate, outcome dropped, reason work_report).
    for (const desc of extracted) {
      await recordDecision(db, {
        layer: "gate",
        outcome: "dropped",
        reason: "work_report",
        candidate_description: String(desc),
        thought_id: thoughtId,
      });
    }
  } else {
    // B2 part 2: observations and references are descriptive, not
    // commitment-shaped.
    if (isDescriptiveType(metadata)) return;
    items = Array.isArray(metadata.action_items)
      ? (metadata.action_items as unknown[])
      : [];
  }
  if (items.length === 0) return;

  // Fetch existing open items to dedup against
  const { data: existingItems } = await db
    .from("action_items")
    .select("description")
    .eq("status", "open");

  const existingNormalized = new Set(
    ((existingItems || []) as Array<{ description: string }>).map((item) =>
      normalizeActionText(item.description)
    ),
  );

  const guarded = items
    .map((desc: unknown) => ({
      source_thought_id: thoughtId,
      description: String(desc),
      status: "open",
    }))
    // Appointment guard: unanchored appointment reminders (no still-owed
    // language, no future-date signal in item or source) are review-only —
    // they duplicate the booking system, not real backlog.
    .filter((row) => {
      if (isUnanchoredAppointmentItem(row.description, content, new Date())) {
        console.log(
          `appointment guard: skipped unanchored item: ${
            row.description.slice(0, LOG_TRUNC)
          }`,
        );
        return false;
      }
      return true;
    });
  // Fragment gate (loop-closing Task 5.1), after the appointment guard: drops
  // one_token and dangling_clause items, one decision row per drop. Then the
  // open-item exact dedup (silent, as before), then the batch-local exact
  // dedup (Task 5.2): its normalized set is updated as the batch is filtered,
  // so two identical strings in one batch insert once. The open-item dedup
  // runs first so a batch copy of an item that is already open is skipped
  // silently, never recorded against a survivor that was never inserted.
  const batch = createBatchDedup(normalizeActionText);
  const rows = (await applyFragmentGate(db, thoughtId, guarded))
    .filter((row) =>
      !existingNormalized.has(normalizeActionText(row.description))
    )
    .filter((row) => batch.keep(row.description));

  if (rows.length === 0) return;
  // Semantic dedup candidates (Task 5.2), read BEFORE the insert so each is
  // older than every row this batch inserts. Never throws.
  const recent = await loadSemanticCandidates(db);
  const { data: inserted, error } = await db.from("action_items").insert(rows)
    .select("id, description");
  if (error) {
    console.error("Action item insert error:", error);
    return;
  }
  // Pronoun-object suspects are inserted, then proposed for review (Task 5.1).
  await recordPronounSuspects(
    db,
    thoughtId,
    (inserted ?? []) as Array<{ id: string; description: string }>,
  );
  // Task 5.2: each batch copy names the survivor the insert returned; then a
  // semantic overlap with a recent open item is proposed, never suppressed.
  await recordBatchDuplicates(
    db,
    thoughtId,
    batch.duplicates,
    inserted,
    normalizeActionText,
  );
  await proposeSemanticDuplicates(
    db,
    recent,
    thoughtId,
    metadata.project,
    inserted,
  );
}
