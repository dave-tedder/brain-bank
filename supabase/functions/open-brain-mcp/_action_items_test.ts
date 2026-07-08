import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  assertRestoreSelector,
  buildDeferActionItemUpdate,
  buildResolveActionItemUpdate,
  buildRestoreActionItemUpdate,
  stateGuardError,
} from "./_action_items.ts";

const NOW = "2026-07-08T12:00:00.000Z";

Deno.test("resolve update sets resolved status, timestamp, and trimmed note", () => {
  const update = buildResolveActionItemUpdate(
    "  Done via applied task 17d39373  ",
    NOW,
  );
  assertEquals(update, {
    status: "resolved",
    resolved_at: NOW,
    resolution_note: "Done via applied task 17d39373",
  });
});

Deno.test("resolve update rejects empty or whitespace reason", () => {
  assertThrows(() => buildResolveActionItemUpdate("", NOW), Error, "reason");
  assertThrows(() => buildResolveActionItemUpdate("   ", NOW), Error, "reason");
});

Deno.test("resolve update rejects an over-long reason", () => {
  assertThrows(
    () => buildResolveActionItemUpdate("x".repeat(501), NOW),
    Error,
    "500",
  );
});

Deno.test("defer update sets deferred status, timestamp, and pause tag", () => {
  const update = buildDeferActionItemUpdate(
    "paused-project:atlanta-invitational",
    NOW,
  );
  assertEquals(update, {
    status: "deferred",
    deferred_at: NOW,
    defer_reason: "paused-project:atlanta-invitational",
  });
});

Deno.test("defer update rejects empty reason", () => {
  assertThrows(() => buildDeferActionItemUpdate("  ", NOW), Error, "reason");
});

Deno.test("restore update reopens and clears defer fields", () => {
  assertEquals(buildRestoreActionItemUpdate(), {
    status: "open",
    deferred_at: null,
    defer_reason: null,
  });
});

Deno.test("restore selector accepts a lone id", () => {
  assertEquals(assertRestoreSelector({ id: "  abc  " }), { id: "abc" });
});

Deno.test("restore selector accepts a lone defer_reason", () => {
  assertEquals(
    assertRestoreSelector({ defer_reason: " paused-project:atlanta " }),
    { defer_reason: "paused-project:atlanta" },
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
