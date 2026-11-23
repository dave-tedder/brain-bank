// Loop-closing Task 5.3, correction 1: before/after reproductions of Codex
// review 1 of PR 38 (findings 1, 2, 3, 4, 6, 7, 8) against a throwaway LOCAL
// cluster, through the public entrypoints that exist on BOTH heads
// (extractAndStoreActionItems, proposeBookingMatches, the pending read, the
// digest renderer and reviewProposal). Run by client-identity-witness-run.sh
// once on the reviewed head and once on the corrected head; it prints one
// "W<n> ..." observation line per scenario and decides nothing. Not a test:
// exit 0 means every scenario ran (an SQL error a scenario does not expect
// is reported as NEVER-RAN, exit 2).

import { extractAndStoreActionItems } from "../../supabase/functions/_shared/capture-pipeline.ts";
import { proposeBookingMatches } from "../../supabase/functions/_shared/booking-match.ts";
import { reviewProposal } from "../../supabase/functions/_shared/proposal-review.ts";
import { renderCalendarProposals } from "../../supabase/functions/brain-digest/calendar-proposals.ts";
import { makePsqlDb } from "./client-identity-psql-db.ts";

const PORT = Deno.env.get("OBRP_PG_PORT")!;
const P = makePsqlDb(PORT, Deno.env.get("OBRP_PG_DB") ?? "obwitness");
const db = P.db;
const NOW = new Date("2026-11-20T15:00:00Z");
// The previous heads took the caller's clock as a third argument; from
// correction 5 the matcher takes no clock (today comes from its own read), so
// the argument is passed through a cast and ignored there.
const matchWithClock = proposeBookingMatches as unknown as (d: unknown, e: string, now?: Date) => Promise<{ status: string; proposed: number }>;
const match = (d: unknown, eventId: string, now: Date = NOW) => matchWithClock(d, eventId, now);
const out = console.log;
console.log = () => {};
console.error = () => {};
console.warn = () => {};
const say = (s: string) => out(s);
const id = (n: number, p = "c") => `${p}${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;
let thoughtN = 0;
async function capture(items: string[]) {
  const t = id(++thoughtN, "7");
  await P.exec(`insert into public.thoughts (id, metadata) values ('${t}', '{}')`, "thought");
  await extractAndStoreActionItems(db, t, { type: "task", source: "slack", project: null, action_items: items }, "Notes: still to do.", () => false);
  return await P.rows(`select a.description, c.name as client from public.action_items a left join public.clients c on c.id = a.client_id
    where a.source_thought_id = '${t}' order by a.description`);
}
const names = async () => Object.fromEntries((await P.rows(`select id::text, name from public.clients`)).map((r) => [r.id, r.name]));

try {
  // W1 identity (finding 1, and the Unicode part of finding 7).
  await P.exec(`insert into public.clients (id, name, metadata) values
    ('${id(1)}', 'Jordan Marlow', '{}'), ('${id(2)}', 'Ann Lee', '{}'), ('${id(3)}', 'Cedar Finch', '{}'),
    ('${id(4)}', 'Jean-Luc West', '{}'), ('${id(5)}', 'Jean Luc West', '{}'), ('${id(6)}', '李 明', '{}'), ('${id(7)}', 'Bea O''Neil', '{}')`, "W1 clients");
  const w1 = await capture(["Book a session for Jordan Miller", "Arrange an appointment for Ann Leeds", "Book a consultation for Cedar Frost",
    "Book a session for Jean Luc West", "Schedule a consultation for 李 明", "Book Bea O’Neil’s appointment"]);
  say(`W1 identity ${JSON.stringify(w1.map((r) => [r.description, r.client]))}`);
  await P.exec(`delete from public.clients`, "W1 cleanup");

  // W2 the 2,001st client (finding 7).
  await P.exec(`insert into public.clients (id, name, metadata) select ('d0000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'Synthetic Client' || g, '{}' from generate_series(1, 2000) g`, "W2 roster");
  await P.exec(`insert into public.clients (id, name, metadata) values ('ffffffff-0000-4000-8000-000000000001', 'Ruth Ivy', '{}')`, "W2 Ruth");
  const w2 = await capture(["Book a consultation for Ruth Ivy"]);
  say(`W2 roster-2001 ${JSON.stringify(w2.map((r) => [r.description, r.client]))}`);
  await P.exec(`delete from public.clients`, "W2 cleanup");

  // W3 a client deleted between attribution and the insert (finding 3).
  await P.exec(`insert into public.clients (id, name, metadata) values ('${id(10)}', 'Sky Harper', '{}')`, "W3 client");
  P.beforeNextInsert("action_items", async () => { await P.exec(`delete from public.clients where id = '${id(10)}'`, "W3 deletion"); });
  P.expectError("insert action_items returning id, description", "23503", "action_items_client_id_fkey");
  const w3 = await capture(["Send Sky Harper the sketch", "Order printer paper for the studio"]);
  say(`W3 fk-race stored=${JSON.stringify(w3.map((r) => [r.description, r.client]))}`);

  // W4 a booking reassigned to another client (finding 4).
  await P.exec(`insert into public.clients (id, name, metadata) values ('${id(20)}', 'Alicia Brennan', '{"crm_id": "cb-alicia"}'), ('${id(21)}', 'Jordan Marlow', '{"crm_id": "cb-jake"}')`, "W4 clients");
  await P.exec(`insert into public.action_items (id, description, status, client_id, created_at) values ('${id(22, "a")}', 'Schedule tattoo appointment for Alicia Brennan', 'open', '${id(20)}', '2026-11-20T14:00:00Z')`, "W4 item");
  await P.exec(`insert into public.business_events (id, title, event_type, date_start, metadata) values ('${id(23, "e")}', 'Tattoo session: Alicia Brennan', 'tattoo_session', '2027-01-16', '{"crm_client_id": "cb-alicia"}')`, "W4 event");
  await match(db, id(23, "e"), NOW);
  await P.exec(`update public.business_events set title = 'Consultation: Jordan Marlow', event_type = 'consultation', metadata = '{"crm_client_id": "cb-jake"}' where id = '${id(23, "e")}'`, "W4 reassign");
  await match(db, id(23, "e"), NOW);
  const pend4 = (await db.rpc("calendar_pending_proposals", { p_limit: 200 })).data as Array<Record<string, unknown>>;
  const line4 = renderCalendarProposals(pend4.filter((r) => r.item_id === id(22, "a")) as never).split("\n")[2] ?? "(not listed)";
  P.expectError("rpc review_proposal", "P0001", "no longer supported");
  const done4 = await reviewProposal(db, { verb: "done", itemRef: id(22, "a"), actor: "operator", source: "mcp-shared-key" });
  const st4 = await P.rows(`select status from public.action_items where id = '${id(22, "a")}'`);
  say(`W4 reassigned digest=${JSON.stringify(line4)} done=${done4.status} item=${st4[0]?.status}`);

  // W5 two event rows for one Google booking, matched concurrently (finding 2).
  await P.exec(`insert into public.clients (id, name, metadata) values ('${id(30)}', 'Cedar Finch', '{}')`, "W5 client");
  await P.exec(`insert into public.action_items (id, description, status, client_id, created_at) values ('${id(31, "a")}', 'Book a session for Cedar Finch', 'open', '${id(30)}', '2026-11-20T14:00:00Z')`, "W5 item");
  await P.exec(`insert into public.business_events (id, title, event_type, date_start, metadata) values
    ('${id(32, "e")}', 'Session for Cedar Finch', 'tattoo_session', '2099-04-02', '{"gcal_event_id": "race-rest"}'),
    ('${id(33, "e")}', 'Session for Cedar Finch', 'tattoo_session', '2099-04-02', '{"gcal_event_id": "race-rest"}')`, "W5 events");
  await Promise.all([match(db, id(32, "e"), NOW), match(db, id(33, "e"), NOW)]);
  const pend5 = ((await db.rpc("calendar_pending_proposals", { p_limit: 200 })).data as Array<Record<string, unknown>>).filter((r) => r.item_id === id(31, "a"));
  const dec5 = await P.rows(`select 1 from public.auto_resolve_decisions where item_id = '${id(31, "a")}'`);
  say(`W5 same-booking decisions=${dec5.length} pending=${pend5.length}`);

  // W6 dates (finding 6).
  await P.exec(`insert into public.clients (id, name, metadata) values ('${id(40)}', 'June Bell', '{"crm_id": "cb-june"}')`, "W6 client");
  await P.exec(`insert into public.action_items (id, description, status, client_id, created_at) values
    ('${id(41, "a")}', 'Book a session for June Bell', 'open', '${id(40)}', '2026-11-20T14:00:00Z'),
    ('${id(42, "a")}', 'Book Alicia Brennan''s session for May', 'open', '${id(20)}', '2026-11-20T14:00:00Z')`, "W6 items");
  await P.exec(`insert into public.business_events (id, title, event_type, date_start, metadata) values
    ('${id(43, "e")}', 'Session: June Bell', 'tattoo_session', '2027-01-16', '{"crm_client_id": "cb-june"}'),
    ('${id(44, "e")}', 'Session: Alicia Brennan', 'tattoo_session', '2027-01-16', '{"crm_client_id": "cb-alicia"}')`, "W6 events");
  await match(db, id(43, "e"), NOW);
  await match(db, id(44, "e"), NOW);
  const d41 = await P.rows(`select 1 from public.auto_resolve_decisions where item_id = '${id(41, "a")}'`);
  const d42 = await P.rows(`select 1 from public.auto_resolve_decisions where item_id = '${id(42, "a")}'`);
  say(`W6 dates june-bell-proposals=${d41.length} alicia-for-may-proposals=${d42.length}`);

  // W7 a calendar proposal next to a dedup proposal (finding 8).
  await P.exec(`insert into public.action_items (id, description, status, client_id, created_at) values
    ('${id(50, "a")}', 'Book Alicia Brennan''s consultation', 'open', '${id(20)}', '2026-11-20T14:00:00Z'),
    ('${id(51, "a")}', 'Book Alicia Brennan consultation', 'open', null, '2026-11-19T14:00:00Z')`, "W7 items");
  await P.exec(`insert into public.business_events (id, title, event_type, date_start, metadata) values ('${id(52, "e")}', 'Consultation: Alicia Brennan', 'consultation', '2027-02-01', '{"crm_client_id": "cb-alicia"}')`, "W7 event");
  await match(db, id(52, "e"), NOW);
  await db.rpc("record_decisions", { p_rows: [{ layer: "dedup", outcome: "proposed", reason: "semantic_overlap", candidate_description: "x", item_id: id(50, "a"), related_item_id: id(51, "a"), score: 0.9 }] });
  const pend7 = ((await db.rpc("calendar_pending_proposals", { p_limit: 200 })).data as Array<Record<string, unknown>>).filter((r) => r.item_id === id(50, "a"));
  const line7 = renderCalendarProposals(pend7 as never).split("\n")[2] ?? "(not listed)";
  const bare7 = await reviewProposal(db, { verb: "done", itemRef: id(50, "a").slice(0, 8), actor: "operator", source: "mcp-shared-key" });
  say(`W7 mixed-evidence digest=${JSON.stringify(line7)} bare-done=${bare7.status}`);

  // W8 a stored tab + CANCELED + newline status after a proposal (finding 8).
  await P.exec(`insert into public.action_items (id, description, status, client_id, created_at) values ('${id(60, "a")}', 'Schedule Alicia Brennan''s session in 2027', 'open', '${id(20)}', '2026-11-20T14:00:00Z')`, "W8 item");
  await P.exec(`insert into public.business_events (id, title, event_type, date_start, metadata) values ('${id(61, "e")}', 'Session: Alicia Brennan', 'tattoo_session', '2027-03-03', '{"crm_client_id": "cb-alicia"}')`, "W8 event");
  await match(db, id(61, "e"), NOW);
  await P.exec(`update public.business_events set metadata = jsonb_set(metadata, '{status}', to_jsonb(chr(9) || 'CANCELED' || chr(10))) where id = '${id(61, "e")}'`, "W8 cancel");
  const pend8 = ((await db.rpc("calendar_pending_proposals", { p_limit: 200 })).data as Array<Record<string, unknown>>).filter((r) => r.item_id === id(60, "a"));
  say(`W8 tab-canceled listed=${pend8.length} flagged=${JSON.stringify(pend8.map((r) => r.event_cancelled ?? "n/a"))}`);
  // --- Round 2 (Codex re-review 1) ---
  // W9 a title that begins with a longer name (finding 1).
  await P.exec(`insert into public.clients (id, name, metadata) values ('${id(70)}', 'Ann Lee', '{}')`, "W9 client");
  const w9 = await capture(["Mary Ann Lee - consultation", "Consultation Ann Lee"]);
  say(`W9 neighbour ${JSON.stringify(w9.map((r) => [r.description, r.client]))}`);

  // W10 the client's name and an explicit date sharing a word (finding 2).
  await P.exec(`insert into public.action_items (id, description, status, client_id, created_at) values
    ('${id(71, "a")}', 'Book a session for June Bell on June 15, 2027', 'open', '${id(40)}', '2026-11-20T14:00:00Z')`, "W10 item");
  await match(db, id(43, "e"), NOW);
  const d71 = await P.rows(`select 1 from public.auto_resolve_decisions where item_id = '${id(71, "a")}'`);
  say(`W10 june-15 proposals=${d71.length}`);

  // W11 a temporary client read error during a re-run (finding 3).
  await P.exec(`insert into public.action_items (id, description, status, client_id, created_at) values ('${id(72, "a")}', 'Schedule Alicia Brennan''s session for 2027', 'open', '${id(20)}', '2026-11-20T14:00:00Z')`, "W11 item");
  await P.exec(`insert into public.business_events (id, title, event_type, date_start, metadata) values ('${id(73, "e")}', 'Session: Alicia Brennan', 'tattoo_session', '2027-07-07', '{"crm_client_id": "cb-alicia"}')`, "W11 event");
  await match(db, id(73, "e"), NOW);
  const listed = async (item: string) =>
    ((await db.rpc("calendar_pending_proposals", { p_limit: 500 })).data as Array<Record<string, unknown>>).filter((r) => r.item_id === item).length;
  const w11a = await listed(id(72, "a"));
  await P.exec(`alter table public.clients rename to clients_offline`, "W11 clients unreadable");
  // The roster read fails at whichever call site the head uses: a select on
  // clients (paged roster) or the client_roster function (correction 3); the
  // other expectation stays unused, which is reported as a NOTE only.
  P.expectError("select clients", "42P01", "clients");
  P.expectError("rpc client_roster", "42P01", "clients");
  P.expectError("rpc booking_match_read", "42P01", "clients");
  await match(db, id(73, "e"), NOW);
  await P.exec(`alter table public.clients_offline rename to clients`, "W11 clients back");
  const w11b = await listed(id(72, "a"));
  say(`W11 read-error listed-before=${w11a} listed-after=${w11b}`);

  // W12 a late matcher run with an older snapshot (finding 4): the event
  // title changes, the current run syncs, then a run that read the event
  // before the change delivers its sync.
  const ev12 = id(73, "e");
  const oldRead = (await P.rows(`select id, title, event_type, date_start::text, metadata from public.business_events where id = '${ev12}'`))[0];
  await P.exec(`update public.business_events set title = 'Session: Alicia Brennan (room 2)' where id = '${ev12}'`, "W12 edit");
  await match(db, ev12);
  const w12a = await listed(id(72, "a"));
  // The head's own signature: correction 3 added p_read_at (null with no rows).
  const fourArgs = (await P.rows(`select 1 from pg_proc where proname = 'sync_booking_proposals' and pronargs = 4`)).length === 1;
  const late = await db.rpc("sync_booking_proposals", {
    p_event_id: ev12,
    p_snapshot: { title: oldRead.title, event_type: oldRead.event_type, date_start: oldRead.date_start, status: null, crm_client_id: "cb-alicia" },
    ...(fourArgs ? { p_read_at: null } : {}),
    p_rows: [],
  });
  const w12b = await listed(id(72, "a"));
  say(`W12 late-sync answer=${JSON.stringify(late.data)} listed-before=${w12a} listed-after=${w12b}`);

  // W13 a server row cap below the page size (finding 7): two Paige Smiths at
  // opposite ends of the id order, 510 clients, at most 100 rows a read.
  await P.exec(`insert into public.clients (id, name, metadata) values ('00000000-0000-4000-8000-0000000000aa', 'Paige Smith', '{}'), ('ffffffff-ffff-4fff-8fff-0000000000ab', 'Paige Smith', '{}')`, "W13 Paiges");
  await P.exec(`insert into public.clients (id, name, metadata) select ('e0000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'Filler Client' || g, '{}' from generate_series(1, 480) g`, "W13 filler");
  P.setRowCap(100);
  const w13 = await capture(["Book a consultation for Paige Smith"]);
  P.setRowCap(Infinity);
  say(`W13 row-cap ${JSON.stringify(w13.map((r) => [r.description, r.client]))}`);

  // W14 an inserted accepted calendar row with no support (finding 6).
  let w14 = "inserted";
  P.expectError("a read-back", "P0001", "no longer supported");
  const ins = await P.psql(`insert into public.auto_resolve_decisions (layer, outcome, reason, candidate_description, item_id, evidence_event_id, quote, review_seq, reviewed_at, reviewed_by)
    values ('calendar', 'accepted', 'booking_match', 'x', '${id(72, "a")}', '${id(23, "e")}', 'q', 1, now(), 'operator')`, "a read-back");
  if ("error" in ins) w14 = `refused ${ins.error.code}`;
  say(`W14 insert-accepted ${w14}`);

  // --- Round 3 (Codex re-review 2) ---
  // W15 the same title written with other spaces (finding 1; strategy A).
  // Ann Lee (W9) is the only Ann Lee.
  // Distinct wording per item, so the capture's own duplicate check keeps all four.
  const w15 = await capture(["Mary\u00a0Ann Lee - consultation about the koi", "Mary\u202fAnn Lee - consultation about the crane",
    "Mary\u200bAnn Lee - consultation about the tiger", "Consultation\u00a0Ann Lee about the peony"]);
  say(`W15 spaces ${JSON.stringify(w15.map((r) => [JSON.stringify(r.description), r.client]))}`);

  // W16 a second Paige Smith committed, behind the read's position, after the
  // first roster statement returns (finding 2; strategy B). Paige B is
  // removed first, so the roster starts with one Paige.
  await P.exec(`delete from public.clients where id = 'ffffffff-ffff-4fff-8fff-0000000000ab'`, "W16 one Paige");
  P.setRowCap(100);
  const rosterStatements = () => P.reads.filter((t) => t === "clients").length + P.rpcCalls.filter((c) => c.fn === "client_roster").length;
  const s16 = rosterStatements();
  P.afterNextRosterRead(async () => {
    await P.exec(`insert into public.clients (id, name, metadata) values ('00000000-0000-4000-8000-000000000001', 'Paige Smith', '{}')`, "W16 second Paige");
  });
  const w16 = await capture(["Book a consultation for Paige Smith about the hannya mask"]);
  P.setRowCap(Infinity);
  const paiges16 = await P.rows(`select count(*)::int as n from public.clients where name = 'Paige Smith'`);
  say(`W16 roster-statements=${rosterStatements() - s16} second-paige-inserted-after-the-first=1 paiges-now=${paiges16[0]?.n} ${JSON.stringify(w16.map((r) => [r.description, r.client]))}`);

  // W17 a first-name possessive (finding 3): June Bell's undated item and
  // her 2027-01-16 session (W6).
  await P.exec(`insert into public.action_items (id, description, status, client_id, created_at) values
    ('${id(74, "a")}', 'Book June''s tattoo session', 'open', '${id(40)}', '2026-11-20T14:00:00Z')`, "W17 item");
  await match(db, id(43, "e"), NOW);
  const d74 = await P.rows(`select 1 from public.auto_resolve_decisions where item_id = '${id(74, "a")}'`);
  say(`W17 possessive proposals=${d74.length}`);

  // W18 an older matcher syncing after a newer one on an unchanged event
  // (finding 4): the older one read one item; a second is added and a newer
  // matcher proposes both; the older one's sync then arrives.
  await P.exec(`insert into public.clients (id, name, metadata) values ('${id(80)}', 'Sky Harper', '{}')`, "W18 client");
  await P.exec(`insert into public.business_events (id, title, event_type, date_start, metadata) values ('${id(81, "e")}', 'Consultation: Sky Harper', 'consultation', '2099-01-01', '{}')`, "W18 event");
  await P.exec(`insert into public.action_items (id, description, status, client_id, created_at) values
    ('${id(82, "a")}', 'Book Sky Harper''s tattoo session', 'open', '${id(80)}', '2026-11-20T14:00:00Z')`, "W18 first item");
  let release18!: () => void, arrived18!: () => void;
  const gate18 = new Promise<void>((r) => (release18 = r)), ready18 = new Promise<void>((r) => (arrived18 = r));
  const olderDb = {
    from: (t: string) => db.from(t),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "sync_booking_proposals") {
        arrived18();
        await gate18;
      }
      return await db.rpc(fn, args);
    },
  };
  const older18 = match(olderDb, id(81, "e"), NOW);
  await ready18;
  await P.exec(`insert into public.action_items (id, description, status, client_id, created_at) values
    ('${id(83, "a")}', 'Schedule a consultation for Sky Harper', 'open', '${id(80)}', '2026-11-20T14:00:00Z')`, "W18 second item");
  const newer18 = await match(db, id(81, "e"), NOW);
  const listed18 = async () => ((await db.rpc("calendar_pending_proposals", { p_limit: 500 })).data as Array<Record<string, unknown>>).filter((r) => r.event_id === id(81, "e")).length;
  const between18 = await listed18();
  release18();
  const old18 = await older18;
  say(`W18 older-sync newer=${newer18.status} listed-between=${between18} older=${old18.status} listed-after=${await listed18()}`);

  // W19 support for one item offered as evidence for another item of the
  // same client (finding 5): the predicate, then an accept that moves the
  // supported decision to that item.
  await P.exec(`insert into public.action_items (id, description, status, client_id, created_at) values
    ('${id(84, "a")}', 'Send Sky Harper the design', 'open', '${id(80)}', '2026-11-20T14:00:00Z')`, "W19 item");
  const dec19 = (await P.rows(`select id::text from public.auto_resolve_decisions where item_id = '${id(82, "a")}' and evidence_event_id = '${id(81, "e")}'`))[0]?.id;
  const holds19 = await P.rows(`select public.calendar_support_holds('${dec19}', '${id(84, "a")}', '${id(81, "e")}') as h`);
  let w19 = "accepted";
  P.expectError("a read-back", "P0001", "no longer supported");
  const mv = await P.psql(`update public.auto_resolve_decisions set outcome = 'accepted', review_seq = 1, reviewed_at = now(), reviewed_by = 'operator',
    item_id = '${id(84, "a")}' where id = '${dec19}'`, "a read-back");
  if ("error" in mv) w19 = `refused ${mv.error.code}`;
  say(`W19 other-item holds=${holds19[0]?.h} accept-moved-to-other-item=${w19}`);

  // --- Round 4 (Codex re-review 3) ---
  // W20 the event's the CRM key and its title read across a client edit
  // (finding 1): Blair Lake holds the key; right after the matcher's roster
  // read, Blair is renamed Alice Lake and loses the key.
  await P.exec(`insert into public.clients (id, name, metadata) values ('${id(90)}', 'Alice Lake', '{}'), ('${id(91)}', 'Blair Lake', '{"crm_id": "overlap-key"}')`, "W20 clients");
  await P.exec(`insert into public.business_events (id, title, event_type, date_start, metadata) values ('${id(92, "e")}', 'Consultation Alice Lake', 'tattoo_session', '2099-01-01', '{"crm_client_id": "overlap-key"}')`, "W20 event");
  await P.exec(`insert into public.action_items (id, description, status, client_id, created_at) values
    ('${id(93, "a")}', 'Schedule Alice Lake''s session', 'open', '${id(90)}', '2026-11-20T14:00:00Z'),
    ('${id(94, "a")}', 'Book Blair Lake''s consultation', 'open', '${id(91)}', '2026-11-20T14:00:00Z')`, "W20 items");
  P.afterNextRosterRead(async () => {
    await P.exec(`update public.clients set name = 'Alice Lake', metadata = '{}' where id = '${id(91)}'`, "W20 edit");
  });
  await match(db, id(92, "e"), NOW);
  const who20 = await P.rows(`select c.name, a.id::text = '${id(93, "a")}' as alice_item from public.auto_resolve_decisions d
    join public.action_items a on a.id = d.item_id join public.clients c on c.id = a.client_id where d.evidence_event_id = '${id(92, "e")}'`);
  say(`W20 key-and-title proposed-for=${JSON.stringify(who20.map((r) => (r.alice_item ? "Alice's item" : "Blair's item")))}`);

  // W21 two matchers whose roster and item reads cross (finding 3): the left
  // one is held before its item read (before correction 4) or before its one
  // read (after); the right one reads, then is held before its sync; a second
  // item is added; the left one completes, then the right one.
  await P.exec(`insert into public.clients (id, name, metadata) values ('${id(95)}', 'Quinn Rose', '{}')`, "W21 client");
  await P.exec(`insert into public.business_events (id, title, event_type, date_start, metadata) values ('${id(96, "e")}', 'Consultation Quinn Rose', 'tattoo_session', '2099-01-01', '{}')`, "W21 event");
  await P.exec(`insert into public.action_items (id, description, status, client_id, created_at) values
    ('${id(97, "a")}', 'Book Quinn Rose''s session', 'open', '${id(95)}', '2026-11-20T14:00:00Z')`, "W21 first item");
  const gate = () => {
    let resume!: () => void, arrive!: () => void;
    const ready = new Promise<void>((f) => (arrive = f)), wait = new Promise<void>((f) => (resume = f));
    return { ready, resume, arrive, wait };
  };
  const pl = gate(), pr = gate();
  let leftHeld = false;
  const leftDb = { from: (t: string) => db.from(t), rpc: async (fn: string, args: Record<string, unknown>) => {
    if (!leftHeld && (fn === "client_open_items" || fn === "booking_match_read")) {
      leftHeld = true;
      pl.arrive();
      await pl.wait;
    }
    return await db.rpc(fn, args);
  } };
  const rightDb = { from: (t: string) => db.from(t), rpc: async (fn: string, args: Record<string, unknown>) => {
    if (fn === "sync_booking_proposals") {
      pr.arrive();
      await pr.wait;
    }
    return await db.rpc(fn, args);
  } };
  const left = match(leftDb, id(96, "e"), NOW);
  await pl.ready;
  const right = match(rightDb, id(96, "e"), NOW);
  await pr.ready;
  await P.exec(`insert into public.action_items (id, description, status, client_id, created_at) values
    ('${id(98, "a")}', 'Schedule Quinn Rose''s consultation', 'open', '${id(95)}', '2026-11-20T14:00:00Z')`, "W21 second item");
  pl.resume();
  const l21 = await left;
  const listed21 = async () => ((await db.rpc("calendar_pending_proposals", { p_limit: 500 })).data as Array<Record<string, unknown>>).filter((r) => r.event_id === id(96, "e")).length;
  const between21 = await listed21();
  pr.resume();
  const r21 = await right;
  say(`W21 crossed-reads left=${l21.status} listed-between=${between21} right=${r21.status} listed-after=${await listed21()}`);

  // W22 equivalent accent spellings in two roster rows (finding 2), and a
  // hyphenated first name's possessive (finding 4).
  await P.exec(`insert into public.clients (id, name, metadata) values ('${id(99)}', 'José Li', '{}'), ('${id(100)}', 'Jose' || chr(173) || chr(769) || ' Li', '{}')`, "W22 clients");
  const w22 = await capture(["Book José Li about the peony sleeve"]);
  await P.exec(`insert into public.clients (id, name, metadata) values ('${id(101)}', 'June-Marie Bell', '{"crm_id": "cb-jm"}')`, "W22 June-Marie");
  await P.exec(`insert into public.business_events (id, title, event_type, date_start, metadata) values ('${id(102, "e")}', 'Session: June-Marie Bell', 'tattoo_session', '2027-01-16', '{"crm_client_id": "cb-jm"}')`, "W22 event");
  await P.exec(`insert into public.action_items (id, description, status, client_id, created_at) values
    ('${id(103, "a")}', 'Book June-Marie''s session and email June-Marie Bell', 'open', '${id(101)}', '2026-11-20T14:00:00Z')`, "W22 item");
  await match(db, id(102, "e"), NOW);
  const d103 = await P.rows(`select 1 from public.auto_resolve_decisions where item_id = '${id(103, "a")}'`);
  say(`W22 equivalent-names ${JSON.stringify(w22.map((r) => [r.description, r.client]))} june-marie-possessive proposals=${d103.length}`);

  // --- Round 5 (Codex re-review 4) ---
  // W23 a second roster "José Li" spelled with U+034F (combining grapheme
  // joiner) inside its decomposed accent (finding 1).
  await P.exec(`delete from public.clients where id = '${id(100)}'`, "W23 previous duplicate");
  await P.exec(`insert into public.clients (id, name, metadata) values ('${id(104)}', 'Jose' || chr(847) || chr(769) || ' Li', '{}')`, "W23 client");
  const w23 = await capture(["Book José Li about the crane sleeve"]);
  say(`W23 grapheme-joiner ${JSON.stringify(w23.map((r) => [r.description, r.client]))}`);

  // W24 a compound first name's possessive written with a space (finding 2):
  // June-Marie Bell's 2027-01-16 session (W22).
  await P.exec(`insert into public.action_items (id, description, status, client_id, created_at) values
    ('${id(105, "a")}', 'Book June Marie''s session and email June-Marie Bell', 'open', '${id(101)}', '2026-11-20T14:00:00Z')`, "W24 item");
  await match(db, id(102, "e"));
  const d105 = await P.rows(`select 1 from public.auto_resolve_decisions where item_id = '${id(105, "a")}'`);
  say(`W24 spaced-compound-possessive proposals=${d105.length}`);

  // W25 a matcher whose caller clock is the previous UTC day (finding 3): the
  // session is dated yesterday by the database's own clock; the caller's
  // clock reads 23:59:59 of that day. Before correction 5 the caller's clock
  // decided "today"; from correction 5 the read's own time does.
  const yday = (await P.rows(`select ((now() at time zone 'utc')::date - 1)::text as d`))[0].d as string;
  await P.exec(`insert into public.clients (id, name, metadata) values ('${id(106)}', 'Remy Vale', '{}')`, "W25 client");
  await P.exec(`insert into public.business_events (id, title, event_type, date_start, metadata) values ('${id(107, "e")}', 'Session: Remy Vale', 'tattoo_session', '${yday}', '{}')`, "W25 event");
  await P.exec(`insert into public.action_items (id, description, status, client_id, created_at) values
    ('${id(108, "a")}', 'Book Remy Vale''s session', 'open', '${id(106)}', '2026-11-20T14:00:00Z')`, "W25 item");
  const r25 = await match(db, id(107, "e"), new Date(`${yday}T23:59:59Z`));
  const listed25 = ((await db.rpc("calendar_pending_proposals", { p_limit: 500 })).data as Array<Record<string, unknown>>).filter((r) => r.event_id === id(107, "e")).length;
  say(`W25 previous-day-clock status=${r25.status} past-session-listed=${listed25}`);

  // --- Round 6 (Codex re-review 5) ---
  // W26 a soft hyphen standing alone between Jordan's first and last names,
  // beside Alicia Brennan's full name (finding 1); both are clients (W4).
  const w26 = await capture(["Book Alicia Brennan and Jordan \u00ad Marlow about the paired koi"]);
  say(`W26 soft-hyphen-between-names ${JSON.stringify(w26.map((r) => [String(r.description).replace("\u00ad", "<SHY>"), r.client]))}`);

  // W27 roster names that look the same encoded differently (finding 2): a
  // format character (U+FFF9) inside a second "Tomás Wu" (a surname too short
  // for the first-name rule, as in Codex's "José Li"), and a Cyrillic o
  // in a second "Mira Sol".
  await P.exec(`insert into public.clients (id, name, metadata) values
    ('${id(111)}', 'Tomás Wu', '{}'), ('${id(112)}', 'Tom' || chr(65529) || 'ás Wu', '{}'),
    ('${id(113)}', 'Mira Sol', '{}'), ('${id(114)}', 'Mira S' || chr(1086) || 'l', '{}')`, "W27 clients");
  const w27 = await capture(["Book Tomás Wu about the tiger back piece", "Book Mira Sol about the lotus sleeve"]);
  say(`W27 confusables ${JSON.stringify(w27.map((r) => [r.description, r.client]))}`);

  // W28 the possessive span (finding 3): June Bell's 2027-01-16 session (W6)
  // against "early June June's", and June-James Bell's against "June James'".
  await P.exec(`insert into public.clients (id, name, metadata) values ('${id(115)}', 'June-James Bell', '{"crm_id": "cb-jj"}')`, "W28 client");
  await P.exec(`insert into public.business_events (id, title, event_type, date_start, metadata) values ('${id(116, "e")}', 'Session: June-James Bell', 'tattoo_session', '2027-01-16', '{"crm_client_id": "cb-jj"}')`, "W28 event");
  await P.exec(`insert into public.action_items (id, description, status, client_id, created_at) values
    ('${id(117, "a")}', 'Book for early June June''s next session and email June Bell', 'open', '${id(40)}', '2026-11-20T14:00:00Z'),
    ('${id(118, "a")}', 'Book June James' || chr(8217) || ' session and email June-James Bell', 'open', '${id(115)}', '2026-11-20T14:00:00Z')`, "W28 items");
  await match(db, id(43, "e"));
  await match(db, id(116, "e"));
  const d117 = await P.rows(`select 1 from public.auto_resolve_decisions where item_id = '${id(117, "a")}'`);
  const d118 = await P.rows(`select 1 from public.auto_resolve_decisions where item_id = '${id(118, "a")}'`);
  say(`W28 possessive-span early-june-proposals=${d117.length} june-james-trailing-apostrophe-proposals=${d118.length}`);
} catch (e) {
  say(`NEVER-RAN: the witness threw: ${e instanceof Error ? e.message : String(e)}`);
  Deno.exit(2);
}
const why = P.neverRan();
if (why && !why.startsWith("an expected refusal never happened")) {
  say(`NEVER-RAN: ${why}`);
  Deno.exit(2);
}
if (why) say(`NOTE ${why}`);
void names;
say("WITNESS COMPLETE");
