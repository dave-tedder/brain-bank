# Calendar Sync

Google Apps Script that mirrors Google Calendar events into Brain Bank on a daily schedule. Two endpoints get written on every run:

- `POST /event` upserts each event into the `business_events` table, keyed by Google Calendar event ID. This feeds the morning digest's pre-appointment briefing section.
- `POST /capture` writes one combined thought summarizing the upcoming week with `"source": "gcal"`, so the events are searchable in semantic memory.

The dual-write is intentional. The two tables serve different downstream needs, and either side can fail without breaking the other.

## What it syncs

- Events from calendars listed in the `ALLOWED_CALENDARS` constant
- Title, start/end, location, description (first 300 chars), guest list (names + emails)
- Skips calendars whose name contains "holidays" (these tend to clutter the brief without being actionable)
- Skips events whose description contains `reclaim.ai` (AI-scheduled work blocks, already captured elsewhere)

## Known limitations

- 30-day rolling window. Events rescheduled beyond the window leave stale rows in `business_events` until they fall off the next day's run.
- Multi-day events: the sync stores `date_start` and `date_end` but the digest's appointment-briefing logic treats each event as point-in-time. Long-running events (conventions, vacations) may render awkwardly in the daily brief.
- Apps Script has a six-minute execution cap. If `ALLOWED_CALENDARS` grows large, split into multiple triggers.

## Files

- `script.gs`. Paste into a new Apps Script project at [script.google.com](https://script.google.com).

## Setup

See [`docs/capture-sources/calendar-sync.md`](../../docs/capture-sources/calendar-sync.md) for the full install walkthrough. The short version: copy `script.gs` into a new Apps Script project, replace three constants at the top (`BRAIN_BANK_BASE`, `BRAIN_KEY`, `ALLOWED_CALENDARS`), save, authorize, set up a daily trigger.
