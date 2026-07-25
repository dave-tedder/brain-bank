-- ---------------------------------------------------------------------------
-- Reaper dead-letter no longer manufactures an unusable claim.
--
-- Problem. public.release_expired_agent_claims() scans ONLY
-- status = 'Agent Working'. When a claim expires at attempt_count >= 5 the
-- dead-letter branch moved the row to 'Agent Needs Input' but KEPT claimed_by
-- and claimed_at while NULLing claim_expires_at and claim_token:
--
--     claimed_at = case when v_new_status = 'Agent Needs Input' then claimed_at else null end,
--     claimed_by = case when v_new_status = 'Agent Needs Input' then claimed_by else null end,
--
-- The result is held, owned on paper by a lane that is gone, with no expiry
-- for anything to key on, and no longer 'Agent Working' so the reaper never
-- revisits it. On that row answer/resume/unblock/update all refuse (the
-- resume-family gates on the claiming agent_code, and the caller is not the
-- gone lane) and admin_amend cannot move 'Agent Needs Input' to a terminal
-- status. That is a genuine dead end, only recoverable with raw SQL.
--
-- Fix. The dead-letter branch now clears claimed_by AND claimed_at along with
-- claim_expires_at and claim_token, so a dead-lettered row lands in
-- 'Agent Needs Input' genuinely UNCLAIMED. Both reaper branches now fully
-- release the claim (the < 5 return-to-Todo branch already did), so the two
-- claim-lifecycle columns become unconditional assignments; only
-- blocked_reason still branches on the destination status.
--
-- Why this is safe:
--   * Attribution of the failure is NOT lost. The AGENT FAILED event this
--     function already inserts carries agent_code = the previous holder
--     (v_row.claimed_by), which is the durable record.
--   * agent_scorecard attributes via coalesce(claimed_by, latest AGENT DONE
--     agent_code, assigned agent_code, '(unassigned)'). A dead-lettered row
--     never reaches AGENT DONE and is 'Agent Needs Input' (is_active), so it
--     only ever counts as in_flight; clearing claimed_by shifts that in-flight
--     tally from the executor to '(unassigned)', which is more accurate for a
--     card no one holds. No resolved/first-try/setback figure changes.
--   * An unclaimed 'Agent Needs Input' row is NOT auto-reclaimed:
--     claim_next_agent_task and claim_specific_agent_task only accept
--     'Agent Todo', so the dead-letter stays parked for a human instead of
--     re-entering the retry loop (which is exactly why the dead-letter branch
--     must not route to 'Agent Todo').
--   * It is reachable by a supported verb without raw SQL:
--     admin_amend_agent_task(release_claim => true) folds an
--     'Agent Needs Input' / 'Agent Review' row to 'Agent Todo'
--     (20260716_release_claim_returns_to_todo.sql), and that fold does not
--     require a claim to be present.
--
-- Scope note: the reaper is the UNIQUE producer of the
-- "status <> Agent Working AND claimed_by set AND claim_expires_at NULL"
-- shape. move_agent_task_status retains a claim when moving to
-- 'Agent Needs Input' / 'Agent Review' but always keeps a REAL (non-null)
-- claim_expires_at (a legitimate hold or a post-review-resumable row), so it
-- does not create the null-expiry dead shape and is intentionally left alone.
--
-- Body otherwise byte-identical to 20260711_oe15_soft_affinity_claim_tokens.sql.
-- ---------------------------------------------------------------------------

create or replace function public.release_expired_agent_claims()
returns table (
  reaped_task_id uuid,
  previous_claimed_by text,
  reaped_claim_expired_at timestamptz,
  new_attempt_count int
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_row record;
  v_new_attempt_count int;
  v_new_status text;
  v_reason text;
begin
  for v_row in
    select id, claimed_by, claim_expires_at, attempt_count
    from public.agent_tasks
    where status = 'Agent Working'
      and claim_expires_at is not null
      and claim_expires_at < now()
      and archived_at is null
    for update skip locked
  loop
    v_new_attempt_count := v_row.attempt_count + 1;
    v_new_status := case when v_new_attempt_count >= 5 then 'Agent Needs Input' else 'Agent Todo' end;
    v_reason := case
      when v_new_attempt_count >= 5 then 'max attempts reached (5); needs human triage'
      else 'claim expired'
    end;

    update public.agent_tasks
    set
      status = v_new_status,
      -- Both branches now fully release the claim. Keeping claimed_by/claimed_at
      -- on the dead-letter branch is what manufactured the unusable-claim shape.
      claimed_at = null,
      claimed_by = null,
      claim_expires_at = null,
      claim_token = null,
      blocked_reason = case when v_new_status = 'Agent Needs Input' then v_reason else null end,
      review_reason = null,
      attempt_count = v_new_attempt_count,
      last_failed_at = now(),
      last_failure_reason = v_reason,
      critic_verdict = null,
      critic_flags = '[]'::jsonb,
      critic_reviewed_by = null,
      critic_reviewed_at = null
    where id = v_row.id;

    insert into public.agent_task_events (task_id, event_type, agent_code, payload)
    values (
      v_row.id,
      'AGENT FAILED',
      v_row.claimed_by,
      jsonb_strip_nulls(jsonb_build_object(
        'status', v_new_status,
        'from_status', 'Agent Working',
        'reason', v_reason,
        'reaped_by', 'release_expired_agent_claims',
        'claim_expired_at', v_row.claim_expires_at,
        'dead_letter', v_new_attempt_count >= 5
      ))
    );

    reaped_task_id := v_row.id;
    previous_claimed_by := v_row.claimed_by;
    reaped_claim_expired_at := v_row.claim_expires_at;
    new_attempt_count := v_new_attempt_count;
    return next;
  end loop;

  return;
end;
$$;

revoke execute on function public.release_expired_agent_claims() from public, anon, authenticated;
grant execute on function public.release_expired_agent_claims() to service_role;

-- ---------------------------------------------------------------------------
-- One-time scoped repair of rows ALREADY in the reaper dead-letter shape.
--
-- Predicate isolates the exact shape this function manufactured and nothing
-- else: 'Agent Needs Input', a live claimed_by, a NULL claim_expires_at and
-- NULL claim_token, and attempt_count >= 5. This deliberately does NOT match:
--   * legitimate holds: 'Agent Needs Input' but a REAL past claim_expires_at
--     and attempt_count 0 -- still resumable by its owner.
--   * completed work awaiting apply (the Agent Review rows): wrong status and
--     a real past claim_expires_at.
--   * any Needs Operator leftover fixture: wrong status; untouched.
--
-- On a fresh install this matches 0 rows. The statement is written to be safe
-- and idempotent so it also catches any dead-letter created between applying
-- this migration and any earlier deploy that still ran the old function body.
-- It clears ONLY the two claim-ownership columns; status, attempt_count,
-- blocked_reason and history are left intact so the card still reads as a
-- dead-lettered "needs human triage" row, now genuinely unclaimed.
-- ---------------------------------------------------------------------------

do $$
declare
  v_ids uuid[];
  v_count int;
begin
  select coalesce(array_agg(id), '{}'), count(*)
  into v_ids, v_count
  from public.agent_tasks
  where status = 'Agent Needs Input'
    and claimed_by is not null
    and claim_expires_at is null
    and claim_token is null
    and attempt_count >= 5
    and archived_at is null;

  raise notice 'reaper dead-letter repair: % row(s) match the stuck shape: %', v_count, v_ids;

  update public.agent_tasks
  set claimed_by = null,
      claimed_at = null
  where status = 'Agent Needs Input'
    and claimed_by is not null
    and claim_expires_at is null
    and claim_token is null
    and attempt_count >= 5
    and archived_at is null;

  raise notice 'reaper dead-letter repair: cleared claim ownership on % row(s)', v_count;
end;
$$;
