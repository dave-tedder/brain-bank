-- OE board-hygiene Track A: an honest close path for work finished OUT OF BAND.
--
-- THE FINDING. When you finish a card's real-world work by hand (publish the
-- page, claim the listing, merge the branch), nothing reflects that back to the
-- board. The card sits in a held status, unclaimed, re-surfacing in every
-- briefing as "needs you" forever. Every available route to close it was either
-- refused or dishonest:
--
--   answer/resume/unblock/update        refused: all gate on the claiming agent_code
--   admin_amend(move_to_needs_operator) refused: legal only from Agent Done / Agent Review
--   release_claim -> claim -> complete  WORKS, AND LIES: an agent writes an AGENT DONE
--                                       receipt asserting it performed work a human did
--                                       by hand, a critic then reviews that fabricated
--                                       receipt, and closeout applies it into project history
--   raw SQL                             works, and is the exact thing the C3 ops verb retires
--   archive                             works, and is wrong: the work HAPPENED, so the card
--                                       is done, not abandoned
--
-- The board's honesty invariant is that a receipt describes what its author
-- actually did. The only route that closed the row made that false.
--
-- WHY THE RELEASE-CLAIM FOLD WAS NECESSARY BUT NOT SUFFICIENT.
-- 20260716_release_claim_returns_to_todo.sql made the row REACHABLE: a held row
-- folds back to Agent Todo with agent_code cleared, so any runtime can claim it.
-- Reachable is not the same as closable honestly, because every path out of
-- Agent Todo still runs through an agent receipt. The fold fixed the lane lock.
-- This fixes the exit.
--
-- THE CHANGE, exactly one behavioral widening plus one new fence:
--   1. p_move_to_needs_operator legality widens from {Agent Done, Agent Review}
--      to {Agent Done, Agent Review, Agent Needs Input, Agent Todo, Agent Working}.
--      The row lands on the desk STATING which step was performed, and the
--      already-honest complete_operator_action closes it with an OPERATOR DONE
--      event naming completed_by and carrying the evidence in note. No new verb,
--      no new event type, nothing for the briefing / digest / scorecard / critic /
--      closeout to learn.
--   2. Agent Working is the one entry that adds risk: it can pull a row out from
--      under a LIVE claim. Fenced below (refused while claim_expires_at > now()
--      unless p_release_claim is passed in the same call).
--
-- The existing operator_action requirement is KEPT and is the honesty guard: the
-- closer must state, in writing, which step was performed. It comes free.
--
-- Standing stays OUT of the widened set by design: an unpromoted draft whose
-- work happened out of band is an archive plus a doc-tag flip, not a desk card.
--
-- Also carries blocked_reason into the desk-move event payload rather than
-- dropping it, so the question the card was held on stays legible after it closes.
--
-- UNCHANGED C3 invariants: attempt_count never modified, no AGENT FAILED ever
-- written, no existing event row edited, search_path pinned, service_role only.
--
-- Copy-forward base: 20260716_release_claim_returns_to_todo.sql (the current
-- definition in this repo, which consolidates both the fold and the agent_code
-- clear). Signature is UNCHANGED (10 args), so create-or-replace keeps the
-- existing grants. The close_check parameter added by
-- 20260725_close_check_packet_field.sql changes the signature and therefore
-- drops and recreates this function; that migration carries this body forward.
--
-- Ships UNAPPLIED, as every migration in this repo does.

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
  p_release_claim boolean default false
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
begin
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'admin_amend_agent_task requires a non-empty reason for the audit trail'
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
    -- Widened set (Track A). Standing stays OUT by design; see the header.
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
      'added_sources', case
        when p_add_sources is not null and jsonb_array_length(p_add_sources) > 0 then p_add_sources
        else null
      end
    ))
  );

  return v_task;
end;
$$;

-- Signature unchanged, so the existing grants still apply. Re-issued anyway so
-- this migration is self-contained if replayed against a fresh database.
revoke execute on function public.admin_amend_agent_task(uuid, text, text, text, jsonb, text, text, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.admin_amend_agent_task(uuid, text, text, text, jsonb, text, text, boolean, boolean, boolean) to service_role;

notify pgrst, 'reload schema';
