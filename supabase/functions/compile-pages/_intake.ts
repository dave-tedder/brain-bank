export interface CompileThoughtLike {
  content: string;
}

export interface SelectCompileThoughtsOptions {
  catchup: boolean;
  maxCount: number;
  maxChars: number;
}

export interface CompilePromptDiagnostics {
  is_catchup: boolean;
  thought_count: number;
  thought_chars: number;
  page_chars: number;
  user_content_chars: number;
  system_prompt_chars: number;
  backlink_chars: number;
  selected_thought_ids: string[];
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
}): CompilePromptDiagnostics {
  return {
    is_catchup: input.isCatchup,
    thought_count: input.thoughts.length,
    thought_chars: input.thoughts.reduce(
      (sum, thought) => sum + thought.content.length,
      0,
    ),
    page_chars: input.pageContent.length,
    user_content_chars: input.userContent.length,
    system_prompt_chars: input.systemPrompt.length,
    backlink_chars: input.backlinkList.length,
    selected_thought_ids: input.thoughts.map((thought) => thought.id),
  };
}
