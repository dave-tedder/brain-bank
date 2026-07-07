#!/usr/bin/env node
// Open Brain — unknown-project reroute report (Session 272, READ-ONLY).
//
// Lists every OPEN action item whose source thought has a null/unknown
// metadata.project, applies the projects.route_phrases route map in dry-run
// (same unique-match semantics the capture paths now use live), and writes a
// markdown approval packet with exact IDs. Performs NO writes of any kind.
//
// Usage:
//   node reroute-report.mjs                # writes out/reroute-report-<date>.md
//   node reroute-report.mjs --stdout       # print instead of writing
//
// Requires .env in this directory (gitignored): SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY. Same conventions as triage.mjs.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRouteMap,
  isUnroutedProject,
  proposeReroutes,
  renderReport,
} from './reroute-lib.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(join(SCRIPT_DIR, '.env'));
} catch {
  /* fall back to ambient process.env */
}
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (.env)');
  process.exit(1);
}

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status} ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const stamp = new Date().toISOString().slice(0, 10);

const projects = await sb('projects?select=slug,route_phrases');
const routeMap = buildRouteMap(projects);
console.error(`route map: ${routeMap.size} projects with phrases`);

// Open action items with their source thought (FK embed). Paged to be safe.
const rows = [];
for (let offset = 0; ; offset += 1000) {
  const page = await sb(
    `action_items?select=id,description,created_at,source_thought_id,thoughts!action_items_source_thought_id_fkey(id,content,metadata)&status=eq.open&order=created_at.asc&limit=1000&offset=${offset}`,
  );
  rows.push(...page);
  if (page.length < 1000) break;
}
console.error(`open action items: ${rows.length}`);

const shaped = rows.map((r) => ({
  id: r.id,
  description: r.description,
  created_at: r.created_at,
  source_thought_id: r.source_thought_id,
  thought: {
    id: r.thoughts?.id ?? r.source_thought_id,
    content: r.thoughts?.content ?? '',
    project: r.thoughts?.metadata?.project ?? null,
  },
}));

const inScope = shaped.filter((r) => isUnroutedProject(r.thought.project)).length;
const result = proposeReroutes(shaped, routeMap);
const report = renderReport(result, stamp);

console.error(
  `in scope (null/unknown project): ${inScope} — proposed: ${result.proposals.length}, unmatched: ${result.unmatched.length}`,
);

if (process.argv.includes('--stdout')) {
  console.log(report);
} else {
  const outPath = join(SCRIPT_DIR, 'out', `reroute-report-${stamp}.md`);
  writeFileSync(outPath, report);
  console.error(`wrote ${outPath}`);
}
