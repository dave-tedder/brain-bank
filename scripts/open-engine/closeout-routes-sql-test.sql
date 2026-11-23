-- Loop-closing Task 5.4: single-connection contract for
-- supabase/migrations/20261120b_closeout_routes.sql (the closeout_routes table,
-- its grants and RLS, the closeout_route_publisher role and
-- publish_closeout_routes). Run ONLY by closeout-routes-sql-test.sh against a
-- throwaway local cluster. Every check prints PASS <name> or raises FAIL <name>;
-- the last line prints CLOSEOUT ROUTES SQL TEST PASSED.
--
-- The TF001 mechanism of scripts/loop-closing/action-item-review-sql-test.sql:
-- a check that RAN and did not hold raises SQLSTATE TF001 with a message
-- starting "FAIL ", from pg_temp.ok and from nowhere else. Every error a mutant
-- is expected to produce is caught by pg_temp.attempt_as and judged by a named
-- check; an interruption is re-raised untouched, so the runner reports it as
-- NEVER-RAN instead of a failure.

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
      message = regexp_replace(format('FAIL %s: %s', p_name, p_detail), E'[\n\r]+', ' ', 'g');
  end if;
  raise notice 'PASS %', p_name;
end $$;

-- Run one statement as a role and REPORT a behavioral error instead of raising
-- it. The role switch is SET LOCAL inside the handler block, so an error rolls it
-- back with the subtransaction and success resets it explicitly.
create function pg_temp.attempt_as(p_role text, p_sql text, out o_raised boolean, out o_state text,
                                   out o_message text, out o_constraint text, out o_result text)
language plpgsql as $$
begin
  o_raised := false;
  begin
    if p_role is not null then
      execute format('set local role %I', p_role);
    end if;
    execute p_sql into o_result;
    execute 'reset role';
  exception when others then
    get stacked diagnostics o_state = returned_sqlstate, o_message = message_text,
                            o_constraint = constraint_name;
    if pg_temp.interruption(o_state) then raise; end if;
    o_raised := true;
  end;
end $$;

-- Every row of closeout_routes, every column. "Wrote nothing" is equality of two
-- of these.
create function pg_temp.state()
returns jsonb language sql as $$
  select coalesce(jsonb_agg(to_jsonb(r) order by r.slug), '[]'::jsonb) from public.closeout_routes r
$$;

create function pg_temp.raises(p_name text, p_role text, p_sql text, p_state text, p_like text)
returns void language plpgsql as $$
declare
  v_before jsonb := pg_temp.state();
  a record;
begin
  select * into a from pg_temp.attempt_as(p_role, p_sql);
  perform pg_temp.ok(p_name, a.o_raised and a.o_state = p_state and a.o_message like '%' || p_like || '%',
    format('raised=%s sqlstate=%s message=%s', a.o_raised, coalesce(a.o_state, '-'), coalesce(a.o_message, '-')));
  perform pg_temp.ok(p_name || ' wrote nothing', pg_temp.state() = v_before);
end $$;

create function pg_temp.succeeds(p_name text, p_role text, p_sql text, p_want text)
returns void language plpgsql as $$
declare
  a record;
begin
  select * into a from pg_temp.attempt_as(p_role, p_sql);
  perform pg_temp.ok(p_name, not a.o_raised and a.o_result is not distinct from p_want,
    format('raised=%s sqlstate=%s message=%s result=%s', a.o_raised, coalesce(a.o_state, '-'),
           coalesce(a.o_message, '-'), coalesce(a.o_result, 'null')));
end $$;

-- A valid route element.
create function pg_temp.route(p_slug text, p_ws boolean default true, p_tr boolean default true,
                              p_sl boolean default true, p_ct boolean default true)
returns jsonb language sql immutable as $$
  select jsonb_build_object('slug', p_slug, 'has_workspace', p_ws, 'has_tracker', p_tr,
                            'has_session_log', p_sl, 'has_capture_tag', p_ct)
$$;

create function pg_temp.call(p_routes jsonb)
returns text language sql immutable as $$
  select format('select public.publish_closeout_routes(%L::jsonb)', p_routes::text)
$$;

-- T01 the table's shape.
select pg_temp.ok('T01 closeout_routes has exactly the six planned columns, types and nullability',
  (select string_agg(format('%s:%s:%s', a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull), ',' order by a.attnum)
     from pg_attribute a where a.attrelid = 'public.closeout_routes'::regclass and a.attnum > 0 and not a.attisdropped)
  = 'slug:text:t,has_workspace:boolean:t,has_tracker:boolean:t,has_session_log:boolean:t,has_capture_tag:boolean:t,published_at:timestamp with time zone:t',
  (select string_agg(format('%s:%s:%s', a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull), ',' order by a.attnum)
     from pg_attribute a where a.attrelid = 'public.closeout_routes'::regclass and a.attnum > 0 and not a.attisdropped));
select pg_temp.ok('T01 slug is the primary key',
  (select pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.closeout_routes'::regclass and c.contype = 'p') = 'PRIMARY KEY (slug)');

-- T02 RLS on.
select pg_temp.ok('T02 row level security is enabled on closeout_routes',
  (select relrowsecurity from pg_class where oid = 'public.closeout_routes'::regclass));

-- T03 table privileges, read through has_table_privilege (default privileges
-- included: the stub grants every new table to anon, authenticated and
-- service_role, as Supabase does).
select pg_temp.ok('T03 anon has no privilege on closeout_routes',
  not has_table_privilege('anon', 'public.closeout_routes', 'select,insert,update,delete,truncate,references,trigger'));
select pg_temp.ok('T03 authenticated has no privilege on closeout_routes',
  not has_table_privilege('authenticated', 'public.closeout_routes', 'select,insert,update,delete,truncate,references,trigger'));
select pg_temp.ok('T03 service_role can select closeout_routes',
  has_table_privilege('service_role', 'public.closeout_routes', 'select'));
select pg_temp.ok('T03 service_role cannot write closeout_routes',
  not has_table_privilege('service_role', 'public.closeout_routes', 'insert,update,delete,truncate'));
select pg_temp.ok('T03 the publisher role has no table privilege at all',
  not has_table_privilege('closeout_route_publisher', 'public.closeout_routes', 'select,insert,update,delete,truncate,references,trigger')
  and not has_any_column_privilege('closeout_route_publisher', 'public.closeout_routes', 'select,insert,update'));

-- T04 the function.
select pg_temp.ok('T04 publish_closeout_routes is security definer with search_path pinned',
  (select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
     from pg_proc p where p.oid = 'public.publish_closeout_routes(jsonb)'::regprocedure),
  (select format('secdef=%s config=%s', p.prosecdef, p.proconfig) from pg_proc p where p.oid = 'public.publish_closeout_routes(jsonb)'::regprocedure));
select pg_temp.ok('T04 PUBLIC holds no EXECUTE on publish_closeout_routes',
  not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
               where p.oid = 'public.publish_closeout_routes(jsonb)'::regprocedure and x.grantee = 0));
select pg_temp.ok('T04 only the publisher can execute publish_closeout_routes',
  has_function_privilege('closeout_route_publisher', 'public.publish_closeout_routes(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.publish_closeout_routes(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.publish_closeout_routes(jsonb)', 'execute')
  and not has_function_privilege('service_role', 'public.publish_closeout_routes(jsonb)', 'execute'));

-- T05 the role.
select pg_temp.ok('T05 closeout_route_publisher cannot log in, does not bypass RLS, does not inherit',
  (select not rolcanlogin and not rolbypassrls and not rolinherit and not rolsuper
     from pg_roles where rolname = 'closeout_route_publisher'));
select pg_temp.ok('T05 authenticator can SET ROLE to the publisher (PostgREST role switch)',
  pg_has_role('authenticator', 'closeout_route_publisher', 'MEMBER'));

-- T06 the publish path, as the publisher.
select pg_temp.ok('T06 the table starts empty', pg_temp.state() = '[]'::jsonb);
select pg_temp.succeeds('T06 the publisher upserts two routes and is told 2', 'closeout_route_publisher',
  pg_temp.call(jsonb_build_array(pg_temp.route('brain-bank'), pg_temp.route('acme_site', true, false, true, false))), '2');
select pg_temp.ok('T06 both rows hold exactly the published booleans',
  (select jsonb_agg(jsonb_build_array(slug, has_workspace, has_tracker, has_session_log, has_capture_tag) order by slug)
     from public.closeout_routes)
  = '[["acme_site", true, false, true, false], ["brain-bank", true, true, true, true]]'::jsonb,
  pg_temp.state()::text);

-- T07 the server stamps published_at, and a re-publish refreshes it and the booleans.
create temp table obt_t07 as select slug, published_at from public.closeout_routes;
select pg_temp.ok('T07 published_at is the server time of the publish',
  (select bool_and(published_at > now() - interval '5 minutes' and published_at <= clock_timestamp()) from public.closeout_routes));
select pg_sleep(0.05);
select pg_temp.succeeds('T07 a re-publish of one route is told 1', 'closeout_route_publisher',
  pg_temp.call(jsonb_build_array(pg_temp.route('acme_site', true, true, true, true))), '1');
select pg_temp.ok('T07 the re-published row has the new booleans and a later published_at',
  (select r.has_tracker and r.has_capture_tag and r.published_at > o.published_at
     from public.closeout_routes r join obt_t07 o using (slug) where r.slug = 'acme_site'),
  pg_temp.state()::text);
select pg_temp.ok('T07 the route not re-published keeps its published_at',
  (select r.published_at = o.published_at from public.closeout_routes r join obt_t07 o using (slug) where r.slug = 'brain-bank'));

-- T08 the publisher cannot touch the table directly.
select pg_temp.raises('T08 publisher direct select is refused', 'closeout_route_publisher',
  'select count(*)::text from public.closeout_routes', '42501', 'permission denied');
select pg_temp.raises('T08 publisher direct insert is refused', 'closeout_route_publisher',
  $q$insert into public.closeout_routes values ('x', true, true, true, true, now()) returning slug$q$, '42501', 'permission denied');
select pg_temp.raises('T08 publisher direct update (a forged published_at) is refused', 'closeout_route_publisher',
  $q$update public.closeout_routes set published_at = now() + interval '1 year' returning slug$q$, '42501', 'permission denied');
select pg_temp.raises('T08 publisher direct delete is refused', 'closeout_route_publisher',
  'delete from public.closeout_routes returning slug', '42501', 'permission denied');

-- T09 everyone else.
select pg_temp.raises('T09 anon cannot read routes', 'anon',
  'select count(*)::text from public.closeout_routes', '42501', 'permission denied');
select pg_temp.raises('T09 authenticated cannot read routes', 'authenticated',
  'select count(*)::text from public.closeout_routes', '42501', 'permission denied');
select pg_temp.raises('T09 anon cannot publish', 'anon',
  pg_temp.call(jsonb_build_array(pg_temp.route('evil'))), '42501', 'permission denied');
select pg_temp.raises('T09 authenticated cannot publish', 'authenticated',
  pg_temp.call(jsonb_build_array(pg_temp.route('evil'))), '42501', 'permission denied');
select pg_temp.raises('T09 service_role cannot publish', 'service_role',
  pg_temp.call(jsonb_build_array(pg_temp.route('evil'))), '42501', 'permission denied');
select pg_temp.raises('T09 service_role cannot insert directly', 'service_role',
  $q$insert into public.closeout_routes values ('evil', true, true, true, true, now()) returning slug$q$, '42501', 'permission denied');
select pg_temp.succeeds('T09 service_role (the Edge Function) reads the route columns', 'service_role',
  $q$select string_agg(slug || ':' || has_workspace || has_tracker || has_session_log || has_capture_tag, ',' order by slug) from public.closeout_routes$q$,
  'acme_site:truetruetruetrue,brain-bank:truetruetruetrue');

-- T10 every malformed payload is refused with 22023 and writes nothing.
select pg_temp.raises('T10 a JSON object instead of an array', 'closeout_route_publisher',
  pg_temp.call(pg_temp.route('brain-bank')), '22023', 'must be a JSON array');
select pg_temp.raises('T10 a null payload', 'closeout_route_publisher',
  'select public.publish_closeout_routes(null)::text', '22023', 'must be a JSON array');
select pg_temp.raises('T10 an empty array', 'closeout_route_publisher',
  pg_temp.call('[]'::jsonb), '22023', '1 to 200 routes');
select pg_temp.raises('T10 201 routes', 'closeout_route_publisher',
  pg_temp.call((select jsonb_agg(pg_temp.route('r' || g)) from generate_series(1, 201) g)), '22023', '1 to 200 routes');
select pg_temp.raises('T10 an element that is not an object', 'closeout_route_publisher',
  pg_temp.call('["brain-bank"]'::jsonb), '22023', 'must be a JSON object');
select pg_temp.raises('T10 an element carrying a path (an extra key)', 'closeout_route_publisher',
  pg_temp.call(jsonb_build_array(pg_temp.route('brain-bank') || '{"workspace_path": "/Users/someone/Projects/x"}'::jsonb)),
  '22023', 'must carry exactly');
select pg_temp.raises('T10 an element missing a capability', 'closeout_route_publisher',
  pg_temp.call(jsonb_build_array(pg_temp.route('brain-bank') - 'has_tracker')), '22023', 'must carry exactly');
select pg_temp.raises('T10 a slug with a slash', 'closeout_route_publisher',
  pg_temp.call(jsonb_build_array(pg_temp.route('a/b'))), '22023', 'is not a route key');
select pg_temp.raises('T10 an upper-case slug with a space', 'closeout_route_publisher',
  pg_temp.call(jsonb_build_array(pg_temp.route('Brain Bank'))), '22023', 'is not a route key');
select pg_temp.raises('T10 a numeric slug', 'closeout_route_publisher',
  pg_temp.call('[{"slug": 7, "has_workspace": true, "has_tracker": true, "has_session_log": true, "has_capture_tag": true}]'::jsonb),
  '22023', 'is not a route key');
select pg_temp.raises('T10 a capability given as the string "true"', 'closeout_route_publisher',
  pg_temp.call('[{"slug": "brain-bank", "has_workspace": "true", "has_tracker": true, "has_session_log": true, "has_capture_tag": true}]'::jsonb),
  '22023', 'must be JSON booleans');
select pg_temp.raises('T10 a capability given as null', 'closeout_route_publisher',
  pg_temp.call('[{"slug": "brain-bank", "has_workspace": true, "has_tracker": true, "has_session_log": true, "has_capture_tag": null}]'::jsonb),
  '22023', 'must be JSON booleans');
select pg_temp.raises('T10 the same slug twice', 'closeout_route_publisher',
  pg_temp.call(jsonb_build_array(pg_temp.route('brain-bank', false), pg_temp.route('brain-bank'))), '22023', 'appears twice');

-- T11 atomic: one bad element refuses the valid ones beside it.
select pg_temp.raises('T11 a valid new route beside an invalid one is not written', 'closeout_route_publisher',
  pg_temp.call(jsonb_build_array(pg_temp.route('brand-new'), pg_temp.route('Bad Key'))), '22023', 'is not a route key');

-- T12 the table's own CHECK stops a path-shaped slug even from the owner.
do $$
declare a record;
begin
  select * into a from pg_temp.attempt_as(null,
    $q$insert into public.closeout_routes values ('/Users/x', true, true, true, true, now()) returning slug$q$);
  perform pg_temp.ok('T12 the slug CHECK stops a path even from the table owner',
    a.o_raised and a.o_state = '23514' and a.o_constraint = 'closeout_routes_slug_shape',
    format('raised=%s sqlstate=%s constraint=%s', a.o_raised, coalesce(a.o_state, '-'), coalesce(nullif(a.o_constraint, ''), '-')));
end $$;

-- OBRT_INJECT_POINT (the runner's negative controls insert one statement here)

do $$ begin raise notice 'CLOSEOUT ROUTES SQL TEST PASSED'; end $$;
