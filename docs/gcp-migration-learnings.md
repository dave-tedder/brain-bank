# Google Cloud Platform & Windows Migration Learnings

This document summarizes the core technical challenges, architectural decisions, and learnings discovered during the migration of **Brain Bank** from its default Supabase-hosted stack to a fully integrated, serverless Google Cloud Platform (GCP) deployment, along with supporting Windows-based local development.

---

## 1. Windows Local Development Learnings

### Path Separators in Unit Tests
* **Symptom:** Node.js unit tests comparing absolute file paths against POSIX strings failed when run on Windows.
* **Cause:** Node's native path resolution utilities (like `path.resolve` or `path.join`) generate Windows-style backslashes (`\`) on Windows.
* **Resolution:** When writing or evaluating paths in tests, conditionally replace backslashes with forward slashes (e.g. `path.replace(/\\/g, "/")`) to keep tests environment-agnostic.

### PowerShell Script Execution Policies
* **Symptom:** Scripts or Node CLI commands failed to run in Windows terminal environments due to local script execution policy locks.
* **Resolution:** Execute commands through the `cmd /c` wrapper (e.g. `cmd /c "gcloud builds submit ..."`) to bypass PowerShell environment execution locks securely and consistently.

### Secret Injection Whitespace Mismatch
* **Symptom:** Secrets written via command-line shell utilities crashed Deno's URL parser on container initialization.
* **Cause:** Running `echo "my_secret_key" | gcloud secrets versions add` on Windows appends a trailing Windows newline carriage return (`\r\n`) to the secret value.
* **Resolution:** Always use standard input file streams or Python data buffers to write secrets to GCP Secret Manager without introducing trailing newlines.

---

## 2. Database & Authorization (Supabase to Cloud SQL)

### Missing Supabase System Roles
* **Symptom:** Running standard Supabase migrations on a bare PostgreSQL database (like GCP Cloud SQL) failed when attempting to configure RLS policies or trigger functions checking `auth.role()`.
* **Resolution:** Manually bootstrap the missing Supabase roles (`anon`, `authenticated`, `service_role`) before pushing application schemas.

### PostgREST Role Membership Mismatch
* **Symptom:** Database queries returned `403 Forbidden` with the error `PGRST301 / 42501: permission denied to set role "service_role"`.
* **Cause:** PostgREST logs into the database as the `postgres` user. When a JWT claims a role (like `service_role`), PostgREST attempts to execute `SET LOCAL ROLE service_role`. If the `postgres` user is not a member of that role, PostgreSQL rejects the switch.
* **Resolution:** Explicitly grant membership to the PostgREST connection user:
  ```sql
  GRANT anon TO postgres;
  GRANT authenticated TO postgres;
  GRANT service_role TO postgres;
  ```

### service_role Bypass RLS & Schema Privileges
* **Symptom:** Queries succeeded but returned empty sets or failed due to permission denial on views/tables.
* **Cause:** Custom roles created on vanilla PostgreSQL do not bypass Row Level Security (RLS) or have schema privileges by default.
* **Resolution:** Alter the role to bypass RLS and establish default privileges for all tables and views created during migrations:
  ```sql
  ALTER ROLE service_role BYPASSRLS;
  GRANT ALL ON SCHEMA public TO service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;
  ```

### Supabase Client REST URL Suffix
* **Symptom:** Database queries made from the Next.js dashboard returned `404 Not Found` (JSON errors logged as `{}`).
* **Cause:** The `@supabase/supabase-js` library hardcodes a `/rest/v1` path suffix onto its database URL. Standalone PostgREST instances deployed to Cloud Run, however, serve tables directly at the root `/`.
* **Resolution:** Monkeypatch the client initialization in the dashboard and edge functions to override the internal REST client URL directly to the raw URL if a custom standalone PostgREST endpoint is used:
  ```typescript
  const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  if (SUPABASE_URL && (SUPABASE_URL.includes("bb-postgrest") || !SUPABASE_URL.includes("supabase.co"))) {
    // @ts-ignore
    client.rest.url = SUPABASE_URL;
  }
  ```

### service_role JWT Generation
* **Symptom:** PostgREST rejected queries with `PGRST301 JWSError (CompactDecodeError: Expected 3 parts)`.
* **Cause:** The dashboard and edge functions were initialized with the raw 32-character HMAC secret key instead of a signed JSON Web Token (JWT).
* **Resolution:** Generated a valid, signed JWT payload containing `{ "role": "service_role", "iss": "supabase" }` signed with the project's secret key and saved it to Secret Manager.

---

## 3. Google Cloud Serverless Architecture

### Deno 2.x Port Configuration on Cloud Run
* **Symptom:** Deno edge function containers booted successfully but failed startup health check probes on Cloud Run.
* **Cause:** Deno 2.x `Deno.serve()` defaults to port `8000` and does not automatically bind to the dynamic `$PORT` environment variable (typically `8080`) supplied by Cloud Run.
* **Resolution:** Run all Deno services with the explicit `--port=8000` launch argument to align Cloud Run's health checkers with Deno's internal listener.

### Deploy-Time Secret Manager Check
* **Symptom:** Cloud Build runs crashed during Cloud Run deployments.
* **Cause:** Cloud Run validates that all referenced Secret Manager secrets exist at deployment time. If optional integrations (like Slack) are bypassed, dummy secrets must still be provisioned beforehand.
* **Resolution:** Seed placeholder values for all optional secrets in the project before deploying the Cloud Run stack.
