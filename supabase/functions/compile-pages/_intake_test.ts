import { assertEquals } from "https://deno.land/std@0.220.0/assert/mod.ts";
import {
  applyCatchupPromptFallback,
  buildCompilePromptDiagnostics,
  selectCompileThoughts,
} from "./_intake.ts";

function thought(id: string, content: string) {
  return { id, content };
}

Deno.test("selectCompileThoughts: steady mode applies count limit only", () => {
  const thoughts = [
    thought("1", "12345"),
    thought("2", "12345"),
    thought("3", "12345"),
  ];

  assertEquals(
    selectCompileThoughts(thoughts, {
      catchup: false,
      maxCount: 2,
      maxChars: 6,
    }).map((t) => t.id),
    ["1", "2"],
  );
});

Deno.test("selectCompileThoughts: catch-up preserves order and caps source chars", () => {
  const thoughts = [
    thought("1", "1234"),
    thought("2", "1234"),
    thought("3", "1234"),
  ];

  assertEquals(
    selectCompileThoughts(thoughts, {
      catchup: true,
      maxCount: 3,
      maxChars: 8,
    }).map((t) => t.id),
    ["1", "2"],
  );
});

Deno.test("selectCompileThoughts: catch-up never exceeds maxCount", () => {
  const thoughts = [
    thought("1", "1"),
    thought("2", "2"),
    thought("3", "3"),
  ];

  assertEquals(
    selectCompileThoughts(thoughts, {
      catchup: true,
      maxCount: 2,
      maxChars: 100,
    }).map((t) => t.id),
    ["1", "2"],
  );
});

Deno.test("selectCompileThoughts: catch-up always lets one oversized thought through", () => {
  const thoughts = [
    thought("1", "1234567890"),
    thought("2", "1"),
  ];

  assertEquals(
    selectCompileThoughts(thoughts, {
      catchup: true,
      maxCount: 2,
      maxChars: 5,
    }).map((t) => t.id),
    ["1"],
  );
});

Deno.test("selectCompileThoughts: zero maxCount selects nothing", () => {
  assertEquals(
    selectCompileThoughts([thought("1", "x")], {
      catchup: true,
      maxCount: 0,
      maxChars: 100,
    }),
    [],
  );
});

Deno.test("buildCompilePromptDiagnostics: reports compact prompt shape", () => {
  assertEquals(
    buildCompilePromptDiagnostics({
      isCatchup: true,
      thoughts: [thought("1", "abc"), thought("2", "defg")],
      pageContent: "existing",
      userContent: "user prompt",
      systemPrompt: "system",
      backlinkList: "a\nb",
      selectionMode: "catchup",
      thoughtLimit: 25,
      sourceCharLimit: 18000,
      isNewPage: false,
      hasH2: true,
      useEditMode: true,
    }),
    {
      is_catchup: true,
      thought_count: 2,
      thought_chars: 7,
      page_chars: 8,
      user_content_chars: 11,
      system_prompt_chars: 6,
      prompt_chars: 17,
      backlink_chars: 3,
      selected_thought_ids: ["1", "2"],
      selection_mode: "catchup",
      thought_limit: 25,
      source_char_limit: 18000,
      fallback_applied: false,
      is_new_page: false,
      has_h2: true,
      use_edit_mode: true,
    },
  );
});

Deno.test("applyCatchupPromptFallback: leaves steady mode unchanged", () => {
  const selected = [thought("1", "12345"), thought("2", "12345")];

  const result = applyCatchupPromptFallback(selected, {
    originalThoughts: selected,
    selectionMode: "steady",
    promptChars: 50000,
    softPromptCharLimit: 24000,
    fallbackThoughtLimit: 3,
    fallbackSourceCharLimit: 8000,
    noH2ThoughtLimit: 1,
    hasH2: false,
    isNewPage: false,
  });

  assertEquals(result.thoughts.map((t) => t.id), ["1", "2"]);
  assertEquals(result.selectionMode, "steady");
  assertEquals(result.fallbackApplied, false);
});

Deno.test("applyCatchupPromptFallback: targeted mode bypasses fallback", () => {
  const selected = [thought("1", "12345"), thought("2", "12345")];

  const result = applyCatchupPromptFallback(selected, {
    originalThoughts: selected,
    selectionMode: "targeted",
    promptChars: 50000,
    softPromptCharLimit: 24000,
    fallbackThoughtLimit: 1,
    fallbackSourceCharLimit: 1,
    noH2ThoughtLimit: 1,
    hasH2: false,
    isNewPage: false,
  });

  assertEquals(result.thoughts.map((t) => t.id), ["1", "2"]);
  assertEquals(result.selectionMode, "targeted");
  assertEquals(result.fallbackApplied, false);
});

Deno.test("applyCatchupPromptFallback: catch-up over soft prompt limit shrinks source slice", () => {
  const original = [
    thought("1", "1234"),
    thought("2", "1234"),
    thought("3", "1234"),
    thought("4", "1234"),
  ];

  const result = applyCatchupPromptFallback(original, {
    originalThoughts: original,
    selectionMode: "catchup",
    promptChars: 30000,
    softPromptCharLimit: 24000,
    fallbackThoughtLimit: 3,
    fallbackSourceCharLimit: 8,
    noH2ThoughtLimit: 1,
    hasH2: true,
    isNewPage: false,
  });

  assertEquals(result.thoughts.map((t) => t.id), ["1", "2"]);
  assertEquals(result.selectionMode, "catchup_fallback");
  assertEquals(result.fallbackApplied, true);
  assertEquals(result.fallbackReason, "prompt_soft_limit");
  assertEquals(result.initialThoughtCount, 4);
  assertEquals(result.initialThoughtChars, 16);
  assertEquals(result.initialPromptChars, 30000);
});

Deno.test("applyCatchupPromptFallback: no-H2 catch-up migration uses one thought", () => {
  const original = [
    thought("1", "1234"),
    thought("2", "1234"),
    thought("3", "1234"),
  ];

  const result = applyCatchupPromptFallback(original, {
    originalThoughts: original,
    selectionMode: "catchup",
    promptChars: 10000,
    softPromptCharLimit: 24000,
    fallbackThoughtLimit: 3,
    fallbackSourceCharLimit: 8000,
    noH2ThoughtLimit: 1,
    hasH2: false,
    isNewPage: false,
  });

  assertEquals(result.thoughts.map((t) => t.id), ["1"]);
  assertEquals(result.selectionMode, "catchup_fallback");
  assertEquals(result.fallbackApplied, true);
  assertEquals(result.fallbackReason, "no_h2_migration");
});

Deno.test("applyCatchupPromptFallback: fallback always lets one oversized thought through", () => {
  const original = [
    thought("1", "1234567890"),
    thought("2", "1"),
  ];

  const result = applyCatchupPromptFallback(original, {
    originalThoughts: original,
    selectionMode: "catchup",
    promptChars: 30000,
    softPromptCharLimit: 24000,
    fallbackThoughtLimit: 3,
    fallbackSourceCharLimit: 5,
    noH2ThoughtLimit: 1,
    hasH2: true,
    isNewPage: false,
  });

  assertEquals(result.thoughts.map((t) => t.id), ["1"]);
  assertEquals(result.selectionMode, "catchup_fallback");
  assertEquals(result.fallbackApplied, true);
});
