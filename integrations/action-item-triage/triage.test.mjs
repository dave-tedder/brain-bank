import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bucketize,
  csv,
  mergeMiddle,
  normalizeForDedup,
  projectNameFromDisplay,
  renderReport,
  runCascade,
} from './triage-lib.mjs';

test('projectNameFromDisplay extracts a configured project prefix', () => {
  assert.equal(projectNameFromDisplay('Acme Launch - Website migration'), 'Acme Launch');
  assert.equal(projectNameFromDisplay('Internal maintenance'), null);
});

test('normalizeForDedup collapses task prefixes and articles', () => {
  assert.equal(
    normalizeForDedup('TODO: Rewrite the deployment guide'),
    normalizeForDedup('need to rewrite deployment guide'),
  );
});

test('protected items win before project matching and deduplication', () => {
  const items = [
    { id: 'older', description: 'Do not resolve: Acme Launch contract review' },
    { id: 'newer', description: 'Acme Launch contract review' },
  ];
  const projects = [{ matchTerms: ['Acme Launch'], displayName: 'Acme Launch', status: 'done' }];
  const { decided } = runCascade({ items, projects });
  assert.equal(decided.older.bucket, 'KEEP');
});

test('completed external project resolves a matching item', () => {
  const items = [{ id: 'x', description: 'Finish Acme Launch handoff' }];
  const projects = [{ matchTerms: ['Acme Launch'], displayName: 'Acme Launch', status: 'done' }];
  const { decided } = runCascade({ items, projects });
  assert.equal(decided.x.bucket, 'RESOLVE');
});

test('active external project keeps a matching item', () => {
  const items = [{ id: 'x', description: 'Finish Acme Launch handoff' }];
  const projects = [{ matchTerms: ['Acme Launch'], displayName: 'Acme Launch', status: 'active' }];
  const { decided } = runCascade({ items, projects });
  assert.equal(decided.x.bucket, 'KEEP');
});

test('done status matching is configurable and case-insensitive', () => {
  const items = [{ id: 'x', description: 'Finish Acme Launch handoff' }];
  const projects = [{ matchTerms: ['Acme Launch'], displayName: 'Acme Launch', status: 'Wrapped' }];
  const { decided } = runCascade({ items, projects, doneStatuses: ['wrapped'] });
  assert.equal(decided.x.bucket, 'RESOLVE');
});

test('deduplication archives the older item and keeps newest in the middle', () => {
  const items = [
    { id: 'older', description: 'Rewrite the deployment guide' },
    { id: 'newer', description: 'need to rewrite deployment guide' },
  ];
  const { decided, middle } = runCascade({ items });
  assert.equal(decided.older.bucket, 'ARCHIVE');
  assert.deepEqual(middle.map((item) => item.id), ['newer']);
});

test('configured work-shaped unmatched item goes to review', () => {
  const items = [{ id: 'x', description: 'Confirm supplier contract deadline' }];
  const { decided } = runCascade({ items, workItemShapeTerms: ['contract', 'deadline'] });
  assert.equal(decided.x.bucket, 'REVIEW');
});

test('ambiguous item falls through to classification', () => {
  const items = [{ id: 'x', description: 'Consider simplifying the deploy script' }];
  const { middle } = runCascade({ items });
  assert.deepEqual(middle.map((item) => item.id), ['x']);
});

test('mergeMiddle marks missing classifications pending', () => {
  const out = mergeMiddle({}, [{ id: 'a' }, { id: 'b' }], {
    a: { bucket: 'archive', reason: 'conditional suggestion' },
  });
  assert.equal(out.a.bucket, 'ARCHIVE');
  assert.equal(out.b.bucket, 'PENDING');
});

test('bucketize groups each item with its reason', () => {
  const buckets = bucketize(
    [{ id: 'a', description: 'x' }],
    { a: { bucket: 'KEEP', reason: 'protected' } },
  );
  assert.equal(buckets.KEEP[0].reason, 'protected');
});

test('csv escapes commas, quotes, and newlines', () => {
  assert.equal(csv('plain'), 'plain');
  assert.equal(csv('a,b'), '"a,b"');
  assert.equal(csv('he said "yes"'), '"he said ""yes"""');
  assert.equal(csv('line 1\nline 2'), '"line 1\nline 2"');
});

test('renderReport includes counts and review items', () => {
  const buckets = {
    KEEP: [],
    RESOLVE: [],
    ARCHIVE: [],
    REVIEW: [{ source: 'fixture', type: 'task', age_days: 10, description: 'Review contract', reason: 'work-shaped' }],
    PENDING: [],
  };
  const counts = Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, value.length]));
  const report = renderReport('2026-06-14', counts, buckets);
  assert.match(report, /Total open: 1/);
  assert.match(report, /Review contract/);
});
