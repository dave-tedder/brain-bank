-- GCP & Cloud SQL compatibility schema adjustments (Start).
-- Targets file: gcp/gcp_compat_start.sql
--
-- This script mocks Supabase-specific functions and schemas (auth.role(), storage buckets)
-- so that upstream migrations execute cleanly on a standard PostgreSQL database.

-- Create extensions schema (for standard pgvector and pgcrypto placement)
CREATE SCHEMA IF NOT EXISTS extensions;

-- Set global search path to include extensions, matching Supabase default behavior
ALTER DATABASE postgres SET search_path TO "$user", public, extensions;
ALTER ROLE postgres SET search_path TO "$user", public, extensions;

-- Create default Supabase roles used in policy declarations
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role;
  END IF;
END
$$;

-- Grant standard roles to postgres user so it can switch roles in PostgREST
GRANT anon TO postgres;
GRANT authenticated TO postgres;
GRANT service_role TO postgres;

-- Configure service_role to behave like Supabase's service_role (bypassing RLS with full privileges)
ALTER ROLE service_role BYPASSRLS;
GRANT ALL ON SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;

-- 1. Create auth schema and PostgREST role helper
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(
    current_setting('request.jwt.claims', true)::json->>'role',
    'anon'
  );
$$;

REVOKE EXECUTE ON FUNCTION auth.role() FROM public;

-- 2. Create storage schema and tables to satisfy buckets & object dependencies
CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  public boolean DEFAULT false,
  file_size_limit bigint,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets(id) ON DELETE RESTRICT,
  name text NOT NULL,
  owner uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  last_accessed_at timestamp with time zone DEFAULT now(),
  metadata jsonb,
  path_tokens text[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED
);

-- Create mock cron schema and schedule function to intercept pg_cron setup statements
CREATE SCHEMA IF NOT EXISTS cron;

CREATE OR REPLACE FUNCTION cron.schedule(
  job_name text,
  schedule text,
  command text
)
RETURNS bigint
LANGUAGE sql
AS $$
  SELECT 1::bigint;
$$;

-- Create mock public.call_edge_function to satisfy REVOKE statements in security migrations
CREATE OR REPLACE FUNCTION public.call_edge_function(
  func_name text,
  qs text,
  method text
)
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN 'mock';
END;
$$;


