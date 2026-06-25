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
export type SupabaseLike = {
  from: (table: string) => {
    select: (cols: string) => PromiseLike<{ data: Array<{ slug: string }> | null; error: unknown }>;
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
  const type = String(metadata?.type ?? "").toLowerCase();
  if (type === "observation" || type === "reference") return false;
  const source = String(metadata?.source ?? "").toLowerCase();
  if (source === "gmail" || source === "email") return false;
  return true;
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

  return isRescheduleCommand(text) || [
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
