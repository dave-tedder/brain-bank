# projects-sync

Seeds and re-syncs the Brain Bank `projects` table from the local filesystem
and the Notion Projects database. A project is a curated `projects` row - it
is not auto-promoted from thought topics (audit Decision B, Phase 15.3).

## Setup

1. Copy `config.example.json` to `config.json` and fill in:
   - `scanRoots` - directories whose immediate subdirectories each become a project.
   - `explicitDirs` - individual directories that are each a project.
   - `notionProjectsDbId` - the Notion Projects database id.
2. Create `.env` in this directory:

   ```
   SUPABASE_URL=https://<project-ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
   NOTION_TOKEN=<notion-integration-token>
   ```

`config.json` and `.env` are gitignored - they hold operator-specific paths
and secrets.

## Run

```
node sync.mjs --dry-run        # enumerate and print, no writes
node sync.mjs                  # seed / sync filesystem + Notion
node sync.mjs --source=fs      # filesystem only
node sync.mjs --source=notion  # Notion only
```

Requires Node 20.6+ (`process.loadEnvFile`). No dependencies.

## Behavior

- Re-runnable and idempotent. New directories and Notion projects are added;
  existing rows refresh their factual fields.
- The script owns `display_name`, `working_dirs` (filesystem rows),
  `notion_page_id` + `status` (Notion rows), and `last_synced_at`.
- Operator curation - `type`, `pinned`, `roi_band`, `vision_md`,
  `manual_next_step`, and `status` on filesystem rows - is never overwritten
  once a row exists. First insert defaults `type=uncategorized`.
- A directory or Notion project removed from source leaves its row in place.
- Notion status maps to the `projects.status` set: done/complete/completed/
  finished -> `done`; archive/archived -> `archive`; paused/on hold/hold ->
  `paused`; everything else (ongoing, deadline, blank) -> `active`.
