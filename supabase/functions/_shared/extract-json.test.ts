import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractJsonObject } from "./extract-json.ts";

Deno.test("clean JSON object passes through", () => {
  assertEquals(extractJsonObject('{"resolved":[]}'), '{"resolved":[]}');
});

Deno.test("fenced JSON block is unwrapped", () => {
  const raw = "```json\n{\"resolved\":[{\"num\":1}]}\n```";
  assertEquals(JSON.parse(extractJsonObject(raw)).resolved[0].num, 1);
});

Deno.test("fenced JSON ignores trailing prose", () => {
  const raw = "```json\n{\"resolved\":[{\"num\":2}]}\n```\n\nExplanation follows.";
  assertEquals(JSON.parse(extractJsonObject(raw)).resolved[0].num, 2);
});

Deno.test("unfenced JSON trims ordinary trailing prose", () => {
  const raw = '{"resolved":[]}\n\nNo items matched.';
  assertEquals(JSON.parse(extractJsonObject(raw)).resolved, []);
});

Deno.test("stray closing brace in unfenced prose fails safe", () => {
  const raw = '{"resolved":[]}\n\nExtra } in prose.';
  let threw = false;
  try {
    JSON.parse(extractJsonObject(raw));
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("non-JSON and empty output remain parse failures", () => {
  assertEquals(extractJsonObject("  no decision  "), "no decision");
  assertEquals(extractJsonObject(""), "");
  for (const raw of ["  no decision  ", ""]) {
    let threw = false;
    try {
      JSON.parse(extractJsonObject(raw));
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  }
});
