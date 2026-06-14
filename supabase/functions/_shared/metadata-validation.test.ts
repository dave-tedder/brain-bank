// Deno unit tests for the shared classification helpers.
// Run: deno test supabase/functions/_shared/metadata-validation.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _resetSlugCacheForTests,
  coerceMetadata,
  coerceType,
  loadKnownSlugs,
  normalizeTopic,
  recombineHyphenated,
  shouldExtractActionItems,
} from "./metadata-validation.ts";

Deno.test("normalizeTopic: lowercases", () => {
  assertEquals(normalizeTopic("Tattoo"), "tattoo");
});

Deno.test("normalizeTopic: collapses spaces to hyphens", () => {
  assertEquals(normalizeTopic("Project Management"), "project-management");
});

Deno.test("normalizeTopic: collapses underscores to hyphens", () => {
  assertEquals(normalizeTopic("fitness_training"), "fitness-training");
});

Deno.test("normalizeTopic: collapses punctuation to hyphens", () => {
  assertEquals(normalizeTopic("appointment, marketing"), "appointment-marketing");
});

Deno.test("normalizeTopic: trims leading/trailing hyphens", () => {
  assertEquals(normalizeTopic("  -tattoo- "), "tattoo");
});

Deno.test("normalizeTopic: collapses multiple hyphens", () => {
  assertEquals(normalizeTopic("foo---bar"), "foo-bar");
});

Deno.test("normalizeTopic: empty / null-ish returns empty string", () => {
  assertEquals(normalizeTopic(""), "");
  assertEquals(normalizeTopic("   "), "");
  assertEquals(normalizeTopic("---"), "");
});

Deno.test("normalizeTopic: does NOT singularize", () => {
  assertEquals(normalizeTopic("appointments"), "appointments");
  assertEquals(normalizeTopic("process"), "process");
});

Deno.test("coerceType: passes valid types through", () => {
  assertEquals(coerceType("observation"), "observation");
  assertEquals(coerceType("task"), "task");
  assertEquals(coerceType("idea"), "idea");
  assertEquals(coerceType("reference"), "reference");
  assertEquals(coerceType("person_note"), "person_note");
});

Deno.test("coerceType: case-insensitive", () => {
  assertEquals(coerceType("Observation"), "observation");
  assertEquals(coerceType("TASK"), "task");
});

Deno.test("coerceType: hallucinated value defaults to observation", () => {
  assertEquals(coerceType("decision"), "observation");
  assertEquals(coerceType("note"), "observation");
});

Deno.test("coerceType: null / undefined / non-string defaults to observation", () => {
  assertEquals(coerceType(null), "observation");
  assertEquals(coerceType(undefined), "observation");
  assertEquals(coerceType(42), "observation");
  assertEquals(coerceType({}), "observation");
});

Deno.test("shouldExtractActionItems: task type -> true", () => {
  assertEquals(shouldExtractActionItems({ type: "task", source: "slack" }), true);
});

Deno.test("shouldExtractActionItems: observation type -> false", () => {
  assertEquals(shouldExtractActionItems({ type: "observation", source: "slack" }), false);
});

Deno.test("shouldExtractActionItems: reference type -> false", () => {
  assertEquals(shouldExtractActionItems({ type: "reference", source: "slack" }), false);
});

Deno.test("shouldExtractActionItems: idea type -> true", () => {
  assertEquals(shouldExtractActionItems({ type: "idea", source: "slack" }), true);
});

Deno.test("shouldExtractActionItems: gmail source -> false", () => {
  assertEquals(shouldExtractActionItems({ type: "task", source: "gmail" }), false);
});

Deno.test("shouldExtractActionItems: email source -> false", () => {
  assertEquals(shouldExtractActionItems({ type: "task", source: "email" }), false);
});

Deno.test("shouldExtractActionItems: case-insensitive on both", () => {
  assertEquals(shouldExtractActionItems({ type: "OBSERVATION", source: "slack" }), false);
  assertEquals(shouldExtractActionItems({ type: "task", source: "GMAIL" }), false);
});

Deno.test("shouldExtractActionItems: missing metadata fields -> fail open (true)", () => {
  assertEquals(shouldExtractActionItems({}), true);
  assertEquals(shouldExtractActionItems({ type: "task" }), true);
});

Deno.test("recombineHyphenated: split pair recombines when slug known + literal hit", () => {
  const known = new Set(["fitness-training"]);
  const content = "Note about fitness-training plan.";
  assertEquals(
    recombineHyphenated(["fitness", "training"], known, content),
    ["fitness-training"],
  );
});

Deno.test("recombineHyphenated: underscore literal also triggers recombine", () => {
  const known = new Set(["fitness-training"]);
  const content = "tagged fitness_training in capture";
  assertEquals(
    recombineHyphenated(["fitness", "training"], known, content),
    ["fitness-training"],
  );
});

Deno.test("recombineHyphenated: no recombine without literal substring", () => {
  const known = new Set(["fitness-training"]);
  const content = "Both fitness AND training matter, separately.";
  assertEquals(
    recombineHyphenated(["fitness", "training"], known, content),
    ["fitness", "training"],
  );
});

Deno.test("recombineHyphenated: no recombine if A is itself a known slug", () => {
  const known = new Set(["fitness", "fitness-training"]);
  const content = "fitness-training mention";
  assertEquals(
    recombineHyphenated(["fitness", "training"], known, content),
    ["fitness", "training"],
  );
});

Deno.test("recombineHyphenated: no recombine if combined not in known set", () => {
  const known = new Set(["something-else"]);
  const content = "fitness-training stuff";
  assertEquals(
    recombineHyphenated(["fitness", "training"], known, content),
    ["fitness", "training"],
  );
});

Deno.test("recombineHyphenated: passes through non-adjacent topics", () => {
  const known = new Set(["fitness-training"]);
  const content = "fitness-training noted";
  assertEquals(
    recombineHyphenated(["fitness", "other", "training"], known, content),
    ["fitness", "other", "training"],
  );
});

Deno.test("recombineHyphenated: empty input", () => {
  assertEquals(recombineHyphenated([], new Set(["fitness-training"]), "anything"), []);
});

Deno.test("recombineHyphenated: case-insensitive literal check", () => {
  const known = new Set(["fitness-training"]);
  const content = "FITNESS-TRAINING program";
  assertEquals(
    recombineHyphenated(["fitness", "training"], known, content),
    ["fitness-training"],
  );
});

Deno.test("coerceMetadata: full happy path", () => {
  const raw = {
    people: ["Jane Doe"],
    action_items: ["follow up Friday"],
    dates_mentioned: ["2026-05-25"],
    topics: ["Tattoo", "Project Management"],
    type: "task",
    project: "Brain Bank",
    priority: "high",
  };
  const known = new Set(["brain-bank", "sample-project"]);
  const out = coerceMetadata(raw, known, "any content");
  assertEquals(out.people, ["Jane Doe"]);
  assertEquals(out.action_items, ["follow up Friday"]);
  assertEquals(out.dates_mentioned, ["2026-05-25"]);
  assertEquals(out.topics, ["tattoo", "project-management"]);
  assertEquals(out.type, "task");
  assertEquals(out.project, "brain-bank");
  assertEquals(out.priority, "high");
});

Deno.test("coerceMetadata: project not in known set -> null", () => {
  const out = coerceMetadata(
    { project: "Phantom Made-Up Project", topics: ["x"] },
    new Set(["brain-bank"]),
    "any",
  );
  assertEquals(out.project, null);
});

Deno.test("coerceMetadata: hallucinated type -> observation", () => {
  const out = coerceMetadata({ type: "decision", topics: ["x"] }, new Set(), "any");
  assertEquals(out.type, "observation");
});

Deno.test("coerceMetadata: topics dedup + drop empties", () => {
  const out = coerceMetadata(
    { topics: ["Tattoo", "tattoo", "", "---", "Project Management"] },
    new Set(),
    "any",
  );
  assertEquals(out.topics, ["tattoo", "project-management"]);
});

Deno.test("coerceMetadata: empty topics -> ['uncategorized']", () => {
  const out = coerceMetadata({ topics: [] }, new Set(), "any");
  assertEquals(out.topics, ["uncategorized"]);
});

Deno.test("coerceMetadata: missing topics -> ['uncategorized']", () => {
  const out = coerceMetadata({}, new Set(), "any");
  assertEquals(out.topics, ["uncategorized"]);
});

Deno.test("coerceMetadata: B5 recombine fires inside coerce", () => {
  const out = coerceMetadata(
    { topics: ["fitness", "training"] },
    new Set(["fitness-training"]),
    "About fitness-training stuff.",
  );
  assertEquals(out.topics, ["fitness-training"]);
});

Deno.test("coerceMetadata: priority pass-through with null default", () => {
  assertEquals(coerceMetadata({}, new Set(), "x").priority, null);
  assertEquals(coerceMetadata({ priority: "low" }, new Set(), "x").priority, "low");
  assertEquals(coerceMetadata({ priority: "bogus" }, new Set(), "x").priority, null);
});

Deno.test("coerceMetadata: people / action_items / dates pass-through arrays only", () => {
  const out = coerceMetadata(
    { people: "not an array", action_items: 42, dates_mentioned: null },
    new Set(),
    "x",
  );
  assertEquals(out.people, []);
  assertEquals(out.action_items, []);
  assertEquals(out.dates_mentioned, []);
});

function makeFakeSupabase(rows: Array<{ slug: string }>, error: unknown = null) {
  let calls = 0;
  const client = {
    from: (_table: string) => ({
      select: (_cols: string) => {
        calls += 1;
        return Promise.resolve({ data: error ? null : rows, error });
      },
    }),
  };
  return { client, calls: () => calls };
}

Deno.test("loadKnownSlugs: returns slugs from DB", async () => {
  _resetSlugCacheForTests();
  const fake = makeFakeSupabase([{ slug: "brain-bank" }, { slug: "sample-project" }]);
  const set = await loadKnownSlugs(fake.client);
  assertEquals(set.has("brain-bank"), true);
  assertEquals(set.has("sample-project"), true);
  assertEquals(set.size, 2);
});

Deno.test("loadKnownSlugs: caches within TTL", async () => {
  _resetSlugCacheForTests();
  const fake = makeFakeSupabase([{ slug: "brain-bank" }]);
  await loadKnownSlugs(fake.client, 300_000);
  await loadKnownSlugs(fake.client, 300_000);
  await loadKnownSlugs(fake.client, 300_000);
  assertEquals(fake.calls(), 1);
});

Deno.test("loadKnownSlugs: refreshes past TTL", async () => {
  _resetSlugCacheForTests();
  const fake = makeFakeSupabase([{ slug: "brain-bank" }]);
  await loadKnownSlugs(fake.client, 0);
  // Ensure the second call's now > loadedAt so TTL=0 actually expires.
  await new Promise((r) => setTimeout(r, 1));
  await loadKnownSlugs(fake.client, 0);
  assertEquals(fake.calls(), 2);
});

Deno.test("loadKnownSlugs: DB error returns last good cache", async () => {
  _resetSlugCacheForTests();
  const good = makeFakeSupabase([{ slug: "brain-bank" }]);
  await loadKnownSlugs(good.client, 0);
  await new Promise((r) => setTimeout(r, 1));
  const bad = makeFakeSupabase([], new Error("connection refused"));
  const set = await loadKnownSlugs(bad.client, 0);
  assertEquals(set.has("brain-bank"), true);
  assertEquals(set.size, 1);
});

Deno.test("loadKnownSlugs: DB error with no cache returns empty Set", async () => {
  _resetSlugCacheForTests();
  const bad = makeFakeSupabase([], new Error("boom"));
  const set = await loadKnownSlugs(bad.client);
  assertEquals(set.size, 0);
});
