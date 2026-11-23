-- Loop-closing Task 5.4 (D3): the route capability snapshot complete_agent_task
-- reads at complete time.
--
-- The closeout controller routes a card through a gitignored, machine-local
-- registry of private filesystem paths (scripts/open-engine/project-closeout-
-- registry.json) and holds it when the workspace, tracker or session log is
-- missing or the capture tag is empty. The Edge Function cannot see that file
-- and must never hold those paths (plan, open question 5). So the operator's
-- machine publishes four booleans per route key, and nothing else, into this
-- table; complete_agent_task reads them to refuse a completion whose route is
-- known to be broken, and accepts with a ROUTE_SNAPSHOT_UNAVAILABLE warning when
-- the row is absent or older than 7 days.
--
-- Writers and readers:
--   closeout_route_publisher  NOLOGIN role behind a PostgREST JWT (minted off
--                             database by scripts/open-engine/mint-route-publisher-jwt.py).
--                             It holds EXECUTE on publish_closeout_routes and
--                             nothing else: no table privilege at all.
--   publish_closeout_routes   SECURITY DEFINER. Validates the whole payload (an
--                             array of objects with exactly the five keys, a
--                             slug of route-key shape, four JSON booleans, no
--                             duplicates), then upserts every row and stamps
--                             published_at with the server's now(). One bad
--                             element refuses the whole call and writes nothing.
--   service_role              SELECT only (the Edge Function reads; it never
--                             writes routes).
--   anon, authenticated       nothing. Supabase's default privileges grant every
--                             new public table to both, so they are revoked here.
-- No delete path: a route removed from the registry stops being refreshed and
-- reads as unavailable once its row is 7 days old.
--
-- Rollback (in order):
--   drop function public.publish_closeout_routes(jsonb);
--   drop table public.closeout_routes;
--   revoke usage on schema public from closeout_route_publisher;
--   revoke closeout_route_publisher from authenticator;
--   revoke closeout_route_publisher from postgres;
--   drop role closeout_route_publisher;

create table public.closeout_routes (
  slug text primary key,
  has_workspace boolean not null,
  has_tracker boolean not null,
  has_session_log boolean not null,
  has_capture_tag boolean not null,
  published_at timestamptz not null default now(),
  -- Route-key shape only: lower-case letters, digits, '-' and '_', no '/', no
  -- spaces, at most 64 characters. A path cannot fit in this column.
  constraint closeout_routes_slug_shape check (slug ~ '^[a-z0-9][a-z0-9_-]{0,63}$')
);

comment on table public.closeout_routes is
  'Loop-closing Task 5.4: per-route closeout capabilities published from the operator machine (booleans only, never paths). Read by complete_agent_task; written only through publish_closeout_routes.';

alter table public.closeout_routes enable row level security;

revoke all on table public.closeout_routes from public, anon, authenticated, service_role;
grant select on table public.closeout_routes to service_role;
create policy "Service role reads closeout_routes"
  on public.closeout_routes for select to service_role using (true);

create role closeout_route_publisher nologin noinherit nobypassrls;
comment on role closeout_route_publisher is
  'Open Engine route snapshot publisher (Task 5.4). EXECUTE on publish_closeout_routes only, via PostgREST. Token: scripts/open-engine/mint-route-publisher-jwt.py';
-- PostgREST switches to the JWT role with SET ROLE, which needs membership.
grant closeout_route_publisher to authenticator;
-- Lets the postgres admin role test with `set role closeout_route_publisher`.
grant closeout_route_publisher to postgres with set true, inherit false;
grant usage on schema public to closeout_route_publisher;

create or replace function public.publish_closeout_routes(p_routes jsonb)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_el jsonb;
  v_keys text[];
  v_slugs text[] := '{}';
  v_count integer := 0;
begin
  if p_routes is null or jsonb_typeof(p_routes) <> 'array' then
    raise exception 'p_routes must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_routes) < 1 or jsonb_array_length(p_routes) > 200 then
    raise exception 'p_routes must hold 1 to 200 routes, got %', jsonb_array_length(p_routes)
      using errcode = '22023';
  end if;

  for v_el in select value from jsonb_array_elements(p_routes) loop
    if jsonb_typeof(v_el) <> 'object' then
      raise exception 'each route must be a JSON object' using errcode = '22023';
    end if;
    select array_agg(k order by k) into v_keys from jsonb_object_keys(v_el) as k;
    if v_keys is distinct from array['has_capture_tag', 'has_session_log', 'has_tracker', 'has_workspace', 'slug'] then
      raise exception 'each route must carry exactly slug, has_workspace, has_tracker, has_session_log, has_capture_tag (got %)', v_keys
        using errcode = '22023';
    end if;
    if jsonb_typeof(v_el -> 'slug') <> 'string'
       or (v_el ->> 'slug') !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
      raise exception 'route slug % is not a route key', v_el -> 'slug' using errcode = '22023';
    end if;
    if jsonb_typeof(v_el -> 'has_workspace') <> 'boolean'
       or jsonb_typeof(v_el -> 'has_tracker') <> 'boolean'
       or jsonb_typeof(v_el -> 'has_session_log') <> 'boolean'
       or jsonb_typeof(v_el -> 'has_capture_tag') <> 'boolean' then
      raise exception 'route % capabilities must be JSON booleans', v_el ->> 'slug' using errcode = '22023';
    end if;
    if (v_el ->> 'slug') = any (v_slugs) then
      raise exception 'route % appears twice', v_el ->> 'slug' using errcode = '22023';
    end if;
    v_slugs := v_slugs || (v_el ->> 'slug');
  end loop;

  insert into public.closeout_routes as r
    (slug, has_workspace, has_tracker, has_session_log, has_capture_tag, published_at)
  select e ->> 'slug',
         (e ->> 'has_workspace')::boolean,
         (e ->> 'has_tracker')::boolean,
         (e ->> 'has_session_log')::boolean,
         (e ->> 'has_capture_tag')::boolean,
         now()
  from jsonb_array_elements(p_routes) as e
  on conflict (slug) do update
    set has_workspace = excluded.has_workspace,
        has_tracker = excluded.has_tracker,
        has_session_log = excluded.has_session_log,
        has_capture_tag = excluded.has_capture_tag,
        published_at = excluded.published_at;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.publish_closeout_routes(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.publish_closeout_routes(jsonb) to closeout_route_publisher;

notify pgrst, 'reload config';
