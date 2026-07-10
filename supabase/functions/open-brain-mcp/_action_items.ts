// Operator-gated action-item lifecycle helpers (resolve / defer / restore).
//
// These back the manual MCP tools resolve_action_item, defer_action_item, and
// restore_action_item. They are intentionally NOT part of the auto-resolve
// decision flow (checkAutoResolve + the LAYER guards) — that path stays the
// only automatic resolver. These helpers only shape the update payloads and
// validate operator input; the actual DB writes (with status-guarded WHERE
// clauses) live in open-brain-mcp/index.ts. No mirror in ingest-thought.

const REASON_MAX_CHARS = 500;

export interface ActionItemUpdate {
  status: "resolved" | "deferred" | "open";
  resolved_at?: string | null;
  resolution_note?: string | null;
  deferred_at?: string | null;
  defer_reason?: string | null;
}

export type RestoreSelector = { id: string } | { defer_reason: string };

function cleanReason(value: string, field: string): string {
  const cleaned = (value ?? "").trim();
  if (!cleaned) throw new Error(`${field} is required.`);
  if (cleaned.length > REASON_MAX_CHARS) {
    throw new Error(`${field} must be ${REASON_MAX_CHARS} characters or fewer.`);
  }
  return cleaned;
}

export function buildResolveActionItemUpdate(
  reason: string,
  now: string,
): ActionItemUpdate {
  return {
    status: "resolved",
    resolved_at: now,
    resolution_note: cleanReason(reason, "reason"),
  };
}

export function buildDeferActionItemUpdate(
  reason: string,
  now: string,
): ActionItemUpdate {
  return {
    status: "deferred",
    deferred_at: now,
    defer_reason: cleanReason(reason, "reason"),
  };
}

export function buildRestoreActionItemUpdate(): ActionItemUpdate {
  return {
    status: "open",
    deferred_at: null,
    defer_reason: null,
  };
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
  action: "resolve" | "defer" | "restore",
  requiredStatus: string,
  row: { status: string } | null | undefined,
): string {
  if (!row) return "Action item not found.";
  return `Cannot ${action} action item: current status is '${row.status}', but '${requiredStatus}' is required.`;
}
