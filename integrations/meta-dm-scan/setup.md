# Meta DM Scanner — Cowork Automation

## Schedule

Once daily, on a schedule that runs it between your other overnight capture syncs and your morning digest — see `docs/operations/daily-pipeline-schedule.md`. Positioning it before the digest means any inbound inquiries get captured to Brain Bank before the morning digest synthesizes them.

## What It Does

Summarizes all Meta Business Suite inbox activity (Instagram + Facebook DMs) from the past 24 hours, including the Instagram Message Requests tab. Categorizes everything: actual conversations, story mentions, shared posts/reels, solicitations, missed calls. Posts a full summary to Slack and captures it to Brain Bank. This gives you a complete picture of DM activity without trying to guess what's important. Does NOT create client stubs or intake records — treat this as inbox visibility, not your system of record for contacts.

## How It Works

Hybrid approach using two tools:
- **Browser-navigation tooling** (e.g. Control Chrome) handles navigation: opening URLs, clicking inbox filter tabs, scrolling, closing tabs. Operates within the automation machine's already-logged-in Chrome session.
- **Screenshot-reading tooling** (e.g. computer-use) handles reading: takes screenshots so the model can visually analyze the inbox, including message previews, attachment thumbnails, video/image indicators, and UI elements that text extraction misses.

This combination gives visual understanding (can distinguish a meme video from a reference photo, read UI tabs, see attachment types) while keeping all interaction through the authenticated Chrome session.

Flow: Cowork > navigation tool (navigate) + screenshot tool (read) > Meta Business Suite inbox + Requests tab > classify > Slack report + Brain Bank summary thought

The scan opens individual conversations to read full message content (not just preview text). This may mark messages as read in Meta, which is acceptable. No replies, reactions, or sends.

## Prerequisites

Before the first run, confirm these on the automation machine:

1. Chrome running and logged into Meta Business Suite at business.facebook.com. Visit business.facebook.com/latest/inbox at least once to confirm the unified inbox loads with both Instagram and Facebook messages.
2. Control Chrome MCP extension (or equivalent) installed and active in Chrome.
3. Computer-use MCP available (built into Claude Desktop, no extension needed).
4. Sleep prevention on the automation machine so it stays reachable overnight (macOS: System Settings > Energy > Prevent automatic sleeping when display is off).
5. Chrome set to launch on login (macOS: System Settings > General > Login Items > add Google Chrome).
6. Claude Desktop running with Cowork enabled, and these tools active: browser-navigation, screenshot-reading, Slack, Brain Bank.

## The Cowork Prompt

Copy and paste `scan-prompt.md` (in this directory) into a new scheduled Cowork task on your automation machine. Set the schedule to run once daily, per `docs/operations/daily-pipeline-schedule.md`.

## Known Risks

**Meta bot detection.** Meta flags automated browser behavior. Mitigated by: read-only operation, 2-3 second waits between actions, under 10 minutes total, real Chrome with real cookies. One scan per day is low frequency. If Meta ever challenges or locks the account, stop the automation immediately and re-authenticate manually.

**Login session expiry.** Meta Business Suite sessions persist for weeks but eventually expire. The prompt detects login walls via screenshot and sends a Slack alert asking you to re-authenticate. It does not attempt to log in.

**UI changes.** Meta redesigns Business Suite periodically. The prompt uses visual screenshot analysis (semantic reasoning about what's on screen) rather than pixel coordinates, CSS selectors, or text extraction, which is more resilient to UI changes than a text-only approach. If the UI becomes unrecognizable, the prompt reports what it saw and stops.

**Message Requests tab.** The Instagram Requests tab location may vary across Business Suite updates. The prompt looks for it visually and reports if it can't find it rather than guessing.

## Long-Term Upgrade: Meta Graph API

Browser automation works but is inherently fragile. The better long-term path is the Instagram Messaging API + Pages Conversations API. This would give structured JSON access with webhook support (real-time notifications instead of daily polling). Requires a Meta App with app review for the `instagram_manage_messages` permission. Could run as a Supabase Edge Function (same architecture as the Gmail bridge), removing the always-on-machine dependency entirely. Worth evaluating once the browser approach proves the value and DM volume justifies the setup cost.
