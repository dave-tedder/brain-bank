# Slack Branch (for brain-bank-setup skill)

SKILL.md Reads this file when the operator selects option 1 on the post-core Slack branch menu. Runs the guided 9-step walk-through from `docs/slack-setup.md`, compressing dashboard-click steps and handling all `.env`/`supabase` shell work.

## Entry point

Reached from SKILL.md post-core menu, option 1. State on entry:
- Core deploy is complete (Step 10 smoke test passed).
- `.env` has all 4 core secrets; `env_slack=0`.
- Four Edge Functions are deployed.

## Sub-flow table

Maps `docs/slack-setup.md`'s 9 steps to beats. Six of the 9 steps require Slack dashboard clicks the operator must do; the skill makes those frictionless (direct URLs, UI hints) and handles everything programmable.

| Step | Claude says (compressed) | Claude runs | Operator does |
|---|---|---|---|
| **1. Create Slack app** | "Open [api.slack.com/apps](https://api.slack.com/apps), **Create New App**, **From scratch**. Name: anything (e.g., 'Brain Bank'). Workspace: pick one, or create a throwaway at [slack.com/create](https://slack.com/create) first if you don't have a clean workspace. Click Create App. Tell me when you're on the Basic Information page." | Nothing. | Click through Slack UI. |
| **2. Add OAuth scopes** | "Left sidebar, **OAuth & Permissions**, scroll to **Bot Token Scopes**, add: `chat:write` and `channels:history`. If any of your Brain Bank channels will be private channels, also add `groups:history`. Tell me when added." | Nothing. | Add scopes. |
| **3. Install to workspace + grab tokens** | "Scroll to top of OAuth & Permissions, **Install to Workspace**, Allow. After install you'll see **Bot User OAuth Token** (starts with `xoxb-`). Copy it. Then left sidebar, **Basic Information**, scroll to **App Credentials, Signing Secret**, Show, copy. You now have two secrets. Add them to `.env`. I'll give you the exact lines. Remember: no pasting in chat." | Provide exact `.env` line format: `SLACK_BOT_TOKEN=<xoxb-...>` and `SLACK_SIGNING_SECRET=<hex>`. After operator confirms saved, run `grep -cE '^SLACK_BOT_TOKEN=xoxb-.{40,}' .env` and same for signing secret. | Paste two secrets into `.env`, save. |
| **4. Create Brain Bank channels** | "In your Slack workspace, create the channels you want. Minimum is one capture channel. Suggest `#brain-capture`. Optional extras: `#brain-longform`, `#brain-ask`, `#brain-digest`. Tell me which channels you created." | Nothing. Store operator's list for step 5. | Create channels in Slack. |
| **5. Invite bot + grab channel IDs** | For each channel the operator created: "In `#channel-name`, type `/invite @Brain Bank`. Then right-click the channel in sidebar, **View channel details**, scroll to bottom, copy **Channel ID** (format: `C0123456789`). Paste into `.env` under the right variable name. I'll tell you which." Walk through one channel at a time: SLACK_CAPTURE_CHANNEL (required), then optional SLACK_BRAIN_CHANNEL, SLACK_QUERY_CHANNEL, SLACK_DIGEST_CHANNEL. | After each ID in `.env`, run `grep -cE '^SLACK_CAPTURE_CHANNEL=C[A-Z0-9]{10}$' .env` (and same per variable). Channel IDs aren't secrets; the grep can safely print the full line if needed for diagnostics. | Invite bot, grab IDs, paste into `.env`. |
| **6. (folded)** | Step 6 of the doc is folded into Steps 3 and 5 above. Skip. | | |
| **7. Push Slack secrets** | "Pushing your updated `.env` to Supabase secrets." | `supabase secrets set --env-file .env --project-ref $REF`. Confirm with `supabase secrets list --project-ref $REF` showing SLACK_* names in output. | Nothing. |
| **8. Event Subscriptions + URL verify** | "Back in Slack app settings, **Event Subscriptions**, toggle **Enable Events** on, paste this URL: `$SUPABASE_URL/functions/v1/ingest-thought` (no `?key=`, no trailing slash). Slack will verify within a second: look for green 'Verified'. Then scroll down to **Subscribe to bot events**, **Add Bot User Event**, `message.channels` (and `message.groups` if using private channels). Click Save Changes. Slack will prompt to reinstall: click **Reinstall to Workspace**, Allow. Tell me when verified + reinstalled." | On verification failure, run `supabase functions logs ingest-thought --project-ref $REF` and parse output. Diagnose via `references/error-recovery.md` Slack Step 8 section. | Paste URL, verify, add event, reinstall. |
| **9. Smoke test each channel** | "Let's test. In `#brain-capture`, post: 'First Slack capture test from setup wizard.' The bot should reply within 5 seconds in-thread with an extracted summary." Then offer optional tests: thread reply, query prefix, silent brain channel, digest delivery. Operator can skip any. | For digest delivery: `source .env && curl -X POST "$SUPABASE_URL/functions/v1/brain-digest?mode=daily&key=$MCP_ACCESS_KEY"`. Check response for `"status":"delivered"` or `"status":"skipped"` (both OK). | Post test messages, confirm bot replies. |

## Failure handling

The failures documented in `docs/slack-setup.md` Step 8 (HMAC mismatch, 404, 500) and Step 9 (bot didn't reply, source field blank, "Failed to capture") are indexed in `references/error-recovery.md`. If any surface during the sub-flow, Read error-recovery.md, find the entry, forward-link to troubleshooting.md if applicable.

## Menu option 2 (self-serve)

If the operator picks "point me at docs/slack-setup.md" on the SKILL.md menu:

```
[Claude runs: open docs/slack-setup.md]
[Claude]: "Opened. Walk through it whenever you're ready. A few things I can help with later:
  * Paste me any Step 8 or Step 9 error and I'll diagnose.
  * When you're done and ready to schedule the morning digest, run /brain-bank-setup again and I'll pick up at the cron branch.
Want to do the cron branch now (without Slack), or stop here?"
```

Then route to the SKILL.md cron branch menu or exit.

## Prohibitions in Slack branch

- Never ask the operator to paste `xoxb-...` or signing secrets into chat.
- Never take screenshots of the Slack app settings page.
- Never construct a curl with the bot token inline in a chat-visible string.
