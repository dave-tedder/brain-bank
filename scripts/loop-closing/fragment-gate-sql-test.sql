-- Loop-closing Task 5.1: single-connection contract for
-- 20261120_fragment_pending_proposals.sql and for the fragment rows the capture
-- paths write. Run ONLY by fragment-gate-sql-test.sh against a throwaway local
-- cluster. Every check prints PASS <name> or raises FAIL <name>; the last line
-- prints FRAGMENT GATE SQL TEST PASSED.
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

-- Fixtures. Thought T, items created five days ago.
insert into public.thoughts (id) values ('e5100000-0000-4000-8000-000000000001') on conflict do nothing;
create function pg_temp.item(p_id uuid, p_desc text, p_status text default 'open')
returns void language sql as $$
  insert into public.action_items (id, description, status, defer_reason, created_at)
  values (p_id, p_desc, p_status, case when p_status = 'deferred' then 'pause:test' end, now() - interval '5 days')
$$;
-- A pronoun suspect row, backdated by p_minutes so the order is deterministic.
create function pg_temp.suspect(p_id uuid, p_item uuid, p_minutes integer)
returns void language sql as $$
  insert into public.auto_resolve_decisions (id, item_id, thought_id, candidate_description, layer, outcome, reason, created_at)
  select p_id, p_item, 'e5100000-0000-4000-8000-000000000001', a.description, 'fragment', 'proposed', 'pronoun_object',
         now() - make_interval(mins => p_minutes)
  from public.action_items a where a.id = p_item
$$;
create function pg_temp.pending(p_limit integer default 200)
returns text language sql as $$
  select coalesce(string_agg(left(item_id::text, 8) || ':' || left(decision_id::text, 8) || ':' || pending_total, ',' order by proposed_at, item_id), '')
  from public.fragment_pending_proposals(p_limit)
$$;

-- F01 to F03: the rows the gate writes are what the schema accepts, and a
-- wrong payload is refused by the named CHECK.
do $$
declare r record;
begin
  select * into r from pg_temp.attempt($q$
    insert into public.auto_resolve_decisions (thought_id, candidate_description, layer, outcome, reason)
    values ('e5100000-0000-4000-8000-000000000001', 'deploy', 'fragment', 'dropped', 'one_token'),
           ('e5100000-0000-4000-8000-000000000001', 'finalize what we''re', 'fragment', 'dropped', 'dangling_clause')$q$);
  perform pg_temp.ok('F01 the two drop payloads (item_id null, thought_id set) are accepted', not r.o_raised, coalesce(r.o_message, ''));
  perform pg_temp.ok('F01 drop rows carry no item_generation',
    (select count(*) = 2 and bool_and(item_generation is null) from public.auto_resolve_decisions where layer = 'fragment' and outcome = 'dropped'), '');

  perform pg_temp.item('a5100001-0000-4000-8000-000000000000', 'send her the explainer PDF');
  select * into r from pg_temp.attempt($q$
    insert into public.auto_resolve_decisions (item_id, thought_id, candidate_description, layer, outcome, reason)
    values ('a5100001-0000-4000-8000-000000000000', 'e5100000-0000-4000-8000-000000000001', 'send her the explainer PDF', 'fragment', 'proposed', 'pronoun_object')$q$);
  perform pg_temp.ok('F02 the suspect payload (item_id and thought_id set) is accepted', not r.o_raised, coalesce(r.o_message, ''));
  perform pg_temp.ok('F02 the suspect row is stamped with the item''s generation',
    (select item_generation = 0 from public.auto_resolve_decisions where item_id = 'a5100001-0000-4000-8000-000000000000'), '');

  select * into r from pg_temp.attempt($q$
    insert into public.auto_resolve_decisions (item_id, thought_id, candidate_description, layer, outcome, reason)
    values ('a5100001-0000-4000-8000-000000000000', 'e5100000-0000-4000-8000-000000000001', 'deploy', 'fragment', 'dropped', 'one_token')$q$);
  perform pg_temp.ok('F03 a drop row carrying an item_id is refused by the payload CHECK',
    r.o_raised and r.o_state = '23514' and r.o_constraint = 'auto_resolve_decision_payload_ok', format('%s %s %s', r.o_raised, r.o_state, r.o_constraint));
  select * into r from pg_temp.attempt($q$
    insert into public.auto_resolve_decisions (thought_id, candidate_description, layer, outcome, reason)
    values ('e5100000-0000-4000-8000-000000000001', 'send her', 'fragment', 'proposed', 'pronoun_object')$q$);
  perform pg_temp.ok('F03 a suspect row without an item_id is refused by the payload CHECK',
    r.o_raised and r.o_state = '23514' and r.o_constraint = 'auto_resolve_decision_payload_ok', format('%s %s %s', r.o_raised, r.o_state, r.o_constraint));
end $$;

-- P01: what is pending. Clear the F02 row first so every fixture below is
-- explicit.
delete from public.auto_resolve_decisions where item_id is not null;
select pg_temp.item('a5100002-0000-4000-8000-000000000000', 'open suspect');
select pg_temp.item('a5100003-0000-4000-8000-000000000000', 'resolved suspect');
select pg_temp.item('a5100004-0000-4000-8000-000000000000', 'archived suspect');
select pg_temp.item('a5100005-0000-4000-8000-000000000000', 'deferred suspect');
select pg_temp.item('a5100006-0000-4000-8000-000000000000', 'kept suspect');
select pg_temp.item('a5100007-0000-4000-8000-000000000000', 'archive proposal only');
select pg_temp.suspect('d5100001-0000-4000-8000-000000000000', 'a5100001-0000-4000-8000-000000000000', 30);
select pg_temp.suspect('d5100002-0000-4000-8000-000000000000', 'a5100002-0000-4000-8000-000000000000', 20);
select pg_temp.suspect('d5100003-0000-4000-8000-000000000000', 'a5100003-0000-4000-8000-000000000000', 25);
select pg_temp.suspect('d5100004-0000-4000-8000-000000000000', 'a5100004-0000-4000-8000-000000000000', 24);
select pg_temp.suspect('d5100005-0000-4000-8000-000000000000', 'a5100005-0000-4000-8000-000000000000', 23);
select pg_temp.suspect('d5100006-0000-4000-8000-000000000000', 'a5100006-0000-4000-8000-000000000000', 22);
insert into public.auto_resolve_decisions (id, item_id, candidate_description, layer, outcome, reason, created_at)
values ('d5100007-0000-4000-8000-000000000000', 'a5100007-0000-4000-8000-000000000000', 'archive proposal only', 'archive', 'proposed', 'age_standard', now() - interval '40 minutes');
update public.auto_resolve_decisions set outcome = 'kept', reviewed_at = now(), reviewed_by = 'operator', review_seq = 1
where id = 'd5100006-0000-4000-8000-000000000000';
select public.transition_action_item('a5100003-0000-4000-8000-000000000000', '{open}', 'resolved', 'operator', 'done');
select public.transition_action_item('a5100004-0000-4000-8000-000000000000', '{open}', 'archived', 'operator', 'expired');
select public.transition_action_item('a5100005-0000-4000-8000-000000000000', '{open}', 'deferred', 'operator', null, null, null, null, null, 'pause:test');

select pg_temp.ok('P01 only the open items'' current proposed fragment rows are pending, oldest first, with the total',
  pg_temp.pending() = 'a5100001:d5100001:2,a5100002:d5100002:2', pg_temp.pending());

-- P02: generations. Resolve then reopen a5100002: its old row is history. A new
-- row in the new generation is pending again.
select public.transition_action_item('a5100002-0000-4000-8000-000000000000', '{open}', 'resolved', 'operator', 'done');
select public.transition_action_item('a5100002-0000-4000-8000-000000000000', '{resolved}', 'open', 'operator');
select pg_temp.ok('P02 after a reopen the earlier generation''s row is not pending',
  pg_temp.pending() = 'a5100001:d5100001:1', pg_temp.pending());
select pg_temp.suspect('d5100012-0000-4000-8000-000000000000', 'a5100002-0000-4000-8000-000000000000', 1);
select pg_temp.ok('P02 a row in the new generation is pending',
  pg_temp.pending() = 'a5100001:d5100001:2,a5100002:d5100012:2'
  and (select item_generation = 1 from public.auto_resolve_decisions where id = 'd5100012-0000-4000-8000-000000000000'), pg_temp.pending());

-- P03: two suspect rows on one item collapse to one line, the newest decision,
-- placed by that decision's time.
select pg_temp.suspect('d5100011-0000-4000-8000-000000000000', 'a5100001-0000-4000-8000-000000000000', 5);
select pg_temp.ok('P03 one line per item, the newest decision',
  pg_temp.pending() = 'a5100002:d5100012:2,a5100001:d5100011:2' or pg_temp.pending() = 'a5100001:d5100011:2,a5100002:d5100012:2', pg_temp.pending());
select pg_temp.ok('P03 that line is ordered by the newest decision''s time',
  pg_temp.pending() = 'a5100001:d5100011:2,a5100002:d5100012:2', pg_temp.pending());
delete from public.auto_resolve_decisions where id = 'd5100011-0000-4000-8000-000000000000';

-- R01, R02: Task 3.6's review_proposal on a fragment suspect, read back through
-- the pending view.
insert into public.agent_task_ledger (agent_code) values ('triage') on conflict do nothing;
do $$
declare r record;
begin
  select * into r from public.review_proposal('a5100002-0000-4000-8000-000000000000', 'keep', 'slack:U0FRAG01', 'slack-signature');
  perform pg_temp.ok('R01 keep on a fragment suspect is recorded', r.status = 'recorded', format('%s %s', r.status, r.message));
  perform pg_temp.ok('R01 the row is kept with its reviewer, the item still open',
    (select outcome = 'kept' and reviewed_by = 'slack:U0FRAG01' and review_seq = 1 from public.auto_resolve_decisions where id = 'd5100012-0000-4000-8000-000000000000')
    and (select status = 'open' from public.action_items where id = 'a5100002-0000-4000-8000-000000000000'), '');
  perform pg_temp.ok('R01 a kept suspect is no longer pending', pg_temp.pending() = 'a5100001:d5100001:1', pg_temp.pending());

  select * into r from public.review_proposal('a5100001-0000-4000-8000-000000000000', 'archive', 'operator', 'mcp-shared-key');
  perform pg_temp.ok('R02 archive on a fragment suspect is recorded', r.status = 'recorded', format('%s %s', r.status, r.message));
  perform pg_temp.ok('R02 the item is archived with close_reason fragment and the row accepted',
    (select status = 'archived' and close_reason = 'fragment' from public.action_items where id = 'a5100001-0000-4000-8000-000000000000')
    and (select outcome = 'accepted' and reviewed_by = 'operator' from public.auto_resolve_decisions where id = 'd5100001-0000-4000-8000-000000000000'), '');
  perform pg_temp.ok('R02 nothing is pending after both reviews', pg_temp.pending() = '', pg_temp.pending());
end $$;

-- L01: the limit. 501 fresh suspects.
insert into public.action_items (id, description, created_at)
select ('a52' || lpad(g::text, 5, '0') || '-0000-4000-8000-000000000000')::uuid, 'bulk ' || g, now() - interval '5 days'
from generate_series(1, 501) g;
insert into public.auto_resolve_decisions (item_id, thought_id, candidate_description, layer, outcome, reason, created_at)
select ('a52' || lpad(g::text, 5, '0') || '-0000-4000-8000-000000000000')::uuid, 'e5100000-0000-4000-8000-000000000001', 'bulk ' || g,
       'fragment', 'proposed', 'pronoun_object', now() - make_interval(secs => 1000 - g)
from generate_series(1, 501) g;
select pg_temp.ok('L01 the default limit is 200 and pending_total counts all 501',
  (select count(*) = 200 and min(pending_total) = 501 and max(pending_total) = 501 from public.fragment_pending_proposals()), '');
select pg_temp.ok('L01 a null limit is the default 200',
  (select count(*) = 200 from public.fragment_pending_proposals(null)), '');
select pg_temp.ok('L01 a limit below 1 reads 1', (select count(*) = 1 from public.fragment_pending_proposals(0)), '');
select pg_temp.ok('L01 a limit above 500 reads 500', (select count(*) = 500 from public.fragment_pending_proposals(10000)), '');
select pg_temp.ok('L01 the first row is the oldest',
  (select left(item_id::text, 8) = 'a5200001' from public.fragment_pending_proposals(1)), '');

-- S01, G01: shape and grants.
select pg_temp.ok('S01 the read is stable, security invoker, with a pinned search_path',
  (select p.provolatile = 's' and not p.prosecdef and p.proconfig = array['search_path=pg_catalog, public']
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fragment_pending_proposals'), '');
select pg_temp.ok('G01 service_role may execute it; anon, authenticated and public may not',
  has_function_privilege('service_role', 'public.fragment_pending_proposals(integer)', 'execute')
  and not has_function_privilege('anon', 'public.fragment_pending_proposals(integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.fragment_pending_proposals(integer)', 'execute')
  and not exists (select 1 from information_schema.routine_privileges
                  where routine_name = 'fragment_pending_proposals' and grantee = 'PUBLIC'), '');

-- Leave nothing pending for the integration bridge, which runs next on this
-- database and expects to see only what it creates.
delete from public.auto_resolve_decisions where layer = 'fragment' and candidate_description like 'bulk %';
select pg_temp.ok('Z01 nothing is pending when the contract hands over', pg_temp.pending() = '', pg_temp.pending());

do $$ begin raise notice 'FRAGMENT GATE SQL TEST PASSED'; end $$;
