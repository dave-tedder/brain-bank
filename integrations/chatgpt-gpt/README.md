# ChatGPT Custom GPT

Connect Brain Bank to a ChatGPT Custom GPT using GPT Actions and the REST API. Lets you search, browse, and capture thoughts from any ChatGPT conversation.

## What it does

- **Search.** Ask the GPT about any topic, person, or past decision. It calls `searchThoughts` and summarizes results conversationally.
- **Browse.** List recent thoughts with filters (type, topic, person, days).
- **Capture.** Tell the GPT "remember that...", and it POSTs to Brain Bank. Captures land in the database with `source = chatgpt` (the default when no `source` is passed in the body).
- **Stats.** Pull top topics, top people mentioned, and the type breakdown on demand.

No server-side component. The Custom GPT calls Brain Bank's REST endpoints directly over HTTPS with bearer-token auth.

## Files

- `openapi.json`. The OpenAPI 3.1 schema to paste into the GPT's Actions configuration. One placeholder (`<your-supabase-project-ref>`) to replace with your real Supabase project ref.
- `gpt-instructions.md`. A neutral Instructions block you can paste into the GPT's Configure tab. Customize with your own persona and writing preferences.

## Setup

See [`docs/capture-sources/chatgpt-gpt.md`](../../docs/capture-sources/chatgpt-gpt.md) for the full walkthrough. The short version: create a Custom GPT, paste `openapi.json` into Actions, set auth to Bearer with your `MCP_ACCESS_KEY`, paste a customized `gpt-instructions.md` into Instructions, save.

## Requires ChatGPT Plus

Custom GPTs (and GPT Actions) are a ChatGPT Plus feature. The free tier cannot create or use Custom GPTs. If you are on the free tier, either upgrade or look at the other REST-based capture paths (voice, Apple Notes) that work without ChatGPT.
