// supabase/functions/_shared/fragment-gate.ts
//
// Loop-closing Task 5.1 (A2, A3): the fragment gate's two writers, called by
// BOTH capture paths' extractAndStoreActionItems (capture-pipeline.ts, used by
// open-brain-mcp and external-crm-sync, and the ingest-thought copy) after the
// appointment guard. Single source, so the mirror rule covers only the two call
// sites, which fragment-gate.test.ts proves identical.
//
//   applyFragmentGate     drops rule (a) one_token and rule (b) dangling_clause
//                         items before insert; one decision row per drop
//                         (fragment / dropped / <reason>, item_id null,
//                         thought_id and candidate_description set).
//   recordPronounSuspects after the insert: one decision row per inserted item
//                         whose object is a bare pronoun (fragment / proposed /
//                         pronoun_object, item_id and thought_id set). The
//                         digest lists these as "check wording" and Task 3.6's
//                         handler reviews them (keep -> kept; archive ->
//                         accepted, close_reason 'fragment').
//
// Both go through recordDecision: ONE row per call (Task 3.1's lock contract),
// validated, never throws. A failed decision write never fails the capture and
// never un-drops an item: the drop is the gate's decision, the row its audit.

import { classifyFragmentItem } from "./metadata-validation.ts";
import { type DecisionDb, recordDecision } from "./decisions.ts";

export const FRAGMENT_LOG_TRUNC = 200;

// recordDecision refuses a blank candidate_description. An extracted item
// that is empty or whitespace is still dropped (one_token); its audit row
// carries this marker instead of nothing.
export const EMPTY_ITEM_MARKER = "(empty extracted item)";

/** Drop fragment items, writing one decision row per drop. Returns the kept
 * rows in their original order, unchanged (the stored description is the
 * original text, not the normalized one). */
export async function applyFragmentGate<R extends { description: string }>(
  db: DecisionDb,
  thoughtId: string,
  rows: R[],
): Promise<R[]> {
  const kept: R[] = [];
  for (const row of rows) {
    const verdict = classifyFragmentItem(row.description);
    if (verdict.drop === null) {
      kept.push(row);
      continue;
    }
    console.log(
      `fragment gate: dropped item (${verdict.drop}): ${
        row.description.slice(0, FRAGMENT_LOG_TRUNC)
      }`,
    );
    await recordDecision(db, {
      layer: "fragment",
      outcome: "dropped",
      reason: verdict.drop,
      candidate_description: row.description.trim() === ""
        ? EMPTY_ITEM_MARKER
        : row.description,
      thought_id: thoughtId,
    });
  }
  return kept;
}

/** One fragment/proposed/pronoun_object row per inserted item whose object is
 * a bare pronoun. `inserted` is what the insert returned (id + description).
 * Returns how many suspects were found (rows attempted, not rows written). */
export async function recordPronounSuspects(
  db: DecisionDb,
  thoughtId: string,
  inserted: ReadonlyArray<{ id: string; description: string }>,
): Promise<number> {
  let n = 0;
  for (const item of inserted) {
    if (!classifyFragmentItem(item.description).pronounObject) continue;
    n += 1;
    console.log(
      `fragment gate: pronoun-object suspect ${item.id}: ${
        item.description.slice(0, FRAGMENT_LOG_TRUNC)
      }`,
    );
    await recordDecision(db, {
      layer: "fragment",
      outcome: "proposed",
      reason: "pronoun_object",
      candidate_description: item.description,
      item_id: item.id,
      thought_id: thoughtId,
    });
  }
  return n;
}
