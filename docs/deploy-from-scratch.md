# Deploy Brain Bank from scratch

This is the full walkthrough. Start with a cold clone and a new Supabase account, end with four Edge Functions running and your first captured thought in the database. Expect about thirty minutes the first time.

The walkthrough is written for someone who is comfortable pasting commands into a terminal but has never deployed a Supabase project before. Every non-obvious step answers "why does this matter" so you are not running commands on faith. Every step also lists what success looks like and what to do if it fails, so a red error message tells you exactly where to go next.

Twelve steps. The last two (Slack and scheduled digests) are optional.

## Guided alternative

If you prefer to do setup inside a Claude Code session rather than reading through this doc, run `/brain-bank-setup` after cloning. The skill walks you through every step interactively, writes `profile.json` based on a short Q&A, and handles all the shell work for you. This doc stays the authoritative reference if you want to self-serve or come back later.

## Before you start

You need four accounts and four tools.

Accounts:
- [Supabase](https://supabase.com). Free tier is fine for a personal instance.
- [OpenRouter](https://openrouter.ai). Set a monthly spend cap in the OpenRouter dashboard before going further. Typical personal usage runs $5 to $15 per month; a runaway bug could climb faster than that.
- [GitHub](https://github.com). Needed to clone the repo.
- (Optional) [Slack](https://slack.com). Needed only for the Slack capture channel and morning digest delivery. A throwaway workspace you create just for this is fine.

Tools, all installed locally:
- Git.
- Node 18 or newer. (`node --version` should print `v18` or higher.)
- The [Supabase CLI](https://supabase.com/docs/guides/cli). On macOS: `brew install supabase/tap/supabase`. On other platforms see the CLI install page.
- A terminal (Terminal.app, iTerm, Windows Terminal, etc.).

You do not need Docker, a local Postgres install, or any Deno tooling. The Supabase CLI handles everything.

---

## Step 1. Clone the repo

```bash
git clone https://github.com/dave-tedder/brain-bank.git
cd brain-bank
```

**What success looks like:** `ls` shows `README.md`, `supabase/`, `profile.example.json`, `.env.example`, `CHANGELOG.md`, and friends.

**If it fails:**
- `fatal: repository not found`: the repo is still private pre-launch. If you are reading this file outside the repo, wait for the `v0.1.0` release announcement.
- `command not found: git`: install Git first. On macOS, `xcode-select --install` is the fastest path.

---

## Step 2. Create a fresh Supabase project

> **Free-tier project cap heads-up.** Supabase's free plan limits each organization to **2 active projects** at a time. If you already have two active projects under the same organization, **New project** will fail with a 400 / `BadRequestException`. Three ways out:
>
> 1. **Pause one of your existing active projects** (Dashboard → Project → Settings → Pause project). Pausing is free, instant, and reversible. Paused projects do not count toward the 2-active cap, so pausing one immediately frees a slot. Restore later from the Dashboard.
> 2. **Upgrade to Pro** ($25/mo per organization). Removes the cap entirely.
> 3. **Delete a project you no longer need** (Dashboard → Project → Settings → Delete project). Permanent; only do this if you're certain.
>
> Note: pausing differs from deleting. Paused projects retain their database, secrets, and Edge Functions and can be restored later. Deleting is irreversible.

Go to [supabase.com/dashboard](https://supabase.com/dashboard), click **New project**, and fill in:

- **Name:** anything you like. "brain-bank" works.
- **Database password:** Supabase generates one; copy it to a password manager. You will rarely need it (the CLI uses a separate access token), but lose it and you are rotating it through the dashboard.
- **Region:** pick the one closest to you.
- **Pricing plan:** Free.

Click **Create new project** and wait about two minutes while Supabase provisions Postgres, auth, and the Edge Functions runtime.

Once the dashboard shows the project as ready, grab two values you will need later:

1. **Project Reference ID.** Dashboard → Project Settings → General → Reference ID. Format: a 20-character lowercase string like `abcdefghijklmnopqrst`. This is your `<project-ref>` everywhere else in the walkthrough.
2. **API URL.** Dashboard → Project Settings → API → Project URL. Format: `https://<project-ref>.supabase.co`.

**What success looks like:** the dashboard shows a green "Healthy" status and your project ref matches the first part of the API URL.

**If it fails:**
- Project stuck provisioning for more than five minutes: refresh the page. If it is still stuck, delete it (Settings → General → Delete project) and try another region.

**Why this matters:** the project ref is what every `supabase` CLI command keys off of. Getting it wrong here means every later step silently targets the wrong project.

---

## Step 3. Link the CLI to your project

```bash
supabase login
supabase link --project-ref <your-project-ref>
```

The `login` command opens a browser and authenticates the CLI with your Supabase account. The `link` command tells the CLI "this directory maps to that project."

If the CLI prompts for the database password from Step 2, paste it. Recent Supabase CLI versions (v2.75 and newer) skip the password prompt at link time and defer it to Step 7's `supabase db push` instead. Either flow is fine; have your password from Step 2 ready when prompted, whether that's now or at the migration step.

**What success looks like:** `Finished supabase link.` and no error output. A new `supabase/.temp/` directory appears in the repo with a cached project reference.

**If it fails:**
- `Invalid access token`: re-run `supabase login`.
- `project not found`: the ref in `--project-ref` is wrong. Re-check the ID from Step 2. A common trap is copying the URL (`https://xxx.supabase.co`) instead of the bare ref (`xxx`).
- Password prompt rejects a correct password (older CLI versions only): Supabase occasionally caches old password state on the CLI. Run `supabase link --project-ref <ref> --password <password>` as a single command instead of letting the prompt ask.

---

## Step 4. Copy profile.json and edit

Brain Bank reads operator-specific vocabulary from `profile.json`. The repo ships `profile.example.json` with neutral defaults. Copy it:

```bash
cp profile.example.json supabase/functions/_shared/profile.json
```

Now open `supabase/functions/_shared/profile.json` in an editor. The fields that matter day-to-day:

- `operator.name`: your name, used in digest prose.
- `operator.emails`: list of email addresses that are "you." Used to filter which calendar events and Gmail threads are yours. Include every address you use (work, personal, aliases).
- `example_projects`: three example project names used as placeholder prompts in LLM calls. Use real names from your work so the engine has accurate examples to pattern against.
- `persona.digest` and `persona.compile_pages`: short phrase the engine uses when generating digest and wiki prose. Defaults to "a knowledge worker." Change it to fit your actual work ("a tattoo artist," "a fiction writer," "a product manager at a healthtech startup," etc.).
- `domain.singular_noun` / `domain.plural_noun` / `domain.vocabulary`: what you call a "session" of your work and the vocabulary list for classification.

Leave `event_types`, `client_event_types`, `content_types`, and `mechanical_capture_prefixes` alone for a first deploy; the defaults are fine.

**What success looks like:** `supabase/functions/_shared/profile.json` exists and parses as JSON (`cat supabase/functions/_shared/profile.json | python3 -m json.tool` prints it back without error).

**If it fails:**
- `Expecting property name` from `json.tool`: you left a trailing comma or forgot quotes. Fix the syntax; JSON is strict about both.

**Why this matters:** `profile.json` must live at `supabase/functions/_shared/profile.json` because `loadProfile()` in that directory imports it as a sibling module (`import profileDefaults from "./profile.json" with { type: "json" }`, see [`CHANGELOG.md`](../CHANGELOG.md) Fixed section for the bundler rationale). The Supabase CLI bundler resolves imports relative to the source file; `profile.json` at any other path is invisible to the bundler and every deploy returns a 400 `Failed to bundle ... Module not found "...supabase/functions/_shared/profile.json"` error at deploy time. (The bundler fix moved this failure from silent runtime 500 to explicit deploy-time 400; see CHANGELOG for the full incident note.) The next step checks for the file.

---

## Step 5. Copy .env and fill values

```bash
cp .env.example .env
```

Open `.env` in an editor. **Use a terminal editor (`nano`, `vi`, `vim`) or a code editor (VS Code, Sublime, etc.). On macOS, do NOT use TextEdit:** TextEdit silently fails to save files whose name starts with a dot (`.env`, `.gitignore`, etc.), reporting "Save successful" but writing nothing to disk. The next step's `supabase secrets set` will appear to push the right values when in fact `.env` is unchanged from `.env.example`. If you must use a GUI editor, confirm the save with `cat .env | head` immediately after.

[`.env.example`](../.env.example) has a "where to find" pointer and a "WHY" line for every variable; read those as you fill each one in.

For a minimum viable first deploy, you need:

- `SUPABASE_URL` (from Step 2)
- `SUPABASE_SERVICE_ROLE_KEY` (Dashboard → Project Settings → API → service_role, click **Reveal**)
- `OPENROUTER_API_KEY` (from OpenRouter → Keys → **Create Key**)
- `MCP_ACCESS_KEY` (generate locally: `openssl rand -hex 32` and paste the output)

You can leave every Slack variable and `NOTION_API_TOKEN` blank for now. The REST and MCP capture paths work without Slack. Adding Slack is Step 11.

**What success looks like:** `grep -c '^[A-Z]' .env` prints at least 4 (the four required variables above) and every filled line has a non-empty value after the `=`.

**If it fails:**
- `SUPABASE_SERVICE_ROLE_KEY` looks like `sb_pub_...` or `eyJ...` with `"role":"anon"` in the middle: you copied the wrong key. The service role key is clearly labeled "service_role" in the dashboard. The anon key will not work.

**Why this matters:** the service role key bypasses Row-Level Security, which is what Edge Functions need to do writes. Never commit this key, never paste it into browser-side code. `.env` is gitignored by the shipped `.gitignore`; verify with `git check-ignore .env` (should print `.env`).

---

## Step 6. Push your secrets to Supabase

Edge Functions read environment variables from Supabase's secrets store, not from your local `.env` file. Push them:

```bash
grep -v '^[A-Z_]*=$' .env | grep -v '^#' | supabase secrets set --project-ref <your-project-ref> --env-file /dev/stdin
```

The `grep -v '^[A-Z_]*=$'` filter strips any line ending in `=` with no value (the empty placeholders left over from `.env.example` for vars you skipped, like the optional `SLACK_*` set on a no-Slack first deploy). Without the filter, `supabase secrets set` happily pushes every `KEY=` line as an empty-string secret, leaving 6 to 10 cosmetic empty entries in your project that show up forever in `supabase secrets list`. The filter keeps the dashboard clean. If you prefer to keep things simple at the cost of cosmetic noise, the unfiltered form (`supabase secrets set --env-file .env --project-ref <your-project-ref>`) works too, the empty entries are harmless.

**What success looks like:** `Finished supabase secrets set.` with no error output, PLUS one `Env name cannot start with SUPABASE_, skipping: <name>` line per `SUPABASE_*` variable in your `.env`. The skip warnings are expected: the Supabase CLI refuses to push any variable whose name starts with `SUPABASE_` because the Edge Function runtime auto-injects `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` at invocation time. The skip is not a failure; the functions still receive both values.

**If it fails:**
- `project not found`: you passed the wrong ref. Re-check against Step 2.
- `invalid line` in the output: `.env` has a malformed line (missing `=`, stray quotes, unclosed multi-line value). Fix it and re-run.

Verify the upload worked:

```bash
supabase secrets list --project-ref <your-project-ref>
```

You should see the non-`SUPABASE_` names: `OPENROUTER_API_KEY`, `MCP_ACCESS_KEY`, plus any `SLACK_*` names if you already filled in Slack secrets. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` will NOT appear in this list (they were skipped by design, see above, and the runtime injects them anyway). The `DIGEST` column shows SHA-256 hashes of the values, not the values themselves (Supabase CLI never prints secret values).

**Why this matters:** the secrets live on Supabase's servers, not in your local environment. Every Edge Function invocation reads them fresh. Rotating a secret later is re-running `supabase secrets set` with the new value; no code redeploy needed.

---

## Step 7. Run the migrations

```bash
supabase db push
```

This applies every SQL file in `supabase/migrations/` to your Supabase project in order. There are twelve migrations: the `extensions` migration (pgvector, pgcrypto, pg_cron, pg_net), the core tables (`thoughts`, `action_items`, `clients`, `content_items`, `business_events`, `compiled_pages`, `notion_mappings`, `digests`), the `match_thoughts` similarity RPC, and a `drop_client_sessions` cleanup migration that removes a deprecated table from earlier in the sequence.

**What success looks like:** `Applying migration 0000_extensions.sql...` through `Applying migration 0011_drop_client_sessions.sql...`, each followed by `Finished supabase db push.`

**If it fails:**
- `permission denied to create extension "vector"`: the CLI is talking to a Postgres where your role lacks `CREATE EXTENSION`. On Supabase-managed Postgres this should never happen; if it does, `cat supabase/.temp/project-ref` to confirm the CLI is linked to the project ref you expect.
- `relation "thoughts" already exists`: migrations already ran against this project from a prior attempt. Cleanest reset is to delete the project in the Supabase dashboard and create a new one. Do not try to drop tables by hand unless you know what you are doing.

Verify the schema landed. In the Supabase dashboard, go to Database → Tables. You should see nine tables: `thoughts`, `action_items`, `clients`, `content_items`, `business_events`, `compiled_pages`, `notion_mappings`, `digests`, and an internal `schema_migrations`.

**Why this matters:** `supabase db push` is idempotent for migration files but not for hand-run SQL. If you mix migration-driven schema with one-off edits in the SQL editor, future `db push` calls may fail. Stick to migrations for schema changes.

---

## Step 8. Mirror MCP_ACCESS_KEY into Supabase's vault

The four Edge Functions read `MCP_ACCESS_KEY` from environment variables (Step 6 handled that). The scheduled digest jobs also need it, but pg_cron runs inside Postgres and cannot read Edge Function environment variables. Supabase's vault solves this: it is a Postgres-native encrypted secrets table.

Open the Supabase SQL editor (Dashboard → SQL Editor → New query) and run:

```sql
select vault.create_secret(
  '<paste the same MCP_ACCESS_KEY value from .env here>',
  'mcp_access_key',
  'MCP / Brain access key, used by pg_cron to call Edge Functions.'
);
```

Important: the first argument is the raw secret value, the second is the name Postgres uses to look it up, and the third is a description. Use the exact same value you put in `.env`. If you generated a new one here, cron calls would authenticate with one key and Edge Functions would accept a different one; nothing works.

**What success looks like:** the query returns a UUID and no error. You can confirm the secret is stored (but not its value) with:

```sql
select name, description, created_at
from vault.secrets
where name = 'mcp_access_key';
```

**If it fails:**
- `relation "vault.secrets" does not exist`: the `supabase_vault` extension is not enabled. Supabase enables it by default on new projects; if yours does not have it, go to Dashboard → Database → Extensions and search for `supabase_vault`, then click **Enable**.
- `duplicate key value violates unique constraint`: you already ran this once. Delete the existing row and recreate: `delete from vault.secrets where name = 'mcp_access_key';` then re-run the `vault.create_secret(...)` call above.

**Why this matters:** the cron wrapper you create in Step 12 (optional) reads the vault secret at call time rather than baking the key into the cron job command. That means future key rotations are a one-row vault update, not four cron job edits.

---

## Step 9. Deploy the four Edge Functions

```bash
supabase functions deploy ingest-thought --no-verify-jwt --project-ref <your-project-ref>
supabase functions deploy open-brain-mcp --no-verify-jwt --project-ref <your-project-ref>
supabase functions deploy brain-digest --no-verify-jwt --project-ref <your-project-ref>
supabase functions deploy compile-pages --no-verify-jwt --project-ref <your-project-ref>
```

The `--no-verify-jwt` flag is important: these functions authenticate inbound callers with `MCP_ACCESS_KEY` (or Slack's signing secret for the Slack path), not with a Supabase JWT. Leave the flag off and every inbound call returns 401.

Each deploy takes about fifteen seconds. There is no build step; the Supabase CLI bundles the TypeScript source and pushes it straight to Deno.

**What success looks like:** each deploy prints `Deployed Function <name> on project <project-ref>`.

**Expected noise (ignore):** every deploy on a host without Docker prints `WARNING: Docker is not running, switching to API bundling.` That is benign. Brain Bank's bundling path uses Supabase's API-side bundler regardless of whether Docker is installed; the warning just notes that the CLI fell back to it. If you do not have Docker installed, leave it that way; installing Docker just to silence this warning gains you nothing.

**If it fails:**
- `A profile.json file is required` or `Failed to bundle the function (reason: Module not found "...supabase/functions/_shared/profile.json")`: the bundler cannot find the file at the expected path. Confirm Step 4 wrote it to the correct location (`ls supabase/functions/_shared/profile.json`) and re-run the deploy. If it landed at repo root instead, move it: `mv profile.json supabase/functions/_shared/profile.json`.
- `Deployment failed` with no detail: open the Supabase Dashboard at Project → Edge Functions → [function] → **Logs** to see the real error (the `supabase functions logs` CLI subcommand was removed in CLI v2.75).
- `undefined is not a function` at deploy time: you are on a very old Supabase CLI. Run `supabase --version`; upgrade to the latest with `brew upgrade supabase` (or the package-manager equivalent on your platform).

**Why this matters:** all four functions share code in `supabase/functions/_shared/` and read the same `profile.json`. Deploy order does not matter, but every one of the four needs to deploy successfully before the system is usable end-to-end.

---

## Step 10. Smoke-test the deploy

Now verify the REST capture path works. Replace `<your-project-ref>` and `<your-mcp-access-key>` with your values:

```bash
curl -X POST "https://<your-project-ref>.supabase.co/functions/v1/open-brain-mcp" \
  -H "x-brain-key: <your-mcp-access-key>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "capture_thought",
      "arguments": {
        "content": "First captured thought from my fresh Brain Bank deploy.",
        "source": "rest"
      }
    }
  }'
```

**What success looks like:** an SSE-formatted response starting with `event: message` followed by a `data: {...}` line. Inside the `data` JSON, `result.content[0].text` begins with `Captured as observation - [topics]` (auto-resolved topic labels included). Returns in under five seconds.

**If it fails:**
- `Not Acceptable: Client must accept both application/json and text/event-stream` (as a JSON-RPC error body): your curl is missing the `Accept: application/json, text/event-stream` header. The MCP Streamable HTTP transport requires both MIME types in `Accept`. Re-add the header and retry.
- `401 Unauthorized`: the `x-brain-key` header value does not match the `MCP_ACCESS_KEY` in your `.env` / Supabase secrets. Confirm with `supabase secrets list --project-ref <ref>` that `MCP_ACCESS_KEY` is present (the list shows a SHA256 digest, not the raw key), then re-check you copied it correctly into the curl command. REST endpoints also accept `Authorization: Bearer <key>` for clients such as ChatGPT Actions. URL query auth is not supported because URL parameters appear in Edge Function logs.
- `500 Internal Server Error` with a body like `{"error":"WORKER_ERROR"}`: the function is crashing on startup. Open the Supabase Dashboard at Project → Edge Functions → `open-brain-mcp` → **Logs** to see the actual error. Common causes: OpenRouter API key expired or over spend cap; `SUPABASE_SERVICE_ROLE_KEY` is actually an anon key (pre-redesign JWTs both start with `eyJ` and look identical to the Step 5 shape check); Supabase transient outage. `profile.json` missing is no longer a 500-at-runtime cause; the bundler fix surfaces it as a 400 at deploy time (see CHANGELOG), so a deployed-but-500 function is a different issue.
- `522` or connection timeout: Supabase is experiencing an outage. Check [status.supabase.com](https://status.supabase.com).

Verify the thought landed. In the Supabase SQL editor:

```sql
select id, left(content, 80) as preview, metadata, created_at
from thoughts
order by created_at desc
limit 5;
```

You should see one row with your test thought in it. The `metadata` JSON column will have extracted fields (`people`, `topics`, `action_items`, etc.) if metadata extraction succeeded.

**Why this matters:** the REST path exercises the same auto-resolve pipeline, SHA-256 deduplication, and metadata extraction as every other capture surface. If it works here, the MCP and Slack paths will work once you wire those up too.

---

## Step 11. (Optional) Connect Slack

If you want to capture thoughts by typing them into a Slack channel and want a morning digest delivered to Slack, follow the dedicated walkthrough:

- [`docs/slack-setup.md`](slack-setup.md)

That doc covers creating the Slack app, the three-channel architecture (capture, brain, query), event subscriptions, OAuth scopes, and wiring Slack's webhook URL to your Supabase Edge Function. It also walks through setting the remaining `SLACK_*` variables in `.env` and re-running Step 6 to push them.

You can skip this step entirely if you only plan to use MCP or REST capture.

---

## Step 12. (Optional) Schedule the morning digest

Brain Bank's daily digest is a 6 AM ET (or whatever timezone you prefer) summary of yesterday's captures delivered to Slack. Same for the weekly digest on Mondays, and the nightly wiki compilation pass. All three run via pg_cron inside Postgres.

This step is optional. If you skip it, digests never fire automatically, but you can still call `brain-digest` manually via curl whenever you want one.

### Create the cron wrapper function

The wrapper reads `mcp_access_key` from the vault (Step 8) and calls your Edge Function URLs. In the Supabase SQL editor, paste the block below after replacing `<your-project-ref>` with your actual ref:

```sql
create or replace function public.call_edge_function(
  function_slug text,
  query_string text default '',
  http_method text default 'POST'
) returns bigint
language plpgsql
security definer
set search_path = public, net, vault
as $$
declare
  v_key text;
  v_url text;
  v_request_id bigint;
begin
  select decrypted_secret into v_key
  from vault.decrypted_secrets
  where name = 'mcp_access_key';

  if v_key is null then
    raise exception 'vault secret mcp_access_key not found';
  end if;

  v_url := format(
    'https://<your-project-ref>.supabase.co/functions/v1/%s?%s%skey=%s',
    function_slug,
    query_string,
    case when query_string = '' then '' else '&' end,
    v_key
  );

  if http_method = 'POST' then
    select net.http_post(
      url := v_url,
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    ) into v_request_id;
  elsif http_method = 'GET' then
    select net.http_get(
      url := v_url,
      headers := '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds := 30000
    ) into v_request_id;
  else
    raise exception 'unsupported http_method: %', http_method;
  end if;

  return v_request_id;
end;
$$;

revoke execute on function public.call_edge_function(text, text, text) from public;
```

**What success looks like:** `CREATE FUNCTION` in the query output. A quick test call:

```sql
select public.call_edge_function('open-brain-mcp', 'health=1', 'GET');
```

should return a bigint (the `net.http_*` request ID), and inspecting `select * from net._http_response order by id desc limit 1;` shortly after should show a 200 response.

**Why `timeout_milliseconds := 30000`:** pg_net's default request timeout is 5 seconds. The `brain-digest` synthesis path can run 7 to 25 seconds depending on the LLM round-trip and the number of thoughts being summarized; `compile-pages` can be similar when it has to compile fresh pages. Without the explicit 30-second timeout, pg_net records `Timeout of 5000 ms reached` in `net._http_response.error_msg`, even though the Edge Function continues running and finishes the work successfully (Edge Functions run independently of the pg_net client connection). The cron job appears to have failed when it actually delivered. Setting the timeout to 30000ms aligns the pg_net client window with the Edge Function's true completion time and makes `net._http_response` a truthful diagnostic.

**If it fails:**
- `vault secret mcp_access_key not found`: you skipped Step 8. Go back and create the vault secret.
- `permission denied for function call_edge_function`: the `revoke execute` line did its job and your connection is not running as the `postgres` superuser. Cron jobs run as the job owner so this is fine for real cron usage; for your own test calls, use the Dashboard SQL editor (which runs as `postgres`) rather than a pooled connection.

### Schedule the four jobs

```sql
select cron.schedule(
  'daily-brain-digest',
  '0 10 * * *',  -- 6:00 AM ET during EDT; adjust for your timezone (pg_cron uses UTC)
  $$select public.call_edge_function('brain-digest', 'mode=daily', 'POST') as request_id;$$
);

select cron.schedule(
  'weekly-brain-digest',
  '0 10 * * 1',  -- 6:00 AM ET Mondays during EDT
  $$select public.call_edge_function('brain-digest', 'mode=weekly&push_to_notion=true', 'POST') as request_id;$$
);

select cron.schedule(
  'compile-pages-daily',
  '45 9 * * *',  -- 5:45 AM ET daily; runs before the morning digest so wiki is current
  $$select public.call_edge_function('compile-pages', 'mode=compile&batch=10', 'GET') as request_id;$$
);

select cron.schedule(
  'compile-pages-weekly-lint',
  '30 9 * * 1',  -- 5:30 AM ET Mondays; lints wiki pages before the weekly digest
  $$select public.call_edge_function('compile-pages', 'mode=lint&batch=10', 'GET') as request_id;$$
);
```

pg_cron uses UTC, not your local timezone. If you want a 6 AM wake-up in your local time, use a converter like [crontab.guru](https://crontab.guru) and offset for UTC. During US Eastern Daylight Time (EDT), 6:00 AM ET is 10:00 UTC; during US Eastern Standard Time (EST) it is 11:00 UTC. Pick the time that matches most of your year; the one-hour drift twice a year is not worth the complexity of automatic adjustment.

**What success looks like:** each `cron.schedule` call returns a bigint (the job ID). Confirm with:

```sql
select jobid, jobname, schedule, command from cron.job order by jobid;
```

You should see all four jobs listed.

**If it fails:**
- `extension "pg_cron" does not exist`: the `0000_extensions.sql` migration did not run. Confirm with `select * from pg_extension where extname = 'pg_cron';`. If empty, re-run `supabase db push`.
- Cron jobs do not fire at the scheduled time: check `select * from cron.job_run_details order by start_time desc limit 5;`. If the `status` is `failed`, the `return_message` column has the reason. Common causes: vault secret mismatch, wrong project ref in the wrapper, OpenRouter key expired.

**Why this matters:** future key rotations only require `update vault.secrets set secret = ... where name = 'mcp_access_key';`. You never edit cron job command strings again, and a rotation does not silently break four cron jobs at once.

### (Optional) Schedule the typed reasoning edges classifier

The `classify-edges` Edge Function looks at pairs of recently captured thoughts that share topics or a project, asks an LLM whether one supports / contradicts / supersedes / evolved into the other, and writes typed edges into `thought_edges`. The MCP `get_thought_by_id` tool surfaces a brief Relationships section and `get_thought_edges` returns the full edge list. Cost is bounded per run (default cap $2.00); over a typical week the function classifies ~15 new pairs.

```sql
select cron.schedule(
  'classify-edges-weekly',
  '15 10 * * 0',  -- Sundays 10:15 UTC; offset for your timezone if you prefer
  $$select public.call_edge_function('classify-edges', 'mode=incremental&since_days=8&min_overlap=2&limit=15&dry_run=false&max_cost_usd=2.00&min_confidence=0.7', 'POST') as request_id;$$
);
```

**Why `limit=15`:** the function buffers `limit*4` candidate pairs in worker memory before filter+classify. At `limit=15` (60 pairs in memory) the worker stays well under the 256 MB Edge Function ceiling. Higher limits can hit `WORKER_RESOURCE_LIMIT`. If your weekly capture rate is high enough that `limit=15` leaves a backlog, schedule a second job at a different hour rather than raising `limit`.

**Why weekly, not daily:** at typical capture rates (~50/day) the per-week pool of new high-overlap pairs is small enough that daily firing wastes LLM budget on the same pairs being re-evaluated. Sundays 10:15 UTC sits well clear of the daily 09:45 UTC `compile-pages` cron, so a worker timeout in one job will not affect the other.

**Verify:**

```sql
select jobid, jobname, schedule, active from cron.job where jobname = 'classify-edges-weekly';
-- expect 1 row with active = true.
```

After the first Sunday fire, check `select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'classify-edges-weekly') order by start_time desc limit 1;` and confirm `status = 'succeeded'`.

Skip this if you do not plan to use the typed reasoning edge classifier. It is purely an enrichment surface; the wiki and raw thoughts remain primary retrieval paths whether or not edges exist.

---

## What's next

You now have:

- Four deployed Edge Functions
- A fresh Supabase project with the full Brain Bank schema
- The MCP / REST capture path verified end-to-end
- (Optional) Slack capture + morning digest delivery
- (Optional) Scheduled daily and weekly digests
- (Optional) Weekly typed reasoning edges classifier

Places to go from here:

- **Capture sources.** Slack covers a lot, but Brain Bank can also ingest from Gmail (labeled threads), Google Calendar events, Apple Notes, voice memos, Notion pages, and a ChatGPT custom GPT. Per-source dummies guides live in `docs/capture-sources/` (arriving in Phase 4.6 through 4.11).
- **Dashboard.** The Next.js dashboard at `dashboard/` gives you a browsing UI, chat interface, and digest archive. Deploy instructions ship with Phase 5 (monorepo merge) and will live at `docs/dashboard-deploy.md`.
- **Troubleshooting.** When something breaks six weeks from now and you cannot remember why, `docs/troubleshooting.md` (Phase 4.12) will be the first stop.
- **Rotating a key.** Change `MCP_ACCESS_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, or `OPENROUTER_API_KEY` by editing the value in `.env` and re-running `supabase secrets set --env-file .env --project-ref <ref>`. For `MCP_ACCESS_KEY`, also refresh the vault entry so cron keeps working: `delete from vault.secrets where name = 'mcp_access_key';` then re-run the `vault.create_secret(...)` call from Step 8 with the new value.

If you hit a bug in this walkthrough, open an issue on the repo. The doc is meant to run clean end-to-end against a throwaway Supabase project; any step that needs a workaround is a doc bug, not a user bug.
