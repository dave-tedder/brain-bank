-- Loop-closing Task 3.6: the ONE proposal review handler. Every proposal-writing
-- task (3.2 archive, 4.1 recheck, 5.1 fragment, 5.2 dedup, 5.3 calendar) is
-- reviewed through this function, from Slack (`keep <id>`, `archive <id>`,
-- `done <id>`, `done <id> <decision-id>`) and from the MCP tool review_proposal.
-- The plan's Task 3.6 section is the specification; the comments below name the
-- rules this body implements, not their history.
--
-- Depends on: 20261105_auto_resolve_decisions.sql (layers, outcomes, review_seq,
-- the review_seq CHECK), 20261106_action_items_close_reason.sql
-- (transition_action_item, reopen_generation, the item_generation stamp) and
-- 20261109a_action_items_archive_proposals.sql (the three archive_* columns).
--
-- Rules, in the order the body applies them:
--   * Authentication is the transport's. The actor is recorded, never treated as
--     authorization: slack-signature actors are `slack:<user>` (bound by Slack's
--     signature), mcp-shared-key actors are `operator` or a ledger agent_code
--     (claimed by the caller). reviewed_by and the 3.1 event actor are the same
--     string; actor_source goes into the event payload.
--   * keep/archive with a decision id is refused before any other work. A
--     decision id is "supplied" whenever it is non-null: '' and whitespace are
--     supplied (refused on keep/archive, malformed on done), never read as absent.
--   * The item row is locked FOR UPDATE, then the current generation's proposal
--     rows in id order. The current generation is item_generation =
--     reopen_generation; earlier generations are history and never pending.
--   * review_seq is assigned AFTER the lock: 1 + the item's max over every
--     generation. The latest review of the current generation is the rows sharing
--     its greatest review_seq. reviewed_at decides nothing.
--   * A decision ref is resolved first, under the lock, against the current
--     generation's pending evidence rows plus the latest review's rows.
--   * Closed item: same verb as the latest review is `already recorded`;
--     anything else is refused with the restore hint.
--   * Open/deferred item: an empty pending set answers from the latest review of
--     this generation, or `nothing pending`; otherwise the verb acts on the
--     pending rows per the per-layer table.
--   * The status write is transition_action_item inside this function; a zero-row
--     result raises, so the decision update rolls back with it.

-- The item reference, resolved OUTSIDE the review lock (the plan keeps item lookup
-- out of the lock; review_proposal re-checks under it). Returns the description
-- too, so the reply can quote it without a second round trip.
create or replace function public.resolve_proposal_item(p_ref text)
returns table (item_id uuid, description text)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_ref text := lower(trim(coalesce(p_ref, '')));
begin
  -- Branching in plpgsql rather than a CASE in one SQL statement: a constant
  -- `v_ref::uuid` inside a CASE can be folded at plan time and raise on a short id.
  if v_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return query
      select distinct a.id, a.description
      from public.auto_resolve_decisions d
      join public.action_items a on a.id = d.item_id
      where d.item_id = v_ref::uuid
        and d.layer in ('archive', 'fragment', 'recheck', 'dedup', 'calendar')
        and d.outcome in ('proposed', 'kept', 'accepted');
  elsif v_ref ~ '^[0-9a-f]{8}$' then
    return query
      select distinct a.id, a.description
      from public.auto_resolve_decisions d
      join public.action_items a on a.id = d.item_id
      where left(d.item_id::text, 8) = v_ref
        and d.layer in ('archive', 'fragment', 'recheck', 'dedup', 'calendar')
        and d.outcome in ('proposed', 'kept', 'accepted');
  end if;
end;
$$;

revoke execute on function public.resolve_proposal_item(text) from public, anon, authenticated;
grant execute on function public.resolve_proposal_item(text) to service_role;

create or replace function public.review_proposal(
  p_item_id uuid,
  p_verb text,
  p_actor text,
  p_actor_source text,
  p_decision_ref text default null
)
returns table (status text, message text, decision_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  c_full constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  c_short constant text := '^[0-9a-f]{8}$';
  c_layers constant text[] := array['archive', 'fragment', 'recheck', 'dedup', 'calendar'];
  c_evidence constant text[] := array['recheck', 'dedup', 'calendar'];
  v_verb text := lower(trim(coalesce(p_verb, '')));
  v_actor text := nullif(trim(coalesce(p_actor, '')), '');
  -- NULL is "no decision id"; any non-null value, however blank, was SUPPLIED and
  -- is judged as supplied (never normalized to NULL first). [[:space:]] strips tabs
  -- and newlines too, which trim() alone does not.
  v_ref_supplied constant boolean := p_decision_ref is not null;
  v_ref text := lower(regexp_replace(p_decision_ref, '^[[:space:]]+|[[:space:]]+$', '', 'g'));
  v_item public.action_items;
  v_short text;
  v_gen integer;
  v_latest_seq integer;
  v_latest_verb text;
  v_latest_at timestamptz;
  v_dec public.auto_resolve_decisions;
  v_matches integer;
  v_pending integer;
  v_seq integer;
  v_ids uuid[];
  v_has_archive boolean;
  v_has_fragment boolean;
  v_close_reason text;
  v_affected integer;
  v_list text;
  v_survivor_status text;
  v_payload jsonb;
begin
  if v_verb not in ('keep', 'archive', 'done') then
    raise exception 'Unknown review verb: %', p_verb using errcode = '22023';
  end if;
  if v_actor is null then
    raise exception 'review_proposal requires an actor.' using errcode = '22023';
  end if;
  if p_actor_source = 'slack-signature' then
    if v_actor !~ '^slack:[A-Z0-9]+$' then
      raise exception 'A slack-signature actor must be slack:<user id> (got %).', v_actor
        using errcode = '22023';
    end if;
  elsif p_actor_source = 'mcp-shared-key' then
    if v_actor <> 'operator' and not exists (
      select 1 from public.agent_task_ledger l where l.agent_code = v_actor
    ) then
      raise exception 'Actor % is neither operator nor a registered agent_code.', v_actor
        using errcode = '22023';
    end if;
  else
    raise exception 'Unknown actor source: %', p_actor_source using errcode = '22023';
  end if;

  -- From every entry point, before any reference or status work. Any supplied
  -- decision id on keep/archive is refused, including '' and whitespace; on done a
  -- supplied-but-empty one is malformed, never "pick the only pending row".
  if v_ref_supplied and v_verb <> 'done' then
    return query select 'refused'::text, 'keep and archive take no decision id'::text, null::uuid;
    return;
  end if;
  if v_ref_supplied and v_ref = '' then
    return query select 'refused'::text,
      'empty decision id; use the full id or its first 8 characters, or leave it out'::text, null::uuid;
    return;
  end if;
  if v_ref is not null and v_ref !~ c_full and v_ref !~ c_short then
    return query select 'refused'::text,
      format('%s is not a decision id; use the full id or its first 8 characters', p_decision_ref),
      null::uuid;
    return;
  end if;

  select * into v_item from public.action_items a where a.id = p_item_id for update;
  if not found or not exists (
    select 1 from public.auto_resolve_decisions d
    where d.item_id = p_item_id and d.layer = any(c_layers)
      and d.outcome in ('proposed', 'kept', 'accepted')
  ) then
    return query select 'not_found'::text,
      format('no proposal on record for %s', left(p_item_id::text, 8)), null::uuid;
    return;
  end if;
  v_short := left(v_item.id::text, 8);
  v_gen := v_item.reopen_generation;

  perform 1 from public.auto_resolve_decisions d
  where d.item_id = p_item_id and d.layer = any(c_layers) and d.item_generation = v_gen
  order by d.id
  for update;

  -- The latest review of this generation: the rows sharing its greatest review_seq.
  select max(d.review_seq) into v_latest_seq
  from public.auto_resolve_decisions d
  where d.item_id = p_item_id and d.item_generation = v_gen and d.review_seq is not null;
  if v_latest_seq is not null then
    select
      min(case when d.outcome = 'kept' then 'keep'
               when d.layer in ('archive', 'fragment') then 'archive'
               else 'done' end),
      max(d.reviewed_at)
    into v_latest_verb, v_latest_at
    from public.auto_resolve_decisions d
    where d.item_id = p_item_id and d.item_generation = v_gen and d.review_seq = v_latest_seq;
  end if;

  -- The decision ref: resolved first, under the lock, against the pending
  -- evidence rows and the latest review's rows together.
  if v_ref is not null then
    select count(*) into v_matches
    from public.auto_resolve_decisions d
    where d.item_id = p_item_id and d.item_generation = v_gen
      and ((d.layer = any(c_evidence) and d.outcome = 'proposed')
           or (v_latest_seq is not null and d.review_seq = v_latest_seq))
      and (case when v_ref ~ c_full then d.id::text = v_ref else left(d.id::text, 8) = v_ref end);
    if v_matches >= 2 then
      return query select 'ambiguous'::text, 'ambiguous, use the full decision id'::text, null::uuid;
      return;
    end if;
    if v_matches = 0 then
      if v_ref ~ c_full and v_latest_seq is not null then
        select * into v_dec from public.auto_resolve_decisions d
        where d.id::text = v_ref and d.item_id = p_item_id and d.item_generation = v_gen
          and d.review_seq is not null and d.review_seq < v_latest_seq;
        if found then
          return query select 'refused'::text,
            format('%s already reviewed (%s %s); nothing pending',
              left(v_dec.id::text, 8),
              case when v_dec.outcome = 'kept' then 'keep'
                   when v_dec.layer in ('archive', 'fragment') then 'archive'
                   else 'done' end,
              to_char(v_dec.reviewed_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"')),
            null::uuid;
          return;
        end if;
      end if;
      return query select 'not_found'::text,
        format('no pending decision %s on %s', v_ref, v_short), null::uuid;
      return;
    end if;
    select * into v_dec
    from public.auto_resolve_decisions d
    where d.item_id = p_item_id and d.item_generation = v_gen
      and ((d.layer = any(c_evidence) and d.outcome = 'proposed')
           or (v_latest_seq is not null and d.review_seq = v_latest_seq))
      and (case when v_ref ~ c_full then d.id::text = v_ref else left(d.id::text, 8) = v_ref end);
  end if;

  -- (1) Closed item.
  if v_item.status in ('resolved', 'archived') then
    if v_latest_seq is not null and v_verb = v_latest_verb
      and (v_dec.id is null or v_dec.review_seq = v_latest_seq)
    then
      return query select 'already_recorded'::text,
        format('already recorded %s', to_char(v_latest_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"')),
        v_dec.id;
      return;
    end if;
    return query select 'refused'::text,
      format('%s is %s since %s; restore_action_item is the undo', v_short, v_item.status,
        coalesce(to_char(v_item.closed_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'), 'an unknown time')),
      null::uuid;
    return;
  end if;

  -- (2) Open or deferred item. A ref that named a row of the latest review.
  if v_dec.id is not null and v_dec.outcome <> 'proposed' then
    if v_verb = v_latest_verb then
      return query select 'already_recorded'::text,
        format('already recorded %s', to_char(v_latest_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"')),
        v_dec.id;
      return;
    end if;
    return query select 'refused'::text,
      format('%s is %s; last proposal %s %s; nothing pending to %s', v_short, v_item.status,
        case v_latest_verb when 'keep' then 'kept' when 'archive' then 'archived' else 'done' end,
        to_char(v_latest_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'), v_verb),
      null::uuid;
    return;
  end if;

  select count(*) into v_pending
  from public.auto_resolve_decisions d
  where d.item_id = p_item_id and d.item_generation = v_gen
    and d.layer = any(c_layers) and d.outcome = 'proposed';

  if v_pending = 0 then
    if v_latest_seq is not null then
      if v_verb = v_latest_verb then
        return query select 'already_recorded'::text,
          format('already recorded %s', to_char(v_latest_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"')),
          null::uuid;
        return;
      end if;
      return query select 'refused'::text,
        format('%s is %s; last proposal %s %s; nothing pending to %s', v_short, v_item.status,
          case v_latest_verb when 'keep' then 'kept' when 'archive' then 'archived' else 'done' end,
          to_char(v_latest_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'), v_verb),
        null::uuid;
      return;
    end if;
    return query select 'nothing_pending'::text, format('nothing pending on %s', v_short), null::uuid;
    return;
  end if;

  v_seq := 1 + coalesce((
    select max(d.review_seq) from public.auto_resolve_decisions d where d.item_id = p_item_id
  ), 0);

  -- keep: every pending row of the item at once.
  if v_verb = 'keep' then
    select bool_or(d.layer = 'archive') into v_has_archive
    from public.auto_resolve_decisions d
    where d.item_id = p_item_id and d.item_generation = v_gen
      and d.layer = any(c_layers) and d.outcome = 'proposed';

    update public.auto_resolve_decisions d
    set outcome = 'kept', review_seq = v_seq, reviewed_at = now(), reviewed_by = v_actor
    where d.item_id = p_item_id and d.item_generation = v_gen
      and d.layer = any(c_layers) and d.outcome = 'proposed';
    get diagnostics v_affected = row_count;

    if v_has_archive then
      update public.action_items a
      set archive_review_outcome = 'kept', archive_reviewed_at = now()
      where a.id = p_item_id;
    end if;

    return query select 'recorded'::text,
      format('kept %s on %s (%s proposal%s)', v_short, v_item.status, v_affected,
        case when v_affected = 1 then '' else 's' end),
      null::uuid;
    return;
  end if;

  -- archive: the pending archive and fragment rows together.
  if v_verb = 'archive' then
    select bool_or(d.layer = 'archive'), bool_or(d.layer = 'fragment')
    into v_has_archive, v_has_fragment
    from public.auto_resolve_decisions d
    where d.item_id = p_item_id and d.item_generation = v_gen
      and d.layer in ('archive', 'fragment') and d.outcome = 'proposed';
    if not coalesce(v_has_archive, false) and not coalesce(v_has_fragment, false) then
      return query select 'refused'::text, 'no archive proposal; reply done or keep'::text, null::uuid;
      return;
    end if;

    with accepted as (
      update public.auto_resolve_decisions d
      set outcome = 'accepted', review_seq = v_seq, reviewed_at = now(), reviewed_by = v_actor
      where d.item_id = p_item_id and d.item_generation = v_gen
        and d.layer in ('archive', 'fragment') and d.outcome = 'proposed'
      returning d.id
    )
    select array_agg(accepted.id order by accepted.id) into v_ids from accepted;

    if v_has_archive then
      update public.action_items a
      set archive_review_outcome = 'accepted', archive_reviewed_at = now()
      where a.id = p_item_id;
    end if;

    -- The more specific defect wins when both are pending.
    v_close_reason := case when v_has_fragment then 'fragment' else 'expired' end;
    v_affected := public.transition_action_item(
      p_item_id, array['open', 'deferred'], 'archived', v_actor,
      v_close_reason,
      format('review: archive %s', (select string_agg(left(x::text, 8), ' ') from unnest(v_ids) x)),
      null, null, null, null,
      jsonb_build_object('actor_source', p_actor_source, 'decision_ids', to_jsonb(v_ids))
    );
    if v_affected <> 1 then
      raise exception 'review_proposal: the archive transition of % wrote % rows.', p_item_id, v_affected
        using errcode = 'P0001';
    end if;

    return query select 'recorded'::text,
      format('archived %s (%s)', v_short, v_close_reason), null::uuid;
    return;
  end if;

  -- done: exactly one pending evidence row, named or the only one.
  if v_item.status <> 'open' then
    return query select 'refused'::text,
      format('%s is %s; done needs an open item', v_short, v_item.status), null::uuid;
    return;
  end if;

  if v_dec.id is null then
    select count(*) into v_matches
    from public.auto_resolve_decisions d
    where d.item_id = p_item_id and d.item_generation = v_gen
      and d.layer = any(c_evidence) and d.outcome = 'proposed';
    if v_matches = 0 then
      return query select 'refused'::text, 'reply archive or keep'::text, null::uuid;
      return;
    end if;
    if v_matches >= 2 then
      select string_agg(
        case d.layer
          when 'recheck' then format('%s recheck "%s"', left(d.id::text, 8), left(coalesce(d.quote, ''), 80))
          when 'dedup' then format('%s dedup of %s', left(d.id::text, 8), left(d.related_item_id::text, 8))
          else format('%s calendar %s', left(d.id::text, 8), coalesce(e.title, left(d.evidence_event_id::text, 8)))
        end, '; ' order by d.id)
      into v_list
      from public.auto_resolve_decisions d
      left join public.business_events e on e.id = d.evidence_event_id
      where d.item_id = p_item_id and d.item_generation = v_gen
        and d.layer = any(c_evidence) and d.outcome = 'proposed';
      return query select 'needs_decision'::text,
        format('%s has %s pending: %s. Reply done %s <decision id>', v_short, v_matches, v_list, v_short),
        null::uuid;
      return;
    end if;
    select * into v_dec
    from public.auto_resolve_decisions d
    where d.item_id = p_item_id and d.item_generation = v_gen
      and d.layer = any(c_evidence) and d.outcome = 'proposed';
  end if;

  if v_dec.layer = 'dedup' then
    select a.status into v_survivor_status from public.action_items a where a.id = v_dec.related_item_id;
    if v_survivor_status = 'archived' then
      return query select 'refused'::text,
        format('survivor %s is %s', left(v_dec.related_item_id::text, 8), v_survivor_status), null::uuid;
      return;
    end if;
  end if;

  update public.auto_resolve_decisions d
  set outcome = 'accepted', review_seq = v_seq, reviewed_at = now(), reviewed_by = v_actor
  where d.id = v_dec.id;

  v_payload := jsonb_build_object('actor_source', p_actor_source, 'decision_id', v_dec.id);
  if v_dec.layer = 'recheck' then
    v_affected := public.transition_action_item(
      p_item_id, array['open'], 'resolved', v_actor, 'done',
      format('review: recheck %s', left(v_dec.id::text, 8)),
      v_dec.evidence_thought_id, v_dec.evidence_thought_id, null, null, v_payload);
  elsif v_dec.layer = 'calendar' then
    v_affected := public.transition_action_item(
      p_item_id, array['open'], 'resolved', v_actor, 'done',
      format('review: calendar %s', left(v_dec.id::text, 8)),
      null, null, null, null,
      v_payload || jsonb_build_object('evidence_event_id', v_dec.evidence_event_id));
  else
    v_affected := public.transition_action_item(
      p_item_id, array['open'], 'archived', v_actor, 'duplicate',
      format('review: dedup %s', left(v_dec.id::text, 8)),
      null, null, v_dec.related_item_id, null, v_payload);
  end if;
  if v_affected <> 1 then
    raise exception 'review_proposal: the done transition of % wrote % rows.', p_item_id, v_affected
      using errcode = 'P0001';
  end if;

  return query select 'recorded'::text,
    format('%s %s (%s %s)', case when v_dec.layer = 'dedup' then 'archived' else 'resolved' end,
      v_short, v_dec.layer, left(v_dec.id::text, 8)),
    v_dec.id;
end;
$$;

revoke execute on function public.review_proposal(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.review_proposal(uuid, text, text, text, text)
  to service_role;
