// Deno unit tests for the shared metadata merge.
// Run: deno test supabase/functions/_shared/metadata-merge.test.ts
import { assertEquals, assertNotStrictEquals } from "jsr:@std/assert@1.0.19";
import { mergeMetadata } from "./metadata-merge.ts";

// A row the CRM push owns (external-crm-sync stamps), and the payload the Apps
// Script calendar sync posts on its daily pass.
const crmRow = {
  gcal_event_id: "abc123evt@google.com",
  attendees: ["client@example.com"],
  calendar: "operator@example.com",
  start_time: "12:00",
  end_time: "17:00",
  all_day: false,
  crm_appointment_id: "00000000-0000-5000-8000-000000000001",
  crm_client_id: "00000000-0000-5000-8000-000000000002",
  source: "external-crm",
  status: "scheduled",
  kind: "session",
  pushed_at: "2026-09-04T02:48:28Z",
};

const calendarPayload = {
  gcal_event_id: "abc123evt@google.com",
  attendees: ["client@example.com", "second@example.com"],
  calendar: "operator@example.com",
  start_time: "13:00",
  end_time: "18:00",
  all_day: false,
};

Deno.test("mergeMetadata: incoming top-level keys win", () => {
  const merged = mergeMetadata(crmRow, calendarPayload)!;
  assertEquals(merged.start_time, "13:00");
  assertEquals(merged.end_time, "18:00");
  assertEquals(merged.attendees, ["client@example.com", "second@example.com"]);
});

Deno.test("mergeMetadata: keys absent from the payload are left standing", () => {
  const merged = mergeMetadata(crmRow, calendarPayload)!;
  assertEquals(merged.crm_appointment_id, crmRow.crm_appointment_id);
  assertEquals(merged.crm_client_id, crmRow.crm_client_id);
  assertEquals(merged.source, "external-crm");
  assertEquals(merged.status, "scheduled");
  assertEquals(merged.kind, "session");
  assertEquals(merged.pushed_at, "2026-09-04T02:48:28Z");
  assertEquals(Object.keys(merged).length, Object.keys(crmRow).length);
});

Deno.test("mergeMetadata: an explicit null in the payload wins (matches _sync.ts)", () => {
  const merged = mergeMetadata({ a: 1, b: 2 }, { a: null })!;
  assertEquals(merged.a, null);
  assertEquals(merged.b, 2);
  assertEquals("a" in merged, true);
});

Deno.test("mergeMetadata: one level deep, a nested object is replaced not merged", () => {
  const merged = mergeMetadata(
    { nested: { keep: 1, drop: 2 }, other: true },
    { nested: { keep: 9 } },
  )!;
  assertEquals(merged.nested, { keep: 9 });
  assertEquals(merged.other, true);
});

Deno.test("mergeMetadata: no existing metadata returns a copy of the payload", () => {
  const merged = mergeMetadata(null, calendarPayload);
  assertEquals(merged, calendarPayload);
  assertNotStrictEquals(merged, calendarPayload);
  assertEquals(mergeMetadata(undefined, calendarPayload), calendarPayload);
});

Deno.test("mergeMetadata: no incoming metadata leaves the row's metadata standing", () => {
  assertEquals(mergeMetadata(crmRow, null), crmRow);
  assertEquals(mergeMetadata(crmRow, undefined), crmRow);
});

Deno.test("mergeMetadata: neither side an object returns null, not {}", () => {
  assertEquals(mergeMetadata(null, null), null);
  assertEquals(mergeMetadata(undefined, undefined), null);
  assertEquals(mergeMetadata("junk", 42), null);
});

Deno.test("mergeMetadata: arrays and scalars are treated as absent, not spread", () => {
  assertEquals(mergeMetadata(["x"], { a: 1 }), { a: 1 });
  assertEquals(mergeMetadata({ a: 1 }, ["x"]), { a: 1 });
  assertEquals(mergeMetadata({ a: 1 }, "gcal"), { a: 1 });
});

Deno.test("mergeMetadata: neither input is mutated", () => {
  const existing = { a: 1, b: { c: 1 } };
  const incoming = { a: 2 };
  const before = JSON.stringify([existing, incoming]);
  mergeMetadata(existing, incoming);
  assertEquals(JSON.stringify([existing, incoming]), before);
});
