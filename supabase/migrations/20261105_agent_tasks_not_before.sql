-- Loop-closing Task 2.3 (D5, D6): agent_tasks.not_before, the hold date a card
-- carries while it sits in Agent Needs Input, so the digest and the sentinel can
-- say which holds are past due instead of counting a desk that never moves.
--
-- Plan: docs/superpowers/plans/2026-11-03-loop-closing-fix-plan.md, Task 2.3.
--
-- Four pieces, in dependency order:
--   1. The column, plus a CHECK that pins the invariant "a date only exists on a
--      held card". Existing rows are all null, so the CHECK is valid at once.
--   2. A BEFORE UPDATE trigger that nulls the date on ANY transition out of
--      Agent Needs Input, whatever path wrote the status (move_agent_task_status,
--      admin_amend_agent_task, the reaper, raw service-role SQL). This is the
--      single clearing mechanism; neither RPC duplicates it, so a dropped trigger
--      is visible to every clear-on-exit test rather than masked by a copy.
--   3. move_agent_task_status gains p_not_before (the hold_agent_task MCP tool
--      passes it through). Signature change: the 6-argument form is dropped
--      first so no ambiguous overload survives, then revoke/grant as before.
--   4. admin_amend_agent_task gains p_set_not_before for cards ALREADY on hold:
--      legal only on an unarchived Agent Needs Input card, refused in the same
--      call as a move off the hold, changes no status, and rides on the one
--      AGENT STATUS audit event the function already writes. Same drop-and-
--      recreate as 20260725_close_check_packet_field.sql (12 args -> 13).
--
-- Both function bodies are the prior migrations' text carried forward verbatim
-- (20260711_oe15_soft_affinity_claim_tokens.sql for move_agent_task_status,
-- 20260725_close_check_packet_field.sql for admin_amend_agent_task), edited only
-- at the lines marked "Task 2.3". scripts/loop-closing/not-before-sql-test.sh
-- applies the prior versions to a throwaway cluster, checks their definitions
-- against the production md5s read on 2026-11-05, then applies this file and
-- diffs the two definitions so the carry-forward is proven, not asserted.
--
-- Rollback is consumer-first: restore the prior sentinel prompt and the four
-- live SKILLs, deploy MCP v138 and the prior brain-digest, and only THEN, in
-- one transaction: re-create both RPCs from the prior migrations named above
-- (dropping the 7- and 13-argument forms first, then revoke/grant their
-- signatures); drop trigger agent_tasks_clear_not_before; drop function
-- agent_tasks_clear_not_before(); drop constraint
-- agent_tasks_not_before_only_when_held; alter table drop column not_before.
-- The new MCP passes p_not_before and p_set_not_before by name, which the
-- prior signatures do not accept, so the schema must outlive the new MCP, never
-- the other way round. The additive schema is harmless to v138.

-- ---------------------------------------------------------------------------
-- 1. Column and invariant
-- ---------------------------------------------------------------------------

alter table public.agent_tasks
  add column if not exists not_before timestamptz null;

comment on column public.agent_tasks.not_before is
  'Task 2.3: the earliest moment a held card is worth re-queueing. Set by hold_agent_task (p_not_before) when the hold is placed, or by admin_amend_agent_task (p_set_not_before) on a card already in Agent Needs Input. Cleared by agent_tasks_clear_not_before on any transition out of Agent Needs Input. Non-null only while status = Agent Needs Input (CHECK agent_tasks_not_before_only_when_held). A past value means the hold is overdue: the digest desk line and the sentinel expired-holds figure both count it.';

alter table public.agent_tasks
  drop constraint if exists agent_tasks_not_before_only_when_held;
alter table public.agent_tasks
  add constraint agent_tasks_not_before_only_when_held
  check (not_before is null or status = 'Agent Needs Input');

-- The sentinel reads agent_tasks through the column-scoped sentinel_reader role
-- (20261105_sentinel_reader_role.sql). Without this grant its CARD_FIELDS read
-- fails the moment the prompt asks for not_before. Conditional so the migration
-- also applies on a database that never created the role.
do $do$
begin
  if exists (select 1 from pg_roles where rolname = 'sentinel_reader') then
    grant select (not_before) on public.agent_tasks to sentinel_reader;
  end if;
end
$do$;

-- ---------------------------------------------------------------------------
-- 2. Clear on exit, every path
-- ---------------------------------------------------------------------------

create or replace function public.agent_tasks_clear_not_before()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.status = 'Agent Needs Input'
     and new.status is distinct from 'Agent Needs Input' then
    new.not_before := null;
  end if;
  return new;
end;
$$;

drop trigger if exists agent_tasks_clear_not_before on public.agent_tasks;
create trigger agent_tasks_clear_not_before
  before update on public.agent_tasks
  for each row
  execute function public.agent_tasks_clear_not_before();

-- ---------------------------------------------------------------------------
-- 3. move_agent_task_status: p_not_before on the hold
-- ---------------------------------------------------------------------------

drop function if exists public.move_agent_task_status(uuid, text, text, text, text, uuid);

create or replace function public.move_agent_task_status(
  p_task_id uuid,
  p_status text,
  p_event_type text,
  p_agent_code text default null,
  p_reason text default null,
  p_claim_token uuid default null,
  p_not_before timestamptz default null
)
returns public.agent_tasks
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_current public.agent_tasks;
  v_task public.agent_tasks;
  v_valid_from_state boolean := false;
begin
  if p_status not in ('Standing','Agent Todo','Agent Working','Agent Needs Input','Agent Review','Needs Operator','Agent Done') then
    raise exception 'Invalid status: %', p_status using errcode = '22023';
  end if;

  if p_event_type not in (
    'AGENT CLAIMED',
    'AGENT DONE',
    'AGENT BLOCKED',
    'AGENT UNBLOCKED',
    'AGENT HUMAN HOLD',
    'AGENT HUMAN ANSWERED',
    'AGENT RESUMED',
    'AGENT FAILED',
    'AGENT APPLIED',
    'AGENT NEEDS OPERATOR',
    'OPERATOR DONE',
    'AGENT CRITIC',
    'AGENT SKILL SUBSCRIBED',
    'AGENT SKILL INSTALLED',
    'AGENT SKILL UPDATED',
    'AGENT SKILL DECLINED',
    'AGENT FOLLOW-UP',
    'AGENT STATUS'
  ) then
    raise exception 'Invalid event_type: %', p_event_type using errcode = '22023';
  end if;

  -- Task 2.3: a not-before date belongs to a hold and nothing else. Refusing it
  -- here keeps a stray date off a Review or Done transition instead of
  -- silently dropping it.
  if p_not_before is not null and p_status <> 'Agent Needs Input' then
    raise exception 'not_before is only meaningful on an Agent Needs Input hold; refusing it on % to %', p_event_type, p_status
      using errcode = '22023';
  end if;

  if p_agent_code is not null and not exists (
    select 1 from public.agent_task_ledger where agent_code = p_agent_code
  ) then
    raise exception 'Unknown agent_code: %', p_agent_code using errcode = '22023';
  end if;

  select * into v_current
  from public.agent_tasks
  where id = p_task_id
  for update;

  if not found then
    raise exception 'Task not found: %', p_task_id using errcode = 'P0002';
  end if;

  if v_current.archived_at is not null then
    raise exception 'Task % is archived; refusing status change', p_task_id
      using errcode = '22023';
  end if;

  if v_current.status = 'Agent Done'
    and not (p_status = 'Agent Done' and p_event_type = 'AGENT APPLIED') then
    raise exception 'Done tasks cannot receive non-apply receipts through this helper'
      using errcode = '22023';
  end if;

  if v_current.claimed_by is not null
    and p_agent_code is not null
    and p_agent_code <> v_current.claimed_by then
    raise exception 'Task % is claimed by %, not %', p_task_id, v_current.claimed_by, p_agent_code
      using errcode = '42501';
  end if;

  -- OE-15 per-run claim ownership: a matching agent_code is no longer enough
  -- for run-side receipts, because three executor slots share one identity.
  if v_current.claim_token is not null
    and p_event_type in ('AGENT DONE','AGENT BLOCKED','AGENT HUMAN HOLD','AGENT FAILED','AGENT STATUS')
    and (p_claim_token is null or p_claim_token <> v_current.claim_token) then
    raise exception 'Task % is held by a different run of %: claim_token missing or stale. Only the run holding the current claim can write % receipts.',
      p_task_id, coalesce(v_current.claimed_by, '(unclaimed)'), p_event_type
      using errcode = '42501';
  end if;

  v_valid_from_state := case
    when p_status = 'Agent Working'
      and p_event_type in ('AGENT RESUMED','AGENT UNBLOCKED','AGENT HUMAN ANSWERED')
      then v_current.status in ('Agent Needs Input','Agent Review')

    when p_status = 'Agent Working' and p_event_type = 'AGENT STATUS'
      then v_current.status = 'Agent Working'

    when p_status = 'Agent Needs Input'
      and p_event_type in ('AGENT BLOCKED','AGENT HUMAN HOLD','AGENT FAILED')
      then v_current.status = 'Agent Working'

    when p_status = 'Agent Review' and p_event_type = 'AGENT DONE'
      then v_current.status = 'Agent Working'

    when p_status = 'Agent Done' and p_event_type = 'AGENT APPLIED'
      then v_current.status = 'Agent Review'

    when p_status = 'Agent Todo' and p_event_type = 'AGENT FAILED'
      then v_current.status = 'Agent Working'

    when p_status = 'Agent Todo' and p_event_type = 'AGENT FOLLOW-UP'
      then v_current.status in ('Agent Working','Agent Needs Input','Agent Review','Needs Operator','Agent Done')

    when p_status = 'Standing' and p_event_type = 'AGENT STATUS'
      then v_current.status in ('Agent Todo','Agent Working','Agent Needs Input','Agent Review','Standing')

    when p_status = v_current.status
      and p_event_type in (
        'AGENT FOLLOW-UP',
        'AGENT STATUS',
        'AGENT SKILL SUBSCRIBED',
        'AGENT SKILL INSTALLED',
        'AGENT SKILL UPDATED',
        'AGENT SKILL DECLINED'
      )
      and v_current.status <> 'Agent Done'
      then true

    else false
  end;

  if not v_valid_from_state then
    raise exception 'Invalid transition: % on % -> % (from %)',
      p_event_type, p_task_id, p_status, v_current.status
      using errcode = '22023';
  end if;

  if p_status = 'Agent Working'
    and v_current.risk = 'high'
    and v_current.explicit_approval is not true then
    raise exception 'High-risk task requires explicit approval before Agent Working'
      using errcode = '42501';
  end if;

  update public.agent_tasks
  set
    status = p_status,
    blocked_reason = case
      when p_status = 'Agent Needs Input' then p_reason
      when status = 'Agent Needs Input' and p_status <> 'Agent Needs Input' then null
      else blocked_reason
    end,
    -- Task 2.3: set or keep the hold date while the card is held. Clearing on
    -- the way OUT of Agent Needs Input is the trigger's job
    -- (agent_tasks_clear_not_before), the one mechanism every write path shares.
    not_before = case
      when p_status = 'Agent Needs Input' then coalesce(p_not_before, not_before)
      else not_before
    end,
    review_reason = case
      when p_status = 'Agent Review' then p_reason
      when status = 'Agent Review' and p_status <> 'Agent Review' then null
      else review_reason
    end,
    completed_at = case
      when p_status = 'Agent Done' then coalesce(completed_at, now())
      when p_status <> 'Agent Done' then null
      else completed_at
    end,
    claimed_at = case
      when p_status in ('Agent Working','Agent Needs Input','Agent Review') then coalesce(claimed_at, now())
      else null
    end,
    claimed_by = case
      when p_status in ('Agent Working','Agent Needs Input','Agent Review') then coalesce(claimed_by, p_agent_code)
      else null
    end,
    claim_expires_at = case
      when p_status = 'Agent Working' then now() + interval '60 minutes'
      when p_status in ('Agent Needs Input','Agent Review') then claim_expires_at
      else null
    end,
    claim_token = case
      when p_status = 'Agent Working'
        and p_event_type in ('AGENT RESUMED','AGENT UNBLOCKED','AGENT HUMAN ANSWERED')
        then gen_random_uuid()
      when p_status in ('Agent Working','Agent Needs Input','Agent Review') then claim_token
      else null
    end,
    attempt_count = case
      when p_event_type = 'AGENT FAILED' then attempt_count + 1
      else attempt_count
    end,
    last_failed_at = case
      when p_event_type = 'AGENT FAILED' then now()
      else last_failed_at
    end,
    last_failure_reason = case
      when p_event_type = 'AGENT FAILED' then p_reason
      else last_failure_reason
    end,
    critic_verdict = case
      when p_status in ('Agent Working','Agent Todo') then null
      else critic_verdict
    end,
    critic_flags = case
      when p_status in ('Agent Working','Agent Todo') then '[]'::jsonb
      else critic_flags
    end,
    critic_reviewed_by = case
      when p_status in ('Agent Working','Agent Todo') then null
      else critic_reviewed_by
    end,
    critic_reviewed_at = case
      when p_status in ('Agent Working','Agent Todo') then null
      else critic_reviewed_at
    end
  where id = p_task_id
  returning * into v_task;

  insert into public.agent_task_events (task_id, event_type, agent_code, payload)
  values (
    p_task_id,
    p_event_type,
    p_agent_code,
    jsonb_strip_nulls(jsonb_build_object(
      'status', p_status,
      'from_status', v_current.status,
      'reason', p_reason,
      'not_before', p_not_before
    ))
  );

  if p_event_type = 'AGENT STATUS' and p_agent_code is not null then
    update public.agent_task_ledger
    set
      last_heartbeat = now(),
      last_queue_result = coalesce(p_reason, 'status heartbeat')
    where agent_code = p_agent_code;
  end if;

  return v_task;
end;
$$;

revoke execute on function public.move_agent_task_status(uuid, text, text, text, text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.move_agent_task_status(uuid, text, text, text, text, uuid, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 4. admin_amend_agent_task: p_set_not_before on a card already held
-- ---------------------------------------------------------------------------

drop function if exists public.admin_amend_agent_task(uuid, text, text, text, jsonb, text, text, boolean, boolean, boolean, jsonb, boolean);

create or replace function public.admin_amend_agent_task(
  p_task_id uuid,
  p_reason text,
  p_actor text default null,
  p_set_project_slug text default null,
  p_add_sources jsonb default null,
  p_set_operator_action text default null,
  p_set_operator_target text default null,
  p_set_requires_local boolean default null,
  p_move_to_needs_operator boolean default false,
  p_release_claim boolean default false,
  p_set_close_check jsonb default null,
  p_clear_close_check boolean default false,
  p_set_not_before timestamptz default null
)
returns public.agent_tasks
language plpgsql
set search_path = pg_catalog, public
as $function$
declare
  v_current public.agent_tasks;
  v_task public.agent_tasks;
  v_new_sources jsonb;
  v_elem jsonb;
  v_effective_operator_action text;
  v_event_type text;
  v_target_status text;
  v_folded_to_todo boolean;
  v_released_agent_code text;
  v_new_close_check jsonb;
begin
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'admin_amend_agent_task requires a non-empty reason for the audit trail'
      using errcode = '22023';
  end if;

  if p_set_close_check is not null and coalesce(p_clear_close_check, false) then
    raise exception 'admin_amend_agent_task cannot set and clear close_check in the same call; clearing and re-authoring are two audited steps'
      using errcode = '22023';
  end if;

  select * into v_current
  from public.agent_tasks
  where id = p_task_id
  for update;

  if not found then
    raise exception 'Task not found: %', p_task_id using errcode = 'P0002';
  end if;

  if v_current.archived_at is not null then
    raise exception 'Task % is archived; refusing admin amend', p_task_id
      using errcode = '22023';
  end if;

  -- Task 2.3: a not-before date is legal only on a card that is held right now,
  -- and never in the same call that moves it off the hold (the transition
  -- clears the date, so the call would record a date that no longer exists).
  if p_set_not_before is not null and v_current.status <> 'Agent Needs Input' then
    raise exception 'admin_amend_agent_task can only set not_before on an Agent Needs Input card; task % is %', p_task_id, v_current.status
      using errcode = '22023';
  end if;
  if p_set_not_before is not null and (coalesce(p_move_to_needs_operator, false) or coalesce(p_release_claim, false)) then
    raise exception 'admin_amend_agent_task cannot set not_before on task % in the same call that moves it off Agent Needs Input (move_to_needs_operator or release_claim)', p_task_id
      using errcode = '22023';
  end if;

  if p_move_to_needs_operator then
    -- Widened set (Track A). Standing stays OUT by design: an unpromoted draft
    -- whose work happened out of band is an archive plus a doc-tag flip, per the
    -- 2026-07-13 escape hatch, not a desk card.
    if v_current.status not in (
      'Agent Done', 'Agent Review', 'Agent Needs Input', 'Agent Todo', 'Agent Working'
    ) then
      raise exception 'admin_amend_agent_task can only move Agent Done, Agent Review, Agent Needs Input, Agent Todo, or Agent Working tasks to Needs Operator; task % is %', p_task_id, v_current.status
        using errcode = '22023';
    end if;

    -- THE ACTIVE-CLAIM FENCE. p_release_claim is evaluated FIRST, so a caller
    -- who explicitly releases and desk-moves in one call succeeds in one
    -- transaction; only a silent stomp of a live claim is refused.
    if not coalesce(p_release_claim, false)
       and v_current.status = 'Agent Working'
       and v_current.claim_expires_at is not null
       and v_current.claim_expires_at > now() then
      raise exception 'Task % is Agent Working under a live claim held by %; refusing to move it to Needs Operator out from under the claim. Pass p_release_claim => true in the same call to release the claim and move it, or wait for the claim to expire.', p_task_id, coalesce(v_current.agent_code, v_current.claimed_by, 'an unnamed run')
        using errcode = '22023';
    end if;

    v_effective_operator_action := coalesce(
      nullif(trim(coalesce(p_set_operator_action, '')), ''),
      nullif(trim(coalesce(v_current.operator_action, '')), '')
    );
    if v_effective_operator_action is null then
      raise exception 'Moving task % to Needs Operator requires an operator_action (pass p_set_operator_action or have one already set)', p_task_id
        using errcode = '22023';
    end if;
  end if;

  v_new_sources := coalesce(v_current.sources, '[]'::jsonb);
  if p_add_sources is not null then
    if jsonb_typeof(p_add_sources) <> 'array' then
      raise exception 'p_add_sources must be a JSON array' using errcode = '22023';
    end if;
    for v_elem in select * from jsonb_array_elements(p_add_sources)
    loop
      if not (v_new_sources @> jsonb_build_array(v_elem)) then
        v_new_sources := v_new_sources || jsonb_build_array(v_elem);
      end if;
    end loop;
  end if;

  -- close_check: author, clear, or leave alone. The write-once trigger is the
  -- backstop that refuses a silent re-aim even if a future caller tries one.
  v_new_close_check := case
    when coalesce(p_clear_close_check, false) then null
    when p_set_close_check is not null then p_set_close_check
    else v_current.close_check
  end;

  -- The fold: releasing a claim on a human-facing status returns the row to the
  -- claim pool instead of orphaning it. move_to_needs_operator keeps precedence.
  v_folded_to_todo := coalesce(p_release_claim, false)
    and not coalesce(p_move_to_needs_operator, false)
    and v_current.status in ('Agent Needs Input', 'Agent Review');

  v_target_status := case
    when p_move_to_needs_operator then 'Needs Operator'
    when v_folded_to_todo then 'Agent Todo'
    else v_current.status
  end;

  -- The lane lock: a release that leaves agent_code set is not a handoff, since
  -- every other runtime is refused at claim time. Record what was cleared.
  v_released_agent_code := case
    when coalesce(p_release_claim, false) then v_current.agent_code
    else null
  end;

  update public.agent_tasks
  set
    project_slug = coalesce(nullif(trim(coalesce(p_set_project_slug, '')), ''), project_slug),
    sources = v_new_sources,
    operator_action = coalesce(nullif(trim(coalesce(p_set_operator_action, '')), ''), operator_action),
    operator_target = coalesce(nullif(trim(coalesce(p_set_operator_target, '')), ''), operator_target),
    requires_local = coalesce(p_set_requires_local, requires_local),
    close_check = v_new_close_check,
    -- Task 2.3: overwrite-to-correct; the clear on leaving the hold is the trigger's.
    not_before = coalesce(p_set_not_before, not_before),
    status = v_target_status,
    completed_at = case when p_move_to_needs_operator then null else completed_at end,
    agent_code = case when p_release_claim then null else agent_code end,
    claimed_by = case when p_release_claim then null else claimed_by end,
    claim_token = case when p_release_claim then null else claim_token end,
    claim_expires_at = case when p_release_claim then null else claim_expires_at end
  where id = p_task_id
  returning * into v_task;

  v_event_type := case when p_move_to_needs_operator then 'AGENT NEEDS OPERATOR' else 'AGENT STATUS' end;

  -- agent_code on the event is the lane the row is LEAVING, not null, so the
  -- audit trail still names who held it when the handoff happened.
  insert into public.agent_task_events (task_id, event_type, agent_code, payload)
  values (
    p_task_id,
    v_event_type,
    coalesce(v_task.agent_code, v_released_agent_code),
    jsonb_strip_nulls(jsonb_build_object(
      'action', 'ops-amend',
      'reason', p_reason,
      'actor', nullif(trim(coalesce(p_actor, '')), ''),
      'from_status', v_current.status,
      'status', v_target_status,
      -- Carried, not dropped: the question the card was held on stays legible
      -- after it closes. Only meaningful on a desk move off a held status.
      'blocked_reason', case
        when p_move_to_needs_operator then nullif(trim(coalesce(v_current.blocked_reason, '')), '')
        else null
      end,
      'released_claim', case when p_release_claim then true else null end,
      'released_to_status', case when v_folded_to_todo then 'Agent Todo' else null end,
      'released_from_agent_code', v_released_agent_code,
      'set_project_slug', nullif(trim(coalesce(p_set_project_slug, '')), ''),
      'set_operator_action', nullif(trim(coalesce(p_set_operator_action, '')), ''),
      'set_operator_target', nullif(trim(coalesce(p_set_operator_target, '')), ''),
      'set_requires_local', p_set_requires_local,
      -- The authored assertion is recorded in the audit trail, so a later
      -- dispute can read what the probe was told to check without trusting the
      -- current column value.
      'set_close_check', p_set_close_check,
      'cleared_close_check', case when coalesce(p_clear_close_check, false) then true else null end,
      'set_not_before', p_set_not_before,
      'added_sources', case
        when p_add_sources is not null and jsonb_array_length(p_add_sources) > 0 then p_add_sources
        else null
      end
    ))
  );

  return v_task;
end;
$function$;

revoke execute on function public.admin_amend_agent_task(uuid, text, text, text, jsonb, text, text, boolean, boolean, boolean, jsonb, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.admin_amend_agent_task(uuid, text, text, text, jsonb, text, text, boolean, boolean, boolean, jsonb, boolean, timestamptz) to service_role;
