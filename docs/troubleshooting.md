# Troubleshooting

This doc is for when something breaks *after* setup. Use [`docs/deploy-from-scratch.md`](deploy-from-scratch.md) if you're still getting your first deploy green; every step there has its own "If it fails" block for setup-time errors.

Troubleshooting here is organized by symptom ("a thought I sent didn't appear," "the 6 AM digest didn't fire," "auto-resolve marked the wrong item done"), not by component. Find your symptom, follow the decision tree.

Six sections:

1. [Read the logs first](#1-read-the-logs-first): the starting move for almost every problem.
2. [Capture isn't working](#2-capture-isnt-working): a thought went in, nothing came out.
3. [Auto-resolve is wrong](#3-auto-resolve-is-wrong): an item got resolved (or didn't) when it shouldn't have.
4. [The digest didn't deliver](#4-the-digest-didnt-deliver): morning Slack post is missing.
5. [Cron jobs aren't firing](#5-cron-jobs-arent-firing): scheduled jobs stopped running.
6. [Deploys stopped working](#6-deploys-stopped-working): Edge Functions were fine yesterday, 500 today.

If you have not completed [`docs/deploy-from-scratch.md`](deploy-from-scratch.md) Steps 1 through 10 at least once successfully, start there. This doc assumes that baseline.

---

## 1. Read the logs first

Before you theorize, read the logs. The Supabase Dashboard is the canonical UI:

```
https://supabase.com/dashboard/project/<your-project-ref>/functions
```

Click the function (`ingest-thought`, `open-brain-mcp`, `brain-digest`, `compile-pages`) → **Logs** tab. The Logs view shows recent invocations with timestamps, status codes, and any `console.log` / `console.error` output the function emitted. Refresh to pull newer entries.

Heads-up: the `supabase functions logs` CLI subcommand was removed in CLI v2.75 and later. Older guides referenced it, current CLI rejects it with `unknown command`, and the CLI does not loudly suggest the Dashboard alternative. If you need a scripted log retrieval path, the Supabase Management API exposes an analytics-logs endpoint, or use the Supabase MCP (`get_logs` with `service: "edge-function"`).

### The URL-encode gotcha

When your access key or a query parameter shows up in a log line, special characters are URL-encoded. The three you will run into:

| Raw | Encoded |
|-----|---------|
| `` ` `` (backtick) | `%60` |
| ` ` (space) | `%20` |
| `"` (quote) | `%22` |

If you generated `MCP_ACCESS_KEY` by hand and accidentally included a backtick or a space, logs will show `key=abc%60def` or `key=abc%20def`. Cron jobs and curl calls will fail with 401 because the key on the server side has the raw character but the caller (after URL-encoding) is sending `%60`. Fix: regenerate the key with `openssl rand -hex 32` (hex output has no special chars) and re-push with `supabase secrets set`.

### What each function logs

- **ingest-thought**: one line per Slack event received, one line per auto-resolve decision, `HMAC verification failed` if Slack's signature doesn't validate.
- **open-brain-mcp**: one line per MCP tool call, REST capture/search/etc. call, auto-resolve decision, `Invalid or missing access key` on auth failure.
- **brain-digest**: `Digest skipped: <reason>`, `Slack post error`, `digest upsert failed (non-fatal)`, `Notion push skipped: ...`.
- **compile-pages**: `Compilation complete: N updated, N created, N errors`, `Compile error for <slug>: <error>`.

### `console.error` vs `console.log`

The Edge Function code uses `console.error` for real failures and `console.log` for informational decisions. If you are filtering for problems, search the log stream for `error:` first.

---

## 2. Capture isn't working

You sent a thought (Slack message, Gmail trigger, curl, ChatGPT, etc.) and it did not appear in the `thoughts` table.

### First: was it actually sent?

Run this SQL in the Supabase dashboard (SQL Editor → New query):

```sql
select id, left(content, 80) as preview, metadata->>'source' as source, created_at
from thoughts
order by created_at desc
limit 10;
```

You are looking for your test thought. If it is there, capture worked and the problem is downstream (auto-resolve, digest, etc.).

If it is not there, capture did not complete. Diagnose by source:

### Slack capture

Symptom: typing in `#brain-capture` produces no bot reply and no new row.

1. **Is the bot in the channel?** Run `/invite @Brain Bank` in the channel. If the bot is already in, Slack will say so. If it is not, the event never reaches your Edge Function.
2. **Is the Event Subscriptions Request URL green?** Slack API → your app → Event Subscriptions → Request URL. If it says "Failed" or is gray, the URL is wrong or the function is 500ing. The URL must point at `ingest-thought` (not `open-brain-mcp`). Full shape: `https://<your-project-ref>.supabase.co/functions/v1/ingest-thought`. Re-save to re-verify.
3. **Is the channel ID in `.env` right?** `SLACK_CAPTURE_CHANNEL` is a channel ID (starts with `C`), not a channel name (does not start with `#`). In Slack, right-click the channel → View channel details → scroll to the bottom → Channel ID. Copy it into `.env` and re-push secrets (`supabase secrets set --env-file .env --project-ref <ref>`).
4. **Is `SLACK_SIGNING_SECRET` right?** If the logs show `HMAC verification failed`, the signing secret in `.env` does not match the one in Slack's app settings. Slack API → your app → Basic Information → App Credentials → Signing Secret. Copy, paste into `.env`, re-push.
5. **Slack's Bot Token was rotated or reinstalled?** The `xoxb-` token in `SLACK_BOT_TOKEN` must match the current install. If you reinstalled the app after changing scopes, grab the new Bot User OAuth Token from Slack → OAuth & Permissions and re-push.

**Why this matters:** the four `SLACK_*` variables have to all agree. A mismatch anywhere (wrong channel ID, stale signing secret, old bot token) produces a silent failure, because the function returns `200 ok` to Slack even when it can't route the message. Only the logs tell you what went wrong.

### Gmail bridge capture

Symptom: emails you forward or label are not appearing as thoughts.

1. **Apps Script trigger is failing.** Google Apps Script → your project → Executions (left sidebar). Recent failed runs show the exception. Most common: OAuth scope expired (fix: run the script manually once to re-authorize), `BRAIN_BANK_URL` wrong (confirm against your Supabase URL), or `BRAIN_BANK_KEY` does not match `MCP_ACCESS_KEY` in Supabase secrets.
2. **Label does not exist.** The script filters by label name. If you changed the label in Gmail or the script's `CAPTURE_LABEL` constant, the script's query returns zero threads. Confirm the label exists in Gmail (Labels → Manage labels) and the name in `script.gs` matches exactly.
3. **Blocklist swallowed it.** `BLOCKED_SENDERS` in the script filters out promotional senders. If your test email matches any pattern (e.g., you forwarded from a domain that matches `*@news.*`), the script skips it without logging. Test with a fresh subject line from a non-blocklisted sender.

See [`docs/capture-sources/gmail-bridge.md`](capture-sources/gmail-bridge.md) for the full setup recipe.

### Calendar sync capture

Symptom: calendar events are not appearing in `business_events` or `thoughts`.

1. **`ALLOWED_CALENDARS` empty or wrong.** Open the Apps Script, verify the constant lists the calendar IDs you actually use. Calendar ID is a long string like `abc123@group.calendar.google.com`, not the calendar's display name.
2. **Sync window excludes the event.** `SYNC_WINDOW_DAYS` defaults to 30. If your event is further out, it will not sync until it falls inside the window.
3. **Both writes failed.** The script calls `/event` (structured `business_events` row) and `/capture` (thought for semantic search). Either failure is logged in Apps Script → Executions. If only `/event` worked and `/capture` did not, the `business_events` row is there but the thought is not; search `business_events` directly.

```sql
select id, title, event_type, date_start, metadata->>'gcal_event_id' as gcal_id
from business_events
order by date_start desc
limit 10;
```

See [`docs/capture-sources/calendar-sync.md`](capture-sources/calendar-sync.md) for the full setup recipe.

### ChatGPT GPT capture

Symptom: your custom GPT says "captured" but nothing lands in `thoughts`, or the GPT returns an error.

1. **Bearer token wrong.** GPT Configure → Actions → Authentication → Bearer Token. The value must match `MCP_ACCESS_KEY`. Re-paste, save.
2. **OpenAPI server URL wrong.** GPT Configure → Actions → (your schema) → `servers[0].url`. Must be `https://<your-project-ref>.supabase.co/functions/v1/open-brain-mcp` with your real project ref substituted in.
3. **GPT hit a different action by mistake.** GPT Configure → Test panel shows the actual API call. If it hit `/search` when you meant `/capture`, the GPT's instructions need clarifying. See [`docs/capture-sources/chatgpt-gpt.md`](capture-sources/chatgpt-gpt.md).

### Apple Notes / voice capture

Symptom: Shortcut runs but no thought appears.

1. **Shortcut reports "Get Contents of URL failed."** Open the Shortcut, run it once manually, watch the output pane. Most common: Bearer token header missing or wrong, `Content-Type` not set to `application/json`, URL typo.
2. **Shortcut reports success but thought is missing.** Check the body: the POST must include `"source": "apple-notes"` (or `"voice"`) AND a non-empty `content` field. An empty content string returns 400.
3. **Safe-double-run semantics.** The Apple Notes shortcut only *moves* a note on `status: "captured"`. If it got `status: "duplicate"`, the note stays in the capture folder for safety. That's expected. Check `thoughts` by `content_hash` (SHA-256): the original thought with that content is already there.

### REST `/capture` direct curl

Symptom: `curl -X POST /capture` returns 401 or does not create a row.

- `{"error":"Invalid or missing access key"}` with 401: the `key=` URL param, `x-brain-key` header, or `Authorization: Bearer <key>` header (all three are accepted) does not match `MCP_ACCESS_KEY`. Confirm with `supabase secrets list --project-ref <ref>` and re-check the caller.
- `{"status":"duplicate","message":"Already in the brain."}` with 200: SHA-256 of the `content` string exactly matches an existing row. This is success, not failure: dedup is working. Slightly change the content to prove the path works.
- `{"status":"captured","id":"..."}` with 200: it worked. Check `thoughts` by that ID.

### MCP capture

Symptom: Claude Desktop or Claude Code `capture_thought` tool silently fails or returns an error.

1. **Claude Desktop: restart required.** If you just added the MCP URL to Settings → Connectors, fully quit and relaunch Claude Desktop. New config isn't read until restart.
2. **Wrong URL shape.** Desktop URL is `https://<your-project-ref>.supabase.co/functions/v1/open-brain-mcp?key=<your-mcp-access-key>`. The `?key=` URL parameter is required for MCP Desktop because the client doesn't send custom headers by default. Heads-up: query-parameter auth gets logged plaintext into Edge Function request logs, so prefer header auth (`x-brain-key: <key>`) for your own curl smoke tests, scheduled jobs, and integration scripts. The `?key=` form is fine for the MCP Desktop URL specifically (it's the only auth path that client supports), but treat the resulting log entries as containing a secret and rotate `MCP_ACCESS_KEY` if you ever share Edge Function log exports.
3. **406 Not Acceptable.** Some MCP clients don't send `Accept: text/event-stream`. The Edge Function injects the header automatically: if you still see 406, your client is very old. Update to a recent `mcp-remote` or Claude build.

---

## 3. Auto-resolve is wrong

"Auto-resolve" is the pipeline that scans your new thought for phrases that close open action items (e.g., you say "shipped the auth fix" and the item "ship auth fix" flips to `status=resolved`).

It runs inside `checkAutoResolve()` in both `ingest-thought/index.ts` and `open-brain-mcp/index.ts`. The function has four layers of guards that progressively narrow candidates:

- **LAYER 0**: mechanical-source block. If the thought starts with a `MECHANICAL_CAPTURE_PREFIXES` string (defaults: `[Calendar Sync]`, `[Notion Sync]`, `[Weekly Review]`, `Email thread:`, etc., plus whatever is in your `profile.json` `mechanical_capture_prefixes`), auto-resolve is skipped entirely. Sync jobs and weekly reviews carry topic overlap that looks like completion but isn't.
- **LAYER 1**: hard scoping. Keep an item as a candidate only if it shares a project, a topic, or a person with the new thought.
- **LAYER 1.5**: restatement guard. If the new thought's own extracted `action_items` overlap heavily with a candidate (Jaccard on token sets), drop it: you're re-capturing work, not finishing it.
- **LAYER 2**: LLM judgment. `gpt-4.1-mini` reads the thought + candidates + per-candidate scoping context and returns a structured JSON list of resolutions plus the quote from the thought that proves each one.
- **LAYER 3**: quote-overlap guard. The LLM's quote must share substantive vocabulary with the candidate description (stemmed Jaccard ≥ threshold). Blocks the classic "rotation of secret X" / "rotated all secrets" umbrella FP.

### False positive (item resolved when it shouldn't have)

Pull the resolved item + the thought that resolved it:

```sql
select ai.id, ai.description, ai.status, ai.resolved_at,
       ai.resolution_thought_id,
       left(t.content, 200) as resolver_preview,
       t.metadata as resolver_metadata
from action_items ai
join thoughts t on t.id = ai.resolution_thought_id
where ai.id = '<item-uuid>';
```

Now tail the logs for the resolving thought's timestamp. Each layer logs why it dropped (or kept) a candidate:

- `checkAutoResolve: blocked mechanical capture (prefix match): ...`: LAYER 0 fired. Would not be a FP source.
- `checkAutoResolve: restatement guard dropped N candidate(s)`: LAYER 1.5 fired. Would not be a FP source.
- `checkAutoResolve: LAYER 3 quote-overlap guard dropped item <id>`: LAYER 3 fired. Would not be a FP source.
- `checkAutoResolve: LAYER 3 blocked item <id>: no quote returned by LLM`: LAYER 3 fired. Would not be a FP source.

A FP means all four guards passed. Most common causes:

- **Mechanical prefix missing.** The resolving thought came from a sync job but did NOT start with a known prefix. Add the prefix to `profile.json` → `mechanical_capture_prefixes`, redeploy `ingest-thought` and `open-brain-mcp`.
- **Readiness verb slipped through.** The LAYER 2 prompt rejects "unblocked," "cleared," "prepped," "queued," etc., as completion signals. If a new verb in that family fired a resolution, add it to rule 5 of the LAYER 2 prompt in BOTH `ingest-thought/index.ts` AND `open-brain-mcp/index.ts`. The LAYER 2 prompt block is byte-identical across both files by design; any change must be mirrored exactly in both or the two capture paths will disagree.
- **Quote overlap threshold too permissive.** The LLM returned a quote that technically shares some vocabulary but semantically doesn't prove completion. Tune `QUOTE_OVERLAP_THRESHOLD` upward (the constant lives in the same helper block as `jaccardTokens` and `stem()`).

**Immediate workaround:** manually reopen the item.

```sql
update action_items
set status = 'open', resolved_at = null, resolution_thought_id = null, resolution_note = null
where id = '<item-uuid>';
```

### False negative (item should have resolved, didn't)

Check the source thought's metadata. Auto-resolve requires AT LEAST ONE of `project`, `topics`, `people` on both the new thought and the candidate's source thought:

```sql
select id, left(content, 80) as preview,
       metadata->>'project' as project,
       metadata->'topics' as topics,
       metadata->'people' as people
from thoughts
where id = '<source-thought-id>';
```

If project, topics, and people are all null or empty, LAYER 1 scoped every candidate away. Same for the resolving thought. The pipeline is designed to prefer false negatives over false positives here: in practice, the fix is to use a `done:` command explicitly:

Type `done: <description>` in `#brain-capture`. It runs a separate, stricter resolver that relies on semantic match instead of scoping.

Alternatively, add explicit scoping to the resolving thought (mention the project name or a shared topic) and recapture.

### Debugging an auto-resolve decision in real time

Open the Edge Function logs in the Supabase Dashboard at Project → Edge Functions → `ingest-thought` → **Logs**. Send your test thought, then refresh the Logs view. You will see:
- `checkAutoResolve: blocked mechanical capture (prefix match): ...` if LAYER 0 fired.
- `checkAutoResolve: restatement guard dropped N candidate(s)` if LAYER 1.5 fired.
- The full LAYER 2 request/response is NOT logged by default (too verbose). If you need it, add a temporary `console.log` around the `fetch(OPENROUTER_BASE/chat/completions)` call, redeploy, reproduce, then revert.
- LAYER 3 drops have full context: candidate ID, overlap score, quoted phrase, candidate description.

---

## 4. The digest didn't deliver

The 6 AM digest is supposed to post to `#brain-digest` every morning. Something went wrong.

### Check the digest run

```sql
select digest_date, digest_type, left(markdown, 120) as preview, metadata, created_at
from digests
order by created_at desc
limit 5;
```

**Row for today exists:** the digest generated but Slack delivery may have failed. Check the function logs for `Slack post error: ...`. Most common cause: `SLACK_DIGEST_CHANNEL` is empty, wrong, or the bot is not in the channel.

**No row for today:** the digest did not run or returned `{"status":"skipped"}`. Check:

- `Digest skipped: Only N thought(s) in the daily window. Need at least 2.`: you did not capture enough on the prior day. Expected behavior.
- Cron did not fire at all. Jump to [Section 5](#5-cron-jobs-arent-firing).
- Function crashed mid-synthesis. Logs will show the actual error. Often OpenRouter returned 429 (rate limited) or 500.

### Manually fire the digest

Useful for both testing and recovering a missed day:

```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/brain-digest?mode=daily&key=<mcp-access-key>"
```

Response shapes:
- `{"status":"delivered","mode":"daily","thoughts_count":N,"channel":"..."}`: digest posted.
- `{"status":"skipped","mode":"daily","reason":"..."}`: not enough thoughts.
- `{"error":"..."}` with 500: something crashed; check logs.

### Business events (pre-brief) not showing up

The daily digest includes a "today's events" pre-brief for events scheduled for today. If the briefing section is empty when you expected it:

1. The calendar sync job did not run (see [`docs/capture-sources/calendar-sync.md`](capture-sources/calendar-sync.md)).
2. The event's `event_type` is not in your `profile.json` → `client_event_types`. The digest filters by this list. Default is `["meeting", "appointment", "call"]`. If your calendar sync script is categorizing events as `travel` or `maintenance`, they will not be pre-briefed.

```sql
select title, event_type, date_start, date_end
from business_events
where date_start::date = current_date
order by date_start;
```

### Compiled pages (wiki) not showing up

The weekly digest pulls wiki health and lint data. If those sections are empty:

1. The `compile-pages` cron did not run or errored. `select status, return_message from cron.job_run_details where jobname like 'compile-pages%' order by start_time desc limit 5;`
2. No pages exist yet. Compile-pages auto-creates pages from entities with ≥ 5 thoughts mentioning them. Check `compiled_pages` row count: if zero, your capture volume just is not there yet.

---

## 5. Cron jobs aren't firing

The four scheduled jobs (`daily-brain-digest`, `weekly-brain-digest`, `compile-pages-daily`, `compile-pages-weekly-lint`) live inside Postgres, not as Edge Function state. Diagnose them inside Postgres.

### Are the jobs registered?

```sql
select jobid, jobname, schedule, command, active
from cron.job
order by jobid;
```

All four should show `active = true`. If a job is missing, redo [`docs/deploy-from-scratch.md`](deploy-from-scratch.md) Step 12.

### Did the jobs run?

```sql
select jobname, status, return_message, start_time, end_time
from cron.job_run_details
order by start_time desc
limit 20;
```

Status should be `succeeded`. If `failed`, the `return_message` column has the reason. Common failures:

- **`vault secret mcp_access_key not found`**: you skipped Step 8 of deploy-from-scratch, or the vault row was deleted. Redo the `vault.create_secret()` call.
- **`404 Not Found`**: the wrapper function has a hardcoded project ref that does not match your project. Check `select prosrc from pg_proc where proname = 'call_edge_function';` and look at the URL template.
- **`401 Unauthorized`**: the key in `vault.secrets` does not match `MCP_ACCESS_KEY` in Supabase secrets. Update the vault row to match: `update vault.secrets set secret = '<new-key>' where name = 'mcp_access_key';`.
- **`timeout`**: the Edge Function took longer than pg_net's default to respond. Usually OpenRouter was slow. Will self-recover next cron cycle.

### The time is wrong (jobs fire at 10 AM instead of 6 AM)

pg_cron uses UTC. The shipped cron schedules are set for UTC, so `0 10 * * *` is 6 AM ET during EDT and 5 AM ET during EST. If you are in a different timezone, the jobs still fire at `0 10 UTC`, which maps to your local time per your offset.

To change the schedule:

```sql
select cron.unschedule('daily-brain-digest');
select cron.schedule('daily-brain-digest', '<your-new-cron-expr>', $$select public.call_edge_function('brain-digest', 'mode=daily', 'POST');$$);
```

Use [crontab.guru](https://crontab.guru) to compute the UTC expression for your local time.

### The jobs fire but do nothing visible

If `cron.job_run_details` shows `succeeded` but no digest is posted, the Edge Function returned `{"status":"skipped"}`. The request succeeded at the HTTP level but the function declined to deliver. Go back to [Section 4](#4-the-digest-didnt-deliver).

---

## 6. Deploys stopped working

Your Edge Functions were working yesterday. Today they are 500ing, or a redeploy is failing.

### `A profile.json file is required` at deploy time

The Supabase CLI bundler could not find `profile.json` at the location the loader imports from. This should not happen on a post-setup deploy unless:

1. You renamed or deleted `profile.json` at the repo root.
2. You changed branches in git and the new branch does not have it (e.g., experimental branch with a different structure).

Fix: confirm `ls profile.json` returns the file, and you are running `supabase functions deploy` from the repo root.

### 500 `WORKER_ERROR` at runtime after a deploy

The function deployed but crashes on first request. Causes ranked by likelihood:

1. **`profile.json` not bundled.** Open the function's Logs in the Supabase Dashboard (Project → Edge Functions → [function] → **Logs**) and look for `Cannot find module` or `NotFound` on a profile path. If the bundler silently shipped without `profile.json`, the fix is in the shipped loader: `profile.ts` uses `import profileDefaults from "./profile.json" with { type: "json" }` so the bundler treats it as a module graph edge. If you modified that import, revert it. Do NOT use `Deno.readTextFileSync`: it works at local `deno run` time but the CLI bundler does not include the JSON file as an asset.
2. **Required secret missing.** A new code path needs an env var you did not set. Run `supabase secrets list --project-ref <ref>` and compare against `.env.example` (11 required vars for base capture + digest).
3. **OpenRouter key hit its monthly spend cap.** Embeddings calls 402. Check your OpenRouter dashboard.

### 401 on every request after deploying from a new branch

You probably deployed from a branch that uses a different auth path. Check the function you deployed actually reads `MCP_ACCESS_KEY` the same way:

```bash
grep -n "MCP_ACCESS_KEY" supabase/functions/open-brain-mcp/index.ts
```

If you added a new key variable and did not push it to Supabase secrets, that's your miss.

### Function version did not update after deploy

```bash
supabase functions list --project-ref <your-project-ref>
```

Each function has a `Version` column. If your latest deploy did not increment it, the deploy actually failed silently. Re-run with a clean `supabase functions deploy <name> --no-verify-jwt --project-ref <ref>` and watch for the "Deployed Function" line. Some terminals clear the scroll buffer on success; if you can't see it, redirect: `... > deploy.log 2>&1`.

### Rolling back a bad deploy

Supabase does not have a one-click rollback. Your options:

1. **Redeploy the prior commit.** `git checkout <prior-sha> -- supabase/functions/<name>/` then `supabase functions deploy <name> --no-verify-jwt --project-ref <ref>`, then `git checkout HEAD -- supabase/functions/<name>/` to restore your working tree.
2. **Redeploy from a tagged good revision.** If you tag known-good deploys (recommended), `git checkout <tag>` in a clean worktree and deploy from there.
3. **Delete the function and redeploy fresh.** Dashboard → Edge Functions → (function) → Settings → Delete. Then `supabase functions deploy`. Note: the URL stays the same; any cron jobs or Slack webhooks keep working once the replacement is up.

**Why this matters:** there is no automatic rollback. Tagging a known-good state before every deploy (e.g., `git tag pre-deploy-$(date +%Y%m%d-%H%M)`) gives you a named point to return to.

---

## When you have tried everything in this doc

Two escape hatches:

- **Reproduce against a throwaway project.** Create a fresh Supabase project, run [`docs/deploy-from-scratch.md`](deploy-from-scratch.md) end to end, then try to reproduce the bug there. If it repros on a clean deploy, the bug is in the code (file an issue). If it does not, the bug is in your environment (stale config, secret mismatch, drifted schema).
- **File an issue.** Include the function name, the first error line from the Supabase Dashboard Logs (Project → Edge Functions → [function] → **Logs**), the response body from the failing call (redact your access key), and a curl command that reproduces. The more complete the repro, the faster the fix.
