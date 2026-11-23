-- Loop-closing Task 5.3: the SQL contract for 20261121b_action_items_client_id.sql,
-- run by client-identity-sql-test.sh on a throwaway LOCAL cluster after the
-- prior migrations (20261105 decisions, 20261106 record_decisions and the
-- generation trigger, 20261107, 20261109b review_proposal, 20261120c) and the
-- migration under test.
--
-- Every check calls pg_temp.ck(id, ok, detail): a false or null ok raises
-- SQLSTATE OBC01 with "FAIL <id>: <detail>" (a COMPLETED assertion failure,
-- exit 1 in the runner); a true ok prints "PASS <id> ...". The runner also
-- requires the exact set of check ids listed in EXPECTED_CONTRACT there, each
-- exactly once; any other error, a missing or extra id, or no CONTRACT
-- COMPLETE line is NEVER-RAN (exit 2).
--
-- A note on snapshots: a subquery in the SAME statement that calls
-- record_decisions or sync_booking_proposals reads that statement's snapshot,
-- from before their inserts, so every read-back below is its own statement.
\set ON_ERROR_STOP 1

create function pg_temp.ck(p_id text, p_ok boolean, p_detail text) returns void
language plpgsql as $$
begin
  if p_ok is distinct from true then
    raise exception 'FAIL %: %', p_id, p_detail using errcode = 'OBC01';
  end if;
  raise notice 'PASS % %', p_id, p_detail;
end;
$$;

-- One proposal row for sync_booking_proposals / record_decisions. The
-- item's text as the matcher read it is the item's current description.
create function pg_temp.prow(p_item uuid, p_event uuid, p_client uuid, p_desc text) returns jsonb
language sql as $$
  select jsonb_build_object('layer', 'calendar', 'outcome', 'proposed', 'reason', 'booking_match',
    'candidate_description', p_desc, 'item_id', p_item, 'evidence_event_id', p_event,
    'quote', (select e.title || ' on ' || to_char(e.date_start, 'YYYY-MM-DD') from public.business_events e where e.id = p_event),
    'client_id', p_client,
    'item_description', (select a.description from public.action_items a where a.id = p_item))
$$;
create function pg_temp.snap(p_event uuid) returns jsonb
language sql as $$
  select public.booking_event_snapshot(e) from public.business_events e where e.id = p_event
$$;
-- A sync whose reads began now (the clock advances, so each is the newest).
create function pg_temp.sync(p_event uuid, p_rows jsonb) returns integer
language sql as $$
  select public.sync_booking_proposals(p_event, pg_temp.snap(p_event), clock_timestamp(), p_rows)
$$;
create function pg_temp.dec(p_item uuid, p_event uuid) returns uuid
language sql as $$
  select d.id from public.auto_resolve_decisions d
  where d.item_id = p_item and d.evidence_event_id = p_event and d.layer = 'calendar'
$$;
create function pg_temp.pending() returns setof uuid
language sql as $$
  select item_id from public.calendar_pending_proposals(500)
$$;

-- Fixtures: clients, a thought, events. E1 and E2 are one Google booking in
-- the two key forms (the REST race leaves two such rows); E4 and E5 carry no
-- key, same date and type; E3 and E7 are other bookings.
insert into public.clients (id, name, metadata, last_contact) values
  ('a11c1a00-0000-4000-8000-000000000001', 'Alicia Brennan', '{"crm_id": "cb-alicia"}', '2026-11-01'),
  ('1a4e0000-0000-4000-8000-000000000002', 'Jordan Marlow', '{"crm_id": "cb-jake"}', '2026-10-01'),
  ('1a4e0000-0000-4000-8000-000000000003', 'Jordan Ruiz', '{}', '2026-09-01'),
  ('de1e7e00-0000-4000-8000-000000000009', 'Deleted Client', '{}', '2026-01-01');
insert into public.thoughts (id, metadata) values ('7a5c0000-0000-4000-8000-000000000001', '{}');
insert into public.business_events (id, title, event_type, date_start, metadata) values
  ('e7e00000-0000-4000-8000-000000000001', 'Tattoo session: Alicia Brennan', 'tattoo_session', '2027-01-16', '{"status": "scheduled", "crm_client_id": "cb-alicia", "gcal_event_id": "g-one@google.com"}'),
  ('e7e00000-0000-4000-8000-000000000002', 'Tattoo session: Alicia Brennan', 'tattoo_session', '2027-01-16', '{"gcal_event_id": " G-ONE "}'),
  ('e7e00000-0000-4000-8000-000000000003', 'Tattoo session: Alicia Brennan (2)', 'tattoo_session', '2027-02-01', '{"gcal_event_id": "g-two"}'),
  ('e7e00000-0000-4000-8000-000000000004', 'Session: Alicia Brennan', 'tattoo_session', '2027-03-01', '{}'),
  ('e7e00000-0000-4000-8000-000000000005', 'Session: Alicia Brennan', 'tattoo_session', '2027-03-01', null),
  ('e7e00000-0000-4000-8000-000000000007', 'Session: Alicia Brennan', 'tattoo_session', '2027-04-01', '{"gcal_event_id": "g-seven"}'),
  ('e7e00000-0000-4000-8000-000000000008', 'Session: Alicia Brennan', 'tattoo_session', '2027-05-01', '{"gcal_event_id": "g-eight"}'),
  ('e7e00000-0000-4000-8000-000000000009', 'Tattoo session: Alicia Brennan', 'tattoo_session', '2027-01-16', '{"gcal_event_id": "g-nine"}'),
  ('e7e00000-0000-4000-8000-000000000010', 'Session: Alicia Brennan', 'tattoo_session', '2027-06-01', '{"gcal_event_id": "g-ten"}'),
  ('e7e00000-0000-4000-8000-000000000011', 'Session: Alicia Brennan', 'tattoo_session', '2027-06-01', '{"gcal_event_id": "g-ten@google.com"}');

-- M01: the column: uuid, nullable, no default.
select pg_temp.ck('M01',
  (select data_type = 'uuid' and is_nullable = 'YES' and column_default is null
   from information_schema.columns
   where table_schema = 'public' and table_name = 'action_items' and column_name = 'client_id'),
  'action_items.client_id is uuid, nullable, with no default');

-- M02: one foreign key on client_id, to clients(id), on delete set null.
select pg_temp.ck('M02',
  (select count(*) = 1 and bool_and(c.confrelid = 'public.clients'::regclass and c.confdeltype = 'n'
     and c.conkey = array[(select attnum from pg_attribute where attrelid = 'public.action_items'::regclass and attname = 'client_id')]
     and c.confkey = array[(select attnum from pg_attribute where attrelid = 'public.clients'::regclass and attname = 'id')])
   from pg_constraint c
   where c.conrelid = 'public.action_items'::regclass and c.contype = 'f'
     and (select attnum from pg_attribute where attrelid = 'public.action_items'::regclass and attname = 'client_id') = any(c.conkey)),
  'client_id references clients(id) on delete set null');

-- M03: null and a real client insert; an unknown uuid is refused by THIS
-- foreign key (only that error is caught; any other is not a verdict).
insert into public.action_items (id, description, status, client_id) values
  ('a0000001-0000-4000-8000-000000000000', 'Schedule tattoo appointment for Alicia Brennan', 'open', 'a11c1a00-0000-4000-8000-000000000001'),
  ('a0000002-0000-4000-8000-000000000000', 'nudge Jordan if nothing arrives', 'open', null),
  ('a0000003-0000-4000-8000-000000000000', 'Book the deleted client session', 'open', 'de1e7e00-0000-4000-8000-000000000009'),
  ('a0000004-0000-4000-8000-000000000000', 'Book Alicia Brennan''s session', 'open', 'a11c1a00-0000-4000-8000-000000000001');
do $$
declare v_name text := 'none';
begin
  begin
    insert into public.action_items (description, status, client_id)
    values ('orphan', 'open', '00000000-0000-4000-8000-0000000000ff');
  exception when foreign_key_violation then
    get stacked diagnostics v_name = constraint_name;
  end;
  perform pg_temp.ck('M03', v_name = 'action_items_client_id_fkey' and (select count(*) = 4 from public.action_items),
    format('null and real client_id insert; an unknown uuid is refused by action_items_client_id_fkey (got %s)', v_name));
end $$;

-- M04: deleting a client leaves its item, with client_id null.
delete from public.clients where id = 'de1e7e00-0000-4000-8000-000000000009';
select pg_temp.ck('M04',
  (select status = 'open' and client_id is null from public.action_items where id = 'a0000003-0000-4000-8000-000000000000'),
  'a deleted client leaves its item open with client_id null');

-- M05: the partial index on open items of one client.
select pg_temp.ck('M05',
  (select count(*) = 1 from pg_indexes
   where schemaname = 'public' and tablename = 'action_items' and indexname = 'action_items_client_open_idx'
     and indexdef like '%(client_id)%' and indexdef like '%client_id IS NOT NULL%' and indexdef like '%status = ''open''%'),
  'action_items_client_open_idx (client_id) where client_id is not null and status = open');

-- B01: the roster is one value: every client in id order, its count and the
-- read time; over p_max, the count without the rows.
select pg_temp.ck('B01',
  (select (r->>'total')::int = 3 and (case when jsonb_typeof(r->'clients') = 'array' then jsonb_array_length(r->'clients') end) = 3
     and r->'clients'->0->>'id' = '1a4e0000-0000-4000-8000-000000000002' and r->'clients'->2->>'name' = 'Alicia Brennan'
     and (r->>'read_at')::timestamptz is not null
   from public.client_roster(3) r)
  and (select (r->>'total')::int = 3 and r->'clients' = 'null'::jsonb from public.client_roster(2) r),
  'client_roster: every client in id order, the count and the read time in one value; over p_max the rows are left out');
-- B02: everything a booking match depends on, in one value from one
-- statement: the event, every client with its the CRM key, every open
-- item that carries a client (A1 and A4; A2 has no client, A3 lost its client
-- in M04; A12 is resolved, so it is not read), the counts and the read time;
-- over a cap that list is left out; a missing event reads null.
insert into public.action_items (id, description, status, client_id) values
  ('a000000c-0000-4000-8000-000000000000', 'Book Alicia Brennan''s old session', 'resolved', 'a11c1a00-0000-4000-8000-000000000001');
select pg_temp.ck('B02',
  (select r->'event'->>'id' = 'e7e00000-0000-4000-8000-000000000001' and r->'event'->>'title' = 'Tattoo session: Alicia Brennan'
     and r->'event'->'metadata'->>'crm_client_id' = 'cb-alicia' and r->'event'->>'date_start' = '2027-01-16'
     and (r->>'clients_total')::int = 3 and (case when jsonb_typeof(r->'clients') = 'array' then jsonb_array_length(r->'clients') end) = 3
     and r->'clients'->2->>'name' = 'Alicia Brennan' and r->'clients'->2->>'crm_id' = 'cb-alicia'
     and r->'clients'->1->'crm_id' = 'null'::jsonb
     and (r->>'items_total')::int = 2 and (case when jsonb_typeof(r->'items') = 'array' then jsonb_array_length(r->'items') end) = 2
     and r->'items'->0->>'id' = 'a0000001-0000-4000-8000-000000000000' and r->'items'->1->>'description' = 'Book Alicia Brennan''s session'
     and r->'items'->1->>'client_id' = 'a11c1a00-0000-4000-8000-000000000001' and r->'items'->1->>'status' = 'open'
     and (r->'items'->0->>'created_at')::timestamptz is not null and (r->>'read_at')::timestamptz is not null
   from public.booking_match_read('e7e00000-0000-4000-8000-000000000001', 3, 2) r)
  and (select (r->>'clients_total')::int = 3 and r->'clients' = 'null'::jsonb and (r->>'items_total')::int = 2 and r->'items' = 'null'::jsonb
       from public.booking_match_read('e7e00000-0000-4000-8000-000000000001', 2, 1) r)
  and (select r->'event' = 'null'::jsonb from public.booking_match_read('00000000-0000-4000-8000-0000000000ee', 10, 10) r),
  'booking_match_read: the event, every client with its the CRM key, every open item with a client, counts and read time in one value; over a cap the list is left out');
delete from public.action_items where id = 'a000000c-0000-4000-8000-000000000000';

-- T01: the support and sync tables: keys, cascading foreign keys, RLS on.
select pg_temp.ck('T01',
  (select count(*) = 7 from information_schema.columns
   where table_schema = 'public' and table_name = 'calendar_proposal_support'
     and (column_name, data_type, is_nullable) in (('decision_id', 'uuid', 'NO'), ('item_id', 'uuid', 'NO'), ('event_id', 'uuid', 'NO'),
          ('client_id', 'uuid', 'NO'), ('item_description', 'text', 'NO'),
          ('event_snapshot', 'jsonb', 'NO'), ('checked_at', 'timestamp with time zone', 'NO')))
  and (select count(*) = 1 from pg_constraint where conrelid = 'public.calendar_proposal_support'::regclass and contype = 'p')
  and (select count(*) = 4 and bool_and(confdeltype = 'c') from pg_constraint where conrelid = 'public.calendar_proposal_support'::regclass and contype = 'f')
  and (select relrowsecurity from pg_class where oid = 'public.calendar_proposal_support'::regclass)
  and (select count(*) = 2 from information_schema.columns
       where table_schema = 'public' and table_name = 'calendar_event_sync'
         and (column_name, data_type, is_nullable) in (('event_id', 'uuid', 'NO'), ('read_at', 'timestamp with time zone', 'NO')))
  and (select count(*) = 1 and bool_and(confdeltype = 'c') from pg_constraint where conrelid = 'public.calendar_event_sync'::regclass and contype = 'f')
  and (select relrowsecurity from pg_class where oid = 'public.calendar_event_sync'::regclass),
  'calendar_proposal_support: seven not-null columns, a primary key, four cascading foreign keys, RLS; calendar_event_sync: two columns, a cascading key, RLS');

-- G01: grants. Every new function executes for service_role only; the
-- support table is service_role's; record_decisions still executes for
-- service_role.
select pg_temp.ck('G01',
  has_column_privilege('service_role', 'public.action_items', 'client_id', 'select')
  and has_column_privilege('service_role', 'public.action_items', 'client_id', 'update')
  and has_column_privilege('service_role', 'public.action_items', 'client_id', 'insert')
  and has_function_privilege('service_role', 'public.record_decisions(jsonb)', 'execute')
  and (select bool_and(has_function_privilege('service_role', f, 'execute') and not has_function_privilege('anon', f, 'execute')
                       and not has_function_privilege('authenticated', f, 'execute'))
       from unnest(array['public.calendar_pending_proposals(integer)', 'public.sync_booking_proposals(uuid, jsonb, timestamptz, jsonb)',
                         'public.client_roster(integer)', 'public.booking_match_read(uuid, integer, integer)',
                         'public.calendar_proposal_supported(uuid)', 'public.calendar_support_holds(uuid, uuid, uuid)',
                         'public.booking_event_snapshot(public.business_events)',
                         'public.booking_gcal_key(public.business_events)',
                         'public.booking_same(public.business_events, public.business_events)']) f)
  and not exists (select 1 from information_schema.routine_privileges
                  where routine_schema = 'public' and grantee = 'PUBLIC'
                    and routine_name in ('calendar_pending_proposals', 'sync_booking_proposals', 'calendar_proposal_supported', 'calendar_support_holds',
                                         'client_roster', 'booking_match_read',
                                         'booking_event_snapshot', 'booking_gcal_key', 'booking_same', 'calendar_support_guard'))
  and has_table_privilege('service_role', 'public.calendar_proposal_support', 'select, insert, update, delete')
  and not has_table_privilege('anon', 'public.calendar_proposal_support', 'select')
  and not has_table_privilege('authenticated', 'public.calendar_proposal_support', 'select')
  and has_table_privilege('service_role', 'public.calendar_event_sync', 'select, insert, update, delete')
  and not has_table_privilege('anon', 'public.calendar_event_sync', 'select')
  and not has_table_privilege('authenticated', 'public.calendar_event_sync', 'select'),
  'service_role reads and writes client_id and the support and sync tables; every new function executes for service_role only; record_decisions still executes for service_role');

-- S01: shapes. The read and the predicates are stable sql, security invoker,
-- search_path pinned; the sync is volatile plpgsql, security invoker; the
-- guard is a before insert-or-update row trigger on auto_resolve_decisions.
select pg_temp.ck('S01',
  (select count(*) filter (where p.provolatile = 's' and not p.prosecdef and p.proconfig = array['search_path=pg_catalog, public'] and l.lanname = 'sql') = 8
   from pg_proc p join pg_language l on l.oid = p.prolang
   where p.oid in ('public.calendar_pending_proposals(integer)'::regprocedure, 'public.calendar_proposal_supported(uuid)'::regprocedure,
                   'public.client_roster(integer)'::regprocedure, 'public.booking_match_read(uuid, integer, integer)'::regprocedure,
                   'public.calendar_support_holds(uuid, uuid, uuid)'::regprocedure,
                   'public.booking_event_snapshot(public.business_events)'::regprocedure, 'public.booking_gcal_key(public.business_events)'::regprocedure,
                   'public.booking_same(public.business_events, public.business_events)'::regprocedure))
  and (select count(*) = 1 from pg_proc p join pg_language l on l.oid = p.prolang
       where p.oid = 'public.sync_booking_proposals(uuid, jsonb, timestamptz, jsonb)'::regprocedure
         and p.provolatile = 'v' and not p.prosecdef and p.proconfig = array['search_path=pg_catalog, public'] and l.lanname = 'plpgsql')
  and (select count(*) = 1 from pg_trigger t where t.tgrelid = 'public.auto_resolve_decisions'::regclass
       and t.tgname = 'auto_resolve_decisions_calendar_support_guard' and t.tgenabled = 'O'
       and t.tgtype = 23 and t.tgfoid = 'public.calendar_support_guard()'::regprocedure),
  'read and predicates are stable sql security invoker with a pinned search_path; the sync is volatile plpgsql; the guard is a before insert-or-update row trigger');

-- K01: the snapshot and the booking identity.
select pg_temp.ck('K01',
  pg_temp.snap('e7e00000-0000-4000-8000-000000000001') = '{"title": "Tattoo session: Alicia Brennan", "event_type": "tattoo_session", "date_start": "2027-01-16", "status": "scheduled", "crm_client_id": "cb-alicia"}'::jsonb
  and pg_temp.snap('e7e00000-0000-4000-8000-000000000005') = '{"title": "Session: Alicia Brennan", "event_type": "tattoo_session", "date_start": "2027-03-01", "status": null, "crm_client_id": null}'::jsonb
  and (select public.booking_gcal_key(e) = 'g-one' from public.business_events e where e.id = 'e7e00000-0000-4000-8000-000000000001')
  and (select public.booking_gcal_key(e) = 'g-one' from public.business_events e where e.id = 'e7e00000-0000-4000-8000-000000000002')
  and (select public.booking_same(a, b) from public.business_events a, public.business_events b
       where a.id = 'e7e00000-0000-4000-8000-000000000001' and b.id = 'e7e00000-0000-4000-8000-000000000002')
  and (select not public.booking_same(a, b) from public.business_events a, public.business_events b
       where a.id = 'e7e00000-0000-4000-8000-000000000001' and b.id = 'e7e00000-0000-4000-8000-000000000003')
  and (select public.booking_same(a, b) from public.business_events a, public.business_events b
       where a.id = 'e7e00000-0000-4000-8000-000000000004' and b.id = 'e7e00000-0000-4000-8000-000000000005')
  and (select not public.booking_same(a, b) from public.business_events a, public.business_events b
       where a.id = 'e7e00000-0000-4000-8000-000000000001' and b.id = 'e7e00000-0000-4000-8000-000000000004')
  and (select not public.booking_same(a, b) from public.business_events a, public.business_events b
       where a.id = 'e7e00000-0000-4000-8000-000000000001' and b.id = 'e7e00000-0000-4000-8000-000000000009'),
  'the snapshot names title, type, date, status and the CRM client (null when absent); the Google key is trimmed, lowercased and stripped of @google.com; two different keys on the same day are two bookings; no key falls back to date and type');

-- D01: the calendar payload: record_decisions accepts the mapped row, and the
-- same row without evidence_event_id is refused by the payload CHECK.
select pg_temp.ck('D01a',
  public.record_decisions(jsonb_build_array(pg_temp.prow('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000001',
    'a11c1a00-0000-4000-8000-000000000001', 'Schedule tattoo appointment for Alicia Brennan'))) = 1,
  'the calendar/proposed/booking_match row lands through record_decisions');
select pg_temp.ck('D01c',
  (select count(*) = 1 and bool_and(item_generation = 0 and thought_id is null and evidence_thought_id is null
     and evidence_event_id = 'e7e00000-0000-4000-8000-000000000001' and outcome = 'proposed')
   from public.auto_resolve_decisions where layer = 'calendar'),
  'the landed row is stamped generation 0 with the typed event evidence and no thought id');
do $$
declare v_name text := 'none';
begin
  begin
    perform public.record_decisions('[{"layer": "calendar", "outcome": "proposed", "reason": "booking_match",
       "candidate_description": "x", "item_id": "a0000001-0000-4000-8000-000000000000",
       "quote": "Tattoo session on 2027-01-16"}]'::jsonb);
  exception when check_violation then
    get stacked diagnostics v_name = constraint_name;
  end;
  perform pg_temp.ck('D01b', v_name = 'auto_resolve_decision_payload_ok',
    format('a calendar row without evidence_event_id is refused by auto_resolve_decision_payload_ok (got %s)', v_name));
end $$;

-- Y01: a sync for E1 with A1 (already proposed) and A4 (new): one row written,
-- both supported with E1's snapshot and Alicia as client.
select pg_temp.ck('Y01a',
  pg_temp.sync('e7e00000-0000-4000-8000-000000000001', jsonb_build_array(
    pg_temp.prow('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000001', 'a11c1a00-0000-4000-8000-000000000001', 'Schedule tattoo appointment for Alicia Brennan'),
    pg_temp.prow('a0000004-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000001', 'a11c1a00-0000-4000-8000-000000000001', 'Book Alicia Brennan''s session'))) = 1,
  'the sync writes only the new proposal (the other already exists)');
select pg_temp.ck('Y01b',
  (select count(*) = 2 and bool_and(s.client_id = 'a11c1a00-0000-4000-8000-000000000001'
     and s.event_snapshot = pg_temp.snap('e7e00000-0000-4000-8000-000000000001') and public.calendar_proposal_supported(s.decision_id))
   from public.calendar_proposal_support s),
  'both proposals carry support with the event snapshot and the client, and read as supported');
-- Y02: the same sync again writes nothing and keeps both supported.
select pg_temp.ck('Y02',
  pg_temp.sync('e7e00000-0000-4000-8000-000000000001', jsonb_build_array(
    pg_temp.prow('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000001', 'a11c1a00-0000-4000-8000-000000000001', 'again'),
    pg_temp.prow('a0000004-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000001', 'a11c1a00-0000-4000-8000-000000000001', 'again'))) = 0,
  'a re-fired sync of the same event writes no row');
select pg_temp.ck('Y02b',
  (select count(*) = 2 from public.auto_resolve_decisions where layer = 'calendar')
  and (select count(*) = 2 from public.calendar_proposal_support),
  'still two proposals and two support rows');
-- Y03: E2 is the same Google booking as E1 (other key form): nothing new.
select pg_temp.ck('Y03',
  pg_temp.sync('e7e00000-0000-4000-8000-000000000002', jsonb_build_array(
    pg_temp.prow('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000002', 'a11c1a00-0000-4000-8000-000000000001', 'dup'))) = 0,
  'a second event row for the same Google booking proposes nothing');
select pg_temp.ck('Y03b',
  pg_temp.dec('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000002') is null,
  'no decision row names the second event row');
-- Y04: E3 is another booking: proposes. E4 then E5 (no key, same date and
-- type): the second proposes nothing.
select pg_temp.ck('Y04a',
  pg_temp.sync('e7e00000-0000-4000-8000-000000000003', jsonb_build_array(
    pg_temp.prow('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000003', 'a11c1a00-0000-4000-8000-000000000001', 'Schedule tattoo appointment for Alicia Brennan'))) = 1
  and pg_temp.sync('e7e00000-0000-4000-8000-000000000004', jsonb_build_array(
    pg_temp.prow('a0000004-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000004', 'a11c1a00-0000-4000-8000-000000000001', 'Book Alicia Brennan''s session'))) = 1,
  'another Google booking, and a keyless booking on another date, each propose');
select pg_temp.ck('Y04b',
  pg_temp.sync('e7e00000-0000-4000-8000-000000000005', jsonb_build_array(
    pg_temp.prow('a0000004-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000005', 'a11c1a00-0000-4000-8000-000000000001', 'dup'))) = 0,
  'a second keyless event row on the same date and type proposes nothing');
select pg_temp.ck('Y04c',
  pg_temp.dec('a0000004-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000005') is null,
  'no decision row names the second keyless event row');

-- P01: the pending read lists the four supported proposals, oldest first,
-- with the event's title and date.
select pg_temp.ck('P01',
  (select count(*) = 4 and bool_and(pending_total = 4)
     and count(*) filter (where item_id = 'a0000001-0000-4000-8000-000000000000' and event_id = 'e7e00000-0000-4000-8000-000000000001'
                            and event_title = 'Tattoo session: Alicia Brennan' and event_date = '2027-01-16') = 1
     and bool_and(ok)
   from (select *, proposed_at >= lag(proposed_at, 1, '-infinity') over (order by ord) as ok
         from (select *, row_number() over () as ord from public.calendar_pending_proposals(200)) x) y),
  'four supported pending rows, oldest first, with title and date, pending_total 4');

-- Y05: E3 reassigned to Jordan Marlow: its proposal is no longer supported,
-- leaves the read, and done on it is refused by the guard (and writes
-- nothing); the read still lists the other three.
update public.business_events set title = 'Consultation: Jordan Marlow', event_type = 'consultation',
  metadata = '{"crm_client_id": "cb-jake"}' where id = 'e7e00000-0000-4000-8000-000000000003';
select pg_temp.ck('Y05a',
  not public.calendar_proposal_supported(pg_temp.dec('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000003'))
  and (select count(*) = 3 from public.calendar_pending_proposals(200)),
  'a changed event hides its proposal until the matcher re-checks it');
do $$
declare v_state text := 'none'; v_msg text := '';
begin
  begin
    perform * from public.review_proposal('a0000001-0000-4000-8000-000000000000', 'done', 'operator', 'mcp-shared-key',
      left(pg_temp.dec('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000003')::text, 8));
  exception when raise_exception then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  perform pg_temp.ck('Y05b', v_state = 'P0001' and v_msg like '%no longer supported by its booking%'
      and (select status = 'open' from public.action_items where id = 'a0000001-0000-4000-8000-000000000000')
      and (select outcome = 'proposed' from public.auto_resolve_decisions where id = pg_temp.dec('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000003')),
    format('done on an unsupported proposal is refused and writes nothing (got %s: %s)', v_state, v_msg));
end $$;
-- Y06: the matcher re-runs for E3 with no rows: the support row is withdrawn.
select public.sync_booking_proposals('e7e00000-0000-4000-8000-000000000003', pg_temp.snap('e7e00000-0000-4000-8000-000000000003'), null, '[]'::jsonb);
select pg_temp.ck('Y06',
  not exists (select 1 from public.calendar_proposal_support
              where decision_id = pg_temp.dec('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000003')),
  'a sync with no rows withdraws the event''s support');
-- Y07: cancelling E1 hides both its proposals; restoring it brings them back
-- (the recorded snapshot matches again).
update public.business_events set metadata = metadata || '{"status": "cancelled"}' where id = 'e7e00000-0000-4000-8000-000000000001';
select pg_temp.ck('Y07a',
  (select count(*) = 1 and bool_and(event_id = 'e7e00000-0000-4000-8000-000000000004') from public.calendar_pending_proposals(200)),
  'a cancelled event''s proposals are not pending');
update public.business_events set metadata = metadata || '{"status": "scheduled"}' where id = 'e7e00000-0000-4000-8000-000000000001';
select pg_temp.ck('Y07b',
  (select count(*) = 3 from public.calendar_pending_proposals(200)),
  'restoring the event restores its supported proposals');
-- Y08: the item's client changing (another client, or none after a delete)
-- withdraws support for its proposals; restoring it restores them.
update public.action_items set client_id = '1a4e0000-0000-4000-8000-000000000002' where id = 'a0000004-0000-4000-8000-000000000000';
select pg_temp.ck('Y08a',
  (select count(*) = 1 and bool_and(item_id = 'a0000001-0000-4000-8000-000000000000') from public.calendar_pending_proposals(200)),
  'proposals whose item now names another client are not pending');
update public.action_items set client_id = 'a11c1a00-0000-4000-8000-000000000001' where id = 'a0000004-0000-4000-8000-000000000000';
select pg_temp.ck('Y08b',
  (select count(*) = 3 from public.calendar_pending_proposals(200)),
  'restoring the item''s client restores them');
-- Y09: an unsupported proposal for the same booking does not block a new
-- one: E10 proposes A6, E10 is then cancelled, E11 (the same Google booking)
-- proposes A6.
insert into public.action_items (id, description, status, client_id) values
  ('a0000006-0000-4000-8000-000000000000', 'Book Alicia Brennan''s June session', 'open', 'a11c1a00-0000-4000-8000-000000000001');
select pg_temp.sync('e7e00000-0000-4000-8000-000000000010', jsonb_build_array(
  pg_temp.prow('a0000006-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000010', 'a11c1a00-0000-4000-8000-000000000001', 'Book Alicia Brennan''s June session')));
update public.business_events set metadata = metadata || '{"status": "cancelled"}' where id = 'e7e00000-0000-4000-8000-000000000010';
select pg_temp.ck('Y09',
  pg_temp.sync('e7e00000-0000-4000-8000-000000000011', jsonb_build_array(
    pg_temp.prow('a0000006-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000011', 'a11c1a00-0000-4000-8000-000000000001', 'Book Alicia Brennan''s June session'))) = 1,
  'a same-booking proposal that is no longer supported does not block the new event row');
update public.action_items set status = 'archived' where id = 'a0000006-0000-4000-8000-000000000000';

-- Y10: a matcher that read the event before a later write does not undo the
-- later write's sync (Codex re-review 1, finding 4): the title changes, the
-- current snapshot is synced (both proposals supported again), then the
-- earlier snapshot arrives with an empty set: it answers -1 and changes
-- nothing. The title is then restored and re-synced.
create temp table obci_old_snap as select pg_temp.snap('e7e00000-0000-4000-8000-000000000001') as s;
update public.business_events set title = 'Tattoo session: Alicia Brennan (moved room)' where id = 'e7e00000-0000-4000-8000-000000000001';
select pg_temp.sync('e7e00000-0000-4000-8000-000000000001', jsonb_build_array(
  pg_temp.prow('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000001', 'a11c1a00-0000-4000-8000-000000000001', 'x'),
  pg_temp.prow('a0000004-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000001', 'a11c1a00-0000-4000-8000-000000000001', 'x')));
select pg_temp.ck('Y10a',
  public.sync_booking_proposals('e7e00000-0000-4000-8000-000000000001', (select s from obci_old_snap), clock_timestamp(), '[]'::jsonb) = -1,
  'a sync carrying a snapshot the event no longer has answers -1');
select pg_temp.ck('Y10b',
  (select count(*) = 3 from public.calendar_pending_proposals(200)),
  'the stale sync changed nothing: the current booking''s proposals are still pending');
update public.business_events set title = 'Tattoo session: Alicia Brennan' where id = 'e7e00000-0000-4000-8000-000000000001';
select pg_temp.sync('e7e00000-0000-4000-8000-000000000001', jsonb_build_array(
  pg_temp.prow('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000001', 'a11c1a00-0000-4000-8000-000000000001', 'x'),
  pg_temp.prow('a0000004-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000001', 'a11c1a00-0000-4000-8000-000000000001', 'x')));

-- G02: a direct update to accepted on an unsupported calendar row is refused
-- too; a kept review is not.
do $$
declare v_state text := 'none';
begin
  begin
    update public.auto_resolve_decisions set outcome = 'accepted', review_seq = 1, reviewed_at = now(), reviewed_by = 'operator'
    where id = pg_temp.dec('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000003');
  exception when raise_exception then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.ck('G02', v_state = 'P0001'
    and (select outcome = 'proposed' from public.auto_resolve_decisions where id = pg_temp.dec('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000003')),
    format('a direct accept of an unsupported calendar row is refused (got %s)', v_state));
end $$;

-- G03: an INSERT of an accepted calendar row is refused (no row can be
-- supported before it exists).
do $$
declare v_state text := 'none';
begin
  begin
    insert into public.auto_resolve_decisions (layer, outcome, reason, candidate_description, item_id, evidence_event_id, quote,
                                               review_seq, reviewed_at, reviewed_by)
    values ('calendar', 'accepted', 'booking_match', 'x', 'a0000001-0000-4000-8000-000000000000',
            'e7e00000-0000-4000-8000-000000000007', 'q', 1, now(), 'operator');
  exception when raise_exception then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.ck('G03', v_state = 'P0001'
    and pg_temp.dec('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000007') is null,
    format('an inserted accepted calendar row is refused (got %s)', v_state));
end $$;
-- G04: an UPDATE that accepts a SUPPORTED row while moving it to another
-- event is judged on the incoming event, and refused.
do $$
declare v_state text := 'none';
begin
  begin
    update public.auto_resolve_decisions set outcome = 'accepted', review_seq = 1, reviewed_at = now(), reviewed_by = 'operator',
      evidence_event_id = 'e7e00000-0000-4000-8000-000000000007'
    where id = pg_temp.dec('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000001');
  exception when raise_exception then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.ck('G04', v_state = 'P0001'
    and (select outcome = 'proposed' and evidence_event_id = 'e7e00000-0000-4000-8000-000000000001'
         from public.auto_resolve_decisions where id = pg_temp.dec('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000001')),
    format('accepting a supported row while moving it to an unsupported event is refused (got %s)', v_state));
end $$;

-- Correction 3, finding E (Codex re-review 2, finding 5): support binds the
-- exact item and event pair, and the item's text as the matcher read it.
-- A7 is the same client's non-scheduling item; A11 has A1's exact text (a
-- duplicate item), so only the pair tells them apart.
insert into public.action_items (id, description, status, client_id) values
  ('a0000007-0000-4000-8000-000000000000', 'Send Alicia Brennan the design', 'open', 'a11c1a00-0000-4000-8000-000000000001'),
  ('a000000b-0000-4000-8000-000000000000', 'Schedule tattoo appointment for Alicia Brennan', 'open', 'a11c1a00-0000-4000-8000-000000000001');
select pg_temp.ck('H01',
  public.calendar_support_holds(pg_temp.dec('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000001'),
    'a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000001')
  and not public.calendar_support_holds(pg_temp.dec('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000001'),
    'a0000007-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000001')
  and not public.calendar_support_holds(pg_temp.dec('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000001'),
    'a0000004-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000001')
  and not public.calendar_support_holds(pg_temp.dec('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000001'),
    'a000000b-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000001'),
  'support holds for the pair the matcher validated, never for another item of the same client (scheduling or not, same text or not)');
-- G05: accepting a supported row while moving it to another item of the same
-- client, on the same event, is refused.
do $$
declare v_state text := 'none';
begin
  begin
    update public.auto_resolve_decisions set outcome = 'accepted', review_seq = 1, reviewed_at = now(), reviewed_by = 'operator',
      item_id = 'a0000007-0000-4000-8000-000000000000'
    where id = pg_temp.dec('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000001');
  exception when raise_exception then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.ck('G05', v_state = 'P0001'
    and (select outcome = 'proposed' and item_id = 'a0000001-0000-4000-8000-000000000000'
         from public.auto_resolve_decisions where id = pg_temp.dec('a0000001-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000001')),
    format('accepting a supported row while moving it to another item of the same client is refused (got %s)', v_state));
end $$;
-- H02: the item's text changing after the match hides its proposal (the
-- predicate and the date rule were applied to the old text); restoring the
-- text restores it.
update public.action_items set description = 'Send Alicia Brennan the design' where id = 'a0000001-0000-4000-8000-000000000000';
select pg_temp.ck('H02a',
  (select count(*) = 2 from public.calendar_pending_proposals(200))
  and not exists (select 1 from public.calendar_pending_proposals(200) where item_id = 'a0000001-0000-4000-8000-000000000000'),
  'an item whose text changed after the match is not pending');
update public.action_items set description = 'Schedule tattoo appointment for Alicia Brennan' where id = 'a0000001-0000-4000-8000-000000000000';
select pg_temp.ck('H02b',
  (select count(*) = 3 from public.calendar_pending_proposals(200)),
  'restoring the item''s text restores its proposal');
delete from public.action_items where id in ('a0000007-0000-4000-8000-000000000000', 'a000000b-0000-4000-8000-000000000000');

-- Y11 (correction 3, finding D; Codex re-review 2, finding 4): syncs of one
-- event apply in the order their reads began. E9 is unchanged throughout.
insert into public.action_items (id, description, status, client_id) values
  ('a0000008-0000-4000-8000-000000000000', 'Book Alicia Brennan''s session one', 'open', 'a11c1a00-0000-4000-8000-000000000001'),
  ('a0000009-0000-4000-8000-000000000000', 'Book Alicia Brennan''s session two', 'open', 'a11c1a00-0000-4000-8000-000000000001'),
  ('a000000a-0000-4000-8000-000000000000', 'Book Alicia Brennan''s session three', 'open', 'a11c1a00-0000-4000-8000-000000000001');
create function pg_temp.rows9(p_items uuid[]) returns jsonb
language sql as $$
  select jsonb_agg(pg_temp.prow(i, 'e7e00000-0000-4000-8000-000000000009', 'a11c1a00-0000-4000-8000-000000000001', 'x') order by i)
  from unnest(p_items) i
$$;
create function pg_temp.support9() returns uuid[]
language sql as $$
  select coalesce(array_agg(s.item_id order by s.item_id), '{}') from public.calendar_proposal_support s
  where s.event_id = 'e7e00000-0000-4000-8000-000000000009'
$$;
select pg_temp.ck('Y11a',
  public.sync_booking_proposals('e7e00000-0000-4000-8000-000000000009', pg_temp.snap('e7e00000-0000-4000-8000-000000000009'), '2000-01-01 00:00:02+00',
    pg_temp.rows9(array['a0000008-0000-4000-8000-000000000000', 'a0000009-0000-4000-8000-000000000000', 'a000000a-0000-4000-8000-000000000000']::uuid[])) = 3,
  'a sync whose reads began at :02 proposes and supports all three items');
select pg_temp.ck('Y11b',
  public.sync_booking_proposals('e7e00000-0000-4000-8000-000000000009', pg_temp.snap('e7e00000-0000-4000-8000-000000000009'), '2000-01-01 00:00:01+00',
    pg_temp.rows9(array['a0000008-0000-4000-8000-000000000000', 'a0000009-0000-4000-8000-000000000000']::uuid[])) = -2,
  'a later-arriving sync whose reads began EARLIER (:01, two items) answers -2');
select pg_temp.ck('Y11c',
  pg_temp.support9() = array['a0000008-0000-4000-8000-000000000000', 'a0000009-0000-4000-8000-000000000000', 'a000000a-0000-4000-8000-000000000000']::uuid[]
  and (select read_at = '2000-01-01 00:00:02+00' from public.calendar_event_sync where event_id = 'e7e00000-0000-4000-8000-000000000009'),
  'the older sync changed nothing: all three items keep their support, and the applied read time stays :02');
do $$
declare v_state text := 'none';
begin
  begin
    perform public.sync_booking_proposals('e7e00000-0000-4000-8000-000000000009', pg_temp.snap('e7e00000-0000-4000-8000-000000000009'), null,
      pg_temp.rows9(array['a0000008-0000-4000-8000-000000000000']::uuid[]));
  exception when invalid_parameter_value then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.ck('Y11d', v_state = '22023'
    and pg_temp.support9() = array['a0000008-0000-4000-8000-000000000000', 'a0000009-0000-4000-8000-000000000000', 'a000000a-0000-4000-8000-000000000000']::uuid[],
    format('rows with no read time are refused and change nothing (got %s)', v_state));
end $$;
select pg_temp.ck('Y11e',
  public.sync_booking_proposals('e7e00000-0000-4000-8000-000000000009', pg_temp.snap('e7e00000-0000-4000-8000-000000000009'), '2000-01-01 00:00:03+00',
    pg_temp.rows9(array['a0000008-0000-4000-8000-000000000000', 'a0000009-0000-4000-8000-000000000000']::uuid[])) = 0
  and pg_temp.support9() = array['a0000008-0000-4000-8000-000000000000', 'a0000009-0000-4000-8000-000000000000']::uuid[],
  'a NEWER sync (:03) without the third item withdraws its support');
select public.sync_booking_proposals('e7e00000-0000-4000-8000-000000000009', pg_temp.snap('e7e00000-0000-4000-8000-000000000009'), null, '[]'::jsonb);
update public.action_items set status = 'archived'
where id in ('a0000008-0000-4000-8000-000000000000', 'a0000009-0000-4000-8000-000000000000', 'a000000a-0000-4000-8000-000000000000');

-- P02: a reopened item's older proposals are history; the same booking
-- never re-proposes; a different booking does, in the new generation.
update public.action_items set status = 'resolved' where id = 'a0000004-0000-4000-8000-000000000000';
update public.action_items set status = 'open' where id = 'a0000004-0000-4000-8000-000000000000';
select pg_temp.ck('P02a',
  (select reopen_generation = 1 from public.action_items where id = 'a0000004-0000-4000-8000-000000000000')
  and (select count(*) = 1 and bool_and(item_id = 'a0000001-0000-4000-8000-000000000000') from public.calendar_pending_proposals(200)),
  'after a reopen the older generation''s proposals are history, not pending');
select pg_temp.ck('P02b',
  pg_temp.sync('e7e00000-0000-4000-8000-000000000004', jsonb_build_array(
    pg_temp.prow('a0000004-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000004', 'a11c1a00-0000-4000-8000-000000000001', 'again'))) = 0
  and pg_temp.sync('e7e00000-0000-4000-8000-000000000007', jsonb_build_array(
    pg_temp.prow('a0000004-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000007', 'a11c1a00-0000-4000-8000-000000000001', 'Book Alicia Brennan''s session'))) = 1,
  'the same booking never re-proposes after a reopen; a different booking does');
select pg_temp.ck('P02c',
  (select item_generation = 1 from public.auto_resolve_decisions where id = pg_temp.dec('a0000004-0000-4000-8000-000000000000', 'e7e00000-0000-4000-8000-000000000007'))
  and (select count(*) = 2 from public.calendar_pending_proposals(200))
  and not exists (select 1 from public.calendar_pending_proposals(200) where event_id = 'e7e00000-0000-4000-8000-000000000004'),
  'the new proposal is generation 1 and pending; the old one is not');

-- P03: the limit is clamped to 1..500 and defaults to 200.
select pg_temp.ck('P03',
  (select count(*) from public.calendar_pending_proposals(0)) = 1
  and (select count(*) from public.calendar_pending_proposals(null)) = 2
  and (select count(*) from public.calendar_pending_proposals()) = 2
  and (select pending_total from public.calendar_pending_proposals(1)) = 2,
  'p_limit 0 reads one row with pending_total 2; null and the default read all');

-- P04: a kept row, another layer's row and a deferred item are not pending.
insert into public.action_items (id, description, status) values
  ('a0000005-0000-4000-8000-000000000000', 'send her the explainer PDF', 'open');
select public.record_decisions('[{"layer": "fragment", "outcome": "proposed", "reason": "pronoun_object",
   "candidate_description": "send her the explainer PDF", "item_id": "a0000005-0000-4000-8000-000000000000",
   "thought_id": "7a5c0000-0000-4000-8000-000000000001"}]'::jsonb);
update public.action_items set status = 'deferred' where id = 'a0000004-0000-4000-8000-000000000000';
select pg_temp.ck('P04a',
  (select count(*) = 1 and bool_and(item_id = 'a0000001-0000-4000-8000-000000000000') from public.calendar_pending_proposals(200)),
  'a deferred item''s proposal and a fragment proposal are not pending');
update public.action_items set status = 'open' where id = 'a0000004-0000-4000-8000-000000000000';

-- R01: done through review_proposal (Task 3.6) on A4 (one supported pending
-- row): resolved, close_reason done, no resolving thought, the event id and
-- actor_source in the close event payload.
select pg_temp.ck('R01a',
  (select status = 'recorded' from public.review_proposal('a0000004-0000-4000-8000-000000000000', 'done', 'operator', 'mcp-shared-key')),
  'done on a single supported calendar proposal is recorded');
select pg_temp.ck('R01b',
  (select a.status = 'resolved' and a.close_reason = 'done' and a.resolved_by_thought_id is null
     and e.payload->>'evidence_event_id' = 'e7e00000-0000-4000-8000-000000000007'
     and e.payload->>'actor_source' = 'mcp-shared-key'
   from public.action_items a
   join public.action_item_events e on e.item_id = a.id and e.new_status = 'resolved'
   where a.id = 'a0000004-0000-4000-8000-000000000000'
   order by e.at desc, e.id desc limit 1),
  'the item resolves with the event id in the close event payload');
-- R01c: A1 holds a supported (E1) and an unsupported (E3) pending row: the
-- bare done asks for the decision id; keep records both as kept.
select pg_temp.ck('R01c',
  (select status = 'needs_decision' from public.review_proposal('a0000001-0000-4000-8000-000000000000', 'done', 'operator', 'mcp-shared-key')),
  'done on an item with two pending calendar rows asks for the decision id');
do $$
declare v_status text := 'none';
begin
  begin
    select status into v_status from public.review_proposal('a0000001-0000-4000-8000-000000000000', 'keep', 'operator', 'mcp-shared-key');
  exception when raise_exception then
    v_status := 'raised: ' || sqlerrm;
  end;
  perform pg_temp.ck('R02', v_status = 'recorded',
    format('keep is recorded even when one of the item''s proposals is unsupported (got %s)', left(v_status, 120)));
end $$;
select pg_temp.ck('R02b',
  (select count(*) = 2 and bool_and(outcome = 'kept') from public.auto_resolve_decisions
   where item_id = 'a0000001-0000-4000-8000-000000000000' and layer = 'calendar')
  and not exists (select 1 from public.calendar_pending_proposals(200)),
  'both of the item''s proposals are kept; nothing is pending');

-- P05: the read's upper bound is exactly 500: 501 supported pending rows,
-- asked for 1000 and for 600, read 500 with pending_total 501.
insert into public.action_items (id, description, status, client_id)
select ('b0000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'Book Alicia Brennan''s session ' || g, 'open', 'a11c1a00-0000-4000-8000-000000000001'
from generate_series(1, 501) g;
select public.sync_booking_proposals('e7e00000-0000-4000-8000-000000000008', pg_temp.snap('e7e00000-0000-4000-8000-000000000008'), clock_timestamp(),
  (select jsonb_agg(pg_temp.prow(('b0000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'e7e00000-0000-4000-8000-000000000008',
     'a11c1a00-0000-4000-8000-000000000001', 'Book Alicia Brennan''s session ' || g)) from generate_series(1, 501) g));
select pg_temp.ck('P05',
  (select count(*) from public.calendar_pending_proposals(1000)) = 500
  and (select count(*) from public.calendar_pending_proposals(600)) = 500
  and (select count(*) from public.calendar_pending_proposals(499)) = 499
  and (select min(pending_total) = 501 from public.calendar_pending_proposals(1000)),
  'the read returns at most 500 rows (499 when asked), and pending_total counts all 501');

select 'CONTRACT COMPLETE';
