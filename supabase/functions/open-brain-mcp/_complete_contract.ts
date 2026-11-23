// Loop-closing Task 5.4 (D3): the receipt contract checked at complete time.
//
// complete_agent_task used to accept any non-empty string, so an agent could
// report success with a receipt the closeout controller would hold for weeks
// (seven cards on 2026-11-03, the oldest eight weeks). This module decides, from
// the receipt, two immutable packet fields and the route snapshot, whether the
// completion is refused before anything is written, and what warnings ride on an
// accepted one. It is pure; index.ts does the two reads and the write.
//
// Refused (repairable, nothing written, the task stays Agent Working under the
// same claim):
//   - any static receipt reason from _shared/receipt-shape.js (the same code the
//     controller runs at apply), with the controller's own hold message;
//   - project_slug null (MISSING_PROJECT_SLUG);
//   - project_slug present in closeout_routes, fresh, with any capability false
//     (UNRESOLVED_WORKSPACE_PATH, UNRESOLVED_TRACKER_PATH,
//     UNRESOLVED_SESSION_LOG_PATH, MISSING_CAPTURE_TAG).
// Accepted with a ROUTE_SNAPSHOT_UNAVAILABLE warning, never refused, because it
// is infrastructure state and not a receipt defect:
//   - the slug has no row in closeout_routes, or the read failed;
//   - the row's published_at is older than 7 days, missing, unparseable, or more
//     than an hour in the future (a clock it cannot trust).
// Runtime checks (risk, requires_local, main-checkout file existence, executed
// checks) stay at apply in the controller.

import {
  evaluateReceiptContract,
  holdMessage,
  ROUTE_CAPABILITIES,
  routeCapabilityReasons,
} from "../_shared/receipt-shape.js";

export const ROUTE_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const ROUTE_SNAPSHOT_FUTURE_SKEW_MS = 60 * 60 * 1000;
export const ROUTE_SNAPSHOT_COLUMNS =
  "slug, has_workspace, has_tracker, has_session_log, has_capture_tag, published_at";

export type RouteSnapshotRow = {
  slug: string;
  has_workspace: boolean | null;
  has_tracker: boolean | null;
  has_session_log: boolean | null;
  has_capture_tag: boolean | null;
  published_at: string | null;
};

// What index.ts read from closeout_routes for the task's slug. `row: null` with
// no error means the slug has no row; an error means the read itself failed.
export type RouteLookup = { row: RouteSnapshotRow | null; error?: string | null };

export type CompletionTask = {
  project_slug?: string | null;
  desired_outcome?: string | null;
  title?: string | null;
};

export type CompletionWarning = {
  code: "ROUTE_SNAPSHOT_UNAVAILABLE";
  message: string;
};

export type CompletionVerdict =
  | { ok: true; warnings: CompletionWarning[] }
  | {
    ok: false;
    repairable: true;
    reasons: string[];
    static_reasons: string[];
    route_reasons: string[];
    message: string;
  };

export const ROUTE_REPAIR_HINT =
  "The executing agent cannot change the task's project route. Exit through hold_agent_task with this same 8-section receipt and this refusal text under Limitations, so an operator can set or repair the route (admin_amend_agent_task, or publish-route-snapshot.mjs after fixing the local registry) and the work is not lost.";
export const RECEIPT_REPAIR_HINT =
  "Fix the receipt and call complete_agent_task again with the same claim_token.";

function snapshotWarning(slug: string, detail: string): CompletionWarning {
  return {
    code: "ROUTE_SNAPSHOT_UNAVAILABLE",
    message:
      `Route snapshot for project_slug '${slug}' is unavailable (${detail}); the route was not checked at complete time. The completion was accepted; the closeout controller still checks the real route at apply. If this repeats, run scripts/open-engine/publish-route-snapshot.mjs on the operator's machine.`,
  };
}

// Route reasons for a present slug, or the warning that replaces them. A stale
// snapshot is unavailable before its booleans are read: a week-old "false" is
// no more trustworthy than a week-old "true".
export function evaluateRoute(
  slug: string,
  lookup: RouteLookup | null,
  now: Date,
): { reasons: string[]; warnings: CompletionWarning[] } {
  if (!lookup || lookup.error) {
    return {
      reasons: [],
      warnings: [snapshotWarning(slug, `the snapshot read failed: ${lookup?.error ?? "no result"}`)],
    };
  }
  const row = lookup.row;
  if (!row) {
    return { reasons: [], warnings: [snapshotWarning(slug, "no row in closeout_routes")] };
  }
  const publishedMs = row.published_at ? Date.parse(row.published_at) : NaN;
  if (!Number.isFinite(publishedMs)) {
    return {
      reasons: [],
      warnings: [snapshotWarning(slug, `published_at is not a timestamp (${String(row.published_at)})`)],
    };
  }
  const age = now.getTime() - publishedMs;
  if (age > ROUTE_SNAPSHOT_MAX_AGE_MS) {
    return {
      reasons: [],
      warnings: [snapshotWarning(slug, `published ${row.published_at}, older than 7 days`)],
    };
  }
  if (age < -ROUTE_SNAPSHOT_FUTURE_SKEW_MS) {
    return {
      reasons: [],
      warnings: [snapshotWarning(slug, `published_at ${row.published_at} is in the future`)],
    };
  }
  const caps: Record<string, unknown> = {};
  for (const { field } of ROUTE_CAPABILITIES) caps[field] = row[field as keyof RouteSnapshotRow];
  return { reasons: routeCapabilityReasons(caps), warnings: [] };
}

export function evaluateCompletion(input: {
  receipt: string;
  task: CompletionTask;
  route: RouteLookup | null;
  now: Date;
}): CompletionVerdict {
  // reviewReason is null on purpose: move_agent_task_status writes this receipt
  // into review_reason, so at apply the "note" is the receipt itself and
  // augmentation adds nothing. Judging the receipt alone here is the same answer.
  const contract = evaluateReceiptContract({
    receiptText: input.receipt,
    reviewReason: null,
    desiredOutcome: input.task.desired_outcome ?? null,
    title: input.task.title ?? null,
  });
  const staticReasons = [...new Set(contract.reasons)];

  const slug = typeof input.task.project_slug === "string"
    ? input.task.project_slug.trim()
    : "";
  let routeReasons: string[] = [];
  let warnings: CompletionWarning[] = [];
  if (!slug) {
    routeReasons = ["MISSING_PROJECT_SLUG"];
  } else {
    const route = evaluateRoute(slug, input.route, input.now);
    routeReasons = route.reasons;
    warnings = route.warnings;
  }

  const reasons = [...new Set([...staticReasons, ...routeReasons])];
  if (reasons.length === 0) return { ok: true, warnings };

  const hints = [];
  if (staticReasons.length > 0) hints.push(RECEIPT_REPAIR_HINT);
  if (routeReasons.length > 0) hints.push(ROUTE_REPAIR_HINT);
  const message = [
    `COMPLETE_REFUSED (${reasons.join(", ")}). Nothing was written; the task is unchanged.`,
    holdMessage(reasons, contract.augmentation),
    ...hints,
  ].join(" ");
  return {
    ok: false,
    repairable: true,
    reasons,
    static_reasons: staticReasons,
    route_reasons: routeReasons,
    message,
  };
}
