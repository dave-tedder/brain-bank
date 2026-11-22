#!/usr/bin/env node
// Task 3.4, PR 19 second amendment: the real controller over a real database. Run by
// supersede-sql-test.sh against its throwaway cluster, never against anything shared.
//
// get_agent_task, supersede_agent_task and capture_thought are answered from local
// PostgreSQL (capture is a stub): the task row and events are selected the way the
// wrapper selects them, ordered by created_at, and the verb is the migration's. Every
// reopen is the real admin_amend_agent_task. Nothing fabricates a timestamp: the 1, 3, 2
// order comes from two real connections whose transaction start order differs from
// the row lock's order, and the tie comes from closes in one real transaction. PostgREST
// is not in the path, so what this proves stops at SQL and JSON.
//
//   SUPERSEDE_DB_PORT=<port> SUPERSEDE_CONTROLLER=<path> node supersede-recovery-db-test.mjs
//   node supersede-recovery-db-test.mjs --mutate-file <copy> <mutant>   # rewrite a copy
//
// Exit 0 passed, 1 failed, 2 never ran (no database, or a fixture that did not produce
// the condition it exists to produce: a test of a state that never occurred is not a pass).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CONTROLLER_MUTANTS = {
  // Finding 1 as the re-review reproduced it: array position is the identity.
  identity_by_array_position: [
    "    const generation = event?.payload?.generation;\n    if (!Number.isInteger(generation) || generation < 1) {",
    "    const generation = byGeneration.size + 1;\n    if (!Number.isInteger(generation) || generation < 1) {",
  ],
  // The qualification: equal timestamps as the identity of "closed by the verb".
  closed_by_matching_timestamps: [
    `    Number.isInteger(task.superseded_closed_generation);`,
    `    Boolean(task.superseded_at) && task.completed_at === task.superseded_at;`,
  ],
  // A repair is reported as a plain close whenever the card reads closed at all.
  ignore_closed_generation: [
    `  const cardChanged = Boolean(resume) &&\n    !(closedBySupersede(task) && task.superseded_closed_generation === generation);`,
    `  const cardChanged = Boolean(resume) &&\n    !closedBySupersede(task);`,
  ],
  event_id_not_checked: [
    `  if (journal.state !== "intent-written" && journal.event_id !== event.id) {`,
    `  if (false) {`,
  ],
  // Third amendment, over real events: tied timestamps make these the only identity.
  repair_by_latest_generation: [
    `  const event = index.byGeneration.get(generation);\n  if (!event) hold(`,
    `  const event = index.byGeneration.get(index.latest);\n  if (!event) hold(`,
  ],
  audit_latest_generation_only: [
    `const generations = [...index.byGeneration.keys()].sort((a, b) => a - b);`,
    `const generations = index.latest ? [index.latest] : [];`,
  ],
  repair_calls_the_verb: [
    `    if (!evaluation.already_done) {\n      await mcpCall(config, "supersede_agent_task"`,
    `    if (!evaluation.already_done || repairGeneration !== null) {\n      await mcpCall(config, "supersede_agent_task"`,
  ],
  // Fourth amendment. The review's reproductions, as the code they reproduced.
  audit_discards_listed_ids: [
    `const { packets, gaps } = reconcileSupersedeInventory(listed.events, fetched);`,
    `const packets = fetched.map((f) => f.packet);\n    const gaps = [];`,
  ],
  repair_takes_no_claim: [
    `  return await withSupersedeLease(\n    cli,\n    cli.repairSupersedeTaskId,\n    "supersede-repair",\n    (lease) => repairUnderLease(cli, registry, lease),\n  );`,
    `  return await repairUnderLease(cli, registry, null);`,
  ],
  overlap_ignored: [
    `  if (holders.length > 0) {\n    rmSync(path, { force: true });`,
    `  if (false) {\n    rmSync(path, { force: true });`,
  ],
  dead_owner_never_recovered: [
    `    if (claim && supersedeLeaseHolderIsGone(claim)) {`,
    `    if (false) {`,
  ],
  capture_not_pinned: [
    `const captureContent = journaled.capture_content ??\n        asCloseoutCapture(\`\${eventBody} Event \${event.id}.\`);`,
    `const captureContent = asCloseoutCapture(\`\${eventBody} Event \${event.id}.\`);`,
  ],
  capture_body_is_the_file_body: [
    `asCloseoutCapture(\`\${eventBody} Event \${event.id}.\`);`,
    `asCloseoutCapture(\`\${body} Event \${event.id}.\`);`,
  ],
  // The harness's own failure mode: a command that exits 0 having run nothing must fail
  // the schedule by name, not hang it.
  start_time_env_not_pinned: [
    `    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },\n`,
    ``,
  ],
  cli_does_nothing: [
    `process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href`,
    `false && import.meta.url === pathToFileURL(process.argv[1]).href`,
  ],
};

if (process.argv[2] === "--mutate-file") {
  const [file, name] = [process.argv[3], process.argv[4]];
  const mutant = CONTROLLER_MUTANTS[name];
  if (!mutant) {
    console.log(`unknown controller mutant: ${name}`);
    process.exit(2);
  }
  const text = readFileSync(file, "utf8");
  const count = text.split(mutant[0]).length - 1;
  if (count !== 1) {
    console.log(`mutant ${name}: target appears ${count} times, expected exactly 1`);
    process.exit(2);
  }
  writeFileSync(file, text.replace(mutant[0], () => mutant[1]), "utf8");
  process.exit(0);
}

const PORT = process.env.SUPERSEDE_DB_PORT;
if (!PORT || !process.env.SUPERSEDE_CONTROLLER) {
  console.log("needs SUPERSEDE_DB_PORT and SUPERSEDE_CONTROLLER; run through supersede-sql-test.sh");
  process.exit(2);
}
const { runSupersede, runSupersedeRepair, runUnrecordedAudit, supersedeMarker } = await import(pathToFileURL(process.env.SUPERSEDE_CONTROLLER).href);

// The controller's entrypoint guard compares import.meta.url, which is resolved, with
// argv[1], which is not. Spawned through a symlink (macOS /tmp is one) it exits 0 having
// run nothing, so the processes below get the resolved path. A reviewer's /tmp worktree
// and every mutated copy under /tmp/obss.* would otherwise run nothing at all.
const CONTROLLER_PATH = realpathSync(process.env.SUPERSEDE_CONTROLLER);

// A schedule that waits on a process can wait forever. Exit 3 is neither pass (0) nor a
// defect caught (1), so the sweep reports NEVER-RAN instead of hanging or crediting a catch.
const liveProcesses = new Set();
const WATCHDOG_MS = Number(process.env.SUPERSEDE_DB_WATCHDOG_MS || 300000);
setTimeout(() => {
  for (const child of liveProcesses) child.kill("SIGKILL");
  console.log(`HARNESS_TIMEOUT: no result after ${WATCHDOG_MS} ms. This is not a test result.`);
  process.exit(3);
}, WATCHDOG_MS).unref();

const PSQL = ["-X", "-h", "127.0.0.1", "-p", PORT, "-U", "postgres", "-d", "obtest", "-v", "ON_ERROR_STOP=1", "-Atq"];
function sql(text) {
  const run = spawnSync("psql", PSQL, { input: text, encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr.trim());
  return run.stdout.trim();
}
const q = (value) => (value === null || value === undefined ? "null" : `'${String(value).replace(/'/g, "''")}'`);
const closeSql = (id, reason, generation = null, by = null) =>
  `select row_to_json(x) from public.close_agent_task_superseded(${q(id)}, ${q(reason)}, ${q(by)}, 'operator', ${generation ?? "null"}) x;`;
const reopenSql = (id) =>
  `select (public.admin_amend_agent_task(${q(id)}, 'recovery test reopen', p_move_to_needs_operator => true, p_set_operator_action => 'verify')).status;`;
const reopen = (id) => assert.equal(sql(reopenSql(id)), "Needs Operator");
const newCard = () => {
  const id = randomUUID();
  sql(`insert into public.agent_tasks (id, title, status, project_slug, blocked_reason) values (${q(id)}, 'recovery fixture', 'Needs Operator', 'tmp-proj', null);`);
  return id;
};
// The wrapper's read: task, then events ordered by created_at alone.
const readEvents = (id) => JSON.parse(sql(`select coalesce(json_agg(e order by e.created_at), '[]') from (select id, task_id, created_at, event_type, agent_code, payload from public.agent_task_events where task_id = ${q(id)}) e;`));
const supersedeEvents = (id) => readEvents(id).filter((e) => e.event_type === "TASK SUPERSEDED");
const eventOf = (id, generation) => supersedeEvents(id).find((e) => e.payload.generation === generation);

const readPacket = ({ task_id }) => ({
  task: JSON.parse(sql(`select row_to_json(t) from public.agent_tasks t where id = ${q(task_id)};`)),
  events: readEvents(task_id),
});

function workspace() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "oe-supersede-db-"));
  writeFileSync(join(dir, "PROJECT-TRACKER.md"), "# Tracker\n");
  writeFileSync(join(dir, "SESSION-LOG.md"), "# Log\n");
  mkdirSync(join(dir, "journals"));
  return {
    dir,
    registry: { "tmp-proj": { workspace_path: dir, tracker_path: join(dir, "PROJECT-TRACKER.md"), session_log_path: join(dir, "SESSION-LOG.md"), capture_tag: "tmp_proj" } },
    cli: (id, reason, generation = null) => ({ supersedeTaskId: id, supersedeBy: null, supersedeReason: reason, supersedePremise: null, supersedeGeneration: generation, journalDir: join(dir, "journals"), liveCheck: false }),
    journal: (id, generation) => JSON.parse(readFileSync(join(dir, "journals", `${id}.supersede.g${generation}.json`), "utf8")),
    tracker: () => readFileSync(join(dir, "PROJECT-TRACKER.md"), "utf8"),
    log: () => readFileSync(join(dir, "SESSION-LOG.md"), "utf8"),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}
const count = (text, needle) => text.split(needle).length - 1;

// Runs one controller command with the MCP answered from this database.
async function controller(cli, registry, hooks = {}) {
  const calls = [];
  const printed = [];
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  process.env.BB_MCP_URL = "http://mcp.stub.invalid/";
  process.env.BB_MCP_KEY = "stub-key";
  const { entry = runSupersede, ...toolHooks } = hooks;
  const handlers = {
    get_agent_task: readPacket,
    // The wrapper's query, against the real events. Local PostgreSQL stands in for PostgREST.
    list_supersede_events: ({ limit }) => {
      const events = JSON.parse(sql(`select coalesce(json_agg(e), '[]') from (select id, task_id, created_at from public.agent_task_events where event_type = 'TASK SUPERSEDED' order by created_at desc, id desc limit ${Number(limit)}) e;`));
      return { count: events.length, total: Number(sql(`select count(*) from public.agent_task_events where event_type = 'TASK SUPERSEDED';`)), limit, events };
    },
    list_agent_tasks: ({ statuses }) => ({ tasks: JSON.parse(sql(`select coalesce(json_agg(t), '[]') from public.agent_tasks t where status = ${q(statuses[0])} and archived_at is null;`)) }),
    supersede_agent_task: (a) => ({ receipt: "TASK SUPERSEDED", task: JSON.parse(sql(closeSql(a.task_id, a.reason, a.expected_generation ?? null, a.superseded_by ?? null))) }),
    capture_thought: () => "Captured as observation",
    ...toolHooks,
  };
  globalThis.fetch = async (_url, init) => {
    const rpc = JSON.parse(init.body);
    calls.push({ name: rpc.params.name, args: rpc.params.arguments });
    const payload = handlers[rpc.params.name](rpc.params.arguments);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  console.log = (...a) => printed.push(a.map(String).join(" "));
  let error = null;
  try {
    await entry(cli, registry);
  } catch (err) {
    error = err;
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  return { calls, output: printed.join("\n"), error, verbs: calls.filter((c) => c.name === "supersede_agent_task").length };
}

// A second real connection, holding an open transaction until told to finish.
function openTransaction(name) {
  const child = spawn("psql", PSQL, { env: { ...process.env, PGAPPNAME: name }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.write("begin; select now();\n");
  let waited = 0;
  while (sql(`select count(*) from pg_stat_activity where application_name = ${q(name)} and state = 'idle in transaction';`) !== "1") {
    if ((waited += 1) > 500) {
      console.log("fixture: the held transaction never started");
      process.exit(2);
    }
  }
  return {
    finish: (text) => new Promise((done, fail) => {
      let err = "";
      child.stderr.on("data", (chunk) => { err += chunk; });
      child.stdout.on("data", () => {});
      child.on("close", (code) => (code === 0 ? done() : fail(new Error(err))));
      child.stdin.end(`${text}\ncommit;\n`);
    }),
  };
}

// The fixture must produce the state it exists for, or the run proves nothing.
function requireFixture(condition, what) {
  if (!condition) {
    console.log(`fixture did not produce ${what}`);
    process.exit(2);
  }
}

// Generation 2's history is unfinished when the events start reading back 1, 3, 2.
async function reversedOrder(label, reasons) {
  const ws = workspace();
  try {
    const id = newCard();
    const first = await controller(ws.cli(id, reasons[0]), ws.registry);
    assert.equal(first.error, null, `${label}: generation 1 closes`);
    reopen(id);
    const earlier = openTransaction(`recovery_${label.replace(/\W/g, "_")}`);
    const partial = await controller(ws.cli(id, reasons[1], 2), ws.registry, { capture_thought: () => { throw new Error("capture down"); } });
    assert.match(String(partial.error), /capture down/, `${label}: generation 2 stops before its capture`);
    assert.equal(ws.journal(id, 2).state, "files-written");
    reopen(id);
    await earlier.finish(closeSql(id, reasons[2], 3));
    requireFixture(
      supersedeEvents(id).map((e) => e.payload.generation).join() === "1,3,2",
      `the 1, 3, 2 order (${label})`,
    );

    const repair = await controller(ws.cli(id, reasons[1], 2), ws.registry);
    assert.equal(repair.error, null, `${label}: the repair must not refuse`);
    assert.equal(repair.verbs, 0, `${label}: no verb`);
    assert.match(repair.output, /HISTORY_REPAIRED_CARD_CHANGED/, `${label}: generation 3 closed the card, not this run`);
    const journal2 = ws.journal(id, 2);
    assert.equal(journal2.state, "complete");
    assert.equal(journal2.event_id, eventOf(id, 2).id, `${label}: generation 2's own event`);
    assert.equal(journal2.superseded_at, String(eventOf(id, 2).created_at), `${label}: generation 2's own time`);
    assert.equal(count(ws.tracker(), supersedeMarker(id, 2)), 1);
    assert.equal(count(ws.log(), supersedeMarker(id, 2)), 1);
    assert.equal(count(ws.tracker(), supersedeMarker(id, 3)), 0, `${label}: generation 3's history is a separate run`);

    // Generation 3 was closed by the bare verb, and is still the live close.
    const third = await controller(ws.cli(id, reasons[2]), ws.registry);
    assert.equal(third.error, null, `${label}: generation 3's history`);
    assert.equal(third.verbs, 0);
    assert.equal(ws.journal(id, 3).event_id, eventOf(id, 3).id);
    assert.equal(count(ws.tracker(), supersedeMarker(id, 3)), 1);

    const replay = await controller(ws.cli(id, reasons[2]), ws.registry);
    assert.equal(replay.error, null);
    assert.equal(replay.verbs, 0);
    assert.match(replay.output, /ALREADY_COMPLETE/);
    assert.equal(supersedeEvents(id).length, 3);
    console.log(`PASS R1 ${label}: events read 1, 3, 2 from real transactions; generation 2 repaired from its own event`);
  } finally {
    ws.done();
  }
}

// The verb lands, its response is lost, the card is reopened, later generations land
// with the same arguments in one transaction, so every created_at ties.
async function tiedAfterLostResponse(label, reasons) {
  const ws = workspace();
  try {
    const id = newCard();
    const lost = await controller(ws.cli(id, reasons[0]), ws.registry, {
      supersede_agent_task: (a) => {
        sql(closeSql(a.task_id, a.reason, a.expected_generation ?? null));
        throw new Error("MCP supersede_agent_task HTTP 503: response lost");
      },
    });
    assert.match(String(lost.error), /response lost/);
    assert.equal(ws.journal(id, 1).state, "intent-written");
    reopen(id);
    sql(`begin; ${closeSql(id, reasons[1], 2)} ${reopenSql(id)} ${closeSql(id, reasons[2], 3)} ${reopenSql(id)} commit;`);
    const events = supersedeEvents(id);
    requireFixture(new Set(events.slice(1).map((e) => e.created_at)).size === 1 && events.length === 3, `tied timestamps (${label})`);

    const adopt = await controller(ws.cli(id, reasons[0]), ws.registry);
    assert.equal(adopt.error, null, `${label}: the lost response is adopted`);
    assert.equal(adopt.verbs, 0);
    assert.equal(ws.journal(id, 1).event_id, eventOf(id, 1).id);
    assert.equal(ws.journal(id, 1).state, "complete");
    assert.match(adopt.output, /HISTORY_REPAIRED_CARD_CHANGED/);
    assert.equal(count(ws.tracker(), supersedeMarker(id, 1)), 1);

    // A journaled intent for tied generation 2: found by number, whichever row came first.
    writeFileSync(join(ws.dir, "journals", `${id}.supersede.g2.json`), JSON.stringify({
      version: 3, kind: "supersede", state: "intent-written", task_id: id, generation: 2, project_slug: "tmp-proj",
      args: { reason: reasons[1], by: null },
    }));
    const tied = await controller(ws.cli(id, reasons[1], 2), ws.registry);
    assert.equal(tied.error, null, `${label}: tied generation 2`);
    assert.equal(tied.verbs, 0);
    assert.equal(ws.journal(id, 2).event_id, eventOf(id, 2).id, `${label}: tied timestamps must not select the wrong event`);
    assert.equal(count(ws.tracker(), supersedeMarker(id, 3)), 0);

    // Generation 3's event exists but this reopened card has no journal for it. The
    // ordinary command cannot write it, and must not guess: R7 is the supported path.
    const next = await controller(ws.cli(id, reasons[2]), ws.registry);
    assert.match(String(next.error), /REOPENED_CARD_NEEDS_GENERATION/);
    assert.equal(next.verbs, 0);
    assert.equal(count(ws.tracker(), supersedeMarker(id, 3)), 0, "--supersede does not write generation 3's history");
    console.log(`PASS R2 ${label}: tied timestamps and a lost response select by generation`);
  } finally {
    ws.done();
  }
}

// The re-review's limitation: in one transaction a real supersede, a real admin reopen
// and a real ordinary completion all stamp one now().
async function sameTransactionCompletion() {
  const ws = workspace();
  try {
    const id = newCard();
    sql(`begin; ${closeSql(id, "same transaction", 1)} ${reopenSql(id)} select (public.complete_operator_action(${q(id)}, 'operator', 'finished normally')).status; commit;`);
    requireFixture(sql(`select completed_at = superseded_at from public.agent_tasks where id = ${q(id)};`) === "t", "equal timestamps after an ordinary completion");
    const run = await controller(ws.cli(id, "same transaction"), ws.registry);
    assert.match(String(run.error), /SUPERSEDE_STATUS_NOT_LEGAL/, "an ordinary completion is not a supersede");
    assert.equal(run.verbs, 0);
    assert.equal(ws.tracker(), "# Tracker\n");
    console.log("PASS R3: a same-transaction ordinary completion is not read as superseded");
  } finally {
    ws.done();
  }
}

async function repeatedCycles() {
  const ws = workspace();
  try {
    const id = newCard();
    for (let generation = 1; generation <= 5; generation += 1) {
      const reason = generation % 2 ? "alternating reason" : `reason ${generation}`;
      const cli = ws.cli(id, reason, generation);
      const close = await controller(cli, ws.registry);
      assert.equal(close.error, null, `cycle ${generation}`);
      assert.equal(close.verbs, 1);
      assert.equal(ws.journal(id, generation).event_id, eventOf(id, generation).id);
      const replay = await controller(cli, ws.registry);
      assert.equal(replay.verbs, 0, `replay ${generation}`);
      assert.match(replay.output, /ALREADY_COMPLETE/);
      assert.equal(count(ws.tracker(), supersedeMarker(id, generation)), 1);
      assert.equal(count(ws.log(), supersedeMarker(id, generation)), 1);
      reopen(id);
      const held = await controller(cli, ws.registry);
      assert.match(String(held.error), /GENERATION_MISMATCH/);
      assert.equal(held.verbs, 0, `an old authorization on reopened cycle ${generation}`);
    }
    assert.equal(supersedeEvents(id).length, 5);
    console.log("PASS R4: five real reopen and close cycles, each history written once");
  } finally {
    ws.done();
  }
}

async function brokenHistories() {
  const ws = workspace();
  try {
    for (const [label, payloads] of Object.entries({
      missing: ['{"reason":"r"}'],
      string: ['{"generation":"1","reason":"r"}'],
      duplicate: ['{"generation":1,"reason":"r"}', '{"generation":1,"reason":"r"}'],
      gap: ['{"generation":1,"reason":"r"}', '{"generation":3,"reason":"r"}'],
    })) {
      const id = newCard();
      for (const payload of payloads) sql(`insert into public.agent_task_events (task_id, event_type, payload) values (${q(id)}, 'TASK SUPERSEDED', ${q(payload)});`);
      const run = await controller(ws.cli(id, "r", payloads.length + 1), ws.registry);
      assert.match(String(run.error), /SUPERSEDE_HISTORY_INVALID/, label);
      assert.equal(run.verbs, 0, label);
      assert.deepEqual(run.calls.map((c) => c.name), ["get_agent_task"], label);
      assert.throws(() => sql(closeSql(id, "r", payloads.length + 1)), /not exactly 1 to/, `${label}: the verb refuses too`);
    }
    assert.equal(ws.tracker(), "# Tracker\n");
    console.log("PASS R5: missing, string, duplicate and gapped generations hold in the controller and the verb");
  } finally {
    ws.done();
  }
}

// Two real generations with identical arguments differ only by event id. A journal that
// recorded one must not be satisfied by the other, in either state past its intent.
async function journalNamesTheWrongEvent() {
  const ws = workspace();
  try {
    const id = newCard();
    sql(closeSql(id, "same reason", 1));
    reopen(id);
    sql(closeSql(id, "same reason", 2));
    const [one, two] = [eventOf(id, 1), eventOf(id, 2)];
    requireFixture(one && two && one.id !== two.id, "two distinct real events");
    for (const state of ["board-superseded", "complete"]) {
      writeFileSync(join(ws.dir, "journals", `${id}.supersede.g1.json`), JSON.stringify({
        version: 3, kind: "supersede", state, task_id: id, generation: 1, project_slug: "tmp-proj",
        event_id: two.id, args: { reason: "same reason", by: null },
      }));
      const run = await controller(ws.cli(id, "same reason"), ws.registry);
      assert.match(String(run.error), /event-mismatch/, state);
      assert.equal(run.verbs, 0, state);
      assert.equal(ws.tracker(), "# Tracker\n", state);
    }
    console.log("PASS R6: a journal naming another generation's real event is refused");
  } finally {
    ws.done();
  }
}

const repairCli = (ws, id, generation, liveCheck = false) => ({ repairSupersedeTaskId: id, supersedeGeneration: generation, journalDir: join(ws.dir, "journals"), liveCheck });
const repair = (ws, id, generation, hooks = {}) => controller(repairCli(ws, id, generation), ws.registry, { entry: runSupersedeRepair, ...hooks });
const auditRows = async (ws, id) => {
  const run = await controller({ lookbackDays: 7 }, ws.registry, { entry: runUnrecordedAudit });
  assert.equal(run.error, null, "the audit ran");
  const result = JSON.parse(run.output);
  assert.equal(result.supersede_scan.error, null);
  return { rows: result.unrecorded.filter((row) => row.task_id === id), result };
};
const boardState = (id) => sql(`select row_to_json(t) from public.agent_tasks t where id = ${q(id)};`) + JSON.stringify(readEvents(id));

// The re-review's gate: a bare close reopened before any controller ran. Real verb, real
// reopen, no journal. Identical reasons in one transaction leave generation as the only
// way to tell the events apart.
async function bareCloseFoundAndRepaired() {
  const ws = workspace();
  try {
    const id = newCard();
    sql(`begin; ${closeSql(id, "same reason", 1)} ${reopenSql(id)} ${closeSql(id, "same reason", 2)} ${reopenSql(id)} commit;`);
    const events = supersedeEvents(id);
    requireFixture(events.length === 2 && events[0].created_at === events[1].created_at, "two bare closes with tied timestamps");
    assert.equal(ws.tracker(), "# Tracker\n");

    const ordinary = await controller(ws.cli(id, "same reason"), ws.registry);
    assert.match(String(ordinary.error), /REOPENED_CARD_NEEDS_GENERATION/);

    let { rows } = await auditRows(ws, id);
    assert.deepEqual(rows.map((r) => [r.generation, r.severity, r.event_id]), [
      [1, "SUPERSEDE_NO_HISTORY", eventOf(id, 1).id],
      [2, "SUPERSEDE_NO_HISTORY", eventOf(id, 2).id],
    ], "the audit finds both, which a status list could not, since the card is open");

    const before = boardState(id);
    const live = await controller(repairCli(ws, id, 1, true), ws.registry, { entry: runSupersedeRepair });
    assert.match(live.output, /REPAIR_READY/);
    assert.equal(ws.tracker(), "# Tracker\n", "the dry run wrote nothing");

    const one = await repair(ws, id, 1);
    assert.equal(one.error, null, String(one.error));
    assert.equal(one.verbs, 0, "the repair never reaches the verb");
    assert.match(one.output, /HISTORY_REPAIRED_CARD_CHANGED/);
    assert.equal(boardState(id), before, "the card and its events did not move");
    assert.equal(ws.journal(id, 1).event_id, eventOf(id, 1).id, "generation 1's own event");
    assert.equal(count(ws.tracker(), supersedeMarker(id, 1)), 1);
    assert.equal(count(ws.log(), supersedeMarker(id, 1)), 1);
    assert.equal(count(ws.tracker(), supersedeMarker(id, 2)), 0);
    ({ rows } = await auditRows(ws, id));
    assert.deepEqual(rows.map((r) => r.generation), [2], "the audit now names only what is left");

    const two = await repair(ws, id, 2);
    assert.equal(two.error, null);
    assert.equal(two.verbs, 0);
    assert.equal(ws.journal(id, 2).event_id, eventOf(id, 2).id, "generation 2's own event");
    assert.deepEqual((await auditRows(ws, id)).rows, [], "clean");

    const again = await repair(ws, id, 2);
    assert.match(again.output, /ALREADY_RECORDED/);
    assert.equal(again.calls.filter((c) => c.name === "capture_thought").length, 0);

    // The ordinary path still works afterwards, and a third generation joins the same history.
    const third = await controller(ws.cli(id, "third reason", 3), ws.registry);
    assert.equal(third.error, null, String(third.error));
    assert.equal(third.verbs, 1);
    assert.equal(count(ws.tracker(), supersedeMarker(id, 3)), 1);
    assert.deepEqual((await auditRows(ws, id)).rows, []);
    assert.equal(sql(`select status from public.agent_tasks where id = ${q(id)};`), "Agent Done");
    console.log("PASS R7: a reopened bare close is found by the audit and written by the repair, zero verbs");
  } finally {
    ws.done();
  }
}

// Partial history, a card still closed, and a close landing during the repair.
async function repairAgainstARealBoard() {
  const ws = workspace();
  try {
    const closed = newCard();
    sql(closeSql(closed, "still closed", 1));
    const stillClosed = await repair(ws, closed, 1);
    assert.equal(stillClosed.error, null);
    assert.equal(stillClosed.verbs, 0);
    assert.match(stillClosed.output, /"status": "HISTORY_REPAIRED"/);
    assert.equal(sql(`select superseded_closed_generation from public.agent_tasks where id = ${q(closed)};`), "1");

    const partial = newCard();
    sql(closeSql(partial, "half written", 1));
    writeFileSync(join(ws.dir, "PROJECT-TRACKER.md"), `${ws.tracker()}${supersedeMarker(partial, 1)}\n`);
    assert.deepEqual((await auditRows(ws, partial)).rows.map((r) => [r.severity, r.missing]), [["SUPERSEDE_PARTIAL_HISTORY", ["session_log"]]]);
    const half = await repair(ws, partial, 1);
    assert.equal(half.error, null);
    assert.equal(count(ws.tracker(), supersedeMarker(partial, 1)), 1, "not written twice");
    assert.equal(count(ws.log(), supersedeMarker(partial, 1)), 1);

    // A real reopen and close between the repair's read and its work.
    const raced = newCard();
    sql(closeSql(raced, "first", 1));
    let fired = false;
    const race = await repair(ws, raced, 1, {
      get_agent_task: (a) => {
        const packet = readPacket(a);
        if (!fired) {
          fired = true;
          reopen(raced);
          sql(closeSql(raced, "second", 2));
        }
        return packet;
      },
    });
    assert.equal(race.error, null, String(race.error));
    assert.equal(race.verbs, 0);
    assert.equal(ws.journal(raced, 1).event_id, eventOf(raced, 1).id);
    assert.match(race.output, /HISTORY_REPAIRED_CARD_CHANGED/, "generation 2 closed it now, and that is said");
    assert.equal(count(ws.tracker(), supersedeMarker(raced, 2)), 0);
    assert.deepEqual((await auditRows(ws, raced)).rows.map((r) => r.generation), [2], "and generation 2 is the next finding");
    console.log("PASS R8: repair over partial history, a closed card and a close landing mid-run");
  } finally {
    ws.done();
  }
}

// The third re-review's audit finding, from real rows: an event the inventory really
// holds, on a reopened card, past the row where a capped oldest-first read stops. The
// cap is applied by this fixture; no production PostgREST limit was measured.
async function cappedPacketIsNotClean() {
  const ws = workspace();
  try {
    const id = newCard();
    sql(`insert into public.agent_task_events (task_id, event_type, payload, created_at) select ${q(id)}, 'AGENT STATUS', '{}', now() - interval '1 day' from generate_series(1, 1000);`);
    sql(closeSql(id, "hidden by packet cap", 1));
    reopen(id);
    const listed = eventOf(id, 1);
    const capped = JSON.parse(sql(`select json_agg(e) from (select id, task_id, created_at, event_type, agent_code, payload from public.agent_task_events where task_id = ${q(id)} order by created_at asc limit 1000) e;`));
    requireFixture(capped.length === 1000 && !capped.some((e) => e.id === listed.id), "a capped packet that omits the listed event");
    const audit = async (events) => {
      const run = await controller({ lookbackDays: 7 }, ws.registry, {
        entry: runUnrecordedAudit,
        list_agent_tasks: () => ({ tasks: [] }),
        list_supersede_events: () => ({ count: 1, total: 1, limit: 500, events: [{ id: listed.id, task_id: id, created_at: listed.created_at }] }),
        get_agent_task: ({ task_id }) => ({ task: readPacket({ task_id }).task, events }),
      });
      assert.equal(run.error, null);
      return JSON.parse(run.output);
    };
    const complete = await audit(readEvents(id));
    assert.equal(complete.supersede_scan.coverage_complete, true, "the uncapped control");
    assert.deepEqual(complete.unrecorded.map((r) => r.severity), ["SUPERSEDE_NO_HISTORY"]);

    const result = await audit(capped);
    assert.equal(result.supersede_scan.error, null, "a null error is exactly the trap");
    assert.equal(result.supersede_scan.coverage_complete, false, "not complete");
    assert.equal(result.unrecorded_count, 1, "not zero findings");
    assert.equal(result.unrecorded[0].severity, "SUPERSEDE_COVERAGE_INCOMPLETE");
    assert.deepEqual(result.unrecorded[0].missing_event_ids, [listed.id]);
    assert.equal(result.scan_truncated.length, 1, "and the lanes' existing pass-through carries it");
    console.log("PASS R10: a listed event a capped packet omits is reported incomplete, never clean");
  } finally {
    ws.done();
  }
}

// The real controller as a real process, against an MCP served from this database.
// Capture is a stub with the production content-hash rule: rows counts distinct bytes,
// requests counts every send. That proves dispatch and bytes, not production rows.
async function mcpServer(hooks = {}) {
  const requests = { capture: [], verbs: 0 };
  const rows = new Set();
  const handlers = {
    get_agent_task: async (a) => {
      if (hooks.read) await hooks.read();
      return readPacket(a);
    },
    supersede_agent_task: (a) => {
      requests.verbs += 1;
      return { receipt: "TASK SUPERSEDED", task: JSON.parse(sql(closeSql(a.task_id, a.reason, a.expected_generation ?? null, a.superseded_by ?? null))) };
    },
    capture_thought: async (a) => {
      requests.capture.push(a.content);
      rows.add(createHash("sha256").update(a.content).digest("hex"));
      if (hooks.capture) await hooks.capture(requests.capture.length);
      return "Captured as observation";
    },
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      const rpc = JSON.parse(body);
      try {
        const payload = await handlers[rpc.params.name](rpc.params.arguments);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }));
      } catch (err) {
        res.writeHead(500);
        res.end(String(err?.message || err));
      }
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    requests,
    rows,
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
  };
}

function cliProcess(server, ws, args, journalDir = join(ws.dir, "journals"), env = {}) {
  const registry = join(ws.dir, "registry.json");
  writeFileSync(registry, JSON.stringify(ws.registry));
  const child = spawn(process.execPath, [CONTROLLER_PATH, ...args, "--registry", registry, "--journal-dir", journalDir], {
    env: { ...process.env, ...env, BB_MCP_URL: server.url, BB_MCP_KEY: "stub-key" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  liveProcesses.add(child);
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  const finished = new Promise((done) => child.on("close", (code, signal) => {
    liveProcesses.delete(child);
    done({ code, signal, out });
  }));
  return { child, finished };
}
const gate = () => {
  let open;
  const opened = new Promise((done) => { open = done; });
  return { opened, open };
};
// Wait for a process to reach its capture, failing if it exits first. A bare await on the
// gate hangs forever when the process never gets there, which is how a controller that
// ran nothing stalled a mutation sweep for 8 hours 48 minutes on 2026-11-06.
const reachedCapture = (entered, proc, label) => Promise.race([
  entered.opened,
  proc.finished.then(({ code, signal, out }) => {
    throw new Error(`${label}: the process exited before its capture (code ${code}, signal ${signal}): [${out.slice(-300)}]`);
  }),
]);
const leasesIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.includes(".lease.")) : []);
const repairArgs = (id, generation) => ["--repair-supersede", id, "--generation", String(generation)];
const closeArgs = (id, reason, by) => ["--supersede", id, "--reason", reason, "--by", by];

// The re-review's interleaving and its mirror, as two OS processes over one real close.
async function overlappingProcesses() {
  for (const [label, firstArgs, secondArgs] of [
    ["ordinary then repair", (id, by) => closeArgs(id, "process overlap", by), (id) => repairArgs(id, 1)],
    ["repair then ordinary", (id) => repairArgs(id, 1), (id, by) => closeArgs(id, "process overlap", by)],
    ["repair then repair", (id) => repairArgs(id, 1), (id) => repairArgs(id, 1)],
  ]) {
    const ws = workspace();
    const held = gate();
    const entered = gate();
    // Only the first capture is held. A second one is the defect, and holding it too would
    // deadlock the schedule instead of failing the assertions below.
    const server = await mcpServer({ capture: async (n) => { if (n === 1) { entered.open(); await held.opened; } } });
    try {
      const by = newCard();
      const id = newCard();
      sql(closeSql(id, "process overlap", 1, by));
      const before = boardState(id);
      const first = cliProcess(server, ws, firstArgs(id, by));
      await reachedCapture(entered, first, label);
      const second = await cliProcess(server, ws, secondArgs(id, by)).finished;
      assert.equal(second.code, 1, `${label}: the second process refuses: ${second.out.slice(0, 300)}`);
      assert.match(second.out, /SUPERSEDE_HISTORY_BUSY/, label);
      assert.equal(server.requests.capture.length, 1, `${label}: one capture in flight`);
      held.open();
      const done = await first.finished;
      assert.equal(done.code, 0, `${label}: the first finishes: ${done.out.slice(-300)}`);
      assert.equal(server.requests.capture.length, 1, `${label}: one capture`);
      assert.equal(server.requests.verbs, 0, `${label}: zero verbs`);
      assert.equal(boardState(id), before, `${label}: the card did not move`);
      assert.equal(count(ws.tracker(), supersedeMarker(id, 1)), 1, label);
      assert.equal(count(ws.log(), supersedeMarker(id, 1)), 1, label);
      assert.equal(ws.journal(id, 1).state, "complete", label);
      assert.deepEqual(leasesIn(join(ws.dir, "journals")), [], `${label}: released`);
      const replay = await cliProcess(server, ws, repairArgs(id, 1)).finished;
      assert.equal(replay.code, 0);
      assert.match(replay.out, /ALREADY_RECORDED/, label);
      assert.equal(server.requests.capture.length, 1, `${label}: the replay sends nothing`);
    } finally {
      held.open();
      await server.close();
      ws.done();
    }
  }
  console.log("PASS R11: overlapping OS processes over a real close send one capture, zero verbs, unchanged card");
}

// No gate at all: real processes, a real verb and its row lock, whatever order they land.
async function freeRunningProcesses() {
  let refused = 0;
  for (let trial = 0; trial < 6; trial += 1) {
    const ws = workspace();
    const server = await mcpServer();
    try {
      const by = newCard();
      const id = newCard();
      const runs = await Promise.all(Array.from({ length: 3 }, () => cliProcess(server, ws, closeArgs(id, "free running", by)).finished));
      refused += runs.filter((r) => /SUPERSEDE_HISTORY_BUSY/.test(r.out)).length;
      for (const run of runs) assert.ok(run.code === 0 || /SUPERSEDE_HISTORY_BUSY/.test(run.out), `only success or a busy refusal: ${run.out.slice(-300)}`);
      assert.ok(server.requests.verbs <= 1, "at most one process reached the verb");
      assert.ok(server.requests.capture.length <= 1, "at most one capture");
      // Both claimants can withdraw at once; a person running it again is the recovery.
      const after = await cliProcess(server, ws, closeArgs(id, "free running", by)).finished;
      assert.equal(after.code, 0, after.out.slice(-300));
      assert.equal(supersedeEvents(id).length, 1, "one real event");
      assert.equal(server.requests.capture.length, 1, "one capture");
      assert.equal(count(ws.tracker(), supersedeMarker(id, 1)), 1);
      assert.equal(count(ws.log(), supersedeMarker(id, 1)), 1);
      assert.deepEqual(leasesIn(join(ws.dir, "journals")), []);
    } finally {
      await server.close();
      ws.done();
    }
  }
  requireFixture(refused > 0, "any overlap among the free-running processes");
  console.log(`PASS R12: free-running processes on one real generation: one event, one capture (${refused} refusals across 6 trials)`);
}

// The owner dies with its capture in flight: the claim is stale and the send's fate unknown.
async function ownerKilledMidCapture() {
  const ws = workspace();
  const entered = gate();
  const server = await mcpServer({ capture: async (n) => { if (n === 1) { entered.open(); await new Promise(() => {}); } } });
  try {
    const by = newCard();
    const id = newCard();
    sql(closeSql(id, "owner dies", 1, by));
    const first = cliProcess(server, ws, closeArgs(id, "owner dies", by));
    await reachedCapture(entered, first, "owner dies");
    const journals = join(ws.dir, "journals");
    assert.equal(leasesIn(journals).length, 1, "the dead owner's claim is left behind");
    first.child.kill("SIGKILL");
    const killed = await first.finished;
    assert.equal(killed.signal, "SIGKILL");
    assert.equal(leasesIn(journals).length, 1, "still there, nothing cleaned up after a kill");
    assert.equal(ws.journal(id, 1).state, "files-written");

    // The card moves on before the recovery, so recomputing the body would change it. Only
    // the pin keeps these bytes the same.
    sql(`update agent_tasks set title = title || ' (retitled)' where id = '${id}'`);

    const recovered = await cliProcess(server, ws, repairArgs(id, 1)).finished;
    assert.equal(recovered.code, 0, `the recovery must finish (code ${recovered.code}, signal ${recovered.signal}): ${JSON.stringify(recovered.out.slice(-400))}`);
    assert.match(recovered.out, /recovered_leases/, "the recovery says so");
    assert.equal(ws.journal(id, 1).state, "complete");
    assert.deepEqual(leasesIn(journals), []);
    assert.equal(server.requests.capture.length, 2, "at-least-once: whether the first landed is unknown, so it is sent again");
    assert.equal(server.requests.capture[0], server.requests.capture[1], "the same bytes");
    assert.equal(server.rows.size, 1, "so the content-hash rule leaves one row");
    assert.equal(count(ws.tracker(), supersedeMarker(id, 1)), 1);
    assert.equal(count(ws.log(), supersedeMarker(id, 1)), 1);
    console.log("PASS R13: an owner killed mid-capture is recovered; the retry resends identical bytes, one row by content hash");
  } finally {
    await server.close();
    ws.done();
  }
}

// An ordinary close and a later repair with no journal in common. Nothing tells the repair
// the first capture landed, so it sends again. The event, not the command, decides the
// bytes: the file says a repair wrote it, and the capture stays the event's.
async function repairWithoutTheJournal() {
  const ws = workspace();
  const server = await mcpServer();
  try {
    const by = newCard();
    const id = newCard();
    sql(closeSql(id, "no shared journal", 1, by));
    const first = await cliProcess(server, ws, closeArgs(id, "no shared journal", by), join(ws.dir, "journals-a")).finished;
    assert.equal(first.code, 0, first.out.slice(-300));
    writeFileSync(join(ws.dir, "SESSION-LOG.md"), "# Log\n");
    const repair = await cliProcess(server, ws, repairArgs(id, 1), join(ws.dir, "journals-c")).finished;
    assert.equal(repair.code, 0, repair.out.slice(-300));
    assert.match(repair.out, /HISTORY_REPAIRED/);
    assert.equal(server.requests.capture.length, 2, "no shared journal, so it sends again");
    assert.equal(server.requests.capture[0], server.requests.capture[1], "an ordinary close and a repair send one body");
    assert.equal(server.rows.size, 1);
    assert.equal(count(ws.tracker(), supersedeMarker(id, 1)), 1);
    assert.equal(count(ws.log(), supersedeMarker(id, 1)), 1);
    assert.match(ws.log(), /History written later by --repair-supersede/, "the file still says how it was written");
    console.log("PASS R15: a repair with no shared journal sends again, and the event keeps it one body");
  } finally {
    await server.close();
    ws.done();
  }
}

// Two commands on one machine, in different time zones or locales: launchd beside a
// Terminal, say. ps renders a start time in its caller's zone and language, so comparing
// raw strings once read a live owner as a dead one. Held at its first read, before any
// history, and again at its capture, after it.
async function liveOwnerAcrossTimeZones() {
  const places = [
    ["time zone, held at capture", "capture", { TZ: "Asia/Tokyo" }, { TZ: "America/New_York" }],
    ["time zone, held at first read", "read", { TZ: "Asia/Tokyo" }, { TZ: "America/New_York" }],
    ["locale, held at capture", "capture", { LC_ALL: "fr_FR.UTF-8" }, { LC_ALL: "C" }],
    ["locale, held at first read", "read", { LC_ALL: "fr_FR.UTF-8" }, { LC_ALL: "C" }],
  ];
  for (const [label, where, envA, envB] of places) {
    const ws = workspace();
    const held = gate();
    const entered = gate();
    let holdNext = true;
    const hold = async () => {
      if (holdNext) {
        holdNext = false;
        entered.open();
        await held.opened;
      }
    };
    const server = await mcpServer(where === "capture" ? { capture: hold } : { read: hold });
    try {
      const by = newCard();
      const id = newCard();
      sql(closeSql(id, "other time zone", 1, by));
      const journals = join(ws.dir, "journals");
      const first = cliProcess(server, ws, closeArgs(id, "other time zone", by), journals, envA);
      await reachedCapture(entered, first, label);
      const second = await cliProcess(server, ws, repairArgs(id, 1), journals, envB).finished;
      const claimsAtOverlap = leasesIn(journals).length;
      const capturesAtOverlap = server.requests.capture.length;
      held.open();
      const done = await first.finished;
      console.log(`OBSERVED ${label}: ${JSON.stringify({ second: second.code, recoveredLiveOwner: /recovered_leases/.test(second.out), claimsAtOverlap, capturesAtOverlap, first: done.code, leaseLost: /SUPERSEDE_LEASE_LOST/.test(done.out), captures: server.requests.capture.length, trackerMarkers: count(ws.tracker(), supersedeMarker(id, 1)), logMarkers: count(ws.log(), supersedeMarker(id, 1)) })}`);
      assert.equal(second.code, 1, `${label}: the second refuses a live owner: ${JSON.stringify(second.out.slice(-200))}`);
      assert.match(second.out, /SUPERSEDE_HISTORY_BUSY/, label);
      assert.doesNotMatch(second.out, /recovered_leases/, `${label}: and does not call it dead`);
      assert.equal(claimsAtOverlap, 1, `${label}: the owner's claim survives`);
      assert.equal(done.code, 0, `${label}: the owner finishes: ${done.out.slice(-200)}`);
      assert.equal(server.requests.capture.length, 1, `${label}: one capture`);
      assert.equal(count(ws.tracker(), supersedeMarker(id, 1)), 1, label);
      assert.equal(count(ws.log(), supersedeMarker(id, 1)), 1, label);
    } finally {
      held.open();
      await server.close();
      ws.done();
    }
  }
  console.log("PASS R16: a live owner in another time zone or locale is never judged gone");
}

// Commands that do not share a journal directory share no claim. The event is still the
// identity: both send one body. This is the stated limit of the lease, tested rather than implied.
async function separateJournalDirectories() {
  const ws = workspace();
  const held = gate();
  const entered = gate();
  const server = await mcpServer({ capture: async (n) => { if (n === 1) { entered.open(); await held.opened; } } });
  try {
    const by = newCard();
    const id = newCard();
    sql(closeSql(id, "two machines", 1, by));
    const first = cliProcess(server, ws, closeArgs(id, "two machines", by), join(ws.dir, "journals-a"));
    await reachedCapture(entered, first, "two machines");
    const second = await cliProcess(server, ws, closeArgs(id, "two machines", by), join(ws.dir, "journals-b")).finished;
    assert.equal(second.code, 0, `no shared claim, so no refusal: ${second.out.slice(-300)}`);
    const third = await cliProcess(server, ws, repairArgs(id, 1), join(ws.dir, "journals-c")).finished;
    assert.equal(third.code, 0);
    assert.match(third.out, /ALREADY_RECORDED/, "the markers stop a repair whichever directory it uses");
    held.open();
    assert.equal((await first.finished).code, 0);
    assert.equal(server.requests.capture.length, 2, "two sends");
    assert.equal(server.requests.capture[0], server.requests.capture[1], "one body");
    assert.equal(server.rows.size, 1);
    assert.equal(count(ws.tracker(), supersedeMarker(id, 1)), 1);
    console.log("PASS R14: without a shared journal directory there are two sends, and event identity keeps them one body");
  } finally {
    held.open();
    await server.close();
    ws.done();
  }
}

// What the audit and repair must refuse, from real rows.
async function auditAndRepairRefusals() {
  const ws = workspace();
  try {
    const noSlug = newCard();
    sql(`update public.agent_tasks set project_slug = null where id = ${q(noSlug)}; ${closeSql(noSlug, "no route", 1)}`);
    requireFixture(sql(`select project_slug is null from public.agent_tasks where id = ${q(noSlug)};`) === "t", "a superseded card with no project");
    assert.deepEqual((await auditRows(ws, noSlug)).rows.map((r) => [r.severity, r.reason]), [["SUPERSEDE_NO_ROUTE", "MISSING_PROJECT_SLUG"]]);
    const blocked = await repair(ws, noSlug, 1);
    assert.match(String(blocked.error), /MISSING_PROJECT_SLUG/);
    assert.equal(blocked.verbs, 0);

    const missing = newCard();
    sql(closeSql(missing, "only one", 1));
    const none = await repair(ws, missing, 2);
    assert.match(String(none.error), /REPAIR_GENERATION_NOT_FOUND/);

    const broken = newCard();
    sql(closeSql(broken, "broken", 1));
    sql(`update public.agent_task_events set payload = jsonb_set(payload, '{generation}', '"1"') where task_id = ${q(broken)} and event_type = 'TASK SUPERSEDED';`);
    assert.deepEqual((await auditRows(ws, broken)).rows.map((r) => r.severity), ["SUPERSEDE_HISTORY_INVALID"]);
    const refused = await repair(ws, broken, 1);
    assert.match(String(refused.error), /SUPERSEDE_HISTORY_INVALID/);
    assert.equal(count(ws.tracker(), broken), 0);
    console.log("PASS R9: no route, an absent generation and a broken history are held, none written");
  } finally {
    ws.done();
  }
}

try {
  sql("select 1;");
} catch (err) {
  console.log(`no database: ${err.message}`);
  process.exit(2);
}

try {
  await reversedOrder("different reasons", ["reason one", "reason two", "reason three"]);
  await reversedOrder("identical reasons", ["same reason", "same reason", "same reason"]);
  await tiedAfterLostResponse("different reasons", ["reason one", "reason two", "reason three"]);
  await tiedAfterLostResponse("identical reasons", ["same reason", "same reason", "same reason"]);
  await sameTransactionCompletion();
  await repeatedCycles();
  await brokenHistories();
  await journalNamesTheWrongEvent();
  await bareCloseFoundAndRepaired();
  await repairAgainstARealBoard();
  await auditAndRepairRefusals();
  await cappedPacketIsNotClean();
  await overlappingProcesses();
  await freeRunningProcesses();
  await ownerKilledMidCapture();
  await separateJournalDirectories();
  await repairWithoutTheJournal();
  await liveOwnerAcrossTimeZones();
} catch (err) {
  console.log(`FAIL ${String(err?.message || err).split("\n")[0]}`);
  process.exit(1);
}
