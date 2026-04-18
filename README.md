# Brain Bank

A personal semantic memory system. Capture thoughts from anywhere, get them back when you need them, and wake up to a synthesized digest of what mattered yesterday.

## Status

**Private pre-alpha.** Not ready for public deployment. This repo is under active construction. A public release will come when the code is sanitized, documented, and tested by a fresh deploy. Until then: don't try to stand it up, it won't work.

## What it does (eventually)

- **Capture thoughts** from Slack, email, calendar events, voice memos, Apple Notes, or any client that speaks the MCP or REST protocol
- **Semantic search** over everything you've captured, using pgvector and modern embeddings
- **Proactive digests** delivered to Slack every morning: yesterday's narrative, pre-appointment briefings, open action items, client cross-references
- **Wiki compilation** that auto-maintains reference pages for people, topics, and projects mentioned across captures
- **Auto-resolution of action items** when follow-up captures indicate something got done

## Architecture

- Postgres + pgvector on Supabase
- Supabase Edge Functions (Deno) for ingest, MCP server, digest synthesis, and page compilation
- Next.js dashboard (included in `dashboard/`) for browsing, search, chat, and archive
- Scheduled jobs via pg_cron
- Uses OpenRouter for embeddings, metadata extraction, and digest synthesis

## Inspired by

Nate Jones' semantic memory build series. Brain Bank is an independent implementation informed by those ideas, extended with proactive digest delivery, cross-reference briefings, and a wiki compilation layer.

## License

MIT. See [LICENSE](LICENSE).
