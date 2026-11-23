-- Loop-closing Task 5.3 (B5): client identity on action items, booking
-- proposals that stay true to their booking, and the digest read.
--
-- 1. action_items.client_id: nullable, references clients. Written at insert
--    by BOTH capture paths (supabase/functions/_shared/item-client.ts, per
--    item: set only when the item's own text names exactly one client).
--    Existing rows stay null; nothing backfills them. on delete set null:
--    removing or merging a client leaves its items open and unattributed
--    rather than blocking the delete.
-- 2. A partial index for the booking matcher's read (open items of one
--    client).
-- 3. calendar_proposal_support: for each pending calendar/booking_match
--    decision the matcher still stands behind, the exact pair it validated
--    (item and event), the item's client and text as read, and the event
--    snapshot (booking_event_snapshot: title, type, date, status, Client
--    Bank client id). A proposal is SUPPORTED (calendar_support_holds) only
--    while that row exists for that decision AND that same item and event,
--    its client is the item's client, its text is the item's current text
--    (the text the scheduling predicate and the date rule were applied to),
--    and its snapshot equals the event's CURRENT snapshot. An event or item
--    changed after the matcher's last run therefore hides its proposals until
--    the matcher re-checks them (fail closed), and the matcher withdraws
--    support when the event no longer backs the item (another client,
--    cancelled, moved before the item's date).
-- 4. Two reads in ONE statement each, so each is one consistent snapshot and
--    a single jsonb value no PostgREST row cap applies to: client_roster
--    (every client's id and name, and the time the read began; the capture
--    paths' roster) and booking_match_read (everything one booking match
--    depends on: the event row, every client's id, name and the CRM key,
--    every open item that carries a client, and the time the read began).
--    The matcher resolves the event's client (the CRM key first, then the
--    title) and picks that client's items from that one snapshot. Over its
--    cap a list is left out and the caller resolves or proposes nothing.
-- 5. calendar_event_sync: per event, the time the reads of the last applied
--    sync began.
-- 6. sync_booking_proposals(p_event_id, p_snapshot, p_read_at, p_rows): the
--    matcher's one write per event. Locks the event row and returns -1,
--    changing nothing, when p_snapshot no longer describes it (a later write
--    landed; the matcher runs again). Then, when p_read_at is given, locks
--    the event's calendar_event_sync row and returns -2, changing nothing,
--    when a sync whose read began LATER has already been applied (p_read_at
--    is the time of the one booking_match_read the match was built from, so
--    the event, client and item set it covers are one snapshot; the newer
--    read stands: an older reader never withdraws what a newer one found).
--    Then pre-locks the items in id order (Task 3.1's
--    multi-item contract), withdraws support from this event's pending
--    proposals that are not in p_rows, skips an item that already holds a
--    supported pending proposal for the SAME booking on another event row
--    (booking_same: equal Google event keys; when either row has no key,
--    equal date and type), writes the rest through record_decisions (on
--    conflict do nothing against the lifetime unique on (item_id,
--    evidence_event_id)) and records their support.
-- 7. A guard trigger, on INSERT and UPDATE: no write may make a calendar
--    decision accepted (an insert of an accepted row, or an update that
--    changes its outcome or layer to accepted), or move an accepted one to
--    another item or event, unless the row it writes is supported
--    (calendar_support_holds on the INCOMING decision, item and event). It
--    covers review_proposal (20261109b, unchanged) and any other writer; keep
--    is unaffected. A later write to an already accepted row that leaves its
--    outcome, layer, item and event as they are is NOT re-checked: accepted
--    is final, and the support behind it may since have been withdrawn (the
--    item is closed, so the matcher no longer lists it) without the
--    acceptance becoming wrong.
-- 8. calendar_pending_proposals: the digest's read for the "Booked" section:
--    supported pending calendar/proposed/booking_match rows on open items in
--    the current generation, one row per decision, with the event's title and
--    date, oldest first.
--
-- The decision rows need no schema change: the calendar triple, its payload
-- rule (item_id, evidence_event_id, quote) and the lifetime unique are in
-- 20261105; record_decisions in 20261106; review_proposal's calendar
-- disposition in 20261109b.
--
-- Plain ASCII, no backslash escape, so md5(prosrc) after apply_migration must
-- equal each function body below byte for byte.
--
-- Rollback (after both capture functions, both event writers and the digest
-- are redeployed from the previous bundles):
--   drop function public.calendar_pending_proposals(integer);
--   drop function public.sync_booking_proposals(uuid, jsonb, timestamptz, jsonb);
--   drop function public.booking_match_read(uuid, integer, integer);
--   drop function public.client_roster(integer);
--   drop trigger auto_resolve_decisions_calendar_support_guard on public.auto_resolve_decisions;
--   drop function public.calendar_support_guard();
--   drop function public.calendar_proposal_supported(uuid);
--   drop function public.calendar_support_holds(uuid, uuid, uuid);
--   drop function public.booking_same(public.business_events, public.business_events);
--   drop function public.booking_gcal_key(public.business_events);
--   drop function public.booking_event_snapshot(public.business_events);
--   drop table public.calendar_event_sync;
--   drop table public.calendar_proposal_support;
--   drop index public.action_items_client_open_idx;
--   alter table public.action_items drop column client_id;

alter table public.action_items
  add column client_id uuid null references public.clients(id) on delete set null;

comment on column public.action_items.client_id is
  'The one client this item names, set at insert when the item text establishes exactly one client; null otherwise. Loop-closing Task 5.3.';

create index action_items_client_open_idx
  on public.action_items (client_id)
  where client_id is not null and status = 'open';

create table public.calendar_proposal_support (
  decision_id uuid primary key references public.auto_resolve_decisions(id) on delete cascade,
  item_id uuid not null references public.action_items(id) on delete cascade,
  event_id uuid not null references public.business_events(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  item_description text not null,
  event_snapshot jsonb not null,
  checked_at timestamptz not null default now()
);

comment on table public.calendar_proposal_support is
  'The booking matcher''s current support for a pending calendar proposal: the exact item and event pair it validated, the item''s client and text as read, and the event snapshot. Loop-closing Task 5.3.';

alter table public.calendar_proposal_support enable row level security;
create policy "Service role full access on calendar_proposal_support"
  on public.calendar_proposal_support for all
  using (auth.role() = 'service_role'::text);
revoke all on table public.calendar_proposal_support from public, anon, authenticated;
grant select, insert, update, delete on table public.calendar_proposal_support to service_role;

create table public.calendar_event_sync (
  event_id uuid primary key references public.business_events(id) on delete cascade,
  read_at timestamptz not null
);

comment on table public.calendar_event_sync is
  'Per event, the time the reads of the last applied booking-matcher sync began; an older sync changes nothing. Loop-closing Task 5.3.';

alter table public.calendar_event_sync enable row level security;
create policy "Service role full access on calendar_event_sync"
  on public.calendar_event_sync for all
  using (auth.role() = 'service_role'::text);
revoke all on table public.calendar_event_sync from public, anon, authenticated;
grant select, insert, update, delete on table public.calendar_event_sync to service_role;

create or replace function public.client_roster(p_max integer)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'read_at', statement_timestamp(),
    'total', count(*),
    'clients', case when count(*) <= p_max
      then coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.id), '[]'::jsonb)
    end
  )
  from public.clients c
$$;

create or replace function public.booking_match_read(p_event_id uuid, p_max_clients integer, p_max_items integer)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'read_at', statement_timestamp(),
    'event', (
      select jsonb_build_object('id', e.id, 'title', e.title, 'event_type', e.event_type,
                                'date_start', e.date_start, 'metadata', e.metadata)
      from public.business_events e where e.id = p_event_id
    ),
    'clients_total', (select count(*) from public.clients),
    'clients', (
      select case when count(*) <= p_max_clients
        then coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name,
                                                   'crm_id', c.metadata->>'crm_id') order by c.id), '[]'::jsonb)
      end
      from public.clients c
    ),
    'items_total', (select count(*) from public.action_items a where a.client_id is not null and a.status = 'open'),
    'items', (
      select case when count(*) <= p_max_items
        then coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'client_id', a.client_id, 'description', a.description,
                                                   'created_at', a.created_at, 'status', a.status) order by a.id), '[]'::jsonb)
      end
      from public.action_items a
      where a.client_id is not null and a.status = 'open'
    )
  )
$$;

create or replace function public.booking_event_snapshot(e public.business_events)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'title', e.title,
    'event_type', e.event_type,
    'date_start', to_char(e.date_start, 'YYYY-MM-DD'),
    'status', coalesce(e.metadata->'status', 'null'::jsonb),
    'crm_client_id', coalesce(e.metadata->'crm_client_id', 'null'::jsonb)
  )
$$;

create or replace function public.booking_gcal_key(e public.business_events)
returns text
language sql
stable
set search_path = pg_catalog, public
as $$
  select case
    when k is null then null
    when right(k, 11) = '@google.com' then nullif(left(k, length(k) - 11), '')
    else k
  end
  from (select nullif(lower(btrim(e.metadata->>'gcal_event_id')), '') as k) x
$$;

create or replace function public.booking_same(a public.business_events, b public.business_events)
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  select case
    when public.booking_gcal_key(a) is not null and public.booking_gcal_key(b) is not null
      then public.booking_gcal_key(a) = public.booking_gcal_key(b)
    else a.date_start is not distinct from b.date_start
      and a.event_type is not distinct from b.event_type
  end
$$;

create or replace function public.calendar_support_holds(p_decision_id uuid, p_item_id uuid, p_event_id uuid)
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.calendar_proposal_support s
    join public.action_items a on a.id = s.item_id
    join public.business_events e on e.id = s.event_id
    where s.decision_id = p_decision_id
      and s.item_id = p_item_id
      and s.event_id = p_event_id
      and s.client_id = a.client_id
      and s.item_description = a.description
      and s.event_snapshot = public.booking_event_snapshot(e)
  )
$$;

create or replace function public.calendar_proposal_supported(p_decision_id uuid)
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  select coalesce((
    select public.calendar_support_holds(d.id, d.item_id, d.evidence_event_id)
    from public.auto_resolve_decisions d
    where d.id = p_decision_id and d.layer = 'calendar'
  ), false)
$$;

create or replace function public.calendar_support_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  -- Every write that makes a calendar row accepted (an insert, or an update
  -- of its outcome or layer), or moves an accepted one to another item or
  -- event. The evidence checked is the incoming row's, not the stored one.
  if new.layer = 'calendar' and new.outcome = 'accepted'
     and (tg_op = 'INSERT'
          or old.outcome is distinct from new.outcome
          or old.layer is distinct from new.layer
          or old.item_id is distinct from new.item_id
          or old.evidence_event_id is distinct from new.evidence_event_id)
     and not public.calendar_support_holds(new.id, new.item_id, new.evidence_event_id) then
    raise exception 'calendar proposal % is no longer supported by its booking (the event changed or no longer names this client); reply keep instead', left(new.id::text, 8)
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger auto_resolve_decisions_calendar_support_guard
  before insert or update on public.auto_resolve_decisions
  for each row execute function public.calendar_support_guard();

create or replace function public.sync_booking_proposals(p_event_id uuid, p_snapshot jsonb, p_read_at timestamptz, p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_event public.business_events;
  v_last timestamptz;
  v_new jsonb;
  v_inserted integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'sync_booking_proposals requires a json array.' using errcode = '22023';
  end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'sync_booking_proposals requires a snapshot object.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) r
    where jsonb_typeof(r->'client_id') is distinct from 'string'
       or jsonb_typeof(r->'item_description') is distinct from 'string'
  ) then
    raise exception 'sync_booking_proposals: every row needs client_id and item_description.' using errcode = '22023';
  end if;
  if p_read_at is null and jsonb_array_length(p_rows) > 0 then
    raise exception 'sync_booking_proposals: rows need the time their reads began.' using errcode = '22023';
  end if;
  -- The event row is locked (a concurrent event write waits for this sync)
  -- and the matcher's snapshot must still describe it; a stale snapshot
  -- changes nothing and answers -1, and the caller matches again.
  select * into v_event from public.business_events where id = p_event_id for share;
  if not found then
    raise exception 'sync_booking_proposals: event % not found.', p_event_id using errcode = '22023';
  end if;
  if public.booking_event_snapshot(v_event) is distinct from p_snapshot then
    return -1;
  end if;
  -- Syncs of one event apply in the order of their reads (p_read_at is the
  -- one time of the one booking_match_read statement a match is built
  -- from): a sync whose read is older than the last applied one changes
  -- nothing and answers -2 (the newer read stands). A sync with no read time
  -- carries no rows and is decided by the snapshot check above.
  if p_read_at is not null then
    insert into public.calendar_event_sync (event_id, read_at) values (p_event_id, p_read_at)
    on conflict (event_id) do nothing;
    select s.read_at into v_last from public.calendar_event_sync s where s.event_id = p_event_id for update;
    if v_last > p_read_at then
      return -2;
    end if;
    update public.calendar_event_sync set read_at = p_read_at where event_id = p_event_id;
  end if;

  perform 1 from (
    select a.id from public.action_items a
    where a.id in (
      select (r->>'item_id')::uuid from jsonb_array_elements(p_rows) r
      union
      select d.item_id from public.auto_resolve_decisions d
      where d.layer = 'calendar' and d.evidence_event_id = p_event_id and d.outcome = 'proposed'
    )
    order by a.id
    for no key update
  ) locked;

  select coalesce(jsonb_agg(r order by r->>'item_id'), '[]'::jsonb) into v_new
  from jsonb_array_elements(p_rows) r
  where not exists (
    select 1
    from public.auto_resolve_decisions d
    join public.action_items a on a.id = d.item_id
    join public.business_events e on e.id = d.evidence_event_id
    where d.item_id = (r->>'item_id')::uuid
      and d.layer = 'calendar'
      and d.outcome = 'proposed'
      and d.item_generation = a.reopen_generation
      and d.evidence_event_id <> p_event_id
      and public.booking_same(e, v_event)
      and public.calendar_proposal_supported(d.id)
  );

  delete from public.calendar_proposal_support s
  using public.auto_resolve_decisions d
  where s.decision_id = d.id
    and d.layer = 'calendar'
    and d.evidence_event_id = p_event_id
    and d.item_id not in (select (r->>'item_id')::uuid from jsonb_array_elements(v_new) r);

  v_inserted := public.record_decisions(v_new);

  insert into public.calendar_proposal_support
    (decision_id, item_id, event_id, client_id, item_description, event_snapshot, checked_at)
  select d.id, d.item_id, d.evidence_event_id, (r->>'client_id')::uuid, r->>'item_description', p_snapshot, now()
  from jsonb_array_elements(v_new) r
  join public.auto_resolve_decisions d
    on d.item_id = (r->>'item_id')::uuid
   and d.evidence_event_id = p_event_id
   and d.layer = 'calendar'
   and d.outcome = 'proposed'
  on conflict (decision_id) do update
    set item_id = excluded.item_id, event_id = excluded.event_id, client_id = excluded.client_id,
        item_description = excluded.item_description, event_snapshot = excluded.event_snapshot,
        checked_at = excluded.checked_at;

  return v_inserted;
end;
$$;

comment on function public.sync_booking_proposals(uuid, jsonb, timestamptz, jsonb) is
  'The booking matcher''s one write per event: refuses a stale snapshot (-1) or reads older than the last applied sync (-2), withdraws stale support, skips a second proposal for the same booking, writes new calendar proposals through record_decisions and records their support. Loop-closing Task 5.3.';

create or replace function public.calendar_pending_proposals(p_limit integer default 200)
returns table (
  decision_id uuid, item_id uuid, description text, event_id uuid,
  event_title text, event_date date, proposed_at timestamptz, pending_total bigint
)
language sql
stable
set search_path = pg_catalog, public
as $$
  with pending as (
    select d.id as decision_id, a.id as item_id, a.description,
           e.id as event_id, e.title as event_title, e.date_start as event_date,
           d.created_at as proposed_at
    from public.auto_resolve_decisions d
    join public.action_items a on a.id = d.item_id
    join public.business_events e on e.id = d.evidence_event_id
    where d.layer = 'calendar'
      and d.outcome = 'proposed'
      and d.reason = 'booking_match'
      and a.status = 'open'
      and d.item_generation = a.reopen_generation
      and public.calendar_proposal_supported(d.id)
  )
  select p.decision_id, p.item_id, p.description, p.event_id, p.event_title,
         p.event_date, p.proposed_at, count(*) over ()
  from pending p
  order by p.proposed_at, p.item_id, p.decision_id
  limit least(greatest(coalesce(p_limit, 200), 1), 500)
$$;

comment on function public.calendar_pending_proposals(integer) is
  'Supported pending booking proposals (layer calendar, outcome proposed, reason booking_match) on open items, current generation, one row per decision, with the event title and date, oldest first; pending_total counts them all. Loop-closing Task 5.3.';

revoke execute on function public.booking_event_snapshot(public.business_events) from public, anon, authenticated;
revoke execute on function public.booking_gcal_key(public.business_events) from public, anon, authenticated;
revoke execute on function public.booking_same(public.business_events, public.business_events) from public, anon, authenticated;
revoke execute on function public.calendar_proposal_supported(uuid) from public, anon, authenticated;
revoke execute on function public.calendar_support_holds(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.calendar_support_guard() from public, anon, authenticated;
revoke execute on function public.sync_booking_proposals(uuid, jsonb, timestamptz, jsonb) from public, anon, authenticated;
revoke execute on function public.client_roster(integer) from public, anon, authenticated;
revoke execute on function public.booking_match_read(uuid, integer, integer) from public, anon, authenticated;
revoke execute on function public.calendar_pending_proposals(integer) from public, anon, authenticated;
grant execute on function public.booking_event_snapshot(public.business_events) to service_role;
grant execute on function public.booking_gcal_key(public.business_events) to service_role;
grant execute on function public.booking_same(public.business_events, public.business_events) to service_role;
grant execute on function public.calendar_proposal_supported(uuid) to service_role;
grant execute on function public.calendar_support_holds(uuid, uuid, uuid) to service_role;
grant execute on function public.sync_booking_proposals(uuid, jsonb, timestamptz, jsonb) to service_role;
grant execute on function public.client_roster(integer) to service_role;
grant execute on function public.booking_match_read(uuid, integer, integer) to service_role;
grant execute on function public.calendar_pending_proposals(integer) to service_role;
