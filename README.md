# Brain Bank

Personal semantic memory for knowledge workers. Capture thoughts from anywhere, search them back when you need them, and wake up to a synthesized digest of what mattered yesterday delivered to Slack every morning.

## What it does

Every thought that passes through your day (a Slack note to yourself, an email you flagged, a calendar event, a voice memo, a note you pasted into an MCP client) gets an embedding, a set of extracted metadata, and a permanent home in Postgres. From there:

- **Semantic search** over everything you've captured, via an MCP server or REST API.
- **Proactive morning digests** delivered to Slack with yesterday's narrative, today's meeting briefings, open action items, and client cross-references.
- **Auto-compiled wiki pages** for people, topics, and projects that come up often, regenerated as the underlying captures change.
- **Action-item tracking with auto-resolution** that recognizes when a follow-up thought indicates something got done and closes the loop without manual bookkeeping.

Brain Bank is an engine. You bring the captures (Slack, Gmail, calendar, voice, Apple Notes, Notion, a ChatGPT custom GPT, or anything that speaks MCP or a plain REST POST). It handles the rest.

## Architecture

At a glance:

- **Postgres + pgvector** on Supabase for storage and HNSW vector indexing
- **Supabase Edge Functions** (Deno) for four worker services: `ingest-thought` (capture router), `open-brain-mcp` (MCP server + REST API), `brain-digest` (morning synthesis), `compile-pages` (wiki builder)
- **pg_cron + pg_net** for scheduled work (daily and weekly digests, nightly page compilation)
- **OpenRouter** for model access (OpenAI embeddings, GPT-4o-mini for metadata extraction, Claude Sonnet for digest prose)
- **Next.js dashboard** (in `dashboard/`) for browsing, chat, and a running archive of past digests
- **Slack** as the primary capture surface and delivery channel for the digest

Everything on the backend is stateless. Secrets live in Supabase's vault, so key rotation is a one-row update.

## Personal customization via profile.json

Every part of the engine that references your specific vocabulary (what you call your clients, what kinds of content you produce, which calendar events count as "business") reads from a gitignored `profile.json`. The repo ships `profile.example.json` with neutral defaults. Copy, edit the fields to match your work, save. That's it.

This is why a tattoo studio and a software consultancy can share the same engine without either one leaking through the other's digest prose. See [`profile.example.json`](profile.example.json) for the schema.

## Prerequisites

Needed:

- A [Supabase](https://supabase.com) account (free tier works for a personal instance)
- An [OpenRouter](https://openrouter.ai) account (set a monthly spend cap; typical usage runs $5-$15/month)
- Node 18+ and the [Supabase CLI](https://supabase.com/docs/guides/cli)
- Git

Needed for the Slack capture and digest delivery flow (the main way to use it):

- A [Slack workspace](https://slack.com) where you can create an app

No local Docker, no Postgres install, nothing else.

## Quickstart

The short path to a working backend:

1. Clone the repo and link it to a fresh Supabase project.
2. Copy `profile.example.json` to `profile.json` and `.env.example` to `.env`. Edit both.
3. Run the migrations against your Supabase project.
4. Deploy the four Edge Functions.
5. Configure the Slack app and point it at your function URLs.

```bash
git clone https://github.com/dave-tedder/brain-bank.git
cd brain-bank
cp profile.example.json profile.json
cp .env.example .env
# Edit both files with your values

supabase login
supabase link --project-ref <your-project-ref>
supabase db push
supabase functions deploy ingest-thought open-brain-mcp brain-digest compile-pages
```

The full end-to-end setup (Slack app, cron jobs, dashboard, capture integrations) is covered in [`docs/deploy-from-scratch.md`](docs/deploy-from-scratch.md) and takes about thirty minutes start to finish.

If `supabase functions deploy` fails with "Project not found," check that `supabase link` finished successfully. If an Edge Function returns 500, `supabase functions logs <name>` will surface the real error.

## Project Structure

```
brain-bank/
├── supabase/
│   ├── migrations/       # 11 SQL migrations, applied in order
│   └── functions/        # 4 Edge Functions (Deno)
│       ├── ingest-thought/
│       ├── open-brain-mcp/
│       ├── brain-digest/
│       └── compile-pages/
├── dashboard/            # Next.js app (merged via git subtree)
├── docs/                 # deploy walkthrough, Slack setup, per-source guides
├── profile.example.json  # copy to profile.json and edit
├── profile.json          # personal overrides (gitignored)
├── .env.example          # every env var required by the deploy
└── CHANGELOG.md
```

## Status

**Pre-release.** The engine is deployed and running in a live personal instance. The public deploy walkthrough ([`docs/deploy-from-scratch.md`](docs/deploy-from-scratch.md)) is being polished against a fresh Supabase project. Until that verification is complete, expect to hit bumps when following the quickstart above. Once the walkthrough runs cleanly end-to-end, this repo flips public and gets a `v0.1.0` tag.

## Inspired by

Nate Jones' semantic memory build series was the starting point and remains the clearest introduction to the underlying design. Brain Bank is an independent implementation of those ideas, extended with proactive digest delivery, cross-reference briefings, a wiki compilation layer, and auto-resolution of action items.

## License

MIT. See [LICENSE](LICENSE).
