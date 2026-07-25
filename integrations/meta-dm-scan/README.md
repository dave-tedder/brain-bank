# Meta DM Scan

Captures unread Instagram and Facebook DMs as Brain Bank thoughts via a scheduled browser-automation agent (e.g. Claude's Cowork) on an always-on machine. Runs once daily, before your morning digest.

## Why browser automation (vs. official APIs)

Meta's Graph API for DMs requires a Business Manager review and only works for verified Pages. For personal or business accounts not on the API, browser automation is the only practical path.

## Architecture

- An always-on machine (a Mac Mini, a spare desktop, anything that stays awake and logged in) runs a scheduled Cowork task
- The agent opens Meta Business Suite, reads unread DM previews, classifies them (text / image / attachment), and posts a summary as a thought via `POST /capture`
- Hybrid pattern: browser-navigation tooling for clicking/scrolling + a screenshot-reading tool for visual classification of attachment types (text extraction alone can't tell a meme video from a reference photo)
- See `skills/browser-automation-patterns/SKILL.md` for the navigation-vs-visual-reading tool split

## Files

- `scan-prompt.md` — the full agent prompt (copy into a scheduled Cowork task)
- `setup.md` — prerequisites, schedule, known risks, and a long-term upgrade path
- `instagram-signals.md` — manual capture approaches for content-performance signals (engagement patterns, post analytics) that the DM scanner doesn't cover

## Schedule

Once daily, positioned after your other overnight capture syncs and before your morning digest — see `docs/operations/daily-pipeline-schedule.md` — so inbound inquiries land in Brain Bank before the digest synthesizes them.
