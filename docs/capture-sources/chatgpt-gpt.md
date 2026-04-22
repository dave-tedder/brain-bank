# Capture from a ChatGPT Custom GPT

This walkthrough takes you from "Brain Bank is deployed and REST capture works" to "I can search, browse, and capture thoughts from inside any ChatGPT conversation using a Custom GPT."

If you have not completed [`deploy-from-scratch.md`](../deploy-from-scratch.md) through Step 10 (the curl smoke test), stop and do that first. This walkthrough assumes your `open-brain-mcp` Edge Function is running against a healthy Supabase project and REST `/capture` works end-to-end.

Eight steps, about twenty minutes the first time.

## What you get by connecting ChatGPT

- **Search your brain from any chat.** "What have I thought about X?" triggers a semantic search across every captured thought, and the GPT summarizes results conversationally.
- **Capture mid-conversation.** Say "remember that..." or "save this for later" and the GPT POSTs to Brain Bank. Captures land in the database with `source = chatgpt`.
- **Browse and filter.** Ask for recent thoughts by type, topic, person, or last N days. The GPT calls `listThoughts` with the right filters.
- **Summary stats on demand.** "What have I been thinking about most this month?" triggers `getThoughtStats`, which returns top topics, top people, and type breakdown.
- **Private by default.** Custom GPTs default to "Only me" visibility. No one else can call your GPT or see your data.

## How it works

ChatGPT Custom GPTs support an "Actions" feature that exposes HTTP endpoints to the model as tools. Brain Bank ships an OpenAPI 3.1 schema that defines four actions (`searchThoughts`, `listThoughts`, `getThoughtStats`, `captureThought`) mapping one-to-one onto the REST endpoints on `open-brain-mcp`. You paste the schema into the GPT's Actions config, set Bearer auth with your `MCP_ACCESS_KEY`, and the GPT can now call your Brain Bank directly.

Every call goes from ChatGPT's servers straight to your Supabase Edge Function. There is no intermediate service. If your Edge Function is healthy, the GPT works; if it is down, the GPT fails with an HTTP error that ChatGPT shows in the chat transcript.

## Prerequisites

- **ChatGPT Plus subscription.** Custom GPTs are a Plus-only feature. If you are on the free tier, either upgrade or use a different capture path (the voice and Apple Notes guides both use the same REST endpoint and work without ChatGPT).
- **Your Supabase project ref.** The 20-character lowercase string from [`deploy-from-scratch.md`](../deploy-from-scratch.md) Step 2.
- **Your `MCP_ACCESS_KEY`.** The value you have in `.env` under `MCP_ACCESS_KEY`, also mirrored into Supabase vault per Step 9 of the deploy guide.
- **The OpenAPI schema.** Ships in the repo at [`integrations/chatgpt-gpt/openapi.json`](../../integrations/chatgpt-gpt/openapi.json).
- **The GPT instructions.** A neutral starter block ships at [`integrations/chatgpt-gpt/gpt-instructions.md`](../../integrations/chatgpt-gpt/gpt-instructions.md). Customize it with your own persona and writing preferences before pasting.

---

## Step 1. Open the GPT editor

Go to [chatgpt.com/gpts/mine](https://chatgpt.com/gpts/mine) and sign in if prompted.

Click **+ Create** (top right). A new tab opens with a split view: a "Create" chat pane on the left, a "Preview" pane on the right.

Click the **Configure** tab at the top of the left pane. This switches from the conversational "tell me what kind of GPT you want to build" flow to the form-based editor. All the fields you need to fill are here.

**What success looks like:** you see form fields for Name, Description, Instructions, Conversation starters, Knowledge, Capabilities, and (at the bottom) Actions.

**If it fails:**
- "Create a GPT is unavailable": you are on the ChatGPT free tier. Upgrade to Plus, or pick a different capture source.
- You land on the conversational "Create" tab and cannot find the fields: click **Configure** at the top of the left pane. The tabs are easy to miss.

---

## Step 2. Set name and description

In the Configure tab:

- **Name:** something short you will recognize in your GPT list. `Brain Bank` works. `Personal Memory` works. Anything.
- **Description:** a one-liner that reminds you what this GPT is for. Example: `Search, browse, and capture thoughts in my personal memory system.`

Click anywhere outside the field to save.

**What success looks like:** the Preview pane on the right updates to show the new name and description at the top.

**If it fails:** changes do not appear in the Preview pane until you click outside the active field. If you navigated away without clicking off, the edit may have been dropped. Re-enter the fields.

---

## Step 3. Paste the Instructions

Open [`integrations/chatgpt-gpt/gpt-instructions.md`](../../integrations/chatgpt-gpt/gpt-instructions.md) in the Brain Bank repo. The file has a fenced code block labeled "Paste this into the GPT's Instructions field." That is the raw Instructions block.

Copy the contents of that code block (just the code, not the surrounding markdown notes). Paste it into the **Instructions** field in the Configure tab.

The starter block is intentionally neutral: it tells the GPT to search before saying "I don't know," to offer capture when the operator mentions something noteworthy, to stay direct and conversational. It does not assume any profession, writing style, or banned words.

Below the paste block in the source file is a "Customize before saving" section listing things to add: persona, banned words, tone preferences, domain shortcuts. Add anything from that list that matters to you directly into the Instructions field, inside the same paste block.

Click outside the field to save.

**What success looks like:** the Instructions field shows your customized block. The Preview pane on the right updates to reflect the new system prompt on next message.

**If it fails:**
- Instructions field shows a character-limit warning: Custom GPT instructions cap around 8,000 characters. The starter block is well under that; if you added a large amount of context, trim until the warning disappears.
- Paste includes weird characters or smart quotes: some clipboards substitute straight quotes with curly ones. If you see visible rendering issues, retype any suspicious lines manually.

---

## Step 4. Add the Action

Scroll to the bottom of the Configure tab. Click **Create new action**.

The Actions editor opens with three sub-sections: **Authentication**, **Schema**, and **Privacy policy**.

Leave Authentication alone for the moment; you will fill it in Step 5.

In the **Schema** field, paste the entire contents of [`integrations/chatgpt-gpt/openapi.json`](../../integrations/chatgpt-gpt/openapi.json).

Scroll to the top of the pasted schema and find the `servers` block:

```json
"servers": [
  {
    "url": "https://<your-supabase-project-ref>.supabase.co/functions/v1/open-brain-mcp"
  }
]
```

Replace `<your-supabase-project-ref>` with your real 20-character Supabase project ref. Leave the rest of the URL alone.

As soon as the schema is valid, a list of available actions appears below the schema field: `searchThoughts`, `listThoughts`, `getThoughtStats`, `captureThought`. Each has a **Test** button.

**What success looks like:** all four actions show up in the Available Actions list with no red error banner above the schema.

**If it fails:**
- Red banner reading "Invalid schema" or "Could not parse schema": the JSON paste truncated or picked up stray characters. Re-copy from the source file and paste fresh.
- Only some actions appear: check that your paste is complete. The schema ends with closing `}` braces after the `/capture` block.
- "Could not resolve server URL" or similar: you left the placeholder `<your-supabase-project-ref>` in the URL. Fill in your real ref.

---

## Step 5. Set Bearer authentication

In the same Actions editor, scroll to the top and click **Authentication**. A side panel opens with auth-type options.

Configure:

- **Authentication Type:** `API Key`
- **API Key:** paste your `MCP_ACCESS_KEY` value. This is the same string you have in `.env` under `MCP_ACCESS_KEY`. A 64-character hex string.
- **Auth Type:** `Bearer`
- **Custom Header Name:** leave blank (the default, `Authorization: Bearer <key>`, is what `open-brain-mcp` expects).

Click **Save**.

**What success looks like:** the Authentication section in the Actions editor now reads "API Key" with a filled-in state indicator. No errors.

**If it fails:**
- "API Key is required" on save: the key field was empty. Re-paste and click Save again.
- Actions still fail on Test with 401: the key you pasted does not match your `MCP_ACCESS_KEY` in Supabase. Re-copy from `.env`, re-paste, save. If the issue persists, verify the key pushed to Supabase matches the one in `.env` with `supabase secrets list --project-ref <ref>` (note: the CLI shows a digest, not the plaintext value; compare digests if both ends are the same key).

**Why this matters:** Brain Bank's REST API accepts the same access key in three places (`x-brain-key` header, `Authorization: Bearer`, or `?key=` URL param) and any one of them works. ChatGPT Custom GPTs only support the two auth types ChatGPT exposes (`API Key` with a Bearer or custom-header mode), so Bearer is the path to use here.

---

## Step 6. Test each action

In the Actions editor, scroll to the **Available Actions** list and click **Test** on `getThoughtStats` first. It has no required parameters, so it is the cleanest way to prove the pipe is working.

A modal appears showing the call details and (after a couple seconds) the response.

**What success looks like:** the response is JSON with a `total` field, a `types` or `by_type` object, and top topics/people arrays. The exact shape depends on what you have in your database, but you should see a 200 response and a JSON body.

**If it fails:**
- **401 Unauthorized:** the API Key does not match `MCP_ACCESS_KEY`. Revisit Step 5.
- **404 Not Found:** the server URL in the schema is wrong. Revisit Step 4 and verify the project ref.
- **500 Internal Server Error:** the Edge Function threw. Check Supabase Edge Function logs for the actual error; most often a Supabase-side auth misconfiguration or a database connection issue unrelated to this integration.
- **Timeout or network error:** confirm the Edge Function is deployed and healthy by running the curl smoke test from [`deploy-from-scratch.md`](../deploy-from-scratch.md) Step 10.

Once `getThoughtStats` is green, click **Test** on `searchThoughts` with a query like `"recent"` or any single word that should match something in your database. You should get a `count` and a `results` array back.

Skip testing `captureThought` here; Step 8 covers that end-to-end from a real conversation.

---

## Step 7. Save and set privacy

Scroll to the top of the Configure tab. Click **Save** (top right). A dropdown offers three visibility options:

- **Only me.** The default. The GPT is private; only you can chat with it. Use this.
- **Anyone with the link.** Do not use this. Anyone who gets the share link can call your GPT, and calls ride on your `MCP_ACCESS_KEY`.
- **GPT Store.** Do not use this. Publishes the GPT publicly.

Click **Only me**, then **Save**.

Optionally, scroll to the **Additional Settings** section at the bottom of the Configure tab and uncheck **Use conversation data in your GPT to improve our models** if you prefer your conversations not be used for OpenAI training. This setting is per-GPT.

**What success looks like:** the Save button changes state to "Saved," and the GPT now appears in your [chatgpt.com/gpts/mine](https://chatgpt.com/gpts/mine) list.

**If it fails:**
- Save fails with "Action validation failed": your OpenAPI schema has a structural issue ChatGPT rejected only at save time (not during live editing). Most commonly this is a missing `operationId` or malformed `servers` block. Fix in the Actions editor and re-save.

**Why this matters:** the privacy setting is enforced by ChatGPT, not Brain Bank. If you flip visibility to "Anyone with the link" and share the link, anyone who opens it can call your Brain Bank with your `MCP_ACCESS_KEY` credentials. Keep it on "Only me" unless you have a specific reason to change.

---

## Step 8. End-to-end smoke test

Open a new chat with your GPT. You can click **View GPT** at the top after saving, or find it at [chatgpt.com/gpts/mine](https://chatgpt.com/gpts/mine).

Try three things:

1. **Search.** Ask a question you know is in your Brain Bank. Example: `What have I thought about Brain Bank setup?` The GPT should call `searchThoughts` (you will see "Talking to Brain Bank API..." or similar in the UI), return results, and summarize them conversationally.
2. **Capture.** Say: `Remember that ChatGPT capture is now working for me.` The GPT should confirm and call `captureThought`. You will see the action invocation in the UI, followed by a confirmation from the GPT.
3. **Verify the row landed.** In the Supabase SQL editor, run:

   ```sql
   select id, left(content, 100) as preview, metadata->>'source' as source, created_at
   from thoughts
   where metadata->>'source' = 'chatgpt'
   order by created_at desc
   limit 3;
   ```

   The capture from step 2 should appear with `source = chatgpt` and the content you dictated.

**What success looks like:** all three actions complete inside ChatGPT, and the capture shows up in the database with `source = chatgpt` (the default when no source is passed in the POST body).

**If it fails:**
- **GPT refuses to call actions and tries to answer from its own training:** the Instructions block did not save. Revisit Step 3; confirm the "ALWAYS call searchThoughts first" rule is in the saved Instructions field.
- **Search works but capture silently does nothing:** check the GPT's response carefully. Some versions ask for confirmation before calling `captureThought`. Say `yes` or `go ahead` if prompted.
- **Row appears but content is missing or empty:** the GPT called `captureThought` with an empty `content` field. This sometimes happens if the conversation was ambiguous about what to capture. Rephrase: `Capture this thought: <the exact text to save>`.
- **Row does not appear at all:** check the Supabase Edge Function logs for the `open-brain-mcp` function, filtered to the last few minutes. A 401 or 500 there will tell you what went wrong.

---

## Customizing the persona further

The starter Instructions block is intentionally neutral. Add any of these to make the GPT feel more like yours:

- **Who you are and what you do.** One or two sentences of context helps the GPT interpret ambiguous queries. Example: `You are assisting a freelance designer who runs a small studio and collaborates with three regular clients.`
- **What to call you.** If you want to be addressed by name, add it: `Address the operator as "<your first name>".`
- **Writing style.** Short sentences vs. flowing prose. Lists vs. paragraphs. No em dashes. All of these shape the output.
- **Recurring project names, acronyms, or jargon.** Spelling out recurring terms upfront reduces the chance the GPT misinterprets them on first mention.
- **Banned words or phrases.** If there are words you dislike in your own writing, list them. The GPT will avoid them.

Edits go inside the Instructions paste block. Re-save after editing.

---

## Revoking the GPT

If you stop using the GPT, or rotate `MCP_ACCESS_KEY` and want to disable the old GPT while you rebuild:

1. Go to [chatgpt.com/gpts/mine](https://chatgpt.com/gpts/mine).
2. Click the GPT, click the three-dot menu next to its name in the editor, click **Delete**.

That removes the GPT and its Action configuration. The `MCP_ACCESS_KEY` it was using is not rotated; do that separately in Supabase if you want to invalidate the key globally.

If you are rotating `MCP_ACCESS_KEY` and want to keep the GPT, just go back to Step 5 and update the API Key field to the new value. Save. The next chat uses the new key.

---

## What's next

You now have ChatGPT wired into Brain Bank with search, browse, capture, and stats all callable from any conversation. Places to go from here:

- **Add more capture sources.** ChatGPT is one of several capture paths in `docs/capture-sources/`. Gmail, voice memos, and Apple Notes are all independent and add cleanly alongside this one.
- **Swap to a different auth mode.** The default `Authorization: Bearer` works, but if you ever want to test the `x-brain-key` header path, ChatGPT's Custom Header auth mode supports that too. Same key, just moved to a different header name.
- **Share the schema with other tools.** The OpenAPI schema at `integrations/chatgpt-gpt/openapi.json` works with any tool that speaks OpenAPI. If you build your own integration layer, point it at the same spec to save time.

If a step in this walkthrough does not work end-to-end, it is a doc bug, not a user bug. Open an issue on the repo.
