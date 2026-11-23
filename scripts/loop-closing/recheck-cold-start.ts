// Loop-closing Task 4.1, cold-start correction: the run loop (runRecheck)
// against the real functions of 20261119c and 20261119ca, called the way
// production calls them: through a login role that carries a role-level
// statement_timeout (PostgREST's `authenticator`) and then SET ROLE
// service_role, over a window sized like production's (9,235 thoughts, 8,116 of
// them inside the oldest item's window).
//
// Run ONLY by recheck-sql-test.sh, against the database "obcold":
//   deno run --no-lock --allow-env --allow-read --allow-run=psql \
//     scripts/loop-closing/recheck-cold-start.ts
//
// WHAT IS REAL AND WHAT IS SIMULATED. Say this wherever a result is quoted.
//   Real:      the two migrations' SQL; the role-level statement_timeout and
//              the 57014 it raises (nothing is injected: PostgreSQL cancels the
//              statement); the run loop; four items at a time; the row counts.
//              With OBRP_PGVECTOR_SQL set, also the vector type and operator
//              (real pgvector, 1536 dimensions). Without it the type is the
//              harness's stand-in domain and the embeddings have 8 dimensions.
//   Simulated: the COLD CACHE. A local disk cannot be made slow, so reading an
//              embedding costs simulated time: the distance operator the plan
//              and the warm-up both use is wrapped by a function that sleeps
//              the first time any session touches one of 93 "pages" (100
//              thoughts each) and never again. The page state lives in
//              sequences, which are shared by all sessions and survive a
//              cancelled statement, as a buffer cache does. The cost per page
//              and the timeout (2 s here, 8 s in production) are chosen so the
//              oldest window costs 1.4 timeouts to read cold: more than one
//              statement can do, as production showed, and little enough that
//              the fifth item passes after four have failed, as production
//              showed. Those two numbers are tuned to production's symptom;
//              they are not measurements of production's disk.
//   So a PASS here says: IF a cold read costs time per embedding first touched
//   and nothing afterwards, the old code fails the way production did and this
//   code does not. Whether production's cache behaves that way is proven only
//   by the cold production dry run.
//
// Exit 0 with "RECHECK COLD START PASSED"; 1 on a failed assertion that ran to
// completion ("FAIL cold: ..."); 2 when the harness itself could not judge
// (NEVER-RAN): a harness query failed, the simulation did not produce a
// timeout, a timing control did not hold (which includes a run of the code
// under test with a call that spent too long outside the database), or this
// machine was too slow for the simulation's margins. A 57014 that the code under test receives from the
// role's timeout is the behavior being judged, not an interruption of the
// harness.
//
// HOW A VERDICT IS REACHED (correction 1, review finding F2). This is the one
// timing-sensitive step of the harness, so:
//   - The machine is calibrated (four warm searches at once, each under a
//     quarter of the timeout) BEFORE anything is judged, again at the moment
//     any check does not hold and BEFORE that check is called a failure, and
//     once more before a pass is declared. A check that does not hold on a
//     machine that no longer calibrates is NEVER-RAN, not FAIL: the slowdown
//     may have begun after the first calibration.
//   - What is asserted about the application is what the DATABASE reports:
//     SQLSTATEs, row counts, the simulated pages a statement first read, the
//     run's own summary and receipt. No assertion compares this client's clock
//     with a margin.
//   - The elapsed times this client measures (spawning psql, connecting, the
//     statement, reading the answer) are TIMING CONTROLS. They are printed. If
//     one is outside its margin the step is NEVER-RAN whatever the calibration
//     then says: it never fails the application and it never passes it.
//
// THE RUN'S OWN TIMINGS ARE JUDGED BEFORE ANY OF ITS CHECKS (correction 2,
// re-review 1). A calibration says how fast the machine is NOW. It does not say
// the run that just ended had the time its checks assume: the warm-up's share
// of the budget is on this client's clock, and which begins the role's timeout
// cancels depends on the four of them reaching the database together. So every
// run of the code under test (A, A2, B, C, the three nights of D) goes through
// one wrapper, and when the run returns, before the scenario reads anything
// from it, the wrapper prints the run's timings and judges them:
//   - TIME A CALL SPENT OUTSIDE THE DATABASE. Each call made as the login role
//     is bracketed, in its own session, by two statements that return the
//     database's clock. On a call that succeeds, the time between them is the
//     database's share; everything else this harness waited for that call is
//     outside it: spawning psql, connecting, a page count the harness reads
//     for itself, a delay. On a call that ends in an SQL error the last stamp
//     is never reached, and the database's share is bounded instead: it cannot
//     be more than the role's statement timeout, and it did not begin before
//     the first stamp.
//   - THIS PROCESS HELD UP. A 50 ms heartbeat runs beside the run; a beat that
//     arrives late says this process did not run for that long (a suspended
//     machine, a starved or blocked event loop), whether or not a call was
//     waiting.
//   - THE MODEL STUB. It answers at once by construction; the time it took is
//     measured all the same.
//   Any of the three over STALL_MAX_MS (an eighth of the timeout, 250 ms), or
//   hold-ups of this process adding up to more than HELD_UP_TOTAL_MAX_MS over
//   the run, and the run is NEVER-RAN: none of its checks is
//   evaluated, so none can be printed as a FAIL, and none can pass. A healthy
//   calibration afterwards changes nothing about that; it is printed and that
//   is all. Code under test cannot produce any of the three except by blocking
//   this process's event loop synchronously for longer than the limit, which
//   is then NEVER-RAN, every run, and has to be looked at.
//   WHY A REAL FAULT IS STILL A COMPLETED FAIL. Time the database itself
//   reports spending on a statement, and time the code under test spends
//   waiting without blocking the event loop, are the application's. They are
//   never grounds for NEVER-RAN when a check fails: a statement that is slow
//   in the database, a cancelled statement, a warm-up that runs out of its
//   share because its statements are slow, all fail their checks as before.
//   What this still cannot rule out: a stall of the database server alone
//   (this process and its calls unaffected) that lasts long enough to cancel a
//   statement or to use up a budget and is gone when the failed check is
//   calibrated. The database reports that time as statement time, the harness
//   attributes it to the application, and the run is a completed FAIL that is
//   wrong. It is a rerun. The timings line of that run, printed before the
//   FAIL, is where it would show.
//
// OBRP_RECHECK_SRC_DIR=<dir holding another _recheck.ts> runs the same
// scenarios against that copy (the code as it was before the correction, or a
// mutant). OBRP_COLD_KEEP_GOING=1 prints every observation and every failed
// check instead of stopping at the first, and still exits 1.

const PORT = Deno.env.get("OBRP_PG_PORT");
const DB = Deno.env.get("OBRP_PG_DB") ?? "obcold";
const say = console.log;
if (!PORT) {
  say("NEVER-RAN: OBRP_PG_PORT is not set (run me from recheck-sql-test.sh)");
  Deno.exit(2);
}
const INTERRUPTION_PREFIXES = (Deno.env.get("OBRP_INTERRUPTION_PREFIXES") ?? "").split(" ").filter(Boolean);
if (INTERRUPTION_PREFIXES.length === 0) {
  say("NEVER-RAN: OBRP_INTERRUPTION_PREFIXES is not set (run me from recheck-sql-test.sh)");
  Deno.exit(2);
}
const KEEP_GOING = Deno.env.get("OBRP_COLD_KEEP_GOING") === "1";
// Negative controls for THIS step's verdicts (recheck-harness-selftest.sh):
//   cold_no_timeout    the role's timeout is a minute, so the simulated cold read fits: NEVER-RAN
//   cold_slow_machine  the calibration limit is 0 ms, so the machine is "too slow": NEVER-RAN
//   cold_assert_fail   a check that runs to completion and does not hold, on a machine
//                      that calibrates: a completed FAIL (after the calibration)
// One stall inside a run of the unmodified application, on this side of the
// connection (correction 2). None may end as a FAIL; each must be NEVER-RAN at
// the run's own timings, before any check of that run:
//   cold_stall_one_call_a     the 17th warm-up call of A is delayed by 41 s: the warm-up
//                             runs out of its 40 s share half-way (the reviewer's case)
//   cold_stall_one_call_c     the first begin of C is delayed by SLOWDOWN_MS: it misses
//                             the timeout the other three get
//   cold_stall_one_call_d     the same on night 1 of D
//   cold_stall_harness_read   in A, the harness's own page count inside one call is delayed
//                             by SLOWDOWN_MS: no psql call of the run is slow
//   cold_stall_process        in A, this process is blocked for SLOWDOWN_MS between two
//                             calls: no call is slow at all
//   cold_stall_process_many   in A, this process is blocked for 200 ms before each of
//                             30 calls: no call is slow and no single hold-up is over
//                             the limit, 6 s in all
//   cold_stall_model_stub     in A, the model stub takes SLOWDOWN_MS once
// A slowdown that starts AFTER the first calibration (every call made as the
// login role is delayed by SLOWDOWN_MS on this side of the connection; the
// application, the migrations and the timeout are untouched):
//   cold_late_slowdown              from just after the first calibration: NEVER-RAN
//   cold_late_slowdown_assert_fail  the same, then a check that does not hold: NEVER-RAN, not FAIL
//   cold_slowdown_from_a            from just before scenario A, after the controls held: NEVER-RAN
//   cold_spike_at_control           one delayed call only, the lone-plan control; the machine
//                                   calibrates again straight after: NEVER-RAN (a timing control)
const INJECT = Deno.env.get("OBRP_INJECT") ?? "";
const SLOWDOWN_MS = 1600;

// The simulation's numbers. TIMEOUT_MS is the role-level statement_timeout.
const TIMEOUT_MS = INJECT === "cold_no_timeout" ? 60_000 : 2000;
// One stall long enough to use up the warm-up's 40 s share of the default budget.
const LONG_STALL_MS = 41_000;
// The most ONE call of a run may spend outside the database, the longest this
// process may be held up at a time during a run, and the longest the model stub
// may take, before the run is not judged: an eighth of the timeout. What it has
// to stay under. (1) In C and on the nights of D the verdict depends on four
// begins reaching the database together. Measured with this harness on the
// stand-in type (the evidence of correction 2): one begin of C that arrives
// 0.9 s after the other three changes nothing; one that arrives 1.2 s after
// them is no longer cancelled with them, and the verdict changes. Night 1 of D
// turns between 1.2 s and 1.6 s. A worker makes two calls on the way to its
// begin and a hold-up of this process can fall between them, so three delays
// just inside the limit move a begin by 0.75 s. (2) The warm-up has a 40 s
// share; A2, the tightest, uses about 15 s of it, and 33 warm-up calls each
// just inside the limit add 8.25 s.
const STALL_MAX_MS = TIMEOUT_MS / 8;
// Hold-ups of this process are not tied to a call, so many short ones could add
// up with none over the limit. All of a run's hold-ups together may not exceed
// this; with the 8.25 s above it still leaves A2 inside its share.
const HELD_UP_TOTAL_MAX_MS = 5000;
const THOUGHTS = 9235;
const WINDOW = 8116; // thoughts newer than every item
const PAGE_ROWS = 100; // thoughts per simulated page
const WINDOW_PAGES = 82; // pages 11..92 hold the window
const COST_NORMAL_MS = 34; // per page first touched: 82 pages = 2.8 s = 1.4 timeouts
const COST_HEAVY_MS = 61; // 82 pages = 5.0 s = 2.5 timeouts: two tries of one statement are not enough
const COST_SIX_TIMEOUTS_MS = 150; // 82 pages = 12.3 s = 6 timeouts; one chunk of 250 rows is at most 4 pages = 0.6 s
const CALIBRATION_MAX_MS = INJECT === "cold_slow_machine" ? 0 : TIMEOUT_MS / 4;
const LAST_PAGE = Math.floor((THOUGHTS - 1) / PAGE_ROWS);

const logs: string[] = [];
console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
console.error = (...a: unknown[]) => { logs.push("ERR " + a.map(String).join(" ")); };
console.warn = (...a: unknown[]) => { logs.push("WARN " + a.map(String).join(" ")); };

const neverRan: string[] = [];
class NeverRan extends Error {
  constructor(message: string) {
    super(message);
    neverRan.push(message);
  }
}
function bail(): never {
  say(`NEVER-RAN: ${neverRan[0]}`);
  Deno.exit(2);
}

// ---------- the code under test ----------
// A file URL built by hand: this checkout's path may hold spaces.
const fileUrl = (path: string) => "file://" + path.split("/").map(encodeURIComponent).join("/");
const srcDir = Deno.env.get("OBRP_RECHECK_SRC_DIR");
const moduleUrl = srcDir
  ? fileUrl(srcDir.replace(/\/+$/, "") + "/_recheck.ts")
  : new URL("../../supabase/functions/action-item-recheck/_recheck.ts", import.meta.url).href;
// deno-lint-ignore no-explicit-any
type Summary = any;
type RunOptions = { dryRun: boolean; limit?: number; budgetMs?: number; now?: () => number; log?: (l: string) => void };
type Llm = (m: Array<{ role: string; content: string }>) => Promise<string>;
// The code under test. The scenarios call it only through runRecheck below.
let runRecheckUnderTest: (db: unknown, llm: Llm, o: RunOptions) => Promise<Summary>;
try {
  runRecheckUnderTest = (await import(moduleUrl)).runRecheck;
} catch (e) {
  say(`NEVER-RAN: the run loop could not be loaded from ${srcDir ?? "this checkout"}: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
  Deno.exit(2);
}

// ---------- psql ----------
// The injected slowdown (negative controls only): a delay on this side of the
// connection before a call made as the login role, inside the time measured.
let slowdown = false;
let spikeOnce = false;
let spikeMs = SLOWDOWN_MS;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The database's clock in epoch milliseconds. A session opened as the login
// role runs it first and last, as statements of their own, so the call under
// test is still one statement, under the role's timeout, exactly as it was.
const DB_CLOCK = "select (extract(epoch from clock_timestamp()) * 1000)::bigint";
type PsqlResult = {
  code: number; out: string; err: string;
  ms: number; // on this client's clock: any injected delay, psql, the connection, the statements, the answer
  dbFirstMs: number | null; // the database's clock when the session's first statement ran
  dbMs: number | null; // the database's clock from the session's first statement to its last; null when the last was not reached
};
async function psql(user: string, statements: string[]): Promise<PsqlResult> {
  const t0 = performance.now();
  if (user === "authenticator" && (slowdown || spikeOnce)) {
    const ms = spikeOnce ? spikeMs : SLOWDOWN_MS;
    spikeOnce = false;
    spikeMs = SLOWDOWN_MS;
    await pause(ms);
  }
  const bracketed = user === "authenticator";
  const all = bracketed ? [DB_CLOCK, ...statements, DB_CLOCK] : statements;
  const cmd = new Deno.Command("psql", {
    args: ["-h", "127.0.0.1", "-p", PORT!, "-U", user, "-d", DB, "-X", "-q", "-A", "-t",
      "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", ...all.flatMap((s) => ["-c", s])],
    stdout: "piped", stderr: "piped",
  });
  const r = await cmd.output();
  const ms = performance.now() - t0;
  let out = new TextDecoder().decode(r.stdout);
  let dbFirstMs: number | null = null;
  let dbMs: number | null = null;
  if (bracketed) {
    // The two stamps are taken off the output; what a caller reads is what the
    // statements it passed printed.
    const lines = out.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const isStamp = (l: string | undefined) => l !== undefined && /^\d{13}$/.test(l);
    if (isStamp(lines[0])) dbFirstMs = Number(lines.shift());
    if (r.code === 0 && dbFirstMs !== null && lines.length > 0 && isStamp(lines[lines.length - 1])) dbMs = Number(lines.pop()) - dbFirstMs;
    out = lines.map((l) => l + "\n").join("");
  }
  return { code: r.code, out, err: new TextDecoder().decode(r.stderr), ms, dbFirstMs, dbMs };
}
// The harness's own reads and fixture writes: superuser, no statement timeout.
async function sql(query: string): Promise<string> {
  const r = await psql("postgres", [query]);
  if (r.code !== 0) throw new NeverRan(`harness query failed (psql exit ${r.code}): ${r.err.trim().slice(0, 300)}`);
  return r.out.replace(/\n$/, "");
}
function quote(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}
const JSONB_ARGS = new Set(["p_rows", "p_summary"]);
const UUID_ARRAY_ARGS = new Set(["p_embedding_ids", "p_item_ids"]);
function lit(key: string, v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (JSONB_ARGS.has(key)) return `${quote(JSON.stringify(v))}::jsonb`;
  if (UUID_ARRAY_ARGS.has(key)) {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new NeverRan(`${key} is not a list of strings`);
    return `${quote("{" + v.join(",") + "}")}::uuid[]`;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return quote(v);
  throw new NeverRan(`unsupported value for ${key}: ${JSON.stringify(v).slice(0, 80)}`);
}
const TABLE_FNS = new Set([
  "recheck_eligible_items", "recheck_source_embedding", "recheck_plan_scan", "recheck_begin_scan",
  "recheck_candidates", "recheck_commit_page", "recheck_warm_embeddings",
]);
const SCALAR_FNS = new Set(["recheck_client_names", "recheck_record_run", "recheck_note_error"]);
const WRITE_FNS = ["recheck_begin_scan", "recheck_commit_page", "recheck_record_run", "recheck_note_error"];

type Call = {
  fn: string; args: Record<string, unknown>; ms: number; code: string | null; data: unknown; firstRead?: number;
  wallMs: number; // everything the code under test waited for this call, on this client's clock
  dbMs: number | null; // the database's share by its own clock; null when the call ended in an SQL error
  outsideMs: number; // wallMs less the database's share (on an SQL error: the least it can have been)
};
let rpcLog: Call[] = [];
// Which run of the code under test is going on ("" between runs).
let scenario = "";
let stallFired = false;
// One injected stall, at one named point of one run (negative controls only).
const stallNow = (name: string, run: string, at: boolean): boolean => {
  if (INJECT !== name || scenario !== run || stallFired || !at) return false;
  stallFired = true;
  return true;
};
const callsSoFar = (fn: string) => rpcLog.filter((c) => c.fn === fn).length;
// Set to the number of simulated pages in cache to have every warm-up statement
// record how many pages IT first read (counted in the database, not timed).
let pagesBeforeWarm: number | null = null;
// Called once, when the first plan or begin of a run arrives.
let onFirstBegin: (() => Promise<void>) | null = null;

// One RPC as production makes it: log in as `authenticator` (statement_timeout
// from the role), SET ROLE service_role, call the function by argument name.
async function bridgeRpc(fn: string, args: Record<string, unknown>) {
  if (!TABLE_FNS.has(fn) && !SCALAR_FNS.has(fn)) throw new NeverRan(`unbridged rpc ${fn}`);
  // This process held up between two calls: a synchronous wait, so nothing here runs.
  if (stallNow("cold_stall_process", "A", fn === "recheck_warm_embeddings" && callsSoFar(fn) === 5)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SLOWDOWN_MS);
  }
  if (INJECT === "cold_stall_process_many" && scenario === "A" && fn === "recheck_warm_embeddings" && callsSoFar(fn) < 30) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  const w0 = performance.now();
  const w0Epoch = Date.now();
  if (stallNow("cold_stall_one_call_a", "A", fn === "recheck_warm_embeddings" && callsSoFar(fn) === 16)) {
    spikeOnce = true;
    spikeMs = LONG_STALL_MS;
  }
  if (stallNow("cold_stall_one_call_c", "C", fn === "recheck_begin_scan") || stallNow("cold_stall_one_call_d", "D night 1", fn === "recheck_begin_scan")) spikeOnce = true;
  if ((fn === "recheck_plan_scan" || fn === "recheck_begin_scan") && onFirstBegin) {
    const hook = onFirstBegin;
    onFirstBegin = null;
    await hook();
  }
  const named = Object.entries(args).map(([k, v]) => {
    if (!/^[a-z_]+$/.test(k)) throw new NeverRan(`unexpected rpc argument name ${k}`);
    return `${k} => ${lit(k, v)}`;
  }).join(", ");
  const query = TABLE_FNS.has(fn)
    ? `select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)::text from public.${fn}(${named}) x`
    : `select to_jsonb(public.${fn}(${named}))::text`;
  const r = await psql("authenticator", ["set role service_role", query]);
  let firstRead: number | undefined;
  if (fn === "recheck_warm_embeddings" && pagesBeforeWarm !== null) {
    const now = (await warmPages()).length;
    firstRead = now - pagesBeforeWarm;
    pagesBeforeWarm = now;
    if (stallNow("cold_stall_harness_read", "A", callsSoFar(fn) === 4)) await pause(SLOWDOWN_MS);
  }
  // Everything the code under test waited for this call. On success the
  // database's share is what its own clock says. On an SQL error it is not
  // known, but it began no earlier than the first stamp and lasted no longer
  // than the role's timeout, so the time outside it was at least the larger of
  // the two remainders.
  const wallMs = performance.now() - w0;
  if (r.code === 0) {
    if (r.dbMs === null) throw new NeverRan(`rpc ${fn} succeeded without the database's two clock readings, so its time outside the database is not known`);
    const data = JSON.parse(r.out.trim());
    rpcLog.push({ fn, args, ms: r.ms, code: null, data, firstRead, wallMs, dbMs: r.dbMs, outsideMs: Math.max(0, wallMs - r.dbMs) });
    return { data, error: null };
  }
  const outsideAtLeast = Math.max(0, wallMs - TIMEOUT_MS, r.dbFirstMs === null ? 0 : r.dbFirstMs - w0Epoch);
  if (r.code === 1 || r.code === 3) {
    const m = /ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/.exec(r.err);
    if (!m) throw new NeverRan(`rpc ${fn} failed with no readable SQLSTATE (psql exit ${r.code}): ${r.err.trim().slice(0, 300)}`);
    // The role's statement timeout is what this harness is about: it goes to
    // the code under test, as PostgREST would hand it over. Every other
    // interruption means nothing can be judged.
    if (m[1] !== "57014" && INTERRUPTION_PREFIXES.some((p) => m[1].startsWith(p))) {
      throw new NeverRan(`rpc ${fn} was interrupted (SQLSTATE ${m[1]}: ${m[2].slice(0, 200)}); nothing is judged on it`);
    }
    rpcLog.push({ fn, args, ms: r.ms, code: m[1], data: null, firstRead, wallMs, dbMs: null, outsideMs: outsideAtLeast });
    return { data: null, error: { code: m[1], message: m[2] } };
  }
  throw new NeverRan(`rpc ${fn} could not execute (psql exit ${r.code}): ${r.err.trim().slice(0, 300)}`);
}
const db = { rpc: (fn: string, args: Record<string, unknown>) => bridgeRpc(fn, args) };

// ---------- assertions ----------
let passed = 0;
let failed = 0;
// A check that does not hold is not a failure yet. The machine is measured
// first (calibrate throws NEVER-RAN when it is too slow, and the step then ends
// with exit 2). Only on a machine that calibrates is the check a completed FAIL.
async function check(name: string, cond: boolean, detail = ""): Promise<void> {
  if (neverRan.length > 0) bail();
  if (!cond) {
    const text = `${name}${detail ? `: ${detail.replace(/\s+/g, " ").slice(0, 500)}` : ""}`;
    say(`COLD a check did not hold; the machine is calibrated before that is a verdict: ${text.slice(0, 300)}`);
    await calibrate("after a check did not hold");
    say(`FAIL cold: ${text}`);
    failed += 1;
    if (!KEEP_GOING) Deno.exit(1);
    return;
  }
  passed += 1;
  say(`PASS K ${name}`);
}
async function eq(name: string, got: unknown, want: unknown): Promise<void> {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  await check(name, g === w, `got ${g}, want ${w}`);
}
// A margin on a time THIS CLIENT measured. It says whether the run was inside
// what the simulation assumes; it is not a check of the application, so it can
// end the step only as NEVER-RAN. It does not say what the cause was.
// `applies` is what the DATABASE must have reported for the margin to mean
// anything (for example: the statement was cancelled by the timeout; every page
// was in cache). Those facts are asserted by checks of their own. Where one did
// not hold (seen only with OBRP_COLD_KEEP_GOING=1, since a failed check ends the
// step otherwise) the time is the application's doing, the check has already
// said so, and the control is skipped.
async function timingControl(name: string, applies: boolean, held: boolean, detail: string): Promise<void> {
  if (neverRan.length > 0) bail();
  if (!applies) {
    say(`COLD timing control skipped (the check it depends on did not hold): ${name}: ${detail}`);
    return;
  }
  if (held) {
    say(`COLD timing control held: ${name}: ${detail}`);
    return;
  }
  say(`COLD timing control did NOT hold: ${name}: ${detail}`);
  await calibrate("after a timing control did not hold");
  throw new NeverRan(`timing control: ${name}: ${detail}. Nothing is judged. That the machine calibrates inside its limit now does not say what the cause was, and this harness does not name one. A step that ends this way on every rerun has to be investigated; it is not a pass`);
}

// ---------- a run of the code under test, and its timings ----------
// The heartbeat: how late the latest beat was says how long this process did
// not run. Only what happens during a run is kept.
const BEAT_MS = 50;
let running = false;
let lastBeat = performance.now();
let worstBeatMs = 0;
let heldUpTotalMs = 0;
let worstStubMs = 0;
const beat = () => {
  const t = performance.now();
  const late = t - lastBeat - BEAT_MS;
  if (running) worstBeatMs = Math.max(worstBeatMs, late);
  // Ordinary timer jitter (a beat a few milliseconds late) is not a hold-up.
  if (running && late > BEAT_MS / 2) heldUpTotalMs += late;
  lastBeat = t;
};
setInterval(beat, BEAT_MS);
const RUNS = ["A", "A2", "B", "C", "D night 1", "D night 2", "D night 3"];
let runsDone = 0;
// Every scenario runs the code under test through this. It returns only when
// the run's timings have been printed and judged, so no check of a scenario
// can be evaluated, and no FAIL printed, on a run whose timings are out of
// margin. There is no other way to the code under test in this file.
async function runRecheck(dbArg: unknown, llmArg: Llm, o: RunOptions): Promise<Summary> {
  scenario = RUNS[runsDone] ?? `run ${runsDone + 1}`;
  runsDone += 1;
  const first = rpcLog.length;
  const timedLlm: Llm = async (m) => {
    const t = performance.now();
    try {
      if (stallNow("cold_stall_model_stub", "A", true)) await pause(SLOWDOWN_MS);
      return await llmArg(m);
    } finally {
      worstStubMs = Math.max(worstStubMs, performance.now() - t);
    }
  };
  worstBeatMs = 0;
  heldUpTotalMs = 0;
  worstStubMs = 0;
  lastBeat = performance.now();
  running = true;
  const t0 = performance.now();
  let s: Summary;
  try {
    s = await runRecheckUnderTest(dbArg, timedLlm, o);
  } finally {
    beat();
    running = false;
  }
  const label = scenario;
  scenario = "";
  await judgeTimings(label, o, performance.now() - t0, rpcLog.slice(first));
  return s;
}
// Calls are logged as they RETURN, so among calls made at once "call N" is the Nth to come back.
const ordinal = (calls: Call[], c: Call) => calls.filter((x) => x.fn === c.fn).indexOf(c) + 1;
const describeCall = (calls: Call[], c: Call) =>
  c.code === null
    ? `${c.fn} (call ${ordinal(calls, c)} of it) spent ${Math.round(c.outsideMs)} ms outside the database: ${Math.round(c.wallMs)} ms on this client's clock, ${c.dbMs} ms in the database by the database's clock`
    : `${c.fn} (call ${ordinal(calls, c)} of it, ended with SQLSTATE ${c.code}) spent at least ${Math.round(c.outsideMs)} ms outside the database: ${Math.round(c.wallMs)} ms on this client's clock, of which the database can account for at most the role's ${TIMEOUT_MS} ms`;
async function judgeTimings(label: string, o: RunOptions, runMs: number, calls: Call[]): Promise<void> {
  if (neverRan.length > 0) bail();
  const slowest: Record<string, number> = {};
  for (const c of calls) slowest[c.fn] = Math.max(slowest[c.fn] ?? 0, Math.round(c.ms));
  const mostOutside = calls.reduce<Call | null>((a, c) => (a === null || c.outsideMs > a.outsideMs ? c : a), null);
  say(`COLD timings of ${label} (${o.dryRun ? "dry run" : "real run"}, limit ${o.limit}), printed before any of its checks: ${JSON.stringify({
    run_ms: Math.round(runMs), calls: calls.length, cancelled_by_the_role_timeout: calls.filter((c) => c.code === "57014").length,
    slowest_call_ms_by_function_on_this_clients_clock: slowest,
    most_time_outside_the_database: mostOutside === null ? null
      : { fn: mostOutside.fn, call: ordinal(calls, mostOutside), outside_ms: Math.round(mostOutside.outsideMs), client_ms: Math.round(mostOutside.wallMs), database_ms: mostOutside.dbMs },
    longest_this_process_was_held_up_ms: Math.round(worstBeatMs), slowest_model_stub_ms: Math.round(worstStubMs), limit_for_each_ms: STALL_MAX_MS,
    this_process_held_up_in_all_ms: Math.round(heldUpTotalMs), limit_in_all_ms: HELD_UP_TOTAL_MAX_MS,
  })}`);
  const out: string[] = calls.filter((c) => c.outsideMs > STALL_MAX_MS).map((c) => describeCall(calls, c));
  if (worstBeatMs > STALL_MAX_MS) out.push(`this process was held up for ${Math.round(worstBeatMs)} ms (a heartbeat of ${BEAT_MS} ms arrived that late)`);
  if (heldUpTotalMs > HELD_UP_TOTAL_MAX_MS) out.push(`this process was held up for ${Math.round(heldUpTotalMs)} ms in all, over ${HELD_UP_TOTAL_MAX_MS} ms (the heartbeat's late beats added up)`);
  if (worstStubMs > STALL_MAX_MS) out.push(`the model stub, which answers at once, took ${Math.round(worstStubMs)} ms`);
  await timingControl(`${label}: no call of the run spent more than ${STALL_MAX_MS} ms outside the database, this process was never held up for longer than that at a time or ${HELD_UP_TOTAL_MAX_MS} ms in all, and the model stub answered at once`,
    true, out.length === 0,
    out.length === 0 ? `the most was ${mostOutside === null ? 0 : Math.round(mostOutside.outsideMs)} ms outside the database, ${Math.round(worstBeatMs)} ms held up at a time and ${Math.round(heldUpTotalMs)} ms in all, ${Math.round(worstStubMs)} ms in the stub`
      : `${out.length} out of margin: ${out.slice(0, 4).join("; ")}${out.length > 4 ? `; and ${out.length - 4} more` : ""}`);
}
const observe = (label: string, o: unknown) => say(`COLD observed ${label}: ${JSON.stringify(o)}`);

// ---------- fixtures and the cold-cache simulation ----------
const itemId = (k: number) => `c01d${String(k).padStart(4, "0")}-0000-4000-8000-000000000000`;
const items = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => itemId(from + i));
const short = (id: string) => id.slice(0, 8);

const llm = () => Promise.resolve('{"verdict":"open","thought_id":null,"quote":null}');

async function setup(): Promise<{ real: boolean; dims: number }> {
  const real = (await sql(`select exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typname = 'vector' and n.nspname = 'extensions')::text`)) === "true";
  const dims = real ? 1536 : 8;
  // The login role PostgREST uses, with a role-level statement timeout.
  await sql(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
  end $$;
  grant service_role to authenticator;
  alter role authenticator set statement_timeout = '${TIMEOUT_MS}ms';`);
  // The thoughts: 1,119 older than every item, 8,116 newer, five minutes apart.
  // The first component of each embedding is its simulated page number.
  const vec = real
    ? `(array[((g - 1) / ${PAGE_ROWS})::real] || array(select (random() - 0.5)::real from generate_series(1, ${dims - 1}) where g = g))::real[]::extensions.vector`
    : `(array[((g - 1) / ${PAGE_ROWS})::float8] || array(select random() - 0.5 from generate_series(1, ${dims - 1}) where g = g))`;
  await sql(`select setseed(0.42);
    insert into public.thoughts (id, created_at, content, embedding, metadata)
    select (lpad(to_hex(g), 8, '0') || '-0000-4000-8000-00000000c01d')::uuid,
           date_trunc('second', now()) - interval '30 days' + (g - 1120) * interval '5 minutes' + interval '123456 microseconds',
           'cold note ' || g, ${vec}, '{}'::jsonb
    from generate_series(1, ${THOUGHTS}) g;
    analyze public.thoughts;`);
  // Twenty never-re-checked items, ten seconds apart, all between thought 1119
  // and thought 1120; item k's source is thought k. No candidate shares
  // metadata with a source, so a scan's only candidates are its frozen five.
  await sql(`update public.thoughts set metadata = jsonb_build_object('project', 'cold-' || ('x' || left(id::text, 8))::bit(32)::int)
      where ('x' || left(id::text, 8))::bit(32)::int <= 20;
    insert into public.action_items (id, description, status, source_thought_id, created_at)
    select ('c01d' || lpad(k::text, 4, '0') || '-0000-4000-8000-000000000000')::uuid, 'cold item ' || k, 'open',
           (lpad(to_hex(k), 8, '0') || '-0000-4000-8000-00000000c01d')::uuid,
           date_trunc('second', now()) - interval '30 days' - interval '4 minutes' + k * interval '10 seconds'
    from generate_series(1, 20) k;`);
  // The simulated cache: one sequence per page (never called = cold), and the
  // cost in milliseconds of a first touch.
  await sql(`create schema obt_cold;
    create sequence obt_cold.cost;
    do $$ begin for k in 0..${LAST_PAGE} loop execute format('create sequence obt_cold.b%s', k); end loop; end $$;
    grant usage on schema obt_cold to service_role;
    grant usage, select, update on all sequences in schema obt_cold to service_role;`);
  const touch = `
      s regclass := ('obt_cold.b' || PAGE_EXPR)::regclass;
    begin
      if pg_sequence_last_value(s) is null then
        perform pg_sleep(pg_sequence_last_value('obt_cold.cost'::regclass) / 1000.0);
        perform nextval(s);
      end if;`;
  if (real) {
    // public is ahead of extensions on the functions' search_path, so this
    // operator is the one match_thoughts_bounded and the warm-up resolve.
    await sql(`create function public.obt_cold_distance(a extensions.vector, b extensions.vector) returns float8
      language plpgsql volatile strict as $f$ declare ${touch.replace("PAGE_EXPR", "((a::real[])[1])::integer")}
        return a operator(extensions.<=>) b;
      end $f$;
      create operator public.<=> (leftarg = extensions.vector, rightarg = extensions.vector, function = public.obt_cold_distance);
      grant execute on function public.obt_cold_distance(extensions.vector, extensions.vector) to service_role;`);
  } else {
    await sql(`create function public.obt_raw_distance(a float8[], b float8[]) returns float8
      language sql immutable strict as $f$
        select 1 - (sum(x * y) / nullif(sqrt(sum(x * x)) * sqrt(sum(y * y)), 0)) from unnest(a, b) as t(x, y)
      $f$;
      create or replace function public.obt_cosine_distance(a float8[], b float8[]) returns float8
      language plpgsql volatile strict as $f$ declare ${touch.replace("PAGE_EXPR", "(a[1])::integer")}
        return public.obt_raw_distance(a, b);
      end $f$;`);
  }
  return { real, dims };
}
const setCold = async (costMs: number) => {
  await sql(`do $$ begin for k in 0..${LAST_PAGE} loop execute format('alter sequence obt_cold.b%s restart', k); end loop; end $$;
    select setval('obt_cold.cost', ${costMs});`);
};
const setWarm = () => sql(`select count(nextval(('obt_cold.b' || k)::regclass)) from generate_series(0, ${LAST_PAGE}) k`);
// The simulated pages that have been read.
const warmPages = async (): Promise<number[]> =>
  (await sql(`select coalesce(string_agg(k::text, ',' order by k), '') from generate_series(0, ${LAST_PAGE}) k
     where pg_sequence_last_value(('obt_cold.b' || k)::regclass) is not null`)).split(",").filter(Boolean).map(Number);
const windowPagesWarm = async () => (await warmPages()).filter((p) => p >= 11).length;
const stateHash = () =>
  sql(`select md5(coalesce((select string_agg(to_jsonb(a)::text, '' order by a.id) from public.action_items a), '')
        || coalesce((select string_agg(to_jsonb(d)::text, '' order by d.id) from public.auto_resolve_decisions d), '')
        || coalesce((select string_agg(to_jsonb(r)::text, '' order by r.id) from public.action_item_recheck_runs r), ''))`);
// The exact top five of an item's window, computed directly on the table with
// the true distance (not through the wrapper, not through any function under test).
const bruteForce = async (id: string, real: boolean): Promise<string[]> =>
  (await sql(`select coalesce(string_agg(x.id::text, ',' order by x.id), '') from (
      select t.id from public.thoughts t, public.action_items a, public.thoughts q
      where a.id = ${quote(id)} and q.id = a.source_thought_id and t.embedding is not null
        and (t.created_at, t.id) > (coalesce(a.recheck_cursor_at, a.created_at), coalesce(a.recheck_cursor_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
      order by ${real ? "t.embedding operator(extensions.<=>) q.embedding" : "public.obt_raw_distance(t.embedding, q.embedding)"}, t.created_at, t.id
      limit 5) x`)).split(",").filter(Boolean);
const sortedIds = (v: unknown): string[] => (Array.isArray(v) ? [...v as string[]].sort() : []);
const stamped = async (ids: string[]) =>
  (await sql(`select coalesce(string_agg(left(id::text, 8), ' ' order by id), '') from public.action_items where recheck_last_error_at is not null and id = any(${quote("{" + ids.join(",") + "}")}::uuid[])`)).split(" ").filter(Boolean);
const rechecked = async (ids: string[]) =>
  Number(await sql(`select count(*) from public.action_items where last_rechecked_at is not null and recheck_scan_id is null and id = any(${quote("{" + ids.join(",") + "}")}::uuid[])`));

// A clock that lets no warm-up run: the first reading is real, every later one
// is 500,000 ms ahead. Against a budget of 1,000,000 ms that is past the
// warm-up's share (400,000) and well inside the run's.
const noWarmClock = () => {
  let readings = 0;
  return () => Date.now() + (readings++ === 0 ? 0 : 500_000);
};
const timeouts = () => rpcLog.filter((c) => c.code === "57014");
const beginsOf = (fn: string) => rpcLog.filter((c) => c.fn === fn);
const processed = () => [...new Set(rpcLog.filter((c) => c.fn === "recheck_source_embedding").map((c) => short(String(c.args.p_item_id))))].sort();
const shape = (s: Summary) => ({
  status: s.status, eligible: s.items_eligible, final: s.items_final, errored: s.items_errored, errors: s.errors,
  warmup: s.warmup ? { chunks: s.warmup.chunks, rows: s.warmup.rows, complete: s.warmup.complete, stopped: s.warmup.stopped, error: s.warmup.error, ms: Math.round(s.warmup.ms) } : "(this code has no warm-up)",
  timeout_retries: s.timeout_retries ?? "(this code has no retry)", items_error_noted: s.items_error_noted ?? "(this code has no error stamp)",
  statements_cancelled_by_the_role_timeout: timeouts().map((c) => `${c.fn}:${short(String(c.args.p_item_id ?? ""))}:${Math.round(c.ms)}ms`),
});

// Four plans at once with everything warm: the machine's own speed, with no
// simulated cost. Too slow, and a timeout here would be the machine's, not the
// simulation's: then nothing is judged.
// It leaves the simulated cache as it found it, so it can run between checks.
async function calibrate(label: string): Promise<void> {
  const before = await warmPages();
  try {
    await calibrateWarm(label);
  } finally {
    if (neverRan.length === 0) {
      await sql(`do $$ begin for k in 0..${LAST_PAGE} loop
          if not (k = any(${quote("{" + before.join(",") + "}")}::int[])) then execute format('alter sequence obt_cold.b%s restart', k); end if;
        end loop; end $$`);
    }
  }
}
async function calibrateWarm(label: string): Promise<void> {
  await setWarm();
  // The bounded search itself over every thought, whatever state the items are in.
  const q = JSON.parse(await sql(`select to_jsonb(embedding::text)::text from public.thoughts where id = '00000001-0000-4000-8000-00000000c01d'`)) as string;
  const rs = await Promise.all([1, 2, 3, 4].map(() =>
    psql("authenticator", ["set role service_role",
      `select count(*) from public.match_thoughts_bounded(query_embedding => ${quote(q)}, p_lower_at => '-infinity', p_lower_id => null, p_upper_at => 'infinity', p_upper_id => 'ffffffff-ffff-ffff-ffff-ffffffffffff', match_count => 5)`])));
  const worst = Math.max(...rs.map((r) => r.ms));
  if (rs.some((r) => r.code !== 0)) throw new NeverRan(`calibration (${label}): a warm search failed: ${rs.find((r) => r.code !== 0)!.err.trim().slice(0, 200)}`);
  say(`COLD calibration (${label}): four warm searches of all ${THOUGHTS} thoughts at once, slowest ${Math.round(worst)} ms; the limit for judging is ${CALIBRATION_MAX_MS} ms, the role's timeout ${TIMEOUT_MS} ms`);
  if (worst > CALIBRATION_MAX_MS) {
    throw new NeverRan(`calibration (${label}): a WARM search took ${Math.round(worst)} ms, over ${CALIBRATION_MAX_MS} ms; this machine is too slow right now for the simulation's margins, so a timeout would not mean what the checks say it means`);
  }
}

try {
  const { real, dims } = await setup();
  say(`COLD vector type: ${real ? "REAL pgvector (schema extensions), 1536 dimensions" : "STAND-IN domain over float8[], 8 dimensions"}; the cold cache is SIMULATED in both`);
  const counts = await sql(`select (select count(*) from public.thoughts where embedding is not null) || '|' ||
      (select count(*) from public.thoughts t where t.embedding is not null and t.created_at > (select max(created_at) from public.action_items where id::text like 'c01d%')) || '|' ||
      (select count(*) from public.action_items where id::text like 'c01d%')`);
  const roleTimeout = (await psql("authenticator", ["set role service_role", "select current_user || '|' || (select setting from pg_settings where name = 'statement_timeout') || ' ms'"])).out.trim();
  await eq(`setup: ${THOUGHTS} thoughts with ${dims}-dimension embeddings, ${WINDOW} of them newer than each of the 20 items; a call arrives as service_role with the login role's ${TIMEOUT_MS} ms statement timeout`,
    [counts, roleTimeout], [`${THOUGHTS}|${WINDOW}|20`, `service_role|${TIMEOUT_MS} ms`]);
  await calibrate("before");
  if (INJECT === "cold_late_slowdown" || INJECT === "cold_late_slowdown_assert_fail") slowdown = true;
  if (INJECT === "cold_assert_fail" || INJECT === "cold_late_slowdown_assert_fail") await check("INJECTED a completed check that does not hold", false, "one is not two");

  // ----- control: the simulated cold read does not fit one statement -----
  await setCold(COST_NORMAL_MS);
  const src1 = JSON.parse(await sql(`select to_jsonb(embedding::text)::text from public.recheck_source_embedding(${quote(itemId(1))})`)) as string;
  if (INJECT === "cold_spike_at_control") spikeOnce = true;
  const lone = await psql("authenticator", ["set role service_role", `select count(*) from public.recheck_plan_scan(p_item_id => ${quote(itemId(1))}, p_query_embedding => ${quote(src1)})`]);
  const loneState = /ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/.exec(lone.err);
  const afterLone = await windowPagesWarm();
  observe("control, one plan alone from cold, as the login role", { psql_exit: lone.code, sqlstate: loneState?.[1] ?? null, message: loneState?.[2] ?? null, ms: Math.round(lone.ms), window_pages_read_before_it_was_cancelled: afterLone, of: WINDOW_PAGES });
  if (lone.code === 0) throw new NeverRan("the simulated cold read fitted inside the role's statement timeout, so there is no timeout to judge against");
  await eq("control: from a cold cache, one plan alone is cancelled by the ROLE's statement timeout (57014)",
    [loneState?.[1], loneState?.[2]], ["57014", "canceling statement due to statement timeout"]);
  await timingControl("the cancelled plan came back at about the role's timeout, as this client measures it", loneState?.[1] === "57014",
    lone.ms >= TIMEOUT_MS && lone.ms < TIMEOUT_MS + 1500, `${Math.round(lone.ms)} ms; expected ${TIMEOUT_MS} to ${TIMEOUT_MS + 1500} ms`);
  await check("control: the cancelled plan left what it had read in the cache: some of the window's pages, not all, and none outside it",
    afterLone > 10 && afterLone < WINDOW_PAGES && (await warmPages()).every((p) => p >= 11), `${afterLone} of ${WINDOW_PAGES}; pages ${JSON.stringify(await warmPages())}`);
  // The same statement with no role timeout finishes: the limit is the role's, not the function's.
  await setCold(COST_NORMAL_MS);
  const free = await psql("postgres", [`select count(*) from public.recheck_plan_scan(p_item_id => ${quote(itemId(1))}, p_query_embedding => ${quote(src1)})`]);
  observe("control, the same plan from cold with no statement timeout (superuser)", { psql_exit: free.code, ms: Math.round(free.ms), window_pages_read: await windowPagesWarm() });
  await check("control: with no statement timeout the same cold plan finishes and reads exactly the window's pages",
    free.code === 0 && JSON.stringify(await warmPages()) === JSON.stringify(Array.from({ length: WINDOW_PAGES }, (_, i) => i + 11)), `psql exit ${free.code}; pages ${JSON.stringify(await warmPages())}`);
  // The simulation's own cost: 82 pages at ${COST_NORMAL_MS} ms cannot take less than the timeout.
  if (free.ms <= TIMEOUT_MS) throw new NeverRan(`the simulated cold read of the whole window took ${Math.round(free.ms)} ms with no statement timeout, not more than the role's ${TIMEOUT_MS} ms, so the simulated cost is not what the scenarios assume`);
  if (INJECT === "cold_slowdown_from_a") slowdown = true;

  // ----- A: the cold DRY run, five items, four at a time (the production call) -----
  await setCold(COST_NORMAL_MS);
  rpcLog = [];
  let pagesAtFirstPlan = -1;
  onFirstBegin = async () => { pagesAtFirstPlan = await windowPagesWarm(); };
  const hashA = await stateHash();
  pagesBeforeWarm = (await warmPages()).length;
  const a = await runRecheck(db, llm, { dryRun: true, limit: 5, log: (l) => logs.push(l) });
  pagesBeforeWarm = null;
  observe("A, cold dry run, limit 5", { ...shape(a), window_pages_in_cache_when_the_first_plan_started: pagesAtFirstPlan, of: WINDOW_PAGES });
  await eq("A cold dry run: ok, five items, none errored, no statement cancelled by the role's timeout, no retry needed",
    [a.status, a.items_eligible, a.items_errored, a.errors, timeouts().length, a.timeout_retries], ["ok", 5, 0, [], 0, 0]);
  await eq(`A cold dry run: the warm-up read all ${WINDOW} embeddings of the window in 33 chunks of at most 250, said so, and every one of the window's ${WINDOW_PAGES} pages was in cache before the first plan started`,
    [a.warmup?.rows, a.warmup?.chunks, a.warmup?.complete, a.warmup?.stopped, a.warmup?.error, pagesAtFirstPlan], [WINDOW, 33, true, null, null, WINDOW_PAGES]);
  const warmCalls = rpcLog.filter((c) => c.fn === "recheck_warm_embeddings");
  const warmMs = warmCalls.map((c) => c.ms);
  const planMs = rpcLog.filter((c) => c.fn === "recheck_plan_scan").map((c) => c.ms);
  observe("A, statement times", { warmup_statements: warmMs.length, slowest_warmup_ms: Math.round(Math.max(0, ...warmMs)), plans: planMs.length, slowest_plan_ms: Math.round(Math.max(0, ...planMs)) });
  // How small one warm-up statement is, as the DATABASE counts it: the rows it
  // was asked for and read, and the simulated pages it was the first to read.
  // 250 consecutive thoughts lie on at most 4 pages of ${PAGE_ROWS}.
  const smallStatements = (calls: Call[]) => [calls.length, calls.every((c) => c.args.p_limit === 250), Math.max(0, ...calls.map((c) => Number((c.data as Array<{ rows_read: number }> | null)?.[0]?.rows_read ?? Infinity))) <= 250,
    Math.max(0, ...calls.map((c) => c.firstRead ?? Infinity)) <= 4, calls.reduce((n, c) => n + (c.firstRead ?? 0), 0)];
  await eq(`A cold dry run: 33 warm-up statements, each asked for 250 embeddings, read at most 250, and first read at most 4 simulated pages (at most ${4 * COST_NORMAL_MS} ms of simulated cold cost against the ${TIMEOUT_MS} ms timeout); together they first read all ${WINDOW_PAGES} pages of the window; 5 plans`,
    [smallStatements(warmCalls), planMs.length], [[33, true, true, true, WINDOW_PAGES], 5]);
  // The margins mean something only when the database says no statement was
  // cancelled, every warm-up statement was small, and every plan found the whole window in cache.
  const marginsApply = (calls: Call[], pagesAtPlan: number) =>
    timeouts().length === 0 && JSON.stringify(smallStatements(calls)) === JSON.stringify([33, true, true, true, WINDOW_PAGES]) && pagesAtPlan === WINDOW_PAGES;
  await timingControl("A: as this client measures them, every cold warm-up statement came back in under half the role's timeout and every plan after it in under a quarter",
    marginsApply(warmCalls, pagesAtFirstPlan) && planMs.length === 5,
    Math.max(...warmMs) < TIMEOUT_MS / 2 && Math.max(...planMs) < TIMEOUT_MS / 4,
    `slowest warm-up statement ${Math.round(Math.max(...warmMs))} ms, slowest plan ${Math.round(Math.max(...planMs))} ms`);
  const exact: string[][] = [];
  for (const id of items(1, 5)) exact.push(await bruteForce(id, real));
  await eq("A cold dry run: each plan's frozen five are exactly the five nearest thoughts of its window, as a direct exact query on the table orders them (the warm-up changed nothing about the search)",
    items(1, 5).map((id) => sortedIds((rpcLog.find((c) => c.fn === "recheck_plan_scan" && c.args.p_item_id === id && c.code === null)?.data as Array<{ embedding_ids: string[] }> | undefined)?.[0]?.embedding_ids)),
    exact);
  await check("A cold dry run: five distinct ids per item (the comparison above is not of empty lists)", exact.every((e) => e.length === 5 && new Set(e).size === 5));
  await check("A cold dry run: it wrote nothing: the database is byte-identical and no write RPC was called",
    await stateHash() === hashA && !rpcLog.some((c) => WRITE_FNS.includes(c.fn)), rpcLog.filter((c) => WRITE_FNS.includes(c.fn)).map((c) => c.fn).join(","));

  // ----- A2: the same dry run when the cold read costs SIX timeouts -----
  // The warm-up does not depend on how much the whole window costs: each of its
  // statements reads one chunk. No retry could carry this (two tries read two
  // timeouts' worth).
  await setCold(COST_SIX_TIMEOUTS_MS);
  rpcLog = [];
  pagesAtFirstPlan = -1;
  onFirstBegin = async () => { pagesAtFirstPlan = await windowPagesWarm(); };
  pagesBeforeWarm = (await warmPages()).length;
  const a2 = await runRecheck(db, llm, { dryRun: true, limit: 5, log: (l) => logs.push(l) });
  pagesBeforeWarm = null;
  const warmCalls2 = rpcLog.filter((c) => c.fn === "recheck_warm_embeddings");
  const warmMs2 = warmCalls2.map((c) => c.ms);
  observe("A2, cold dry run with a cold read worth six timeouts, limit 5", { ...shape(a2), window_pages_in_cache_when_the_first_plan_started: pagesAtFirstPlan, slowest_warmup_ms: Math.round(Math.max(0, ...warmMs2)) });
  await eq(`A2 a cold read worth six timeouts: the warm-up still reads the whole window, one small statement at a time (each first read at most 4 simulated pages, at most ${4 * COST_SIX_TIMEOUTS_MS} ms of simulated cold cost, under half the ${TIMEOUT_MS} ms timeout), and the dry run is ok with no statement cancelled and no retry`,
    [a2.status, a2.items_errored, timeouts().length, a2.timeout_retries, a2.warmup?.rows, a2.warmup?.chunks, a2.warmup?.complete, pagesAtFirstPlan, smallStatements(warmCalls2)],
    ["ok", 0, 0, 0, WINDOW, 33, true, WINDOW_PAGES, [33, true, true, true, WINDOW_PAGES]]);
  await timingControl("A2: as this client measures them, every cold warm-up statement came back in under half the role's timeout", marginsApply(warmCalls2, pagesAtFirstPlan),
    Math.max(...warmMs2) < TIMEOUT_MS / 2, `slowest warm-up statement ${Math.round(Math.max(...warmMs2))} ms`);
  await check("A2: it wrote nothing either", await stateHash() === hashA && !rpcLog.some((c) => WRITE_FNS.includes(c.fn)));

  // ----- B: the cold REAL run, the same five items -----
  await setCold(COST_NORMAL_MS);
  rpcLog = [];
  const b = await runRecheck(db, llm, { dryRun: false, limit: 5, log: (l) => logs.push(l) });
  observe("B, cold real run, limit 5", shape(b));
  await eq("B cold real run: ok, five scans begun and finished, none errored, no statement cancelled, no retry, no error stamp",
    [b.status, b.items_final, b.items_errored, timeouts().length, b.timeout_retries, b.items_error_noted, await rechecked(items(1, 5)), await stamped(items(1, 20))],
    ["ok", 5, 0, 0, 0, 0, 5, []]);
  await eq("B cold real run: each begin froze exactly the five nearest thoughts the direct query names",
    items(1, 5).map((id) => sortedIds((rpcLog.find((c) => c.fn === "recheck_begin_scan" && c.args.p_item_id === id && c.code === null)?.data as Array<{ embedding_ids: string[] }> | undefined)?.[0]?.embedding_ids)),
    exact);
  await eq("B cold real run: the receipt carries the warm-up",
    await sql(`select concat_ws('|', status, summary->'warmup'->>'rows', summary->'warmup'->>'complete', summary->>'timeout_retries', summary->>'items_errored') from public.action_item_recheck_runs order by finished_at desc limit 1`),
    `ok|${WINDOW}|true|0|0`);

  // ----- C: the second line. No warm-up at all; the plan's own retry -----
  await setCold(COST_NORMAL_MS);
  rpcLog = [];
  const c = await runRecheck(db, llm, { dryRun: false, limit: 5, budgetMs: 1_000_000, now: noWarmClock(), log: (l) => logs.push(l) });
  observe("C, cold real run with the warm-up given no time, limit 5", shape(c));
  await eq("C no warm-up: the warm-up read nothing and says it stopped on its budget",
    [c.warmup?.chunks, c.warmup?.rows, c.warmup?.complete, c.warmup?.stopped], [0, 0, false, "budget"]);
  await eq("C no warm-up: the first four begins are cancelled by the role's timeout, each is tried once more and succeeds, the fifth needs no retry; the run is ok with nothing errored and nothing stamped",
    [c.status, c.items_final, c.items_errored, c.timeout_retries, timeouts().map((t) => `${t.fn}:${short(String(t.args.p_item_id))}`).sort(),
      beginsOf("recheck_begin_scan").length, await rechecked(items(6, 10)), await stamped(items(1, 20))],
    ["ok", 5, 0, 4, items(6, 9).map((id) => `recheck_begin_scan:${short(id)}`), 9, 5, []]);

  // ----- D: a failure that lasts. The cold read costs 2.5 timeouts and no warm-up runs -----
  // Night 1: the four items at the head fail on both tries and are stamped.
  await setCold(COST_HEAVY_MS);
  rpcLog = [];
  const d1 = await runRecheck(db, llm, { dryRun: false, limit: 5, budgetMs: 1_000_000, now: noWarmClock(), log: (l) => logs.push(l) });
  const night1 = processed();
  observe("D night 1, heavy cold cost, no warm-up, limit 5", { ...shape(d1), items_processed: night1, stamped: await stamped(items(1, 20)) });
  await eq("D night 1: the five oldest never-attempted items run; four begins are cancelled twice each and no more; those four are errors with no scan begun, the fifth finishes",
    [night1, d1.status, d1.items_errored, d1.items_final, d1.recheck_incomplete, d1.timeout_retries, timeouts().length, beginsOf("recheck_begin_scan").length],
    [items(11, 15).map(short), "partial", 4, 1, 0, 4, 8, 9]);
  await eq("D night 1: the errors are reported as the statement timeout, in the summary and in the receipt, and exactly those four items are stamped: four stamps written, none refused, none failed",
    [d1.errors, [d1.items_error_noted, d1.error_notes_refused, d1.error_notes_failed], await stamped(items(1, 20)),
      await sql(`select concat_ws('|', status, summary->>'items_errored', summary->>'items_error_noted', summary->>'error_notes_refused', summary->>'error_notes_failed', summary->'errors'->0->>'message') from public.action_item_recheck_runs order by finished_at desc limit 1`)],
    [items(11, 14).map((id) => ({ item: short(id), message: "recheck_begin_scan 57014: canceling statement due to statement timeout" })), [4, 0, 0], items(11, 14).map(short),
      "partial|4|4|0|0|recheck_begin_scan 57014: canceling statement due to statement timeout"]);
  // Night 2, the same cold start: the items that failed are not at the head.
  await setCold(COST_HEAVY_MS);
  rpcLog = [];
  const d2 = await runRecheck(db, llm, { dryRun: false, limit: 5, budgetMs: 1_000_000, now: noWarmClock(), log: (l) => logs.push(l) });
  const night2 = processed();
  observe("D night 2, the same cold start, limit 5", { ...shape(d2), items_processed: night2, items_processed_on_both_nights: night2.filter((x) => night1.includes(x) && d1.errors.some((e: { item: string }) => e.item === x)), stamped: await stamped(items(1, 20)) });
  await eq("D night 2: the head of the queue is the next five never-attempted items; not one of the four that failed last night is tried",
    [night2, night2.filter((x) => items(11, 14).map(short).includes(x))], [items(16, 20).map(short), []]);
  // Night 3: an ordinary cold night with the warm-up. The stamped items are retried and finish.
  await setCold(COST_NORMAL_MS);
  rpcLog = [];
  const d3 = await runRecheck(db, llm, { dryRun: false, limit: 40, log: (l) => logs.push(l) });
  observe("D night 3, ordinary cold cost with the warm-up, limit 40", { ...shape(d3), items_processed: processed() });
  await eq("D night 3: every item an earlier night gave up on is retried, oldest attempt first, and finishes: none errored, no statement cancelled",
    [d3.status, d3.items_errored, d3.items_eligible === d3.items_final, timeouts().length, d3.timeout_retries,
      rpcLog.filter((x) => x.fn === "recheck_eligible_items").length, items(11, 14).every((id) => processed().includes(short(id))), await rechecked(items(1, 20))],
    ["ok", 0, true, 0, 0, 1, true, 20]);
  const firstEight = ((rpcLog.find((x) => x.fn === "recheck_eligible_items")?.data ?? []) as Array<{ id: string }>).map((x) => short(x.id));
  await eq("D night 3: the queue held the items in the order of their last attempt: night 1's four, then night 2's",
    [firstEight.slice(0, 4).sort(), firstEight.slice(4).sort(), firstEight.length], [items(11, 14).map(short), items(16, 19).map(short), d3.items_eligible]);

  await calibrate("after");
  await check("no call was refused for an argument name or type the SQL does not declare, and no error stamp failed to write",
    !logs.some((l) => /42883|42804|42P02|42501|function .* does not exist/.test(l)), logs.find((l) => /42883|42804|42P02|42501/.test(l)) ?? "");
} catch (e) {
  if (e instanceof NeverRan || neverRan.length > 0) bail();
  say(`NEVER-RAN: the cold-start harness threw outside an assertion: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
  Deno.exit(2);
}
if (neverRan.length > 0) bail();
if (failed > 0) {
  say(`RECHECK COLD START FAILED (${failed} checks failed, ${passed} passed)`);
  Deno.exit(1);
}
say(`RECHECK COLD START PASSED (${passed} checks)`);
Deno.exit(0);
