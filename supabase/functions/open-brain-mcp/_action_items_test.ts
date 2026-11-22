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
