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
} from "./metadata-validation.ts";
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
        if (table === "auto_resolve_decisions") {
          decisions.push(rows as Record<string, unknown>);
        } else if (Array.isArray(rows)) {
          inserted.push(...rows);
        } else {
          throw new Error(`unexpected single-row insert into ${table}`);
        }
        return Promise.resolve({ error: null });
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
