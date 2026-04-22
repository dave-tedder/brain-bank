# Notion Sync

A Claude Code routine (a scheduled agent hosted by Anthropic) that reads rows from one or more Notion databases and POSTs each row to Brain Bank's REST `/capture` endpoint on a daily schedule. Runs entirely in the cloud, no local machine or server involved.

## What it does

- Fires on a schedule you set at [claude.ai/code/routines](https://claude.ai/code/routines) (daily at 4:00 AM is a good default; early enough to feed a 6:00 AM morning digest).
- Queries each configured Notion database over the Notion REST API, using an integration token you create inside Notion.
- Formats each row as a plain-English summary thought and POSTs to Brain Bank's REST `/capture` endpoint with `"source": "notion-sync"` so captures tag correctly in the database.
- Skips duplicates automatically. Brain Bank's SHA-256 dedup rejects any content hash that already exists, so re-running the routine is safe and unchanged rows cost nothing.
- Posts a one-line summary thought at the end of each run ("N rows synced from Projects DB") so you can audit the last run from the dashboard or a Slack search.
- Optional CRM extension: for Notion databases that look like contact intake forms, the walkthrough shows how to chain a `/client` POST per row so new contacts land in the Brain Bank `clients` table at the same time.

## Why no script file ships here

The routine runs on Anthropic's infrastructure, not on your machine. It does not live in a file you can commit. The source of truth is the prompt you paste into [claude.ai/code/routines](https://claude.ai/code/routines) when you create the routine. Once saved, the routine fires on the schedule you set, and you can edit, pause, or delete it through the same UI.

This is different from the Apps Script integrations (Gmail Bridge and Calendar Sync) which ship with a `script.gs` you paste into Google's editor. Claude Code routines have no equivalent export, so the walkthrough provides a ready-to-paste prompt template instead.

## Files

- This README.

The routine prompt is constructed inside the claude.ai/code/routines UI per the dummies guide.

## Setup

See [`docs/capture-sources/notion-sync.md`](../../docs/capture-sources/notion-sync.md) for the full walkthrough. The short version: create a Notion internal integration and get its token, share each database you want synced with that integration, grab each database ID, open claude.ai/code/routines and create a new routine, paste the prompt template from the guide, fill in three secrets and your database IDs, save, run once manually to test, check the thoughts table.

## Good use cases

- **Active projects database.** Pull rows where Status is "In Progress" or "Active" so queries like "what am I working on this month?" hit semantic memory alongside chat and calendar context.
- **Reading or watch list.** A Notion DB of books, papers, or videos you're working through. Each row gets captured once, and Brain Bank can answer "what did I plan to read last month?"
- **Meeting notes database.** Rows with date, attendees, and decisions get captured as thoughts and cross-reference with calendar events already in Brain Bank.
- **Contact intake or CRM.** If you run a client-intake form that writes rows into Notion, the walkthrough's Advanced section shows how to chain `/client` calls so new contacts land in the Brain Bank `clients` table automatically.

## Known limitations

- Notion API rate-limits at about three requests per second per integration. Large databases fit inside a daily run, but the walkthrough shows how to scope the filter to recent or active rows only for very large collections.
- Routines are a Claude Code feature that requires a paid Claude plan. Check [claude.ai/code/routines](https://claude.ai/code/routines) for current availability in your region.
- Notion database schemas vary widely. The prompt template in the walkthrough uses generic properties (title, status, created time). For richer captures you will edit the prompt to include your own field names.
