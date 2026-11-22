-- Loop-closing Task 3.6 (and 3.2's schema part): single-connection contract for
-- review_proposal and resolve_proposal_item. Run ONLY by review-proposal-sql-test.sh
-- against a throwaway local cluster. Every check prints PASS <name> or raises
-- FAIL <name>; the last line prints REVIEW PROPOSAL SQL TEST PASSED.
--
-- A DO block is one transaction, so a fixture that needs equal now() values for
-- different reviews (round 15) lives inside one block. Fixtures that need two
-- connections are in the shell script.

\set ON_ERROR_STOP 1
set client_min_messages = notice;

insert into public.thoughts (id) values
  ('e0000000-0000-4000-8000-000000000003'), ('e0000000-0000-4000-8000-000000000004'),
  ('e0000000-0000-4000-8000-000000000005');
insert into public.agent_task_ledger (agent_code) values ('codex');

create function pg_temp.ok(p_name text, p_cond boolean, p_detail text default '')
returns void language plpgsql as $$
begin
  if p_cond is distinct from true then
    raise exception 'FAIL %: %', p_name, p_detail;
  end if;
  raise notice 'PASS %', p_name;
end $$;

create function pg_temp.item(p_id uuid, p_status text default 'open')
returns void language sql as $$
  insert into public.action_items (id, description, status, defer_reason)
  values (p_id, 'item ' || left(p_id::text, 8), p_status,
          case when p_status = 'deferred' then 'pause:test' end)
$$;

-- One proposal row of any layer, with the payload Task 1.4's CHECK demands.
create function pg_temp.prop(p_id uuid, p_item uuid, p_layer text,
  p_related uuid default null,
  p_thought uuid default 'e0000000-0000-4000-8000-000000000002')
returns void language plpgsql as $$
begin
  if p_layer = 'archive' then
    insert into public.auto_resolve_decisions (id, item_id, candidate_description, layer, outcome, reason)
    values (p_id, p_item, 'c', 'archive', 'proposed', 'age_standard');
  elsif p_layer = 'fragment' then
    insert into public.auto_resolve_decisions (id, item_id, thought_id, candidate_description, layer, outcome, reason)
    values (p_id, p_item, 'e0000000-0000-4000-8000-000000000001', 'c', 'fragment', 'proposed', 'pronoun_object');
  elsif p_layer = 'recheck' then
    insert into public.auto_resolve_decisions (id, item_id, evidence_thought_id, quote, score, candidate_description, layer, outcome, reason)
    values (p_id, p_item, p_thought, 'sent the explainer', 0.9, 'c', 'recheck', 'proposed', null);
  elsif p_layer = 'dedup' then
    insert into public.auto_resolve_decisions (id, item_id, related_item_id, score, candidate_description, layer, outcome, reason)
    values (p_id, p_item, p_related, 0.92, 'c', 'dedup', 'proposed', 'semantic_overlap');
  elsif p_layer = 'calendar' then
    insert into public.auto_resolve_decisions (id, item_id, evidence_event_id, quote, candidate_description, layer, outcome, reason)
    values (p_id, p_item, 'b0000000-0000-4000-8000-000000000001', 'Joseph session', 'c', 'calendar', 'proposed', 'booking_match');
  else
    raise exception 'unknown layer %', p_layer;
  end if;
end $$;

create function pg_temp.rp(p_item uuid, p_verb text, p_ref text default null,
  p_actor text default 'operator', p_src text default 'mcp-shared-key')
returns table (status text, message text, decision_id uuid) language sql as $$
  select * from public.review_proposal(p_item, p_verb, p_actor, p_src, p_ref)
$$;

-- The complete business state a review can write: EVERY row of action_items,
-- auto_resolve_decisions and action_item_events, every column (to_jsonb of the
-- row), keyed by the row's full uuid. "Zero writes" is equality of two of these,
-- taken before and after the call, across all items, not just the one reviewed.
-- (PR 23 review F2: the earlier signature serialized a few columns of one item and
-- an event COUNT, so a change to resolution_note, closed_at, an evidence column or
-- an existing event's contents could pass unseen.) The RPC writes no other table;
-- mcp_tool_invocations telemetry is the MCP transport's, outside this function.
create function pg_temp.state()
returns jsonb language sql as $$
  select jsonb_build_object(
    'action_items', coalesce((select jsonb_object_agg(a.id::text, to_jsonb(a)) from public.action_items a), '{}'::jsonb),
    'auto_resolve_decisions', coalesce((select jsonb_object_agg(d.id::text, to_jsonb(d)) from public.auto_resolve_decisions d), '{}'::jsonb),
    'action_item_events', coalesce((select jsonb_object_agg(e.id::text, to_jsonb(e)) from public.action_item_events e), '{}'::jsonb))
$$;

-- Which rows differ between a snapshot and now: "<table>:<full id>", or "none".
create function pg_temp.state_diff(p_before jsonb)
returns text language sql as $$
  with s as (select p_before as b, pg_temp.state() as n),
  k as (
    select t, key from s, unnest(array['action_items', 'auto_resolve_decisions', 'action_item_events']) t,
      lateral (select jsonb_object_keys(s.b -> t) as key union select jsonb_object_keys(s.n -> t)) ks
  )
  select coalesce(string_agg(k.t || ':' || k.key, ', ' order by k.t, k.key), 'none')
  from k, s where (s.b -> k.t -> k.key) is distinct from (s.n -> k.t -> k.key)
$$;

create function pg_temp.unchanged(p_name text, p_before jsonb)
returns void language plpgsql as $$
begin
  perform pg_temp.ok(p_name, pg_temp.state() = p_before, 'rows changed: ' || pg_temp.state_diff(p_before));
end $$;

-- A refusal fixture proves nothing unless the snapshot actually holds the item and
-- the pending rows a wrong write would have touched.
create function pg_temp.live(p_name text, p_before jsonb, p_item uuid, p_pending int)
returns void language plpgsql as $$
begin
  perform pg_temp.ok(p_name || ' (fixture is live)',
    p_before -> 'action_items' ? p_item::text
      and (select count(*) from jsonb_each(p_before -> 'auto_resolve_decisions') d
           where d.value ->> 'item_id' = p_item::text and d.value ->> 'outcome' = 'proposed') = p_pending,
    format('expected item %s with %s proposed rows in the snapshot', p_item, p_pending));
end $$;

-- T01 item reference resolution, outside the lock.
select pg_temp.item('c0010001-0000-4000-8000-000000000000');
select pg_temp.prop('d0010001-0000-4000-8000-000000000000', 'c0010001-0000-4000-8000-000000000000', 'archive');
select pg_temp.item('c0010002-0000-4000-8000-000000000000');
select pg_temp.item('c0010003-0000-4000-8000-000000000000');
insert into public.auto_resolve_decisions (item_id, thought_id, candidate_description, layer, outcome, reason)
values ('c0010003-0000-4000-8000-000000000000', 'e0000000-0000-4000-8000-000000000001', 'c', 'L2', 'dropped', 'not_claimed');
select pg_temp.item('1a2b3c4d-0000-4000-8000-000000000001');
select pg_temp.item('1a2b3c4d-0000-4000-8000-000000000002');
select pg_temp.prop('d0010002-0000-4000-8000-000000000000', '1a2b3c4d-0000-4000-8000-000000000001', 'archive');
select pg_temp.prop('d0010003-0000-4000-8000-000000000000', '1a2b3c4d-0000-4000-8000-000000000002', 'archive');
select pg_temp.ok('T01 full id resolves', (select count(*) = 1 from public.resolve_proposal_item('c0010001-0000-4000-8000-000000000000')));
select pg_temp.ok('T01 short id resolves', (select count(*) = 1 from public.resolve_proposal_item('c0010001')));
select pg_temp.ok('T01 short id is case-insensitive', (select count(*) = 1 from public.resolve_proposal_item('C0010001')));
select pg_temp.ok('T01 ambiguous short id returns both', (select count(*) = 2 from public.resolve_proposal_item('1a2b3c4d')));
select pg_temp.ok('T01 unknown id resolves nothing', (select count(*) = 0 from public.resolve_proposal_item('ffffffff')));
select pg_temp.ok('T01 malformed ref resolves nothing', (select count(*) = 0 from public.resolve_proposal_item('c001000')));
select pg_temp.ok('T01 an item with no proposal row resolves nothing', (select count(*) = 0 from public.resolve_proposal_item('c0010002')));
select pg_temp.ok('T01 a capture-layer decision is not a proposal', (select count(*) = 0 from public.resolve_proposal_item('c0010003')));

-- T02 a reviewed item still resolves.
select pg_temp.item('c0020001-0000-4000-8000-000000000000');
select pg_temp.prop('d0020001-0000-4000-8000-000000000000', 'c0020001-0000-4000-8000-000000000000', 'archive');
select pg_temp.ok('T02 keep recorded', (select status = 'recorded' from pg_temp.rp('c0020001-0000-4000-8000-000000000000', 'keep')));
select pg_temp.ok('T02 a reviewed item still resolves', (select count(*) = 1 from public.resolve_proposal_item('c0020001')));

-- T03 an item closed by another path writes nothing.
do $$
declare r record; s jsonb;
begin
  perform pg_temp.item('c0030001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0030001-0000-4000-8000-000000000000', 'c0030001-0000-4000-8000-000000000000', 'recheck');
  perform public.transition_action_item('c0030001-0000-4000-8000-000000000000', '{open}', 'resolved', 'operator', 'done');
  s := pg_temp.state();
  select * into r from pg_temp.rp('c0030001-0000-4000-8000-000000000000', 'done');
  perform pg_temp.ok('T03 stale item refused with the restore hint',
    r.status = 'refused' and r.message like 'c0030001 is resolved since % UTC; restore_action_item is the undo', r.message);
  perform pg_temp.ok('T03 stale item: zero writes', pg_temp.state() = s);
end $$;

-- T04 keep then keep.
do $$
declare r record; s jsonb;
begin
  perform pg_temp.item('c0040001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0040001-0000-4000-8000-000000000000', 'c0040001-0000-4000-8000-000000000000', 'archive');
  select * into r from pg_temp.rp('c0040001-0000-4000-8000-000000000000', 'keep');
  perform pg_temp.ok('T04 first keep recorded', r.status = 'recorded', r.message);
  perform pg_temp.ok('T04 keep writes the decision row',
    (select outcome = 'kept' and review_seq = 1 and reviewed_by = 'operator' and reviewed_at is not null
     from public.auto_resolve_decisions where id = 'd0040001-0000-4000-8000-000000000000'));
  perform pg_temp.ok('T04 keep on an archive row writes the item columns',
    (select archive_review_outcome = 'kept' and archive_reviewed_at is not null and status = 'open'
     from public.action_items where id = 'c0040001-0000-4000-8000-000000000000'));
  s := pg_temp.state();
  select * into r from pg_temp.rp('c0040001-0000-4000-8000-000000000000', 'keep');
  perform pg_temp.ok('T04 second keep is already recorded', r.status = 'already_recorded' and r.message like 'already recorded % UTC', r.message);
  perform pg_temp.ok('T04 second keep: zero writes', pg_temp.state() = s);
end $$;

-- T05 keep then archive: nothing pending to archive, no restore hint, still open.
do $$
declare r record; s jsonb;
begin
  perform pg_temp.item('c0050001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0050001-0000-4000-8000-000000000000', 'c0050001-0000-4000-8000-000000000000', 'archive');
  perform pg_temp.rp('c0050001-0000-4000-8000-000000000000', 'keep');
  s := pg_temp.state();
  select * into r from pg_temp.rp('c0050001-0000-4000-8000-000000000000', 'archive');
  perform pg_temp.ok('T05 keep then archive refused as nothing pending',
    r.status = 'refused' and r.message like 'c0050001 is open; last proposal kept % UTC; nothing pending to archive'
      and r.message not like '%restore%', r.message);
  perform pg_temp.ok('T05 zero writes, item still open', pg_temp.state() = s);
end $$;

-- T06 a re-proposal in the same generation: keep acts on the new row only.
do $$
declare r record; a_before text;
begin
  perform pg_temp.item('c0060001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0060001-0000-4000-8000-000000000000', 'c0060001-0000-4000-8000-000000000000', 'archive');
  perform pg_temp.rp('c0060001-0000-4000-8000-000000000000', 'keep');
  select outcome || review_seq || reviewed_at::text into a_before from public.auto_resolve_decisions where id = 'd0060001-0000-4000-8000-000000000000';
  -- What Task 3.2's job does after 90 days: clear the item columns, write a new row.
  update public.action_items set archive_proposed_at = now(), archive_review_outcome = null, archive_reviewed_at = null
  where id = 'c0060001-0000-4000-8000-000000000000';
  perform pg_temp.prop('d0060002-0000-4000-8000-000000000000', 'c0060001-0000-4000-8000-000000000000', 'archive');
  select * into r from pg_temp.rp('c0060001-0000-4000-8000-000000000000', 'keep');
  perform pg_temp.ok('T06 keep acts on the re-proposal', r.status = 'recorded'
    and (select outcome = 'kept' and review_seq = 2 from public.auto_resolve_decisions where id = 'd0060002-0000-4000-8000-000000000000'), r.message);
  perform pg_temp.ok('T06 the old kept row is untouched',
    (select outcome || review_seq || reviewed_at::text from public.auto_resolve_decisions where id = 'd0060001-0000-4000-8000-000000000000') = a_before);
  perform pg_temp.ok('T06 item columns kept again',
    (select archive_review_outcome = 'kept' from public.action_items where id = 'c0060001-0000-4000-8000-000000000000'));
end $$;

-- T07 archive on an archive proposal, Slack actor.
do $$
declare r record;
begin
  perform pg_temp.item('c0070001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0070001-0000-4000-8000-000000000000', 'c0070001-0000-4000-8000-000000000000', 'archive');
  select * into r from pg_temp.rp('c0070001-0000-4000-8000-000000000000', 'archive', null, 'slack:U123ABC', 'slack-signature');
  perform pg_temp.ok('T07 archive recorded', r.status = 'recorded' and r.message = 'archived c0070001 (expired)', r.message);
  perform pg_temp.ok('T07 item archived with the review columns',
    (select status = 'archived' and close_reason = 'expired' and archive_review_outcome = 'accepted' and archive_reviewed_at is not null
     from public.action_items where id = 'c0070001-0000-4000-8000-000000000000'));
  perform pg_temp.ok('T07 decision accepted by the Slack actor',
    (select outcome = 'accepted' and reviewed_by = 'slack:U123ABC' and review_seq = 1
     from public.auto_resolve_decisions where id = 'd0070001-0000-4000-8000-000000000000'));
  perform pg_temp.ok('T07 the 3.1 close event carries the actor and its source',
    (select count(*) = 1 from public.action_item_events
     where item_id = 'c0070001-0000-4000-8000-000000000000' and actor = 'slack:U123ABC'
       and new_status = 'archived' and close_reason = 'expired'
       and payload->>'actor_source' = 'slack-signature'
       and payload->'decision_ids' ? 'd0070001-0000-4000-8000-000000000000'));
end $$;

-- T08 archive on a fragment proposal.
do $$
declare r record;
begin
  perform pg_temp.item('c0080001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0080001-0000-4000-8000-000000000000', 'c0080001-0000-4000-8000-000000000000', 'fragment');
  select * into r from pg_temp.rp('c0080001-0000-4000-8000-000000000000', 'archive');
  perform pg_temp.ok('T08 fragment archive closes as fragment',
    r.status = 'recorded' and (select close_reason = 'fragment' and archive_review_outcome is null
      from public.action_items where id = 'c0080001-0000-4000-8000-000000000000'), r.message);
end $$;

-- T09 archive on a recheck-only item.
do $$
declare r record; s jsonb;
begin
  perform pg_temp.item('c0090001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0090001-0000-4000-8000-000000000000', 'c0090001-0000-4000-8000-000000000000', 'recheck');
  s := pg_temp.state();
  select * into r from pg_temp.rp('c0090001-0000-4000-8000-000000000000', 'archive');
  perform pg_temp.ok('T09 archive on recheck-only refused',
    r.status = 'refused' and r.message = 'no archive proposal; reply done or keep'
      and pg_temp.state() = s, r.message);
end $$;

-- T10 done on a recheck proposal.
do $$
declare r record;
begin
  perform pg_temp.item('c0100001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0100001-0000-4000-8000-000000000000', 'c0100001-0000-4000-8000-000000000000', 'recheck');
  select * into r from pg_temp.rp('c0100001-0000-4000-8000-000000000000', 'done');
  perform pg_temp.ok('T10 recheck done recorded', r.status = 'recorded'
    and r.decision_id = 'd0100001-0000-4000-8000-000000000000', r.message);
  perform pg_temp.ok('T10 resolved_by_thought_id is the evidence thought',
    (select status = 'resolved' and close_reason = 'done'
       and resolved_by_thought_id = 'e0000000-0000-4000-8000-000000000002'
       and resolution_note = 'review: recheck d0100001'
     from public.action_items where id = 'c0100001-0000-4000-8000-000000000000'));
  perform pg_temp.ok('T10 the close event carries the evidence and the MCP actor source',
    (select count(*) = 1 from public.action_item_events
     where item_id = 'c0100001-0000-4000-8000-000000000000' and actor = 'operator'
       and evidence_thought_id = 'e0000000-0000-4000-8000-000000000002'
       and payload->>'actor_source' = 'mcp-shared-key'
       and payload->>'decision_id' = 'd0100001-0000-4000-8000-000000000000'));
end $$;

-- T11 done on a calendar proposal.
do $$
declare r record;
begin
  perform pg_temp.item('c0110001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0110001-0000-4000-8000-000000000000', 'c0110001-0000-4000-8000-000000000000', 'calendar');
  select * into r from pg_temp.rp('c0110001-0000-4000-8000-000000000000', 'done');
  perform pg_temp.ok('T11 calendar done resolves with no resolver thought',
    r.status = 'recorded' and (select status = 'resolved' and resolved_by_thought_id is null
      from public.action_items where id = 'c0110001-0000-4000-8000-000000000000'), r.message);
  perform pg_temp.ok('T11 evidence_event_id is in the close event payload',
    (select count(*) = 1 from public.action_item_events
     where item_id = 'c0110001-0000-4000-8000-000000000000'
       and payload->>'evidence_event_id' = 'b0000000-0000-4000-8000-000000000001'));
end $$;

-- T12 done on a dedup proposal; refused when the survivor is archived.
do $$
declare r record; s jsonb;
begin
  perform pg_temp.item('c0120002-0000-4000-8000-000000000000');
  perform pg_temp.item('c0120001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0120001-0000-4000-8000-000000000000', 'c0120001-0000-4000-8000-000000000000', 'dedup', 'c0120002-0000-4000-8000-000000000000');
  select * into r from pg_temp.rp('c0120001-0000-4000-8000-000000000000', 'done');
  perform pg_temp.ok('T12 dedup done archives as a duplicate of the survivor',
    r.status = 'recorded' and (select status = 'archived' and close_reason = 'duplicate'
      and duplicate_of = 'c0120002-0000-4000-8000-000000000000'
      from public.action_items where id = 'c0120001-0000-4000-8000-000000000000'), r.message);
  perform pg_temp.item('c0120003-0000-4000-8000-000000000000', 'archived');
  perform pg_temp.item('c0120004-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0120002-0000-4000-8000-000000000000', 'c0120004-0000-4000-8000-000000000000', 'dedup', 'c0120003-0000-4000-8000-000000000000');
  s := pg_temp.state();
  select * into r from pg_temp.rp('c0120004-0000-4000-8000-000000000000', 'done');
  perform pg_temp.ok('T12 an archived survivor is refused with zero writes',
    r.status = 'refused' and r.message = 'survivor c0120003 is archived'
      and pg_temp.state() = s, r.message);
end $$;

-- T13 done on archive-only and fragment-only items.
do $$
declare r record; s jsonb;
begin
  perform pg_temp.item('c0130001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0130001-0000-4000-8000-000000000000', 'c0130001-0000-4000-8000-000000000000', 'archive');
  perform pg_temp.item('c0130002-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0130002-0000-4000-8000-000000000000', 'c0130002-0000-4000-8000-000000000000', 'fragment');
  s := pg_temp.state();
  perform pg_temp.live('T13 archive-only', s, 'c0130001-0000-4000-8000-000000000000', 1);
  select * into r from pg_temp.rp('c0130001-0000-4000-8000-000000000000', 'done');
  perform pg_temp.ok('T13 done on archive-only refused', r.status = 'refused' and r.message = 'reply archive or keep', r.message);
  perform pg_temp.unchanged('T13 done on archive-only: zero business writes', s);
  select * into r from pg_temp.rp('c0130002-0000-4000-8000-000000000000', 'done');
  perform pg_temp.ok('T13 done on fragment-only refused', r.status = 'refused' and r.message = 'reply archive or keep', r.message);
  perform pg_temp.unchanged('T13 done on fragment-only: zero business writes', s);
end $$;

-- T14 two pending evidence rows; a selective done; retries; T15 restore.
do $$
declare r record; s jsonb;
begin
  perform pg_temp.item('c0140002-0000-4000-8000-000000000000');
  perform pg_temp.item('c0140001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0140001-0000-4000-8000-000000000000', 'c0140001-0000-4000-8000-000000000000', 'recheck');
  perform pg_temp.prop('d0140002-0000-4000-8000-000000000000', 'c0140001-0000-4000-8000-000000000000', 'dedup', 'c0140002-0000-4000-8000-000000000000');
  s := pg_temp.state();
  select * into r from pg_temp.rp('c0140001-0000-4000-8000-000000000000', 'done');
  perform pg_temp.ok('T14 done with two evidence rows lists both and writes nothing',
    r.status = 'needs_decision' and r.message like '%d0140001 recheck "sent the explainer"%'
      and r.message like '%d0140002 dedup of c0140002%' and r.message like '%Reply done c0140001 <decision id>'
      and pg_temp.state() = s, r.message);
  select * into r from pg_temp.rp('c0140001-0000-4000-8000-000000000000', 'done', 'd0140002');
  perform pg_temp.ok('T14 done with a decision id accepts that row only',
    r.status = 'recorded' and r.decision_id = 'd0140002-0000-4000-8000-000000000000'
      and (select outcome from public.auto_resolve_decisions where id = 'd0140001-0000-4000-8000-000000000000') = 'proposed'
      and (select close_reason from public.action_items where id = 'c0140001-0000-4000-8000-000000000000') = 'duplicate', r.message);
  s := pg_temp.state();
  select * into r from pg_temp.rp('c0140001-0000-4000-8000-000000000000', 'done', 'd0140002-0000-4000-8000-000000000000');
  perform pg_temp.ok('T14 the same done retried by full id is already recorded',
    r.status = 'already_recorded' and pg_temp.state() = s
      and (select outcome from public.auto_resolve_decisions where id = 'd0140001-0000-4000-8000-000000000000') = 'proposed', r.message);
  select * into r from pg_temp.rp('c0140001-0000-4000-8000-000000000000', 'done', 'd0140002');
  perform pg_temp.ok('T14 retried by short id is already recorded', r.status = 'already_recorded', r.message);
  select * into r from pg_temp.rp('c0140001-0000-4000-8000-000000000000', 'done', 'd0140001-0000-4000-8000-000000000000');
  perform pg_temp.ok('T14 done of the leftover sibling on the closed item is the restore refusal',
    r.status = 'refused' and r.message like '%restore_action_item is the undo'
      and pg_temp.state() = s, r.message);

  perform public.transition_action_item('c0140001-0000-4000-8000-000000000000', '{archived}', 'open', 'operator');
  s := pg_temp.state();
  select * into r from pg_temp.rp('c0140001-0000-4000-8000-000000000000', 'done', 'd0140002');
  perform pg_temp.ok('T15 after a restore the old decision is no pending decision',
    r.status = 'not_found' and r.message = 'no pending decision d0140002 on c0140001', r.message);
  select * into r from pg_temp.rp('c0140001-0000-4000-8000-000000000000', 'done');
  perform pg_temp.ok('T15 after a restore nothing is pending', r.status = 'nothing_pending' and r.message = 'nothing pending on c0140001', r.message);
  perform pg_temp.ok('T15 the pending view reads only the new generation',
    (select count(*) = 0 from public.auto_resolve_decisions d join public.action_items a on a.id = d.item_id
     where d.item_id = 'c0140001-0000-4000-8000-000000000000' and d.outcome = 'proposed'
       and d.item_generation = a.reopen_generation)
    and (select count(*) = 1 from public.auto_resolve_decisions d
     where d.item_id = 'c0140001-0000-4000-8000-000000000000' and d.outcome = 'proposed'));
  perform pg_temp.ok('T15 zero writes', pg_temp.state() = s);
end $$;

-- T16 a decision id from another item.
do $$
declare r record; s jsonb;
begin
  perform pg_temp.item('c0160001-0000-4000-8000-000000000000');
  perform pg_temp.item('c0160002-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0160001-0000-4000-8000-000000000000', 'c0160001-0000-4000-8000-000000000000', 'recheck');
  perform pg_temp.prop('d0160002-0000-4000-8000-000000000000', 'c0160002-0000-4000-8000-000000000000', 'recheck');
  s := pg_temp.state();
  select * into r from pg_temp.rp('c0160001-0000-4000-8000-000000000000', 'done', 'd0160002');
  perform pg_temp.ok('T16 a foreign short decision id is refused', r.status = 'not_found', r.message);
  select * into r from pg_temp.rp('c0160001-0000-4000-8000-000000000000', 'done', 'd0160002-0000-4000-8000-000000000000');
  perform pg_temp.ok('T16 a foreign full decision id is refused', r.status = 'not_found', r.message);
  perform pg_temp.ok('T16 zero writes', pg_temp.state() = s);
end $$;

-- T17 an 8-hex decision id matching two pending rows.
do $$
declare r record; s jsonb;
begin
  perform pg_temp.item('c0170002-0000-4000-8000-000000000000');
  perform pg_temp.item('c0170001-0000-4000-8000-000000000000');
  perform pg_temp.prop('abcd1234-0000-4000-8000-000000000001', 'c0170001-0000-4000-8000-000000000000', 'recheck');
  perform pg_temp.prop('abcd1234-0000-4000-8000-000000000002', 'c0170001-0000-4000-8000-000000000000', 'dedup', 'c0170002-0000-4000-8000-000000000000');
  s := pg_temp.state();
  select * into r from pg_temp.rp('c0170001-0000-4000-8000-000000000000', 'done', 'abcd1234');
  perform pg_temp.ok('T17 an ambiguous decision short id is refused with zero writes',
    r.status = 'ambiguous' and r.message = 'ambiguous, use the full decision id'
      and pg_temp.state() = s, r.message);
  select * into r from pg_temp.rp('c0170001-0000-4000-8000-000000000000', 'done', 'abcd1234-0000-4000-8000-000000000001');
  perform pg_temp.ok('T17 the full id still resolves', r.status = 'recorded'
    and r.decision_id = 'abcd1234-0000-4000-8000-000000000001', r.message);
end $$;

-- T18 archive with both an archive and a fragment row pending.
do $$
declare r record;
begin
  perform pg_temp.item('c0180001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0180001-0000-4000-8000-000000000000', 'c0180001-0000-4000-8000-000000000000', 'archive');
  perform pg_temp.prop('d0180002-0000-4000-8000-000000000000', 'c0180001-0000-4000-8000-000000000000', 'fragment');
  select * into r from pg_temp.rp('c0180001-0000-4000-8000-000000000000', 'archive');
  perform pg_temp.ok('T18 the mixed pair closes as fragment', r.status = 'recorded'
    and (select close_reason = 'fragment' and archive_review_outcome = 'accepted'
         from public.action_items where id = 'c0180001-0000-4000-8000-000000000000'), r.message);
  perform pg_temp.ok('T18 both rows accepted in one review',
    (select count(*) = 2 and count(distinct review_seq) = 1 and bool_and(outcome = 'accepted')
     from public.auto_resolve_decisions where item_id = 'c0180001-0000-4000-8000-000000000000'));
end $$;

-- T19 actor validation.
do $$
declare v_msg text; s jsonb;
begin
  perform pg_temp.item('c0190001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0190001-0000-4000-8000-000000000000', 'c0190001-0000-4000-8000-000000000000', 'archive');
  s := pg_temp.state();
  begin
    perform pg_temp.rp('c0190001-0000-4000-8000-000000000000', 'keep', null, 'slack:', 'slack-signature');
    v_msg := 'accepted';
  exception when others then v_msg := sqlerrm; end;
  perform pg_temp.ok('T19 a Slack actor with no user id is refused', v_msg like 'A slack-signature actor must be%', v_msg);
  begin
    perform pg_temp.rp('c0190001-0000-4000-8000-000000000000', 'keep', null, 'operator', 'slack-signature');
    v_msg := 'accepted';
  exception when others then v_msg := sqlerrm; end;
  perform pg_temp.ok('T19 operator cannot claim the Slack source', v_msg like 'A slack-signature actor must be%', v_msg);
  begin
    perform pg_temp.rp('c0190001-0000-4000-8000-000000000000', 'keep', null, 'mallory', 'mcp-shared-key');
    v_msg := 'accepted';
  exception when others then v_msg := sqlerrm; end;
  perform pg_temp.ok('T19 an MCP actor that is neither operator nor a ledger code is refused', v_msg like 'Actor mallory is neither%', v_msg);
  begin
    perform pg_temp.rp('c0190001-0000-4000-8000-000000000000', 'keep', null, 'operator', 'header');
    v_msg := 'accepted';
  exception when others then v_msg := sqlerrm; end;
  perform pg_temp.ok('T19 an unknown actor source is refused', v_msg like 'Unknown actor source%', v_msg);
  perform pg_temp.ok('T19 refusals wrote nothing',
    (select outcome = 'proposed' from public.auto_resolve_decisions where id = 'd0190001-0000-4000-8000-000000000000'));
  perform pg_temp.unchanged('T19 actor refusals: zero business writes', s);
  -- Two statements: a subquery in the same statement as the call reads the
  -- statement's snapshot and would not see the call's write.
  select status into v_msg from pg_temp.rp('c0190001-0000-4000-8000-000000000000', 'keep', null, 'codex', 'mcp-shared-key');
  perform pg_temp.ok('T19 a ledger agent_code is accepted and recorded', v_msg = 'recorded'
    and (select reviewed_by = 'codex' from public.auto_resolve_decisions where id = 'd0190001-0000-4000-8000-000000000000'), v_msg);
end $$;

-- T20 a zero-row transition raises and the decision row reads proposed afterwards.
do $$
declare v_msg text;
begin
  perform pg_temp.item('c0200001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0200001-0000-4000-8000-000000000000', 'c0200001-0000-4000-8000-000000000000', 'recheck');
  begin
    -- Stands in for "resolved by a second connection after the lookup": the guarded
    -- update matches nothing. The sub-block's rollback restores the real function.
    create or replace function public.transition_action_item(
      p_item_id uuid, p_from_statuses text[], p_to_status text, p_actor text,
      p_close_reason text default null, p_resolution_note text default null,
      p_resolved_by_thought_id uuid default null, p_evidence_thought_id uuid default null,
      p_duplicate_of uuid default null, p_defer_reason text default null,
      p_event_payload jsonb default null)
    returns integer language plpgsql as $f$ begin return 0; end $f$;
    perform pg_temp.rp('c0200001-0000-4000-8000-000000000000', 'done');
    v_msg := 'no exception';
  exception when others then v_msg := sqlerrm; end;
  perform pg_temp.ok('T20 a zero-row transition raises', v_msg like 'review_proposal: the done transition of % wrote 0 rows.', v_msg);
  perform pg_temp.ok('T20 the decision row still reads proposed',
    (select outcome = 'proposed' and review_seq is null from public.auto_resolve_decisions where id = 'd0200001-0000-4000-8000-000000000000'));
  perform pg_temp.ok('T20 the real transition function is back',
    (select prosrc like '%set_config(''app.actor''%' from pg_proc where proname = 'transition_action_item'));
end $$;

-- T22 done, then restore: reopened, the accepted row stays as history, and the
-- next review's number continues the item's sequence across generations.
do $$
declare r record;
begin
  perform pg_temp.item('c0220001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0220001-0000-4000-8000-000000000000', 'c0220001-0000-4000-8000-000000000000', 'recheck');
  perform pg_temp.rp('c0220001-0000-4000-8000-000000000000', 'done');
  perform public.transition_action_item('c0220001-0000-4000-8000-000000000000', '{resolved}', 'open', 'operator');
  perform pg_temp.ok('T22 restore reopens into generation 1, the accepted row is history',
    (select status = 'open' and reopen_generation = 1 from public.action_items where id = 'c0220001-0000-4000-8000-000000000000')
    and (select outcome = 'accepted' and item_generation = 0 from public.auto_resolve_decisions where id = 'd0220001-0000-4000-8000-000000000000'));
  perform pg_temp.prop('d0220002-0000-4000-8000-000000000000', 'c0220001-0000-4000-8000-000000000000', 'archive');
  select * into r from pg_temp.rp('c0220001-0000-4000-8000-000000000000', 'keep');
  perform pg_temp.ok('T22 a new-generation review continues review_seq',
    r.status = 'recorded' and (select review_seq = 2 and item_generation = 1
      from public.auto_resolve_decisions where id = 'd0220002-0000-4000-8000-000000000000'), r.message);
end $$;

-- T24 accepted row and leftover sibling share their first 8 hex characters.
do $$
declare r record; s jsonb;
begin
  perform pg_temp.item('c0240002-0000-4000-8000-000000000000');
  perform pg_temp.item('c0240001-0000-4000-8000-000000000000');
  perform pg_temp.prop('ef012345-0000-4000-8000-000000000001', 'c0240001-0000-4000-8000-000000000000', 'recheck');
  perform pg_temp.prop('ef012345-0000-4000-8000-000000000002', 'c0240001-0000-4000-8000-000000000000', 'dedup', 'c0240002-0000-4000-8000-000000000000');
  perform pg_temp.rp('c0240001-0000-4000-8000-000000000000', 'done', 'ef012345-0000-4000-8000-000000000001');
  s := pg_temp.state();
  select * into r from pg_temp.rp('c0240001-0000-4000-8000-000000000000', 'done', 'ef012345');
  perform pg_temp.ok('T24 the shared short form is ambiguous', r.status = 'ambiguous', r.message);
  select * into r from pg_temp.rp('c0240001-0000-4000-8000-000000000000', 'done', 'ef012345-0000-4000-8000-000000000001');
  perform pg_temp.ok('T24 the accepted row by full id is already recorded', r.status = 'already_recorded', r.message);
  select * into r from pg_temp.rp('c0240001-0000-4000-8000-000000000000', 'done', 'ef012345-0000-4000-8000-000000000002');
  perform pg_temp.ok('T24 the sibling by full id is the closed-item refusal',
    r.status = 'refused' and r.message like '%restore_action_item is the undo', r.message);
  perform pg_temp.ok('T24 zero writes', pg_temp.state() = s);
end $$;

-- T25/T31 only an older generation holds proposal rows (one kept, one proposed).
do $$
declare r record; s jsonb;
begin
  perform pg_temp.item('c0250001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0250001-0000-4000-8000-000000000000', 'c0250001-0000-4000-8000-000000000000', 'archive');
  perform public.transition_action_item('c0250001-0000-4000-8000-000000000000', '{open}', 'archived', 'operator', 'expired');
  perform public.transition_action_item('c0250001-0000-4000-8000-000000000000', '{archived}', 'open', 'operator');
  perform pg_temp.ok('T25 the item still resolves', (select count(*) = 1 from public.resolve_proposal_item('c0250001')));
  s := pg_temp.state();
  select * into r from pg_temp.rp('c0250001-0000-4000-8000-000000000000', 'keep');
  perform pg_temp.ok('T25 an older generation''s proposal is never pending',
    r.status = 'nothing_pending' and pg_temp.state() = s, r.message);

  perform pg_temp.item('c0310001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0310001-0000-4000-8000-000000000000', 'c0310001-0000-4000-8000-000000000000', 'archive');
  perform pg_temp.rp('c0310001-0000-4000-8000-000000000000', 'keep');
  perform public.transition_action_item('c0310001-0000-4000-8000-000000000000', '{open}', 'resolved', 'operator', 'done');
  perform public.transition_action_item('c0310001-0000-4000-8000-000000000000', '{resolved}', 'open', 'operator');
  s := pg_temp.state();
  select * into r from pg_temp.rp('c0310001-0000-4000-8000-000000000000', 'keep');
  perform pg_temp.ok('T31 an older generation''s keep is never already recorded',
    r.status = 'nothing_pending' and pg_temp.state() = s, r.message);
end $$;

-- T26 round 13: decision ids on keep/archive; keep A, then B and C, then keep.
do $$
declare r record; s jsonb;
begin
  -- A nonexistent item: the refusal comes before any item lookup (not not_found).
  select * into r from pg_temp.rp('99999999-0000-4000-8000-000000000000', 'keep', 'abcdef12');
  perform pg_temp.ok('T26 keep with a decision id on a missing item is refused before the item is looked up',
    r.status = 'refused' and r.message = 'keep and archive take no decision id', r.message);
  -- An EXISTING item with a pending row the decision id really names (F2: the
  -- missing-item fixture alone could not show an existing item's rows untouched).
  perform pg_temp.item('c0260001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0260001-0000-4000-8000-000000000000', 'c0260001-0000-4000-8000-000000000000', 'archive');
  s := pg_temp.state();
  perform pg_temp.live('T26 keep/archive with a decision id', s, 'c0260001-0000-4000-8000-000000000000', 1);
  select * into r from pg_temp.rp('c0260001-0000-4000-8000-000000000000', 'keep', 'd0260001');
  perform pg_temp.ok('T26 keep with a decision id on an existing pending item is refused',
    r.status = 'refused' and r.message = 'keep and archive take no decision id', r.message);
  perform pg_temp.unchanged('T26 keep with a decision id: zero business writes', s);
  select * into r from pg_temp.rp('c0260001-0000-4000-8000-000000000000', 'keep', 'd0260001-0000-4000-8000-000000000000');
  perform pg_temp.ok('T26 keep with a full decision id is refused', r.status = 'refused' and r.message = 'keep and archive take no decision id', r.message);
  perform pg_temp.unchanged('T26 keep with a full decision id: zero business writes', s);
  select * into r from pg_temp.rp('c0260001-0000-4000-8000-000000000000', 'archive', 'd0260001');
  perform pg_temp.ok('T26 archive with a decision id is refused',
    r.status = 'refused' and r.message = 'keep and archive take no decision id', r.message);
  perform pg_temp.unchanged('T26 archive with a decision id: zero business writes', s);
  perform pg_temp.rp('c0260001-0000-4000-8000-000000000000', 'keep');
end $$;
-- B and C in a LATER transaction, so their review carries a later reviewed_at.
do $$
declare r record; s jsonb;
begin
  perform pg_temp.prop('d0260002-0000-4000-8000-000000000000', 'c0260001-0000-4000-8000-000000000000', 'recheck', null, 'e0000000-0000-4000-8000-000000000003');
  perform pg_temp.prop('d0260003-0000-4000-8000-000000000000', 'c0260001-0000-4000-8000-000000000000', 'recheck', null, 'e0000000-0000-4000-8000-000000000004');
  select * into r from pg_temp.rp('c0260001-0000-4000-8000-000000000000', 'keep');
  perform pg_temp.ok('T26 keep reviews B and C', r.status = 'recorded' and r.message like 'kept c0260001 on open (2 proposals)', r.message);
  perform pg_temp.ok('T26 B and C share one review_seq above A''s',
    (select count(distinct review_seq) = 1 and min(review_seq) = 2 from public.auto_resolve_decisions
     where id in ('d0260002-0000-4000-8000-000000000000', 'd0260003-0000-4000-8000-000000000000'))
    and (select review_seq = 1 from public.auto_resolve_decisions where id = 'd0260001-0000-4000-8000-000000000000'));
  s := pg_temp.state();
  select * into r from pg_temp.rp('c0260001-0000-4000-8000-000000000000', 'keep');
  perform pg_temp.ok('T26 a further keep is already recorded with the second timestamp',
    r.status = 'already_recorded' and r.message = 'already recorded ' ||
      (select to_char(reviewed_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"') from public.auto_resolve_decisions where id = 'd0260002-0000-4000-8000-000000000000'), r.message);
  select * into r from pg_temp.rp('c0260001-0000-4000-8000-000000000000', 'done', 'd0260001-0000-4000-8000-000000000000');
  perform pg_temp.ok('T26 done of the earlier review''s row is already reviewed',
    r.status = 'refused' and r.message like 'd0260001 already reviewed (keep % UTC); nothing pending', r.message);
  select * into r from pg_temp.rp('c0260001-0000-4000-8000-000000000000', 'done', 'd0260002');
  perform pg_temp.ok('T26 done of a latest-review row is the open-item refusal',
    r.status = 'refused' and r.message like 'c0260001 is open; last proposal kept % UTC; nothing pending to done', r.message);
  perform pg_temp.ok('T26 zero writes', pg_temp.state() = s);
end $$;

-- T27 round 15, ONE transaction: keep A, insert B and C, keep B and C, done A.
do $$
declare r record; s jsonb;
begin
  perform pg_temp.item('c0270001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0270001-0000-4000-8000-000000000000', 'c0270001-0000-4000-8000-000000000000', 'recheck', null, 'e0000000-0000-4000-8000-000000000003');
  perform pg_temp.rp('c0270001-0000-4000-8000-000000000000', 'keep');
  perform pg_temp.prop('d0270002-0000-4000-8000-000000000000', 'c0270001-0000-4000-8000-000000000000', 'recheck', null, 'e0000000-0000-4000-8000-000000000004');
  perform pg_temp.prop('d0270003-0000-4000-8000-000000000000', 'c0270001-0000-4000-8000-000000000000', 'recheck', null, 'e0000000-0000-4000-8000-000000000005');
  perform pg_temp.rp('c0270001-0000-4000-8000-000000000000', 'keep');
  perform pg_temp.ok('T27 the collision really occurs: three equal reviewed_at',
    (select count(distinct reviewed_at) = 1 and count(*) = 3 from public.auto_resolve_decisions where item_id = 'c0270001-0000-4000-8000-000000000000'));
  perform pg_temp.ok('T27 the sequence separates the reviews',
    (select review_seq = 1 from public.auto_resolve_decisions where id = 'd0270001-0000-4000-8000-000000000000')
    and (select count(*) = 2 from public.auto_resolve_decisions where item_id = 'c0270001-0000-4000-8000-000000000000' and review_seq = 2));
  s := pg_temp.state();
  select * into r from pg_temp.rp('c0270001-0000-4000-8000-000000000000', 'done', 'd0270001-0000-4000-8000-000000000000');
  perform pg_temp.ok('T27 done A by full id is already reviewed, not merged into the latest',
    r.status = 'refused' and r.message like 'd0270001 already reviewed (keep %', r.message);
  perform pg_temp.unchanged('T27 the already-reviewed refusal: zero business writes', s);
end $$;

-- T28 round 15, ONE transaction: keep A, insert B, done B; then the retry and keep.
do $$
declare r record; s jsonb;
begin
  perform pg_temp.item('c0280001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0280001-0000-4000-8000-000000000000', 'c0280001-0000-4000-8000-000000000000', 'archive');
  perform pg_temp.rp('c0280001-0000-4000-8000-000000000000', 'keep');
  perform pg_temp.prop('d0280002-0000-4000-8000-000000000000', 'c0280001-0000-4000-8000-000000000000', 'recheck');
  select * into r from pg_temp.rp('c0280001-0000-4000-8000-000000000000', 'done', 'd0280002-0000-4000-8000-000000000000');
  perform pg_temp.ok('T28 done B closes the item', r.status = 'recorded', r.message);
  -- The collision must really occur: both reviewed rows, one timestamp.
  perform pg_temp.ok('T28 the collision really occurs: two reviewed rows, equal reviewed_at',
    (select count(*) = 2 and count(distinct reviewed_at) = 1 and count(distinct review_seq) = 2
     from public.auto_resolve_decisions where item_id = 'c0280001-0000-4000-8000-000000000000' and review_seq is not null));
  perform pg_temp.ok('T28 ordered sequence: A is 1, B is 2',
    (select review_seq = 1 from public.auto_resolve_decisions where id = 'd0280001-0000-4000-8000-000000000000')
    and (select review_seq = 2 from public.auto_resolve_decisions where id = 'd0280002-0000-4000-8000-000000000000'));
  s := pg_temp.state();
  select * into r from pg_temp.rp('c0280001-0000-4000-8000-000000000000', 'done', 'd0280002-0000-4000-8000-000000000000');
  perform pg_temp.ok('T28 the retried full-id done is already recorded', r.status = 'already_recorded', r.message);
  perform pg_temp.unchanged('T28 the retried done: zero business writes', s);
  select * into r from pg_temp.rp('c0280001-0000-4000-8000-000000000000', 'keep');
  perform pg_temp.ok('T28 keep after done is the closed-item refusal',
    r.status = 'refused' and r.message like '%restore_action_item is the undo', r.message);
  perform pg_temp.unchanged('T28 keep after done: zero business writes', s);
end $$;

-- T32 Task 3.2's schema: CHECKs, and a reopen clears the columns into the event.
do $$
declare v_msg text;
begin
  perform pg_temp.item('c0320001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0320001-0000-4000-8000-000000000000', 'c0320001-0000-4000-8000-000000000000', 'archive');
  update public.action_items set archive_proposed_at = now() where id = 'c0320001-0000-4000-8000-000000000000';
  perform pg_temp.rp('c0320001-0000-4000-8000-000000000000', 'archive');
  perform public.transition_action_item('c0320001-0000-4000-8000-000000000000', '{archived}', 'open', 'operator');
  perform pg_temp.ok('T32 a reopen nulls the three archive columns',
    (select archive_proposed_at is null and archive_review_outcome is null and archive_reviewed_at is null
     from public.action_items where id = 'c0320001-0000-4000-8000-000000000000'));
  perform pg_temp.ok('T32 the reopen event carries their old values',
    (select count(*) = 1 from public.action_item_events
     where item_id = 'c0320001-0000-4000-8000-000000000000' and new_status = 'open'
       and payload->>'archive_review_outcome' = 'accepted'
       and payload ? 'archive_reviewed_at' and payload ? 'archive_proposed_at'));
  begin
    update public.action_items set archive_review_outcome = 'maybe', archive_reviewed_at = now()
    where id = 'c0320001-0000-4000-8000-000000000000';
    v_msg := 'accepted';
  exception when check_violation then v_msg := sqlerrm; end;
  perform pg_temp.ok('T32 an unknown outcome is refused', v_msg like '%action_items_archive_review_outcome_known%', v_msg);
  begin
    update public.action_items set archive_review_outcome = 'kept'
    where id = 'c0320001-0000-4000-8000-000000000000';
    v_msg := 'accepted';
  exception when check_violation then v_msg := sqlerrm; end;
  perform pg_temp.ok('T32 an outcome without its timestamp is refused', v_msg like '%action_items_archive_review_together%', v_msg);
end $$;

-- T33 deferred items.
do $$
declare r record; s jsonb;
begin
  perform pg_temp.item('c0330001-0000-4000-8000-000000000000', 'deferred');
  perform pg_temp.prop('d0330001-0000-4000-8000-000000000000', 'c0330001-0000-4000-8000-000000000000', 'archive');
  select * into r from pg_temp.rp('c0330001-0000-4000-8000-000000000000', 'archive');
  perform pg_temp.ok('T33 archive closes a deferred item',
    r.status = 'recorded' and (select count(*) = 1 from public.action_item_events
      where item_id = 'c0330001-0000-4000-8000-000000000000' and old_status = 'deferred' and new_status = 'archived'), r.message);
  perform pg_temp.item('c0330002-0000-4000-8000-000000000000', 'deferred');
  perform pg_temp.prop('d0330002-0000-4000-8000-000000000000', 'c0330002-0000-4000-8000-000000000000', 'recheck');
  s := pg_temp.state();
  perform pg_temp.live('T33 deferred recheck', s, 'c0330002-0000-4000-8000-000000000000', 1);
  select * into r from pg_temp.rp('c0330002-0000-4000-8000-000000000000', 'done');
  perform pg_temp.ok('T33 done on a deferred item is refused',
    r.status = 'refused' and r.message = 'c0330002 is deferred; done needs an open item', r.message);
  perform pg_temp.unchanged('T33 done on a deferred item: zero business writes', s);
  perform pg_temp.item('c0330003-0000-4000-8000-000000000000', 'deferred');
  perform pg_temp.prop('d0330003-0000-4000-8000-000000000000', 'c0330003-0000-4000-8000-000000000000', 'archive');
  select * into r from pg_temp.rp('c0330003-0000-4000-8000-000000000000', 'keep');
  perform pg_temp.ok('T33 keep on a deferred item records and leaves it deferred',
    r.status = 'recorded' and (select status = 'deferred' from public.action_items where id = 'c0330003-0000-4000-8000-000000000000'), r.message);
end $$;

-- T34 no proposal on record; T36 a malformed decision ref.
do $$
declare r record; s jsonb;
begin
  perform pg_temp.item('c0340001-0000-4000-8000-000000000000');
  perform pg_temp.item('c0360001-0000-4000-8000-000000000000');
  perform pg_temp.prop('d0360001-0000-4000-8000-000000000000', 'c0360001-0000-4000-8000-000000000000', 'recheck');
  s := pg_temp.state();
  select * into r from pg_temp.rp('c0340001-0000-4000-8000-000000000000', 'keep');
  perform pg_temp.ok('T34 an item with no proposal', r.status = 'not_found' and r.message = 'no proposal on record for c0340001', r.message);
  perform pg_temp.unchanged('T34 an item with no proposal: zero business writes', s);
  select * into r from pg_temp.rp('99999999-0000-4000-8000-000000000001', 'done');
  perform pg_temp.ok('T34 a missing item', r.status = 'not_found', r.message);
  perform pg_temp.unchanged('T34 a missing item: zero business writes', s);
  -- T36 on an item whose one pending row "done" would otherwise accept.
  perform pg_temp.live('T36 malformed ref', s, 'c0360001-0000-4000-8000-000000000000', 1);
  select * into r from pg_temp.rp('c0360001-0000-4000-8000-000000000000', 'done', 'zz');
  perform pg_temp.ok('T36 a malformed decision ref is refused', r.status = 'refused' and r.message like 'zz is not a decision id%', r.message);
  perform pg_temp.unchanged('T36 a malformed decision ref: zero business writes', s);
end $$;

-- T38 (PR 23 review F1): absent vs supplied-but-empty decision ids, directly at the
-- RPC. NULL is absent; every non-null value is supplied, including '' and blanks.
-- keep/archive refuse any supplied value before item work; done refuses an empty
-- one as malformed instead of silently picking the only pending evidence row.
do $$
declare r record; s jsonb; v_blank text;
  c_blanks constant text[] := array['', ' ', '   ', E'\t', E'\n', E' \t\r\n '];
  c_mixed constant uuid := 'c0380001-0000-4000-8000-000000000000';
  c_one constant uuid := 'c0380002-0000-4000-8000-000000000000';
  c_def constant uuid := 'c0380003-0000-4000-8000-000000000000';
begin
  -- An open item with an archive AND a recheck row pending: a wrongly admitted
  -- keep would keep both, a wrongly admitted archive would archive the item.
  perform pg_temp.item(c_mixed);
  perform pg_temp.prop('d0380001-0000-4000-8000-000000000000', c_mixed, 'archive');
  perform pg_temp.prop('d0380002-0000-4000-8000-000000000000', c_mixed, 'recheck');
  -- An open item with exactly ONE pending evidence row: a blank done read as
  -- absent would accept it and resolve the item.
  perform pg_temp.item(c_one);
  perform pg_temp.prop('d0380003-0000-4000-8000-000000000000', c_one, 'recheck');
  -- A deferred item with an archive row pending.
  perform pg_temp.item(c_def, 'deferred');
  perform pg_temp.prop('d0380004-0000-4000-8000-000000000000', c_def, 'archive');
  s := pg_temp.state();
  perform pg_temp.live('T38 mixed', s, c_mixed, 2);
  perform pg_temp.live('T38 one evidence row', s, c_one, 1);
  perform pg_temp.live('T38 deferred', s, c_def, 1);

  foreach v_blank in array c_blanks loop
    select * into r from pg_temp.rp(c_mixed, 'keep', v_blank);
    perform pg_temp.ok(format('T38 keep with decision_ref %s is refused', to_json(v_blank)),
      r.status = 'refused' and r.message = 'keep and archive take no decision id', r.status || ': ' || r.message);
    select * into r from pg_temp.rp(c_mixed, 'archive', v_blank);
    perform pg_temp.ok(format('T38 archive with decision_ref %s is refused', to_json(v_blank)),
      r.status = 'refused' and r.message = 'keep and archive take no decision id', r.status || ': ' || r.message);
    select * into r from pg_temp.rp(c_def, 'archive', v_blank);
    perform pg_temp.ok(format('T38 archive of a deferred item with decision_ref %s is refused', to_json(v_blank)),
      r.status = 'refused' and r.message = 'keep and archive take no decision id', r.status || ': ' || r.message);
    select * into r from pg_temp.rp(c_one, 'done', v_blank);
    perform pg_temp.ok(format('T38 done with decision_ref %s is malformed', to_json(v_blank)),
      r.status = 'refused'
        and r.message = 'empty decision id; use the full id or its first 8 characters, or leave it out',
      r.status || ': ' || r.message);
    perform pg_temp.unchanged(format('T38 decision_ref %s: zero business writes on all three items', to_json(v_blank)), s);
  end loop;

  -- A valid decision id on keep/archive, short and full: refused, zero writes.
  select * into r from pg_temp.rp(c_mixed, 'keep', 'd0380002');
  perform pg_temp.ok('T38 keep with a valid short decision id is refused', r.status = 'refused' and r.message = 'keep and archive take no decision id', r.message);
  select * into r from pg_temp.rp(c_mixed, 'archive', 'd0380001-0000-4000-8000-000000000000');
  perform pg_temp.ok('T38 archive with a valid full decision id is refused', r.status = 'refused' and r.message = 'keep and archive take no decision id', r.message);
  -- Padded valid ids on done are NOT blank: they are trimmed and resolved.
  perform pg_temp.unchanged('T38 valid ids on keep/archive: zero business writes', s);

  -- Controls: the same fixtures DO accept writes when the decision id is absent
  -- (NULL), so every refusal above refused something that would have written.
  select * into r from pg_temp.rp(c_one, 'done', E' \td0380003\n');
  perform pg_temp.ok('T38 control: done with a padded valid id resolves the one row',
    r.status = 'recorded' and r.decision_id = 'd0380003-0000-4000-8000-000000000000'
      and (select status = 'resolved' from public.action_items where id = c_one), r.message);
  select * into r from pg_temp.rp(c_mixed, 'archive', null);
  perform pg_temp.ok('T38 control: archive with no decision id archives the mixed item',
    r.status = 'recorded' and (select status = 'archived' from public.action_items where id = c_mixed), r.message);
  select * into r from pg_temp.rp(c_def, 'keep', null);
  perform pg_temp.ok('T38 control: keep with no decision id keeps the deferred item',
    r.status = 'recorded' and (select outcome = 'kept' from public.auto_resolve_decisions where id = 'd0380004-0000-4000-8000-000000000000'), r.message);
end $$;

-- T39 (F1) the empty-ref refusal on done, with no pending rows and with a missing
-- item: still the malformed refusal, never not_found or nothing_pending.
do $$
declare r record; s jsonb;
begin
  s := pg_temp.state();
  select * into r from pg_temp.rp('99999999-0000-4000-8000-000000000002', 'done', '  ');
  perform pg_temp.ok('T39 done with a blank ref on a missing item is the malformed refusal',
    r.status = 'refused' and r.message like 'empty decision id%', r.message);
  select * into r from pg_temp.rp('99999999-0000-4000-8000-000000000002', 'archive', '');
  perform pg_temp.ok('T39 archive with an empty ref on a missing item is refused before lookup',
    r.status = 'refused' and r.message = 'keep and archive take no decision id', r.message);
  perform pg_temp.unchanged('T39 zero business writes', s);
end $$;

-- T35 grants.
select pg_temp.ok('T35 anon cannot run review_proposal',
  not has_function_privilege('anon', 'public.review_proposal(uuid,text,text,text,text)', 'execute'));
select pg_temp.ok('T35 authenticated cannot run review_proposal',
  not has_function_privilege('authenticated', 'public.review_proposal(uuid,text,text,text,text)', 'execute'));
select pg_temp.ok('T35 service_role can run review_proposal',
  has_function_privilege('service_role', 'public.review_proposal(uuid,text,text,text,text)', 'execute'));
select pg_temp.ok('T35 anon cannot run resolve_proposal_item',
  not has_function_privilege('anon', 'public.resolve_proposal_item(text)', 'execute'));

-- T30 every review is one actor and one verb, across every fixture above.
select pg_temp.ok('T30 the check is not vacuous: many reviews exist',
  (select count(*) >= 15 from (select distinct item_id, review_seq from public.auto_resolve_decisions where review_seq is not null) g));
select pg_temp.ok('T30 every review has one reviewed_by and maps to one verb',
  (select count(*) = 0 from (
    select item_id, review_seq from public.auto_resolve_decisions where review_seq is not null
    group by item_id, review_seq
    having count(distinct reviewed_by) > 1
        or count(distinct case when outcome = 'kept' then 'keep'
                               when layer in ('archive', 'fragment') then 'archive' else 'done' end) > 1) bad));
select pg_temp.ok('T37 no review wrote an sql-actor event',
  (select count(*) = 0 from public.action_item_events where actor = 'sql'));

select 'REVIEW PROPOSAL SQL TEST PASSED' as result;
