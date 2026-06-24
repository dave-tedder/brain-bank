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
  return diagnostics;
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
