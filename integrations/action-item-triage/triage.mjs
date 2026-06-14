#!/usr/bin/env node
// Brain Bank action-item triage. Dry-run is the default.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bucketize,
  csv,
  DEFAULT_DONE_STATUSES,
  DEFAULT_PROTECTED_PHRASES,
  DEFAULT_WORK_ITEM_SHAPE_TERMS,
  mergeMiddle,
  projectNameFromDisplay,
  renderReport,
  runCascade,
} from './triage-lib.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const argValue = (name) => {
  const arg = args.find((candidate) => candidate.startsWith('--' + name + '='));
  return arg ? arg.split('=').slice(1).join('=') : null;
};
const DECISIONS_FILE = argValue('decisions');
const FIXTURE_FILE = argValue('fixture');
const STAMP = argValue('stamp') || new Date().toISOString().slice(0, 10);
const OUT_DIR = resolve(argValue('out-dir') || join(SCRIPT_DIR, 'out'));
mkdirSync(OUT_DIR, { recursive: true });

try {
  process.loadEnvFile(join(SCRIPT_DIR, '.env'));
} catch {
  // Ambient environment variables are also supported.
}

let config = {};
try {
  config = JSON.parse(readFileSync(join(SCRIPT_DIR, 'config.json'), 'utf8'));
} catch {
  console.warn('No config.json; using generic defaults.');
}

const MODEL = config.model || 'openai/gpt-4.1-mini';
const DONE_STATUSES = config.doneStatuses || DEFAULT_DONE_STATUSES;
const PROTECTED_PHRASES = config.protectedPhrases || DEFAULT_PROTECTED_PHRASES;
const WORK_ITEM_SHAPE_TERMS = config.workItemShapeTerms || DEFAULT_WORK_ITEM_SHAPE_TERMS;
const PROJECT_ALIASES = config.projectAliases || {};
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || null;

async function supabase(path, options = {}) {
  const response = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error('Supabase ' + response.status + ' ' + path + ': ' + text.slice(0, 300));
  }
  return text ? JSON.parse(text) : null;
}

async function notionStatuses() {
  if (!NOTION_TOKEN || !config.notionProjectsDbId) return new Map();
  const statuses = new Map();
  let cursor;
  do {
    const response = await fetch(
      'https://api.notion.com/v1/databases/' + config.notionProjectsDbId + '/query',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + NOTION_TOKEN,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(cursor ? { page_size: 100, start_cursor: cursor } : { page_size: 100 }),
      },
    );
    if (!response.ok) {
      console.warn('Notion query failed (' + response.status + '); using projects-table statuses.');
      break;
    }
    const data = await response.json();
    for (const page of data.results || []) {
      const prop = page.properties?.Status;
      const name = prop?.type === 'status' ? prop.status?.name : prop?.select?.name;
      statuses.set(page.id.replace(/-/g, ''), name || '');
    }
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return statuses;
}

function projectFromRow(row, statuses) {
  const displayName = row.display_name || '';
  const aliases = PROJECT_ALIASES[displayName] || [];
  return {
    displayName,
    matchTerms: [...new Set([projectNameFromDisplay(displayName), displayName, ...aliases].filter(Boolean))],
    status: statuses.get(row.notion_page_id?.replace(/-/g, '')) || row.status || '',
  };
}

async function loadInput() {
  if (FIXTURE_FILE) {
    const fixture = JSON.parse(readFileSync(resolve(FIXTURE_FILE), 'utf8'));
    const now = Date.now();
    return {
      items: (fixture.items || []).map((item) => ({
        age_days: item.age_days ?? Math.max(0, Math.floor((now - new Date(item.created_at).getTime()) / 86400000)),
        source: item.source || 'fixture',
        type: item.type || 'unknown',
        ...item,
      })),
      projects: fixture.projects || [],
      offline: true,
    };
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing Supabase credentials. Use --fixture for an offline dry run.');
  }
  const rows = await supabase(
    'action_items?status=eq.open&select=id,description,created_at,source_thought_id,thoughts!source_thought_id(metadata,content)&order=created_at.asc',
  );
  const projectRows = await supabase('projects?select=display_name,notion_page_id,status');
  const statuses = await notionStatuses();
  const now = Date.now();
  return {
    items: rows.map((row) => ({
      id: row.id,
      description: row.description || '',
      created_at: row.created_at,
      age_days: Math.max(0, Math.floor((now - new Date(row.created_at).getTime()) / 86400000)),
      source: row.thoughts?.metadata?.source || '(unknown)',
      type: row.thoughts?.metadata?.type || '(unknown)',
      preview: (row.thoughts?.content || '').slice(0, 160).replace(/\s+/g, ' '),
    })),
    projects: projectRows.map((row) => projectFromRow(row, statuses)),
    offline: false,
  };
}

const CLASSIFIER_SYSTEM = [
  'You triage one captured action item at a time for a Brain Bank operator.',
  'KEEP only a concrete, unfinished commitment. ARCHIVE advice, conditional ideas, narration, or plainly completed implementation notes.',
  'REVIEW anything uncertain or involving a customer, contract, money, legal obligation, or deadline.',
  'Judge the item alone and quote the phrase that drove the decision.',
  'Return strict JSON: {"bucket":"keep|archive|review","reason":"<short quote>"}.',
].join('\n');

async function classifyOne(item) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + OPENROUTER_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      response_format: { type: 'json_object' },
      temperature: 0,
      messages: [
        { role: 'system', content: CLASSIFIER_SYSTEM },
        {
          role: 'user',
          content:
            '[source=' + item.source + ' type=' + item.type + ' age=' + item.age_days + 'd] ' + item.description,
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error('OpenRouter ' + response.status + ': ' + (await response.text()).slice(0, 200));
  }
  const data = await response.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  const bucket = ['keep', 'archive', 'review'].includes(parsed.bucket)
    ? parsed.bucket.toUpperCase()
    : 'REVIEW';
  return { bucket, reason: String(parsed.reason || '').slice(0, 200) };
}

async function classifyMiddle(middle) {
  const decisions = {};
  for (let index = 0; index < middle.length; index += 6) {
    const results = await Promise.all(
      middle.slice(index, index + 6).map(async (item) => {
        try {
          return [item.id, await classifyOne(item)];
        } catch (error) {
          return [item.id, { bucket: 'REVIEW', reason: 'classifier error: ' + error.message.slice(0, 80) }];
        }
      }),
    );
    for (const [id, decision] of results) decisions[id] = decision;
  }
  return decisions;
}

async function applyStatus(status, items) {
  for (let index = 0; index < items.length; index += 100) {
    const ids = items.slice(index, index + 100).map((item) => '"' + item.id + '"').join(',');
    await supabase('action_items?id=in.(' + ids + ')', {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status,
        resolved_at: status === 'resolved' ? new Date().toISOString() : null,
      }),
    });
  }
}

async function main() {
  const { items, projects, offline } = await loadInput();
  const { decided: deterministic, middle } = runCascade({
    items,
    projects,
    doneStatuses: DONE_STATUSES,
    protectedPhrases: PROTECTED_PHRASES,
    workItemShapeTerms: WORK_ITEM_SHAPE_TERMS,
  });

  let middleDecisions = {};
  if (DECISIONS_FILE) {
    middleDecisions = JSON.parse(readFileSync(resolve(DECISIONS_FILE), 'utf8'));
  } else if (OPENROUTER_API_KEY && !offline) {
    middleDecisions = await classifyMiddle(middle);
  } else if (middle.length) {
    const inputPath = join(OUT_DIR, 'triage-classify-input-' + STAMP + '.json');
    writeFileSync(inputPath, JSON.stringify(middle, null, 2));
    console.error('No optional OpenRouter credentials; wrote classification input to ' + inputPath);
  }

  const decided = mergeMiddle(deterministic, middle, middleDecisions);
  const buckets = bucketize(items, decided);
  const counts = Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, value.length]));
  writeFileSync(join(OUT_DIR, 'triage-report-' + STAMP + '.md'), renderReport(STAMP, counts, buckets));
  writeFileSync(join(OUT_DIR, 'triage-buckets-' + STAMP + '.json'), JSON.stringify(decided, null, 2));

  if (!APPLY) {
    console.error(
      'DRY-RUN. Would ARCHIVE ' + buckets.ARCHIVE.length + ', RESOLVE ' + buckets.RESOLVE.length +
        '; no database writes performed.',
    );
    return;
  }
  if (counts.PENDING > 0) {
    console.error('Refusing --apply: one or more items are PENDING.');
    process.exitCode = 1;
    return;
  }
  if (offline) {
    console.error('Refusing --apply with --fixture: offline fixtures are verification-only.');
    process.exitCode = 1;
    return;
  }

  await applyStatus('archived', buckets.ARCHIVE);
  await applyStatus('resolved', buckets.RESOLVE);
  const lines = ['id,old_status,new_status,bucket,reason,description'];
  for (const bucket of ['ARCHIVE', 'RESOLVE']) {
    for (const item of buckets[bucket]) {
      const status = bucket === 'ARCHIVE' ? 'archived' : 'resolved';
      lines.push([item.id, 'open', status, bucket, csv(item.reason), csv(item.description)].join(','));
    }
  }
  const dispositionPath = join(OUT_DIR, 'triage-disposition-' + STAMP + '.csv');
  writeFileSync(dispositionPath, lines.join('\n'));
  console.error('Applied reversible status changes. Disposition: ' + dispositionPath);
}

main().catch((error) => {
  console.error('FATAL: ' + error.message);
  process.exitCode = 1;
});
