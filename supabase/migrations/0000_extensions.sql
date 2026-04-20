-- 0000_extensions.sql
-- Required Postgres extensions + the shared update_updated_at() trigger function.
-- pg_graphql, pg_stat_statements, and supabase_vault are managed by Supabase and
-- do not need to be enabled here. The pg_cron wrapper (public.call_edge_function())
-- is an optional operator-configured piece and lives outside these core migrations;
-- see docs/operations/ for the post-deploy recipe.

-- Vector similarity search (thoughts.embedding + match_thoughts RPC).
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- gen_random_uuid() used as the default for every table's `id` column.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- pg_cron + pg_net: required only if the operator wants scheduled digests /
-- compile-pages runs. Safe to enable here — they are no-ops until the operator
-- creates cron jobs post-deploy.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Shared trigger function: stamps `updated_at = now()` on row UPDATE. Attached
-- by the per-table migrations (0001, 0003, 0005, 0006, 0007, 0008) on tables
-- that carry an `updated_at` column.
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
