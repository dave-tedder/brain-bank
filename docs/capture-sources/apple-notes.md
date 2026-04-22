# Capture from Apple Notes

This walkthrough takes you from "Brain Bank is deployed and REST capture works" to "notes I drop in a special folder on any Apple device land in Brain Bank automatically on the schedule I choose, with `source = apple-notes` in the database."

If you have not completed [`deploy-from-scratch.md`](../deploy-from-scratch.md) through Step 10 (the curl smoke test), stop and do that first. This walkthrough assumes your `open-brain-mcp` Edge Function is running and REST `/capture` works end-to-end.

Eight steps, about twenty-five minutes the first time. All of it is inside the Shortcuts app; no code, no external service.

## What you get by connecting Apple Notes

- **Drop-and-forget capture.** Create a note in the `Brain Capture` folder from iPhone, iPad, Mac, or Apple Watch. The next time the Shortcut runs, that note gets POSTed to Brain Bank and moved to an archive folder.
- **Sync works everywhere iCloud syncs.** Because Apple Notes syncs through iCloud, a note written on your Apple Watch lands in the same capture folder as one written on your Mac. The Shortcut on any one device picks up the whole queue.
- **Safe double-runs.** The Shortcut checks the response from Brain Bank and only moves a note to `Brain Archived` if the capture actually succeeded. Duplicates (same content already in the database) get left in place so you can see and delete them manually if you want.
- **Silent by default.** You can schedule the Shortcut to run daily in the background. An optional completion notification is available if you want visible feedback.
- **Good for Siri dictation.** Saying "Hey Siri, note to self..." creates a note in your default folder; moving it to `Brain Capture` on the next Apple Notes pass is one tap. Or set `Brain Capture` as your default Notes folder if you want every Siri note captured.

## How it works

Apple Shortcuts is a built-in automation app on every modern iPhone, iPad, and Mac. It lets you chain actions from a large library (Notes, Files, Web Requests, Notifications, and more) into a reusable recipe. The recipe is stored in iCloud and syncs across your Apple devices.

The Shortcut you build here:

1. Looks in the `Brain Capture` folder for every note with text content.
2. For each note, POSTs the text body to `open-brain-mcp/capture` with `"source": "apple-notes"` and a Bearer auth header.
3. Checks the response status. If the capture succeeded (`"captured"`), moves the note to `Brain Archived`. If it was a duplicate (`"duplicate"`), leaves the note alone.
4. Optionally shows a single summary notification when done.

Because Shortcuts cannot be exported to a file, there is no script to copy from the repo. You build the Shortcut interactively once, and it syncs to your other Apple devices automatically.

## Prerequisites

- **An Apple device on a recent OS.** iOS 14+, iPadOS 14+, or macOS 12+. The Shortcuts app is built in.
- **iCloud Notes enabled.** Settings → `[your name]` → iCloud → check that Notes is on. This lets notes sync across devices and is how the Shortcut sees them.
- **Your Supabase project ref.** The 20-character lowercase string from [`deploy-from-scratch.md`](../deploy-from-scratch.md) Step 2.
- **Your `MCP_ACCESS_KEY`.** Same value as in `.env`.

---

## Step 1. Create the two Notes folders

Open the Notes app on any Apple device. In the folder list (left sidebar on Mac, top navigation on iPhone), create two folders at the iCloud account level:

1. `Brain Capture`
2. `Brain Archived`

Both names are case-sensitive and the Shortcut matches them exactly. Create them under the iCloud account (not "On My iPhone" or any local-only location), so they sync to every device.

**What success looks like:** both folders appear in the Notes sidebar on every Apple device signed into the same iCloud account. Create a test note in `Brain Capture` from one device and confirm it shows up in the folder on another device within a minute.

**If it fails:**
- Folders created but do not sync: check Settings → `[your name]` → iCloud → Notes is enabled on every device. On Mac, also check System Settings → `[your name]` → iCloud → Notes.
- Typo in the folder name: the Shortcut will silently find zero notes. Delete and recreate with exact casing.

**Why this matters:** the folder names are baked into the Shortcut. Rename them in Notes and you have to rebuild the Shortcut's folder-selection actions to match.

---

## Step 2. Create a new Shortcut

Open the **Shortcuts** app.

- On **iPhone** or **iPad**: tap the **+** in the top right to create a new Shortcut.
- On **Mac**: click the **+** in the toolbar. Or use the menu: File → New Shortcut.

At the top of the editor, rename the Shortcut to **Brain Bank Notes Sync**. (The name is cosmetic; pick anything you like.)

**What success looks like:** you land in the Shortcut editor. The left pane (Mac) or full screen (iPhone) is empty; the right pane is the action library you drag from.

**If it fails:**
- "Shortcuts is not available": on a Mac, you need macOS 12 (Monterey) or later. Update macOS or use a newer device.
- You cannot find the action library: on iPhone, tap anywhere in the empty editor to surface the action picker.

---

## Step 3. Add the Find Notes action

Add the first action: **Find Notes**. Search the action library for `find notes` and tap/drag the result into the editor.

Configure the action:

- **Filter:** tap **Add Filter**, then set **Folder** **is** **Brain Capture**.
- **Sort by:** **Date Modified**, **Newest First** (optional; affects processing order but not behavior).
- **Limit:** leave off. You want every note in the folder to be processed every run.

**What success looks like:** the action reads `Find All Notes where Folder is Brain Capture sorted by Date Modified newest first`.

**If it fails:**
- The folder list in the filter picker does not include `Brain Capture`: iCloud Notes sync has not made it to this device yet. Wait a minute and retry, or pull-to-refresh Notes on this device first.
- The action shows `Find All Notes` with no filter at all: you skipped the Add Filter step. Tap into the action and configure the folder filter.

---

## Step 4. Add the Repeat loop and text extraction

Now wrap the matched notes in a loop and pull the body text from each one.

Add the action **Repeat with Each**. Search for `repeat with each` and add it. It will automatically connect to the output of **Find Notes** and iterate once per matched note. The variable name `Repeat Item` represents the current note inside the loop.

Inside the Repeat block, add a **Get Text from Input** action. Configure:

- **Input:** the `Repeat Item` magic variable (tap the variable picker and choose `Repeat Item`).

This extracts the plain text body of the current note, stripping formatting.

Below that (still inside the Repeat block), add an **If** action. Configure:

- **Input:** the text output from the previous step (the magic variable is usually called `Text` by default).
- **Condition:** `has any value`.

This guards against notes that are empty or image-only.

**What success looks like:** your Shortcut now reads in roughly this structure:

```
Find All Notes where Folder is Brain Capture
Repeat with Each item
    Get Text from Repeat Item
    If Text has any value
        [... next actions go here ...]
    End If
End Repeat
```

**If it fails:**
- The If action does not show `has any value` as a condition option: some older iOS versions only offer `is equal to`. Upgrade iOS or use `is not` `` (empty string) as the condition, which is equivalent.

---

## Step 5. Add the POST to Brain Bank

Inside the If block, add a **Get Contents of URL** action (search `get contents of url`).

Configure the action by tapping **Show More** to reveal all fields:

- **URL:** `https://<your-supabase-project-ref>.supabase.co/functions/v1/open-brain-mcp/capture`. Replace `<your-supabase-project-ref>` with your real Supabase ref. Leave the rest alone.
- **Method:** `POST`.
- **Headers:** tap **Add new header**. Add:
  - Key `Authorization`, Value `Bearer YOUR_BRAIN_KEY` (replace `YOUR_BRAIN_KEY` with the real value from `.env`).
  - Key `Content-Type`, Value `application/json`.
- **Request Body:** `JSON`. Add two fields:
  - Key `content`, Value: tap the variable picker and choose `Text` (the output of the Get Text action from Step 4).
  - Key `source`, Value: type the literal string `apple-notes`.

**What success looks like:** the action block shows the URL with your real project ref, method POST, two headers (Authorization and Content-Type), and a JSON body with `content` bound to the Text variable and `source` set to the literal `apple-notes`.

**If it fails:**
- You cannot find the `Text` variable to bind to `content`: you are outside the If block. Drag the Get Contents of URL action inside the If block so it has access to the Text variable.
- The source value keeps becoming a variable name instead of a literal string: tap the source value field, delete any variable pill, and type `apple-notes` as plain text.

**Why this matters:** the `source` field in the POST body is what tags every capture from this flow as `source = apple-notes` in the database. Without it, captures fall back to the default source (`chatgpt`). You want them tagged correctly so future filters like `source = apple-notes` in queries actually find them.

---

## Step 6. Handle the response and move on success

Still inside the If block, below the Get Contents of URL action, add:

1. **Get Dictionary Value** (search `get dictionary value`). Configure:
   - **Get:** `Value for`
   - **Key:** `status`
   - **Dictionary:** the `Contents of URL` magic variable (output of the previous action).

2. **If** (nested inside the outer If). Configure:
   - **Input:** the `Dictionary Value` variable.
   - **Condition:** `is` `captured`.

3. Inside that nested If, add **Move Note** (search `move note`). Configure:
   - **Note:** the `Repeat Item` magic variable.
   - **Destination folder:** `Brain Archived`.

Close that nested If.

**What success looks like:** your Shortcut structure now looks roughly like:

```
Find All Notes where Folder is Brain Capture
Repeat with Each item
    Get Text from Repeat Item
    If Text has any value
        Get Contents of URL (POST to Brain Bank)
        Get Dictionary Value: status from Contents of URL
        If Dictionary Value is "captured"
            Move Repeat Item to Brain Archived
        End If
    End If
End Repeat
```

**If it fails:**
- The **Move Note** action is not available in your action library: you are on an older iOS version that predates the Move Note Shortcut action. Workaround: delete the original note instead (use **Delete Notes** on `Repeat Item`). You lose the local archive but the content is safe in Brain Bank.
- The inner If fires even on `"duplicate"` responses: you set the condition to `has any value` by accident. Change to `is captured` exactly.

**Why this matters:** skipping the move on a `duplicate` response (rather than deleting or moving anyway) is what makes double-runs safe. If you accidentally run the Shortcut twice in a row, the duplicate check rejects the second POST, and the note stays put with no data loss. The alternative (moving every note whether it captured or not) makes two rapid runs indistinguishable, which is a footgun the next time you debug something.

---

## Step 7. Manual test run and database verify

You now have a complete Shortcut. Test it before scheduling.

1. In the Notes app, create a test note in the `Brain Capture` folder. Type a sentence that would stand out in search: `Testing Apple Notes to Brain Bank capture on <today's date>.`
2. Back in the Shortcuts app, open your Brain Bank Notes Sync Shortcut.
3. Tap the **Play** button (triangle icon) at the top. On first run, Shortcuts will prompt for permissions twice: once to read Notes, once to contact the external server. Grant both.
4. Wait a couple seconds. The Shortcut runs silently if no notifications were added.
5. Back in Notes, refresh the `Brain Capture` folder. The test note should be gone. Check `Brain Archived`; it should be there.

Now verify the row landed in the database:

```sql
select id, left(content, 100) as preview, metadata->>'source' as source, created_at
from thoughts
where metadata->>'source' = 'apple-notes'
order by created_at desc
limit 3;
```

**What success looks like:** the test note's text appears in `content`, `source = apple-notes`, and the note is in `Brain Archived` (not `Brain Capture`).

**If it fails:**
- **The note stayed in `Brain Capture` and the SQL query returns nothing:** the POST failed. Re-open the Shortcut, tap the clock icon at the bottom to see the most recent run history, and read the error. Most common: wrong URL (re-check project ref in Step 5), wrong key (re-copy from `.env`), or the `Authorization` header had a trailing space or smart-quote substitution (retype manually).
- **The note stayed in `Brain Capture` but the SQL returns a row with matching content:** the capture succeeded but the status-check condition in Step 6 did not fire. Open the run history and look at the response body; confirm `"status":"captured"` appears. If it says something else, adjust the nested If condition to match the real status string.
- **The note moved to `Brain Archived` but the SQL returns no row:** you are querying a different Supabase project. Verify the project ref in the Shortcut's URL matches the project you are querying.

**Why this matters:** running the test with a note you can recognize by its content (rather than a vague "test" or "hello") makes it obvious whether the right capture landed in the right database. If two test runs land in the database with identical content, the dedup check will silently suppress the second one, which can look like a failure from the Shortcut side when it is actually the dedup system working correctly.

---

## Step 8. (Optional) Schedule daily automation

The Shortcut runs on demand by default. If you want it to run unattended, add a Personal Automation.

On iPhone or iPad:

1. Open Shortcuts → tap the **Automation** tab at the bottom.
2. Tap **+** → **Create Personal Automation**.
3. Choose **Time of Day**. Set it to run once daily at a quiet hour (example: 6:00 AM, before your morning digest).
4. Tap **Next**. Tap **Add Action** → **Run Shortcut**. Pick your Brain Bank Notes Sync.
5. Tap **Next**. Turn off **Ask Before Running** so it runs silently.
6. Tap **Done**.

On Mac, the equivalent is in Shortcuts → File → New Automation → pick time-based trigger.

**What success looks like:** the Automation appears in the Automation tab marked **Enabled**. At the scheduled time, the Shortcut fires, notes in `Brain Capture` get captured, and successfully captured ones move to `Brain Archived` without any visible prompts.

**If it fails:**
- **Automation never fires:** Apple's time-based automations can be delayed if the device is locked and not plugged in, especially on iPhone. On a Mac, they are more reliable. If Brain Bank is a daily habit and missed runs are a problem, run the Shortcut manually once per day instead, or schedule it on a Mac that is always awake.
- **Automation fires but nothing happens:** open the Automation, confirm **Ask Before Running** is off (otherwise it silently waits for a prompt that never shows up on a locked device).

**Why this matters:** iOS and macOS treat time-based personal automations as best-effort. If you depend on nothing ever falling through the cracks, run the Shortcut manually on a cadence that fits your morning routine instead of trusting the automation to fire at an exact minute.

---

## End-to-end smoke

Wait a full day with the daily automation enabled (or run the Shortcut manually a few times). Then check three things:

1. **Notes side:** `Brain Capture` is empty or near-empty. `Brain Archived` has the notes that captured successfully.
2. **Database side:** the SQL query from Step 7 shows recent rows with `source = apple-notes` matching the notes you wrote over the last day.
3. **Shortcut run history:** open the Shortcut and tap the clock icon. Runs show completion times with no error indicators.

If all three line up, the pipe is healthy.

---

## Making Siri dictation easier

If you use Siri to dictate quick thoughts, you can skip the "move note to `Brain Capture`" step by making `Brain Capture` your default Notes folder:

- On **iPhone** or **iPad**: Settings → Notes → Default Account, pick your iCloud account. Then Default Folder → `Brain Capture`.
- On **Mac**: Notes → Settings → Default Account + Default Folder, same idea.

After that, saying "Hey Siri, note to self that..." creates a note directly in `Brain Capture`, and your next Shortcut run picks it up.

---

## What's next

You now have Apple Notes wired into Brain Bank with Shortcut-driven capture, automatic archive on success, and optional daily automation. Places to go from here:

- **Add more capture sources.** Apple Notes is one of several capture paths in `docs/capture-sources/`. Gmail, voice memos, and ChatGPT are all independent and add cleanly alongside this one.
- **Share the Shortcut across devices.** iCloud sync handles this automatically. If you set up the Shortcut on your iPhone, it appears on your Mac and iPad within a minute or two. You can run it from any of them.
- **Rotate `MCP_ACCESS_KEY`.** If you ever rotate the key, remember to open this Shortcut and update the `Authorization: Bearer ...` header. The old key stops working immediately after rotation.

If a step in this walkthrough does not work end-to-end, it is a doc bug, not a user bug. Open an issue on the repo.
