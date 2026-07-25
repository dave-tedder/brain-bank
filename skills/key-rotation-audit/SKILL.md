---
name: key-rotation-audit
description: Use when rotating any secret that authenticates to Brain Bank — MCP_ACCESS_KEY / BRAIN_KEY, Supabase service_role, Notion integration token, Anthropic API key, OpenRouter API key, or Slack signing secret. Also fires on questions like "what consumers depend on this key" or "is it safe to rotate X".
type: skill
---

# Key Rotation Consumer Audit (READ BEFORE ROTATING ANY SECRET)

Rotating any secret that authenticates to Brain Bank (`MCP_ACCESS_KEY` / `BRAIN_KEY`, Supabase `service_role`, Notion integration token, Anthropic/OpenRouter API key, Slack signing secret) must cover **both manual AND scheduled/automated consumers**. The classic miss is pg_cron: a key inlined directly into `cron.job.command` looks fine at rotation time (every manual, human-driven call works) and then silently 401s on every scheduled fire afterward, because nobody looks at a cron job's command string during a rotation. `docs/deploy-from-scratch.md` Step 8 already routes `MCP_ACCESS_KEY` through Supabase's vault + a cron wrapper function specifically so a rotation is a one-row `vault.secrets` update, not N cron-job edits — but that only protects you if you actually update the vault row, and it does nothing for every OTHER consumer below.

**Pre-rotation checklist:**

1. **Manual consumers.** Work the list below; do not rotate from memory. Every entry is a place the old value lives, so every entry is a place the rotation can silently fail. Not every deployment has every row — skip what you never set up, but check the ones you did.

   | Consumer | Where the value lives | Who updates it |
   |---|---|---|
   | Supabase Edge Function secret | project secret `MCP_ACCESS_KEY` (`supabase secrets set`) | you, via CLI |
   | pg_cron | vault secret `mcp_access_key` (one `update vault.secrets`; the wrapper function means no cron job edits) | you, via SQL |
   | Claude Code MCP | wherever you registered Brain Bank as an MCP server for Claude Code (commonly `~/.claude.json` → `mcpServers.<your-server-name>`, headers or env) | you |
   | Codex MCP | `~/.codex/config.toml` mirror, if you also run this board from Codex | you |
   | Cloud routines | env vars `BRAIN_BANK_MCP_URL` / `BRAIN_BANK_MCP_KEY` on the cloud environment your routines run under (env vars live on the environment, not per-routine) | you, via the routine platform's UI |
   | Cloud routine connectors | if any routine has an attached connector whose URL embeds the key, that's a second place the raw value lives — a rotation kills the old value regardless, but the connector URL should be updated (or de-keyed) too | you, via the routine platform's UI |
   | **calendar-sync Apps Script** | script property `BRAIN_KEY` via `PropertiesService.getScriptProperties()` | you, via the Apps Script editor's Project Settings |
   | **gmail-bridge Apps Script** | script property `BRAIN_KEY` via `PropertiesService.getScriptProperties()` | you, via the Apps Script editor's Project Settings |
   | Dashboard | Railway (or your host's) env `BRAIN_BANK_API_KEY` | you, via your host's dashboard |
   | ChatGPT GPT action, if you built one | Bearer auth token in the GPT-builder Actions UI | you, via the GPT builder — if the GPT is unused, consider deleting the action instead of re-keying it; a live credential on an idle consumer is pure blast radius with no capability |
   | Claude Desktop config | `~/Library/Application Support/Claude/claude_desktop_config.json` | check whether you actually configured a Brain Bank server entry here — most setups don't |
   | Local `.env` files | project `.env` / `.env.local` | check which key each local `.env` actually holds before assuming it's the one you're rotating |

2. **`cron.job` scan.** `SELECT jobid, jobname, command FROM cron.job ORDER BY jobid;` — any occurrence of the retired key in `command` means the wrapper isn't being used for that job, or someone bypassed it. With the vault+wrapper pattern in place this should be zero hits for `MCP_ACCESS_KEY`.
3. **Hardcoded references.** `git grep '<retired-key-prefix>'` against this repo, any personal rules/config files you keep outside the repo, and any sibling automation repos you run alongside Brain Bank.
4. **Documentation should use placeholders, not raw key values.** If any operator notes, rules files, or plan docs ever captured a raw key value, redact to a placeholder at rotation time rather than updating them to the new raw value. **Rule:** docs get URL shapes with `?key=YOUR_BRAIN_KEY`-style placeholders plus a pointer to where the live value actually lives. One source of truth per consumer, not N — a raw value copied into a doc only expands the blast radius (wherever that doc syncs to) without adding any capability.
5. **Edge Function env / Supabase secrets / hosting platform env.** Confirm the new value is live everywhere before retiring the old. A dual-key window (both old and new values valid briefly) avoids a hard cutover if you can arrange it.
6. **Post-rotation smoke test — one per consumer you actually run. The rotation is NOT done until every box below is checked.**

   A rotation is not "finished" when the new key is set; it is finished when every consumer has been *observed* using it. One end-to-end path is not enough — a green MCP round-trip says nothing about whether an Apps Script still holds the retired value.

   - [ ] **calendar-sync Apps Script, if configured.** Run the script and confirm it reads `BRAIN_KEY` from `PropertiesService` and makes a successful authenticated call: expect events synced with `errors: 0`. A 401 here means the script property was never updated.
   - [ ] **gmail-bridge Apps Script, if configured.** Same: run it, confirm an authenticated call succeeds, no 401.
   - [ ] One MCP round-trip from Claude Code (proves your local MCP config).
   - [ ] One cloud-routine manual fire, if you run any (proves the cloud environment's env vars).
   - [ ] One pg_cron path (manual trigger or wait for the next scheduled fire), checking `net._http_response` + Edge Function logs for 200 vs 401.
   - [ ] Probe the OLD key directly and confirm it now returns 401.

   **Why the Apps Scripts are non-negotiable if you run them.** Neither script is loud when it fails: they run on their own schedule, and a 401 just means no data arrives. A script that silently 401s can go unnoticed for a long time, because nothing errors where a human is looking — the failure mode is a `business_events` table that quietly stops growing, not an alert. Both scripts read `BRAIN_KEY` from a Script Property (Project Settings → Script Properties), so a rotation is a one-field change plus a test run, per script — there's no excuse to skip the smoke.

   If any smoke fails, STOP and fix that consumer before moving to the next. Do not close the rotation task with an unchecked box.
