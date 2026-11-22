// Operator-gated action-item lifecycle helpers (resolve / defer / restore).
//
// These back the manual MCP tools resolve_action_item, archive_action_item,
// defer_action_item, and restore_action_item. They are intentionally NOT part of the auto-resolve
// decision flow (checkAutoResolve + the LAYER guards) — that path stays the
// only automatic resolver. These helpers only shape the transition arguments and
// validate operator input; the status-guarded write is transition_action_item. No mirror in ingest-thought.

import type {
  ActionItemCloseReason,
  TransitionArgs,
} from "../_shared/action-item-transition.ts";

const REASON_MAX_CHARS = 500;

export type RestoreSelector = { id: string } | { defer_reason: string };

function cleanReason(value: string, field: string): string {
  const cleaned = (value ?? "").trim();
  if (!cleaned) throw new Error(`${field} is required.`);
  if (cleaned.length > REASON_MAX_CHARS) {
    throw new Error(`${field} must be ${REASON_MAX_CHARS} characters or fewer.`);
  }
  return cleaned;
}

// The MCP has no caller identity: the shared key authorizes the call and does not
// name the caller, so these tools record the operator role they are documented
// for, with actor_source saying the name was not proven by the transport.
const OPERATOR_ACTOR = "operator";
const MCP_ACTOR_PAYLOAD = { actor_source: "mcp-shared-key" };

export function buildResolveTransition(id: string, reason: string): TransitionArgs {
  return {
    itemId: id,
    from: ["open"],
    to: "resolved",
    actor: OPERATOR_ACTOR,
    closeReason: "done",
    resolutionNote: cleanReason(reason, "reason"),
    eventPayload: MCP_ACTOR_PAYLOAD,
  };
}

export function buildArchiveTransition(
  id: string,
  reason: string,
  closeReason: ActionItemCloseReason,
  duplicateOf?: string | null,
): TransitionArgs {
  return {
    itemId: id,
    from: ["open", "deferred"],
    to: "archived",
    actor: OPERATOR_ACTOR,
    closeReason,
    resolutionNote: cleanReason(reason, "reason"),
    duplicateOf: duplicateOf ?? null,
    eventPayload: MCP_ACTOR_PAYLOAD,
  };
}

export function buildDeferTransition(id: string, reason: string): TransitionArgs {
  return {
    itemId: id,
    from: ["open"],
    to: "deferred",
    actor: OPERATOR_ACTOR,
    deferReason: cleanReason(reason, "reason"),
    eventPayload: MCP_ACTOR_PAYLOAD,
  };
}

// Reopen by id is the undo for every close verb. The defer_reason selector goes
// through its own RPC, restricted to deferred rows, so an unpause can never reopen
// closed work.
export function buildRestoreTransition(id: string): TransitionArgs {
  return {
    itemId: id,
    from: ["deferred", "archived", "resolved"],
    to: "open",
    actor: OPERATOR_ACTOR,
    eventPayload: MCP_ACTOR_PAYLOAD,
  };
}

export const ACTION_ITEM_LIST_MAX = 100;

// offset..offset+limit-1 for .range(), with order on (created_at, id) so a page
// boundary cannot skip or repeat rows that share a timestamp.
export function actionItemListWindow(
  args: { limit?: number; offset?: number },
): { from: number; to: number } {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  return { from: offset, to: offset + limit - 1 };
}

export function assertRestoreSelector(
  args: { id?: string | null; defer_reason?: string | null },
): RestoreSelector {
  const id = args.id?.trim() || "";
  const deferReason = args.defer_reason?.trim() || "";
  if (id && deferReason) {
    throw new Error(
      "Provide exactly one of id or defer_reason, not both.",
    );
  }
  if (!id && !deferReason) {
    throw new Error("Provide exactly one of id or defer_reason.");
  }
  return id ? { id } : { defer_reason: deferReason };
}

export function stateGuardError(
  action: "resolve" | "defer" | "restore" | "archive",
  requiredStatus: string,
  row: { status: string } | null | undefined,
): string {
  if (!row) return "Action item not found.";
  return `Cannot ${action} action item: current status is '${row.status}', but '${requiredStatus}' is required.`;
}
