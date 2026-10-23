-- Non-secret identifiers only. No access keys, tokens, or passwords in this table.
create table public.brain_oauth_config (
  singleton boolean primary key default true check (singleton),
  owner_id uuid not null references auth.users(id),
  client_id uuid not null,
  resource_url text not null check (resource_url ~ '^https://[^[:space:]]+$')
);
alter table public.brain_oauth_config enable row level security;
revoke all on public.brain_oauth_config from public, anon, authenticated;
grant all on public.brain_oauth_config to service_role;
create policy "Service role full access on brain_oauth_config"
  on public.brain_oauth_config for all to service_role
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- Supabase Auth owns code issuance, S256 PKCE, refresh rotation and revocation.
-- Bind only the explicitly configured owner/client pair to the memory resource.
create function public.brain_oauth_token_hook(event jsonb)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  cfg public.brain_oauth_config%rowtype;
  claims jsonb := event->'claims';
  requesting_client text := coalesce(event->>'client_id', event->'claims'->>'client_id');
begin
  select * into cfg from public.brain_oauth_config where singleton = true;
  if cfg.client_id is not null and requesting_client = cfg.client_id::text then
    if event->>'user_id' is distinct from cfg.owner_id::text then
      return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'This account cannot authorize Brain Bank.'));
    end if;
    claims := jsonb_set(claims, '{aud}', to_jsonb(cfg.resource_url));
    claims := jsonb_set(claims, '{client_id}', to_jsonb(cfg.client_id::text));
    claims := jsonb_set(claims, '{brain_access}', '"memory"'::jsonb);
    return jsonb_set(event, '{claims}', claims);
  end if;
  return event;
end;
$$;
revoke execute on function public.brain_oauth_token_hook(jsonb) from public, anon, authenticated;
grant execute on function public.brain_oauth_token_hook(jsonb) to supabase_auth_admin;
