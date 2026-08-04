---
name: browser-automation-patterns
description: Use when planning or debugging browser automation against Brain Bank integrations (Meta DM scan, Instagram, banking portals, any authenticated site) — picking between a full-session browser tool and an isolated-session one, or debugging `get_page_content` returning generic placeholder text like "sent an attachment" when you need to know what the message actually contains.
type: skill
---

# Browser Automation Patterns

## Full-session vs isolated-session browser tools

Browser automation tools come in two kinds, and the difference decides whether an authenticated page works at all.

- **Full-session** (for example Control Chrome): operates on the existing browser's tabs, with that profile's cookies and logins. Anything behind a login needs this.
- **Isolated-session** (for example a sandboxed agent browser): creates its own tab group that does **not** inherit login state. Navigating to an authenticated page hits a login wall.

For Meta Business Suite, banking portals, or any account-gated surface, use the full-session tool. Reserve the isolated one for public pages, where the cleaner sandbox is an advantage rather than a blocker.

Watch for silent fallback: an agent whose full-session tool fails may quietly retry with the isolated one and report a login wall as though the site were down. If a prompt names a browser tool, it should also name which tools not to fall back to.

## `get_page_content` is text-only

Text extraction returns a text layer. It cannot distinguish images, videos, or attachment types: a DM containing a photo, a reel, a voice note, or a shared post all come back as the same generic `"sent an attachment"` string.

This bites the Meta DM scan directly. Classifying inbox items by message type, or reading an inbox preview to decide which threads matter, cannot be done from the text layer alone.

**Use the hybrid.** The browser tool navigates and extracts what text exists; a screenshot tool reads the rendered page visually. Navigation stays with the live session, and visual classification goes to the tool that can actually see.

Do not try to defeat this with a cleverer selector or a JavaScript extraction. The information is not in the DOM text in a form that names the attachment type; it is in the rendered pixels.
