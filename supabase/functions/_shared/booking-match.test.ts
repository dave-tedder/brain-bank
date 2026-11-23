// Loop-closing Task 5.3: booking events propose closing scheduling items.
// Run: deno test --allow-read --allow-env supabase/functions/_shared/booking-match.test.ts
//
// The REAL proposeBookingMatches over an in-memory database
// (scripts/loop-closing/client-identity-fake.ts) whose sync_booking_proposals
// re-states 20261121b's (support rows, the same-booking skip, and
// record_decisions' ON CONFLICT DO NOTHING against the calendar lifetime
// unique). The same code against a real
// PostgreSQL cluster, with the real CHECKs, trigger and unique index, is
// client-identity-sql-test.sh's integration bridge; the two event writers'
// real handlers are external-crm-sync/index_test.ts and
// closeout-capture-probe-harness.ts probe M.
//
// The clock is pinned to 2026-11-20 (the date this was built), so "future"
// is fixed: a 2027-01-16 session is future and an April 2026 one is past.

import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import {
  bookingEventIneligible,
  bookingQuote,
  isActiveEvent,
  isSchedulingItem,
  itemDate,
  planBookingProposals,
  proposeBookingMatches,
} from "./booking-match.ts";
import { validateDecisionRow } from "./decisions.ts";
import { FakeDb } from "../../../scripts/loop-closing/client-identity-fake.ts";
// Runtime-bound claims for the TS mutant sweep (Codex re-review 2, N1).
import { claim } from "../../../scripts/loop-closing/claim.ts";

const NOW = new Date("2026-11-20T15:00:00Z");
const CREATED = "2026-11-20T14:00:00Z";
const ALICIA = "a11c1a00-0000-4000-8000-000000000001";
const JAKE_M = "1a4e0000-0000-4000-8000-000000000002";
const JAKE_R = "1a4e0000-0000-4000-8000-000000000003";
const EV = "e7e00000-0000-4000-8000-000000000001";
const CLIENTS = [
  { id: ALICIA, name: "Alicia Brennan", last_contact: "2026-11-01T00:00:00Z", metadata: { crm_id: "cb-alicia" } },
  { id: JAKE_M, name: "Jordan Marlow", last_contact: "2026-10-01T00:00:00Z", metadata: { crm_id: "cb-jake-m" } },
  { id: JAKE_R, name: "Jordan Ruiz", last_contact: "2026-09-01T00:00:00Z", metadata: {} },
];

function session(over: Record<string, unknown> = {}) {
  return {
    id: EV,
    title: "Tattoo session: Alicia Brennan",
    event_type: "tattoo_session",
    date_start: "2027-01-16",
    metadata: { source: "external-crm", status: "scheduled", crm_client_id: "cb-alicia" },
    ...over,
  };
}
function item(n: number, description: string, over: Record<string, unknown> = {}) {
  return {
    id: `a${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`,
    description,
    status: "open",
    client_id: ALICIA,
    created_at: CREATED,
    ...over,
  };
}
async function run(db: FakeDb, eventId = EV) {
  const realLog = console.log;
  const logs: string[] = [];
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    return { result: await proposeBookingMatches(db, eventId), logs };
  } finally {
    console.log = realLog;
  }
}
const calendarRows = (db: FakeDb) => db.tables.auto_resolve_decisions.filter((d) => d.layer === "calendar");

Deno.test("booking match 5.3: the scheduling predicate, after Task 5.1's prefix normalisation", () => {
  const yes = [
    "Schedule tattoo appointment for Alicia Brennan",
    "book a consult with Jordan Marlow",
    "Reschedule Alicia Brennan's session",
    "Set up a consultation for Alicia Brennan",
    "arrange the follow-up appointment",
    "TODO: schedule Alicia's touch-up session",
    "then book the consultation for Jordan Marlow",
  ];
  const no = [
    "send Alicia the design",
    "Ask Alicia to schedule an appointment", // the verb must lead
    "schedule the Instagram post", // no appointment, session or consult
    "booking appointment reminders", // "booking" is not "book"
    "Sessions recap for Alicia",
    "Reschedule Alicia Brennan to March", // the plan's fixture names no session
  ];
  claim(
    "predicate-cases",
    [...yes, ...no].map((d) => [d, isSchedulingItem(d)]),
    [...yes.map((d) => [d, true]), ...no.map((d) => [d, false])],
    "the scheduling predicate admits exactly the scheduling items",
  );
});

Deno.test("booking match 5.3: the item's own date (ISO, or a capitalised month resolved from the creation date)", () => {
  assertEquals(itemDate("Reschedule Alicia Brennan to March", CREATED), "2027-03-01");
  assertEquals(itemDate("Reschedule Alicia Brennan to December", CREATED), "2026-12-01");
  assertEquals(itemDate("Book the session for November 25", CREATED), "2026-11-25");
  assertEquals(itemDate("Book the session for November 3", CREATED), "2027-11-03");
  assertEquals(itemDate("Book the session for March 3, 2028", CREATED), "2028-03-03");
  assertEquals(itemDate("schedule the consult by 2027-02-01", CREATED), "2027-02-01");
  assertEquals(itemDate("schedule the consult between 2027-02-01 and 2027-02-10", CREATED), "2027-02-10");
  assertEquals(itemDate("Schedule tattoo appointment for Alicia Brennan", CREATED), null);
  assertEquals(itemDate("Book Alicia, May need a consult first", CREATED), null);
  assertEquals(itemDate("Book Alicia on May 4", CREATED), "2027-05-04");
  assertEquals(itemDate("book the march session", CREATED), null);
  assertEquals(itemDate("schedule on 2027-02-30", CREATED), null);
});

Deno.test("booking match 5.3: eligibility: type, active status, and a date today or later", () => {
  assertEquals(bookingEventIneligible(session(), "2026-11-20"), null);
  assertEquals(bookingEventIneligible(session({ event_type: "consultation" }), "2026-11-20"), null);
  assertEquals(bookingEventIneligible(session({ event_type: "general" }), "2026-11-20"), "event_type");
  assertEquals(bookingEventIneligible(session({ event_type: "cancelled_session" }), "2026-11-20"), "event_type");
  assertEquals(bookingEventIneligible(session({ metadata: { status: "Cancelled" } }), "2026-11-20"), "cancelled");
  assertEquals(bookingEventIneligible(session({ date_start: "2026-11-19" }), "2026-11-20"), "not_future");
  assertEquals(bookingEventIneligible(session({ date_start: "2026-11-20" }), "2026-11-20"), null);
  assertEquals(bookingEventIneligible(session({ date_start: null }), "2026-11-20"), "no_date");
  assertEquals(isActiveEvent({ metadata: null }), true);
  assertEquals(isActiveEvent({ metadata: { status: "completed" } }), true);
  assertEquals(bookingQuote(session()), "Tattoo session: Alicia Brennan on 2027-01-16");
});

Deno.test("booking match 5.3: Schedule tattoo appointment for Alicia Brennan with her 2027-01-16 session proposes", async () => {
  const db = new FakeDb({ clients: CLIENTS, business_events: [session()], action_items: [item(1, "Schedule tattoo appointment for Alicia Brennan")] });
  const { result } = await run(db);
  const rows = calendarRows(db).map((d) => ({
    layer: d.layer, outcome: d.outcome, reason: d.reason, item_id: d.item_id, evidence_event_id: d.evidence_event_id,
    evidence_thought_id: d.evidence_thought_id, thought_id: d.thought_id, quote: d.quote,
  }));
  claim("alicia-proposes", rows, [{
    layer: "calendar", outcome: "proposed", reason: "booking_match", item_id: item(1, "").id, evidence_event_id: EV,
    evidence_thought_id: null, thought_id: null, quote: "Tattoo session: Alicia Brennan on 2027-01-16",
  }], "one calendar/proposed/booking_match row, typed event evidence, no thought id");
  assertEquals(result, { status: "proposed", proposed: 1 });
  assertEquals(db.rpcCalls.map((c) => c.fn), ["sync_booking_proposals"]);
  assertEquals(db.tables.calendar_proposal_support.length, 1, "the proposal is supported");
});

Deno.test("booking match 5.3: send Alicia the design with the same event does not propose (predicate)", async () => {
  // The item carries Alicia's client_id, so only the predicate stands between it and a proposal.
  const db = new FakeDb({ clients: CLIENTS, business_events: [session()], action_items: [item(2, "send Alicia the design")] });
  const { result } = await run(db);
  claim("predicate-blocks", calendarRows(db).length, 0, "a non-scheduling item of the same client is never proposed");
  assertEquals(result.status, "no_match");
});

Deno.test("booking match 5.3: Reschedule Alicia Brennan to March does not propose against an event before the item's date", async () => {
  // The plan's case: the April 2026 event. It is refused on more than one
  // ground: the event is past, and the plan's text names no appointment,
  // session or consult, so it also fails the predicate.
  const april = new FakeDb({
    clients: CLIENTS,
    business_events: [session({ date_start: "2026-04-14" })],
    action_items: [item(3, "Reschedule Alicia Brennan to March")],
  });
  assertEquals((await run(april)).result.status, "skipped_not_future");
  assertEquals(calendarRows(april).length, 0);
  // The date rule on its own, with scheduling wording: a FUTURE event
  // (2027-01-16) before the item's date (March 2027) proposes nothing, and an
  // item dated on or before the event (January 2027) is proposed.
  const db = new FakeDb({
    clients: CLIENTS,
    business_events: [session()],
    action_items: [item(3, "Reschedule Alicia Brennan's session to March"), item(4, "Reschedule Alicia Brennan's session to January")],
  });
  await run(db);
  claim(
    "date-order",
    calendarRows(db).map((d) => d.item_id),
    [item(4, "").id],
    "March (2027-03-01) is after the 2027-01-16 session: no proposal; January (2027-01-01) is before it: proposed",
  );
});

Deno.test("booking match 5.3: a cancelled event proposes nothing", async () => {
  const db = new FakeDb({
    clients: CLIENTS,
    business_events: [session({ metadata: { source: "external-crm", status: "cancelled", crm_client_id: "cb-alicia" } })],
    action_items: [item(1, "Schedule tattoo appointment for Alicia Brennan")],
  });
  const { result } = await run(db);
  claim("cancelled-nothing", calendarRows(db).length, 0, "an event whose metadata.status is cancelled proposes nothing");
  assertEquals(result.status, "skipped_cancelled");
});

Deno.test("booking match 5.3: an item with client_id null (nudge Jordan) is never proposed", async () => {
  const db = new FakeDb({
    clients: CLIENTS,
    business_events: [session({ title: "Consultation: Jordan Marlow", event_type: "consultation", metadata: { status: "scheduled", crm_client_id: "cb-jake-m" } })],
    action_items: [
      item(5, "nudge Jordan if nothing arrives", { client_id: null }),
      item(6, "Schedule a consult for Jordan", { client_id: null }),
    ],
  });
  const { result } = await run(db);
  claim("null-client-never", calendarRows(db).length, 0, "items without a client are never candidates");
  assertEquals(result.status, "no_match");
  // The candidates come from the one read, by client_id, never by text.
  assert(db.reads.some((r) => r.table === "booking_match_read"));
});

Deno.test("booking match 5.3: another client's scheduling item is never proposed", async () => {
  const db = new FakeDb({
    clients: CLIENTS,
    business_events: [session()],
    action_items: [item(7, "Schedule tattoo appointment for Jordan Marlow", { client_id: JAKE_M })],
  });
  await run(db);
  assertEquals(calendarRows(db).length, 0);
});

Deno.test("booking match 5.3: a re-fired write of the same event never proposes twice", async () => {
  const db = new FakeDb({ clients: CLIENTS, business_events: [session()], action_items: [item(1, "Schedule tattoo appointment for Alicia Brennan")] });
  assertEquals((await run(db)).result, { status: "proposed", proposed: 1 });
  assertEquals((await run(db)).result, { status: "proposed", proposed: 0 });
  assertEquals(calendarRows(db).length, 1);
  // A different active event for the same item can propose.
  db.tables.business_events.push(session({ id: "e7e00000-0000-4000-8000-000000000002", date_start: "2027-02-01" }));
  assertEquals((await run(db, "e7e00000-0000-4000-8000-000000000002")).result.proposed, 1);
  assertEquals(calendarRows(db).length, 2);
});

Deno.test("booking match 5.3: one event matching several items writes them in ONE sync call", async () => {
  const db = new FakeDb({
    clients: CLIENTS,
    business_events: [session()],
    action_items: [
      item(9, "Book Alicia Brennan's session"),
      item(8, "Schedule tattoo appointment for Alicia Brennan"),
      item(10, "send Alicia the design"),
    ],
  });
  await run(db);
  const calls = db.rpcCalls.filter((c) => c.fn === "sync_booking_proposals");
  claim(
    "one-call-several-items",
    calls.map((c) => (c.args.p_rows as Array<Record<string, unknown>>).map((r) => r.item_id).sort()),
    [[item(8, "").id, item(9, "").id]],
    "both scheduling items in one sync call",
  );
  for (const r of calls[0].args.p_rows as Array<Record<string, unknown>>) {
    const { client_id: _c, ...payload } = r;
    assertEquals(validateDecisionRow(payload), null);
    assertEquals(r.client_id, ALICIA);
  }
});

Deno.test("booking match 5.3: proposals only, nothing resolves and no item is written", async () => {
  const db = new FakeDb({ clients: CLIENTS, business_events: [session()], action_items: [item(1, "Schedule tattoo appointment for Alicia Brennan")] });
  await run(db);
  claim(
    "proposal-only",
    {
      rpcs: db.rpcCalls.map((c) => c.fn),
      itemWrites: db.writes.filter((w) => w.table === "action_items").length,
      statuses: db.tables.action_items.map((a) => a.status),
      outcomes: db.tables.auto_resolve_decisions.map((d) => d.outcome),
    },
    { rpcs: ["sync_booking_proposals"], itemWrites: 0, statuses: ["open"], outcomes: ["proposed"] },
    "only a proposed decision row is written",
  );
});

Deno.test("booking match 5.3: the client resolves by the CRM id, else by the title with the item rule", async () => {
  // No the CRM id: the title names Alicia Brennan in full.
  const byTitle = new FakeDb({
    clients: CLIENTS,
    business_events: [session({ metadata: { source: "dash-bot-create" } })],
    action_items: [item(1, "Schedule tattoo appointment for Alicia Brennan")],
  });
  assertEquals((await run(byTitle)).result.proposed, 1);
  // A title naming "Jordan" (two clients) resolves no client.
  const jake = new FakeDb({
    clients: CLIENTS,
    business_events: [session({ title: "Consult Jordan", metadata: {} })],
    action_items: [item(1, "Schedule tattoo appointment for Jordan", { client_id: JAKE_M })],
  });
  assertEquals((await run(jake)).result.status, "no_client");
  // The the CRM id wins over the title.
  const cb = new FakeDb({
    clients: CLIENTS,
    business_events: [session({ title: "Tattoo session", metadata: { crm_client_id: "cb-jake-m" } })],
    action_items: [item(11, "Book Jordan's session", { client_id: JAKE_M }), item(12, "Book Alicia's session")],
  });
  await run(cb);
  assertEquals(calendarRows(cb).map((d) => d.item_id), [item(11, "").id]);
  // A the CRM id matching two clients rows proposes nothing.
  const twice = new FakeDb({
    clients: [...CLIENTS, { id: "dup00000-0000-4000-8000-000000000009", name: "Alicia B.", metadata: { crm_id: "cb-alicia" } }],
    business_events: [session()],
    action_items: [item(1, "Schedule tattoo appointment for Alicia Brennan")],
  });
  assertEquals((await run(twice)).result.status, "no_client");
});

Deno.test("booking match 5.3: the sync is retried on 40P01; a failure is logged, never thrown", async () => {
  const db = new FakeDb({ clients: CLIENTS, business_events: [session()], action_items: [item(1, "Schedule tattoo appointment for Alicia Brennan")] });
  db.failNext["rpc/sync_booking_proposals"] = [{ code: "40P01", message: "deadlock detected" }];
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    assertEquals((await run(db)).result, { status: "proposed", proposed: 1 });
  } finally {
    console.warn = realWarn;
  }
  assertEquals(db.rpcCalls.filter((c) => c.fn === "sync_booking_proposals").length, 2);
  const bad = new FakeDb({ clients: CLIENTS, business_events: [session()], action_items: [item(1, "Schedule tattoo appointment for Alicia Brennan")] });
  bad.failNext["rpc/sync_booking_proposals"] = [{ code: "23514", message: "check violation" }];
  const realErr = console.error;
  const errors: string[] = [];
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  try {
    assertEquals((await run(bad)).result.status, "write_failed");
  } finally {
    console.error = realErr;
  }
  assertEquals(bad.rpcCalls.filter((c) => c.fn === "sync_booking_proposals").length, 1, "a CHECK refusal is not retried");
  assertEquals(errors.length, 1);
});

Deno.test("booking match 5.3: an unreadable or missing event, and a db that throws, never throw", async () => {
  const missing = new FakeDb({ clients: CLIENTS });
  assertEquals((await run(missing)).result.status, "event_missing");
  const broken = { from() { throw new Error("boom"); }, rpc() { throw new Error("boom"); } };
  const realErr = console.error;
  console.error = () => {};
  try {
    const realLog = console.log;
    console.log = () => {};
    try {
      assertEquals((await proposeBookingMatches(broken, EV)).status, "threw");
    } finally {
      console.log = realLog;
    }
  } finally {
    console.error = realErr;
  }
});

Deno.test("booking match 5.3: planBookingProposals skips closed items and refuses an ineligible event", () => {
  const ev = session();
  assertEquals(planBookingProposals(ev, [item(1, "Schedule tattoo appointment for Alicia Brennan", { status: "resolved" })], "2026-11-20"), []);
  assertEquals(planBookingProposals(session({ event_type: "general" }), [item(1, "Schedule tattoo appointment for Alicia Brennan")], "2026-11-20"), []);
  assertEquals(planBookingProposals(ev, [item(1, "Schedule tattoo appointment for Alicia Brennan")], "2026-11-20").length, 1);
});

Deno.test("booking match 5.3: an item dated on the event's own day is proposed (the date bound is inclusive)", async () => {
  const db = new FakeDb({
    clients: CLIENTS,
    business_events: [session()],
    action_items: [item(20, "Book Alicia Brennan's session for 2027-01-16"), item(21, "Book Alicia Brennan's session for January 16")],
  });
  await run(db);
  claim(
    "equal-date-proposes",
    calendarRows(db).map((d) => d.item_id).sort(),
    [item(20, "").id, item(21, "").id],
    "an item whose own date equals date_start is on or before it",
  );
});

Deno.test("booking match 5.3: a client's name is not a month, and a month-only phrase is a date", async () => {
  const june = { id: "j0000000-0000-4000-8000-000000000001", name: "June Bell", last_contact: "2026-11-01", metadata: { crm_id: "cb-june" } };
  const db = new FakeDb({
    clients: [...CLIENTS, june],
    business_events: [
      session(),
      session({ id: "e7e00000-0000-4000-8000-0000000000aa", title: "Session: June Bell", metadata: { crm_client_id: "cb-june" } }),
    ],
    action_items: [
      item(30, "Book a session for June Bell", { client_id: june.id }),
      item(31, "Book Alicia Brennan's session for May"),
      item(32, "Book Alicia Brennan's session, May need a consult first"),
    ],
  });
  await run(db);
  await run(db, "e7e00000-0000-4000-8000-0000000000aa");
  claim(
    "names-and-month-phrases",
    {
      june: calendarRows(db).filter((d) => d.item_id === item(30, "").id).length,
      forMay: calendarRows(db).filter((d) => d.item_id === item(31, "").id).length,
      mayVerb: calendarRows(db).filter((d) => d.item_id === item(32, "").id).length,
    },
    { june: 1, forMay: 0, mayVerb: 1 },
    "June Bell is a name, not June; 'for May' (2027-05-01) is after 2027-01-16; 'May need' is the verb",
  );
  assertEquals(itemDate("Book a session for June Bell", CREATED, ["June Bell"]), null);
  assertEquals(itemDate("Book a session for June Bell", CREATED), "2027-06-01");
  assertEquals(itemDate("Book Alicia's session in May", CREATED), "2027-05-01");
});

Deno.test("booking match 5.3: a reassigned, cancelled or moved event withdraws its support, so the proposal is no longer shown", async () => {
  const db = new FakeDb({ clients: CLIENTS, business_events: [session()], action_items: [item(1, "Schedule tattoo appointment for Alicia Brennan")] });
  await run(db);
  assertEquals(db.tables.calendar_proposal_support.length, 1);
  // reassigned to Jordan Marlow
  Object.assign(db.tables.business_events[0], { title: "Consultation: Jordan Marlow", event_type: "consultation", metadata: { status: "scheduled", crm_client_id: "cb-jake-m" } });
  await run(db);
  const reassigned = db.tables.calendar_proposal_support.length;
  // back to Alicia, then cancelled
  Object.assign(db.tables.business_events[0], session());
  await run(db);
  const restored = db.tables.calendar_proposal_support.length;
  Object.assign(db.tables.business_events[0], session({ metadata: { status: "cancelled", crm_client_id: "cb-alicia" } }));
  await run(db);
  const cancelled = db.tables.calendar_proposal_support.length;
  Object.assign(db.tables.business_events[0], session());
  await run(db);
  const restoredAgain = db.tables.calendar_proposal_support.length;
  // no client can be resolved any more
  Object.assign(db.tables.business_events[0], session({ title: "Session", metadata: { status: "scheduled", crm_client_id: "cb-unknown" } }));
  await run(db);
  const unresolved = db.tables.calendar_proposal_support.length;
  claim(
    "reassigned-withdrawn",
    { reassigned, restored, cancelled, restoredAgain, unresolved, decisions: calendarRows(db).length },
    { reassigned: 0, restored: 1, cancelled: 0, restoredAgain: 1, unresolved: 0, decisions: 1 },
    "support follows the event; the decision row stays, unduplicated",
  );
  // moved before an item's own date
  const moved = new FakeDb({ clients: CLIENTS, business_events: [session({ date_start: "2027-04-01" })], action_items: [item(4, "Reschedule Alicia Brennan's session to March")] });
  await run(moved);
  assertEquals(moved.tables.calendar_proposal_support.length, 1);
  moved.tables.business_events[0].date_start = "2027-02-01";
  await run(moved);
  assertEquals(moved.tables.calendar_proposal_support.length, 0, "moved before the item's date: withdrawn");
});

Deno.test("booking match 5.3: a second event row for the same booking does not propose the item again", async () => {
  const gcal = (id: string, key: string | null, over: Record<string, unknown> = {}) =>
    session({ id, metadata: { status: "scheduled", crm_client_id: "cb-alicia", ...(key ? { gcal_event_id: key } : {}) }, ...over });
  const db = new FakeDb({
    clients: CLIENTS,
    business_events: [
      gcal("e1000000-0000-4000-8000-000000000001", "race-rest@google.com"),
      gcal("e1000000-0000-4000-8000-000000000002", "race-rest"),
      gcal("e1000000-0000-4000-8000-000000000003", "other-booking"),
      gcal("e1000000-0000-4000-8000-000000000004", null, { date_start: "2027-03-01" }),
    ],
    action_items: [item(1, "Schedule tattoo appointment for Alicia Brennan")],
  });
  for (const id of ["e1000000-0000-4000-8000-000000000001", "e1000000-0000-4000-8000-000000000002", "e1000000-0000-4000-8000-000000000003", "e1000000-0000-4000-8000-000000000004"]) {
    await run(db, id);
  }
  claim(
    "same-booking-once",
    calendarRows(db).map((d) => d.evidence_event_id).sort(),
    ["e1000000-0000-4000-8000-000000000001", "e1000000-0000-4000-8000-000000000003", "e1000000-0000-4000-8000-000000000004"],
    "the same Google event key (either form) proposes once; a different key, or no key and another date, is another booking",
  );
});

Deno.test("booking match 5.3: the client's open items are one read, whatever the server row cap", async () => {
  const many = Array.from({ length: 1001 }, (_, i) => item(1000 + i, i === 1000 ? "Schedule tattoo appointment for Alicia Brennan" : `send Alicia note ${i}`));
  const db = new FakeDb({ clients: CLIENTS, business_events: [session()], action_items: many });
  await run(db);
  // under a 100-row server cap every item is still read: the answer is one jsonb value
  const capped = new FakeDb({ clients: CLIENTS, business_events: [session()], action_items: many });
  capped.rowCap = 100;
  await run(capped);
  claim(
    "items-one-read",
    {
      uncapped: calendarRows(db).map((d) => d.item_id),
      capped: calendarRows(capped).map((d) => d.item_id),
      reads: db.reads.map((r) => r.filters.join()),
    },
    { uncapped: [item(2000, "").id], capped: [item(2000, "").id], reads: ["rpc booking_match_read"] },
    "the scheduling item last in id order is proposed, with and without a 100-row server cap, from one read",
  );
});

Deno.test("booking match 5.3: a partial or over-cap item answer proposes nothing and sends no sync", async () => {
  // The one read's answer with its item list altered: a count the rows do not
  // add up to, or the rows left out (over the cap).
  const outcome = async (alter: (a: Record<string, unknown>) => Record<string, unknown>) => {
    const db = new FakeDb({ clients: CLIENTS, business_events: [session()], action_items: [item(1, "Schedule tattoo appointment for Alicia Brennan")] });
    await run(db);
    const realRpc = db.rpc.bind(db);
    db.rpc = async (fn: string, args: Record<string, unknown>) => {
      const r = await realRpc(fn, args);
      return fn === "booking_match_read" ? { data: alter(r.data as Record<string, unknown>), error: null } : r;
    };
    const realErr = console.error;
    console.error = () => {};
    try {
      return { result: (await run(db)).result.status, support: db.tables.calendar_proposal_support.length, syncs: db.rpcCalls.length };
    } finally {
      console.error = realErr;
    }
  };
  claim(
    "items-partial-refused",
    {
      partial: await outcome((a) => ({ ...a, items_total: (a.items_total as number) + 1 })),
      overCap: await outcome((a) => ({ ...a, items_total: 20001, items: null })),
    },
    { partial: { result: "items_unreadable", support: 1, syncs: 1 }, overCap: { result: "items_unreadable", support: 1, syncs: 1 } },
    "an answer whose rows do not add up to its count, or that leaves them out, is no answer: nothing is withdrawn",
  );
});

Deno.test("booking match 5.3: the client's name is masked only where it is mentioned, so its own date still counts", async () => {
  const june = { id: "j0000000-0000-4000-8000-000000000001", name: "June Bell", last_contact: "2026-11-01", metadata: { crm_id: "cb-june" } };
  const db = new FakeDb({
    clients: [...CLIENTS, june],
    business_events: [session({ title: "Session: June Bell", metadata: { crm_client_id: "cb-june" } })],
    action_items: [
      item(70, "Book a session for June Bell on June 15, 2027", { client_id: june.id }),
      item(71, "Book a session for June Bell", { client_id: june.id }),
    ],
  });
  await run(db);
  claim(
    "name-span-masked",
    calendarRows(db).map((d) => d.item_id),
    [item(71, "").id],
    "June 15, 2027 is after the 2027-01-16 session: no proposal; the bare name is not a date: proposed",
  );
  assertEquals(itemDate("Book a session for June Bell on June 15, 2027", CREATED, ["June Bell"]), "2027-06-15");
});

Deno.test("booking match 5.3: a client read error skips the sync, so existing support stays", async () => {
  const db = new FakeDb({ clients: CLIENTS, business_events: [session()], action_items: [item(1, "Schedule tattoo appointment for Alicia Brennan")] });
  await run(db);
  const before = db.tables.calendar_proposal_support.length;
  const realErr = console.error;
  console.error = () => {};
  let unreadable, partial, overCap;
  try {
    // the one read failing
    db.failNext.clients = [{ message: "roster down" }];
    unreadable = (await run(db)).result;
    // a roster whose rows do not add up to its count, and one longer than
    // ROSTER_MAX (the rows left out)
    const realRpc = db.rpc.bind(db);
    let alter = (a: Record<string, unknown>) => ({ ...a, clients_total: (a.clients_total as number) + 1 });
    db.rpc = async (fn: string, args: Record<string, unknown>) => {
      const r = await realRpc(fn, args);
      return fn === "booking_match_read" ? { data: alter(r.data as Record<string, unknown>), error: null } : r;
    };
    partial = (await run(db)).result;
    alter = (a) => ({ ...a, clients_total: 20001, clients: null });
    overCap = (await run(db)).result;
  } finally {
    console.error = realErr;
  }
  claim(
    "read-error-no-sync",
    { before, unreadable, partial, overCap, after: db.tables.calendar_proposal_support.length, syncs: db.rpcCalls.length },
    {
      before: 1,
      unreadable: { status: "read_failed", proposed: 0 },
      partial: { status: "client_unreadable", proposed: 0 },
      overCap: { status: "client_unreadable", proposed: 0 },
      after: 1,
      syncs: 1,
    },
    "no failed read, partial roster or over-cap roster sends a sync; the support row stays",
  );
});

Deno.test("booking match 5.3: a stale snapshot changes nothing and the match runs again from a fresh read", async () => {
  const db = new FakeDb({ clients: CLIENTS, business_events: [session()], action_items: [item(1, "Schedule tattoo appointment for Alicia Brennan")] });
  // the event changes between the matcher's read and its sync, once
  const realRpc = db.rpc.bind(db);
  let changed = false;
  db.rpc = (fn: string, args: Record<string, unknown>) => {
    if (fn === "sync_booking_proposals" && !changed) {
      changed = true;
      db.tables.business_events[0].title = "Tattoo session: Alicia Brennan (room 2)";
    }
    return realRpc(fn, args);
  };
  const { result } = await run(db);
  claim(
    "stale-reruns",
    { result, syncs: db.rpcCalls.length, snapshotTitle: (db.tables.calendar_proposal_support[0]?.event_snapshot as Record<string, unknown> | undefined)?.title ?? null },
    { result: { status: "proposed", proposed: 1 }, syncs: 2, snapshotTitle: "Tattoo session: Alicia Brennan (room 2)" },
    "the first sync answers stale and writes nothing; the second, from a fresh read, proposes with the current snapshot",
  );
});

Deno.test("booking match 5.3: an ineligible or unresolvable event still syncs, with no rows, so old support is withdrawn", async () => {
  const db = new FakeDb({ clients: CLIENTS, business_events: [session({ event_type: "general" })], action_items: [] });
  const { result } = await run(db);
  assertEquals(result, { status: "skipped_event_type", proposed: 0 });
  assertEquals(db.rpcCalls.map((c) => [c.fn, (c.args.p_rows as unknown[]).length]), [["sync_booking_proposals", 0]]);
});

Deno.test("booking match 5.3: a possessive of the client's name is the client, not a month", async () => {
  const june = { id: "j0000000-0000-4000-8000-000000000001", name: "June Bell", last_contact: "2026-11-01", metadata: { crm_id: "cb-june" } };
  const db = new FakeDb({
    clients: [...CLIENTS, june],
    business_events: [session({ title: "Session: June Bell", metadata: { crm_client_id: "cb-june" } })],
    action_items: [
      item(80, "Book June's tattoo session", { client_id: june.id }),
      item(81, "Book June\u2019s tattoo session", { client_id: june.id }),
      item(82, "Book Bell's session", { client_id: june.id }),
      item(83, "Book June Bell's session on June 15, 2027", { client_id: june.id }),
      item(84, "Book June's session in June", { client_id: june.id }),
    ],
  });
  await run(db);
  claim(
    "possessive-masked",
    {
      proposed: calendarRows(db).map((d) => d.item_id).sort(),
      dates: ["Book June's tattoo session", "Book June Bell's session on June 15, 2027", "Book June's session in June"].map((t) => itemDate(t, CREATED, ["June Bell"])),
    },
    { proposed: [item(80, "").id, item(81, "").id, item(82, "").id], dates: [null, "2027-06-15", "2027-06-01"] },
    "June's and Bell's are the client; a real date (June 15, 2027; in June) after the 2027-01-16 session still blocks the proposal",
  );
});

// The date paths under every way a space can be written (correction 3,
// strategy A): the same answer as the ASCII text.
// (The zero-width space is not a space since correction 5: it is an
// invisible code point the identity allowlist fails closed on.)
const DATE_SPACE_VARIANTS = ["\u00a0", "\u2002", "\u2009", "\u202f", "\u3000", "\u2028", "\t", "\n", "  "];
Deno.test("booking match 5.3: every Unicode space gives the ASCII date, predicate and proposal", () => {
  const texts: Array<[string, string[]]> = [
    ["Reschedule Alicia Brennan to March", []],
    ["Book the session for November 25", []],
    ["Book the session for March 3, 2028", []],
    ["Book Alicia, May need a consult first", []],
    ["Book Alicia on May 4", []],
    ["Book Alicia's session in May", []],
    ["Book a session for June Bell", ["June Bell"]],
    ["Book a session for June Bell on June 15, 2027", ["June Bell"]],
    ["Book June's tattoo session", ["June Bell"]],
    ["Set up a consultation for Alicia Brennan", []],
    ["Schedule tattoo appointment for Alicia Brennan", []],
  ];
  const differ: string[] = [];
  const answer = (t: string, names: string[]) =>
    JSON.stringify([itemDate(t, CREATED, names), isSchedulingItem(t), planBookingProposals(session(), [item(1, t)], "2026-11-20", names).length]);
  for (const [t, names] of texts) {
    const want = answer(t, names);
    for (const v of DATE_SPACE_VARIANTS) {
      const got = answer(t.replaceAll(" ", v), names.map((n) => n.replaceAll(" ", v)));
      if (got !== want) differ.push(`${JSON.stringify(v)} in "${t}": ${got} not ${want}`);
    }
  }
  claim("date-spaces-identical", differ, [], "the same item written with any space has the same date, predicate answer and proposal");
});

Deno.test("booking match 5.3: a matcher whose reads are older than an applied sync changes nothing", async () => {
  // Codex re-review 2, finding 4: the older matcher reads one qualifying item;
  // a second is added and a newer matcher proposes both; the older one then
  // syncs on the unchanged event.
  const db = new FakeDb({ clients: CLIENTS, business_events: [session()], action_items: [item(90, "Book Alicia Brennan's tattoo session")] });
  const realRpc = db.rpc.bind(db);
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>((r) => (release = r)), ready = new Promise<void>((r) => (arrived = r));
  let held = false;
  db.rpc = async (fn: string, args: Record<string, unknown>) => {
    if (fn === "sync_booking_proposals" && !held) {
      held = true;
      arrived();
      await gate;
    }
    return realRpc(fn, args);
  };
  const older = run(db);
  await ready;
  db.tables.action_items.push(item(91, "Schedule a consultation for Alicia Brennan"));
  const newer = await run(db);
  const pendingBetween = db.tables.calendar_proposal_support.length;
  release();
  const old = await older;
  claim(
    "older-read-superseded",
    { newer: newer.result, pendingBetween, older: old.result, support: db.tables.calendar_proposal_support.map((s) => s.item_id).sort() },
    { newer: { status: "proposed", proposed: 2 }, pendingBetween: 2, older: { status: "superseded", proposed: 0 }, support: [item(90, "").id, item(91, "").id] },
    "the older reads change nothing, so both qualifying bookings stay supported",
  );
});

Deno.test("booking match 5.3: a hyphenated first name's possessive is the client, not a month", async () => {
  const jm = { id: "j0000000-0000-4000-8000-000000000002", name: "June-Marie Bell", last_contact: "2026-11-01", metadata: { crm_id: "cb-jm" } };
  const db = new FakeDb({
    clients: [...CLIENTS, jm],
    business_events: [session({ title: "Session: June-Marie Bell", metadata: { crm_client_id: "cb-jm" } })],
    action_items: [
      item(85, "Book June-Marie's session and email June-Marie Bell", { client_id: jm.id }),
      item(86, "Book June-Marie\u2019s tattoo session", { client_id: jm.id }),
      item(87, "Book Marie's session", { client_id: jm.id }),
      item(88, "Book June-Marie Bell's session on June 15, 2027", { client_id: jm.id }),
      item(89, "Book June-Marie's session in June", { client_id: jm.id }),
    ],
  });
  await run(db);
  claim(
    "hyphenated-possessive-masked",
    {
      proposed: calendarRows(db).map((d) => d.item_id).sort(),
      dates: ["Book June-Marie's session and email June-Marie Bell", "Book June-Marie Bell's session on June 15, 2027", "Book June-Marie's session in June"]
        .map((t) => itemDate(t, CREATED, ["June-Marie Bell"])),
    },
    { proposed: [item(85, "").id, item(86, "").id, item(87, "").id], dates: [null, "2027-06-15", "2027-06-01"] },
    "June-Marie's and Marie's are the client; a real date after the 2027-01-16 session still blocks the proposal",
  );
});

Deno.test("booking match 5.3: the event's the CRM key and title resolve from the same read", async () => {
  // Codex re-review 3, finding 1: Blair Lake holds the event's the CRM
  // key; right after the match's read, Blair is renamed Alice Lake and loses
  // the key. The match must choose from what its one read saw (Blair), never
  // mix the edit with the earlier roster (which would choose Alice).
  const alice = { id: "a1ce0000-0000-4000-8000-000000000001", name: "Alice Lake", metadata: {} };
  const blair = { id: "b1a10000-0000-4000-8000-000000000002", name: "Blair Lake", metadata: { crm_id: "overlap-key" } };
  const db = new FakeDb({
    clients: [alice, blair],
    business_events: [session({ title: "Consultation Alice Lake", metadata: { crm_client_id: "overlap-key" } })],
    action_items: [
      item(95, "Schedule Alice Lake's session", { client_id: alice.id }),
      item(96, "Book Blair Lake's consultation", { client_id: blair.id }),
    ],
  });
  const realRpc = db.rpc.bind(db);
  db.rpc = async (fn: string, args: Record<string, unknown>) => {
    const r = await realRpc(fn, args);
    if (fn === "booking_match_read") Object.assign(db.tables.clients[1], { name: "Alice Lake", metadata: {} });
    return r;
  };
  await run(db);
  claim(
    "client-one-snapshot",
    { proposed: calendarRows(db).map((d) => d.item_id), reads: db.reads.map((r) => r.table) },
    { proposed: [item(96, "").id], reads: ["booking_match_read"] },
    "the key and the title are judged on one read: Blair's item, never Alice's",
  );
});

Deno.test("booking match 5.3: a match is one read, and its time is the sync's read time", async () => {
  const db = new FakeDb({ clients: CLIENTS, business_events: [session()], action_items: [item(1, "Schedule tattoo appointment for Alicia Brennan")] });
  const times: string[] = [];
  const realRpc = db.rpc.bind(db);
  db.rpc = async (fn: string, args: Record<string, unknown>) => {
    const r = await realRpc(fn, args);
    if (fn === "booking_match_read") times.push((r.data as { read_at: string }).read_at);
    return r;
  };
  await run(db);
  await run(db);
  claim(
    "one-read-per-match",
    { reads: db.reads.map((r) => r.table), sent: db.rpcCalls.map((c) => c.args.p_read_at) },
    { reads: ["booking_match_read", "booking_match_read"], sent: times },
    "each match reads once, and its sync carries exactly that read's time",
  );
});

Deno.test("booking match 5.3: a compound first name's possessive is masked however its words are joined", () => {
  // Codex re-review 4, finding 2: "June Marie's" (a space) read June 1 while
  // "June-Marie's" did not. Both joinings, both roster spellings, straight
  // and curly apostrophes; a real date stays a date.
  const ev = session({ title: "Session", metadata: {} });
  const got: unknown[] = [];
  const want: unknown[] = [];
  for (const rosterName of ["June-Marie Bell", "June Marie Bell"]) {
    for (const first of ["June-Marie", "June Marie"]) {
      for (const apos of ["'", "’"]) {
        const text = `Book ${first}${apos}s session and email ${rosterName}`;
        got.push([text, itemDate(text, CREATED, [rosterName]), planBookingProposals(ev, [item(1, text)], "2026-11-20", [rosterName]).length]);
        want.push([text, null, 1]);
      }
      const dated = `Book ${first}'s session on June 15, 2027`;
      got.push([dated, itemDate(dated, CREATED, [rosterName])]);
      want.push([dated, "2027-06-15"]);
    }
  }
  claim("compound-possessive-masked", got, want, "a possessive of the client's compound first name is the client, joined by a hyphen or a space");
});

Deno.test("booking match 5.3: today is the UTC date of the match's own read, never a caller's clock", async () => {
  // Codex re-review 4, finding 3: across UTC midnight, a matcher held before
  // its read must judge the event with the date of the read it then makes.
  // The database clock is set far from the real one (2029-12-31), so a
  // process clock would give a different answer.
  const db = new FakeDb({ clients: CLIENTS, business_events: [session({ date_start: "2029-12-31" })], action_items: [item(1, "Schedule tattoo appointment for Alicia Brennan")] });
  db.clockBase = Date.UTC(2029, 11, 31, 23, 59, 58);
  const first = (await run(db)).result;
  const realRpc = db.rpc.bind(db);
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>((r) => (release = r)), ready = new Promise<void>((r) => (arrived = r));
  let held = false;
  const heldDb = {
    from: db.from.bind(db),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "booking_match_read" && !held) {
        held = true;
        arrived();
        await gate;
      }
      return await realRpc(fn, args);
    },
  };
  const realLog = console.log;
  console.log = () => {};
  let late, newer, older;
  try {
    late = proposeBookingMatches(heldDb, EV);
    await ready;
    db.clockBase = Date.UTC(2030, 0, 1, 0, 0, 0);
    newer = await proposeBookingMatches(db, EV);
    release();
    older = await late;
  } finally {
    console.log = realLog;
  }
  claim(
    "today-from-read",
    { first: first.status, newer: newer.status, older: older.status, support: db.tables.calendar_proposal_support.length },
    { first: "proposed", newer: "skipped_not_future", older: "skipped_not_future", support: 0 },
    "before midnight the session is today; after it, both matchers read it as past and nothing stays visible",
  );
});

Deno.test("booking match 5.3: a possessive masks only the exact part of the name it spells, and a trailing apostrophe counts", () => {
  // Codex re-review 5, finding 3. "early June June's": the name has one
  // June, so only "June's" is the client and the month stays. "James'": a
  // bare trailing apostrophe is a possessive. Each name below, with "'s" and
  // (for names ending in s) a bare "'", straight and curly.
  const ev = session({ title: "Session", metadata: {} });
  const assess = (name: string, text: string) => [itemDate(text, CREATED, [name]), planBookingProposals(ev, [item(1, text)], "2026-11-20", [name]).length];
  const got: unknown[] = [];
  const want: unknown[] = [];
  const add = (name: string, text: string, expected: unknown[]) => {
    got.push([text, ...assess(name, text)]);
    want.push([text, ...expected]);
  };
  add("June Bell", "Book for early June June's next session and email June Bell", ["2027-06-01", 0]);
  add("June Bell", "Book for early June, June's next session and email June Bell", ["2027-06-01", 0]);
  add("June-James Bell", "Book June James’ session and email June-James Bell", [null, 1]);
  for (const name of ["June Bell", "June-Marie Bell", "June James Bell", "June-James Bell", "Agnes June", "June Ames"]) {
    const words = name.split(" ");
    const first = words[0];
    for (const apos of ["'", "’"]) {
      for (const poss of /s$/.test(first) ? [`${apos}s`, apos] : [`${apos}s`]) {
        add(name, `Book ${first}${poss} session and email ${name}`, [null, 1]);
        add(name, `Book ${first}${poss} session on June 15, 2027`, ["2027-06-15", 0]);
      }
    }
    const last = words[words.length - 1];
    if (/s$/.test(last)) add(name, `Book ${name}' session`, [null, 1]);
  }
  claim("exact-possessive-span", got, want, "only the possessive's own ordered part of the name is masked; a trailing apostrophe is a possessive");
});
