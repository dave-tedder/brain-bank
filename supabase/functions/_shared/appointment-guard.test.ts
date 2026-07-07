// Deno unit tests for the appointment extraction guard.
// Run: deno test supabase/functions/_shared/appointment-guard.test.ts
//
// Rule: appointment-shaped extracted action items are review-only — skip
// storing them as open items — UNLESS the source carries explicit still-owed
// language or a future-date signal. Fixtures are synthetic equivalents of the
// real rows that motivated the guard.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isUnanchoredAppointmentItem } from "./appointment-guard.ts";

const NOW = new Date("2026-07-06T12:00:00Z");

Deno.test("non-appointment item is never skipped", () => {
  assertEquals(
    isUnanchoredAppointmentItem(
      "Fix the nav menu on the website",
      "Fix the nav menu on the website",
      NOW,
    ),
    false,
  );
});

Deno.test("bare imperative appointment item with no date is skipped", () => {
  const item = "Schedule Appointment - Alex Smith - Project Session 3";
  assertEquals(isUnanchoredAppointmentItem(item, item, NOW), true);
});

Deno.test("prepare-for-appointment item with no date is skipped", () => {
  const item = "Prepare for appointment with Jordan Lee";
  assertEquals(isUnanchoredAppointmentItem(item, item, NOW), true);
});

Deno.test("still-owed language in the item keeps it", () => {
  const item = "need to schedule Appointment for Jordan Lee";
  assertEquals(isUnanchoredAppointmentItem(item, item, NOW), false);
});

Deno.test("todo marker keeps it", () => {
  const item = "TODO: client appointment on May 30th 1pm-7pm";
  assertEquals(isUnanchoredAppointmentItem(item, item, NOW), false);
});

Deno.test("still-owed language in the surrounding content keeps it", () => {
  const item = "Prepare for appointment with Jordan Lee";
  const content =
    "Notes from today. Jordan confirmed sizing. We still need to schedule the follow-up before his deployment.";
  assertEquals(isUnanchoredAppointmentItem(item, content, NOW), false);
});

Deno.test("future ISO date keeps it", () => {
  const item = "Consultation with Casey Reed on 2026-12-01";
  assertEquals(isUnanchoredAppointmentItem(item, item, NOW), false);
});

Deno.test("past ISO date without still-owed language is skipped", () => {
  const item = "Client appointment on 2026-05-30 with Alex Smith";
  assertEquals(isUnanchoredAppointmentItem(item, item, NOW), true);
});

Deno.test("past slash date without still-owed language is skipped", () => {
  const item = "Appt on 5/30/2026 for touch-up";
  assertEquals(isUnanchoredAppointmentItem(item, item, NOW), true);
});

Deno.test("future slash date keeps it", () => {
  const item = "Appt on 12/30/2026 for touch-up";
  assertEquals(isUnanchoredAppointmentItem(item, item, NOW), false);
});

Deno.test("month-day without a year is ambiguous and keeps it", () => {
  const item = "Confirm Morgan Blake touch-up appointment on May 11";
  assertEquals(isUnanchoredAppointmentItem(item, item, NOW), false);
});

Deno.test("month-name-with-year in the past is not a future signal", () => {
  const item = "Client appointment May 30, 2026 with Alex Smith";
  assertEquals(isUnanchoredAppointmentItem(item, item, NOW), true);
});

Deno.test("relative future word keeps it", () => {
  const item = "Client appointment tomorrow with Riley";
  assertEquals(isUnanchoredAppointmentItem(item, item, NOW), false);
});

Deno.test("next-week phrasing keeps it", () => {
  const item = "Consultation next week with Dana";
  assertEquals(isUnanchoredAppointmentItem(item, item, NOW), false);
});

Deno.test("bare month names without a day are not a date anchor", () => {
  const item =
    "Schedule client appointment for Jesse Wells in March or April on a Saturday";
  assertEquals(isUnanchoredAppointmentItem(item, item, NOW), true);
});

Deno.test("touch-up shape is recognized", () => {
  const item = "Touch-up for Kevin Yang";
  assertEquals(isUnanchoredAppointmentItem(item, item, NOW), true);
});

Deno.test("consultation shape is recognized", () => {
  const item = "15-minute consultation with Jamie Cole";
  assertEquals(isUnanchoredAppointmentItem(item, item, NOW), true);
});

Deno.test("STILL_OWED_MARKERS vocabulary keeps it (pending)", () => {
  const item = "Client appointment with Cody pending deposit";
  assertEquals(isUnanchoredAppointmentItem(item, item, NOW), false);
});
