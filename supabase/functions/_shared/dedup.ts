// supabase/functions/_shared/dedup.ts
//
// Loop-closing Task 5.2 (A3): dedup at insert. Single source for BOTH capture
// paths' extractAndStoreActionItems (capture-pipeline.ts, used by
// open-brain-mcp's REST /capture and capture_thought, and the ingest-thought
// copy), so the mirror rule covers only the call sites, which
// fragment-gate.test.ts proves identical (the whole function body is compared
// as a syntax tree).
//
// Two independent fixes, in this order inside extractAndStoreActionItems:
//
//   (1) Batch-local exact dedup, the ONLY automatic drop. After the fragment
//       gate and after the open-item exact dedup, the normalized set is
//       updated as the batch is filtered (createBatchDedup), so two identical
//       strings in one LLM batch insert once. After the insert, each dropped
//       copy writes ONE decision row (dedup / dropped / exact_batch,
//       thought_id, related_item_id = the inserted survivor,
//       candidate_description = the copy's text, item_id null) through
//       recordDecision: one row per call, no item_id, so no stamping lock.
//
//   (2) Semantic overlap, proposals only. There is NO `same`: a semantic match
//       never suppresses anything (plan round 4: "send Sam the final
//       appointment reminder email" and "send Riley the final appointment
//       reminder email" share 5 of 6 content tokens with empty constraint
//       sets, and are two clients' tasks). The candidates, read BEFORE the
//       insert so each is older than the rows this batch inserts, are open
//       items from the last 14 days (dedup_semantic_candidates); a candidate
//       qualifies when its source thought shares the capture's project, or
//       either project is null. Every inserted item with a `maybe` candidate
//       is inserted as usual AND gets ONE proposal row (dedup / proposed /
//       semantic_overlap, item_id = the new item, related_item_id = the
//       OLDEST qualifying candidate, score = containment). The batch's
//       proposal rows go through record_decisions(p_rows jsonb) (Task 3.1:
//       pre-locks the affected items in id order) inside the 40P01 retry.
//
// constraintTokens (numbers, ISO dates, hostnames, environment words,
// negations) is used ONLY to word a proposal in the digest
// (describeConstraints); it never decides anything.
//
// Nothing here throws into the capture: a failed read, a failed decision write
// or a missing rpc logs and returns. A failed write never un-drops a batch
// duplicate and never un-inserts an item.

import { descriptionContentTokens, stem } from "./quote-coverage.ts";
import {
  type DecisionRow,
  recordDecision,
  toInsertPayload,
  validateDecisionRow,
} from "./decisions.ts";
import { rpcWithDeadlockRetry } from "./action-item-transition.ts";

export const SEMANTIC_OVERLAP_THRESHOLD = 0.8;
export const SEMANTIC_MIN_CONTENT_TOKENS = 2;
export const SEMANTIC_WINDOW_DAYS = 14;
export const SEMANTIC_CANDIDATE_LIMIT = 500;
export const DEDUP_LOG_TRUNC = 200;

export const ENVIRONMENT_WORDS: ReadonlySet<string> = new Set([
  "live",
  "demo",
  "prod",
  "production",
  "staging",
  "test",
]);
export const NEGATION_WORDS: ReadonlySet<string> = new Set(["not", "never", "no"]);

// File extensions that would otherwise read as a hostname's top-level label
// (`deliverables/report.md`). Wording only; a miss here mislabels nothing.
const FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  "md", "ts", "js", "mjs", "sql", "json", "txt", "py", "sh", "pdf", "png",
  "jpg", "csv", "html", "css", "yml", "yaml", "toml",
]);

/** The constraint tokens of an item: ISO dates, hostnames, numbers,
 * environment words and negations, lowercase. Used ONLY to word a proposal. */
export function constraintTokens(desc: string): Set<string> {
  let s = String(desc ?? "").toLowerCase();
  const out = new Set<string>();
  // Dates first, then hostnames, then bare numbers, each removed once taken so
  // a date is not also read as three numbers.
  s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (m) => {
    out.add(m);
    return " ";
  });
  s = s.replace(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/g, (m) => {
    const tld = m.slice(m.lastIndexOf(".") + 1);
    if (FILE_EXTENSIONS.has(tld)) return m;
    out.add(m);
    return " ";
  });
  s = s.replace(/\b\d+(?:\.\d+)*\b/g, (m) => {
    out.add(m);
    return " ";
  });
  for (const w of s.split(/[^a-z]+/)) {
    if (ENVIRONMENT_WORDS.has(w) || NEGATION_WORDS.has(w)) out.add(w);
  }
  return out;
}

/** Distinct stemmed content tokens (Task 1.3 stoplist on the raw words,
 * single-source in quote-coverage.ts, then the Task 1.3 stemmer). */
export function contentStems(desc: string): Set<string> {
  return new Set(descriptionContentTokens(String(desc ?? "")).map(stem));
}

/** Containment of the SHORTER item's distinct content tokens in the longer
 * item's. 0 when the shorter has fewer than SEMANTIC_MIN_CONTENT_TOKENS. */
export function overlapContainment(a: string, b: string): number {
  const sa = contentStems(a), sb = contentStems(b);
  const [shorter, longer] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  if (shorter.size < SEMANTIC_MIN_CONTENT_TOKENS) return 0;
  let inside = 0;
  for (const t of shorter) if (longer.has(t)) inside++;
  return inside / shorter.size;
}

/** `maybe` at or above SEMANTIC_OVERLAP_THRESHOLD containment with at least
 * two content tokens, else `no`. There is no value that suppresses. */
export function semanticOverlap(a: string, b: string): "maybe" | "no" {
  return overlapContainment(a, b) >= SEMANTIC_OVERLAP_THRESHOLD ? "maybe" : "no";
}

/** The digest's wording: `constraints agree`, or `constraints differ: X vs Y`
 * with the survivor's own constraint tokens first and the newer item's
 * second (`none` for an empty side), each side sorted. */
export function describeConstraints(item: string, survivor: string): string {
  const a = constraintTokens(item), b = constraintTokens(survivor);
  const onlySurvivor = [...b].filter((t) => !a.has(t)).sort();
  const onlyItem = [...a].filter((t) => !b.has(t)).sort();
  if (onlySurvivor.length === 0 && onlyItem.length === 0) return "constraints agree";
  const side = (ts: string[]) => ts.length ? ts.join(", ") : "none";
  return `constraints differ: ${side(onlySurvivor)} vs ${side(onlyItem)}`;
}

// ---------------------------------------------------------------------------
// (1) Batch-local exact dedup.
// ---------------------------------------------------------------------------

export type BatchDuplicate = { description: string; key: string };

/** A filter whose normalized set is updated as the batch is filtered: keep()
 * is true for the first row of each normalized text and false for every later
 * copy, which it records in `duplicates` (in batch order). `normalize` is the
 * caller's normalizeActionText (_shared/capture-helpers.ts, one source for both
 * capture paths). */
export function createBatchDedup(normalize: (s: string) => string): {
  keep: (description: string) => boolean;
  duplicates: BatchDuplicate[];
} {
  const seen = new Set<string>();
  const duplicates: BatchDuplicate[] = [];
  return {
    keep(description: string): boolean {
      const key = normalize(description);
      if (seen.has(key)) {
        duplicates.push({ description, key });
        return false;
      }
      seen.add(key);
      return true;
    },
    duplicates,
  };
}

/** After the insert: ONE dedup/dropped/exact_batch row per batch duplicate,
 * naming the survivor the insert returned (matched by normalized text, which
 * is unique among the inserted rows). Returns the rows attempted. */
export async function recordBatchDuplicates(
  // deno-lint-ignore no-explicit-any
  db: { from(table: string): any },
  thoughtId: string,
  duplicates: readonly BatchDuplicate[],
  inserted: ReadonlyArray<{ id: string; description: string }> | null | undefined,
  normalize: (s: string) => string,
): Promise<number> {
  if (duplicates.length === 0) return 0;
  const survivorByKey = new Map<string, string>();
  for (const row of inserted ?? []) {
    if (row && typeof row.id === "string") survivorByKey.set(normalize(String(row.description)), row.id);
  }
  let n = 0;
  for (const dup of duplicates) {
    const survivor = survivorByKey.get(dup.key);
    if (survivor === undefined) {
      console.error(
        `exact batch dedup: no inserted survivor for a dropped copy; no row written: ${
          dup.description.slice(0, DEDUP_LOG_TRUNC)
        }`,
      );
      continue;
    }
    n += 1;
    console.log(
      `exact batch dedup: dropped a copy of ${survivor}: ${dup.description.slice(0, DEDUP_LOG_TRUNC)}`,
    );
    await recordDecision(db, {
      layer: "dedup",
      outcome: "dropped",
      reason: "exact_batch",
      candidate_description: dup.description,
      thought_id: thoughtId,
      related_item_id: survivor,
    });
  }
  return n;
}

// ---------------------------------------------------------------------------
// (2) Semantic overlap, proposals only.
// ---------------------------------------------------------------------------

export type SemanticCandidate = {
  id: string;
  description: string;
  created_at: string;
  source_thought_id: string | null;
  project: string | null;
};

// deno-lint-ignore no-explicit-any
type RpcDb = { rpc?: (fn: string, args: Record<string, unknown>) => any };

/** Lowercase, trimmed project name; null when absent, blank or not a string. */
export function normalizeProject(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const t = p.trim().toLowerCase();
  return t === "" ? null : t;
}

/** The open items of the last SEMANTIC_WINDOW_DAYS with their source
 * thought's project (dedup_semantic_candidates). Read BEFORE the insert.
 * Never throws: a failed read logs and yields no candidates (nothing is
 * proposed; nothing is ever suppressed either way). */
export async function loadSemanticCandidates(db: RpcDb): Promise<SemanticCandidate[]> {
  try {
    if (typeof db.rpc !== "function") {
      console.error("semantic dedup: candidate read skipped: the client has no rpc");
      return [];
    }
    const { data, error } = await db.rpc("dedup_semantic_candidates", {
      p_window_days: SEMANTIC_WINDOW_DAYS,
      p_limit: SEMANTIC_CANDIDATE_LIMIT,
    });
    if (error) {
      console.error(`semantic dedup: candidate read failed: ${error.message ?? String(error)}`);
      return [];
    }
    return Array.isArray(data) ? (data as SemanticCandidate[]) : [];
  } catch (e) {
    console.error(`semantic dedup: candidate read threw: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

function olderFirst(a: SemanticCandidate, b: SemanticCandidate): number {
  return Date.parse(a.created_at) - Date.parse(b.created_at) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Pure: one dedup/proposed/semantic_overlap row per inserted item that has a
 * `maybe` candidate, naming the OLDEST such candidate (the survivor of the
 * group). A candidate qualifies when it is not one of the inserted rows, does
 * not come from the same source thought, and its project matches the
 * capture's project or either is null. */
export function planSemanticProposals(
  candidates: readonly SemanticCandidate[],
  thoughtId: string,
  captureProject: unknown,
  inserted: ReadonlyArray<{ id: string; description: string }> | null | undefined,
): DecisionRow[] {
  const mine = normalizeProject(captureProject);
  const insertedIds = new Set((inserted ?? []).map((r) => r?.id));
  const eligible = candidates
    .filter((c) => c && typeof c.id === "string" && typeof c.description === "string")
    .filter((c) => !insertedIds.has(c.id) && c.source_thought_id !== thoughtId)
    .filter((c) => {
      const theirs = normalizeProject(c.project);
      return mine === null || theirs === null || mine === theirs;
    })
    .sort(olderFirst);
  const rows: DecisionRow[] = [];
  for (const item of inserted ?? []) {
    if (!item || typeof item.id !== "string") continue;
    const survivor = eligible.find((c) => semanticOverlap(item.description, c.description) === "maybe");
    if (survivor === undefined) continue;
    rows.push({
      layer: "dedup",
      outcome: "proposed",
      reason: "semantic_overlap",
      candidate_description: String(item.description),
      item_id: item.id,
      related_item_id: survivor.id,
      score: Math.round(overlapContainment(item.description, survivor.description) * 1000) / 1000,
    });
  }
  return rows;
}

/** After the insert: the batch's proposal rows in ONE record_decisions call
 * (pre-locks the items in id order), retried on 40P01. Returns the rows the
 * call reported inserted, 0 on any failure. Never throws. */
export async function proposeSemanticDuplicates(
  db: RpcDb,
  candidates: readonly SemanticCandidate[],
  thoughtId: string,
  captureProject: unknown,
  inserted: ReadonlyArray<{ id: string; description: string }> | null | undefined,
): Promise<number> {
  try {
    const planned = planSemanticProposals(candidates, thoughtId, captureProject, inserted);
    const rows = planned.filter((r) => {
      const problem = validateDecisionRow(r);
      if (problem) console.error(`semantic dedup: refused a proposal row: ${problem}`);
      return problem === null;
    });
    if (rows.length === 0) return 0;
    for (const r of rows) {
      console.log(
        `semantic dedup: proposed ${r.item_id} as a possible duplicate of ${r.related_item_id} (containment=${r.score})`,
      );
    }
    if (typeof db.rpc !== "function") {
      console.error("semantic dedup: record_decisions skipped: the client has no rpc");
      return 0;
    }
    const { data, error, attempts } = await rpcWithDeadlockRetry(
      { rpc: db.rpc.bind(db) },
      "record_decisions",
      { p_rows: rows.map(toInsertPayload) },
    );
    if (error) {
      console.error(
        `semantic dedup: record_decisions failed after ${attempts} attempt(s); ${rows.length} proposal row(s) not written: ${
          error.message ?? String(error)
        }`,
      );
      return 0;
    }
    return typeof data === "number" ? data : 0;
  } catch (e) {
    console.error(`semantic dedup: proposal write threw: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}
