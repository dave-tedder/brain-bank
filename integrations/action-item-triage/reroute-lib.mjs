// Pure helpers for the unknown-project reroute report (Session 272).
// Mirrors the routing semantics of supabase/functions/_shared/
// metadata-validation.ts (routeProjectFromContent): unique-match only,
// phrases under 4 chars ignored. Keep the two in sync if semantics change.

const ROUTE_PHRASE_MIN_LENGTH = 4;

export function buildRouteMap(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const phrases = (row.route_phrases || []).filter(
      (p) => typeof p === 'string' && p.trim().length > 0,
    );
    if (row.slug && phrases.length > 0) map.set(row.slug, phrases);
  }
  return map;
}

export function routeProjectFromContent(content, routeMap) {
  if (!routeMap || routeMap.size === 0) return null;
  const haystack = String(content || '').toLowerCase();
  let matched = null;
  for (const [slug, phrases] of routeMap) {
    const hit = phrases.some((p) => {
      const needle = p.trim().toLowerCase();
      return needle.length >= ROUTE_PHRASE_MIN_LENGTH && haystack.includes(needle);
    });
    if (!hit) continue;
    if (matched !== null) return null; // two distinct projects -> ambiguous
    matched = slug;
  }
  return matched;
}

// Scope rule from the tracker item: only rows whose source thought has no
// usable project ('unknown' is the historical pre-coercion LLM literal).
export function isUnroutedProject(project) {
  const p = String(project ?? '').trim().toLowerCase();
  return p === '' || p === 'unknown';
}

// rows: [{ id, description, created_at, source_thought_id,
//          thought: { id, content, project } }]
// Returns { proposals, unmatched, skipped } — proposals carry exact IDs for
// the approval packet; nothing here writes anywhere.
export function proposeReroutes(rows, routeMap) {
  const proposals = [];
  const unmatched = [];
  const skipped = [];
  for (const row of rows || []) {
    const thought = row.thought || {};
    if (!isUnroutedProject(thought.project)) {
      skipped.push({ action_item_id: row.id, current_project: thought.project });
      continue;
    }
    const proposed = routeProjectFromContent(thought.content, routeMap);
    const base = {
      action_item_id: row.id,
      thought_id: thought.id ?? row.source_thought_id,
      created_at: row.created_at,
      description: row.description,
      current_project: thought.project ?? null,
    };
    if (proposed) proposals.push({ ...base, proposed_project: proposed });
    else unmatched.push(base);
  }
  return { proposals, unmatched, skipped };
}

// Markdown table cell: escape backslashes before pipes (escaping pipes alone
// lets a trailing backslash re-arm them), flatten newlines, bound length.
function mdCell(raw) {
  return String(raw)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .slice(0, 90);
}

export function renderReport({ proposals, unmatched, skipped }, stamp) {
  const lines = [];
  lines.push(`# Unknown-project reroute report — ${stamp}`);
  lines.push('');
  lines.push('Read-only dry run.');
  lines.push(
    'Proposes `thoughts.metadata.project` values for open action items whose source',
  );
  lines.push(
    'thought has a null/unknown project, using the `projects.route_phrases` route map',
  );
  lines.push(
    '(unique-match only). NO writes were performed. Apply requires the operator',
  );
  lines.push('approving the exact thought IDs below.');
  lines.push('');
  lines.push(
    `Counts: ${proposals.length} proposed reroutes, ${unmatched.length} unmatched (stay unrouted), ${skipped.length} already routed (out of scope).`,
  );
  lines.push('');
  lines.push('## Proposed reroutes');
  lines.push('');
  lines.push('| action_item_id | thought_id | created | proposed project | description |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const p of proposals) {
    lines.push(
      `| ${p.action_item_id} | ${p.thought_id} | ${String(p.created_at).slice(0, 10)} | ${p.proposed_project} | ${mdCell(p.description)} |`,
    );
  }
  lines.push('');
  lines.push('## Unmatched (no unique route phrase hit — left as-is)');
  lines.push('');
  lines.push('| action_item_id | thought_id | created | description |');
  lines.push('| --- | --- | --- | --- |');
  for (const u of unmatched) {
    lines.push(
      `| ${u.action_item_id} | ${u.thought_id} | ${String(u.created_at).slice(0, 10)} | ${mdCell(u.description)} |`,
    );
  }
  lines.push('');
  lines.push('## Apply shape (after approval, one UPDATE per distinct thought)');
  lines.push('');
  lines.push('```sql');
  const seen = new Set();
  for (const p of proposals) {
    if (seen.has(p.thought_id)) continue;
    seen.add(p.thought_id);
    lines.push(
      `update public.thoughts set metadata = jsonb_set(metadata, '{project}', '"${p.proposed_project}"') where id = '${p.thought_id}';`,
    );
  }
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}
