# Capture Notion rows with the Notion Sync routine

This walkthrough takes you from "Brain Bank is deployed and REST capture works" to "every morning at 4 AM, rows from my Notion databases land in Brain Bank automatically, tagged `source = notion-sync` in the database."

If you have not completed [`deploy-from-scratch.md`](../deploy-from-scratch.md) through Step 10 (the curl smoke test), stop and do that first. This walkthrough assumes your four Edge Functions are running against a healthy Supabase project and REST `/capture` works end-to-end.

Seven steps plus an optional CRM extension, about twenty to thirty minutes the first time.

## What you get by connecting Notion

- **Active projects and tasks in semantic memory.** Rows from a Notion "Projects" or "Tasks" database flow in as thoughts tagged `source = notion-sync`, so questions like "what am I working on this month?" find structured Notion context alongside chat messages and calendar events.
- **Daily refresh, no manual work.** A Claude Code routine fires on schedule (4 AM is a good default; early enough to feed a 6 AM morning digest). Brain Bank's SHA-256 dedup means unchanged rows cost nothing and re-running is safe.
- **One-line audit per run.** The routine posts a final summary thought ("N rows synced") so you can confirm the last run succeeded from the dashboard, the MCP `list_thoughts` tool, or a Slack search.
- **No app, no server, nothing on your machine.** The routine runs on Anthropic's infrastructure. Pause or delete it through the same UI you created it in.
- **Optional CRM extension.** If one of your Notion databases is a client-intake form, the same routine can chain `/client` calls so new contacts land in Brain Bank's `clients` table automatically. Covered in the Advanced section at the bottom.

## How it works

A Claude Code routine is a scheduled agent hosted by Anthropic. You create one at [claude.ai/code/routines](https://claude.ai/code/routines) by pasting a prompt and picking a schedule. On each run, a model (Claude Sonnet is a good default) executes the prompt inside an isolated sandbox with Bash and `curl` available. The prompt instructs the agent to:

1. Query one or more Notion databases over the Notion REST API using an integration token.
2. For each row, format a plain-English thought summary and POST it to Brain Bank's REST `/capture` endpoint with `source: "notion-sync"`.
3. Post a one-line summary thought at the end.

Credentials (your Notion token, Brain Bank URL, and Brain Bank key) live inside the prompt text. The prompt is private to your Claude account, same security model as any other stored credential.

---

## Step 1. Create a Notion internal integration

Open [notion.so/my-integrations](https://www.notion.so/my-integrations) and sign in with the Notion account that owns the databases you want to sync.

Click **New integration**. Fill in:

- **Name:** `Brain Bank Notion Sync` (or anything you like; cosmetic only).
- **Associated workspace:** pick the workspace that holds the databases.
- **Type:** Internal (the default).

Under **Content Capabilities**, check **Read content**. Leave **Update content** and **Insert content** unchecked; the routine only reads from Notion.

Leave **User Capabilities** at the default (No user information).

Click **Save**. The next screen shows a **Secret**. Click **Show** and copy the string that starts with `ntn_` (or `secret_` on older integrations). This is your `NOTION_TOKEN`. Paste it somewhere safe; you will need it again in Step 5.

**What success looks like:** you are on the integration settings page, the Internal Integration Secret is visible, and you have a copy of it.

**If it fails:**
- "Internal integrations are disabled for your workspace": your workspace admin has turned them off. You either need admin access or need to ask your admin to re-enable internal integrations, or to create one on your behalf.
- The secret appears truncated when you paste it: click **Show** again before copying. Notion's UI masks by default and partial copy-paste is a common mistake.

**Why this matters:** an internal integration token is scoped to your workspace and can only access databases you explicitly share with it (Step 2). It cannot read anything else in your Notion workspace. This is the safe, minimum-access setup.

---

## Step 2. Share each database with the integration

For each Notion database you want synced, open the database page in Notion (the full-page view, not inline inside another page).

Click the **`...`** menu in the top-right of the database, then **Connections** → **Connect to** → find and click **Brain Bank Notion Sync** (or whatever you named your integration in Step 1).

Notion pops up a confirmation. Click **Confirm** to share the database with the integration. The database now shows up in the integration's connections list.

Repeat for every database you want the routine to read. It is fine to start with one database and add more later by editing the routine prompt.

**What success looks like:** on each database's `...` → **Connections** menu, your integration is now in the **Connected to** list (with a small icon and a **Disconnect** option).

**If it fails:**
- The integration does not appear in the **Connect to** search results: wait thirty seconds and try again. Newly-created integrations sometimes take a moment to propagate. If still missing, refresh the page.
- "Your admin has restricted which integrations can be connected": your workspace admin maintains an allowlist. Ask them to allow your integration.
- You clicked **Disconnect** by accident: click **Connect to** again and pick the integration; the connection is additive, no data lost.

**Why this matters:** Notion integrations cannot read any database you have not explicitly connected. If the routine logs `object not found` or `404` in Step 6, the most common cause is that you created the integration but forgot to share the database with it.

---

## Step 3. Find each database ID

A Notion database ID is a 32-character hex string (sometimes shown with hyphens). You need one ID per database you want to sync.

Open the database in Notion as a full page. Look at the URL in your browser's address bar:

```
https://www.notion.so/your-workspace/My-Projects-abcdef0123456789abcdef0123456789?v=...
```

The 32-character string right before `?v=` is the database ID. You can copy it with or without hyphens; both work. In the example above, the ID is `abcdef0123456789abcdef0123456789`.

Alternative path: click the database's **`...`** menu → **Copy link**, paste the link into a scratchpad, and extract the same 32-character segment.

Repeat for every database you connected in Step 2. Keep them in a scratchpad labeled with what each one contains ("Projects DB", "Reading list", etc.). You will paste them into the routine prompt in Step 5.

**What success looks like:** you have a 32-character hex string per database, labeled with what the database contains.

**If it fails:**
- The URL looks like `notion.so/p/...` or `notion.site/...`: you are looking at a public web view, not the workspace URL. Sign in to Notion, open the same database from your sidebar, and copy the URL from inside the app.
- The string is shorter or longer than 32 characters: you copied the wrong segment. The database ID is always 32 characters (excluding optional hyphens).

---

## Step 4. Create a new routine at claude.ai/code/routines

Open [claude.ai/code/routines](https://claude.ai/code/routines) in a browser. Sign in with the Claude account that holds your paid plan.

Click **New routine** (or the plus icon). Fill in:

- **Name:** `Notion to Brain Bank sync` (or anything you like).
- **Schedule:** daily at 4:00 AM in your local timezone. You can pick any time, but the routine should finish before your 6 AM digest cron runs, so it contributes fresh data to that morning's digest.
- **Model:** Claude Sonnet is a good default. Sonnet handles the Notion-to-Brain-Bank translation reliably and costs less per run than Opus.
- **Connectors:** leave all off. Connectors display in the UI but do not inject tools into the routine's sandbox as of this writing, so the prompt uses curl directly.

Do not click **Save** yet; you need to paste the prompt first (Step 5).

**What success looks like:** you are on the routine editor page, the name and schedule are set, and the prompt box is empty (or has a default placeholder).

**If it fails:**
- "Routines are not available on your plan": routines require a paid Claude plan. Check [claude.ai/upgrade](https://claude.ai/upgrade) for plan details.
- The schedule picker shows only UTC times: set the schedule so that its UTC equivalent lands at 4 AM in your local timezone. For example, 4 AM Eastern Daylight Time is 8 AM UTC.

**Why this matters:** the routine fires once per schedule tick. If you miss a day (Anthropic maintenance, your account pauses), the next run still pulls every row that changed since last time because Brain Bank dedups by content hash. There is no missed-sync catch-up ritual; just let the next daily fire do its job.

---

## Step 5. Paste the prompt and fill in placeholders

Paste the block below into the routine's prompt box. Replace the five placeholders at the top (NOTION_TOKEN, BRAIN_BASE, BRAIN_KEY, DATABASE_ID, DATABASE_NAME) with your values.

```
You are a daily sync agent. Your job: pull rows from a Notion database and push them to Brain Bank via its REST API. Run silently, no unnecessary output.

CREDENTIALS (do not log or echo these):
NOTION_TOKEN=<paste-your-ntn_-secret-from-Step-1>
BRAIN_BASE=https://<your-project-ref>.supabase.co/functions/v1/open-brain-mcp
BRAIN_KEY=<paste-your-MCP_ACCESS_KEY-from-.env>

TARGET DATABASE (Projects):
DATABASE_ID=<paste-32-char-DB-id-from-Step-3>
DATABASE_NAME=Projects

STEP 1: Query the target Notion database
- POST to https://api.notion.com/v1/databases/$DATABASE_ID/query
- Headers: Authorization: Bearer $NOTION_TOKEN, Notion-Version: 2022-06-28, Content-Type: application/json
- Request body: an empty JSON object {} returns all rows up to 100 per page. Handle pagination via the has_more + next_cursor fields if needed.
- Optional filter: to scope by status, add a filter. Notion has TWO kinds of status-like column: "status" type and "select" type. The filter syntax differs:
    {"filter":{"property":"Status","status":{"equals":"In Progress"}}}   for status-type columns
    {"filter":{"property":"Status","select":{"equals":"Active"}}}        for select-type columns
  If you get a 400 with "status is not a valid property type" or similar, retry with the other variant and log which one worked.

STEP 2: For each row returned, capture a thought via POST /capture
- Extract the title: find the property whose type is "title" and concatenate its plain_text segments.
- Extract the Status value if present: look for a property named "Status" (case-insensitive). For select type, read .select.name. For status type, read .status.name. If absent, use "N/A".
- Extract Created: page.created_time (ISO 8601).
- Compose the thought content:
  "[Notion Sync] <title> -- Status: <status>. Created: <created_time>. Source: Notion <DATABASE_NAME> database."
- POST to $BRAIN_BASE/capture?key=$BRAIN_KEY:
  curl -s -X POST "$BRAIN_BASE/capture?key=$BRAIN_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"content\":\"<thought content>\",\"source\":\"notion-sync\"}"
- Expected success: HTTP 200 with {"status":"captured",...} or {"status":"duplicate",...}. Both are success; SHA-256 dedup is intentional.

STEP 3: Post a summary thought
- After all rows are processed, POST once more to /capture:
  "[Notion Sync] Daily sync complete (<YYYY-MM-DD>). <N> rows scanned from $DATABASE_NAME. <M> new thoughts captured, <D> duplicates skipped."

IMPORTANT RULES:
- Use curl for all API calls. Do not attempt to use MCP tools from inside the routine.
- Do not echo API tokens in output or logs.
- If a Notion API call fails, log the error response body and continue with the next item. Do not abort the entire sync on a single failure.
- If a /capture call returns a 4xx, log the response body and continue.
- On Notion rate limits (HTTP 429), sleep for the Retry-After header value and retry the same request.
```

To sync more than one database, duplicate the `TARGET DATABASE` block and the `STEP 1` / `STEP 2` / `STEP 3` sequence per database, or instruct the agent to loop over an array of `{id, name}` pairs. Keep each database's summary thought distinct so audits stay readable.

Click **Save** once placeholders are filled in.

**What success looks like:** the routine is saved, the prompt box shows your edited text, the schedule is set, and the routine status is **Scheduled** (or equivalent "active" state in the UI).

**If it fails:**
- Save button rejects the prompt as "too long": Claude Code routines have a prompt length limit (typically tens of thousands of characters; well above the template above). If hit, move the credentials block to the routine's environment variable fields (if that UI surface exists for your account) or trim any extra databases you listed.
- Prompt validation complains about unescaped characters: this template uses backslash-quoted JSON inside double-quoted curl payloads. If your paste mangled the escapes, paste it again from the source block above.

**Why this matters:** the prompt is the routine's entire program. You can edit it later to tune filters, add new databases, or extend it (the /client extension in the Advanced section below is a direct addition to this prompt).

---

## Step 6. Run the routine manually once to test

Most routine UIs include a **Run now** button (or **Test** or **Trigger**). Click it. The run usually completes in one to three minutes depending on how many rows your databases contain.

When the run finishes, the UI displays the agent's output (captures, errors, summary). Look for:

- One "captured" or "duplicate" response per row in the target database.
- A final summary line listing the N/M/D counts.
- Zero Notion error bodies (or, if the routine hit a 400 on a status filter, a line stating that it retried with the other variant and succeeded).

**What success looks like:** the routine output lists N rows processed, the final summary thought was POSTed, and the summary counts sum cleanly (`captured + duplicate = N`).

**If it fails:**
- 401 Unauthorized from Notion: `NOTION_TOKEN` is wrong or the database was not shared with the integration in Step 2. Fix the token or share the database, then re-run.
- 404 Not Found from Notion on `/databases/<id>/query`: the database ID is wrong (typo) or the database is in a different workspace than the integration. Re-copy the ID from Step 3, confirm the integration's associated workspace in Step 1.
- 400 on a status filter for both `status` and `select` variants: your column is probably not named `Status`, or it is a different property type (multi_select, relation). Remove the filter for now (empty `{}` body), get the sync working, then re-add a filter once you know the exact property type from the raw Notion response.
- 401 or 403 from Brain Bank on /capture: `BRAIN_KEY` in the prompt does not match `MCP_ACCESS_KEY` in your `.env`. Copy the value fresh from your `.env` file. Remember that Supabase secrets and `.env` have to agree; if you recently rotated the key, re-run `supabase secrets set --env-file .env --project-ref <ref>` and re-paste the new value into the routine prompt.

---

## Step 7. Verify via SQL

Once the routine run finishes cleanly, open the Supabase SQL editor and run:

```sql
select id, content, metadata->>'source' as source, created_at
from thoughts
where metadata->>'source' = 'notion-sync'
order by created_at desc
limit 20;
```

You should see one row per Notion row captured, plus the summary thought at the top of the list.

Cross-check the count against the routine output. If you synced 14 Notion rows and the routine reported 14 captures, you should see 15 rows here (the summary thought is row 15).

**What success looks like:** rows with `source = notion-sync` appear in the `thoughts` table, newest first, content starts with `[Notion Sync]`.

**If it fails:**
- Zero rows returned: the routine ran but every row hit a 4xx on capture (check the routine output for errors). Or the routine completed with `source` missing from the body (verify Step 5 template); in that case, captures have `source = chatgpt` per the default-source fallback.
- Rows returned but with `source = chatgpt` (not `notion-sync`): the `source` field was not included in the POST body. Re-check Step 5 template; the payload must include `"source":"notion-sync"`.
- Summary thought missing: the routine aborted before Step 3 in the prompt fired. Usually a 429 or 500 partway through. Re-run manually and check the output tail.

---

## Advanced: CRM-shaped workspaces (chaining `/client` per intake row)

Skip this section unless one of your Notion databases is a client intake form. For typical project or reading-list databases, the core walkthrough above is enough.

If you run a client-intake workflow in Notion (rows with name, email, phone, date-submitted), Brain Bank has a generic `/client` endpoint that deduplicates contacts by name (case-insensitive) and upserts a row into the `clients` table. You can chain a `/client` call per intake row from the same routine, so new contacts land in Brain Bank's contacts layer at the same time they get captured as thoughts.

To extend the routine, add the block below to your prompt between STEP 2 and STEP 3:

```
STEP 2.5 (OPTIONAL, CRM shape only): If the TARGET DATABASE looks like a contact intake form (has a title that is a person's name, plus email/phone properties), also call /client for each row.

- Extract the person's name. For simple cases this is the title itself. Watch for these quirks:
    - If the title follows a pattern like "Alex Rivera - kitchen remodel" (name, separator, project description), take only the part before the first " - ".
    - If the title ends in the word "intake" or "Intake" (case-insensitive), strip that suffix.
    - If the name does not look like a person's name (more than 4 words, contains a colon, contains a project-sounding phrase), skip the /client call for that row rather than creating a bad record.
- Extract email and phone from properties of the right type (email and phone_number). If absent, use null.
- POST to $BRAIN_BASE/client?key=$BRAIN_KEY:
  curl -s -X POST "$BRAIN_BASE/client?key=$BRAIN_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"<person-name>\",\"email\":<email-or-null>,\"phone\":<phone-or-null>,\"notes\":\"Intake: <row-title>. Submitted: <created_time>.\",\"first_contact\":\"<created_time as YYYY-MM-DD>\"}"
- Expected success: {"status":"created"} for new contacts, {"status":"exists"} for already-known names. Both are success; the endpoint is idempotent and safe to re-run.
```

Verify via SQL after your next manual run:

```sql
select id, name, email, phone, first_contact, last_contact
from clients
where created_at >= now() - interval '1 hour'
order by created_at desc;
```

**Gotchas to watch for:**

- **Bad name extraction creates bad rows.** The heuristics above are conservative on purpose; when in doubt, skip rather than insert. If you find a bad row, delete it with `delete from clients where id = '<id>'` and tighten the parsing rule in the prompt.
- **The `/client` endpoint is case-insensitive on dedup.** "Alex Rivera" and "alex rivera" are treated as the same person. Good for CRM; avoid using case to disambiguate unrelated people with the same name.
- **Schema variance.** If your intake database has unusual property names (a "Full Name" property instead of using the title, a "Work Phone" instead of "Phone"), the agent will not find them. Adjust the extraction rules to match your schema.

---

## Tuning for large databases

The default prompt queries with an empty body, which returns every row in the database (up to 100 per page, paginated). For databases with a few hundred rows this is fine; for databases with thousands, use a filter.

Two good filter patterns:

**Only recently-modified rows.** Scope the query to rows that changed in the last 48 hours so the daily sync stays fast even as the database grows.

```json
{
  "filter": {
    "timestamp": "last_edited_time",
    "last_edited_time": { "past_day": {} }
  }
}
```

**Only active rows.** Scope by status so archived or completed rows do not re-capture every day (SHA-256 dedup handles this, but filtering earlier is cheaper).

```json
{
  "filter": {
    "property": "Status",
    "status": { "does_not_equal": "Archived" }
  }
}
```

Paste either block into the curl body for the Notion query in STEP 1 of your prompt. Notion's filter syntax is documented at [developers.notion.com/reference/post-database-query-filter](https://developers.notion.com/reference/post-database-query-filter).

---

## Rotating credentials

If you rotate `MCP_ACCESS_KEY` (Brain Bank) or regenerate your Notion integration secret:

1. Update your `.env` file (for `MCP_ACCESS_KEY`) or Notion integration settings (for the Notion secret).
2. For Brain Bank, re-run `supabase secrets set --env-file .env --project-ref <ref>` so the Edge Function reads the new value.
3. Open the routine at [claude.ai/code/routines](https://claude.ai/code/routines), click **Edit**, and paste the new secret into the corresponding line of the prompt.
4. Click **Save**. The next scheduled run (or a manual test run) uses the new credential.

Brain Bank does not support dual-key grace windows for routine prompts out of the box; if you need zero-downtime rotation, coordinate with the caller (schedule the rotation for when the routine is not mid-run, which is easy since it fires once a day).

---

## Decommissioning

To stop the sync entirely:

1. Open [claude.ai/code/routines](https://claude.ai/code/routines), find the routine, and click **Delete** (or **Pause** if you want to keep the prompt around for reference).
2. Optionally revoke the Notion integration at [notion.so/my-integrations](https://www.notion.so/my-integrations) so the token can no longer query Notion.
3. Existing rows in the `thoughts` table stay put; run `delete from thoughts where metadata->>'source' = 'notion-sync'` if you want to remove them.
