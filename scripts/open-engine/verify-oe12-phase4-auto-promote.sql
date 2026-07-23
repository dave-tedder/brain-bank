-- OE-12 Phase 4 auto-promote — verification suite.
--
-- Run this AFTER 20260715_oe_phase4_auto_promote.sql is applied, as ONE
-- statement (the whole DO block). Everything happens inside a single implicit
-- transaction and the final RAISE 'PROBE_SUITE_PASS' rolls it ALL back: no
-- scratch rows persist, no daily-cap slot is consumed, the ledger is untouched.
--   * Success  -> the statement ends with SQLSTATE P0001, message
--                 'PROBE_SUITE_PASS: 8 refusals + happy path + watch-clean'.
--   * Any failure -> it ends with the specific assertion message instead.
-- Time it between lanes, with zero Agent Working tasks on the board.
--
-- NOTE: agent_tasks has a partial unique index on linked_action_item_id for
-- active tasks (the has_active_draft backstop), so every compliant scratch
-- draft gets its OWN action_item.

do $$
declare
  v_ai      uuid;
  v_task    uuid;
  v_res     public.agent_tasks;
  v_evt     int;
  v_dt_evt  int;
  v_author  text;
  v_caught  boolean;
  v_msg     text;
begin
  -- ============================================================= REFUSALS ==
  -- Each: seed a fresh action item + a compliant draft, mutate ONE field, and
  -- assert the call raises with the matching condition tag.

  -- Probe 1 — A: risk='medium'.
  insert into public.action_items (description) values ('SMOKE p1') returning id into v_ai;
  insert into public.agent_tasks
    (title, desired_outcome, acceptance_criteria, boundaries, risk,
     explicit_approval, status, intake_source, linked_action_item_id, requires_local)
  values ('SMOKE p1','o','c','b','medium',false,'Standing','triage-agent',v_ai,false)
  returning id into v_task;
  v_caught := false;
  begin v_res := public.auto_promote_agent_task_intake(v_task,'triage',1,'r');
  exception when others then v_caught := true; v_msg := sqlerrm; end;
  if not v_caught then raise exception 'PROBE 1 (A risk) should have refused'; end if;
  if position('(A risk)' in v_msg) = 0 then raise exception 'PROBE 1 wrong reason: %', v_msg; end if;

  -- Probe 2 — B: explicit_approval=true.
  insert into public.action_items (description) values ('SMOKE p2') returning id into v_ai;
  insert into public.agent_tasks
    (title, desired_outcome, acceptance_criteria, boundaries, risk,
     explicit_approval, status, intake_source, linked_action_item_id, requires_local)
  values ('SMOKE p2','o','c','b','low',true,'Standing','triage-agent',v_ai,false)
  returning id into v_task;
  v_caught := false;
  begin v_res := public.auto_promote_agent_task_intake(v_task,'triage',1,'r');
  exception when others then v_caught := true; v_msg := sqlerrm; end;
  if not v_caught then raise exception 'PROBE 2 (B explicit_approval) should have refused'; end if;
  if position('(B explicit_approval)' in v_msg) = 0 then raise exception 'PROBE 2 wrong reason: %', v_msg; end if;

  -- Probe 3 — E: linked_action_item_id IS NULL (no action item seeded).
  insert into public.agent_tasks
    (title, desired_outcome, acceptance_criteria, boundaries, risk,
     explicit_approval, status, intake_source, linked_action_item_id, requires_local)
  values ('SMOKE p3','o','c','b','low',false,'Standing','triage-agent',null,false)
  returning id into v_task;
  v_caught := false;
  begin v_res := public.auto_promote_agent_task_intake(v_task,'triage',1,'r');
  exception when others then v_caught := true; v_msg := sqlerrm; end;
  if not v_caught then raise exception 'PROBE 3 (E linked_action_item_id) should have refused'; end if;
  if position('(E linked_action_item_id)' in v_msg) = 0 then raise exception 'PROBE 3 wrong reason: %', v_msg; end if;

  -- Probe 4 — F: missing acceptance_criteria.
  insert into public.action_items (description) values ('SMOKE p4') returning id into v_ai;
  insert into public.agent_tasks
    (title, desired_outcome, acceptance_criteria, boundaries, risk,
     explicit_approval, status, intake_source, linked_action_item_id, requires_local)
  values ('SMOKE p4','o','','b','low',false,'Standing','triage-agent',v_ai,false)
  returning id into v_task;
  v_caught := false;
  begin v_res := public.auto_promote_agent_task_intake(v_task,'triage',1,'r');
  exception when others then v_caught := true; v_msg := sqlerrm; end;
  if not v_caught then raise exception 'PROBE 4 (F packet) should have refused'; end if;
  if position('(F packet)' in v_msg) = 0 then raise exception 'PROBE 4 wrong reason: %', v_msg; end if;

  -- Probe 5 — I: requires_local=true. The new S3-driven probe.
  insert into public.action_items (description) values ('SMOKE p5') returning id into v_ai;
  insert into public.agent_tasks
    (title, desired_outcome, acceptance_criteria, boundaries, risk,
     explicit_approval, status, intake_source, linked_action_item_id, requires_local)
  values ('SMOKE p5','o','c','b','low',false,'Standing','triage-agent',v_ai,true)
  returning id into v_task;
  v_caught := false;
  begin v_res := public.auto_promote_agent_task_intake(v_task,'triage',1,'r');
  exception when others then v_caught := true; v_msg := sqlerrm; end;
  if not v_caught then raise exception 'PROBE 5 (I requires_local) should have refused'; end if;
  if position('(I requires_local)' in v_msg) = 0 then raise exception 'PROBE 5 wrong reason: %', v_msg; end if;

  -- Probe 6 — G: caller other than triage.
  insert into public.action_items (description) values ('SMOKE p6') returning id into v_ai;
  insert into public.agent_tasks
    (title, desired_outcome, acceptance_criteria, boundaries, risk,
     explicit_approval, status, intake_source, linked_action_item_id, requires_local)
  values ('SMOKE p6','o','c','b','low',false,'Standing','triage-agent',v_ai,false)
  returning id into v_task;
  v_caught := false;
  begin v_res := public.auto_promote_agent_task_intake(v_task,'local-codex',1,'r');
  exception when others then v_caught := true; v_msg := sqlerrm; end;
  if not v_caught then raise exception 'PROBE 6 (G caller) should have refused'; end if;
  if position('(G caller)' in v_msg) = 0 then raise exception 'PROBE 6 wrong reason: %', v_msg; end if;

  -- Probe 8 — D: intake_source not triage-agent. (Probe 7, the cap, runs after
  -- the happy path so a real count exists.)
  insert into public.action_items (description) values ('SMOKE p8') returning id into v_ai;
  insert into public.agent_tasks
    (title, desired_outcome, acceptance_criteria, boundaries, risk,
     explicit_approval, status, intake_source, linked_action_item_id, requires_local)
  values ('SMOKE p8','o','c','b','low',false,'Standing','thought-intake',v_ai,false)
  returning id into v_task;
  v_caught := false;
  begin v_res := public.auto_promote_agent_task_intake(v_task,'triage',1,'r');
  exception when others then v_caught := true; v_msg := sqlerrm; end;
  if not v_caught then raise exception 'PROBE 8 (D intake_source) should have refused'; end if;
  if position('(D intake_source)' in v_msg) = 0 then raise exception 'PROBE 8 wrong reason: %', v_msg; end if;

  -- No auto-promoted event leaked from any refusal.
  select count(*) into v_evt
  from public.agent_task_events
  where event_type = 'AGENT STATUS' and payload->>'action' = 'auto-promoted';
  if v_evt <> 0 then raise exception 'REFUSALS leaked % auto-promoted event(s); expected 0', v_evt; end if;

  -- ============================================================ HAPPY PATH ==
  insert into public.action_items (description) values ('SMOKE happy') returning id into v_ai;
  insert into public.agent_tasks
    (title, desired_outcome, acceptance_criteria, boundaries, risk,
     explicit_approval, status, intake_source, linked_action_item_id, requires_local, attempt_count)
  values ('SMOKE happy','ship a report','done when report exists','no sends','low',
     false,'Standing','triage-agent',v_ai,false,0)
  returning id into v_task;

  v_res := public.auto_promote_agent_task_intake(
    v_task, 'triage', 1, 'Read-only lookup that produces a report; touches nothing live.');

  if v_res.status <> 'Agent Todo'   then raise exception 'HAPPY status=% expected Agent Todo', v_res.status; end if;
  if v_res.agent_code is not null   then raise exception 'HAPPY agent_code=% expected NULL', v_res.agent_code; end if;
  if v_res.preferred_agent is not null then raise exception 'HAPPY preferred_agent=% expected NULL', v_res.preferred_agent; end if;
  if v_res.requires_local is not false then raise exception 'HAPPY requires_local changed'; end if;
  if v_res.attempt_count <> 0       then raise exception 'HAPPY attempt_count touched: %', v_res.attempt_count; end if;
  if v_res.claim_token is not null or v_res.claimed_by is not null then raise exception 'HAPPY claim state touched'; end if;

  select count(*), max(agent_code) into v_evt, v_author
  from public.agent_task_events
  where task_id = v_task and event_type = 'AGENT STATUS' and payload->>'action' = 'auto-promoted';
  if v_evt <> 1 then raise exception 'HAPPY event count=% expected 1', v_evt; end if;
  if v_author <> 'triage-auto' then raise exception 'HAPPY event author=% expected triage-auto', v_author; end if;

  perform 1 from public.agent_task_events
  where task_id = v_task and event_type = 'AGENT STATUS'
    and agent_code = 'triage-auto'
    and payload->>'action' = 'auto-promoted'
    and payload->>'caller' = 'triage'
    and (payload->>'allowlist_category')::int = 1
    and nullif(trim(payload->>'rationale'), '') is not null
    and payload->>'from_status' = 'Standing'
    and payload->>'status' = 'Agent Todo';
  if not found then raise exception 'HAPPY event payload does not match the §4.2 contract'; end if;

  -- ===================================================== WATCH NON-INTERFERE ==
  -- S318 regression guard, executable: the promotion must NOT author any event
  -- as triage (the DIRTY predicate). Only triage-auto.
  select count(*) into v_dt_evt
  from public.agent_task_events
  where task_id = v_task and agent_code = 'triage';
  if v_dt_evt <> 0 then raise exception 'WATCH: promotion wrote % triage-authored event(s); would dirty the day', v_dt_evt; end if;

  -- ================================================================ CAP (7) ==
  -- One auto-promoted event now exists this UTC day. Lower the cap to 1 so the
  -- next compliant promote must refuse on H, and confirm H reads from events.
  update public.oe_auto_promote_config set daily_cap = 1 where id = true;
  insert into public.action_items (description) values ('SMOKE p7') returning id into v_ai;
  insert into public.agent_tasks
    (title, desired_outcome, acceptance_criteria, boundaries, risk,
     explicit_approval, status, intake_source, linked_action_item_id, requires_local)
  values ('SMOKE p7','o','c','b','low',false,'Standing','triage-agent',v_ai,false)
  returning id into v_task;
  v_caught := false;
  begin v_res := public.auto_promote_agent_task_intake(v_task,'triage',1,'r');
  exception when others then v_caught := true; v_msg := sqlerrm; end;
  if not v_caught then raise exception 'PROBE 7 (H cap) should have refused at cap 1 with 1 already promoted'; end if;
  if position('(H cap)' in v_msg) = 0 then raise exception 'PROBE 7 wrong reason: %', v_msg; end if;

  -- Roll everything back: nothing above persists.
  raise exception 'PROBE_SUITE_PASS: 8 refusals + happy path + watch-clean';
end $$;
