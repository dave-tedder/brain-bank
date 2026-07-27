# Key Rotation Consumer Audit

A pre-rotation checklist for any secret that authenticates to Brain Bank. The failure mode this guards against: a key inlined directly into `cron.job.command` looks fine at rotation time (every manual call still works) and then silently 401s on every scheduled fire afterward, because nobody checks a cron job's command string during a routine rotation.

The checklist covers: manual consumers (Apps Scripts, MCP configs, hosting env, ChatGPT GPT headers, cloud-routine env vars), a `pg_cron` `cron.job` scan, a hardcoded-references grep, Edge Function / Supabase secrets / hosting env coverage, and a post-rotation smoke test.

For the structural fix that makes `MCP_ACCESS_KEY` rotation safe by default, see `docs/deploy-from-scratch.md` Step 8 (vault + cron wrapper) and `skills/pg-cron-patterns/SKILL.md`.
