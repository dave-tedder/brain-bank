// Deno unit tests for the shared classification helpers.
// Run: deno test supabase/functions/_shared/metadata-validation.test.ts
import { assertEquals } from "jsr:@std/assert@1.0.19";
import {
  _resetRouteMapCacheForTests,
  _resetSlugCacheForTests,
  coerceMetadata,
  coerceType,
  isOperationCommandCapture,
  loadKnownSlugs,
  loadRouteMap,
  normalizeTopic,
  recombineHyphenated,
  extractOperatorLines,
  isDescriptiveType,
  isExcludedSource,
  datedHeaderIsFuture,
  isWorkReportCapture,
  routeProjectFromContent,
  shouldExtractActionItems,
  classifyFragmentItem,
  DANGLING_FINAL_TOKENS,
  hasPronounObject,
  isFragmentItem,
  normalizeItemPrefix,
} from "./metadata-validation.ts";
import { descriptionContentTokens } from "./quote-coverage.ts";
import { EMPTY_ITEM_MARKER } from "./fragment-gate.ts";
// Runtime-bound claims for the TS mutant sweep (Codex re-review 2, N1).
import { claim } from "../../../scripts/loop-closing/claim.ts";
import { extractAndStoreActionItems } from "./capture-pipeline.ts";

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

Deno.test("isOperationCommandCapture: suppresses brain-channel record commands", () => {
  assertEquals(
    isOperationCommandCapture(
      "New client Jane Doe, add project and appointment",
      "brain-channel",
    ),
    true,
  );
  assertEquals(
    isOperationCommandCapture(
      "New project Sam Smith - migration rollout",
      "brain-channel",
    ),
    true,
  );
  assertEquals(
    isOperationCommandCapture(
      "Add appointment Alex Johnson July 5 at 10am for consultation",
      "brain-channel",
    ),
    true,
  );
  assertEquals(
    isOperationCommandCapture(
      "Reschedule Taylor Morgan same times next week",
      "brain-channel",
    ),
    true,
  );
});

Deno.test("isOperationCommandCapture: normal todos still permit extraction", () => {
  assertEquals(
    isOperationCommandCapture(
      "Need to send the deployment report before Friday",
      "brain-channel",
    ),
    false,
  );
  assertEquals(
    isOperationCommandCapture(
      "Need to reschedule the planning review after tests pass",
      "brain-channel",
    ),
    false,
  );
});

Deno.test("isOperationCommandCapture: suppresses explicit-time reschedule commands", () => {
  assertEquals(
    isOperationCommandCapture(
      "Reschedule Taylor Morgan to Saturday May 23, 12pm-5pm",
      "brain-channel",
    ),
    true,
  );
  assertEquals(
    isOperationCommandCapture(
      "reschedule sam smith appointment from march 20 to this saturday 1:30pm-8pm",
      "brain-channel",
    ),
    true,
  );
});

Deno.test("isOperationCommandCapture: suppresses appointment-booking dictation", () => {
  // A booking dictation whose command sits in a later sentence, so the
  // ^-anchored record-command patterns miss it; the appointment noun paired
  // with a clock time is the booking signature.
  assertEquals(
    isOperationCommandCapture(
      "New project for Jane Doe: quarterly planning. " +
        "Add task, appointment: kickoff, on July 19 12pm-7pm",
      "brain-channel",
    ),
    true,
  );
  // Simpler booking phrasings.
  assertEquals(
    isOperationCommandCapture(
      "New appointment for Jane Doe on July 12 12pm-6pm",
      "brain-channel",
    ),
    true,
  );
  assertEquals(
    isOperationCommandCapture(
      "New appointment, Sam Smith, April 12 12 PM to 7 PM",
      "brain-channel",
    ),
    true,
  );
});

Deno.test("isOperationCommandCapture: booking suppression stays tight", () => {
  // No clock time -> not a booking dictation, real todo permits extraction.
  assertEquals(
    isOperationCommandCapture(
      "Follow up with Jane Doe about her appointment reference materials",
      "brain-channel",
    ),
    false,
  );
  // No booking verb reaching the appointment noun.
  assertEquals(
    isOperationCommandCapture(
      "Confirm the deposit cleared before her appointment at 2pm",
      "brain-channel",
    ),
    false,
  );
  // Booking dictation from a non-brain-channel source is untouched here.
  assertEquals(
    isOperationCommandCapture(
      "New appointment for Jane Doe on July 12 12pm-6pm",
      "slack",
    ),
    false,
  );
});

Deno.test("isOperationCommandCapture: only applies to brain-channel source", () => {
  assertEquals(
    isOperationCommandCapture(
      "New client Jane Doe, add project and appointment",
      "slack",
    ),
    false,
  );
  assertEquals(isOperationCommandCapture("New client Jane Doe"), false);
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

// ---------------------------------------------------------------------------
// Route map (Session 272): deterministic content-phrase → project routing
// for captures whose LLM-extracted project is null. Unique-match only.
// ---------------------------------------------------------------------------

function makeRouteMap(entries: Array<[string, string[]]>): Map<string, string[]> {
  return new Map(entries);
}

Deno.test("routeProjectFromContent: single phrase match routes", () => {
  const map = makeRouteMap([["jane-website", ["janedoe.com"]]]);
  assertEquals(
    routeProjectFromContent("Fixed the nav menu on janedoe.com today", map),
    "jane-website",
  );
});

Deno.test("routeProjectFromContent: case-insensitive match", () => {
  const map = makeRouteMap([["seo-agent", ["seo agent"]]]);
  assertEquals(
    routeProjectFromContent("Ran the SEO Agent weekly crawl", map),
    "seo-agent",
  );
});

Deno.test("routeProjectFromContent: no phrase match returns null", () => {
  const map = makeRouteMap([["jane-website", ["janedoe.com"]]]);
  assertEquals(
    routeProjectFromContent("Utility bill reminder for the shop", map),
    null,
  );
});

Deno.test("routeProjectFromContent: two distinct projects match returns null", () => {
  const map = makeRouteMap([
    ["jane-website", ["janedoe.com"]],
    ["studio-website", ["janedoestudio.com"]],
  ]);
  assertEquals(
    routeProjectFromContent(
      "Digest: updated janedoe.com and janedoestudio.com footers",
      map,
    ),
    null,
  );
});

Deno.test("routeProjectFromContent: multiple phrases for same project still route", () => {
  const map = makeRouteMap([
    ["family-bakery-website", [
      "doefamilybakery.com",
      "doe family bakery",
    ]],
  ]);
  assertEquals(
    routeProjectFromContent(
      "Doe Family Bakery homepage copy shipped to doefamilybakery.com",
      map,
    ),
    "family-bakery-website",
  );
});

Deno.test("routeProjectFromContent: empty and short phrases ignored", () => {
  const map = makeRouteMap([["jane-website", ["", "  ", "a"]]]);
  assertEquals(
    routeProjectFromContent("a note that contains the letter a", map),
    null,
  );
});

Deno.test("routeProjectFromContent: empty map returns null", () => {
  assertEquals(
    routeProjectFromContent("anything at all", new Map()),
    null,
  );
});

function makeFakeRouteSupabase(
  rows: Array<{ slug: string; route_phrases: string[] | null }>,
  error: unknown = null,
) {
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

Deno.test("loadRouteMap: returns slug→phrases map, skipping empty rows", async () => {
  _resetRouteMapCacheForTests();
  const fake = makeFakeRouteSupabase([
    { slug: "jane-website", route_phrases: ["janedoe.com"] },
    { slug: "brain-bank", route_phrases: [] },
    { slug: "seo", route_phrases: null },
  ]);
  const map = await loadRouteMap(fake.client);
  assertEquals(map.get("jane-website"), ["janedoe.com"]);
  assertEquals(map.has("brain-bank"), false);
  assertEquals(map.has("seo"), false);
  assertEquals(map.size, 1);
});

Deno.test("loadRouteMap: caches within TTL", async () => {
  _resetRouteMapCacheForTests();
  const fake = makeFakeRouteSupabase([
    { slug: "jane-website", route_phrases: ["janedoe.com"] },
  ]);
  await loadRouteMap(fake.client, 300_000);
  await loadRouteMap(fake.client, 300_000);
  assertEquals(fake.calls(), 1);
});

Deno.test("loadRouteMap: DB error returns last good cache", async () => {
  _resetRouteMapCacheForTests();
  const good = makeFakeRouteSupabase([
    { slug: "jane-website", route_phrases: ["janedoe.com"] },
  ]);
  await loadRouteMap(good.client, 0);
  await new Promise((r) => setTimeout(r, 1));
  const bad = makeFakeRouteSupabase([], new Error("connection refused"));
  const map = await loadRouteMap(bad.client, 0);
  assertEquals(map.get("jane-website"), ["janedoe.com"]);
});

Deno.test("loadRouteMap: DB error with no cache returns empty map", async () => {
  _resetRouteMapCacheForTests();
  const bad = makeFakeRouteSupabase([], new Error("boom"));
  const map = await loadRouteMap(bad.client);
  assertEquals(map.size, 0);
});

// --- Loop-closing Task 1.2: work-report extraction gate ---------------------
//
// A session close-out ("work report") used to feed every LLM-extracted
// imperative into action_items. Now a work report stores ONLY its line-anchored
// `FOR OPERATOR:` lines. The marker overrides the descriptive-type gate and nothing
// else: mechanical prefixes, operation commands, task-intake captures and
// gmail/email sources never store items, marker or not.

// CRM Session 80 style capture: a session number, a commit hash and a
// trailing "Next:" clause (the shape that manufactured the junk).
const SESSION_80_REPORT =
  "CRM Session 80: departure-notice window spec written and committed " +
  "(commit 4f1c2a9b). Tracker updated. Next: The operator runs both deploys.";

const SESSION_80_WITH_MARKER = SESSION_80_REPORT +
  "\nFOR OPERATOR: send Sam the sign-in link by 2026-11-05";

type FakeRow = { source_thought_id: string; description: string; status: string };

// Minimal supabase-js stand-in for extractAndStoreActionItems: one select of
// open descriptions, and inserts recorded per table (action_items rows, and
// the auto_resolve_decisions rows the work-report gate writes, Task 1.4).
function makeFakeActionItemDb(existingOpen: string[] = []) {
  const inserted: FakeRow[] = [];
  const decisions: Array<Record<string, unknown>> = [];
  const db = {
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) =>
          Promise.resolve({
            data: existingOpen.map((description) => ({ description })),
            error: null,
          }),
      }),
      insert: (rows: FakeRow[] | Record<string, unknown>) => {
        let returned: Array<{ id: string; description: string }> = [];
        if (table === "auto_resolve_decisions") {
          decisions.push(rows as Record<string, unknown>);
        } else if (Array.isArray(rows)) {
          inserted.push(...rows);
          // Task 5.1: the action_items insert asks for the new ids back
          // (.select("id, description")) for the pronoun-suspect rows.
          returned = rows.map((r, i) => ({
            id: `f0000000-0000-4000-8000-${String(inserted.length - rows.length + i).padStart(12, "0")}`,
            description: r.description,
          }));
        } else {
          throw new Error(`unexpected single-row insert into ${table}`);
        }
        return Object.assign(Promise.resolve({ error: null }), {
          select: (_cols: string) => Promise.resolve({ data: returned, error: null }),
        });
      },
    }),
  };
  return { db, inserted, decisions };
}

const isMechanicalForTest = (content: string) =>
  content.trimStart().startsWith("[Calendar Sync]");

Deno.test("isWorkReportCapture: Session 80 style capture is a work report with no FOR OPERATOR lines", () => {
  assertEquals(isWorkReportCapture(SESSION_80_REPORT), true);
  assertEquals(extractOperatorLines(SESSION_80_REPORT), []);
});

Deno.test("extractOperatorLines: a trailing FOR OPERATOR line is returned verbatim", () => {
  assertEquals(isWorkReportCapture(SESSION_80_WITH_MARKER), true);
  assertEquals(extractOperatorLines(SESSION_80_WITH_MARKER), [
    "send Sam the sign-in link by 2026-11-05",
  ]);
});

Deno.test("work-report gate: observation-typed work report still stores its FOR OPERATOR line (marker overrides the type gate only)", async () => {
  const { db, inserted, decisions } = makeFakeActionItemDb();
  await extractAndStoreActionItems(
    db,
    "thought-1",
    {
      type: "observation",
      source: "mcp",
      action_items: ["The operator runs both deploys", "Update the tracker"],
    },
    SESSION_80_WITH_MARKER,
    isMechanicalForTest,
  );
  assertEquals(inserted.map((r) => r.description), [
    "send Sam the sign-in link by 2026-11-05",
  ]);
  assertEquals(inserted[0].source_thought_id, "thought-1");
  assertEquals(inserted[0].status, "open");
  // Task 1.4: one gate decision row per replaced item, so the suppressed
  // text is auditable after the fact.
  assertEquals(decisions.length, 2);
  assertEquals(
    decisions.map((d) => [d.layer, d.outcome, d.reason, d.candidate_description, d.thought_id, d.item_id]),
    [
      ["gate", "dropped", "work_report", "The operator runs both deploys", "thought-1", null],
      ["gate", "dropped", "work_report", "Update the tracker", "thought-1", null],
    ],
  );
});

Deno.test("isWorkReportCapture: a dated close-out header alone is a work report (the operator, 2026-11-05)", () => {
  assertEquals(
    isWorkReportCapture(
      "CRM Session 86 (2026-11-02): migration 064 (probe_email_queue_insert) is applied to the live and demo databases, and both read back correct. Next: The operator reviews the queue.",
    ),
    true,
  );
  // A board task reference plus a session number is a work report too.
  assertEquals(
    isWorkReportCapture(
      "Open Engine task c1d1fb2b completed in Session 331: page 1531 copy replaced.",
    ),
    true,
  );
  // A session number with no date and no second shape is still one shape.
  assertEquals(
    isWorkReportCapture(
      "Session 3 with Jordan needs the koi stencil printed before he arrives",
    ),
    false,
  );
});

Deno.test("isWorkReportCapture: a plain client note is not a work report", () => {
  assertEquals(
    isWorkReportCapture(
      "Jordan Lee wants to resume the kitchen remodel after his wedding",
    ),
    false,
  );
});

Deno.test("isWorkReportCapture: one shape alone (a lone commit hash) is not a work report", () => {
  assertEquals(
    isWorkReportCapture(
      "Need to revert commit 4f1c2a9b before the client demo on Friday",
    ),
    false,
  );
});

// --- Codex review of PR 16 (2026-11-05): the dated header on its own --------
//
// Shape 8 (dated session header) implies shape 1 (session N), so a lone
// "session 2 (2026-11-12)" in a client note reached two shapes by itself and
// the note lost its action items. A close-out header is dated the day the
// session closed (0 of 683 production dated-session captures in the prior 90
// days carried a later date), so a header dated after the capture day does not
// count. The capture time is passed explicitly here; production uses now().

const CAPTURED_AT = new Date("2026-11-05T14:00:00Z");

Deno.test("isWorkReportCapture: Codex example, a client note with a future-dated session is NOT a work report", () => {
  assertEquals(
    isWorkReportCapture(
      "Jordan Lee remodel session 2 (2026-11-12): send Jordan the revised floor plan by 2026-11-10.",
      CAPTURED_AT,
    ),
    false,
  );
});

Deno.test("isWorkReportCapture: a header dated the capture day, or the day after (UTC slack), still counts", () => {
  assertEquals(
    isWorkReportCapture("CRM Session 86 (2026-11-05): migration applied.", CAPTURED_AT),
    true,
  );
  assertEquals(
    isWorkReportCapture("CRM Session 86 (2026-11-06): migration applied.", CAPTURED_AT),
    true,
  );
  assertEquals(
    isWorkReportCapture("CRM Session 86 (2026-11-07): migration applied.", CAPTURED_AT),
    false,
  );
  // An impossible date is not a close-out date.
  assertEquals(
    isWorkReportCapture("CRM Session 86 (2026-13-45): migration applied.", CAPTURED_AT),
    false,
  );
});

// Codex second pass (2026-11-05): the 2026-13-45 fixture above only passed
// because Date.UTC normalized it into the future. A mistyped date that
// normalizes to BEFORE the cutoff (February 30 to March 2, month 00 to the
// prior December, day 00 to the prior month's last day, a non-leap
// February 29) must not count either, or a client note loses its items.
Deno.test("datedHeaderIsFuture: a date that Date.UTC would normalize is not a real date", () => {
  for (const bad of ["2026-02-30", "2026-00-12", "2026-11-00", "2025-02-29", "2026-04-31"]) {
    assertEquals(datedHeaderIsFuture(`Session 2 (${bad})`, CAPTURED_AT), true, bad);
  }
  // Real past dates, including a real leap day, still count.
  for (const good of ["2024-02-29", "2026-11-05", "2026-01-31", "0100-01-31"]) {
    assertEquals(datedHeaderIsFuture(`Session 2 (${good})`, CAPTURED_AT), false, good);
  }
  // Documented range starts at 0100: Date.UTC reads years 0 to 99 as 1900 to
  // 1999, so a first-century date fails the round trip and does not count
  // (Codex third pass, 2026-11-05). Not a close-out date anyone writes.
  assertEquals(datedHeaderIsFuture("Session 2 (0099-01-31)", CAPTURED_AT), true);
});

Deno.test("isWorkReportCapture: a lone mistyped-date session header does not reach two shapes", () => {
  for (const bad of ["2026-02-30", "2026-00-12", "2025-02-29"]) {
    assertEquals(
      isWorkReportCapture(`Client session 2 (${bad}): send the revised drawing.`, CAPTURED_AT),
      false,
      bad,
    );
  }
});

Deno.test("isWorkReportCapture: a future-dated header does not block a capture that has two other shapes", () => {
  assertEquals(
    isWorkReportCapture(
      "CRM Session 86 (2026-11-20 target) handoff written, commit 4f1c2a9b.",
      CAPTURED_AT,
    ),
    true,
  );
});

Deno.test("isWorkReportCapture: KNOWN RESIDUAL, a client note with a past-dated session still trips the pair", () => {
  // Not desired behaviour. Lexically this is the close-out header form
  // ("<name> session N (date): ..."); no such client note exists in 90 days of
  // production, and when one lands the gate writes an auditable
  // gate/dropped/work_report decision row per suppressed item, which is the
  // recovery path. Recorded so a change in either direction is deliberate.
  assertEquals(
    isWorkReportCapture(
      "Jordan Lee remodel session 2 (2026-11-01): send Jordan the revised floor plan by 2026-11-10.",
      CAPTURED_AT,
    ),
    true,
  );
});

Deno.test("work-report gate: Codex example 1 end to end, the client note keeps its extracted action item and writes no gate row", async () => {
  // Production passes now() as the capture time, so the appointment date is
  // built relative to the clock to keep this fixture from going stale.
  const inSevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const note =
    `Jordan Lee remodel session 2 (${inSevenDays}): send Jordan the revised floor plan by ${inSevenDays}.`;
  const { db, inserted, decisions } = makeFakeActionItemDb();
  await extractAndStoreActionItems(
    db,
    "thought-jake",
    { type: "task", source: "mcp", action_items: ["Send Jordan the revised floor plan"] },
    note,
    isMechanicalForTest,
  );
  assertEquals(inserted.map((r) => r.description), ["Send Jordan the revised floor plan"]);
  assertEquals(decisions.length, 0);
});

Deno.test("isWorkReportCapture: Codex example 2, a board task id plus a deliverables path IS a work report (intended)", () => {
  // Both references are to agent-board work; a note about them routes its
  // operator step through a FOR OPERATOR line like any other work narrative.
  // 2 such captures in 90 days of production, both agent close-outs.
  assertEquals(
    isWorkReportCapture(
      "Board packet for task deadbeef: review deliverables/external-crm/intake-plan.md and send Sam the sign-in link by 2026-11-06.",
      CAPTURED_AT,
    ),
    true,
  );
});

Deno.test("work-report gate: a [Calendar Sync] capture carrying FOR OPERATOR stores nothing", async () => {
  const { db, inserted, decisions } = makeFakeActionItemDb();
  await extractAndStoreActionItems(
    db,
    "thought-2",
    { type: "task", source: "calendar", action_items: ["call Jordan"] },
    "[Calendar Sync] Session 80 handoff\nFOR OPERATOR: call Jordan about the kitchen remodel",
    isMechanicalForTest,
  );
  assertEquals(inserted.length, 0);
  assertEquals(decisions.length, 0);
});

Deno.test("work-report gate: a task_intake capture carrying FOR OPERATOR stores nothing", async () => {
  const { db, inserted } = makeFakeActionItemDb();
  await extractAndStoreActionItems(
    db,
    "thought-3",
    { type: "task", source: "slack", task_intake: true, action_items: ["x"] },
    SESSION_80_WITH_MARKER,
    isMechanicalForTest,
  );
  assertEquals(inserted.length, 0);
});

Deno.test("work-report gate: a gmail-sourced capture carrying FOR OPERATOR stores nothing", async () => {
  const { db, inserted } = makeFakeActionItemDb();
  await extractAndStoreActionItems(
    db,
    "thought-4",
    { type: "task", source: "gmail", action_items: ["x"] },
    SESSION_80_WITH_MARKER,
    isMechanicalForTest,
  );
  assertEquals(inserted.length, 0);
});

Deno.test("isExcludedSource / isDescriptiveType: the split preserves shouldExtractActionItems", () => {
  assertEquals(isExcludedSource({ task_intake: true }), true);
  assertEquals(isExcludedSource({ source: "gmail" }), true);
  assertEquals(isExcludedSource({ source: "EMAIL" }), true);
  assertEquals(isExcludedSource({ type: "observation", source: "slack" }), false);
  assertEquals(isDescriptiveType({ type: "observation" }), true);
  assertEquals(isDescriptiveType({ type: "Reference" }), true);
  assertEquals(isDescriptiveType({ type: "task" }), false);
  for (
    const m of [
      { type: "task", source: "slack" },
      { type: "observation", source: "slack" },
      { type: "task", source: "gmail" },
      { task_intake: true, type: "task" },
      {},
    ]
  ) {
    assertEquals(
      shouldExtractActionItems(m),
      !isExcludedSource(m) && !isDescriptiveType(m),
    );
  }
});

Deno.test("extractOperatorLines: a profile-configured marker replaces the default", () => {
  const content = "Session 12 handoff (commit 4f1c2a9b).\nFOR ALEX: renew the domain\nFOR OPERATOR: not this one";
  assertEquals(extractOperatorLines(content, "FOR ALEX"), ["renew the domain"]);
  assertEquals(extractOperatorLines(content, "FOR OPERATOR"), ["not this one"]);
  // Regex metacharacters in a marker are literal, and the match is case-sensitive.
  assertEquals(extractOperatorLines("TODO(me): ship it\ntodo(me): prose", "TODO(me)"), ["ship it"]);
  assertEquals(extractOperatorLines("for alex: prose, not a marker", "FOR ALEX"), []);
});


// ---------------------------------------------------------------------------
// Loop-closing Task 5.1: the fragment gate. The plan's own cases first, each
// named for the case; then the rule edges; then the gate end to end through the
// shared extractAndStoreActionItems (fake db above).
// ---------------------------------------------------------------------------

Deno.test("fragment gate 5.1: deploy, switch on and then deploy drop with reason one_token", () => {
  for (const d of ["deploy", "switch on", "then deploy"]) {
    claim("rule-a-one-token", classifyFragmentItem(d).drop, "one_token", d);
    assertEquals(isFragmentItem(d), true, d);
  }
});

Deno.test("fragment gate 5.1: finalize what we're drops with reason dangling_clause and NOT one_token", () => {
  // Rule (a) alone keeps it: two content tokens survive the stoplist. Rule (b)
  // is what drops it.
  assertEquals(descriptionContentTokens("finalize what we're"), ["finalize", "what"]);
  const v = classifyFragmentItem("finalize what we're");
  claim("rule-b-dangling", v.drop, "dangling_clause");
  assertEquals(v.pronounObject, false);
});

Deno.test("fragment gate 5.1: Awaiting the operator to apply migration 063 keeps, normalized to the operator to apply migration 063", () => {
  const v = classifyFragmentItem("Awaiting the operator to apply migration 063");
  claim("prefix-normalized", v, { normalized: "the operator to apply migration 063", drop: null, pronounObject: false });
});

Deno.test("fragment gate 5.1: send Sam the explainer PDF keeps (ends in a content word), no suspect", () => {
  assertEquals(classifyFragmentItem("send Sam the explainer PDF"), {
    normalized: "send Sam the explainer PDF", drop: null, pronounObject: false,
  });
});

Deno.test("fragment gate 5.1: send her the explainer PDF keeps as a pronoun_object suspect", () => {
  claim("pronoun-suspect", classifyFragmentItem("send her the explainer PDF"), {
    normalized: "send her the explainer PDF", drop: null, pronounObject: true,
  });
});

Deno.test("fragment gate 5.1: nudge Jordan if nothing arrives keeps, no suspect", () => {
  assertEquals(classifyFragmentItem("nudge Jordan if nothing arrives"), {
    normalized: "nudge Jordan if nothing arrives", drop: null, pronounObject: false,
  });
});

Deno.test("fragment gate 5.1: normalizeItemPrefix strips each prefix in any case, repeatedly, and nothing else", () => {
  const cases: Array<[string, string]> = [
    ["then send Jordan the koi sketch", "send Jordan the koi sketch"],
    ["Then, send Jordan the koi sketch", "send Jordan the koi sketch"],
    ["next: send Jordan the koi sketch", "send Jordan the koi sketch"],
    ["NEXT:send Jordan the koi sketch", "send Jordan the koi sketch"],
    ["waiting on Jordan to send the deposit", "Jordan to send the deposit"],
    ["Waiting   on Jordan to send the deposit", "Jordan to send the deposit"],
    ["awaiting Jordan's deposit", "Jordan's deposit"],
    ["TODO: send Jordan the koi sketch", "send Jordan the koi sketch"],
    ["todo:send Jordan the koi sketch", "send Jordan the koi sketch"],
    ["TODO: then next: send Jordan the koi sketch", "send Jordan the koi sketch"],
    ["  then  ", ""],
    // Not prefixes: inside a word, without the colon, or not at the start.
    ["thence to the shop", "thence to the shop"],
    ["next week send Jordan the sketch", "next week send Jordan the sketch"],
    ["TODO send Jordan the sketch", "TODO send Jordan the sketch"],
    ["send Jordan the sketch then call", "send Jordan the sketch then call"],
    ["waitingon nothing", "waitingon nothing"],
  ];
  for (const [input, want] of cases) assertEquals(normalizeItemPrefix(input), want, input);
});

Deno.test("fragment gate 5.1: a prefix is normalized, never a reason to drop", () => {
  for (const p of ["then ", "next: ", "waiting on ", "awaiting ", "TODO: "]) {
    claim("prefix-never-drops", classifyFragmentItem(`${p}send Sam the explainer PDF`).drop, null, p);
  }
  // "next:" is not on the stoplist, so without normalization "next: deploy"
  // would keep two content tokens; normalized, it is one.
  assertEquals(classifyFragmentItem("next: deploy").drop, "one_token");
});

Deno.test("fragment gate 5.1: rule (a) counts distinct content tokens after the Task 1.3 stoplist", () => {
  assertEquals(classifyFragmentItem("").drop, "one_token");
  assertEquals(classifyFragmentItem("   ").drop, "one_token");
  assertEquals(classifyFragmentItem("fix it").drop, "one_token"); // both stoplisted
  assertEquals(classifyFragmentItem("invoice invoice").drop, "one_token"); // one distinct token
  claim("rule-a-stoplist", classifyFragmentItem("The operator should run the deploy").drop, "one_token");
  assertEquals(classifyFragmentItem("invoice Jordan").drop, null); // two content tokens
});

Deno.test("fragment gate 5.1: rule (b) drops on every listed final word and only when it is final", () => {
  assertEquals(DANGLING_FINAL_TOKENS.size, 20);
  for (const w of DANGLING_FINAL_TOKENS) {
    assertEquals(classifyFragmentItem(`send Sam the koi brochure ${w}`).drop, "dangling_clause", w);
    // The same word inside the item does not drop it.
    assertEquals(classifyFragmentItem(`send Sam ${w} koi brochure`).drop, null, `${w} mid-item`);
  }
  // Raw final token: case folded, trailing punctuation trimmed, curly
  // apostrophe folded to a straight one, apostrophe kept.
  assertEquals(classifyFragmentItem("Finalize what WE'RE.").drop, "dangling_clause");
  assertEquals(classifyFragmentItem("finalize what we’re").drop, "dangling_clause");
  assertEquals(classifyFragmentItem("ask Jordan what we're doing about it's").drop, "dangling_clause");
  // A word that merely starts like a listed one is not listed.
  assertEquals(classifyFragmentItem("send Sam the theme").drop, null);
  assertEquals(classifyFragmentItem("ask Jordan about isles").drop, null);
});

Deno.test("fragment gate 5.1: rule (a) is checked first, so an item both rules match records one_token", () => {
  assertEquals(classifyFragmentItem("deploy the").drop, "one_token");
  assertEquals(classifyFragmentItem("then deploy to").drop, "one_token");
});

Deno.test("fragment gate 5.1: pronoun objects her, him and it anywhere; this and that only as an object", () => {
  const yes = [
    "send her the explainer PDF",
    "follow up with him about the deposit",
    "send it to Sam by Friday",
    "pull her file before the session",
    "send this to Jordan",
    "finish that up tomorrow",
    "hand Sam this",
  ];
  const no = [
    "send Sam the explainer PDF",
    "check this week's koi post",
    "confirm that the migration ran",
    "check if it's live on the site",
    "send Sam the koi brochure",
  ];
  for (const d of yes) assertEquals(hasPronounObject(normalizeItemPrefix(d)), true, d);
  for (const d of no) assertEquals(hasPronounObject(normalizeItemPrefix(d)), false, d);
  // A dropped item is never also a suspect.
  assertEquals(classifyFragmentItem("send it").pronounObject, false);
});

const FRAG_THOUGHT = "4a51f000-0000-4000-8000-000000000001";
const PLAN_ITEMS = [
  "deploy",
  "switch on",
  "then deploy",
  "finalize what we're",
  "Awaiting the operator to apply migration 063",
  "send Sam the explainer PDF",
  "send her the explainer PDF",
  "nudge Jordan if nothing arrives",
];
const TASK_META = (items: string[]) => ({ type: "task", source: "slack", action_items: items });

Deno.test("fragment gate 5.1, shared capture path: the plan's eight items store four, drop four with their reasons, and record one suspect", async () => {
  const { db, inserted, decisions } = makeFakeActionItemDb();
  await extractAndStoreActionItems(db, FRAG_THOUGHT, TASK_META(PLAN_ITEMS), "a note with eight items", isMechanicalForTest);
  // The stored description is the original text, prefix included.
  claim("e2e-stored", inserted.map((r) => r.description), [
    "Awaiting the operator to apply migration 063",
    "send Sam the explainer PDF",
    "send her the explainer PDF",
    "nudge Jordan if nothing arrives",
  ]);
  const drops = decisions.filter((d) => d.outcome === "dropped");
  claim("e2e-drops", drops.map((d) => [d.candidate_description, d.reason]), [
    ["deploy", "one_token"],
    ["switch on", "one_token"],
    ["then deploy", "one_token"],
    ["finalize what we're", "dangling_clause"],
  ]);
  for (const d of drops) {
    assertEquals(d.layer, "fragment");
    assertEquals(d.item_id, null);
    assertEquals(d.thought_id, FRAG_THOUGHT);
    assertEquals([d.evidence_thought_id, d.evidence_event_id, d.related_item_id, d.quote, d.score], [null, null, null, null, null]);
  }
  const suspects = decisions.filter((d) => d.outcome === "proposed");
  // The fake returns ids in insert order; "send her..." is the third row.
  claim("e2e-suspect", suspects, [{
    layer: "fragment", outcome: "proposed", reason: "pronoun_object",
    candidate_description: "send her the explainer PDF",
    item_id: "f0000000-0000-4000-8000-000000000002", thought_id: FRAG_THOUGHT,
    evidence_thought_id: null, evidence_event_id: null, related_item_id: null, quote: null, score: null,
  }]);
  assertEquals(decisions.length, 5);
});

Deno.test("fragment gate 5.1, shared capture path: runs after the appointment guard and before the open-item dedup", async () => {
  // An unanchored appointment item that is ALSO a fragment is the appointment
  // guard's: skipped there, so no fragment row. A fragment that duplicates an
  // open item still gets its fragment row: the gate runs before the dedup.
  const { db, inserted, decisions } = makeFakeActionItemDb(["switch on"]);
  await extractAndStoreActionItems(
    db, FRAG_THOUGHT,
    TASK_META(["Schedule dental appointment for the", "switch on", "send Sam the explainer PDF"]),
    "a note", isMechanicalForTest,
  );
  assertEquals(inserted.map((r) => r.description), ["send Sam the explainer PDF"]);
  claim("gate-before-dedup", decisions.map((d) => [d.layer, d.outcome, d.reason, d.candidate_description]), [
    ["fragment", "dropped", "one_token", "switch on"],
  ]);
});

Deno.test("fragment gate 5.1, shared capture path: FOR OPERATOR lines of a work report pass through the same gate", async () => {
  const { db, inserted, decisions } = makeFakeActionItemDb();
  const report = "CRM Session 80 (2026-10-29): spec committed (commit 4f1c2a9b).\nFOR OPERATOR: deploy\nFOR OPERATOR: send Sam the sign-in link";
  await extractAndStoreActionItems(db, FRAG_THOUGHT, TASK_META(["Update the tracker"]), report, isMechanicalForTest);
  assertEquals(inserted.map((r) => r.description), ["send Sam the sign-in link"]);
  assertEquals(decisions.map((d) => [d.layer, d.reason, d.candidate_description]), [
    ["gate", "work_report", "Update the tracker"],
    ["fragment", "one_token", "deploy"],
  ]);
});

Deno.test("fragment gate 5.1, shared capture path: an empty extracted item is dropped and its row carries the marker", async () => {
  const { db, inserted, decisions } = makeFakeActionItemDb();
  await extractAndStoreActionItems(db, FRAG_THOUGHT, TASK_META(["  ", "send Sam the explainer PDF"]), "a note", isMechanicalForTest);
  assertEquals(inserted.map((r) => r.description), ["send Sam the explainer PDF"]);
  assertEquals(decisions.map((d) => [d.reason, d.candidate_description]), [["one_token", EMPTY_ITEM_MARKER]]);
});

Deno.test("fragment gate 5.1, shared capture path: a failed action_items insert writes no suspect row", async () => {
  const decisions: Array<Record<string, unknown>> = [];
  const db = {
    from: (table: string) => ({
      select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
      insert: (rows: unknown) => {
        if (table === "auto_resolve_decisions") decisions.push(rows as Record<string, unknown>);
        const answer = table === "action_items"
          ? { data: null, error: { message: "insert refused" } }
          : { error: null };
        return Object.assign(Promise.resolve(answer), { select: () => Promise.resolve(answer) });
      },
    }),
  };
  await extractAndStoreActionItems(db, FRAG_THOUGHT, TASK_META(["send her the explainer PDF", "deploy"]), "a note", isMechanicalForTest);
  assertEquals(decisions.map((d) => [d.outcome, d.reason]), [["dropped", "one_token"]]);
});

Deno.test("fragment gate 5.1, shared capture path: a failed decision write never un-drops an item", async () => {
  const inserted: unknown[] = [];
  const db = {
    from: (table: string) => ({
      select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
      insert: (rows: unknown) => {
        if (table === "auto_resolve_decisions") return Object.assign(Promise.resolve({ error: { message: "down" } }), {});
        inserted.push(...(rows as unknown[]));
        return Object.assign(Promise.resolve({ error: null }), {
          select: () => Promise.resolve({ data: (rows as Array<{ description: string }>).map((r, i) => ({ id: `id-${i}`, description: r.description })), error: null }),
        });
      },
    }),
  };
  await extractAndStoreActionItems(db, FRAG_THOUGHT, TASK_META(["deploy", "send her the explainer PDF"]), "a note", isMechanicalForTest);
  assertEquals((inserted as Array<{ description: string }>).map((r) => r.description), ["send her the explainer PDF"]);
});

Deno.test("fragment gate 5.1: known cost of rule (a) as the plan wrote it: a generic verb plus one object word drops", () => {
  // The Task 1.3 stoplist holds generic verbs (fix, update, deploy, check, add,
  // make, run, apply), so an item that is one of them plus a single object word
  // has one content token and drops. Pinned here so a change to this behavior
  // is a decision, not a drift; the packet lists it for the operator, and every such
  // drop is a fragment row the monthly hand read can see.
  for (const d of ["Fix the website", "Update the tracker", "Deploy the dashboard fix", "check email"]) {
    assertEquals(classifyFragmentItem(d).drop, "one_token", d);
  }
  // Two object words, or a named person, keep it.
  for (const d of ["Fix the website menu", "Call Jordan", "Pay rent", "email Sam the invoice"]) {
    assertEquals(classifyFragmentItem(d).drop, null, d);
  }
});
