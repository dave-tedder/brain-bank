-- OE board-hygiene Track A-prime: the close_check packet field, which is the
-- reconciliation lane's opt-in gate.
--
-- Modeled on 20260715_oe13_check_spec_packet_field.sql. Nullable + additive, so
-- it is drop-safe and NULL leaves the card on the existing human-read desk byte
-- for byte. A card with no close_check is never probed and never auto-closed.
--
-- MUST RUN AFTER 20260725_admin_amend_desk_move_from_held.sql. This migration
-- drops and recreates admin_amend_agent_task (the signature changes), carrying
-- that migration's widened predicate and active-claim fence forward verbatim.
--
-- ============================================================================
-- WRITE-ONCE, NOT STRICTLY IMMUTABLE: the one deliberate divergence from check_spec
-- ============================================================================
-- Both fields share the same safety story: the assertion is authored upstream and
-- NO WORKER HAS A VERB TO ALTER IT. That is what the trigger protects, and it is
-- mirrored here.
--
-- check_spec's trigger additionally blocks NULLING, on the stated reasoning that
-- clearing the check "would drop the task back to the weaker receipt-only gate,
-- which is the wrong direction for a correction."
--
-- For close_check that reasoning INVERTS. Clearing a close_check returns the card
-- to the human-read desk, which is the SAFE direction, and it is the first-line
-- rollback lever for a bad probe: set every close_check to null, the field goes
-- inert, the lane runs and closes nothing. Blocking the disarm would delete a
-- rollback path and protect nothing.
--
-- So the trigger blocks exactly the dangerous transition:
--   null  -> value            ALLOWED  (authorship)
--   value -> null             ALLOWED  (disarm / rollback)
--   value -> same value       ALLOWED  (no-op update elsewhere on the row)
--   value -> DIFFERENT value  RAISES   (silent re-aim: swapping a hard assertion
--                                       for a trivially-true one is how a probe
--                                       gets quietly weaponized into a false close)
--
-- Write-once is also what makes the feature REACHABLE on an existing board. Every
-- Needs Operator card intaken before this column existed would otherwise need
-- archive-and-re-intake to become eligible. admin_amend_agent_task is the
-- authoring path for cards already on the desk, and it is service_role-only,
-- human/ops-use-only, and absent from every executor allowlist.
--
-- The honest correction path for a WRONG close_check is: clear it (allowed), then
-- author the corrected one. That is two audited admin_amend events, not a silent
-- edit.
--
-- ============================================================================
-- OPERATOR-AUTHORED ONLY IN FIRST SCOPE
-- ============================================================================
-- Where Phase 4 auto-promote is enabled, a fully zero-human close loop becomes
-- constructible: triage authors a card carrying a close_check -> auto-promote
-- moves it to Agent Todo with no human in the path -> an executor runs it ->
-- closeout routes it to the desk -> the reconciler closes it. Nobody would have
-- decided anything.
--
-- Severed at the source in the MCP layer: create_agent_task_intake refuses a
-- close_check when intake_source = 'triage-agent', which is exactly and only the
-- provenance auto_promote_agent_task_intake requires (its condition G). Mirrors
-- the OE-13B do-not-stack rule and is relaxable on the same terms: not in the
-- week a gate graduated.
--
-- Shape validation lives in the MCP layer (_agent_intake.ts validateCloseCheck),
-- shared by both authoring paths, exactly as check_spec's does. The column itself
-- is plain jsonb and service_role-only.
--
-- Ships UNAPPLIED, as every migration in this repo does.

alter table public.agent_tasks
  add column if not exists close_check jsonb;

comment on column public.agent_tasks.close_check is
  'OE board-hygiene: packet-authored reconciliation probe ({probe, ...}, allowlist-validated at authorship against the four probe verbs). WRITE-ONCE (trigger-enforced): authorable once, clearable for rollback, never silently re-aimed. Read by the scheduled reconciler lane, which may only ever auto-close a Needs Operator card and never reopen, re-flag, or otherwise mutate one. Operator-authored only in first scope (intake refuses it on intake_source=triage-agent). NULL = not eligible, card stays on the human-read desk.';

-- Plain invoker rights (no SECURITY DEFINER -- the trigger only raises).
create or replace function public.oe_close_check_write_once()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.close_check is not null
     and new.close_check is not null
     and new.close_check is distinct from old.close_check then
    raise exception 'agent_tasks.close_check is write-once: it may be authored once and cleared for rollback, but never re-aimed at a different assertion. Clear it first (admin_amend_agent_task with p_clear_close_check => true), then author the corrected check. Both steps are audited.'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_oe_close_check_write_once on public.agent_tasks;
create trigger trg_oe_close_check_write_once
  before update on public.agent_tasks
  for each row
  execute function public.oe_close_check_write_once();

-- ============================================================================
-- admin_amend_agent_task: add close_check authorship
-- ============================================================================
-- The signature changes, so create-or-replace would register a second overload
-- and leave the 10-arg version callable and ambiguous. Drop it explicitly.
-- Body is 20260725_admin_amend_desk_move_from_held.sql carried forward verbatim
-- (widened desk-move predicate + active-claim fence) plus the two new params.
--
-- TWO params rather than one, because a single nullable jsonb cannot distinguish
-- "not supplied" from "explicitly clear this". p_set_close_check authors;
-- p_clear_close_check disarms. Passing both raises.

drop function if exists public.admin_amend_agent_task(uuid, text, text, text, jsonb, text, text, boolean, boolean, boolean);

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
  p_clear_close_check boolean default false
)
returns public.agent_tasks
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
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

  if p_move_to_needs_operator then
    -- Widened set (Track A). Standing stays OUT by design: an unpromoted draft
    -- whose work happened out of band is an archive plus a doc-tag flip, not a
    -- desk card.
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
      'added_sources', case
        when p_add_sources is not null and jsonb_array_length(p_add_sources) > 0 then p_add_sources
        else null
      end
    ))
  );

  return v_task;
end;
$$;

revoke execute on function public.admin_amend_agent_task(uuid, text, text, text, jsonb, text, text, boolean, boolean, boolean, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.admin_amend_agent_task(uuid, text, text, text, jsonb, text, text, boolean, boolean, boolean, jsonb, boolean) to service_role;

notify pgrst, 'reload schema';
