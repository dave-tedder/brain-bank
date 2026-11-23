import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  addDryRunExternalCompletionSignals,
  applyDispositions,
  bucketize,
  CLASSIFIER_SYSTEM,
  csv,
  csvRecords,
  DECISION_HELD_PREFIX,
  DISPOSITION_HEADER,
  dispositionLines,
  LEGACY_DISPOSITION_HEADER,
  llmDecision,
  normalizeMiddleDecision,
  parseCsv,
  planDispositionBytes,
  planDispositionFile,
  projectStatusEvidence,
  TRIAGE_ACTOR,
  triageTransitionArgs,
  externalCompletionEvidenceForItem,
  isOperationCommandText,
  mergeMiddle,
  normalizeEvidenceText,
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

test('normalizeEvidenceText prepares conservative source-of-truth matching', () => {
  assert.equal(normalizeEvidenceText('Acme Launch, Inc.'), 'acme launch inc');
});

test('isOperationCommandText detects only supported operation commands', () => {
  assert.equal(isOperationCommandText('Add appointment Acme Launch kickoff'), true);
  assert.equal(isOperationCommandText('New project Sam Smith migration'), true);
  assert.equal(isOperationCommandText('Reschedule Taylor Morgan to Saturday May 23, 12pm-5pm'), true);
  assert.equal(
    isOperationCommandText('reschedule sam smith appointment from march 20 to this saturday 1:30pm-8pm'),
    true,
  );
  assert.equal(isOperationCommandText('Need to reschedule the planning review after tests pass'), false);
  assert.equal(isOperationCommandText('Consider adding a better report'), false);
});

test('external completion evidence requires a brain-channel operation command', () => {
  const evidence = {
    projects: [{ displayName: 'Acme Launch', matchTermsNorm: ['acme launch'] }],
    events: [],
  };
  assert.equal(
    externalCompletionEvidenceForItem(
      {
        id: 'x',
        source: 'brain-channel',
        description: 'Add appointment Acme Launch kickoff',
        preview: 'Add appointment Acme Launch kickoff for next week',
      },
      evidence,
    ),
    'external-command-completed dry-run only: matching project "Acme Launch"',
  );
  assert.equal(
    externalCompletionEvidenceForItem(
      {
        id: 'x',
        source: 'manual',
        description: 'Add appointment Acme Launch kickoff',
        preview: 'Add appointment Acme Launch kickoff for next week',
      },
      evidence,
    ),
    null,
  );
});

test('external completion evidence can match mirrored event titles and attendees', () => {
  const evidence = {
    projects: [],
    events: [{
      title: 'Acme Launch kickoff',
      titleNorm: 'acme launch kickoff',
      attendeesNorm: ['jane doe'],
    }],
  };
  assert.match(
    externalCompletionEvidenceForItem(
      {
        id: 'x',
        source: 'brain-channel',
        description: 'Add appointment Acme Launch kickoff',
        preview: 'Add appointment Acme Launch kickoff',
      },
      evidence,
    ),
    /matching event/,
  );
  assert.match(
    externalCompletionEvidenceForItem(
      {
        id: 'y',
        source: 'brain-channel',
        description: 'Add appointment Jane Doe check-in',
        preview: 'Add appointment Jane Doe check-in',
      },
      evidence,
    ),
    /matching event attendee/,
  );
});

test('dry-run external completion signals are review-only overlays', () => {
  const decided = { a: { bucket: 'PENDING', reason: 'awaiting classification' } };
  const { decided: withSignals, matches } = addDryRunExternalCompletionSignals(
    decided,
    [{
      id: 'a',
      source: 'brain-channel',
      description: 'New project Acme Launch rollout',
      preview: 'New project Acme Launch rollout',
    }],
    { projects: [{ displayName: 'Acme Launch', matchTermsNorm: ['acme launch'] }], events: [] },
  );
  assert.equal(withSignals.a.bucket, 'REVIEW');
  assert.equal(matches.length, 1);
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
    a: { bucket: 'archive', close_reason: 'fragment', reason: 'conditional suggestion' },
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

test('csv escapes commas, quotes, carriage returns, and newlines', () => {
  assert.equal(csv('plain'), 'plain');
  assert.equal(csv('a\rb'), '"a\rb"');
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
  assert.match(report, /\| RESOLVE \| 0 \| status=resolved, close_reason=done/);
  assert.match(report, /\| ARCHIVE \| 0 \| status=archived, close_reason=fragment or duplicate/);
});

// --- --apply goes through the guarded RPC ------------------------------------------

test('triageTransitionArgs: resolve closes as done, with actor, guard and note', () => {
  const args = triageTransitionArgs({ id: 'i1', closeReason: 'done', evidence: 'project-status:projects-table:Acme Launch', reason: 'external project complete: "Acme Launch" (done)' }, 'resolved');
  assert.equal(args.p_item_id, 'i1');
  assert.deepEqual(args.p_from_statuses, ['open']);
  assert.equal(args.p_to_status, 'resolved');
  assert.equal(args.p_actor, TRIAGE_ACTOR);
  assert.equal(args.p_close_reason, 'done');
  assert.equal(args.p_resolution_note, 'triage: external project complete: "Acme Launch" (done)');
  assert.equal(args.p_event_payload.tool, TRIAGE_ACTOR);
  assert.equal(args.p_event_payload.evidence, 'project-status:projects-table:Acme Launch');
  assert.equal('p_duplicate_of' in args, false);
});

test('triageTransitionArgs reads only the explicit close reason, never the free text', () => {
  const dup = triageTransitionArgs({ id: 'i2', closeReason: 'duplicate', duplicateOf: 'aaaa-bbbb', reason: 'duplicate-of aaaa-bbbb' }, 'archived');
  assert.equal(dup.p_close_reason, 'duplicate');
  assert.equal(dup.p_duplicate_of, 'aaaa-bbbb');
  const prose = triageTransitionArgs({ id: 'i3', closeReason: 'fragment', reason: 'consider a nicer report someday' }, 'archived');
  assert.equal(prose.p_close_reason, 'fragment');
  assert.equal('p_duplicate_of' in prose, false);
  const spoof = triageTransitionArgs({ id: 'i4', closeReason: 'fragment', reason: 'duplicate-of x' }, 'archived');
  assert.equal(spoof.p_close_reason, 'fragment', 'a reason cannot name a survivor');
  assert.equal('p_duplicate_of' in spoof, false);
  assert.equal(triageTransitionArgs({ id: 'i5', closeReason: 'fragment' }, 'archived').p_resolution_note, 'triage: no reason recorded');
});

test('triageTransitionArgs throws rather than give an item a reason it does not have', () => {
  const noReason = /no valid close reason/;
  assert.throws(() => triageTransitionArgs({ id: 'a', reason: 'shipped in commit abcdef1' }, 'archived'), noReason);
  assert.throws(() => triageTransitionArgs({ id: 'b', reason: 'looks done' }, 'resolved'), noReason);
  assert.throws(() => triageTransitionArgs({ id: 'c', closeReason: 'done' }, 'archived'), noReason, 'done under archived');
  assert.throws(() => triageTransitionArgs({ id: 'd', closeReason: 'fragment' }, 'resolved'), noReason, 'fragment under resolved');
  assert.throws(() => triageTransitionArgs({ id: 'e', closeReason: 'duplicate' }, 'archived'), noReason, 'duplicate with no survivor');
  assert.throws(() => triageTransitionArgs({ id: 'f', closeReason: 'done' }, 'open'), noReason, 'a status triage never writes');
  assert.throws(() => triageTransitionArgs({ id: 'g', closeReason: 'wont_do' }, 'archived'), noReason);
});

test('normalizeMiddleDecision: a true fragment and verified finished work, explicitly', () => {
  assert.deepEqual(
    normalizeMiddleDecision({ bucket: 'archive', close_reason: 'fragment', reason: ' Consider a nicer report ' }),
    { bucket: 'ARCHIVE', reason: 'Consider a nicer report', closeReason: 'fragment' },
  );
  assert.deepEqual(
    normalizeMiddleDecision({ bucket: 'RESOLVE', close_reason: 'done', evidence: 'commit:abcdef1', reason: 'the migration shipped' }),
    { bucket: 'RESOLVE', reason: 'the migration shipped', closeReason: 'done', evidence: 'commit:abcdef1' },
  );
  for (const evidence of ['commit:abcdef1', 'commit:' + 'a'.repeat(40), 'pr:example-org/brain-bank#19', 'card:0a1b2c3d', 'card:0a1b2c3d-0000-4000-8000-000000000000', 'thought:e3c698f3-0000-4000-8000-000000000000', 'url:https://example.com/a']) {
    assert.equal(normalizeMiddleDecision({ bucket: 'RESOLVE', close_reason: 'done', evidence, reason: 'r' }).bucket, 'RESOLVE', evidence);
  }
  assert.deepEqual(normalizeMiddleDecision({ bucket: 'keep', reason: 'real' }), { bucket: 'KEEP', reason: 'real' });
  assert.deepEqual(normalizeMiddleDecision({ reason: 'no bucket means look' }), { bucket: 'REVIEW', reason: 'no bucket means look' });
});

test('normalizeMiddleDecision: anything that cannot justify a close stays in REVIEW, and says why', () => {
  const heldBecause = (decision, why) => {
    const out = normalizeMiddleDecision(decision);
    assert.equal(out.bucket, 'REVIEW', JSON.stringify(decision));
    assert.equal(out.held, true, JSON.stringify(decision));
    assert.ok(out.reason.startsWith(DECISION_HELD_PREFIX), out.reason);
    assert.match(out.reason, why);
    assert.equal(out.closeReason, undefined, 'a held decision carries no close reason');
    assert.equal(out.evidence, undefined);
  };
  // Finished work named only in free text, and every legacy ARCHIVE: free text is not a reason.
  heldBecause({ bucket: 'ARCHIVE', reason: 'shipped in commit abcdef1' }, /names no close_reason.*It said: shipped in commit abcdef1/);
  heldBecause({ bucket: 'ARCHIVE', reason: 'Consider a nicer report' }, /names no close_reason/);
  heldBecause({ bucket: 'ARCHIVE', close_reason: null, reason: 'x' }, /names no close_reason/);
  heldBecause({ bucket: 'ARCHIVE', close_reason: 'done', evidence: 'commit:abcdef1', reason: 'x' }, /only as fragment.*finished work is RESOLVE/);
  heldBecause({ bucket: 'ARCHIVE', close_reason: 'duplicate', reason: 'duplicate-of aaaa' }, /only as fragment/);
  heldBecause({ bucket: 'ARCHIVE', close_reason: 'wont_do', reason: 'x' }, /only as fragment/);
  heldBecause({ bucket: 'ARCHIVE', close_reason: 'FRAGMENT', reason: 'x' }, /only as fragment/);
  heldBecause({ bucket: 'ARCHIVE', close_reason: 'fragment', reason: '   ' }, /needs its reason/);
  heldBecause({ bucket: 'ARCHIVE', close_reason: 'fragment' }, /needs its reason/);
  heldBecause({ bucket: 'RESOLVE', reason: 'shipped in commit abcdef1' }, /only as done/);
  heldBecause({ bucket: 'RESOLVE', close_reason: 'fragment', evidence: 'commit:abcdef1', reason: 'x' }, /only as done/);
  heldBecause({ bucket: 'RESOLVE', close_reason: 'done', reason: 'shipped in commit abcdef1' }, /checkable evidence pointer/);
  for (const evidence of ['trust me', 'shipped in commit abcdef1', 'commit:', 'commit:xyz', 'commit:abc', ' commit:abcdef1', 'url:ftp://x', 42, null, {}]) {
    heldBecause({ bucket: 'RESOLVE', close_reason: 'done', evidence, reason: 'x' }, /checkable evidence pointer/);
  }
  heldBecause({ bucket: 'RESOLVE', close_reason: 'done', evidence: 'commit:abcdef1', reason: '' }, /needs its reason/);
  heldBecause({ bucket: 'TRASH', reason: 'x' }, /unknown bucket/);
  for (const notObject of ['ARCHIVE', 7, null, ['ARCHIVE']]) heldBecause(notObject, /not an object/);
});

test('mergeMiddle: an absent decision blocks as PENDING, a present one goes through the contract', () => {
  const out = mergeMiddle({ d: { bucket: 'KEEP', reason: 'x' } }, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], {
    a: { bucket: 'ARCHIVE', reason: 'legacy' },
    b: null,
  });
  assert.equal(out.d.bucket, 'KEEP', 'the cascade is left alone');
  assert.equal(out.a.bucket, 'REVIEW');
  assert.equal(out.a.held, true);
  assert.equal(out.b.bucket, 'REVIEW', 'a null entry is a broken decision, not an unclassified item');
  assert.equal(out.c.bucket, 'PENDING');
});

test('the cascade carries its close reason explicitly, and bucketize keeps it for apply', () => {
  const items = [
    { id: 'old', description: 'Rewrite the notes', created_at: '2026-06-01T00:00:00Z' },
    { id: 'new', description: 'rewrite notes', created_at: '2026-06-02T00:00:00Z' },
    { id: 'project', description: 'Finish Acme Launch handoff', created_at: '2026-06-03T00:00:00Z' },
    { id: 'active', description: 'Draft the Beta Rollout plan', created_at: '2026-06-04T00:00:00Z' },
  ];
  const { decided } = runCascade({
    items,
    projects: [
      { matchTerms: ['Acme Launch'], displayName: 'Acme Launch - Website migration', status: 'done', statusSource: 'projects-table' },
      { matchTerms: ['Beta Rollout'], displayName: 'Beta Rollout', status: 'active', statusSource: 'projects-table' },
    ],
  });
  assert.equal(decided.old.closeReason, 'duplicate');
  assert.equal(decided.old.duplicateOf, 'new');
  assert.equal(decided.project.closeReason, 'done');
  assert.equal(decided.project.evidence, 'project-status:projects-table:Acme Launch - Website migration');
  assert.equal(decided.active.closeReason, undefined, 'an active project closes nothing');
  assert.equal(projectStatusEvidence({ displayName: 'X' }), 'project-status:unknown:X', 'a project with no source says so');
  const buckets = bucketize(items, { ...decided, new: { bucket: 'KEEP', reason: 'r' } });
  assert.equal(triageTransitionArgs(buckets.ARCHIVE[0], 'archived').p_duplicate_of, 'new');
  const resolve = triageTransitionArgs(buckets.RESOLVE[0], 'resolved');
  assert.equal(resolve.p_close_reason, 'done');
  assert.equal(resolve.p_event_payload.evidence, 'project-status:projects-table:Acme Launch - Website migration');
});

test('the classifier cannot produce done, and its instructions send possibly finished work to REVIEW', () => {
  assert.equal(llmDecision({ bucket: 'resolve', close_reason: 'done', evidence: 'commit:abcdef1', reason: 'x' }).bucket, 'REVIEW');
  assert.equal(llmDecision({}).bucket, 'REVIEW');
  const fragment = llmDecision({ bucket: 'archive', close_reason: 'fragment', reason: 'q'.repeat(300) });
  assert.equal(fragment.reason.length, 200);
  assert.deepEqual(normalizeMiddleDecision(fragment), { bucket: 'ARCHIVE', reason: 'q'.repeat(200), closeReason: 'fragment' });
  // A model that follows the old rule, or forgets the field, is held and stays open.
  assert.equal(normalizeMiddleDecision(llmDecision({ bucket: 'archive', reason: 'shipped' })).held, true);
  assert.equal(normalizeMiddleDecision(llmDecision({ bucket: 'archive', close_reason: 'done', reason: 'shipped' })).held, true);
  const rule = (start) => CLASSIFIER_SYSTEM.split('\n').find((line) => line.startsWith(start));
  const archiveRule = rule('ARCHIVE');
  assert.doesNotMatch(archiveRule, /shipped|complete|finished|done/i);
  assert.match(archiveRule, /"close_reason":"fragment"/);
  const reviewRule = rule('REVIEW');
  assert.match(reviewRule, /may already be finished/);
  assert.match(reviewRule, /Never ARCHIVE finished work/);
  for (const term of ['client', 'customer', 'money', 'legal']) assert.match(reviewRule, new RegExp(term));
  assert.match(rule('Return strict JSON'), /"close_reason":"fragment\|null"/);
});

test('applyDispositions: a row that left open is skipped and recorded, not treated as applied', async () => {
  const seen = [];
  const answers = { a: 1, b: 0, c: 1 };
  const records = await applyDispositions(
    [{ id: 'a', closeReason: 'fragment', reason: 'r' }, { id: 'b', closeReason: 'fragment', reason: 'r' }, { id: 'c', closeReason: 'fragment', reason: 'r' }],
    'archived',
    async (args) => { seen.push(args.p_item_id); return answers[args.p_item_id]; },
  );
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.deepEqual(records.map((r) => r.outcome), ['applied', 'skipped_status_changed', 'applied']);
  assert.deepEqual(records.map((r) => r.closeReason), ['fragment', 'fragment', 'fragment']);
});

test('applyDispositions: an unexpected count or an error stops the run and keeps the record so far', async () => {
  const records = [];
  await assert.rejects(
    applyDispositions(['a', 'b', 'c'].map((id) => ({ id, closeReason: 'fragment' })), 'archived', async (args) => (args.p_item_id === 'b' ? 2 : 1), records),
    /returned 2 for b/,
  );
  assert.deepEqual(records.map((r) => r.item.id), ['a']);
  const failing = [];
  await assert.rejects(
    applyDispositions(['a', 'b'].map((id) => ({ id, closeReason: 'done' })), 'resolved', async (args) => {
      if (args.p_item_id === 'b') throw new Error('Supabase 500');
      return 1;
    }, failing),
    /Supabase 500/,
  );
  assert.deepEqual(failing.map((r) => r.item.id), ['a']);
});

test('dispositionLines carries the close reason and the outcome, under the header', () => {
  const [line] = dispositionLines([{ item: { id: 'a', reason: 'x, y', description: 'd', evidence: 'commit:abcdef1' }, newStatus: 'resolved', closeReason: 'done', outcome: 'applied' }]);
  assert.equal(line, 'a,open,resolved,done,applied,"x, y",d,commit:abcdef1');
  assert.equal(DISPOSITION_HEADER.split(',').length, 8);
  const [noEvidence] = dispositionLines([{ item: { id: 'b', reason: 'r', description: 'd' }, newStatus: 'archived', closeReason: 'fragment', outcome: 'applied' }]);
  assert.equal(noEvidence, 'b,open,archived,fragment,applied,r,d,');
});

// --- An existing disposition file ---------------------------------------------------

const byName = (text) => {
  const [header, ...rows] = csvRecords(text).filter((r) => r.raw !== '');
  return rows.map((row) => Object.fromEntries(row.cells.map((cell, i) => [header.cells[i] ?? `unheaded-${i}`, cell])));
};

test('csvRecords reads quoted commas, doubled quotes, line breaks and CRLF, and refuses an open quote', () => {
  const records = csvRecords('a,"b, c","d ""e"" f"\r\n1,"two\nlines",3\n');
  assert.deepEqual(records.map((r) => r.cells), [['a', 'b, c', 'd "e" f'], ['1', 'two\nlines', '3']]);
  assert.equal(records[1].raw, '1,"two\nlines",3', 'the raw text survives');
  assert.deepEqual(csvRecords('a,b').map((r) => r.cells), [['a', 'b']], 'no final newline');
  assert.deepEqual(csvRecords('a,\n').map((r) => r.cells), [['a', '']], 'a trailing empty field counts');
  assert.equal(csvRecords('a,"b\n'), null);
});

test('planDispositionFile migrates the seven-column file, keeping every record and naming evidence', () => {
  const prior = `${LEGACY_DISPOSITION_HEADER}\nold-1,open,archived,fragment,applied,"x, y","quoted ""d"" and\nnewline"\nold-2,open,archived,fragment,applied,r,d\n`;
  const plan = planDispositionFile(prior);
  assert.equal(plan.action, 'migrate');
  assert.equal(plan.records, 2);
  assert.equal(plan.content, `${DISPOSITION_HEADER}\nold-1,open,archived,fragment,applied,"x, y","quoted ""d"" and\nnewline",\nold-2,open,archived,fragment,applied,r,d,\n`);
  const rows = byName(plan.content);
  assert.equal(rows[0].description, 'quoted "d" and\nnewline');
  assert.equal(rows[0].reason, 'x, y');
  assert.equal(rows[0].evidence, '', 'a prior row has an empty evidence field, by name');
  assert.equal(planDispositionFile(plan.content).action, 'append', 'migrating twice is not possible');
});

test('planDispositionFile keeps the eight-field records the old head appended under the seven-column header', () => {
  const damaged = `${LEGACY_DISPOSITION_HEADER}\nold,open,archived,fragment,applied,r,d\nnew,open,resolved,done,applied,r,d,commit:abcdef1\n`;
  const plan = planDispositionFile(damaged);
  assert.equal(plan.action, 'migrate');
  const rows = byName(plan.content);
  assert.equal(rows[0].evidence, '');
  assert.equal(rows[1].evidence, 'commit:abcdef1', 'the evidence it could not name before is now named');
  assert.ok(!plan.content.includes('commit:abcdef1,'), 'an eight-field record gains nothing');
});

test('planDispositionFile: the current header appends, and a short row under it refuses', () => {
  const current = `${DISPOSITION_HEADER}\na,open,resolved,done,applied,r,d,commit:abcdef1\n`;
  assert.deepEqual(planDispositionFile(current), { action: 'append', needsNewline: false, records: 1 });
  assert.equal(planDispositionFile(current.trimEnd()).needsNewline, true);
  assert.equal(planDispositionFile(current.trimEnd()).unterminatedLast, 'a,open,resolved,done,applied,r,d,commit:abcdef1', 'a last record with no line ending is named');
  assert.equal(planDispositionFile(current).unterminatedLast, undefined);
  assert.equal(planDispositionFile(`${LEGACY_DISPOSITION_HEADER}\nold,open,archived,fragment,applied,r,d`).unterminatedLast, 'old,open,archived,fragment,applied,r,d', 'on a migration too');
  assert.equal(planDispositionFile(`﻿${current}`).action, 'append', 'a spreadsheet BOM');
  assert.equal(planDispositionFile(current.replaceAll('\n', '\r\n')).action, 'append', 'spreadsheet CRLF');
  assert.equal(planDispositionFile(`${current}\n\n`).records, 1, 'blank lines are not records');
  const short = planDispositionFile(`${DISPOSITION_HEADER}\na,open,resolved,done,applied,description,commit:1234567\n`);
  assert.equal(short.action, 'refuse', 'nothing says which field is missing');
  assert.match(short.problem, /record with 7 fields under the current header/);
  assert.equal(planDispositionFile('').action, 'create');
  assert.equal(planDispositionFile(' \n').action, 'create');
});

test('planDispositionFile refuses what it cannot place: unknown header, wrong width, open quote', () => {
  const refused = (text) => {
    const plan = planDispositionFile(text);
    assert.equal(plan.action, 'refuse', text);
    assert.equal(plan.content, undefined);
    return plan.problem;
  };
  assert.match(refused('id,old_status,new_status,bucket,reason,description\na,open,archived,ARCHIVE,r,d\n'), /unrecognized header: id,old_status,new_status,bucket/);
  assert.match(refused('id,something,else\n'), /unrecognized header/);
  assert.match(refused(`${LEGACY_DISPOSITION_HEADER},extra\n`), /unrecognized header/);
  assert.match(refused(`${LEGACY_DISPOSITION_HEADER}\na,b,c\n`), /record with 3 fields/);
  assert.match(refused(`${LEGACY_DISPOSITION_HEADER}\na,b,c,d,e,f\n`), /record with 6 fields/);
  assert.match(refused(`${DISPOSITION_HEADER}\na,b,c,d,e,f,g,h,i\n`), /record with 9 fields/);
  assert.match(refused(`${DISPOSITION_HEADER}\na,open,resolved,done,applied,"torn\n`), /never closes/);
  assert.match(refused(`${LEGACY_DISPOSITION_HEADER}\na,b,c,d,e,f,g,h,i\n`), /record with 9 fields under the seven-column header/);
});

test('parseCsv refuses what a standard parser would read differently, and names the boundary', () => {
  const problem = (text) => {
    const parsed = parseCsv(text);
    assert.equal(parsed.records, undefined, JSON.stringify(text));
    assert.equal(csvRecords(text), null);
    return parsed.problem;
  };
  assert.match(problem('a"b,c\n'), /a quote inside an unquoted field/);
  assert.match(problem('"a"junk,c\n'), /text after a closing quote/);
  assert.match(problem('"a" ,c\n'), /text after a closing quote/);
  assert.match(problem('a,b\rc,d\n'), /a bare carriage return outside quotes/);
  assert.match(problem('"a"\rb\n'), /a bare carriage return outside quotes/);
  assert.match(problem('a,b\0,c\n'), /a NUL byte/);
  assert.match(problem('"a\0b",c\n'), /a NUL byte/);
  assert.match(problem('a,"b'), /never closes/);
  assert.match(problem('first,row\nsecond"x,row\n'), /in record 2: second/);
  assert.deepEqual(parseCsv('"",""\n').records[0].cells, ['', ''], 'an empty quoted field is valid');
  assert.deepEqual(parseCsv('"a\rb",c\n').records[0].cells, ['a\rb', 'c'], 'a carriage return inside quotes is data');
});

test('planDispositionFile refuses the review\'s malformed rows under either header, with no content', () => {
  for (const header of [LEGACY_DISPOSITION_HEADER, DISPOSITION_HEADER]) {
    for (const row of ['prior,open,archived,fragment,applied,a"b,c",desc', 'prior,open,archived,fragment,applied,"a"junk,desc', 'prior,open,archived,fragment,applied,a\rb,desc']) {
      const plan = planDispositionFile(`${header}\n${row}\n`);
      assert.equal(plan.action, 'refuse', row);
      assert.equal(plan.content, undefined);
    }
  }
});

test('planDispositionBytes refuses bytes that are not UTF-8, and reads a BOM', () => {
  const header = Buffer.from(`${DISPOSITION_HEADER}\n`);
  const plan = planDispositionBytes(Buffer.concat([header, Buffer.from([0x61, 0x2c, 0xc3])]));
  assert.equal(plan.action, 'refuse');
  assert.match(plan.problem, /not valid UTF-8/);
  assert.equal(planDispositionBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), header])).action, 'append');
});

test('csv quotes a carriage return, so this tool never writes a record its own parser refuses', () => {
  const [line] = dispositionLines([{ item: { id: 'a', reason: 'one\rtwo', description: 'three\r\nfour', evidence: 'x,"y"' }, newStatus: 'resolved', closeReason: 'done', outcome: 'applied' }]);
  assert.deepEqual(parseCsv(`${line}\n`).records[0].cells, ['a', 'open', 'resolved', 'done', 'applied', 'one\rtwo', 'three\r\nfour', 'x,"y"']);
});

// Differential against a real parser, over text built to hit every boundary. What this
// parser accepts, Python's strict reader must accept with the same records. Python also
// accepts some text this one refuses, such as a quote inside an unquoted field: that
// direction is the conservative one and is counted, not hidden.
test('parseCsv agrees with Python csv strict mode on everything it accepts', () => {
  const alphabet = ['a', 'b', ',', '"', '"', '\n', '\r', '\r\n', ' ', '\u00e9'];
  let seed = 20261107;
  const next = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const samples = Array.from({ length: 4000 }, () => Array.from({ length: next(16) }, () => alphabet[next(alphabet.length)]).join(''));
  const python = `
import csv, io, json, sys
out = []
for s in json.load(sys.stdin):
    try:
        out.append([r for r in csv.reader(io.StringIO(s, newline=''), strict=True) if r])
    except csv.Error:
        out.append(None)
json.dump(out, sys.stdout)
`;
  const run = spawnSync('python3', ['-I', '-c', python], { input: JSON.stringify(samples), encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(run.status, 0, `python3 is required for this test: ${run.error || run.stderr}`);
  const theirs = JSON.parse(run.stdout);
  let accepted = 0;
  let stricter = 0;
  samples.forEach((sample, i) => {
    const records = csvRecords(sample);
    if (records === null) {
      if (theirs[i] !== null) stricter += 1;
      return;
    }
    accepted += 1;
    assert.notEqual(theirs[i], null, `accepted here, rejected by Python: ${JSON.stringify(sample)}`);
    assert.deepEqual(records.filter((r) => r.raw !== '').map((r) => r.cells), theirs[i], JSON.stringify(sample));
  });
  assert.ok(accepted > 500, `the samples must reach acceptance, got ${accepted}`);
  assert.ok(accepted < samples.length, 'and must reach refusal');
  assert.ok(stricter > 0, 'the stricter direction is exercised');
});
