// supabase/functions/_shared/proposal-review.ts
//
// Loop-closing Task 3.6: the one proposal review handler, shared by the Slack
// reply forms (ingest-thought) and the review_proposal MCP tool (open-brain-mcp).
// Every proposal-writing task (3.2, 4.1, 5.1, 5.2, 5.3) is reviewed through it.
//
// This module resolves the ITEM reference only (outside the lock) and passes the
// decision reference through as text: the review_proposal RPC resolves it under
// the item lock, so a retried `done <item> <decision>` is answered by the same
// locked code that answered the first attempt. All review state lives in the RPC;
// this module validates shapes, refuses what can be refused before any database
// work, and formats the RPC's structured reply.

import { rpcWithDeadlockRetry, type TransitionDb } from "./action-item-transition.ts";

export const REVIEW_VERBS = ["keep", "archive", "done"] as const;
export type ReviewVerb = (typeof REVIEW_VERBS)[number];
export type ReviewActorSource = "slack-signature" | "mcp-shared-key";

const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHORT_ID = /^[0-9a-f]{8}$/;

/** A full uuid or an 8-hex short id, lowercase; nothing else. */
export function isIdRef(ref: string): boolean {
  return FULL_ID.test(ref) || SHORT_ID.test(ref);
}

export type ReviewCommand = {
  verb: ReviewVerb;
  itemRef: string;
  decisionRef: string | null;
};

// The exact Slack forms: `keep <id>`, `archive <id>`, `done <id>`,
// `done <id> <decision-id>`. Nothing else may follow. The verb is matched without
// regard to case and the ids are lowercased, since Slack users type both; anything
// that is not one of these forms is not a review command and is captured as a
// thought exactly as before. keep and archive cannot carry a decision id here.
const COMMAND =
  /^(keep|archive|done)\s+([0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)(?:\s+([0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?))?$/i;

export function parseReviewCommand(text: string): ReviewCommand | null {
  const m = COMMAND.exec(text.trim());
  if (!m) return null;
  const verb = m[1].toLowerCase() as ReviewVerb;
  const decisionRef = m[3] ? m[3].toLowerCase() : null;
  if (decisionRef && verb !== "done") return null;
  return { verb, itemRef: m[2].toLowerCase(), decisionRef };
}

export type ReviewStatus =
  | "recorded"
  | "already_recorded"
  | "refused"
  | "ambiguous"
  | "not_found"
  | "nothing_pending"
  | "needs_decision"
  | "error";

export type ReviewReply = {
  status: ReviewStatus;
  /** The RPC's message, or this module's refusal. */
  message: string;
  /** The reply line for Slack and the MCP tool: short id, description, outcome. */
  text: string;
  itemId: string | null;
  decisionId: string | null;
};

export type ReviewArgs = {
  verb: string;
  itemRef: string;
  decisionRef?: string | null;
  actor: string;
  source: ReviewActorSource;
};

export type ItemResolution =
  | { kind: "one"; itemId: string; description: string }
  | { kind: "none" }
  | { kind: "ambiguous" }
  | { kind: "error"; error: string };

export async function resolveItemRef(db: TransitionDb, ref: string): Promise<ItemResolution> {
  const { data, error } = await db.rpc("resolve_proposal_item", { p_ref: ref });
  if (error) return { kind: "error", error: error.message ?? String(error) };
  if (!Array.isArray(data)) {
    return { kind: "error", error: `resolve_proposal_item returned ${JSON.stringify(data)}` };
  }
  if (data.length === 0) return { kind: "none" };
  if (data.length > 1) return { kind: "ambiguous" };
  const row = data[0] as { item_id?: unknown; description?: unknown };
  if (typeof row.item_id !== "string") {
    return { kind: "error", error: `resolve_proposal_item returned ${JSON.stringify(data)}` };
  }
  return { kind: "one", itemId: row.item_id, description: String(row.description ?? "") };
}

const DESCRIPTION_MAX = 80;

function quoteDescription(description: string): string {
  const d = description.replace(/\s+/g, " ").trim();
  return d.length > DESCRIPTION_MAX ? `${d.slice(0, DESCRIPTION_MAX - 3)}...` : d;
}

function reply(
  status: ReviewStatus,
  message: string,
  item: { itemId: string; description: string } | null,
  decisionId: string | null = null,
): ReviewReply {
  const text = item
    ? `${item.itemId.slice(0, 8)} "${quoteDescription(item.description)}": ${message}`
    : message;
  return { status, message, text, itemId: item?.itemId ?? null, decisionId };
}

/** The refusal for a supplied but empty decision reference; the RPC answers the same text. */
export const EMPTY_DECISION_REF =
  "empty decision id; use the full id or its first 8 characters, or leave it out";

const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  "recorded",
  "already_recorded",
  "refused",
  "ambiguous",
  "not_found",
  "nothing_pending",
  "needs_decision",
]);

export async function reviewProposal(db: TransitionDb, args: ReviewArgs): Promise<ReviewReply> {
  const verb = args.verb.trim().toLowerCase();
  if (!(REVIEW_VERBS as readonly string[]).includes(verb)) {
    return reply("refused", `unknown verb ${args.verb}; use keep, archive or done`, null);
  }
  const itemRef = args.itemRef.trim().toLowerCase();
  // Absent (undefined or null) and SUPPLIED are different inputs. A supplied
  // reference is judged as supplied even when it is empty or only whitespace:
  // normalizing it to "absent" first would turn `archive <item> "   "` into a plain
  // archive of every pending row, and `done <item> ""` into "pick the only one".
  const decisionSupplied = args.decisionRef !== undefined && args.decisionRef !== null;
  const decisionRef = decisionSupplied ? String(args.decisionRef).trim().toLowerCase() : null;

  // Refused before any reference or status work, from every entry point.
  if (decisionSupplied && verb !== "done") {
    return reply("refused", "keep and archive take no decision id", null);
  }
  if (decisionSupplied && decisionRef === "") {
    return reply("refused", EMPTY_DECISION_REF, null);
  }
  if (!isIdRef(itemRef)) {
    return reply("refused", `${args.itemRef} is not an item id; use the full id or its first 8 characters`, null);
  }
  if (decisionRef !== null && !isIdRef(decisionRef)) {
    return reply(
      "refused",
      `${args.decisionRef} is not a decision id; use the full id or its first 8 characters`,
      null,
    );
  }

  const resolved = await resolveItemRef(db, itemRef);
  if (resolved.kind === "error") return reply("error", `lookup failed: ${resolved.error}`, null);
  if (resolved.kind === "none") return reply("not_found", `no proposal on record for ${itemRef}`, null);
  if (resolved.kind === "ambiguous") return reply("ambiguous", "ambiguous, use the full id", null);
  const item = { itemId: resolved.itemId, description: resolved.description };

  const { data, error } = await rpcWithDeadlockRetry(db, "review_proposal", {
    p_item_id: resolved.itemId,
    p_verb: verb,
    p_actor: args.actor,
    p_actor_source: args.source,
    p_decision_ref: decisionRef,
  });
  if (error) return reply("error", `review failed: ${error.message ?? String(error)}`, item);
  const row = Array.isArray(data) ? data[0] : null;
  if (
    !row || typeof row.status !== "string" || !KNOWN_STATUSES.has(row.status) ||
    typeof row.message !== "string"
  ) {
    return reply("error", `review_proposal returned ${JSON.stringify(data)}`, item);
  }
  return reply(
    row.status as ReviewStatus,
    row.message,
    item,
    typeof row.decision_id === "string" ? row.decision_id : null,
  );
}
