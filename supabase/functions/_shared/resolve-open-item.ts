// supabase/functions/_shared/resolve-open-item.ts
//
// Loop-closing Task 1.4: the affected-row resolve. The auto-resolve update
// used to write by id alone, so an item deferred or closed while the LAYER 2
// model ran was overwritten and no record said so. Now the update carries the
// status predicate and returns the affected ids; a `resolved` decision row is
// written only when exactly that row changed. Single source for both capture
// files (like still-owed-veto.ts), so there is no mirror burden here; only the
// call sites inside each checkAutoResolve are mirrored.

import { type DecisionDb, recordDecision } from "./decisions.ts";

export type ResolveOutcome = "resolved" | "not_open" | "error";

export type ResolveOpenItemArgs = {
  itemId: string;
  description: string;
  thoughtId: string;
  quote: string;
  now: string;
};

export async function resolveOpenItemAndRecord(
  db: DecisionDb,
  args: ResolveOpenItemArgs,
): Promise<ResolveOutcome> {
  const { data: affected, error: updateError } = await db
    .from("action_items")
    .update({
      status: "resolved",
      resolved_by_thought_id: args.thoughtId,
      resolved_at: args.now,
    })
    .eq("id", args.itemId)
    .eq("status", "open")
    .select("id");
  if (updateError) {
    console.error(
      `checkAutoResolve: resolve UPDATE failed for item ${args.itemId}: ${
        (updateError as { message?: string }).message ?? String(updateError)
      }`,
    );
    return "error";
  }
  if (!Array.isArray(affected) || affected.length === 0) {
    // The item left `open` while the model ran (deferred, closed by hand, or
    // resolved by a concurrent capture). Nothing changed, so nothing is
    // recorded as resolved.
    console.log(
      `checkAutoResolve: resolve skipped for item ${args.itemId}: no longer open`,
    );
    return "not_open";
  }
  await recordDecision(db, {
    layer: "resolved",
    outcome: "resolved",
    reason: null,
    candidate_description: args.description,
    item_id: args.itemId,
    thought_id: args.thoughtId,
    quote: args.quote,
  });
  return "resolved";
}
