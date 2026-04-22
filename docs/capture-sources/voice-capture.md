# Capture by voice (Siri)

This walkthrough takes you from "Brain Bank is deployed and REST capture works" to "I can say `Hey Siri, brain thought` from my iPhone, Apple Watch, CarPlay, or Mac, dictate a thought, and have it land in Brain Bank with `source = voice` in the database."

If you have not completed [`deploy-from-scratch.md`](../deploy-from-scratch.md) through Step 10 (the curl smoke test), stop and do that first. This walkthrough assumes your `open-brain-mcp` Edge Function is running and REST `/capture` works end-to-end.

Seven steps, about fifteen minutes the first time.

## What you get by connecting voice

- **Capture from anywhere, hands-free.** Driving, walking, doing dishes. Any time you can speak to Siri, you can capture a thought.
- **Apple Watch and CarPlay support.** The Shortcut runs on any Apple device signed into the same iCloud account. Siri passes the dictation through, and the POST fires from whichever device answered.
- **Instant transcription.** Apple's built-in Dictation handles the voice-to-text. No audio is sent to Brain Bank; only the transcript.
- **Silent confirmation.** A short notification tells you the capture went through. A different notification tells you if the dictation was empty (you cancelled or Siri misheard).
- **Dedup protection.** If you accidentally capture the same thought twice, Brain Bank's content-hash dedup catches the second one before embedding or metadata extraction.

## How it works

Apple Shortcuts lets you chain a Dictate Text action into a web-request action. You bind Siri to the Shortcut with a custom trigger phrase, and the whole flow lives on your device. No intermediate server, no transcription fee, no latency from network hops beyond the final POST to Brain Bank.

The Shortcut you build here:

1. Triggers on a Siri phrase you pick (for example, "brain thought").
2. Opens the microphone via **Dictate Text**, stops listening when you pause.
3. Checks that the transcript has content. If yes, POSTs to `open-brain-mcp/capture` with `"source": "voice"` and shows a success notification. If no, shows an "I did not hear anything" notification and stops.

Because Shortcuts cannot be exported to a file, there is no script to copy from the repo. Build the Shortcut interactively once, and it syncs to your other Apple devices.

## Prerequisites

- **An Apple device on a recent OS.** iOS 14+, watchOS 7+, or macOS 12+. Shortcuts is built in.
- **Siri enabled.** Settings → Siri & Search → confirm "Press Side Button for Siri" (or the equivalent) is on and the language matches your speech.
- **Your Supabase project ref.** The 20-character lowercase string from [`deploy-from-scratch.md`](../deploy-from-scratch.md) Step 2.
- **Your `MCP_ACCESS_KEY`.** Same value as in `.env`.

---

## Step 1. Create a new Shortcut

Open the **Shortcuts** app.

- On **iPhone** or **iPad**: tap the **+** in the top right.
- On **Mac**: click the **+** in the toolbar, or File → New Shortcut.

Rename the Shortcut to **Brain Thought** (or any name; this becomes the default Siri trigger phrase unless you override it).

**What success looks like:** you land in the Shortcut editor with an empty action list on the left and the action library on the right.

**If it fails:**
- "Shortcuts is not available": on Mac, you need macOS 12 (Monterey) or later.

---

## Step 2. Add the Dictate Text action

Add the first action: **Dictate Text**. Search the action library for `dictate text` and tap or drag the result into the editor.

Configure the action:

- **Language:** match your speaking language (default is fine for most setups).
- **Stop Listening:** tap **Show More**, then set **Stop Listening** to **After Pause**. This lets Siri stop on its own when you finish a sentence, rather than listening for a fixed duration.

**What success looks like:** the action reads `Dictate Text (After Pause)`.

**If it fails:**
- The action is not in the library: the Dictate Text action ships with every iOS 14+ device. If it is missing, reset the action library by force-closing the Shortcuts app and reopening.
- The **Stop Listening** option is not visible: tap **Show More** in the action. Older iOS versions label this differently ("Stop Listening" vs. "Listening Time").

---

## Step 3. Add an If-has-value guard

You want to avoid POSTing empty text if the dictation was cancelled or Siri misheard silence.

Add the action **If**. Configure:

- **Input:** the `Dictated Text` variable (tap the variable picker and choose it).
- **Condition:** `has any value`.

This splits the flow into a "got something" branch and an "empty" branch. The next two steps fill in each branch.

**What success looks like:** your Shortcut structure is:

```
Dictate Text (After Pause)
If Dictated Text has any value
    [... POST here ...]
Otherwise
    [... "no input" notification here ...]
End If
```

**If it fails:**
- The condition list in the If picker does not include `has any value`: some older iOS versions offer only `is equal to`. You can substitute `is not` `` (empty string) as equivalent.

---

## Step 4. Add the POST to Brain Bank

Inside the If (the "got something" branch), add **Get Contents of URL**. Tap **Show More** to reveal all fields.

Configure:

- **URL:** `https://<your-supabase-project-ref>.supabase.co/functions/v1/open-brain-mcp/capture`. Replace `<your-supabase-project-ref>` with your real Supabase ref.
- **Method:** `POST`.
- **Headers:** tap **Add new header**. Add:
  - Key `Authorization`, Value `Bearer YOUR_BRAIN_KEY` (replace `YOUR_BRAIN_KEY` with the real value from `.env`).
  - Key `Content-Type`, Value `application/json`.
- **Request Body:** `JSON`. Add two fields:
  - Key `content`, Value: the `Dictated Text` variable (from the variable picker).
  - Key `source`, Value: type the literal string `voice`.

Right after the Get Contents of URL action (still inside the If branch), add a **Show Notification** action. Configure:

- **Title:** `Brain Capture`
- **Body:** `Thought captured.`

**What success looks like:** the "got something" branch of your Shortcut reads:

```
Get Contents of URL (POST to .../capture with content + source=voice)
Show Notification: Brain Capture / Thought captured.
```

**If it fails:**
- The `source` field becomes a variable pill instead of the literal string `voice`: tap the field, delete the pill, type `voice` as plain text.
- You cannot find `Dictated Text` in the variable picker: you are outside the If block or positioned above the Dictate Text action. Drag the Get Contents of URL action to sit inside the If, below the Dictate Text step.

**Why this matters:** the `source` field tags every voice capture as `source = voice` in the database. Without it, captures fall back to the default source (`chatgpt`), so your voice captures would be indistinguishable from your ChatGPT GPT captures in queries. Tagging correctly is cheap at capture time and hard to backfill later.

---

## Step 5. Fill in the Otherwise branch

Below the If's success branch, in the **Otherwise** branch, add another **Show Notification**. Configure:

- **Title:** `Brain Capture`
- **Body:** `No input detected. Try again.`

**What success looks like:** your Shortcut now has complete success and failure paths:

```
Dictate Text (After Pause)
If Dictated Text has any value
    Get Contents of URL (POST .../capture)
    Show Notification: "Thought captured."
Otherwise
    Show Notification: "No input detected. Try again."
End If
```

**If it fails:**
- You accidentally put the "no input" notification inside the success branch: it will fire even on successful captures. Drag it into the Otherwise block.

---

## Step 6. Record the Siri trigger phrase

At the top of the Shortcut editor, tap the Shortcut's name or the settings icon (gear/info). Find **Add to Siri** (also sometimes called "Use with Siri" or shown with a microphone icon).

Tap **Add to Siri** and record the phrase Siri should listen for. Suggestions:

- `brain thought` (short, hard to confuse with other commands)
- `capture thought`
- `open brain`

Speak the phrase clearly, twice if the recording UI asks. Tap **Done**.

**What success looks like:** the Shortcut settings show the recorded trigger phrase. Saying "Hey Siri, [your phrase]" now invokes this Shortcut.

**If it fails:**
- Siri mishears the phrase consistently: record it again with a simpler or more distinctive word. Avoid phrases that overlap with built-in Siri commands ("capture photo" etc.).
- The **Add to Siri** option is missing: you are on a Mac running an older macOS. On modern macOS, Shortcut names themselves act as Siri triggers (you say "Hey Siri, Brain Thought" using the Shortcut's exact name). Rename the Shortcut to something short and distinctive if so.

---

## Step 7. Test on device and verify in the database

Say "Hey Siri, [your trigger phrase]" (or tap the Run button in the Shortcut editor, which is a valid test path).

Siri opens the microphone. Speak a clear test sentence: `Testing voice capture to Brain Bank on <today's date>.`

When you stop, Siri should complete the Shortcut silently and show the "Thought captured." notification. If Siri heard nothing, you will see the "No input detected" notification instead; just retry.

Verify the row landed in the database:

```sql
select id, left(content, 100) as preview, metadata->>'source' as source, created_at
from thoughts
where metadata->>'source' = 'voice'
order by created_at desc
limit 3;
```

**What success looks like:** the test sentence appears in `content` with `source = voice` and the `created_at` within the last minute.

**If it fails:**
- **Notification says "Thought captured" but no row in the database:** you are querying a different Supabase project. Verify the URL in the Shortcut's Get Contents of URL action.
- **Silent failure with no notification either way:** the Shortcut hit a network error that neither branch handled. Open the Shortcut, tap the clock icon at the bottom, find the most recent run, and read the error. Most common: wrong URL (re-check project ref), wrong key (re-copy from `.env`), or `Authorization` header has a trailing space or smart-quote substitution.
- **Row appears with `source = chatgpt` instead of `source = voice`:** the `source` field in the JSON body got dropped or has the wrong value. Open the Shortcut and confirm the literal string `voice` (not a variable pill) in the source field of the POST body.
- **Siri dictation keeps timing out before you finish speaking:** you have Stop Listening set to a fixed duration. Open the Dictate Text action and change Stop Listening to **After Pause**.

**Why this matters:** dedup is content-hash based, so back-to-back tests with identical phrasing will only land the first one. Use distinctive test content (with today's date or a random word) so you can see clearly which run wrote the row.

---

## Using on Apple Watch and in CarPlay

The Shortcut syncs to your Apple Watch automatically via iCloud. To trigger it:

- **Apple Watch:** raise your wrist, say "Hey Siri, [trigger phrase]". Speak the thought when Siri opens the mic. The Watch POSTs directly (using its own cellular or paired-iPhone connection). The notification appears on the Watch.
- **CarPlay:** say "Hey Siri, [trigger phrase]" to the car. CarPlay passes the command to your paired iPhone, which runs the Shortcut and POSTs. CarPlay shows a minimal confirmation banner.
- **Mac:** say "Hey Siri" (if enabled) or press the Siri shortcut (default is `Cmd+Space` held, or the menu bar icon), then the trigger phrase.

In all three cases, the Shortcut pulls configuration from the iCloud-synced definition, so you do not need to rebuild it per device.

---

## Troubleshooting common issues

- **"Could not connect to server":** your internet connection is down, or Supabase is having a transient outage. Retry.
- **401 Unauthorized with no notification (silent failure):** check the URL in the Get Contents of URL action for a trailing backtick, space, or smart quote. These stack on the end of the `Bearer ...` header and cause a 401 that Shortcuts does not surface.
- **Dictation transcribed the wrong word:** Apple's on-device dictation is not perfect. Re-running is the fix. Over time, if a specific word is consistently wrong, adding it to your Personal Dictionary (Settings → General → Keyboard → Text Replacement) helps.
- **Duplicate notification but you wanted the capture to go through:** the content hash matched a prior capture exactly. This is dedup working correctly. If you meant to capture a truly-different thought, rephrase slightly and try again.

---

## Optional: text-input variant

If you want a version you can type into instead of dictate (useful in meetings or quiet environments), duplicate the Shortcut and replace the **Dictate Text** action with **Ask for Input**:

- **Prompt:** `What's on your mind?`
- Everything else stays the same; `Ask for Input` returns the typed text in a variable called `Provided Input`, which slots into the POST body the same way `Dictated Text` did.

Name the variant something distinct ("Brain Note" vs. "Brain Thought") and record a different Siri phrase so you can pick which one you want per situation.

---

## What's next

You now have hands-free voice capture into Brain Bank, working on every Apple device signed into your iCloud account. Places to go from here:

- **Add more capture sources.** Voice is one of several capture paths in `docs/capture-sources/`. Gmail, Apple Notes, and ChatGPT are all independent and add cleanly alongside this one.
- **Add a home-screen widget.** On iPhone, add the Shortcuts widget to your home screen and pin this Shortcut to it. One tap invokes the same flow with a tappable affordance instead of the voice trigger. Same flow, no voice needed.
- **Rotate `MCP_ACCESS_KEY`.** If you ever rotate the key, update the `Authorization` header in the Get Contents of URL action. The old key stops working immediately after rotation.

If a step in this walkthrough does not work end-to-end, it is a doc bug, not a user bug. Open an issue on the repo.
