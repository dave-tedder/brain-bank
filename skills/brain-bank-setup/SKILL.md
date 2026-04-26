---
name: brain-bank-setup
description: Use when the operator types `/brain-bank-setup`, OR when Claude is invoked inside a brain-bank clone and detects a fresh, unconfigured state (no `profile.json`, no `.env`, and no `supabase/.temp/project-ref`). Guides a first-time deploy from zero to a successful smoke test, with optional Slack and cron-digest branches.
---

# brain-bank-setup

Guides a first-time brain-bank operator from cold clone to first captured thought in one sitting. Compresses `docs/deploy-from-scratch.md` (12 steps) + `docs/slack-setup.md` (9 steps) into a conversational wizard with resume support.

## When this skill fires

Two trigger conditions:

1. **Explicit:** operator types `/brain-bank-setup` in Claude Code.
2. **Auto-detect:** Claude is invoked inside a brain-bank clone and detects a fresh, unconfigured state (no `profile.json`, no `.env`, no `supabase/.temp/project-ref`). All three absent together is a strong signal of a never-touched clone.

On fire, greet the operator:

> "I'll guide you through setting up brain-bank from scratch. Core deploy takes 30-60 minutes. Slack add-on is optional (~20 min). Scheduled morning digest is optional (~5 min). I'll ask for things as we go. One ground rule up front: I won't ask you to paste API keys or tokens into this chat; we'll put them in `.env` (gitignored) and I'll read them through shell tools. More on that when we hit the first secret. Ready?"

Wait for confirmation, then run pre-flight.

## Pre-flight toolkit check

First action: verify the operator's toolkit. One Bash call:

```bash
which node && which git && which supabase && node --version | head -1 && \
  { which pbcopy || which xclip || which clip || which clip.exe; } && echo "toolkit OK"
```

Passes silently if all present and Node >= 18. On failure:

- **`which supabase` empty:** platform-matched install instructions.
  - macOS: `brew install supabase/tap/supabase`
  - Linux: `curl -fsSL https://supabase.com/install.sh | sh`
  - Windows (Git Bash): download the installer from [supabase.com/docs/guides/cli](https://supabase.com/docs/guides/cli#installation)
- **Node < 18:** link to [nodejs.org](https://nodejs.org) with "install v20 LTS".
- **No clipboard tool:** mac should have `pbcopy` pre-installed; Linux `sudo apt install xclip` (Debian/Ubuntu) or `sudo dnf install xclip` (Fedora); Git Bash has `clip`; pure PowerShell/cmd.exe is unsupported for v1, use Git Bash or WSL.

Halt if pre-flight fails. Do not proceed to state scan until all checks pass.

## State scanning + resume logic

After pre-flight passes, run a single state scan. This is one Bash call that probes every "what step did we reach last time" signal without reading raw secret values:

```bash
cd "$(git rev-parse --show-toplevel)" && {
  echo "profile=$([ -f supabase/functions/_shared/profile.json ] && echo yes || echo no)"
  echo "env_required=$(grep -cE '^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|OPENROUTER_API_KEY|MCP_ACCESS_KEY)=.+' .env 2>/dev/null || echo 0)"
  echo "env_slack=$(grep -cE '^SLACK_(BOT_TOKEN|CAPTURE_CHANNEL)=.+' .env 2>/dev/null || echo 0)"
  echo "linked=$([ -f supabase/.temp/project-ref ] && echo yes || echo no)"
  echo "project_ref=$(cat supabase/.temp/project-ref 2>/dev/null || echo '')"
}
```

If `profile=yes`, additionally validate it parses:

```bash
python3 -m json.tool supabase/functions/_shared/profile.json >/dev/null 2>&1 || echo "profile=invalid"
```

### Resume decision tree

| Signal | Resume at |
|---|---|
| All checks negative (fresh clone) | Step 1 (intro + expectations) |
| `profile=no`, others any | Step 3.5 (profile Q&A) |
| `profile=invalid` | Step 4 repair branch: "your profile.json exists but doesn't parse. Want me to show you the error, fix it together, or start fresh?" |
| `profile=yes`, `env_required<4` | Step 5 (gather core secrets) |
| `env_required=4`, `linked=no` | Step 3 (`supabase login` + `link`) |
| `env_required=4`, `linked=yes`, migrations not applied | Step 7 (`supabase db push`) |
| Migrations applied, functions not deployed | Step 9 (deploy 4 functions) |
| Functions deployed, no captured thought | Step 10 (smoke test) |
| Smoke test passed, Slack branch not done | Post-core Slack branch menu |
| Slack done or skipped, cron branch not done | Cron branch menu |
| Everything done | Diagnostic mode: "Already set up. Verify deploy is still healthy?" |

### Deferred checks (run only when needed)

Two probes are too expensive for the opening scan:

1. **Migrations applied.** Run `supabase db push --dry-run` inline at the moment we need to know. Only relevant if `linked=yes`.
2. **Functions deployed.** Run `curl -s -o /dev/null -w "%{http_code}" https://<ref>.supabase.co/functions/v1/open-brain-mcp` inline. 401 means deployed, 404 means not.

### Resume announcement

When resuming past step 1, always tell the operator where you're picking up:

> "Looks like you got through [Step N] last time. Picking up at [Step N+1]: [description]. If something went wrong with [Step N] and you want to redo it, say 'restart from step N' and I'll wipe the prior state for that step and retry."

This gives an escape hatch if the scan mis-detected state.

## Secrets-in-chat pattern

### First-secret teaching block

Fires once, before the first core secret is gathered (typically `SUPABASE_SERVICE_ROLE_KEY` at Step 5). Say to the operator:

> **A note on how we handle secrets, before we start collecting them.**
>
> I'm not going to ask you to paste API keys or tokens into this chat. Here's why that matters:
>
> Anything you type here gets stored in the Claude transcript on your disk (`~/.claude/projects/...`). That's fine for you (nobody else can read it), but it builds a habit of treating chat as a secret-safe surface, and that habit will bite someone the first time they screenshot a chat to share a bug, or copy-paste a snippet into a public Discord.
>
> Instead, every time I need a secret, I'll ask you to paste it into `.env` at the repo root. That file:
> - Is already in `.gitignore`, so it never gets committed to GitHub.
> - Lives on your local disk only; nothing uploads it anywhere.
> - Is readable by me through shell tools when I need to push it to Supabase, but I won't read its raw contents back into our conversation.
>
> One more thing: don't take screenshots of Supabase dashboard pages showing API keys. Paste them into `.env` manually.
>
> **Editor heads-up:** open `.env` in a terminal editor (`nano`, `vi`, `vim`) or a code editor (VS Code, Sublime, etc.). On macOS, do NOT use TextEdit. TextEdit silently fails to save dot-prefixed files, reporting "Save successful" but writing nothing to disk. The shape-check grep below will catch this (returns 0 even though you "saved"), but you'll save time by avoiding TextEdit up front.
>
> For each secret, I'll:
> 1. Tell you exactly where to find it in the relevant dashboard.
> 2. Give you the line to paste into `.env`.
> 3. Verify the shape is right via a shell check that prints only "OK" or a specific failure pointer.
>
> Ready to continue?

Run this block exactly once, on the first secret gathered. On subsequent secrets, skip to the per-secret compressed flow.

### Per-secret compressed flow

After the teaching block runs, each subsequent secret uses this pattern:

```text
Claude: "Next secret: OPENROUTER_API_KEY.
  Where: openrouter.ai, Keys, Create Key.
  Add this line to .env: OPENROUTER_API_KEY=<your key>
  Let me know when saved."
Operator: "saved"
Claude: [Bash: grep -cE '^OPENROUTER_API_KEY=sk-or-.{20,}' .env]
Bash output: "1"
Claude: "OK, key shape looks right. Moving on."
```

Failure (grep returns 0):

```text
Claude: "I don't see a well-formed OPENROUTER_API_KEY in .env yet.
  Expected shape: starts with 'sk-or-' and at least 20 chars after.
  Possible causes: key wasn't saved yet, or you pasted the wrong key.
  Open .env and check the OPENROUTER_API_KEY line. Let me know when fixed."
```

### Shape-check grep patterns

One entry per secret. Never echo the matched value; `grep -c` returns counts only.

| Secret | Shape regex | Guards against |
|---|---|---|
| `SUPABASE_URL` | `^SUPABASE_URL=https://[a-z0-9]{20}\.supabase\.co$` | Missing value, wrong ref format |
| `SUPABASE_SERVICE_ROLE_KEY` | `^SUPABASE_SERVICE_ROLE_KEY=(eyJ.{100,}|sb_secret_.{20,})$` | Anon key instead (legacy `eyJ` anon or modern `sb_publishable_*`), truncated paste |
| `OPENROUTER_API_KEY` | `^OPENROUTER_API_KEY=sk-or-.{20,}` | Wrong provider, short paste |
| `MCP_ACCESS_KEY` | `^MCP_ACCESS_KEY=[a-f0-9]{64}$` | Openssl ran on wrong line, not 32-byte hex |
| `SLACK_BOT_TOKEN` | `^SLACK_BOT_TOKEN=xoxb-.{40,}` | User token instead of bot |
| `SLACK_SIGNING_SECRET` | `^SLACK_SIGNING_SECRET=[a-f0-9]{32}$` | Wrong app's secret |

### Special cases

**`MCP_ACCESS_KEY` generation** (Step 5, last core secret). The skill generates this; operator doesn't gather it:

```bash
echo "MCP_ACCESS_KEY=$(openssl rand -hex 32)" >> .env
```

Stdout is empty. The value goes straight to .env; Claude never sees it. Shape-check grep confirms it landed.

**Vault mirror clipboard pattern** (cron branch only, Task 4). Platform-detected:

```bash
case "$(uname -s)" in
  Darwin)        CB=pbcopy ;;
  Linux)         command -v clip.exe >/dev/null && CB=clip.exe || CB=xclip ;;
  MINGW*|MSYS*|CYGWIN*) CB=clip ;;
esac
grep '^MCP_ACCESS_KEY=' .env | cut -d= -f2 | tr -d '\n' | $CB && echo "on clipboard"
```

Operator pastes from clipboard into Supabase SQL editor. Value on clipboard ~30 seconds, not in chat.

### Skill-side prohibitions

- **Never** `Read .env` directly (puts values in Claude's context).
- **Never** echo a secret value in reply text.
- **Never** construct curl commands with secrets inline; use `source .env && curl ...` patterns so the shell substitutes the value without it ever landing in a chat-visible string.
- **Never** copy `.env` contents into a spec, summary, or commit message.

## Core conversational flow (Steps 1-10)

Each of deploy-from-scratch.md's Steps 1-10 becomes a conversational beat. The skill orchestrates; `docs/deploy-from-scratch.md` remains the authoritative prose reference. Profile Q&A inserts at **Step 3.5** (after CLI link, before .env) because the Q&A produces the profile.json content.

| Step | Claude says (compressed) | Claude runs / checks | Operator does |
|---|---|---|---|
| **1. Clone** | "You're in the repo already (the skill only fires inside a brain-bank clone), so clone is done. Moving on." | `ls README.md supabase profile.example.json` to confirm structure. | Nothing. |
| **2. Create Supabase project** | "Open [supabase.com/dashboard](https://supabase.com/dashboard), New Project. Name: whatever you like. Password: save to your password manager. Region: closest to you. Free tier. Takes ~2 min to provision." Link + two bullets on what to copy back (Reference ID, API URL). **Already-have-a-project path:** "If you already have an empty Supabase project you want to use, paste the 20-char Reference ID instead of creating a new one. 'Empty' means no `thoughts` table yet (Step 7 will apply the 11 migrations; it will fail loudly if the schema already exists, which is fine, you're not resuming a prior install here)." | When operator confirms project ready, ask for the project ref. Validate shape with regex `^[a-z0-9]{20}$`. If the ref doesn't match that pattern, say: "That looks like a URL or the wrong format. The ref is 20 lowercase letters and numbers, found at Dashboard > Project Settings > General > Reference ID. It looks like `abcdefghij1234567890`." | Click through dashboard, paste project ref when prompted. Or paste the ref of an existing empty project. |
| **3. Link the CLI** | "Running `supabase login`: browser will open. Then `supabase link --project-ref <your-ref>`. The CLI may or may not prompt for your DB password here, depending on version. v2.75+ defers the password prompt to Step 7 (`supabase db push`); have it ready either way." | `supabase login` via Bash (opens browser, blocks until auth). Then `supabase link --project-ref $REF`. Check `ls supabase/.temp/project-ref`. | Approves browser auth, pastes DB password if prompted (here or at Step 7). |
| **3.5. Profile Q&A** | [Full Q&A catalog below] | After last question, write `supabase/functions/_shared/profile.json` via Write tool. **The bundler requires this exact path**: `loadProfile()` in `_shared/profile.ts` imports `profile.json` as a sibling module (`import profileDefaults from "./profile.json" with { type: "json" }`), and the Supabase CLI bundler resolves imports relative to the source file. A `profile.json` at repo root (or anywhere else) is invisible to the bundler and every deploy 400s with `Module not found`. Run `python3 -m json.tool supabase/functions/_shared/profile.json > /dev/null` to verify it parses. | Answer 13 questions (accept defaults on 10-13). |
| **4. Confirm profile.json** | "Your `profile.json` is written. Verifying it parses." | Already verified in 3.5. Just announce. | Nothing. |
| **5. Gather core secrets into .env** | **First-secret teaching block fires here.** Then walks through 4 secrets: SUPABASE_URL (auto-derived from project ref; skill writes it, operator just confirms), SUPABASE_SERVICE_ROLE_KEY (teach: "service_role key, NOT anon: dashboard, Project Settings, API, service_role, Reveal"), OPENROUTER_API_KEY (teach: "set monthly spend cap in OpenRouter dashboard FIRST, then create key"), MCP_ACCESS_KEY (skill generates via `openssl rand -hex 32`). | `cp .env.example .env` if .env missing. For SUPABASE_URL: `sed -i.bak "s|^SUPABASE_URL=.*|SUPABASE_URL=https://$REF.supabase.co|" .env && rm -f .env.bak` (replaces the placeholder line in place; the `.bak` suffix keeps the sed call portable between GNU sed and BSD sed on macOS). For the other three secrets: shape-check greps after each paste. | Create OpenRouter account + spend cap, gather service_role key from Supabase dashboard, paste both into .env. |
| **6. Push secrets to Supabase** | "Pushing your .env to Supabase secrets store. Heads up: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are platform-auto-injected at Edge Function runtime; the CLI refuses to push any name starting with `SUPABASE_` and prints `Env name cannot start with SUPABASE_, skipping: ...` for each one. That warning is expected; the functions still get both values at runtime." | `supabase secrets set --env-file .env --project-ref $REF` (expect two `skipping: SUPABASE_*` warning lines on stderr), then `supabase secrets list --project-ref $REF` to confirm the non-`SUPABASE_` names appear: `OPENROUTER_API_KEY`, `MCP_ACCESS_KEY`, plus any `SLACK_*` if the Slack branch ran. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` will NOT appear in the list; that's correct. | Nothing. |
| **7. Run migrations** | "Applying 11 migrations (schema + RPC)." | `supabase db push`. Check output for `Finished supabase db push.` | Nothing. Failures route to `references/error-recovery.md`. |
| **8. Vault mirror** | **Skipped in core flow.** Only happens if operator says yes to cron branch. | | |
| **9. Deploy 4 Edge Functions** | "Deploying ingest-thought, open-brain-mcp, brain-digest, compile-pages. Takes ~1 min total." | Four sequential `supabase functions deploy <name> --no-verify-jwt --project-ref $REF` calls (the `--no-verify-jwt` flag is required because these functions authenticate inbound callers via their own key scheme: `MCP_ACCESS_KEY` for the MCP/REST path and Slack Signing Secret for the Slack path; without the flag, every inbound call returns 401 before it even reaches the function's own auth check). Check each: CLI process exits 0 AND stdout contains a `supabase.com/dashboard/project/` URL (stable across CLI versions). The literal success banner has drifted between `Deployed Function` (older CLI) and `You can inspect your deployment in the Dashboard` (v2.75+); don't regex-match the banner itself. | Nothing. If `A profile.json file is required` or `Module not found "...supabase/functions/_shared/profile.json"`: skill re-verifies `ls supabase/functions/_shared/profile.json` (NOT repo root; the bundler reads only the `_shared/` sibling) and retries. |
| **10. Smoke test** | "Testing the REST capture path with a placeholder thought." | Construct curl via `source .env && curl -X POST "$SUPABASE_URL/functions/v1/open-brain-mcp" -H "x-brain-key: $MCP_ACCESS_KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{...}}'`. The `source .env` is required before the curl; without it the shell has no value for `$SUPABASE_URL` or `$MCP_ACCESS_KEY` and the curl call hits a malformed URL. Header auth (`x-brain-key`) is the recommended path because URL-parameter auth (`?key=$MCP_ACCESS_KEY`) gets logged plaintext into Edge Function request logs. The `Accept: application/json, text/event-stream` header is required by the MCP Streamable HTTP transport; without it the server returns `Not Acceptable: Client must accept both application/json and text/event-stream`. Secret never in chat text. Response is SSE-formatted (`event: message` / `data: {...}`); parse for substring `"Captured"` inside the data payload (actual text is `"Captured as observation - [topics]"` with auto-resolved topic labels, not a bare `"Captured."`). | Run `select count(*) from thoughts;` in Supabase SQL editor, paste count (a number, not a secret) back to Claude. |

After Step 10 passes: **"Core deploy complete. You've got a working brain bank."** Then present the post-core branch menu.

### `supabase db push` partial-run handling

If `supabase db push --dry-run` during resume detects a partial state (some migrations applied, some not): "Looks like migrations partially applied. Safest reset is to delete this Supabase project and create a new one; the free tier lets you do this in 60 seconds. Want me to walk you through that, or would you rather drop specific tables manually?"

## Profile Q&A catalog

Runs at **Step 3.5**. Flows as one continuous conversation, one question per exchange. Fields 1-9 are day-one (must answer); fields 10-13 offer "accept default? (y/n)" skips.

### Day-one fields (1-9), must answer

| # | Field | Question (literal) | Validation |
|---|---|---|---|
| 1 | `operator.name` | "What name should the digest use when referring to you? (first name is fine, e.g., 'Dave', 'Jamie')" | Non-empty string |
| 2 | `operator.emails` | "What email addresses are 'you'? List all: work, personal, aliases. Separate with commas." | Each segment matches `^[^@\s]+@[^@\s]+\.[^@\s]+$` |
| 3 | `example_domain` | "What's the primary domain for your work or business? (e.g., `tedderfamilytattooing.com` or `jamiesblog.com`)" | `^[a-z0-9.-]+\.[a-z]{2,}$` |
| 4 | `example_projects` | "Name three of your active projects. Separate with commas; short names are fine." | Exactly 3 non-empty segments after split |
| 5 | `example_person_name` | "What's a name the engine might see often in your captures? A regular client, coworker, or family member. (Just 'Firstname Lastname'.)" | Non-empty, has a space |
| 6 | `persona.digest` | "How would you describe what you do in one short phrase? Start with 'a' or 'an'. Examples: 'a tattoo artist', 'a product manager at a healthtech startup'." | Starts with `a ` or `an ` |
| 7 | `persona.compile_pages` | "What is your wiki for? One phrase. Examples: 'my tattoo business knowledge base', 'my research notes on ocean acidification'." | Non-empty string |
| 8 | `domain.singular_noun` + `domain.plural_noun` | "What do you call one unit of your core work? Singular and plural, separated by slash. Examples: 'tattoo appointment / tattoo appointments'. Default: 'client session / client sessions'." | 2 non-empty segments split on `/` |
| 9 | `domain.vocabulary` | "List 3-5 words that show up a lot when you're writing about your actual work. Example for a tattoo artist: 'tattoo, client, consult, flash, sitting'. Default: 'work, project, client'." | 3-5 comma-separated non-empty strings |

### Default-offered fields (10-13), A2-lite

| # | Field | Default | Question |
|---|---|---|---|
| 10 | `event_types` | `["event", "meeting", "travel", "maintenance"]` | "Non-client event types. Defaults shown. Keep defaults (y/n)?" |
| 11 | `client_event_types` | `["client_session", "consultation", "business"]` | "Client-related event types. Defaults shown. Keep defaults (y/n)?" |
| 12 | `content_types` | `["photo", "video", "article"]` | "Content types for things you log. Defaults shown. Keep defaults (y/n)?" |
| 13 | `mechanical_capture_prefixes` | `[]` | "Advanced: prefixes marking a thought as 'mechanical' (skip auto-resolve). Default: empty list. Keep default (y/n)?" |

**If the operator answers `n`** on any of fields 10-13, the follow-up prompt is:

> "List your custom values, comma-separated. Example for field 10: `event, meeting, travel, maintenance, workout`."

Validation: split on commas, trim whitespace, reject empty strings and any entry containing a space or non-`[a-z0-9_-]` character (these become JSON array members consumed by LLM prompts and Edge Function enum checks; hyphens and underscores allowed, spaces disallowed). If validation fails, re-prompt with the specific offending token: "`check up` has a space in it; enum values need to be single tokens. Try again or type 'default' to accept the default."

For field 13 (`mechanical_capture_prefixes`) the prompt ends with a colon hint: `"List prefixes, comma-separated (e.g., 'todo:, note:, idea:')."` Trailing colon is expected; don't strip.

### Write safety

After all 13 answered, construct JSON in memory and write via the Write tool. Before write:

1. **If `profile.json` exists** (shouldn't, state scan would skip Q&A; defensive check): present 3 options: (a) skip and keep current, (b) overwrite from Q&A, (c) diff and decide.
2. **Validate JSON parses:** in-memory construct through indented serialization.
3. **Schema sanity:** top-level keys of written content must match `profile.example.json`'s top-level keys.

After write, `python3 -m json.tool supabase/functions/_shared/profile.json > /dev/null && echo "valid"` as a final sanity check.

### Stuck-operator fallbacks

If operator says "skip" or "don't know" on a field:

- **Fields 1-5** (identity / examples): "These just feed LLM prompts as examples. 'Jamie', 'jamiesblog.com', '[A, B, C]' works. Editable later."
- **Fields 6-7** (persona): "Defaults 'a knowledge worker' / 'a personal knowledge base' are fine."
- **Fields 8-9** (domain): "Defaults are fine unless your work is organized differently."

Fields 6, 8, 9 still can't reasonably be skipped (they go into actual prompt text). Insist politely: "This one's needed; a short answer is fine."

### Post-Q&A message

Say to the operator:

> "profile.json written at `supabase/functions/_shared/profile.json` (the path the Edge Function bundler reads). You can edit it anytime; just make sure the JSON stays valid (`cat supabase/functions/_shared/profile.json | python3 -m json.tool` parses it). Changes take effect on the next Edge Function deploy."

## Post-core branch menu

After Step 10 smoke test passes, present this menu:

```text
Core deploy complete; one captured thought in the database. Want to wire Slack?

  1. Walk me through it (guided: I'll Read references/slack-branch.md and run you
     through the 9 steps, asking for values and handling the shell work)
  2. Point me at docs/slack-setup.md (I'll open it and do it myself)
  3. Skip Slack for now
```

On `1`: Read `references/slack-branch.md` and run that sub-flow (Task 3 wires this up).
On `2`: `open docs/slack-setup.md`, then say "Paste me any Step 8 or Step 9 error and I'll diagnose."
On `3`: proceed to the cron branch menu.

After Slack branch completes (or is skipped), present:

```text
Want to schedule the morning digest? This wires pg_cron inside Postgres to:
  * Post a daily digest to Slack at 6 AM ET (or your timezone)
  * Post a weekly digest Monday 6 AM ET
  * Compile wiki pages nightly

Three options:
  1. Walk me through it (guided: vault secret + 4 cron jobs via SQL I'll give you)
  2. Point me at docs/deploy-from-scratch.md Step 12 (I'll do it myself)
  3. Skip scheduled digests
```

On `1`: Read `references/cron-branch.md` and run that sub-flow (Task 4 wires this up).
On `2`: `open docs/deploy-from-scratch.md`, point at Step 12.
On `3`: wrap up.

When wrapping up:

> "Setup complete. Capture your first real thought with `source .env && curl -X POST "$SUPABASE_URL/functions/v1/open-brain-mcp" -H "x-brain-key: $MCP_ACCESS_KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"capture_thought","arguments":{"content":"hello world","source":"rest"}}}'` or wait for the morning digest if you scheduled it. Operating guide: `docs/troubleshooting.md` when things break."

**Both branches are live.** Slack: `references/slack-branch.md`. Cron: `references/cron-branch.md`. On-failure routing uses `references/error-recovery.md`.

## Flow conventions

### Confirmation after each beat

After each flow step's shell call returns, announce: "Step N done: [one-line summary of what's now true]." Wait for operator to acknowledge before proceeding. Operator can interject any time.

### Failure routing

On any step failure:

1. Read `references/error-recovery.md`.
2. Find the entry for the current step.
3. Apply the inline diagnosis (shell check, log grep, state inspection).
4. If the failure matches a documented recipe in `docs/troubleshooting.md`, forward-link with this phrasing:

> "This matches [specific symptom] in docs/troubleshooting.md section [N]. Short version: [one-sentence fix]. Full version in the doc. Want me to apply the short fix, or would you rather read the full section first?"

### Never do these

- `Read .env` directly.
- Echo a secret value in reply text.
- Construct curl commands with secrets inline; use `source .env && curl ...` always.
- Copy `.env` contents into a spec, summary, or commit message.
- Take screenshots of Supabase dashboard pages showing API keys.
- Paste secrets into an interactive Claude-in-Chrome or computer-use session; those tools might log the screen content.
