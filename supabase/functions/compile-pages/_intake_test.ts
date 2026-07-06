import { assertEquals } from "https://deno.land/std@0.220.0/assert/mod.ts";
import {
  applyCatchupPromptFallback,
  buildCompilePromptDiagnostics,
  capBacklinkSlugs,
  OMITTED_SECTION_MARKER,
  selectCompileThoughts,
  truncatePageContentForPrompt,
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

// --- truncatePageContentForPrompt (CAP-1) ---

function sectionBlock(name: string, body: string): string {
  return `## ${name}\n${body}\n`;
}

Deno.test("truncatePageContentForPrompt: no-op when content fits", () => {
  const content = "# Title\n\n" + sectionBlock("A", "aaa") +
    sectionBlock("B", "bbb");

  const result = truncatePageContentForPrompt(content, 10_000);

  assertEquals(result.truncationApplied, false);
  assertEquals(result.content, content);
  assertEquals(result.omittedSections, 0);
  assertEquals(result.omittedChars, 0);
});

Deno.test("truncatePageContentForPrompt: keeps preamble, all headers, newest bodies", () => {
  const preamble = "# Trend Analysis\n\nIntro paragraph.\n\n";
  const content = preamble +
    sectionBlock("Oldest", "x".repeat(3000)) +
    sectionBlock("Middle", "y".repeat(3000)) +
    sectionBlock("Newest", "z".repeat(500));

  const result = truncatePageContentForPrompt(content, 2_000);

  assertEquals(result.truncationApplied, true);
  // All headers survive
  for (const name of ["Oldest", "Middle", "Newest"]) {
    assertEquals(result.content.includes(`## ${name}\n`), true);
  }
  // Preamble survives
  assertEquals(result.content.startsWith(preamble), true);
  // Newest body kept in full; older bodies replaced by the marker
  assertEquals(result.content.includes("z".repeat(500)), true);
  assertEquals(result.content.includes("x".repeat(3000)), false);
  assertEquals(result.content.includes("y".repeat(3000)), false);
  assertEquals(result.omittedSections, 2);
  assertEquals(result.omittedChars > 6000, true);
  assertEquals(result.content.includes(OMITTED_SECTION_MARKER), true);
});

Deno.test("truncatePageContentForPrompt: kept region is contiguous from the bottom", () => {
  // Middle is small enough to fit alone, but Newest is huge: once Newest
  // fails to fit the walk stops, so Middle is omitted too (no cherry-picking
  // that would misrepresent recency).
  const content = sectionBlock("Old", "a".repeat(2000)) +
    sectionBlock("Middle", "b".repeat(100)) +
    sectionBlock("Newest", "c".repeat(5000));

  const result = truncatePageContentForPrompt(content, 1_000);

  assertEquals(result.truncationApplied, true);
  assertEquals(result.content.includes("c".repeat(5000)), false);
  assertEquals(result.content.includes("b".repeat(100)), false);
  assertEquals(result.omittedSections, 3);
});

Deno.test("truncatePageContentForPrompt: view lands at or under budget for real-shaped pages", () => {
  const content = "# Page\n\n" +
    Array.from(
      { length: 8 },
      (_, i) => sectionBlock(`Section ${i}`, "w".repeat(2500)),
    ).join("");

  const result = truncatePageContentForPrompt(content, 12_000);

  assertEquals(result.truncationApplied, true);
  assertEquals(result.content.length <= 12_000, true);
});

// --- capBacklinkSlugs (CAP-1) ---

Deno.test("capBacklinkSlugs: no-op under the cap", () => {
  const result = capBacklinkSlugs(["a", "b"], ["b"], 5);
  assertEquals(result.capped, false);
  assertEquals(result.slugs, ["a", "b"]);
});

Deno.test("capBacklinkSlugs: existing backlinks first, then fill, no dupes", () => {
  const others = ["p1", "p2", "p3", "p4", "p5"];
  const result = capBacklinkSlugs(others, ["p4", "gone-page", "p2"], 4);

  assertEquals(result.capped, true);
  assertEquals(result.slugs, ["p4", "p2", "p1", "p3"]);
});
