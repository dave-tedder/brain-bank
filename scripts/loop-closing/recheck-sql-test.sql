-- Loop-closing Task 4.1: single-connection contract for
-- 20261119c_action_items_recheck.sql (the bounded search, eligibility, begin,
-- the candidate page, the page commit, the pending view, the run receipt) and
-- 20261119ca_action_items_recheck_cold_start.sql (the order by last attempt in
-- T03, the error stamp in T16, the warm-up read in T17).
-- Run ONLY by recheck-sql-test.sh against a throwaway local cluster. Every check
-- prints PASS <name> or raises FAIL <name>; the last line prints
-- RECHECK SQL TEST PASSED.
--
-- A check that RAN and did not hold raises SQLSTATE TF001 with a message
-- starting "FAIL ", from pg_temp.ok and from nowhere else; the runner counts
-- only that as a completed failure. Every call into the code under test goes
-- through pg_temp.call, which REPORTS a behavioral error as data for a named
-- check to judge and re-raises an interruption untouched. So a mutant that
-- makes a function raise is judged by a check, never by a raw SQL error.
--
-- pgvector is not installed on this cluster. The runner defines `vector` as a
-- domain over float8[] with a cosine-distance `<=>` operator; the migration's
-- SQL is the same text production runs, the vector type underneath is a stand-in.
--
-- Time: pg_temp.t(day, minute) is a fixed instant in 2025 carrying microseconds.
-- Each section works in its own day, and sections run in day order, because a
-- scan's upper bound is the newest thought in the whole table.

\set ON_ERROR_STOP 1
set client_min_messages = notice;
set timezone = 'UTC';

create temp table obt_interruption (prefix text primary key);
insert into obt_interruption select unnest(string_to_array(:'interruption_prefixes', ' '));

insert into public.agent_task_ledger (agent_code) values ('triage');

create function pg_temp.interruption(p_state text)
returns boolean language sql stable as $$
  select p_state is null or exists (select 1 from obt_interruption i where p_state like i.prefix || '%')
$$;

-- The only place TF001 is raised.
create function pg_temp.ok(p_name text, p_cond boolean, p_detail text default '')
returns void language plpgsql as $$
begin
  if p_cond is distinct from true then
    raise exception using errcode = 'TF001',
      message = regexp_replace(format('FAIL %s: %s', p_name, p_detail), E'[\n\r]+', ' ', 'g');
  end if;
  raise notice 'PASS %', p_name;
end $$;

create function pg_temp.eq(p_name text, p_got text, p_want text)
returns void language sql as $$
  select pg_temp.ok(p_name, p_got is not distinct from p_want,
    format('got %s, want %s', coalesce(p_got, '<null>'), coalesce(p_want, '<null>')))
$$;

-- Run one query and return its rows as a jsonb array (or, with p_query false,
-- run one statement and return {"done": true}). A behavioral error comes back
-- as {"raised": true, "state", "message", "constraint"}; an interruption is
-- re-raised as it came. The one handler in this file.
create function pg_temp.call(p_sql text, p_query boolean default true)
returns jsonb language plpgsql as $$
declare
  v jsonb;
  v_state text; v_message text; v_constraint text;
begin
  begin
    if not p_query then
      execute p_sql;
      return '{"done": true}'::jsonb;
    end if;
    execute format('select coalesce(jsonb_agg(to_jsonb(obt_r)), ''[]''::jsonb) from (%s) obt_r', p_sql) into v;
    return v;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text,
                            v_constraint = constraint_name;
    if pg_temp.interruption(v_state) then raise; end if;
    return jsonb_build_object('raised', true, 'state', v_state, 'message', v_message,
                              'constraint', v_constraint);
  end;
end $$;

-- A result that must be a raise with this SQLSTATE and message.
create function pg_temp.raised(p_name text, p_r jsonb, p_state text, p_like text)
returns void language sql as $$
  select pg_temp.ok(p_name,
    jsonb_typeof(p_r) = 'object' and p_r->>'raised' = 'true' and p_r->>'state' = p_state
      and p_r->>'message' like '%' || p_like || '%',
    left(p_r::text, 300))
$$;

create function pg_temp.t(p_day integer, p_minute integer)
returns timestamptz language sql immutable as $$
  select timestamptz '2025-01-01 00:00:00.123456+00' + make_interval(days => p_day, mins => p_minute)
$$;

-- A readable fixed uuid: an 8-hex prefix and a number.
create function pg_temp.u(p_prefix text, p_n integer)
returns uuid language sql immutable as $$
  select (rpad(p_prefix, 8, '0') || '-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;

create function pg_temp.th(p_id uuid, p_at timestamptz, p_project text,
                           p_embedding float8[] default null, p_topics text[] default null,
                           p_people text[] default null, p_content text default null)
returns void language sql as $$
  insert into public.thoughts (id, created_at, content, embedding, metadata)
  values (p_id, p_at, coalesce(p_content, 'thought ' || left(p_id::text, 8)), p_embedding,
          jsonb_strip_nulls(jsonb_build_object('project', p_project, 'topics', to_jsonb(p_topics),
                                               'people', to_jsonb(p_people))))
$$;

create function pg_temp.item(p_id uuid, p_created timestamptz, p_source uuid default null,
                             p_description text default null, p_status text default 'open')
returns void language sql as $$
  insert into public.action_items (id, description, status, defer_reason, source_thought_id, created_at)
  values (p_id, coalesce(p_description, 'item ' || left(p_id::text, 8)), p_status,
          case when p_status = 'deferred' then 'pause:test' end, p_source, p_created)
$$;

-- Everything a re-check call may write, every column of every row.
create function pg_temp.state()
returns jsonb language sql as $$
  select jsonb_build_object(
    'action_items', coalesce((select jsonb_object_agg(a.id::text, to_jsonb(a)) from public.action_items a), '{}'::jsonb),
    'decisions', coalesce((select jsonb_object_agg(d.id::text, to_jsonb(d)) from public.auto_resolve_decisions d), '{}'::jsonb),
    'events', coalesce((select jsonb_object_agg(e.id::text, to_jsonb(e)) from public.action_item_events e), '{}'::jsonb),
    'runs', coalesce((select jsonb_object_agg(r.id::text, to_jsonb(r)) from public.action_item_recheck_runs r), '{}'::jsonb))
$$;

-- One item's scan state on one line.
create function pg_temp.scan(p_id uuid)
returns text language sql as $$
  select concat_ws('|',
    case when a.recheck_scan_id is null then 'idle' else 'scanning' end,
    coalesce(a.recheck_cursor_at::text, '-'), coalesce(left(a.recheck_cursor_id::text, 8) || right(a.recheck_cursor_id::text, 4), '-'),
    coalesce(a.recheck_scan_upper_at::text, '-'), coalesce(left(a.recheck_scan_upper_id::text, 8) || right(a.recheck_scan_upper_id::text, 4), '-'),
    a.recheck_scan_proposed::text,
    case when a.last_rechecked_at is null then 'never' else 'stamped' end)
  from public.action_items a where a.id = p_id
$$;

create function pg_temp.short(p_ids uuid[])
returns text language sql as $$
  select coalesce(string_agg(left(x::text, 8) || right(x::text, 4), ' ' order by n), '')
  from unnest(p_ids) with ordinality as e(x, n)
$$;

create function pg_temp.begin_scan(p_item uuid, p_embedding float8[] default null)
returns jsonb language sql as $$
  select pg_temp.call(format('select * from public.recheck_begin_scan(%L::uuid, %L::vector)', p_item, p_embedding))
$$;

-- The candidate page as short ids, or the raise.
create function pg_temp.page(p_item uuid, p_lower_at timestamptz, p_lower_id uuid,
                             p_upper_at timestamptz, p_upper_id uuid,
                             p_embedding_ids uuid[] default '{}', p_limit integer default 10)
returns text language plpgsql as $$
declare r jsonb;
begin
  r := pg_temp.call(format(
    'select id from public.recheck_candidates(%L::uuid, %L::timestamptz, %L::uuid, %L::timestamptz, %L::uuid, %L::uuid[], %L::integer)',
    p_item, p_lower_at, p_lower_id, p_upper_at, p_upper_id, p_embedding_ids, p_limit));
  if jsonb_typeof(r) = 'object' then return 'RAISED ' || (r->>'state') || ' ' || (r->>'message'); end if;
  return coalesce((select string_agg(left(x->>'id', 8) || right(x->>'id', 4), ' ' order by n)
                   from jsonb_array_elements(r) with ordinality as e(x, n)), '');
end $$;

-- One commit: the single returned row as jsonb, or the raise.
create function pg_temp.commit(p_item uuid, p_scan uuid, p_exp_at timestamptz, p_exp_id uuid,
                               p_cur_at timestamptz, p_cur_id uuid, p_rows jsonb, p_final boolean)
returns jsonb language plpgsql as $$
declare r jsonb;
begin
  r := pg_temp.call(format(
    'select * from public.recheck_commit_page(%L::uuid, %L::uuid, %L::timestamptz, %L::uuid, %L::timestamptz, %L::uuid, %L::jsonb, %L::boolean)',
    p_item, p_scan, p_exp_at, p_exp_id, p_cur_at, p_cur_id, p_rows, p_final));
  if jsonb_typeof(r) = 'object' then return r; end if;
  if jsonb_array_length(r) <> 1 then return jsonb_build_object('rows_returned', jsonb_array_length(r)); end if;
  return r->0;
end $$;

-- status|scan_active|cursor short|scan_proposed|inserted of a commit's answer.
create function pg_temp.answer(p_r jsonb)
returns text language sql as $$
  select case when p_r ? 'raised' then 'RAISED ' || (p_r->>'state')
    else concat_ws('|', p_r->>'status', p_r->>'scan_active',
      coalesce((p_r->>'cursor_at')::timestamptz::text, '-'),
      coalesce(left(p_r->>'cursor_id', 8) || right(p_r->>'cursor_id', 4), '-'),
      p_r->>'scan_proposed', p_r->>'inserted') end
$$;

create function pg_temp.drow(p_outcome text, p_reason text, p_evidence uuid, p_quote text default null, p_score numeric default null)
returns jsonb language sql as $$
  select jsonb_build_object('outcome', p_outcome, 'reason', p_reason, 'evidence_thought_id', p_evidence,
                            'quote', p_quote, 'score', p_score)
$$;

-- The item's recheck decision rows, in insertion order, one line each.
create function pg_temp.decisions(p_item uuid)
returns text language sql as $$
  select coalesce(string_agg(concat_ws('/', d.outcome, coalesce(d.reason, '-'),
           coalesce(left(d.evidence_thought_id::text, 8) || right(d.evidence_thought_id::text, 4), '-'),
           'g' || d.item_generation), ' ' order by d.created_at, d.outcome, d.reason, d.evidence_thought_id), '')
  from public.auto_resolve_decisions d where d.item_id = p_item and d.layer = 'recheck'
$$;

-- ---------------------------------------------------------------------------
-- T00: the harness's own classification, before it is relied on
-- ---------------------------------------------------------------------------
do $$
declare r jsonb;
begin
  perform pg_temp.ok('T00 harness: the runner passed its interruption list',
    (select count(*) from obt_interruption) >= 6, (select count(*)::text from obt_interruption));
  perform pg_temp.ok('T00 harness: cancellation, connection, resource, limit, system and internal errors are interruptions',
    (select bool_and(pg_temp.interruption(s)) from unnest(array['57014', '57P01', '08006', '53200', '54001', '58030', 'XX000', '55P03']) s)
    and pg_temp.interruption(null));
  perform pg_temp.ok('T00 harness: the errors a mutant is expected to produce are not interruptions',
    not (select bool_or(pg_temp.interruption(s)) from unnest(array['23503', '23505', '23514', '22023', '22012', 'P0001', '42883', 'TF001', 'RC001', 'RC002', 'RC003', 'RC004', 'RC005', 'RC006']) s));
  r := pg_temp.call('select 1/0 as x');
  perform pg_temp.ok('T00 harness: call reports a behavioral error with its SQLSTATE', r->>'raised' = 'true' and r->>'state' = '22012', r::text);
  r := pg_temp.call('select 7 as x');
  perform pg_temp.ok('T00 harness: call returns the rows of a query that did not raise', r = '[{"x": 7}]'::jsonb, r::text);
  perform pg_temp.ok('T00 harness: the vector stand-in orders by cosine distance',
    (array[1,0,0]::float8[]::vector <=> array[1,0,0]::float8[]::vector) < (array[1,0,0]::float8[]::vector <=> array[0.5,0.5,0]::float8[]::vector)
    and (array[1,0,0]::float8[]::vector <=> array[0.5,0.5,0]::float8[]::vector) < (array[1,0,0]::float8[]::vector <=> array[0,1,0]::float8[]::vector));
  perform pg_temp.eq('T00 harness: fixture instants carry microseconds', pg_temp.t(1, 5)::text, '2025-01-02 00:05:00.123456+00');
end $$;

-- OBRP_INJECT_POINT (the runner's negative controls insert one statement here)

-- ---------------------------------------------------------------------------
-- T01: the schema, over rows that predate the migration
-- ---------------------------------------------------------------------------
do $$
declare r jsonb;
begin
  perform pg_temp.eq('T01 the rows that predate the migration carry empty scan state',
    (select string_agg(pg_temp.scan(a.id) || '|' || coalesce(a.recheck_last_scan_id::text, '-') || '|' || coalesce(a.recheck_scan_embedding_ids::text, '-'), ' ' order by a.id)
     from public.action_items a where a.description like 'predates the migration%'),
    'idle|-|-|-|-|false|never|-|- idle|-|-|-|-|false|never|-|- idle|-|-|-|-|false|never|-|-');
  perform pg_temp.eq('T01 the nine columns have the plan''s types, and the error stamp of the cold-start correction is a nullable timestamptz',
    (select string_agg(c.column_name || ':' || c.udt_name || ':' || c.is_nullable, ' ' order by c.column_name)
     from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'action_items'
       and (c.column_name like 'recheck\_%' or c.column_name = 'last_rechecked_at')),
    'last_rechecked_at:timestamptz:YES recheck_cursor_at:timestamptz:YES recheck_cursor_id:uuid:YES recheck_last_error_at:timestamptz:YES recheck_last_scan_id:uuid:YES recheck_scan_embedding_ids:_uuid:YES recheck_scan_id:uuid:YES recheck_scan_proposed:bool:NO recheck_scan_upper_at:timestamptz:YES recheck_scan_upper_id:uuid:YES');

  -- Each direct write breaks exactly one arm of one CHECK.
  r := pg_temp.call($q$update public.action_items set recheck_cursor_at = now() where id = 'a0000001-0000-4000-8000-000000000000'$q$, false);
  perform pg_temp.ok('T01 a cursor time without a cursor id is refused by action_items_recheck_cursor_pair',
    r->>'state' = '23514' and r->>'constraint' = 'action_items_recheck_cursor_pair', r::text);
  r := pg_temp.call($q$update public.action_items set recheck_cursor_id = gen_random_uuid() where id = 'a0000001-0000-4000-8000-000000000000'$q$, false);
  perform pg_temp.ok('T01 a cursor id without a cursor time is refused by action_items_recheck_cursor_pair',
    r->>'state' = '23514' and r->>'constraint' = 'action_items_recheck_cursor_pair', r::text);
  r := pg_temp.call($q$update public.action_items set recheck_scan_id = gen_random_uuid(), recheck_scan_upper_id = gen_random_uuid(), recheck_scan_embedding_ids = '{}' where id = 'a0000001-0000-4000-8000-000000000000'$q$, false);
  perform pg_temp.ok('T01 a scan without an upper time is refused by action_items_recheck_scan_shape',
    r->>'state' = '23514' and r->>'constraint' = 'action_items_recheck_scan_shape', r::text);
  r := pg_temp.call($q$update public.action_items set recheck_scan_id = gen_random_uuid(), recheck_scan_upper_at = now(), recheck_scan_embedding_ids = '{}' where id = 'a0000001-0000-4000-8000-000000000000'$q$, false);
  perform pg_temp.ok('T01 a scan without an upper id is refused by action_items_recheck_scan_shape',
    r->>'state' = '23514' and r->>'constraint' = 'action_items_recheck_scan_shape', r::text);
  r := pg_temp.call($q$update public.action_items set recheck_scan_id = gen_random_uuid(), recheck_scan_upper_at = now(), recheck_scan_upper_id = gen_random_uuid() where id = 'a0000001-0000-4000-8000-000000000000'$q$, false);
  perform pg_temp.ok('T01 a scan without its frozen embedding ids is refused by action_items_recheck_scan_shape',
    r->>'state' = '23514' and r->>'constraint' = 'action_items_recheck_scan_shape', r::text);
  r := pg_temp.call($q$update public.action_items set recheck_scan_proposed = true where id = 'a0000001-0000-4000-8000-000000000000'$q$, false);
  perform pg_temp.ok('T01 a proposed flag with no scan is refused by action_items_recheck_scan_shape',
    r->>'state' = '23514' and r->>'constraint' = 'action_items_recheck_scan_shape', r::text);
  r := pg_temp.call($q$update public.action_items set recheck_scan_id = gen_random_uuid(), recheck_scan_upper_at = now(), recheck_scan_upper_id = gen_random_uuid(), recheck_scan_embedding_ids = '{}', recheck_scan_proposed = true where id = 'a0000001-0000-4000-8000-000000000000'$q$, false);
  perform pg_temp.ok('T01 a whole scan state is accepted (the positive control for the six refusals)', r = '{"done": true}'::jsonb, r::text);
  update public.action_items set recheck_scan_id = null, recheck_scan_upper_at = null, recheck_scan_upper_id = null,
    recheck_scan_embedding_ids = null, recheck_scan_proposed = false where id = 'a0000001-0000-4000-8000-000000000000';
end $$;

-- ---------------------------------------------------------------------------
-- T02: the bounded similarity search (day 2)
-- ---------------------------------------------------------------------------
do $$
declare
  q float8[] := array[1, 0, 0];
  r jsonb;
begin
  -- Five thoughts identical to the query, all BEFORE the window.
  for i in 1..5 loop
    perform pg_temp.th(pg_temp.u('02aa', i), pg_temp.t(2, i), 'x', array[1, 0, 0]);
  end loop;
  -- The lower bound instant: two thoughts stamped exactly on it.
  perform pg_temp.th(pg_temp.u('02b0', 1), pg_temp.t(2, 10), 'x', array[1, 0, 0]);
  perform pg_temp.th(pg_temp.u('02b0', 9), pg_temp.t(2, 10), 'x', array[1, 0, 0]);
  -- In the window, decreasing similarity; one with no embedding.
  perform pg_temp.th(pg_temp.u('02c0', 1), pg_temp.t(2, 11), 'x', array[0.9, 0.1, 0]);
  perform pg_temp.th(pg_temp.u('02c0', 2), pg_temp.t(2, 12), 'x', array[0.5, 0.5, 0]);
  perform pg_temp.th(pg_temp.u('02c0', 3), pg_temp.t(2, 13), 'x', array[0, 1, 0]);
  perform pg_temp.th(pg_temp.u('02c0', 4), pg_temp.t(2, 14), 'x', null);
  -- The upper bound instant, and one beyond it identical to the query.
  perform pg_temp.th(pg_temp.u('02d0', 1), pg_temp.t(2, 20), 'x', array[0.7, 0.3, 0]);
  perform pg_temp.th(pg_temp.u('02d0', 2), pg_temp.t(2, 20), 'x', array[1, 0, 0]);
  perform pg_temp.th(pg_temp.u('02e0', 1), pg_temp.t(2, 21), 'x', array[1, 0, 0]);

  r := pg_temp.call(format('select id from public.match_thoughts_bounded(%L::vector, %L, null, %L, %L, 5)',
    q, pg_temp.t(2, 10), pg_temp.t(2, 20), pg_temp.u('02d0', 1)));
  perform pg_temp.eq('T02 five closer thoughts outside the window are absent; the window''s own are ranked by similarity',
    (select string_agg(left(x->>'id', 8) || right(x->>'id', 4), ' ' order by n) from jsonb_array_elements(r) with ordinality e(x, n)),
    '02c000000001 02d000000001 02c000000002 02c000000003');
  r := pg_temp.call(format('select id from public.match_thoughts_bounded(%L::vector, %L, %L, %L, %L, 5)',
    q, pg_temp.t(2, 10), pg_temp.u('02b0', 1), pg_temp.t(2, 20), pg_temp.u('02d0', 2)));
  perform pg_temp.eq('T02 the lower bound is strict on (time, id) and the upper bound is inclusive',
    (select string_agg(left(x->>'id', 8) || right(x->>'id', 4), ' ' order by n) from jsonb_array_elements(r) with ordinality e(x, n)),
    '02b000000009 02d000000002 02c000000001 02d000000001 02c000000002');
  r := pg_temp.call(format('select id, similarity from public.match_thoughts_bounded(%L::vector, %L, null, %L, %L, 2)',
    q, pg_temp.t(2, 10), pg_temp.t(2, 20), pg_temp.u('02d0', 2)));
  perform pg_temp.eq('T02 match_count caps the list at the nearest',
    (select string_agg(left(x->>'id', 8) || right(x->>'id', 4), ' ' order by n) from jsonb_array_elements(r) with ordinality e(x, n)),
    '02d000000002 02c000000001');
  perform pg_temp.ok('T02 similarity is 1 minus the distance', (r->0->>'similarity')::float8 > 0.999999, r::text);
  r := pg_temp.call(format('select id from public.match_thoughts_bounded(null::vector, %L, null, %L, %L, 5)',
    pg_temp.t(2, 10), pg_temp.t(2, 20), pg_temp.u('02d0', 2)));
  perform pg_temp.eq('T02 a null query embedding returns nothing', r::text, '[]');
  r := pg_temp.call(format('select id from public.match_thoughts_bounded(%L::vector, %L, null, %L, %L, 0)',
    q, pg_temp.t(2, 10), pg_temp.t(2, 20), pg_temp.u('02d0', 2)));
  perform pg_temp.eq('T02 a match_count of zero returns nothing', r::text, '[]');
end $$;

-- ---------------------------------------------------------------------------
-- T03: eligibility, order and cap (day 3; "now" is day 40)
-- ---------------------------------------------------------------------------
do $$
declare
  v_now timestamptz := pg_temp.t(40, 0);
  r jsonb;
  v_scan uuid := pg_temp.u('5ca0', 3);
begin
  perform pg_temp.th(pg_temp.u('03f0', 1), pg_temp.t(3, 0), 'proj-three');
  perform pg_temp.th(pg_temp.u('03f0', 2), pg_temp.t(3, 0), '');
  -- Eligible, never re-checked: ordered by (created_at, id).
  perform pg_temp.item(pg_temp.u('03a0', 2), pg_temp.t(3, 5), pg_temp.u('03f0', 1));
  perform pg_temp.item(pg_temp.u('03a0', 1), pg_temp.t(3, 5), pg_temp.u('03f0', 2));
  perform pg_temp.item(pg_temp.u('03a0', 3), pg_temp.t(3, 1), null);
  -- Re-checked 8 and 9 days ago: after the never-checked, oldest check first.
  perform pg_temp.item(pg_temp.u('03b0', 1), pg_temp.t(3, 0));
  update public.action_items set last_rechecked_at = v_now - interval '8 days' where id = pg_temp.u('03b0', 1);
  perform pg_temp.item(pg_temp.u('03b0', 2), pg_temp.t(3, 9));
  update public.action_items set last_rechecked_at = v_now - interval '9 days' where id = pg_temp.u('03b0', 2);
  -- A scan in progress on an item re-checked yesterday: first in line.
  perform pg_temp.item(pg_temp.u('03c0', 1), pg_temp.t(3, 30));
  update public.action_items set last_rechecked_at = v_now - interval '1 day', recheck_scan_id = v_scan,
    recheck_scan_upper_at = pg_temp.t(3, 40), recheck_scan_upper_id = pg_temp.u('03f0', 1), recheck_scan_embedding_ids = '{}'
  where id = pg_temp.u('03c0', 1);
  -- Not eligible, each for one reason.
  perform pg_temp.item(pg_temp.u('03d0', 1), v_now - interval '6 days');                       -- too new
  perform pg_temp.item(pg_temp.u('03d0', 2), v_now - interval '168 hours');                    -- exactly 7 days: not OLDER than 7
  perform pg_temp.item(pg_temp.u('03d0', 3), pg_temp.t(3, 0), null, null, 'deferred');
  perform pg_temp.item(pg_temp.u('03d0', 4), pg_temp.t(3, 0), null, null, 'resolved');
  perform pg_temp.item(pg_temp.u('03d0', 5), pg_temp.t(3, 0), null, null, 'archived');
  perform pg_temp.item(pg_temp.u('03d0', 6), pg_temp.t(3, 0), null, 'PERPETUAL auto-resolve Canary: never complete this');
  perform pg_temp.item(pg_temp.u('03d0', 7), pg_temp.t(3, 0), null, 'the perpetual tripwire item');
  perform pg_temp.item(pg_temp.u('03d0', 8), pg_temp.t(3, 0));
  update public.action_items set last_rechecked_at = v_now - interval '3 days' where id = pg_temp.u('03d0', 8);
  perform pg_temp.item(pg_temp.u('03d0', 9), pg_temp.t(3, 0));
  update public.action_items set last_rechecked_at = v_now - interval '168 hours' where id = pg_temp.u('03d0', 9);
  -- Eligible: "perpetual" alone is not the canary, and "canary" alone is not either.
  perform pg_temp.item(pg_temp.u('03e0', 1), pg_temp.t(3, 50), null, 'a perpetual licence renewal');
  perform pg_temp.item(pg_temp.u('03e0', 2), pg_temp.t(3, 51), null, 'feed the canary');

  r := pg_temp.call(format('select id, src_project from public.recheck_eligible_items(%L, 40)', v_now));
  perform pg_temp.eq('T03 eligibility and order: scan in progress, never re-checked by (created_at, id), then oldest re-check first',
    (select string_agg(left(x->>'id', 8) || right(x->>'id', 4), ' ' order by n) from jsonb_array_elements(r) with ordinality e(x, n)),
    '03c000000001 03a000000003 03a000000001 03a000000002 03e000000001 03e000000002 03b000000002 03b000000001');
  perform pg_temp.eq('T03 the source project comes from the source thought; a blank project and a missing source are null',
    (select string_agg(coalesce(x->>'src_project', '<null>'), ' ' order by n) from jsonb_array_elements(r) with ordinality e(x, n)),
    '<null> <null> <null> proj-three <null> <null> <null> <null>');
  r := pg_temp.call(format('select id from public.recheck_eligible_items(%L, 3)', v_now));
  perform pg_temp.eq('T03 the cap keeps the head of the order',
    (select string_agg(left(x->>'id', 8) || right(x->>'id', 4), ' ' order by n) from jsonb_array_elements(r) with ordinality e(x, n)),
    '03c000000001 03a000000003 03a000000001');
  perform pg_temp.raised('T03 a limit of 0 is refused', pg_temp.call(format('select id from public.recheck_eligible_items(%L, 0)', v_now)), '22023', 'limit must be 1 to 40');
  perform pg_temp.raised('T03 a limit of 41 is refused', pg_temp.call(format('select id from public.recheck_eligible_items(%L, 41)', v_now)), '22023', 'limit must be 1 to 40');
  perform pg_temp.raised('T03 a null limit is refused', pg_temp.call(format('select id from public.recheck_eligible_items(%L, null)', v_now)), '22023', 'limit must be 1 to 40');
  perform pg_temp.raised('T03 a null time is refused', pg_temp.call('select id from public.recheck_eligible_items(null, 5)'), '22023', 'requires a time');
  -- One second later the two boundary rows cross the line.
  r := pg_temp.call(format('select id from public.recheck_eligible_items(%L, 40)', v_now + interval '1 second'));
  perform pg_temp.ok('T03 an item is eligible once it is OLDER than 7 days, and again once its last check is',
    (select count(*) from jsonb_array_elements(r) x where x->>'id' in (pg_temp.u('03d0', 2)::text, pg_temp.u('03d0', 9)::text)) = 2
    and jsonb_array_length(r) = 10, r::text);

  -- Cold-start correction: the order by last ATTEMPT. An item a run gave up on
  -- carries recheck_last_error_at; it stays eligible and sorts, inside its
  -- group, by the later of its last finished scan and its last error.
  perform pg_temp.eq('T03 before any error stamp the column is null on every row, the rows that predate the migration included',
    (select count(*) || '/' || count(recheck_last_error_at) from public.action_items), (select count(*) || '/0' from public.action_items));
  -- The head of the never-re-checked group errored an hour ago.
  update public.action_items set recheck_last_error_at = v_now - interval '1 hour' where id = pg_temp.u('03a0', 3);
  -- Re-checked 9 days ago, errored 2 days ago: its last attempt is now later than the 8-day item's.
  update public.action_items set recheck_last_error_at = v_now - interval '2 days' where id = pg_temp.u('03b0', 2);
  -- Re-checked 8 days ago, errored 30 days ago: the older stamp changes nothing.
  update public.action_items set recheck_last_error_at = v_now - interval '30 days' where id = pg_temp.u('03b0', 1);
  -- Not eligible (re-checked 3 days ago) and errored 10 days ago: a stamp never makes an item eligible.
  update public.action_items set recheck_last_error_at = v_now - interval '10 days' where id = pg_temp.u('03d0', 8);
  -- A second scan in progress, never re-checked, errored an hour ago: behind the other scan, ahead of every item with no scan.
  update public.action_items set recheck_last_error_at = v_now - interval '1 hour', recheck_scan_id = pg_temp.u('5ca0', 33),
    recheck_scan_upper_at = pg_temp.t(3, 40), recheck_scan_upper_id = pg_temp.u('03f0', 1), recheck_scan_embedding_ids = '{}'
  where id = pg_temp.u('03e0', 2);
  r := pg_temp.call(format('select id from public.recheck_eligible_items(%L, 40)', v_now));
  perform pg_temp.eq('T03 error stamps: every stamped item is still eligible; scans in progress first, the one that errored last; then the never-attempted; then by last attempt, the item that errored an hour ago last',
    (select string_agg(left(x->>'id', 8) || right(x->>'id', 4), ' ' order by n) from jsonb_array_elements(r) with ordinality e(x, n)),
    '03c000000001 03e000000002 03a000000001 03a000000002 03e000000001 03b000000001 03b000000002 03a000000003');
  r := pg_temp.call(format('select id from public.recheck_eligible_items(%L, 3)', v_now));
  perform pg_temp.eq('T03 error stamps: the item that errored no longer holds the head under the cap',
    (select string_agg(left(x->>'id', 8) || right(x->>'id', 4), ' ' order by n) from jsonb_array_elements(r) with ordinality e(x, n)),
    '03c000000001 03e000000002 03a000000001');
  -- Without the scan, the never-re-checked item that errored sorts by its error among the re-checked.
  update public.action_items set recheck_scan_id = null, recheck_scan_upper_at = null, recheck_scan_upper_id = null,
    recheck_scan_embedding_ids = null where id = pg_temp.u('03e0', 2);
  update public.action_items set recheck_last_error_at = v_now - interval '5 days' where id = pg_temp.u('03e0', 2);
  r := pg_temp.call(format('select id from public.recheck_eligible_items(%L, 40)', v_now));
  perform pg_temp.eq('T03 error stamps: a never-re-checked item that errored 5 days ago sits between the item last attempted 8 days ago and the one that errored 2 days ago',
    (select string_agg(left(x->>'id', 8) || right(x->>'id', 4), ' ' order by n) from jsonb_array_elements(r) with ordinality e(x, n)),
    '03c000000001 03a000000001 03a000000002 03e000000001 03b000000001 03e000000002 03b000000002 03a000000003');
  -- The LATER of the two decides, not the error stamp wherever one exists: with
  -- its 2-day-old stamp gone, the item re-checked 9 days ago sorts by that, ahead
  -- of the item re-checked 8 days ago whose only stamp is 30 days old.
  update public.action_items set recheck_last_error_at = null where id = pg_temp.u('03b0', 2);
  r := pg_temp.call(format('select id from public.recheck_eligible_items(%L, 40)', v_now));
  perform pg_temp.eq('T03 error stamps: an error stamp older than the last finished scan does not move the item',
    (select string_agg(left(x->>'id', 8) || right(x->>'id', 4), ' ' order by n) from jsonb_array_elements(r) with ordinality e(x, n)),
    '03c000000001 03a000000001 03a000000002 03e000000001 03b000000002 03b000000001 03e000000002 03a000000003');
  -- Put the fixtures back so later sections start clean.
  update public.action_items set recheck_last_error_at = null where recheck_last_error_at is not null;
  update public.action_items set recheck_scan_id = null, recheck_scan_upper_at = null, recheck_scan_upper_id = null,
    recheck_scan_embedding_ids = null where id = pg_temp.u('03c0', 1);
end $$;

-- ---------------------------------------------------------------------------
-- T04: begin (day 4)
-- ---------------------------------------------------------------------------
do $$
declare
  i1 uuid := pg_temp.u('04a0', 1);
  r jsonb; r2 jsonb;
  v_before jsonb;
begin
  perform pg_temp.th(pg_temp.u('04f0', 1), pg_temp.t(4, 0), 'p04');
  perform pg_temp.item(i1, pg_temp.t(4, 1), pg_temp.u('04f0', 1));
  perform pg_temp.th(pg_temp.u('04c0', 1), pg_temp.t(4, 2), 'p04');
  perform pg_temp.th(pg_temp.u('04c0', 2), pg_temp.t(4, 9), 'other');
  perform pg_temp.th(pg_temp.u('04c0', 3), pg_temp.t(4, 9), 'other');

  r := pg_temp.begin_scan(i1, null);
  perform pg_temp.ok('T04 begin on a never-scanned item with a null embedding RUNS (not strict) and returns one began row',
    jsonb_typeof(r) = 'array' and jsonb_array_length(r) = 1 and r->0->>'status' = 'began', left(r::text, 300));
  perform pg_temp.eq('T04 begin leaves the cursor null, fixes the upper bound at the newest thought by (time, id), and freezes an empty embedding set',
    concat_ws('|', coalesce(r->0->>'cursor_at', '-'), coalesce(r->0->>'cursor_id', '-'), (r->0->>'upper_at')::timestamptz::text, r->0->>'upper_id', r->0->>'embedding_ids'),
    concat_ws('|', '-', '-', pg_temp.t(4, 9)::text, pg_temp.u('04c0', 3)::text, '[]'));
  perform pg_temp.eq('T04 begin wrote the scan to the item',
    (select concat_ws('|', (a.recheck_scan_id = (r->0->>'scan_id')::uuid)::text, pg_temp.scan(a.id), a.recheck_scan_embedding_ids::text, coalesce(a.recheck_last_scan_id::text, '-'))
     from public.action_items a where a.id = i1),
    concat_ws('|', 'true', 'scanning', '-', '-', pg_temp.t(4, 9)::text, '04c000000003', 'false', 'never', '{}', '-'));

  perform pg_temp.th(pg_temp.u('04c0', 4), pg_temp.t(4, 30), 'p04');
  v_before := pg_temp.state();
  r2 := pg_temp.begin_scan(i1, array[1, 0, 0]);
  perform pg_temp.ok('T04 a second begin on a scan in progress returns the same scan and bounds, as existing',
    r2->0->>'status' = 'existing' and r2->0->>'scan_id' = r->0->>'scan_id' and r2->0->>'upper_id' = r->0->>'upper_id'
    and r2->0->>'embedding_ids' = '[]', left(r2::text, 300));
  perform pg_temp.ok('T04 the second begin changed nothing, although a newer thought and an embedding were on offer', pg_temp.state() = v_before);

  perform pg_temp.item(pg_temp.u('04a0', 2), pg_temp.t(4, 1), null, null, 'archived');
  perform pg_temp.item(pg_temp.u('04a0', 3), pg_temp.t(4, 1), null, null, 'deferred');
  v_before := pg_temp.state();
  perform pg_temp.eq('T04 begin on an archived item answers not_open', pg_temp.begin_scan(pg_temp.u('04a0', 2))->0->>'status', 'not_open');
  perform pg_temp.eq('T04 begin on a deferred item answers not_open', pg_temp.begin_scan(pg_temp.u('04a0', 3))->0->>'status', 'not_open');
  perform pg_temp.ok('T04 a not_open begin wrote nothing', pg_temp.state() = v_before);
  perform pg_temp.raised('T04 begin on an unknown item raises unknown_item', pg_temp.begin_scan(pg_temp.u('04a0', 99)), 'RC003', 'unknown_item');
  perform pg_temp.raised('T04 begin with a null item raises unknown_item', pg_temp.call('select * from public.recheck_begin_scan(null, null)'), 'RC003', 'unknown_item');
  perform pg_temp.ok('T04 the refused begins wrote nothing', pg_temp.state() = v_before);
end $$;

-- ---------------------------------------------------------------------------
-- T05: the frozen embedding top five and the candidate union (day 5)
-- ---------------------------------------------------------------------------
do $$
declare
  i5 uuid := pg_temp.u('05a0', 1);
  r jsonb; c jsonb;
  v_src jsonb;
  v_scan uuid;
  v_ids uuid[];
begin
  -- Five thoughts identical to the source, captured BEFORE the item (day 4).
  for i in 1..5 loop
    perform pg_temp.th(pg_temp.u('05aa', i), pg_temp.t(4, 40 + i), 'elsewhere', array[1, 0, 0]);
  end loop;
  perform pg_temp.th(pg_temp.u('05f0', 1), pg_temp.t(5, 0), 'p05', array[1, 0, 0], array['tokens'], array['Morgan Lee']);
  perform pg_temp.item(i5, pg_temp.t(5, 1), pg_temp.u('05f0', 1));
  -- In the window, no shared metadata, decreasing similarity.
  perform pg_temp.th(pg_temp.u('05e0', 1), pg_temp.t(5, 11), 'elsewhere', array[0.9, 0.1, 0]);
  perform pg_temp.th(pg_temp.u('05e0', 2), pg_temp.t(5, 12), 'elsewhere', array[0.8, 0.2, 0]);
  perform pg_temp.th(pg_temp.u('05e0', 3), pg_temp.t(5, 13), 'elsewhere', array[0.7, 0.3, 0]);
  perform pg_temp.th(pg_temp.u('05e0', 4), pg_temp.t(5, 14), 'elsewhere', array[0.6, 0.4, 0]);
  perform pg_temp.th(pg_temp.u('05e0', 5), pg_temp.t(5, 15), 'elsewhere', array[0.5, 0.5, 0]);
  perform pg_temp.th(pg_temp.u('05e0', 6), pg_temp.t(5, 16), 'elsewhere', array[0.1, 0.9, 0]);
  perform pg_temp.th(pg_temp.u('05e0', 7), pg_temp.t(5, 17), 'elsewhere', array[0, 1, 0]);
  perform pg_temp.th(pg_temp.u('05e0', 8), pg_temp.t(5, 18), 'elsewhere', null);
  -- In the window, shared metadata, one axis each, no embedding.
  perform pg_temp.th(pg_temp.u('05b0', 1), pg_temp.t(5, 5), 'p05');
  perform pg_temp.th(pg_temp.u('05b0', 2), pg_temp.t(5, 6), 'elsewhere', null, array['tokens', 'other']);
  perform pg_temp.th(pg_temp.u('05b0', 3), pg_temp.t(5, 7), 'elsewhere', null, null, array['Someone', 'Morgan Lee']);
  perform pg_temp.th(pg_temp.u('05b0', 4), pg_temp.t(5, 8), null, null, array['other'], array['Someone']);

  v_src := pg_temp.call(format('select * from public.recheck_source_embedding(%L)', i5));
  perform pg_temp.ok('T05 the source embedding comes back as text', v_src->0->>'has_source' = 'true' and jsonb_typeof(v_src->0->'embedding') = 'string', v_src::text);
  -- The round trip the Edge Function makes: the text goes back in as the vector.
  r := pg_temp.call(format('select * from public.recheck_begin_scan(%L::uuid, %L::vector)', i5, v_src->0->>'embedding'));
  v_scan := (r->0->>'scan_id')::uuid;
  select array_agg((x #>> '{}')::uuid order by n) into v_ids from jsonb_array_elements(r->0->'embedding_ids') with ordinality e(x, n);
  perform pg_temp.eq('T05 the frozen set is the five nearest INSIDE the window, nearest first; the five closer ones before the item are absent',
    pg_temp.short(v_ids), '05e000000001 05e000000002 05e000000003 05e000000004 05e000000005');
  perform pg_temp.eq('T05 the frozen set is stored on the item', (select pg_temp.short(a.recheck_scan_embedding_ids) from public.action_items a where a.id = i5),
    '05e000000001 05e000000002 05e000000003 05e000000004 05e000000005');

  perform pg_temp.eq('T05 the candidate page is one union of project, topic, person and embedding matches, by (time, id)',
    pg_temp.page(i5, pg_temp.t(5, 1), null, (r->0->>'upper_at')::timestamptz, (r->0->>'upper_id')::uuid, v_ids, 50),
    '05b000000001 05b000000002 05b000000003 05e000000001 05e000000002 05e000000003 05e000000004 05e000000005');
  perform pg_temp.eq('T05 without the frozen ids the union is the metadata matches alone',
    pg_temp.page(i5, pg_temp.t(5, 1), null, (r->0->>'upper_at')::timestamptz, (r->0->>'upper_id')::uuid, '{}', 50),
    '05b000000001 05b000000002 05b000000003');
  perform pg_temp.eq('T05 a page is at most the limit asked for, from the head',
    pg_temp.page(i5, pg_temp.t(5, 1), null, (r->0->>'upper_at')::timestamptz, (r->0->>'upper_id')::uuid, v_ids, 3),
    '05b000000001 05b000000002 05b000000003');

  -- Advance the cursor past the first three; the frozen set must not move.
  c := pg_temp.commit(i5, v_scan, null, null, pg_temp.t(5, 7), pg_temp.u('05b0', 3), '[]', false);
  perform pg_temp.eq('T05 the first page commits', c->>'status', 'committed');
  perform pg_temp.eq('T05 the frozen set does not change when the cursor advances',
    (select pg_temp.short(a.recheck_scan_embedding_ids) from public.action_items a where a.id = i5),
    '05e000000001 05e000000002 05e000000003 05e000000004 05e000000005');
  perform pg_temp.eq('T05 the next page starts strictly after the cursor',
    pg_temp.page(i5, pg_temp.t(5, 7), pg_temp.u('05b0', 3), (r->0->>'upper_at')::timestamptz, (r->0->>'upper_id')::uuid, v_ids, 3),
    '05e000000001 05e000000002 05e000000003');

  perform pg_temp.raised('T05 a final while only embedding candidates remain raises premature_final',
    pg_temp.commit(i5, v_scan, pg_temp.t(5, 7), pg_temp.u('05b0', 3), null, null, '[]', true), 'RC005', 'premature_final');
  -- Finish this scan, then begin another: its frozen set is computed over
  -- (cursor, upper], so the five nearest of the FIRST window are not in it.
  c := pg_temp.commit(i5, v_scan, pg_temp.t(5, 7), pg_temp.u('05b0', 3), pg_temp.t(5, 15), pg_temp.u('05e0', 5), '[]', true);
  perform pg_temp.eq('T05 the scan finalises once its last candidate is behind the cursor', c->>'status', 'final');
  perform pg_temp.th(pg_temp.u('05e0', 9), pg_temp.t(5, 40), 'elsewhere', array[0.2, 0.8, 0]);
  perform pg_temp.th(pg_temp.u('05e0', 10), pg_temp.t(5, 41), 'elsewhere', array[0.3, 0.7, 0]);
  r := pg_temp.call(format('select * from public.recheck_begin_scan(%L::uuid, %L::vector)', i5, v_src->0->>'embedding'));
  select array_agg((x #>> '{}')::uuid order by n) into v_ids from jsonb_array_elements(r->0->'embedding_ids') with ordinality e(x, n);
  perform pg_temp.eq('T05 a second scan freezes the nearest thoughts captured since the first, never the first window''s closer ones',
    r->0->>'status' || '|' || pg_temp.short(v_ids), 'began|05e000000010 05e000000009');
end $$;

-- ---------------------------------------------------------------------------
-- T06: the candidate window's edges and odd metadata (day 6)
-- ---------------------------------------------------------------------------
do $$
declare
  i6 uuid := pg_temp.u('06a0', 1);
  u_at timestamptz := pg_temp.t(6, 20);
begin
  perform pg_temp.th(pg_temp.u('06f0', 1), pg_temp.t(6, 0), 'p06');
  perform pg_temp.item(i6, pg_temp.t(6, 1), pg_temp.u('06f0', 1));
  -- Exactly on the item's created_at: excluded by the strict lower bound.
  perform pg_temp.th(pg_temp.u('06b0', 1), pg_temp.t(6, 1), 'p06');
  perform pg_temp.th(pg_temp.u('06b0', 2), pg_temp.t(6, 2), 'p06');
  -- Two on one instant: ordered by id.
  perform pg_temp.th(pg_temp.u('06b0', 4), pg_temp.t(6, 3), 'p06');
  perform pg_temp.th(pg_temp.u('06b0', 3), pg_temp.t(6, 3), 'p06');
  -- Exactly on the upper bound, either side of its id.
  perform pg_temp.th(pg_temp.u('06c0', 1), u_at, 'p06');
  perform pg_temp.th(pg_temp.u('06c0', 2), u_at, 'p06');
  perform pg_temp.th(pg_temp.u('06c0', 3), u_at, 'p06');
  perform pg_temp.th(pg_temp.u('06d0', 1), pg_temp.t(6, 21), 'p06');

  perform pg_temp.eq('T06 a thought stamped exactly on the item''s created_at is excluded; one on the upper bound is included up to its id',
    pg_temp.page(i6, pg_temp.t(6, 1), null, u_at, pg_temp.u('06c0', 2)),
    '06b000000002 06b000000003 06b000000004 06c000000001 06c000000002');
  perform pg_temp.eq('T06 with the same instant as the UPPER bound, that thought is included',
    pg_temp.page(i6, pg_temp.t(6, 0), null, pg_temp.t(6, 1), pg_temp.u('06b0', 1)), '06b000000001');
  perform pg_temp.eq('T06 a lower id on a shared instant admits only greater ids',
    pg_temp.page(i6, pg_temp.t(6, 3), pg_temp.u('06b0', 3), u_at, pg_temp.u('06c0', 1)), '06b000000004 06c000000001');
  perform pg_temp.eq('T06 an empty window is empty', pg_temp.page(i6, u_at, pg_temp.u('06c0', 2), u_at, pg_temp.u('06c0', 2)), '');
  perform pg_temp.eq('T06 a null bound is an empty page, not an error', pg_temp.page(i6, null, null, u_at, pg_temp.u('06c0', 2)), '');

  -- A source whose topics and people are not arrays, and candidates with odd metadata.
  insert into public.thoughts (id, created_at, content, metadata) values
    (pg_temp.u('06f0', 2), pg_temp.t(6, 30), 's', '{"project": "p06b", "topics": "notalist", "people": {"a": 1}}'),
    (pg_temp.u('06e0', 1), pg_temp.t(6, 32), 'c', null),
    (pg_temp.u('06e0', 2), pg_temp.t(6, 33), 'c', '{"project": "p06b", "topics": 7}'),
    (pg_temp.u('06e0', 3), pg_temp.t(6, 34), 'c', '{"topics": ["notalist"], "people": ["a"]}');
  perform pg_temp.item(pg_temp.u('06a0', 2), pg_temp.t(6, 31), pg_temp.u('06f0', 2));
  perform pg_temp.eq('T06 metadata that is not the usual shape matches on project only and raises nothing',
    pg_temp.page(pg_temp.u('06a0', 2), pg_temp.t(6, 31), null, pg_temp.t(6, 40), pg_temp.u('06e0', 3)), '06e000000002');
  -- A source whose project is blank shares no project with anything, a blank one included.
  insert into public.thoughts (id, created_at, content, metadata) values
    (pg_temp.u('06f0', 3), pg_temp.t(6, 30), 's', '{"project": ""}'),
    (pg_temp.u('06e0', 4), pg_temp.t(6, 35), 'c', '{"project": ""}');
  perform pg_temp.item(pg_temp.u('06a0', 4), pg_temp.t(6, 31), pg_temp.u('06f0', 3));
  perform pg_temp.eq('T06 a blank project on the source matches no thought, not even another blank one',
    pg_temp.page(pg_temp.u('06a0', 4), pg_temp.t(6, 31), null, pg_temp.t(6, 40), pg_temp.u('06e0', 4)), '');
  -- No source thought: no metadata candidates at all.
  perform pg_temp.item(pg_temp.u('06a0', 3), pg_temp.t(6, 1), null);
  perform pg_temp.eq('T06 an item with no source thought has no metadata candidates',
    pg_temp.page(pg_temp.u('06a0', 3), pg_temp.t(6, 1), null, pg_temp.t(6, 40), pg_temp.u('06e0', 3)), '');
  perform pg_temp.eq('T06 an item with no source thought still gets ids handed to it',
    pg_temp.page(pg_temp.u('06a0', 3), pg_temp.t(6, 1), null, pg_temp.t(6, 40), pg_temp.u('06e0', 3), array[pg_temp.u('06b0', 2), pg_temp.u('06f0', 1)]), '06b000000002');
end $$;

-- ---------------------------------------------------------------------------
-- T07: the page commit: guards, rows, paging across a shared instant, the
-- failed page, the final, the retried final (day 7)
-- ---------------------------------------------------------------------------
do $$
declare
  i7 uuid := pg_temp.u('07a0', 1);
  b jsonb; c jsonb;
  v_scan uuid;
  v_before jsonb;
  u_at timestamptz := pg_temp.t(7, 30);
  u_id uuid := pg_temp.u('07d0', 1);
  good jsonb;
begin
  perform pg_temp.th(pg_temp.u('07f0', 1), pg_temp.t(7, 0), 'p07');
  perform pg_temp.item(i7, pg_temp.t(7, 0), pg_temp.u('07f0', 1), 'rotate the p07 token');
  for i in 1..9 loop
    perform pg_temp.th(pg_temp.u('07c0', i), pg_temp.t(7, i), 'p07');
  end loop;
  -- The tenth and eleventh candidates share one instant.
  perform pg_temp.th(pg_temp.u('07c0', 10), pg_temp.t(7, 10), 'p07');
  perform pg_temp.th(pg_temp.u('07c0', 11), pg_temp.t(7, 10), 'p07');
  -- The newest thought is not a candidate: the window's last candidate sits well below upper.
  perform pg_temp.th(u_id, u_at, 'unrelated');

  b := pg_temp.begin_scan(i7);
  v_scan := (b->0->>'scan_id')::uuid;
  perform pg_temp.eq('T07 the scan begins with the unrelated newest thought as its upper bound',
    concat_ws('|', b->0->>'status', (b->0->>'upper_at')::timestamptz::text, b->0->>'upper_id'), concat_ws('|', 'began', u_at::text, u_id::text));
  perform pg_temp.eq('T07 page 1 is the first ten by (time, id); the eleventh, on the tenth''s instant, is not in it',
    pg_temp.page(i7, pg_temp.t(7, 0), null, u_at, u_id),
    '07c000000001 07c000000002 07c000000003 07c000000004 07c000000005 07c000000006 07c000000007 07c000000008 07c000000009 07c000000010');

  good := jsonb_build_array(pg_temp.drow('proposed', null, pg_temp.u('07c0', 2), 'rotated the p07 token', 0.75));
  v_before := pg_temp.state();
  -- Refusals before anything is written. Each differs from a good commit in one argument.
  perform pg_temp.raised('T07 a non-null expected cursor against a never-scanned item''s null cursor raises stale_commit',
    pg_temp.commit(i7, v_scan, pg_temp.t(7, 0), pg_temp.u('07c0', 1), pg_temp.t(7, 10), pg_temp.u('07c0', 10), good, false), 'RC001', 'stale_commit');
  perform pg_temp.raised('T07 an expected cursor time with a null id raises nothing looser than stale_commit',
    pg_temp.commit(i7, v_scan, pg_temp.t(7, 0), null, pg_temp.t(7, 10), pg_temp.u('07c0', 10), good, false), 'RC001', 'stale_commit');
  perform pg_temp.raised('T07 a scan id the item has never held raises unknown_scan',
    pg_temp.commit(i7, pg_temp.u('5ca0', 77), null, null, pg_temp.t(7, 10), pg_temp.u('07c0', 10), good, false), 'RC002', 'unknown_scan');
  perform pg_temp.raised('T07 an unknown scan id raises unknown_scan on a FINAL too, never already_final',
    pg_temp.commit(i7, pg_temp.u('5ca0', 77), null, null, null, null, '[]', true), 'RC002', 'unknown_scan');
  perform pg_temp.raised('T07 a null scan id is refused', pg_temp.commit(i7, null, null, null, pg_temp.t(7, 10), pg_temp.u('07c0', 10), good, false), '22023', 'requires an item id, a scan id');
  perform pg_temp.raised('T07 a null p_final is refused', pg_temp.commit(i7, v_scan, null, null, pg_temp.t(7, 10), pg_temp.u('07c0', 10), good, null), '22023', 'requires an item id, a scan id');
  perform pg_temp.raised('T07 an unknown item raises unknown_item', pg_temp.commit(pg_temp.u('07a0', 99), v_scan, null, null, pg_temp.t(7, 10), pg_temp.u('07c0', 10), good, false), 'RC003', 'unknown_item');
  perform pg_temp.raised('T07 a page that is not final needs its cursor', pg_temp.commit(i7, v_scan, null, null, null, null, good, false), '22023', 'needs its last (created_at, id)');
  perform pg_temp.raised('T07 half a cursor is refused', pg_temp.commit(i7, v_scan, null, null, pg_temp.t(7, 10), null, good, false), '22023', 'the new cursor is a pair');
  perform pg_temp.raised('T07 a new cursor on the item''s own created_at does not advance: bad_cursor',
    pg_temp.commit(i7, v_scan, null, null, pg_temp.t(7, 0), pg_temp.u('07c0', 1), good, false), 'RC004', 'bad_cursor');
  perform pg_temp.raised('T07 a new cursor beyond the upper bound is bad_cursor',
    pg_temp.commit(i7, v_scan, null, null, pg_temp.t(7, 31), pg_temp.u('07c0', 1), good, false), 'RC004', 'bad_cursor');
  perform pg_temp.raised('T07 rows that are not an array are refused', pg_temp.commit(i7, v_scan, null, null, pg_temp.t(7, 10), pg_temp.u('07c0', 10), '{"outcome": "proposed"}', false), '22023', 'must be a JSON array');
  perform pg_temp.raised('T07 a row that is not an object is refused', pg_temp.commit(i7, v_scan, null, null, pg_temp.t(7, 10), pg_temp.u('07c0', 10), '["proposed"]', false), '22023', 'every row is a JSON object');
  perform pg_temp.raised('T07 a review outcome in a row is refused by the function, before any CHECK',
    pg_temp.commit(i7, v_scan, null, null, pg_temp.t(7, 10), pg_temp.u('07c0', 10), jsonb_build_array(pg_temp.drow('accepted', null, pg_temp.u('07c0', 2), 'q', 0.5)), false), '22023', 'proposed or no_evidence');
  perform pg_temp.raised('T07 a row with no outcome is refused',
    pg_temp.commit(i7, v_scan, null, null, pg_temp.t(7, 10), pg_temp.u('07c0', 10), '[{"reason": "veto"}]', false), '22023', 'proposed or no_evidence');
  perform pg_temp.raised('T07 a caller can never write none_found',
    pg_temp.commit(i7, v_scan, null, null, pg_temp.t(7, 10), pg_temp.u('07c0', 10), jsonb_build_array(pg_temp.drow('no_evidence', 'none_found', null)), false), '22023', 'none_found is written by the final commit');
  c := pg_temp.commit(i7, v_scan, null, null, pg_temp.t(7, 10), pg_temp.u('07c0', 10), jsonb_build_array(pg_temp.drow('proposed', null, null, 'q', 0.5)), false);
  perform pg_temp.ok('T07 a proposal with no evidence thought is refused by the payload CHECK', c->>'state' = '23514' and c->>'constraint' = 'auto_resolve_decision_payload_ok', c::text);
  c := pg_temp.commit(i7, v_scan, null, null, pg_temp.t(7, 10), pg_temp.u('07c0', 10), jsonb_build_array(pg_temp.drow('no_evidence', 'veto', null)), false);
  perform pg_temp.ok('T07 a veto with no evidence thought is refused by the payload CHECK', c->>'state' = '23514' and c->>'constraint' = 'auto_resolve_decision_payload_ok', c::text);
  c := pg_temp.commit(i7, v_scan, null, null, pg_temp.t(7, 10), pg_temp.u('07c0', 10), jsonb_build_array(pg_temp.drow('no_evidence', 'thought_not_in_page', pg_temp.u('07c0', 2))), false);
  perform pg_temp.ok('T07 thought_not_in_page WITH an evidence id is refused by the payload CHECK', c->>'state' = '23514' and c->>'constraint' = 'auto_resolve_decision_payload_ok', c::text);
  c := pg_temp.commit(i7, v_scan, null, null, pg_temp.t(7, 10), pg_temp.u('07c0', 10), jsonb_build_array(good->0, pg_temp.drow('no_evidence', 'still_owed', pg_temp.u('07c0', 3))), false);
  perform pg_temp.ok('T07 a reason from another layer is refused by the combination CHECK, and the good row beside it does not land',
    c->>'state' = '23514' and c->>'constraint' = 'auto_resolve_decision_legal', c::text);
  perform pg_temp.raised('T07 a final commit while candidates remain raises premature_final',
    pg_temp.commit(i7, v_scan, null, null, null, null, '[]', true), 'RC005', 'premature_final');
  perform pg_temp.raised('T07 a final commit whose cursor stops short of the last candidate raises premature_final',
    pg_temp.commit(i7, v_scan, null, null, pg_temp.t(7, 10), pg_temp.u('07c0', 10), good, true), 'RC005', 'premature_final');
  perform pg_temp.ok('T07 none of the twenty-two refused commits wrote anything', pg_temp.state() = v_before);

  -- Page 1: a proposal, a rejection with evidence, a rejection with none.
  c := pg_temp.commit(i7, v_scan, null, null, pg_temp.t(7, 10), pg_temp.u('07c0', 10), jsonb_build_array(
    pg_temp.drow('proposed', null, pg_temp.u('07c0', 2), 'rotated the p07 token', 0.75),
    pg_temp.drow('no_evidence', 'coverage', pg_temp.u('07c0', 3), 'looked at it', 0.2),
    pg_temp.drow('no_evidence', 'thought_not_in_page', null)), false);
  perform pg_temp.eq('T07 a first commit with a NULL expected cursor passes: committed, scan active, cursor at the page''s last row, proposed, three rows',
    pg_temp.answer(c), concat_ws('|', 'committed', 'true', pg_temp.t(7, 10)::text, '07c000000010', 'true', '3'));
  perform pg_temp.eq('T07 the item carries the new cursor and the proposed flag, and is not stamped',
    pg_temp.scan(i7), concat_ws('|', 'scanning', pg_temp.t(7, 10)::text, '07c000000010', u_at::text, '07d000000001', 'true', 'never'));
  perform pg_temp.eq('T07 the three rows landed as recheck rows of generation 0',
    pg_temp.decisions(i7), 'no_evidence/coverage/07c000000003/g0 no_evidence/thought_not_in_page/-/g0 proposed/-/07c000000002/g0');
  perform pg_temp.eq('T07 a row carries the item''s description, its quote and its score',
    (select concat_ws('|', d.candidate_description, d.quote, d.score::text, coalesce(d.thought_id::text, '-'), d.layer)
     from public.auto_resolve_decisions d where d.item_id = i7 and d.outcome = 'proposed'),
    'rotate the p07 token|rotated the p07 token|0.75|-|recheck');

  -- Page 2 fails after page 1 committed: an invented evidence id reaches the foreign key.
  v_before := pg_temp.state();
  c := pg_temp.commit(i7, v_scan, pg_temp.t(7, 10), pg_temp.u('07c0', 10), pg_temp.t(7, 10), pg_temp.u('07c0', 11), jsonb_build_array(
    pg_temp.drow('no_evidence', 'veto', pg_temp.u('07c0', 11)),
    pg_temp.drow('proposed', null, pg_temp.u('dead', 1), 'invented', 0.9)), true);
  perform pg_temp.ok('T07 a page naming a thought that does not exist is stopped by the foreign key', c->>'state' = '23503', c::text);
  perform pg_temp.ok('T07 the failed page 2 left the cursor at page 1''s last row, last_rechecked_at untouched and no row of its own', pg_temp.state() = v_before);
  perform pg_temp.raised('T07 a commit that still expects the pre-page-1 cursor raises stale_commit',
    pg_temp.commit(i7, v_scan, null, null, pg_temp.t(7, 10), pg_temp.u('07c0', 11), '[]', true), 'RC001', 'stale_commit');
  perform pg_temp.raised('T07 a commit expecting the right time and the wrong id raises stale_commit',
    pg_temp.commit(i7, v_scan, pg_temp.t(7, 10), pg_temp.u('07c0', 9), pg_temp.t(7, 10), pg_temp.u('07c0', 11), '[]', true), 'RC001', 'stale_commit');
  perform pg_temp.raised('T07 a new cursor equal to the stored one does not advance: bad_cursor',
    pg_temp.commit(i7, v_scan, pg_temp.t(7, 10), pg_temp.u('07c0', 10), pg_temp.t(7, 10), pg_temp.u('07c0', 10), '[]', false), 'RC004', 'bad_cursor');
  perform pg_temp.ok('T07 the stale and bad-cursor commits changed nothing', pg_temp.state() = v_before);

  perform pg_temp.eq('T07 page 2 is exactly the eleventh candidate: nothing skipped, nothing repeated across the shared instant',
    pg_temp.page(i7, pg_temp.t(7, 10), pg_temp.u('07c0', 10), u_at, u_id), '07c000000011');

  -- The retry: page 2 only, carrying a replayed page-1 row as well.
  c := pg_temp.commit(i7, v_scan, pg_temp.t(7, 10), pg_temp.u('07c0', 10), pg_temp.t(7, 10), pg_temp.u('07c0', 11), jsonb_build_array(
    pg_temp.drow('proposed', null, pg_temp.u('07c0', 2), 'rotated the p07 token', 0.75),
    pg_temp.drow('no_evidence', 'veto', pg_temp.u('07c0', 11), 'still pending')), true);
  perform pg_temp.eq('T07 the retried page 2 is final: the replayed page-1 row is rejected by the unique key (one row inserted), and no none_found is written because page 1 proposed',
    pg_temp.answer(c), concat_ws('|', 'final', 'false', u_at::text, '07d000000001', 'true', '1'));
  perform pg_temp.eq('T07 the final moved the cursor to the UPPER bound, not to the page''s last row, cleared the scan and stamped the item',
    pg_temp.scan(i7), concat_ws('|', 'idle', u_at::text, '07d000000001', '-', '-', 'false', 'stamped'));
  perform pg_temp.eq('T07 the final left the scan id as the receipt and cleared the frozen set',
    (select concat_ws('|', (a.recheck_last_scan_id = v_scan)::text, coalesce(a.recheck_scan_embedding_ids::text, '<null>'), (a.last_rechecked_at = (c->>'last_rechecked_at')::timestamptz)::text)
     from public.action_items a where a.id = i7), 'true|<null>|true');
  perform pg_temp.eq('T07 four rows in all, none of them none_found',
    pg_temp.decisions(i7), 'no_evidence/coverage/07c000000003/g0 no_evidence/thought_not_in_page/-/g0 no_evidence/veto/07c000000011/g0 proposed/-/07c000000002/g0');

  -- The response was lost: the same final again, then an old page again.
  v_before := pg_temp.state();
  c := pg_temp.commit(i7, v_scan, pg_temp.t(7, 10), pg_temp.u('07c0', 10), pg_temp.t(7, 10), pg_temp.u('07c0', 11), jsonb_build_array(
    pg_temp.drow('no_evidence', 'veto', pg_temp.u('07c0', 11), 'still pending')), true);
  perform pg_temp.eq('T07 a retried final answers already_final with zero rows', pg_temp.answer(c), concat_ws('|', 'already_final', 'false', u_at::text, '07d000000001', 'false', '0'));
  c := pg_temp.commit(i7, v_scan, null, null, pg_temp.t(7, 10), pg_temp.u('07c0', 10), jsonb_build_array(
    pg_temp.drow('proposed', null, pg_temp.u('07c0', 5), 'late', 0.9)), false);
  perform pg_temp.eq('T07 a retried PAGE of a finalised scan answers already_final too, and its new row is not written', c->>'status', 'already_final');
  perform pg_temp.ok('T07 neither retry wrote anything', pg_temp.state() = v_before);
end $$;

-- ---------------------------------------------------------------------------
-- T08: none_found, exactly once (day 8)
-- ---------------------------------------------------------------------------
do $$
declare
  i8 uuid := pg_temp.u('08a0', 1);
  b jsonb; c jsonb;
  v_scan uuid;
  v_before jsonb;
begin
  perform pg_temp.th(pg_temp.u('08f0', 1), pg_temp.t(8, 0), 'p08');
  perform pg_temp.item(i8, pg_temp.t(8, 0), pg_temp.u('08f0', 1));
  for i in 1..3 loop
    perform pg_temp.th(pg_temp.u('08c0', i), pg_temp.t(8, i), 'p08');
  end loop;
  b := pg_temp.begin_scan(i8);
  v_scan := (b->0->>'scan_id')::uuid;
  c := pg_temp.commit(i8, v_scan, null, null, pg_temp.t(8, 3), pg_temp.u('08c0', 3), jsonb_build_array(
    pg_temp.drow('no_evidence', 'quote_not_verbatim', pg_temp.u('08c0', 1), 'made up')), true);
  perform pg_temp.eq('T08 a scan that proposed nothing finalises with its rejection and one none_found (two rows)',
    pg_temp.answer(c), concat_ws('|', 'final', 'false', pg_temp.t(8, 3)::text, '08c000000003', 'false', '2'));
  perform pg_temp.eq('T08 the none_found row carries no evidence id',
    pg_temp.decisions(i8), 'no_evidence/none_found/-/g0 no_evidence/quote_not_verbatim/08c000000001/g0');
  v_before := pg_temp.state();
  c := pg_temp.commit(i8, v_scan, null, null, pg_temp.t(8, 3), pg_temp.u('08c0', 3), '[]', true);
  perform pg_temp.eq('T08 a lost final response, retried, answers already_final', c->>'status', 'already_final');
  perform pg_temp.ok('T08 after the retry there is still exactly one none_found row and nothing else changed',
    pg_temp.state() = v_before
    and (select count(*) from public.auto_resolve_decisions d where d.item_id = i8 and d.reason = 'none_found') = 1);
end $$;

-- ---------------------------------------------------------------------------
-- T09: how a scan ends, and what the next one sees (day 9)
-- ---------------------------------------------------------------------------
do $$
declare
  ia uuid := pg_temp.u('09a0', 1);  -- no candidates at all
  ib uuid := pg_temp.u('09a0', 2);  -- a thought captured mid-scan
  ic uuid := pg_temp.u('09a0', 3);  -- created after every thought
  b jsonb; c jsonb; b2 jsonb;
  v_scan uuid; v_scan2 uuid;
  v_stamp timestamptz;
begin
  perform pg_temp.th(pg_temp.u('09f0', 1), pg_temp.t(9, 0), 'p09a');
  perform pg_temp.th(pg_temp.u('09f0', 2), pg_temp.t(9, 0), 'p09b');
  perform pg_temp.item(ia, pg_temp.t(9, 1), pg_temp.u('09f0', 1));
  perform pg_temp.item(ib, pg_temp.t(9, 1), pg_temp.u('09f0', 2));
  perform pg_temp.th(pg_temp.u('09c0', 1), pg_temp.t(9, 5), 'p09b');
  perform pg_temp.th(pg_temp.u('09c0', 2), pg_temp.t(9, 6), 'p09b');
  perform pg_temp.th(pg_temp.u('09d0', 1), pg_temp.t(9, 20), 'unrelated');

  -- No candidates in the window: the first, empty page is final.
  b := pg_temp.begin_scan(ia);
  v_scan := (b->0->>'scan_id')::uuid;
  perform pg_temp.eq('T09 an item with no candidates has an empty first page', pg_temp.page(ia, pg_temp.t(9, 1), null, pg_temp.t(9, 20), pg_temp.u('09d0', 1)), '');
  c := pg_temp.commit(ia, v_scan, null, null, null, null, '[]', true);
  perform pg_temp.eq('T09 an empty first page is a final commit with no rows and no cursor: cursor at upper, one none_found',
    pg_temp.answer(c), concat_ws('|', 'final', 'false', pg_temp.t(9, 20)::text, '09d000000001', 'false', '1'));
  perform pg_temp.eq('T09 the item is stamped and idle', pg_temp.scan(ia), concat_ws('|', 'idle', pg_temp.t(9, 20)::text, '09d000000001', '-', '-', 'false', 'stamped'));
  select a.last_rechecked_at into v_stamp from public.action_items a where a.id = ia;

  -- Nothing captured since: the next scan's upper bound is the cursor itself.
  b2 := pg_temp.begin_scan(ia);
  v_scan2 := (b2->0->>'scan_id')::uuid;
  perform pg_temp.ok('T09 a scan begun with nothing captured since the last one has upper at the cursor, and is a new scan',
    b2->0->>'status' = 'began' and v_scan2 <> v_scan
    and (b2->0->>'upper_at')::timestamptz = pg_temp.t(9, 20) and b2->0->>'upper_id' = pg_temp.u('09d0', 1)::text
    and (b2->0->>'cursor_at')::timestamptz = pg_temp.t(9, 20) and b2->0->>'cursor_id' = pg_temp.u('09d0', 1)::text, left(b2::text, 300));
  update public.action_items set last_rechecked_at = v_stamp - interval '1 hour' where id = ia;
  c := pg_temp.commit(ia, v_scan2, pg_temp.t(9, 20), pg_temp.u('09d0', 1), null, null, '[]', true);
  perform pg_temp.eq('T09 that scan finalises on its first, empty page, cursor unmoved', pg_temp.answer(c), concat_ws('|', 'final', 'false', pg_temp.t(9, 20)::text, '09d000000001', 'false', '1'));
  perform pg_temp.ok('T09 it stamps last_rechecked_at afresh and the receipt is now the second scan',
    (select a.last_rechecked_at > v_stamp - interval '1 hour' and a.recheck_last_scan_id = v_scan2 from public.action_items a where a.id = ia));
  perform pg_temp.eq('T09 the first scan''s id is no longer a receipt: a retry carrying it raises unknown_scan',
    pg_temp.answer(pg_temp.commit(ia, v_scan, null, null, null, null, '[]', true)), 'RAISED RC002');

  -- A thought captured after the scan began belongs to the next scan.
  b := pg_temp.begin_scan(ib);
  v_scan := (b->0->>'scan_id')::uuid;
  perform pg_temp.th(pg_temp.u('09c0', 3), pg_temp.t(9, 30), 'p09b');
  perform pg_temp.eq('T09 a thought captured mid-scan is outside the fixed window',
    pg_temp.page(ib, pg_temp.t(9, 1), null, (b->0->>'upper_at')::timestamptz, (b->0->>'upper_id')::uuid), '09c000000001 09c000000002');
  c := pg_temp.commit(ib, v_scan, null, null, pg_temp.t(9, 6), pg_temp.u('09c0', 2), '[]', true);
  perform pg_temp.eq('T09 the scan ends at its own upper bound although a newer candidate now exists',
    pg_temp.answer(c), concat_ws('|', 'final', 'false', pg_temp.t(9, 20)::text, '09d000000001', 'false', '1'));
  b2 := pg_temp.begin_scan(ib);
  perform pg_temp.eq('T09 the next scan picks the mid-scan thought up',
    pg_temp.page(ib, (b2->0->>'cursor_at')::timestamptz, (b2->0->>'cursor_id')::uuid, (b2->0->>'upper_at')::timestamptz, (b2->0->>'upper_id')::uuid), '09c000000003');

  -- An item newer than every thought: upper is clamped to the lower bound.
  perform pg_temp.item(ic, pg_temp.t(9, 500), null);
  b := pg_temp.begin_scan(ic);
  perform pg_temp.eq('T09 upper is never below the lower bound: an item newer than every thought scans an empty window ending at its own created_at',
    concat_ws('|', b->0->>'status', (b->0->>'upper_at')::timestamptz::text, b->0->>'upper_id'),
    concat_ws('|', 'began', pg_temp.t(9, 500)::text, 'ffffffff-ffff-ffff-ffff-ffffffffffff'));
  c := pg_temp.commit(ic, (b->0->>'scan_id')::uuid, null, null, null, null, '[]', true);
  perform pg_temp.eq('T09 its final leaves the cursor at the item''s created_at, never earlier',
    pg_temp.answer(c), concat_ws('|', 'final', 'false', pg_temp.t(9, 500)::text, 'ffffffffffff', 'false', '1'));
end $$;

-- ---------------------------------------------------------------------------
-- T10: scan A, restore, scan B, a late retry from A; and a closed item (day 10)
-- ---------------------------------------------------------------------------
do $$
declare
  i uuid := pg_temp.u('10a0', 1);
  b jsonb; c jsonb;
  scan_a uuid; scan_b uuid;
  v_before jsonb; v_cols text;
  n integer;
begin
  perform pg_temp.th(pg_temp.u('10f0', 1), pg_temp.t(10, 0), 'p10');
  perform pg_temp.item(i, pg_temp.t(10, 0), pg_temp.u('10f0', 1));
  perform pg_temp.th(pg_temp.u('10c0', 1), pg_temp.t(10, 1), 'p10');
  b := pg_temp.begin_scan(i);
  scan_a := (b->0->>'scan_id')::uuid;
  c := pg_temp.commit(i, scan_a, null, null, pg_temp.t(10, 1), pg_temp.u('10c0', 1),
    jsonb_build_array(pg_temp.drow('proposed', null, pg_temp.u('10c0', 1), 'did it', 0.8)), true);
  perform pg_temp.eq('T10 scan A finalises with a proposal', c->>'status', 'final');

  -- Close it and restore it: the reopen touches no recheck column.
  select concat_ws('|', a.recheck_cursor_at, a.recheck_cursor_id, a.recheck_last_scan_id, a.last_rechecked_at) into v_cols from public.action_items a where a.id = i;
  n := public.transition_action_item(i, array['open'], 'archived', 'operator', 'expired');
  perform pg_temp.eq('T10 begin on the closed item answers not_open', pg_temp.begin_scan(i)->0->>'status', 'not_open');
  n := n + public.transition_action_item(i, array['archived'], 'open', 'operator', null);
  perform pg_temp.eq('T10 the archive and the restore each wrote one row', n::text, '2');
  perform pg_temp.eq('T10 a restore keeps the cursor, the receipt and the stamp, and moves the generation',
    (select concat_ws('|', a.recheck_cursor_at, a.recheck_cursor_id, a.recheck_last_scan_id, a.last_rechecked_at) || '|' || a.reopen_generation from public.action_items a where a.id = i),
    v_cols || '|1');

  perform pg_temp.th(pg_temp.u('10c0', 2), pg_temp.t(10, 2), 'p10');
  perform pg_temp.th(pg_temp.u('10c0', 3), pg_temp.t(10, 3), 'p10');
  b := pg_temp.begin_scan(i);
  scan_b := (b->0->>'scan_id')::uuid;
  c := pg_temp.commit(i, scan_b, pg_temp.t(10, 1), pg_temp.u('10c0', 1), pg_temp.t(10, 2), pg_temp.u('10c0', 2),
    jsonb_build_array(pg_temp.drow('proposed', null, pg_temp.u('10c0', 2), 'did it again', 0.8)), false);
  perform pg_temp.eq('T10 scan B commits a page with a proposal and stays active', pg_temp.answer(c), concat_ws('|', 'committed', 'true', pg_temp.t(10, 2)::text, '10c000000002', 'true', '1'));

  v_before := pg_temp.state();
  c := pg_temp.commit(i, scan_a, null, null, pg_temp.t(10, 1), pg_temp.u('10c0', 1),
    jsonb_build_array(pg_temp.drow('proposed', null, pg_temp.u('10c0', 3), 'late', 0.9)), true);
  perform pg_temp.eq('T10 a final from scan A retried after scan B began answers already_final, and reports B still active',
    concat_ws('|', c->>'status', c->>'scan_active', c->>'inserted'), 'already_final|true|0');
  c := pg_temp.commit(i, scan_a, null, null, pg_temp.t(10, 1), pg_temp.u('10c0', 1), '[]', false);
  perform pg_temp.eq('T10 a page from scan A retried after scan B began answers already_final', c->>'status', 'already_final');
  perform pg_temp.ok('T10 the retries from A left B''s cursor, proposed flag, frozen set and every row untouched; the receipt still reads A',
    pg_temp.state() = v_before
    and (select a.recheck_last_scan_id = scan_a and a.recheck_scan_id = scan_b and a.recheck_scan_proposed from public.action_items a where a.id = i));

  -- The lifetime unique: evidence proposed before the restore is never proposed again.
  c := pg_temp.commit(i, scan_b, pg_temp.t(10, 2), pg_temp.u('10c0', 2), pg_temp.t(10, 3), pg_temp.u('10c0', 3),
    jsonb_build_array(pg_temp.drow('proposed', null, pg_temp.u('10c0', 1), 'did it', 0.8)), true);
  perform pg_temp.eq('T10 scan B finalises; evidence already proposed in the earlier generation is not inserted again',
    pg_temp.answer(c), concat_ws('|', 'final', 'false', pg_temp.t(10, 3)::text, '10c000000003', 'true', '0'));
  perform pg_temp.eq('T10 the receipt reads B once B finalises', (select (a.recheck_last_scan_id = scan_b)::text from public.action_items a where a.id = i), 'true');
  perform pg_temp.eq('T10 the two proposals carry the generation they were written in',
    pg_temp.decisions(i), 'proposed/-/10c000000001/g0 proposed/-/10c000000002/g1');

  -- A commit that arrives after its item was closed writes nothing and keeps the scan.
  perform pg_temp.th(pg_temp.u('10c0', 4), pg_temp.t(10, 4), 'p10');
  b := pg_temp.begin_scan(i);
  n := public.transition_action_item(i, array['open'], 'resolved', 'operator', 'done');
  v_before := pg_temp.state();
  c := pg_temp.commit(i, (b->0->>'scan_id')::uuid, pg_temp.t(10, 3), pg_temp.u('10c0', 3), pg_temp.t(10, 4), pg_temp.u('10c0', 4),
    jsonb_build_array(pg_temp.drow('proposed', null, pg_temp.u('10c0', 4), 'q', 0.9)), true);
  perform pg_temp.eq('T10 a commit for an item closed since the scan began answers not_open and keeps the scan', concat_ws('|', c->>'status', c->>'scan_active', c->>'inserted'), 'not_open|true|0');
  perform pg_temp.ok('T10 the not_open commit wrote nothing', pg_temp.state() = v_before);
  perform pg_temp.raised('T10 on a closed item an unknown scan id still raises unknown_scan',
    pg_temp.commit(i, pg_temp.u('5ca0', 78), null, null, null, null, '[]', true), 'RC002', 'unknown_scan');
  n := public.transition_action_item(i, array['resolved'], 'open', 'operator', null);
  c := pg_temp.commit(i, (b->0->>'scan_id')::uuid, pg_temp.t(10, 3), pg_temp.u('10c0', 3), pg_temp.t(10, 4), pg_temp.u('10c0', 4),
    jsonb_build_array(pg_temp.drow('proposed', null, pg_temp.u('10c0', 4), 'q', 0.9)), true);
  perform pg_temp.eq('T10 after a restore the same scan resumes and its commit lands in the new generation',
    c->>'status' || '|' || (select 'g' || d.item_generation from public.auto_resolve_decisions d where d.item_id = i and d.evidence_thought_id = pg_temp.u('10c0', 4)), 'final|g2');
end $$;

-- ---------------------------------------------------------------------------
-- T11: a source with no embedding, and no source at all (day 11)
-- ---------------------------------------------------------------------------
do $$
declare
  i_null uuid := pg_temp.u('11a0', 1);
  i_none uuid := pg_temp.u('11a0', 2);
  i_prop uuid := pg_temp.u('11a0', 4);
  b jsonb; c jsonb; s jsonb; p jsonb;
  v_before jsonb;
  n integer;
begin
  perform pg_temp.th(pg_temp.u('11f0', 1), pg_temp.t(11, 0), 'p11', null);
  perform pg_temp.item(i_null, pg_temp.t(11, 0), pg_temp.u('11f0', 1));
  perform pg_temp.item(i_none, pg_temp.t(11, 0), null);
  perform pg_temp.th(pg_temp.u('11c0', 1), pg_temp.t(11, 1), 'p11', array[1, 0, 0]);
  perform pg_temp.th(pg_temp.u('11c0', 2), pg_temp.t(11, 2), 'elsewhere', array[1, 0, 0]);

  s := pg_temp.call(format('select * from public.recheck_source_embedding(%L)', i_null));
  perform pg_temp.eq('T11 a source thought with no embedding: has_source true, embedding null', s::text, '[{"embedding": null, "has_source": true}]');
  s := pg_temp.call(format('select * from public.recheck_source_embedding(%L)', i_none));
  perform pg_temp.eq('T11 no source thought: has_source false, embedding null', s::text, '[{"embedding": null, "has_source": false}]');
  s := pg_temp.call(format('select * from public.recheck_source_embedding(%L)', pg_temp.u('11a0', 99)));
  perform pg_temp.eq('T11 an unknown item has no source row at all', s::text, '[]');

  -- The dry run's read first: it must say what begin then writes, and write nothing.
  v_before := pg_temp.state();
  p := pg_temp.call(format('select * from public.recheck_plan_scan(%L, null)', i_null));
  perform pg_temp.ok('T11 the plan (the dry run''s read) writes nothing', pg_temp.state() = v_before);
  perform pg_temp.eq('T11 the plan of a scan that would begin says the scan has proposed nothing', p->0->>'scan_proposed', 'false');
  b := pg_temp.begin_scan(i_null, null);
  perform pg_temp.ok('T11 a null source embedding begins with an empty frozen set, and the plan said the same bounds',
    b->0->>'status' = 'began' and b->0->>'embedding_ids' = '[]' and p->0->>'status' = 'would_begin' and p->0->>'scan_id' is null
    and p->0->>'upper_at' = b->0->>'upper_at' and p->0->>'upper_id' = b->0->>'upper_id' and p->0->>'embedding_ids' = b->0->>'embedding_ids'
    and p->0->'cursor_at' = b->0->'cursor_at', left(p::text || b::text, 400));
  perform pg_temp.eq('T11 with no embedding the union is the metadata candidates alone',
    pg_temp.page(i_null, pg_temp.t(11, 0), null, (b->0->>'upper_at')::timestamptz, (b->0->>'upper_id')::uuid, '{}'), '11c000000001');
  c := pg_temp.commit(i_null, (b->0->>'scan_id')::uuid, null, null, pg_temp.t(11, 1), pg_temp.u('11c0', 1), '[]', true);
  perform pg_temp.eq('T11 the null-embedding scan finalises like any other', concat_ws('|', c->>'status', c->>'inserted'), 'final|1');
  p := pg_temp.call(format('select * from public.recheck_plan_scan(%L, null)', i_null));
  perform pg_temp.eq('T11 with a scan finalised the plan reads would_begin from the new cursor', concat_ws('|', p->0->>'status', (p->0->>'cursor_at')::timestamptz::text), concat_ws('|', 'would_begin', pg_temp.t(11, 2)::text));

  b := pg_temp.begin_scan(i_none, null);
  perform pg_temp.ok('T11 an item with no source thought begins on a null embedding with an empty frozen set',
    b->0->>'status' = 'began' and b->0->>'embedding_ids' = '[]', left(b::text, 300));
  p := pg_temp.call(format('select * from public.recheck_plan_scan(%L, null)', i_none));
  perform pg_temp.eq('T11 the plan of a scan in progress returns it as existing, and as not having proposed',
    concat_ws('|', p->0->>'status', p->0->>'scan_id', p->0->>'scan_proposed'), concat_ws('|', 'existing', b->0->>'scan_id', 'false'));
  perform pg_temp.eq('T11 its first page is empty', pg_temp.page(i_none, pg_temp.t(11, 0), null, (b->0->>'upper_at')::timestamptz, (b->0->>'upper_id')::uuid, '{}'), '');
  c := pg_temp.commit(i_none, (b->0->>'scan_id')::uuid, null, null, null, null, '[]', true);
  perform pg_temp.eq('T11 it finalises with one none_found row and a stamp',
    concat_ws('|', c->>'status', c->>'inserted', pg_temp.decisions(i_none), (select (a.last_rechecked_at is not null)::text from public.action_items a where a.id = i_none)),
    'final|1|no_evidence/none_found/-/g0|true');
  perform pg_temp.raised('T11 the plan of an unknown item raises unknown_item', pg_temp.call(format('select * from public.recheck_plan_scan(%L, null)', pg_temp.u('11a0', 99))), 'RC003', 'unknown_item');
  perform pg_temp.item(pg_temp.u('11a0', 3), pg_temp.t(11, 0), null, null, 'archived');
  p := pg_temp.call(format('select * from public.recheck_plan_scan(%L, null)', pg_temp.u('11a0', 3)));
  perform pg_temp.eq('T11 the plan of a closed item answers not_open', p->0->>'status', 'not_open');

  -- The persisted proposed flag (review finding F2): the dry run resumes a scan
  -- in progress from it, so the plan must return what an earlier page stored.
  perform pg_temp.item(i_prop, pg_temp.t(11, 0), pg_temp.u('11f0', 1));
  b := pg_temp.begin_scan(i_prop, null);
  c := pg_temp.commit(i_prop, (b->0->>'scan_id')::uuid, null, null, pg_temp.t(11, 1), pg_temp.u('11c0', 1),
    jsonb_build_array(pg_temp.drow('proposed', null, pg_temp.u('11c0', 1), 'did it', 0.8)), false);
  perform pg_temp.eq('T11 a page that proposed commits and leaves the scan active', pg_temp.answer(c), concat_ws('|', 'committed', 'true', pg_temp.t(11, 1)::text, '11c000000001', 'true', '1'));
  v_before := pg_temp.state();
  p := pg_temp.call(format('select * from public.recheck_plan_scan(%L, null)', i_prop));
  perform pg_temp.eq('T11 the plan of a scan in progress that proposed on an earlier page returns scan_proposed true, with the stored cursor',
    concat_ws('|', p->0->>'status', p->0->>'scan_id', p->0->>'scan_proposed', (p->0->>'cursor_at')::timestamptz::text, p->0->>'cursor_id'),
    concat_ws('|', 'existing', b->0->>'scan_id', 'true', pg_temp.t(11, 1)::text, pg_temp.u('11c0', 1)::text));
  perform pg_temp.ok('T11 that plan wrote nothing either', pg_temp.state() = v_before);
  n := public.transition_action_item(i_prop, array['open'], 'archived', 'operator', 'expired');
  p := pg_temp.call(format('select * from public.recheck_plan_scan(%L, null)', i_prop));
  perform pg_temp.eq('T11 closed mid-scan, the plan answers not_open and still returns the stored flag',
    concat_ws('|', n::text, p->0->>'status', p->0->>'scan_proposed'), '1|not_open|true');
end $$;

-- ---------------------------------------------------------------------------
-- T12: what the digest reads, and Task 3.6 reviewing a re-check proposal (day 12)
-- ---------------------------------------------------------------------------
do $$
declare
  i_done uuid := pg_temp.u('12a0', 1);
  i_keep uuid := pg_temp.u('12a0', 2);
  i_closed uuid := pg_temp.u('12a0', 3);
  b jsonb; c jsonb; r jsonb;
  n integer;
  it uuid;
begin
  perform pg_temp.th(pg_temp.u('12f0', 1), pg_temp.t(12, 0), 'p12');
  perform pg_temp.item(i_done, pg_temp.t(12, 0), pg_temp.u('12f0', 1), 'done item');
  perform pg_temp.item(i_keep, pg_temp.t(12, 0), pg_temp.u('12f0', 1), 'keep item');
  perform pg_temp.item(i_closed, pg_temp.t(12, 0), pg_temp.u('12f0', 1), 'closed item');
  perform pg_temp.th(pg_temp.u('12c0', 1), pg_temp.t(12, 1), 'p12');
  perform pg_temp.th(pg_temp.u('12c0', 2), pg_temp.t(12, 2), 'p12');
  foreach it in array array[i_done, i_keep, i_closed] loop
    b := pg_temp.begin_scan(it);
    c := pg_temp.commit(it, (b->0->>'scan_id')::uuid, null, null, pg_temp.t(12, 2), pg_temp.u('12c0', 2), jsonb_build_array(
      pg_temp.drow('proposed', null, pg_temp.u('12c0', 1), 'quote one', 0.6),
      pg_temp.drow('no_evidence', 'veto', pg_temp.u('12c0', 2), 'quote two')), true);
    perform pg_temp.eq('T12 the fixture scan of ' || left(it::text, 8) || right(it::text, 4) || ' finalises with a proposal', concat_ws('|', c->>'status', c->>'inserted'), 'final|2');
  end loop;
  n := public.transition_action_item(i_closed, array['open'], 'archived', 'operator', 'expired');

  r := pg_temp.call('select * from public.recheck_pending_proposals(200)');
  perform pg_temp.eq('T12 pending proposals: proposed rows of open items only, with the quote and the evidence thought; rejections and the closed item''s row are absent',
    (select string_agg(concat_ws('/', left(x->>'item_id', 8) || right(x->>'item_id', 4), x->>'description', x->>'quote', left(x->>'evidence_thought_id', 8) || right(x->>'evidence_thought_id', 4)), ' ' order by x->>'item_id')
     from jsonb_array_elements(r) x where x->>'item_id' in (i_done::text, i_keep::text, i_closed::text)),
    '12a000000001/done item/quote one/12c000000001 12a000000002/keep item/quote one/12c000000001');
  perform pg_temp.ok('T12 pending_total counts every pending proposal in the table',
    (select bool_and((x->>'pending_total')::integer = jsonb_array_length(r)) from jsonb_array_elements(r) x) and jsonb_array_length(r) >= 4, r::text);
  perform pg_temp.ok('T12 the list is oldest proposal first',
    (select bool_and(ord_ok) from (select (x->>'proposed_at')::timestamptz >= lag((x->>'proposed_at')::timestamptz, 1, '-infinity') over (order by pos) as ord_ok
                                   from jsonb_array_elements(r) with ordinality e(x, pos)) s));
  r := pg_temp.call('select * from public.recheck_pending_proposals(1)');
  perform pg_temp.ok('T12 a capped list still reports the whole count', jsonb_array_length(r) = 1 and (r->0->>'pending_total')::integer >= 4, r::text);

  -- Task 3.6 on these rows: done resolves with the evidence thought; keep keeps.
  r := pg_temp.call(format($q$select * from public.review_proposal(%L, 'done', 'operator', 'mcp-shared-key')$q$, i_done));
  perform pg_temp.eq('T12 review_proposal done on a re-check proposal resolves the item with the evidence thought as resolver',
    concat_ws('|', r->0->>'status', (select concat_ws('|', a.status, a.close_reason, a.resolved_by_thought_id) from public.action_items a where a.id = i_done)),
    concat_ws('|', 'recorded', 'resolved', 'done', pg_temp.u('12c0', 1)::text));
  r := pg_temp.call(format($q$select * from public.review_proposal(%L, 'keep', 'operator', 'mcp-shared-key')$q$, i_keep));
  perform pg_temp.eq('T12 review_proposal keep on a re-check proposal keeps the item open and the row kept',
    concat_ws('|', r->0->>'status', (select a.status from public.action_items a where a.id = i_keep),
      (select d.outcome from public.auto_resolve_decisions d where d.item_id = i_keep and d.evidence_thought_id = pg_temp.u('12c0', 1))),
    'recorded|open|kept');
  r := pg_temp.call('select * from public.recheck_pending_proposals(200)');
  perform pg_temp.eq('T12 a reviewed proposal leaves the pending list',
    (select count(*)::text from jsonb_array_elements(r) x where x->>'item_id' in (i_done::text, i_keep::text, i_closed::text)), '0');

  -- A restored item's old proposal is history, not pending.
  n := public.transition_action_item(i_closed, array['archived'], 'open', 'operator', null);
  r := pg_temp.call('select * from public.recheck_pending_proposals(200)');
  perform pg_temp.eq('T12 after a restore the earlier generation''s proposal is not pending, although the item is open and the row still reads proposed',
    concat_ws('|', (select count(*) from jsonb_array_elements(r) x where x->>'item_id' = i_closed::text),
      (select d.outcome from public.auto_resolve_decisions d where d.item_id = i_closed and d.outcome = 'proposed')), '0|proposed');
end $$;

-- ---------------------------------------------------------------------------
-- T13: client names and the run receipt
-- ---------------------------------------------------------------------------
do $$
declare r jsonb; v_before jsonb;
begin
  perform pg_temp.eq('T13 no clients is an empty list, not null', pg_temp.call('select public.recheck_client_names() as names')->0->>'names', '[]');
  insert into public.clients (name) values ('Morgan Lee'), ('Alicia Brennan'), (''), (null), ('Jordan Smith');
  perform pg_temp.eq('T13 every client name, once, in order, without blanks, as ONE array',
    pg_temp.call('select public.recheck_client_names() as names')->0->>'names', '["Alicia Brennan", "Jordan Smith", "Morgan Lee"]');

  r := pg_temp.call($q$select public.recheck_record_run('2025-02-01 04:00:00+00', 'partial', '{"items_errored": 2, "recheck_incomplete": 3}') as id$q$);
  perform pg_temp.eq('T13 a run receipt is stored with its start, status and counts',
    (select concat_ws('|', x.started_at::text, x.status, x.summary::text, (x.finished_at is not null)::text)
     from public.action_item_recheck_runs x where x.id = (r->0->>'id')::uuid),
    '2025-02-01 04:00:00+00|partial|{"items_errored": 2, "recheck_incomplete": 3}|true');
  v_before := pg_temp.state();
  r := pg_temp.call($q$select public.recheck_record_run('2025-02-01 04:00:00+00', 'fine', '{}') as id$q$);
  perform pg_temp.ok('T13 a status outside ok, partial, failed is refused by action_item_recheck_runs_status',
    r->>'state' = '23514' and r->>'constraint' = 'action_item_recheck_runs_status', r::text);
  perform pg_temp.raised('T13 a receipt with no start time is refused', pg_temp.call($q$select public.recheck_record_run(null, 'ok', '{}') as id$q$), '22023', 'requires a start time');
  perform pg_temp.raised('T13 a receipt whose summary is not an object is refused', pg_temp.call($q$select public.recheck_record_run('2025-02-01 04:00:00+00', 'ok', '[1]') as id$q$), '22023', 'JSON object summary');
  perform pg_temp.raised('T13 a receipt with a null summary is refused', pg_temp.call($q$select public.recheck_record_run('2025-02-01 04:00:00+00', 'ok', null) as id$q$), '22023', 'JSON object summary');
  perform pg_temp.ok('T13 the refused receipts wrote nothing', pg_temp.state() = v_before);
end $$;

-- ---------------------------------------------------------------------------
-- T14: grants and row level security
-- ---------------------------------------------------------------------------
do $$
declare
  fns text[] := array[
    'public.match_thoughts_bounded(vector, timestamptz, uuid, timestamptz, uuid, integer)',
    'public.recheck_eligible_items(timestamptz, integer)',
    'public.recheck_plan_scan(uuid, vector)',
    'public.recheck_begin_scan(uuid, vector)',
    'public.recheck_candidates(uuid, timestamptz, uuid, timestamptz, uuid, uuid[], integer)',
    'public.recheck_commit_page(uuid, uuid, timestamptz, uuid, timestamptz, uuid, jsonb, boolean)',
    'public.recheck_pending_proposals(integer)',
    'public.recheck_source_embedding(uuid)',
    'public.recheck_client_names()',
    'public.recheck_record_run(timestamptz, text, jsonb)',
    'public.recheck_warm_embeddings(uuid[], timestamptz, uuid, integer)',
    'public.recheck_note_error(uuid)'];
  f text;
begin
  perform pg_temp.eq('T14 the two migrations define exactly these twelve functions',
    (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and (p.proname like 'recheck\_%' or p.proname = 'match_thoughts_bounded')), '12');
  foreach f in array fns loop
    perform pg_temp.ok('T14 anon cannot execute ' || split_part(f, '(', 1), not has_function_privilege('anon', f, 'execute'));
    perform pg_temp.ok('T14 authenticated cannot execute ' || split_part(f, '(', 1), not has_function_privilege('authenticated', f, 'execute'));
    perform pg_temp.ok('T14 service_role can execute ' || split_part(f, '(', 1), has_function_privilege('service_role', f, 'execute'));
  end loop;
  perform pg_temp.ok('T14 no re-check function is SECURITY DEFINER',
    not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and (p.proname like 'recheck\_%' or p.proname = 'match_thoughts_bounded') and p.prosecdef));
  perform pg_temp.ok('T14 every re-check function pins its search_path',
    not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and (p.proname like 'recheck\_%' or p.proname = 'match_thoughts_bounded')
                  and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')));
  perform pg_temp.ok('T14 recheck_begin_scan and recheck_plan_scan are not strict', (select bool_and(not p.proisstrict) from pg_proc p where p.proname in ('recheck_begin_scan', 'recheck_plan_scan')));
  perform pg_temp.eq('T14 the warm-up is a read: recheck_warm_embeddings is STABLE, so it cannot write; recheck_note_error is the writer',
    (select string_agg(p.proname || ':' || p.provolatile::text, ' ' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('recheck_warm_embeddings', 'recheck_note_error')),
    'recheck_note_error:v recheck_warm_embeddings:s');
  perform pg_temp.ok('T14 the receipt table has row level security on, with the service-role policy',
    (select c.relrowsecurity from pg_class c where c.oid = 'public.action_item_recheck_runs'::regclass)
    and exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = 'action_item_recheck_runs'
                and p.policyname = 'Service role full access on action_item_recheck_runs'));
end $$;

-- A role that is not the service role reads no receipt through RLS. The count
-- is taken as anon and judged after the role is put back.
do $$
declare n_anon integer; n_all integer;
begin
  execute 'set local role anon';
  select count(*) into n_anon from public.action_item_recheck_runs;
  execute 'reset role';
  select count(*) into n_all from public.action_item_recheck_runs;
  perform pg_temp.eq('T14 anon reads no run receipt through row level security, while one exists', n_anon || ' of ' || n_all, '0 of 1');
end $$;

-- ---------------------------------------------------------------------------
-- T15: the page boundary of a commit (day 15). Review finding F3: a commit with
-- the right expected cursor could move the cursor past candidates no page had
-- read, as far as the upper bound, and finalise the scan over them. The new
-- cursor must be a row of the NEXT candidate page: one of the first ten
-- candidates after the stored cursor. Fourteen candidates, so the window is
-- larger than a page and the eleventh is the first row no page could hold.
-- ---------------------------------------------------------------------------
do $$
declare
  i uuid := pg_temp.u('15a0', 1);
  i_full uuid := pg_temp.u('15a0', 2);
  b jsonb; c jsonb;
  v_scan uuid;
  v_before jsonb;
  u_at timestamptz := pg_temp.t(15, 30);
  u_id uuid := pg_temp.u('15d0', 1);
  one jsonb := jsonb_build_array(pg_temp.drow('proposed', null, pg_temp.u('15c0', 2), 'did the p15 item', 0.9));
begin
  perform pg_temp.th(pg_temp.u('15f0', 1), pg_temp.t(15, 0), 'p15');
  perform pg_temp.th(pg_temp.u('15f0', 2), pg_temp.t(15, 0), 'p15full');
  perform pg_temp.item(i, pg_temp.t(15, 0), pg_temp.u('15f0', 1), 'the p15 item');
  perform pg_temp.item(i_full, pg_temp.t(15, 0), pg_temp.u('15f0', 2), 'the p15 full-page item');
  for k in 1..14 loop
    perform pg_temp.th(pg_temp.u('15c0', k), pg_temp.t(15, k), 'p15');
  end loop;
  -- Not a candidate, between the fifth and the sixth candidates, on an instant
  -- no candidate shares.
  perform pg_temp.th(pg_temp.u('15e0', 1), pg_temp.t(15, 5) + interval '30 seconds', 'unrelated');
  -- Exactly ten candidates for the second item.
  for k in 1..10 loop
    perform pg_temp.th(pg_temp.u('15b0', k), pg_temp.t(15, 15 + k), 'p15full');
  end loop;
  -- The newest thought, not a candidate of either item: the upper bound.
  perform pg_temp.th(u_id, u_at, 'unrelated');

  b := pg_temp.begin_scan(i);
  v_scan := (b->0->>'scan_id')::uuid;
  perform pg_temp.eq('T15 the scan''s upper bound is the newest thought, which is not a candidate',
    concat_ws('|', b->0->>'status', (b->0->>'upper_at')::timestamptz::text, b->0->>'upper_id'), concat_ws('|', 'began', u_at::text, u_id::text));
  perform pg_temp.eq('T15 the window holds fourteen candidates, four more than a page; the next page is the first ten',
    pg_temp.page(i, pg_temp.t(15, 0), null, u_at, u_id, '{}', 50) || ' / ' || pg_temp.page(i, pg_temp.t(15, 0), null, u_at, u_id),
    '15c000000001 15c000000002 15c000000003 15c000000004 15c000000005 15c000000006 15c000000007 15c000000008 15c000000009 15c000000010 15c000000011 15c000000012 15c000000013 15c000000014'
    || ' / 15c000000001 15c000000002 15c000000003 15c000000004 15c000000005 15c000000006 15c000000007 15c000000008 15c000000009 15c000000010');

  v_before := pg_temp.state();
  -- The review's own call: the upper bound, no rows, final, the correct (null) expected cursor.
  perform pg_temp.raised('T15 a FINAL commit that jumps to the upper bound with no rows, over fourteen unread candidates, raises cursor_not_in_page',
    pg_temp.commit(i, v_scan, null, null, u_at, u_id, '[]', true), 'RC006', 'cursor_not_in_page');
  -- The last candidate of the window: nothing remains after it, so premature_final cannot be what refuses these two.
  perform pg_temp.raised('T15 a FINAL commit with rows whose cursor is the fourteenth candidate raises cursor_not_in_page',
    pg_temp.commit(i, v_scan, null, null, pg_temp.t(15, 14), pg_temp.u('15c0', 14), one, true), 'RC006', 'cursor_not_in_page');
  perform pg_temp.raised('T15 a FINAL commit with no rows whose cursor is the fourteenth candidate raises cursor_not_in_page',
    pg_temp.commit(i, v_scan, null, null, pg_temp.t(15, 14), pg_temp.u('15c0', 14), '[]', true), 'RC006', 'cursor_not_in_page');
  perform pg_temp.raised('T15 a page with rows whose cursor is the ELEVENTH candidate, one past the page, raises cursor_not_in_page',
    pg_temp.commit(i, v_scan, null, null, pg_temp.t(15, 11), pg_temp.u('15c0', 11), one, false), 'RC006', 'cursor_not_in_page');
  perform pg_temp.raised('T15 a page with no rows whose cursor is the fourteenth candidate raises cursor_not_in_page',
    pg_temp.commit(i, v_scan, null, null, pg_temp.t(15, 14), pg_temp.u('15c0', 14), '[]', false), 'RC006', 'cursor_not_in_page');
  perform pg_temp.raised('T15 a page with no rows whose cursor is the upper bound raises cursor_not_in_page',
    pg_temp.commit(i, v_scan, null, null, u_at, u_id, '[]', false), 'RC006', 'cursor_not_in_page');
  -- Inside the page's range, but not a candidate's tuple.
  perform pg_temp.raised('T15 a cursor on a thought that is not a candidate, inside the page''s range, raises cursor_not_in_page',
    pg_temp.commit(i, v_scan, null, null, pg_temp.t(15, 5) + interval '30 seconds', pg_temp.u('15e0', 1), one, false), 'RC006', 'cursor_not_in_page');
  -- One part of the tuple right, the other belonging to no candidate at all, so
  -- each of these two can only be refused by the comparison of that other part.
  perform pg_temp.raised('T15 a cursor with the tenth candidate''s time and an id no candidate has raises cursor_not_in_page',
    pg_temp.commit(i, v_scan, null, null, pg_temp.t(15, 10), pg_temp.u('15c0', 9999), one, false), 'RC006', 'cursor_not_in_page');
  perform pg_temp.raised('T15 a cursor with the tenth candidate''s id and a time no candidate has raises cursor_not_in_page',
    pg_temp.commit(i, v_scan, null, null, pg_temp.t(15, 9) + interval '30 seconds', pg_temp.u('15c0', 10), one, false), 'RC006', 'cursor_not_in_page');
  -- The refusals that were already there keep their own codes on this fixture.
  perform pg_temp.raised('T15 a cursor beyond the upper bound is still bad_cursor',
    pg_temp.commit(i, v_scan, null, null, pg_temp.t(15, 31), pg_temp.u('15c0', 1), one, false), 'RC004', 'bad_cursor');
  perform pg_temp.raised('T15 a cursor on the item''s own created_at (a rewind to the lower bound) is still bad_cursor',
    pg_temp.commit(i, v_scan, null, null, pg_temp.t(15, 0), pg_temp.u('15c0', 1), one, false), 'RC004', 'bad_cursor');
  perform pg_temp.raised('T15 a stale expected cursor is still stale_commit, even with a cursor inside the page',
    pg_temp.commit(i, v_scan, pg_temp.t(15, 1), pg_temp.u('15c0', 1), pg_temp.t(15, 10), pg_temp.u('15c0', 10), one, false), 'RC001', 'stale_commit');
  perform pg_temp.raised('T15 a final on the page''s last row while four candidates remain is still premature_final',
    pg_temp.commit(i, v_scan, null, null, pg_temp.t(15, 10), pg_temp.u('15c0', 10), one, true), 'RC005', 'premature_final');
  perform pg_temp.raised('T15 a final with no cursor while candidates remain is still premature_final',
    pg_temp.commit(i, v_scan, null, null, null, null, '[]', true), 'RC005', 'premature_final');
  perform pg_temp.ok('T15 none of the fourteen refused commits wrote anything: no row, no cursor move, no stamp', pg_temp.state() = v_before);
  perform pg_temp.eq('T15 the scan is still at its start, active and unstamped',
    pg_temp.scan(i), concat_ws('|', 'scanning', '-', '-', u_at::text, '15d000000001', 'false', 'never'));

  -- The page boundary itself: the tenth candidate is accepted.
  c := pg_temp.commit(i, v_scan, null, null, pg_temp.t(15, 10), pg_temp.u('15c0', 10), one, false);
  perform pg_temp.eq('T15 a page whose cursor is the TENTH candidate, the page''s last row, commits',
    pg_temp.answer(c), concat_ws('|', 'committed', 'true', pg_temp.t(15, 10)::text, '15c000000010', 'true', '1'));
  -- From the new cursor the same jump is refused again, with the correct non-null expected cursor.
  v_before := pg_temp.state();
  perform pg_temp.raised('T15 after page 1, a FINAL commit that jumps to the upper bound is refused again',
    pg_temp.commit(i, v_scan, pg_temp.t(15, 10), pg_temp.u('15c0', 10), u_at, u_id, '[]', true), 'RC006', 'cursor_not_in_page');
  perform pg_temp.raised('T15 after page 1, a cursor on a row of the page already committed does not advance: bad_cursor',
    pg_temp.commit(i, v_scan, pg_temp.t(15, 10), pg_temp.u('15c0', 10), pg_temp.t(15, 4), pg_temp.u('15c0', 4), '[]', false), 'RC004', 'bad_cursor');
  perform pg_temp.ok('T15 those two refusals wrote nothing', pg_temp.state() = v_before);
  -- The page is measured from the STORED cursor: the fourteenth candidate is now the fourth row of the next page.
  c := pg_temp.commit(i, v_scan, pg_temp.t(15, 10), pg_temp.u('15c0', 10), pg_temp.t(15, 14), pg_temp.u('15c0', 14), '[]', true);
  perform pg_temp.eq('T15 the short second page finalises: cursor at the upper bound, no none_found because page 1 proposed',
    pg_temp.answer(c), concat_ws('|', 'final', 'false', u_at::text, '15d000000001', 'true', '0'));
  perform pg_temp.eq('T15 the item holds the one proposal and is stamped',
    pg_temp.decisions(i) || '|' || pg_temp.scan(i),
    'proposed/-/15c000000002/g0|' || concat_ws('|', 'idle', u_at::text, '15d000000001', '-', '-', 'false', 'stamped'));

  -- Kept on purpose: SQL accepts a final on a FULL page of ten when nothing
  -- remains after it. The run loop never sends one (a full page is never final
  -- there); accepting it loses nothing, because every candidate was in the page.
  b := pg_temp.begin_scan(i_full);
  perform pg_temp.eq('T15 the second item has exactly ten candidates',
    pg_temp.page(i_full, pg_temp.t(15, 0), null, u_at, u_id, '{}', 50),
    '15b000000001 15b000000002 15b000000003 15b000000004 15b000000005 15b000000006 15b000000007 15b000000008 15b000000009 15b000000010');
  c := pg_temp.commit(i_full, (b->0->>'scan_id')::uuid, null, null, pg_temp.t(15, 25), pg_temp.u('15b0', 10), '[]', true);
  perform pg_temp.eq('T15 a final on an exhausted full page of ten is accepted by the function: every candidate was in the page',
    pg_temp.answer(c) || '|' || pg_temp.decisions(i_full),
    concat_ws('|', 'final', 'false', u_at::text, '15d000000001', 'false', '1') || '|no_evidence/none_found/-/g0');
end $$;

-- ---------------------------------------------------------------------------
-- T16: recheck_note_error, the error stamp (day 16). Cold-start correction.
-- ---------------------------------------------------------------------------
do $$
declare
  i_open uuid := pg_temp.u('16a0', 1); i_scan uuid := pg_temp.u('16a0', 2); i_other uuid := pg_temp.u('16a0', 3);
  i_cur uuid := pg_temp.u('16a0', 4);
  v_before jsonb; v_after jsonb; r jsonb; b jsonb; c jsonb; st text;
begin
  perform pg_temp.th(pg_temp.u('16f0', 1), pg_temp.t(16, 0), 'p16');
  perform pg_temp.th(pg_temp.u('16c0', 1), pg_temp.t(16, 10), 'p16');
  perform pg_temp.item(i_open, pg_temp.t(16, 1), pg_temp.u('16f0', 1));
  perform pg_temp.item(i_scan, pg_temp.t(16, 1), pg_temp.u('16f0', 1));
  perform pg_temp.item(i_other, pg_temp.t(16, 1), pg_temp.u('16f0', 1));
  b := pg_temp.begin_scan(i_scan);

  v_before := pg_temp.state();
  r := pg_temp.call(format('select public.recheck_note_error(%L::uuid) as noted', i_open));
  v_after := pg_temp.state();
  perform pg_temp.eq('T16 an open item is stamped: the answer is true', r->0->>'noted', 'true');
  perform pg_temp.ok('T16 the stamp is the ONLY change in the database: that one column of that one row, set to now()',
    v_after = jsonb_set(v_before, array['action_items', i_open::text, 'recheck_last_error_at'], to_jsonb(now())), 'the state differs elsewhere, or the stamp is not now()');

  v_before := pg_temp.state();
  r := pg_temp.call(format('select public.recheck_note_error(%L::uuid) as noted', i_scan));
  perform pg_temp.ok('T16 an item mid-scan is stamped and its scan, cursor and proposed flag are untouched',
    r->0->>'noted' = 'true'
    and pg_temp.state() = jsonb_set(v_before, array['action_items', i_scan::text, 'recheck_last_error_at'], to_jsonb(now())), r::text);
  c := pg_temp.commit(i_scan, (b->0->>'scan_id')::uuid, null, null, pg_temp.t(16, 10), pg_temp.u('16c0', 1), '[]', true);
  perform pg_temp.eq('T16 the stamped scan then commits its page as before: final, one none_found, and the stamp is still there',
    c->>'status' || '|' || pg_temp.decisions(i_scan) || '|' || (select (recheck_last_error_at = now())::text || '|' || (last_rechecked_at = now())::text from public.action_items where id = i_scan),
    'final|no_evidence/none_found/-/g0|true|true');

  -- An item a finished scan left a cursor on: the stamp does not move it.
  perform pg_temp.item(i_cur, pg_temp.t(16, 1), pg_temp.u('16f0', 1));
  update public.action_items set recheck_cursor_at = pg_temp.t(16, 10), recheck_cursor_id = pg_temp.u('16c0', 1),
    last_rechecked_at = pg_temp.t(16, 11), recheck_last_scan_id = pg_temp.u('5ca0', 16) where id = i_cur;
  v_before := pg_temp.state();
  r := pg_temp.call(format('select public.recheck_note_error(%L::uuid) as noted', i_cur));
  perform pg_temp.ok('T16 an item with a cursor from a finished scan is stamped; the cursor, the receipt and last_rechecked_at are untouched',
    r->0->>'noted' = 'true'
    and pg_temp.state() = jsonb_set(v_before, array['action_items', i_cur::text, 'recheck_last_error_at'], to_jsonb(now())), r::text);

  foreach st in array array['resolved', 'archived', 'deferred'] loop
    update public.action_items set status = st, defer_reason = case when st = 'deferred' then 'pause:test' end where id = i_other;
    v_before := pg_temp.state();
    r := pg_temp.call(format('select public.recheck_note_error(%L::uuid) as noted', i_other));
    perform pg_temp.ok(format('T16 a %s item is not stamped: the answer is false and nothing is written', st),
      r->0->>'noted' = 'false' and pg_temp.state() = v_before, r::text);
  end loop;

  v_before := pg_temp.state();
  perform pg_temp.raised('T16 an unknown item raises unknown_item', pg_temp.call(format('select public.recheck_note_error(%L::uuid)', pg_temp.u('16ff', 9))), 'RC003', 'unknown_item');
  perform pg_temp.raised('T16 a null item id is refused', pg_temp.call('select public.recheck_note_error(null)'), '22023', 'requires an item id');
  perform pg_temp.ok('T16 the two refusals wrote nothing', pg_temp.state() = v_before);
end $$;

-- ---------------------------------------------------------------------------
-- T17: recheck_warm_embeddings, the bounded warm-up read (day 17). Cold-start
-- correction. The distance operator of this cluster is the stand-in function
-- public.obt_cosine_distance; for this section it is replaced by one that
-- counts its calls in a sequence, so "the chunk's embeddings were read in
-- full, once each" is observed, and put back at the end.
-- ---------------------------------------------------------------------------
create sequence public.obt_distance_calls;
create or replace function public.obt_cosine_distance(a float8[], b float8[]) returns float8
language plpgsql volatile strict as $f$
begin
  perform nextval('public.obt_distance_calls');
  return (select 1 - (sum(x * y) / nullif(sqrt(sum(x * x)) * sqrt(sum(y * y)), 0)) from unnest(a, b) as t(x, y));
end $f$;
create function pg_temp.warm(p_items uuid[], p_at timestamptz default null, p_id uuid default null, p_limit integer default 250)
returns text language plpgsql as $f$
declare r jsonb; n0 bigint; n1 bigint;
begin
  select coalesce(pg_sequence_last_value('public.obt_distance_calls'), 0) into n0;
  r := pg_temp.call(format('select * from public.recheck_warm_embeddings(%L::uuid[], %L::timestamptz, %L::uuid, %L::integer)', p_items, p_at, p_id, p_limit));
  select coalesce(pg_sequence_last_value('public.obt_distance_calls'), 0) into n1;
  if jsonb_typeof(r) = 'object' then return 'RAISED ' || (r->>'state') || ' ' || (r->>'message'); end if;
  -- rows read | last row | done | embeddings passed to the distance operator
  return concat_ws('|', r->0->>'rows_read', coalesce(left(r->0->>'last_id', 8) || right(r->0->>'last_id', 4), '-'),
    coalesce(((r->0->>'last_at')::timestamptz = (select t.created_at from public.thoughts t where t.id = (r->0->>'last_id')::uuid))::text, '-'),
    r->0->>'done', (n1 - n0)::text);
end $f$;
do $$
declare
  i_a uuid := pg_temp.u('17a0', 1);      -- never scanned, created at minute 10
  i_b uuid := pg_temp.u('17a0', 2);      -- a finished scan left its cursor at minute 6
  i_scan uuid := pg_temp.u('17a0', 3);   -- mid-scan, created at minute 0
  i_noemb uuid := pg_temp.u('17a0', 4);  -- its source has no embedding, created at minute 0
  i_nosrc uuid := pg_temp.u('17a0', 5);  -- no source thought, created at minute 0
  i_closed uuid := pg_temp.u('17a0', 6); -- resolved, created at minute 0
  i_c uuid := pg_temp.u('17a0', 7);      -- a cursor at minute 6 too, one row earlier than B's
  v_before jsonb; w text; v_at timestamptz; v_id uuid; seen text[] := '{}'; r jsonb; n integer := 0;
begin
  perform pg_temp.th(pg_temp.u('17f0', 1), pg_temp.t(17, 0), 'p17', '{1,0,0}');
  perform pg_temp.th(pg_temp.u('17f0', 2), pg_temp.t(17, 0), 'p17', null);
  -- Embedded thoughts at minutes 2, 4, 6 (three at that one instant), 8, 10 (two at the item's own instant), 12, 14, 16; two with no embedding.
  perform pg_temp.th(pg_temp.u('17c0', 2), pg_temp.t(17, 2), 'x', '{1,0,0}');
  perform pg_temp.th(pg_temp.u('17c0', 4), pg_temp.t(17, 4), 'x', '{1,1,0}');
  perform pg_temp.th(pg_temp.u('17c0', 61), pg_temp.t(17, 6), 'x', '{1,2,0}');
  perform pg_temp.th(pg_temp.u('17c0', 62), pg_temp.t(17, 6), 'x', '{1,3,0}');
  perform pg_temp.th(pg_temp.u('17c0', 63), pg_temp.t(17, 6), 'x', '{1,4,0}');
  perform pg_temp.th(pg_temp.u('17c0', 8), pg_temp.t(17, 8), 'x', '{1,5,0}');
  perform pg_temp.th(pg_temp.u('17c0', 9), pg_temp.t(17, 9), 'x', null);
  perform pg_temp.th(pg_temp.u('17c0', 101), pg_temp.t(17, 10), 'x', '{1,6,0}');
  perform pg_temp.th(pg_temp.u('17c0', 102), pg_temp.t(17, 10), 'x', '{1,7,0}');
  perform pg_temp.th(pg_temp.u('17c0', 12), pg_temp.t(17, 12), 'x', '{1,8,0}');
  perform pg_temp.th(pg_temp.u('17c0', 13), pg_temp.t(17, 13), 'x', null);
  perform pg_temp.th(pg_temp.u('17c0', 14), pg_temp.t(17, 14), 'x', '{1,9,0}');
  perform pg_temp.th(pg_temp.u('17c0', 16), pg_temp.t(17, 16), 'x', '{2,1,0}');
  perform pg_temp.item(i_a, pg_temp.t(17, 10), pg_temp.u('17f0', 1));
  perform pg_temp.item(i_b, pg_temp.t(17, 1), pg_temp.u('17f0', 1));
  update public.action_items set recheck_cursor_at = pg_temp.t(17, 6), recheck_cursor_id = pg_temp.u('17c0', 62),
    last_rechecked_at = pg_temp.t(17, 7), recheck_last_scan_id = pg_temp.u('5ca0', 17) where id = i_b;
  perform pg_temp.item(i_c, pg_temp.t(17, 1), pg_temp.u('17f0', 1));
  update public.action_items set recheck_cursor_at = pg_temp.t(17, 6), recheck_cursor_id = pg_temp.u('17c0', 61),
    last_rechecked_at = pg_temp.t(17, 7), recheck_last_scan_id = pg_temp.u('5ca0', 19) where id = i_c;
  perform pg_temp.item(i_scan, pg_temp.t(17, 0), pg_temp.u('17f0', 1));
  update public.action_items set recheck_scan_id = pg_temp.u('5ca0', 18), recheck_scan_upper_at = pg_temp.t(17, 16),
    recheck_scan_upper_id = pg_temp.u('17c0', 16), recheck_scan_embedding_ids = '{}' where id = i_scan;
  perform pg_temp.item(i_noemb, pg_temp.t(17, 0), pg_temp.u('17f0', 2));
  perform pg_temp.item(i_nosrc, pg_temp.t(17, 0), null);
  perform pg_temp.item(i_closed, pg_temp.t(17, 0), pg_temp.u('17f0', 1), null, 'resolved');
  v_before := pg_temp.state();

  -- The plan's own window, for comparison: what recheck_plan_scan would search for item A.
  perform pg_temp.eq('T17 a never-scanned item: the chunk starts strictly after the item''s own instant (both thoughts stamped at it are left out), skips thoughts with no embedding, and reads each embedding once',
    pg_temp.warm(array[i_a]), '3|17c000000016|true|true|3');
  perform pg_temp.eq('T17 those are exactly the rows the bounded search of that item''s plan orders',
    (select count(*)::text from public.match_thoughts_bounded('{1,0,0}'::vector, pg_temp.t(17, 10), null, pg_temp.t(17, 16), pg_temp.u('17c0', 16), 100)), '3');
  perform pg_temp.eq('T17 an item with a cursor: the chunk starts strictly after the cursor row, inside a shared instant',
    pg_temp.warm(array[i_b]), '7|17c000000016|true|true|7');
  perform pg_temp.eq('T17 several items: the earliest lower bound among them is where the chunk starts',
    pg_temp.warm(array[i_a, i_b]) || ' ' || pg_temp.warm(array[i_b, i_a]), '7|17c000000016|true|true|7 7|17c000000016|true|true|7');
  perform pg_temp.eq('T17 two cursors at one instant: the earlier id is the earlier bound, in either order of the list',
    pg_temp.warm(array[i_b, i_c]) || ' ' || pg_temp.warm(array[i_c, i_b]) || ' ' || pg_temp.warm(array[i_c], null, null, 1),
    '8|17c000000016|true|true|8 8|17c000000016|true|true|8 1|17c000000062|true|false|1');
  -- Items that run no vector search do not move the start, though each is older than A and B.
  perform pg_temp.eq('T17 an item mid-scan, a source with no embedding, no source, and a closed item are not warmed for: listed with A, the chunk is A''s',
    pg_temp.warm(array[i_scan, i_noemb, i_nosrc, i_closed, i_a]), '3|17c000000016|true|true|3');
  perform pg_temp.eq('T17 each of them alone, no item, a null list and an unknown id: nothing to read, done, and no embedding touched',
    concat_ws(' ', pg_temp.warm(array[i_scan]), pg_temp.warm(array[i_noemb]), pg_temp.warm(array[i_nosrc]), pg_temp.warm(array[i_closed]),
      pg_temp.warm('{}'), pg_temp.warm(null), pg_temp.warm(array[pg_temp.u('17ff', 9)])),
    '0|-|-|true|0 0|-|-|true|0 0|-|-|true|0 0|-|-|true|0 0|-|-|true|0 0|-|-|true|0 0|-|-|true|0');
  -- Only the listed items count: B is older, but it was not listed.
  perform pg_temp.eq('T17 an item that is not listed does not move the start', pg_temp.warm(array[i_a, i_scan]), '3|17c000000016|true|true|3');

  -- Paging: chunks of 3 from B's cursor. Seven rows: 3, 3, 1.
  perform pg_temp.eq('T17 a first chunk of 3 of 7: three rows, the third is the last, not done, three embeddings read',
    pg_temp.warm(array[i_b], null, null, 3), '3|17c000000101|true|false|3');
  perform pg_temp.eq('T17 the second chunk continues strictly after the position, inside the instant two rows share',
    pg_temp.warm(array[i_b], pg_temp.t(17, 10), pg_temp.u('17c0', 101), 3), '3|17c000000014|true|false|3');
  perform pg_temp.eq('T17 the last chunk is short and says done',
    pg_temp.warm(array[i_b], pg_temp.t(17, 14), pg_temp.u('17c0', 14), 3), '1|17c000000016|true|true|1');
  perform pg_temp.eq('T17 a chunk that is exactly full is not done; the next one is empty, names no row, and is done',
    pg_temp.warm(array[i_b], null, null, 7) || ' ' || pg_temp.warm(array[i_b], pg_temp.t(17, 16), pg_temp.u('17c0', 16), 7),
    '7|17c000000016|true|false|7 0|-|-|true|0');
  -- Walk it the way the run loop does and collect what each chunk covered.
  v_at := null; v_id := null;
  loop
    n := n + 1;
    r := pg_temp.call(format('select * from public.recheck_warm_embeddings(%L::uuid[], %L::timestamptz, %L::uuid, 2)', array[i_b], v_at, v_id));
    seen := seen || array(select left(t.id::text, 8) || right(t.id::text, 4) from public.thoughts t
      where t.embedding is not null and (t.created_at, t.id) > (coalesce(v_at, pg_temp.t(17, 6)), coalesce(v_id, pg_temp.u('17c0', 62)))
        and (t.created_at, t.id) <= ((r->0->>'last_at')::timestamptz, (r->0->>'last_id')::uuid) order by t.created_at, t.id);
    exit when (r->0->>'done')::boolean or n > 20;
    v_at := (r->0->>'last_at')::timestamptz; v_id := (r->0->>'last_id')::uuid;
  end loop;
  perform pg_temp.eq('T17 walked in chunks of 2, every embedded thought after the cursor is covered exactly once, in order, in four calls',
    n || ': ' || array_to_string(seen, ' '),
    '4: 17c000000063 17c000000008 17c000000101 17c000000102 17c000000012 17c000000014 17c000000016');
  -- A position before the window is not a way to read outside it.
  perform pg_temp.eq('T17 a position earlier than the items'' lower bound is ignored: the chunk still starts at the lower bound',
    pg_temp.warm(array[i_a], pg_temp.t(17, 2), pg_temp.u('17c0', 2)), '3|17c000000016|true|true|3');
  perform pg_temp.eq('T17 a null cursor id on the item means "after every id at that instant", as in the plan',
    pg_temp.warm(array[i_a], null, null, 1), '1|17c000000012|true|false|1');

  perform pg_temp.eq('T17 a limit of 0, of 1001 and a null limit are refused; 1000 is accepted',
    concat_ws(' ', left(pg_temp.warm(array[i_a], null, null, 0), 12), left(pg_temp.warm(array[i_a], null, null, 1001), 12),
      left(pg_temp.warm(array[i_a], null, null, null), 12), pg_temp.warm(array[i_a], null, null, 1000)),
    'RAISED 22023 RAISED 22023 RAISED 22023 3|17c000000016|true|true|3');
  perform pg_temp.eq('T17 half a position is refused, either half',
    left(pg_temp.warm(array[i_a], pg_temp.t(17, 2), null), 12) || ' ' || left(pg_temp.warm(array[i_a], null, pg_temp.u('17c0', 2)), 12),
    'RAISED 22023 RAISED 22023');
  perform pg_temp.ok('T17 none of these calls wrote anything', pg_temp.state() = v_before);
end $$;
-- The stand-in distance function, as the runner defined it.
create or replace function public.obt_cosine_distance(a float8[], b float8[]) returns float8
language sql immutable strict as $f$
  select 1 - (sum(x * y) / nullif(sqrt(sum(x * x)) * sqrt(sum(y * y)), 0)) from unnest(a, b) as t(x, y)
$f$;

do $$ begin raise notice 'RECHECK SQL TEST PASSED'; end $$;
