-- GCP & Cloud SQL compatibility schema adjustments (Start).
-- Targets file: gcp/gcp_compat_start.sql
--
-- This script mocks Supabase-specific functions and schemas (auth.role(), storage buckets)
-- so that upstream migrations execute cleanly on a standard PostgreSQL database.

-- Create extensions schema (for standard pgvector and pgcrypto placement)
CREATE SCHEMA IF NOT EXISTS extensions;

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
