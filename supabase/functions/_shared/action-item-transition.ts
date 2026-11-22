// supabase/functions/_shared/action-item-transition.ts
//
// Loop-closing Task 3.1: the one way TypeScript changes action_items.status.
// The RPCs run set_config and the guarded update in a single transaction, which
// a preceding set_config request cannot do (it lives on whichever pooled
// connection served it). Single source for both capture files and the MCP tools.

export const ACTION_ITEM_CLOSE_REASONS = [
  "done",
  "superseded",
  "duplicate",
  "fragment",
  "expired",
  "wont_do",
] as const;
export type ActionItemCloseReason = (typeof ACTION_ITEM_CLOSE_REASONS)[number];

export type ActionItemStatus = "open" | "deferred" | "resolved" | "archived";

export type TransitionArgs = {
  itemId: string;
  from: ActionItemStatus[];
  to: ActionItemStatus;
  actor: string;
  closeReason?: ActionItemCloseReason | null;
  resolutionNote?: string | null;
  resolvedByThoughtId?: string | null;
  evidenceThoughtId?: string | null;
  duplicateOf?: string | null;
  deferReason?: string | null;
  eventPayload?: Record<string, unknown> | null;
};

export type TransitionResult =
  | { ok: true; affected: number }
  | { ok: false; error: string };

type RpcError = { code?: string; message?: string } | null;
export type TransitionDb = {
  // deno-lint-ignore no-explicit-any
  rpc: (fn: string, args: Record<string, unknown>) => any;
};

export const DEADLOCK_MAX_ATTEMPTS = 3;
const DEADLOCK_SQLSTATE = "40P01";

// Postgres aborted the victim's whole transaction, so retrying it whole is safe.
// After the last attempt the error is returned for the caller to log and move on.
export async function rpcWithDeadlockRetry(
  db: TransitionDb,
  fn: string,
  args: Record<string, unknown>,
  maxAttempts = DEADLOCK_MAX_ATTEMPTS,
): Promise<{ data: unknown; error: RpcError; attempts: number }> {
  let attempts = 0;
  while (true) {
    attempts += 1;
    const { data, error } = await db.rpc(fn, args);
    if (error?.code === DEADLOCK_SQLSTATE && attempts < maxAttempts) {
      console.warn(`${fn}: deadlock victim, retrying (attempt ${attempts})`);
      continue;
    }
    return { data, error: error ?? null, attempts };
  }
}

export function transitionRpcArgs(args: TransitionArgs): Record<string, unknown> {
  return {
    p_item_id: args.itemId,
    p_from_statuses: args.from,
    p_to_status: args.to,
    p_actor: args.actor,
    p_close_reason: args.closeReason ?? null,
    p_resolution_note: args.resolutionNote ?? null,
    p_resolved_by_thought_id: args.resolvedByThoughtId ?? null,
    p_evidence_thought_id: args.evidenceThoughtId ?? null,
    p_duplicate_of: args.duplicateOf ?? null,
    p_defer_reason: args.deferReason ?? null,
    p_event_payload: args.eventPayload ?? null,
  };
}

export async function transitionActionItem(
  db: TransitionDb,
  args: TransitionArgs,
): Promise<TransitionResult> {
  const { data, error } = await rpcWithDeadlockRetry(
    db,
    "transition_action_item",
    transitionRpcArgs(args),
  );
  if (error) {
    return { ok: false, error: error.message ?? String(error) };
  }
  // A non-numeric answer is a contract failure, not "zero rows": reading it as
  // zero would report a real close as "no longer open".
  if (typeof data !== "number") {
    return { ok: false, error: `transition_action_item returned ${JSON.stringify(data)}` };
  }
  return { ok: true, affected: data };
}

export async function restoreByDeferReason(
  db: TransitionDb,
  deferReason: string,
  actor: string,
): Promise<TransitionResult> {
  const { data, error } = await rpcWithDeadlockRetry(
    db,
    "transition_action_items_by_defer_reason",
    { p_defer_reason: deferReason, p_actor: actor },
  );
  if (error) return { ok: false, error: error.message ?? String(error) };
  if (typeof data !== "number") {
    return { ok: false, error: `transition_action_items_by_defer_reason returned ${JSON.stringify(data)}` };
  }
  return { ok: true, affected: data };
}
