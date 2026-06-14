# Cron Branch (for brain-bank-setup skill)

SKILL.md Reads this file when the operator selects option 1 on the post-Slack cron branch menu. Runs the guided walkthrough for `docs/deploy-from-scratch.md` Step 8 (vault secret mirror, if not already done) + Step 12 (cron wrapper function + 4 schedules).

## Entry point

Reached from SKILL.md cron branch menu, option 1. State on entry:
- Core deploy is complete.
- Slack branch may or may not be done; not required.
- `MCP_ACCESS_KEY` is in `.env` and in Supabase secrets.

## Sub-flow table

| Step | Claude says | Claude runs | Operator does |
|---|---|---|---|
| **Check vault extension** | "First, confirming Supabase vault is available in your project." | Ask operator to run in SQL editor: `select * from pg_extension where extname = 'supabase_vault';`, expect 1 row. If empty: "Supabase vault isn't enabled. Dashboard, Database, Extensions, search `supabase_vault`, Enable, then come back and we'll continue." | Open SQL editor, run query, paste back "1 row" or "empty". |
| **Copy MCP_ACCESS_KEY to clipboard** | "Putting your MCP_ACCESS_KEY on the clipboard for 30 seconds. Paste it into the SQL block I'm about to give you, then clear your clipboard with anything else." | Platform-detected clipboard pattern: `case "$(uname -s)" in Darwin) CB=pbcopy ;; Linux) command -v clip.exe >/dev/null && CB=clip.exe || CB=xclip ;; MINGW*|MSYS*|CYGWIN*) CB=clip ;; esac; grep '^MCP_ACCESS_KEY=' .env | cut -d= -f2 | tr -d '\n' | $CB && echo "on clipboard"` | Paste from clipboard into the SQL block below when prompted. |
| **Vault create_secret** | "First, check whether the vault secret already exists (it would, if you ran deploy-from-scratch.md Step 8 earlier). If it's there, we skip creation." Then: "If the check returned empty, run this create block. First argument is the raw secret (paste from clipboard), second is the name Postgres uses to look it up. Same value as .env." | Pre-check: `select name from vault.secrets where name = 'mcp_access_key';`. If 1 row returned, skip the create_secret block entirely. If 0 rows, emit `select vault.create_secret('<PASTE FROM CLIPBOARD>', 'mcp_access_key', 'MCP / Brain access key, used by pg_cron to call Edge Functions.');` and after operator confirms: `select name, description, created_at from vault.secrets where name = 'mcp_access_key';`, expect 1 row. | Run the pre-check, then (if needed) the create block, pasting from clipboard into the marker. |
| **Cron wrapper function** | "Now the cron wrapper. Paste this into SQL editor. I've already substituted your project ref (`$REF`), so it's ready to run." | Emit the full `create or replace function public.call_edge_function(function_slug text, query_string text default '', http_method text default 'POST') returns bigint language plpgsql security definer set search_path = public, net, vault as $$ ... $$;` block from `docs/deploy-from-scratch.md` Step 12, with `<your-project-ref>` already replaced with `$REF`. Include the `revoke execute on function public.call_edge_function(text, text, text) from public;` line. After operator runs it: `select public.call_edge_function('open-brain-mcp', 'health=1', 'GET');`, expect a bigint returned. | Run wrapper SQL, run test call. |
| **Schedule 4 cron jobs** | "Finally, the four cron schedules. Default is 6 AM ET during EDT (10:00 UTC). Want that, or adjust for your timezone / DST?" | If operator adjusts: offer a quick translation (e.g., "6 AM PT during PDT = `0 13 * * *`"). Emit the 4 `select cron.schedule(...);` blocks from `docs/deploy-from-scratch.md` Step 12 with the chosen UTC offset applied. After operator runs: `select jobid, jobname, schedule, command from cron.job order by jobid;`, expect 4 rows. | Run the 4 `cron.schedule` calls. |
| **Done** | "Scheduled digests live. First fire at [calculated next-fire time based on cron schedule]. If it doesn't land, check `select * from cron.job_run_details order by start_time desc limit 5;`, the `status` and `return_message` columns tell you what went wrong." | | Wait for next fire. |

## Optional: classify-edges-weekly

After the four core cron jobs are scheduled, offer the operator the optional weekly typed reasoning edges classifier (Phase 13). Reference is `docs/deploy-from-scratch.md` Step 12 final subsection. Schedule shape: `'15 10 * * 0'` (Sundays 10:15 UTC), `limit=15`, `max_cost_usd=2.00`. Skip without prompt if the operator declines; this is purely an enrichment surface and the wiki + raw thoughts remain primary retrieval.

## Failure handling

Failures (vault missing, permission denied, extension not enabled, cron fires but fails) forward-link to `references/error-recovery.md` "Cron branch" section.

## Why this matters

**Vault secret + wrapper function pattern:** Future `MCP_ACCESS_KEY` rotations are a single `update vault.secrets set secret = ... where name = 'mcp_access_key';`. The cron job command strings stay frozen; no four-cron-job edits on every rotation. This is the reason the wrapper reads the key from vault at call time rather than embedding it as a literal in each `cron.schedule` command.

**`security definer` on the wrapper function:** The wrapper calls `pg_net.http_post` and reads from `vault.decrypted_secrets`. Both require elevated privileges that the `postgres` role (which pg_cron runs as) wouldn't otherwise have at the call site. `security definer` runs the function body under the definer's permissions, not the caller's. Without it, the vault lookup silently returns nothing and every cron call fails with a 401.

**`revoke execute on function ... from public`:** By default, any Postgres role can call a newly created function. This wrapper reads a vault secret (the `MCP_ACCESS_KEY`) and fires outbound HTTP calls. Leaving it callable by `public` would let any authenticated database user trigger arbitrary Edge Function calls. The revoke closes that. The cron jobs still run because pg_cron executes as `postgres`, which is the definer and retains execute.

**`timeout_milliseconds := 30000` on `net.http_post` and `net.http_get`:** pg_net's default request timeout is 5 seconds. The `brain-digest` synthesis path runs 7 to 25 seconds depending on the LLM round-trip and the number of thoughts being summarized; `compile-pages` can be similar when it has fresh pages to compile. Without the explicit 30-second timeout, pg_net records `Timeout of 5000 ms reached` in `net._http_response.error_msg`, even though the Edge Function continues running and finishes the work successfully (Edge Functions run independently of the pg_net client connection). The cron job appears to have failed when it actually delivered. The 30-second timeout aligns the pg_net client window with the Edge Function's true completion time and makes `net._http_response` a truthful diagnostic.
