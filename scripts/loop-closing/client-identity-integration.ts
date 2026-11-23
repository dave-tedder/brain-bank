// Loop-closing Task 5.3: the REAL shared code wired to a throwaway local
// PostgreSQL cluster. Run ONLY by client-identity-sql-test.sh after the prior
// migrations and 20261121b are applied, with OBRP_PG_PORT pointing at its
// cluster and OBRP_PG_DB at the bridge's own database:
//   deno run --no-lock --allow-env --allow-read --allow-run=psql \
//     scripts/loop-closing/client-identity-integration.ts
//
// What it proves, every assertion reading persisted rows back (the adapter is
// client-identity-psql-db.ts):
//   I1 extractAndStoreActionItems (capture-pipeline.ts) on a multi-client
//      capture stores each item's own client_id through the real foreign key;
//      "nudge Jordan" (two Jakes) and "Book a consultation for Cedar Frost" (a
//      surname no client has) are null.
//   I2 proposeBookingMatches on Alicia's 2027-01-16 session writes ONE
//      calendar/proposed/booking_match row through the real
//      sync_booking_proposals and record_decisions (generation 0, typed event
//      evidence, title-and-date quote, no thought id) and its support row, and
//      the TypeScript snapshot equals the database's booking_event_snapshot
//      (the proposal reads as supported).
//   I3 the same event again writes nothing new.
//   I4 one event matching two items writes both in one call; a cancelled
//      event and an event before an item's own date propose nothing.
//   I5 calendar_pending_proposals and the digest renderer print the line with
//      its decision; review_proposal (Task 3.6) done resolves the item with
//      the event id in the close event payload, keep leaves the other open.
//   I6 a client deleted between attribution and the insert (Codex review 1 of
//      PR 38, finding 3): the real 23503 on action_items_client_id_fkey is
//      retried once without that id; both items are stored.
//   I7 Alicia's booking reassigned to Jordan Marlow (finding 4): after the
//      matcher re-runs, the pending read no longer lists her item, done on it
//      is refused by the guard trigger, keep still records the review.
//   I8 two event rows for one Google booking (the REST lookup-then-insert
//      race, finding 2), matched concurrently: exactly one proposal.
// Three outcomes: exit 0 with "CLIENT IDENTITY INTEGRATION PASSED"; exit 1 on
// a completed assertion ("FAIL integration: ..."); exit 2 NEVER-RAN.
//
// Control cases (client-identity-sql-test.sh --inject-selftest) reach this
// file through OBCI_BRIDGE_INJECT: bridge_bad_column plants an undefined
// column in a read-back (must read NEVER-RAN); bridge_planted_fail plants a
// failing assertion after I1 (must read FAIL); bridge_skip_check skips I3 (the
// runner must read NEVER-RAN for a missing check id). Each prints
// "OBCI_INJECT_REACHED <name>" from the planted branch.

import { extractAndStoreActionItems } from "../../supabase/functions/_shared/capture-pipeline.ts";
import { proposeBookingMatches } from "../../supabase/functions/_shared/booking-match.ts";
import { reviewProposal } from "../../supabase/functions/_shared/proposal-review.ts";
import { type CalendarProposalRow, renderCalendarProposals } from "../../supabase/functions/brain-digest/calendar-proposals.ts";
import { makePsqlDb } from "./client-identity-psql-db.ts";

const PORT = Deno.env.get("OBRP_PG_PORT");
const DBNAME = Deno.env.get("OBRP_PG_DB") ?? "obbridge";
if (!PORT) {
  console.log("NEVER-RAN: OBRP_PG_PORT is not set (run me from client-identity-sql-test.sh)");
  Deno.exit(2);
}
const INJECT = Deno.env.get("OBCI_BRIDGE_INJECT") ?? "";
if (INJECT !== "" && !["bridge_bad_column", "bridge_planted_fail", "bridge_skip_check"].includes(INJECT)) {
  console.log(`NEVER-RAN: unknown bridge injection ${INJECT}`);
  Deno.exit(2);
}
const NOW = new Date("2026-11-20T15:00:00Z");

const origLog = console.log;
const logs: string[] = [];
console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
console.error = (...a: unknown[]) => { logs.push("ERR " + a.map(String).join(" ")); };
console.warn = (...a: unknown[]) => { logs.push("WARN " + a.map(String).join(" ")); };
const say = (s: string) => origLog(s);

const P = makePsqlDb(PORT, DBNAME);
const db = P.db;
function check(): void {
  const why = P.neverRan();
  if (why) { say(`NEVER-RAN: ${why}`); Deno.exit(2); }
}
function fail(msg: string): never {
  check();
  say(`FAIL integration: ${msg}`);
  for (const l of logs.slice(-15)) say(`  ${l.slice(0, 200)}`);
  Deno.exit(1);
}
const expect = (cond: boolean, msg: string) => { if (!cond) fail(msg); };

const ALICIA = "a11c1a00-0000-4000-8000-0000000000b1";
const JAKE_M = "1a4e0000-0000-4000-8000-0000000000b2";
const JAKE_R = "1a4e0000-0000-4000-8000-0000000000b3";
const CEDAR = "cedaf000-0000-4000-8000-0000000000b4";
const SKY = "5c400000-0000-4000-8000-0000000000b5";
const T1 = "7a5c0000-0000-4000-8000-0000000000b1";
const T2 = "7a5c0000-0000-4000-8000-0000000000b2";
const EV = "e7e00000-0000-4000-8000-0000000000b1";
const EV_CANCELLED = "e7e00000-0000-4000-8000-0000000000b2";
const EV_TOO_EARLY = "e7e00000-0000-4000-8000-0000000000b3";
const EV_RACE_A = "e7e00000-0000-4000-8000-0000000000c1";
const EV_RACE_B = "e7e00000-0000-4000-8000-0000000000c2";

const capture = async (thought: string, items: string[]) =>
  await extractAndStoreActionItems(db, thought, { type: "task", source: "slack", project: null, action_items: items }, "Notes: still to do.", () => false);

try {
  await P.exec(`insert into public.clients (id, name, metadata, last_contact) values
    ('${ALICIA}', 'Alicia Brennan', '{"crm_id": "cb-alicia"}', '2026-11-01'),
    ('${JAKE_M}', 'Jordan Marlow', '{"crm_id": "cb-jake"}', '2026-10-01'),
    ('${JAKE_R}', 'Jordan Ruiz', '{}', '2026-09-01'),
    ('${CEDAR}', 'Cedar Finch', '{}', '2026-09-01'),
    ('${SKY}', 'Sky Harper', '{}', '2026-09-01')`, "clients");
  await P.exec(`insert into public.thoughts (id, metadata) values ('${T1}', '{}'), ('${T2}', '{}')`, "thoughts");
  check();

  // I1: a multi-client capture through the real shared copy.
  const ITEMS = [
    "Schedule tattoo appointment for Alicia Brennan",
    "Send Jordan Marlow the floor plan sketch",
    "nudge Jordan if nothing arrives",
    "send Alicia Brennan the design",
    "Book a consultation for Cedar Frost",
  ];
  await capture(T1, ITEMS);
  check();
  const stored = await P.rows(`select description, client_id::text from public.action_items where source_thought_id = '${T1}' order by description`);
  const byDesc = Object.fromEntries(stored.map((r) => [r.description, r.client_id]));
  expect(stored.length === 5 && byDesc[ITEMS[0]] === ALICIA && byDesc[ITEMS[1]] === JAKE_M && byDesc[ITEMS[2]] === null &&
    byDesc[ITEMS[3]] === ALICIA && byDesc[ITEMS[4]] === null, `I1 client_id per item: ${JSON.stringify(stored)}`);
  say("PASS I1 a multi-client capture stores each item's own client_id through the real foreign key; nudge Jordan (two clients) and Cedar Frost (no such client) are null");
  if (INJECT === "bridge_planted_fail") {
    say("OBCI_INJECT_REACHED bridge_planted_fail");
    expect(false, "obci planted assertion");
  }

  // I2: Alicia's session proposes her scheduling item only, with support.
  await P.exec(`insert into public.business_events (id, title, event_type, date_start, metadata) values
    ('${EV}', 'Tattoo session: Alicia Brennan', 'tattoo_session', '2027-01-16', '{"status": "scheduled", "crm_client_id": "cb-alicia", "gcal_event_id": "alicia-1@google.com"}')`, "event");
  check();
  const r2 = await proposeBookingMatches(db, EV);
  check();
  const cal = await P.rows(`select d.id::text as decision_id, d.item_id::text, a.description, d.evidence_event_id::text, d.quote, d.thought_id, d.evidence_thought_id,
      d.item_generation, d.outcome, d.reason, public.calendar_proposal_supported(d.id) as supported
    from public.auto_resolve_decisions d join public.action_items a on a.id = d.item_id where d.layer = 'calendar'`);
  expect(r2.status === "proposed" && r2.proposed === 1 && cal.length === 1 && cal[0].description === ITEMS[0] && cal[0].evidence_event_id === EV &&
    cal[0].quote === "Tattoo session: Alicia Brennan on 2027-01-16" && cal[0].thought_id === null && cal[0].evidence_thought_id === null &&
    cal[0].item_generation === 0 && cal[0].outcome === "proposed" && cal[0].reason === "booking_match" && cal[0].supported === true,
    `I2 one supported booking proposal: ${JSON.stringify(r2)} ${JSON.stringify(cal)}`);
  const statuses = await P.rows(`select distinct status from public.action_items`);
  expect(statuses.length === 1 && statuses[0].status === "open", `I2 nothing closed: ${JSON.stringify(statuses)}`);
  say("PASS I2 the session wrote one supported calendar/proposed/booking_match row through the real sync and record_decisions (generation 0); the TypeScript snapshot equals the database's");

  // I3: the same event again.
  if (INJECT === "bridge_skip_check") {
    say("OBCI_INJECT_REACHED bridge_skip_check");
  } else {
    const r3 = await proposeBookingMatches(db, EV);
    check();
    const cal3 = await P.rows(`select 1 from public.auto_resolve_decisions where layer = 'calendar'`);
    expect(r3.status === "proposed" && r3.proposed === 0 && cal3.length === 1, `I3 re-fired: ${JSON.stringify(r3)} rows ${cal3.length}`);
    say("PASS I3 the same event again writes nothing new");
  }

  // I4: two items, one call; cancelled and too-early events propose nothing.
  await P.exec(`insert into public.action_items (id, description, status, client_id, created_at) values
    ('a0000b01-0000-4000-8000-000000000000', 'Book Jordan Marlow''s consultation', 'open', '${JAKE_M}', '2026-11-20T14:00:00Z'),
    ('a0000b02-0000-4000-8000-000000000000', 'Reschedule Jordan Marlow''s session', 'open', '${JAKE_M}', '2026-11-20T14:00:00Z'),
    ('a0000b03-0000-4000-8000-000000000000', 'Reschedule Jordan Marlow''s session to March', 'open', '${JAKE_M}', '2026-11-20T14:00:00Z')`, "jake items");
  await P.exec(`insert into public.business_events (id, title, event_type, date_start, metadata) values
    ('e7e00000-0000-4000-8000-0000000000b4', 'Consultation: Jordan Marlow', 'consultation', '2027-01-20', '{"crm_client_id": "cb-jake"}'),
    ('${EV_CANCELLED}', 'Consultation: Jordan Marlow', 'consultation', '2027-04-20', '{"status": "cancelled", "crm_client_id": "cb-jake"}'),
    ('${EV_TOO_EARLY}', 'Tattoo session: Jordan Marlow', 'tattoo_session', '2027-02-10', '{"crm_client_id": "cb-jake"}')`, "jake events");
  check();
  const before4 = P.rpcCalls.filter((c) => c.fn === "sync_booking_proposals").length;
  const r4 = await proposeBookingMatches(db, "e7e00000-0000-4000-8000-0000000000b4");
  check();
  const calls4 = P.rpcCalls.filter((c) => c.fn === "sync_booking_proposals").slice(before4);
  const jake = await P.rows(`select item_id::text from public.auto_resolve_decisions where evidence_event_id = 'e7e00000-0000-4000-8000-0000000000b4' order by item_id`);
  expect(r4.proposed === 2 && calls4.length === 1 && (calls4[0].args.p_rows as unknown[]).length === 2 &&
    JSON.stringify(jake.map((r) => r.item_id)) === JSON.stringify(["a0000b01-0000-4000-8000-000000000000", "a0000b02-0000-4000-8000-000000000000"]),
    `I4 two items in one call: ${JSON.stringify(r4)} ${JSON.stringify(jake)}`);
  const r4c = await proposeBookingMatches(db, EV_CANCELLED);
  await proposeBookingMatches(db, EV_TOO_EARLY);
  check();
  const extra = await P.rows(`select item_id::text, evidence_event_id::text from public.auto_resolve_decisions where evidence_event_id in ('${EV_CANCELLED}', '${EV_TOO_EARLY}')`);
  expect(r4c.status === "skipped_cancelled" && !extra.some((r) => r.item_id === "a0000b03-0000-4000-8000-000000000000") &&
    extra.every((r) => r.evidence_event_id === EV_TOO_EARLY), `I4 cancelled and too-early: ${JSON.stringify(extra)}`);
  say("PASS I4 one event matching two items writes both in one sync; a cancelled event proposes nothing; an event before an item's own date never proposes it");

  // I5: the digest read and renderer; review through Task 3.6's helper.
  const pend = await db.rpc("calendar_pending_proposals", { p_limit: 200 });
  check();
  const section = renderCalendarProposals(pend.data as CalendarProposalRow[]);
  const aliciaItem = String(cal[0].item_id);
  const aliciaDecision = String(cal[0].decision_id);
  expect(section.split("\n")[2] === `- ${aliciaItem.slice(0, 8)} "${ITEMS[0]}" matches Tattoo session: Alicia Brennan on 2027-01-16 (decision ${aliciaDecision.slice(0, 8)})`,
    `I5 digest line: ${JSON.stringify(section)}`);
  const done = await reviewProposal(db, { verb: "done", itemRef: aliciaItem.slice(0, 8), actor: "slack:U0BOOK1", source: "slack-signature" });
  check();
  expect(done.status === "recorded", `I5 done: ${JSON.stringify(done)}`);
  const after = await P.rows(`select a.status, a.close_reason, a.resolved_by_thought_id, e.payload->>'evidence_event_id' as ev, e.actor, d.outcome
    from public.action_items a join public.action_item_events e on e.item_id = a.id and e.new_status = 'resolved'
    join public.auto_resolve_decisions d on d.item_id = a.id and d.layer = 'calendar' where a.id = '${aliciaItem}'`);
  expect(after.length === 1 && after[0].status === "resolved" && after[0].close_reason === "done" && after[0].resolved_by_thought_id === null &&
    after[0].ev === EV && after[0].actor === "slack:U0BOOK1" && after[0].outcome === "accepted", `I5 after done: ${JSON.stringify(after)}`);
  const keep = await reviewProposal(db, { verb: "keep", itemRef: "a0000b01-0000-4000-8000-000000000000", actor: "operator", source: "mcp-shared-key" });
  check();
  expect(keep.status === "recorded", `I5 keep: ${JSON.stringify(keep)}`);
  say("PASS I5 the digest prints the line with its decision; done resolves with the event id in the close event; keep leaves the item open");

  // I6: a client deleted between attribution and the insert.
  P.beforeNextInsert("action_items", async () => {
    await P.exec(`delete from public.clients where id = '${SKY}'`, "the deletion");
  });
  P.expectError("insert action_items returning id, description", "23503", "action_items_client_id_fkey");
  await capture(T2, ["Send Sky Harper the sketch", "Order printer paper for the studio"]);
  check();
  const kept6 = await P.rows(`select description, client_id from public.action_items where source_thought_id = '${T2}' order by description`);
  expect(kept6.length === 2 && kept6.every((r) => r.client_id === null), `I6 both items stored after the client disappeared: ${JSON.stringify(kept6)}`);
  say("PASS I6 a client deleted before the insert: the real 23503 is retried without that id and both items are stored");

  // I7: Alicia's booking reassigned to Jordan Marlow.
  await P.exec(`insert into public.action_items (id, description, status, client_id, created_at) values
    ('a0000c01-0000-4000-8000-000000000000', 'Schedule tattoo appointment for Alicia Brennan in 2027', 'open', '${ALICIA}', '2026-11-20T14:00:00Z')`, "alicia item 2");
  await P.exec(`insert into public.business_events (id, title, event_type, date_start, metadata) values
    ('e7e00000-0000-4000-8000-0000000000d1', 'Tattoo session: Alicia Brennan', 'tattoo_session', '2027-05-16', '{"crm_client_id": "cb-alicia"}')`, "alicia event 2");
  check();
  await proposeBookingMatches(db, "e7e00000-0000-4000-8000-0000000000d1");
  check();
  const listedBefore = ((await db.rpc("calendar_pending_proposals", { p_limit: 200 })).data as CalendarProposalRow[]).some((r) => r.item_id === "a0000c01-0000-4000-8000-000000000000");
  await P.exec(`update public.business_events set title = 'Consultation: Jordan Marlow', event_type = 'consultation', metadata = '{"crm_client_id": "cb-jake"}' where id = 'e7e00000-0000-4000-8000-0000000000d1'`, "reassignment");
  await proposeBookingMatches(db, "e7e00000-0000-4000-8000-0000000000d1");
  check();
  const listedAfter = ((await db.rpc("calendar_pending_proposals", { p_limit: 200 })).data as CalendarProposalRow[]).some((r) => r.item_id === "a0000c01-0000-4000-8000-000000000000");
  P.expectError("rpc review_proposal", "P0001", "no longer supported by its booking");
  const refused = await reviewProposal(db, { verb: "done", itemRef: "a0000c01-0000-4000-8000-000000000000", actor: "operator", source: "mcp-shared-key" });
  check();
  const still = await P.rows(`select a.status, d.outcome from public.action_items a join public.auto_resolve_decisions d on d.item_id = a.id where a.id = 'a0000c01-0000-4000-8000-000000000000'`);
  const kept7 = await reviewProposal(db, { verb: "keep", itemRef: "a0000c01-0000-4000-8000-000000000000", actor: "operator", source: "mcp-shared-key" });
  check();
  expect(listedBefore && !listedAfter && refused.status === "error" && /no longer supported/.test(refused.message) &&
    still.length === 1 && still[0].status === "open" && still[0].outcome === "proposed" && kept7.status === "recorded",
    `I7 reassigned booking: listed ${listedBefore}/${listedAfter} done ${JSON.stringify(refused)} rows ${JSON.stringify(still)} keep ${JSON.stringify(kept7)}`);
  say("PASS I7 a booking reassigned to another client: the proposal leaves the pending read, done is refused and writes nothing, keep is recorded");

  // I8: two event rows for one Google booking, matched concurrently.
  await P.exec(`insert into public.action_items (id, description, status, client_id, created_at) values
    ('a0000d01-0000-4000-8000-000000000000', 'Book a session for Cedar Finch', 'open', '${CEDAR}', '2026-11-20T14:00:00Z')`, "cedar item");
  await P.exec(`insert into public.business_events (id, title, event_type, date_start, metadata) values
    ('${EV_RACE_A}', 'Session for Cedar Finch', 'tattoo_session', '2099-04-02', '{"gcal_event_id": "race-rest"}'),
    ('${EV_RACE_B}', 'Session for Cedar Finch', 'tattoo_session', '2099-04-02', '{"gcal_event_id": "race-rest"}')`, "race events");
  check();
  await Promise.all([proposeBookingMatches(db, EV_RACE_A), proposeBookingMatches(db, EV_RACE_B)]);
  check();
  const race = await P.rows(`select d.evidence_event_id::text, public.calendar_proposal_supported(d.id) as supported from public.auto_resolve_decisions d
    where d.item_id = 'a0000d01-0000-4000-8000-000000000000' and d.layer = 'calendar'`);
  expect(race.length === 1 && race[0].supported === true, `I8 one proposal for one booking: ${JSON.stringify(race)}`);
  say("PASS I8 two event rows for one Google booking, matched at the same time, produce exactly one supported proposal");

  if (INJECT === "bridge_bad_column") {
    say("OBCI_INJECT_REACHED bridge_bad_column");
    await P.rows(`select obci_injected_missing_column from public.action_items`);
  }
} catch (e) {
  check();
  say(`NEVER-RAN: the bridge threw: ${e instanceof Error ? e.message : String(e)}`);
  Deno.exit(2);
}
check();
say("CLIENT IDENTITY INTEGRATION PASSED");
Deno.exit(0);
