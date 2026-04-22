# Gmail Bridge

Google Apps Script that captures Gmail threads into Brain Bank. Runs on a time-driven trigger, typically hourly.

## What it does

- Scans the inbox for threads newer than the trigger window and not yet processed.
- Builds a compact thread summary (subject, sender, date, truncated body per message).
- POSTs to Brain Bank's REST `/capture` endpoint with `"source": "gmail"` so captures tag correctly in the database.
- Labels threads `brain-processed` (captured) or `brain-capture-skipped` (filtered out).
- Honors a manual `brain-capture` label that overrides the blocklist, for threads you want captured no matter what.

## What it skips

- Threads from blocklisted senders (marketing, transactional notifications, noreply addresses). Blocklist in `BLOCKED_SENDERS`.
- Threads whose subject matches a blocked pattern (password resets, billing, shipping notifications, promos). In `BLOCKED_SUBJECT_PATTERNS`.
- Allowlisted senders (AI vendors, infrastructure, dev tools, business-critical SaaS) always pass through even if they match a blocked pattern.

The blocklist is opinionated but conservative. See the script comments for tuning tips.

## Files

- `script.gs`. The Apps Script to paste into a new project at [script.google.com](https://script.google.com).

## Labels

- `brain-capture`. Apply manually to any thread to force capture regardless of blocklist.
- `brain-processed`. Applied after successful capture.
- `brain-capture-skipped`. Applied to threads the blocklist filtered out, so you can audit what was skipped.

## Setup

See [`docs/capture-sources/gmail-bridge.md`](../../docs/capture-sources/gmail-bridge.md) for the full install walkthrough. The short version: copy `script.gs` into a new Apps Script project, replace the two constants at the top with your Brain Bank URL and access key, save, authorize, set up an hourly trigger.
