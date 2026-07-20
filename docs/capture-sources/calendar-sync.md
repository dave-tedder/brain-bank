# Capture calendar events with the Calendar Sync

This walkthrough takes you from "Brain Bank is deployed and REST capture works" to "every morning, the next thirty days of my Google Calendar events are mirrored into Brain Bank automatically, both as structured rows for the digest's pre-appointment briefing AND as a searchable thought summary."

If you have not completed [`deploy-from-scratch.md`](../deploy-from-scratch.md) through Step 10 (the curl smoke test), stop and do that first. This walkthrough assumes your four Edge Functions are running against a healthy Supabase project and REST `/capture` works end-to-end.

Eight steps, about twenty minutes the first time.

## What you get by connecting Google Calendar

- **Pre-appointment briefings in the morning digest.** The digest's daily-mode prompt queries `business_events` for today's events and weaves each one into a "here's what's on your plate and what you've said about the people involved" section.
- **Semantic search over upcoming events.** A single combined thought gets captured each day with `source = gcal`, so searches like "when am I seeing Alex next?" find calendar events alongside chat messages and notes.
- **Safe re-runs.** Events upsert by Google Calendar event ID, so the daily trigger can re-run any number of times without creating duplicates. Reschedules overwrite the old row. Cancellations leave stale rows until you re-sync with a shorter window (edge case, rare).
- **No app, no server.** Runs entirely inside your Google account as an Apps Script. Decommission any time by deleting the trigger.

## Why the dual-write

The sync hits two different Brain Bank endpoints on every run, writing to two different tables:

- **`POST /event`** inserts one row per calendar event into the `business_events` table. These rows are structured (event_type, date_start, date_end, location, attendees, metadata). The morning digest reads them to build its pre-appointment briefing section. Upsert is keyed by `metadata.gcal_event_id`.
- **`POST /capture`** writes one combined thought summarizing the entire window into the `thoughts` table with `"source": "gcal"`. This is what makes events searchable in semantic memory via the MCP tools and the chat UI.

Neither write depends on the other. If `/event` fails for a single event, the rest still go through and the combined thought still gets captured. If `/capture` fails, the structured events still land. You can watch the execution log to see both counts independently.

## How it works

A daily time-driven trigger wakes `captureAndSync()`, which:

1. Scans every calendar in `ALLOWED_CALENDARS` for events in the next thirty days.
2. Skips calendars whose name contains "holidays" (noise for a work brief).
3. Skips events whose description contains `reclaim.ai` (AI scheduler placeholders).
4. For each event, classifies it into one of your `profile.json` event_types and POSTs to `/event` with upsert semantics.
5. Builds a single human-readable summary of all events and POSTs to `/capture` with `source = gcal`.
6. Logs a completion line with the synced-event count and any errors.

---

## Step 1. Find your calendar IDs

The script needs the ID of each calendar you want synced. For most people, that is just their primary Google Calendar (the one created automatically with your Gmail account).

Open [Google Calendar](https://calendar.google.com) in a browser. In the left sidebar under **My calendars**, hover over the calendar you want to sync and click the three-dot menu → **Settings and sharing**.

Scroll down to **Integrate calendar**. The **Calendar ID** field shows the ID as a string:

- For your primary calendar, it will be your Gmail address (for example `alex@example.com`).
- For secondary calendars you created, it will be a long auto-generated ID ending in `@group.calendar.google.com`.

Copy each ID you want synced. If in doubt, start with just the primary calendar; you can add more later.

**What success looks like:** you have one or more calendar ID strings in your clipboard or a scratchpad.

**If it fails:**
- "Integrate calendar" section missing: you are looking at a calendar that someone else shared with you. Their calendar can still be synced, but the ID is under the same place in that calendar's settings (if they gave you access to settings) or accessible via the Calendar API only (out of scope for this walkthrough).
- Calendar ID is the same as your Gmail address but with `.google.com` appended: that is the shared address, not the ID. Use the plain Gmail address instead.

---

## Step 2. Create a new Apps Script project

Go to [script.google.com](https://script.google.com). Sign in with the Google account that owns the calendars you listed in Step 1.

Click **New project**. A new tab opens with a default `Code.gs` file containing a `myFunction()` stub.

At the top of the page, click **Untitled project** and rename the project to **Brain Bank Calendar Sync** (or anything you like; the name is cosmetic).

**What success looks like:** you land in the Apps Script editor with a file called `Code.gs` and a sidebar showing Editor, Triggers, Executions, and Project Settings.

**If it fails:**
- "Apps Script is not available for your account": you are signed in with a Google Workspace account whose admin has disabled Apps Script. Either ask your admin, or sign into a personal Gmail account for this instead.

---

## Step 3. Paste the script, set the two Script Properties, fill the calendar constant

Open [`integrations/calendar-sync/script.gs`](../../integrations/calendar-sync/script.gs) in the Brain Bank repo. Select all and copy.

Back in the Apps Script editor, open `Code.gs`, select all existing code, delete it, and paste the Brain Bank script.

**Set `BRAIN_BANK_BASE` and `BRAIN_KEY` as Script Properties (not in the code).** These are your connection secret, so they live in project settings instead of the script body: rotating your key later becomes a one-field update instead of a code edit, and it can never go stale from a forgotten paste. Open **Project Settings** (the gear icon in the left sidebar) → scroll to **Script Properties** → **Add script property** twice:

| Property | Value |
| --- | --- |
| `BRAIN_BANK_BASE` | `https://<your-project-ref>.supabase.co/functions/v1/open-brain-mcp` |
| `BRAIN_KEY` | the same value you have in `.env` as `MCP_ACCESS_KEY` |

For `BRAIN_BANK_BASE`, replace `<your-project-ref>` with your Supabase project ref (the 20-character lowercase string from `deploy-from-scratch.md` Step 2) and leave the rest of the URL alone. This is the `open-brain-mcp` base (no trailing path); the script appends `/event` and `/capture` at each call site.

Then scroll to the top of the script and fill the one remaining constant:

```javascript
var ALLOWED_CALENDARS = ['your-email@example.com'];
```

- `ALLOWED_CALENDARS`: replace `'your-email@example.com'` with the calendar IDs from Step 1. To sync multiple calendars, list each ID as its own string: `['alex@example.com', 'work-abc123@group.calendar.google.com']`.

Click the save icon (or press `Cmd+S` / `Ctrl+S`).

**What success looks like:** Project Settings shows both `BRAIN_BANK_BASE` (your real project ref) and `BRAIN_KEY` (a 64-character hex string) under Script Properties, and `ALLOWED_CALENDARS` in the code contains at least one real calendar ID. If either property is missing, the first run throws `Missing Script Property BRAIN_BANK_BASE or BRAIN_KEY` instead of failing silently. The title bar shows "Saved" with no yellow "unsaved changes" dot.

**If it fails:**
- Paste includes weird characters: Apps Script is touchy about smart quotes getting substituted by the clipboard. If the editor shows red underlines on the `var` declarations, delete the offending lines and retype them manually.
- `ALLOWED_CALENDARS` is still `['your-email@example.com']`: nothing will sync. The script treats this as the safe-default shipping value. Swap in your real calendar ID before running.

**Why this matters:** the script only reads calendars whose ID appears in `ALLOWED_CALENDARS`. A typo here means zero events sync and the execution log just shows "No events in the next 30 days" with no clear error. Double-check the IDs against what you copied in Step 1.

---

## Step 4. Save and authorize OAuth scopes

With the script saved, you need to authorize it to read your Calendar and call outbound URLs. The cleanest way is to run `captureAndSync` once from the editor.

At the top of the editor, use the function dropdown to select `captureAndSync`. Click **Run**.

Apps Script will prompt **Authorization required**. Click **Review permissions**.

Sign in with the Google account whose calendars you want the script to read. You will see a screen that says **Google hasn't verified this app**. This is normal for personal Apps Scripts; Google only verifies public apps. Click **Advanced**, then **Go to Brain Bank Calendar Sync (unsafe)**.

Click **Allow** on the permissions request. The script needs three scopes:

- Read your Google Calendars (`https://www.google.com/calendar/feeds`). The script reads events and guest lists.
- Connect to an external service (to POST to your Supabase Edge Function).
- Allow this application to run when you are not present (for the time-driven trigger).

You can revoke all three at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) if you decommission the sync later.

**What success looks like:** after **Allow**, you return to the Apps Script editor and the script starts running. The **Execution log** panel at the bottom fills with lines like `Skipping calendar: <name>` for calendars you did NOT include, then eventually a summary line `Calendar sync complete. Events synced to business_events: X, sync errors: 0` and a `Thought capture: {"status":"captured",...}` line.

**If it fails:**
- **"Exception: You do not have permission to call UrlFetchApp.fetch"**: the authorization dialog did not complete. Re-run `captureAndSync` from the editor and click through the full dialog this time.
- **"Missing Script Property BRAIN_BANK_BASE or BRAIN_KEY"**: you pasted the script but did not set the two Script Properties (Step 3). Open Project Settings → Script Properties and add both.
- **"Event sync error ... 401"** in the execution log: your `BRAIN_KEY` Script Property does not match `MCP_ACCESS_KEY` in Supabase. Re-copy the key from `.env`, update the `BRAIN_KEY` Script Property (Project Settings → Script Properties), run again.
- **"Event sync error ... 404"**: the URL is wrong. Verify the project ref in the `BRAIN_BANK_BASE` Script Property and that the path ends with `/functions/v1/open-brain-mcp` (no trailing slash).
- **"No events in the next 30 days"** but you definitely have events: `ALLOWED_CALENDARS` does not include your real calendar ID. Check Step 1 again; the execution log lines starting `Skipping calendar:` tell you the exact IDs the script saw.

**Why this matters:** the authorization dialog only appears the first time. Subsequent runs (including trigger-driven ones) use the token granted here. If you re-authenticate or revoke the scope later, you have to re-run the function manually to re-authorize before the next trigger fires.

---

## Step 5. Verify both tables got written

The manual run from Step 4 should have hit both endpoints. Confirm each landed in the database.

In the Supabase SQL editor, run:

```sql
-- Check the structured events
select id, event_type, title, date_start, location, metadata->>'gcal_event_id' as gcal_id
from business_events
where metadata->>'gcal_event_id' is not null
order by created_at desc
limit 10;
```

```sql
-- Check the combined thought
select id, left(content, 150) as preview, metadata->>'source' as source, created_at
from thoughts
where metadata->>'source' = 'gcal'
order by created_at desc
limit 3;
```

**What success looks like:** the first query returns one row per synced event, each with a populated `event_type` (one of your `profile.json` event_types), a `date_start` in ISO format, and a non-null `gcal_id`. The second query returns the most recent combined thought with `source = gcal` and content starting `[Calendar Sync] Schedule for the next 30 days:`.

**If it fails:**
- **First query returns zero rows**: the `/event` endpoint is rejecting or the script's classifier is throwing. Read the execution log for any `Event sync error` lines, which include the HTTP status and response body.
- **Second query returns zero rows but first query works**: the `/capture` endpoint is rejecting. Look for a `Capture failed:` line in the execution log. Most commonly this is a temporary 5xx from Supabase; re-run `captureAndSync` manually.
- **First query returns rows with `event_type = 'event'` for everything**: the classifier fell through to the default bucket because none of its keywords matched your event titles. This is not a failure; it just means your titles do not use words like "meeting", "call", "travel", or "maintenance". See Step 7 for how to customize.

**Why this matters:** this is the only step that proves the full pipeline works end-to-end. If either endpoint is rejecting, you want to know now while the script is still in the foreground. Once the daily trigger is running, silent failures are harder to notice.

---

## Step 6. Set up the daily trigger

Now make the script run on its own.

In the Apps Script editor, click the **Triggers** icon in the left sidebar (it looks like an alarm clock). Click **+ Add Trigger** at the bottom right.

Configure:

- **Choose which function to run:** `captureAndSync`
- **Choose which deployment should run:** `Head`
- **Select event source:** `Time-driven`
- **Select type of time based trigger:** `Day timer`
- **Select time of day:** pick an hour window that runs BEFORE your morning digest fires. If you have not customized cron timing (see `deploy-from-scratch.md` Step 12), the default daily digest is 6 AM in your local timezone. A trigger set to `3am to 4am` gives the sync a safe two-hour buffer even if Apps Script fires at the end of its window.
- **Failure notification settings:** `Notify me immediately` (or daily, your preference).

Click **Save**.

**What success looks like:** the Triggers page lists one trigger for `captureAndSync`, Head deployment, daily interval, with today's date in the "Last run" column once the next scheduled window passes.

**If it fails:**
- **Trigger saved but never fires**: Apps Script occasionally needs a few minutes for a fresh trigger to register. Wait fifteen minutes, then check the Executions tab (also in the sidebar) for any runs.
- **Trigger fires but every execution fails**: open the Executions tab, click the failing run, read the error. Most common: the authorization has expired and the script cannot hit Calendar without a manual re-auth. Fix by re-running `captureAndSync` manually once, which re-authorizes.

**Why this matters:** the digest reads `business_events` fresh each morning. If the sync does not run before the digest, the brief will reference stale data (yesterday's state of tomorrow's calendar). The 3-4 AM window gives plenty of headroom if Apps Script or your network is slow.

---

## Step 7. (Optional) Customize the event classifier

The shipped `classifyEvent()` maps event titles to the four default event types in `profile.example.json`: `meeting`, `travel`, `maintenance`, `event`. It uses simple keyword matching on lowercased titles; first match wins.

If you changed `event_types` in your own `profile.json` (for example, added `client_session` or `study`), you need to update the classifier to produce those strings. Otherwise the classifier still works, but its output will not use your custom types.

To customize, edit the `classifyEvent` function in the script:

```javascript
function classifyEvent(title, calendarName) {
  var t = (title || '').toLowerCase();

  // Add or replace buckets here. First match wins.
  if (t.indexOf('client') >= 0 || t.indexOf('session') >= 0) {
    return 'client_session';
  }

  if (t.indexOf('meeting') >= 0 || t.indexOf('call') >= 0) {
    return 'meeting';
  }

  // ... keep the rest, or replace entirely ...

  return 'event';
}
```

Save the script. The next trigger (or manual run) will start using the new classifier. Old rows in `business_events` keep their original `event_type`; they get rewritten on the next sync because the upsert updates all fields.

**Important gotcha:** the `client_event_types` array in `profile.json` is what the digest uses to decide which events get the pre-appointment briefing treatment (versus just being listed). If you add a new `event_type` string like `client_session`, also add it to `client_event_types` in `profile.json` if you want that category to show up in the pre-brief. The two arrays do not need to overlap; `event_types` is "all valid types," and `client_event_types` is "types worth briefing on."

---

## Step 8. End-to-end smoke test

Wait for the next daily trigger (or run `captureAndSync` manually one more time). Then verify:

1. **Apps Script side:** open the Executions tab in the Apps Script editor. The most recent `captureAndSync` run shows a green completed status with a log line like `Calendar sync complete. Events synced to business_events: X, sync errors: 0`.
2. **Database side (structured):** run the first SQL query from Step 5 again. Row counts should match (or slightly differ from) what you see in your calendar for the next thirty days. Events you cancelled should be gone once the 30-day window rolls past them; newly added events appear on the next run.
3. **Database side (semantic):** run the second SQL query from Step 5. The latest row should have today's date in `created_at` and the first line should be `[Calendar Sync] Schedule for the next 30 days:`.
4. **Digest side:** the morning after the first trigger fires, your daily digest (if Slack is connected) or the `/digest` dashboard page should include a pre-appointment briefing for any client-facing events on today's date.

**What success looks like:** all four checks pass. The digest's pre-brief section references real calendar context instead of being empty or generic.

**If it fails:**
- **Sync errors nonzero but greater than zero synced**: open a failing run in the Executions tab and read the error. Most commonly a single malformed event title or a very long description. The rest of the sync still landed; the failing events usually get picked up on the next run.
- **Digest still shows no pre-brief even though `business_events` has today's events**: the digest filters by `client_event_types`. If none of today's events classify into a type in that array, they are included in the "events list" section but skipped for pre-briefing. Check `profile.json` and adjust either the classifier or the `client_event_types` array.
- **`ALLOWED_CALENDARS` is ignored and every calendar gets synced**: impossible. Apps Script's `ALLOWED_CALENDARS.indexOf(cal.getId())` returns `-1` for calendars not in the list, and the script skips them. If you think this is happening, check the execution log for `Skipping calendar:` lines, which enumerate every calendar the script saw, so the non-skipped ones are your true sync set.

---

## Tuning the sync window

The shipped `SYNC_WINDOW_DAYS = 30` balances "enough lookahead for multi-week planning" against "not too many events for the digest's pre-brief."

Shorter windows:

- `7`. One week out. Lighter query load, faster sync. Events rescheduled beyond seven days leave stale rows until re-sync catches them.
- `14`. Two weeks. Good default for dense calendars.

Longer windows:

- `60` or `90`. One-to-three months. Useful if you schedule far out. Adds more rows to `business_events`; the digest's pre-brief only looks at today's events regardless, so the extra rows are just searchable context.

To change the window, edit `SYNC_WINDOW_DAYS` at the top of the script and save. The next trigger uses the new value. Stale rows from the old window age out of the next day's sync automatically.

---

## What's next

You now have Google Calendar mirroring into Brain Bank on a daily schedule, with structured events for the digest's pre-brief AND a searchable thought summary. Places to go from here:

- **Add more capture sources.** Calendar is one of six dummies guides in `docs/capture-sources/`. Gmail, Apple Notes, voice memos, Notion, and the ChatGPT custom GPT are all independent and can be added incrementally.
- **Decommission later.** If you want to stop the sync, open Apps Script → Triggers → delete the `captureAndSync` trigger. The script stays but does nothing. To also stop it from reading your calendar, go to [myaccount.google.com/permissions](https://myaccount.google.com/permissions), find "Brain Bank Calendar Sync," and click **Remove access**.
- **Rotate `BRAIN_KEY`.** If you ever rotate `MCP_ACCESS_KEY` in Supabase (via `.env` + `supabase secrets set`), update the `BRAIN_KEY` Script Property (Project Settings → Script Properties). No code edit and no save needed; the next trigger reads the new value. Because the key lives in a Script Property rather than the script body, a rotation you forget to mirror surfaces immediately as a 401 in the execution log rather than failing silently.
- **Add a health-check trigger.** The Gmail Bridge ships with a separate `healthCheck()` function and daily trigger that emails you if the main run has not succeeded in three hours. The Calendar Sync does not include this by default (daily triggers with email-on-failure tend to be noisy enough). Add one if you need it.

If a step in this walkthrough does not work end-to-end, it is a doc bug, not a user bug. Open an issue on the repo.
