# Connect Brain Bank to Slack

This walkthrough takes you from "Brain Bank is deployed and REST capture works" to "I post a thought in Slack and a reply confirms it was captured, and a morning digest lands in my Slack workspace on schedule."

If you have not completed [`deploy-from-scratch.md`](deploy-from-scratch.md) through Step 10 (the curl smoke test), stop and do that first. This walkthrough assumes four Edge Functions are running against a healthy Supabase project and the REST capture path works end-to-end.

Nine steps, about twenty minutes the first time.

## What you get by connecting Slack

- **Capture from any channel.** Post a message in your capture channel and it becomes a thought in the database, with embedding, metadata, and auto-resolve of matching open action items, usually within two seconds.
- **Morning digest delivery.** The daily and weekly digests get posted to a Slack channel of your choice instead of sitting in the database.
- **Thread-aware follow-ups.** Reply inside a thread and the reply is captured with the parent message's context baked into the embedding, so "let's do that next week" stays meaningfully searchable.
- **In-channel query.** Post in a dedicated query channel (or prefix a message with `search:` or `ask:` in the capture channel) and Brain Bank replies with the top five matching thoughts.
- **In-channel done command.** Prefix a message with `done:` in the capture channel to manually close an action item without auto-resolve.

## Three channels, one app

Brain Bank supports up to four Slack channels, each with a specific job. You can start with one channel (capture) and add the others later. The split exists because these modes have different signal-to-noise profiles and mixing them in one channel is frustrating after the first week.

| Env var | Required? | What the channel does |
|---|---|---|
| `SLACK_CAPTURE_CHANNEL` | Yes | Primary capture. Every top-level message is captured with a confirmation reply. Thread replies capture with parent context. `search:`, `ask:`, and `done:` prefixes are recognized. |
| `SLACK_BRAIN_CHANNEL` | No | Silent capture for longer-form thoughts. Every message is captured with no reply (no confirmation chatter for dump-style notes). |
| `SLACK_QUERY_CHANNEL` | No | Pure query surface. Every message is treated as a search query. Thread replies synthesize a contextual follow-up query from the conversation history. No capture happens here. |
| `SLACK_DIGEST_CHANNEL` | No | Where the morning digest gets posted. Falls back to `SLACK_CAPTURE_CHANNEL` if left blank. |

Minimum viable setup is just the capture channel. Common setups: one channel for everything (capture only), or two channels (capture + a separate digest channel so the digest does not clutter your capture log). The full four-channel layout is worth it once you have a habit going.

---

## Step 1. Create a new Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**. Pick **From scratch**.

- **App name:** anything you like. "Brain Bank" works.
- **Workspace:** the workspace you want to capture into. If you do not already have a workspace you are comfortable using for this, [create a free throwaway workspace](https://slack.com/create) first. A throwaway workspace is a clean choice even if you have a main workspace; it keeps the capture bot out of conversations it has no reason to be in.

Click **Create App**.

**What success looks like:** you land on the app's **Basic Information** page, with tabs down the left side (Basic Information, App Home, OAuth & Permissions, Event Subscriptions, etc.).

**If it fails:**
- Workspace picker is empty: you are not signed into Slack in this browser. Sign in at [slack.com](https://slack.com), reload, try again.

---

## Step 2. Add the OAuth scopes the bot needs

In your app's left sidebar, click **OAuth & Permissions**. Scroll to **Scopes → Bot Token Scopes** and click **Add an OAuth Scope** for each of these:

- `chat:write`. Lets the bot post capture confirmations, query answers, and the morning digest.
- `channels:history`. Lets the bot read thread replies for thread-aware capture and contextual queries.

If any of your Brain Bank channels will be **private** channels (padlock icon in Slack), also add:

- `groups:history`. Same as `channels:history` but for private channels.

You do not need any User Token Scopes. Brain Bank acts entirely as a bot.

**What success looks like:** the Bot Token Scopes list shows `chat:write` and `channels:history` (and `groups:history` if you added it) and no red warnings.

**If it fails:**
- Scope picker refuses to accept a scope: you typed it in the wrong casing. The picker is a dropdown, not a text field; pick from the list.

**Why this matters:** Slack bots only see events in channels they have been invited to AND channels whose history they have scope to read. Miss `channels:history` and the bot gets the top-level message events but cannot read thread history, so contextual thread replies break silently.

---

## Step 3. Install to workspace and grab your two tokens

Still on **OAuth & Permissions**, scroll to the top and click **Install to `<your workspace>`**. Slack will show a consent screen listing the scopes from Step 2. Click **Allow**.

After install, Slack drops you back on the OAuth & Permissions page with a new **Bot User OAuth Token** visible at the top. It starts with `xoxb-`.

Copy the Bot User OAuth Token. This is your `SLACK_BOT_TOKEN`.

Now click **Basic Information** in the left sidebar and scroll to **App Credentials → Signing Secret**. Click **Show** and copy the value.

This is your `SLACK_SIGNING_SECRET`.

**What success looks like:** you have two strings copied to a scratch note, the first starting with `xoxb-` and the second being a 32-character hex string.

**If it fails:**
- No Bot User OAuth Token appears after install: you installed before adding any Bot Token Scopes in Step 2. Go back to Step 2, add the scopes, then click **Reinstall to Workspace** at the top of OAuth & Permissions.

**Why this matters:** the Signing Secret is how Brain Bank knows a webhook call actually came from Slack and is not a forgery. Without it set, anyone who guesses your Edge Function URL could POST fake messages and they would be stored as real captures. On a real deploy, always set it.

---

## Step 4. Create your Brain Bank channels

In your Slack workspace, create the channels you plan to use. At minimum you need the capture channel. Suggested names:

- `#brain-capture` (required, maps to `SLACK_CAPTURE_CHANNEL`)
- `#brain-longform` (optional, maps to `SLACK_BRAIN_CHANNEL`)
- `#brain-ask` (optional, maps to `SLACK_QUERY_CHANNEL`)
- `#brain-digest` (optional, maps to `SLACK_DIGEST_CHANNEL`)

Channel names are cosmetic; Brain Bank routes on the Channel ID, not the name. Rename them later without breaking anything.

**What success looks like:** the channels you want are visible in your Slack sidebar.

**If it fails:**
- "Restricted" or "Workspace admin approval required": you do not have channel creation rights in this workspace. Ask an admin or create the app in a workspace you own.

---

## Step 5. Invite the bot and grab the channel IDs

For each channel you created, invite the bot:

```
/invite @Brain Bank
```

(Or whatever you named the app in Step 1.) A bot that is not a member of a channel cannot read or post in it, no matter the scopes.

Now retrieve the Channel ID for each channel. In Slack:

1. Right-click the channel name in the sidebar (or on mobile, tap the channel name at the top).
2. Click **View channel details**.
3. Scroll to the bottom of the details panel.
4. Copy the **Channel ID**. Format: `C0123456789` (starts with `C`, eleven characters, all uppercase and digits).

Repeat for each channel. Note them with the matching env var in a scratch pad:

```
SLACK_CAPTURE_CHANNEL=C0123456789   # #brain-capture
SLACK_BRAIN_CHANNEL=C0987654321     # #brain-longform (if using)
SLACK_QUERY_CHANNEL=CABCDEF1234     # #brain-ask (if using)
SLACK_DIGEST_CHANNEL=C1234567890    # #brain-digest (if using)
```

**What success looks like:** every channel you plan to use has a Channel ID that starts with `C` and no spaces, and the bot appears as a member of each.

**If it fails:**
- You copied `#brain-capture` instead of `C0123456789`: Slack accepts both formats in the UI but Brain Bank only routes on Channel IDs. Re-do the right-click dance and copy the ID, not the name.
- You see the Channel ID but the bot is not listed in the member list: run `/invite @Brain Bank` in that channel.

**Why this matters:** if you put a channel name in `SLACK_CAPTURE_CHANNEL` instead of a Channel ID, `ingest-thought` compares events against the wrong string and silently ignores every message. You get no errors and no captures.

---

## Step 6. Fill the SLACK_* values in .env

Open `.env` at the repo root and fill in:

```env
SLACK_BOT_TOKEN=xoxb-...                 # from Step 3
SLACK_SIGNING_SECRET=...                 # from Step 3
SLACK_CAPTURE_CHANNEL=C0123456789        # from Step 5
SLACK_BRAIN_CHANNEL=C0987654321          # optional, leave blank if unused
SLACK_QUERY_CHANNEL=CABCDEF1234          # optional, leave blank if unused
SLACK_DIGEST_CHANNEL=C1234567890         # optional, falls back to capture
```

**What success looks like:** every line you filled has the value after `=` and no trailing whitespace or stray quotes.

**If it fails:**
- Values wrapped in quotes: `supabase secrets set` accepts values both with and without quotes, but mixing the two in one file is the most common source of quiet failures. Pick one style and stick with it. Unquoted is simpler.

---

## Step 7. Push the new secrets to Supabase

```bash
supabase secrets set --env-file .env --project-ref <your-project-ref>
```

**What success looks like:** `Finished supabase secrets set.` with no error output. Verify with:

```bash
supabase secrets list --project-ref <your-project-ref>
```

You should now see `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_CAPTURE_CHANNEL`, and any optional channel IDs you set. The `DIGEST` column shows SHA-256 hashes of the values, not the values themselves.

**If it fails:**
- `invalid line` in output: `.env` has a malformed line. Look for stray quotes, missing `=`, or a line that starts with whitespace.
- Secrets are listed but Slack capture still does not work after Step 9: the values did not push. Re-run the set command and watch for any red output.

**Why this matters:** Edge Functions read environment variables at every request, but they read from Supabase's secrets store, not your local `.env`. Any change to `.env` needs a push before it takes effect. No function redeploy is needed; the next Slack webhook call picks up the new values.

---

## Step 8. Turn on Event Subscriptions and point Slack at ingest-thought

This is where Slack learns how to forward messages to Brain Bank.

In your Slack app settings, click **Event Subscriptions** in the left sidebar. Toggle **Enable Events** to on.

A **Request URL** field appears. Paste this URL, with your project ref substituted:

```
https://<your-project-ref>.supabase.co/functions/v1/ingest-thought
```

No `?key=` query parameter. No trailing slash. The `ingest-thought` function authenticates Slack via the Signing Secret from Step 3, not via `MCP_ACCESS_KEY`.

Slack will POST a one-shot verification challenge to the URL within a second and expect a specific JSON response. If everything is wired up, you see a green **Verified** next to the URL. If you see a red error, jump to the failure list below.

Once verified, scroll down to **Subscribe to bot events** and click **Add Bot User Event**:

- `message.channels`. Fires for every message posted in a public channel the bot is a member of.

If any of your Brain Bank channels are **private** channels, also add:

- `message.groups`. Same event for private channels.

You do NOT need to add `app_mention`. Brain Bank's query channel treats every message in `SLACK_QUERY_CHANNEL` as a search query, so an @mention is not required. (Mentions work too; they just do not add anything.)

Click **Save Changes** at the bottom of the page. Slack will prompt you to **reinstall** the app because the bot event subscriptions changed the app's permissions. Click **Reinstall to Workspace** and **Allow**.

**What success looks like:** green **Verified** by the Request URL, `message.channels` listed under Bot Events, and the sidebar no longer shows an orange "reinstall required" dot.

**If it fails:**
- **Request URL returns red "Your URL did not respond with the value of the challenge parameter":** in a second terminal, tail the function logs with `supabase functions logs ingest-thought --project-ref <ref>` while you click **Retry** in Slack. The logs tell you which failure mode this is:
  - `HMAC verification failed` in the logs: your `SLACK_SIGNING_SECRET` in Supabase does not match what Slack is sending. Re-copy the Signing Secret from Basic Information (double-check you are in the right Slack app; it is easy to paste from an older app by accident), update `.env`, re-run Step 7, retry.
  - Any other 500 error: read the logs for the real cause. Common: `profile.json` missing from bundle (redo Step 4 and Step 9 of `deploy-from-scratch.md`), or missing env vars.
  - Nothing in the logs at all: the URL is wrong and the function never saw the request. Double-check the URL ends with `/functions/v1/ingest-thought`, not `/ingest-thought-v2` or `/open-brain-mcp`.
- **Request URL returns red "URL returned HTTP 404":** you pointed Slack at a function name that does not exist. Double-check the URL ends with `/functions/v1/ingest-thought`.
- **Slack does not prompt to reinstall after Save Changes:** your app was already reinstalled recently. Just manually reinstall via **OAuth & Permissions → Reinstall to Workspace** for completeness.

**Why this matters:** the Request URL is what ties Slack to your Brain Bank deploy. Changing the URL (for example, migrating to a new Supabase project) means updating this field and re-verifying. Keep the URL written down alongside the Supabase project ref.

---

## Step 9. Smoke test each channel

### Capture

In `#brain-capture`, post:

```
First Slack capture test. Brain Bank is now listening.
```

**What success looks like:** within five seconds, the bot replies in-thread with something like:

> Captured as *observation* - test, brain-bank

(extracted topics will vary; the exact wording depends on what the metadata model picks out. Additional lines for `People:`, `Action items:`, and `Auto-resolved:` appear if the capture contained any.)

Verify the row landed in the database. In the Supabase SQL editor:

```sql
select id, left(content, 80) as preview, metadata->>'source' as source, created_at
from thoughts
order by created_at desc
limit 3;
```

You should see the test thought with `source = slack`.

### Thread reply (context-aware capture)

In `#brain-capture`, reply inside the thread of the message you just posted:

```
Follow-up: confirming thread context flows in too.
```

**What success looks like:** a second confirmation reply in-thread, with text `(with thread context)` appended. The new row in `thoughts` stores the combined parent + reply text in `content`, and `metadata->>'parent_slack_ts'` points to the parent's timestamp.

### Query prefix

In `#brain-capture`, post:

```
search: listening
```

**What success looks like:** the bot replies in-thread with up to five matching thoughts. The capture test message you posted a moment ago should be near the top.

### Query channel (if configured)

In `#brain-ask`, post:

```
what did I just test
```

**What success looks like:** the bot replies in-thread with matches, treating the message as a query directly (no `search:` prefix needed).

### Silent brain channel (if configured)

In `#brain-longform`, post any message. The bot does NOT reply. Verify the row landed:

```sql
select id, left(content, 80) as preview, metadata->>'source' as source, created_at
from thoughts
order by created_at desc
limit 3;
```

The new row should have `source = brain-channel`.

### Digest delivery

Manually fire the daily digest. Replace the two placeholders:

```bash
curl -X POST "https://<your-project-ref>.supabase.co/functions/v1/brain-digest?mode=daily&key=<your-mcp-access-key>"
```

**What success looks like:** within ten to thirty seconds, the digest posts to `SLACK_DIGEST_CHANNEL` (or `SLACK_CAPTURE_CHANNEL` if you left the digest channel blank). The curl response body is a JSON payload like `{"status":"delivered","mode":"daily","thoughts_count":<N>,"channel":"C0123456789"}`. If the response is `{"status":"skipped","reason":"..."}`, the function ran but found nothing worth digesting today (usually because no captures since yesterday's digest); not an error.

**If any step fails:**
- **Posted in capture channel, no reply and no row in `thoughts`:** the Request URL verification passed (Step 8) but Slack is not actually forwarding messages. Check **Event Subscriptions → Subscribe to bot events** includes `message.channels`. Reinstall the app if you added events after install.
- **Row lands but with `metadata->>'source'` blank or wrong:** the function is receiving webhook calls but is getting stuck. `supabase functions logs ingest-thought --project-ref <ref>` will show the real error (often: `profile.json` missing from bundle, OpenRouter key invalid, or database insert type mismatch).
- **Bot reply says "Failed to capture":** the database write failed. The reply text includes the Supabase error message; most common cause is a wrong service role key (re-check Step 6 of `deploy-from-scratch.md`).
- **Digest curl returns `401 Unauthorized`:** the `key=` value does not match `MCP_ACCESS_KEY`. Re-check the value in `.env` and your curl command.
- **Digest curl succeeds but no post lands in Slack:** `SLACK_DIGEST_CHANNEL` value is wrong, OR the bot has not been invited to that channel. Re-check Step 5.

---

## What's next

You now have a working Slack capture + digest delivery flow. Places to go from here:

- **Schedule the morning digest.** If you followed `deploy-from-scratch.md` Step 12, the daily digest already fires automatically at the schedule you set (default: 6:00 AM ET via pg_cron). Tomorrow morning, check `SLACK_DIGEST_CHANNEL` to confirm the first scheduled fire landed. If it did not, `select * from cron.job_run_details order by start_time desc limit 5;` in the SQL editor shows the last few cron executions and their status.
- **Add more capture sources.** Slack is the primary surface, but Brain Bank also ingests from Gmail, Google Calendar, Apple Notes, voice memos, Notion, and a ChatGPT custom GPT. Per-source dummies guides live in `docs/capture-sources/` (arriving in Phase 4.6 through 4.11).
- **Rotate the Signing Secret.** If you ever need to rotate `SLACK_SIGNING_SECRET` (Slack lets you regenerate it in Basic Information), update `.env` with the new value, run `supabase secrets set --env-file .env --project-ref <ref>`, and the next webhook call uses the new secret. No function redeploy needed.
- **Add a second workspace.** Brain Bank only supports one Slack workspace per deploy (one bot token, one set of channel IDs). If you want to capture from a second workspace, spin up a second Brain Bank deploy against a separate Supabase project. A shared database across two workspaces is not supported in v0.1.0.

If a step in this walkthrough does not work end-to-end, it is a doc bug, not a user bug. Open an issue on the repo.
