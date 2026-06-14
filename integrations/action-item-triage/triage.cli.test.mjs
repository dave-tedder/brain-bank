import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
