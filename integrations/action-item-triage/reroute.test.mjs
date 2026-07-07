// node --test reroute.test.mjs
// Unit tests for the unknown-project reroute report lib (Session 272).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRouteMap,
  isUnroutedProject,
  proposeReroutes,
  routeProjectFromContent,
} from './reroute-lib.mjs';

const MAP = buildRouteMap([
  { slug: 'jane-website', route_phrases: ['janedoe.com'] },
  { slug: 'studio-website', route_phrases: ['janedoestudio.com'] },
  { slug: 'seo-agent', route_phrases: ['seo agent', 'seo-agent'] },
  { slug: 'brain-bank', route_phrases: [] },
  { slug: 'no-phrases', route_phrases: null },
]);

test('buildRouteMap keeps only rows with non-empty phrases', () => {
  assert.equal(MAP.size, 3);
  assert.equal(MAP.has('brain-bank'), false);
  assert.equal(MAP.has('no-phrases'), false);
});

test('routeProjectFromContent: unique match routes, case-insensitive', () => {
  assert.equal(
    routeProjectFromContent('Fixed the SEO Agent weekly crawl', MAP),
    'seo-agent',
  );
});

test('routeProjectFromContent: two distinct projects -> null', () => {
  assert.equal(
    routeProjectFromContent(
      'digest touching janedoe.com and janedoestudio.com',
      MAP,
    ),
    null,
  );
});

test('routeProjectFromContent: no match -> null', () => {
  assert.equal(routeProjectFromContent('utility bill reminder', MAP), null);
});

test('routeProjectFromContent: short phrases are ignored', () => {
  const map = buildRouteMap([{ slug: 'x', route_phrases: ['a', ' '] }]);
  assert.equal(routeProjectFromContent('a note with the letter a', map), null);
});

test('isUnroutedProject: null, empty, and unknown are in scope', () => {
  assert.equal(isUnroutedProject(null), true);
  assert.equal(isUnroutedProject(undefined), true);
  assert.equal(isUnroutedProject(''), true);
  assert.equal(isUnroutedProject('unknown'), true);
  assert.equal(isUnroutedProject('Unknown'), true);
  assert.equal(isUnroutedProject('brain-bank'), false);
});

test('proposeReroutes: routes unrouted rows and skips already-routed ones', () => {
  const rows = [
    {
      id: 'a1',
      description: 'fix footer',
      source_thought_id: 't1',
      thought: {
        id: 't1',
        content: 'session log: shipped footer fix on janedoe.com',
        project: null,
      },
    },
    {
      id: 'a2',
      description: 'already routed',
      source_thought_id: 't2',
      thought: { id: 't2', content: 'janedoe.com note', project: 'brain-bank' },
    },
    {
      id: 'a3',
      description: 'no signal',
      source_thought_id: 't3',
      thought: { id: 't3', content: 'random reminder', project: 'unknown' },
    },
  ];
  const { proposals, unmatched, skipped } = proposeReroutes(rows, MAP);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].action_item_id, 'a1');
  assert.equal(proposals[0].thought_id, 't1');
  assert.equal(proposals[0].proposed_project, 'jane-website');
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].action_item_id, 'a3');
  assert.equal(skipped.length, 1);
});

test('proposeReroutes: dedups multiple items from the same thought', () => {
  const rows = [
    {
      id: 'a1',
      description: 'one',
      source_thought_id: 't1',
      thought: { id: 't1', content: 'work on janedoe.com', project: null },
    },
    {
      id: 'a2',
      description: 'two',
      source_thought_id: 't1',
      thought: { id: 't1', content: 'work on janedoe.com', project: null },
    },
  ];
  const { proposals } = proposeReroutes(rows, MAP);
  assert.equal(proposals.length, 2); // one line per action item…
  const thoughtIds = new Set(proposals.map((p) => p.thought_id));
  assert.equal(thoughtIds.size, 1); // …but a single thought UPDATE target
});
