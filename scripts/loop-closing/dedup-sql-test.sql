-- Loop-closing Task 5.2: single-connection contract for
-- 20261120c_dedup_semantic_reads.sql and for the dedup rows the capture paths
-- write. Run ONLY by dedup-sql-test.sh against a throwaway local cluster. Every
-- check prints PASS <name> or raises FAIL <name>; the last line prints
-- DEDUP SQL TEST PASSED.
--
-- Failure versus interruption (the rule of action-item-review-sql-test.sql): a
-- check that RAN and did not hold raises SQLSTATE TF001 with a message starting
-- "FAIL ", from pg_temp.ok and from nowhere else. Any other error that stops
-- this file is NEVER-RAN in the runner. Every error a check expects is caught by
-- pg_temp.attempt and judged by name; an interruption is re-raised untouched.

\set ON_ERROR_STOP 1
set client_min_messages = notice;

create temp table obt_interruption (prefix text primary key);
insert into obt_interruption select unnest(string_to_array(:'interruption_prefixes', ' '));

create function pg_temp.interruption(p_state text)
returns boolean language sql stable as $$
  select p_state is null or exists (select 1 from obt_interruption i where p_state like i.prefix || '%')
$$;

create function pg_temp.ok(p_name text, p_cond boolean, p_detail text default '')
returns void language plpgsql as $$
begin
  if p_cond is distinct from true then
    raise exception using errcode = 'TF001',
      message = regexp_replace(format('FAIL %s: %s', p_name, p_detail), E'[\n\r]+', ' ', 'g');
  end if;
  raise notice 'PASS %', p_name;
end $$;

create function pg_temp.attempt(p_sql text, out o_raised boolean, out o_state text,
                                out o_message text, out o_constraint text)
language plpgsql as $$
begin
  o_raised := false;
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics o_state = returned_sqlstate, o_message = message_text,
                            o_constraint = constraint_name;
    if pg_temp.interruption(o_state) then raise; end if;
    o_raised := true;
  end;
end $$;

-- OBRP_INJECT_POINT (the runner's negative controls insert one statement here)

-- Fixtures: three source thoughts with projects, one without metadata, one with
-- a blank project. Items are backdated by p_days.
insert into public.thoughts (id, metadata) values
  ('e5200000-0000-4000-8000-000000000001', '{"project": "brain-bank"}'),
  ('e5200000-0000-4000-8000-000000000002', '{"project": "  external-crm  "}'),
  ('e5200000-0000-4000-8000-000000000003', null),
  ('e5200000-0000-4000-8000-000000000004', '{"project": "   "}')
on conflict do nothing;
create function pg_temp.item(p_id uuid, p_desc text, p_days numeric, p_thought uuid default null, p_status text default 'open')
returns void language sql as $$
  insert into public.action_items (id, description, status, defer_reason, created_at, source_thought_id)
  values (p_id, p_desc, p_status, case when p_status = 'deferred' then 'pause:test' end,
          now() - make_interval(secs => (p_days * 86400)::double precision), p_thought)
$$;
create function pg_temp.cands(p_days integer default 14, p_limit integer default 500)
returns text language sql as $$
  select coalesce(string_agg(left(id::text, 8) || ':' || coalesce(project, '-'), ',' order by created_at, id), '')
  from public.dedup_semantic_candidates(p_days, p_limit)
$$;
create function pg_temp.pending(p_limit integer default 200)
returns text language sql as $$
  select coalesce(string_agg(left(item_id::text, 8) || ':' || left(decision_id::text, 8) || ':' || left(survivor_id::text, 8)
                             || ':' || coalesce(survivor_status, '-') || ':' || pending_total, ',' order by proposed_at, item_id), '')
  from public.dedup_pending_proposals(p_limit)
$$;
-- A semantic proposal row, backdated by p_minutes so the order is deterministic.
create function pg_temp.proposal(p_id uuid, p_item uuid, p_survivor uuid, p_minutes integer, p_score numeric default 0.9)
returns void language sql as $$
  insert into public.auto_resolve_decisions (id, item_id, related_item_id, score, candidate_description, layer, outcome, reason, created_at)
  select p_id, p_item, p_survivor, p_score, a.description, 'dedup', 'proposed', 'semantic_overlap', now() - make_interval(mins => p_minutes)
  from public.action_items a where a.id = p_item
$$;

-- C01 to C04: the capture-time candidate read.
select pg_temp.item('a5200001-0000-4000-8000-000000000000', 'oldest open, project brain-bank', 13, 'e5200000-0000-4000-8000-000000000001');
select pg_temp.item('a5200002-0000-4000-8000-000000000000', 'open, project padded', 10, 'e5200000-0000-4000-8000-000000000002');
select pg_temp.item('a5200003-0000-4000-8000-000000000000', 'open, thought without metadata', 5, 'e5200000-0000-4000-8000-000000000003');
select pg_temp.item('a5200004-0000-4000-8000-000000000000', 'open, blank project', 3, 'e5200000-0000-4000-8000-000000000004');
select pg_temp.item('a5200005-0000-4000-8000-000000000000', 'open, no source thought', 2);
select pg_temp.item('a5200006-0000-4000-8000-000000000000', 'open but 20 days old', 20, 'e5200000-0000-4000-8000-000000000001');
select pg_temp.item('a5200007-0000-4000-8000-000000000000', 'resolved', 1, 'e5200000-0000-4000-8000-000000000001');
select pg_temp.item('a5200008-0000-4000-8000-000000000000', 'archived', 1, 'e5200000-0000-4000-8000-000000000001');
select pg_temp.item('a5200009-0000-4000-8000-000000000000', 'deferred', 1, 'e5200000-0000-4000-8000-000000000001', 'deferred');
select public.transition_action_item('a5200007-0000-4000-8000-000000000000', '{open}', 'resolved', 'operator', 'done');
select public.transition_action_item('a5200008-0000-4000-8000-000000000000', '{open}', 'archived', 'operator', 'expired');

select pg_temp.ok('C01 open items of the last 14 days, oldest first, with the trimmed project (null when absent or blank)',
  pg_temp.cands() = 'a5200001:brain-bank,a5200002:external-crm,a5200003:-,a5200004:-,a5200005:-', pg_temp.cands());
select pg_temp.ok('C02 the window is a parameter: 4 days',
  pg_temp.cands(4) = 'a5200004:-,a5200005:-', pg_temp.cands(4));
select pg_temp.item('a520000a-0000-4000-8000-000000000000', 'half a day old', 0.5);
select pg_temp.item('a520000b-0000-4000-8000-000000000000', '100 days old', 100);
select pg_temp.ok('C02 a window below 1 day reads 1 day, above 90 reads 90',
  pg_temp.cands(0) = 'a520000a:-'
  and pg_temp.cands(1000) = 'a5200006:brain-bank,a5200001:brain-bank,a5200002:external-crm,a5200003:-,a5200004:-,a5200005:-,a520000a:-',
  pg_temp.cands(0) || ' | ' || pg_temp.cands(1000));
delete from public.action_items where id in ('a520000a-0000-4000-8000-000000000000', 'a520000b-0000-4000-8000-000000000000');
select pg_temp.ok('C02 a null window is the default 14 days',
  (select count(*) = 5 from public.dedup_semantic_candidates(null, 500)), '');
select pg_temp.ok('C03 the limit keeps the oldest; below 1 reads 1; null is the default',
  pg_temp.cands(14, 2) = 'a5200001:brain-bank,a5200002:external-crm' and pg_temp.cands(14, 0) = 'a5200001:brain-bank'
  and (select count(*) = 5 from public.dedup_semantic_candidates(14, null)), pg_temp.cands(14, 2) || ' | ' || pg_temp.cands(14, 0));
insert into public.action_items (id, description, created_at)
select ('a53' || lpad(g::text, 5, '0') || '-0000-4000-8000-000000000000')::uuid, 'bulk ' || g, now() - make_interval(secs => 3600 + g)
from generate_series(1, 1001) g;
select pg_temp.ok('C03 the default limit is 500 (omitted or null) and the limit is capped at 1000',
  (select count(*) = 500 from public.dedup_semantic_candidates())
  and (select count(*) = 500 from public.dedup_semantic_candidates(14, null))
  and (select count(*) = 1000 from public.dedup_semantic_candidates(14, 100000)), '');
delete from public.action_items where description like 'bulk %';

-- D01, D02: the rows the capture paths write are what the schema accepts.
do $$
declare r record; n integer;
begin
  select * into r from pg_temp.attempt($q$
    insert into public.auto_resolve_decisions (thought_id, related_item_id, candidate_description, layer, outcome, reason)
    values ('e5200000-0000-4000-8000-000000000001', 'a5200001-0000-4000-8000-000000000000', 'oldest open, project brain-bank.', 'dedup', 'dropped', 'exact_batch')$q$);
  perform pg_temp.ok('D01 the exact_batch payload (thought_id, related_item_id, no item_id) is accepted', not r.o_raised, coalesce(r.o_message, ''));
  perform pg_temp.ok('D01 the exact_batch row carries no item_generation',
    (select count(*) = 1 and bool_and(item_generation is null) from public.auto_resolve_decisions where reason = 'exact_batch'), '');
  select * into r from pg_temp.attempt($q$
    insert into public.auto_resolve_decisions (thought_id, candidate_description, layer, outcome, reason)
    values ('e5200000-0000-4000-8000-000000000001', 'no survivor', 'dedup', 'dropped', 'exact_batch')$q$);
  perform pg_temp.ok('D01 an exact_batch row without its survivor is refused by the payload CHECK',
    r.o_raised and r.o_state = '23514' and r.o_constraint = 'auto_resolve_decision_payload_ok', format('%s %s %s', r.o_raised, r.o_state, r.o_constraint));

  n := public.record_decisions(jsonb_build_array(
    jsonb_build_object('item_id', 'a5200002-0000-4000-8000-000000000000', 'related_item_id', 'a5200001-0000-4000-8000-000000000000',
      'score', 0.833, 'candidate_description', 'open, project padded', 'layer', 'dedup', 'outcome', 'proposed', 'reason', 'semantic_overlap',
      'thought_id', null, 'quote', null, 'evidence_thought_id', null, 'evidence_event_id', null),
    jsonb_build_object('item_id', 'a5200003-0000-4000-8000-000000000000', 'related_item_id', 'a5200001-0000-4000-8000-000000000000',
      'score', 1, 'candidate_description', 'open, thought without metadata', 'layer', 'dedup', 'outcome', 'proposed', 'reason', 'semantic_overlap',
      'thought_id', null, 'quote', null, 'evidence_thought_id', null, 'evidence_event_id', null)));
  perform pg_temp.ok('D02 record_decisions writes the batch''s two semantic proposals, stamped generation 0',
    n = 2 and (select count(*) = 2 and bool_and(item_generation = 0) and bool_and(thought_id is null)
               from public.auto_resolve_decisions where reason = 'semantic_overlap'), format('n=%s', n));

  select * into r from pg_temp.attempt($q$
    select public.record_decisions(jsonb_build_array(
      jsonb_build_object('item_id', 'a5200004-0000-4000-8000-000000000000', 'related_item_id', 'a5200001-0000-4000-8000-000000000000',
        'score', 0.9, 'candidate_description', 'valid', 'layer', 'dedup', 'outcome', 'proposed', 'reason', 'semantic_overlap'),
      jsonb_build_object('item_id', 'a5200005-0000-4000-8000-000000000000', 'related_item_id', 'a5200001-0000-4000-8000-000000000000',
        'score', 0.9, 'candidate_description', 'carries a thought', 'layer', 'dedup', 'outcome', 'proposed', 'reason', 'semantic_overlap',
        'thought_id', 'e5200000-0000-4000-8000-000000000001')))$q$);
  perform pg_temp.ok('D02 a proposal carrying a thought_id is refused by the payload CHECK and the whole batch writes nothing',
    r.o_raised and r.o_state = '23514' and r.o_constraint = 'auto_resolve_decision_payload_ok'
    and (select count(*) = 2 from public.auto_resolve_decisions where reason = 'semantic_overlap'), format('%s %s %s', r.o_raised, r.o_state, r.o_constraint));
end $$;

-- P01 to P04: what the digest lists.
delete from public.auto_resolve_decisions;
select pg_temp.item('a5210001-0000-4000-8000-000000000000', 'survivor', 8);
select pg_temp.item('a5210002-0000-4000-8000-000000000000', 'newer copy, pending', 6);
select pg_temp.item('a5210003-0000-4000-8000-000000000000', 'newer copy, item resolved', 6);
select pg_temp.item('a5210004-0000-4000-8000-000000000000', 'newer copy, item deferred', 6);
select pg_temp.item('a5210005-0000-4000-8000-000000000000', 'newer copy, kept', 6);
select pg_temp.item('a5210006-0000-4000-8000-000000000000', 'newer copy, survivor archived', 6);
select pg_temp.item('a5210007-0000-4000-8000-000000000000', 'archived survivor', 9);
select pg_temp.item('a5210008-0000-4000-8000-000000000000', 'fragment suspect only', 6);
select pg_temp.proposal('d5210002-0000-4000-8000-000000000000', 'a5210002-0000-4000-8000-000000000000', 'a5210001-0000-4000-8000-000000000000', 30);
select pg_temp.proposal('d5210003-0000-4000-8000-000000000000', 'a5210003-0000-4000-8000-000000000000', 'a5210001-0000-4000-8000-000000000000', 29);
select pg_temp.proposal('d5210004-0000-4000-8000-000000000000', 'a5210004-0000-4000-8000-000000000000', 'a5210001-0000-4000-8000-000000000000', 28);
select pg_temp.proposal('d5210005-0000-4000-8000-000000000000', 'a5210005-0000-4000-8000-000000000000', 'a5210001-0000-4000-8000-000000000000', 27);
select pg_temp.proposal('d5210006-0000-4000-8000-000000000000', 'a5210006-0000-4000-8000-000000000000', 'a5210007-0000-4000-8000-000000000000', 26);
insert into public.auto_resolve_decisions (id, item_id, thought_id, candidate_description, layer, outcome, reason, created_at)
values ('d5210008-0000-4000-8000-000000000000', 'a5210008-0000-4000-8000-000000000000', 'e5200000-0000-4000-8000-000000000001',
        'fragment suspect only', 'fragment', 'proposed', 'pronoun_object', now() - interval '40 minutes');
insert into public.auto_resolve_decisions (thought_id, related_item_id, candidate_description, layer, outcome, reason, created_at)
values ('e5200000-0000-4000-8000-000000000001', 'a5210001-0000-4000-8000-000000000000', 'survivor', 'dedup', 'dropped', 'exact_batch', now() - interval '50 minutes');
update public.auto_resolve_decisions set outcome = 'kept', reviewed_at = now(), reviewed_by = 'operator', review_seq = 1
where id = 'd5210005-0000-4000-8000-000000000000';
select public.transition_action_item('a5210003-0000-4000-8000-000000000000', '{open}', 'resolved', 'operator', 'done');
select public.transition_action_item('a5210004-0000-4000-8000-000000000000', '{open}', 'deferred', 'operator', null, null, null, null, null, 'pause:test');
select public.transition_action_item('a5210007-0000-4000-8000-000000000000', '{open}', 'archived', 'operator', 'expired');

select pg_temp.ok('P01 only open items'' current proposed semantic rows are pending, oldest first, with the survivor and the total',
  pg_temp.pending() = 'a5210002:d5210002:a5210001:open:2,a5210006:d5210006:a5210007:archived:2', pg_temp.pending());
select pg_temp.ok('P01 each row carries both descriptions and the score',
  (select description = 'newer copy, pending' and survivor_description = 'survivor' and score = 0.9
   from public.dedup_pending_proposals() where item_id = 'a5210002-0000-4000-8000-000000000000'), '');

select public.transition_action_item('a5210002-0000-4000-8000-000000000000', '{open}', 'resolved', 'operator', 'done');
select public.transition_action_item('a5210002-0000-4000-8000-000000000000', '{resolved}', 'open', 'operator');
select pg_temp.ok('P02 after a reopen the earlier generation''s proposal is not pending',
  pg_temp.pending() = 'a5210006:d5210006:a5210007:archived:1', pg_temp.pending());
select pg_temp.proposal('d5210012-0000-4000-8000-000000000000', 'a5210002-0000-4000-8000-000000000000', 'a5210001-0000-4000-8000-000000000000', 20);
select pg_temp.ok('P02 a proposal in the new generation is pending',
  pg_temp.pending() = 'a5210006:d5210006:a5210007:archived:2,a5210002:d5210012:a5210001:open:2'
  and (select item_generation = 1 from public.auto_resolve_decisions where id = 'd5210012-0000-4000-8000-000000000000'), pg_temp.pending());

select pg_temp.proposal('d5210022-0000-4000-8000-000000000000', 'a5210006-0000-4000-8000-000000000000', 'a5210001-0000-4000-8000-000000000000', 5);
select pg_temp.ok('P03 two proposals on one item collapse to the newest, ordered by its time',
  pg_temp.pending() = 'a5210002:d5210012:a5210001:open:2,a5210006:d5210022:a5210001:open:2', pg_temp.pending());
delete from public.auto_resolve_decisions where id = 'd5210022-0000-4000-8000-000000000000';

-- R01 to R03: Task 3.6's review_proposal on a dedup proposal, read back through
-- the pending view.
insert into public.agent_task_ledger (agent_code) values ('triage') on conflict do nothing;
do $$
declare r record;
begin
  select * into r from public.review_proposal('a5210006-0000-4000-8000-000000000000', 'done', 'operator', 'mcp-shared-key');
  perform pg_temp.ok('R01 done is refused while the survivor is archived, and writes nothing',
    r.status = 'refused' and r.message like 'survivor a5210007 is archived%'
    and (select outcome = 'proposed' from public.auto_resolve_decisions where id = 'd5210006-0000-4000-8000-000000000000')
    and (select status = 'open' from public.action_items where id = 'a5210006-0000-4000-8000-000000000000'), format('%s %s', r.status, r.message));

  select * into r from public.review_proposal('a5210002-0000-4000-8000-000000000000', 'done', 'slack:U0DEDUP1', 'slack-signature');
  perform pg_temp.ok('R02 done on a dedup proposal is recorded', r.status = 'recorded', format('%s %s', r.status, r.message));
  perform pg_temp.ok('R02 the newer copy is archived as a duplicate of the survivor and the row accepted',
    (select status = 'archived' and close_reason = 'duplicate' and duplicate_of = 'a5210001-0000-4000-8000-000000000000'
     from public.action_items where id = 'a5210002-0000-4000-8000-000000000000')
    and (select outcome = 'accepted' and reviewed_by = 'slack:U0DEDUP1' from public.auto_resolve_decisions where id = 'd5210012-0000-4000-8000-000000000000'), '');

  select * into r from public.review_proposal('a5210006-0000-4000-8000-000000000000', 'keep', 'operator', 'mcp-shared-key');
  perform pg_temp.ok('R03 keep records the pair as distinct and leaves the item open',
    r.status = 'recorded'
    and (select outcome = 'kept' from public.auto_resolve_decisions where id = 'd5210006-0000-4000-8000-000000000000')
    and (select status = 'open' from public.action_items where id = 'a5210006-0000-4000-8000-000000000000'), format('%s %s', r.status, r.message));
  perform pg_temp.ok('R03 nothing is pending after both reviews', pg_temp.pending() = '', pg_temp.pending());
end $$;

-- L01: the limit. 501 fresh proposals.
insert into public.action_items (id, description, created_at)
select ('a54' || lpad(g::text, 5, '0') || '-0000-4000-8000-000000000000')::uuid, 'bulk ' || g, now() - interval '5 days'
from generate_series(1, 501) g;
insert into public.auto_resolve_decisions (item_id, related_item_id, score, candidate_description, layer, outcome, reason, created_at)
select ('a54' || lpad(g::text, 5, '0') || '-0000-4000-8000-000000000000')::uuid, 'a5210001-0000-4000-8000-000000000000', 0.9, 'bulk ' || g,
       'dedup', 'proposed', 'semantic_overlap', now() - make_interval(secs => 1000 - g)
from generate_series(1, 501) g;
select pg_temp.ok('L01 the default limit is 200 and pending_total counts all 501',
  (select count(*) = 200 and min(pending_total) = 501 and max(pending_total) = 501 from public.dedup_pending_proposals()), '');
select pg_temp.ok('L01 a null limit is the default 200', (select count(*) = 200 from public.dedup_pending_proposals(null)), '');
select pg_temp.ok('L01 a limit below 1 reads 1', (select count(*) = 1 from public.dedup_pending_proposals(0)), '');
select pg_temp.ok('L01 a limit above 500 reads 500', (select count(*) = 500 from public.dedup_pending_proposals(10000)), '');
select pg_temp.ok('L01 the first row is the oldest',
  (select left(item_id::text, 8) = 'a5400001' from public.dedup_pending_proposals(1)), '');

-- S01, G01: shape and grants of both functions.
select pg_temp.ok('S01 both reads are stable, security invoker, with a pinned search_path',
  (select count(*) = 2 and bool_and(coalesce(p.provolatile = 's' and not p.prosecdef and p.proconfig = array['search_path=pg_catalog, public'], false))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('dedup_semantic_candidates', 'dedup_pending_proposals')), '');
select pg_temp.ok('G01 service_role may execute both; anon, authenticated and public may not',
  has_function_privilege('service_role', 'public.dedup_semantic_candidates(integer, integer)', 'execute')
  and has_function_privilege('service_role', 'public.dedup_pending_proposals(integer)', 'execute')
  and not has_function_privilege('anon', 'public.dedup_semantic_candidates(integer, integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.dedup_semantic_candidates(integer, integer)', 'execute')
  and not has_function_privilege('anon', 'public.dedup_pending_proposals(integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.dedup_pending_proposals(integer)', 'execute')
  and not exists (select 1 from information_schema.routine_privileges
                  where routine_name in ('dedup_semantic_candidates', 'dedup_pending_proposals') and grantee = 'PUBLIC'), '');

-- Hand over a clean database to the integration bridge: no decision rows, no
-- items.
delete from public.auto_resolve_decisions;
delete from public.action_item_events;
update public.action_items set duplicate_of = null;
delete from public.action_items;
select pg_temp.ok('Z01 nothing is pending or a candidate when the contract hands over',
  pg_temp.pending() = '' and pg_temp.cands() = '', pg_temp.pending() || ' | ' || pg_temp.cands());

do $$ begin raise notice 'DEDUP SQL TEST PASSED'; end $$;
