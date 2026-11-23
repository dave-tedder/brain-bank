import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { csvRecords, DISPOSITION_HEADER, LEGACY_DISPOSITION_HEADER } from './triage-lib.mjs';

const script = fileURLToPath(new URL('./triage.mjs', import.meta.url));

async function fixtureRun(extraArgs = []) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-bank-triage-'));
  const fixturePath = path.join(dir, 'fixture.json');
  await writeFile(
    fixturePath,
    JSON.stringify({
      items: [
        { id: 'protected', description: 'Do not resolve this canary', created_at: '2026-06-01T00:00:00Z', source: 'fixture', type: 'task' },
        { id: 'ambiguous', description: 'Consider simplifying the deployment notes', created_at: '2026-06-02T00:00:00Z', source: 'fixture', type: 'observation' },
      ],
      projects: [],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [script, `--fixture=${fixturePath}`, `--out-dir=${dir}`, '--stamp=2026-06-14', ...extraArgs],
    { encoding: 'utf8' },
  );
  return { dir, result };
}

test('offline fixture dry-run writes reports without service credentials', async () => {
  const { dir, result } = await fixtureRun();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /DRY-RUN/);
  const report = await readFile(path.join(dir, 'triage-report-2026-06-14.md'), 'utf8');
  assert.match(report, /PENDING/);
});

test('--apply fails closed when an offline item is pending', async () => {
  const { result } = await fixtureRun(['--apply']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing --apply/);
});

// --apply against a stub PostgREST, running the real script. Credentials are dummies
// and the URL is local, set in the environment, so .env cannot supply real ones.
const OPEN_ITEMS = [
  { id: 'old-copy', description: 'Rewrite the deployment notes', created_at: '2026-06-01T00:00:00Z', source_thought_id: null, thoughts: null },
  { id: 'new-copy', description: 'rewrite deployment notes', created_at: '2026-06-02T00:00:00Z', source_thought_id: null, thoughts: null },
  { id: 'project-done', description: 'Finish the Jane Doe website handoff', created_at: '2026-06-03T00:00:00Z', source_thought_id: null, thoughts: null },
  { id: 'prose', description: 'Prioritize sleep this week', created_at: '2026-06-04T00:00:00Z', source_thought_id: null, thoughts: null },
  { id: 'moved', description: 'Consider a refresh someday', created_at: '2026-06-05T00:00:00Z', source_thought_id: null, thoughts: null },
  { id: 'canary', description: 'Do not resolve this canary', created_at: '2026-06-06T00:00:00Z', source_thought_id: null, thoughts: null },
  { id: 'verified', description: 'Ship the migration', created_at: '2026-06-07T00:00:00Z', source_thought_id: null, thoughts: null },
  { id: 'legacy', description: 'Maybe the other migration shipped', created_at: '2026-06-08T00:00:00Z', source_thought_id: null, thoughts: null },
  { id: 'no-evidence', description: 'Publish the changelog page', created_at: '2026-06-09T00:00:00Z', source_thought_id: null, thoughts: null },
];

async function startStub(rpcAnswer) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      const reply = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.method === 'GET' && req.url.startsWith('/rest/v1/action_items')) return reply(200, OPEN_ITEMS);
      if (req.method === 'GET' && req.url.startsWith('/rest/v1/projects')) return reply(200, [{ display_name: 'Jane Doe - Website', notion_page_id: null, status: 'done' }]);
      if (req.method === 'GET' && req.url.startsWith('/rest/v1/business_events')) return reply(200, []);
      if (req.method === 'POST' && req.url === '/rest/v1/rpc/transition_action_item') {
        const answer = await rpcAnswer(JSON.parse(body));
        return answer === 'error' ? reply(500, { message: 'stub failure' }) : reply(200, answer);
      }
      return reply(500, { message: `unexpected ${req.method} ${req.url}` });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { requests, port: server.address().port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

async function writeDecisions(dir) {
  const decisions = path.join(dir, 'decisions.json');
  await writeFile(decisions, JSON.stringify({
    'new-copy': { bucket: 'KEEP', reason: 'real' },
    prose: { bucket: 'ARCHIVE', close_reason: 'fragment', reason: 'Prioritize sleep' },
    moved: { bucket: 'ARCHIVE', close_reason: 'fragment', reason: 'Consider' },
    verified: { bucket: 'RESOLVE', close_reason: 'done', evidence: 'commit:abcdef1', reason: 'the migration shipped' },
    legacy: { bucket: 'ARCHIVE', reason: 'shipped in commit abcdef1' },
    'no-evidence': { bucket: 'RESOLVE', close_reason: 'done', reason: 'shipped in commit abcdef1' },
  }));
  return decisions;
}

function startCli(dir, port, decisions, nodeArgs = [], extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...nodeArgs, script, '--apply', `--decisions=${decisions}`, `--out-dir=${dir}`, '--stamp=2026-06-14'], {
      env: {
        PATH: process.env.PATH,
        ...extraEnv,
        SUPABASE_URL: `http://127.0.0.1:${port}`,
        SUPABASE_SERVICE_ROLE_KEY: 'stub-key',
        NOTION_TOKEN: '',
        OPENROUTER_API_KEY: '',
      },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

async function applyRun({ rpcAnswer, dir: existingDir = null, prepare = null, nodeArgs = [] }) {
  const dir = existingDir || await mkdtemp(path.join(os.tmpdir(), 'brain-bank-triage-apply-'));
  if (prepare) await prepare(dir);
  const stub = await startStub(rpcAnswer);
  const decisions = await writeDecisions(dir);
  const result = await startCli(dir, stub.port, decisions, nodeArgs);
  await stub.close();
  return { dir, requests: stub.requests, result };
}

const rpcCalls = (requests) => requests.filter((r) => r.url === '/rest/v1/rpc/transition_action_item');

test('--apply writes only through the guarded RPC, with reasons, and records a moved row as skipped', async () => {
  const { dir, requests, result } = await applyRun({ rpcAnswer: (args) => (args.p_item_id === 'moved' ? 0 : 1) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(requests.filter((r) => r.method === 'PATCH'), [], 'no direct status write');
  assert.deepEqual(requests.filter((r) => r.method !== 'GET' && r.url !== '/rest/v1/rpc/transition_action_item'), []);
  const byId = Object.fromEntries(rpcCalls(requests).map((r) => [r.body.p_item_id, r.body]));
  assert.deepEqual(Object.keys(byId).sort(), ['moved', 'old-copy', 'project-done', 'prose', 'verified'], 'KEEP, protected and held rows are not written');
  assert.equal(byId.verified.p_close_reason, 'done');
  assert.equal(byId.verified.p_to_status, 'resolved');
  assert.equal(byId.verified.p_event_payload.evidence, 'commit:abcdef1');
  assert.equal(byId['project-done'].p_close_reason, 'done');
  assert.equal(byId['project-done'].p_to_status, 'resolved');
  assert.equal(byId['project-done'].p_event_payload.evidence, 'project-status:projects-table:Jane Doe - Website', 'the cascade names where it read done');
  assert.equal(byId['old-copy'].p_close_reason, 'duplicate');
  assert.equal(byId['old-copy'].p_duplicate_of, 'new-copy');
  assert.equal(byId.prose.p_close_reason, 'fragment');
  for (const call of Object.values(byId)) {
    assert.equal(call.p_actor, 'action-item-triage');
    assert.deepEqual(call.p_from_statuses, ['open']);
  }
  const lines = (await readFile(path.join(dir, 'triage-disposition-2026-06-14.csv'), 'utf8')).trim().split('\n');
  assert.equal(lines[0], 'id,old_status,new_status,close_reason,outcome,reason,description,evidence');
  assert.equal(lines.length, 6);
  assert.ok(lines.some((l) => l.startsWith('verified,open,resolved,done,applied,') && l.endsWith(',commit:abcdef1')), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('moved,open,archived,fragment,skipped_status_changed,')), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('project-done,open,resolved,done,applied,') && l.endsWith(',project-status:projects-table:Jane Doe - Website')), lines.join('\n'));
  assert.match(result.stderr, /Applied 4, skipped 1/);
  assert.match(result.stderr, /2 decision\(s\) held in REVIEW/);
  const report = await readFile(path.join(dir, 'triage-report-2026-06-14.md'), 'utf8');
  assert.match(report, /decision held for review: ARCHIVE names no close_reason\. It said: shipped in commit abcdef1/);
  assert.match(report, /decision held for review: RESOLVE needs a checkable evidence pointer/);
});

test('--apply stops on an RPC failure, exits nonzero, and keeps the record of what landed', async () => {
  const { dir, requests, result } = await applyRun({ rpcAnswer: (args) => (args.p_item_id === 'prose' ? 'error' : 1) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /stub failure/);
  const calls = rpcCalls(requests).map((r) => r.body.p_item_id);
  assert.equal(calls.at(-1), 'prose', 'nothing after the failure');
  const csvText = await readFile(path.join(dir, 'triage-disposition-2026-06-14.csv'), 'utf8');
  assert.ok(csvText.includes('old-copy,open,archived,duplicate,applied'), csvText);
  assert.ok(!csvText.includes('prose,'), 'the failed row did not land');
});

// --- An existing disposition file, through the real CLI ---

const CSV_NAME = 'triage-disposition-2026-06-14.csv';
const csvRows = (text) => {
  const [header, ...rows] = csvRecords(text).filter((r) => r.raw !== '');
  return rows.map((row) => Object.fromEntries(row.cells.map((cell, i) => [header.cells[i] ?? `unheaded-${i}`, cell])));
};
const seedCsv = (content) => (dir) => writeFile(path.join(dir, CSV_NAME), content);
const claimsIn = (names) => names.filter((name) => name.startsWith(`${CSV_NAME}.claim.`));
const PRIOR = `${LEGACY_DISPOSITION_HEADER}\nprior-1,open,archived,fragment,applied,"x, y","two\nlines"\n`;

test('--apply migrates a seven-column file before writing: every prior record kept, evidence reachable by name', async () => {
  const { dir, requests, result } = await applyRun({ rpcAnswer: (args) => (args.p_item_id === 'moved' ? 0 : 1), prepare: seedCsv(PRIOR) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /migrated to the evidence column: 1 prior record/);
  const text = await readFile(path.join(dir, CSV_NAME), 'utf8');
  assert.equal(text.split('\n')[0], DISPOSITION_HEADER);
  const rows = csvRows(text);
  const prior = rows.find((r) => r.id === 'prior-1');
  assert.equal(prior.reason, 'x, y');
  assert.equal(prior.description, 'two\nlines');
  assert.equal(prior.evidence, '');
  assert.equal(rows.find((r) => r.id === 'verified').evidence, 'commit:abcdef1', 'evidence by its column name');
  assert.equal(rows.find((r) => r.id === 'moved').outcome, 'skipped_status_changed');
  assert.ok(rows.every((r) => !Object.keys(r).some((k) => k.startsWith('unheaded'))), 'no unheaded field anywhere');
  assert.equal(rows.length, 1 + rpcCalls(requests).length, 'one record per answer, plus the prior one');
  const names = await readdir(dir);
  const backups = names.filter((name) => name.startsWith(`${CSV_NAME}.pre-evidence-`));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(path.join(dir, backups[0]), 'utf8'), PRIOR, 'the original is kept byte for byte');
  assert.deepEqual(names.filter((name) => name.endsWith('.migrating')), [], 'no temp file left');
  assert.deepEqual(claimsIn(names), [], 'the claim is released');

  // A repeated run the same day: appends, does not migrate again, keeps one header.
  const second = await applyRun({ rpcAnswer: () => 1, dir });
  assert.equal(second.result.status, 0, second.result.stderr);
  assert.doesNotMatch(second.result.stderr, /migrated/);
  const again = await readFile(path.join(dir, CSV_NAME), 'utf8');
  assert.equal(again.split(DISPOSITION_HEADER).length - 1, 1, 'one header');
  assert.equal(csvRows(again).length, rows.length + rpcCalls(second.requests).length, 'the second run added its records');
  assert.ok(again.startsWith(text), 'nothing the first run recorded changed');
  assert.equal((await readdir(dir)).filter((name) => name.startsWith(`${CSV_NAME}.pre-evidence-`)).length, 1, 'one backup');
});

test('--apply repairs a seven-column file that already holds eight-field records', async () => {
  const damaged = `${LEGACY_DISPOSITION_HEADER}\nprior-1,open,archived,fragment,applied,r,d\nprior-2,open,resolved,done,applied,r,d,commit:1234567\n`;
  const { dir, result } = await applyRun({ rpcAnswer: () => 1, prepare: seedCsv(damaged) });
  assert.equal(result.status, 0, result.stderr);
  const rows = csvRows(await readFile(path.join(dir, CSV_NAME), 'utf8'));
  assert.equal(rows.find((r) => r.id === 'prior-2').evidence, 'commit:1234567');
  assert.equal(rows.find((r) => r.id === 'prior-1').evidence, '');
});

test('--apply appends to a file already in the current shape, and adds a missing final newline first', async () => {
  const current = `${DISPOSITION_HEADER}\nprior-1,open,resolved,done,applied,r,d,commit:1234567`;
  const { dir, result } = await applyRun({ rpcAnswer: () => 1, prepare: seedCsv(current) });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /migrated/);
  assert.match(result.stderr, /the last record in .* had no line ending/, 'and says so');
  const text = await readFile(path.join(dir, CSV_NAME), 'utf8');
  assert.ok(text.startsWith(`${current}\n`), 'the prior record is untouched and terminated');
  const rows = csvRows(text);
  assert.equal(rows[0].evidence, 'commit:1234567');
  assert.ok(rows.length > 1);
  assert.equal(rows.find((r) => r.id === 'verified').evidence, 'commit:abcdef1');
  assert.equal((await readdir(dir)).filter((name) => name.includes('pre-evidence')).length, 0, 'no backup when nothing changed');
});

test('--apply starts a file that exists but is empty', async () => {
  const { dir, result } = await applyRun({ rpcAnswer: () => 1, prepare: seedCsv('') });
  assert.equal(result.status, 0, result.stderr);
  const text = await readFile(path.join(dir, CSV_NAME), 'utf8');
  assert.equal(text.split('\n')[0], DISPOSITION_HEADER);
  assert.equal(csvRows(text).find((r) => r.id === 'verified').evidence, 'commit:abcdef1');
});

for (const [label, content, problem] of [
  ['an older tool\'s header', 'id,old_status,new_status,bucket,reason,description\na,open,archived,ARCHIVE,r,d\n', /unrecognized header/],
  ['a record of the wrong width', `${LEGACY_DISPOSITION_HEADER}\na,b,c\n`, /record with 3 fields/],
  ['a torn write', `${DISPOSITION_HEADER}\na,open,resolved,done,applied,"torn`, /never closes/],
  ['a quote inside an unquoted field', `${LEGACY_DISPOSITION_HEADER}\nprior,open,archived,fragment,applied,a"b,c",desc\n`, /a quote inside an unquoted field/],
  ['text after a closing quote', `${LEGACY_DISPOSITION_HEADER}\nprior,open,archived,fragment,applied,"a"junk,desc\n`, /text after a closing quote/],
  ['seven fields under the current header', `${DISPOSITION_HEADER}\nprior,open,resolved,done,applied,description,commit:1234567\n`, /record with 7 fields under the current header/],
  ['a bare carriage return', `${DISPOSITION_HEADER}\nprior,open,resolved,done,applied,a\rb,d,\n`, /bare carriage return/],
  ['a NUL byte', `${DISPOSITION_HEADER}\nprior,open,resolved,done,applied,a\0b,d,\n`, /NUL byte/],
  ['bytes that are not UTF-8', Buffer.concat([Buffer.from(`${DISPOSITION_HEADER}\nprior,open,resolved,done,applied,`), Buffer.from([0xc3])]), /not valid UTF-8/],
]) {
  test(`--apply refuses ${label} before any database write and leaves the file alone`, async () => {
    const { dir, requests, result } = await applyRun({ rpcAnswer: () => 1, prepare: seedCsv(content) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing --apply/);
    assert.match(result.stderr, problem);
    assert.match(result.stderr, /Nothing was written/);
    assert.deepEqual(rpcCalls(requests), [], 'no RPC call');
    assert.equal(Buffer.compare(await readFile(path.join(dir, CSV_NAME)), Buffer.from(content)), 0, 'byte for byte');
    assert.equal((await readdir(dir)).filter((name) => name.includes('pre-evidence') || name.endsWith('.migrating')).length, 0);
    assert.deepEqual(claimsIn(await readdir(dir)), [], 'the claim is released on a refusal');
  });
}

// A preload that replaces one fs function for the CLI process only. The CLI's source is
// untouched, so this schedules the real code.
async function preload(dir, name, body) {
  const file = path.join(dir, name);
  await writeFile(file, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';\n${body}\nsyncBuiltinESMExports();\n`);
  return ['--import', file];
}

test('--apply stops before any write when the migration itself cannot finish, with the original intact', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-bank-triage-apply-'));
  const nodeArgs = await preload(dir, 'fail-rename.mjs', "const rename = fs.renameSync; fs.renameSync = (from, to) => { if (String(from).endsWith('.migrating')) throw new Error('injected interrupted rename'); return rename(from, to); };");
  const { requests, result } = await applyRun({ rpcAnswer: () => 1, dir, nodeArgs, prepare: seedCsv(PRIOR) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FATAL: injected interrupted rename/);
  assert.deepEqual(rpcCalls(requests), [], 'no RPC call');
  assert.equal(await readFile(path.join(dir, CSV_NAME), 'utf8'), PRIOR);
  const names = await readdir(dir);
  assert.deepEqual(names.filter((name) => name.endsWith('.migrating')), [], 'its own temp file is removed');
  assert.deepEqual(claimsIn(names), [], 'the claim is released');
});

test('a claim that cannot be renamed in stops the run before any write, and leaves no temp behind', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-bank-triage-apply-'));
  const nodeArgs = await preload(dir, 'fail-claim-rename.mjs', "const rename = fs.renameSync; fs.renameSync = (from, to) => { if (String(from).includes('.claim.')) throw new Error('injected claim rename failure'); return rename(from, to); };");
  const { requests, result } = await applyRun({ rpcAnswer: () => 1, dir, nodeArgs, prepare: seedCsv(PRIOR) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FATAL: injected claim rename failure/);
  assert.deepEqual(rpcCalls(requests), [], 'no RPC call');
  assert.equal(await readFile(path.join(dir, CSV_NAME), 'utf8'), PRIOR, 'the file is untouched');
  assert.deepEqual((await readdir(dir)).filter((name) => name.includes('.claim.')), [], 'no claim and no temp left');
});

test('a stale temp from an earlier crash neither blocks a migration nor gets read', async () => {
  const stale = `${CSV_NAME}.migrating`;
  const { dir, result } = await applyRun({
    rpcAnswer: () => 1,
    prepare: async (d) => {
      await seedCsv(PRIOR)(d);
      await writeFile(path.join(d, stale), 'stale temporary content');
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const text = await readFile(path.join(dir, CSV_NAME), 'utf8');
  assert.ok(!text.includes('stale temporary content'));
  assert.ok(csvRows(text).some((r) => r.id === 'prior-1'));
  assert.equal(await readFile(path.join(dir, stale), 'utf8'), 'stale temporary content', 'left alone');
});

test('two migrations in the same millisecond keep two backups', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-bank-triage-apply-'));
  const nodeArgs = await preload(dir, 'fixed-clock.mjs', 'Date.now = () => 1;');
  for (let run = 0; run < 2; run += 1) {
    const { result } = await applyRun({ rpcAnswer: () => 1, dir, nodeArgs, prepare: seedCsv(PRIOR) });
    assert.equal(result.status, 0, result.stderr);
  }
  const backups = (await readdir(dir)).filter((name) => name.startsWith(`${CSV_NAME}.pre-evidence-1-`));
  assert.equal(backups.length, 2);
  for (const name of backups) assert.equal(await readFile(path.join(dir, name), 'utf8'), PRIOR);
});

// A run pauses after planning from the old file while another finishes. The second
// cannot start, so the first's plan is never stale.
test('overlap: a run paused before its migration temp write keeps the second out entirely', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-bank-triage-apply-'));
  await seedCsv(PRIOR)(dir);
  const paused = path.join(dir, 'paused');
  const release = path.join(dir, 'release');
  const nodeArgs = await preload(dir, 'barrier.mjs', `
const original = fs.writeFileSync;
let once = false;
fs.writeFileSync = function (p, ...rest) {
  if (!once && String(p).endsWith('.migrating')) {
    once = true;
    original(${JSON.stringify(paused)}, 'ready');
    const end = Date.now() + 15000;
    while (!fs.existsSync(${JSON.stringify(release)})) {
      if (Date.now() > end) throw new Error('barrier timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  return original.call(this, p, ...rest);
};`);
  const stub = await startStub(() => 1);
  try {
    const decisions = await writeDecisions(dir);
    const first = startCli(dir, stub.port, decisions, nodeArgs);
    for (let n = 0; !existsSync(paused); n += 1) {
      assert.ok(n < 500, 'the first run never reached its barrier');
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
    const second = await startCli(dir, stub.port, decisions);
    assert.equal(second.status, 1, second.stderr);
    assert.match(second.stderr, /another run holds/);
    assert.match(second.stderr, /Nothing was written/);
    assert.deepEqual(rpcCalls(stub.requests), [], 'the second reached no RPC');
    assert.equal(await readFile(path.join(dir, CSV_NAME), 'utf8'), PRIOR, 'and left the file alone');
    assert.equal(claimsIn(await readdir(dir)).length, 1, 'and took its own claim back');
    await writeFile(release, 'go');
    const done = await first;
    assert.equal(done.status, 0, done.stderr);
    const rows = csvRows(await readFile(path.join(dir, CSV_NAME), 'utf8'));
    assert.ok(rows.some((r) => r.id === 'prior-1'), 'the prior record is kept');
    assert.equal(rows.find((r) => r.id === 'verified').outcome, 'applied');
    assert.deepEqual(rows.filter((r) => r.outcome !== 'applied' && r.id !== 'prior-1'), [], 'no skipped record stands in for it');
    assert.equal((await readdir(dir)).filter((name) => name.includes('pre-evidence')).length, 1);
    assert.deepEqual(claimsIn(await readdir(dir)), []);
  } finally {
    await stub.close();
  }
});

test('overlap: a run mid-apply keeps the second out, then the second can run and keeps every record', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-bank-triage-apply-'));
  let enter;
  const entered = new Promise((resolve) => { enter = resolve; });
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  // Only the first call is held. A second process reaching the RPC is the defect, and
  // holding it too would deadlock this test instead of failing the assertions below.
  let holding = false;
  const stub = await startStub(async () => {
    if (!holding) {
      holding = true;
      enter();
      await opened;
    }
    return 1;
  });
  try {
    const decisions = await writeDecisions(dir);
    const first = startCli(dir, stub.port, decisions);
    await Promise.race([entered, first.then((r) => { throw new Error(`the first run exited before its first RPC (${r.status}): ${r.stderr.slice(-300)}`); })]);
    const calls = rpcCalls(stub.requests).length;
    const second = await startCli(dir, stub.port, decisions);
    assert.equal(second.status, 1, second.stderr);
    assert.match(second.stderr, /another run holds/);
    assert.equal(rpcCalls(stub.requests).length, calls, 'no RPC from the second');
    open();
    assert.equal((await first).status, 0);
    const text = await readFile(path.join(dir, CSV_NAME), 'utf8');
    const rerun = await startCli(dir, stub.port, decisions);
    assert.equal(rerun.status, 0, rerun.stderr);
    const after = await readFile(path.join(dir, CSV_NAME), 'utf8');
    assert.ok(after.startsWith(text), 'nothing the first recorded changed');
    assert.ok(after.length > text.length, 'and the later run added its own');
  } finally {
    open();
    await stub.close();
  }
});

for (const [label, owner, other] of [
  ['time zone', { TZ: 'Asia/Tokyo' }, { TZ: 'America/New_York' }],
  ['locale', { LC_ALL: 'fr_FR.UTF-8' }, { LC_ALL: 'C' }],
]) {
  test(`overlap across a ${label}: a live owner is never judged gone`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-bank-triage-apply-'));
    let enter;
    const entered = new Promise((resolve) => { enter = resolve; });
    let open;
    const opened = new Promise((resolve) => { open = resolve; });
    let holding = false;
    const stub = await startStub(async () => {
      if (!holding) {
        holding = true;
        enter();
        await opened;
      }
      return 1;
    });
    try {
      const decisions = await writeDecisions(dir);
      const first = startCli(dir, stub.port, decisions, [], owner);
      await Promise.race([entered, first.then((r) => { throw new Error(`the owner exited before its first RPC (${r.status}): ${r.stderr.slice(-300)}`); })]);
      const calls = rpcCalls(stub.requests).length;
      const second = await startCli(dir, stub.port, decisions, [], other);
      assert.equal(second.status, 1, second.stderr);
      assert.match(second.stderr, /another run holds/);
      assert.doesNotMatch(second.stderr, /Recovered/, 'a live owner is not called dead');
      assert.equal(claimsIn(await readdir(dir)).length, 1, "the owner's claim survives");
      assert.equal(rpcCalls(stub.requests).length, calls, 'no RPC from the second');
      open();
      const done = await first;
      assert.equal(done.status, 0, done.stderr);
      assert.doesNotMatch(done.stderr, /was removed while it ran/);
    } finally {
      open();
      await stub.close();
    }
  });
}

// A run paused while writing its claim must not leave a half-written claim that a second
// run reads as unreadable and refuses on. Before the rename there is nothing to see.
test('a claim is seen only whole: a run paused mid-claim leaves nothing a second run refuses on', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-bank-triage-apply-'));
  const paused = path.join(dir, 'paused');
  const release = path.join(dir, 'release');
  const nodeArgs = await preload(dir, 'claim-barrier.mjs', `
const original = fs.writeFileSync;
let once = false;
fs.writeFileSync = function (p, ...rest) {
  const result = original.call(this, p, ...rest);
  if (!once && String(p).includes('.claim.')) {
    once = true;
    original(${JSON.stringify(paused)}, 'ready');
    const end = Date.now() + 15000;
    while (!fs.existsSync(${JSON.stringify(release)})) {
      if (Date.now() > end) throw new Error('barrier timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  return result;
};`);
  const stub = await startStub(() => 1);
  try {
    const decisions = await writeDecisions(dir);
    const first = startCli(dir, stub.port, decisions, nodeArgs);
    for (let n = 0; !existsSync(paused); n += 1) {
      assert.ok(n < 500, 'the first run never reached its claim');
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
    assert.deepEqual(claimsIn(await readdir(dir)).filter((name) => name.endsWith('.json')), [], 'no claim is visible before it is whole');
    const second = await startCli(dir, stub.port, decisions);
    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(second.stderr, /unreadable/);
    await writeFile(release, 'go');
    const done = await first;
    assert.ok([0, 1].includes(done.status), done.stderr);
    assert.deepEqual(claimsIn(await readdir(dir)), [], 'nothing left behind');
  } finally {
    await writeFile(release, 'go');
    await stub.close();
  }
});

const deadPid = () => spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid;
// In the claim's pinned form: a claim records its start time with LC_ALL=C and TZ=UTC.
const realStart = () => spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).stdout.trim();
const CLAIM_ID = '00000000-0000-4000-8000-000000000001';

for (const [label, claim, recovered] of [
  ['a dead owner', () => JSON.stringify({ pid: deadPid(), host: hostname(), started_at: 'whenever' }), true],
  ['a recycled pid', () => JSON.stringify({ pid: process.pid, host: hostname(), started_at: 'not when it started' }), true],
  ['a live owner', () => JSON.stringify({ pid: process.pid, host: hostname(), started_at: realStart() }), false],
  ['a live pid with no start time', () => JSON.stringify({ pid: process.pid, host: hostname() }), false],
  ['a dead pid on another host', () => JSON.stringify({ pid: deadPid(), host: 'elsewhere', started_at: 'whenever' }), false],
  ['a claim with no pid', () => JSON.stringify({ host: hostname(), started_at: 'whenever' }), false],
  ['an unreadable claim', () => '{"pid":', false],
  ['a claim that is not an object', () => '12', false],
]) {
  test(`a claim file left by ${label} is ${recovered ? 'recovered and reported' : 'refused, and stays for a person'}`, async () => {
    const name = `${CSV_NAME}.claim.${CLAIM_ID}.json`;
    const { dir, requests, result } = await applyRun({ rpcAnswer: () => 1, prepare: (d) => writeFile(path.join(d, name), claim()) });
    const left = claimsIn(await readdir(dir));
    if (recovered) {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, new RegExp(`Recovered 1 claim\\(s\\) left by a dead process: ${name}`));
      assert.ok(rpcCalls(requests).length > 0);
      assert.deepEqual(left, []);
    } else {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /another run holds/);
      assert.ok(result.stderr.includes(name), 'the refusal names the claim');
      assert.deepEqual(rpcCalls(requests), []);
      assert.ok(!existsSync(path.join(dir, CSV_NAME)), 'no file started');
      assert.deepEqual(left, [name], 'its own claim is gone and that one stays');
    }
  });
}

test('a claim on another file does not block this one', async () => {
  const live = JSON.stringify({ pid: process.pid, host: hostname(), started_at: realStart() });
  const { dir, result } = await applyRun({
    rpcAnswer: () => 1,
    prepare: async (d) => {
      await writeFile(path.join(d, `triage-disposition-2026-06-15.csv.claim.${CLAIM_ID}.json`), live);
      await writeFile(path.join(d, `x${CSV_NAME}.claim.${CLAIM_ID}.json`), live);
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(claimsIn(await readdir(dir)).length, 0);
});

test('the claim is released when a call fails partway', async () => {
  const { dir, result } = await applyRun({ rpcAnswer: (args) => (args.p_item_id === 'prose' ? 'error' : 1) });
  assert.equal(result.status, 1);
  assert.deepEqual(claimsIn(await readdir(dir)), []);
});

test('a claim removed mid-run is reported with a nonzero exit, and the records still land', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-bank-triage-apply-'));
  const { result } = await applyRun({
    dir,
    rpcAnswer: async () => {
      for (const name of claimsIn(await readdir(dir))) await rm(path.join(dir, name));
      return 1;
    },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /claim on .* was removed while it ran/);
  assert.ok(csvRows(await readFile(path.join(dir, CSV_NAME), 'utf8')).some((r) => r.id === 'verified' && r.outcome === 'applied'));
});

test('--apply keeps the migrated file and the record of what landed when a call then fails', async () => {
  const { dir, result } = await applyRun({ rpcAnswer: (args) => (args.p_item_id === 'prose' ? 'error' : 1), prepare: seedCsv(PRIOR) });
  assert.equal(result.status, 1);
  const rows = csvRows(await readFile(path.join(dir, CSV_NAME), 'utf8'));
  assert.ok(rows.some((r) => r.id === 'prior-1'));
  assert.ok(rows.some((r) => r.id === 'old-copy' && r.outcome === 'applied'));
  assert.ok(!rows.some((r) => r.id === 'prose'));
});

test('a dry run leaves an existing seven-column file untouched', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-bank-triage-dry-'));
  await seedCsv(PRIOR)(dir);
  const fixturePath = path.join(dir, 'fixture.json');
  await writeFile(fixturePath, JSON.stringify({ items: [], projects: [] }));
  const result = spawnSync(process.execPath, [script, `--fixture=${fixturePath}`, `--out-dir=${dir}`, '--stamp=2026-06-14'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(path.join(dir, CSV_NAME), 'utf8'), PRIOR);
  assert.equal((await readdir(dir)).filter((name) => name.includes('pre-evidence')).length, 0);
});
