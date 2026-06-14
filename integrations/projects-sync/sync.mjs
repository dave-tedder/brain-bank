#!/usr/bin/env node
// Brain Bank - projects-sync
// Seeds / re-syncs the `projects` table from the local filesystem and the
// Notion Projects database. Re-runnable and idempotent: operator curation
// (type, pinned, roi_band, vision_md, manual_next_step, and status on
// filesystem rows) is never overwritten once a row exists.
//
// Usage:
//   node sync.mjs [--dry-run] [--source=all|fs|notion]
//
// Requires (both gitignored - operator-specific / secrets):
//   .env          NOTION_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   config.json   scanRoots[], explicitDirs[], notionProjectsDbId

import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// ---- args -----------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SOURCE = (args.find((a) => a.startsWith('--source=')) || '--source=all').split('=')[1];
if (!['all', 'fs', 'notion'].includes(SOURCE)) {
  console.error(`Invalid --source: ${SOURCE} (expected all|fs|notion)`);
  process.exit(1);
}

// ---- env + config ---------------------------------------------------------
try {
  process.loadEnvFile(join(SCRIPT_DIR, '.env'));
} catch {
  // no .env file - fall back to ambient process.env
}

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (.env)');
  process.exit(1);
}

let config;
try {
  config = JSON.parse(readFileSync(join(SCRIPT_DIR, 'config.json'), 'utf8'));
} catch (err) {
  console.error(`Cannot read config.json: ${err.message}`);
  process.exit(1);
}

function expandHome(p) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

// ---- slug -----------------------------------------------------------------
// Identical normalization to the projects_rollup view's thought_facts CTE.
function toSlug(name) {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || null;
}

// ---- filesystem enumeration ----------------------------------------------
function enumerateFilesystem() {
  const found = [];
  for (const root of config.scanRoots || []) {
    const absRoot = expandHome(root);
    if (!existsSync(absRoot)) {
      console.warn(`scanRoot missing, skipping: ${absRoot}`);
      continue;
    }
    for (const entry of readdirSync(absRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      found.push({ name: entry.name, absPath: join(absRoot, entry.name) });
    }
  }
  for (const dir of config.explicitDirs || []) {
    const absDir = expandHome(dir);
    if (!existsSync(absDir) || !statSync(absDir).isDirectory()) {
      console.warn(`explicitDir missing, skipping: ${absDir}`);
      continue;
    }
    found.push({ name: basename(absDir), absPath: absDir });
  }
  return found;
}

// ---- Notion enumeration ---------------------------------------------------
function mapNotionStatus(raw) {
  const s = (raw || '').toLowerCase().trim();
  if (['done', 'complete', 'completed', 'finished'].includes(s)) return 'done';
  if (['archive', 'archived'].includes(s)) return 'archive';
  if (['paused', 'on hold', 'hold'].includes(s)) return 'paused';
  return 'active'; // ongoing, deadline, blank, or anything unrecognized
}

async function enumerateNotion() {
  if (!NOTION_TOKEN) {
    console.warn('NOTION_TOKEN not set - skipping Notion enumeration');
    return [];
  }
  if (!config.notionProjectsDbId) {
    console.warn('notionProjectsDbId not set in config - skipping Notion');
    return [];
  }
  const out = [];
  let cursor;
  do {
    const res = await fetch(
      `https://api.notion.com/v1/databases/${config.notionProjectsDbId}/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(cursor ? { start_cursor: cursor } : {}),
      },
    );
    if (!res.ok) {
      throw new Error(`Notion query failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    for (const page of data.results) {
      const props = page.properties || {};
      let title = null;
      let status = null;
      for (const [name, prop] of Object.entries(props)) {
        if (prop.type === 'title') {
          title = (prop.title || []).map((t) => t.plain_text).join('').trim();
        }
        if (name.toLowerCase() === 'status' && prop.type === 'select') {
          status = prop.select ? prop.select.name : null;
        }
        if (name.toLowerCase() === 'status' && prop.type === 'status') {
          status = prop.status ? prop.status.name : null;
        }
      }
      if (!title) continue;
      out.push({ title, pageId: page.id, status: mapNotionStatus(status) });
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return out;
}

// ---- Supabase upsert ------------------------------------------------------
// Bulk PostgREST upsert with resolution=merge-duplicates. On conflict it
// updates ONLY the columns present in the payload - so omitting type/pinned/
// roi_band/vision_md/manual_next_step preserves operator curation, and new
// rows get the table defaults (type=uncategorized, status=active).
async function upsert(rows, label) {
  if (rows.length === 0) {
    console.log(`${label}: 0 rows`);
    return;
  }
  if (DRY_RUN) {
    console.log(`[dry-run] ${label}: would upsert ${rows.length} rows`);
    for (const r of rows) console.log(`  - ${r.slug} (${r.display_name})`);
    return;
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/projects?on_conflict=slug`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    throw new Error(`Supabase upsert (${label}) failed: ${res.status} ${await res.text()}`);
  }
  console.log(`${label}: upserted ${rows.length} rows`);
}

// ---- main -----------------------------------------------------------------
async function main() {
  const now = new Date().toISOString();
  const seen = new Map(); // slug -> origin label, collision guard
  const fsRows = [];
  const notionRows = [];

  if (SOURCE === 'all' || SOURCE === 'fs') {
    for (const proj of enumerateFilesystem()) {
      const slug = toSlug(proj.name);
      if (!slug) {
        console.warn(`skip (empty slug): ${proj.name}`);
        continue;
      }
      if (seen.has(slug)) {
        console.warn(`slug collision "${slug}" (${proj.name}), already from ${seen.get(slug)} - skipping`);
        continue;
      }
      seen.set(slug, 'filesystem');
      // fs payload: omits notion_page_id so it never clobbers a Notion link.
      fsRows.push({
        slug,
        display_name: proj.name,
        working_dirs: [proj.absPath],
        last_synced_at: now,
      });
    }
  }

  if (SOURCE === 'all' || SOURCE === 'notion') {
    for (const proj of await enumerateNotion()) {
      const slug = toSlug(proj.title);
      if (!slug) {
        console.warn(`skip (empty slug): ${proj.title}`);
        continue;
      }
      if (seen.has(slug)) {
        console.warn(`slug collision "${slug}" (${proj.title}), already from ${seen.get(slug)} - skipping`);
        continue;
      }
      seen.set(slug, 'notion');
      // notion payload: omits working_dirs (not script-managed for Notion rows).
      notionRows.push({
        slug,
        display_name: proj.title,
        notion_page_id: proj.pageId,
        status: proj.status,
        last_synced_at: now,
      });
    }
  }

  console.log(`Enumerated: ${fsRows.length} filesystem, ${notionRows.length} Notion`);
  await upsert(fsRows, 'filesystem');
  await upsert(notionRows, 'notion');
  console.log(DRY_RUN ? 'Dry run complete - no writes.' : 'Sync complete.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
