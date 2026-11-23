-- Task 3.4 contract for close_agent_task_superseded. Run by supersede-sql-test.sh
-- on a throwaway cluster. Fixtures were seeded BEFORE the migration by the runner,
-- so the prior event CHECK and pre-existing rows are what the migration met.
-- Positive assertions use IS DISTINCT FROM so a missing value fails rather than
-- comparing to null and passing (the Task 2.3 lesson).
\set ON_ERROR_STOP on

create or replace function pg_temp.expect_refusal(p_sql text, p_state text, p_like text, p_label text)
returns void language plpgsql as $$
declare v_state text; v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state is distinct from p_state or v_msg not like p_like then
      raise exception '% refused for the wrong reason: % %', p_label, v_state, v_msg;
    end if;
    raise notice 'PASS %: refused (%)', p_label, v_msg;
    return;
  end;
  raise exception '% was NOT refused', p_label;
end $$;

do $$
declare
  v_row public.agent_tasks;
  v_ev public.agent_task_events;
  v_n int;
  c_needs_op constant uuid := '10000000-0000-4000-8000-000000000001';
  c_input    constant uuid := '10000000-0000-4000-8000-000000000002';
  c_review   constant uuid := '10000000-0000-4000-8000-000000000003';
  c_repl     constant uuid := '10000000-0000-4000-8000-000000000009';
begin
  -- T1: the common case. Needs Operator, claimed_by null, no replacement.
  v_row := public.close_agent_task_superseded(c_needs_op, 'premise is stale', null, 'operator');
  if v_row.status is distinct from 'Agent Done' then raise exception 'T1 status %', v_row.status; end if;
  if v_row.completed_at is null then raise exception 'T1 completed_at not set'; end if;
  if v_row.superseded_at is null then raise exception 'T1 superseded_at not set'; end if;
  if v_row.superseded_reason is distinct from 'premise is stale' then raise exception 'T1 reason %', v_row.superseded_reason; end if;
  if v_row.superseded_actor is distinct from 'operator' then raise exception 'T1 actor %', v_row.superseded_actor; end if;
  if v_row.superseded_by is not null then raise exception 'T1 superseded_by %', v_row.superseded_by; end if;
  if v_row.superseded_closed_generation is distinct from 1 then raise exception 'T1 closed generation %', v_row.superseded_closed_generation; end if;
  select count(*) into v_n from public.agent_task_events where task_id = c_needs_op and event_type = 'TASK SUPERSEDED';
  if v_n <> 1 then raise exception 'T1 event count %', v_n; end if;
  select * into v_ev from public.agent_task_events where task_id = c_needs_op and event_type = 'TASK SUPERSEDED';
  if v_ev.agent_code is not null then raise exception 'T1 agent_code %', v_ev.agent_code; end if;
  if v_ev.payload->>'status' is distinct from 'Agent Done' then raise exception 'T1 payload status'; end if;
  if v_ev.payload->>'from_status' is distinct from 'Needs Operator' then raise exception 'T1 payload from_status'; end if;
  if v_ev.payload->>'resolution' is distinct from 'superseded' then raise exception 'T1 payload resolution'; end if;
  if v_ev.payload->>'reason' is distinct from 'premise is stale' then raise exception 'T1 payload reason'; end if;
  if v_ev.payload->>'actor' is distinct from 'operator' then raise exception 'T1 payload actor'; end if;
  if v_ev.payload->>'actor_source' is distinct from 'mcp-shared-key' then raise exception 'T1 payload actor_source'; end if;
  if not (v_ev.payload ? 'superseded_by') then raise exception 'T1 payload lost the superseded_by key'; end if;
  raise notice 'PASS T1: Needs Operator, null claim, no replacement';

  -- T2: from Agent Review. The claimant lands in agent_code; the claim is cleared.
  v_row := public.close_agent_task_superseded(c_review, 'duplicate of the replacement', c_repl, 'claude-code');
  if v_row.superseded_by is distinct from c_repl then raise exception 'T2 superseded_by %', v_row.superseded_by; end if;
  if v_row.claimed_by is not null then raise exception 'T2 claimed_by not cleared'; end if;
  if v_row.claim_token is not null then raise exception 'T2 claim_token not cleared'; end if;
  if v_row.claim_expires_at is not null then raise exception 'T2 claim_expires_at not cleared'; end if;
  select * into v_ev from public.agent_task_events where task_id = c_review and event_type = 'TASK SUPERSEDED';
  if v_ev.agent_code is distinct from 'claude-code' then raise exception 'T2 agent_code %', v_ev.agent_code; end if;
  if v_ev.payload->>'superseded_by' is distinct from c_repl::text then raise exception 'T2 payload superseded_by'; end if;
  if v_ev.payload->>'from_status' is distinct from 'Agent Review' then raise exception 'T2 payload from_status'; end if;
  raise notice 'PASS T2: Agent Review with claimant and replacement';

  -- T3: from Agent Needs Input. The dated hold clears through the existing trigger.
  v_row := public.close_agent_task_superseded(c_input, 'hold is moot', null, 'operator');
  if v_row.status is distinct from 'Agent Done' then raise exception 'T3 status %', v_row.status; end if;
  if v_row.blocked_reason is not null then raise exception 'T3 blocked_reason not cleared'; end if;
  if v_row.not_before is not null then raise exception 'T3 not_before not cleared'; end if;
  raise notice 'PASS T3: Agent Needs Input';

  -- T4: idempotent second call with equal reason and replacement writes nothing.
  v_row := public.close_agent_task_superseded(c_review, 'duplicate of the replacement', c_repl, 'claude-code');
  select count(*) into v_n from public.agent_task_events where task_id = c_review and event_type = 'TASK SUPERSEDED';
  if v_n <> 1 then raise exception 'T4 wrote a second event (%)', v_n; end if;
  if v_row.superseded_reason is distinct from 'duplicate of the replacement' then raise exception 'T4 row'; end if;
  -- Null replacement compares equal to null, and only to null.
  v_row := public.close_agent_task_superseded(c_needs_op, 'premise is stale', null, 'operator');
  select count(*) into v_n from public.agent_task_events where task_id = c_needs_op and event_type = 'TASK SUPERSEDED';
  if v_n <> 1 then raise exception 'T4 null-replacement retry wrote a second event (%)', v_n; end if;
  raise notice 'PASS T4: idempotent retry writes no second event';
end $$;

-- T5 refusals. Every id below exists, so a refusal is the guard's, not a missing row.
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-000000000004', 'r', null, 'operator')$q$,
  '22023', 'Supersede is legal only%', 'T5a Agent Todo');
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-000000000005', 'r', null, 'operator')$q$,
  '22023', '%was not superseded%', 'T5b ordinary Agent Done, null replacement');
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-000000000006', 'r', '10000000-0000-4000-8000-000000000006', 'operator')$q$,
  '22023', '%cannot supersede itself%', 'T5c self replacement');
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-000000000006', 'r', 'ffffffff-0000-4000-8000-000000000000', 'operator')$q$,
  'P0002', 'Replacement task not found%', 'T5d missing replacement');
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-000000000003', 'a different reason', '10000000-0000-4000-8000-000000000009', 'operator')$q$,
  '22023', '%different reason or replacement%', 'T5e retry with different reason');
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-000000000003', 'duplicate of the replacement', null, 'operator')$q$,
  '22023', '%different reason or replacement%', 'T5f retry with different replacement');
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-000000000006', 'r', null, 'somebody')$q$,
  '22023', 'Actor % is neither%', 'T5g unknown actor');
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-000000000006', 'r', null, '  ')$q$,
  '22023', '%requires an actor%', 'T5h blank actor');
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-000000000006', '  ', null, 'operator')$q$,
  '22023', '%requires a reason%', 'T5i blank reason');
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-000000000007', 'r', null, 'operator')$q$,
  '22023', '%is archived%', 'T5j archived card');
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('ffffffff-0000-4000-8000-000000000001', 'r', null, 'operator')$q$,
  'P0002', 'Task not found%', 'T5k missing card');

do $$
declare
  v_row public.agent_tasks;
  v_n int;
  v_status text;
begin
  -- The guarded refusals changed nothing on the card they looked at.
  select * into v_row from public.agent_tasks where id = '10000000-0000-4000-8000-000000000006';
  if v_row.status is distinct from 'Needs Operator' or v_row.superseded_at is not null then
    raise exception 'T5 mutated the untouched control card: % %', v_row.status, v_row.superseded_at;
  end if;
  select count(*) into v_n from public.agent_task_events where task_id = '10000000-0000-4000-8000-000000000006';
  if v_n <> 0 then raise exception 'T5 wrote % events on the control card', v_n; end if;
  -- Positive control for the ordinary-done refusal: that card stayed Done, unlabelled.
  select * into v_row from public.agent_tasks where id = '10000000-0000-4000-8000-000000000005';
  if v_row.superseded_at is not null then raise exception 'T5b relabelled ordinary Done'; end if;
  raise notice 'PASS T5: refusals wrote nothing';

  -- T6: the linked action item is not touched.
  select status into v_status from public.action_items where id = '20000000-0000-4000-8000-000000000001';
  if v_status is distinct from 'open' then raise exception 'T6 linked item status %', v_status; end if;
  raise notice 'PASS T6: linked action item untouched';

  -- T7: the migrated CHECK as a set: every one of the 18 prior values plus the new one.
  declare
    v_def text;
    v_expected text[] := array['AGENT CLAIMED','AGENT DONE','AGENT BLOCKED','AGENT UNBLOCKED','AGENT HUMAN HOLD','AGENT HUMAN ANSWERED','AGENT RESUMED','AGENT FAILED','AGENT APPLIED','AGENT NEEDS OPERATOR','OPERATOR DONE','AGENT CRITIC','AGENT SKILL SUBSCRIBED','AGENT SKILL INSTALLED','AGENT SKILL UPDATED','AGENT SKILL DECLINED','AGENT FOLLOW-UP','AGENT STATUS','TASK SUPERSEDED'];
    v_got text[];
  begin
    select pg_get_constraintdef(oid) into v_def from pg_constraint where conname = 'agent_task_events_event_type_check';
    select array_agg(m[1] order by m[1]) into v_got from regexp_matches(v_def, $r$'([A-Z][A-Z -]+)'::text$r$, 'g') as m;
    if v_got is distinct from (select array_agg(x order by x) from unnest(v_expected) x) then
      raise exception 'T7 constraint set differs: %', v_got;
    end if;
    if array_length(v_got, 1) <> 19 then raise exception 'T7 count %', array_length(v_got, 1); end if;
  end;
  -- The historical row the migration met still validates, and an unknown type is refused.
  select count(*) into v_n from public.agent_task_events where event_type = 'AGENT NEEDS OPERATOR';
  if v_n <> 1 then raise exception 'T7 prior-value fixture missing (%)', v_n; end if;
  raise notice 'PASS T7: event CHECK is the prior 18 plus TASK SUPERSEDED';

  -- T8: fields travel together.
  begin
    update public.agent_tasks set superseded_reason = 'half set' where id = '10000000-0000-4000-8000-000000000006';
    raise exception 'T8 half-set superseded fields accepted';
  exception when check_violation then
    raise notice 'PASS T8: half-set superseded fields refused';
  end;
end $$;

-- T10: a Done card carrying the columns is not "already done": the closed generation
-- says the verb closed it, and that generation's event has to exist.
update public.agent_tasks
set superseded_at = now(), completed_at = now(), superseded_reason = 'columns only', superseded_actor = 'operator'
where id = '10000000-0000-4000-8000-000000000005';
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-000000000005', 'columns only', null, 'operator')$q$,
  '22023', '%was not superseded%', 'T10a superseded columns without a closed generation');
update public.agent_tasks set superseded_closed_generation = 1 where id = '10000000-0000-4000-8000-000000000005';
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-000000000005', 'columns only', null, 'operator')$q$,
  '22023', '%events end at generation 0%', 'T10b a closed generation with no event');

-- T11: generations. Each statement is its own transaction, as in production, so
-- now() advances between them. The reopen is the real admin_amend_agent_task.
create or replace function pg_temp.admin_reopen(p_id uuid) returns void language sql as $f$
  select public.admin_amend_agent_task(p_id, 'test reopen', p_move_to_needs_operator => true, p_set_operator_action => 'verify');
$f$;
do $$
declare
  v_row public.agent_tasks;
  v_n int;
  c constant uuid := '10000000-0000-4000-8000-00000000000a';
begin
  v_row := public.close_agent_task_superseded(c, 'first', null, 'operator', 1);
  if (select payload->>'generation' from public.agent_task_events where task_id = c and event_type = 'TASK SUPERSEDED') is distinct from '1' then
    raise exception 'T11 payload generation for the first close';
  end if;
  -- A replay naming the generation that is closed writes nothing.
  v_row := public.close_agent_task_superseded(c, 'first', null, 'operator', 1);
  select count(*) into v_n from public.agent_task_events where task_id = c and event_type = 'TASK SUPERSEDED';
  if v_n <> 1 then raise exception 'T11 replay wrote an event (%)', v_n; end if;
  -- A replay with no generation at all is read-only too, on a closed card.
  v_row := public.close_agent_task_superseded(c, 'first', null, 'operator');
  select count(*) into v_n from public.agent_task_events where task_id = c and event_type = 'TASK SUPERSEDED';
  if v_n <> 1 then raise exception 'T11 bare replay wrote an event (%)', v_n; end if;
  raise notice 'PASS T11a: expected_generation 1 closes, and replays without a write';
end $$;
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-00000000000a', 'first', null, 'operator', 2)$q$,
  '22023', '%is closed at supersede generation 1%', 'T11b replay naming a generation that is not closed');

select pg_temp.admin_reopen('10000000-0000-4000-8000-00000000000a');
do $$
begin
  if (select superseded_closed_generation from public.agent_tasks where id = '10000000-0000-4000-8000-00000000000a') is not null then
    raise exception 'T11 the real admin reopen left the closed generation set';
  end if;
  if (select superseded_reason from public.agent_tasks where id = '10000000-0000-4000-8000-00000000000a') is distinct from 'first' then
    raise exception 'T11 the reopen must keep the superseded_* columns';
  end if;
end $$;
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-00000000000a', 'first', null, 'operator')$q$,
  '22023', '%requires the expected generation%', 'T11c reopened card with no generation, the bare call');
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-00000000000a', 'first', null, 'operator', 1)$q$,
  '22023', '%next generation is 2%', 'T11d reopened card with the old authorization');
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-00000000000a', 'first', null, 'operator', 3)$q$,
  '22023', '%next generation is 2%', 'T11e reopened card with a future generation');
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-00000000000b', 'r', null, 'operator', 2)$q$,
  '22023', '%next generation is 1%', 'T11f first close naming generation 2');
do $$
declare
  v_row public.agent_tasks;
  v_first timestamptz;
  v_n int;
  c constant uuid := '10000000-0000-4000-8000-00000000000a';
begin
  if (select count(*) from public.agent_task_events where task_id = c and event_type = 'TASK SUPERSEDED') <> 1 then
    raise exception 'T11 refusals wrote an event';
  end if;
  if (select status from public.agent_tasks where id = c) is distinct from 'Needs Operator' then
    raise exception 'T11 refusals moved the reopened card';
  end if;
  if (select status from public.agent_tasks where id = '10000000-0000-4000-8000-00000000000b') is distinct from 'Needs Operator' then
    raise exception 'T11f moved the first-close control card';
  end if;
  select superseded_at into v_first from public.agent_tasks where id = c;
  v_row := public.close_agent_task_superseded(c, 'second, with a new reason', null, 'operator', 2);
  if v_row.status is distinct from 'Agent Done' then raise exception 'T11g status %', v_row.status; end if;
  if v_row.superseded_reason is distinct from 'second, with a new reason' then raise exception 'T11g reason %', v_row.superseded_reason; end if;
  if v_row.superseded_at is not distinct from v_first then raise exception 'T11g superseded_at did not advance'; end if;
  if v_row.superseded_closed_generation is distinct from 2 then raise exception 'T11g closed generation %', v_row.superseded_closed_generation; end if;
  select count(*) into v_n from public.agent_task_events where task_id = c and event_type = 'TASK SUPERSEDED';
  if v_n <> 2 then raise exception 'T11g event count %', v_n; end if;
  if not exists (select 1 from public.agent_task_events where task_id = c and event_type = 'TASK SUPERSEDED' and payload->>'generation' = '2' and payload->>'reason' = 'second, with a new reason') then
    raise exception 'T11g second event payload';
  end if;
  if not exists (select 1 from public.agent_task_events where task_id = c and event_type = 'TASK SUPERSEDED' and payload->>'generation' = '1' and payload->>'reason' = 'first') then
    raise exception 'T11g first event was rewritten';
  end if;
  raise notice 'PASS T11g: a reopened card closes as generation 2 and keeps generation 1';
end $$;

-- T12: superseded, reopened, then finished normally, in separate transactions, by the
-- real writers. The columns and the event are still there with the same arguments;
-- only the cleared closed generation shows the verb did not close it.
select public.close_agent_task_superseded('10000000-0000-4000-8000-00000000000c', 'stale premise', null, 'operator');
select pg_temp.admin_reopen('10000000-0000-4000-8000-00000000000c');
select public.complete_operator_action('10000000-0000-4000-8000-00000000000c', 'operator', 'finished normally');
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-00000000000c', 'stale premise', null, 'operator')$q$,
  '22023', '%was not superseded%', 'T12 reopened and finished normally');

-- T13: the same lifecycle inside ONE transaction, where now() is one value and
-- completed_at = superseded_at holds after the ordinary completion. Reproduced from
-- the PR 19 re-review with the real functions. The closed generation must still tell.
begin;
select public.close_agent_task_superseded('10000000-0000-4000-8000-00000000000d', 'same transaction', null, 'operator', 1);
select pg_temp.admin_reopen('10000000-0000-4000-8000-00000000000d');
select public.complete_operator_action('10000000-0000-4000-8000-00000000000d', 'operator', 'finished normally');
do $$
begin
  if (select completed_at is distinct from superseded_at from public.agent_tasks where id = '10000000-0000-4000-8000-00000000000d') then
    raise exception 'T13 fixture: the timestamps must match, or this is not the defect';
  end if;
  if (select superseded_closed_generation from public.agent_tasks where id = '10000000-0000-4000-8000-00000000000d') is not null then
    raise exception 'T13 an ordinary completion reads as closed by the verb';
  end if;
end $$;
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-00000000000d', 'same transaction', null, 'operator', 1)$q$,
  '22023', '%was not superseded%', 'T13 same-transaction ordinary completion, naming generation 1');
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-00000000000d', 'same transaction', null, 'operator')$q$,
  '22023', '%was not superseded%', 'T13 same-transaction ordinary completion, bare');
commit;

-- T14: three generations in one transaction: every created_at ties, every number is
-- right, the closed generation is the last, and a replay answers from it.
begin;
select public.close_agent_task_superseded('10000000-0000-4000-8000-00000000000e', 'one', null, 'operator', 1);
select pg_temp.admin_reopen('10000000-0000-4000-8000-00000000000e');
select public.close_agent_task_superseded('10000000-0000-4000-8000-00000000000e', 'two', null, 'operator', 2);
select pg_temp.admin_reopen('10000000-0000-4000-8000-00000000000e');
select public.close_agent_task_superseded('10000000-0000-4000-8000-00000000000e', 'three', null, 'operator', 3);
select public.close_agent_task_superseded('10000000-0000-4000-8000-00000000000e', 'three', null, 'operator', 3);
commit;
do $$
declare
  c constant uuid := '10000000-0000-4000-8000-00000000000e';
begin
  if (select count(distinct created_at) from public.agent_task_events where task_id = c and event_type = 'TASK SUPERSEDED') <> 1 then
    raise exception 'T14 fixture: the timestamps must tie';
  end if;
  if (select array_agg(payload->>'generation' order by payload->>'generation') from public.agent_task_events where task_id = c and event_type = 'TASK SUPERSEDED') is distinct from array['1','2','3'] then
    raise exception 'T14 generations are not 1, 2, 3';
  end if;
  if (select superseded_closed_generation from public.agent_tasks where id = c) is distinct from 3 then
    raise exception 'T14 closed generation';
  end if;
  raise notice 'PASS T14: tied timestamps keep distinct generations';
end $$;

-- T15: the clear-on-exit reaches every writer, and the invariant is enforced.
do $$
declare
  c constant uuid := '10000000-0000-4000-8000-00000000000f';
  v_row public.agent_tasks;
begin
  v_row := public.close_agent_task_superseded(c, 'raw', null, 'operator');
  update public.agent_tasks set status = 'Agent Todo' where id = c;
  if (select superseded_closed_generation from public.agent_tasks where id = c) is not null then
    raise exception 'T15 a raw status UPDATE left the closed generation set';
  end if;
  begin
    update public.agent_tasks set superseded_closed_generation = 1 where id = c;
    raise exception 'T15 a closed generation was accepted on an open card';
  exception when check_violation then
    raise notice 'PASS T15a: a closed generation needs Agent Done';
  end;
  begin
    update public.agent_tasks set status = 'Agent Done', superseded_closed_generation = 0 where id = c;
    raise exception 'T15 generation 0 was accepted';
  exception when check_violation then
    raise notice 'PASS T15b: a closed generation is positive';
  end;
  begin
    update public.agent_tasks set status = 'Agent Done', superseded_closed_generation = 1 where id = '10000000-0000-4000-8000-000000000006';
    raise exception 'T15 a closed generation was accepted with no superseded_at';
  exception when check_violation then
    raise notice 'PASS T15c: a closed generation needs the supersede columns';
  end;
  raise notice 'PASS T15: the clear reaches a raw UPDATE';
end $$;

-- T16: a history a raw writer has broken is refused rather than extended. Each row
-- is inserted directly because the verb cannot produce it; that is the point.
insert into public.agent_task_events (task_id, event_type, payload) values
  ('10000000-0000-4000-8000-000000000010', 'TASK SUPERSEDED', '{"reason":"no generation"}'),
  ('10000000-0000-4000-8000-000000000011', 'TASK SUPERSEDED', '{"generation":"1"}'),
  ('10000000-0000-4000-8000-000000000012', 'TASK SUPERSEDED', '{"generation":1}'),
  ('10000000-0000-4000-8000-000000000012', 'TASK SUPERSEDED', '{"generation":1}'),
  ('10000000-0000-4000-8000-000000000013', 'TASK SUPERSEDED', '{"generation":1}'),
  ('10000000-0000-4000-8000-000000000013', 'TASK SUPERSEDED', '{"generation":3}');
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-000000000010', 'r', null, 'operator', 2)$q$,
  '22023', '%not exactly 1 to 1%', 'T16a missing generation');
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-000000000011', 'r', null, 'operator', 2)$q$,
  '22023', '%not exactly 1 to 1%', 'T16b string generation');
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-000000000012', 'r', null, 'operator', 3)$q$,
  '22023', '%not exactly 1 to 2%', 'T16c duplicate generation');
select pg_temp.expect_refusal(
  $q$select public.close_agent_task_superseded('10000000-0000-4000-8000-000000000013', 'r', null, 'operator', 3)$q$,
  '22023', '%not exactly 1 to 2%', 'T16d gap');

-- T9: grants. service_role may execute; nobody else may. Read from the catalog
-- with a positive control so an empty answer cannot pass.
do $$
begin
  if not has_function_privilege('service_role', 'public.close_agent_task_superseded(uuid,text,uuid,text,integer)', 'execute') then
    raise exception 'T9 service_role cannot execute';
  end if;
  if has_function_privilege('anon', 'public.close_agent_task_superseded(uuid,text,uuid,text,integer)', 'execute') then
    raise exception 'T9 anon can execute';
  end if;
  if has_function_privilege('authenticated', 'public.close_agent_task_superseded(uuid,text,uuid,text,integer)', 'execute') then
    raise exception 'T9 authenticated can execute';
  end if;
  if (select prosecdef from pg_proc where proname = 'close_agent_task_superseded') is distinct from true then
    raise exception 'T9 not security definer';
  end if;
  raise notice 'PASS T9: grants';
end $$;

select 'SUPERSEDE SQL TEST PASSED' as result;
