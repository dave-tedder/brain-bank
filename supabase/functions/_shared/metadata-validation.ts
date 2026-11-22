// supabase/functions/_shared/metadata-validation.ts
//
// Shared classification helpers used by ingest-thought and open-brain-mcp.
// Pure functions are unit-tested in metadata-validation.test.ts.
// loadKnownSlugs is a module-level TTL cache verified live post-deploy.
//
// Audit findings addressed:
//   B1 topic normalization (normalizeTopic)
//   B2 action-item extraction gate (shouldExtractActionItems)
//   B3 project enum coercion (loadKnownSlugs + coerceMetadata)
//   B4 type validation (coerceType)
//   B5 hyphen-recombine (recombineHyphenated)
import { loadProfile } from "./profile.ts";

export const VALID_TYPES = [
  "observation",
  "task",
  "idea",
  "reference",
  "person_note",
] as const;

export type ValidType = (typeof VALID_TYPES)[number];

export type RawMetadata = Record<string, unknown>;

export type CoercedMetadata = {
  people: string[];
  action_items: string[];
  dates_mentioned: string[];
  topics: string[];
  type: ValidType;
  project: string | null;
  priority: "high" | "low" | "normal" | null;
};

// Minimal structural type so tests can inject a fake supabase without
// pulling in the full @supabase/supabase-js type surface.
// `select()` returns PromiseLike (not Promise) so both Promise-returning
// test mocks and supabase-js's thenable PostgrestFilterBuilder satisfy it.
// deno-lint-ignore no-explicit-any
export type SupabaseLike<Row = any> = {
  from: (table: string) => {
    select: (cols: string) => PromiseLike<{ data: Row[] | null; error: unknown }>;
  };
};

// B1: normalize a raw topic string to a slug-shaped form.
// Lowercase, collapse spaces / underscores / punctuation to '-',
// collapse runs of '-', trim leading/trailing '-'.
// Deliberately NOT singularized (`process` would become `proces`).
export function normalizeTopic(raw: unknown): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// B4: coerce an arbitrary LLM-emitted `type` value to one of VALID_TYPES.
// Case-insensitive. Hallucinated values default to 'observation' (the
// most conservative choice for the downstream B2 action-item gate).
export function coerceType(raw: unknown): ValidType {
  const candidate = String(raw ?? "").toLowerCase();
  return (VALID_TYPES as readonly string[]).includes(candidate)
    ? (candidate as ValidType)
    : "observation";
}

// B2: gate action-item storage on metadata type + source.
// Observations and references are descriptive, not commitment-shaped.
// Gmail- / email-sourced captures are advisory marketing copy.
// Fail OPEN on missing/malformed metadata so real task captures
// don't get silently swallowed if shape is unexpected.
export function shouldExtractActionItems(metadata: RawMetadata): boolean {
  return !isExcludedSource(metadata) && !isDescriptiveType(metadata);
}

// Loop-closing Task 1.2 split the B2 gate in two so the work-report marker can
// override exactly one of its exclusions (the descriptive type) and never the
// other two. Order inside extractAndStoreActionItems: mechanical prefix,
// operation command, isExcludedSource, then operator-marker lines, then
// isDescriptiveType for everything else.
export function isExcludedSource(metadata: RawMetadata): boolean {
  // Slack task-intake captures become Standing agent-task drafts (OE-6);
  // extracting action items from them too would double-track the same work.
  if (metadata?.task_intake === true) return true;
  const source = String(metadata?.source ?? "").toLowerCase();
  return source === "gmail" || source === "email";
}

export function isDescriptiveType(metadata: RawMetadata): boolean {
  const type = String(metadata?.type ?? "").toLowerCase();
  return type === "observation" || type === "reference";
}

// Loop-closing Task 1.2 (A1 part 2). A "work report" is a session close-out,
// handoff or tracker/deliverable note. Its LLM-extracted imperatives are the
// single largest source of junk action items (287 of 368 recent items were
// work-report born; 22 still open, a handful real), so a work report stores
// ONLY its explicit operator-marker lines (`FOR OPERATOR:` by default; see
// workReportMarker). Two shapes are required, not one, so a
// real to-do that happens to mention a commit once is not swallowed.
//
// Mirror rule: scripts/loop-closing/work-report-backtest.mjs carries a Node
// port of WORK_REPORT_SHAPES for the read-only production backtest. Change
// both or the backtest measures a different classifier.
export const WORK_REPORT_SHAPES: readonly RegExp[] = [
  /\bsession \d+\b/i,
  /\bhandoff\b/i,
  // A git hash preceded by "commit" or wrapped in parentheses.
  /(?:\bcommit\s+[0-9a-f]{7,40}\b|\([0-9a-f]{7,40}\))/i,
  /\b(?:PROJECT-TRACKER\.md|SESSION-LOG\.md)\b/,
  /\bdeliverables\/[\w./-]+\.\w+/,
  /\[OE:[0-9a-f]{8}/,
  /\b(?:closed|paused|built|deployed|shipped) (?:2026|2027)-\d\d-\d\d\b/i,
  // Two shapes added on the operator's call 2026-11-05 after the production backtest:
  // the plan's seven recalled 78 of 293 work-report items (27%) because 54 of
  // 109 work-report thoughts carry only the dated close-out header
  // ("CRM Session 86 (2026-11-02): ..."). With these two, 221 of 293
  // (75%) with zero spillover into non-work-report items. The dated header
  // overlaps "session N" by construction, so a dated session header alone
  // counts as two shapes: that overlap IS the signal. It is also the one
  // place an ordinary note can trip the gate by itself (Codex review of PR
  // 16, 2026-11-05: "Jordan Lee remodel session 2 (2026-11-12): send Jordan
  // the revised floor plan"), so the header counts only when its date is
  // not after the capture day; see isWorkReportCapture.
  /\bsession \d+\b[^\n]{0,24}?\b\d{4}-\d\d-\d\d\b/i,
  /\btask [0-9a-f]{8}\b/i,
];

export const WORK_REPORT_MIN_SHAPES = 2;

// Index of the dated close-out header in WORK_REPORT_SHAPES.
export const WORK_REPORT_DATED_HEADER_INDEX = 7;
// A close-out header is dated the day the session closed: 0 of the 683 dated
// session captures in the 90 days before 2026-11-05 carried a date after their
// capture day. A header dated later than that is an appointment, not a
// report, and does not count toward the two shapes. One day of slack covers a
// session that closes after midnight UTC and dates itself the local day.
export const WORK_REPORT_FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

const ISO_DATE_RE = /\b(\d{4})-(\d\d)-(\d\d)\b/;

/** True when the dated session header's date is later than capturedAt plus
 * the slack, or is not a real calendar date (a mistyped date, which Date.UTC
 * would silently normalize, counts as not real). Supported years are 0100
 * to 9999: Date.UTC reads 0 to 99 as 1900 to 1999, so a first-century date
 * fails the round trip and is treated as not real, which keeps the capture's
 * items (Codex third pass, 2026-11-05). */
export function datedHeaderIsFuture(headerMatch: string, capturedAt: Date): boolean {
  const m = ISO_DATE_RE.exec(headerMatch);
  if (!m) return true;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  // Date.UTC normalizes out-of-range parts instead of failing (February 30
  // becomes March 2, month 00 becomes December of the year before), so a
  // mistyped date must round-trip to its own components to count as real
  // (Codex review of PR 16, 2026-11-05).
  if (Number.isNaN(t)) return true;
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return true;
  return t > capturedAt.getTime() + WORK_REPORT_FUTURE_SLACK_MS;
}

export function isWorkReportCapture(
  content: string,
  capturedAt: Date = new Date(),
): boolean {
  let hits = 0;
  WORK_REPORT_SHAPES.forEach((shape, i) => {
    if (i !== WORK_REPORT_DATED_HEADER_INDEX) {
      if (shape.test(content)) hits += 1;
      return;
    }
    // Every dated header in the content is checked; one dated on or before
    // the capture day is enough for the shape to count.
    const all = new RegExp(shape.source, shape.flags.includes("g") ? shape.flags : shape.flags + "g");
    for (const m of String(content ?? "").matchAll(all)) {
      if (!datedHeaderIsFuture(m[0], capturedAt)) { hits += 1; break; }
    }
  });
  return hits >= WORK_REPORT_MIN_SHAPES;
}

// The work-report marker comes from the profile (`work_report_marker`, for
// example "FOR ALEX"), defaulting to "FOR OPERATOR". It is matched
// case-sensitively, so ordinary prose ("for alex: ...") never trips it.
export const DEFAULT_WORK_REPORT_MARKER = "FOR OPERATOR";

export function workReportMarker(): string {
  const configured = loadProfile().work_report_marker;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : DEFAULT_WORK_REPORT_MARKER;
}

function operatorLineRe(marker: string): RegExp {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Line-anchored: the marker must open its line (leading whitespace allowed).
  // A marker buried mid-sentence is prose, not a marker.
  return new RegExp(`^\\s*${escaped}:\\s*(.+?)\\s*$`);
}

export function extractOperatorLines(
  content: string,
  marker: string = workReportMarker(),
): string[] {
  const out: string[] = [];
  const re = operatorLineRe(marker);
  for (const line of String(content ?? "").split(/\r?\n/)) {
    const m = re.exec(line);
    if (m && m[1]) out.push(m[1]);
  }
  return out;
}

const RESCHEDULE_DATE_HINT_RE =
  /\b(?:today|tomorrow|tonight|this\s+(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)|next\s+(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i;

const RESCHEDULE_TIME_HINT_RE =
  /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i;

function isRescheduleCommand(text: string): boolean {
  if (!/^reschedule\b/i.test(text)) return false;
  if (/\bsame\s+times?\b/i.test(text)) return true;
  return RESCHEDULE_DATE_HINT_RE.test(text) &&
    RESCHEDULE_TIME_HINT_RE.test(text);
}

// A booking dictation sent through an automation channel to create a calendar
// appointment (a downstream listener creates the real event). Shape: a
// create/add/book/new verb reaching an appointment noun within the same
// sentence, paired with a concrete clock time (the booking's start/end range).
// These are captures that spawn a real calendar entry, not deliverable todos -
// but the metadata extractor reads "add ... appointment" as an action item and
// triage then drafts a phantom "prep" task. The clock-time requirement keeps
// this tight: a real todo that merely mentions an appointment ("follow up about
// the appointment") carries no booking time and is untouched. The ^-anchored
// record-command patterns below miss it when the booking phrase is not the
// first sentence, and the appointment-guard treats a future date as a
// keep-signal, so this is the layer that catches it.
const APPOINTMENT_BOOKING_PHRASE_RE =
  /\b(?:new|add|book(?:ed|ing)?|create)\b[^.?!]*\b(?:appointment|appt)\b/i;

function isAppointmentBookingCapture(text: string): boolean {
  return APPOINTMENT_BOOKING_PHRASE_RE.test(text) &&
    RESCHEDULE_TIME_HINT_RE.test(text);
}

// Operation commands sent through automation channels tell downstream systems
// to create/update business records. They are captures, not operator todos.
// Keep this narrower than MECHANICAL_CAPTURE_PREFIXES so auto-resolve LAYER 0
// stays intact.
export function isOperationCommandCapture(
  content: string,
  source?: string,
): boolean {
  if (String(source ?? "").toLowerCase() !== "brain-channel") return false;

  const text = content.trim().replace(/\s+/g, " ");
  if (!text) return false;

  return isRescheduleCommand(text) || isAppointmentBookingCapture(text) || [
    /^new\s+client\b/i,
    /^new\s+project\b/i,
    /^add\s+appointment\b/i,
    /^add\s+project\b/i,
  ].some((pattern) => pattern.test(text));
}

// B3: cache the known projects.slug Set at module scope with a TTL.
// Lazy-loaded on first call past TTL. Falls back to last-good Set on
// transient DB error; cold-start error returns empty Set (fail safe -
// project then coerces to null, never to a stale or wrong value).
let _slugCache: { set: Set<string>; loadedAt: number } | null = null;

// Exported for tests only. Resets the module-level cache so Deno.test
// runs cannot leak state across each other.
export function _resetSlugCacheForTests(): void {
  _slugCache = null;
}

export async function loadKnownSlugs(
  supabase: SupabaseLike,
  ttlMs: number = 300_000,
): Promise<Set<string>> {
  const now = Date.now();
  if (_slugCache && now - _slugCache.loadedAt < ttlMs) return _slugCache.set;
  try {
    const { data, error } = await supabase.from("projects").select("slug");
    if (error) throw error;
    const set = new Set((data ?? []).map((r) => r.slug).filter(Boolean));
    _slugCache = { set, loadedAt: now };
    return set;
  } catch (err) {
    console.error("loadKnownSlugs error, reusing cache:", err);
    return _slugCache?.set ?? new Set();
  }
}

// Session 272 route map: deterministic content-phrase → project routing.
// Fills metadata.project ONLY when the LLM returned null AND exactly one
// project's route_phrases match the content. The unique-match rule keeps
// cross-project digests unrouted instead of mis-routed (the Session 203
// failure class). Phrases live in projects.route_phrases (operator data).
let _routeMapCache: { map: Map<string, string[]>; loadedAt: number } | null =
  null;

// Exported for tests only.
export function _resetRouteMapCacheForTests(): void {
  _routeMapCache = null;
}

export async function loadRouteMap(
  supabase: SupabaseLike<{ slug: string; route_phrases: string[] | null }>,
  ttlMs: number = 300_000,
): Promise<Map<string, string[]>> {
  const now = Date.now();
  if (_routeMapCache && now - _routeMapCache.loadedAt < ttlMs) {
    return _routeMapCache.map;
  }
  try {
    const { data, error } = await supabase.from("projects").select(
      "slug, route_phrases",
    );
    if (error) throw error;
    const map = new Map<string, string[]>();
    for (const row of data ?? []) {
      const phrases = (row.route_phrases ?? []).filter(
        (p): p is string => typeof p === "string" && p.trim().length > 0,
      );
      if (row.slug && phrases.length > 0) map.set(row.slug, phrases);
    }
    _routeMapCache = { map, loadedAt: now };
    return map;
  } catch (err) {
    console.error("loadRouteMap error, reusing cache:", err);
    return _routeMapCache?.map ?? new Map();
  }
}

// Phrases shorter than this are too ambiguous to route on ("a", "ok").
const ROUTE_PHRASE_MIN_LENGTH = 4;

export function routeProjectFromContent(
  content: string,
  routeMap: Map<string, string[]>,
): string | null {
  if (routeMap.size === 0) return null;
  const haystack = content.toLowerCase();
  let matched: string | null = null;
  for (const [slug, phrases] of routeMap) {
    const hit = phrases.some((p) => {
      const needle = p.trim().toLowerCase();
      return needle.length >= ROUTE_PHRASE_MIN_LENGTH &&
        haystack.includes(needle);
    });
    if (!hit) continue;
    if (matched !== null) return null; // two distinct projects → ambiguous
    matched = slug;
  }
  return matched;
}

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

function coercePriority(raw: unknown): "high" | "low" | "normal" | null {
  const v = String(raw ?? "").toLowerCase();
  if (v === "high" || v === "low" || v === "normal") return v;
  return null;
}

// Composes B1 (normalize topics) + B5 (recombine split pairs) +
// B3 (project coercion against knownSlugs) + B4 (type validation).
// Pure function - no I/O - so it's deterministic and unit-testable.
export function coerceMetadata(
  raw: RawMetadata,
  knownSlugs: Set<string>,
  content: string,
): CoercedMetadata {
  // B1: normalize topics, dedup preserving first-seen order, drop empties.
  const rawTopics = asStringArray(raw?.topics);
  const normalizedSeen = new Set<string>();
  const normalizedTopics: string[] = [];
  for (const t of rawTopics) {
    const n = normalizeTopic(t);
    if (n && !normalizedSeen.has(n)) {
      normalizedSeen.add(n);
      normalizedTopics.push(n);
    }
  }
  // B5: recombine adjacent split pairs against the known-slugs dictionary.
  const recombined = recombineHyphenated(normalizedTopics, knownSlugs, content);
  const finalTopics = recombined.length > 0 ? recombined : ["uncategorized"];

  // B3: coerce project against known slugs (apply same normalization first).
  let project: string | null = null;
  const rawProject = raw?.project;
  if (typeof rawProject === "string" && rawProject.trim()) {
    const normProject = normalizeTopic(rawProject);
    if (normProject && knownSlugs.has(normProject)) project = normProject;
  }

  return {
    people: asStringArray(raw?.people),
    action_items: asStringArray(raw?.action_items),
    dates_mentioned: asStringArray(raw?.dates_mentioned),
    topics: finalTopics,
    type: coerceType(raw?.type),
    project,
    priority: coercePriority(raw?.priority),
  };
}

// B5: recombine adjacent topic pairs that the LLM split mid-hyphen.
// Only fires when (a) the combined "A-B" is a known projects.slug,
// (b) neither A nor B is itself a known slug, and (c) the original
// content text contains "A-B" or "A_B" as a literal substring (proves
// the LLM split what was originally one token, not two real topics).
export function recombineHyphenated(
  topics: string[],
  knownSlugs: Set<string>,
  content: string,
): string[] {
  const contentLower = content.toLowerCase();
  const out: string[] = [];
  let i = 0;
  while (i < topics.length) {
    if (i + 1 < topics.length) {
      const a = topics[i];
      const b = topics[i + 1];
      const combined = `${a}-${b}`;
      const literalHit =
        contentLower.includes(combined) || contentLower.includes(`${a}_${b}`);
      if (
        knownSlugs.has(combined) &&
        !knownSlugs.has(a) &&
        !knownSlugs.has(b) &&
        literalHit
      ) {
        out.push(combined);
        console.log(`B5 recombine: [${a}, ${b}] -> ${combined}`);
        i += 2;
        continue;
      }
    }
    out.push(topics[i]);
    i += 1;
  }
  return out;
}
