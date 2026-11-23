#!/usr/bin/env node
// Brain Bank action-item triage. Dry-run is the default.
//
// Status flips only; no row is ever deleted. --apply goes through the guarded
// transition_action_item RPC, so every close carries an actor, a reason and a
// current-status guard. The close reason is an explicit field of the decision, never
// inferred from its free text (see normalizeMiddleDecision):
//   {"bucket":"ARCHIVE","close_reason":"fragment","reason":"<quote>"}   never a real task
//   {"bucket":"RESOLVE","close_reason":"done","evidence":"commit:abc1234","reason":"<why>"}
// A decision without a valid one stays open in REVIEW, including every ARCHIVE in a
// file written before this contract. A disposition CSV records each answer the RPC
// gave, applied or skipped; a call that throws has no row, and a lost response can
// leave an event with no row, so action_item_events is the durable record. Undo a row
// with restore_action_item, which records the reopen. This needs the migration
// 20261106_action_items_close_reason.sql: without the RPC, --apply fails on its first
// call having written nothing.

import { randomUUID } from 'node:crypto';
import { appendFileSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addDryRunExternalCompletionSignals,
  applyDispositions,
  bucketize,
  CLASSIFIER_SYSTEM,
  DEFAULT_DONE_STATUSES,
  DEFAULT_PROTECTED_PHRASES,
  DEFAULT_WORK_ITEM_SHAPE_TERMS,
  DISPOSITION_HEADER,
  dispositionLines,
  llmDecision,
  mergeMiddle,
  normalizeEvidenceText,
  planDispositionBytes,
  projectNameFromDisplay,
  renderReport,
  runCascade,
} from './triage-lib.mjs';
import { claimDispositionFile } from './disposition-claim.mjs';

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
  const matchTerms = [...new Set([projectNameFromDisplay(displayName), displayName, ...aliases].filter(Boolean))];
  const liveStatus = statuses.get(row.notion_page_id?.replace(/-/g, ''));
  return {
    displayName,
    matchTerms,
    matchTermsNorm: matchTerms.map(normalizeEvidenceText).filter(Boolean),
    status: liveStatus || row.status || '',
    // Where the status was read, so a cascade close names a source someone can open.
    statusSource: liveStatus ? 'notion' : 'projects-table',
  };
}

async function loadBusinessEvents() {
  try {
    // Attendees live in the metadata jsonb (there is no top-level attendees
    // column on business_events).
    const rows = await supabase('business_events?select=title,date_start,metadata&order=date_start.desc&limit=500');
    return rows.map((row) => ({
      title: row.title || '',
      titleNorm: normalizeEvidenceText(row.title),
      date_start: row.date_start || null,
      attendeesNorm: Array.isArray(row.metadata?.attendees)
        ? row.metadata.attendees.map(normalizeEvidenceText).filter(Boolean)
        : [],
    }));
  } catch (error) {
    console.warn('business_events unavailable; external event evidence skipped: ' + error.message.slice(0, 120));
    return [];
  }
}

async function loadInput() {
  if (FIXTURE_FILE) {
    const fixture = JSON.parse(readFileSync(resolve(FIXTURE_FILE), 'utf8'));
    const now = Date.now();
    const projects = fixture.projects || [];
    const externalEvidence = fixture.externalEvidence || {
      projects: projects.map((project) => ({
        ...project,
        matchTermsNorm: (project.matchTerms || [projectNameFromDisplay(project.displayName), project.displayName])
          .filter(Boolean)
          .map(normalizeEvidenceText),
      })),
      events: (fixture.events || []).map((event) => ({
        ...event,
        titleNorm: normalizeEvidenceText(event.title),
        attendeesNorm: (event.attendees || []).map(normalizeEvidenceText).filter(Boolean),
      })),
    };
    return {
      items: (fixture.items || []).map((item) => ({
        age_days: item.age_days ?? Math.max(0, Math.floor((now - new Date(item.created_at).getTime()) / 86400000)),
        source: item.source || 'fixture',
        type: item.type || 'unknown',
        ...item,
      })),
      projects,
      externalEvidence,
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
  const projects = projectRows.map((row) => projectFromRow(row, statuses));
  const events = await loadBusinessEvents();
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
    projects,
    externalEvidence: { projects, events },
    offline: false,
  };
}

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
  return llmDecision(JSON.parse(data.choices[0].message.content));
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

// Takes this run's claim on the file, or stops the run. Released on any exit; a run that
// is killed leaves its claim behind, and the next run proves it dead and recovers it.
function claimOrRefuse(path) {
  const claim = claimDispositionFile(path);
  if (claim.busy) {
    console.error(`\nRefusing --apply: another run holds ${path}. Nothing was written to the database or the file. Run this again when it finishes. A claim left by a dead process on this machine is recovered automatically. One from another host, or one that cannot be read, is not: confirm that process is gone, then delete the claim file named here.\n${JSON.stringify(claim.holders, null, 2)}`);
    process.exit(1);
  }
  process.on('exit', claim.release);
  if (claim.recovered.length > 0) {
    console.error(`Recovered ${claim.recovered.length} claim(s) left by a dead process: ${claim.recovered.join(', ')}`);
  }
  return claim;
}

// Leaves the file ready to append to, or stops the run. A migration writes a temp file
// beside it, keeps the original as a backup, and renames over, so a crash leaves either
// the old file or the new one and never half of one. Both names are unique to this run,
// and a stale temp from an earlier crash is left alone and never read.
function prepareDispositionFile(path) {
  const plan = existsSync(path) ? planDispositionBytes(readFileSync(path)) : { action: 'create' };
  if (plan.action === 'refuse') {
    console.error(`\nRefusing --apply: ${path} holds ${plan.problem}. Nothing was written to the database or the file. Move that file aside, keeping it as its run's record, and re-run: this run then starts a new one.`);
    process.exit(1);
  }
  if (plan.unterminatedLast) {
    console.error(`Note: the last record in ${path} had no line ending. A spreadsheet saves files this way, and so does a write cut short; if it was cut short, that record may be incomplete. It is kept as it is: ${plan.unterminatedLast.slice(0, 200)}`);
  }
  if (plan.action === 'create') {
    writeFileSync(path, `${DISPOSITION_HEADER}\n`);
  } else if (plan.action === 'append') {
    if (plan.needsNewline) appendFileSync(path, '\n');
  } else {
    const unique = randomUUID();
    const temp = `${path}.${unique}.migrating`;
    const backup = `${path}.pre-evidence-${Date.now()}-${unique}.bak`;
    try {
      writeFileSync(temp, plan.content, { flag: 'wx' });
      copyFileSync(path, backup, constants.COPYFILE_EXCL);
      renameSync(temp, path);
    } finally {
      rmSync(temp, { force: true });
    }
    console.error(`Disposition file migrated to the evidence column: ${plan.records} prior record(s) kept, original at ${backup}`);
  }
}

async function applyFlips(newStatus, list, records) {
  await applyDispositions(
    list,
    newStatus,
    (args) => supabase('rpc/transition_action_item', { method: 'POST', body: JSON.stringify(args) }),
    records,
    (done, total) => {
      if (done % 100 === 0 || done === total) console.error(`  ${newStatus}: ${done}/${total}`);
    },
  );
}

async function main() {
  const { items, projects, externalEvidence, offline } = await loadInput();
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
    console.error('Classify them, write {id:{bucket,close_reason,reason}} JSON (see the README for the contract), re-run with --decisions=<file>');
  }

  let decided = mergeMiddle(deterministic, middle, middleDecisions);
  const held = Object.values(decided).filter((decision) => decision.held).length;
  if (held) {
    console.error(`${held} decision(s) held in REVIEW with no valid close reason; they stay open and the report says why`);
  }
  if (!APPLY) {
    decided = addDryRunExternalCompletionSignals(decided, items, externalEvidence).decided;
  }
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

  // The CSV is written even when a call fails partway, and appended to, so a re-run
  // on the same day keeps the first run's record. Its shape is settled here, before
  // any database write: a file this run could not add to refuses with nothing closed,
  // rather than closing items whose record it cannot keep. The claim is held from here
  // through the final append, so another run cannot replace the file under this one.
  const dispPath = join(OUT_DIR, 'triage-disposition-' + STAMP + '.csv');
  const claim = claimOrRefuse(dispPath);
  prepareDispositionFile(dispPath);
  const records = [];
  try {
    await applyFlips('archived', buckets.ARCHIVE, records);
    await applyFlips('resolved', buckets.RESOLVE, records);
  } finally {
    if (records.length) appendFileSync(dispPath, `${dispositionLines(records).join('\n')}\n`);
    if (!claim.held()) {
      console.error(`\nWARNING: this run's claim on ${dispPath} was removed while it ran. Its records were appended, but another run may have replaced the file meanwhile. Compare the file with action_item_events.`);
      process.exitCode = 1;
    }
    const skipped = records.filter((record) => record.outcome !== 'applied').length;
    console.error(`Applied ${records.length - skipped}, skipped ${skipped} that left 'open' since classification. Disposition: ${dispPath}`);
  }
}

main().catch((error) => {
  console.error('FATAL: ' + error.message);
  process.exitCode = 1;
});
