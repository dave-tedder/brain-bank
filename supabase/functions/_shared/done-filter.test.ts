import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { filterCandidatesForDone, _internals } from "./done-filter.ts";

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, description: `item ${i} content` }));

Deno.test("filterCandidatesForDone: empty done text returns first cap items", () => {
  const result = filterCandidatesForDone("", items(300), 200);
  assertEquals(result.length, 200);
  assertEquals(result[0].id, "id-0");
});

Deno.test("filterCandidatesForDone: stopword-only done text falls back to cap", () => {
  const result = filterCandidatesForDone("the and for", items(5), 200);
  assertEquals(result.length, 5);
  assertEquals(result[0].id, "id-0");
});

Deno.test("filterCandidatesForDone: short-token done text falls back to cap", () => {
  const result = filterCandidatesForDone("do go in", items(5), 200);
  assertEquals(result.length, 5);
});

Deno.test("filterCandidatesForDone: overlap path keeps only matches", () => {
  const pool = [
    { id: "a", description: "fix the broken login flow" },
    { id: "b", description: "update README with screenshots" },
    { id: "c", description: "investigate failing login telemetry" },
  ];
  const result = filterCandidatesForDone("shipped the login fix", pool, 200);
  const ids = result.map((r) => r.id).sort();
  assertEquals(ids, ["a", "c"]);
});

Deno.test("filterCandidatesForDone: cap enforced when overlap > cap", () => {
  const pool = Array.from({ length: 250 }, (_, i) => ({ id: `id-${i}`, description: "login bug recurring" }));
  const result = filterCandidatesForDone("fixed login bug", pool, 200);
  assertEquals(result.length, 200);
});

Deno.test("filterCandidatesForDone: case insensitive", () => {
  const pool = [
    { id: "a", description: "Fix Login Flow" },
    { id: "b", description: "Refactor Auth Module" },
  ];
  const result = filterCandidatesForDone("LOGIN bug", pool, 200);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "a");
});

Deno.test("filterCandidatesForDone: non-alphanumeric splitting", () => {
  const pool = [
    { id: "a", description: "Fix bug-123 in payment flow" },
    { id: "b", description: "Unrelated thing" },
  ];
  const result = filterCandidatesForDone("bug-123 fixed", pool, 200);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "a");
});

Deno.test("filterCandidatesForDone: no overlap falls back to first cap items", () => {
  const pool = [
    { id: "a", description: "fix login flow" },
    { id: "b", description: "update README" },
  ];
  const result = filterCandidatesForDone("zebra elephant marmoset", pool, 200);
  assertEquals(result.length, 2);
  assertEquals(result.map((r) => r.id), ["a", "b"]);
});

Deno.test("_internals.tokenize: strips stopwords, lowercases, drops short tokens", () => {
  const tokens = _internals.tokenize("THE Quick fox is do");
  assertEquals(tokens, new Set(["quick", "fox"]));
});

Deno.test("_internals.tokenize: empty input returns empty set", () => {
  const tokens = _internals.tokenize("");
  assertEquals(tokens.size, 0);
});
