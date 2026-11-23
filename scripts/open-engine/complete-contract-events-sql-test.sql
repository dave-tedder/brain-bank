-- Task 5.4 follow-up (PR 32 decision 7): single-connection contract for
-- supabase/migrations/20261121c_complete_contract_events.sql and the two
-- read-only queries in scripts/loop-closing/complete-contract-metrics.sql.
-- Run ONLY by complete-contract-events-sql-test.sh against a throwaway local
-- cluster; the runner substitutes the two queries for the @@ markers below.
--
-- Every check prints PASS <name> or raises FAIL <name> with SQLSTATE TF001,
-- from pg_temp.ok and from nowhere else. An expected refusal is caught by
-- pg_temp.attempt_as and judged by a named check; an interruption (the
-- prefixes the runner passes in) is re-raised untouched, so the runner reports
-- it as NEVER-RAN, never as a failure. The last line prints
-- COMPLETE CONTRACT EVENTS SQL TEST PASSED.

\set ON_ERROR_STOP 1
set client_min_messages = notice;

create temp table obt_interruption (prefix text primary key);
insert into obt_interruption select unnest(string_to_array(:'interruption_prefixes', ' '));

create function pg_temp.interruption(p_state text)
returns boolean language sql stable as $$
  select p_state is null or exists (select 1 from obt_interruption i where p_state like i.prefix || '%')
$$;

create function pg_temp.ok(p_name text, p_cond boolean, p_detail text default '')
returns void language plpgsql as $$
begin
  if p_cond is distinct from true then
    raise exception using errcode = 'TF001',
      message = regexp_replace(format('FAIL %s: %s', p_name, p_detail), '[\n\r]+', ' ', 'g');
  end if;
  raise notice 'PASS %', p_name;
end $$;

-- Run one statement as a role (null: as the session user) and REPORT a
-- behavioral error instead of raising it (correction 1, finding 4):
--   * the role switch is SETUP and runs before the error capture, so a role
--     that cannot be set (missing, not grantable) raises to the runner, which
--     reads it as NEVER-RAN, never as a judged refusal;
--   * the statement runs without INTO, so a successful INSERT, UPDATE, DELETE,
--     TRUNCATE or data-changing WITH reads as success whatever its text says;
--   * in the handler, diagnostics are read first, then the role is reset, so
--     the interruption check runs as the session user.
-- SET LOCAL ROLE outside the inner block is not undone by the inner block's
-- rollback; it is reset explicitly on both paths.
create function pg_temp.attempt_as(p_role text, p_sql text, out o_raised boolean, out o_state text,
                                   out o_message text, out o_constraint text)
language plpgsql as $$
begin
  o_raised := false;
  if p_role is not null then
    execute format('set local role %I', p_role);
  end if;
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics o_state = returned_sqlstate, o_message = message_text,
                            o_constraint = constraint_name;
    execute 'reset role';
    if pg_temp.interruption(o_state) then raise; end if;
    o_raised := true;
  end;
  execute 'reset role';
end $$;

-- One value read as a role. No error capture at all: any error here reaches
-- the runner as NEVER-RAN. Used only after a judged check that the same read
-- succeeds.
create function pg_temp.value_as(p_role text, p_sql text)
returns text language plpgsql as $$
declare v text;
begin
  execute format('set local role %I', p_role);
  execute p_sql into v;
  execute 'reset role';
  return v;
end $$;

-- Expect p_sql, run as p_role, to raise p_state (and, when given, to name
-- constraint p_constraint).
create function pg_temp.raises(p_name text, p_role text, p_sql text, p_state text, p_constraint text default null)
returns void language plpgsql as $$
declare r record;
begin
  select * into r from pg_temp.attempt_as(p_role, p_sql);
  perform pg_temp.ok(p_name,
    r.o_raised and r.o_state = p_state and (p_constraint is null or r.o_constraint = p_constraint),
    format('expected %s%s, got raised=%s state=%s constraint=%s message=%s', p_state,
           coalesce(' on ' || p_constraint, ''), r.o_raised, r.o_state, r.o_constraint, r.o_message));
end $$;

create function pg_temp.succeeds(p_name text, p_role text, p_sql text)
returns void language plpgsql as $$
declare r record;
begin
  select * into r from pg_temp.attempt_as(p_role, p_sql);
  perform pg_temp.ok(p_name, not r.o_raised,
    format('expected success, got state=%s message=%s', r.o_state, r.o_message));
end $$;

create function pg_temp.row_count() returns bigint language sql as $$
  select count(*) from public.complete_contract_events
$$;

-- T01 shape: the columns, types, nullability and defaults.
select pg_temp.ok('T01 columns',
  (select string_agg(format('%s:%s:%s:%s', column_name, data_type, is_nullable, coalesce(column_default, '-')), ' ' order by ordinal_position)
     from information_schema.columns
    where table_schema = 'public' and table_name = 'complete_contract_events')
  = 'id:uuid:NO:gen_random_uuid() created_at:timestamp with time zone:NO:now() tool:text:NO:- task_id:uuid:YES:- agent_code:text:YES:- outcome:text:NO:- reason:text:NO:- project_slug:text:YES:- occurred_at:timestamp with time zone:NO:-',
  (select string_agg(format('%s:%s:%s:%s', column_name, data_type, is_nullable, coalesce(column_default, '-')), ' ' order by ordinal_position)
     from information_schema.columns
    where table_schema = 'public' and table_name = 'complete_contract_events'));
select pg_temp.ok('T01 primary key on id',
  (select string_agg(a.attname, ',') from pg_index i
     join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
    where i.indrelid = 'public.complete_contract_events'::regclass and i.indisprimary) = 'id');
select pg_temp.ok('T01 no foreign key',
  not exists (select 1 from pg_constraint where conrelid = 'public.complete_contract_events'::regclass and contype = 'f'));

-- T02 the CHECKs: each refuses what it must and a well-formed row passes.
select pg_temp.raises('T02 outcome accepted is refused', null,
  $q$insert into public.complete_contract_events (occurred_at, tool, outcome, reason) values (now(), 'complete_agent_task', 'accepted', 'X')$q$,
  '23514', 'complete_contract_events_outcome_check');
select pg_temp.raises('T02 outcome null is refused', null,
  $q$insert into public.complete_contract_events (occurred_at, tool, outcome, reason) values (now(), 'complete_agent_task', null, 'X')$q$,
  '23502');
select pg_temp.raises('T02 occurred_at null is refused', null,
  $q$insert into public.complete_contract_events (occurred_at, tool, outcome, reason) values (null, 'complete_agent_task', 'refused', 'X')$q$,
  '23502');
select pg_temp.raises('T02 another tool is refused', null,
  $q$insert into public.complete_contract_events (occurred_at, tool, outcome, reason) values (now(), 'hold_agent_task', 'refused', 'X')$q$,
  '23514', 'complete_contract_events_tool_check');
select pg_temp.raises('T02 receipt text in reason is refused', null,
  $q$insert into public.complete_contract_events (occurred_at, tool, outcome, reason) values (now(), 'complete_agent_task', 'refused', 'Work summary: did the thing')$q$,
  '23514', 'complete_contract_events_reason_shape');
select pg_temp.raises('T02 multi-line reason is refused', null,
  format('insert into public.complete_contract_events (occurred_at, tool, outcome, reason) values (now(), %L, %L, %L)',
         'complete_agent_task', 'refused', 'RECEIPT_MISSING_SECTION' || chr(10) || 'OTHER'),
  '23514', 'complete_contract_events_reason_shape');
select pg_temp.raises('T02 lower-case reason is refused', null,
  $q$insert into public.complete_contract_events (occurred_at, tool, outcome, reason) values (now(), 'complete_agent_task', 'refused', 'receipt_missing_section')$q$,
  '23514', 'complete_contract_events_reason_shape');
select pg_temp.raises('T02 empty reason is refused', null,
  $q$insert into public.complete_contract_events (occurred_at, tool, outcome, reason) values (now(), 'complete_agent_task', 'refused', '')$q$,
  '23514', 'complete_contract_events_reason_shape');
select pg_temp.raises('T02 trailing comma in reason is refused', null,
  $q$insert into public.complete_contract_events (occurred_at, tool, outcome, reason) values (now(), 'complete_agent_task', 'refused', 'RECEIPT_MISSING_SECTION,')$q$,
  '23514', 'complete_contract_events_reason_shape');
select pg_temp.raises('T02 empty agent_code is refused', null,
  $q$insert into public.complete_contract_events (occurred_at, tool, outcome, reason, agent_code) values (now(), 'complete_agent_task', 'refused', 'X', '')$q$,
  '23514', 'complete_contract_events_agent_code_nonempty');
select pg_temp.raises('T02 empty project_slug is refused', null,
  $q$insert into public.complete_contract_events (occurred_at, tool, outcome, reason, project_slug) values (now(), 'complete_agent_task', 'refused', 'X', '')$q$,
  '23514', 'complete_contract_events_project_slug_nonempty');
select pg_temp.ok('T02 refused inserts wrote nothing', pg_temp.row_count() = 0, pg_temp.row_count()::text);
select pg_temp.succeeds('T02 a two-reason refused row is accepted', null,
  $q$insert into public.complete_contract_events (occurred_at, tool, task_id, agent_code, outcome, reason, project_slug)
     values (now(), 'request_agent_review', '00000000-0000-4000-8000-000000000001', 'claude-code', 'refused',
             'RECEIPT_MISSING_SECTION,OPERATOR_MARKER_OUTSIDE_FOLLOW_UP', 'brain-bank') returning 'ok'$q$);
select pg_temp.ok('T02 id and created_at are filled by default',
  (select count(*) = 1 and bool_and(id is not null and created_at is not null) from public.complete_contract_events));
delete from public.complete_contract_events;

-- T03 RLS on, and exactly the two service_role policies.
select pg_temp.ok('T03 RLS enabled',
  (select relrowsecurity from pg_class where oid = 'public.complete_contract_events'::regclass));
select pg_temp.ok('T03 policies',
  (select string_agg(format('%s:%s', cmd, array_to_string(roles, ',')), ' ' order by cmd)
     from pg_policies where schemaname = 'public' and tablename = 'complete_contract_events') = 'INSERT:service_role SELECT:service_role',
  (select coalesce(string_agg(format('%s:%s', cmd, array_to_string(roles, ',')), ' ' order by cmd), '(none)')
     from pg_policies where schemaname = 'public' and tablename = 'complete_contract_events'));

-- T04 privileges, catalog and behavior. anon and authenticated have none;
-- service_role has insert and select and nothing else; PUBLIC has nothing.
create temp table obt_privs as
select r.rolname, p.priv,
       has_table_privilege(r.rolname, 'public.complete_contract_events', p.priv) as granted
from (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as p(priv);
grant select on obt_privs to public;
select pg_temp.ok('T04 anon has no privilege',
  not exists (select 1 from obt_privs where rolname = 'anon' and granted),
  (select string_agg(priv, ',') from obt_privs where rolname = 'anon' and granted));
select pg_temp.ok('T04 authenticated has no privilege',
  not exists (select 1 from obt_privs where rolname = 'authenticated' and granted),
  (select string_agg(priv, ',') from obt_privs where rolname = 'authenticated' and granted));
select pg_temp.ok('T04 service_role has exactly insert and select',
  (select string_agg(priv, ',' order by priv) from obt_privs where rolname = 'service_role' and granted) = 'INSERT,SELECT',
  coalesce((select string_agg(priv, ',' order by priv) from obt_privs where rolname = 'service_role' and granted), '(none)'));
select pg_temp.ok('T04 PUBLIC has no grant',
  not exists (select 1 from pg_class c, aclexplode(c.relacl) a
               where c.oid = 'public.complete_contract_events'::regclass and a.grantee = 0));
-- Column level (correction 2, finding 3): a column grant is invisible to the
-- table-level checks above. No column of this table carries its own ACL, and
-- the EFFECTIVE column privileges (has_column_privilege follows role
-- membership) are exactly what the table grants imply: service_role SELECT
-- and INSERT on every column, nothing else, and nothing for anon or
-- authenticated.
select pg_temp.ok('T04 no column-level grants on the table',
  not exists (select 1 from pg_attribute
               where attrelid = 'public.complete_contract_events'::regclass
                 and attnum > 0 and not attisdropped and attacl is not null),
  (select string_agg(attname || '=' || attacl::text, ' ') from pg_attribute
    where attrelid = 'public.complete_contract_events'::regclass
      and attnum > 0 and not attisdropped and attacl is not null));
create temp table obt_colprivs as
select r.rolname, a.attname, p.priv,
       has_column_privilege(r.rolname, 'public.complete_contract_events', a.attname, p.priv) as granted
from (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
cross join (select attname from pg_attribute
             where attrelid = 'public.complete_contract_events'::regclass
               and attnum > 0 and not attisdropped) as a
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) as p(priv);
select pg_temp.ok('T04 effective column privileges are service_role select and insert only',
  (select count(*) = 3 * 9 * 4 from obt_colprivs)
  and not exists (select 1 from obt_colprivs
                   where granted is distinct from (rolname = 'service_role' and priv in ('SELECT', 'INSERT'))),
  coalesce((select string_agg(format('%s %s %s=%s', rolname, attname, priv, granted), '; ')
              from obt_colprivs
             where granted is distinct from (rolname = 'service_role' and priv in ('SELECT', 'INSERT'))),
           format('%s rows', (select count(*) from obt_colprivs))));
-- Roles each of the three can become (correction 3, finding 2): a role reached
-- through membership, or through SET ROLE alone (membership with INHERIT FALSE,
-- SET TRUE), brings its own privileges, which the checks above do not see.
-- pg_has_role(..., 'MEMBER') and (..., 'SET') follow chains of memberships.
-- Every reachable role, the base role included, may hold on this table at most
-- SELECT and INSERT when reached from service_role, nothing when reached from
-- anon or authenticated, and no grant option anywhere; the same at column level.
create temp table obt_reach as
select b.base, r.rolname as reach
from (values ('anon'), ('authenticated'), ('service_role')) as b(base)
join pg_roles r on pg_has_role(b.base, r.oid, 'MEMBER') or pg_has_role(b.base, r.oid, 'SET');
select pg_temp.ok('T04 the reachable-role list includes each base role',
  (select count(*) = 3 from obt_reach where reach = base));
create temp table obt_reach_privs as
select o.base, o.reach, p.priv,
       has_table_privilege(o.reach, 'public.complete_contract_events', p.priv) as granted
from obt_reach o
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'),
                   ('SELECT WITH GRANT OPTION'), ('INSERT WITH GRANT OPTION')) as p(priv);
select pg_temp.ok('T04 no role reachable from anon, authenticated or service_role holds more than intended on the table',
  not exists (select 1 from obt_reach_privs
               where granted and not (base = 'service_role' and priv in ('SELECT', 'INSERT'))),
  (select string_agg(format('%s->%s %s', base, reach, priv), ', ') from obt_reach_privs
    where granted and not (base = 'service_role' and priv in ('SELECT', 'INSERT'))));
select pg_temp.ok('T04 no role reachable from anon, authenticated or service_role holds more than intended on any column',
  not exists (select 1 from obt_reach o
               cross join (select attname from pg_attribute
                            where attrelid = 'public.complete_contract_events'::regclass
                              and attnum > 0 and not attisdropped) as a
               cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) as p(priv)
               where has_column_privilege(o.reach, 'public.complete_contract_events', a.attname, p.priv)
                 and not (o.base = 'service_role' and p.priv in ('SELECT', 'INSERT'))));
-- MAINTAIN exists from PostgreSQL 17 (production runs 17.6). No role reachable
-- from anon, authenticated or service_role, the base roles included, may hold
-- it (correction 4, finding 2: the earlier check covered the base roles only).
-- PostgreSQL 16 has no such privilege, so there the check is SKIPPED and says so
-- with its own SKIP line: it is never printed as a PASS. This branch first runs
-- at rollout, on 17.6.
do $$
declare v boolean;
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute $q$select not exists (select 1 from obt_reach o
                                 where has_table_privilege(o.reach, 'public.complete_contract_events', 'MAINTAIN'))$q$ into v;
    perform pg_temp.ok('T04 no MAINTAIN for any role reachable from anon, authenticated or service_role', v,
      (select string_agg(base || '->' || reach, ', ') from obt_reach));
  else
    raise notice 'SKIP T04 no MAINTAIN for any role reachable from anon, authenticated or service_role: PostgreSQL % has no MAINTAIN privilege; this branch first runs at rollout on 17',
      current_setting('server_version');
  end if;
end $$;
-- And the effective result: from every role service_role can become other than
-- itself, an UPDATE is refused (none exists on a correct setup, so this loop
-- normally judges nothing; the catalog checks above are the guarantee).
do $$
declare v record;
begin
  for v in select reach from obt_reach where base = 'service_role' and reach <> 'service_role' order by reach loop
    perform pg_temp.raises(format('T04 update as %s (reachable from service_role) is refused', v.reach), v.reach,
      $q$update public.complete_contract_events set project_slug = 'reached'$q$, '42501');
  end loop;
end $$;
select pg_temp.raises('T04 anon select is refused', 'anon',
  'select count(*)::text from public.complete_contract_events', '42501');
select pg_temp.raises('T04 anon insert is refused', 'anon',
  $q$insert into public.complete_contract_events (occurred_at, tool, outcome, reason) values (now(), 'complete_agent_task', 'refused', 'X')$q$, '42501');
select pg_temp.raises('T04 authenticated select is refused', 'authenticated',
  'select count(*)::text from public.complete_contract_events', '42501');
select pg_temp.raises('T04 authenticated insert is refused', 'authenticated',
  $q$insert into public.complete_contract_events (occurred_at, tool, outcome, reason) values (now(), 'complete_agent_task', 'refused', 'X')$q$, '42501');
select pg_temp.succeeds('T04 service_role insert works', 'service_role',
  $q$insert into public.complete_contract_events (occurred_at, tool, task_id, agent_code, outcome, reason, project_slug)
     values (now(), 'complete_agent_task', '00000000-0000-4000-8000-000000000002', 'codex', 'warned',
             'ROUTE_SNAPSHOT_UNAVAILABLE', 'brain-bank') returning 'ok'$q$);
select pg_temp.succeeds('T04 service_role select works', 'service_role',
  'select count(*) from public.complete_contract_events');
select pg_temp.ok('T04 service_role select reads the row',
  pg_temp.value_as('service_role', 'select count(*)::text from public.complete_contract_events') = '1');
select pg_temp.raises('T04 service_role update is refused', 'service_role',
  $q$update public.complete_contract_events set reason = 'OTHER'$q$, '42501');
select pg_temp.raises('T04 service_role update of project_slug is refused', 'service_role',
  $q$update public.complete_contract_events set project_slug = 'other'$q$, '42501');
select pg_temp.raises('T04 service_role delete is refused', 'service_role',
  'delete from public.complete_contract_events', '42501');
select pg_temp.raises('T04 service_role truncate is refused', 'service_role',
  'truncate public.complete_contract_events', '42501');
-- Correction 1, finding 2: identifiers longer than any old cap land whole.
select pg_temp.succeeds('T04 service_role insert of a 5000-character agent_code and project_slug works', 'service_role',
  format('insert into public.complete_contract_events (occurred_at, tool, outcome, reason, agent_code, project_slug) values (now(), %L, %L, %L, %L, %L)',
         'complete_agent_task', 'warned', 'ROUTE_SNAPSHOT_UNAVAILABLE', repeat('a', 5000), repeat('s', 5000)));
select pg_temp.ok('T04 the long identifiers are stored whole',
  (select count(*) = 1 from public.complete_contract_events
    where char_length(agent_code) = 5000 and char_length(project_slug) = 5000));
delete from public.complete_contract_events where char_length(agent_code) = 5000;
select pg_temp.ok('T04 the row is unchanged', (select string_agg(reason, ',') from public.complete_contract_events) = 'ROUTE_SNAPSHOT_UNAVAILABLE');
delete from public.complete_contract_events;

-- T05 the weekly queries on seeded rows. ws is the start of the current UTC
-- week; offsets are minutes, so every seeded row lands in a known week.
-- The session runs at UTC+14 on purpose: the queries must bucket by UTC weeks
-- whatever the session time zone, so a week computed in local time shows here.
set timezone = 'Pacific/Kiritimati';
create temp table obt_ws as
select (date_trunc('week', now() at time zone 'UTC') at time zone 'UTC') as ws,
       (date_trunc('week', now() at time zone 'UTC'))::date as wsd;
-- Cards: A refused twice then done; B refused, never done; C done clean;
-- D refused last week and done this week; E refused 13 weeks ago (outside);
-- C, F (twice) and G warned, G five hours before the week turned (UTC).
-- occurred_at is when the log line was emitted; created_at is when the
-- delayed insert landed (correction 1, finding 1). A's refusals land 15
-- minutes late, AFTER A's repair at +10; the first (+1) still counts as before
-- it. A's second refusal (+12) comes after that repair, so only the FIRST
-- refusal of the week makes A a repaired card (correction 2, finding 2); H was
-- refused two minutes before the week turned and landed five minutes after,
-- and still counts last week; X occurred next week and counts nowhere.
insert into public.complete_contract_events (occurred_at, created_at, tool, task_id, agent_code, outcome, reason, project_slug)
select ws + o.at, ws + o.at + o.delay, o.tool, o.task::uuid, 'claude-code', o.outcome, o.reason, o.slug
from obt_ws, (values
  (interval '1 minute',  interval '15 minutes', 'complete_agent_task',  '0000000a-0000-4000-8000-000000000000', 'refused', 'RECEIPT_MISSING_SECTION,OPERATOR_MARKER_OUTSIDE_FOLLOW_UP', 'brain-bank'),
  (interval '12 minutes', interval '15 minutes', 'complete_agent_task',  '0000000a-0000-4000-8000-000000000000', 'refused', 'RECEIPT_MISSING_SECTION', 'brain-bank'),
  (interval '3 minutes', interval '0',          'request_agent_review', '0000000b-0000-4000-8000-000000000000', 'refused', 'MISSING_PROJECT_SLUG', null),
  (interval '4 minutes', interval '0',          'complete_agent_task',  '0000000c-0000-4000-8000-000000000000', 'warned',  'ROUTE_SNAPSHOT_UNAVAILABLE', 'brain-bank'),
  (interval '5 minutes', interval '0',          'complete_agent_task',  '0000000f-0000-4000-8000-000000000000', 'warned',  'ROUTE_SNAPSHOT_UNAVAILABLE', 'example-site'),
  (interval '6 minutes', interval '0',          'complete_agent_task',  '0000000f-0000-4000-8000-000000000000', 'warned',  'ROUTE_SNAPSHOT_UNAVAILABLE', 'example-site'),
  (interval '-7 days' + interval '1 minute', interval '0', 'complete_agent_task', '0000000d-0000-4000-8000-000000000000', 'refused', 'DELIVERABLE_WITHOUT_OPERATOR_ACTION', 'va-2027'),
  -- Sunday 19:00 UTC: last week in UTC, but Monday 09:00 this week at UTC+14.
  (interval '-5 hours', interval '0', 'complete_agent_task', '00000010-0000-4000-8000-000000000000', 'warned', 'ROUTE_SNAPSHOT_UNAVAILABLE', 'brain-bank'),
  (interval '-2 minutes', interval '7 minutes', 'complete_agent_task', '00000012-0000-4000-8000-000000000000', 'refused', 'RECEIPT_MISSING_SECTION', 'brain-bank'),
  (interval '7 days' + interval '1 minute', interval '0', 'complete_agent_task', '00000013-0000-4000-8000-000000000000', 'refused', 'NEXT_WEEK_ONLY', 'brain-bank'),
  (interval '-91 days', interval '0', 'complete_agent_task', '0000000e-0000-4000-8000-000000000000', 'refused', 'RECEIPT_MISSING_SECTION', 'brain-bank')
) as o(at, delay, tool, task, outcome, reason, slug);
insert into public.agent_task_events (created_at, task_id, event_type)
select ws + o.at, o.task::uuid, o.ev
from obt_ws, (values
  (interval '10 minutes', '0000000a-0000-4000-8000-000000000000', 'AGENT DONE'),
  (interval '11 minutes', '0000000c-0000-4000-8000-000000000000', 'AGENT DONE'),
  (interval '12 minutes', '0000000d-0000-4000-8000-000000000000', 'AGENT DONE'),
  (interval '13 minutes', '0000000b-0000-4000-8000-000000000000', 'AGENT CLAIMED'),
  -- K: a clean completion. Four done against three refusals makes this week's
  -- share 3/7 = 42.9, where integer division would read 42 (correction 1,
  -- finding 5).
  (interval '14 minutes', '00000011-0000-4000-8000-000000000000', 'AGENT DONE'),
  (interval '-91 days' + interval '1 minute', '0000000e-0000-4000-8000-000000000000', 'AGENT DONE')
) as o(at, task, ev);
-- B was done once BEFORE its refusal (an earlier generation): not a later done.
insert into public.agent_task_events (created_at, task_id, event_type)
select ws - interval '1 day', '0000000b-0000-4000-8000-000000000000', 'AGENT DONE' from obt_ws;

create temp table obt_weekly as
-- @@WEEKLY_QUERY@@
;
create temp table obt_reasons as
-- @@REASONS_QUERY@@
;

select pg_temp.ok('T05 twelve weeks, one row each, ending this week',
  (select count(*) = 12 and count(distinct week) = 12 and max(week) = (select wsd from obt_ws)
            and min(week) = (select wsd - 77 from obt_ws) from obt_weekly),
  (select format('rows=%s min=%s max=%s', count(*), min(week), max(week)) from obt_weekly));
select pg_temp.ok('T05 this week',
  (select format('%s|%s|%s|%s|%s|%s|%s', agent_done_events, refused_events, refused_tasks, refused_tasks_later_done,
                 refused_share_pct, route_snapshot_unavailable, warned_slugs)
     from obt_weekly, obt_ws where week = wsd) = '4|3|2|1|42.9|3|2',
  (select format('done|refused|tasks|later|share|warn|slugs = %s|%s|%s|%s|%s|%s|%s', agent_done_events, refused_events, refused_tasks,
                 refused_tasks_later_done, refused_share_pct, route_snapshot_unavailable, warned_slugs)
     from obt_weekly, obt_ws where week = wsd));
select pg_temp.ok('T05 last week',
  (select format('%s|%s|%s|%s|%s|%s|%s', agent_done_events, refused_events, refused_tasks, refused_tasks_later_done,
                 refused_share_pct, route_snapshot_unavailable, warned_slugs)
     from obt_weekly, obt_ws where week = wsd - 7) = '1|2|2|1|66.7|1|1',
  (select format('done|refused|tasks|later|share|warn|slugs = %s|%s|%s|%s|%s|%s|%s', agent_done_events, refused_events, refused_tasks,
                 refused_tasks_later_done, refused_share_pct, route_snapshot_unavailable, warned_slugs)
     from obt_weekly, obt_ws where week = wsd - 7));
select pg_temp.ok('T05 empty weeks read zero with a null share',
  (select count(*) = 10 and bool_and(agent_done_events = 0 and refused_events = 0 and refused_tasks = 0
                                     and refused_tasks_later_done = 0 and refused_share_pct is null
                                     and route_snapshot_unavailable = 0 and warned_slugs = 0)
     from obt_weekly, obt_ws where week < wsd - 7));
select pg_temp.ok('T05 reasons by week',
  (select string_agg(format('%s:%s:%s', case when week = wsd then 'this' when week = wsd - 7 then 'last' else week::text end,
                            reason_code, refusals), ' ' order by week, refusals desc, reason_code)
     from obt_reasons, obt_ws)
  = 'last:DELIVERABLE_WITHOUT_OPERATOR_ACTION:1 last:RECEIPT_MISSING_SECTION:1 this:RECEIPT_MISSING_SECTION:2 this:MISSING_PROJECT_SLUG:1 this:OPERATOR_MARKER_OUTSIDE_FOLLOW_UP:1',
  (select string_agg(format('%s:%s:%s', week, reason_code, refusals), ' ' order by week, refusals desc, reason_code) from obt_reasons));
select pg_temp.ok('T05 the queries wrote nothing',
  pg_temp.row_count() = 11 and (select count(*) from public.agent_task_events) = 7,
  format('events=%s agent_task_events=%s', pg_temp.row_count(), (select count(*) from public.agent_task_events)));

-- After this contract passes, the runner also runs the metrics file verbatim
-- in a fresh psql session on the rows seeded above (correction 2, finding 1;
-- moved out of this session by correction 3, finding 1, so it sees none of the
-- variables this session was started with).

do $$ begin raise notice 'COMPLETE CONTRACT EVENTS SQL TEST PASSED'; end $$;
