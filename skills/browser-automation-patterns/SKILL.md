---
name: browser-automation-patterns
description: Use when planning or debugging browser automation against Brain Bank integrations (Meta DM scan, Instagram, banking portals, any authenticated site). Specifically when picking between Control Chrome (existing tabs, full session) and an isolated-session browser tool (isolated tabs, no inherited login). Also fires on debugging "sent an attachment" generic text from get_page_content.
type: skill
---

# Browser Automation Patterns

- **Control Chrome vs an isolated-session browser tool for authenticated sites.** An isolated-session tool creates isolated tab groups that do NOT inherit login sessions. For automation needing an authenticated browser (Meta Business Suite, banking portals), use Control Chrome — it operates on existing Chrome tabs with full cookie/session access.
- **Control Chrome text extraction is limited.** `get_page_content` is text-only — cannot distinguish images, videos, or attachment types ("sent an attachment" is all you get). For visual understanding (classifying DM types, reading inbox previews), hybrid: Control Chrome navigates, computer-use screenshots read.
