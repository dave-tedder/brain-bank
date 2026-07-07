import { parsePageSections, serializePage } from "./_section_merge.ts";

export interface CompileThoughtLike {
  content: string;
}

export interface SelectCompileThoughtsOptions {
  catchup: boolean;
  maxCount: number;
  maxChars: number;
}

export type CompileSelectionMode =
  | "steady"
  | "catchup"
  | "catchup_budget_fit"
  | "catchup_fallback"
  | "targeted";

export interface CompilePromptDiagnostics {
  is_catchup: boolean;
  thought_count: number;
  thought_chars: number;
  page_chars: number;
  user_content_chars: number;
  system_prompt_chars: number;
  prompt_chars: number;
  backlink_chars: number;
  selected_thought_ids: string[];
  selection_mode: CompileSelectionMode;
  thought_limit: number;
  source_char_limit: number;
  fallback_applied: boolean;
  fallback_reason?: string;
  initial_thought_count?: number;
  initial_thought_chars?: number;
  initial_prompt_chars?: number;
  is_new_page: boolean;
  has_h2: boolean;
  use_edit_mode: boolean;
  page_truncation_applied?: boolean;
  page_view_chars?: number;
  page_omitted_sections?: number;
  page_omitted_chars?: number;
  backlinks_capped?: boolean;
  backlink_slugs_shown?: number;
}

export function selectCompileThoughts<T extends CompileThoughtLike>(
  thoughts: T[],
  options: SelectCompileThoughtsOptions,
): T[] {
  const maxCount = Math.max(0, Math.floor(options.maxCount));
  if (maxCount === 0 || thoughts.length === 0) return [];

  const countBounded = thoughts.slice(0, maxCount);
  if (!options.catchup) return countBounded;

  const maxChars = Math.max(0, Math.floor(options.maxChars));
  const selected: T[] = [];
  let chars = 0;

  for (const thought of countBounded) {
    const thoughtChars = thought.content.length;
    if (selected.length > 0 && chars + thoughtChars > maxChars) break;
    selected.push(thought);
    chars += thoughtChars;
  }

  // Always allow one thought through so stale pages make forward progress
  // after a successful synthesis, even when a single capture exceeds the cap.
  return selected.length > 0 ? selected : [countBounded[0]];
}

export function buildCompilePromptDiagnostics<
  T extends CompileThoughtLike & { id: string },
>(input: {
  isCatchup: boolean;
  thoughts: T[];
  pageContent: string;
  userContent: string;
  systemPrompt: string;
  backlinkList: string;
  selectionMode: CompileSelectionMode;
  thoughtLimit: number;
  sourceCharLimit: number;
  fallbackApplied?: boolean;
  fallbackReason?: string;
  initialThoughtCount?: number;
  initialThoughtChars?: number;
  initialPromptChars?: number;
  isNewPage: boolean;
  hasH2: boolean;
  useEditMode: boolean;
  pageTruncation?: PageTruncationResult;
  backlinksCapped?: boolean;
  backlinkSlugsShown?: number;
}): CompilePromptDiagnostics {
  const diagnostics: CompilePromptDiagnostics = {
    is_catchup: input.isCatchup,
    thought_count: input.thoughts.length,
    thought_chars: input.thoughts.reduce(
      (sum, thought) => sum + thought.content.length,
      0,
    ),
    page_chars: input.pageContent.length,
    user_content_chars: input.userContent.length,
    system_prompt_chars: input.systemPrompt.length,
    prompt_chars: input.userContent.length + input.systemPrompt.length,
    backlink_chars: input.backlinkList.length,
    selected_thought_ids: input.thoughts.map((thought) => thought.id),
    selection_mode: input.selectionMode,
    thought_limit: input.thoughtLimit,
    source_char_limit: input.sourceCharLimit,
    fallback_applied: input.fallbackApplied ?? false,
    is_new_page: input.isNewPage,
    has_h2: input.hasH2,
    use_edit_mode: input.useEditMode,
  };
  if (input.fallbackReason) diagnostics.fallback_reason = input.fallbackReason;
  if (input.initialThoughtCount !== undefined) {
    diagnostics.initial_thought_count = input.initialThoughtCount;
  }
  if (input.initialThoughtChars !== undefined) {
    diagnostics.initial_thought_chars = input.initialThoughtChars;
  }
  if (input.initialPromptChars !== undefined) {
    diagnostics.initial_prompt_chars = input.initialPromptChars;
  }
  if (input.pageTruncation?.truncationApplied) {
    diagnostics.page_truncation_applied = true;
    diagnostics.page_view_chars = input.pageTruncation.content.length;
    diagnostics.page_omitted_sections = input.pageTruncation.omittedSections;
    diagnostics.page_omitted_chars = input.pageTruncation.omittedChars;
  }
  if (input.backlinksCapped) {
    diagnostics.backlinks_capped = true;
  }
  if (input.backlinkSlugsShown !== undefined) {
    diagnostics.backlink_slugs_shown = input.backlinkSlugsShown;
  }
  return diagnostics;
}

// --- Budget-fit thought re-selection (Session 285) ---
//
// The initial catch-up slice is selected against CATCHUP_SOURCE_CHAR_LIMIT,
// not against what actually remains of the prompt budget once the page view,
// backlinks, and system prompt are accounted for. When the assembled prompt
// is still over the soft limit after CAP-1 page-side truncation, re-select
// the largest ascending prefix of the fetched oversample that fits the
// remaining budget — instead of collapsing to the 1-thought fallback, which
// stalls deep-backlog drain (topic/tattoo: 1 thought/day against 489).
//
// The allowance covers the per-thought "[i] (id: <uuid>, date, type) " header
// that buildNewThoughtsText adds on top of raw content chars.
export const BUDGET_FIT_THOUGHT_HEADER_ALLOWANCE = 80;

export interface BudgetFitOptions {
  // Current assembled prompt size (system + user content).
  promptChars: number;
  // Chars of the rendered thought block currently inside that prompt.
  thoughtsTextChars: number;
  softPromptCharLimit: number;
  maxCount: number;
}

export function fitCompileThoughtsToBudget<T extends CompileThoughtLike>(
  fetched: T[],
  options: BudgetFitOptions,
): { thoughts: T[]; maxChars: number } {
  const overhead = options.promptChars - options.thoughtsTextChars;
  const headerAllowance = BUDGET_FIT_THOUGHT_HEADER_ALLOWANCE *
    Math.min(options.maxCount, fetched.length);
  const maxChars = Math.max(
    0,
    options.softPromptCharLimit - overhead - headerAllowance,
  );
  // selectCompileThoughts guarantees at least one thought through, so a
  // negative or tiny budget degrades to the old 1-thought behavior.
  const thoughts = selectCompileThoughts(fetched, {
    catchup: true,
    maxCount: options.maxCount,
    maxChars,
  });
  return { thoughts, maxChars };
}

export interface CatchupPromptFallbackOptions {
  originalThoughts: CompileThoughtLike[];
  selectionMode: CompileSelectionMode;
  promptChars: number;
  softPromptCharLimit: number;
  fallbackThoughtLimit: number;
  fallbackSourceCharLimit: number;
  noH2ThoughtLimit: number;
  hasH2: boolean;
  isNewPage: boolean;
}

export interface CatchupPromptFallbackResult<T extends CompileThoughtLike> {
  thoughts: T[];
  selectionMode: CompileSelectionMode;
  fallbackApplied: boolean;
  fallbackReason?: "prompt_soft_limit" | "no_h2_migration";
  thoughtLimit?: number;
  sourceCharLimit?: number;
  initialThoughtCount?: number;
  initialThoughtChars?: number;
  initialPromptChars?: number;
}

export function applyCatchupPromptFallback<T extends CompileThoughtLike>(
  selectedThoughts: T[],
  options: CatchupPromptFallbackOptions,
): CatchupPromptFallbackResult<T> {
  if (options.selectionMode !== "catchup") {
    return {
      thoughts: selectedThoughts,
      selectionMode: options.selectionMode,
      fallbackApplied: false,
    };
  }

  const needsNoH2Migration = !options.isNewPage && !options.hasH2;
  const exceedsSoftLimit = options.promptChars > options.softPromptCharLimit;
  if (!needsNoH2Migration && !exceedsSoftLimit) {
    return {
      thoughts: selectedThoughts,
      selectionMode: options.selectionMode,
      fallbackApplied: false,
    };
  }

  const fallbackReason = needsNoH2Migration
    ? "no_h2_migration"
    : "prompt_soft_limit";
  const thoughtLimit = needsNoH2Migration
    ? options.noH2ThoughtLimit
    : options.fallbackThoughtLimit;
  const sourceCharLimit = needsNoH2Migration
    ? Number.MAX_SAFE_INTEGER
    : options.fallbackSourceCharLimit;
  const thoughts = selectCompileThoughts(options.originalThoughts as T[], {
    catchup: true,
    maxCount: thoughtLimit,
    maxChars: sourceCharLimit,
  });

  return {
    thoughts,
    selectionMode: "catchup_fallback",
    fallbackApplied: true,
    fallbackReason,
    thoughtLimit,
    sourceCharLimit,
    initialThoughtCount: selectedThoughts.length,
    initialThoughtChars: selectedThoughts.reduce(
      (sum, thought) => sum + thought.content.length,
      0,
    ),
    initialPromptChars: options.promptChars,
  };
}

// --- Edit-mode page-side prompt truncation (CAP-1) ---
//
// applyCatchupPromptFallback only shrinks the thought slice. A page whose
// existing body + backlink list dominate the prompt (topic/trend-analysis,
// 2026-06-29: 18K body + 5.6K backlinks) stays over the soft limit no matter
// how small the slice gets and aborts on the LLM timeout every scheduled run.
// In edit mode the model only needs section HEADERS to target edits, so older
// section bodies can be dropped from the prompt view while every header stays
// addressable. Only the prompt view shrinks — applyEdits still runs against
// the full stored page body.
//
// Ordering (Session 285): the caller applies this truncation BEFORE the
// thought-slice fallback. Page-side reduction is lossless; collapsing the
// thought slice to FALLBACK_CATCHUP_THOUGHT_LIMIT costs catch-up progress
// (topic/tattoo drained 1 thought/day against a 489-thought backlog when the
// fallback fired on the pre-truncation prompt size).

export const OMITTED_SECTION_MARKER =
  "[section body omitted for prompt budget; do not update this section]";

export interface PageTruncationResult {
  content: string;
  truncationApplied: boolean;
  omittedSections: number;
  omittedChars: number;
}

export function truncatePageContentForPrompt(
  pageContent: string,
  maxChars: number,
): PageTruncationResult {
  if (pageContent.length <= maxChars) {
    return {
      content: pageContent,
      truncationApplied: false,
      omittedSections: 0,
      omittedChars: 0,
    };
  }

  const sections = parsePageSections(pageContent);
  const names = [...sections.keys()].filter((name) => name !== "");
  const preamble = sections.get("") ?? "";

  // Fixed cost: preamble, every H2 header line, and a worst-case marker per
  // section. Whatever budget remains goes to real section bodies, newest
  // (bottom-most) sections first, stopping at the first body that no longer
  // fits so the kept region is a contiguous most-recent block.
  let budget = maxChars - preamble.length;
  for (const name of names) {
    budget -= `## ${name}\n`.length + OMITTED_SECTION_MARKER.length + 1;
  }

  const keep = new Set<string>();
  for (let i = names.length - 1; i >= 0; i--) {
    const body = sections.get(names[i]) ?? "";
    // The kept body replaces this section's reserved marker cost.
    const cost = body.length - (OMITTED_SECTION_MARKER.length + 1);
    if (cost > budget) break;
    keep.add(names[i]);
    budget -= cost;
  }

  let omittedSections = 0;
  let omittedChars = 0;
  const view = new Map<string, string>();
  view.set("", preamble);
  for (const name of names) {
    const body = sections.get(name) ?? "";
    if (keep.has(name)) {
      view.set(name, body);
    } else {
      omittedSections++;
      omittedChars += body.length;
      view.set(name, `${OMITTED_SECTION_MARKER}\n`);
    }
  }

  if (omittedSections === 0) {
    // Nothing could be dropped (e.g. one giant section that also fits once
    // marker overhead is refunded) — return the original untouched.
    return {
      content: pageContent,
      truncationApplied: false,
      omittedSections: 0,
      omittedChars: 0,
    };
  }

  return {
    content: serializePage(view),
    truncationApplied: true,
    omittedSections,
    omittedChars,
  };
}

// Cap the backlink candidate list shown to the model. The page's existing
// backlinks go first so a successful compile can re-emit them instead of
// silently dropping cross-references it can no longer see.
export function capBacklinkSlugs(
  otherSlugs: string[],
  existingBacklinks: string[],
  maxSlugs: number,
): { slugs: string[]; capped: boolean } {
  if (otherSlugs.length <= maxSlugs) {
    return { slugs: otherSlugs, capped: false };
  }
  const available = new Set(otherSlugs);
  const slugs: string[] = [];
  for (const slug of existingBacklinks) {
    if (slugs.length >= maxSlugs) break;
    if (available.has(slug) && !slugs.includes(slug)) slugs.push(slug);
  }
  for (const slug of otherSlugs) {
    if (slugs.length >= maxSlugs) break;
    if (!slugs.includes(slug)) slugs.push(slug);
  }
  return { slugs, capped: true };
}
