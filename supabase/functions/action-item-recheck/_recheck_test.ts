// The run loop against a scripted database: what is called, in what order, with
// which values, and what the summary then says. The SQL functions themselves are
// proven on a real PostgreSQL by scripts/loop-closing/recheck-sql-test.sh, which
// also runs this loop against them (recheck-integration.ts).
import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { type RecheckLlm, runRecheck, type RunSummary, TIMEOUT_ATTEMPTS, WARM_BUDGET_FRACTION, WARM_CHUNK_ROWS, WARM_MAX_CHUNKS } from "./_recheck.ts";

type Reply = { data?: unknown; error?: { code?: string; message?: string } | null };
type Args = Record<string, unknown>;
type Call = { fn: string; args: Args };
type Thought = { id: string; created_at: string; content: string; metadata: Record<string, unknown> | null };

const UPPER_AT = "2026-11-18T23:59:59.999999+00:00";
const UPPER_ID = "ffffffff-0000-4000-8000-00000000ffff";
const SCAN = "5ca00000-0000-4000-8000-000000000001";

function item(n: number, description = `rotate the Railway deploy token ${n}`) {
  return {
    id: `a${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`,
    description,
    created_at: "2026-10-01T08:00:00.654321+00:00",
    src_project: "brain-bank",
  };
}
function thoughts(n: number, prefix = "b"): Thought[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${String(i).padStart(7, "0")}-0000-4000-8000-000000000000`,
    // Microseconds that a JavaScript Date would round away.
    created_at: `2026-11-10T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.123456+00:00`,
    content: `note ${i}`,
    metadata: { project: "brain-bank" },
  }));
}

class FakeDb {
  calls: Call[] = [];
  counts: Record<string, number> = {};
  handlers: Record<string, (args: Args, n: number) => Reply> = {};
  // As the real function does: the proposed flag lasts for the whole scan.
  proposed = new Set<string>();
  constructor(items: ReturnType<typeof item>[], byItem: Record<string, Thought[]>) {
    this.handlers = {
      recheck_client_names: () => ({ data: [] }),
      recheck_eligible_items: () => ({ data: items }),
      recheck_source_embedding: () => ({ data: [{ has_source: true, embedding: "[0.25,0.5]" }] }),
      recheck_begin_scan: () => ({
        data: [{ status: "began", scan_id: SCAN, cursor_at: null, cursor_id: null, upper_at: UPPER_AT, upper_id: UPPER_ID, embedding_ids: [] }],
      }),
      recheck_plan_scan: () => ({
        data: [{ status: "would_begin", scan_id: null, cursor_at: null, cursor_id: null, upper_at: UPPER_AT, upper_id: UPPER_ID, embedding_ids: [], scan_proposed: false }],
      }),
      recheck_candidates: (a) => {
        const all = byItem[a.p_item_id as string] ?? [];
        const from = a.p_lower_id === null ? 0 : all.findIndex((t) => t.id === a.p_lower_id) + 1;
        return { data: all.slice(from, from + (a.p_limit as number)) };
      },
      recheck_commit_page: (a) => {
        const rows = a.p_rows as Array<{ outcome: string }>;
        if (rows.some((r) => r.outcome === "proposed")) this.proposed.add(a.p_item_id as string);
        const proposed = this.proposed.has(a.p_item_id as string);
        return a.p_final
          ? { data: [{ status: "final", scan_active: false, cursor_at: UPPER_AT, cursor_id: UPPER_ID, scan_proposed: proposed, inserted: rows.length + (proposed ? 0 : 1), last_rechecked_at: UPPER_AT }] }
          : { data: [{ status: "committed", scan_active: true, cursor_at: a.p_cursor_at, cursor_id: a.p_cursor_id, scan_proposed: proposed, inserted: rows.length, last_rechecked_at: null }] };
      },
      recheck_record_run: () => ({ data: "0c000000-0000-4000-8000-000000000000" }),
      // Cold-start correction: nothing left to warm, and an error stamp that lands.
      recheck_warm_embeddings: () => ({ data: [{ rows_read: 0, last_at: null, last_id: null, done: true }] }),
      recheck_note_error: () => ({ data: true }),
    };
  }
  rpc(fn: string, args: Args) {
    this.calls.push({ fn, args });
    const n = this.counts[fn] = (this.counts[fn] ?? 0) + 1;
    const h = this.handlers[fn];
    const r = h ? h(args, n) : { error: { code: "FAKE0", message: `unexpected rpc ${fn}` } };
    return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
  }
  of(fn: string): Args[] {
    return this.calls.filter((c) => c.fn === fn).map((c) => c.args);
  }
}

const OPEN: RecheckLlm = () => Promise.resolve('{"verdict":"open","thought_id":null,"quote":null}');
const quiet = { log: () => {}, concurrency: 1 };

Deno.test("run: a short first page is one model call and one FINAL commit, with a null expected cursor", async () => {
  const it = item(1);
  const ts = thoughts(3);
  const db = new FakeDb([it], { [it.id]: ts });
  let prompts = 0;
  const s = await runRecheck(db, (m) => { prompts += 1; assert(m[1].content.includes(`ITEM: ${it.description}`)); return OPEN(m); }, { dryRun: false, ...quiet });
  assertEquals(prompts, 1);
  const commits = db.of("recheck_commit_page");
  assertEquals(commits, [{
    p_item_id: it.id, p_scan_id: SCAN,
    p_expected_cursor_at: null, p_expected_cursor_id: null,
    p_cursor_at: ts[2].created_at, p_cursor_id: ts[2].id,
    p_rows: [], p_final: true,
  }]);
  // A never-scanned item's window starts at the item's own created_at, passed as received.
  assertEquals(db.of("recheck_candidates")[0], {
    p_item_id: it.id, p_lower_at: it.created_at, p_lower_id: null,
    p_upper_at: UPPER_AT, p_upper_id: UPPER_ID, p_embedding_ids: [], p_limit: 10,
  });
  assertEquals([s.status, s.items_eligible, s.items_final, s.recheck_incomplete, s.pages, s.llm_calls], ["ok", 1, 1, 0, 1, 1]);
  assertEquals(s.rows, { proposed: 0, none_found: 1, no_evidence: {} });
  assertEquals(s.would_be, undefined);
  assertEquals(db.of("recheck_record_run").length, 1);
  assertEquals(db.of("recheck_record_run")[0].p_status, "ok");
  assertEquals(db.of("recheck_plan_scan").length, 0);
});

Deno.test("run: an empty first page is a final commit with no rows, no cursor and no model call", async () => {
  const it = item(1);
  const db = new FakeDb([it], { [it.id]: [] });
  let prompts = 0;
  const s = await runRecheck(db, (m) => { prompts += 1; return OPEN(m); }, { dryRun: false, ...quiet });
  assertEquals(prompts, 0);
  assertEquals(db.of("recheck_commit_page"), [{
    p_item_id: it.id, p_scan_id: SCAN, p_expected_cursor_at: null, p_expected_cursor_id: null,
    p_cursor_at: null, p_cursor_id: null, p_rows: [], p_final: true,
  }]);
  assertEquals([s.items_final, s.rows.none_found], [1, 1]);
});

Deno.test("run: the cursor strings the database returned are passed back character for character", async () => {
  const it = item(1);
  const ts = thoughts(13);
  const db = new FakeDb([it], { [it.id]: ts });
  await runRecheck(db, OPEN, { dryRun: false, ...quiet });
  const commits = db.of("recheck_commit_page");
  assertEquals(commits.length, 2);
  assertEquals([commits[0].p_final, commits[0].p_cursor_at, commits[0].p_cursor_id], [false, ts[9].created_at, ts[9].id]);
  // Page 2 expects exactly what page 1's commit answered, microseconds included.
  assertEquals([commits[1].p_expected_cursor_at, commits[1].p_expected_cursor_id], [ts[9].created_at, ts[9].id]);
  assert(String(commits[1].p_expected_cursor_at).includes(".123456"));
  assertEquals([commits[1].p_final, commits[1].p_cursor_at, commits[1].p_cursor_id], [true, ts[12].created_at, ts[12].id]);
  const pages = db.of("recheck_candidates");
  assertEquals([pages[1].p_lower_at, pages[1].p_lower_id], [ts[9].created_at, ts[9].id]);
});

Deno.test("run: exactly ten candidates take two pages; the full page is never final", async () => {
  const it = item(1);
  const db = new FakeDb([it], { [it.id]: thoughts(10) });
  const s = await runRecheck(db, OPEN, { dryRun: false, ...quiet });
  assertEquals(db.of("recheck_commit_page").map((c) => [c.p_final, (c.p_rows as unknown[]).length, c.p_cursor_at === null]), [[false, 0, false], [true, 0, true]]);
  assertEquals([s.items_final, s.recheck_incomplete, s.pages, s.llm_calls], [1, 0, 2, 1]);
});

for (const [n, commits, final, incomplete] of [[40, 5, 1, 0], [41, 5, 1, 0], [49, 5, 1, 0], [50, 5, 0, 1]] as const) {
  Deno.test(`run: ${n} candidates: ${commits} commits, final ${final}, recheck_incomplete ${incomplete}`, async () => {
    const it = item(1);
    const db = new FakeDb([it], { [it.id]: thoughts(n) });
    const s = await runRecheck(db, OPEN, { dryRun: false, ...quiet });
    assertEquals(db.of("recheck_commit_page").length, commits);
    assertEquals(db.of("recheck_commit_page").map((c) => c.p_final).filter(Boolean).length, final);
    assertEquals([s.items_final, s.recheck_incomplete, s.incomplete_ids, s.status], [final, incomplete, incomplete ? [it.id.slice(0, 8)] : [], "ok"]);
  });
}

Deno.test("run: recheck_incomplete is read from the last commit's own answer, not from the page count", async () => {
  // Five commits, and the fifth answers that the scan is no longer active.
  const it = item(1);
  const db = new FakeDb([it], { [it.id]: thoughts(45) });
  const s = await runRecheck(db, OPEN, { dryRun: false, ...quiet });
  assertEquals(db.of("recheck_commit_page").length, 5);
  assertEquals(s.recheck_incomplete, 0);
  // And the reverse: a database that says the scan is still active after a
  // commit the loop sent as final is believed.
  const db2 = new FakeDb([it], { [it.id]: thoughts(3) });
  db2.handlers.recheck_commit_page = () => ({ data: [{ status: "committed", scan_active: true, cursor_at: UPPER_AT, cursor_id: UPPER_ID, scan_proposed: false, inserted: 0 }] });
  const s2 = await runRecheck(db2, OPEN, { dryRun: false, ...quiet });
  assertEquals(s2.recheck_incomplete, 1);
});

Deno.test("run: accepted and rejected answers become the page's rows; an id outside the page has no evidence id and the page still commits", async () => {
  const it = item(1, "rotate the Railway deploy token");
  const ts = thoughts(12);
  ts[2].content = "Rotated the Railway deploy token this morning.";
  ts[11].content = "Rotated the Railway deploy token again, and it is done.";
  const db = new FakeDb([it], { [it.id]: ts });
  let call = 0;
  const llm: RecheckLlm = () => {
    call += 1;
    return Promise.resolve(call === 1
      ? JSON.stringify({ verdict: "done", thought_id: ts[2].id, quote: "Rotated the Railway deploy token this morning." })
      : JSON.stringify({ verdict: "done", thought_id: "99999999-9999-4999-8999-999999999999", quote: "invented" }));
  };
  const s = await runRecheck(db, llm, { dryRun: false, ...quiet });
  const commits = db.of("recheck_commit_page");
  assertEquals(commits[0].p_rows, [
    { outcome: "proposed", reason: null, evidence_thought_id: ts[2].id, quote: "Rotated the Railway deploy token this morning.", score: 1 },
  ]);
  assertEquals(commits[1].p_rows, [
    { outcome: "no_evidence", reason: "thought_not_in_page", evidence_thought_id: null, quote: null, score: null },
  ]);
  assertEquals(commits[1].p_final, true);
  // Page 1 proposed, so the final commit reports the scan as proposed: no none_found.
  assertEquals(s.rows, { proposed: 1, none_found: 0, no_evidence: { thought_not_in_page: 1 } });
  assertEquals(s.items_final, 1);
});

Deno.test("run: the client names the database returned decide the client scope check", async () => {
  const it = item(1, "Send Alicia Brennan the deposit link");
  const ts = thoughts(2);
  ts[0].content = "Sent the deposit link.";
  ts[0].metadata = {};
  const answer = JSON.stringify({ verdict: "done", thought_id: ts[0].id, quote: "Sent the deposit link." });
  const withClient = new FakeDb([{ ...it, src_project: null as unknown as string }], { [it.id]: ts });
  withClient.handlers.recheck_client_names = () => ({ data: ["Alicia Brennan", "Morgan Lee"] });
  await runRecheck(withClient, () => Promise.resolve(answer), { dryRun: false, ...quiet });
  assertEquals((withClient.of("recheck_commit_page")[0].p_rows as Array<{ reason: string | null }>).map((r) => r.reason), ["scope_mismatch"]);
  // The same answer with no such client on file is a proposal.
  const without = new FakeDb([{ ...it, src_project: null as unknown as string }], { [it.id]: ts });
  await runRecheck(without, () => Promise.resolve(answer), { dryRun: false, ...quiet });
  assertEquals((without.of("recheck_commit_page")[0].p_rows as Array<{ outcome: string }>).map((r) => r.outcome), ["proposed"]);
});

Deno.test("run: a commit error aborts the item before its next page, leaves the scan counted as active, and the next item still runs", async () => {
  const a = item(1), b = item(2);
  const db = new FakeDb([a, b], { [a.id]: thoughts(25), [b.id]: thoughts(2, "c") });
  const base = db.handlers.recheck_commit_page;
  db.handlers.recheck_commit_page = (args, n) =>
    args.p_item_id === a.id && db.of("recheck_commit_page").filter((c) => c.p_item_id === a.id).length === 2
      ? { error: { code: "RC001", message: "stale_commit: the cursor of a0000001 is not the one this commit expected" } }
      : base(args, n);
  const s = await runRecheck(db, OPEN, { dryRun: false, ...quiet });
  assertEquals(db.of("recheck_commit_page").filter((c) => c.p_item_id === a.id).length, 2, "no third page after the failed second");
  assertEquals(db.of("recheck_candidates").filter((c) => c.p_item_id === a.id).length, 2);
  assertEquals([s.status, s.items_errored, s.items_final, s.recheck_incomplete, s.incomplete_ids], ["partial", 1, 1, 1, ["a0000001"]]);
  assertEquals(s.errors, [{ item: "a0000001", message: "recheck_commit_page RC001: stale_commit: the cursor of a0000001 is not the one this commit expected" }]);
  assertEquals(s.pages, 2, "page 1 of the first item and the one page of the second");
});

Deno.test("run: a model failure or an answer that is not the object asked for commits nothing for that page", async () => {
  for (const bad of [() => Promise.reject(new Error("OpenRouter 503")), () => Promise.resolve("it looks done to me")] as RecheckLlm[]) {
    const it = item(1);
    const db = new FakeDb([it], { [it.id]: thoughts(4) });
    const s = await runRecheck(db, bad, { dryRun: false, ...quiet });
    assertEquals(db.of("recheck_commit_page").length, 0);
    assertEquals([s.status, s.items_errored, s.recheck_incomplete, s.rows.none_found], ["partial", 1, 1, 0]);
  }
});

Deno.test("run: a deadlock on a commit is retried and the page commits once", async () => {
  const it = item(1);
  const db = new FakeDb([it], { [it.id]: thoughts(2) });
  const base = db.handlers.recheck_commit_page;
  db.handlers.recheck_commit_page = (args, n) => n === 1 ? { error: { code: "40P01", message: "deadlock detected" } } : base(args, n);
  const s = await runRecheck(db, OPEN, { dryRun: false, ...quiet });
  assertEquals(db.of("recheck_commit_page").length, 2);
  assertEquals(db.of("recheck_commit_page")[0], db.of("recheck_commit_page")[1]);
  assertEquals([s.status, s.items_final, s.pages], ["ok", 1, 1]);
});

Deno.test("run: three deadlocks in a row abort the item and count it", async () => {
  const it = item(1);
  const db = new FakeDb([it], { [it.id]: thoughts(2) });
  db.handlers.recheck_commit_page = () => ({ error: { code: "40P01", message: "deadlock detected" } });
  const s = await runRecheck(db, OPEN, { dryRun: false, ...quiet });
  assertEquals(db.of("recheck_commit_page").length, 3);
  assertEquals([s.status, s.items_errored], ["partial", 1]);
});

Deno.test("run: the source embedding goes to begin untouched; no source thought sends null", async () => {
  const a = item(1), b = item(2);
  const db = new FakeDb([a, b], {});
  db.handlers.recheck_source_embedding = (args) =>
    args.p_item_id === a.id ? { data: [{ has_source: true, embedding: "[0.25,0.5]" }] } : { data: [{ has_source: false, embedding: null }] };
  await runRecheck(db, OPEN, { dryRun: false, ...quiet });
  assertEquals(db.of("recheck_begin_scan"), [
    { p_item_id: a.id, p_query_embedding: "[0.25,0.5]" },
    { p_item_id: b.id, p_query_embedding: null },
  ]);
});

Deno.test("run: an existing scan resumes from its stored cursor", async () => {
  const it = item(1);
  const ts = thoughts(14);
  const db = new FakeDb([it], { [it.id]: ts });
  db.handlers.recheck_begin_scan = () => ({
    data: [{ status: "existing", scan_id: SCAN, cursor_at: ts[9].created_at, cursor_id: ts[9].id, upper_at: UPPER_AT, upper_id: UPPER_ID, embedding_ids: [ts[12].id] }],
  });
  await runRecheck(db, OPEN, { dryRun: false, ...quiet });
  assertEquals(db.of("recheck_candidates")[0], {
    p_item_id: it.id, p_lower_at: ts[9].created_at, p_lower_id: ts[9].id,
    p_upper_at: UPPER_AT, p_upper_id: UPPER_ID, p_embedding_ids: [ts[12].id], p_limit: 10,
  });
  const c = db.of("recheck_commit_page");
  assertEquals(c.length, 1);
  assertEquals([c[0].p_expected_cursor_at, c[0].p_expected_cursor_id, c[0].p_final], [ts[9].created_at, ts[9].id, true]);
});

Deno.test("run: an item that is no longer open is left alone and is not counted as incomplete", async () => {
  const a = item(1), b = item(2);
  const db = new FakeDb([a, b], { [a.id]: thoughts(3), [b.id]: thoughts(3, "c") });
  db.handlers.recheck_begin_scan = (args) =>
    args.p_item_id === a.id
      ? { data: [{ status: "not_open", scan_id: null, cursor_at: null, cursor_id: null, upper_at: null, upper_id: null, embedding_ids: null }] }
      : { data: [{ status: "began", scan_id: SCAN, cursor_at: null, cursor_id: null, upper_at: UPPER_AT, upper_id: UPPER_ID, embedding_ids: [] }] };
  db.handlers.recheck_commit_page = () => ({ data: [{ status: "not_open", scan_active: true, cursor_at: null, cursor_id: null, scan_proposed: false, inserted: 0 }] });
  const s = await runRecheck(db, OPEN, { dryRun: false, ...quiet });
  assertEquals(db.of("recheck_candidates").map((c) => c.p_item_id), [b.id]);
  assertEquals([s.status, s.items_not_open, s.recheck_incomplete, s.items_final, s.pages], ["ok", 2, 0, 0, 0]);
});

Deno.test("run: a retried final that the database already holds is final, and writes no page", async () => {
  const it = item(1);
  const db = new FakeDb([it], { [it.id]: thoughts(1) });
  db.handlers.recheck_commit_page = () => ({ data: [{ status: "already_final", scan_active: false, cursor_at: UPPER_AT, cursor_id: UPPER_ID, scan_proposed: false, inserted: 0 }] });
  const s = await runRecheck(db, OPEN, { dryRun: false, ...quiet });
  assertEquals([s.items_final, s.recheck_incomplete, s.pages, s.rows.none_found], [1, 0, 0, 0]);
});

Deno.test("dry run: plans, reads and judges, and calls no write of any kind", async () => {
  const it = item(1, "rotate the Railway deploy token");
  const ts = thoughts(12);
  ts[1].content = "Rotated the Railway deploy token this morning.";
  const db = new FakeDb([it], { [it.id]: ts });
  const lines: string[] = [];
  let call = 0;
  const llm: RecheckLlm = () => {
    call += 1;
    return Promise.resolve(call === 1
      ? JSON.stringify({ verdict: "done", thought_id: ts[1].id, quote: "Rotated the Railway deploy token this morning." })
      : '{"verdict":"open"}');
  };
  const s = await runRecheck(db, llm, { dryRun: true, concurrency: 1, log: (l) => lines.push(l) });
  assertEquals(new Set(db.calls.map((c) => c.fn)), new Set(["recheck_client_names", "recheck_eligible_items", "recheck_warm_embeddings", "recheck_source_embedding", "recheck_plan_scan", "recheck_candidates"]));
  const row = { outcome: "proposed", reason: null, evidence_thought_id: ts[1].id, quote: "Rotated the Railway deploy token this morning.", score: 1, item_id: it.id, description: it.description };
  assertEquals(s.would_be as unknown, [row]);
  assertEquals(lines[0], `recheck dry-run row ${JSON.stringify(row)}`);
  assertEquals([s.dry_run, s.status, s.items_final, s.pages, s.rows.proposed, s.rows.none_found, s.inserted], [true, "ok", 1, 2, 1, 0, 0]);
  // Page 2 was read from page 1's last row, client-side.
  assertEquals([db.of("recheck_candidates")[1].p_lower_at, db.of("recheck_candidates")[1].p_lower_id], [ts[9].created_at, ts[9].id]);
});

Deno.test("dry run: a scan that found nothing reports one would-be none_found ROW, logged as JSON; five full pages report the scan a real run would leave active and no row", async () => {
  const a = item(1), b = item(2);
  const db = new FakeDb([a, b], { [a.id]: thoughts(3), [b.id]: thoughts(60, "c") });
  const lines: string[] = [];
  const s = await runRecheck(db, OPEN, { dryRun: true, concurrency: 1, log: (l) => lines.push(l) });
  assertEquals([s.items_final, s.rows.none_found, s.recheck_incomplete, s.incomplete_ids, s.pages], [1, 1, 1, [b.id.slice(0, 8)], 6]);
  assertEquals(db.of("recheck_commit_page").length + db.of("recheck_begin_scan").length + db.of("recheck_record_run").length, 0);
  // The row the real final commit would write, for the item that finished; none for the one still scanning.
  const noneFound = { outcome: "no_evidence", reason: "none_found", evidence_thought_id: null, quote: null, score: null, item_id: a.id, description: a.description };
  assertEquals(s.would_be as unknown, [noneFound]);
  assertEquals(lines.filter((l) => l.startsWith("recheck dry-run row ")), [`recheck dry-run row ${JSON.stringify(noneFound)}`]);
  // none_found is counted on its own line of the summary, as a real run counts it.
  assertEquals(s.rows, { proposed: 0, none_found: 1, no_evidence: {} });
});

// Review finding F2. A dry run between two real runs resumes a scan in progress:
// the plan returns the stored cursor AND the stored proposed flag.
Deno.test("dry run: a resumed scan that proposed on an earlier page reports NO none_found; the same scan without a proposal reports one", async () => {
  const it = item(1);
  const ts = thoughts(14);
  const plan = (scanProposed: boolean) => () => ({
    data: [{ status: "existing", scan_id: SCAN, cursor_at: ts[9].created_at, cursor_id: ts[9].id, upper_at: UPPER_AT, upper_id: UPPER_ID, embedding_ids: [ts[12].id], scan_proposed: scanProposed }],
  });
  const proposedBefore = new FakeDb([it], { [it.id]: ts });
  proposedBefore.handlers.recheck_plan_scan = plan(true);
  const s1 = await runRecheck(proposedBefore, OPEN, { dryRun: true, ...quiet });
  assertEquals([s1.items_final, s1.pages, s1.rows.none_found, s1.would_be], [1, 1, 0, []]);
  // It read the rest of the scan from the stored cursor, with the frozen ids.
  assertEquals(proposedBefore.of("recheck_candidates"), [{
    p_item_id: it.id, p_lower_at: ts[9].created_at, p_lower_id: ts[9].id,
    p_upper_at: UPPER_AT, p_upper_id: UPPER_ID, p_embedding_ids: [ts[12].id], p_limit: 10,
  }]);
  assertEquals(proposedBefore.of("recheck_begin_scan").length + proposedBefore.of("recheck_commit_page").length + proposedBefore.of("recheck_record_run").length, 0);

  const nothingBefore = new FakeDb([it], { [it.id]: ts });
  nothingBefore.handlers.recheck_plan_scan = plan(false);
  const s2 = await runRecheck(nothingBefore, OPEN, { dryRun: true, ...quiet });
  assertEquals([s2.items_final, s2.pages, s2.rows.none_found], [1, 1, 1]);
  assertEquals(s2.would_be as unknown, [
    { outcome: "no_evidence", reason: "none_found", evidence_thought_id: null, quote: null, score: null, item_id: it.id, description: it.description },
  ]);
});

Deno.test("dry run: a plan that does not say whether the scan has proposed aborts the item; it is never read as 'no'", async () => {
  for (const flag of [undefined, null, "true", 1]) {
    const it = item(1);
    const db = new FakeDb([it], { [it.id]: thoughts(3) });
    db.handlers.recheck_plan_scan = () => ({
      data: [{ status: "existing", scan_id: SCAN, cursor_at: null, cursor_id: null, upper_at: UPPER_AT, upper_id: UPPER_ID, embedding_ids: [], scan_proposed: flag }],
    });
    const s = await runRecheck(db, OPEN, { dryRun: true, ...quiet });
    assertEquals([s.status, s.items_errored, s.items_final, s.rows.none_found, s.would_be], ["partial", 1, 0, 0, []], `scan_proposed ${JSON.stringify(flag)}`);
    assertEquals(s.errors, [{ item: it.id.slice(0, 8), message: "the plan did not say whether the scan has proposed" }]);
    assertEquals(db.of("recheck_candidates").length, 0);
    // A plan that could not be read gives no scan to report as in progress.
    assertEquals([s.recheck_incomplete, s.incomplete_ids], [0, []], `scan_proposed ${JSON.stringify(flag)}`);
  }
  // A real run does not read the flag from begin: its final commit answers it.
  const it = item(1);
  const db = new FakeDb([it], { [it.id]: thoughts(3) });
  assertEquals((await runRecheck(db, OPEN, { dryRun: false, ...quiet })).items_final, 1);
});

// The rows a real run writes for one item: every row of every page it committed,
// then one none_found when its final commit answered that the scan never proposed.
function realRows(db: FakeDb, itemId: string, description: string): unknown[] {
  const out: unknown[] = [];
  for (const c of db.of("recheck_commit_page").filter((c) => c.p_item_id === itemId)) {
    for (const r of c.p_rows as Record<string, unknown>[]) out.push({ ...r, item_id: itemId, description });
    if (c.p_final && !db.proposed.has(itemId)) {
      out.push({ outcome: "no_evidence", reason: "none_found", evidence_thought_id: null, quote: null, score: null, item_id: itemId, description });
    }
  }
  return out;
}

Deno.test("dry run: per item, the would-be rows are exactly the rows a real run writes: a source with no embedding, an item with no source, and a scan that proposes", async () => {
  const nullEmb = item(1, "rotate the Railway deploy token");
  const noSource = item(2, "an item with no source thought");
  const proposes = item(3, "renew the vault licence key");
  const a = thoughts(12);
  a[3].content = "Looked at the Railway dashboard.";
  const c = thoughts(11, "c");
  c[1].content = "Renewed the vault licence key today.";
  const llm: RecheckLlm = (m) => {
    const user = m[1].content;
    if (user.includes("Looked at the Railway dashboard.")) {
      return Promise.resolve(JSON.stringify({ verdict: "done", thought_id: a[3].id, quote: "Looked at the Railway dashboard." }));
    }
    if (user.includes("Renewed the vault licence key today.")) {
      return Promise.resolve(JSON.stringify({ verdict: "done", thought_id: c[1].id, quote: "Renewed the vault licence key today." }));
    }
    return OPEN(m);
  };
  const make = () => {
    const db = new FakeDb([nullEmb, noSource, proposes], { [nullEmb.id]: a, [noSource.id]: [], [proposes.id]: c });
    db.handlers.recheck_source_embedding = (args) =>
      args.p_item_id === nullEmb.id ? { data: [{ has_source: true, embedding: null }] }
        : args.p_item_id === noSource.id ? { data: [{ has_source: false, embedding: null }] }
        : { data: [{ has_source: true, embedding: "[0.25,0.5]" }] };
    return db;
  };
  const real = make();
  await runRecheck(real, llm, { dryRun: false, ...quiet });
  const dryDb = make();
  const dry = await runRecheck(dryDb, llm, { dryRun: true, ...quiet });
  const wouldBe = (id: string) => (dry.would_be ?? []).filter((r) => r.item_id === id) as unknown[];

  // A source thought with no embedding: the plan gets a null embedding, the
  // pages carry an empty frozen set, and the metadata candidates are judged.
  assertEquals(dryDb.of("recheck_plan_scan").find((p) => p.p_item_id === nullEmb.id), { p_item_id: nullEmb.id, p_query_embedding: null });
  assertEquals(dryDb.of("recheck_candidates").filter((p) => p.p_item_id === nullEmb.id).map((p) => p.p_embedding_ids), [[], []]);
  assertEquals(wouldBe(nullEmb.id), [
    { outcome: "no_evidence", reason: "coverage", evidence_thought_id: a[3].id, quote: "Looked at the Railway dashboard.", score: 0.3333, item_id: nullEmb.id, description: nullEmb.description },
    { outcome: "no_evidence", reason: "none_found", evidence_thought_id: null, quote: null, score: null, item_id: nullEmb.id, description: nullEmb.description },
  ]);
  assertEquals(wouldBe(nullEmb.id), realRows(real, nullEmb.id, nullEmb.description));

  // An item with no source thought: a null embedding, one empty page, no model
  // call, and an empty scan reported as its one none_found row.
  assertEquals(dryDb.of("recheck_plan_scan").find((p) => p.p_item_id === noSource.id), { p_item_id: noSource.id, p_query_embedding: null });
  assertEquals(dryDb.of("recheck_candidates").filter((p) => p.p_item_id === noSource.id).length, 1);
  assertEquals(wouldBe(noSource.id), [
    { outcome: "no_evidence", reason: "none_found", evidence_thought_id: null, quote: null, score: null, item_id: noSource.id, description: noSource.description },
  ]);
  assertEquals(wouldBe(noSource.id), realRows(real, noSource.id, noSource.description));

  // A scan whose first page proposes: the final page adds no none_found.
  assertEquals(wouldBe(proposes.id), [
    { outcome: "proposed", reason: null, evidence_thought_id: c[1].id, quote: "Renewed the vault licence key today.", score: 1, item_id: proposes.id, description: proposes.description },
  ]);
  assertEquals(wouldBe(proposes.id), realRows(real, proposes.id, proposes.description));

  // The counts agree with the real run's, and the dry run wrote nothing.
  assertEquals(dry.rows, { proposed: 1, none_found: 2, no_evidence: { coverage: 1 } });
  assertEquals([dry.items_final, dry.pages, dry.llm_calls], [3, 5, 4]);
  assertEquals(dryDb.of("recheck_begin_scan").length + dryDb.of("recheck_commit_page").length + dryDb.of("recheck_record_run").length, 0);
});

// Re-review 1, P2. A dry run that leaves an item part-way (the time budget, or
// an error) must report the scan a real run stopped at the same point leaves in
// progress. The dry scan is in progress from a valid plan until its simulated
// final page, exactly as the real one is from begin until its final commit.
type Stop = "budget" | "model-error";
type ScanKind = "fresh" | "resumed";
async function partialRun(stop: Stop, scan: ScanKind, dryRun: boolean) {
  const it = item(1);
  // 35 candidates: after one page of ten, at least one more FULL page is unread,
  // whether the scan starts at the beginning or resumes after the tenth.
  const ts = thoughts(35);
  const db = new FakeDb([it], { [it.id]: ts });
  if (scan === "resumed") {
    const existing = { status: "existing", scan_id: SCAN, cursor_at: ts[9].created_at, cursor_id: ts[9].id, upper_at: UPPER_AT, upper_id: UPPER_ID, embedding_ids: [] };
    db.handlers.recheck_begin_scan = () => ({ data: [existing] });
    db.handlers.recheck_plan_scan = () => ({ data: [{ ...existing, scan_proposed: false }] });
  }
  let calls = 0, clock = 0;
  const llm: RecheckLlm = (m) => {
    calls += 1;
    // The clock passes the budget once the first page has been judged.
    if (stop === "budget") clock = 1_000_000;
    // The second page's answer is not the JSON object asked for.
    if (stop === "model-error" && calls === 2) return Promise.resolve("it looks done to me");
    return OPEN(m);
  };
  const s = await runRecheck(db, llm, { dryRun, budgetMs: 1000, now: () => clock, ...quiet });
  return { it, ts, db, s };
}
const stopShape = (s: Awaited<ReturnType<typeof runRecheck>>) =>
  [s.status, s.pages, s.llm_calls, s.items_budget_stopped, s.items_errored, s.items_final, s.rows.none_found];

for (const stop of ["budget", "model-error"] as const) {
  for (const scan of ["fresh", "resumed"] as const) {
    Deno.test(`dry run, partial exit (${stop}, ${scan} scan): recheck_incomplete and incomplete_ids equal the real run's, stopped at the same point`, async () => {
      const real = await partialRun(stop, scan, false);
      const dry = await partialRun(stop, scan, true);
      const id8 = real.it.id.slice(0, 8);
      // The real control: one page committed, then the stop; the scan is still in
      // progress by the database's own answer to that commit.
      assertEquals(real.db.of("recheck_commit_page").map((c) => c.p_final), [false]);
      assertEquals(stopShape(real.s), stop === "budget" ? ["partial", 1, 1, 1, 0, 0, 0] : ["partial", 1, 2, 0, 1, 0, 0]);
      assertEquals([real.s.recheck_incomplete, real.s.incomplete_ids], [1, [id8]]);
      // The dry run stopped at the same point: same pages read, same model calls, same exit.
      assertEquals(stopShape(dry.s), stopShape(real.s));
      assertEquals(dry.db.of("recheck_candidates"), real.db.of("recheck_candidates"));
      assertEquals(dry.db.of("recheck_candidates")[0].p_lower_id, scan === "resumed" ? dry.ts[9].id : null);
      assertEquals(dry.db.of("recheck_plan_scan").length, 1);
      // And it reports the unfinished scan the real run left behind.
      assertEquals([dry.s.recheck_incomplete, dry.s.incomplete_ids], [real.s.recheck_incomplete, real.s.incomplete_ids]);
      assertEquals([dry.s.recheck_incomplete, dry.s.incomplete_ids], [1, [id8]]);
      if (stop === "model-error") {
        assertEquals(dry.s.errors, real.s.errors);
        assertEquals(dry.s.errors, [{ item: id8, message: "the model's answer was not the JSON object asked for" }]);
      }
      // Still a dry run: nothing was written.
      assertEquals(dry.db.of("recheck_begin_scan").length + dry.db.of("recheck_commit_page").length + dry.db.of("recheck_record_run").length, 0);
    });
  }
}

Deno.test("dry run: a scan that would FINISH reports no scan in progress, as the real run leaves none: a short page, an empty first page, a final page that proposes, a resumed scan's last page", async () => {
  const proposing = thoughts(3);
  proposing[1].content = "Rotated the Railway deploy token 1 this morning.";
  const proposeLlm: RecheckLlm = () =>
    Promise.resolve(JSON.stringify({ verdict: "done", thought_id: proposing[1].id, quote: "Rotated the Railway deploy token 1 this morning." }));
  const cases: Array<{ name: string; ts: Thought[]; llm: RecheckLlm; resumed: boolean; proposed: number; noneFound: number }> = [
    { name: "a short first page", ts: thoughts(3), llm: OPEN, resumed: false, proposed: 0, noneFound: 1 },
    { name: "an empty first page (no candidates at all)", ts: [], llm: OPEN, resumed: false, proposed: 0, noneFound: 1 },
    { name: "a final page that proposes", ts: proposing, llm: proposeLlm, resumed: false, proposed: 1, noneFound: 0 },
    { name: "a resumed scan's last page", ts: thoughts(14), llm: OPEN, resumed: true, proposed: 0, noneFound: 1 },
  ];
  for (const c of cases) {
    const out = [];
    for (const dryRun of [false, true]) {
      const it = item(1);
      const db = new FakeDb([it], { [it.id]: c.ts });
      if (c.resumed) {
        const existing = { status: "existing", scan_id: SCAN, cursor_at: c.ts[9].created_at, cursor_id: c.ts[9].id, upper_at: UPPER_AT, upper_id: UPPER_ID, embedding_ids: [] };
        db.handlers.recheck_begin_scan = () => ({ data: [existing] });
        db.handlers.recheck_plan_scan = () => ({ data: [{ ...existing, scan_proposed: false }] });
      }
      const s = await runRecheck(db, c.llm, { dryRun, ...quiet });
      assertEquals([s.status, s.items_final, s.pages, s.rows.proposed, s.rows.none_found], ["ok", 1, 1, c.proposed, c.noneFound], `${c.name}, dryRun ${dryRun}`);
      out.push(s);
    }
    const [real, dry] = out;
    assertEquals([real.recheck_incomplete, real.incomplete_ids], [0, []], `${c.name}: the real control`);
    assertEquals([dry.recheck_incomplete, dry.incomplete_ids], [real.recheck_incomplete, real.incomplete_ids], c.name);
    assertEquals([dry.recheck_incomplete, dry.incomplete_ids], [0, []], c.name);
  }
});

Deno.test("dry run: an item with no valid plan reports no scan in progress: not open, a plan that fails, a plan with an unknown answer", async () => {
  const cases: Array<{ name: string; plan: Reply; shape: unknown[] }> = [
    {
      name: "not open",
      plan: { data: [{ status: "not_open", scan_id: null, cursor_at: null, cursor_id: null, upper_at: null, upper_id: null, embedding_ids: null, scan_proposed: false }] },
      shape: ["ok", 1, 0],
    },
    { name: "the plan fails", plan: { error: { code: "RC003", message: "unknown_item: no action item" } }, shape: ["partial", 0, 1] },
    {
      name: "an unknown answer",
      plan: { data: [{ status: "paused", scan_id: null, cursor_at: null, cursor_id: null, upper_at: UPPER_AT, upper_id: UPPER_ID, embedding_ids: [], scan_proposed: false }] },
      shape: ["partial", 0, 1],
    },
  ];
  for (const c of cases) {
    const it = item(1);
    const db = new FakeDb([it], { [it.id]: thoughts(3) });
    db.handlers.recheck_plan_scan = () => c.plan;
    const s = await runRecheck(db, OPEN, { dryRun: true, ...quiet });
    assertEquals([s.status, s.items_not_open, s.items_errored], c.shape, c.name);
    assertEquals([s.recheck_incomplete, s.incomplete_ids, s.items_final, s.pages, s.would_be], [0, [], 0, 0, []], c.name);
    assertEquals(db.of("recheck_candidates").length, 0, c.name);
  }
});

Deno.test("run: the time budget stops new pages and new items, and says so", async () => {
  const a = item(1), b = item(2), c = item(3);
  const db = new FakeDb([a, b, c], { [a.id]: thoughts(25), [b.id]: thoughts(3, "c"), [c.id]: thoughts(3, "d") });
  let t = 0;
  // The clock jumps past the budget once the first item's first page has committed.
  const now = () => (db.of("recheck_commit_page").length >= 1 ? (t = 1_000_000) : t);
  const s = await runRecheck(db, OPEN, { dryRun: false, budgetMs: 1000, now, ...quiet });
  assertEquals(db.of("recheck_commit_page").length, 1);
  assertEquals([s.status, s.items_budget_stopped, s.items_not_started, s.recheck_incomplete, s.items_final], ["partial", 1, 2, 1, 0]);
});

Deno.test("run: the perpetual canary is skipped even if the database hands it over, and the run says so", async () => {
  const canary = item(1, "PERPETUAL auto-resolve canary: never complete this");
  const real = item(2);
  const db = new FakeDb([canary, real], { [canary.id]: thoughts(3), [real.id]: thoughts(3, "c") });
  const s = await runRecheck(db, OPEN, { dryRun: false, ...quiet });
  assertEquals(db.calls.filter((c) => c.args.p_item_id === canary.id).length, 0);
  assertEquals([s.status, s.items_canary_skipped, s.items_final], ["partial", 1, 1]);
});

Deno.test("run: a failed client or eligibility read fails the run, scans nothing and still writes its receipt", async () => {
  for (const fn of ["recheck_client_names", "recheck_eligible_items"]) {
    const it = item(1);
    const db = new FakeDb([it], { [it.id]: thoughts(3) });
    db.handlers[fn] = () => ({ error: { code: "42883", message: "function does not exist" } });
    const s = await runRecheck(db, OPEN, { dryRun: false, ...quiet });
    assertEquals([s.status, s.items_eligible, s.failure], ["failed", 0, `${fn} 42883: function does not exist`]);
    assertEquals(db.of("recheck_begin_scan").length, 0);
    assertEquals(db.of("recheck_record_run").map((r) => r.p_status), ["failed"]);
  }
  // A client list that is not a list of names is a failure too, not "no clients".
  const it = item(1);
  const db = new FakeDb([it], {});
  db.handlers.recheck_client_names = () => ({ data: null });
  assertEquals((await runRecheck(db, OPEN, { dryRun: false, ...quiet })).status, "failed");
});

Deno.test("run: the receipt carries the counts and no would-be rows; a receipt that fails to write is reported", async () => {
  const it = item(1);
  const db = new FakeDb([it], { [it.id]: thoughts(3) });
  const s = await runRecheck(db, OPEN, { dryRun: false, ...quiet });
  const receipt = db.of("recheck_record_run")[0];
  assertEquals(receipt.p_started_at, s.started_at);
  const sent = receipt.p_summary as Record<string, unknown>;
  assertEquals("would_be" in sent, false);
  assertEquals([sent.items_final, sent.recheck_incomplete, sent.dry_run], [1, 0, false]);
  assertEquals(s.receipt_error, undefined);

  const db2 = new FakeDb([it], { [it.id]: thoughts(3) });
  db2.handlers.recheck_record_run = () => ({ error: { code: "23514", message: "violates check constraint" } });
  const s2 = await runRecheck(db2, OPEN, { dryRun: false, ...quiet });
  assertEquals(s2.receipt_error, "23514: violates check constraint");
});

Deno.test("run: the item cap is 40 and a smaller limit is passed through", async () => {
  const db = new FakeDb([], {});
  await runRecheck(db, OPEN, { dryRun: false, ...quiet });
  await runRecheck(db, OPEN, { dryRun: false, limit: 7, ...quiet });
  await runRecheck(db, OPEN, { dryRun: false, limit: 400, ...quiet });
  assertEquals(db.of("recheck_eligible_items"), [{ p_limit: 40 }, { p_limit: 7 }, { p_limit: 40 }]);
});

Deno.test("run: items are worked several at a time and every one is accounted for", async () => {
  const items = Array.from({ length: 9 }, (_, i) => item(i + 1));
  const by: Record<string, Thought[]> = {};
  for (const it of items) by[it.id] = thoughts(3);
  const db = new FakeDb(items, by);
  let inFlight = 0, most = 0;
  const slow: RecheckLlm = async (m) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return OPEN(m);
  };
  const s = await runRecheck(db, slow, { dryRun: false, log: () => {}, concurrency: 4 });
  assertEquals([s.items_eligible, s.items_final, s.pages], [9, 9, 9]);
  assertEquals(most, 4, "four items at a time: not one, and not all nine");
  assertEquals(new Set(db.of("recheck_commit_page").map((c) => c.p_item_id)).size, 9);
});

// ---------------------------------------------------------------------------
// Cold-start correction (production finding, 2026-11-19): the serial warm-up,
// the retry of a plan the statement timeout cancelled, and the error stamp.
// ---------------------------------------------------------------------------
const TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" };
const POS = (n: number) => ({ at: `2026-11-0${n}T00:00:00.00000${n}+00:00`, id: `e000000${n}-0000-4000-8000-000000000000` });
/** A database whose warm-up has `chunks` full chunks and then a short last one. */
function warmScript(db: FakeDb, fullChunks: number, lastRows = 17) {
  db.handlers.recheck_warm_embeddings = (_a, n) =>
    n <= fullChunks
      ? { data: [{ rows_read: WARM_CHUNK_ROWS, last_at: POS(n).at, last_id: POS(n).id, done: false }] }
      : { data: [{ rows_read: lastRows, last_at: POS(n).at, last_id: POS(n).id, done: true }] };
}
const fns = (db: FakeDb) => db.calls.map((c) => c.fn);

for (const dryRun of [false, true]) {
  Deno.test(`warm-up (${dryRun ? "dry run" : "real run"}): before any item, chunk after chunk, each call carrying the last position as received, until the database says done`, async () => {
    const a = item(1), b = item(2);
    const db = new FakeDb([a, b], { [a.id]: thoughts(2), [b.id]: thoughts(2, "c") });
    warmScript(db, 2);
    const s = await runRecheck(db, OPEN, { dryRun, log: () => {}, concurrency: 2 });
    assertEquals(db.of("recheck_warm_embeddings"), [
      { p_item_ids: [a.id, b.id], p_after_at: null, p_after_id: null, p_limit: 250 },
      { p_item_ids: [a.id, b.id], p_after_at: POS(1).at, p_after_id: POS(1).id, p_limit: 250 },
      { p_item_ids: [a.id, b.id], p_after_at: POS(2).at, p_after_id: POS(2).id, p_limit: 250 },
    ]);
    assert(POS(2).at.includes(".000002"), "the position keeps its microseconds");
    assertEquals(WARM_CHUNK_ROWS, 250);
    const order = fns(db);
    assertEquals(order.slice(0, 5), ["recheck_client_names", "recheck_eligible_items", "recheck_warm_embeddings", "recheck_warm_embeddings", "recheck_warm_embeddings"],
      "eligibility, then the whole warm-up, before any item's first call");
    assertEquals(order.lastIndexOf("recheck_warm_embeddings"), 4);
    assertEquals(order.indexOf("recheck_source_embedding"), 5);
    assertEquals({ ...s.warmup, ms: 0 }, { chunks: 3, rows: 517, ms: 0, complete: true, stopped: null, error: null });
    assertEquals([s.status, s.items_final, s.timeout_retries], ["ok", 2, 0]);
    if (dryRun) {
      assertEquals(order.filter((f) => ["recheck_begin_scan", "recheck_commit_page", "recheck_record_run", "recheck_note_error"].includes(f)), []);
    } else {
      const receipt = db.of("recheck_record_run")[0].p_summary as Record<string, unknown>;
      assertEquals([(receipt.warmup as { rows: number }).rows, receipt.timeout_retries, receipt.items_error_noted, receipt.error_notes_refused, receipt.error_notes_failed], [517, 0, 0, 0, 0]);
    }
  });
}

Deno.test("warm-up: it is asked only for items that would begin a scan: an item mid-scan and the canary are left out; with nothing to warm for, no call is made", async () => {
  const fresh = item(1), midScan = { ...item(2), recheck_scan_id: SCAN }, canary = item(3, "PERPETUAL auto-resolve canary: never complete this");
  const db = new FakeDb([midScan, fresh, canary], { [fresh.id]: thoughts(1), [midScan.id]: thoughts(1, "c") });
  const s = await runRecheck(db, OPEN, { dryRun: true, ...quiet });
  assertEquals(db.of("recheck_warm_embeddings").map((c) => c.p_item_ids), [[fresh.id]]);
  assertEquals(s.warmup.complete, true);

  const only = new FakeDb([midScan, canary], { [midScan.id]: thoughts(1, "c") });
  const s2 = await runRecheck(only, OPEN, { dryRun: true, ...quiet });
  assertEquals(only.of("recheck_warm_embeddings").length, 0);
  assertEquals([s2.warmup.complete, s2.warmup.chunks, s2.warmup.stopped], [true, 0, null]);

  const none = new FakeDb([], {});
  const s3 = await runRecheck(none, OPEN, { dryRun: true, ...quiet });
  assertEquals([none.of("recheck_warm_embeddings").length, s3.warmup.complete], [0, true]);

  const failed = new FakeDb([fresh], {});
  failed.handlers.recheck_eligible_items = () => ({ error: { code: "42883", message: "function does not exist" } });
  const s4 = await runRecheck(failed, OPEN, { dryRun: true, ...quiet });
  assertEquals([failed.of("recheck_warm_embeddings").length, s4.status], [0, "failed"]);
});

Deno.test("warm-up: it stops at its share of the time budget, says so, and the items still run", async () => {
  assertEquals(WARM_BUDGET_FRACTION, 0.4);
  for (const [clockAfterTwo, wantCalls, wantStopped] of [[400, 4, null], [401, 2, "budget"]] as const) {
    const it = item(1);
    const db = new FakeDb([it], { [it.id]: thoughts(2) });
    warmScript(db, 3);
    // The clock stands at 0, then at clockAfterTwo once two chunks are read. The budget is 1000 ms, its warm share 400.
    const now = () => (db.of("recheck_warm_embeddings").length >= 2 ? clockAfterTwo : 0);
    const s = await runRecheck(db, OPEN, { dryRun: false, budgetMs: 1000, now, ...quiet });
    assertEquals([db.of("recheck_warm_embeddings").length, s.warmup.stopped, s.warmup.complete, s.warmup.rows], [wantCalls, wantStopped, wantStopped === null, wantStopped === null ? 767 : 500]);
    assertEquals([s.status, s.items_final, s.items_not_started], ["ok", 1, 0], "an unfinished warm-up is not an item failure, and the run's own budget is not used up");
  }
});

Deno.test("warm-up: a database that never says done is left at the chunk cap; one that does not advance, answers with no chunk, or fails is left at once; the items still run", async () => {
  const it = item(1);
  const capped = new FakeDb([it], { [it.id]: thoughts(2) });
  capped.handlers.recheck_warm_embeddings = (_a, n) => ({ data: [{ rows_read: 250, last_at: `2026-11-01T00:00:00.${String(n).padStart(6, "0")}+00:00`, last_id: POS(1).id, done: false }] });
  const s = await runRecheck(capped, OPEN, { dryRun: false, ...quiet });
  assertEquals(WARM_MAX_CHUNKS, 400);
  assertEquals([capped.of("recheck_warm_embeddings").length, s.warmup.stopped, s.warmup.complete, s.warmup.chunks, s.status, s.items_final], [400, "chunk_cap", false, 400, "ok", 1]);

  const stuck = new FakeDb([it], { [it.id]: thoughts(2) });
  stuck.handlers.recheck_warm_embeddings = () => ({ data: [{ rows_read: 250, last_at: POS(1).at, last_id: POS(1).id, done: false }] });
  const s2 = await runRecheck(stuck, OPEN, { dryRun: false, ...quiet });
  assertEquals([stuck.of("recheck_warm_embeddings").length, s2.warmup.stopped, s2.warmup.error, s2.status, s2.items_final],
    [2, "error", "recheck_warm_embeddings did not advance", "ok", 1]);

  // A second chunk that names no position: the loop does not go back to the start.
  const lost = new FakeDb([it], { [it.id]: thoughts(2) });
  lost.handlers.recheck_warm_embeddings = (_a, n) => ({ data: [{ rows_read: 250, last_at: n === 1 ? POS(1).at : null, last_id: n === 1 ? POS(1).id : null, done: false }] });
  const s3 = await runRecheck(lost, OPEN, { dryRun: false, ...quiet });
  assertEquals([lost.of("recheck_warm_embeddings").length, s3.warmup.stopped, s3.warmup.error, s3.warmup.chunks], [2, "error", "recheck_warm_embeddings did not advance", 2]);
  const halfLost = new FakeDb([it], { [it.id]: thoughts(2) });
  halfLost.handlers.recheck_warm_embeddings = (_a, n) => ({ data: [{ rows_read: 250, last_at: POS(n).at, last_id: n === 1 ? POS(1).id : null, done: false }] });
  assertEquals([(await runRecheck(halfLost, OPEN, { dryRun: false, ...quiet })).warmup.error, halfLost.of("recheck_warm_embeddings").length], ["recheck_warm_embeddings did not advance", 2]);

  for (const [reply, message] of [
    [{ data: [{ rows_read: 250, last_at: null, last_id: null, done: false }] }, "recheck_warm_embeddings did not advance"],
    [{ data: [{ last_at: POS(1).at, last_id: POS(1).id, done: true }] }, "recheck_warm_embeddings did not return a chunk"],
    [{ data: [{ rows_read: 3, last_at: POS(1).at, last_id: POS(1).id }] }, "recheck_warm_embeddings did not return a chunk"],
    [{ data: [] }, "recheck_warm_embeddings did not return a chunk"],
    [{ error: { code: "42883", message: "function does not exist" } }, "recheck_warm_embeddings 42883: function does not exist"],
  ] as Array<[Reply, string]>) {
    const db = new FakeDb([it], { [it.id]: thoughts(2) });
    db.handlers.recheck_warm_embeddings = () => reply;
    const r = await runRecheck(db, OPEN, { dryRun: false, ...quiet });
    assertEquals([db.of("recheck_warm_embeddings").length, r.warmup.stopped, r.warmup.complete, r.warmup.error, r.status, r.items_final, r.items_errored],
      [1, "error", false, message, "ok", 1, 0]);
  }
});

Deno.test("warm-up: a chunk the statement timeout cancelled is read again with the same position; cancelled on every try, the warm-up stops and the items run", async () => {
  const it = item(1);
  const db = new FakeDb([it], { [it.id]: thoughts(2) });
  db.handlers.recheck_warm_embeddings = (_a, n) =>
    n === 2 ? { error: TIMEOUT } : n === 1
      ? { data: [{ rows_read: 250, last_at: POS(1).at, last_id: POS(1).id, done: false }] }
      : { data: [{ rows_read: 9, last_at: POS(2).at, last_id: POS(2).id, done: true }] };
  const s = await runRecheck(db, OPEN, { dryRun: false, ...quiet });
  const calls = db.of("recheck_warm_embeddings");
  assertEquals(calls.length, 3);
  assertEquals(calls[1], calls[2], "the retried chunk asks for the same rows");
  assertEquals([calls[1].p_after_at, s.warmup.complete, s.warmup.chunks, s.warmup.rows, s.timeout_retries, s.status], [POS(1).at, true, 2, 259, 1, "ok"]);

  const always = new FakeDb([it], { [it.id]: thoughts(2) });
  always.handlers.recheck_warm_embeddings = () => ({ error: TIMEOUT });
  const s2 = await runRecheck(always, OPEN, { dryRun: false, ...quiet });
  assertEquals(TIMEOUT_ATTEMPTS, 2);
  assertEquals([always.of("recheck_warm_embeddings").length, s2.warmup.stopped, s2.warmup.error, s2.timeout_retries, s2.status, s2.items_final],
    [2, "error", "recheck_warm_embeddings 57014: canceling statement due to statement timeout", 1, "ok", 1]);
});

for (const dryRun of [false, true]) {
  const beginFn = dryRun ? "recheck_plan_scan" : "recheck_begin_scan";
  Deno.test(`timeout retry (${dryRun ? "dry run" : "real run"}): a ${beginFn} the statement timeout cancelled is tried once more with the same arguments, and the item goes on`, async () => {
    const it = item(1);
    const db = new FakeDb([it], { [it.id]: thoughts(3) });
    const base = db.handlers[beginFn];
    db.handlers[beginFn] = (a, n) => (n === 1 ? { error: TIMEOUT } : base(a, n));
    const s = await runRecheck(db, OPEN, { dryRun, ...quiet });
    assertEquals(db.of(beginFn).length, 2);
    assertEquals(db.of(beginFn)[0], db.of(beginFn)[1]);
    assertEquals([s.status, s.items_final, s.items_errored, s.timeout_retries, s.errors, db.of("recheck_note_error").length], ["ok", 1, 0, 1, [], 0]);
  });

  Deno.test(`timeout retry (${dryRun ? "dry run" : "real run"}): cancelled on every try, ${beginFn} is called ${TIMEOUT_ATTEMPTS} times and no more; the item is an error with no scan, and the next item runs`, async () => {
    const a = item(1), b = item(2);
    const db = new FakeDb([a, b], { [a.id]: thoughts(3), [b.id]: thoughts(3, "c") });
    const base = db.handlers[beginFn];
    db.handlers[beginFn] = (args, n) => (args.p_item_id === a.id ? { error: TIMEOUT } : base(args, n));
    const s = await runRecheck(db, OPEN, { dryRun, ...quiet });
    assertEquals(db.of(beginFn).filter((c) => c.p_item_id === a.id).length, 2);
    assertEquals([s.status, s.items_errored, s.items_final, s.recheck_incomplete, s.timeout_retries], ["partial", 1, 1, 0, 1]);
    assertEquals(s.errors, [{ item: "a0000001", message: `${beginFn} 57014: canceling statement due to statement timeout` }]);
    assertEquals(db.of("recheck_candidates").filter((c) => c.p_item_id === a.id).length, 0);
    // The real run stamps the item it gave up on; the dry run writes nothing.
    assertEquals(db.of("recheck_note_error"), dryRun ? [] : [{ p_item_id: a.id }]);
    assertEquals([s.items_error_noted, s.error_notes_refused, s.error_notes_failed], [dryRun ? 0 : 1, 0, 0]);
  });
}

Deno.test("timeout retry: only the statement timeout is retried, only on the plan or begin, and not once the run's budget has ended", async () => {
  // Another error on begin: one call.
  for (const error of [{ code: "RC003", message: "unknown_item: no action item" }, { code: "57P01", message: "terminating connection" }, { code: "40P01", message: "deadlock detected" }, { message: "no code at all" }]) {
    const it = item(1);
    const db = new FakeDb([it], { [it.id]: thoughts(3) });
    db.handlers.recheck_begin_scan = () => ({ error });
    const s = await runRecheck(db, OPEN, { dryRun: false, ...quiet });
    assertEquals([db.of("recheck_begin_scan").length, s.items_errored, s.timeout_retries], [1, 1, 0]);
  }
  // A statement timeout on the candidate page or the source read: one call, an item error.
  for (const fn of ["recheck_candidates", "recheck_source_embedding"]) {
    const it = item(1);
    const db = new FakeDb([it], { [it.id]: thoughts(3) });
    db.handlers[fn] = () => ({ error: TIMEOUT });
    const s = await runRecheck(db, OPEN, { dryRun: false, ...quiet });
    assertEquals([db.of(fn).length, s.items_errored, s.timeout_retries], [1, 1, 0]);
  }
  // The budget ends while the first try is running: no second try.
  const it = item(1);
  const db = new FakeDb([it], { [it.id]: thoughts(3) });
  db.handlers.recheck_begin_scan = () => ({ error: TIMEOUT });
  const now = () => (db.of("recheck_begin_scan").length >= 1 ? 1_000_000 : 0);
  const s = await runRecheck(db, OPEN, { dryRun: false, budgetMs: 1000, now, ...quiet });
  assertEquals([db.of("recheck_begin_scan").length, s.items_errored, s.timeout_retries, s.status], [1, 1, 0, "partial"]);
});

Deno.test("error stamp: a real run stamps every item it gives up on with an error, before or after its scan began, and no other; a dry run stamps none", async () => {
  const build = () => {
    const beforeBegin = item(1), atBegin = item(2), afterBegin = item(3, "renew the vault licence key"), fine = item(4), fivePages = item(5), closed = item(6);
    const canary = item(7, "PERPETUAL auto-resolve canary: never complete this");
    const db = new FakeDb([beforeBegin, atBegin, afterBegin, fine, fivePages, closed, canary], {
      [afterBegin.id]: thoughts(15), [fine.id]: thoughts(2, "c"), [fivePages.id]: thoughts(50, "d"),
    });
    const src = db.handlers.recheck_source_embedding;
    db.handlers.recheck_source_embedding = (a, n) => (a.p_item_id === beforeBegin.id ? { error: { code: "XX000", message: "source read failed" } } : src(a, n));
    for (const fn of ["recheck_begin_scan", "recheck_plan_scan"]) {
      const base = db.handlers[fn];
      db.handlers[fn] = (a, n) =>
        a.p_item_id === atBegin.id ? { error: { code: "RC003", message: "unknown_item" } }
          : a.p_item_id === closed.id ? { data: [{ status: "not_open", scan_id: null, cursor_at: null, cursor_id: null, upper_at: null, upper_id: null, embedding_ids: null, scan_proposed: false }] }
          : base(a, n);
    }
    let callsForAfter = 0;
    const llm: RecheckLlm = (m) => {
      if (m[1].content.includes("ITEM: renew the vault licence key") && ++callsForAfter === 2) return Promise.reject(new Error("OpenRouter 503"));
      return OPEN(m);
    };
    return { db, llm, ids: { beforeBegin: beforeBegin.id, atBegin: atBegin.id, afterBegin: afterBegin.id } };
  };
  const real = build();
  const s = await runRecheck(real.db, real.llm, { dryRun: false, ...quiet });
  assertEquals([s.items_errored, s.items_final, s.recheck_incomplete, s.items_not_open, s.items_canary_skipped], [3, 1, 2, 1, 1]);
  assertEquals(real.db.of("recheck_note_error"), [{ p_item_id: real.ids.beforeBegin }, { p_item_id: real.ids.atBegin }, { p_item_id: real.ids.afterBegin }]);
  assertEquals([s.items_error_noted, s.error_notes_refused, s.error_notes_failed], [3, 0, 0]);
  // Each stamp follows its own item's last call and precedes the receipt.
  const order = real.db.calls.map((c) => `${c.fn}:${String(c.args.p_item_id ?? "").slice(0, 8)}`);
  assert(order.indexOf("recheck_note_error:a0000001") < order.indexOf("recheck_source_embedding:a0000002"), "stamped as soon as the item ended, before the next item began");
  assert(order.lastIndexOf("recheck_note_error:a0000003") < order.indexOf("recheck_record_run:"));

  const dry = build();
  const d = await runRecheck(dry.db, dry.llm, { dryRun: true, ...quiet });
  assertEquals([d.items_errored, dry.db.of("recheck_note_error").length, d.items_error_noted, d.error_notes_refused, d.error_notes_failed], [3, 0, 0, 0, 0]);
});

Deno.test("error stamp: a stamp whose RPC errors or throws is counted as failed; the item's own error stands, the run finishes and writes its receipt", async () => {
  for (const refuse of ["error", "throw"] as const) {
    const a = item(1), b = item(2);
    const db = new FakeDb([a, b], { [b.id]: thoughts(2, "c") });
    db.handlers.recheck_begin_scan = (args) =>
      args.p_item_id === a.id ? { error: { code: "RC003", message: "unknown_item" } }
        : { data: [{ status: "began", scan_id: SCAN, cursor_at: null, cursor_id: null, upper_at: UPPER_AT, upper_id: UPPER_ID, embedding_ids: [] }] };
    db.handlers.recheck_note_error = () => {
      if (refuse === "throw") throw new Error("connection reset");
      return { error: { code: "42501", message: "permission denied" } };
    };
    const s = await runRecheck(db, OPEN, { dryRun: false, ...quiet });
    assertEquals([s.status, s.items_errored, s.items_final, s.items_error_noted, s.error_notes_refused, s.error_notes_failed], ["partial", 1, 1, 0, 0, 1]);
    assertEquals(s.errors, [{ item: "a0000001", message: "recheck_begin_scan RC003: unknown_item" }]);
    assertEquals(db.of("recheck_record_run").length, 1);
    assertEquals(stampCounts(db.of("recheck_record_run")[0].p_summary), [0, 0, 1]);
  }
});

// The three stamp counts, from a summary or from the receipt's copy of it.
function stampCounts(o: unknown): unknown[] {
  const r = o as Record<string, unknown>;
  return [r.items_error_noted, r.error_notes_refused, r.error_notes_failed];
}
// One real run of one item whose begin is cancelled, with the stamp answering as given.
async function runWithStampAnswer(answer: () => Reply) {
  const it = item(1);
  const db = new FakeDb([it], {});
  db.handlers.recheck_begin_scan = () => ({ error: TIMEOUT });
  db.handlers.recheck_note_error = answer;
  const errors: string[] = [];
  const consoleError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  let s: RunSummary;
  try {
    s = await runRecheck(db, OPEN, { dryRun: false, ...quiet });
  } finally {
    console.error = consoleError;
  }
  return { s, db, it, errors, receipt: db.of("recheck_record_run")[0].p_summary as Record<string, unknown> };
}

Deno.test("error stamp: an answer of false (the item was closed between its error and the stamp) is not a written stamp: counted as refused, not as noted and not as failed, in the summary and in the receipt", async () => {
  // recheck_note_error returns false, with no error, when the locked item is no longer open.
  const { s, db, it, errors, receipt } = await runWithStampAnswer(() => ({ data: false, error: null }));
  assertEquals(db.of("recheck_note_error"), [{ p_item_id: it.id }], "asked once, not asked again");
  assertEquals(stampCounts(s), [0, 1, 0], "false means no stamp was written");
  assertEquals(stampCounts(receipt), [0, 1, 0], "the durable receipt must not claim a stamp");
  // The refusal changes nothing else: the item's own error stands and the run is partial.
  assertEquals([s.status, s.items_errored, s.errors, receipt.status, receipt.items_errored],
    ["partial", 1, [{ item: "a0000001", message: "recheck_begin_scan 57014: canceling statement due to statement timeout" }], "partial", 1]);
  // A refusal is not a fault: nothing is logged as an error for it.
  assertEquals(errors.filter((l) => l.includes("error stamp")), []);
  // Control: the same run with an answer of true is one written stamp.
  const yes = await runWithStampAnswer(() => ({ data: true, error: null }));
  assertEquals([stampCounts(yes.s), stampCounts(yes.receipt)], [[1, 0, 0], [1, 0, 0]]);
});

Deno.test("error stamp: an answer that is neither true nor false is a failed stamp, never a written one and never a refusal", async () => {
  const answers: Array<[string, unknown]> = [
    ["null", null], ["the string true", "true"], ["the string false", "false"], ["the string t", "t"],
    ["one", 1], ["zero", 0], ["a list holding true", [true]], ["an empty list", []], ["a row object", { recheck_note_error: true }],
  ];
  for (const [label, data] of answers) {
    const { s, receipt, errors } = await runWithStampAnswer(() => ({ data }));
    assertEquals(stampCounts(s), [0, 0, 1], `summary, stamp answered ${label}`);
    assertEquals(stampCounts(receipt), [0, 0, 1], `receipt, stamp answered ${label}`);
    assertEquals(errors.filter((l) => l.includes("answered neither true nor false")).length, 1, `logged, stamp answered ${label}`);
    assertEquals([s.status, s.items_errored], ["partial", 1]);
  }
  // The fake database turns a missing answer into null. A client that hands over
  // no data field at all is the same failed stamp.
  const it = item(1);
  const fake = new FakeDb([it], {});
  fake.handlers.recheck_begin_scan = () => ({ error: TIMEOUT });
  const noData = { rpc: (fn: string, args: Args) => (fn === "recheck_note_error" ? Promise.resolve({ error: null }) : fake.rpc(fn, args)) };
  const consoleError = console.error;
  console.error = () => {};
  try {
    const s = await runRecheck(noData as unknown as FakeDb, OPEN, { dryRun: false, ...quiet });
    assertEquals([stampCounts(s), stampCounts(fake.of("recheck_record_run")[0].p_summary)], [[0, 0, 1], [0, 0, 1]]);
  } finally {
    console.error = consoleError;
  }
});

Deno.test("error stamp: written, refused and failed stamps in one run are counted apart, every errored item is in exactly one count, and the receipt's counts are the summary's", async () => {
  const items = [1, 2, 3, 4, 5, 6].map((n) => item(n));
  const db = new FakeDb(items, {});
  db.handlers.recheck_begin_scan = () => ({ error: { code: "RC003", message: "unknown_item" } });
  const answers: Record<string, () => Reply> = {
    [items[0].id]: () => ({ data: true }),
    [items[1].id]: () => ({ data: false }),
    [items[2].id]: () => ({ data: false }),
    [items[3].id]: () => ({ error: { code: "42501", message: "permission denied" } }),
    [items[4].id]: () => ({ data: null }),
    [items[5].id]: () => { throw new Error("connection reset"); },
  };
  db.handlers.recheck_note_error = (a) => answers[a.p_item_id as string]();
  const consoleError = console.error;
  console.error = () => {};
  let s: RunSummary;
  try {
    s = await runRecheck(db, OPEN, { dryRun: false, ...quiet });
  } finally {
    console.error = consoleError;
  }
  assertEquals(db.of("recheck_note_error").map((c) => c.p_item_id), items.map((i) => i.id));
  assertEquals([s.items_errored, ...stampCounts(s)], [6, 1, 2, 3]);
  assertEquals(s.items_error_noted + s.error_notes_refused + s.error_notes_failed, s.items_errored);
  const receipt = db.of("recheck_record_run")[0].p_summary as Record<string, unknown>;
  assertEquals([receipt.items_errored, ...stampCounts(receipt)], [6, 1, 2, 3]);
  // The receipt is the summary: no field of it says something the response does not.
  const { would_be: _w, ...rest } = s;
  assertEquals(receipt, JSON.parse(JSON.stringify(rest)));
});
