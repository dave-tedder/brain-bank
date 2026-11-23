-- Task 3.1 single-connection contract. Run by action-item-events-sql-test.sh on a
-- throwaway cluster. The seed rows existed BEFORE the migration ran. Concurrency
-- schedules live in the runner, because they need real second connections.
\set ON_ERROR_STOP on

create or replace function pg_temp.ok(p_cond boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'FAIL %', p_msg; end if;
end $$;

create or replace function pg_temp.refused(p_sql text, p_state text, p_like text, p_label text)
returns void language plpgsql as $$
declare v_state text; v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state is distinct from p_state or v_msg not like p_like then
      raise exception 'FAIL % refused for the wrong reason: % %', p_label, v_state, v_msg;
    end if;
    raise notice 'PASS %', p_label;
    return;
  end;
  raise exception 'FAIL % was NOT refused', p_label;
end $$;

-- Ids: a000 seeded rows; b000 rows created here, after the migration.
do $$
declare v_row public.action_items; v_n int;
begin
  -- B1: backfill, justified rows only, and it wrote no events.
  select * into v_row from public.action_items where id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.ok(v_row.close_reason = 'done', 'B1 resolver thought row is done');
  perform pg_temp.ok(v_row.closed_at = '2026-01-01T00:00:00Z', 'B1 closed_at copied from resolved_at');
  select * into v_row from public.action_items where id = 'a0000000-0000-4000-8000-000000000002';
  perform pg_temp.ok(v_row.close_reason = 'fragment', 'B1 sweep fragment');
  select * into v_row from public.action_items where id = 'a0000000-0000-4000-8000-000000000003';
  perform pg_temp.ok(v_row.close_reason = 'done', 'B1 sweep verified done');
  select * into v_row from public.action_items where id = 'a0000000-0000-4000-8000-000000000004';
  perform pg_temp.ok(v_row.close_reason is null, 'B1 unjustified close stays null');
  perform pg_temp.ok(v_row.closed_at is null, 'B1 archived with no resolved_at stays unknown');
  select * into v_row from public.action_items where id = 'a0000000-0000-4000-8000-000000000005';
  perform pg_temp.ok(v_row.close_reason is null, 'B1 a sweep note that is neither form stays null');
  select * into v_row from public.action_items where id = 'a0000000-0000-4000-8000-000000000006';
  perform pg_temp.ok(v_row.close_reason is null and v_row.closed_at is null and v_row.status = 'open', 'B1 open row untouched');
  perform pg_temp.ok(v_row.reopen_generation = 0, 'B1 generation starts at zero');
  select count(*) into v_n from public.action_item_events;
  perform pg_temp.ok(v_n = 0, 'B1 backfill wrote no events');
  -- The decision rows the migration met.
  perform pg_temp.ok((select item_generation from public.auto_resolve_decisions where id = 'd0000000-0000-4000-8000-000000000001') = 0, 'B1 seeded decision is generation 0');
  perform pg_temp.ok((select item_generation from public.auto_resolve_decisions where id = 'd0000000-0000-4000-8000-000000000002') is null, 'B1 capture-level decision has no generation');
  raise notice 'PASS B1 backfill';
end $$;

insert into public.action_items (id, description, status) values
  ('b0000000-0000-4000-8000-000000000001', 'close then reopen', 'open'),
  ('b0000000-0000-4000-8000-000000000002', 'survivor', 'open'),
  ('b0000000-0000-4000-8000-000000000003', 'duplicate copy', 'open'),
  ('b0000000-0000-4000-8000-000000000004', 'guarded', 'deferred'),
  ('b0000000-0000-4000-8000-000000000005', 'defer me', 'open'),
  ('b0000000-0000-4000-8000-000000000006', 'payload', 'open'),
  ('b0000000-0000-4000-8000-000000000007', 'bare write', 'open'),
  ('b0000000-0000-4000-8000-000000000008', 'generation', 'open'),
  ('b0000000-0000-4000-8000-000000000009', 'generation separate', 'open'),
  ('b0000000-0000-4000-8000-00000000000a', 'unpaused one', 'deferred'),
  ('b0000000-0000-4000-8000-00000000000b', 'unpaused two', 'deferred'),
  ('b0000000-0000-4000-8000-00000000000c', 'unpaused three', 'deferred'),
  ('b0000000-0000-4000-8000-00000000000d', 'tag on a closed row', 'archived'),
  ('b0000000-0000-4000-8000-00000000000e', 'other tag', 'deferred'),
  ('b0000000-0000-4000-8000-00000000000f', 'archive from deferred', 'deferred');
update public.action_items set defer_reason = 'pause:x', deferred_at = now()
  where id in ('b0000000-0000-4000-8000-00000000000a','b0000000-0000-4000-8000-00000000000b','b0000000-0000-4000-8000-00000000000c','b0000000-0000-4000-8000-00000000000d');
update public.action_items set defer_reason = 'pause:y', deferred_at = now()
  where id in ('b0000000-0000-4000-8000-00000000000e','b0000000-0000-4000-8000-00000000000f');
delete from public.action_item_events;

do $$
declare
  c constant uuid := 'b0000000-0000-4000-8000-000000000001';
  t1 constant uuid := 'e0000000-0000-4000-8000-000000000001';
  t2 constant uuid := 'e0000000-0000-4000-8000-000000000002';
  v_row public.action_items; v_ev public.action_item_events; v_n int; v_first timestamptz;
begin
  -- T1 close: stamps closed_at, records actor, reason, note, resolver.
  v_n := public.transition_action_item(c, '{open}', 'resolved', 'auto-resolve', 'done', 'first note', t1, t1);
  perform pg_temp.ok(v_n = 1, 'T1 affected');
  select * into v_row from public.action_items where id = c;
  perform pg_temp.ok(v_row.status = 'resolved', 'T1 status');
  perform pg_temp.ok(v_row.closed_at is not null, 'T1 trigger stamps closed_at');
  perform pg_temp.ok(v_row.resolved_at is not null, 'T1 resolved_at');
  perform pg_temp.ok(v_row.close_reason = 'done', 'T1 reason');
  select * into v_ev from public.action_item_events where item_id = c;
  perform pg_temp.ok(v_ev.actor = 'auto-resolve', 'T1 event actor');
  perform pg_temp.ok(v_ev.old_status = 'open' and v_ev.new_status = 'resolved', 'T1 event statuses');
  perform pg_temp.ok(v_ev.close_reason = 'done' and v_ev.note = 'first note' and v_ev.evidence_thought_id = t1, 'T1 event evidence');
  raise notice 'PASS T1 close';

  -- T2 reopen: the event carries the old evidence, the row carries none of it.
  v_n := public.transition_action_item(c, '{resolved,archived,deferred}', 'open', 'operator');
  perform pg_temp.ok(v_n = 1, 'T2 affected');
  select * into v_row from public.action_items where id = c;
  perform pg_temp.ok(v_row.status = 'open', 'T2 status');
  perform pg_temp.ok(v_row.resolved_at is null, 'T2 resolved_at cleared');
  perform pg_temp.ok(v_row.resolved_by_thought_id is null, 'T2 resolver cleared');
  perform pg_temp.ok(v_row.resolution_note is null, 'T2 note cleared');
  perform pg_temp.ok(v_row.close_reason is null, 'T2 reason cleared');
  perform pg_temp.ok(v_row.closed_at is null, 'T2 closed_at cleared');
  perform pg_temp.ok(v_row.reopened_at is not null, 'T2 reopened_at stamped');
  perform pg_temp.ok(v_row.reopen_generation = 1, 'T2 generation incremented');
  select * into v_ev from public.action_item_events where item_id = c and new_status = 'open';
  perform pg_temp.ok(v_ev.actor = 'operator', 'T2 event actor');
  perform pg_temp.ok(v_ev.close_reason = 'done', 'T2 event carries the old reason');
  perform pg_temp.ok(v_ev.note = 'first note', 'T2 event carries the old note');
  perform pg_temp.ok(v_ev.evidence_thought_id = t1, 'T2 event carries the old resolver');
  perform pg_temp.ok(v_ev.payload ? 'resolved_at', 'T2 event payload carries resolved_at');
  raise notice 'PASS T2 reopen';

  -- T3 second close is attributed fresh.
  v_n := public.transition_action_item(c, '{open}', 'archived', 'operator', 'wont_do', 'second note', t2, t2);
  select * into v_row from public.action_items where id = c;
  perform pg_temp.ok(v_row.resolved_by_thought_id = t2 and v_row.close_reason = 'wont_do', 'T3 fresh attribution');
  select * into v_ev from public.action_item_events where item_id = c and new_status = 'archived';
  perform pg_temp.ok(v_ev.close_reason = 'wont_do' and v_ev.note = 'second note' and v_ev.evidence_thought_id = t2, 'T3 event is the new close');
  raise notice 'PASS T3 second close';
  -- Backdated because now() is the transaction timestamp: inside this block a
  -- second reopen stamps the same instant, and an assertion on it could not fail.
  update public.action_items set reopened_at = '2026-01-02T00:00:00Z' where id = c;
  v_first := '2026-01-02T00:00:00Z';

  -- T4 second reopen overwrites reopened_at, the event keeps the first value.
  v_n := public.transition_action_item(c, '{archived}', 'open', 'operator');
  select * into v_row from public.action_items where id = c;
  perform pg_temp.ok(v_row.reopen_generation = 2, 'T4 generation');
  perform pg_temp.ok(v_row.reopened_at is distinct from v_first, 'T4 reopened_at overwritten');
  select * into v_ev from public.action_item_events where item_id = c and old_status = 'archived';
  perform pg_temp.ok((v_ev.payload->>'previous_reopened_at')::timestamptz = v_first, 'T4 event carries the first reopened_at');
  raise notice 'PASS T4 second reopen';

  -- T5 guard: a deferred row with from {open} changes nothing and writes no event.
  v_n := public.transition_action_item('b0000000-0000-4000-8000-000000000004', '{open}', 'resolved', 'operator', 'done');
  perform pg_temp.ok(v_n = 0, 'T5 returns 0');
  perform pg_temp.ok((select status from public.action_items where id = 'b0000000-0000-4000-8000-000000000004') = 'deferred', 'T5 row unchanged');
  perform pg_temp.ok(not exists (select 1 from public.action_item_events where item_id = 'b0000000-0000-4000-8000-000000000004'), 'T5 no event');
  raise notice 'PASS T5 guard';

  -- T6 duplicate with a valid survivor writes it and the event together.
  v_n := public.transition_action_item('b0000000-0000-4000-8000-000000000003', '{open}', 'archived', 'operator', 'duplicate', 'older copy', null, null, 'b0000000-0000-4000-8000-000000000002');
  select * into v_row from public.action_items where id = 'b0000000-0000-4000-8000-000000000003';
  perform pg_temp.ok(v_row.duplicate_of = 'b0000000-0000-4000-8000-000000000002', 'T6 duplicate_of');
  select * into v_ev from public.action_item_events where item_id = 'b0000000-0000-4000-8000-000000000003';
  perform pg_temp.ok(v_ev.payload->>'duplicate_of' = 'b0000000-0000-4000-8000-000000000002', 'T6 event names the survivor');
  -- Reopen clears it, with the old value in the event.
  v_n := public.transition_action_item('b0000000-0000-4000-8000-000000000003', '{archived}', 'open', 'operator');
  select * into v_row from public.action_items where id = 'b0000000-0000-4000-8000-000000000003';
  perform pg_temp.ok(v_row.duplicate_of is null, 'T6 reopen clears duplicate_of');
  select * into v_ev from public.action_item_events where item_id = 'b0000000-0000-4000-8000-000000000003' and new_status = 'open';
  perform pg_temp.ok(v_ev.payload->>'duplicate_of' = 'b0000000-0000-4000-8000-000000000002', 'T6 reopen event keeps the survivor');
  raise notice 'PASS T6 duplicate';

  -- T7 payload verbatim.
  v_n := public.transition_action_item('b0000000-0000-4000-8000-000000000006', '{open}', 'resolved', 'slack:U1', 'done', null, null, null, null, null,
    '{"evidence_event_id": "c0000000-0000-4000-8000-000000000001"}'::jsonb);
  select * into v_ev from public.action_item_events where item_id = 'b0000000-0000-4000-8000-000000000006';
  perform pg_temp.ok(v_ev.payload = '{"evidence_event_id": "c0000000-0000-4000-8000-000000000001"}'::jsonb, 'T7 payload verbatim');
  raise notice 'PASS T7 payload';

  -- T8 defer through the RPC.
  v_n := public.transition_action_item('b0000000-0000-4000-8000-000000000005', '{open}', 'deferred', 'operator', null, null, null, null, null, 'pause:z');
  select * into v_row from public.action_items where id = 'b0000000-0000-4000-8000-000000000005';
  perform pg_temp.ok(v_row.defer_reason = 'pause:z' and v_row.deferred_at is not null, 'T8 defer fields');
  select * into v_ev from public.action_item_events where item_id = 'b0000000-0000-4000-8000-000000000005';
  perform pg_temp.ok(v_ev.actor = 'operator' and v_ev.note = 'pause:z' and v_ev.new_status = 'deferred', 'T8 event');
  -- Out of deferred clears both and is no reopen: the generation does not move.
  v_n := public.transition_action_item('b0000000-0000-4000-8000-000000000005', '{deferred}', 'open', 'operator');
  select * into v_row from public.action_items where id = 'b0000000-0000-4000-8000-000000000005';
  perform pg_temp.ok(v_row.defer_reason is null and v_row.deferred_at is null, 'T8 restore clears the marker');
  perform pg_temp.ok(v_row.reopen_generation = 0 and v_row.reopened_at is null, 'T8 undefer is not a reopen');
  select * into v_ev from public.action_item_events where item_id = 'b0000000-0000-4000-8000-000000000005' and new_status = 'open';
  perform pg_temp.ok(v_ev.note = 'pause:z', 'T8 undefer event keeps the tag');
  -- Archive from deferred keeps the tag in the event.
  v_n := public.transition_action_item('b0000000-0000-4000-8000-00000000000f', '{open,deferred}', 'archived', 'operator', 'expired', 'stale');
  select * into v_ev from public.action_item_events where item_id = 'b0000000-0000-4000-8000-00000000000f';
  perform pg_temp.ok(v_ev.payload->>'defer_reason' = 'pause:y', 'T8 archive event keeps the tag');
  raise notice 'PASS T8 defer';

  -- T9 unpause: three rows, three events, the closed fourth and the other tag alone.
  update public.action_items set status = 'archived' where id = 'b0000000-0000-4000-8000-00000000000d';
  update public.action_items set defer_reason = 'pause:x' where id = 'b0000000-0000-4000-8000-00000000000d';
  delete from public.action_item_events where item_id = 'b0000000-0000-4000-8000-00000000000d';
  v_n := public.transition_action_items_by_defer_reason('pause:x', 'operator');
  perform pg_temp.ok(v_n = 3, 'T9 restores three, got ' || v_n);
  select count(*) into v_n from public.action_item_events where item_id in ('b0000000-0000-4000-8000-00000000000a','b0000000-0000-4000-8000-00000000000b','b0000000-0000-4000-8000-00000000000c') and actor = 'operator' and new_status = 'open';
  perform pg_temp.ok(v_n = 3, 'T9 three events');
  perform pg_temp.ok((select status from public.action_items where id = 'b0000000-0000-4000-8000-00000000000d') = 'archived', 'T9 closed row carrying the tag stays closed');
  perform pg_temp.ok((select status from public.action_items where id = 'b0000000-0000-4000-8000-00000000000e') = 'deferred', 'T9 other tag stays deferred');
  raise notice 'PASS T9 unpause';
end $$;

-- T10 generation inside ONE transaction, on a row whose three decision rows share
-- one created_at, so no timestamp comparison could separate them.
begin;
insert into public.auto_resolve_decisions (id, item_id, candidate_description, layer, outcome, reason)
  values ('d1000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000008', 'g', 'archive', 'proposed', 'age_standard');
update public.action_items set status = 'archived' where id = 'b0000000-0000-4000-8000-000000000008';
select public.transition_action_item('b0000000-0000-4000-8000-000000000008', '{archived}', 'open', 'operator');
insert into public.auto_resolve_decisions (id, item_id, candidate_description, layer, outcome, reason)
  values ('d1000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000008', 'g', 'archive', 'proposed', 'age_standard');
update public.action_items set status = 'archived' where id = 'b0000000-0000-4000-8000-000000000008';
select public.transition_action_item('b0000000-0000-4000-8000-000000000008', '{archived}', 'open', 'operator');
insert into public.auto_resolve_decisions (id, item_id, candidate_description, layer, outcome, reason)
  values ('d1000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000008', 'g', 'archive', 'proposed', 'age_standard');
commit;

-- The same three steps in separate transactions.
insert into public.auto_resolve_decisions (id, item_id, candidate_description, layer, outcome, reason)
  values ('d2000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000009', 'g', 'archive', 'proposed', 'age_standard');
update public.action_items set status = 'archived' where id = 'b0000000-0000-4000-8000-000000000009';
select public.transition_action_item('b0000000-0000-4000-8000-000000000009', '{archived}', 'open', 'operator');
insert into public.auto_resolve_decisions (id, item_id, candidate_description, layer, outcome, reason)
  values ('d2000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000009', 'g', 'archive', 'proposed', 'age_standard');
update public.action_items set status = 'archived' where id = 'b0000000-0000-4000-8000-000000000009';
select public.transition_action_item('b0000000-0000-4000-8000-000000000009', '{archived}', 'open', 'operator');
insert into public.auto_resolve_decisions (id, item_id, candidate_description, layer, outcome, reason)
  values ('d2000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000009', 'g', 'archive', 'proposed', 'age_standard');

do $$
declare v_gens int[]; v_times int;
begin
  select array_agg(item_generation order by id), count(distinct created_at) into v_gens, v_times
  from public.auto_resolve_decisions where item_id = 'b0000000-0000-4000-8000-000000000008';
  perform pg_temp.ok(v_gens = '{0,1,2}', 'T10 one transaction generations ' || v_gens::text);
  perform pg_temp.ok(v_times = 1, 'T10 fixture: all three rows share one created_at');
  perform pg_temp.ok((select reopen_generation from public.action_items where id = 'b0000000-0000-4000-8000-000000000008') = 2, 'T10 item generation');
  select array_agg(item_generation order by id) into v_gens
  from public.auto_resolve_decisions where item_id = 'b0000000-0000-4000-8000-000000000009';
  perform pg_temp.ok(v_gens = '{0,1,2}', 'T10 separate transactions generations ' || v_gens::text);
  -- A writer cannot misstate the number, and a capture-level row has none.
  insert into public.auto_resolve_decisions (id, item_id, candidate_description, layer, outcome, reason, item_generation)
    values ('d3000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000008', 'g', 'archive', 'proposed', 'age_standard', 99);
  perform pg_temp.ok((select item_generation from public.auto_resolve_decisions where id = 'd3000000-0000-4000-8000-000000000001') = 2, 'T10 trigger overrides a stated generation');
  insert into public.auto_resolve_decisions (id, item_id, thought_id, candidate_description, layer, outcome, reason, item_generation)
    values ('d3000000-0000-4000-8000-000000000002', null, 'e0000000-0000-4000-8000-000000000001', 'c', 'L0', 'blocked', 'mechanical_prefix', 99);
  perform pg_temp.ok((select item_generation from public.auto_resolve_decisions where id = 'd3000000-0000-4000-8000-000000000002') is null, 'T10 null item has null generation');
  raise notice 'PASS T10 generation';
end $$;

-- T11 refusals. Each input can only be caught by the arm it names.
select pg_temp.refused($q$select public.transition_action_item('b0000000-0000-4000-8000-000000000002', '{open}', 'resolved', '  ', 'done')$q$, '22023', '%requires an actor%', 'T11a blank actor');
select pg_temp.refused($q$select public.transition_action_item('b0000000-0000-4000-8000-000000000002', '{open}', 'gone', 'operator')$q$, '22023', 'Unknown target%', 'T11b unknown status');
select pg_temp.refused($q$select public.transition_action_item('b0000000-0000-4000-8000-000000000002', '{}', 'resolved', 'operator', 'done')$q$, '22023', '%requires p_from_statuses%', 'T11c empty from');
select pg_temp.refused($q$select public.transition_action_item('b0000000-0000-4000-8000-000000000002', '{open,resolved}', 'resolved', 'operator', 'done')$q$, '22023', '%must not include%', 'T11d from includes target');
select pg_temp.refused($q$select public.transition_action_item('b0000000-0000-4000-8000-000000000002', '{open}', 'resolved', 'operator')$q$, '22023', '%requires p_close_reason%', 'T11e close without reason');
select pg_temp.refused($q$select public.transition_action_item('b0000000-0000-4000-8000-000000000002', '{open}', 'deferred', 'operator', 'done', null, null, null, null, 'tag')$q$, '22023', '%only legal on a close%', 'T11f reason without close');
select pg_temp.refused($q$select public.transition_action_item('b0000000-0000-4000-8000-000000000002', '{open}', 'archived', 'operator', 'duplicate')$q$, '22023', '%requires p_duplicate_of%', 'T11g duplicate without survivor');
select pg_temp.refused($q$select public.transition_action_item('b0000000-0000-4000-8000-000000000002', '{open}', 'archived', 'operator', 'duplicate', null, null, null, 'b0000000-0000-4000-8000-000000000002')$q$, '22023', '%of itself%', 'T11h duplicate of self');
select pg_temp.refused($q$select public.transition_action_item('b0000000-0000-4000-8000-000000000002', '{open}', 'archived', 'operator', 'duplicate', null, null, null, 'ffffffff-0000-4000-8000-000000000000')$q$, 'P0002', 'Duplicate survivor not found%', 'T11i missing survivor');
select pg_temp.refused($q$select public.transition_action_item('b0000000-0000-4000-8000-000000000002', '{open}', 'archived', 'operator', 'expired', null, null, null, 'b0000000-0000-4000-8000-000000000001')$q$, '22023', '%only legal with close_reason duplicate%', 'T11j survivor with another reason');
select pg_temp.refused($q$select public.transition_action_item('b0000000-0000-4000-8000-000000000002', '{open}', 'deferred', 'operator')$q$, '22023', '%requires p_defer_reason%', 'T11k defer without tag');
select pg_temp.refused($q$select public.transition_action_item('b0000000-0000-4000-8000-000000000002', '{open}', 'resolved', 'operator', 'done', null, null, null, null, 'tag')$q$, '22023', '%only legal on a defer%', 'T11l tag without defer');
select pg_temp.refused($q$select public.transition_action_item('b0000000-0000-4000-8000-000000000002', '{open}', 'resolved', 'operator', 'nonsense')$q$, '23514', '%action_items_close_reason_known%', 'T11m unknown reason');
select pg_temp.refused($q$select public.transition_action_items_by_defer_reason('pause:y', ' ')$q$, '22023', '%requires an actor%', 'T11n bulk blank actor');
select pg_temp.refused($q$select public.transition_action_items_by_defer_reason(' ', 'operator')$q$, '22023', '%requires a defer reason%', 'T11o bulk blank tag');
select pg_temp.refused($q$update public.action_items set close_reason = 'done' where id = 'b0000000-0000-4000-8000-000000000002'$q$, '23514', '%close_reason_only_when_closed%', 'T11p reason on an open row');
select pg_temp.refused($q$update public.action_items set status = 'archived', close_reason = 'expired', duplicate_of = 'b0000000-0000-4000-8000-000000000001' where id = 'b0000000-0000-4000-8000-000000000002'$q$, '23514', '%duplicate_of_consistent%', 'T11q survivor on a non-duplicate close');
-- The NULL arm, separate from T11q's wrong non-null reason: = would answer NULL here
-- and a CHECK accepts NULL.
select pg_temp.refused($q$insert into public.action_items (id, description, status, duplicate_of) values ('b1000000-0000-4000-8000-000000000001', 'x', 'open', 'b0000000-0000-4000-8000-000000000001')$q$, '23514', '%duplicate_of_consistent%', 'T11r survivor with a null reason on an open row');
select pg_temp.refused($q$update public.action_items set status = 'archived', duplicate_of = 'b0000000-0000-4000-8000-000000000001' where id = 'b0000000-0000-4000-8000-000000000002'$q$, '23514', '%duplicate_of_consistent%', 'T11s survivor with a null reason on a close');
select pg_temp.refused($q$update public.action_items set status = 'archived', close_reason = 'duplicate', duplicate_of = id where id = 'b0000000-0000-4000-8000-000000000002'$q$, '23514', '%duplicate_of_consistent%', 'T11t a direct write naming itself the survivor');

do $$
begin
  perform pg_temp.ok((select status from public.action_items where id = 'b0000000-0000-4000-8000-000000000002') = 'open', 'T11 positive control: every refused call left the row open');
  perform pg_temp.ok(not exists (select 1 from public.action_item_events where item_id = 'b0000000-0000-4000-8000-000000000002'), 'T11 positive control: no event');
  raise notice 'PASS T11 refusals wrote nothing';
end $$;

-- T12 a bare update with no actor records sql; a later RPC in a NEW transaction
-- does not inherit a prior transaction's actor.
select public.transition_action_item('b0000000-0000-4000-8000-000000000007', '{open}', 'deferred', 'someone', null, null, null, null, null, 'pause:q');
update public.action_items set status = 'open' where id = 'b0000000-0000-4000-8000-000000000007';
do $$
begin
  perform pg_temp.ok((select actor from public.action_item_events where item_id = 'b0000000-0000-4000-8000-000000000007' and new_status = 'open') = 'sql', 'T12 bare update records sql');
  raise notice 'PASS T12 actor scope';
end $$;

-- T13 the card verbs: reason, note and actor on the linked close; a closed item
-- is not reopened or overwritten; no linked item writes nothing.
select public.complete_operator_action('f0000000-0000-4000-8000-000000000001', 'the operator', 'did it');
select public.apply_agent_task_review('f0000000-0000-4000-8000-000000000002', 'closeout', 'accepted', 'note', true);
select public.complete_operator_action('f0000000-0000-4000-8000-000000000003', 'the operator', 'already closed');
do $$
declare v_row public.action_items; v_ev public.action_item_events;
begin
  select * into v_row from public.action_items where id = 'a0000000-0000-4000-8000-000000000007';
  perform pg_temp.ok(v_row.status = 'resolved' and v_row.close_reason = 'done', 'T13 operator verb closes with done');
  perform pg_temp.ok(v_row.resolution_note = 'card f0000000', 'T13 operator verb note, got ' || coalesce(v_row.resolution_note, '<null>'));
  select * into v_ev from public.action_item_events where item_id = v_row.id;
  perform pg_temp.ok(v_ev.actor = 'the operator', 'T13 operator verb actor, got ' || coalesce(v_ev.actor, '<null>'));
  select * into v_row from public.action_items where id = 'a0000000-0000-4000-8000-000000000008';
  perform pg_temp.ok(v_row.close_reason = 'done' and v_row.resolution_note = 'card f0000000', 'T13 apply verb closes with done');
  select * into v_ev from public.action_item_events where item_id = v_row.id;
  perform pg_temp.ok(v_ev.actor = 'closeout', 'T13 apply verb actor');
  select * into v_row from public.action_items where id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.ok(v_row.resolution_note is not distinct from null and v_row.close_reason = 'done', 'T13 a closed linked item is left as it was');
  perform pg_temp.ok(not exists (select 1 from public.action_item_events where item_id = v_row.id), 'T13 no event on an already-closed link');
  raise notice 'PASS T13 card verbs';
end $$;

-- T14 record_decisions: atomic, ordered, idempotent on the unique key.
do $$
declare v_n int; v_before int;
begin
  select count(*) into v_before from public.auto_resolve_decisions;
  begin
    perform public.record_decisions('[
      {"item_id":"b0000000-0000-4000-8000-000000000001","candidate_description":"ok","layer":"archive","outcome":"proposed","reason":"age_standard"},
      {"item_id":"b0000000-0000-4000-8000-000000000002","candidate_description":"bad","layer":"dedup","outcome":"proposed","reason":"semantic_overlap","score":0.9}
    ]'::jsonb);
    raise exception 'FAIL T14 a row missing its required id was accepted';
  exception when check_violation then null;
  end;
  select count(*) into v_n from public.auto_resolve_decisions;
  perform pg_temp.ok(v_n = v_before, 'T14 a CHECK failure leaves zero new rows');
  v_n := public.record_decisions('[
    {"item_id":"b0000000-0000-4000-8000-000000000002","candidate_description":"ok","layer":"archive","outcome":"proposed","reason":"age_standard"},
    {"item_id":"b0000000-0000-4000-8000-000000000001","candidate_description":"ok","layer":"archive","outcome":"proposed","reason":"age_standard"}
  ]'::jsonb);
  perform pg_temp.ok(v_n = 2, 'T14 two valid rows');
  perform pg_temp.ok((select item_generation from public.auto_resolve_decisions where item_id = 'b0000000-0000-4000-8000-000000000001' and candidate_description = 'ok') = 2, 'T14 the trigger stamps batch rows');
  raise notice 'PASS T14 record_decisions';
end $$;

-- T15 grants, each with a positive control.
do $$
begin
  perform pg_temp.ok(has_function_privilege('service_role', 'public.transition_action_item(uuid,text[],text,text,text,text,uuid,uuid,uuid,text,jsonb)', 'execute'), 'T15 service_role executes');
  perform pg_temp.ok(not has_function_privilege('anon', 'public.transition_action_item(uuid,text[],text,text,text,text,uuid,uuid,uuid,text,jsonb)', 'execute'), 'T15 anon cannot execute');
  perform pg_temp.ok(not has_function_privilege('authenticated', 'public.transition_action_item(uuid,text[],text,text,text,text,uuid,uuid,uuid,text,jsonb)', 'execute'), 'T15 authenticated cannot execute');
  perform pg_temp.ok(not has_function_privilege('anon', 'public.transition_action_items_by_defer_reason(text,text)', 'execute'), 'T15 anon cannot bulk');
  perform pg_temp.ok(has_function_privilege('service_role', 'public.record_decisions(jsonb)', 'execute'), 'T15 service_role records');
  perform pg_temp.ok(not has_function_privilege('anon', 'public.record_decisions(jsonb)', 'execute'), 'T15 anon cannot record');
  perform pg_temp.ok(has_table_privilege('service_role', 'public.action_item_events', 'select'), 'T15 service_role reads events');
  perform pg_temp.ok(not has_table_privilege('service_role', 'public.action_item_events', 'update'), 'T15 no update on events');
  perform pg_temp.ok(not has_table_privilege('service_role', 'public.action_item_events', 'delete'), 'T15 no delete on events');
  perform pg_temp.ok(not has_table_privilege('service_role', 'public.action_item_events', 'insert'), 'T15 no insert on events');
  perform pg_temp.ok(not has_table_privilege('anon', 'public.action_item_events', 'select'), 'T15 anon cannot read events');
  perform pg_temp.ok((select relrowsecurity from pg_class where oid = 'public.action_item_events'::regclass), 'T15 RLS on');
  raise notice 'PASS T15 grants';
end $$;

-- T16 the RPC really runs as service_role: the writes reach the trigger through
-- the definer, and the role itself cannot touch the event table.
set role service_role;
select public.transition_action_item('b0000000-0000-4000-8000-000000000002', '{open}', 'resolved', 'role-check', 'done');
insert into public.auto_resolve_decisions (item_id, candidate_description, layer, outcome, reason)
  values ('b0000000-0000-4000-8000-000000000002', 'role', 'archive', 'proposed', 'age_standard');
select public.record_decisions('[{"item_id":"b0000000-0000-4000-8000-000000000002","candidate_description":"role2","layer":"archive","outcome":"proposed","reason":"age_standard"}]'::jsonb);
reset role;
do $$
begin
  perform pg_temp.ok((select actor from public.action_item_events where item_id = 'b0000000-0000-4000-8000-000000000002') = 'role-check', 'T16 event written under service_role');
  raise notice 'PASS T16 service_role path';
end $$;

-- T17 the other arm of the survivor CHECK: hard-deleting a survivor must still work,
-- clearing duplicate_of and leaving the close reason standing.
-- T18 the retention limitation, pinned so a change to it is a decision: callers cannot
-- touch event rows, but a hard delete of the item takes them.
insert into public.action_items (id, description, status) values
 ('b1000000-0000-4000-8000-000000000002', 'survivor to delete', 'open'),
 ('b1000000-0000-4000-8000-000000000003', 'dup of it', 'open');
select public.transition_action_item('b1000000-0000-4000-8000-000000000003', '{open}', 'archived', 'operator', 'duplicate', null, null, null, 'b1000000-0000-4000-8000-000000000002');
select public.transition_action_item('b1000000-0000-4000-8000-000000000002', '{open}', 'resolved', 'operator', 'done');
delete from public.action_items where id = 'b1000000-0000-4000-8000-000000000002';
do $$
declare v_row public.action_items;
begin
  select * into v_row from public.action_items where id = 'b1000000-0000-4000-8000-000000000003';
  perform pg_temp.ok(v_row.duplicate_of is null, 'T17 survivor delete cleared duplicate_of');
  perform pg_temp.ok(v_row.close_reason = 'duplicate', 'T17 the close reason stands');
  perform pg_temp.ok(v_row.status = 'archived', 'T17 the row stays closed');
  raise notice 'PASS T17 a survivor can still be hard-deleted';
  perform pg_temp.ok((select count(*) from public.action_item_events where item_id = 'b1000000-0000-4000-8000-000000000002') = 0, 'T18 a hard delete takes the item''s events');
  perform pg_temp.ok((select count(*) from public.action_item_events where item_id = 'b1000000-0000-4000-8000-000000000003') = 1, 'T18 another item keeps its events');
  raise notice 'PASS T18 the event cascade on a hard delete is the documented limit';
end $$;

select 'ACTION ITEM EVENTS SQL TEST PASSED' as result;
