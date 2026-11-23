#!/usr/bin/env node
// PR 20 amendment: mutation proof for action-item-triage's --apply path. Each mutant
// replaces one exact string in a TEMP COPY of the tool, then runs its test suite
// there. The working tree is never edited, and the tests talk only to a local stub.
//
//   node scripts/loop-closing/triage-apply-mutations.mjs
//
// CAUGHT: a test failed, the suite ran as many tests as the control did (so an import
// failure cannot count), and a named test, when the mutant has one, is among the
// failures. WRONG-FAILURE: it failed elsewhere (exit 1). SURVIVED: all passed (exit 1).
// NEVER-RAN: the target is not there exactly once, or the suite did not run its tests
// (exit 2). A failed control: the unmutated copy must pass first (exit 2).
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIB = "triage-lib.mjs";
const CLI = "triage.mjs";
const CLAIM = "disposition-claim.mjs";

const MUTANTS = [
  ["direct-patch-restored", CLI, "(args) => supabase('rpc/transition_action_item', { method: 'POST', body: JSON.stringify(args) }),", "(args) => supabase(`action_items?id=in.(\"${args.p_item_id}\")`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: args.p_to_status }) }).then(() => 1),"],
  ["no-status-guard", LIB, "p_from_statuses: ['open'],", "p_from_statuses: ['open', 'deferred'],"],
  ["blank-actor", LIB, "p_actor: TRIAGE_ACTOR,", "p_actor: '',"],
  ["no-note", LIB, "p_resolution_note: `triage: ${item.reason || 'no reason recorded'}`,", "p_resolution_note: null,"],
  ["no-reason-on-resolve", LIB, "return { ...args, p_close_reason: 'done' };", "return { ...args };"],
  ["no-reason-on-archive", LIB, "return { ...args, p_close_reason: 'fragment' };", "return { ...args };"],
  ["no-survivor", LIB, "return { ...args, p_close_reason: 'duplicate', p_duplicate_of: item.duplicateOf };", "return { ...args, p_close_reason: 'duplicate' };"],
  // PR 20 second amendment: the disposition contract, each arm on its own.
  ["gap-becomes-fragment", LIB, "  throw new Error(`triage has no valid close reason for ${item.id}: ${newStatus}/${item.closeReason ?? 'none'}`);", "  return { ...args, p_close_reason: newStatus === 'resolved' ? 'done' : 'fragment' };", /throws rather than give an item a reason/],
  ["done-allowed-under-archive", LIB, "if (newStatus === 'archived' && item.closeReason === 'fragment') {", "if (newStatus === 'archived' && (item.closeReason === 'fragment' || item.closeReason === 'done')) {", /throws rather than give an item a reason/],
  ["duplicate-allowed-without-survivor", LIB, "if (newStatus === 'archived' && item.closeReason === 'duplicate' && item.duplicateOf) {", "if (newStatus === 'archived' && item.closeReason === 'duplicate') {", /throws rather than give an item a reason/],
  ["survivor-from-free-text", LIB, "  if (newStatus === 'resolved' && item.closeReason === 'done') {", "  const m = /^duplicate-of (\\S+)$/.exec(item.reason || '');\n  if (m) return { ...args, p_close_reason: 'duplicate', p_duplicate_of: m[1] };\n  if (newStatus === 'resolved' && item.closeReason === 'done') {", /reads only the explicit close reason/],
  ["legacy-archive-becomes-fragment", LIB, "      return hold('ARCHIVE names no close_reason');", "      return { bucket, reason: said, closeReason: 'fragment' };", /stays in REVIEW, and says why/],
  ["archive-any-close-reason", LIB, "    if (decision.close_reason !== 'fragment') {", "    if (false) {", /stays in REVIEW, and says why/],
  ["fragment-without-reason", LIB, "    if (!said) return hold('a fragment needs its reason');\n", "", /stays in REVIEW, and says why/],
  ["resolve-any-close-reason", LIB, "    if (decision.close_reason !== 'done') return hold(", "    if (false) return hold(", /stays in REVIEW, and says why/],
  ["done-without-evidence", LIB, "    if (typeof decision.evidence !== 'string' || !DONE_EVIDENCE_RE.test(decision.evidence)) {", "    if (false) {", /stays in REVIEW, and says why/],
  ["done-any-string-evidence", LIB, "    if (typeof decision.evidence !== 'string' || !DONE_EVIDENCE_RE.test(decision.evidence)) {", "    if (typeof decision.evidence !== 'string' || !decision.evidence) {", /stays in REVIEW, and says why/],
  ["evidence-pattern-unanchored", LIB, "export const DONE_EVIDENCE_RE = /^(?:", "export const DONE_EVIDENCE_RE = /(?:", /stays in REVIEW, and says why/],
  ["done-without-reason", LIB, "    if (!said) return hold('finished work needs its reason');\n", "", /stays in REVIEW, and says why/],
  ["unknown-bucket-kept", LIB, "  return hold(`unknown bucket ${JSON.stringify(decision.bucket)}`);", "  return { bucket, reason: said };", /stays in REVIEW, and says why/],
  ["non-object-accepted", LIB, "  if (decision === null || typeof decision !== 'object' || Array.isArray(decision)) return hold('not an object');\n", "", /stays in REVIEW, and says why/],
  ["held-decision-not-flagged", LIB, "    held: true,\n", "", /stays in REVIEW, and says why/],
  ["null-decision-reads-as-pending", LIB, "    output[item.id] = Object.hasOwn(middleDecisions, item.id)\n", "    output[item.id] = middleDecisions[item.id]\n", /an absent decision blocks as PENDING/],
  ["merge-skips-contract", LIB, "      ? normalizeMiddleDecision(middleDecisions[item.id])\n", "      ? { ...middleDecisions[item.id], bucket: String(middleDecisions[item.id]?.bucket || 'REVIEW').toUpperCase() }\n", /an absent decision blocks as PENDING/],
  ["bucketize-drops-close-reason", LIB, "      closeReason: decision.closeReason,\n", "", /the cascade carries its close reason/],
  ["cascade-duplicate-without-reason", LIB, "        closeReason: 'duplicate',\n", "", /the cascade carries its close reason/],
  ["cascade-duplicate-without-survivor", LIB, "        duplicateOf: newestByDescription.get(normalized),\n", "", /the cascade carries its close reason/],
  // Brain Bank's cascade matches generic projects; a done project resolves with evidence.
  ["cascade-project-without-reason", LIB, "          closeReason: 'done',\n          evidence: projectStatusEvidence(project),\n", "          evidence: projectStatusEvidence(project),\n", /the cascade carries its close reason/],
  ["cascade-project-without-evidence", LIB, "          evidence: projectStatusEvidence(project),\n", "", /the cascade carries its close reason/],
  ["cascade-evidence-unnamed-project", LIB, "  return `project-status:${project.statusSource || 'unknown'}:${project.displayName || 'unnamed'}`;", "  return `project-status:${project.statusSource || 'unknown'}`;", /the cascade carries its close reason/],
  ["cascade-active-project-resolves", LIB, "      decided[item.id] = done.includes(status)\n", "      decided[item.id] = true\n", /the cascade carries its close reason/],
  ["cli-project-source-not-recorded", CLI, "    statusSource: liveStatus ? 'notion' : 'projects-table',\n", "", /--apply writes only through the guarded RPC/],
  ["llm-can-resolve", LIB, "const bucket = ['keep', 'archive', 'review'].includes(parsed?.bucket)", "const bucket = ['keep', 'archive', 'review', 'resolve'].includes(parsed?.bucket)", /classifier cannot produce done/],
  ["llm-prompt-archives-shipped", LIB, "advice, conditional ideas, or narration. Every ARCHIVE", "advice, conditional ideas, narration, or plainly completed implementation notes. Every ARCHIVE", /classifier cannot produce done/],
  ["llm-prompt-forgets-finished", LIB, "anything that may already be finished (you cannot verify that from here), ", "", /classifier cannot produce done/],
  ["llm-prompt-no-fragment-field", LIB, "Every ARCHIVE sets \"close_reason\":\"fragment\".", "", /classifier cannot produce done/],
  ["cli-does-not-report-held", CLI, "  if (held) {\n", "  if (false) {\n", /--apply writes only through the guarded RPC/],
  ["payload-drops-evidence", LIB, "      evidence: item.evidence || null,\n", "", /resolve closes as done/],
  ["csv-drops-evidence", LIB, ", csv(r.item.evidence),\n", ",\n", /dispositionLines carries/],
  ["no-event-payload", LIB, "    p_event_payload: {\n      tool: TRIAGE_ACTOR,\n      actor_source: 'service-role-cli',\n      reason: item.reason || null,\n      evidence: item.evidence || null,\n    },", "    p_event_payload: null,"],
  ["skip-counted-as-applied", LIB, "outcome: affected === 1 ? 'applied' : 'skipped_status_changed',", "outcome: 'applied',"],
  ["unexpected-count-accepted", LIB, "if (affected !== 0 && affected !== 1) {", "if (false) {"],
  ["csv-lost-on-failure", CLI, "  } finally {\n    if (records.length) appendFileSync", "  } catch (e) {\n    throw e;\n  }\n  {\n    if (records.length) appendFileSync"],
  ["csv-drops-outcome", LIB, "r.item.id, 'open', r.newStatus, r.closeReason, r.outcome, csv(r.item.reason), csv(r.item.description), csv(r.item.evidence),", "r.item.id, 'open', r.newStatus, r.closeReason, csv(r.item.reason), csv(r.item.description), csv(r.item.evidence),"],
  // Third amendment: an existing disposition file.
  ["csv-not-prepared", CLI, "  prepareDispositionFile(dispPath);\n", "", /migrates a seven-column file/],
  ["csv-prepared-after-writes", CLI, "  prepareDispositionFile(dispPath);\n  const records = [];\n  try {\n    await applyFlips('archived', buckets.ARCHIVE, records);\n    await applyFlips('resolved', buckets.RESOLVE, records);\n", "  const records = [];\n  try {\n    await applyFlips('archived', buckets.ARCHIVE, records);\n    await applyFlips('resolved', buckets.RESOLVE, records);\n    prepareDispositionFile(dispPath);\n", /refuses an older tool's header before any database write/],
  ["csv-refusal-does-not-stop", CLI, "Move that file aside, keeping it as its run's record, and re-run: this run then starts a new one.`);\n    process.exit(1);", "Move that file aside, keeping it as its run's record, and re-run: this run then starts a new one.`);\n    return;", /refuses an older tool's header before any database write/],
  ["csv-no-backup", CLI, "      copyFileSync(path, backup, constants.COPYFILE_EXCL);\n", "", /migrates a seven-column file/],
  ["csv-temp-left-behind", CLI, "    } finally {\n      rmSync(temp, { force: true });\n    }\n", "    } finally {\n    }\n", /the migration itself cannot finish/],
  ["csv-final-newline-not-added", CLI, "    if (plan.needsNewline) appendFileSync(path, '\\n');\n", "", /adds a missing final newline/],
  ["csv-empty-file-not-started", CLI, "  if (plan.action === 'create') {\n    writeFileSync(path, `${DISPOSITION_HEADER}\\n`);\n  } else if", "  if (plan.action === 'create') {\n  } else if", /starts a file that exists but is empty/],
  ["csv-evidence-field-not-added", LIB, "(row.cells.length === legacyWidth ? `${row.raw},` : row.raw)", "row.raw", /migrates the seven-column file/],
  ["csv-eight-field-row-padded", LIB, "(row.cells.length === legacyWidth ? `${row.raw},` : row.raw)", "`${row.raw},`", /keeps the eight-field records/],
  ["csv-header-not-rewritten", LIB, "content: `${[DISPOSITION_HEADER, ...lines].join('\\n')}\\n`,", "content: `${[LEGACY_DISPOSITION_HEADER, ...lines].join('\\n')}\\n`,", /migrates the seven-column file/],
  ["csv-any-header-accepted", LIB, "  if (header.raw !== DISPOSITION_HEADER && header.raw !== LEGACY_DISPOSITION_HEADER) {", "  if (false) {", /refuses what it cannot place/],
  ["csv-any-width-accepted", LIB, "  if (odd) {", "  if (false) {", /refuses what it cannot place/],
  ["csv-open-quote-accepted", LIB, "  if (state === 'quoted') return { problem: 'a quoted field that never closes' };\n", "", /refuses an open quote/],
  ["csv-not-quote-aware", LIB, "      raw += c;\n      state = 'quoted';\n", "      raw += c;\n      cell += c;\n      state = 'unquoted';\n", /reads quoted commas/],
  ["csv-doubled-quote-ends-field", LIB, "      else if (text[i + 1] === '\"') {", "      else if (false) {", /reads quoted commas/],
  ["csv-crlf-not-a-break", LIB, "    } else if (c === '\\r') {\n", "    } else if (false) {\n", /reads quoted commas/],
  ["csv-bom-breaks-header", LIB, "  const body = text.replace(/^\\uFEFF/, '');", "  const body = text;", /the current header appends/],
  ["csv-short-row-under-current-header-repaired", LIB, "  const allowed = isCurrent ? [width] : [legacyWidth, width];\n", "  const allowed = [legacyWidth, width];\n", /a short row under it refuses/],
  ["csv-blank-lines-count", LIB, "  const [header, ...rows] = parsed.records.filter((record) => record.raw !== '');", "  const [header, ...rows] = parsed.records;", /the current header appends/],
  ["csv-whitespace-file-refused", LIB, "  if (body.trim() === '') return { action: 'create' };\n", "", /the current header appends/],
  ["csv-header-refusal-silent", LIB, "problem: `an unrecognized header: ${header.raw.slice(0, 120)}`", "problem: 'a problem'", /refuses what it cannot place/],
  ["csv-header-only-on-new-file", CLI, "  const plan = existsSync(path) ? planDispositionBytes(readFileSync(path)) : { action: 'create' };", "  const plan = existsSync(path) ? { action: 'append' } : { action: 'create' };", /migrates a seven-column file/],
  // Fourth amendment: field boundaries.
  ["csv-quote-in-unquoted-accepted", LIB, "      if (state === 'unquoted') return bad('a quote inside an unquoted field');\n", "", /refuses what a standard parser/],
  ["csv-text-after-quote-accepted", LIB, "    } else if (state === 'afterQuote') {\n      return bad('text after a closing quote');\n", "", /refuses what a standard parser/],
  ["csv-bare-cr-accepted", LIB, "      if (text[i + 1] !== '\\n') return bad('a bare carriage return outside quotes');\n      i += 1;\n", "      if (text[i + 1] === '\\n') i += 1;\n", /refuses what a standard parser/],
  ["csv-nul-accepted", LIB, "    if (c === '\\0') return bad('a NUL byte');\n", "", /refuses what a standard parser/],
  ["csv-field-start-not-reset", LIB, "      raw += c;\n      endCell();\n      state = 'start';\n", "      raw += c;\n      endCell();\n", /reads quoted commas/],
  ["csv-record-start-not-reset", LIB, "    } else if (c === '\\n') {\n      endRecord();\n      state = 'start';\n", "    } else if (c === '\\n') {\n      endRecord();\n", /migrates the seven-column file/],
  ["csv-unquoted-state-not-set", LIB, "      cell += c;\n      state = 'unquoted';\n", "      cell += c;\n", /refuses what a standard parser/],
  ["csv-seven-column-nine-accepted", LIB, "  const odd = rows.find((row) => !allowed.includes(row.cells.length));\n", "  const odd = rows.find((row) => row.cells.length < 7);\n", /refuses what it cannot place/],
  ["csv-problem-not-refused", LIB, "  if (parsed.problem) return { action: 'refuse', problem: parsed.problem };\n", "  if (parsed.problem) return { action: 'create' };\n", /refuses the review|refuses what it cannot place/],
  ["csv-writer-leaves-bare-cr", LIB, 'return /[",\\r\\n]/.test(escaped)', 'return /[",\\n]/.test(escaped)', /csv quotes a carriage return/],
  ["csv-utf8-not-fatal", LIB, "new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })", "new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })", /refuses bytes that are not UTF-8/],
  ["csv-bytes-plan-unused", CLI, "planDispositionBytes(readFileSync(path))", "planDispositionFile(readFileSync(path, 'utf8'))", /--apply refuses bytes that are not UTF-8/],
  // Fourth amendment: who owns the file.
  ["claim-not-taken", CLI, "  const claim = claimOrRefuse(dispPath);\n", "  const claim = { held: () => true };\n", /overlap: a run paused/],
  ["claim-taken-after-prepare", CLI, "  const claim = claimOrRefuse(dispPath);\n  prepareDispositionFile(dispPath);\n", "  prepareDispositionFile(dispPath);\n  const claim = claimOrRefuse(dispPath);\n", /overlap: a run paused|a claim file left by a live owner/],
  ["claim-busy-not-stopped", CLI, "confirm that process is gone, then delete the claim file named here.\\n${JSON.stringify(claim.holders, null, 2)}`);\n    process.exit(1);\n", "confirm that process is gone, then delete the claim file named here.\\n${JSON.stringify(claim.holders, null, 2)}`);\n    return { recovered: [], held: () => true, release: () => {} };\n", /overlap: a run paused/],
  ["claim-refusal-ignored", CLAIM, "  if (holders.length > 0) {\n", "  if (false) {\n", /overlap: a run paused/],
  ["refusal-keeps-own-claim", CLAIM, "    rmSync(own, { force: true });\n    return { busy: true, holders };\n", "    return { busy: true, holders };\n", /overlap: a run paused/],
  ["claim-not-released", CLI, "  process.on('exit', claim.release);\n", "", /migrates a seven-column file/],
  ["other-files-claim-blocks", CLAIM, "    if (!pattern.test(name) || other === own) continue;\n", "    if (!name.includes('.claim.') || other === own) continue;\n", /a claim on another file/],
  ["own-claim-not-excluded", CLAIM, "    if (!pattern.test(name) || other === own) continue;\n", "    if (!pattern.test(name)) continue;\n", /migrates a seven-column file/],
  ["dead-owner-not-recovered", CLAIM, "    if (claim && holderIsGone(claim)) {\n", "    if (false) {\n", /left by a dead owner/],
  ["recovery-not-reported", CLI, "  if (claim.recovered.length > 0) {\n", "  if (false) {\n", /left by a dead owner/],
  ["recovered-claim-left", CLAIM, "      rmSync(other, { force: true });\n      recovered.push(name);\n", "      recovered.push(name);\n", /left by a dead owner/],
  ["any-host-can-be-proved-gone", CLAIM, "  if (claim.host !== hostname() || !Number.isInteger(claim.pid) || claim.pid <= 0) return false;\n", "  if (!Number.isInteger(claim.pid) || claim.pid <= 0) return false;\n", /left by a dead pid on another host/],
  ["no-pid-reads-as-gone", CLAIM, "  if (claim.host !== hostname() || !Number.isInteger(claim.pid) || claim.pid <= 0) return false;\n", "  if (claim.host !== hostname()) return false;\n  if (!Number.isInteger(claim.pid) || claim.pid <= 0) return true;\n", /left by a claim with no pid/],
  ["recycled-pid-reads-as-alive", CLAIM, "  return Boolean(claim.started_at && started && started !== claim.started_at);\n", "  return false;\n", /left by a recycled pid/],
  ["live-owner-reads-as-gone", CLAIM, "  return Boolean(claim.started_at && started && started !== claim.started_at);\n", "  return true;\n", /left by a live owner/],
  ["unknown-start-reads-as-gone", CLAIM, "  return Boolean(claim.started_at && started && started !== claim.started_at);\n", "  return Boolean(started !== claim.started_at);\n", /left by a live pid with no start time/],
  ["unreadable-claim-ignored", CLAIM, "      holders.push({ file: other, ...(claim && typeof claim === 'object' ? claim : { unreadable: true }) });\n", "      if (claim) holders.push({ file: other, ...claim });\n", /left by an unreadable claim/],
  ["claim-loss-not-reported", CLI, "    if (!claim.held()) {\n", "    if (false) {\n", /a claim removed mid-run/],
  ["claim-loss-exits-zero", CLI, "      process.exitCode = 1;\n", "", /a claim removed mid-run/],
  ["temp-path-shared", CLI, "const temp = `${path}.${unique}.migrating`;", "const temp = `${path}.migrating`;", /a stale temp from an earlier crash/],
  ["backup-path-not-unique", CLI, "`${path}.pre-evidence-${Date.now()}-${unique}.bak`", "`${path}.pre-evidence-${Date.now()}.bak`", /two migrations in the same millisecond/],
  // Fifth amendment.
  ["start-time-tz-not-pinned", CLAIM, "    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },\n", "    env: { ...process.env, LC_ALL: 'C' },\n", /overlap across a time zone/],
  ["start-time-locale-not-pinned", CLAIM, "    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },\n", "    env: { ...process.env, TZ: 'UTC' },\n", /overlap across a locale/],
  ["claim-written-in-place", CLAIM, "  const temp = `${own}.tmp`;\n", "  const temp = own;\n", /a claim is seen only whole/],
  ["claim-temp-left-on-failure", CLAIM, "    rmSync(temp, { force: true });\n    throw err;\n", "    throw err;\n", /a claim that cannot be renamed in/],
  ["unterminated-not-flagged", LIB, "  const unterminated = !body.endsWith('\\n') && rows.length > 0 ? { unterminatedLast: rows.at(-1).raw } : {};\n", "  const unterminated = {};\n", /the current header appends/],
  ["unterminated-not-reported", CLI, "  if (plan.unterminatedLast) {\n", "  if (false) {\n", /adds a missing final newline/],
  ["resolve-skipped", CLI, "    await applyFlips('resolved', buckets.RESOLVE, records);\n", ""],
  ["archive-skipped", CLI, "    await applyFlips('archived', buckets.ARCHIVE, records);\n", ""],
];

const dir = mkdtempSync(join(realpathSync(tmpdir()), "oe-triage-mut-"));
const tool = join(dir, "action-item-triage");
let bad = 0;
try {
  cpSync(join(ROOT, "integrations/action-item-triage"), tool, {
    recursive: true,
    // Never carry .env or real output into the copy: the suite must not see credentials.
    filter: (src) => !/\/(\.env|out|config\.json)$/.test(src),
  });
  const run = () => spawnSync("node", ["--test", "triage.test.mjs", "triage.cli.test.mjs"], { cwd: tool, encoding: "utf8", timeout: 300000, killSignal: "SIGKILL" });
  const outcome = (result) => ({
    total: Number(result.stdout.match(/^ℹ tests (\d+)$/m)?.[1] ?? NaN),
    failures: [...new Set([...result.stdout.matchAll(/^✖ (.+?)(?: \(\d[^)]*\))?$/gm)].map((m) => m[1]))].filter((name) => name !== "failing tests:"),
  });
  const control = run();
  const expectedTotal = outcome(control).total;
  if (control.status !== 0 || !expectedTotal) {
    console.log(`CONTROL FAILED: ${control.stdout.slice(0, 400)}`);
    process.exit(2);
  }
  console.log(`CONTROL ok (${expectedTotal} tests)`);
  for (const [name, file, from, to, expected] of MUTANTS) {
    const path = join(tool, file);
    const original = readFileSync(path, "utf8");
    const count = original.split(from).length - 1;
    if (count !== 1) {
      console.log(`NEVER-RAN ${name}: target appears ${count} times, expected exactly 1`);
      process.exitCode = 2;
      bad += 1;
      continue;
    }
    writeFileSync(path, original.replace(from, () => to), "utf8");
    const result = run();
    writeFileSync(path, original, "utf8");
    const { total, failures } = outcome(result);
    if (result.status === 0) {
      console.log(`SURVIVED ${name}`);
      process.exitCode = process.exitCode || 1;
      bad += 1;
    } else if (total !== expectedTotal || failures.length === 0) {
      console.log(`NEVER-RAN ${name}: the suite did not run its ${expectedTotal} tests (got ${total}), so this failure is not the defect`);
      process.exitCode = 2;
      bad += 1;
    } else if (expected && !failures.some((f) => expected.test(f))) {
      console.log(`WRONG-FAILURE ${name}: wanted ${expected}, got ${failures[0]}`);
      process.exitCode = process.exitCode || 1;
      bad += 1;
    } else {
      const named = expected ? failures.find((f) => expected.test(f)) : failures[0];
      console.log(`CAUGHT ${name} [${failures.length} failed]: ${named.slice(0, 100)}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (!bad) console.log(`ALL MUTATIONS CAUGHT (${MUTANTS.length})`);
