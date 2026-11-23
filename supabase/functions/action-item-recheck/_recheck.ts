// Loop-closing Task 4.1: the run loop of the aged-item re-check.
//
// Every database call is an RPC from 20261119c_action_items_recheck.sql or
// 20261119ca_action_items_recheck_cold_start.sql, and the only writes are
// recheck_begin_scan, recheck_commit_page, the error stamp (recheck_note_error)
// and the run receipt (recheck_record_run). Nothing here changes an item's status: an accepted
// answer is a PROPOSAL row, reviewed later through Task 3.6.
//
// A real run, per eligible item (at most 40, scans in progress first):
//   begin (or resume) the scan, then up to 5 pages of 10 candidate thoughts;
//   each page is judged by the model and committed in ONE transaction with the
//   cursor. A page of fewer than 10 rows is final wherever it falls, page 5
//   included. Any error aborts the item before its next page: the cursor stays
//   at the last committed page and the next run resumes the same scan.
// A dry run reads the same things through recheck_plan_scan and
// recheck_candidates, calls the model, and writes NOTHING: no begin, no commit,
// no error stamp, no receipt. It reports the decision rows a real run would write, the final
// none_found row included: it resumes a scan in progress from that scan's
// stored cursor AND stored proposed flag (recheck_plan_scan returns both), so a
// scan that proposed on an earlier page reports no none_found here either.
// Its would-be rows are returned and logged for a hand read. It also reports
// the scans a real run stopped at the same point would leave in progress
// (recheck_incomplete): a dry scan is in progress from its plan until its
// simulated final page, whether the item stops on five full pages, the time
// budget or an error.
//
// The cold start (production finding, 2026-11-19; SQL in
// 20261119ca_action_items_recheck_cold_start.sql). A plan orders every thought
// of the item's window by exact distance, so it reads every embedding in the
// window, and with a cold cache that read did not fit in PostgREST's 8 second
// statement timeout. Three things answer it, in this order:
//   1. Before any item starts, the run warms the embeddings its plans will
//      read: recheck_warm_embeddings, one bounded chunk per call, serially,
//      inside a share of the run's time budget. Each statement is small
//      however large the window is, and it is a read, so a dry run does it too.
//   2. A plan (or begin) cancelled by the statement timeout (SQLSTATE 57014) is
//      tried once more, unless the budget has ended: the cancelled attempt
//      left the pages it read in cache. TIMEOUT_ATTEMPTS bounds it; a
//      persistent failure is an item error, as before.
//   3. A real run records every item it gives up on with an error
//      (recheck_note_error), so the item sorts behind the items that have
//      waited longer instead of first every night. A dry run records nothing.
//      The stamp answers true when it was written and false when the item was
//      closed between its error and the stamp (nothing is written then). Only
//      true is counted as written (items_error_noted); false is counted as
//      refused (error_notes_refused); an RPC error, an exception, or any other
//      answer is counted as failed (error_notes_failed).
//
// Cursor values are the database's own timestamp strings and are passed back
// exactly as received. They carry microseconds; a JavaScript Date would round
// them and every commit would be refused as stale.

import { rpcWithDeadlockRetry } from "../_shared/action-item-transition.ts";
import { isPerpetualCanaryText } from "../_shared/archive-policy.ts";
import {
  buildRecheckPrompt,
  ITEM_CAP,
  judgeAnswer,
  MAX_PAGES_PER_ITEM,
  mergeRows,
  PAGE_SIZE,
  type PageThought,
  parseRecheckAnswer,
  planRecheckCalls,
  type RecheckRow,
} from "./_prompt.ts";

type RpcError = { code?: string; message?: string } | null;
export type RecheckDb = {
  // deno-lint-ignore no-explicit-any
  rpc: (fn: string, args: Record<string, unknown>) => any;
};
export type RecheckLlm = (messages: Array<{ role: string; content: string }>) => Promise<string>;

export const DEFAULT_BUDGET_MS = 100_000;
export const DEFAULT_CONCURRENCY = 4;
export const ERROR_LIST_MAX = 20;
/** Embeddings read by one warm-up statement. */
export const WARM_CHUNK_ROWS = 250;
/** A stop for the warm-up loop, not a target: 400 chunks is 100,000 embeddings. */
export const WARM_MAX_CHUNKS = 400;
/** The share of the run's time budget the warm-up may use before the items start regardless. */
export const WARM_BUDGET_FRACTION = 0.4;
/** Tries of one statement that the statement timeout cancels (1 means no retry). */
export const TIMEOUT_ATTEMPTS = 2;
const STATEMENT_TIMEOUT = "57014";

export type RecheckOptions = {
  dryRun: boolean;
  limit?: number;
  budgetMs?: number;
  concurrency?: number;
  now?: () => number;
  log?: (line: string) => void;
};

type EligibleItem = {
  id: string;
  description: string;
  created_at: string;
  src_project: string | null;
  recheck_scan_id?: string | null;
};

/** What the warm-up did. It never fails a run: a plan that still meets a cold
 * cache has its own retry, and its own error if that fails too. */
export type Warmup = {
  chunks: number;
  rows: number;
  ms: number;
  /** True when the database said no embedding was left to read. */
  complete: boolean;
  stopped: null | "budget" | "chunk_cap" | "error";
  error: string | null;
};

/** One decision row a real run would write. The final none_found row, which a
 * real run's last commit writes inside the database, is listed here too. */
export type WouldBeRow = Omit<RecheckRow, "reason"> & {
  reason: RecheckRow["reason"] | "none_found";
  item_id: string;
  description: string;
};

export type ItemState =
  | "final" // the scan finished this run
  | "incomplete" // five full pages; the scan continues next run
  | "not_open" // the item stopped being open; nothing written
  | "error" // aborted before its next page
  | "budget" // the run's time budget ended mid-scan
  | "not_started" // the run's time budget ended before this item
  | "canary_skipped"; // the perpetual canary reached the loop (a defect)

export type RunSummary = {
  dry_run: boolean;
  started_at: string;
  finished_at: string;
  status: "ok" | "partial" | "failed";
  failure: string | null;
  items_eligible: number;
  items_final: number;
  recheck_incomplete: number;
  incomplete_ids: string[];
  items_errored: number;
  items_not_open: number;
  items_not_started: number;
  items_budget_stopped: number;
  items_canary_skipped: number;
  pages: number;
  llm_calls: number;
  rows: { proposed: number; none_found: number; no_evidence: Record<string, number> };
  inserted: number;
  errors: Array<{ item: string; message: string }>;
  warmup: Warmup;
  /** Statements cancelled by the statement timeout and tried again. */
  timeout_retries: number;
  /** Real run only, one count per errored item. items_error_noted: the stamp
   * answered true, so it was written and the item stops sorting first.
   * error_notes_refused: it answered false, the item was no longer open and
   * nothing was written. error_notes_failed: an RPC error, an exception, or an
   * answer that is neither true nor false; whether a stamp exists is unknown. */
  items_error_noted: number;
  error_notes_refused: number;
  error_notes_failed: number;
  receipt_error?: string;
  would_be?: WouldBeRow[];
};

class ItemAbort extends Error {}

function firstRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" ? row as Record<string, unknown> : null;
}

function errText(error: RpcError): string {
  return `${error?.code ?? "no code"}: ${String(error?.message ?? "unknown error").slice(0, 200)}`;
}

async function rpc(db: RecheckDb, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await db.rpc(fn, args) as { data: unknown; error: RpcError };
  if (error) throw new ItemAbort(`${fn} ${errText(error)}`);
  return data;
}

/** One RPC, tried again when the statement timeout cancelled it: at most
 * TIMEOUT_ATTEMPTS tries, and no further try once mayRetry says no. Only for
 * statements that are safe to repeat: a read, or a write whose cancelled
 * transaction wrote nothing (recheck_begin_scan). */
async function rpcRetryingTimeout(
  db: RecheckDb,
  fn: string,
  args: Record<string, unknown>,
  mayRetry: () => boolean,
  onRetry: () => void,
): Promise<{ data: unknown; error: RpcError }> {
  for (let attempt = 1;; attempt++) {
    const r = await db.rpc(fn, args) as { data: unknown; error: RpcError };
    if (r.error?.code !== STATEMENT_TIMEOUT || attempt >= TIMEOUT_ATTEMPTS || !mayRetry()) return r;
    onRetry();
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

type ItemResult = {
  id: string;
  state: ItemState;
  scanActive: boolean;
  pages: number;
  calls: number;
  sent: RecheckRow[];
  inserted: number;
  noneFound: number;
  wouldBe: WouldBeRow[];
  error: string | null;
  timeoutRetries: number;
  /** Real run, errored item: what the error stamp answered. "yes" only for
   * true; "refused" for false (the item was closed first); "failed" for
   * anything else. "no": no stamp was attempted. */
  noted: "no" | "yes" | "refused" | "failed";
};

/** Read, chunk by chunk and one statement at a time, the embeddings the plans
 * of these items are about to read. Stops when the database says none is left,
 * at the warm share of the budget, at the chunk cap, or on an error. */
async function warmEmbeddings(
  db: RecheckDb,
  items: EligibleItem[],
  now: () => number,
  startedMs: number,
  warmBudgetMs: number,
  onRetry: () => void,
): Promise<Warmup> {
  const w: Warmup = { chunks: 0, rows: 0, ms: 0, complete: false, stopped: null, error: null };
  const t0 = now();
  // An item mid-scan resumes from its frozen ids and runs no search.
  const ids = items.filter((i) => !i.recheck_scan_id && !isPerpetualCanaryText(i.description)).map((i) => i.id);
  if (ids.length === 0) {
    w.complete = true;
    return w;
  }
  const inBudget = () => now() - startedMs <= warmBudgetMs;
  let afterAt: string | null = null;
  let afterId: string | null = null;
  try {
    while (true) {
      if (w.chunks >= WARM_MAX_CHUNKS) {
        w.stopped = "chunk_cap";
        break;
      }
      if (!inBudget()) {
        w.stopped = "budget";
        break;
      }
      const { data, error } = await rpcRetryingTimeout(db, "recheck_warm_embeddings", {
        p_item_ids: ids,
        p_after_at: afterAt,
        p_after_id: afterId,
        p_limit: WARM_CHUNK_ROWS,
      }, inBudget, onRetry);
      if (error) throw new ItemAbort(`recheck_warm_embeddings ${errText(error)}`);
      const row = firstRow(data);
      if (!row || typeof row.rows_read !== "number" || typeof row.done !== "boolean") {
        throw new ItemAbort("recheck_warm_embeddings did not return a chunk");
      }
      w.chunks += 1;
      w.rows += row.rows_read;
      if (row.done) {
        w.complete = true;
        break;
      }
      const lastAt = str(row.last_at);
      const lastId = str(row.last_id);
      if (!lastAt || !lastId || (lastAt === afterAt && lastId === afterId)) {
        throw new ItemAbort("recheck_warm_embeddings did not advance");
      }
      afterAt = lastAt;
      afterId = lastId;
    }
  } catch (e) {
    w.stopped = "error";
    w.error = (e instanceof Error ? e.message : String(e)).slice(0, 240);
  }
  w.ms = now() - t0;
  return w;
}

async function processItem(
  db: RecheckDb,
  llm: RecheckLlm,
  item: EligibleItem,
  clientNames: readonly string[],
  dryRun: boolean,
  overBudget: () => boolean,
): Promise<ItemResult> {
  const res: ItemResult = {
    id: item.id, state: "error", scanActive: false, pages: 0, calls: 0,
    sent: [], inserted: 0, noneFound: 0, wouldBe: [], error: null, timeoutRetries: 0, noted: "no",
  };
  try {
    const src = firstRow(await rpc(db, "recheck_source_embedding", { p_item_id: item.id }));
    // An opaque value: handed back to the database exactly as it came.
    const embedding = src?.embedding ?? null;

    // The one statement that reads the window's embeddings. Cancelled by the
    // statement timeout, it is tried once more: nothing was written (the
    // cancelled begin rolled back) and what it read is now in cache.
    const beginFn = dryRun ? "recheck_plan_scan" : "recheck_begin_scan";
    const begin = await rpcRetryingTimeout(db, beginFn, {
      p_item_id: item.id,
      p_query_embedding: embedding,
    }, () => !overBudget(), () => { res.timeoutRetries += 1; });
    if (begin.error) throw new ItemAbort(`${beginFn} ${errText(begin.error)}`);
    const begun = firstRow(begin.data);
    const beginStatus = str(begun?.status);
    if (beginStatus === "not_open") {
      res.state = "not_open";
      return res;
    }
    if (!begun || !["began", "existing", "would_begin"].includes(beginStatus ?? "")) {
      throw new ItemAbort(`begin answered ${JSON.stringify(begun?.status ?? null)}`);
    }
    const scanId = str(begun.scan_id);
    if (!dryRun && !scanId) throw new ItemAbort("begin returned no scan id");
    const upperAt = str(begun.upper_at);
    const upperId = str(begun.upper_id);
    if (!upperAt || !upperId) throw new ItemAbort("begin returned no upper bound");
    const embeddingIds = Array.isArray(begun.embedding_ids) ? begun.embedding_ids : [];
    let cursorAt = str(begun.cursor_at);
    let cursorId = str(begun.cursor_id);
    // Dry run only: whether this scan has proposed so far. It starts from the
    // flag the database holds for a scan in progress (false for a scan that
    // would begin now), as the real final commit reads it. A plan that does not
    // say is not read as "no": the item is aborted.
    if (dryRun && typeof begun.scan_proposed !== "boolean") {
      throw new ItemAbort("the plan did not say whether the scan has proposed");
    }
    let proposed = dryRun && begun.scan_proposed === true;
    // From here the item has a scan in progress: begun or resumed by a real
    // run, and for a dry run the scan a real run would have at this point (one
    // it would begin, or the one the database already holds). It stays in
    // progress however the item leaves the loop (the time budget, an error,
    // five full pages) until a final page ends it: the commit's own answer in a
    // real run, the simulated final page in a dry run.
    res.scanActive = true;

    for (let page = 1; page <= MAX_PAGES_PER_ITEM; page++) {
      if (overBudget()) {
        res.state = "budget";
        return res;
      }
      const data = await rpc(db, "recheck_candidates", {
        p_item_id: item.id,
        p_lower_at: cursorAt ?? item.created_at,
        p_lower_id: cursorId,
        p_upper_at: upperAt,
        p_upper_id: upperId,
        p_embedding_ids: embeddingIds,
        p_limit: PAGE_SIZE,
      });
      if (!Array.isArray(data)) throw new ItemAbort("recheck_candidates did not return a list");
      const thoughts = data as PageThought[];
      // A short page is final wherever it falls; a full page never is.
      const isFinal = thoughts.length < PAGE_SIZE;

      let rows: RecheckRow[] = [];
      if (thoughts.length > 0) {
        const byId = new Map(thoughts.map((t) => [String(t.id).toLowerCase(), t]));
        const drafts: RecheckRow[] = [];
        for (const blocks of planRecheckCalls(thoughts)) {
          const raw = await llm(buildRecheckPrompt(item.description, blocks));
          res.calls += 1;
          const answer = parseRecheckAnswer(raw);
          if (!answer) throw new ItemAbort("the model's answer was not the JSON object asked for");
          const row = judgeAnswer(
            answer,
            { description: item.description, project: item.src_project ?? null },
            byId,
            clientNames,
          );
          if (row) drafts.push(row);
        }
        rows = mergeRows(drafts);
      }
      const last = thoughts.length > 0 ? thoughts[thoughts.length - 1] : null;

      if (dryRun) {
        res.pages += 1;
        res.sent.push(...rows);
        res.wouldBe.push(...rows.map((r) => ({ ...r, item_id: item.id, description: item.description })));
        if (rows.some((r) => r.outcome === "proposed")) proposed = true;
        if (isFinal) {
          // What the real final commit does: one none_found row, only when no
          // page of the whole scan proposed.
          if (!proposed) {
            res.noneFound += 1;
            res.wouldBe.push({
              outcome: "no_evidence", reason: "none_found", evidence_thought_id: null, quote: null, score: null,
              item_id: item.id, description: item.description,
            });
          }
          // The real final commit ends the scan; so does the simulated one.
          res.scanActive = false;
          res.state = "final";
          return res;
        }
        cursorAt = last!.created_at;
        cursorId = last!.id;
        continue;
      }

      const { data: committed, error } = await rpcWithDeadlockRetry(db, "recheck_commit_page", {
        p_item_id: item.id,
        p_scan_id: scanId,
        p_expected_cursor_at: cursorAt,
        p_expected_cursor_id: cursorId,
        p_cursor_at: last ? last.created_at : null,
        p_cursor_id: last ? last.id : null,
        p_rows: rows,
        p_final: isFinal,
      });
      if (error) throw new ItemAbort(`recheck_commit_page ${errText(error)}`);
      const c = firstRow(committed);
      const status = str(c?.status);
      if (!c || !status) throw new ItemAbort("recheck_commit_page returned no row");
      // The scan's state after THIS commit, from the commit's own answer: a
      // short fifth page that finalised is not incomplete.
      res.scanActive = c.scan_active === true;
      if (status === "not_open") {
        res.scanActive = false;
        res.state = "not_open";
        return res;
      }
      if (status === "already_final") {
        res.state = "final";
        return res;
      }
      if (status !== "committed" && status !== "final") {
        throw new ItemAbort(`recheck_commit_page answered ${status}`);
      }
      res.pages += 1;
      res.sent.push(...rows);
      res.inserted += typeof c.inserted === "number" ? c.inserted : 0;
      if (status === "final") {
        if (c.scan_proposed !== true) res.noneFound += 1;
        res.state = "final";
        return res;
      }
      cursorAt = str(c.cursor_at);
      cursorId = str(c.cursor_id);
      if (!cursorAt || !cursorId) throw new ItemAbort("a committed page returned no cursor");
    }
    // Five full pages: the scan stays active (a real run's fifth commit said
    // so; a dry run's simulated scan was never ended).
    res.state = "incomplete";
    return res;
  } catch (e) {
    res.state = "error";
    res.error = (e instanceof Error ? e.message : String(e)).slice(0, 240);
    return res;
  }
}

export async function runRecheck(
  db: RecheckDb,
  llm: RecheckLlm,
  options: RecheckOptions,
): Promise<RunSummary> {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.log(line));
  const startedMs = now();
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? ITEM_CAP), 1), ITEM_CAP);
  const concurrency = Math.min(Math.max(Math.trunc(options.concurrency ?? DEFAULT_CONCURRENCY), 1), 8);
  const overBudget = () => now() - startedMs > budgetMs;

  const summary: RunSummary = {
    dry_run: options.dryRun,
    started_at: new Date(startedMs).toISOString(),
    finished_at: "",
    status: "ok",
    failure: null,
    items_eligible: 0,
    items_final: 0,
    recheck_incomplete: 0,
    incomplete_ids: [],
    items_errored: 0,
    items_not_open: 0,
    items_not_started: 0,
    items_budget_stopped: 0,
    items_canary_skipped: 0,
    pages: 0,
    llm_calls: 0,
    rows: { proposed: 0, none_found: 0, no_evidence: {} },
    inserted: 0,
    errors: [],
    warmup: { chunks: 0, rows: 0, ms: 0, complete: false, stopped: null, error: null },
    timeout_retries: 0,
    items_error_noted: 0,
    error_notes_refused: 0,
    error_notes_failed: 0,
  };
  if (options.dryRun) summary.would_be = [];

  let items: EligibleItem[] = [];
  let clientNames: string[] = [];
  try {
    const names = await rpc(db, "recheck_client_names", {});
    if (!Array.isArray(names) || !names.every((n) => typeof n === "string")) {
      throw new ItemAbort("recheck_client_names did not return a list of names");
    }
    clientNames = names as string[];
    const eligible = await rpc(db, "recheck_eligible_items", { p_limit: limit });
    if (!Array.isArray(eligible)) throw new ItemAbort("recheck_eligible_items did not return a list");
    items = eligible as EligibleItem[];
  } catch (e) {
    summary.status = "failed";
    summary.failure = (e instanceof Error ? e.message : String(e)).slice(0, 240);
  }
  summary.items_eligible = items.length;

  // Before any item: the serial warm-up, inside its share of the budget.
  if (items.length > 0) {
    summary.warmup = await warmEmbeddings(db, items, now, startedMs, budgetMs * WARM_BUDGET_FRACTION,
      () => { summary.timeout_retries += 1; });
    if (summary.warmup.error) console.error(`recheck: the warm-up stopped: ${summary.warmup.error}`);
  } else {
    summary.warmup.complete = true;
  }

  const results: ItemResult[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      const blank: ItemResult = {
        id: item.id, state: "not_started", scanActive: false, pages: 0, calls: 0,
        sent: [], inserted: 0, noneFound: 0, wouldBe: [], error: null, timeoutRetries: 0, noted: "no",
      };
      if (isPerpetualCanaryText(item.description)) {
        results[i] = { ...blank, state: "canary_skipped" };
      } else if (overBudget()) {
        results[i] = blank;
      } else {
        const r = await processItem(db, llm, item, clientNames, options.dryRun, overBudget);
        // A real run records the item it gave up on, whether or not a scan had
        // begun, so it does not sort first again tomorrow. A dry run writes
        // nothing. Whatever the stamp answers, the item's error stands. Only
        // an answer of exactly true is a written stamp. False is the
        // database refusing because the item was closed after it errored:
        // nothing was written and nothing is wrong. Anything else failed.
        if (!options.dryRun && r.state === "error") {
          try {
            const { data, error } = await db.rpc("recheck_note_error", { p_item_id: item.id }) as { data: unknown; error: RpcError };
            if (error) {
              r.noted = "failed";
              console.error(`recheck: the error stamp of ${item.id.slice(0, 8)} was not written: ${errText(error)}`);
            } else if (data === true) {
              r.noted = "yes";
            } else if (data === false) {
              r.noted = "refused";
            } else {
              r.noted = "failed";
              console.error(`recheck: the error stamp of ${item.id.slice(0, 8)} answered neither true nor false: ${String(JSON.stringify(data)).slice(0, 80)}`);
            }
          } catch (e) {
            r.noted = "failed";
            console.error(`recheck: the error stamp of ${item.id.slice(0, 8)} was not written: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        results[i] = r;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, worker));

  for (const r of results) {
    summary.pages += r.pages;
    summary.llm_calls += r.calls;
    summary.inserted += r.inserted;
    summary.rows.none_found += r.noneFound;
    summary.timeout_retries += r.timeoutRetries;
    if (r.noted === "yes") summary.items_error_noted += 1;
    if (r.noted === "refused") summary.error_notes_refused += 1;
    if (r.noted === "failed") summary.error_notes_failed += 1;
    for (const row of r.sent) {
      if (row.outcome === "proposed") summary.rows.proposed += 1;
      else if (row.reason) summary.rows.no_evidence[row.reason] = (summary.rows.no_evidence[row.reason] ?? 0) + 1;
    }
    if (summary.would_be) summary.would_be.push(...r.wouldBe);
    if (r.state === "final") summary.items_final += 1;
    if (r.state === "not_open") summary.items_not_open += 1;
    if (r.state === "not_started") summary.items_not_started += 1;
    if (r.state === "budget") summary.items_budget_stopped += 1;
    if (r.state === "canary_skipped") summary.items_canary_skipped += 1;
    if (r.state === "error") {
      summary.items_errored += 1;
      if (summary.errors.length < ERROR_LIST_MAX) {
        summary.errors.push({ item: r.id.slice(0, 8), message: r.error ?? "unknown error" });
      }
    }
    // Still scanning after this run's last commit for the item.
    if (r.scanActive) {
      summary.recheck_incomplete += 1;
      summary.incomplete_ids.push(r.id.slice(0, 8));
    }
  }
  if (summary.status !== "failed" &&
    (summary.items_errored > 0 || summary.items_not_started > 0 || summary.items_budget_stopped > 0 ||
      summary.items_canary_skipped > 0)) {
    summary.status = "partial";
  }
  summary.finished_at = new Date(now()).toISOString();

  if (options.dryRun) {
    for (const row of summary.would_be ?? []) log(`recheck dry-run row ${JSON.stringify(row)}`);
  } else {
    const { would_be: _omit, ...receipt } = summary;
    try {
      const { error } = await db.rpc("recheck_record_run", {
        p_started_at: summary.started_at,
        p_status: summary.status,
        p_summary: receipt,
      }) as { error: RpcError };
      if (error) summary.receipt_error = errText(error);
    } catch (e) {
      summary.receipt_error = (e instanceof Error ? e.message : String(e)).slice(0, 240);
    }
    if (summary.receipt_error) console.error(`recheck: the run receipt was not written: ${summary.receipt_error}`);
  }
  log(
    `recheck ${options.dryRun ? "dry run" : "run"} ${summary.status}: eligible ${summary.items_eligible}, final ${summary.items_final}, recheck_incomplete ${summary.recheck_incomplete}, errored ${summary.items_errored}, proposed ${summary.rows.proposed}, warm-up ${summary.warmup.rows} rows in ${summary.warmup.chunks} chunks${summary.warmup.complete ? "" : ` (stopped: ${summary.warmup.stopped})`}, timeout retries ${summary.timeout_retries}`,
  );
  return summary;
}
