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

// ---------------------------------------------------------------------------
// Loop-closing Task 3.3: durable triage reviews and the oldest-unreviewed read.
//
// The rules live in SQL (20261119b_action_items_review.sql): review_action_item
// is the one writer and it validates everything. These helpers only shape the
// RPC arguments and the reply, so there is one copy of each rule. The argument
// NAMES here must equal the SQL parameter names; scripts/loop-closing/
// action-item-review-integration.ts runs these helpers against the real
// functions to prove it.
// ---------------------------------------------------------------------------

export const REVIEW_OUTCOMES = ["keep", "proposal"] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

export const TRIAGE_DISPOSITIONS = [
  "stale",
  "duplicate",
  "vague",
  "done",
  "paused",
] as const;
export type TriageDisposition = (typeof TRIAGE_DISPOSITIONS)[number];

export const UNREVIEWED_DAYS_MAX = 365;

export interface RpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export interface ReviewActionItemArgs {
  id: string;
  outcome: string;
  actor: string;
  disposition?: string | null;
  evidence?: string | null;
  replacement_id?: string | null;
}

// An omitted optional is null; a supplied one, however blank, is passed as it
// is, so the SQL can refuse an empty disposition on a keep rather than have it
// read as absent.
export function buildReviewActionItemParams(
  args: ReviewActionItemArgs,
): Record<string, unknown> {
  return {
    p_item_id: args.id,
    p_outcome: args.outcome,
    p_actor: args.actor,
    p_disposition: args.disposition ?? null,
    p_evidence: args.evidence ?? null,
    p_replacement_id: args.replacement_id ?? null,
  };
}

export type ReviewActionItemStatus =
  | "recorded"
  | "refused"
  | "not_found"
  | "error";

export interface ReviewActionItemResult {
  status: ReviewActionItemStatus;
  message: string;
}

const REVIEW_REPLY_STATUSES = new Set(["recorded", "refused", "not_found"]);

// Never reports success it did not read: an RPC error, an empty reply or a
// status this code does not know is "error".
export async function reviewActionItem(
  db: RpcClient,
  args: ReviewActionItemArgs,
): Promise<ReviewActionItemResult> {
  const { data, error } = await db.rpc(
    "review_action_item",
    buildReviewActionItemParams(args),
  );
  if (error) return { status: "error", message: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  const status = (row as { status?: unknown } | null | undefined)?.status;
  const message = (row as { message?: unknown } | null | undefined)?.message;
  if (
    typeof status !== "string" || !REVIEW_REPLY_STATUSES.has(status) ||
    typeof message !== "string"
  ) {
    return {
      status: "error",
      message: "review_action_item returned no readable reply; nothing is known to be recorded.",
    };
  }
  return { status: status as ReviewActionItemStatus, message };
}

// unreviewed_days selects the triage read: open items only, oldest unreviewed
// first. The other list options would contradict it, so they are refused rather
// than ignored.
export function assertUnreviewedListArgs(
  args: { include_deferred?: boolean; order?: string },
): void {
  if (args.include_deferred) {
    throw new Error(
      "unreviewed_days reads open items only; it cannot be combined with include_deferred.",
    );
  }
  if (args.order === "newest") {
    throw new Error(
      "unreviewed_days fixes the order to oldest unreviewed first; it cannot be combined with order='newest'.",
    );
  }
}

export interface UnreviewedActionItem {
  id: string;
  description: string;
  status: string;
  created_at: string | null;
  source_thought_id: string | null;
  last_reviewed_at: string | null;
  last_reviewed_by: string | null;
  review_outcome: string | null;
  triage_disposition: string | null;
  triage_evidence: string | null;
  triage_replacement_id: string | null;
}

export interface UnreviewedList {
  items: UnreviewedActionItem[];
  /** The whole unreviewed window. Null when this page is empty at an offset
   * past zero, where the function returns no row to carry it. */
  unreviewed_total: number | null;
}

export async function listUnreviewedActionItems(
  db: RpcClient,
  args: { unreviewed_days: number; limit?: number; offset?: number },
): Promise<UnreviewedList> {
  const window = actionItemListWindow({ limit: args.limit, offset: args.offset });
  const limit = window.to - window.from + 1;
  const { data, error } = await db.rpc("list_unreviewed_action_items", {
    p_unreviewed_days: args.unreviewed_days,
    p_limit: limit,
    p_offset: window.from,
  });
  if (error) throw new Error(error.message);
  if (!Array.isArray(data)) {
    throw new Error("list_unreviewed_action_items returned no readable rows.");
  }
  const rows = data as Array<Record<string, unknown>>;
  let total: number | null = window.from === 0 ? 0 : null;
  const items = rows.map((r) => {
    const { unreviewed_total, ...item } = r;
    const n = Number(unreviewed_total);
    if (!Number.isInteger(n) || n < rows.length) {
      throw new Error(
        "list_unreviewed_action_items returned a row without a usable unreviewed_total.",
      );
    }
    total = n;
    return item as unknown as UnreviewedActionItem;
  });
  return { items, unreviewed_total: total };
}
