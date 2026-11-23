#!/usr/bin/env node
// PR 20 second amendment: the real triage.mjs --apply against a real database. Run by
// action-item-events-sql-test.sh on its throwaway cluster, never on anything shared.
//
// Real CLI -> loopback HTTP adapter -> the migrated transition_action_item, run as
// service_role. The adapter is not PostgREST, so the wrapper's schema cache and grants
// remain a rollout check, but every close below is the migration's own function
// writing its own event. Adapted from the PR 20 re-review's reproduction.
//
//   TRIAGE_DB_PORT=<port> TRIAGE_TOOL_DIR=<dir> node triage-cli-db-test.mjs
//   node triage-cli-db-test.mjs --mutate-file <dir> <mutant>   # rewrite a copy of the tool
//
// Exit 0 passed, 1 failed, 2 never ran (no database, or a fixture that did not produce
// the condition it exists to produce), 3 stopped by the watchdog. Only 1 counts as a catch.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MUTANTS = {
  // The re-review's defect: a decision with no close reason becomes a fragment.
  archive_defaults_fragment: ["triage-lib.mjs", `      return hold('ARCHIVE names no close_reason');`, `      return { bucket, reason: said, closeReason: 'fragment' };`],
  archive_accepts_any_reason: ["triage-lib.mjs", `    if (decision.close_reason !== 'fragment') {`, `    if (false) {`],
  done_without_evidence: ["triage-lib.mjs", `    if (typeof decision.evidence !== 'string' || !DONE_EVIDENCE_RE.test(decision.evidence)) {`, `    if (false) {`],
  // Trusting a phrase in the free text, which the contract exists to refuse.
  done_from_free_text: ["triage-lib.mjs", `    if (decision.close_reason !== 'done') return hold(`, `    if (/shipped in commit/.test(said)) return { bucket, reason: said, closeReason: 'done' };\n    if (decision.close_reason !== 'done') return hold(`],
  status_guard_dropped: ["triage-lib.mjs", `p_from_statuses: ['open'],`, `p_from_statuses: ['open', 'deferred'],`],
  // The third amendment's defect: the old header stays and evidence goes unheaded.
  csv_not_prepared: ["triage.mjs", `  prepareDispositionFile(dispPath);\n`, ``],
  // Migrates but keeps the old header: M3 never meets an old file, so only M3d can see it.
  csv_keeps_old_header: ["triage-lib.mjs", "content: `${[DISPOSITION_HEADER, ...lines].join('\\n')}\\n`,", "content: `${[LEGACY_DISPOSITION_HEADER, ...lines].join('\\n')}\\n`,"],
  // A refusal after the database writes keeps nothing from closing.
  csv_prepared_after_writes: ["triage.mjs", `  prepareDispositionFile(dispPath);\n  const records = [];\n  try {\n    await applyFlips('archived', buckets.ARCHIVE, records);\n    await applyFlips('resolved', buckets.RESOLVE, records);\n`, `  const records = [];\n  try {\n    await applyFlips('archived', buckets.ARCHIVE, records);\n    await applyFlips('resolved', buckets.RESOLVE, records);\n    prepareDispositionFile(dispPath);\n`],
  // Fourth amendment. The review's two defects, as the code they reproduced.
  claim_not_taken: ["triage.mjs", `  const claim = claimOrRefuse(dispPath);\n`, `  const claim = { held: () => true };\n`],
  claim_refusal_ignored: ["disposition-claim.mjs", `  if (holders.length > 0) {\n`, `  if (false) {\n`],
  dead_claim_not_recovered: ["disposition-claim.mjs", `    if (claim && holderIsGone(claim)) {\n`, `    if (false) {\n`],
  temp_path_shared: ["triage.mjs", "const temp = `${path}.${unique}.migrating`;", "const temp = `${path}.migrating`;"],
  csv_quote_in_unquoted_accepted: ["triage-lib.mjs", `      if (state === 'unquoted') return bad('a quote inside an unquoted field');\n`, ``],
  csv_text_after_quote_accepted: ["triage-lib.mjs", `    } else if (state === 'afterQuote') {\n      return bad('text after a closing quote');\n`, ``],
  csv_seven_under_current_accepted: ["triage-lib.mjs", `  const allowed = isCurrent ? [width] : [legacyWidth, width];\n`, `  const allowed = [legacyWidth, width];\n`],
  start_time_env_not_pinned: ["disposition-claim.mjs", `    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },\n`, ``],
  csv_writer_leaves_bare_cr: ["triage-lib.mjs", `return /[",\\r\\n]/.test(escaped)`, `return /[",\\n]/.test(escaped)`],
  // Brain Bank's cascade: a done project resolves as done and names where it read that.
  cascade_project_without_reason: ["triage-lib.mjs", `          closeReason: 'done',\n          evidence: projectStatusEvidence(project),\n`, `          evidence: projectStatusEvidence(project),\n`],
  cascade_duplicate_without_survivor: ["triage-lib.mjs", `        duplicateOf: newestByDescription.get(normalized),\n`, ``],
};

if (process.argv[2] === "--mutate-file") {
  const [dir, name] = [process.argv[3], process.argv[4]];
  const mutant = MUTANTS[name];
  if (!mutant) {
    console.log(`unknown triage mutant: ${name}`);
    process.exit(2);
  }
  const path = join(dir, mutant[0]);
  const text = readFileSync(path, "utf8");
  const count = text.split(mutant[1]).length - 1;
  if (count !== 1) {
    console.log(`mutant ${name}: target appears ${count} times, expected exactly 1`);
    process.exit(2);
  }
  writeFileSync(path, text.replace(mutant[1], () => mutant[2]), "utf8");
  process.exit(0);
}

// A schedule that waits on a process can wait forever. Exit 3 is neither pass nor catch.
const liveProcesses = new Set();
const WATCHDOG_MS = Number(process.env.TRIAGE_DB_WATCHDOG_MS || 300000);
setTimeout(() => {
  for (const child of liveProcesses) child.kill("SIGKILL");
  console.log(`HARNESS_TIMEOUT: no result after ${WATCHDOG_MS} ms. This is not a test result.`);
  process.exit(3);
}, WATCHDOG_MS).unref();

const PORT = process.env.TRIAGE_DB_PORT;
const TOOL = process.env.TRIAGE_TOOL_DIR;
if (!PORT || !TOOL) {
  console.log("needs TRIAGE_DB_PORT and TRIAGE_TOOL_DIR; run through action-item-events-sql-test.sh");
  process.exit(2);
}

const sql = (text) => execFileSync("psql", ["-X", "-h", "127.0.0.1", "-p", PORT, "-U", "postgres", "-d", "obtest", "-Atq", "-v", "ON_ERROR_STOP=1"], { input: text, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const quote = (v) => (v == null ? "null" : `'${String(v).replaceAll("'", "''")}'`);
const id = (n) => `d9000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SIGNATURE = "uuid, text[], text, text, text, text, uuid, uuid, uuid, text, jsonb";

const dir = mkdtempSync(join(realpathSync(tmpdir()), "oe-triage-cli-db-"));
const decisionsPath = join(dir, "decisions.json");
const row = (n) => sql(`select status || '|' || coalesce(close_reason, '') || '|' || coalesce(duplicate_of::text, '') from public.action_items where id = ${quote(id(n))}`);
const event = (n) => sql(`select actor || '|' || new_status || '|' || coalesce(close_reason, '') from public.action_item_events where item_id = ${quote(id(n))} order by at`);
const eventCount = () => sql(`select count(*) from public.action_item_events where item_id::text like 'd9000000%'`);

let deferOnLoad = null;
let failNthRpc = 0;
let holdRpc = null;
const requests = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", async () => {
    requests.push([req.method, req.url]);
    const reply = (code, data) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.method === "GET" && req.url.startsWith("/rest/v1/action_items")) {
        const rows = JSON.parse(sql(`select coalesce(json_agg(a order by a.created_at), '[]') from (select *, null as thoughts from public.action_items where status = 'open' and id::text like 'd9000000%') a`));
        // Moves after the read: the row is open in the report and deferred at the write.
        if (deferOnLoad) {
          sql(`select public.transition_action_item(p_item_id => ${quote(deferOnLoad)}, p_from_statuses => array['open'], p_to_status => 'deferred', p_actor => 'race-fixture', p_defer_reason => 'pause:race')`);
          deferOnLoad = null;
        }
        return reply(200, rows);
      }
      if (req.method === "GET" && req.url.startsWith("/rest/v1/projects")) return reply(200, [{ display_name: "Jane Doe - Website", notion_page_id: null, status: "done" }]);
      if (req.method === "GET" && req.url.startsWith("/rest/v1/business_events")) return reply(200, []);
      if (req.method === "POST" && req.url === "/rest/v1/rpc/transition_action_item") {
        if (failNthRpc && --failNthRpc === 0) return reply(404, { message: "injected RPC failure" });
        if (holdRpc) {
          const held = holdRpc;
          holdRpc = null;
          held.entered();
          await held.released;
        }
        const args = JSON.parse(body);
        const types = { p_from_statuses: "text[]", p_event_payload: "jsonb" };
        const named = Object.entries(args).map(([k, v]) =>
          `${k} => ${Array.isArray(v) ? `array[${v.map(quote).join(",")}]::text[]` : `${quote(typeof v === "object" ? JSON.stringify(v) : v)}${types[k] ? `::${types[k]}` : ""}`}`
        ).join(", ");
        return reply(200, Number(sql(`set role service_role; select public.transition_action_item(${named})`)));
      }
      return reply(500, { message: "unexpected request" });
    } catch (err) {
      return reply(404, { message: String(err.stderr || err.message) });
    }
  });
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));

function startCli(stamp = "2026-11-06", preload = null, extraEnv = {}) {
  const child = spawn(process.execPath, [...(preload ? ["--import", preload] : []), join(TOOL, "triage.mjs"), "--apply", `--decisions=${decisionsPath}`, `--out-dir=${dir}`, `--stamp=${stamp}`], {
    env: { PATH: process.env.PATH, ...extraEnv, SUPABASE_URL: `http://127.0.0.1:${server.address().port}`, SUPABASE_SERVICE_ROLE_KEY: "local-dummy", NOTION_TOKEN: "", OPENROUTER_API_KEY: "" },
  });
  liveProcesses.add(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const finished = new Promise((done) => child.on("close", (code, signal) => {
    liveProcesses.delete(child);
    done({ code, signal, stderr });
  }));
  return { child, finished };
}
const runCli = (stamp, preload, extraEnv) => startCli(stamp, preload, extraEnv).finished;

// The emitted bytes through a real parser, in strict mode. A parse failure throws, which
// fails the schedule by name.
const STRICT = `
import csv, io, json, sys
text = sys.stdin.buffer.read().decode('utf-8-sig')
print(json.dumps([r for r in csv.reader(io.StringIO(text, newline=''), strict=True) if r]))
`;
function strictCsv(bytes) {
  const run = spawnSync("python3", ["-I", "-c", STRICT], { input: bytes, encoding: "utf8", maxBuffer: 1 << 26 });
  if (run.error) {
    console.log(`no python3 for the independent parser: ${run.error.message}`);
    process.exit(2);
  }
  assert.equal(run.status, 0, `Python's strict CSV parser rejected the file: ${run.stderr.trim().split("\n").at(-1)}`);
  return JSON.parse(run.stdout);
}
// Every record eight wide, then each record as an object by its column name.
function strictRecords(path) {
  const [header, ...rows] = strictCsv(readFileSync(path));
  assert.equal(header.join(","), H);
  for (const row of rows) assert.equal(row.length, 8, `a record of ${row.length} fields: ${JSON.stringify(row)}`);
  return rows.map((row) => Object.fromEntries(row.map((cell, i) => [header[i], cell])));
}
const H = "id,old_status,new_status,close_reason,outcome,reason,description,evidence";
const L = "id,old_status,new_status,close_reason,outcome,reason,description";
const PRIOR_ROW = "prior,open,archived,fragment,applied,r,d";
const csvOf = (stamp) => join(dir, `triage-disposition-${stamp}.csv`);
const beside = (stamp, marker) => readdirSync(dir).filter((name) => name.startsWith(`triage-disposition-${stamp}.csv.`) && name.includes(marker));
const claimsOf = (stamp) => beside(stamp, ".claim.");
const backupsOf = (stamp) => beside(stamp, ".pre-evidence-");
const postsSince = (start) => requests.slice(start).filter(([method]) => method === "POST").length;
const decide = (...ns) => writeFileSync(decisionsPath, JSON.stringify(Object.fromEntries(ns.map((n) => [id(n), { bucket: "RESOLVE", close_reason: "done", evidence: `commit:${String(n).padStart(7, "a")}`, reason: `verified work ${n}` }]))));
// A clean slate for the later schedules: one open item, and its decision.
function seedOne() {
  sql("delete from public.action_items where id::text like 'd9000000%'");
  sql(`insert into public.action_items (id, description) values (${quote(id(4))}, 'The development migration landed')`);
  decide(4);
}
function hook(name, body) {
  const file = join(dir, name);
  writeFileSync(file, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';\n${body}\nsyncBuiltinESMExports();\n`);
  return file;
}
// Pauses the CLI just before its first call of fs.<fn> on a .migrating path, with the
// real code above it already run. It waits for a file so a kill or a release is the test's.
function barrier(fn, stamp) {
  const signal = join(dir, `paused-${stamp}`);
  const release = join(dir, `release-${stamp}`);
  const file = hook(`barrier-${stamp}.mjs`, `
const original = fs.${fn};
let once = false;
fs.${fn} = function (p, ...rest) {
  if (!once && String(p).endsWith('.migrating')) {
    once = true;
    fs.writeFileSync(${JSON.stringify(signal)}, 'ready');
    const end = Date.now() + 120000;
    while (!fs.existsSync(${JSON.stringify(release)})) {
      if (Date.now() > end) throw new Error('barrier timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  return original.call(this, p, ...rest);
};`);
  return { file, release: () => writeFileSync(release, "go"), reached: () => existsSync(signal) };
}
async function reachedBarrier(gate, proc, label) {
  let exited = false;
  proc.finished.then(() => { exited = true; });
  while (!gate.reached()) {
    if (exited) assert.fail(`${label}: the process exited before its barrier: ${(await proc.finished).stderr.slice(-300)}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

let exitCode = 0;
try {
  try {
    sql("select 1;");
  } catch (err) {
    console.log(`no database: ${err.message}`);
    exitCode = 2;
    throw null;
  }
  const seed = [
    "Rewrite the release notes", // 1: older copy, the cascade's duplicate of 2
    "rewrite release notes", // 2: KEEP, the survivor
    "Prioritize sleep", // 3: a true fragment
    "The development migration landed", // 4: verified finished work
    "Consider a refresh someday", // 5: left open since classification
    "Finish the Jane Doe website handoff", // 6: the cascade's project done
    "The other migration landed", // 7: the re-review's exact decision, legacy shape
    "A third migration landed", // 8: done under ARCHIVE
    "A fourth migration landed", // 9: RESOLVE with free text and no pointer
    "A fifth migration landed", // 10: RESOLVE with a pointer that is not one
    "Maybe drop this one", // 11: a close reason triage does not offer
    "Maybe trash this one", // 12: an unknown bucket
    "Unclear whether this is real", // 13: an ambiguous decision
    "Quote nothing about this", // 14: a fragment with no reason
  ];
  seed.forEach((description, n) => sql(`insert into public.action_items (id, description, created_at) values (${quote(id(n + 1))}, ${quote(description)}, ${quote(`2026-06-${String(n + 1).padStart(2, "0")}`)})`));
  writeFileSync(decisionsPath, JSON.stringify({
    [id(2)]: { bucket: "KEEP", reason: "real" },
    [id(3)]: { bucket: "ARCHIVE", close_reason: "fragment", reason: "Prioritize sleep" },
    [id(4)]: { bucket: "RESOLVE", close_reason: "done", evidence: "commit:abcdef1", reason: "the migration shipped" },
    [id(5)]: { bucket: "ARCHIVE", close_reason: "fragment", reason: "Consider a refresh" },
    [id(7)]: { bucket: "ARCHIVE", reason: "shipped in commit abcdef1" },
    [id(8)]: { bucket: "ARCHIVE", close_reason: "done", evidence: "commit:abcdef1", reason: "shipped in commit abcdef1" },
    [id(9)]: { bucket: "RESOLVE", close_reason: "done", reason: "shipped in commit abcdef1" },
    [id(10)]: { bucket: "RESOLVE", close_reason: "done", evidence: "shipped in commit abcdef1", reason: "shipped" },
    [id(11)]: { bucket: "ARCHIVE", close_reason: "wont_do", reason: "drop it" },
    [id(12)]: { bucket: "TRASH", reason: "trash it" },
    [id(13)]: { bucket: "REVIEW", reason: "not sure" },
    [id(14)]: { bucket: "ARCHIVE", close_reason: "fragment", reason: "  " },
  }));

  deferOnLoad = id(5);
  const first = await runCli();
  if (deferOnLoad !== null) {
    console.log("fixture: the race row was never moved");
    exitCode = 2;
    throw null;
  }
  assert.equal(first.code, 0, `the CLI run: ${first.stderr}`);

  // Fragment, finished work and duplicate each land as what they are.
  assert.equal(row(3), "archived|fragment|", "a true fragment");
  assert.equal(event(3), "action-item-triage|archived|fragment");
  assert.equal(row(4), "resolved|done|", "verified finished work is not a fragment");
  assert.equal(event(4), "action-item-triage|resolved|done");
  assert.equal(sql(`select payload->>'evidence' from public.action_item_events where item_id = ${quote(id(4))}`), "commit:abcdef1");
  assert.equal(row(1), `archived|duplicate|${id(2)}`, "the duplicate keeps its survivor");
  assert.equal(event(1), "action-item-triage|archived|duplicate");
  assert.equal(row(2), "open||", "the survivor stays open");
  assert.equal(row(6), "resolved|done|", "the cascade's done project");
  assert.equal(event(6), "action-item-triage|resolved|done");
  assert.equal(sql(`select payload->>'evidence' from public.action_item_events where item_id = ${quote(id(6))}`), "project-status:projects-table:Jane Doe - Website");

  // A row that moved after it was read keeps its later state, and the only event is that move.
  assert.equal(row(5), "deferred||", "a stale status is skipped");
  assert.equal(event(5), "race-fixture|deferred|");

  // Everything the available evidence cannot justify stays open with no event at all.
  for (const n of [7, 8, 9, 10, 11, 12, 13, 14]) {
    assert.equal(row(n), "open||", `item ${n} stays open`);
    assert.equal(event(n), "", `item ${n} has no event`);
  }
  assert.match(first.stderr, /Applied 4, skipped 1/);
  assert.match(first.stderr, /7 decision\(s\) held in REVIEW/);
  const report = readFileSync(join(dir, "triage-report-2026-11-06.md"), "utf8");
  for (const needle of ["ARCHIVE names no close_reason. It said: shipped in commit abcdef1", "ARCHIVE closes only as fragment, not \"done\"", "RESOLVE needs a checkable evidence pointer", "unknown bucket \"TRASH\"", "a fragment needs its reason"]) {
    assert.ok(report.includes(needle), `the report says why: ${needle}`);
  }
  const csv = readFileSync(join(dir, "triage-disposition-2026-11-06.csv"), "utf8");
  assert.ok(csv.includes(`${id(4)},open,resolved,done,applied,the migration shipped,The development migration landed,commit:abcdef1`), csv);
  assert.ok(csv.includes(`${id(5)},open,archived,fragment,skipped_status_changed,`), csv);
  assert.ok(!csv.includes(id(7)), "a held decision has no CSV row");
  assert.deepEqual(requests.filter(([method]) => method === "PATCH"), [], "no direct status write");
  console.log("PASS M3 real CLI into the database: fragment, verified done and duplicate land as themselves; ambiguous and invalid decisions stay open; a stale status is skipped");

  // A re-run closes nothing new, and the held rows are still held.
  const before = eventCount();
  const rerun = await runCli();
  assert.equal(rerun.code, 0);
  assert.equal(eventCount(), before, "a re-run writes no event");
  assert.match(readFileSync(join(dir, "triage-disposition-2026-11-06.csv"), "utf8"), /^id,old_status/, "the file keeps its header");
  console.log("PASS M3b a re-run writes nothing new");

  // The RPC is gone: the run fails on its first call, visibly, with nothing written.
  sql(`insert into public.action_items (id, description, created_at) values (${quote(id(15))}, 'An advisory sentence', '2026-07-01')`);
  const decisions = JSON.parse(readFileSync(decisionsPath, "utf8"));
  decisions[id(15)] = { bucket: "ARCHIVE", close_reason: "fragment", reason: "advisory" };
  writeFileSync(decisionsPath, JSON.stringify(decisions));
  const beforeMissing = eventCount();
  sql(`alter function public.transition_action_item(${SIGNATURE}) rename to transition_action_item_hidden`);
  let missing;
  try {
    missing = await runCli();
  } finally {
    sql(`alter function public.transition_action_item_hidden(${SIGNATURE}) rename to transition_action_item`);
  }
  assert.equal(missing.code, 1, "a missing RPC fails the run");
  assert.match(missing.stderr, /FATAL: Supabase 404 rpc\/transition_action_item/, "and says so");
  assert.match(missing.stderr, /Applied 0, skipped 0/);
  assert.equal(eventCount(), beforeMissing, "no event");
  assert.equal(row(15), "open||", "the item stays open");
  console.log("PASS M3c a missing RPC fails closed and visibly");

  // The third amendment. A same-day file with the seven-column header: the real CLI
  // migrates it first, the row and event land as before, and the evidence is reachable
  // by its column name. Read with the tool's own parser and, in the review's probe,
  // with Python's csv.DictReader.
  const { csvRecords } = await import(pathToFileURL(join(TOOL, "triage-lib.mjs")).href);
  const named = (text) => {
    const [header, ...rows] = csvRecords(text);
    return rows.map((r) => Object.fromEntries(r.cells.map((cell, i) => [header.cells[i] ?? `unheaded-${i}`, cell])));
  };
  const laterDecisions = JSON.parse(readFileSync(decisionsPath, "utf8"));
  // M3c's item stays held from here on, so only the new row closes.
  laterDecisions[id(15)] = { bucket: "KEEP", reason: "held for the rest of this fixture" };
  laterDecisions[id(16)] = { bucket: "RESOLVE", close_reason: "done", evidence: "commit:fedcba9", reason: "the change landed" };
  writeFileSync(decisionsPath, JSON.stringify(laterDecisions));
  sql(`insert into public.action_items (id, description, created_at) values (${quote(id(16))}, 'The second migration landed', '2026-07-02')`);
  const migrated = join(dir, "triage-disposition-2026-11-07.csv");
  const prior = 'id,old_status,new_status,close_reason,outcome,reason,description\nprior-id,open,archived,fragment,applied,"a, b",prior record\n';
  writeFileSync(migrated, prior);
  const old = await runCli("2026-11-07");
  assert.equal(old.code, 0, `the CLI run over an old header: ${old.stderr}`);
  assert.equal(row(16), "resolved|done|");
  assert.equal(sql(`select payload->>'evidence' from public.action_item_events where item_id = ${quote(id(16))}`), "commit:fedcba9");
  const rows = named(readFileSync(migrated, "utf8"));
  assert.equal(rows.find((r) => r.id === id(16))?.evidence, "commit:fedcba9", "evidence by its column name");
  assert.deepEqual(
    (({ id: i, reason, description, evidence }) => [i, reason, description, evidence])(rows.find((r) => r.id === "prior-id")),
    ["prior-id", "a, b", "prior record", ""],
    "the prior record kept, with an empty evidence field",
  );
  assert.ok(rows.every((r) => !Object.keys(r).some((k) => k.startsWith("unheaded"))), "no unheaded field");
  const backups = readdirSync(dir).filter((name) => name.startsWith("triage-disposition-2026-11-07.csv.pre-evidence-"));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dir, backups[0]), "utf8"), prior);
  console.log("PASS M3d an old-header file is migrated by the real CLI before it writes, evidence reachable by name");

  // A header it does not know: refused before any database write, the row stays open.
  laterDecisions[id(16)] = { bucket: "KEEP", reason: "already closed" };
  laterDecisions[id(17)] = { bucket: "ARCHIVE", close_reason: "fragment", reason: "Remember to breathe" };
  writeFileSync(decisionsPath, JSON.stringify(laterDecisions));
  sql(`insert into public.action_items (id, description, created_at) values (${quote(id(17))}, 'Remember to breathe', '2026-07-03')`);
  const unknown = join(dir, "triage-disposition-2026-11-08.csv");
  const older = "id,old_status,new_status,bucket,reason,description\nolder,open,archived,ARCHIVE,r,d\n";
  writeFileSync(unknown, older);
  const beforeRefusal = eventCount();
  const refused = await runCli("2026-11-08");
  assert.equal(refused.code, 1, "an unknown header stops the run");
  assert.match(refused.stderr, /Refusing --apply/);
  assert.equal(eventCount(), beforeRefusal, "no event");
  assert.equal(row(17), "open||", "the item stays open");
  assert.equal(readFileSync(unknown, "utf8"), older, "the file is untouched");
  console.log("PASS M3e an unknown header refuses before any database write");

  // --- Fourth amendment. Every bad file: refused by the real CLI, nothing written. ---
  const BAD = [
    ["quote inside an unquoted field", `${L}\n${"prior,open,archived,fragment,applied,"}a"b,c",desc\n`],
    ["text after a closing quote", `${L}\nprior,open,archived,fragment,applied,"a"junk,desc\n`],
    ["the same two under the current header", `${H}\nprior,open,archived,fragment,applied,a"b,c",desc,\n`],
    ["trailing text, current header", `${H}\nprior,open,archived,fragment,applied,"a"junk,desc,\n`],
    ["seven fields under the current header", `${H}\nprior,open,resolved,done,applied,description,commit:1234567\n`],
    ["a torn write, unclosed quote", `${H}\nprior,open,archived,fragment,applied,"torn`],
    ["odd width", `${H}\nprior,open,archived\n`],
    ["nine fields under the seven-column header", `${L}\na,b,c,d,e,f,g,h,i\n`],
    ["the older six-column header", "id,old_status,new_status,bucket,reason,description\nprior,open,archived,ARCHIVE,r,d\n"],
    ["a bare carriage return", `${H}\nprior,open,archived,fragment,applied,a\rb,d,\n`],
    ["a NUL byte", `${H}\nprior,open,archived,fragment,applied,a\0b,d,\n`],
    ["a character torn in half", Buffer.concat([Buffer.from(`${H}\nprior,open,archived,fragment,applied,`), Buffer.from([0xc3])])],
  ];
  for (let i = 0; i < BAD.length; i += 1) {
    const [label, content] = BAD[i];
    const stamp = `bad-${i}`;
    seedOne();
    writeFileSync(csvOf(stamp), content);
    const start = requests.length;
    const result = await runCli(stamp);
    assert.equal(result.code, 1, `${label}: refused: ${result.stderr.slice(-300)}`);
    assert.match(result.stderr, /Refusing --apply/, label);
    assert.match(result.stderr, /Nothing was written/, label);
    assert.equal(postsSince(start), 0, `${label}: no RPC`);
    assert.equal(row(4), "open||", `${label}: the item stays open`);
    assert.equal(eventCount(), "0", `${label}: no event`);
    assert.equal(Buffer.compare(readFileSync(csvOf(stamp)), Buffer.from(content)), 0, `${label}: the file is byte-identical`);
    assert.deepEqual([...backupsOf(stamp), ...claimsOf(stamp), ...beside(stamp, ".migrating")], [], `${label}: nothing left beside it`);
  }
  console.log(`PASS M3f ${BAD.length} malformed files refused by the real CLI: no RPC, no event, item open, file byte-identical`);

  // Every valid shape: the emitted bytes are valid for a real parser, all eight wide.
  const GOOD = [
    ["quoted commas, doubled quotes, embedded newline", `${L}\nprior,open,archived,fragment,applied,"a, ""b""","line1\nline2"\n`, { reason: 'a, "b"', description: "line1\nline2", evidence: "" }, 1],
    ["BOM and CRLF, a quoted CRLF", `\uFEFF${L}\r\nprior,open,archived,fragment,applied,"a\r\nb",desc\r\n`, { reason: "a\r\nb", description: "desc", evidence: "" }, 1],
    ["no final newline, current header", `${H}\nprior,open,archived,fragment,applied,r,d,`, { reason: "r", description: "d", evidence: "" }, 0],
    ["CRLF, current header", `${H}\r\nprior,open,archived,fragment,applied,r,d,\r\n`, { reason: "r", description: "d", evidence: "" }, 0],
    ["eight fields under the seven-column header", `${L}\nprior,open,resolved,done,applied,r,d,commit:1234567\n`, { reason: "r", description: "d", evidence: "commit:1234567" }, 1],
    ["a mix of both legacy widths", `${L}\nother,open,archived,fragment,applied,r,d\nprior,open,resolved,done,applied,r,d,commit:1234567\n`, { reason: "r", description: "d", evidence: "commit:1234567" }, 1],
    ["no final newline, seven-column header", `${L}\nprior,open,archived,fragment,applied,r,d`, { reason: "r", description: "d", evidence: "" }, 1],
  ];
  for (let i = 0; i < GOOD.length; i += 1) {
    const [label, content, expected, backups] = GOOD[i];
    const stamp = `good-${i}`;
    seedOne();
    writeFileSync(csvOf(stamp), content);
    const start = requests.length;
    const result = await runCli(stamp);
    assert.equal(result.code, 0, `${label}: ${result.stderr.slice(-300)}`);
    assert.equal(postsSince(start), 1, label);
    assert.equal(row(4), "resolved|done|", label);
    assert.equal(eventCount(), "1", label);
    const records = strictRecords(csvOf(stamp));
    const prior = records.find((r) => r.id === "prior");
    for (const [key, value] of Object.entries(expected)) assert.equal(prior[key], value, `${label}: the prior ${key}`);
    const added = records.find((r) => r.id === id(4));
    assert.equal(added.outcome, "applied", label);
    assert.equal(added.evidence, "commit:aaaaaa4", `${label}: evidence by its column name`);
    assert.equal(backupsOf(stamp).length, backups, `${label}: backups`);
    if (backups) assert.equal(readFileSync(join(dir, backupsOf(stamp)[0]), "utf8"), content, `${label}: the backup is the original`);
    assert.deepEqual(claimsOf(stamp), [], `${label}: the claim is released`);
  }
  console.log(`PASS M3g ${GOOD.length} valid shapes: one close, the emitted bytes pass Python's strict parser, every record eight wide, values and evidence by name`);

  // A carriage return in a real description: the tool must not write what it then refuses.
  seedOne();
  // Nothing else in this text forces quoting, so only the carriage return can.
  sql(`update public.action_items set description = E'one\\rtwo' where id = ${quote(id(4))}`);
  const cr = await runCli("carriage-return");
  assert.equal(cr.code, 0, cr.stderr);
  assert.equal(strictRecords(csvOf("carriage-return"))[0].description, "one\rtwo");
  sql(`insert into public.action_items (id, description) values (${quote(id(5))}, 'A later item')`);
  decide(4, 5);
  const crAgain = await runCli("carriage-return");
  assert.equal(crAgain.code, 0, `a re-run over this tool's own bytes: ${crAgain.stderr.slice(-300)}`);
  assert.equal(strictRecords(csvOf("carriage-return")).length, 2);
  console.log("PASS M3h a carriage return in a real description is quoted, and a re-run reads the bytes back");

  // Stale temps of the old fixed name, a file and a directory: neither blocks nor is read.
  for (const [label, make] of [["file", (p) => writeFileSync(p, "stale temporary content")], ["directory", (p) => mkdirSync(p)]]) {
    const stamp = `stale-${label}`;
    seedOne();
    writeFileSync(csvOf(stamp), `${L}\n${PRIOR_ROW}\n`);
    make(`${csvOf(stamp)}.migrating`);
    const result = await runCli(stamp);
    assert.equal(result.code, 0, `${label}: ${result.stderr.slice(-300)}`);
    assert.equal(strictRecords(csvOf(stamp)).length, 2, label);
    assert.ok(!readFileSync(csvOf(stamp), "utf8").includes("stale"), label);
    assert.ok(existsSync(`${csvOf(stamp)}.migrating`), `${label}: left alone`);
  }
  console.log("PASS M3i a stale temp, file or directory, neither blocks a migration nor is read");

  // Sequential same-day runs: the first's bytes are a prefix of the last's, one header.
  seedOne();
  writeFileSync(csvOf("same-day"), `${L}\n${PRIOR_ROW}\n`);
  assert.equal((await runCli("same-day")).code, 0);
  const firstRun = readFileSync(csvOf("same-day"), "utf8");
  sql(`insert into public.action_items (id, description) values (${quote(id(5))}, 'A later item')`);
  decide(4, 5);
  const laterRun = await runCli("same-day");
  assert.equal(laterRun.code, 0, laterRun.stderr);
  const sameDay = readFileSync(csvOf("same-day"), "utf8");
  assert.ok(sameDay.startsWith(firstRun), "nothing the first run recorded changed");
  assert.equal(sameDay.split(H).length - 1, 1, "one header");
  assert.deepEqual(strictRecords(csvOf("same-day")).map((r) => r.id), ["prior", id(4), id(5)]);
  assert.equal(backupsOf("same-day").length, 1, "one migration, one backup");
  console.log("PASS M3j sequential same-day runs keep every record under one header");

  // A real failure partway: the landed row is recorded, the rest stay open, a retry finishes.
  seedOne();
  sql(`insert into public.action_items (id, description, created_at) values (${quote(id(5))}, 'A later item', '2030-01-01')`);
  decide(4, 5);
  writeFileSync(csvOf("partial"), `${L}\n${PRIOR_ROW}\n`);
  failNthRpc = 2;
  const partial = await runCli("partial");
  assert.equal(partial.code, 1, "a failed call fails the run");
  assert.match(partial.stderr, /FATAL: Supabase 404/);
  assert.equal(row(4), "resolved|done|", "the first landed");
  assert.equal(row(5), "open||", "the second did not");
  assert.equal(eventCount(), "1");
  assert.deepEqual(strictRecords(csvOf("partial")).map((r) => [r.id, r.outcome]), [["prior", "applied"], [id(4), "applied"]]);
  assert.deepEqual(claimsOf("partial"), [], "the claim is released on a failure");
  const retry = await runCli("partial");
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(row(5), "resolved|done|");
  assert.equal(eventCount(), "2");
  assert.deepEqual(strictRecords(csvOf("partial")).map((r) => r.id), ["prior", id(4), id(5)]);
  console.log("PASS M3k a real partial failure keeps what landed, and a retry finishes under one record");

  // The review's race: two real processes, A paused after it planned from the old file.
  seedOne();
  writeFileSync(csvOf("race"), `${L}\n${PRIOR_ROW}\n`);
  const raceGate = barrier("writeFileSync", "race");
  const racer = startCli("race", raceGate.file);
  await reachedBarrier(raceGate, racer, "race");
  const raceStart = requests.length;
  const second = await runCli("race");
  assert.equal(second.code, 1, `the second run refuses: ${JSON.stringify(second.stderr.slice(-700))}`);
  assert.match(second.stderr, /another run holds/);
  assert.equal(postsSince(raceStart), 0, "and reaches no RPC");
  assert.equal(row(4), "open||", "the item is not closed by it");
  assert.equal(readFileSync(csvOf("race"), "utf8"), `${L}\n${PRIOR_ROW}\n`, "the file is untouched while A holds it");
  raceGate.release();
  const raceDone = await racer.finished;
  assert.equal(raceDone.code, 0, raceDone.stderr.slice(-300));
  assert.equal(row(4), "resolved|done|");
  assert.equal(event(4), "action-item-triage|resolved|done", "one close event");
  assert.deepEqual(strictRecords(csvOf("race")).map((r) => [r.id, r.outcome]), [["prior", "applied"], [id(4), "applied"]], "the acknowledged record is in the active file");
  assert.equal(backupsOf("race").length, 1);
  assert.deepEqual(claimsOf("race"), []);
  console.log("PASS M3l the review's race: a run paused before its temp write keeps the second out, and the acknowledged record stays");

  // The same overlap with A inside its real RPC call, already migrated.
  seedOne();
  writeFileSync(csvOf("mid-apply"), `${L}\n${PRIOR_ROW}\n`);
  let entered;
  let released;
  const inRpc = new Promise((done) => { entered = done; });
  const letGo = new Promise((done) => { released = done; });
  holdRpc = { entered, released: letGo };
  const holder = startCli("mid-apply");
  await inRpc;
  const midStart = requests.length;
  const shutOut = await runCli("mid-apply");
  assert.equal(shutOut.code, 1, shutOut.stderr.slice(-300));
  assert.match(shutOut.stderr, /another run holds/);
  assert.equal(postsSince(midStart), 0);
  const migratedBytes = readFileSync(csvOf("mid-apply"), "utf8");
  released();
  assert.equal((await holder.finished).code, 0);
  assert.ok(readFileSync(csvOf("mid-apply"), "utf8").startsWith(migratedBytes));
  assert.deepEqual(strictRecords(csvOf("mid-apply")).map((r) => [r.id, r.outcome]), [["prior", "applied"], [id(4), "applied"]]);
  console.log("PASS M3m a run inside its real RPC call keeps the second out");

  // The owner and the second run in different time zones or locales: launchd beside a
  // Terminal. ps renders a start time in its caller's zone and language, so comparing raw
  // strings once read a live owner as a dead one.
  for (const [label, envA, envB] of [
    ["time zone", { TZ: "Asia/Tokyo" }, { TZ: "America/New_York" }],
    ["locale", { LC_ALL: "fr_FR.UTF-8" }, { LC_ALL: "C" }],
  ]) {
    const stamp = `zone-${label.replace(" ", "-")}`;
    seedOne();
    writeFileSync(csvOf(stamp), `${L}\n${PRIOR_ROW}\n`);
    let zoneEntered;
    let zoneRelease;
    const zoneIn = new Promise((done) => { zoneEntered = done; });
    holdRpc = { entered: zoneEntered, released: new Promise((done) => { zoneRelease = done; }) };
    const owner = startCli(stamp, null, envA);
    await Promise.race([zoneIn, owner.finished.then((r) => { throw new Error(`${label}: the owner exited before its RPC: ${r.stderr.slice(-300)}`); })]);
    const zoneStart = requests.length;
    const other = await runCli(stamp, null, envB);
    const claimsAtOverlap = claimsOf(stamp).length;
    const postsAtOverlap = postsSince(zoneStart);
    zoneRelease();
    const ownerDone = await owner.finished;
    console.log(`OBSERVED ${label}: ${JSON.stringify({ second: other.code, recoveredLiveOwner: /Recovered/.test(other.stderr), claimsAtOverlap, secondPosts: postsAtOverlap, owner: ownerDone.code, ownerSawLoss: /was removed while it ran/.test(ownerDone.stderr), events: eventCount(), records: strictRecords(csvOf(stamp)).map((r) => `${r.id === "prior" ? "prior" : "item"}:${r.outcome}`) })}`);
    assert.equal(other.code, 1, `${label}: the second refuses a live owner: ${JSON.stringify(other.stderr.slice(-300))}`);
    assert.match(other.stderr, /another run holds/, label);
    assert.doesNotMatch(other.stderr, /Recovered/, `${label}: and does not call it dead`);
    assert.equal(claimsAtOverlap, 1, `${label}: the owner's claim survives`);
    assert.equal(postsAtOverlap, 0, `${label}: the second reaches no RPC`);
    assert.equal(ownerDone.code, 0, `${label}: ${ownerDone.stderr.slice(-300)}`);
    assert.deepEqual(strictRecords(csvOf(stamp)).map((r) => [r.id, r.outcome]), [["prior", "applied"], [id(4), "applied"]], label);
  }
  console.log("PASS M3p a live owner in another time zone or locale is never judged gone");

  // No gate at all: real processes in whatever order they land. Refusing is allowed, and
  // all of them may refuse. Losing an acknowledged record, or closing twice, is not.
  let refusals = 0;
  let closedInRace = 0;
  for (let trial = 0; trial < 6; trial += 1) {
    const stamp = `free-${trial}`;
    seedOne();
    writeFileSync(csvOf(stamp), `${L}\n${PRIOR_ROW}\n`);
    const runs = await Promise.all([runCli(stamp), runCli(stamp), runCli(stamp)]);
    for (const r of runs) {
      assert.ok([0, 1].includes(r.code), `trial ${trial}: exit ${r.code}: ${r.stderr.slice(-300)}`);
      if (r.code === 1) {
        assert.match(r.stderr, /another run holds/, `trial ${trial}`);
        refusals += 1;
      }
    }
    if (eventCount() === "1") closedInRace += 1;
    const final = await runCli(stamp);
    assert.equal(final.code, 0, final.stderr.slice(-300));
    assert.equal(event(4), "action-item-triage|resolved|done", `trial ${trial}: one close event, whoever won`);
    const records = strictRecords(csvOf(stamp));
    assert.equal(records.filter((r) => r.id === "prior").length, 1, `trial ${trial}: the prior record is kept`);
    assert.equal(records.filter((r) => r.id === id(4) && r.outcome === "applied").length, 1, `trial ${trial}: the acknowledged close is recorded once`);
    assert.equal(backupsOf(stamp).length, 1, `trial ${trial}: one migration`);
    assert.deepEqual(claimsOf(stamp), [], `trial ${trial}`);
  }
  console.log(`PASS M3n free-running processes on one file: one event and one applied record every trial (${refusals} refusals, closed during the race in ${closedInRace} of 6)`);

  // An owner killed before its temp write, and again between temp and rename. The original
  // stays whole, the claim is proved dead, and the next run finishes the job.
  for (const fn of ["writeFileSync", "renameSync"]) {
    const stamp = `killed-${fn}`;
    seedOne();
    const original = `${L}\n${PRIOR_ROW}\n`;
    writeFileSync(csvOf(stamp), original);
    const gate = barrier(fn, stamp);
    const owner = startCli(stamp, gate.file);
    await reachedBarrier(gate, owner, stamp);
    owner.child.kill("SIGKILL");
    assert.equal((await owner.finished).signal, "SIGKILL", stamp);
    assert.equal(readFileSync(csvOf(stamp), "utf8"), original, `${stamp}: the original is whole`);
    assert.equal(claimsOf(stamp).length, 1, `${stamp}: its claim is left behind`);
    assert.equal(row(4), "open||", `${stamp}: nothing closed`);
    const recovered = await runCli(stamp);
    assert.equal(recovered.code, 0, `${stamp}: ${recovered.stderr.slice(-300)}`);
    assert.match(recovered.stderr, /Recovered 1 claim/, stamp);
    assert.deepEqual(strictRecords(csvOf(stamp)).map((r) => [r.id, r.outcome]), [["prior", "applied"], [id(4), "applied"]], stamp);
    assert.deepEqual(claimsOf(stamp), [], stamp);
    if (fn === "renameSync") {
      assert.equal(beside(stamp, ".migrating").length, 1, "the killed run's temp stays, unread");
      assert.equal(backupsOf(stamp).length, 2, "each attempt kept its own backup");
    }
  }
  console.log("PASS M3o an owner killed before its temp write or before its rename: original whole, claim recovered, next run finishes");
} catch (err) {
  if (err !== null) {
    console.log(`FAIL M3 ${String(err?.message || err).split("\n")[0]}`);
    exitCode = 1;
  }
} finally {
  await new Promise((done) => server.close(done));
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
