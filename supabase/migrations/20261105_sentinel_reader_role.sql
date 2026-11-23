-- Loop-closing Task 0.2: read-only PostgREST access for the Open Engine cloud
-- sentinel's step 3d backlog-drift reads. The cloud environment is shared by
-- every OE routine, so it must never hold the service_role key. Instead the
-- sentinel presents a JWT whose role claim is `sentinel_reader`, a NOLOGIN
-- Postgres role that can SELECT exactly the columns the four reads name and
-- nothing else. RLS stays on; each table gets one SELECT-only policy for this
-- role. The anon key stays as the gateway `apikey`; it has no policy on any of
-- these tables and reads zero rows on its own.
--
-- Token minting happens off-database (scripts/loop-closing/mint-sentinel-read-jwt.py)
-- because this project has neither pgjwt nor app.settings.jwt_secret.
-- Rollback: drop policy ... ; revoke all on ... from sentinel_reader;
--           revoke sentinel_reader from authenticator; drop role sentinel_reader;

create role sentinel_reader nologin noinherit nobypassrls;
comment on role sentinel_reader is
  'Open Engine cloud sentinel, step 3d drift reads. SELECT-only on four tables via PostgREST. Token: scripts/loop-closing/mint-sentinel-read-jwt.py';

-- PostgREST switches to the JWT role with SET ROLE, which needs membership.
grant sentinel_reader to authenticator;
-- Lets the postgres admin role test with `set role sentinel_reader` (no inherit).
grant sentinel_reader to postgres with set true, inherit false;

grant usage on schema public to sentinel_reader;

grant select (id, digest_date, digest_type, created_at, metadata)
  on public.digests to sentinel_reader;
grant select (id, created_at, resolved_at, status)
  on public.action_items to sentinel_reader;
grant select (id, task_id, created_at, event_type, payload)
  on public.agent_task_events to sentinel_reader;
grant select (id, status, created_at, archived_at)
  on public.agent_tasks to sentinel_reader;

create policy "Sentinel read-only on digests"
  on public.digests for select to sentinel_reader using (true);
create policy "Sentinel read-only on action_items"
  on public.action_items for select to sentinel_reader using (true);
create policy "Sentinel read-only on agent_task_events"
  on public.agent_task_events for select to sentinel_reader using (true);
create policy "Sentinel read-only on agent_tasks"
  on public.agent_tasks for select to sentinel_reader using (true);

-- Defensive: PostgREST already runs GET in read-only transactions.
alter role sentinel_reader set default_transaction_read_only = on;

notify pgrst, 'reload config';
