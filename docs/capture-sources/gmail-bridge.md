# Capture email with the Gmail Bridge

This walkthrough takes you from "Brain Bank is deployed and REST capture works" to "email threads I care about land in Brain Bank automatically on an hourly schedule, with `source = gmail` in the database."

If you have not completed [`deploy-from-scratch.md`](../deploy-from-scratch.md) through Step 10 (the curl smoke test), stop and do that first. This walkthrough assumes your four Edge Functions are running against a healthy Supabase project and REST `/capture` works end-to-end.

Eight steps, about fifteen minutes the first time.

## What you get by connecting Gmail

- **Auto-capture of inbox threads.** Every hour, the script scans the last two hours of inbox mail, filters out marketing and transactional noise, and POSTs the remaining threads to Brain Bank. The filter is tunable (more on that at the end).
- **Manual capture on demand.** Apply a `brain-capture` label to any thread and the next run picks it up, bypassing the blocklist. Handy for threads the auto-filter would otherwise skip.
- **Thread summaries, not raw bodies.** The script collapses each thread into a sender-and-date-prefixed summary with the first 500 characters of each message's plain-text body. Signatures and disclaimers slip in, but the metadata extractor is good at ignoring them.
- **Audit trail in Gmail itself.** Every processed thread ends up with a `brain-processed` or `brain-capture-skipped` label, so you can search Gmail for what was captured or filtered without touching the database.
- **Google Voice integration for free.** Gmail routes every Google Voice text and voicemail transcript to the inbox. A one-time Gmail filter recipe at the end of this walkthrough auto-labels them `brain-capture`, which flows client texts and voicemail into Brain Bank with no per-message effort.

## How it works

The bridge is a Google Apps Script running entirely inside your Google account. It has no server component. An hourly time-driven trigger wakes the `processEmails()` function, which:

1. Searches for inbox threads newer than the search window (default 2 hours) that do not already carry one of the three Brain Bank labels.
2. For each thread, builds a content string and checks the sender against the allowlist, then the subject against the subject allowlist, then the sender against the blocklist, then the subject against the blocked-pattern list. First match wins.
3. Passing threads get POSTed to `POST /capture` on your `open-brain-mcp` Edge Function with `"source": "gmail"` in the body. Success means the thread gets a `brain-processed` label.
4. Filtered threads get a `brain-capture-skipped` label so you can audit the filter.
5. Any thread carrying the manual `brain-capture` label gets sent regardless of the blocklist.

The script stores a `lastSuccessfulRun` timestamp, but only when the run finished with zero capture errors. A run that hits capture errors (stale key, wrong endpoint, network failure) emails you immediately and leaves the timestamp untouched, so the separate (optional) daily health-check trigger also flags the staleness if more than three hours pass without a clean run.

---

## Step 1. Create the three Gmail labels

In Gmail:

1. Click the `+` next to **Labels** in the left sidebar. (If you do not see Labels, click **More** to expand.)
2. Create label: `brain-capture`
3. Create label: `brain-processed`
4. Create label: `brain-capture-skipped`

All three must exist before the first run. The script ensures them programmatically too, but creating them by hand now makes the first run cleaner.

**What success looks like:** all three labels are visible in the Labels section of the sidebar (you may need to click **More** to see them).

**If it fails:**
- Label names with typos: the script matches on exact string. `brain_capture` or `Brain-Capture` will not work. Delete and recreate.

**Why this matters:** label names are hardcoded in the script as `LABEL_CAPTURE`, `LABEL_PROCESSED`, `LABEL_SKIPPED`. Rename them in Gmail and you must rename them in the script constants too.

---

## Step 2. Create a new Apps Script project

Go to [script.google.com](https://script.google.com). Sign in with the Gmail account whose inbox you want Brain Bank reading.

Click **New project**. A new tab opens with a default `Code.gs` file containing a `myFunction()` stub.

At the top of the page, click **Untitled project** and rename the project to **Brain Bank Gmail Bridge** (or anything you like; the name is cosmetic).

**What success looks like:** you land in the Apps Script editor with a file called `Code.gs` and a sidebar showing Editor, Triggers, Executions, and Project Settings.

**If it fails:**
- "Apps Script is not available for your account": you are signed in with a Google Workspace account whose admin has disabled Apps Script. Either ask your admin, or sign into a personal Gmail account for this instead.

---

## Step 3. Paste the script and set the two Script Properties

Open [`integrations/gmail-bridge/script.gs`](../../integrations/gmail-bridge/script.gs) in the Brain Bank repo. Select all and copy.

Back in the Apps Script editor, open `Code.gs`, select all existing code, delete it, and paste the Brain Bank script.

**Set `BRAIN_BANK_URL` and `BRAIN_KEY` as Script Properties (not in the code).** These are your connection secret, so they live in project settings instead of the script body: rotating your key later becomes a one-field update instead of a code edit, and it can never go stale from a forgotten paste. Open **Project Settings** (the gear icon in the left sidebar) → scroll to **Script Properties** → **Add script property** twice:

| Property | Value |
| --- | --- |
| `BRAIN_BANK_URL` | `https://<your-project-ref>.supabase.co/functions/v1/open-brain-mcp/capture` |
| `BRAIN_KEY` | the same value you have in `.env` as `MCP_ACCESS_KEY` |

For `BRAIN_BANK_URL`, replace `<your-project-ref>` with your Supabase project ref (the 20-character lowercase string from `deploy-from-scratch.md` Step 2) and leave the rest of the URL alone; `/functions/v1/open-brain-mcp/capture` is the REST endpoint path.

Click the save icon (or press `Cmd+S` / `Ctrl+S`).

**What success looks like:** Project Settings shows both `BRAIN_BANK_URL` (your real project ref) and `BRAIN_KEY` (a 64-character hex string) under Script Properties. If either is missing, the first run throws `Missing Script Property BRAIN_BANK_URL or BRAIN_KEY` instead of failing silently. The title bar shows "Saved" with no yellow "unsaved changes" dot.

**If it fails:**
- Paste includes weird characters: Apps Script is touchy about smart quotes getting substituted by the clipboard. If the editor shows red underlines on the `var` declarations, delete the two offending lines and retype them manually.

**Why this matters:** these two values gate all traffic. A wrong URL means 404 with no explanation in the Gmail UI. A wrong key means 401, likewise invisible until you check the execution log.

---

## Step 4. Save and authorize OAuth scopes

With the script saved, you need to authorize it to read your Gmail and call outbound URLs. The cleanest way is to run one of the functions once from the editor.

At the top of the editor, use the function dropdown to select `processEmails`. Click **Run**.

Apps Script will prompt **Authorization required**. Click **Review permissions**.

Sign in with the Google account whose inbox you want the script to read. You will see a screen that says **Google hasn't verified this app**. This is normal for personal Apps Scripts; Google only verifies public apps. Click **Advanced**, then **Go to Brain Bank Gmail Bridge (unsafe)**.

Click **Allow** on the permissions request. The script needs four scopes:

- Read, compose, send, and permanently delete your email (`https://mail.google.com/`). The script reads threads and applies labels.
- Send mail as you (for the health-check alert).
- Connect to an external service (to POST to your Supabase Edge Function).
- Allow this application to run when you are not present (for the time-driven trigger).

You can revoke all four at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) if you decommission the bridge later.

**What success looks like:** after **Allow**, you return to the Apps Script editor and the script starts running. The **Execution log** panel at the bottom fills in with lines like `Auto-capture: N new threads`. A few seconds later, you should see a summary line `Done. Captured: X, Skipped: Y, Errors: 0`.

**If it fails:**
- **"Exception: You do not have permission to call UrlFetchApp.fetch"**: the authorization dialog did not complete. Re-run `processEmails` from the editor and click through the full dialog this time.
- **"Missing Script Property BRAIN_BANK_URL or BRAIN_KEY"**: you pasted the script but did not set the two Script Properties (Step 3). Open Project Settings → Script Properties and add both.
- **"Brain Bank returned 401"** in the execution log: your `BRAIN_KEY` Script Property does not match `MCP_ACCESS_KEY` in Supabase. Re-copy the key from `.env`, update the `BRAIN_KEY` Script Property (Project Settings → Script Properties), run again.
- **"Brain Bank returned 404"**: the URL is wrong. Verify the project ref in the `BRAIN_BANK_URL` Script Property and that the path ends with `/functions/v1/open-brain-mcp/capture`.
- **"Exception: Request failed with error: ..."** with a DNS-looking message: your Supabase project ref is malformed (maybe you pasted the dashboard URL instead of just the ref). Re-copy from `deploy-from-scratch.md` Step 2.

**Why this matters:** the authorization dialog only appears the first time. Subsequent runs (including trigger-driven ones) use the token granted here. If you re-authenticate or revoke the scope later, you have to re-run the function manually to re-authorize before the next trigger fires.

---

## Step 5. Manual test run

With authorization done, do a deliberate test on a real email thread so you can see the capture land in the database.

1. In Gmail, find any recent email (the bridge searches the last two hours by default, so pick something from today).
2. Open the thread and apply the `brain-capture` label to it (the label icon in the top toolbar, or the `l` shortcut).
3. Back in Apps Script, click **Run** on `processEmails` again.
4. Watch the execution log. You should see `Manual capture: 1 threads` followed by `Manual captured "<subject line>"`.
5. In Gmail, refresh the thread. The `brain-capture` label is gone and `brain-processed` has replaced it.

Now verify the row landed in the database with the correct `source` tag. In the Supabase SQL editor:

```sql
select id, left(content, 100) as preview, metadata->>'source' as source, created_at
from thoughts
where metadata->>'source' = 'gmail'
order by created_at desc
limit 3;
```

**What success looks like:** the test thread shows up with `source = gmail` and the content starts with `Email thread: <subject>`. Metadata columns (`type`, `topics`, etc.) are populated in the full `metadata` JSON.

**If it fails:**
- **Execution log shows "Captured" but no row appears in the query**: you are looking at a different Supabase project. Verify the project ref in `BRAIN_BANK_URL` matches the project you are querying.
- **Row appears with `source = chatgpt`, not `source = gmail`**: you are running an older version of the script that did not include the source field in the POST body. Re-copy `script.gs` from the repo (the current version passes `"source": "gmail"`).
- **Row appears but `content` is truncated at the first line**: you are looking at the `preview` column, which the `left()` call in the query truncates at 100 chars. The full row is intact; look at the Supabase table view to confirm.

**Why this matters:** this step proves the full pipeline works end-to-end (authorization, URL, key, source tagging, metadata extraction) before you commit to the hourly trigger. If anything is wrong, you want to know now while the script is still in the foreground.

---

## Step 6. Set up the hourly trigger

Now make the script run on its own.

In the Apps Script editor, click the **Triggers** icon in the left sidebar (it looks like an alarm clock). Click **+ Add Trigger** at the bottom right.

Configure:

- **Choose which function to run:** `processEmails`
- **Choose which deployment should run:** `Head`
- **Select event source:** `Time-driven`
- **Select type of time based trigger:** `Hour timer`
- **Select hour interval:** `Every hour`
- **Failure notification settings:** `Notify me immediately` (or daily, your preference)

Click **Save**.

**What success looks like:** the Triggers page lists one trigger for `processEmails`, Head deployment, hourly interval, with today's date in the "Last run" column as soon as the next hour ticks over.

**If it fails:**
- **Trigger saved but never fires**: Apps Script occasionally needs a few minutes for a fresh trigger to register. Wait fifteen minutes, then check the Executions tab (also in the sidebar) for any runs.
- **Trigger fires but every execution fails**: open the Executions tab, click the failing run, read the error. Most common: the authorization has expired and the script cannot hit Gmail without a manual re-auth (Apps Script tokens occasionally expire when Google rotates OAuth state). Fix by re-running `processEmails` manually once, which re-authorizes.

**Why this matters:** the trigger interval is also your recovery window. A two-hour search window with an hourly trigger means any single missed run gets picked up the next hour with no gap. If you change the interval to every four hours, widen the `SEARCH_WINDOW` constant in the script to at least `5h` to keep that overlap.

---

## Step 7. (Optional) Set up the daily health-check trigger

The script tracks `lastSuccessfulRun` in Apps Script Properties, and `processEmails` only writes it when a run finishes with zero capture errors. A separate function, `healthCheck`, first verifies the `BRAIN_BANK_URL` and `BRAIN_KEY` Script Properties are actually set (a misnamed property fails exactly like a missing one), then compares that timestamp to now and emails you if more than three hours have elapsed. This catches silent failures that the trigger's own notification would miss (for example, if Google temporarily suspends Apps Script runs for your account, or if every capture is erroring while the trigger itself runs green).

In the same Triggers page, click **+ Add Trigger** again:

- **Choose which function to run:** `healthCheck`
- **Choose which deployment should run:** `Head`
- **Select event source:** `Time-driven`
- **Select type of time based trigger:** `Day timer`
- **Select time of day:** something in the morning (for example, `8am to 9am`).

Click **Save**.

**What success looks like:** a second trigger for `healthCheck` appears in the list, configured for a daily run.

**If it fails:**
- **Health check emails you every day even when `processEmails` is running fine**: the `processEmails` trigger has not recorded `lastSuccessfulRun` yet. Remember that a run only counts as successful when it has zero capture errors, so check for `Capture Errors` alert emails too. Open the Executions tab and confirm at least one `processEmails` run has completed cleanly in the last three hours, then wait until tomorrow's health check.

**Why this matters:** a silent Apps Script outage is the most common failure mode for this bridge. Google does not pro-actively tell you when your triggers stop firing. The health check is a one-minute setup that catches six months of silent data loss.

---

## Step 8. End-to-end smoke test

Wait for the next hourly trigger (or run `processEmails` manually one more time). Then go to a real email you received earlier today that is neither marketing nor transactional, and check:

1. **Gmail side:** the thread now has a `brain-processed` label (auto-captured) or still has no label (blocklist filtered it, intentionally or not).
2. **Database side:** run the SQL query from Step 5 again and look for the thread's subject in the `content` preview. If it is there, source tagging is working. If it is not there and the Gmail thread has no Brain Bank label at all, the trigger has not fired yet.
3. **Log side:** in Apps Script, click **Executions** in the sidebar and find the most recent `processEmails` run. The log line at the bottom tells you the captured / skipped / error counts for that run.

**What success looks like:** captured counts match your Gmail side observations. Skipped counts reflect the blocklist filtering marketing and transactional mail as expected. Error count is zero.

**If it fails:**
- **Captured counts are zero across multiple runs but your inbox gets fresh mail**: the blocklist is over-filtering. Walk through what is in `brain-capture-skipped` in Gmail and see if there are real senders getting dropped. Fix by adding their domain to `ALLOWED_SENDERS` in the script, save, wait for the next trigger.
- **Error count is nonzero**: open the execution log and look for the individual thread that errored. Most commonly a Supabase transient 5xx or a very long email that exceeds the function's body size limit. Both resolve on the next run. Persistent errors deserve a real look (Executions tab → click run → read stack trace).
- **A thread you care about got `brain-capture-skipped`**: add its sender domain to `ALLOWED_SENDERS` (or, if it was filtered by subject, add a more specific `ALLOWED_SUBJECT_PATTERNS` entry). Save the script. The next trigger will re-evaluate any fresh threads from that sender; already-skipped threads stay skipped.

---

## Tuning the blocklist

The shipped `BLOCKED_SENDERS` and `BLOCKED_SUBJECT_PATTERNS` catch obvious marketing and transactional noise. You will still get some noise through (every marketer has a unique From address) and you will occasionally over-filter (a real person from a domain that matches a blocked pattern).

The tuning loop:

1. Open Gmail and click into the `brain-capture-skipped` label.
2. Scan recent threads. Is there anything there you wish had been captured?
3. If yes, identify what pattern it matched. Most commonly it was `noreply@` from a domain whose notifications are actually worth reading (a vendor security advisory, a shipping update from a small seller, a GitHub repository alert).
4. Add the sender's domain fragment to `ALLOWED_SENDERS` in the script. Domain fragments catch every mailbox on the domain (`noreply@`, `security@`, etc.), which is usually what you want.
5. Save. The next trigger picks up any fresh threads from that sender.

Conversely, if a noisy sender is getting captured that should not be:

1. Open a thread from that sender.
2. Copy the domain fragment (everything after the `@` up to a likely-distinguishing subdomain).
3. Add it to `BLOCKED_SENDERS` in the script.
4. Save. The next trigger excludes new threads from that sender.

The order of evaluation is: `ALLOWED_SENDERS` first, then `ALLOWED_SUBJECT_PATTERNS`, then `BLOCKED_SENDERS`, then `BLOCKED_SUBJECT_PATTERNS`. First match wins. An allowlist entry always beats a blocklist entry for the same mail.

---

## Google Voice auto-capture

If you use Google Voice for work calls and texts, every text and voicemail transcript lands in Gmail from two specific sender addresses. A one-time Gmail filter auto-labels them `brain-capture`, which flows every Google Voice conversation into Brain Bank without any per-message action.

In Gmail, click the gear icon → **See all settings** → **Filters and Blocked Addresses** → **Create a new filter**.

Filter 1 (text messages):

- **From:** `@txt.voice.google.com`
- Click **Create filter**
- Check **Apply the label:** pick `brain-capture`
- Click **Create filter**

Filter 2 (voicemail transcripts):

- **From:** `voice-noreply@google.com`
- Click **Create filter**
- Check **Apply the label:** pick `brain-capture`
- Click **Create filter**

Every Google Voice conversation now gets labeled `brain-capture` on arrival, and the next `processEmails` run picks it up (bypassing the blocklist, since the manual label overrides it).

**What success looks like:** next time you send or receive a Google Voice text, the email notification in Gmail already has the `brain-capture` label on arrival, and within an hour it moves to `brain-processed`. The Brain Bank row for that conversation has `source = gmail` and the Google Voice contact name extracted in `metadata.people`.

---

## What's next

You now have Gmail capturing into Brain Bank on an hourly schedule, with a tunable filter, a manual override label, a health check, and (optionally) Google Voice pouring into the same pipe. Places to go from here:

- **Add more capture sources.** Gmail is one of six dummies guides in `docs/capture-sources/`. Calendar, Apple Notes, voice memos, Notion, and the ChatGPT custom GPT are all independent and can be added incrementally.
- **Decomission later.** If you want to stop the bridge, open Apps Script → Triggers → delete both triggers. The script stays but does nothing. To also stop it from reading your inbox, go to [myaccount.google.com/permissions](https://myaccount.google.com/permissions), find "Brain Bank Gmail Bridge," and click **Remove access**.
- **Rotate `BRAIN_KEY`.** If you ever rotate `MCP_ACCESS_KEY` in Supabase (via `.env` + `supabase secrets set`), update the `BRAIN_KEY` Script Property (Project Settings → Script Properties). No code edit and no save needed; the next trigger reads the new value. Because the key lives in a Script Property rather than the script body, a rotation you forget to mirror surfaces immediately as a 401 in the execution log rather than failing silently.
- **Increase or shrink the search window.** The default `SEARCH_WINDOW = '2h'` overlaps an hourly trigger with a comfortable margin. If you switch to a less frequent trigger (every four hours, nightly), widen the window to match so no threads fall through the gap.

If a step in this walkthrough does not work end-to-end, it is a doc bug, not a user bug. Open an issue on the repo.
