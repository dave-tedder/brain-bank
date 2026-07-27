# Meta DM Scanner — Cowork Prompt

Copy everything below the line into a scheduled Cowork task on your automation machine.

---

You are scanning the operator's Meta Business Suite unified inbox (Instagram + Facebook DMs) and summarizing all activity from the past 24 hours. This runs daily on the automation machine.

## Rules

- This is a READ-ONLY scan. You may click on conversations to open and read them, and click inbox filter tabs (All Messages, Requests, etc.) to navigate between views. Do NOT reply, react, like, delete, or send anything. Reading a message may mark it as read in Meta, that's acceptable.
- Move slowly. Wait 3-5 seconds between any actions. No rapid navigation.
- Total session should complete in under 10 minutes. If there are many conversations, prioritize ones that look like actual messages over shared posts/reels (which can be categorized from the list view without opening).
- If anything unexpected happens (login wall, captcha, UI you don't recognize), STOP and report via Slack.
- Do NOT fall back to an isolated-session browser tool if any tool fails. Report the failure and stop.

## Step 1: Set Up Access

Use computer-use `request_access` to request read access to Google Chrome. If denied, stop entirely.

Use Control Chrome's `list_tabs` to confirm Chrome is reachable. If this fails, stop entirely.

Use Control Chrome's `open_url` to navigate to: business.facebook.com/latest/inbox

Wait 5 seconds for the page to load.

Take a screenshot using computer-use.

Check the screenshot for login indicators: a login form, "Log In" button, password field, or two-factor authentication prompt. If you see any of these:
- Send a Slack message to your capture channel: "Meta DM Scan: Login session expired on the automation machine. Log back into Meta Business Suite in Chrome at business.facebook.com, then the next scan will work."
- Close the tab and stop.

Check for captcha or verification screens. If present, send a similar Slack alert and stop.

## Step 2: Read the Main Inbox

Confirm the screenshot shows the inbox (conversation list with names, message previews, timestamps). If the page is still loading, wait 3 seconds and screenshot again.

First, scan the conversation list to identify which conversations have activity in the last 24 hours (check timestamps). Ignore older conversations. If you need to scroll to see more, use Control Chrome's `execute_javascript` to scroll the conversation list, wait 3 seconds, then screenshot again. Cap at 25 conversations total.

For each conversation with recent activity, click on it to open it, wait 2 seconds, then take a screenshot to read the actual messages. Note:
- Sender name or handle
- Platform (Instagram or Facebook)
- What the messages contain: text, images, shared posts/reels, video, story mentions, missed calls, etc.
- The actual content of what they said or asked
- Timestamp of the most recent message

After reading a conversation, click back to the inbox list (use the back arrow or click "Inbox" in the sidebar) before opening the next one. Wait 2 seconds between conversations.

## Step 2.5: Enrich Senders With the Brain Bank Wiki

For each conversation you read in Step 2, look up the sender in the Brain Bank wiki using the `get_compiled_page` MCP tool with `name: "<sender display name>"` and `page_type: "client"`. The wiki holds pre-synthesized client pages with preferences, last contact, history, and intake notes, if you've captured that kind of context before.

For each lookup, save:
- Whether a page was found (yes/no)
- If yes, the most useful 1-2 facts to put alongside the conversation in the summary (e.g., "existing customer, prefers phone follow-up, project kicked off last month")

If the sender's display name doesn't match a page, try once with a stripped/normalized name (e.g., drop emoji, drop "@", strip an Instagram handle to first/last name if visible elsewhere in the thread). One retry only — do not loop.

This is a READ-ONLY MCP call. It does not modify the wiki. Cap at 25 lookups per run to match the conversation cap.

## Step 3: Check Message Requests

Instagram has a separate "Requests" or "Message Requests" section for messages from people the account doesn't follow. New inquiries often land here.

Look at the screenshot for a "Requests" tab, filter, or link in the inbox navigation. It might appear as a tab alongside "All Messages", "Messenger", "Instagram", etc., or as a separate section.

If you see a Requests tab or filter:
- Use Control Chrome's `execute_javascript` to click on it, OR use Control Chrome's `open_url` if you can construct the URL.
- Wait 3 seconds, then take a screenshot.
- Read the requests the same way as Step 2.
- Note these as coming from the Requests tab in the report.

If you cannot find a Requests section, note "Message Requests tab not found" in the report.

## Step 4: Build the Summary

Organize everything you found into these categories. A message can only go in one category. Use your best judgment based on what you see.

**Actual Conversations** (someone is talking, asking a question, or having a back-and-forth):
- Include the name, platform, and a brief summary of what they said or asked.
- If the wiki lookup from Step 2.5 returned a compiled page for this sender, prefix the line with `[KNOWN]` and include the 1-2 saved facts in parentheses after the name. Example: `[KNOWN] Jane Doe (existing customer, prefers phone follow-up, project kicked off last month) [IG]: asking about scheduling next session`.
- If no page exists, prefix with `[NEW]` so you can see at a glance which conversations are with strangers.
- This is the most important section. Be specific about what they want.

**Story Mentions** (someone mentioned or tagged the account in their Instagram story):
- Name/handle and any visible context about the mention.

**Shared Posts/Reels** (someone shared a post, reel, video, or meme via DM):
- Name/handle and what they shared if you can tell (e.g., "shared a reel", "shared a meme video", "sent a TikTok").

**Solicitations/Spam** (businesses pitching services, bots, promos):
- Just count these. No need to list individually.

**Missed Calls** (audio or video calls with no accompanying message):
- Name/handle.

**Other** (anything that doesn't fit above):
- Name/handle and brief description.

## Step 5: Report to Slack

Send a Slack message to your capture channel with this format:

**Meta DM Summary** ([today's date])

**Conversations:**
- [IG/FB] Name: summary of what they said/asked
- [IG/FB] Name: summary [Requests] (if from requests tab)

**Story Mentions:**
- [IG] @handle: context if visible

**Shared Posts/Reels:**
- [IG/FB] Name: what they shared

**Missed Calls:** [count, or list names if few]
**Solicitations/Spam:** [count] skipped
**Total activity:** [count] | Requests checked: yes/no

If there is ZERO activity in the past 24 hours, send a short message: "Meta DM Summary ([date]): No new activity in the past 24 hours. Requests checked: yes/no."

## Step 6: Capture to Brain Bank

Capture a summary thought using `capture_thought`:

"[Meta DM Scan] [today's date]: [total count] messages in past 24 hours. [count] conversations, [count] story mentions, [count] shared posts, [count] spam, [count] missed calls. [For each conversation: name, platform, what they asked/said in one line]."

Always capture, even if there was no activity (capture "no new activity" as the thought).

## Step 7: Clean Up

Close the Meta Business Suite tab you opened using Control Chrome's `close_tab`. Do not leave tabs accumulating on the automation machine.

## Failure Handling

If any step fails unexpectedly:
- Send a Slack message to your capture channel: "Meta DM Scan failed at step [N]: [brief error description]. May need to check the automation machine."
- Do not retry failed steps. One attempt per run.
- Do NOT fall back to alternative tools (an isolated-session browser tool, etc.). Report and stop.
- If Slack is unavailable, capture the failure report to Brain Bank via `capture_thought` instead.
