-- Loop-closing Task 2.3: behavioural contract for agent_tasks.not_before.
-- Run by scripts/loop-closing/not-before-sql-test.sh on a throwaway cluster
-- after 20261105_agent_tasks_not_before.sql is applied. Every block raises a
-- NOTICE on pass and an exception on failure (ON_ERROR_STOP aborts the file).
--
-- Positive assertions on nullable values (row columns, payload fields) use
-- IS DISTINCT FROM, never <>: in PL/pgSQL `null <> x` is null, so an `if`
-- on it silently skips the raise and a missing date reads as proof of one.
-- Codex PR 18 review, 2026-11-05: four storage/audit mutations passed T1-T12
-- under <>. The runner's move_store/move_audit/admin_store/admin_audit
-- mutations keep that from coming back. Count comparisons (v_n, v_state) are
-- on non-null locals and keep <>.

insert into public.agent_task_ledger (agent_code) values ('codex'), ('claude-code');

create or replace function pg_temp.mk_task(p_status text, p_claimed_by text default null, p_token uuid default null)
returns uuid language sql as $$
  insert into public.agent_tasks (title, desired_outcome, status, claimed_by, claimed_at, claim_token, claim_expires_at, agent_code)
  values ('fixture ' || p_status, 'fixture', p_status, p_claimed_by,
          case when p_claimed_by is null then null else now() end, p_token,
          case when p_claimed_by is null then null else now() + interval '60 minutes' end, p_claimed_by)
  returning id
$$;

-- T1: hold with a date sets the column and the hold event carries it.
do $$
declare v_id uuid; v_tok uuid := gen_random_uuid(); v_row public.agent_tasks; v_ev jsonb; v_n int;
begin
  v_id := pg_temp.mk_task('Agent Working', 'codex', v_tok);
  v_row := public.move_agent_task_status(v_id, 'Agent Needs Input', 'AGENT HUMAN HOLD', 'codex', 'NOT_YET_DUE until 2026-12-01', v_tok, '2026-12-01T00:00:00Z');
  if v_row.status is distinct from 'Agent Needs Input' then raise exception 'T1 status % expected Agent Needs Input', v_row.status; end if;
  if v_row.not_before is distinct from '2026-12-01T00:00:00Z'::timestamptz then raise exception 'T1 not_before % expected 2026-12-01', v_row.not_before; end if;
  select count(*) into v_n from public.agent_task_events where task_id = v_id;
  select payload into v_ev from public.agent_task_events where task_id = v_id;
  if v_n <> 1 then raise exception 'T1 expected exactly one event, got %', v_n; end if;
  if (v_ev->>'not_before')::timestamptz is distinct from '2026-12-01T00:00:00Z'::timestamptz then raise exception 'T1 event payload lacks not_before: %', v_ev; end if;
  if v_ev->>'status' is distinct from 'Agent Needs Input' then raise exception 'T1 event status %', v_ev->>'status'; end if;
  raise notice 'PASS T1: hold with p_not_before stores the date and the AGENT HUMAN HOLD event carries it';
end $$;

-- T2: hold without a date leaves the column null and the payload without the key.
do $$
declare v_id uuid; v_tok uuid := gen_random_uuid(); v_row public.agent_tasks; v_ev jsonb;
begin
  v_id := pg_temp.mk_task('Agent Working', 'codex', v_tok);
  v_row := public.move_agent_task_status(v_id, 'Agent Needs Input', 'AGENT HUMAN HOLD', 'codex', 'held, no date', v_tok);
  if v_row.not_before is not null then raise exception 'T2 not_before should be null, got %', v_row.not_before; end if;
  select payload into v_ev from public.agent_task_events where task_id = v_id;
  if v_ev ? 'not_before' then raise exception 'T2 payload must not carry a null not_before: %', v_ev; end if;
  raise notice 'PASS T2: hold without p_not_before stores null and the payload omits the key';
end $$;

-- T3: a date on any non-hold transition is refused, writes nothing.
do $$
declare v_id uuid; v_tok uuid := gen_random_uuid(); v_msg text := ''; v_row public.agent_tasks; v_n int;
begin
  v_id := pg_temp.mk_task('Agent Working', 'codex', v_tok);
  begin
    perform public.move_agent_task_status(v_id, 'Agent Review', 'AGENT DONE', 'codex', 'done', v_tok, '2026-12-01T00:00:00Z');
  exception when others then v_msg := sqlerrm; end;
  if v_msg not like '%only meaningful on an Agent Needs Input hold%' then raise exception 'T3 expected the hold-only refusal, got: %', v_msg; end if;
  select * into v_row from public.agent_tasks where id = v_id;
  if v_row.status is distinct from 'Agent Working' or v_row.not_before is not null then raise exception 'T3 row changed: % %', v_row.status, v_row.not_before; end if;
  select count(*) into v_n from public.agent_task_events where task_id = v_id;
  if v_n <> 0 then raise exception 'T3 wrote % event(s) on a refused call', v_n; end if;
  raise notice 'PASS T3: p_not_before on a non-hold transition is refused and writes nothing';
end $$;

-- T4: admin_amend sets the date on a card already held: status unchanged, exactly
-- one AGENT STATUS event carrying set_not_before; a second call overwrites.
do $$
declare v_id uuid; v_tok uuid := gen_random_uuid(); v_row public.agent_tasks; v_n int; v_ev record;
begin
  v_id := pg_temp.mk_task('Agent Working', 'codex', v_tok);
  perform public.move_agent_task_status(v_id, 'Agent Needs Input', 'AGENT HUMAN HOLD', 'codex', 'held, date to be confirmed by the operator', v_tok);
  v_row := public.admin_amend_agent_task(v_id, 'the operator confirmed the not-before date from the hold note', 'the operator via Session 427',
             null, null, null, null, null, false, false, null, false, '2026-10-01T00:00:00Z');
  if v_row.status is distinct from 'Agent Needs Input' then raise exception 'T4 status changed to %', v_row.status; end if;
  if v_row.not_before is distinct from '2026-10-01T00:00:00Z'::timestamptz then raise exception 'T4 not_before % expected 2026-10-01', v_row.not_before; end if;
  if v_row.claimed_by is distinct from 'codex' or v_row.claim_token is distinct from v_tok then raise exception 'T4 claim disturbed'; end if;
  select count(*) into v_n from public.agent_task_events where task_id = v_id and event_type = 'AGENT STATUS';
  if v_n <> 1 then raise exception 'T4 expected exactly one AGENT STATUS event, got %', v_n; end if;
  select payload into v_ev from public.agent_task_events where task_id = v_id and event_type = 'AGENT STATUS';
  if (v_ev.payload->>'set_not_before')::timestamptz is distinct from '2026-10-01T00:00:00Z'::timestamptz then raise exception 'T4 event lacks set_not_before: %', v_ev.payload; end if;
  if v_ev.payload->>'status' is distinct from 'Agent Needs Input' or v_ev.payload->>'from_status' is distinct from 'Agent Needs Input' then raise exception 'T4 event status fields wrong: %', v_ev.payload; end if;
  if v_ev.payload->>'action' is distinct from 'ops-amend' then raise exception 'T4 event action: %', v_ev.payload; end if;
  v_row := public.admin_amend_agent_task(v_id, 'corrected date', 'the operator', null, null, null, null, null, false, false, null, false, '2026-10-08T00:00:00Z');
  if v_row.not_before is distinct from '2026-10-08T00:00:00Z'::timestamptz then raise exception 'T4 overwrite failed: %', v_row.not_before; end if;
  select count(*) into v_n from public.agent_task_events where task_id = v_id and event_type = 'AGENT STATUS';
  if v_n <> 2 then raise exception 'T4 expected two AGENT STATUS events after the overwrite, got %', v_n; end if;
  raise notice 'PASS T4: admin_amend p_set_not_before on a held card keeps status, writes one dated AGENT STATUS event, overwrites on a second call';
end $$;

-- T5: admin_amend p_set_not_before on a card that is not held is refused.
do $$
declare v_todo uuid; v_desk uuid; v_msg text; v_n int; v_row public.agent_tasks;
begin
  v_todo := pg_temp.mk_task('Agent Todo');
  v_desk := pg_temp.mk_task('Needs Operator');
  v_msg := '';
  begin
    perform public.admin_amend_agent_task(v_todo, 'try', 'the operator', null, null, null, null, null, false, false, null, false, '2026-10-01T00:00:00Z');
  exception when others then v_msg := sqlerrm; end;
  if v_msg not like '%can only set not_before on an Agent Needs Input card%' then raise exception 'T5 Agent Todo: expected refusal, got: %', v_msg; end if;
  v_msg := '';
  begin
    perform public.admin_amend_agent_task(v_desk, 'try', 'the operator', null, null, null, null, null, false, false, null, false, '2026-10-01T00:00:00Z');
  exception when others then v_msg := sqlerrm; end;
  if v_msg not like '%can only set not_before on an Agent Needs Input card%' then raise exception 'T5 Needs Operator: expected refusal, got: %', v_msg; end if;
  select count(*) into v_n from public.agent_task_events where task_id in (v_todo, v_desk);
  if v_n <> 0 then raise exception 'T5 wrote % event(s) on refused calls', v_n; end if;
  select * into v_row from public.agent_tasks where id = v_todo;
  if v_row.not_before is not null or v_row.status is distinct from 'Agent Todo' then raise exception 'T5 row changed'; end if;
  raise notice 'PASS T5: admin_amend p_set_not_before is refused on Agent Todo and Needs Operator cards, nothing written';
end $$;

-- T6: setting a date in the same call that moves the card off the hold is refused.
do $$
declare v_id uuid; v_tok uuid := gen_random_uuid(); v_msg text; v_n int; v_row public.agent_tasks;
begin
  v_id := pg_temp.mk_task('Agent Working', 'codex', v_tok);
  perform public.move_agent_task_status(v_id, 'Agent Needs Input', 'AGENT HUMAN HOLD', 'codex', 'held', v_tok);
  select count(*) into v_n from public.agent_task_events where task_id = v_id;
  v_msg := '';
  begin
    perform public.admin_amend_agent_task(v_id, 'release and date', 'the operator', null, null, null, null, null, false, true, null, false, '2026-10-01T00:00:00Z');
  exception when others then v_msg := sqlerrm; end;
  if v_msg not like '%same call that moves it off Agent Needs Input%' then raise exception 'T6 release_claim: expected refusal, got: %', v_msg; end if;
  v_msg := '';
  begin
    perform public.admin_amend_agent_task(v_id, 'desk and date', 'the operator', null, null, 'read the report', null, null, true, false, null, false, '2026-10-01T00:00:00Z');
  exception when others then v_msg := sqlerrm; end;
  if v_msg not like '%same call that moves it off Agent Needs Input%' then raise exception 'T6 move_to_needs_operator: expected refusal, got: %', v_msg; end if;
  select * into v_row from public.agent_tasks where id = v_id;
  if v_row.status is distinct from 'Agent Needs Input' or v_row.not_before is not null or v_row.claim_token is distinct from v_tok then raise exception 'T6 row changed'; end if;
  if (select count(*) from public.agent_task_events where task_id = v_id) <> v_n then raise exception 'T6 wrote events on refused calls'; end if;
  raise notice 'PASS T6: p_set_not_before combined with release_claim or move_to_needs_operator is refused, nothing written';
end $$;

-- T7: release (fold to Agent Todo) clears the date.
do $$
declare v_id uuid; v_tok uuid := gen_random_uuid(); v_row public.agent_tasks;
begin
  v_id := pg_temp.mk_task('Agent Working', 'codex', v_tok);
  perform public.move_agent_task_status(v_id, 'Agent Needs Input', 'AGENT HUMAN HOLD', 'codex', 'held', v_tok, '2026-10-01T00:00:00Z');
  v_row := public.admin_amend_agent_task(v_id, 'release the dead claim', 'the operator', null, null, null, null, null, false, true, null, false);
  if v_row.status is distinct from 'Agent Todo' then raise exception 'T7 status % expected Agent Todo', v_row.status; end if;
  if v_row.not_before is not null then raise exception 'T7 not_before survived the release: %', v_row.not_before; end if;
  raise notice 'PASS T7: release_claim fold to Agent Todo clears not_before';
end $$;

-- T8: resume back to Agent Working clears the date.
do $$
declare v_id uuid; v_tok uuid := gen_random_uuid(); v_row public.agent_tasks;
begin
  v_id := pg_temp.mk_task('Agent Working', 'codex', v_tok);
  perform public.move_agent_task_status(v_id, 'Agent Needs Input', 'AGENT HUMAN HOLD', 'codex', 'held', v_tok, '2026-10-01T00:00:00Z');
  v_row := public.move_agent_task_status(v_id, 'Agent Working', 'AGENT RESUMED', 'codex', 'due now', null);
  if v_row.status is distinct from 'Agent Working' then raise exception 'T8 status %', v_row.status; end if;
  if v_row.not_before is not null then raise exception 'T8 not_before survived the resume: %', v_row.not_before; end if;
  raise notice 'PASS T8: AGENT RESUMED to Agent Working clears not_before';
end $$;

-- T9: desk move and follow-up (the other exits from a hold) clear the date.
do $$
declare v_a uuid; v_b uuid; v_tok uuid; v_row public.agent_tasks;
begin
  v_tok := gen_random_uuid();
  v_a := pg_temp.mk_task('Agent Working', 'codex', v_tok);
  perform public.move_agent_task_status(v_a, 'Agent Needs Input', 'AGENT HUMAN HOLD', 'codex', 'held', v_tok, '2026-10-01T00:00:00Z');
  v_row := public.admin_amend_agent_task(v_a, 'work happened out of band', 'the operator', null, null, 'read the report', null, null, true, false, null, false);
  if v_row.status is distinct from 'Needs Operator' or v_row.not_before is not null then raise exception 'T9 desk move: % %', v_row.status, v_row.not_before; end if;
  v_tok := gen_random_uuid();
  v_b := pg_temp.mk_task('Agent Working', 'codex', v_tok);
  perform public.move_agent_task_status(v_b, 'Agent Needs Input', 'AGENT HUMAN HOLD', 'codex', 'held', v_tok, '2026-10-01T00:00:00Z');
  v_row := public.move_agent_task_status(v_b, 'Agent Todo', 'AGENT FOLLOW-UP', 'codex', 'follow-up', null);
  if v_row.status is distinct from 'Agent Todo' or v_row.not_before is not null then raise exception 'T9 follow-up: % %', v_row.status, v_row.not_before; end if;
  raise notice 'PASS T9: desk move to Needs Operator and AGENT FOLLOW-UP to Agent Todo both clear not_before';
end $$;

-- T10: the trigger and CHECK hold on raw SQL too (the reaper, service-role fixes).
do $$
declare v_id uuid; v_other uuid; v_row public.agent_tasks; v_state text;
begin
  v_id := pg_temp.mk_task('Agent Needs Input');
  update public.agent_tasks set not_before = '2026-10-01T00:00:00Z' where id = v_id;
  update public.agent_tasks set status = 'Agent Todo' where id = v_id;
  select * into v_row from public.agent_tasks where id = v_id;
  if v_row.not_before is not null then raise exception 'T10 raw status write left not_before: %', v_row.not_before; end if;
  v_other := pg_temp.mk_task('Agent Todo');
  v_state := '';
  begin
    update public.agent_tasks set not_before = now() where id = v_other;
  exception when others then v_state := sqlstate; end;
  if v_state <> '23514' then raise exception 'T10 expected CHECK violation (23514) on a dated Agent Todo row, got "%"', v_state; end if;
  v_state := '';
  begin
    insert into public.agent_tasks (title, desired_outcome, status, not_before) values ('x', 'x', 'Needs Operator', now());
  exception when others then v_state := sqlstate; end;
  if v_state <> '23514' then raise exception 'T10 expected CHECK violation (23514) on insert, got "%"', v_state; end if;
  raise notice 'PASS T10: raw SQL exit from the hold clears the date; a date on any other status is refused by the CHECK';
end $$;

-- T11: a same-status heartbeat on the held card keeps the date unless a new one is given.
do $$
declare v_id uuid; v_tok uuid := gen_random_uuid(); v_row public.agent_tasks;
begin
  v_id := pg_temp.mk_task('Agent Working', 'codex', v_tok);
  perform public.move_agent_task_status(v_id, 'Agent Needs Input', 'AGENT HUMAN HOLD', 'codex', 'held', v_tok, '2026-10-01T00:00:00Z');
  v_row := public.move_agent_task_status(v_id, 'Agent Needs Input', 'AGENT STATUS', 'codex', 'still held', v_tok);
  if v_row.not_before is distinct from '2026-10-01T00:00:00Z'::timestamptz then raise exception 'T11 heartbeat without a date changed it: %', v_row.not_before; end if;
  v_row := public.move_agent_task_status(v_id, 'Agent Needs Input', 'AGENT STATUS', 'codex', 'pushed out', v_tok, '2026-10-15T00:00:00Z');
  if v_row.not_before is distinct from '2026-10-15T00:00:00Z'::timestamptz then raise exception 'T11 heartbeat with a date did not update it: %', v_row.not_before; end if;
  raise notice 'PASS T11: same-status AGENT STATUS keeps the date when none is given and updates it when one is';
end $$;

-- T12: the sentinel role can read the new column (its CARD_FIELDS read adds it).
do $$
begin
  if not has_column_privilege('sentinel_reader', 'public.agent_tasks', 'not_before', 'SELECT') then
    raise exception 'T12 sentinel_reader cannot select not_before';
  end if;
  if has_column_privilege('sentinel_reader', 'public.agent_tasks', 'blocked_reason', 'SELECT') then
    raise exception 'T12 sentinel_reader grant widened beyond not_before';
  end if;
  raise notice 'PASS T12: sentinel_reader may select not_before and nothing else new';
end $$;

-- T13: held to TERMINAL clears the date (the plan's "on release and on terminal").
-- No RPC moves Agent Needs Input straight to Agent Done or Agent Review (AGENT
-- APPLIED requires Agent Review, AGENT DONE requires Agent Working), so the
-- direct held-to-terminal write is raw SQL: the reaper, a service-role repair,
-- or an ops fix. The trigger is the only thing standing between that write and a
-- terminal card that still carries a date, which the CHECK would then refuse.
do $$
declare v_done uuid; v_rev uuid; v_tok uuid := gen_random_uuid(); v_row public.agent_tasks;
begin
  v_done := pg_temp.mk_task('Agent Working', 'codex', v_tok);
  perform public.move_agent_task_status(v_done, 'Agent Needs Input', 'AGENT HUMAN HOLD', 'codex', 'held', v_tok, '2026-10-01T00:00:00Z');
  select * into v_row from public.agent_tasks where id = v_done;
  if v_row.not_before is distinct from '2026-10-01T00:00:00Z'::timestamptz then raise exception 'T13 precondition: hold did not store the date: %', v_row.not_before; end if;
  update public.agent_tasks set status = 'Agent Done', completed_at = now(), claimed_by = null, claim_token = null, claim_expires_at = null where id = v_done;
  select * into v_row from public.agent_tasks where id = v_done;
  if v_row.status is distinct from 'Agent Done' then raise exception 'T13 status % expected Agent Done', v_row.status; end if;
  if v_row.not_before is not null then raise exception 'T13 not_before survived the terminal exit: %', v_row.not_before; end if;
  v_tok := gen_random_uuid();
  v_rev := pg_temp.mk_task('Agent Working', 'codex', v_tok);
  perform public.move_agent_task_status(v_rev, 'Agent Needs Input', 'AGENT HUMAN HOLD', 'codex', 'held', v_tok, '2026-10-01T00:00:00Z');
  update public.agent_tasks set status = 'Agent Review' where id = v_rev;
  select * into v_row from public.agent_tasks where id = v_rev;
  if v_row.status is distinct from 'Agent Review' or v_row.not_before is not null then raise exception 'T13 review exit: % %', v_row.status, v_row.not_before; end if;
  raise notice 'PASS T13: raw held-to-terminal (Agent Done) and held-to-Agent Review exits both clear not_before';
end $$;

select 'NOT-BEFORE SQL TEST PASSED' as result;
