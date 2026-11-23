-- Loop-closing Task 3.2 (producer): single-connection contract for
-- run_archive_proposals and archive_proposals_due. Run ONLY by
-- archive-proposals-sql-test.sh against a throwaway local cluster. Every check
-- prints PASS <name> or raises FAIL <name>; the last line prints
-- ARCHIVE PROPOSALS SQL TEST PASSED.
--
-- How a failure is told apart from everything else that stops this file (the
-- rule action-item-review-sql-test.sql has had since the PR 25 Codex review, P2,
-- 2026-11-18): a check that RAN and did not hold raises SQLSTATE TF001 with a
-- message starting "FAIL ", from pg_temp.ok and from nowhere else. The runner
-- counts only that as a completed failure. Any other error that stops this file
-- (a syntax error, a missing function, a cancelled statement, a timeout, a lost
-- resource, or an error no check was written for) is NEVER-RAN there. This file
-- has no error handler, so nothing here can turn such an error into an answer.
--
-- Every run passes an explicit p_now so the fixtures do not depend on the clock.
-- Fixtures that need two connections are in the shell script.

\set ON_ERROR_STOP 1
set client_min_messages = notice;

insert into public.agent_task_ledger (agent_code) values ('codex');
insert into public.clients (name) values
  ('Jordan Lee'), ('Avery Jordans'), ('Paul Reyes'), ('Mira');

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

create function pg_temp.now0() returns timestamptz language sql immutable as
  $$ select '2026-11-19 05:30:00+00'::timestamptz $$;

-- An item aged in whole days (exact hours) before now0.
create function pg_temp.mk(p_id uuid, p_desc text, p_age_days numeric,
  p_status text default 'open', p_src uuid default null)
returns void language sql as $$
  insert into public.action_items (id, description, status, created_at, defer_reason, source_thought_id)
  values (p_id, p_desc, p_status, pg_temp.now0() - make_interval(hours => (p_age_days * 24)::int),
          case when p_status = 'deferred' then 'pause:test' end, p_src)
$$;

create function pg_temp.proposed(p_id uuid) returns boolean language sql as $$
  select archive_proposed_at is not null from public.action_items where id = p_id
$$;
create function pg_temp.rows(p_id uuid, p_outcome text default 'proposed') returns bigint language sql as $$
  select count(*) from public.auto_resolve_decisions
  where item_id = p_id and layer = 'archive' and outcome = p_outcome
$$;
create function pg_temp.reason(p_id uuid) returns text language sql as $$
  select string_agg(reason, ',' order by created_at, id) from public.auto_resolve_decisions
  where item_id = p_id and layer = 'archive' and outcome = 'proposed'
$$;

-- Thought sources: a work report (two shapes) and an ordinary note.
insert into public.thoughts (id, content, created_at) values
  ('e1000000-0000-4000-8000-000000000001',
   E'Brain Bank Session 412 (2026-10-01): built the gate.\nFOR OPERATOR: check the tags', '2026-10-01 20:00:00+00'),
  ('e1000000-0000-4000-8000-000000000002', 'buy more black ink and needles', '2026-10-01 20:00:00+00'),
  -- One shape plus a dated header in the FUTURE: not a work report.
  ('e1000000-0000-4000-8000-000000000003', 'Jordan remodel session 2 (2026-12-12): send the revised koi', '2026-10-01 20:00:00+00');

-- OBAP_INJECT_POINT (the runner's negative controls insert one statement here)

-- ---------------------------------------------------------------------------
-- The age, deadline and exemption fixtures, all evaluated by ONE run.
-- ---------------------------------------------------------------------------
select pg_temp.mk('a0000000-0000-4000-8000-000000000001', 'update the shop hours page', 61);
select pg_temp.mk('a0000000-0000-4000-8000-000000000002', 'update the shop hours page', 59);
select pg_temp.mk('a0000000-0000-4000-8000-000000000003', 'reply to the vendor', 31, 'open', 'e1000000-0000-4000-8000-000000000001');
select pg_temp.mk('a0000000-0000-4000-8000-000000000004', 'reply to the vendor', 31, 'open', 'e1000000-0000-4000-8000-000000000002');
select pg_temp.mk('a0000000-0000-4000-8000-000000000005', 'reply to the vendor', 31, 'open', 'e1000000-0000-4000-8000-000000000003');
select pg_temp.mk('a0000000-0000-4000-8000-000000000006', 'run the export before 2026-11-01', 20);       -- 11-15 <= now: due
select pg_temp.mk('a0000000-0000-4000-8000-000000000007', 'flip the venue by 2027-03-01', 300);          -- future deadline wins over age
select pg_temp.mk('a0000000-0000-4000-8000-000000000008', 'entries before and after, from 2026-01-01', 61); -- clause break: standard
select pg_temp.mk('a0000000-0000-4000-8000-000000000009', 'update the shop hours page', 200, 'deferred');
select pg_temp.mk('a0000000-0000-4000-8000-000000000010', 'Perpetual auto-resolve canary (do NOT resolve)', 400);
select pg_temp.mk('a0000000-0000-4000-8000-000000000011', 'design the sleeve for paul reyes', 200);
select pg_temp.mk('a0000000-0000-4000-8000-000000000012', 'nudge Jordan if nothing arrives', 200);
select pg_temp.mk('a0000000-0000-4000-8000-000000000013', 'ask Mira about the swatch', 200);          -- one-word client, one match: not exempt
select pg_temp.mk('a0000000-0000-4000-8000-000000000014', 'card linked, Agent Todo', 200);
select pg_temp.mk('a0000000-0000-4000-8000-000000000015', 'card linked, Agent Done', 200);
select pg_temp.mk('a0000000-0000-4000-8000-000000000016', 'card linked, archived card', 200);
select pg_temp.mk('a0000000-0000-4000-8000-000000000017', 'exactly sixty days', 60);
select pg_temp.mk('a0000000-0000-4000-8000-000000000018', 'fragment flagged', 31, 'open', 'e1000000-0000-4000-8000-000000000002');
select pg_temp.mk('a0000000-0000-4000-8000-000000000019', 'resolved already', 200, 'resolved');
select pg_temp.mk('a0000000-0000-4000-8000-000000000025', 'due on a Friday 2026-11-01', 20);  -- keyword 4 tokens back: not a deadline
select pg_temp.mk('a0000000-0000-4000-8000-000000000026', 'send the proof by 2026-11-10', 20); -- deadline passed, grace not over
insert into public.agent_tasks (status, linked_action_item_id, archived_at) values
  ('Agent Todo', 'a0000000-0000-4000-8000-000000000014', null),
  ('Agent Done', 'a0000000-0000-4000-8000-000000000015', null),
  ('Needs Operator', 'a0000000-0000-4000-8000-000000000016', '2026-11-01');
insert into public.auto_resolve_decisions (item_id, thought_id, candidate_description, layer, outcome, reason)
values ('a0000000-0000-4000-8000-000000000018', 'e1000000-0000-4000-8000-000000000002', 'c', 'fragment', 'proposed', 'pronoun_object');

create temp table before_events as select count(*) as n from public.action_item_events;
create temp table run1 as select public.run_archive_proposals(pg_temp.now0()) as n;

select pg_temp.ok('A01 standard 61 days proposed, age_standard',
  pg_temp.proposed('a0000000-0000-4000-8000-000000000001') and pg_temp.reason('a0000000-0000-4000-8000-000000000001') = 'age_standard');
select pg_temp.ok('A01 archive_proposed_at is the run moment',
  (select archive_proposed_at = pg_temp.now0() from public.action_items where id = 'a0000000-0000-4000-8000-000000000001'));
select pg_temp.ok('A02 standard 59 days not proposed',
  not pg_temp.proposed('a0000000-0000-4000-8000-000000000002') and pg_temp.rows('a0000000-0000-4000-8000-000000000002') = 0);
select pg_temp.ok('A03 work-report source at 31 days proposed, age_work_report',
  pg_temp.reason('a0000000-0000-4000-8000-000000000003') = 'age_work_report');
select pg_temp.ok('A04 ordinary source at 31 days not proposed',
  not pg_temp.proposed('a0000000-0000-4000-8000-000000000004'));
select pg_temp.ok('A05 a future-dated session header is not a work report',
  not pg_temp.proposed('a0000000-0000-4000-8000-000000000005'));
select pg_temp.ok('A06 passed deadline plus 14 proposed, deadline_passed, though 20 days old',
  pg_temp.reason('a0000000-0000-4000-8000-000000000006') = 'deadline_passed');
select pg_temp.ok('A07 a future deadline outranks a 300-day age',
  not pg_temp.proposed('a0000000-0000-4000-8000-000000000007'));
select pg_temp.ok('A08 a date after a clause break is a reference: standard rule',
  pg_temp.reason('a0000000-0000-4000-8000-000000000008') = 'age_standard');
select pg_temp.ok('A09 deferred exempt', not pg_temp.proposed('a0000000-0000-4000-8000-000000000009'));
select pg_temp.ok('A10 canary exempt', not pg_temp.proposed('a0000000-0000-4000-8000-000000000010'));
select pg_temp.ok('A11 client full name exempt', not pg_temp.proposed('a0000000-0000-4000-8000-000000000011'));
select pg_temp.ok('A12 shared first name exempt (Jordan matches two clients)', not pg_temp.proposed('a0000000-0000-4000-8000-000000000012'));
select pg_temp.ok('A13 a one-match name is not client-shaped', pg_temp.proposed('a0000000-0000-4000-8000-000000000013'));
select pg_temp.ok('A14 linked to an open card exempt', not pg_temp.proposed('a0000000-0000-4000-8000-000000000014'));
select pg_temp.ok('A15 linked only to an Agent Done card is proposed', pg_temp.proposed('a0000000-0000-4000-8000-000000000015'));
select pg_temp.ok('A16 linked only to an archived card is proposed', pg_temp.proposed('a0000000-0000-4000-8000-000000000016'));
select pg_temp.ok('A17 exactly 60 days is due (inclusive)', pg_temp.proposed('a0000000-0000-4000-8000-000000000017'));
select pg_temp.ok('A18 fragment-flagged at 31 days proposed as age_work_report',
  pg_temp.reason('a0000000-0000-4000-8000-000000000018') = 'age_work_report');
select pg_temp.ok('A19 a closed item is never proposed', not pg_temp.proposed('a0000000-0000-4000-8000-000000000019'));
select pg_temp.ok('A25 a keyword four tokens before the date is not a deadline',
  not pg_temp.proposed('a0000000-0000-4000-8000-000000000025'));
select pg_temp.ok('A26 a deadline 9 days past is inside its 14-day grace',
  not pg_temp.proposed('a0000000-0000-4000-8000-000000000026'));
select pg_temp.ok('A20 run count equals the decision rows written',
  (select n from run1) = (select count(*) from public.auto_resolve_decisions where layer = 'archive')
  and (select n from run1) = 9, format('run %s', (select n from run1)));
select pg_temp.ok('A21 every proposal row is generation 0 with the exact payload',
  not exists (select 1 from public.auto_resolve_decisions d where d.layer = 'archive'
    and (d.item_generation is distinct from 0 or d.thought_id is not null or d.review_seq is not null
         or d.reviewed_at is not null or d.candidate_description is distinct from
           (select description from public.action_items a where a.id = d.item_id))));
select pg_temp.ok('A22 the job changes no status and writes no event',
  (select count(*) from public.action_item_events) = (select n from before_events)
  and (select count(*) from public.action_items where status = 'open') = 19);
select pg_temp.ok('A23 the due function agrees with what was written',
  (select array_agg(item_id order by item_id) from public.archive_proposals_due(pg_temp.now0()))
  = (select array_agg(item_id order by item_id) from public.auto_resolve_decisions where layer = 'archive'));

-- A second run the same morning writes nothing: every due item is pending.
create temp table run_a24 as select public.run_archive_proposals(pg_temp.now0()) as n;
select pg_temp.ok('A24 a second run is a no-op',
  (select n from run_a24) = 0
  and (select count(*) from public.auto_resolve_decisions where layer = 'archive') = 9
  and (select bool_and(action = 'pending') from public.archive_proposals_due(pg_temp.now0())));

-- ---------------------------------------------------------------------------
-- Review state, through Task 3.6's real RPC.
-- ---------------------------------------------------------------------------
select pg_temp.ok('B01 keep through review_proposal',
  (select status from public.review_proposal('a0000000-0000-4000-8000-000000000001', 'keep', 'operator', 'mcp-shared-key')) = 'recorded');
-- review_proposal stamps archive_reviewed_at with the real clock, so relative to
-- now0 the keep is recent whenever this runs.
create temp table run_b02 as select public.run_archive_proposals(pg_temp.now0()) as n;
select pg_temp.ok('B02 kept just now: not re-proposed',
  (select n from run_b02) = 0
  and pg_temp.rows('a0000000-0000-4000-8000-000000000001', 'kept') = 1
  and pg_temp.rows('a0000000-0000-4000-8000-000000000001') = 0);
update public.action_items set archive_reviewed_at = pg_temp.now0() - interval '89 days'
where id = 'a0000000-0000-4000-8000-000000000001';
create temp table run_b03 as select public.run_archive_proposals(pg_temp.now0()) as n;
select pg_temp.ok('B03 kept 89 days ago: still exempt',
  (select n from run_b03) = 0);
update public.action_items set archive_reviewed_at = pg_temp.now0() - interval '91 days'
where id = 'a0000000-0000-4000-8000-000000000001';
create temp table run_b04 as select public.run_archive_proposals(pg_temp.now0()) as n;
select pg_temp.ok('B04 kept 91 days ago and still due: re-proposed',
  (select n from run_b04) = 1);
select pg_temp.ok('B05 the re-proposal clears the review and keeps the old kept row',
  (select archive_review_outcome is null and archive_reviewed_at is null and archive_proposed_at = pg_temp.now0()
     from public.action_items where id = 'a0000000-0000-4000-8000-000000000001')
  and pg_temp.rows('a0000000-0000-4000-8000-000000000001', 'kept') = 1
  and pg_temp.rows('a0000000-0000-4000-8000-000000000001') = 1);
create temp table b06 as
  select status, message from public.review_proposal('a0000000-0000-4000-8000-000000000001', 'keep', 'operator', 'mcp-shared-key');
select pg_temp.ok('B06 a later keep acts on the new row only',
  (select status from b06) = 'recorded'
  and pg_temp.rows('a0000000-0000-4000-8000-000000000001', 'kept') = 2
  and (select count(distinct review_seq) from public.auto_resolve_decisions
       where item_id = 'a0000000-0000-4000-8000-000000000001' and outcome = 'kept') = 2,
  (select status || ': ' || message from b06));

-- Archive, restore, the reopen exemption, and the next generation's proposal.
-- A call and the read of its effects are separate statements: within one SELECT
-- the evaluation order of the two is not defined.
create temp table b07 as
  select status from public.review_proposal('a0000000-0000-4000-8000-000000000017', 'archive', 'operator', 'mcp-shared-key');
select pg_temp.ok('B07 archive through review_proposal archives the item',
  (select status from b07) = 'recorded'
  and (select status = 'archived' and close_reason = 'expired' from public.action_items where id = 'a0000000-0000-4000-8000-000000000017'));
create temp table b08 as
  select public.transition_action_item('a0000000-0000-4000-8000-000000000017', array['archived'], 'open', 'operator') as n;
select pg_temp.ok('B08 restore reopens and clears the archive columns',
  (select n from b08) = 1
  and (select archive_proposed_at is null and archive_review_outcome is null and reopen_generation = 1
       from public.action_items where id = 'a0000000-0000-4000-8000-000000000017'));
update public.action_items set reopened_at = pg_temp.now0() - interval '10 days'
where id = 'a0000000-0000-4000-8000-000000000017';
create temp table run_b09 as select public.run_archive_proposals(pg_temp.now0()) as n;
select pg_temp.ok('B09 reopened 10 days ago: exempt',
  (select n from run_b09) = 0
  and not pg_temp.proposed('a0000000-0000-4000-8000-000000000017'));
update public.action_items set reopened_at = pg_temp.now0() - interval '91 days'
where id = 'a0000000-0000-4000-8000-000000000017';
create temp table run_b10 as select public.run_archive_proposals(pg_temp.now0()) as n;
select pg_temp.ok('B10 reopened 91 days ago and still due: proposed in the new generation',
  (select n from run_b10) = 1
  and (select item_generation from public.auto_resolve_decisions
       where item_id = 'a0000000-0000-4000-8000-000000000017' and outcome = 'proposed') = 1
  and pg_temp.rows('a0000000-0000-4000-8000-000000000017', 'accepted') = 1);

-- A fragment row from an OLDER generation does not shorten the clock.
select pg_temp.mk('a0000000-0000-4000-8000-000000000020', 'old fragment flag', 40, 'resolved');
insert into public.auto_resolve_decisions (item_id, thought_id, candidate_description, layer, outcome, reason)
values ('a0000000-0000-4000-8000-000000000020', 'e1000000-0000-4000-8000-000000000002', 'c', 'fragment', 'proposed', 'pronoun_object');
select public.transition_action_item('a0000000-0000-4000-8000-000000000020', array['resolved'], 'open', 'operator');
update public.action_items set reopened_at = pg_temp.now0() - interval '100 days'
where id = 'a0000000-0000-4000-8000-000000000020';
create temp table run_b11 as select public.run_archive_proposals(pg_temp.now0()) as n;
select pg_temp.ok('B11 an older generation''s fragment row is history: 40 days is not due',
  (select n from run_b11) = 0
  and not pg_temp.proposed('a0000000-0000-4000-8000-000000000020'));

-- ---------------------------------------------------------------------------
-- Word boundaries are JavaScript's ASCII \b, not the locale's (Codex review of
-- PR 24, 2026-11-18). The cluster runs en_US.UTF-8, where Postgres \y and
-- [[:alnum:]] treat an accented letter as a word character and JavaScript does
-- not. Each accented case is paired with an underscore control: underscore IS a
-- word character to JavaScript, so it must still block the boundary.
-- ---------------------------------------------------------------------------
create function pg_temp.wr(p_text text) returns boolean language sql as $$
  select public.archive_policy_is_work_report(p_text, '2026-11-02 20:00:00+00')
$$;
select pg_temp.ok('W01 an accented letter before "session N" is a boundary',
  pg_temp.wr('ésession 12 handoff'));
select pg_temp.ok('W02 an accented letter after "handoff" is a boundary',
  pg_temp.wr('session 12 handoffé'));
select pg_temp.ok('W03 underscore before "session N" blocks it',
  not pg_temp.wr('_session 12 handoff'));
select pg_temp.ok('W04 underscore after "handoff" blocks it',
  not pg_temp.wr('session 12 handoff_'));
select pg_temp.ok('W05 underscore after the session number blocks it',
  not pg_temp.wr('session 12_ handoff'));
select pg_temp.ok('W06 accented letters around the dated header: two shapes',
  pg_temp.wr('Ésession 5 é2026-11-01é'));
select pg_temp.ok('W07 underscore before the header date: one shape',
  not pg_temp.wr('session 5 _2026-11-01'));
select pg_temp.ok('W08 underscore after the header date: one shape',
  not pg_temp.wr('session 5 2026-11-01_'));
select pg_temp.ok('W09 accented boundaries on every other bounded shape',
  pg_temp.wr('écommit abc1234é handoff') and pg_temp.wr('éPROJECT-TRACKER.mdé handoff')
  and pg_temp.wr('édeliverables/a/b.md handoff') and pg_temp.wr('éshipped 2026-11-01é handoff')
  and pg_temp.wr('étask 1234abcdé handoff'));
select pg_temp.ok('W10 underscore blocks every other bounded shape',
  not pg_temp.wr('_commit abc1234 handoff') and not pg_temp.wr('commit abc1234_ handoff')
  and not pg_temp.wr('PROJECT-TRACKER.md_ handoff') and not pg_temp.wr('_deliverables/a/b.md handoff')
  and not pg_temp.wr('shipped 2026-11-01_ handoff') and not pg_temp.wr('_task 1234abcd handoff'));
select pg_temp.ok('W11 ASCII letters and digits still block (the old boundary held here)',
  not pg_temp.wr('xsession 12 handoff') and not pg_temp.wr('session 12 handoffs')
  and not pg_temp.wr('2session 12 handoff'));

-- The clock the classifier selects, read through the due set: a 40-day item is
-- due only on the 30-day work-report clock.
insert into public.thoughts (id, content, created_at) values
  ('e1000000-0000-4000-8000-000000000101', 'ésession 12 handoff', '2026-10-01 20:00:00+00'),
  ('e1000000-0000-4000-8000-000000000102', 'session 12 handoffé', '2026-10-01 20:00:00+00'),
  ('e1000000-0000-4000-8000-000000000103', '_session 12 handoff', '2026-10-01 20:00:00+00');
select pg_temp.mk('a0000000-0000-4000-8000-000000000101', 'reply to the vendor', 40, 'open', 'e1000000-0000-4000-8000-000000000101');
select pg_temp.mk('a0000000-0000-4000-8000-000000000102', 'reply to the vendor', 40, 'open', 'e1000000-0000-4000-8000-000000000102');
select pg_temp.mk('a0000000-0000-4000-8000-000000000103', 'reply to the vendor', 40, 'open', 'e1000000-0000-4000-8000-000000000103');
create temp table w12 as
  select item_id, reason, action from public.archive_proposals_due(pg_temp.now0())
  where item_id in ('a0000000-0000-4000-8000-000000000101', 'a0000000-0000-4000-8000-000000000102',
                    'a0000000-0000-4000-8000-000000000103');
select pg_temp.ok('W12 accented-boundary sources at 40 days are due on the work-report clock',
  (select count(*) from w12 where reason = 'age_work_report' and action = 'propose'
     and item_id in ('a0000000-0000-4000-8000-000000000101', 'a0000000-0000-4000-8000-000000000102')) = 2,
  (select coalesce(string_agg(item_id::text || ':' || reason || ':' || action, ' '), 'none') from w12));
select pg_temp.ok('W13 the underscore control at 40 days is on the 60-day clock: not due',
  not exists (select 1 from w12 where item_id = 'a0000000-0000-4000-8000-000000000103'));

-- ---------------------------------------------------------------------------
-- JavaScript's whitespace, UTF-16 lengths and lowercasing, not the locale's
-- (Codex re-review of PR 24, 2026-11-18). Every case below is one TypeScript
-- and the locale disagree on; the expected value is the TypeScript reference's.
-- ---------------------------------------------------------------------------
create temp table js_ws (cp int);
insert into js_ws values (9), (10), (11), (12), (13), (32), (160), (5760), (8192), (8193), (8194),
  (8195), (8196), (8197), (8198), (8199), (8200), (8201), (8202), (8232), (8233), (8239), (8287),
  (12288), (65279);
select pg_temp.ok('U01 all 25 JavaScript whitespace characters split deadline tokens',
  -- coalesce: bool_and skips NULLs, and a lost deadline IS a NULL.
  (select count(*) = 25 and bool_and(coalesce(public.archive_policy_deadline('reply by' || chr(cp) || '2026-12-30') = '2026-12-30', false))
   from js_ws),
  (select coalesce(string_agg(to_hex(cp), ' '), 'none') from js_ws
   where public.archive_policy_deadline('reply by' || chr(cp) || '2026-12-30') is distinct from '2026-12-30'));
select pg_temp.ok('U02 all 25 JavaScript whitespace characters separate "commit" from its hash',
  (select bool_and(pg_temp.wr('commit' || chr(cp) || 'abcdef1 handoff')) from js_ws),
  (select coalesce(string_agg(to_hex(cp), ' '), 'none') from js_ws
   where not pg_temp.wr('commit' || chr(cp) || 'abcdef1 handoff')));
select pg_temp.ok('U03 U+0085, U+180E and U+200B are not JavaScript whitespace',
  (select bool_and(public.archive_policy_deadline('reply by' || chr(cp) || '2026-12-30') is null
                   and not pg_temp.wr('commit' || chr(cp) || 'abcdef1 handoff'))
   from (values (133), (6158), (8203)) v(cp)));
select pg_temp.ok('U04 a U+FEFF between two words makes them two tokens: the keyword is four back',
  public.archive_policy_deadline('by x' || chr(65279) || 'y z 2026-12-30') is null
  and public.archive_policy_deadline('by x' || chr(65279) || 'y 2026-12-30') = '2026-12-30');
select pg_temp.ok('U05 the dated-header gap is 24 UTF-16 units: eleven emoji (22 units) is a header',
  pg_temp.wr('session 1 ' || repeat(chr(128512), 11) || ' 2026-11-01'));
select pg_temp.ok('U06 twelve emoji is 14 characters but 26 units: not a header',
  not pg_temp.wr('session 1 ' || repeat(chr(128512), 12) || ' 2026-11-01')
  and not pg_temp.wr('session 1 ' || repeat(chr(128512), 13) || ' 2026-11-01'));
select pg_temp.ok('U07 the unit boundary itself: 24 units counts, 25 units (24 characters) does not',
  pg_temp.wr('session 1 ' || repeat('a', 20) || chr(128512) || ' 2026-11-01')
  and not pg_temp.wr('session 1 ' || repeat('a', 21) || chr(128512) || ' 2026-11-01')
  and pg_temp.wr('session 1 ' || repeat('é', 22) || ' 2026-11-01')
  and not pg_temp.wr('session 1 ' || repeat('é', 23) || ' 2026-11-01'));
select pg_temp.ok('U08 archive_policy_js_lower is JavaScript toLowerCase on every ASCII-producing character',
  public.archive_policy_js_lower('AZaz09' || chr(304) || chr(8490) || 'Éé') = 'azaz09i' || chr(775) || 'kÉé'
  and public.archive_policy_js_lower(null) = '');

insert into public.clients (name) values ('İpek Kaya'), ('Ipek Demir'), (chr(8490) || 'ira Lee');
create function pg_temp.cs(p_text text) returns boolean language sql as $$
  select public.archive_policy_client_shaped(p_text)
$$;
select pg_temp.ok('U09 a dotted capital I lowercases to "i" plus U+0307, as in JavaScript',
  pg_temp.cs('notify i' || chr(775) || 'pek kaya') and pg_temp.cs('notify İpek Kaya')
  and pg_temp.cs('notify I' || chr(775) || 'pek Kaya') and pg_temp.cs('notify İPEK KAYA')
  and not pg_temp.cs('notify ipek kaya') and not pg_temp.cs('notify pek kaya'));
select pg_temp.ok('U10 a Kelvin sign lowercases to "k"',
  pg_temp.cs('ask kira lee') and pg_temp.cs('ask ' || chr(8490) || 'ira Lee') and not pg_temp.cs('ask ira lee'));
select pg_temp.ok('U11 partial names match JavaScript''s lowercase: "Ipek" is one client, "Jordan" two',
  not pg_temp.cs('ask Ipek about the swatch') and pg_temp.cs('nudge Jordan again')
  and not pg_temp.cs('ask Kira about it'));
select pg_temp.ok('U12 deadline keywords lowercase as JavaScript does',
  public.archive_policy_deadline('UNTİL 2026-12-30') = '2026-12-30'
  and public.archive_policy_deadline('due' || chr(8490) || ' 2026-12-30') is null);

-- The clock and the exemptions, through the real writer at one moment.
insert into public.thoughts (id, content, created_at) values
  ('e1000000-0000-4000-8000-000000000201', 'session 1 ' || repeat(chr(128512), 12) || ' 2026-11-01', '2026-11-02 20:00:00+00'),
  ('e1000000-0000-4000-8000-000000000202', 'session 1 ' || repeat(chr(128512), 11) || ' 2026-11-01', '2026-11-02 20:00:00+00'),
  ('e1000000-0000-4000-8000-000000000203', 'commit' || chr(65279) || 'abcdef1 handoff', '2026-11-02 20:00:00+00');
create function pg_temp.mk_at(p_id uuid, p_desc text, p_created timestamptz, p_src uuid default null)
returns void language sql as $$
  insert into public.action_items (id, description, created_at, source_thought_id) values (p_id, p_desc, p_created, p_src)
$$;
-- Run moment 2026-12-10 05:30 UTC; items 40 or 70 days old then.
select pg_temp.mk_at('a0000000-0000-4000-8000-000000000201', 'reply to the vendor', '2026-10-31 05:30:00+00', 'e1000000-0000-4000-8000-000000000201');
select pg_temp.mk_at('a0000000-0000-4000-8000-000000000202', 'reply to the vendor', '2026-10-31 05:30:00+00', 'e1000000-0000-4000-8000-000000000202');
select pg_temp.mk_at('a0000000-0000-4000-8000-000000000203', 'reply to the vendor', '2026-10-31 05:30:00+00', 'e1000000-0000-4000-8000-000000000203');
select pg_temp.mk_at('a0000000-0000-4000-8000-000000000204', 'reply by' || chr(65279) || '2026-12-30', '2026-10-01 05:30:00+00');
select pg_temp.mk_at('a0000000-0000-4000-8000-000000000205', 'notify i' || chr(775) || 'pek kaya', '2026-10-01 05:30:00+00');
select pg_temp.mk_at('a0000000-0000-4000-8000-000000000206', 'notify ipek kaya', '2026-10-01 05:30:00+00');
select pg_temp.mk_at('a0000000-0000-4000-8000-000000000207', 'perpetual trİpwire, do not resolve', '2026-10-01 05:30:00+00');
select pg_temp.mk_at('a0000000-0000-4000-8000-000000000208', 'Perpetual TRIPWIRE, do not resolve', '2026-10-01 05:30:00+00');
select public.run_archive_proposals('2026-12-10 05:30:00+00');
select pg_temp.ok('U13 the writer follows the JavaScript clock for the emoji and U+FEFF sources',
  not pg_temp.proposed('a0000000-0000-4000-8000-000000000201')
  and pg_temp.reason('a0000000-0000-4000-8000-000000000202') = 'age_work_report'
  and pg_temp.reason('a0000000-0000-4000-8000-000000000203') = 'age_work_report',
  (select string_agg(id::text || ':' || coalesce(pg_temp.reason(id), 'none'), ' ') from public.action_items
   where id in ('a0000000-0000-4000-8000-000000000201', 'a0000000-0000-4000-8000-000000000202', 'a0000000-0000-4000-8000-000000000203')));
select pg_temp.ok('U14 the writer keeps the U+FEFF deadline, the client and the canary as JavaScript does',
  not pg_temp.proposed('a0000000-0000-4000-8000-000000000204')
  and not pg_temp.proposed('a0000000-0000-4000-8000-000000000205')
  and pg_temp.reason('a0000000-0000-4000-8000-000000000206') = 'age_standard'
  and pg_temp.reason('a0000000-0000-4000-8000-000000000207') = 'age_standard'
  and not pg_temp.proposed('a0000000-0000-4000-8000-000000000208'),
  (select string_agg(id::text || ':' || coalesce(pg_temp.reason(id), 'none'), ' ') from public.action_items
   where id::text between 'a0000000-0000-4000-8000-000000000204' and 'a0000000-0000-4000-8000-000000000208'));

-- ---------------------------------------------------------------------------
-- Grants, schedule and the digest's read.
-- ---------------------------------------------------------------------------
select pg_temp.ok('G01 anon and authenticated cannot run or read the job',
  not has_function_privilege('anon', 'public.run_archive_proposals(timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.run_archive_proposals(timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.archive_proposals_due(timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.archive_proposals_last_run()', 'execute')
  and not has_function_privilege('anon', 'public.archive_policy_client_shaped(text)', 'execute')
  and not has_function_privilege('anon', 'public.archive_policy_js_lower(text)', 'execute'));
select pg_temp.ok('G02 service_role can run the job and read the last run',
  has_function_privilege('service_role', 'public.run_archive_proposals(timestamptz)', 'execute')
  and has_function_privilege('service_role', 'public.archive_proposals_last_run()', 'execute'));
select pg_temp.ok('G03 the job is scheduled at 05:30 UTC calling the writer',
  (select schedule = '30 5 * * *' and command = 'select public.run_archive_proposals()'
   from cron.job where jobname = 'action_items_archive_proposals'));
insert into cron.job_run_details (jobid, status, return_message, start_time, end_time)
select jobid, s, m, t, t + interval '1 second' from cron.job,
  (values ('succeeded', '1 row', '2026-11-18 05:30:00+00'::timestamptz),
          ('failed', 'ERROR: deadlock detected', '2026-11-19 05:30:00+00'::timestamptz)) v(s, m, t)
where jobname = 'action_items_archive_proposals';
select pg_temp.ok('G04 the last run is the latest by start time, failures included',
  (select status = 'failed' and return_message = 'ERROR: deadlock detected' from public.archive_proposals_last_run()));

\echo ARCHIVE PROPOSALS SQL TEST PASSED
