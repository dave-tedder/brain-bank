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
        ? { bucket: 'RESOLVE', reason: `external project complete: "${project.displayName}" (${status})` }
        : { bucket: 'KEEP', reason: `external project active: "${project.displayName}" (${status || 'unknown'})` };
      continue;
    }

    const normalized = normalizeForDedup(item.description);
    if (normalized && newestByDescription.get(normalized) !== item.id) {
      decided[item.id] = {
        bucket: 'ARCHIVE',
        reason: `duplicate-of ${newestByDescription.get(normalized)}`,
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

export function mergeMiddle(decided, middle, middleDecisions) {
  const output = { ...decided };
  for (const item of middle) {
    const decision = middleDecisions[item.id];
    output[item.id] = decision
      ? { bucket: (decision.bucket || 'REVIEW').toUpperCase(), reason: decision.reason || '' }
      : { bucket: 'PENDING', reason: 'awaiting classification' };
  }
  return output;
}

export function bucketize(items, decided) {
  const buckets = { KEEP: [], RESOLVE: [], ARCHIVE: [], REVIEW: [], PENDING: [] };
  for (const item of items) {
    const decision = decided[item.id] || { bucket: 'PENDING', reason: 'no decision' };
    (buckets[decision.bucket] || buckets.PENDING).push({ ...item, reason: decision.reason });
  }
  return buckets;
}

export function csv(value) {
  const escaped = String(value ?? '').replace(/"/g, '""');
  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

export function renderReport(date, counts, buckets) {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  let markdown = `# Action-item triage report - ${date}\n\nTotal open: ${total}\n\n`;
  markdown += '| Bucket | Count | Effect |\n|---|---:|---|\n';
  markdown += `| KEEP | ${counts.KEEP || 0} | stays open |\n`;
  markdown += `| RESOLVE | ${counts.RESOLVE || 0} | status=resolved |\n`;
  markdown += `| ARCHIVE | ${counts.ARCHIVE || 0} | status=archived |\n`;
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
