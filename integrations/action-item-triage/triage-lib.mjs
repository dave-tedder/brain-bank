// Pure action-item triage logic. No file, network, environment, or process I/O.

export const DEFAULT_PROTECTED_PHRASES = ['do not resolve', 'canary', 'tripwire'];
export const DEFAULT_WORK_ITEM_SHAPE_TERMS = [
  'appointment',
  'client',
  'contract',
  'customer',
  'deadline',
  'deposit',
  'invoice',
  'legal',
];
export const DEFAULT_DONE_STATUSES = ['done', 'complete', 'completed', 'closed', 'archived', 'finished'];

export function projectNameFromDisplay(displayName) {
  const idx = (displayName || '').indexOf(' - ');
  if (idx === -1) return null;
  const name = displayName.slice(0, idx).trim();
  return name.includes(' ') ? name : null;
}

export function normalizeForDedup(description) {
  return (description || '')
    .toLowerCase()
    .replace(/^\s*(todo:|to-do:|note:)\s*/i, '')
    .replace(/^\s*(need to|needs to|should|must|consider|to|please)\s+/i, '')
    .replace(/\b(the|a|an)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeEvidenceText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const RESCHEDULE_DATE_HINT_RE =
  /\b(?:today|tomorrow|tonight|this\s+(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)|next\s+(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i;

const RESCHEDULE_TIME_HINT_RE =
  /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i;

function isRescheduleCommand(text) {
  if (!/^reschedule\b/i.test(text)) return false;
  if (/\bsame\s+times?\b/i.test(text)) return true;
  return RESCHEDULE_DATE_HINT_RE.test(text) && RESCHEDULE_TIME_HINT_RE.test(text);
}

export function isOperationCommandText(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  return isRescheduleCommand(text) || [
    /^new\s+(client|customer|project)\b/i,
    /^add\s+(appointment|event|project|task)\b/i,
  ].some((pattern) => pattern.test(text));
}

export function externalCompletionEvidenceForItem(item, evidence = {}) {
  if (item.source !== 'brain-channel') return null;
  if (!isOperationCommandText(`${item.preview || ''} ${item.description || ''}`)) return null;

  const haystack = normalizeEvidenceText(`${item.description || ''} ${item.preview || ''}`);
  if (!haystack) return null;

  for (const project of evidence.projects || []) {
    const terms = project.matchTermsNorm?.length
      ? project.matchTermsNorm
      : [normalizeEvidenceText(project.displayName)];
    if (terms.some((term) => term && term.length >= 4 && haystack.includes(term))) {
      return `external-command-completed dry-run only: matching project "${project.displayName}"`;
    }
  }

  for (const event of evidence.events || []) {
    if (event.titleNorm && event.titleNorm.length >= 4 && haystack.includes(event.titleNorm)) {
      return `external-command-completed dry-run only: matching event "${event.title}"`;
    }
    if ((event.attendeesNorm || []).some((attendee) => attendee && attendee.length >= 4 && haystack.includes(attendee))) {
      return `external-command-completed dry-run only: matching event attendee for "${event.title}"`;
    }
  }

  return null;
}

export function addDryRunExternalCompletionSignals(decided, items, evidence = {}) {
  const output = { ...decided };
  const matches = [];
  for (const item of items) {
    const reason = externalCompletionEvidenceForItem(item, evidence);
    if (!reason) continue;
    output[item.id] = { bucket: 'REVIEW', reason };
    matches.push({ id: item.id, reason });
  }
  return { decided: output, matches };
}

function containsTerm(value, terms) {
  const lower = (value || '').toLowerCase();
  return terms.some((term) => term && lower.includes(String(term).toLowerCase()));
}

function projectMatches(description, project) {
  const terms = project.matchTerms?.length
    ? project.matchTerms
    : [projectNameFromDisplay(project.displayName), project.displayName].filter(Boolean);
  return containsTerm(description, terms);
}

// The pointer a cascade close names: where the project's done status was read, and
// which project. A person checks it by opening that project in that source. Only the
// cascade writes this form; a decisions file must name one of DONE_EVIDENCE_RE's.
export function projectStatusEvidence(project) {
  return `project-status:${project.statusSource || 'unknown'}:${project.displayName || 'unnamed'}`;
}

// The deterministic cascade. Returns { decided, middle }.
//   decided: { [id]: { bucket, reason, closeReason?, evidence?, duplicateOf? } }
//   middle:  items that fall through to classification
// projects: [{ displayName, matchTerms?, status, statusSource? }]
export function runCascade({
  items,
  projects = [],
  doneStatuses = DEFAULT_DONE_STATUSES,
  protectedPhrases = DEFAULT_PROTECTED_PHRASES,
  workItemShapeTerms = DEFAULT_WORK_ITEM_SHAPE_TERMS,
}) {
  const done = doneStatuses.map((status) => status.toLowerCase());
  const newestByDescription = new Map();
  for (const item of items) {
    const normalized = normalizeForDedup(item.description);
    if (normalized) newestByDescription.set(normalized, item.id);
  }

  const decided = {};
  const middle = [];
  for (const item of items) {
    if (containsTerm(item.description, protectedPhrases)) {
      decided[item.id] = { bucket: 'KEEP', reason: 'protected phrase' };
      continue;
    }

    const project = projects.find((candidate) => projectMatches(item.description, candidate));
    if (project) {
      const status = (project.status || '').toLowerCase();
      decided[item.id] = done.includes(status)
        ? {
          bucket: 'RESOLVE',
          reason: `external project complete: "${project.displayName}" (${status})`,
          closeReason: 'done',
          evidence: projectStatusEvidence(project),
        }
        : { bucket: 'KEEP', reason: `external project active: "${project.displayName}" (${status || 'unknown'})` };
      continue;
    }

    const normalized = normalizeForDedup(item.description);
    if (normalized && newestByDescription.get(normalized) !== item.id) {
      decided[item.id] = {
        bucket: 'ARCHIVE',
        reason: `duplicate-of ${newestByDescription.get(normalized)}`,
        closeReason: 'duplicate',
        duplicateOf: newestByDescription.get(normalized),
      };
      continue;
    }

    if (containsTerm(item.description, workItemShapeTerms)) {
      decided[item.id] = { bucket: 'REVIEW', reason: 'work-shaped item without a confident project match' };
      continue;
    }

    middle.push(item);
  }
  return { decided, middle };
}

// The classifier's instructions. It cannot verify that anything shipped, so finished
// work is not one of its archive cases: it can only say "never a real task" or send
// the item to a person.
export const CLASSIFIER_SYSTEM = [
  'You triage one captured action item at a time for a Brain Bank operator.',
  'KEEP only a concrete, unfinished commitment.',
  'ARCHIVE only what was never a real task: advice, conditional ideas, or narration. Every ARCHIVE sets "close_reason":"fragment".',
  'REVIEW anything uncertain, anything that may already be finished (you cannot verify that from here), or anything involving a client, customer, contract, money, legal obligation, or deadline. Never ARCHIVE finished work, client work, or a financial or legal obligation.',
  'Judge the item alone and quote the phrase that drove the decision.',
  'Return strict JSON: {"bucket":"keep|archive|review","close_reason":"fragment|null","reason":"<short quote>"}.',
].join('\n');

// Pure. A model's answer as a decision. The bucket is limited to what the classifier
// may decide: it can never produce RESOLVE, because it has no evidence to offer.
export function llmDecision(parsed) {
  const bucket = ['keep', 'archive', 'review'].includes(parsed?.bucket) ? parsed.bucket.toUpperCase() : 'REVIEW';
  return { bucket, close_reason: parsed?.close_reason ?? null, reason: String(parsed?.reason || '').slice(0, 200) };
}

// A pointer someone can check. This proves the decision named one, not that the claim
// is true: the tool cannot reach most of these. The writer of the file attests to it,
// and the pointer is kept on the event and in the CSV so it can be audited.
export const DONE_EVIDENCE_RE = /^(?:commit:[0-9a-f]{7,40}|pr:[\w.-]+\/[\w.-]+#\d+|card:[0-9a-f]{8}(?:-[0-9a-f-]{27})?|thought:[0-9a-f]{8}-[0-9a-f-]{27}|url:https?:\/\/\S+)$/i;

export const DECISION_HELD_PREFIX = 'decision held for review: ';

// Pure. One middle decision, as a decisions file or the classifier wrote it, to what
// --apply may act on. The close reason is an explicit field, never read out of the
// free-text reason. Anything that cannot justify a close stays open in REVIEW, with
// the reason saying why and keeping what the decision said.
//   ARCHIVE needs close_reason "fragment" (never a real task) and a reason.
//   RESOLVE needs close_reason "done", a checkable evidence pointer, and a reason.
//   KEEP and REVIEW need nothing, and close nothing.
// A file written before this contract has ARCHIVE decisions with no close_reason:
// they are held, not guessed, so re-running an old file closes nothing it used to.
export function normalizeMiddleDecision(decision) {
  const said = typeof decision?.reason === 'string' ? decision.reason.trim() : '';
  const hold = (why) => ({
    bucket: 'REVIEW',
    reason: `${DECISION_HELD_PREFIX}${why}${said ? `. It said: ${said}` : ''}`,
    held: true,
  });
  if (decision === null || typeof decision !== 'object' || Array.isArray(decision)) return hold('not an object');
  const bucket = String(decision.bucket ?? 'REVIEW').toUpperCase();
  if (bucket === 'KEEP' || bucket === 'REVIEW') return { bucket, reason: said };
  if (bucket === 'ARCHIVE') {
    if (decision.close_reason === undefined || decision.close_reason === null) {
      return hold('ARCHIVE names no close_reason');
    }
    if (decision.close_reason !== 'fragment') {
      return hold(`ARCHIVE closes only as fragment, not ${JSON.stringify(decision.close_reason)}; finished work is RESOLVE with evidence`);
    }
    if (!said) return hold('a fragment needs its reason');
    return { bucket, reason: said, closeReason: 'fragment' };
  }
  if (bucket === 'RESOLVE') {
    if (decision.close_reason !== 'done') return hold(`RESOLVE closes only as done, not ${JSON.stringify(decision.close_reason ?? null)}`);
    if (typeof decision.evidence !== 'string' || !DONE_EVIDENCE_RE.test(decision.evidence)) {
      return hold(`RESOLVE needs a checkable evidence pointer (commit:, pr:, card:, thought:, url:), not ${JSON.stringify(decision.evidence ?? null)}`);
    }
    if (!said) return hold('finished work needs its reason');
    return { bucket, reason: said, closeReason: 'done', evidence: decision.evidence };
  }
  return hold(`unknown bucket ${JSON.stringify(decision.bucket)}`);
}

// Merge classifier or agent middle decisions into the deterministic map. Unclassified
// middle items become PENDING (which blocks --apply); decided ones pass the contract above.
export function mergeMiddle(decided, middle, middleDecisions) {
  const output = { ...decided };
  for (const item of middle) {
    output[item.id] = Object.hasOwn(middleDecisions, item.id)
      ? normalizeMiddleDecision(middleDecisions[item.id])
      : { bucket: 'PENDING', reason: 'awaiting classification' };
  }
  return output;
}

export function bucketize(items, decided) {
  const buckets = { KEEP: [], RESOLVE: [], ARCHIVE: [], REVIEW: [], PENDING: [] };
  for (const item of items) {
    const decision = decided[item.id] || { bucket: 'PENDING', reason: 'no decision' };
    (buckets[decision.bucket] || buckets.PENDING).push({
      ...item,
      reason: decision.reason,
      closeReason: decision.closeReason,
      evidence: decision.evidence,
      duplicateOf: decision.duplicateOf,
    });
  }
  return buckets;
}

// --apply writes through transition_action_item, the same guarded RPC every Edge
// Function uses, so a triage close has an actor, a reason and a current-status
// predicate like any other close. One item per call, so it holds one row lock.
export const TRIAGE_ACTOR = 'action-item-triage';

// Pure. A decided item and its target status to RPC arguments, named as the function
// names them. The close reason comes from the decision's explicit field: done for
// finished work, fragment for what was never a real task, duplicate with the survivor
// the cascade's dedup named. An item with none of those throws rather than being given
// one, so a gap can never become a durable, wrong reason. A row that left 'open' since
// it was classified is refused by p_from_statuses, so a stale report cannot overwrite a
// later decision. That is a status guard, not a generation check: a row closed and
// reopened since classification reads as open and is closed.
export function triageTransitionArgs(item, newStatus) {
  const args = {
    p_item_id: item.id,
    p_from_statuses: ['open'],
    p_to_status: newStatus,
    p_actor: TRIAGE_ACTOR,
    p_resolution_note: `triage: ${item.reason || 'no reason recorded'}`,
    p_event_payload: {
      tool: TRIAGE_ACTOR,
      actor_source: 'service-role-cli',
      reason: item.reason || null,
      evidence: item.evidence || null,
    },
  };
  if (newStatus === 'resolved' && item.closeReason === 'done') {
    return { ...args, p_close_reason: 'done' };
  }
  if (newStatus === 'archived' && item.closeReason === 'fragment') {
    return { ...args, p_close_reason: 'fragment' };
  }
  if (newStatus === 'archived' && item.closeReason === 'duplicate' && item.duplicateOf) {
    return { ...args, p_close_reason: 'duplicate', p_duplicate_of: item.duplicateOf };
  }
  throw new Error(`triage has no valid close reason for ${item.id}: ${newStatus}/${item.closeReason ?? 'none'}`);
}

// Records each answer it receives in `records` as it happens, so a failure partway
// still leaves an accurate account of what it knows landed. callRpc returns the RPC's
// row count: 1 applied, 0 the row had already left 'open'. Anything else, or a thrown
// error, stops the run. A call that throws has no record: a request can commit and
// lose its response, or the process can die, leaving an event with no row. The
// action_item_events row is the durable evidence; the record is this run's account.
export async function applyDispositions(list, newStatus, callRpc, records = [], onProgress = () => {}) {
  for (const [index, item] of list.entries()) {
    const args = triageTransitionArgs(item, newStatus);
    const affected = await callRpc(args);
    if (affected !== 0 && affected !== 1) {
      throw new Error(`transition_action_item returned ${JSON.stringify(affected)} for ${item.id}`);
    }
    records.push({
      item,
      newStatus,
      closeReason: args.p_close_reason,
      outcome: affected === 1 ? 'applied' : 'skipped_status_changed',
    });
    onProgress(index + 1, list.length);
  }
  return records;
}

export const DISPOSITION_HEADER = 'id,old_status,new_status,close_reason,outcome,reason,description,evidence';

export function dispositionLines(records) {
  return records.map((r) => [
    r.item.id, 'open', r.newStatus, r.closeReason, r.outcome, csv(r.item.reason), csv(r.item.description), csv(r.item.evidence),
  ].join(','));
}

export function csv(value) {
  const escaped = String(value ?? '').replace(/"/g, '""');
  return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

// The seven-column header of the format's first close-reason revision, which had no
// evidence column. It is migrated, not refused. This tool's original header
// (id,old_status,new_status,bucket,reason,description) has no close reason to carry
// forward and is refused like any other header this code does not recognize.
export const LEGACY_DISPOSITION_HEADER = 'id,old_status,new_status,close_reason,outcome,reason,description';

// CSV text as records: each keeps its raw text, so a migration changes only what it
// must, and its parsed cells. A quoted field may hold commas, doubled quotes and line
// breaks. Anything a standard CSV parser would read differently or reject is a problem,
// not a guess: a quote inside an unquoted field, text after a closing quote, a bare
// carriage return outside quotes, a NUL byte, or a quote that never closes, which is what
// a torn write leaves behind. A field that merely opens with a space and then a quote is
// also refused, which is stricter than Python's reader and never written by this tool.
export function parseCsv(text) {
  const records = [];
  let raw = '';
  let cell = '';
  let cells = [];
  let state = 'start';
  const bad = (what) => ({ problem: `${what}, in record ${records.length + 1}: ${raw.slice(0, 120)}` });
  const endCell = () => {
    cells.push(cell);
    cell = '';
  };
  const endRecord = () => {
    endCell();
    records.push({ raw, cells });
    raw = '';
    cells = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\0') return bad('a NUL byte');
    if (state === 'quoted') {
      raw += c;
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') {
        raw += '"';
        cell += '"';
        i += 1;
      } else state = 'afterQuote';
    } else if (c === ',') {
      raw += c;
      endCell();
      state = 'start';
    } else if (c === '\n') {
      endRecord();
      state = 'start';
    } else if (c === '\r') {
      if (text[i + 1] !== '\n') return bad('a bare carriage return outside quotes');
      i += 1;
      endRecord();
      state = 'start';
    } else if (state === 'afterQuote') {
      return bad('text after a closing quote');
    } else if (c === '"') {
      if (state === 'unquoted') return bad('a quote inside an unquoted field');
      raw += c;
      state = 'quoted';
    } else {
      raw += c;
      cell += c;
      state = 'unquoted';
    }
  }
  if (state === 'quoted') return { problem: 'a quoted field that never closes' };
  if (raw !== '') endRecord();
  return { records };
}

// The records, or null when the text is not valid CSV.
export function csvRecords(text) {
  return parseCsv(text).records ?? null;
}

// What to do with an existing disposition file before --apply writes anything. Pure.
//   create: nothing is there yet, or nothing but whitespace.
//   append: the current header, with every record the right width.
//   migrate: the seven-column header, whose records have seven fields, or the eight a
//     newer run appended under that header. Every record keeps its bytes, and a
//     seven-field one gains an empty evidence field.
//   refuse: anything else, seven fields under the current header included. Nothing says
//     which of its fields is missing, and guessing which column a field belongs in would
//     corrupt the record of what was closed, so a person moves the file aside.
export function planDispositionFile(text) {
  const body = text.replace(/^\uFEFF/, '');
  if (body.trim() === '') return { action: 'create' };
  const parsed = parseCsv(body);
  if (parsed.problem) return { action: 'refuse', problem: parsed.problem };
  const [header, ...rows] = parsed.records.filter((record) => record.raw !== '');
  if (header.raw !== DISPOSITION_HEADER && header.raw !== LEGACY_DISPOSITION_HEADER) {
    return { action: 'refuse', problem: `an unrecognized header: ${header.raw.slice(0, 120)}` };
  }
  const width = DISPOSITION_HEADER.split(',').length;
  const legacyWidth = LEGACY_DISPOSITION_HEADER.split(',').length;
  const isCurrent = header.raw === DISPOSITION_HEADER;
  const allowed = isCurrent ? [width] : [legacyWidth, width];
  const odd = rows.find((row) => !allowed.includes(row.cells.length));
  if (odd) {
    return { action: 'refuse', problem: `a record with ${odd.cells.length} fields under the ${isCurrent ? 'current' : 'seven-column'} header: ${odd.raw.slice(0, 120)}` };
  }
  // A last record with no line ending is kept, since spreadsheets save files that way,
  // but named: a write cut short at a field boundary leaves exactly this, and no width
  // check can tell the two apart.
  const unterminated = !body.endsWith('\n') && rows.length > 0 ? { unterminatedLast: rows.at(-1).raw } : {};
  if (isCurrent) {
    return { action: 'append', needsNewline: !body.endsWith('\n'), records: rows.length, ...unterminated };
  }
  const lines = rows.map((row) => (row.cells.length === legacyWidth ? `${row.raw},` : row.raw));
  return {
    action: 'migrate',
    records: rows.length,
    content: `${[DISPOSITION_HEADER, ...lines].join('\n')}\n`,
    ...unterminated,
  };
}

// The same plan from the file's bytes. Bytes that are not UTF-8 refuse: decoding them
// loosely would rewrite them on a migration, and a torn write can split a character.
export function planDispositionBytes(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { action: 'refuse', problem: 'bytes that are not valid UTF-8' };
  }
  return planDispositionFile(text);
}

export function renderReport(date, counts, buckets) {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  let markdown = `# Action-item triage report - ${date}\n\nTotal open: ${total}\n\n`;
  markdown += '| Bucket | Count | Effect |\n|---|---:|---|\n';
  markdown += `| KEEP | ${counts.KEEP || 0} | stays open |\n`;
  markdown += `| RESOLVE | ${counts.RESOLVE || 0} | status=resolved, close_reason=done (real, finished, evidence named) |\n`;
  markdown += `| ARCHIVE | ${counts.ARCHIVE || 0} | status=archived, close_reason=fragment or duplicate |\n`;
  markdown += `| REVIEW | ${counts.REVIEW || 0} | stays open for review |\n`;
  if (counts.PENDING) markdown += `| PENDING | ${counts.PENDING} | awaiting classification |\n`;
  markdown += '\n';

  for (const bucket of ['REVIEW', 'RESOLVE', 'ARCHIVE', 'KEEP', 'PENDING']) {
    const items = buckets[bucket] || [];
    if (!items.length) continue;
    const shown = bucket === 'REVIEW' ? items : items.slice(0, 20);
    markdown += `## ${bucket} (${items.length})\n\n`;
    markdown += shown
      .map((item) => `- [${item.source || 'unknown'}/${item.type || 'unknown'} ${item.age_days ?? '?'}d] ${item.description}  _(${item.reason})_`)
      .join('\n');
    markdown += '\n\n';
  }
  return markdown;
}
