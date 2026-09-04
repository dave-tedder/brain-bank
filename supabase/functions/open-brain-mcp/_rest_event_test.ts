// Run: deno test supabase/functions/open-brain-mcp/_rest_event_test.ts
import { assertEquals } from "jsr:@std/assert@1.0.19";
import { buildRestEventUpdate } from "./_rest_event.ts";

// Exactly what integrations/calendar-sync/script.gs posts (Step 1 payload).
const calendarBody = {
  title: "Sample Client - Samurai and Tiger Leg Sleeve",
  event_type: "tattoo_session",
  date_start: "2026-09-13",
  date_end: "2026-09-13",
  location: null,
  notes: "Deposit paid",
  metadata: {
    gcal_event_id: "abc123evt@google.com",
    attendees: ["client@example.com"],
    calendar: "operator@example.com",
    start_time: "12:00",
    end_time: "17:00",
    all_day: false,
  },
};

// A row the CRM push owns, as external-crm-sync/_sync.ts stamps it.
const pushedRowMetadata = {
  gcal_event_id: "abc123evt@google.com",
  attendees: ["client@example.com"],
  calendar: "operator@example.com",
  start_time: "11:00",
  end_time: "16:00",
  all_day: false,
  crm_appointment_id: "00000000-0000-5000-8000-000000000001",
  crm_client_id: "00000000-0000-5000-8000-000000000002",
  source: "external-crm",
  status: "scheduled",
  kind: "session",
  pushed_at: "2026-09-04T02:48:28Z",
};

Deno.test("/event update keeps the other writer's keys AND applies the payload's own", () => {
  const patch = buildRestEventUpdate(calendarBody, pushedRowMetadata);
  const md = patch.metadata!;
  // The calendar sync's fields moved to the payload's values.
  assertEquals(md.start_time, "12:00");
  assertEquals(md.end_time, "17:00");
  // The push's keys are untouched.
  assertEquals(md.crm_appointment_id, pushedRowMetadata.crm_appointment_id);
  assertEquals(md.crm_client_id, pushedRowMetadata.crm_client_id);
  assertEquals(md.source, "external-crm");
  assertEquals(md.status, "scheduled");
  assertEquals(md.kind, "session");
  assertEquals(md.pushed_at, "2026-09-04T02:48:28Z");
  assertEquals(Object.keys(md).sort(), Object.keys(pushedRowMetadata).sort());
});

Deno.test("/event update on a row the calendar sync owns alone is unchanged in shape", () => {
  const existing = { ...calendarBody.metadata, start_time: "09:00" };
  const patch = buildRestEventUpdate(calendarBody, existing);
  assertEquals(patch.metadata, calendarBody.metadata);
});

Deno.test("/event update with no existing metadata writes the payload's metadata", () => {
  const patch = buildRestEventUpdate(calendarBody, null);
  assertEquals(patch.metadata, calendarBody.metadata);
});

Deno.test("/event update with no payload metadata leaves the row's metadata standing", () => {
  const { metadata: _drop, ...noMetadata } = calendarBody;
  const patch = buildRestEventUpdate(noMetadata, pushedRowMetadata);
  assertEquals(patch.metadata, pushedRowMetadata);
});

Deno.test("/event update scalar columns keep their existing semantics", () => {
  const patch = buildRestEventUpdate(calendarBody, pushedRowMetadata);
  assertEquals(patch.title, calendarBody.title);
  assertEquals(patch.event_type, "tattoo_session");
  assertEquals(patch.date_start, "2026-09-13");
  assertEquals(patch.date_end, "2026-09-13");
  assertEquals(patch.location, null);
  assertEquals(patch.notes, "Deposit paid");
  const sparse = buildRestEventUpdate({ title: "t" }, null);
  assertEquals(sparse.event_type, null);
  assertEquals(sparse.date_start, null);
  assertEquals(sparse.notes, null);
  assertEquals(sparse.metadata, null);
});
