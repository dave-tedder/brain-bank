# Error Recovery Index (for brain-bank-setup skill)

SKILL.md Reads this file when a flow step fails and Claude needs to diagnose. This file is **not** a duplicate of `docs/troubleshooting.md`. Troubleshooting is lookup-by-symptom (for operators reading on their own). This file is a skill-side index organized by flow step, mapping failure signals to inline diagnoses, with forward-links into troubleshooting.md when a documented fix applies.

Each entry: (signal) -> (inline diagnosis) -> (link).

## Pre-flight check failures
* `which supabase` empty -> platform-matched install line (macOS: `brew install supabase/tap/supabase`; Linux: curl installer from supabase.com/docs; Windows Git Bash: download from supabase.com/docs/guides/cli).
  Forward: docs/deploy-from-scratch.md "Before you start" > Tools.
* Node < 18 -> "nodejs.org -> install v20 LTS".
* No clipboard tool on Linux -> `sudo apt install xclip` or `sudo dnf install xclip`.

## Step 3: supabase link
* `Invalid access token` -> `supabase logout && supabase login`.
  Forward: docs/deploy-from-scratch.md Step 3 "If it fails" block (CLI auth failures aren't indexed in troubleshooting.md; the first-run walkthrough covers them).
* `project not found` -> re-ask for project ref. Likely cause: operator pasted the URL (`https://xxx.supabase.co`) instead of the bare ref (`xxx`).
  Forward: docs/deploy-from-scratch.md Step 2.
* Password prompt rejects a correct password -> CLI has stale cached state. Retry as a single command: `supabase link --project-ref <ref> --password <password>`.
  Forward: docs/deploy-from-scratch.md Step 3.

## Step 5: .env secret gathering
* Service role key looks like `sb_publishable_...` -> "anon key, not service_role (modern Supabase format is visibly distinguishable: publishable/anon starts `sb_publishable_`, secret/service_role starts `sb_secret_`). Dashboard, Project Settings, API, service_role, Reveal."
  Forward: docs/deploy-from-scratch.md Step 5.
* Any secret shape-check grep returns 0 -> "I don't see the expected shape. Open .env and check that line. Tell me when fixed."

## Step 6: supabase secrets set
* `invalid line` in output -> `grep -n "^[^A-Z#].*=" .env` to find malformed lines without reading contents. Common causes: stray quotes, missing `=`, line starting with whitespace.
  Forward: docs/deploy-from-scratch.md Step 6.
* Secrets listed but later steps fail auth -> the values didn't push. Re-run `supabase secrets set --env-file .env --project-ref $REF` and watch for red output.

## Step 7: supabase db push
* `permission denied to create extension "vector"` -> check `supabase/.temp/project-ref` matches `$REF`. If it doesn't, re-link.
  Forward: docs/deploy-from-scratch.md Step 7.
* `relation "thoughts" already exists` -> "Migrations ran against this project before. Cleanest reset: dashboard, Settings, Delete project, then restart /brain-bank-setup."

## Step 9: function deploy
* `A profile.json file is required` OR `Module not found "...supabase/functions/_shared/profile.json"` -> re-verify `ls supabase/functions/_shared/profile.json` and re-run deploy. **The bundler requires `profile.json` as a sibling of `_shared/profile.ts`, NOT at repo root.** If `ls profile.json` shows it only at repo root, move it: `mv profile.json supabase/functions/_shared/profile.json`. If still fails after the move, `Read` the file for syntax (verify via `python3 -m json.tool`, do NOT echo contents into chat), compare top-level keys against `profile.example.json`.
  Forward: docs/deploy-from-scratch.md Step 9.
* `Deployment failed` with no detail -> Supabase Dashboard → Edge Functions → [function] → **Logs**, read the actual error. (`supabase functions logs` was removed in CLI v2.75.)
* `undefined is not a function` at deploy time -> Supabase CLI too old. `supabase --version`; upgrade via `brew upgrade supabase` (macOS) or the appropriate package manager.

## Step 10: REST smoke test
* `401 Unauthorized` -> diff MCP_ACCESS_KEY via `supabase secrets list --project-ref $REF`. Grep for name presence (value is a SHA256 digest in the output, not the raw key).
  Forward: docs/deploy-from-scratch.md Step 10.
* `500 WORKER_ERROR` or `500 Internal Server Error` -> Supabase Dashboard → Edge Functions → `open-brain-mcp` → **Logs**, scan for the actual error. Common causes in order of likelihood:
  - **Anon key pasted into `SUPABASE_SERVICE_ROLE_KEY` slot.** Supabase has two key formats. **Legacy JWT format:** both anon and service_role start with `eyJ`; the Step 5 shape check cannot distinguish them and a wrong paste only surfaces at runtime as RLS denial. **Modern `sb_*` format (2025+ projects):** publishable/anon starts with `sb_publishable_` and secret/service_role starts with `sb_secret_`, so the shape check catches this swap at paste time (the regex accepts only `eyJ.{100,}` or `sb_secret_.{20,}`). If logs show RLS denial or `permission denied for table thoughts`, the key is wrong. Re-copy the service_role key from Dashboard > Project Settings > API (it sits below the anon/publishable key, explicitly labeled `service_role` / `secret`, click `Reveal`). Update `.env`, re-run `supabase secrets set --env-file .env --project-ref $REF`.
  - OpenRouter API key expired or over spend cap.
  Forward: docs/troubleshooting.md section 6, "500 WORKER_ERROR at runtime after a deploy".
* `522` or connection timeout -> Supabase outage; check [status.supabase.com](https://status.supabase.com).

## Slack Step 8: URL verification
* "Your URL did not respond with the value of the challenge parameter" -> open Supabase Dashboard → Edge Functions → `ingest-thought` → **Logs** in another tab, then click Retry in Slack and refresh the Logs view.
  - `HMAC verification failed` in logs -> `SLACK_SIGNING_SECRET` in Supabase doesn't match what Slack sends. Re-copy from Basic Information, update `.env`, re-run `supabase secrets set`, retry.
  - Any other 500 -> read the log for root cause (often: env vars missing, OpenRouter outage, transient Supabase issue). `profile.json` missing no longer hits here; it's now caught at deploy as a 400 (see Step 9).
  - Nothing in logs at all -> URL is wrong; confirm it ends with `/functions/v1/ingest-thought` exactly.
  Forward: docs/troubleshooting.md section 2, "Slack capture" (covers capture-time verification failures that surface after deploy).
* "URL returned HTTP 404" -> wrong function name in the URL. Confirm `/functions/v1/ingest-thought`.

## Slack Step 9: bot didn't reply
* Row did not land in `thoughts` at all -> Slack is not forwarding messages. Check **Event Subscriptions, Subscribe to bot events** includes `message.channels`. Reinstall the app if events added after install.
* Row landed but `metadata->>'source'` is blank or wrong -> function is receiving webhooks but is stuck. Read logs for real error.
* Bot reply says "Failed to capture" -> database write failed. Reply text usually includes Supabase error; most common is wrong service_role key.

## Cron branch
* `relation "vault.secrets" does not exist` -> vault extension not enabled. Dashboard, Database, Extensions, search `supabase_vault`, Enable.
  Forward: docs/deploy-from-scratch.md Step 8.
* `duplicate key value violates unique constraint` on `vault.create_secret` -> the secret already exists. `delete from vault.secrets where name = 'mcp_access_key';` then re-run.
* Cron fires but fails -> `select status, return_message from cron.job_run_details order by start_time desc limit 5;`. Most likely: vault key mismatch. Also possible: OpenRouter key expired, wrong project ref in the wrapper.
  Forward: docs/deploy-from-scratch.md Step 12.
