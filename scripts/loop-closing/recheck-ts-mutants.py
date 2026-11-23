#!/usr/bin/env python3
"""Loop-closing Task 4.1: negative controls for the TypeScript side.

    python3 scripts/loop-closing/recheck-ts-mutants.py            # every mutant
    python3 scripts/loop-closing/recheck-ts-mutants.py <name>...  # some
    python3 scripts/loop-closing/recheck-ts-mutants.py --list

Each mutant is one literal edit (exactly one site) applied to a THROWAWAY COPY
of supabase/functions (never this checkout) and judged by the unit tests of the
file it changes:
    P  action-item-recheck/_prompt.ts   by _prompt_test.ts
    R  action-item-recheck/_recheck.ts  by _recheck_test.ts
    D  brain-digest/recheck-proposals.ts by recheck-proposals.test.ts
The SQL side is judged separately by recheck-sql-test.sh --all-mutations.

CAUGHT only when deno test ran and reported a failed test. A judge that timed
out, could not load, or exited any other way is NEVER-RAN. Exit 0 only when
every mutant was CAUGHT; 1 if any survived; 2 if any never ran.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEADLINE = os.path.join(ROOT, "scripts", "loop-closing", "deadline.py")
FILES = {
    "P": ("supabase/functions/action-item-recheck/_prompt.ts", "supabase/functions/action-item-recheck/_prompt_test.ts"),
    "R": ("supabase/functions/action-item-recheck/_recheck.ts", "supabase/functions/action-item-recheck/_recheck_test.ts"),
    "D": ("supabase/functions/brain-digest/recheck-proposals.ts", "supabase/functions/brain-digest/recheck-proposals.test.ts"),
}

M = {
    # ----- chunking and the prompt -----
    "chunk_no_overlap": ("P", "  const step = CHUNK_CHARS - CHUNK_OVERLAP;", "  const step = CHUNK_CHARS;"),
    "chunk_truncates": ("P", "  if (text.length <= CHUNK_CHARS) return [text];", "  if (true) return [text.slice(0, CHUNK_CHARS)];"),
    "chunk_600_cut": ("P", '  const chunks = chunkThought(t.content ?? "");', '  const chunks = chunkThought((t.content ?? "").slice(0, 600));'),
    "chunk_splits_surrogate": ("P", "    if (from > 0 && code >= 0xdc00 && code <= 0xdfff) from -= 1;\n", ""),
    "chunk_drops_tail": ("P", "    if (start + CHUNK_CHARS >= text.length) break;", "    if (start + CHUNK_CHARS + step >= text.length) break;"),
    "item_text_on_first_part_only": ("P", "  return `ITEM: ${itemText}\\nTHOUGHT", '  return `${b.part === 1 ? "ITEM: " + itemText + "\\n" : ""}THOUGHT'),
    "no_part_label": ("P", "  const part = b.parts > 1 ? ` [part ${b.part} of ${b.parts}]` : \"\";", '  const part = "";'),
    "call_cap_off": ("P", "      if (current.length > 0 && size + b.text.length > MAX_CALL_CHARS) {", "      if (false) {"),
    "call_loses_last": ("P", "  if (current.length > 0) calls.push(current);\n  return calls;", "  return calls;"),
    # ----- parsing -----
    "parse_garbage_as_open": ("P", "  } catch {\n    return null;\n  }", '  } catch {\n    return { verdict: "open", thought_id: null, quote: null };\n  }'),
    "parse_unknown_verdict_kept": ("P", '  if (verdict !== "done" && verdict !== "superseded" && verdict !== "open") return null;\n', ""),
    "parse_id_case_kept": ("P", "    ? o.thought_id.trim().toLowerCase()", "    ? o.thought_id.trim()"),
    "parse_quote_untrimmed": ("P", '? o.quote.trim() : null;', '? o.quote : null;'),
    # ----- the acceptance checks -----
    "judge_open_writes": ("P", '  if (answer.verdict === "open") return null;\n', ""),
    "judge_superseded_ignored": ("P", '  if (answer.verdict === "open") return null;', '  if (answer.verdict !== "done") return null;'),
    "judge_nip_keeps_id": ("P", 'reason: "thought_not_in_page", evidence_thought_id: null, quote: null, score: null };\n  }\n  const full', 'reason: "thought_not_in_page", evidence_thought_id: answer.thought_id, quote: null, score: null };\n  }\n  const full'),
    "judge_verbatim_off": ("P", "  if (quote === null || !full.includes(quote)) {", "  if (quote === null) {"),
    "judge_missing_quote_ok": ("P", "  if (quote === null || !full.includes(quote)) {", '  if (quote !== null && !full.includes(quote)) {'),
    "judge_verbatim_case_insensitive": ("P", "  if (quote === null || !full.includes(quote)) {", "  if (quote === null || !full.toLowerCase().includes(quote.toLowerCase())) {"),
    # Verbatim in what the model was SHOWN (the parts), not in the stored thought.
    "judge_verbatim_in_prompt": ("P", "  if (quote === null || !full.includes(quote)) {", '  if (quote === null || !thoughtBlocks(t).map((b) => b.text).join("").includes(quote)) {'),
    "judge_veto_off": ("P", "  if (stillOwedAdjacencyVeto(full, item.description, stem).vetoed) {", "  if (false) {"),
    "judge_veto_first_chunk": ("P", "  if (stillOwedAdjacencyVeto(full, item.description, stem).vetoed) {", "  if (stillOwedAdjacencyVeto(full.slice(0, CHUNK_CHARS), item.description, stem).vetoed) {"),
    "judge_veto_on_quote": ("P", "  if (stillOwedAdjacencyVeto(full, item.description, stem).vetoed) {", "  if (stillOwedAdjacencyVeto(quote, item.description, stem).vetoed) {"),
    "judge_coverage_off": ("P", "  if (score < SUBJECT_COVERAGE_THRESHOLD) {", "  if (false) {"),
    "judge_coverage_inclusive": ("P", "  if (score < SUBJECT_COVERAGE_THRESHOLD) {", "  if (score <= SUBJECT_COVERAGE_THRESHOLD) {"),
    "judge_coverage_of_thought": ("P", "subjectCoverage(quote, item.description) * 10000", "subjectCoverage(full, item.description) * 10000"),
    "judge_project_off": ("P", "  if ((tp !== null && tp !== item.project) || ", "  if ((false) || "),
    "judge_null_item_project_any": ("P", "  if ((tp !== null && tp !== item.project) || ", "  if ((tp !== null && item.project !== null && tp !== item.project) || "),
    "judge_null_thought_project_refused": ("P", "  if ((tp !== null && tp !== item.project) || ", "  if ((tp !== item.project) || "),
    "judge_blank_project_kept": ("P", '  return typeof p === "string" && p.trim() !== "" ? p : null;', '  return typeof p === "string" ? p : null;'),
    "judge_client_off": ("P", " || !thoughtNamesItemClient(item.description, full, clientNames)) {", ") {"),
    "judge_scope_drops_evidence": ("P", 'reason: "scope_mismatch", evidence_thought_id: t.id,', 'reason: "scope_mismatch", evidence_thought_id: null,'),
    "judge_order_scope_first": ("P", "  if (quote === null || !full.includes(quote)) {", '  if (thoughtProject(t) !== null && thoughtProject(t) !== item.project) {\n    return { outcome: "no_evidence", reason: "scope_mismatch", evidence_thought_id: t.id, quote: null, score: null };\n  }\n  if (quote === null || !full.includes(quote)) {'),
    "client_any_full_name": ("P", "  if (full.length > 0) return full.every((needle) => thoughtHay.includes(needle));", "  if (full.length > 0) return full.some((needle) => thoughtHay.includes(needle));"),
    "client_first_name_substring": ("P", "shared.every((w) => thoughtTokens.includes(w));", "shared.every((w) => thoughtHay.includes(w));"),
    "client_full_name_substring": ("P", "  const thoughtHay = ` ${thoughtTokens.join(\" \")} `;", '  const thoughtHay = ` ${thoughtTokens.join("")} `;'),
    # The stored quote. An ACCEPTED quote is stored whole (review finding F1: a cap
    # applied after the checks kept the preamble and dropped the completion
    # sentence); a REJECTED one is capped, at each of the four sites that store it.
    "accepted_quote_capped": ("P", '  return { outcome: "proposed", reason: null, evidence_thought_id: t.id, quote, score };', '  return { outcome: "proposed", reason: null, evidence_thought_id: t.id, quote: quote.slice(0, QUOTE_STORE_MAX), score };'),
    "accepted_quote_rejected_cap_reused": ("P", '  return { outcome: "proposed", reason: null, evidence_thought_id: t.id, quote, score };', '  return { outcome: "proposed", reason: null, evidence_thought_id: t.id, quote: rejectedQuote(quote), score };'),
    "rejected_quote_uncapped": ("P", "  return q === null ? null : q.slice(0, QUOTE_STORE_MAX);", "  return q;"),
    "nonverbatim_quote_uncapped": ("P", 'reason: "quote_not_verbatim", evidence_thought_id: t.id, quote: rejectedQuote(quote),', 'reason: "quote_not_verbatim", evidence_thought_id: t.id, quote,'),
    "veto_quote_uncapped": ("P", 'reason: "veto", evidence_thought_id: t.id, quote: rejectedQuote(quote),', 'reason: "veto", evidence_thought_id: t.id, quote,'),
    "coverage_quote_uncapped": ("P", 'reason: "coverage", evidence_thought_id: t.id, quote: rejectedQuote(quote),', 'reason: "coverage", evidence_thought_id: t.id, quote,'),
    "scope_quote_uncapped": ("P", 'reason: "scope_mismatch", evidence_thought_id: t.id, quote: rejectedQuote(quote),', 'reason: "scope_mismatch", evidence_thought_id: t.id, quote,'),
    "score_unrounded": ("P", "Math.round(subjectCoverage(quote, item.description) * 10000) / 10000", "subjectCoverage(quote, item.description) + 1e-9"),
    "merge_first_wins": ("P", '    } else if (out[at].outcome !== "proposed" && r.outcome === "proposed") {', "    } else if (false) {"),
    "merge_last_wins": ("P", '    } else if (out[at].outcome !== "proposed" && r.outcome === "proposed") {', "    } else if (true) {"),
    "merge_keeps_duplicates": ("P", "    if (at === undefined) {", "    if (true) {"),
    "merge_many_not_in_page": ("P", "      if (!notInPage) {", "      if (true) {"),
    # ----- the run loop -----
    "full_page_is_final": ("R", "      const isFinal = thoughts.length < PAGE_SIZE;", "      const isFinal = thoughts.length <= PAGE_SIZE;"),
    "short_page_not_final": ("R", "      const isFinal = thoughts.length < PAGE_SIZE;", "      const isFinal = thoughts.length === 0;"),
    "six_pages": ("R", "    for (let page = 1; page <= MAX_PAGES_PER_ITEM; page++) {", "    for (let page = 1; page <= MAX_PAGES_PER_ITEM + 1; page++) {"),
    "four_pages": ("R", "    for (let page = 1; page <= MAX_PAGES_PER_ITEM; page++) {", "    for (let page = 1; page < MAX_PAGES_PER_ITEM; page++) {"),
    # The plan's own trap: counting from the page number instead of the commit's answer.
    "incomplete_from_page_count": ("R", "      res.scanActive = c.scan_active === true;", "      res.scanActive = page >= MAX_PAGES_PER_ITEM;"),
    "incomplete_never": ("R", "      res.scanActive = c.scan_active === true;", "      res.scanActive = false;"),
    "cursor_through_date": ("R", "      cursorAt = str(c.cursor_at);", "      cursorAt = c.cursor_at ? new Date(String(c.cursor_at)).toISOString() : null;"),
    "page_cursor_through_date": ("R", "        p_cursor_at: last ? last.created_at : null,", "        p_cursor_at: last ? new Date(last.created_at).toISOString() : null,"),
    "expected_cursor_dropped": ("R", "        p_expected_cursor_at: cursorAt,", "        p_expected_cursor_at: null,"),
    "expected_cursor_id_dropped": ("R", "        p_expected_cursor_id: cursorId,", "        p_expected_cursor_id: null,"),
    "lower_ignores_item_created": ("R", "        p_lower_at: cursorAt ?? item.created_at,", "        p_lower_at: cursorAt,"),
    "lower_id_invented": ("R", "        p_lower_id: cursorId,\n", '        p_lower_id: cursorId ?? "00000000-0000-0000-0000-000000000000",\n'),
    "embedding_dropped": ("R", "    const embedding = src?.embedding ?? null;", "    const embedding = null;"),
    "embedding_parsed": ("R", "    const embedding = src?.embedding ?? null;", "    const embedding = src?.embedding ? JSON.parse(String(src.embedding)) : null;"),
    "embedding_ids_dropped": ("R", "        p_embedding_ids: embeddingIds,", "        p_embedding_ids: [],"),
    "existing_scan_restarts": ("R", "    let cursorAt = str(begun.cursor_at);", "    let cursorAt: string | null = null;"),
    "commit_error_ignored": ("R", "      if (error) throw new ItemAbort(`recheck_commit_page ${errText(error)}`);\n", ""),
    "parse_failure_skipped": ("R", "          if (!answer) throw new ItemAbort(\"the model's answer was not the JSON object asked for\");", "          if (!answer) continue;"),
    "no_deadlock_retry": ("R", '      const { data: committed, error } = await rpcWithDeadlockRetry(db, "recheck_commit_page", {', '      const { data: committed, error } = await db.rpc("recheck_commit_page", {'),
    "wrong_scan_param_name": ("R", "        p_scan_id: scanId,", "        p_scan: scanId,"),
    "final_flag_lost": ("R", "        p_final: isFinal,", "        p_final: false,"),
    "rows_dropped": ("R", "        p_rows: rows,", "        p_rows: [],"),
    "rows_unmerged": ("R", "        rows = mergeRows(drafts);", "        rows = [];"),
    "item_project_dropped": ("R", "            { description: item.description, project: item.src_project ?? null },", "            { description: item.description, project: null },"),
    "client_names_dropped": ("R", "            byId,\n            clientNames,\n", "            byId,\n            [],\n"),
    "page_size_20": ("R", "        p_limit: PAGE_SIZE,", "        p_limit: PAGE_SIZE * 2,"),
    "dry_run_begins": ("R", 'dryRun ? "recheck_plan_scan" : "recheck_begin_scan"', '"recheck_begin_scan"'),
    "dry_run_commits": ("R", "      if (dryRun) {\n        res.pages += 1;", "      if (false) {\n        res.pages += 1;"),
    "dry_run_writes_receipt": ("R", "  if (options.dryRun) {\n    for (const row of summary.would_be ?? [])", "  if (false) {\n    for (const row of summary.would_be ?? [])"),
    "dry_run_silent": ("R", "    for (const row of summary.would_be ?? []) log(`recheck dry-run row ${JSON.stringify(row)}`);\n", ""),
    # Re-review 1, P2: the dry run's hypothetical scan state. A dry scan is in
    # progress from a valid plan until its simulated final page, so a dry run
    # stopped by the budget or an error reports the scan a real run leaves.
    # One mutant per arm: never set, set for one plan answer only, set too
    # early, not cleared at the final page, cleared on each non-final exit.
    "dry_scan_never_active": ("R", "    res.scanActive = true;\n\n    for (", "    res.scanActive = !dryRun;\n\n    for ("),
    "real_scan_inactive_until_commit": ("R", "    res.scanActive = true;\n\n    for (", "    res.scanActive = dryRun;\n\n    for ("),
    "dry_scan_active_fresh_only": ("R", "    res.scanActive = true;\n\n    for (", '    res.scanActive = !dryRun || beginStatus === "would_begin";\n\n    for ('),
    "dry_scan_active_resumed_only": ("R", "    res.scanActive = true;\n\n    for (", '    res.scanActive = !dryRun || beginStatus === "existing";\n\n    for ('),
    "dry_scan_active_before_plan": ("R", '    id: item.id, state: "error", scanActive: false, pages: 0, calls: 0,', '    id: item.id, state: "error", scanActive: dryRun, pages: 0, calls: 0,'),
    "dry_scan_active_before_flag_check": ("R", '    if (dryRun && typeof begun.scan_proposed !== "boolean") {', '    res.scanActive = true;\n    if (dryRun && typeof begun.scan_proposed !== "boolean") {'),
    "dry_final_keeps_scan_active": ("R", '          res.scanActive = false;\n          res.state = "final";', '          res.state = "final";'),
    "dry_final_clears_only_without_proposal": ("R", '          res.scanActive = false;\n          res.state = "final";', '          res.scanActive = proposed;\n          res.state = "final";'),
    "dry_budget_clears_scan": ("R", '        res.state = "budget";\n        return res;', '        res.state = "budget";\n        if (dryRun) res.scanActive = false;\n        return res;'),
    "dry_error_clears_scan": ("R", '    res.state = "error";\n    res.error = (e instanceof', '    if (dryRun) res.scanActive = false;\n    res.state = "error";\n    res.error = (e instanceof'),
    "dry_five_pages_clears_scan": ("R", '    res.state = "incomplete";\n    return res;', '    res.state = "incomplete";\n    if (dryRun) res.scanActive = false;\n    return res;'),
    "dry_run_none_found_always": ("R", "          if (!proposed) {\n            res.noneFound += 1;", "          if (true) {\n            res.noneFound += 1;"),
    # Review finding F2: the dry run resumes from the scan's persisted proposed
    # flag, and reports the final none_found as a would-be ROW, not only a count.
    "dry_run_ignores_persisted_proposed": ("R", "    let proposed = dryRun && begun.scan_proposed === true;", "    let proposed = false;"),
    "dry_run_proposed_always": ("R", "    let proposed = dryRun && begun.scan_proposed === true;", "    let proposed = dryRun;"),
    "dry_run_plan_flag_unchecked": ("R", '    if (dryRun && typeof begun.scan_proposed !== "boolean") {', "    if (false) {"),
    "dry_run_none_found_row_dropped": ("R", "            res.noneFound += 1;\n            res.wouldBe.push({", "            res.noneFound += 1;\n            void ({"),
    "dry_run_none_found_count_dropped": ("R", "            res.noneFound += 1;\n            res.wouldBe.push({", "            res.wouldBe.push({"),
    "dry_run_none_found_no_item_id": ("R", "              item_id: item.id, description: item.description,\n            });", "              item_id: \"\", description: item.description,\n            });"),
    "real_run_reads_plan_flag": ("R", '    if (dryRun && typeof begun.scan_proposed !== "boolean") {', '    if (typeof begun.scan_proposed !== "boolean") {'),
    "not_open_counted_incomplete": ("R", '        res.scanActive = false;\n        res.state = "not_open";', '        res.state = "not_open";'),
    "already_final_as_error": ("R", '      if (status === "already_final") {\n        res.state = "final";\n        return res;\n      }\n', ""),
    # ----- cold-start correction: the serial warm-up -----
    "warm_skipped": ("R", "  if (items.length > 0) {\n    summary.warmup = await warmEmbeddings(", "  if (false) {\n    summary.warmup = await warmEmbeddings("),
    "warm_includes_midscan": ("R", "!i.recheck_scan_id && !isPerpetualCanaryText(i.description)", "!isPerpetualCanaryText(i.description)"),
    "warm_includes_canary": ("R", "!i.recheck_scan_id && !isPerpetualCanaryText(i.description)", "!i.recheck_scan_id"),
    "warm_position_dropped": ("R", "        p_after_at: afterAt,", "        p_after_at: null,"),
    "warm_position_id_dropped": ("R", "        p_after_id: afterId,", "        p_after_id: null,"),
    "warm_position_through_date": ("R", "      afterAt = lastAt;", "      afterAt = new Date(lastAt).toISOString();"),
    "warm_chunk_500": ("R", "        p_limit: WARM_CHUNK_ROWS,", "        p_limit: WARM_CHUNK_ROWS * 2,"),
    "warm_ignores_done": ("R", "      if (row.done) {\n        w.complete = true;\n        break;\n      }\n", ""),
    "warm_complete_by_default": ("R", "  const w: Warmup = { chunks: 0, rows: 0, ms: 0, complete: false,", "  const w: Warmup = { chunks: 0, rows: 0, ms: 0, complete: true,"),
    "warm_budget_ignored": ("R", '      if (!inBudget()) {\n        w.stopped = "budget";', '      if (false) {\n        w.stopped = "budget";'),
    "warm_budget_whole_run": ("R", "budgetMs * WARM_BUDGET_FRACTION,", "budgetMs,"),
    "warm_budget_exclusive": ("R", "  const inBudget = () => now() - startedMs <= warmBudgetMs;", "  const inBudget = () => now() - startedMs < warmBudgetMs;"),
    "warm_budget_from_warm_start": ("R", "  const inBudget = () => now() - startedMs <= warmBudgetMs;", "  const inBudget = () => now() - now() <= warmBudgetMs;"),
    "warm_cap_off_by_one": ("R", "      if (w.chunks >= WARM_MAX_CHUNKS) {", "      if (w.chunks > WARM_MAX_CHUNKS) {"),
    "warm_no_advance_check": ("R", "(lastAt === afterAt && lastId === afterId)", "false"),
    "warm_no_position_check": ("R", "      if (!lastAt || !lastId || (lastAt", "      if ((lastAt"),
    "warm_position_at_only": ("R", "      if (!lastAt || !lastId || (lastAt", "      if (!lastAt || (lastAt"),
    "warm_chunk_shape_unchecked": ("R", '      if (!row || typeof row.rows_read !== "number" || typeof row.done !== "boolean") {', "      if (!row) {"),
    "warm_done_shape_unchecked": ("R", '      if (!row || typeof row.rows_read !== "number" || typeof row.done !== "boolean") {', '      if (!row || typeof row.rows_read !== "number") {'),
    "warm_rows_uncounted": ("R", "      w.rows += row.rows_read;\n", ""),
    "warm_chunks_double": ("R", "      w.chunks += 1;", "      w.chunks += 2;"),
    "warm_error_unreported": ("R", "    w.error = (e instanceof Error ? e.message : String(e)).slice(0, 240);\n  }\n  w.ms", "    w.error = null;\n  }\n  w.ms"),
    "warm_error_not_stopped": ("R", '    w.stopped = "error";\n', ""),
    "warm_rpc_error_ignored": ("R", "      if (error) throw new ItemAbort(`recheck_warm_embeddings ${errText(error)}`);\n", ""),
    "warm_timeout_not_retried": ("R", "      }, inBudget, onRetry);", "      }, () => false, onRetry);"),
    "warm_retry_uncounted": ("R", "      () => { summary.timeout_retries += 1; });", "      () => {});"),
    "warm_nothing_not_complete": ("R", "  if (ids.length === 0) {\n    w.complete = true;\n    return w;", "  if (ids.length === 0) {\n    return w;"),
    "warm_none_eligible_not_complete": ("R", "  } else {\n    summary.warmup.complete = true;\n  }", "  }"),
    # ----- cold-start correction: the retry of a statement the timeout cancelled -----
    "timeout_three_tries": ("R", "attempt >= TIMEOUT_ATTEMPTS", "attempt > TIMEOUT_ATTEMPTS"),
    "timeout_one_try": ("R", "export const TIMEOUT_ATTEMPTS = 2;", "export const TIMEOUT_ATTEMPTS = 1;"),
    "timeout_retry_any_error": ("R", "    if (r.error?.code !== STATEMENT_TIMEOUT || ", "    if (!r.error || "),
    "timeout_code_wrong": ("R", 'const STATEMENT_TIMEOUT = "57014";', 'const STATEMENT_TIMEOUT = "57P01";'),
    "begin_timeout_not_retried": ("R", "    }, () => !overBudget(), () => { res.timeoutRetries += 1; });", "    }, () => false, () => { res.timeoutRetries += 1; });"),
    "begin_retry_ignores_budget": ("R", "    }, () => !overBudget(), () => { res.timeoutRetries += 1; });", "    }, () => true, () => { res.timeoutRetries += 1; });"),
    "begin_retry_uncounted": ("R", "    }, () => !overBudget(), () => { res.timeoutRetries += 1; });", "    }, () => !overBudget(), () => {});"),
    "begin_error_unread": ("R", "    if (begin.error) throw new ItemAbort(`${beginFn} ${errText(begin.error)}`);\n", ""),
    "item_retries_unsummed": ("R", "    summary.timeout_retries += r.timeoutRetries;\n", ""),
    "candidates_timeout_retried": ("R", '      const data = await rpc(db, "recheck_candidates", {', '      const data = await (async (f: string, a: Record<string, unknown>) => { const r = await rpcRetryingTimeout(db, f, a, () => true, () => {}); if (r.error) throw new ItemAbort(`${f} ${errText(r.error)}`); return r.data; })("recheck_candidates", {'),
    # ----- cold-start correction: the error stamp -----
    "note_in_dry_run": ("R", '        if (!options.dryRun && r.state === "error") {', '        if (r.state === "error") {'),
    "note_never": ("R", '        if (!options.dryRun && r.state === "error") {', "        if (false) {"),
    "note_every_item": ("R", '        if (!options.dryRun && r.state === "error") {', "        if (!options.dryRun) {"),
    "note_wrong_arg_name": ("R", '"recheck_note_error", { p_item_id: item.id })', '"recheck_note_error", { p_item: item.id })'),
    "note_rpc_error_as_written": ("R", '            if (error) {\n              r.noted = "failed";', '            if (error) {\n              r.noted = "yes";'),
    # Correction 1 (review F1): only an answer of exactly true is a written stamp.
    "note_any_answer_written": ("R", "            } else if (data === true) {", "            } else if (true) {"),
    "note_false_counted_written": ("R", "            } else if (data === true) {", "            } else if (data === true || data === false) {"),
    "note_truthy_counted_written": ("R", "            } else if (data === true) {", "            } else if (data) {"),
    "note_loose_true": ("R", "            } else if (data === true) {", "            } else if (data == true) {"),
    "note_not_false_counted_written": ("R", "            } else if (data === true) {", "            } else if (data !== false) {"),
    "note_false_counted_failed": ("R", '            } else if (data === false) {\n              r.noted = "refused";', '            } else if (data === false) {\n              r.noted = "failed";'),
    "note_malformed_counted_refused": ("R", "            } else if (data === false) {", "            } else if (data !== true) {"),
    "note_falsy_counted_refused": ("R", "            } else if (data === false) {", "            } else if (!data) {"),
    "note_loose_false": ("R", "            } else if (data === false) {", "            } else if (data == false) {"),
    "note_malformed_as_no_attempt": ("R", '            } else {\n              r.noted = "failed";', '            } else {\n              r.noted = "no";'),
    "note_malformed_unlogged": ("R", "              console.error(`recheck: the error stamp of ${item.id.slice(0, 8)} answered neither true nor false: ${String(JSON.stringify(data)).slice(0, 80)}`);\n", ""),
    "note_refusal_uncounted": ("R", '    if (r.noted === "refused") summary.error_notes_refused += 1;\n', ""),
    "note_refusal_counted_as_written": ("R", '    if (r.noted === "refused") summary.error_notes_refused += 1;', '    if (r.noted === "refused") summary.items_error_noted += 1;'),
    "note_refusal_counted_as_failed": ("R", '    if (r.noted === "refused") summary.error_notes_refused += 1;', '    if (r.noted === "refused") summary.error_notes_failed += 1;'),
    "note_refusal_logged_as_fault": ("R", '            } else if (data === false) {\n              r.noted = "refused";\n', '            } else if (data === false) {\n              r.noted = "refused";\n              console.error(`recheck: the error stamp of ${item.id.slice(0, 8)} was refused`);\n'),
    "note_throw_as_written": ("R", '          } catch (e) {\n            r.noted = "failed";', '          } catch (e) {\n            r.noted = "yes";'),
    "note_uncounted": ("R", '    if (r.noted === "yes") summary.items_error_noted += 1;\n', ""),
    "note_failure_uncounted": ("R", '    if (r.noted === "failed") summary.error_notes_failed += 1;\n', ""),
    "note_result_dropped": ("R", '        results[i] = r;\n      }', '        results[i] = { ...r, noted: "no" };\n      }'),
    "canary_not_skipped": ("R", "      if (isPerpetualCanaryText(item.description)) {", "      if (false) {"),
    "budget_ignored_between_items": ("R", "      } else if (overBudget()) {", "      } else if (false) {"),
    "budget_ignored_between_pages": ("R", '      if (overBudget()) {\n        res.state = "budget";', '      if (false) {\n        res.state = "budget";'),
    "failed_read_as_ok": ("R", '    summary.status = "failed";\n    summary.failure', '    summary.status = "ok";\n    summary.failure'),
    "names_not_validated": ("R", '    if (!Array.isArray(names) || !names.every((n) => typeof n === "string")) {', "    if (false) {"),
    "limit_uncapped": ("R", "  const limit = Math.min(Math.max(Math.trunc(options.limit ?? ITEM_CAP), 1), ITEM_CAP);", "  const limit = Math.trunc(options.limit ?? ITEM_CAP);"),
    "partial_as_ok": ("R", '    summary.status = "partial";', '    summary.status = "ok";'),
    "none_found_always": ("R", "        if (c.scan_proposed !== true) res.noneFound += 1;", "        res.noneFound += 1;"),
    "receipt_not_written": ("R", '      const { error } = await db.rpc("recheck_record_run", {', '      const { error } = await Promise.resolve(null).then(() => ({ error: null as RpcError })) as { error: RpcError }; void ({'),
    "receipt_error_swallowed": ("R", "      if (error) summary.receipt_error = errText(error);\n", ""),
    "errors_unlisted": ("R", "      if (summary.errors.length < ERROR_LIST_MAX) {", "      if (false) {"),
    "serial_only": ("R", "  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, worker));", "  await Promise.all(Array.from({ length: 1 }, worker));"),
    "concurrency_uncapped": ("R", "  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, worker));", "  await Promise.all(Array.from({ length: Math.max(items.length, 1) }, worker));"),
    # ----- the digest section -----
    "digest_newest_first": ("D", "    Date.parse(a.proposed_at) - Date.parse(b.proposed_at) ||", "    Date.parse(b.proposed_at) - Date.parse(a.proposed_at) ||"),
    "digest_no_decision_tiebreak": ("D", "    (a.decision_id < b.decision_id ? -1 : a.decision_id > b.decision_id ? 1 : 0)", "    0"),
    "digest_multi_hint_off": ("D", "    const which = n > 1", "    const which = n > 99"),
    "digest_hint_always": ("D", "    const which = n > 1", "    const which = n > 0"),
    "digest_cap_off": ("D", "  const shown = sorted.slice(0, RECHECK_PROPOSAL_LIST_CAP);", "  const shown = sorted;"),
    "digest_total_ignores_database": ("D", "  const total = Math.max(sorted.length, ...sorted.map((r) => Number(r.pending_total ?? 0) || 0));", "  const total = sorted.length;"),
    "digest_failed_read_as_none": ("D", "  if (rows === null) {", "  if (rows === null) rows = [];\n  if (false) {"),
    "digest_never_ran_silent": ("D", '  if (!run.started_at) return "Re-check has never run.";', "  if (!run.started_at) return null;"),
    "digest_unreadable_run_silent": ("D", '  if (run === null) return "Re-check status unavailable: its last run could not be read.";', "  if (run === null) return null;"),
    "digest_failed_run_silent": ("D", '  if (run.status !== "ok") {', "  if (false) {"),
    "digest_failure_text_dropped": ("D", "    if (failure) parts.push(failure);\n", ""),
    "digest_stale_silent": ("D", "  if (nowMs - Date.parse(run.started_at) > RECHECK_JOB_STALE_HOURS * 3_600_000) {", "  if (false) {"),
    "digest_stale_inclusive": ("D", "  if (nowMs - Date.parse(run.started_at) > RECHECK_JOB_STALE_HOURS * 3_600_000) {", "  if (nowMs - Date.parse(run.started_at) >= RECHECK_JOB_STALE_HOURS * 3_600_000) {"),
    "digest_incomplete_silent": ("D", "  if (incomplete > 0) {", "  if (false) {"),
    "digest_text_multiline": ("D", '  const flat = String(s ?? "").replace(/\\s+/g, " ").trim();', '  const flat = String(s ?? "").trim();'),
    "digest_description_uncapped": ("D", "const DESCRIPTION_MAX = 70;", "const DESCRIPTION_MAX = 7000;"),
    "digest_quote_uncapped": ("D", "const QUOTE_MAX = 140;", "const QUOTE_MAX = 14000;"),
    "digest_evidence_dropped": ("D", '    const from = r.evidence_thought_id ? ` from ${r.evidence_thought_id.slice(0, 8)}` : "";', '    const from = "";'),
    "digest_warning_dropped_with_list": ("D", "  if (warning) lines.push(`_${warning}_`);\n", ""),
    "digest_quiet_line_hides_warning": ("D", '      `Re-check proposals: none pending${when}.`,\n      warning ? `_${warning}_` : "",', '      `Re-check proposals: none pending${when}.`,\n      "",'),
}


def run_one(name):
    kind, old, new = M[name]
    src, test = FILES[kind]
    tree = tempfile.mkdtemp(prefix="obrc-ts.", dir="/tmp")
    try:
        os.makedirs(os.path.join(tree, "supabase"))
        shutil.copytree(os.path.join(ROOT, "supabase", "functions"), os.path.join(tree, "supabase", "functions"))
        shutil.copy(os.path.join(ROOT, "deno.json"), tree)
        path = os.path.join(tree, src)
        s = open(path).read()
        if s.count(old) != 1 or old == new:
            return "NEVER-RAN", f"the mutant did not apply to exactly one site ({s.count(old)} matches)"
        open(path, "w").write(s.replace(old, new))
        # --no-check: a mutant is judged by what the tests observe, not by the
        # type checker (several mutants are deliberately ill-typed).
        p = subprocess.run(
            ["python3", DEADLINE, "120", "deno", "test", "--no-lock", "--no-check", "--allow-read", os.path.join(tree, test)],
            cwd=tree, capture_output=True, text=True)
        out = re.sub(r"\x1b\[[0-9;]*m", "", p.stdout + p.stderr)
        if p.returncode == 1 and re.search(r"[1-9][0-9]* failed", out):
            failed = sorted(set(re.findall(r"^(.*) \.\.\. FAILED", out, re.M)))
            return "CAUGHT", " | ".join(failed)[:400]
        if p.returncode == 0:
            return "SURVIVED", ""
        return "NEVER-RAN", f"exit {p.returncode}: {out.strip().splitlines()[-1][:160] if out.strip() else ''}"
    finally:
        shutil.rmtree(tree, ignore_errors=True)


def main():
    args = sys.argv[1:]
    if args == ["--list"]:
        print(" ".join(M))
        return 0
    names = args or list(M)
    counts = {"CAUGHT": 0, "SURVIVED": 0, "NEVER-RAN": 0}
    for name in names:
        if name not in M:
            verdict, detail = "NEVER-RAN", "unknown mutant"
        else:
            verdict, detail = run_one(name)
        counts[verdict] += 1
        print(f"{verdict:<9} {name}{': ' + detail if detail else ''}", flush=True)
    n = sum(counts.values())
    print(f"TS SWEEP: {n} mutations, {counts['CAUGHT']} caught, {counts['SURVIVED']} survived, {counts['NEVER-RAN']} never ran")
    if counts["NEVER-RAN"]:
        return 2
    if counts["SURVIVED"]:
        return 1
    print(f"ALL {n} TS MUTATIONS CAUGHT")
    return 0


if __name__ == "__main__":
    sys.exit(main())
