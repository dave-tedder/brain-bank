---
name: apps-script-patterns
description: Use when editing any Google Apps Script file (typically under integrations/ — gmail-bridge, calendar-sync), when debugging V8 runtime inconsistencies, when working with Gmail Bridge labels (brain-processed, brain-capture-skipped, brain-capture), when calendar sync misses a guest, or when tuning the Gmail blocklist for marketing senders.
type: skill
---

# Google Apps Script Patterns

## V8 runtime inconsistencies

- V8 runtime is inconsistent. Avoid `for...of` on GmailApp collections, avoid `const`/`let` in loops. Use `var` + `for (var i = 0; i < arr.length; i++)`.
- Don't call `thread.getMessages()` inside helpers and pass thread objects around. Fetch messages once in the main loop, pass primitives.
- Scripts live as standalone files (not embedded in markdown — cloud-synced folders can strip code blocks).
- **Time-driven triggers run against the saved (Head) version**, not deployed versions. Save (Cmd+S) is enough. Deploy is not needed.

## Gmail Bridge labels

**Gmail Bridge labels:** `brain-processed` (captured), `brain-capture-skipped` (filtered), `brain-capture` (manual override). Don't invent a fourth label variant for a "definitely captured" state — these three cover the full lifecycle.

## Calendar sync patterns

- **`guest.getName()` returns empty string** when the guest has no display name in Google Contacts. Capture names AND emails separately. Some events store display names with extra context appended (e.g. a person's name plus a project or topic string). Attendee-to-record matching needs fuzzy fallbacks (email → full name → first+last).
- **Calendar sync filters by ID.** Only the calendars listed in `ALLOWED_CALENDARS` sync; everything else is excluded, including auto-added "Holidays" calendars.
- **Calendar sync window is `SYNC_WINDOW_DAYS`** (default 30). Events rescheduled outside the window leave stale `business_events` rows until the next sync window passes over them again. If you have a separate real-time write path into `business_events` from another app, keep it in sync with what the Apps Script sync considers current.
- **Calendar acceptance/confirmation emails are a rich enrichment source** (phone numbers, deposit amounts, project or topic descriptions, history not captured anywhere else). Searching `from:<contact_email>` for acceptance emails is a fast way to backfill a record when Calendar alone is thin.

## Gmail blocklist tuning

**Gmail blocklist tuning pattern:** search Brain Bank for recent "email thread" captures, identify new marketing domains slipping through, add them to `BLOCKED_SENDERS` in `integrations/gmail-bridge/script.gs` (substring match catches subdomains), save. `shouldSkip()` checks in a fixed order: `ALLOWED_SENDERS` wins first, then `ALLOWED_SUBJECT_PATTERNS` (catches vendor security/deprecation notices you haven't explicitly enumerated), then the `SUPPLY_VENDOR_SENDERS` + `RECEIPT_SUBJECT_PATTERNS` exception (a vendor whose marketing is blocked can still get its receipt-shaped mail through), then `BLOCKED_SENDERS`, then `BLOCKED_SUBJECT_PATTERNS`. If you want a category of transactional mail (payment platforms, financial records, whatever matters to your use case) to always come through regardless of sender, add it to `ALLOWED_SENDERS` rather than leaving it to fall through the blocklist by omission — an omission is fragile against future blocklist additions, an explicit allow is not.
