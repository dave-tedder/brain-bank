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

## Why these decisions matter

Constraint #3 calls for a "why this matters" line on every non-obvious decision. The ones worth an extra beat with the operator:

### Step 2: both `chat:write` AND `channels:history`

Without `channels:history`, the bot still receives top-level `message.channels` events (it can post capture confirmations), but any attempt to read the parent message of a thread reply fails silently. Thread-aware capture breaks with no error message. The operator only notices when follow-up replies in a thread aren't carrying parent context. Always add both; the two-scope minimum is required for Brain Bank's thread-context feature to work.

### Step 3: the Signing Secret is required, not optional

Skipping `SLACK_SIGNING_SECRET` would let anyone who guesses the Edge Function URL POST fake Slack events that land in the `thoughts` table as real captures. The function verifies inbound payloads via HMAC using this secret; an empty secret disables that check. Always set it on any deploy that isn't a throwaway.

### Step 5: Channel ID, not channel name

Slack shows channel names (`#brain-capture`) everywhere in the UI, so an operator's instinct is to paste that. If they put `SLACK_CAPTURE_CHANNEL=#brain-capture` into `.env`, the function compares inbound events against a string that never matches and silently ignores every message. No error in the logs, no captured thoughts, no obvious failure. The grep pattern catches the shape mismatch (starts with `C`, then 10 uppercase alphanumerics), but remind the operator why the ID looks different from what they see in Slack.

### Step 8: no `?key=`, no trailing slash on the Event Subscriptions URL

Slack authenticates itself via the Signing Secret, not via `MCP_ACCESS_KEY`. Appending `?key=...` to the URL would work (the function ignores the query param on the Slack path), but the trailing slash breaks Slack's challenge response and the verification fails. Paste the URL exactly: `$SUPABASE_URL/functions/v1/ingest-thought`.

## Failure handling

When a step fails, Read `references/error-recovery.md` for the authoritative diagnosis index. The three most common Step 8 failures to recognize on sight before reaching for the index:

- **"URL did not respond with the value of the challenge parameter"** plus `HMAC verification failed` in `supabase functions logs ingest-thought`: `SLACK_SIGNING_SECRET` in Supabase doesn't match what this Slack app is signing with. Double-check you copied from the right app's Basic Information page (easy to paste from an older app by accident), update `.env`, re-run `supabase secrets set --env-file .env --project-ref $REF`, retry verification.
- **"URL returned HTTP 404"**: wrong function name in the URL. Confirm it ends exactly with `/functions/v1/ingest-thought`, not `/ingest-thought-v2` or `/open-brain-mcp`.
- **Green "Verified" but Step 9 smoke test sees no reply and no row in `thoughts`**: Event Subscriptions saved without `message.channels` under Subscribe to bot events. Add the event, click Save Changes, reinstall the app when Slack prompts.

Any other Step 8 or Step 9 failure (bot reply says "Failed to capture", row lands with `metadata->>'source'` blank, 500 errors): forward to `references/error-recovery.md` Slack sections, then to `docs/troubleshooting.md` if the recipe matches.

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
