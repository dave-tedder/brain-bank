-- Loop-closing Task 3.3: single-connection contract for
-- 20261119b_action_items_review.sql (review_action_item, the clearing trigger,
-- the CHECKs, list_unreviewed_action_items). Run ONLY by
-- action-item-review-sql-test.sh against a throwaway local cluster. Every check
-- prints PASS <name> or raises FAIL <name>; the last line prints
-- ACTION ITEM REVIEW SQL TEST PASSED.
--
-- How a failure is told apart from an interruption (PR 25 Codex review, P2,
-- 2026-11-18): a check that RAN and did not hold raises SQLSTATE TF001 with a
-- message starting "FAIL ", from pg_temp.ok and from nowhere else. The runner
-- counts only that as a completed failure. Any other error that stops this file
-- (a cancelled statement, a timeout, a lost resource, or an error no check was
-- written for) is NEVER-RAN there. So every error a mutant is expected to
-- produce is caught by pg_temp.attempt and judged by a named check; and
-- pg_temp.attempt re-raises an interruption untouched instead of reporting it.
--
-- The rows a000000*-... were inserted by the shell BEFORE the migration under
-- test was applied, as production's rows predate it.

\set ON_ERROR_STOP 1
set client_min_messages = notice;

-- The SQLSTATE prefixes that mean "interrupted, nothing was judged". One list,
-- owned by the runner (INTERRUPTION_PREFIXES) and passed in, so the shell, this
-- file and the integration bridge cannot disagree.
create temp table obt_interruption (prefix text primary key);
insert into obt_interruption select unnest(string_to_array(:'interruption_prefixes', ' '));

insert into public.agent_task_ledger (agent_code) values ('triage');

create function pg_temp.interruption(p_state text)
returns boolean language sql stable as $$
  select p_state is null or exists (select 1 from obt_interruption i where p_state like i.prefix || '%')
$$;

-- The only place TF001 is raised. One line, so the runner's first error line
-- carries the whole verdict.
create function pg_temp.ok(p_name text, p_cond boolean, p_detail text default '')
returns void language plpgsql as $$
begin
  if p_cond is distinct from true then
    raise exception using errcode = 'TF001',
      message = regexp_replace(format('FAIL %s: %s', p_name, p_detail), E'[\n\r]+', ' ', 'g');
  end if;
  raise notice 'PASS %', p_name;
end $$;

-- Run one statement and REPORT a behavioral error instead of raising it, so a
-- named check can judge it. An interruption is re-raised as it came: it is not
-- an answer from the code under test. (WHEN OTHERS never catches a cancelled
-- statement, 57014, in the first place.) The one handler in this file.
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

-- created_at is backdated: an item created "now" would hide a review that also
-- rewrote created_at to now(), because both are this transaction's timestamp.
create function pg_temp.item(p_id uuid, p_status text default 'open')
returns void language sql as $$
  insert into public.action_items (id, description, status, defer_reason, created_at)
  values (p_id, 'item ' || left(p_id::text, 8), p_status,
          case when p_status = 'deferred' then 'pause:test' end,
          now() - interval '5 days')
$$;

-- Every row of action_items and action_item_events, every column, keyed by the
-- full uuid. "Zero writes" is equality of two of these across ALL rows.
create function pg_temp.state()
returns jsonb language sql as $$
  select jsonb_build_object(
    'action_items', coalesce((select jsonb_object_agg(a.id::text, to_jsonb(a)) from public.action_items a), '{}'::jsonb),
    'action_item_events', coalesce((select jsonb_object_agg(e.id::text, to_jsonb(e)) from public.action_item_events e), '{}'::jsonb))
$$;

-- One item's row without the six review columns: what a review must not touch.
create function pg_temp.rest(p_id uuid)
returns jsonb language sql as $$
  select to_jsonb(a) - 'last_reviewed_at' - 'last_reviewed_by' - 'review_outcome'
         - 'triage_disposition' - 'triage_evidence' - 'triage_replacement_id'
  from public.action_items a where a.id = p_id
$$;

-- The six review columns of one item, as text.
create function pg_temp.review(p_id uuid)
returns text language sql as $$
  select concat_ws('|', coalesce(a.review_outcome, '-'), coalesce(a.last_reviewed_by, '-'),
                   coalesce(a.triage_disposition, '-'), coalesce(a.triage_evidence, '-'),
                   coalesce(a.triage_replacement_id::text, '-'),
                   case when a.last_reviewed_at is null then 'never' else 'at' end)
  from public.action_items a where a.id = p_id
$$;

-- A call that must raise p_state, with a message containing p_like, and write
-- nothing anywhere. A call that returns instead of raising fails here.
create function pg_temp.raises(p_name text, p_sql text, p_state text, p_like text)
returns void language plpgsql as $$
declare
  v_before jsonb := pg_temp.state();
  a record;
begin
  select * into a from pg_temp.attempt(p_sql);
  perform pg_temp.ok(p_name, a.o_raised and a.o_state = p_state and a.o_message like '%' || p_like || '%',
    format('raised=%s sqlstate=%s message=%s', a.o_raised, coalesce(a.o_state, '-'), coalesce(a.o_message, '-')));
  perform pg_temp.ok(p_name || ' wrote nothing', pg_temp.state() = v_before);
end $$;

-- A direct write that must be stopped by exactly the named CHECK.
create function pg_temp.check_stops(p_name text, p_sql text, p_constraint text)
returns void language plpgsql as $$
declare
  a record;
begin
  select * into a from pg_temp.attempt(p_sql);
  perform pg_temp.ok(p_name, a.o_raised and a.o_state = '23514' and a.o_constraint = p_constraint,
    format('raised=%s sqlstate=%s constraint=%s', a.o_raised, coalesce(a.o_state, '-'), coalesce(nullif(a.o_constraint, ''), '-')));
end $$;

-- ---------------------------------------------------------------------------
-- T00: the harness's own classification, before it is relied on
-- ---------------------------------------------------------------------------
do $$
declare a record;
begin
  perform pg_temp.ok('T00 harness: the runner passed its interruption list',
    (select count(*) from obt_interruption) >= 6, (select count(*)::text from obt_interruption));
  perform pg_temp.ok('T00 harness: cancellation, connection, resource, limit, system and internal errors are interruptions',
    (select bool_and(pg_temp.interruption(s)) from unnest(array['57014', '57P01', '08006', '53200', '54001', '58030', 'XX000', '55P03']) s)
    and pg_temp.interruption(null));
  perform pg_temp.ok('T00 harness: the errors a mutant is expected to produce are not interruptions',
    not (select bool_or(pg_temp.interruption(s)) from unnest(array['23503', '23514', '22023', '2201X', '22012', 'P0001', '42883', 'TF001']) s));
  select * into a from pg_temp.attempt('select 1/0');
  perform pg_temp.ok('T00 harness: attempt reports a behavioral error with its SQLSTATE',
    a.o_raised and a.o_state = '22012', format('raised=%s sqlstate=%s', a.o_raised, coalesce(a.o_state, '-')));
  select * into a from pg_temp.attempt('select 1');
  perform pg_temp.ok('T00 harness: attempt reports a statement that did not raise',
    not a.o_raised and a.o_state is null, format('raised=%s sqlstate=%s', a.o_raised, coalesce(a.o_state, '-')));
end $$;

-- OBRP_INJECT_POINT (the runner's negative controls insert one statement here)

-- ---------------------------------------------------------------------------
-- T01: rows that predate the migration
-- ---------------------------------------------------------------------------
do $$
declare v_n integer;
begin
  select count(*) into v_n from public.action_items
  where id::text like 'a000000%' and last_reviewed_at is null and last_reviewed_by is null
    and review_outcome is null and triage_disposition is null and triage_evidence is null
    and triage_replacement_id is null;
  perform pg_temp.ok('T01 the three pre-migration rows carry six null review columns', v_n = 3, 'count ' || v_n);
  select count(*) into v_n from public.list_unreviewed_action_items(14, 100, 0) l where l.id::text like 'a000000%';
  perform pg_temp.ok('T01 the two OPEN pre-migration rows are in the unreviewed list', v_n = 2, 'count ' || v_n);
end $$;

-- ---------------------------------------------------------------------------
-- T02 to T06: recorded reviews
-- ---------------------------------------------------------------------------
do $$
declare
  k uuid := 'c1000001-0000-4000-8000-000000000000';
  r record; v_rest jsonb; v_events bigint;
begin
  perform pg_temp.item(k);
  v_rest := pg_temp.rest(k);
  select count(*) into v_events from public.action_item_events;
  select * into r from public.review_action_item(k, 'keep', 'triage');
  perform pg_temp.ok('T02 keep is recorded', r.status = 'recorded' and r.message = 'kept c1000001', r.status || '|' || r.message);
  perform pg_temp.ok('T02 keep writes outcome, actor and time, and no proposal columns',
    pg_temp.review(k) = 'keep|triage|-|-|-|at', pg_temp.review(k));
  perform pg_temp.ok('T02 last_reviewed_at is the transaction time',
    (select last_reviewed_at = now() from public.action_items where id = k));
  perform pg_temp.ok('T02 no other column of the item changed (created_at is 5 days old, so a rewrite would show)',
    pg_temp.rest(k) = v_rest and (select created_at = now() - interval '5 days' from public.action_items where id = k));
  perform pg_temp.ok('T02 the item is still open', (select status = 'open' from public.action_items where id = k));
  perform pg_temp.ok('T02 a review writes no status event',
    (select count(*) from public.action_item_events) = v_events);
end $$;

do $$
declare
  s uuid := 'c1000002-0000-4000-8000-000000000000';
  d uuid := 'c1000003-0000-4000-8000-000000000000';
  y uuid := 'c1000004-0000-4000-8000-000000000000';
  r record; v_rest jsonb;
begin
  perform pg_temp.item(s); perform pg_temp.item(d); perform pg_temp.item(y);
  v_rest := pg_temp.rest(s);
  select * into r from public.review_action_item(s, 'proposal', 'triage', 'stale', E' \t no activity since spring \n');
  perform pg_temp.ok('T03 a stale proposal is recorded', r.status = 'recorded' and r.message = 'proposed c1000002: stale', r.status || '|' || r.message);
  perform pg_temp.ok('T03 the evidence is stored trimmed',
    pg_temp.review(s) = 'proposal|triage|stale|no activity since spring|-|at', pg_temp.review(s));
  perform pg_temp.ok('T03 no other column of the item changed', pg_temp.rest(s) = v_rest);

  select * into r from public.review_action_item(d, 'proposal', 'operator', 'duplicate', 'same task as the survivor', y);
  perform pg_temp.ok('T04 a duplicate proposal is recorded with its survivor',
    r.status = 'recorded' and r.message = 'proposed c1000003: duplicate of c1000004', r.status || '|' || r.message);
  perform pg_temp.ok('T04 the replacement is stored, and the actor operator is accepted',
    pg_temp.review(d) = 'proposal|operator|duplicate|same task as the survivor|' || y::text || '|at', pg_temp.review(d));
  perform pg_temp.ok('T04 the survivor itself is untouched', pg_temp.review(y) = '-|-|-|-|-|never', pg_temp.review(y));

  -- Outcome and disposition are case- and space-tolerant; the actor is trimmed.
  select * into r from public.review_action_item(y, ' Proposal ', '  triage  ', ' VAGUE ', 'no object named');
  perform pg_temp.ok('T04b outcome, disposition and actor are normalized',
    r.status = 'recorded' and pg_temp.review(y) = 'proposal|triage|vague|no object named|-|at', pg_temp.review(y));
end $$;

do $$
declare
  v_id uuid; r record; p text; i integer := 0;
begin
  foreach p in array array['thought:1a2b3c4d', 'commit:abc1234 shipped in S440', 'pr:24', 'card:9662e944', 'url:https://example.com/x'] loop
    i := i + 1;
    v_id := ('c105000' || i || '-0000-4000-8000-000000000000')::uuid;
    perform pg_temp.item(v_id);
    select * into r from public.review_action_item(v_id, 'proposal', 'triage', 'done', p);
    perform pg_temp.ok('T05 done accepts the pointer ' || split_part(p, ':', 1),
      r.status = 'recorded' and (select triage_evidence = p and triage_disposition = 'done' from public.action_items where id = v_id),
      r.status || '|' || r.message);
  end loop;
end $$;

select pg_temp.item('c1050009-0000-4000-8000-000000000000');
select pg_temp.raises('T05 done refuses evidence with no pointer',
  $q$select * from public.review_action_item('c1050009-0000-4000-8000-000000000000', 'proposal', 'triage', 'done', 'it shipped last week')$q$, '22023', 'pointer');
select pg_temp.raises('T05 done refuses a pointer with nothing after the colon',
  $q$select * from public.review_action_item('c1050009-0000-4000-8000-000000000000', 'proposal', 'triage', 'done', 'thought: 1a2b3c4d')$q$, '22023', 'pointer');
select pg_temp.raises('T05 done refuses a pointer that is not at the start',
  $q$select * from public.review_action_item('c1050009-0000-4000-8000-000000000000', 'proposal', 'triage', 'done', 'see thought:1a2b3c4d')$q$, '22023', 'pointer');
select pg_temp.raises('T05 done refuses an unknown pointer kind',
  $q$select * from public.review_action_item('c1050009-0000-4000-8000-000000000000', 'proposal', 'triage', 'done', 'note:1a2b3c4d')$q$, '22023', 'pointer');
-- Positive control beside the refusals: the same free text is fine for stale.
do $$
declare r record;
begin
  select * into r from public.review_action_item('c1050009-0000-4000-8000-000000000000', 'proposal', 'triage', 'stale', 'it shipped last week');
  perform pg_temp.ok('T05 the pointer rule applies to done only', r.status = 'recorded', r.status);
end $$;

do $$
declare
  d uuid := 'c1000003-0000-4000-8000-000000000000';
  r record;
begin
  perform pg_temp.ok('T06 fixture: the item carries a duplicate proposal',
    (select triage_disposition = 'duplicate' and triage_replacement_id is not null from public.action_items where id = d));
  select * into r from public.review_action_item(d, 'keep', 'triage');
  perform pg_temp.ok('T06 a keep after a proposal clears disposition, evidence and replacement',
    r.status = 'recorded' and pg_temp.review(d) = 'keep|triage|-|-|-|at', pg_temp.review(d));
  select * into r from public.review_action_item(d, 'proposal', 'triage', 'paused', 'paused-project:some-project');
  perform pg_temp.ok('T06 a later proposal replaces the keep',
    r.status = 'recorded' and pg_temp.review(d) = 'proposal|triage|paused|paused-project:some-project|-|at', pg_temp.review(d));
end $$;

-- ---------------------------------------------------------------------------
-- T07: malformed input raises 22023 and writes nothing
-- ---------------------------------------------------------------------------
select pg_temp.item('c1070001-0000-4000-8000-000000000000');
select pg_temp.item('c1070002-0000-4000-8000-000000000000');
\set I '''c1070001-0000-4000-8000-000000000000'''
select pg_temp.raises('T07 unknown outcome',
  'select * from public.review_action_item(' || :'I' || $q$, 'skip', 'triage')$q$, '22023', 'Unknown review outcome');
select pg_temp.raises('T07 null item id',
  $q$select * from public.review_action_item(null, 'keep', 'triage')$q$, '22023', 'requires an item id');
select pg_temp.raises('T07 null actor',
  'select * from public.review_action_item(' || :'I' || $q$, 'keep', null)$q$, '22023', 'requires an actor');
select pg_temp.raises('T07 blank actor',
  'select * from public.review_action_item(' || :'I' || $q$, 'keep', '   ')$q$, '22023', 'requires an actor');
select pg_temp.raises('T07 an actor that is neither operator nor a ledger code',
  'select * from public.review_action_item(' || :'I' || $q$, 'keep', 'nobody-registered')$q$, '22023', 'neither operator nor a registered agent_code');
select pg_temp.raises('T07 keep with a disposition',
  'select * from public.review_action_item(' || :'I' || $q$, 'keep', 'triage', 'stale')$q$, '22023', 'A keep takes no');
select pg_temp.raises('T07 keep with EMPTY evidence (supplied, not absent)',
  'select * from public.review_action_item(' || :'I' || $q$, 'keep', 'triage', null, '')$q$, '22023', 'A keep takes no');
select pg_temp.raises('T07 keep with a replacement',
  'select * from public.review_action_item(' || :'I' || $q$, 'keep', 'triage', null, null, 'c1070002-0000-4000-8000-000000000000')$q$, '22023', 'A keep takes no');
select pg_temp.raises('T07 proposal with no disposition',
  'select * from public.review_action_item(' || :'I' || $q$, 'proposal', 'triage', null, 'why')$q$, '22023', 'requires a disposition');
select pg_temp.raises('T07 proposal with an empty disposition',
  'select * from public.review_action_item(' || :'I' || $q$, 'proposal', 'triage', '', 'why')$q$, '22023', 'requires a disposition');
select pg_temp.raises('T07 unknown disposition',
  'select * from public.review_action_item(' || :'I' || $q$, 'proposal', 'triage', 'junk', 'why')$q$, '22023', 'Unknown disposition');
select pg_temp.raises('T07 proposal with no evidence',
  'select * from public.review_action_item(' || :'I' || $q$, 'proposal', 'triage', 'stale')$q$, '22023', 'requires evidence');
select pg_temp.raises('T07 proposal with whitespace-only evidence',
  'select * from public.review_action_item(' || :'I' || $q$, 'proposal', 'triage', 'stale', E' \t\n ')$q$, '22023', 'requires evidence');
select pg_temp.raises('T07 evidence of 501 characters',
  'select * from public.review_action_item(' || :'I' || $q$, 'proposal', 'triage', 'stale', repeat('x', 501))$q$, '22023', '500 characters');
select pg_temp.raises('T07 duplicate with no replacement',
  'select * from public.review_action_item(' || :'I' || $q$, 'proposal', 'triage', 'duplicate', 'why')$q$, '22023', 'requires replacement_id');
select pg_temp.raises('T07 an item named as its own replacement',
  'select * from public.review_action_item(' || :'I' || $q$, 'proposal', 'triage', 'duplicate', 'why', $q$ || :'I' || ')', '22023', 'duplicate of itself');
select pg_temp.raises('T07 a replacement on a non-duplicate disposition',
  'select * from public.review_action_item(' || :'I' || $q$, 'proposal', 'triage', 'stale', 'why', 'c1070002-0000-4000-8000-000000000000')$q$, '22023', 'only legal with the duplicate disposition');
do $$
declare r record;
begin
  -- Positive control: 500 characters, padded with space the trim removes, is accepted.
  select * into r from public.review_action_item('c1070001-0000-4000-8000-000000000000', 'proposal', 'triage', 'stale', '  ' || repeat('x', 500) || '  ');
  perform pg_temp.ok('T07 evidence of exactly 500 characters after trimming is accepted',
    r.status = 'recorded' and (select char_length(triage_evidence) = 500 from public.action_items where id = 'c1070001-0000-4000-8000-000000000000'), r.status);
end $$;

-- ---------------------------------------------------------------------------
-- T08: state answers are returned and write nothing
-- ---------------------------------------------------------------------------
do $$
declare
  v_before jsonb; r record; a record; st text; v_id uuid; i integer := 0;
  o uuid := 'c1080009-0000-4000-8000-000000000000';
begin
  v_before := pg_temp.state();
  select * into r from public.review_action_item('c10800ff-0000-4000-8000-000000000000', 'keep', 'triage');
  perform pg_temp.ok('T08 an unknown item is not_found', r.status = 'not_found' and r.message = 'no action item c10800ff', r.status || '|' || r.message);
  perform pg_temp.ok('T08 not_found wrote nothing', pg_temp.state() = v_before);

  foreach st in array array['deferred', 'archived', 'resolved'] loop
    i := i + 1;
    v_id := ('c108000' || i || '-0000-4000-8000-000000000000')::uuid;
    perform pg_temp.item(v_id);
    if st = 'deferred' then
      perform public.transition_action_item(v_id, '{open}', 'deferred', 'operator', null, null, null, null, null, 'pause:test');
    elsif st = 'archived' then
      perform public.transition_action_item(v_id, '{open}', 'archived', 'operator', 'expired');
    else
      perform public.transition_action_item(v_id, '{open}', 'resolved', 'operator', 'done');
    end if;
    perform pg_temp.ok('T08 fixture: the item is ' || st, (select status = st from public.action_items where id = v_id));
    v_before := pg_temp.state();
    select * into r from public.review_action_item(v_id, 'keep', 'triage');
    perform pg_temp.ok('T08 a keep on a ' || st || ' item is refused',
      r.status = 'refused' and r.message = format('%s is %s; only an open item is reviewed', left(v_id::text, 8), st), r.status || '|' || r.message);
    perform pg_temp.ok('T08 the refused keep on a ' || st || ' item wrote nothing', pg_temp.state() = v_before);
    select * into r from public.review_action_item(v_id, 'proposal', 'triage', 'stale', 'why');
    perform pg_temp.ok('T08 a proposal on a ' || st || ' item is refused', r.status = 'refused', r.status);
    perform pg_temp.ok('T08 the refused proposal on a ' || st || ' item wrote nothing', pg_temp.state() = v_before);
  end loop;

  perform pg_temp.item(o);
  v_before := pg_temp.state();
  -- Asked twice: once through attempt, so an error (a foreign-key violation when
  -- the existence check is gone) is a named failure here; once for the answer.
  select * into a from pg_temp.attempt($q$select * from public.review_action_item('c1080009-0000-4000-8000-000000000000', 'proposal', 'triage', 'duplicate', 'why', 'c10800ee-0000-4000-8000-000000000000')$q$);
  perform pg_temp.ok('T08 a replacement that does not exist is answered, not raised',
    not a.o_raised, format('raised sqlstate=%s constraint=%s message=%s', coalesce(a.o_state, '-'), coalesce(nullif(a.o_constraint, ''), '-'), coalesce(a.o_message, '-')));
  select * into r from public.review_action_item(o, 'proposal', 'triage', 'duplicate', 'why', 'c10800ee-0000-4000-8000-000000000000');
  perform pg_temp.ok('T08 a replacement that does not exist is refused',
    r.status = 'refused' and r.message = 'replacement c10800ee not found', r.status || '|' || r.message);
  perform pg_temp.ok('T08 the refused replacement wrote nothing', pg_temp.state() = v_before);
  -- Positive control: a replacement in ANY status is accepted (a duplicate of finished work).
  select * into r from public.review_action_item(o, 'proposal', 'triage', 'duplicate', 'why', 'c1080002-0000-4000-8000-000000000000');
  perform pg_temp.ok('T08 an archived replacement is accepted', r.status = 'recorded', r.status || '|' || r.message);
end $$;

-- ---------------------------------------------------------------------------
-- T10: the CHECKs stop a direct write the function would never make. Each write
-- violates exactly one constraint, named in the error.
-- ---------------------------------------------------------------------------
select pg_temp.item('c1100001-0000-4000-8000-000000000000');
select pg_temp.item('c1100002-0000-4000-8000-000000000000');
\set C '''c1100001-0000-4000-8000-000000000000'''
select pg_temp.check_stops('T10 an unknown outcome',
  $q$update public.action_items set last_reviewed_at = now(), last_reviewed_by = 'x', review_outcome = 'maybe' where id = $q$ || :'C',
  'action_items_review_outcome_known');
select pg_temp.check_stops('T10 an unknown disposition',
  $q$update public.action_items set last_reviewed_at = now(), last_reviewed_by = 'x', review_outcome = 'proposal', triage_disposition = 'junk', triage_evidence = 'e' where id = $q$ || :'C',
  'action_items_triage_disposition_known');
select pg_temp.check_stops('T10 a time with no outcome',
  $q$update public.action_items set last_reviewed_at = now(), last_reviewed_by = 'x' where id = $q$ || :'C',
  'action_items_review_together');
select pg_temp.check_stops('T10 an outcome with no reviewer',
  $q$update public.action_items set last_reviewed_at = now(), review_outcome = 'keep' where id = $q$ || :'C',
  'action_items_review_together');
select pg_temp.check_stops('T10 a proposal with no disposition',
  $q$update public.action_items set last_reviewed_at = now(), last_reviewed_by = 'x', review_outcome = 'proposal' where id = $q$ || :'C',
  'action_items_review_proposal_shape');
select pg_temp.check_stops('T10 a keep carrying a disposition',
  $q$update public.action_items set last_reviewed_at = now(), last_reviewed_by = 'x', review_outcome = 'keep', triage_disposition = 'stale', triage_evidence = 'e' where id = $q$ || :'C',
  'action_items_review_proposal_shape');
select pg_temp.check_stops('T10 a proposal with a disposition and no evidence',
  $q$update public.action_items set last_reviewed_at = now(), last_reviewed_by = 'x', review_outcome = 'proposal', triage_disposition = 'stale' where id = $q$ || :'C',
  'action_items_review_proposal_shape');
select pg_temp.check_stops('T10 a replacement on a stale proposal',
  $q$update public.action_items set last_reviewed_at = now(), last_reviewed_by = 'x', review_outcome = 'proposal', triage_disposition = 'stale', triage_evidence = 'e', triage_replacement_id = 'c1100002-0000-4000-8000-000000000000' where id = $q$ || :'C',
  'action_items_triage_replacement_consistent');
select pg_temp.check_stops('T10 an item as its own replacement',
  $q$update public.action_items set last_reviewed_at = now(), last_reviewed_by = 'x', review_outcome = 'proposal', triage_disposition = 'duplicate', triage_evidence = 'e', triage_replacement_id = id where id = $q$ || :'C',
  'action_items_triage_replacement_consistent');
do $$
begin
  -- Positive control: the well-formed direct write the CHECKs must admit.
  update public.action_items set last_reviewed_at = now(), last_reviewed_by = 'x', review_outcome = 'proposal',
    triage_disposition = 'duplicate', triage_evidence = 'e', triage_replacement_id = 'c1100002-0000-4000-8000-000000000000'
  where id = 'c1100001-0000-4000-8000-000000000000';
  perform pg_temp.ok('T10 a well-formed direct write is admitted',
    pg_temp.review('c1100001-0000-4000-8000-000000000000') = 'proposal|x|duplicate|e|c1100002-0000-4000-8000-000000000000|at');
end $$;

-- ---------------------------------------------------------------------------
-- T11: a hard-deleted replacement clears the link and nothing else
-- ---------------------------------------------------------------------------
do $$
declare a record;
begin
  perform pg_temp.ok('T11 fixture: the replacement exists and a proposal names it',
    exists (select 1 from public.action_items where id = 'c1100002-0000-4000-8000-000000000000')
    and (select triage_replacement_id = 'c1100002-0000-4000-8000-000000000000' from public.action_items where id = 'c1100001-0000-4000-8000-000000000000'));
  -- Through attempt: a delete the foreign key refuses is a named failure here.
  select * into a from pg_temp.attempt($q$delete from public.action_items where id = 'c1100002-0000-4000-8000-000000000000'$q$);
  perform pg_temp.ok('T11 a replacement named by a proposal can be hard-deleted',
    not a.o_raised, format('raised sqlstate=%s constraint=%s message=%s', coalesce(a.o_state, '-'), coalesce(nullif(a.o_constraint, ''), '-'), coalesce(a.o_message, '-')));
  perform pg_temp.ok('T11 the replacement row is gone',
    not exists (select 1 from public.action_items where id = 'c1100002-0000-4000-8000-000000000000'));
  perform pg_temp.ok('T11 deleting the replacement nulls the link and keeps the proposal',
    pg_temp.review('c1100001-0000-4000-8000-000000000000') = 'proposal|x|duplicate|e|-|at',
    pg_temp.review('c1100001-0000-4000-8000-000000000000'));
end $$;

-- ---------------------------------------------------------------------------
-- T12: a return to open clears the review; nothing else does
-- ---------------------------------------------------------------------------
do $$
declare
  a uuid := 'c1200001-0000-4000-8000-000000000000';
  b uuid := 'c1200002-0000-4000-8000-000000000000';
  c uuid := 'c1200003-0000-4000-8000-000000000000';
  v_events bigint; v_rev text;
begin
  perform pg_temp.item(a); perform pg_temp.item(b); perform pg_temp.item(c);
  perform public.review_action_item(a, 'proposal', 'triage', 'paused', 'paused-project:test');
  perform public.review_action_item(b, 'proposal', 'triage', 'duplicate', 'same', c);
  perform public.review_action_item(c, 'keep', 'triage');

  v_rev := pg_temp.review(a);
  update public.action_items set description = description || ' (edited)' where id = a;
  perform pg_temp.ok('T12 an edit that changes no status keeps the review', pg_temp.review(a) = v_rev, pg_temp.review(a));
  update public.action_items set status = 'open' where id = a;
  perform pg_temp.ok('T12 an open-to-open update keeps the review', pg_temp.review(a) = v_rev, pg_temp.review(a));

  perform public.transition_action_item(a, '{open}', 'deferred', 'operator', null, null, null, null, null, 'paused-project:test');
  perform pg_temp.ok('T12 a deferred item keeps its review while deferred',
    (select status = 'deferred' from public.action_items where id = a) and pg_temp.review(a) = v_rev, pg_temp.review(a));
  perform public.transition_action_item(a, '{deferred}', 'open', 'operator');
  perform pg_temp.ok('T12 restored from deferred, the six columns are null',
    (select status = 'open' from public.action_items where id = a) and pg_temp.review(a) = '-|-|-|-|-|never', pg_temp.review(a));

  v_rev := pg_temp.review(b);
  perform public.transition_action_item(b, '{open}', 'archived', 'operator', 'duplicate', null, null, null, c);
  perform pg_temp.ok('T12 an archived item keeps its review as history',
    (select status = 'archived' from public.action_items where id = b) and pg_temp.review(b) = v_rev
    and v_rev like 'proposal|triage|duplicate|same|%', pg_temp.review(b));
  select count(*) into v_events from public.action_item_events where item_id = b;
  perform public.transition_action_item(b, '{archived}', 'open', 'operator');
  perform pg_temp.ok('T12 restored from archived, the six columns are null',
    (select status = 'open' from public.action_items where id = b) and pg_temp.review(b) = '-|-|-|-|-|never', pg_temp.review(b));
  perform pg_temp.ok('T12 the reopen still wrote exactly one Task 3.1 event and advanced the generation',
    (select count(*) from public.action_item_events where item_id = b) = v_events + 1
    and (select reopen_generation = 1 and reopened_at is not null and close_reason is null from public.action_items where id = b));

  perform public.transition_action_item(c, '{open}', 'resolved', 'operator', 'done');
  perform pg_temp.ok('T12 a resolved item keeps its review as history', pg_temp.review(c) = 'keep|triage|-|-|-|at', pg_temp.review(c));
  perform public.transition_action_item(c, '{resolved}', 'open', 'operator');
  perform pg_temp.ok('T12 restored from resolved, the six columns are null', pg_temp.review(c) = '-|-|-|-|-|never', pg_temp.review(c));
  -- The restored item is reviewable again.
  perform pg_temp.ok('T12 a restored item takes a new review',
    (select status from public.review_action_item(c, 'keep', 'operator')) = 'recorded'
    and pg_temp.review(c) = 'keep|operator|-|-|-|at', pg_temp.review(c));
end $$;

-- ---------------------------------------------------------------------------
-- T13: the read order. A clean table, every time relative to this transaction's
-- now(), so the 14-day boundary is exact.
-- ---------------------------------------------------------------------------
do $$
declare
  v_ids text; v_tot text; r record; v_before jsonb;
  -- Short names: f = 'f13000NN-...'.
begin
  delete from public.action_items;
  insert into public.action_items (id, description, status, created_at, defer_reason,
    last_reviewed_at, last_reviewed_by, review_outcome, triage_disposition, triage_evidence)
  values
    -- Three OLD rows all reviewed yesterday: the starvation case's head.
    ('f1300001-0000-4000-8000-000000000000', 'old 1', 'open', now() - interval '400 days', null, now() - interval '1 day', 'triage', 'keep', null, null),
    ('f1300002-0000-4000-8000-000000000000', 'old 2', 'open', now() - interval '399 days', null, now() - interval '1 day', 'triage', 'keep', null, null),
    ('f1300003-0000-4000-8000-000000000000', 'old 3', 'open', now() - interval '398 days', null, now() - interval '13 days', 'triage', 'proposal', 'stale', 'e'),
    -- Never reviewed, created 300 and 100 days ago.
    ('f1300004-0000-4000-8000-000000000000', 'never 300', 'open', now() - interval '300 days', null, null, null, null, null, null),
    ('f1300005-0000-4000-8000-000000000000', 'never 100', 'open', now() - interval '100 days', null, null, null, null, null, null),
    -- Created 500 days ago, reviewed 200 days ago: orders by the REVIEW time (between 300 and 100).
    ('f1300006-0000-4000-8000-000000000000', 'reviewed 200', 'open', now() - interval '500 days', null, now() - interval '200 days', 'triage', 'keep', null, null),
    -- The boundary: exactly 14 days ago is NOT older than 14 days; one second more is.
    ('f1300007-0000-4000-8000-000000000000', 'exactly 14d', 'open', now() - interval '600 days', null, now() - interval '14 days', 'triage', 'keep', null, null),
    ('f1300008-0000-4000-8000-000000000000', '14d and 1s', 'open', now() - interval '600 days', null, now() - interval '14 days 1 second', 'triage', 'proposal', 'vague', 'e'),
    -- A tie on the ordering time (both never reviewed, same created_at), inserted high id first.
    ('f130000b-0000-4000-8000-000000000000', 'tie b', 'open', now() - interval '50 days', null, null, null, null, null, null),
    ('f130000a-0000-4000-8000-000000000000', 'tie a', 'open', now() - interval '50 days', null, null, null, null, null, null),
    -- Reviewed 20 days ago: in a 14-day window, out of a 30-day one.
    ('f130000c-0000-4000-8000-000000000000', 'reviewed 20', 'open', now() - interval '700 days', null, now() - interval '20 days', 'triage', 'keep', null, null),
    -- Not open: never listed, however old and unreviewed.
    ('f130000d-0000-4000-8000-000000000000', 'deferred', 'deferred', now() - interval '900 days', 'pause:test', null, null, null, null, null),
    ('f130000e-0000-4000-8000-000000000000', 'archived', 'archived', now() - interval '900 days', null, null, null, null, null, null),
    ('f130000f-0000-4000-8000-000000000000', 'resolved', 'resolved', now() - interval '900 days', null, null, null, null, null, null);
  v_before := pg_temp.state();

  select string_agg(substr(l.id::text, 7, 2), ' ' order by l.ord), string_agg(distinct l.unreviewed_total::text, ',')
    into v_ids, v_tot
  from (select *, row_number() over () as ord from public.list_unreviewed_action_items(14, 100, 0)) l;
  -- 04 (300d) 06 (review 200d) 05 (100d) 0a 0b (50d, id order) 0c (review 20d) 08 (review 14d 1s)
  perform pg_temp.ok('T13 the whole window, in order: coalesce(last_reviewed_at, created_at), then id',
    v_ids = '04 06 05 0a 0b 0c 08', coalesce(v_ids, '(none)'));
  perform pg_temp.ok('T13 unreviewed_total is the window size on every row', v_tot = '7', coalesce(v_tot, '(none)'));

  select string_agg(substr(l.id::text, 7, 2), ' ' order by l.ord), string_agg(distinct l.unreviewed_total::text, ',')
    into v_ids, v_tot
  from (select *, row_number() over () as ord from public.list_unreviewed_action_items(14, 2, 0)) l;
  perform pg_temp.ok('T13 starvation case: the three oldest rows are recently reviewed and limit 2 still reaches the unreviewed',
    v_ids = '04 06', coalesce(v_ids, '(none)'));
  perform pg_temp.ok('T13 unreviewed_total does not shrink with the limit', v_tot = '7', coalesce(v_tot, '(none)'));

  select string_agg(substr(l.id::text, 7, 2), ' ' order by l.ord) into v_ids
  from (select *, row_number() over () as ord from public.list_unreviewed_action_items(14, 3, 2)) l;
  perform pg_temp.ok('T13 limit and offset page the same order', v_ids = '05 0a 0b', coalesce(v_ids, '(none)'));

  select string_agg(substr(l.id::text, 7, 2), ' ' order by l.ord) into v_ids
  from (select *, row_number() over () as ord from public.list_unreviewed_action_items(30, 100, 0)) l;
  perform pg_temp.ok('T13 the window follows unreviewed_days: 30 days drops the rows reviewed 20 and 14 days ago',
    v_ids = '04 06 05 0a 0b', coalesce(v_ids, '(none)'));

  select * into r from public.list_unreviewed_action_items(14, 1, 5) l;
  perform pg_temp.ok('T13 a listed row carries its previous review',
    r.id = 'f130000c-0000-4000-8000-000000000000' and r.review_outcome = 'keep' and r.last_reviewed_by = 'triage'
    and r.last_reviewed_at = now() - interval '20 days' and r.status = 'open' and r.description = 'reviewed 20',
    r.id::text);

  -- Six list calls above, between the snapshot and here.
  perform pg_temp.ok('T13 listing wrote nothing', pg_temp.state() = v_before);
  -- The window moves: reviewing the head removes it, and the next read starts at the next oldest.
  perform public.review_action_item('f1300004-0000-4000-8000-000000000000', 'keep', 'triage');
  select string_agg(substr(l.id::text, 7, 2), ' ' order by l.ord), string_agg(distinct l.unreviewed_total::text, ',')
    into v_ids, v_tot
  from (select *, row_number() over () as ord from public.list_unreviewed_action_items(14, 2, 0)) l;
  perform pg_temp.ok('T13 a reviewed row leaves the window and the next read starts at the next oldest',
    v_ids = '06 05' and v_tot = '6', coalesce(v_ids, '(none)') || ' total ' || coalesce(v_tot, '-'));
end $$;

select pg_temp.raises('T13 unreviewed_days 0', 'select * from public.list_unreviewed_action_items(0, 10, 0)', '22023', 'between 1 and 365');
select pg_temp.raises('T13 unreviewed_days 366', 'select * from public.list_unreviewed_action_items(366, 10, 0)', '22023', 'between 1 and 365');
select pg_temp.raises('T13 unreviewed_days null', 'select * from public.list_unreviewed_action_items(null, 10, 0)', '22023', 'between 1 and 365');
select pg_temp.raises('T13 limit 0', 'select * from public.list_unreviewed_action_items(14, 0, 0)', '22023', 'between 1 and 100');
select pg_temp.raises('T13 limit 101', 'select * from public.list_unreviewed_action_items(14, 101, 0)', '22023', 'between 1 and 100');
select pg_temp.raises('T13 offset -1', 'select * from public.list_unreviewed_action_items(14, 10, -1)', '22023', '0 or greater');
do $$
begin
  perform pg_temp.ok('T13 the bounds themselves are accepted (1 and 365 days, limit 1 and 100)',
    (select count(*) from public.list_unreviewed_action_items(1, 100, 0)) > 0
    and (select count(*) from public.list_unreviewed_action_items(365, 1, 0)) = 1);
end $$;

-- ---------------------------------------------------------------------------
-- T14: who may execute
-- ---------------------------------------------------------------------------
do $$
declare
  f text; v_ran integer;
begin
  foreach f in array array[
    'public.review_action_item(uuid, text, text, text, text, uuid)',
    'public.list_unreviewed_action_items(integer, integer, integer)'] loop
    perform pg_temp.ok('T14 anon cannot execute ' || split_part(f, '(', 1), not has_function_privilege('anon', f, 'execute'));
    perform pg_temp.ok('T14 authenticated cannot execute ' || split_part(f, '(', 1), not has_function_privilege('authenticated', f, 'execute'));
    perform pg_temp.ok('T14 service_role can execute ' || split_part(f, '(', 1), has_function_privilege('service_role', f, 'execute'));
  end loop;
  -- And really run both as service_role.
  set local role service_role;
  select count(*) into v_ran from public.list_unreviewed_action_items(14, 5, 0);
  perform public.review_action_item('f1300005-0000-4000-8000-000000000000', 'keep', 'triage');
  reset role;
  perform pg_temp.ok('T14 service_role ran both functions',
    v_ran > 0 and pg_temp.review('f1300005-0000-4000-8000-000000000000') = 'keep|triage|-|-|-|at');
end $$;

do $$ begin raise notice 'ACTION ITEM REVIEW SQL TEST PASSED'; end $$;
