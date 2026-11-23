import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import {
  actionItemListWindow,
  assertRestoreSelector,
  buildArchiveTransition,
  buildDeferTransition,
  buildResolveTransition,
  buildRestoreTransition,
  stateGuardError,
} from "./_action_items.ts";

const ID = "11111111-0000-4000-8000-000000000001";

Deno.test("resolve goes through the guarded transition with a done reason and a trimmed note", () => {
  const args = buildResolveTransition(ID, "  Done via applied task 17d39373  ");
  assertEquals(args.from, ["open"]);
  assertEquals(args.to, "resolved");
  assertEquals(args.closeReason, "done");
  assertEquals(args.resolutionNote, "Done via applied task 17d39373");
  assertEquals(args.actor, "operator");
  assertEquals(args.eventPayload, { actor_source: "mcp-shared-key" });
});

Deno.test("every note-bearing verb rejects an empty or over-long reason", () => {
  for (const build of [
    (r: string) => buildResolveTransition(ID, r),
    (r: string) => buildDeferTransition(ID, r),
    (r: string) => buildArchiveTransition(ID, r, "expired"),
  ]) {
    assertThrows(() => build(""), Error, "reason");
    assertThrows(() => build("   "), Error, "reason");
    assertThrows(() => build("x".repeat(501)), Error, "500");
  }
});

Deno.test("archive is legal from open and deferred and carries its reason and survivor", () => {
  const args = buildArchiveTransition(ID, "older copy", "duplicate", "22222222-0000-4000-8000-000000000002");
  assertEquals(args.from, ["open", "deferred"]);
  assertEquals(args.to, "archived");
  assertEquals(args.closeReason, "duplicate");
  assertEquals(args.duplicateOf, "22222222-0000-4000-8000-000000000002");
  assertEquals(args.resolutionNote, "older copy");
});

Deno.test("defer carries the pause tag and only leaves open", () => {
  const args = buildDeferTransition(ID, "paused-project:some-project");
  assertEquals(args.from, ["open"]);
  assertEquals(args.to, "deferred");
  assertEquals(args.deferReason, "paused-project:some-project");
  assertEquals(args.closeReason, undefined);
});

Deno.test("restore by id reopens deferred, archived and resolved rows", () => {
  const args = buildRestoreTransition(ID);
  assertEquals(args.to, "open");
  assertEquals([...args.from].sort(), ["archived", "deferred", "resolved"]);
});

Deno.test("list window is inclusive, defaults to page one, and pages without overlap", () => {
  assertEquals(actionItemListWindow({}), { from: 0, to: 49 });
  assertEquals(actionItemListWindow({ limit: 10 }), { from: 0, to: 9 });
  assertEquals(actionItemListWindow({ limit: 10, offset: 10 }), { from: 10, to: 19 });
});

Deno.test("restore selector accepts a lone id", () => {
  assertEquals(assertRestoreSelector({ id: "  abc  " }), { id: "abc" });
});

Deno.test("restore selector accepts a lone defer_reason", () => {
  assertEquals(
    assertRestoreSelector({ defer_reason: " paused-project:some-project " }),
    { defer_reason: "paused-project:some-project" },
  );
});

Deno.test("restore selector rejects both id and defer_reason", () => {
  assertThrows(
    () => assertRestoreSelector({ id: "abc", defer_reason: "tag" }),
    Error,
    "exactly one",
  );
});

Deno.test("restore selector rejects neither id nor defer_reason", () => {
  assertThrows(
    () => assertRestoreSelector({}),
    Error,
    "exactly one",
  );
});

Deno.test("state guard error distinguishes missing from wrong-status", () => {
  assertEquals(
    stateGuardError("resolve", "open", null),
    "Action item not found.",
  );
  const msg = stateGuardError("defer", "open", { status: "resolved" });
  assertEquals(
    msg.includes("resolved") && msg.includes("open") && msg.includes("defer"),
    true,
  );
});

Deno.test("the restore tool's help states the bulk path's snapshot semantics", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  const start = source.indexOf('"Operator-gated reopen.');
  const help = source.slice(start, source.indexOf("\n", start));
  assertEquals(start > 0, true);
  assertEquals(help.includes("restores every DEFERRED"), false);
  assertEquals(help.includes("a row tagged after it stays deferred"), true);
  assertEquals(help.includes("not that none remain"), true);
});

// ---------------------------------------------------------------------------
// Loop-closing Task 3.3: the review writer's and the unreviewed read's helpers.
// A scripted RpcClient: these tests pin the arguments sent and the reading of
// every reply shape. The real functions are exercised by
// scripts/loop-closing/action-item-review-sql-test.sh.
// ---------------------------------------------------------------------------

import { assertRejects } from "jsr:@std/assert@1.0.19";
import {
  assertUnreviewedListArgs,
  buildReviewActionItemParams,
  listUnreviewedActionItems,
  reviewActionItem,
  type RpcClient,
} from "./_action_items.ts";

const REPLACEMENT = "22222222-0000-4000-8000-000000000002";

function scripted(
  reply: { data: unknown; error: { message: string } | null },
): { db: RpcClient; calls: Array<{ fn: string; args: Record<string, unknown> }> } {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    db: {
      rpc: (fn, args) => {
        calls.push({ fn, args });
        return Promise.resolve(reply);
      },
    },
  };
}

Deno.test("review params: the six SQL parameter names, an omitted optional as null", () => {
  assertEquals(
    buildReviewActionItemParams({ id: ID, outcome: "keep", actor: "triage" }),
    {
      p_item_id: ID,
      p_outcome: "keep",
      p_actor: "triage",
      p_disposition: null,
      p_evidence: null,
      p_replacement_id: null,
    },
  );
});

Deno.test("review params: a supplied value is passed as it is, an empty string included", () => {
  assertEquals(
    buildReviewActionItemParams({
      id: ID,
      outcome: "proposal",
      actor: "operator",
      disposition: "duplicate",
      evidence: "",
      replacement_id: REPLACEMENT,
    }),
    {
      p_item_id: ID,
      p_outcome: "proposal",
      p_actor: "operator",
      p_disposition: "duplicate",
      p_evidence: "",
      p_replacement_id: REPLACEMENT,
    },
  );
});

Deno.test("reviewActionItem: calls review_action_item once and passes the reply through", async () => {
  const s = scripted({ data: [{ status: "recorded", message: "kept 11111111" }], error: null });
  const r = await reviewActionItem(s.db, { id: ID, outcome: "keep", actor: "triage" });
  assertEquals(r, { status: "recorded", message: "kept 11111111" });
  assertEquals(s.calls.length, 1);
  assertEquals(s.calls[0].fn, "review_action_item");
  assertEquals(s.calls[0].args.p_item_id, ID);
});

Deno.test("reviewActionItem: refused and not_found are answers, not errors", async () => {
  for (const status of ["refused", "not_found"]) {
    const s = scripted({ data: [{ status, message: "m" }], error: null });
    assertEquals(
      await reviewActionItem(s.db, { id: ID, outcome: "keep", actor: "operator" }),
      { status, message: "m" },
    );
  }
});

Deno.test("reviewActionItem: an RPC error is an error carrying the database's message", async () => {
  const s = scripted({ data: null, error: { message: "A proposal requires evidence." } });
  assertEquals(
    await reviewActionItem(s.db, { id: ID, outcome: "proposal", actor: "operator", disposition: "stale" }),
    { status: "error", message: "A proposal requires evidence." },
  );
});

Deno.test("reviewActionItem: no row, an unknown status or a missing message is never success", async () => {
  const replies: unknown[] = [
    [],
    null,
    [{ status: "ok", message: "m" }],
    [{ status: "recorded" }],
    [{ message: "kept" }],
    [{ status: "recorded", message: 7 }],
  ];
  for (const data of replies) {
    const s = scripted({ data, error: null });
    const r = await reviewActionItem(s.db, { id: ID, outcome: "keep", actor: "operator" });
    assertEquals(r.status, "error", JSON.stringify(data));
  }
});

Deno.test("unreviewed list args: include_deferred and order newest are refused, not ignored", () => {
  assertThrows(() => assertUnreviewedListArgs({ include_deferred: true }), Error, "include_deferred");
  assertThrows(() => assertUnreviewedListArgs({ order: "newest" }), Error, "newest");
  assertUnreviewedListArgs({});
  assertUnreviewedListArgs({ include_deferred: false, order: "oldest" });
});

Deno.test("listUnreviewedActionItems: sends the three SQL parameter names with the default window", async () => {
  const s = scripted({ data: [], error: null });
  await listUnreviewedActionItems(s.db, { unreviewed_days: 14 });
  assertEquals(s.calls, [{
    fn: "list_unreviewed_action_items",
    args: { p_unreviewed_days: 14, p_limit: 50, p_offset: 0 },
  }]);
});

Deno.test("listUnreviewedActionItems: limit and offset reach the function unchanged", async () => {
  const s = scripted({ data: [], error: null });
  await listUnreviewedActionItems(s.db, { unreviewed_days: 30, limit: 7, offset: 21 });
  assertEquals(s.calls[0].args, { p_unreviewed_days: 30, p_limit: 7, p_offset: 21 });
});

Deno.test("listUnreviewedActionItems: the total comes off the rows and is not left on the items", async () => {
  const s = scripted({
    data: [
      { id: ID, description: "a", unreviewed_total: 9 },
      { id: REPLACEMENT, description: "b", unreviewed_total: 9 },
    ],
    error: null,
  });
  const page = await listUnreviewedActionItems(s.db, { unreviewed_days: 14, limit: 2 });
  assertEquals(page.unreviewed_total, 9);
  assertEquals(page.items.map((i) => i.id), [ID, REPLACEMENT]);
  assertEquals("unreviewed_total" in page.items[0], false);
});

Deno.test("listUnreviewedActionItems: an empty first page is a total of 0; an empty later page is unknown", async () => {
  const first = await listUnreviewedActionItems(scripted({ data: [], error: null }).db, { unreviewed_days: 14 });
  assertEquals(first, { items: [], unreviewed_total: 0 });
  const later = await listUnreviewedActionItems(
    scripted({ data: [], error: null }).db,
    { unreviewed_days: 14, offset: 50 },
  );
  assertEquals(later, { items: [], unreviewed_total: null });
});

Deno.test("listUnreviewedActionItems: an error, a non-array reply or a row without a total throws", async () => {
  await assertRejects(
    () => listUnreviewedActionItems(scripted({ data: null, error: { message: "boom" } }).db, { unreviewed_days: 14 }),
    Error,
    "boom",
  );
  await assertRejects(
    () => listUnreviewedActionItems(scripted({ data: { id: ID }, error: null }).db, { unreviewed_days: 14 }),
    Error,
    "no readable rows",
  );
  await assertRejects(
    () => listUnreviewedActionItems(scripted({ data: [{ id: ID }], error: null }).db, { unreviewed_days: 14 }),
    Error,
    "unreviewed_total",
  );
  // A total smaller than the page it came with cannot be right.
  await assertRejects(
    () =>
      listUnreviewedActionItems(
        scripted({ data: [{ id: ID, unreviewed_total: 1 }, { id: REPLACEMENT, unreviewed_total: 1 }], error: null }).db,
        { unreviewed_days: 14 },
      ),
    Error,
    "unreviewed_total",
  );
});
