import { assertEquals } from "https://deno.land/std@0.220.0/assert/mod.ts";
import {
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
    }),
    {
      is_catchup: true,
      thought_count: 2,
      thought_chars: 7,
      page_chars: 8,
      user_content_chars: 11,
      system_prompt_chars: 6,
      backlink_chars: 3,
      selected_thought_ids: ["1", "2"],
    },
  );
});
