-- Loop-closing Task 3.4 (D4): a supersede verb for board cards.
--
-- Until now a card whose premise went stale, or whose work duplicated another
-- card, could only close by pretending its operator step happened. This adds a
-- recorded, reasoned terminal path. The linked action item is deliberately NOT
-- touched: its disposition is a separate decision.
--
-- The authority is the service key. p_actor is recorded, never treated as
-- authorization: the MCP has no caller identity, so the payload records
-- actor_source = 'mcp-shared-key' and a reader knows the actor was claimed by
-- the caller, not proven by the transport.
--
-- A card can be reopened off Done (admin_amend_agent_task is the rollback path)
-- and superseded again, so each TASK SUPERSEDED event is one GENERATION, named by
-- payload.generation. That number is the identity. created_at is NOT: it defaults
-- to now(), the transaction's start, taken before this function waits on the row
-- lock, so serialized closes can read back in the order 1, 3, 2 and closes in one
-- transaction tie. p_expected_generation is a compare-and-swap on that number,
-- checked under the row lock: a retry or replay carrying an old authorization
-- cannot close a card that was reopened after it was issued. It may be omitted on a
-- card's first supersede, and on a read-only replay of the generation closed right
-- now; a close of a reopened card must name it. It guards the supersede count, not
-- arbitrary edits to the card between the caller's read and this call.
--
-- The superseded_* columns describe the most recent generation and are NOT cleared
-- by a reopen. "Closed by this verb right now" is superseded_closed_generation not
-- null. This verb sets it; agent_tasks_clear_superseded_closed_generation clears it
-- on any move off Agent Done, whatever path wrote the status, so it needs no edit
-- to any status writer and holds inside one transaction, where now() would make a
-- supersede, an admin reopen and an ordinary completion all look simultaneous.

alter table public.agent_tasks
  add column if not exists superseded_by uuid null
    references public.agent_tasks(id) on delete set null,
  add column if not exists superseded_reason text null,
  add column if not exists superseded_at timestamptz null,
  add column if not exists superseded_actor text null,
  add column if not exists superseded_closed_generation integer null;

-- All three required fields travel together. superseded_by stays optional: a
-- premise-stale close has no replacement, and the FK's on delete set null must
-- not be able to violate this.
alter table public.agent_tasks
  add constraint agent_tasks_superseded_fields_together check (
    (superseded_at is null and superseded_reason is null
      and superseded_actor is null and superseded_by is null)
    or (superseded_at is not null and superseded_reason is not null
      and superseded_actor is not null)
  );

-- The same shape as agent_tasks_not_before_only_when_held and its clear-on-exit
-- trigger: an invariant, plus one mechanism every write path shares.
alter table public.agent_tasks
  add constraint agent_tasks_superseded_closed_only_when_done check (
    superseded_closed_generation is null
    or (superseded_closed_generation >= 1
      and status = 'Agent Done'
      and superseded_at is not null)
  );

create or replace function public.agent_tasks_clear_superseded_closed_generation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.status = 'Agent Done' and new.status is distinct from 'Agent Done' then
    new.superseded_closed_generation := null;
  end if;
  return new;
end;
$$;

create trigger agent_tasks_clear_superseded_closed_generation
  before update on public.agent_tasks
  for each row
  execute function public.agent_tasks_clear_superseded_closed_generation();

-- The 18 values of the prior constraint (20260709030000_critic_verdict.sql)
-- plus one.
alter table public.agent_task_events
  drop constraint agent_task_events_event_type_check;
alter table public.agent_task_events
  add constraint agent_task_events_event_type_check check (event_type in (
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
    'AGENT STATUS',
    'TASK SUPERSEDED'
  ));

create or replace function public.close_agent_task_superseded(
  p_task_id uuid,
  p_reason text,
  p_superseded_by uuid default null,
  p_actor text default null,
  p_expected_generation integer default null
)
returns public.agent_tasks
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_current public.agent_tasks;
  v_task public.agent_tasks;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_actor text := nullif(trim(coalesce(p_actor, '')), '');
  v_generations integer;
  v_well_formed integer;
begin
  if v_reason is null then
    raise exception 'close_agent_task_superseded requires a reason.' using errcode = '22023';
  end if;
  if v_actor is null then
    raise exception 'close_agent_task_superseded requires an actor.' using errcode = '22023';
  end if;
  if v_actor <> 'operator' and not exists (
    select 1 from public.agent_task_ledger where agent_code = v_actor
  ) then
    raise exception 'Actor % is neither operator nor a registered agent_code.', v_actor
      using errcode = '22023';
  end if;
  if p_superseded_by is not null and p_superseded_by = p_task_id then
    raise exception 'A task cannot supersede itself.' using errcode = '22023';
  end if;

  select * into v_current
  from public.agent_tasks
  where id = p_task_id
  for update;
  if not found then
    raise exception 'Task not found: %', p_task_id using errcode = 'P0002';
  end if;
  if v_current.archived_at is not null then
    raise exception 'Task % is archived; cannot supersede.', p_task_id using errcode = '22023';
  end if;

  -- Counted under the row lock, so the number cannot move between this read and the
  -- insert below. Generations 1..n must each appear exactly once: n events and n
  -- distinct numbers from 1 to n leave no room for a duplicate, a gap or a value
  -- that is not a JSON number. A history a raw writer has broken is refused, because
  -- count + 1 would otherwise write a duplicate over it.
  select count(*) into v_generations
  from public.agent_task_events
  where task_id = p_task_id and event_type = 'TASK SUPERSEDED';
  select count(*) into v_well_formed
  from generate_series(1, v_generations) as g
  where (
    select count(*) from public.agent_task_events e
    where e.task_id = p_task_id
      and e.event_type = 'TASK SUPERSEDED'
      and e.payload->'generation' = to_jsonb(g)
  ) = 1;
  if v_well_formed <> v_generations then
    raise exception 'Task % has % TASK SUPERSEDED event(s) whose generations are not exactly 1 to %; refusing until that history is repaired.', p_task_id, v_generations, v_generations
      using errcode = '22023';
  end if;

  -- Idempotence is narrow on purpose: only a card this verb closed and nothing has
  -- moved since, with the same reason and the same replacement, answers "already
  -- done". An ordinary completed card is refused whatever the arguments, including
  -- one that was superseded, reopened and later finished normally (its columns
  -- still describe the old supersede), so this verb can never relabel finished work.
  if v_current.status = 'Agent Done' then
    if v_current.superseded_closed_generation is null then
      raise exception 'Task % is Agent Done and was not superseded; supersede is legal only from Needs Operator, Agent Needs Input or Agent Review.', p_task_id
        using errcode = '22023';
    end if;
    if v_current.superseded_closed_generation <> v_generations then
      raise exception 'Task % says it was closed by supersede generation % but its events end at generation %; refusing until that history is repaired.', p_task_id, v_current.superseded_closed_generation, v_generations
        using errcode = '22023';
    end if;
    if v_current.superseded_reason = v_reason
      and v_current.superseded_by is not distinct from p_superseded_by
    then
      if p_expected_generation is not null and p_expected_generation <> v_generations then
        raise exception 'Task % is closed at supersede generation %, not generation %.', p_task_id, v_generations, p_expected_generation
          using errcode = '22023';
      end if;
      return v_current;
    end if;
    raise exception 'Task % was already superseded with a different reason or replacement.', p_task_id
      using errcode = '22023';
  end if;

  if v_current.status not in ('Needs Operator', 'Agent Needs Input', 'Agent Review') then
    raise exception 'Supersede is legal only from Needs Operator, Agent Needs Input or Agent Review (got %).', v_current.status
      using errcode = '22023';
  end if;

  -- A card that was superseded and reopened is new work. Closing it again takes an
  -- explicit, current generation at every entry point, the bare MCP tool included.
  if v_generations > 0 and p_expected_generation is null then
    raise exception 'Task % was superseded % time(s) and reopened; closing it again requires the expected generation (%).', p_task_id, v_generations, v_generations + 1
      using errcode = '22023';
  end if;
  if p_expected_generation is not null and p_expected_generation <> v_generations + 1 then
    raise exception 'Task % expected supersede generation % but the next generation is %.', p_task_id, p_expected_generation, v_generations + 1
      using errcode = '22023';
  end if;

  if p_superseded_by is not null and not exists (
    select 1 from public.agent_tasks where id = p_superseded_by
  ) then
    raise exception 'Replacement task not found: %', p_superseded_by using errcode = 'P0002';
  end if;

  update public.agent_tasks
  set
    status = 'Agent Done',
    completed_at = now(),
    claimed_at = null,
    claimed_by = null,
    claim_expires_at = null,
    claim_token = null,
    blocked_reason = null,
    superseded_by = p_superseded_by,
    superseded_reason = v_reason,
    superseded_at = now(),
    superseded_actor = v_actor,
    superseded_closed_generation = v_generations + 1,
    updated_at = now()
  where id = p_task_id
  returning * into v_task;

  -- agent_code is the card's claimed_by exactly as stored, null included (always
  -- null from Needs Operator, where the status writer has cleared the claim). It
  -- is a foreign key to the ledger and cannot hold 'operator', which is why the
  -- actor lives in the payload.
  insert into public.agent_task_events (task_id, event_type, agent_code, payload)
  values (
    p_task_id,
    'TASK SUPERSEDED',
    v_current.claimed_by,
    jsonb_build_object(
      'status', 'Agent Done',
      'from_status', v_current.status,
      'resolution', 'superseded',
      'generation', v_generations + 1,
      'reason', v_reason,
      'superseded_by', p_superseded_by,
      'actor', v_actor,
      'actor_source', 'mcp-shared-key',
      'linked_action_item_id', v_current.linked_action_item_id,
      'linked_action_item_outcome', 'not_touched'
    )
  );

  return v_task;
end;
$$;

revoke execute on function public.close_agent_task_superseded(uuid, text, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.close_agent_task_superseded(uuid, text, uuid, text, integer)
  to service_role;
