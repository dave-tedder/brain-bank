#!/bin/bash
# Loop-closing Task 5.2: prove 20261120c_dedup_semantic_reads.sql, and the dedup
# rows the capture paths write, on a throwaway LOCAL PostgreSQL cluster (never
# production). Built from fragment-gate-sql-test.sh (Task 5.1): same verdict
# code, same three outcomes, same negative controls.
#
#   bash scripts/loop-closing/dedup-sql-test.sh                   # exit 0 passed
#   bash scripts/loop-closing/dedup-sql-test.sh --mutate <name>   # exit 1 expected
#   bash scripts/loop-closing/dedup-sql-test.sh --all-mutations   # all must be CAUGHT
#   bash scripts/loop-closing/dedup-sql-test.sh --verdict-selftest  # no database
#   bash scripts/loop-closing/dedup-sql-test.sh --inject-selftest   # negative controls
#   bash scripts/loop-closing/dedup-sql-test.sh --inject-selftest-controls  # controls OF the self-test
#
# --inject-selftest runs every injection in inject_table (8) in its own run. An
# injection counts only when ALL hold (Codex review 1 of PR 33, R3; the
# mechanism of PR 32's closeout-routes-sql-test.sh): the run printed exactly one
# "OBDD_INJECT_REACHED <name>" line and no other such line, printed only from
# inside the injected code path (a NOTICE raised by the planted statement or
# trigger itself; the bridge's planted adapter branch; for the shell-side
# helper_fail, the shell's planted branch just before its query); the exit is
# the one the table names; and the first FAIL/NEVER-RAN line matches the
# table's diagnostic, which carries a token only the planted code produces
# (obdd_...), except sql_timeout's, which is the generic 57014 line; and, where
# the table names one, the error was raised at the required site (Codex
# re-review 1 of PR 33, F1; PR 32's OBRT_ERROR_CONTEXT mechanism): the run
# prints the SQL contract's first error CONTEXT as one "OBDD_ERROR_CONTEXT" line
# ("(none)" for a top-level statement) and it must match. sql_timeout's marker
# and its sleep are one function, pg_temp.obdd_reach_then_sleep, and its site is
# that function's frame, so a timeout in any other statement (Codex's displaced
# sleep) is FAILED, and a timeout before the marker is INCOMPLETE. The
# contract's assert_fail and raw_error must be raised inside their planted DO
# block. And for every contract injection (a site other than "-"), the marker
# and the first error must come from the SAME statement psql sent (Codex
# re-review 2 of PR 33, F1; PR 32's identity rule): the contract runs with
# psql -e, and sent_identity reads from the echo that psql sent no other
# statement between the marker and the error, so a frame a later statement
# borrows (a second anonymous block, a redefined function) is FAILED. No
# marker (an unknown name, an injection whose setup failed, a run that ended
# for an unrelated reason before the site) or a deadline is INCOMPLETE, exit 2;
# a reached injection with the wrong exit, diagnostic, site or sending
# statement is FAILED, exit 1; only all-good is PASSED, exit 0. OBDD_INJECT_TABLE
# replaces the table and OBDD_SELFTEST_STOP_BEFORE_BRIDGE=1 ends a run NEVER-RAN
# after the SQL contract; both, and the selftest_* injections, exist only for
# the controls.
#
# Three outcomes, never two:
#   0  passed: every check ran to completion and held.
#   1  FAILED: a check RAN TO COMPLETION and its assertion did not hold. Only this is
#      a caught mutation. Every exit 1 prints a line starting "FAIL ".
#   2  NEVER-RAN: the cluster, a migration or a mutant did not apply; a helper query
#      did not execute; a statement was cancelled, timed out or lost a resource; the
#      SQL contract stopped on an error that is not one of its own assertions (only
#      SQLSTATE TF001 with a "FAIL " message is); the integration bridge could not
#      run; a step stopped before its last check. Nothing was judged.
#
# What it proves, in order:
#   1. The migration applies over the prior Task 1.4 / 3.1 / 3.2 / 3.6 schema and
#      changes no existing function (every public function's md5(prosrc) is
#      compared before and after; only the two new reads may appear).
#   2. dedup-sql-test.sql (C, D, P, R, L, S, G checks): the candidate read (open
#      items, window, project trimmed or null, oldest first, limit bounds); the
#      exact_batch and semantic proposal payloads against the real CHECKs, the
#      generation trigger and record_decisions; what the digest read lists (open
#      items, current generation, proposed semantic rows only, one per item,
#      newest decision, oldest first, survivor status, total, limit bounds); Task
#      3.6's done and keep on a dedup proposal; volatility, security and grants.
#   3. dedup-integration.ts: the real shared extractAndStoreActionItems, the
#      digest renderer and the review helper against these real functions.
export LC_ALL=C
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/scripts/loop-closing"
M_MCP_LOG="$ROOT/supabase/migrations/0016_mcp_tool_invocations.sql"
M_DECISIONS="$ROOT/supabase/migrations/20261105_auto_resolve_decisions.sql"
M_CLOSE="$ROOT/supabase/migrations/20261106_action_items_close_reason.sql"
M_ARCHIVE="$ROOT/supabase/migrations/20261109a_action_items_archive_proposals.sql"
M_REVIEW="$ROOT/supabase/migrations/20261109b_review_proposal_rpc.sql"
M_DEDUP="$ROOT/supabase/migrations/20261120c_dedup_semantic_reads.sql"
TEST_SQL="$HERE/dedup-sql-test.sql"

MUTATIONS="cand_any_status cand_no_window cand_window_unclamped cand_newest_first cand_limit_unclamped cand_limit_default_50 cand_project_untrimmed cand_project_blank_kept cand_inner_join pend_no_generation_filter pend_includes_deferred pend_any_outcome pend_any_layer pend_no_distinct pend_oldest_decision pend_order_desc pend_total_is_row_number pend_limit_unbounded pend_no_survivor_status grant_anon_candidates grant_anon_pending security_definer volatile_read no_search_path"
MUTANT_DEADLINE="${OBFG_MUTANT_DEADLINE:-300}"

# SQLSTATE prefixes that mean the statement was interrupted or the server could
# not do the work: nothing was judged. 08 connection, 53 insufficient resources,
# 54 program limit, 57 operator intervention (57014 is statement_timeout and
# cancel), 58 system error, XX internal error, 55P03 lock_timeout. The SQL
# contract and the integration bridge are handed this same list.
INTERRUPTION_PREFIXES="08 53 54 57 58 XX 55P03"
# The SQL contract's assertion failures: pg_temp.ok raises this, nothing else does.
ASSERT_STATE=TF001
# Where the runner's injections are planted in a copy of the contract.
POINT_ANCHOR="-- OBRP_INJECT_POINT (the runner's negative controls insert one statement here)
"

# sqlstate_kind <state>: assertion | interruption | behavioral | unparseable.
sqlstate_kind() {
  local p
  case "$1" in
    [0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z]) ;;
    *) echo unparseable; return;;
  esac
  [ "$1" = "$ASSERT_STATE" ] && { echo assertion; return; }
  for p in $INTERRUPTION_PREFIXES; do
    case "$1" in "$p"*) echo interruption; return;; esac
  done
  echo behavioral
}

# contract_verdict <psql exit> <output file>: judge one run of the SQL contract
# (psql -f, ON_ERROR_STOP, VERBOSITY=verbose, so every error line carries its
# SQLSTATE). Sets VERDICT; returns 0 passed, 1 a completed assertion failed,
# 2 NEVER-RAN. psql's exit 3 says only that a statement raised.
contract_verdict() {
  local code="$1" file="$2" first state msg
  first=$(grep -m1 -E '^psql:.*:[0-9]+: ERROR:  ' "$file")
  case "$code" in
    0)
      if [ -n "$first" ]; then VERDICT="psql exited 0 but its output carries an error"; return 2; fi
      if grep -Eq '^psql:.*:[0-9]+: NOTICE:  00000: DEDUP SQL TEST PASSED$' "$file"; then VERDICT="passed"; return 0; fi
      VERDICT="the SQL contract exited 0 without its PASSED line"; return 2;;
    3)
      state=$(printf '%s\n' "$first" | sed -nE 's/^psql:.*:[0-9]+: ERROR:  ([0-9A-Z]{5}): .*$/\1/p')
      msg=$(printf '%s\n' "$first" | sed -E 's/^psql:.*:[0-9]+: ERROR:  ([0-9A-Z]{5}: )?//' | cut -c1-240)
      case "$(sqlstate_kind "$state")" in
        assertion)
          case "$msg" in
            "FAIL "*) VERDICT="$msg"; return 1;;
          esac
          VERDICT="SQLSTATE $ASSERT_STATE without a FAIL message, so no named check failed: $msg"; return 2;;
        interruption) VERDICT="the SQL contract was interrupted (SQLSTATE $state: $msg); the statement did not complete, so no check was judged"; return 2;;
        behavioral) VERDICT="the SQL contract stopped on an SQL error that is not one of its assertions (SQLSTATE $state: $msg); no check judged it, so it is not a failure and not a catch"; return 2;;
        *) VERDICT="the SQL contract stopped (psql exit 3) on an error with no readable SQLSTATE: $(printf '%s' "${first:-$(tail -1 "$file")}" | cut -c1-200)"; return 2;;
      esac;;
    *) VERDICT="the SQL contract did not complete (psql exit $code): $(tail -1 "$file" | cut -c1-160)"; return 2;;
  esac
}

# classify <mutation> <exit code> <output>: prints one line; returns 0 CAUGHT,
# 1 SURVIVED, 2 NEVER-RAN. An exit 1 is a catch only when the run printed a
# completed "FAIL " line and nothing in it says the run was cut short: no
# NEVER-RAN line, and no SQL error line other than a contract assertion.
classify() {
  local m="$1" code="$2" out="$3" line bad
  case "$code" in
    1)
      bad=$(printf '%s\n' "$out" | grep -m1 '^NEVER-RAN')
      if [ -n "$bad" ]; then echo "NEVER-RAN $m: exit 1, but the run says it did not complete: $(printf '%s' "$bad" | cut -c1-160)"; return 2; fi
      bad=$(printf '%s\n' "$out" | grep -E '^ERROR' | grep -m1 -v "^ERROR $ASSERT_STATE: FAIL ")
      if [ -n "$bad" ]; then echo "NEVER-RAN $m: exit 1, but the output carries an SQL error that is not a completed assertion: $(printf '%s' "$bad" | cut -c1-160)"; return 2; fi
      line=$(printf '%s\n' "$out" | grep -m1 '^FAIL ' | cut -c1-240)
      if [ -n "$line" ]; then echo "CAUGHT    $m: $line"; return 0; fi
      echo "NEVER-RAN $m: exit 1 with no completed FAIL line: $(printf '%s\n' "$out" | tail -1 | cut -c1-140)"; return 2;;
    0) echo "SURVIVED  $m"; return 1;;
    124) echo "NEVER-RAN $m: deadline of ${MUTANT_DEADLINE}s exceeded, the run did not complete"; return 2;;
    *) echo "NEVER-RAN $m (exit $code): $(printf '%s\n' "$out" | tail -1 | cut -c1-140)"; return 2;;
  esac
}

# sent_identity <psql -e output> <contract as run> <contract source> <anchor>
# <injection>: prints ONE line, "OBDD_SENT_IDENTITY same: ...", "... differs:
# ..." or "... unknown: ...". Which statement raised the first error is read
# from what psql SENT, not inferred from a frame (Codex re-review 2 of PR 33,
# F1; PR 32's closeout-routes-sql-test.sh identity rule). The contract runs with
# psql -e (ECHO=queries): psql prints each statement just before sending it and
# flushes stdout before the server's notices and errors reach stderr, so in the
# merged output every psql message ("psql:<file>:<line>: <SEVERITY>:  ...",
# through its LOCATION line, VERBOSITY=verbose) belongs to the statement whose
# echo is the last echoed line above it. "same" needs all of:
#   - the planted block (the contract as run, minus the contract source, at
#     the anchor) holds no backslash, and the source's only meta-command is
#     its own "\set ON_ERROR_STOP 1" line: a meta-command can stop psql
#     echoing (\set ECHO none) or make it echo input lines instead of the
#     statements it sends (\set ECHO all), and then the echo no longer says
#     what was sent;
#   - exactly one marker NOTICE for the injection, and an ERROR after it, both
#     from the contract file;
#   - psql echoed something before the marker, and echoed NOTHING between the
#     marker and the first error: no other statement was sent in between, so
#     the statement psql sent last before the error is the one it sent last
#     before the marker, the statement that raised the marker;
#   - and both messages name the same input line (a second, independent
#     witness: under the two rules above it always holds, see the report).
sent_identity() {
  python3 - "$@" <<'PY' 2>/dev/null || echo "OBDD_SENT_IDENTITY unknown: the identity judge did not run"
import re, sys
out_path, run_path, src_path, anchor, inj = sys.argv[1:6]
def say(kind, msg):
    print(f"OBDD_SENT_IDENTITY {kind}: {msg}"[:600]); sys.exit(0)
lines = open(out_path, encoding="utf-8", errors="replace").read().split("\n")
if lines and lines[-1] == "": lines.pop()
run = open(run_path, encoding="utf-8").read(); src = open(src_path, encoding="utf-8").read()
if src.count(anchor) != 1: say("unknown", "the contract source does not hold its injection anchor exactly once")
cut = src.index(anchor) + len(anchor)
head, tail = src[:cut], src[cut:]
if not (len(run) >= len(head) + len(tail) and run.startswith(head) and run.endswith(tail)):
    say("unknown", "the contract as run is not the contract source with one block planted at its anchor")
if "\\" in run[len(head):len(run) - len(tail)]:
    say("differs", "the planted block holds a backslash, so a psql meta-command could change what psql echoes")
meta = [l for l in src.split("\n") if l.lstrip().startswith("\\") or re.search(r";\s*\\[A-Za-z]", l)]
if meta != ["\\set ON_ERROR_STOP 1"]:
    say("unknown", f"the contract source's meta-commands are not exactly \\set ON_ERROR_STOP 1: {meta}")
MSG = re.compile(r"^psql:(.+):([0-9]+): ([A-Z]+):  (.*)$")
blocks, echo, k = [], [], 0
while k < len(lines):
    m = MSG.match(lines[k])
    if not m:
        echo.append(k); k += 1; continue
    j = k + 1
    while j < len(lines) and not lines[j].startswith("LOCATION:  ") and not MSG.match(lines[j]):
        j += 1
    if j >= len(lines) or not lines[j].startswith("LOCATION:  "):
        say("unknown", f"psql's message at output line {k + 1} has no LOCATION line, so where it ends is not known")
    blocks.append({"start": k, "end": j, "file": m.group(1), "line": int(m.group(2)), "sev": m.group(3), "text": m.group(4)})
    k = j + 1
markers = [b for b in blocks if b["sev"] == "NOTICE" and b["text"] == f"00000: OBDD_INJECT_REACHED {inj}"]
if len(markers) != 1: say("unknown", f"the marker NOTICE for {inj} was raised {len(markers)} time(s)")
errors = [b for b in blocks if b["sev"] == "ERROR"]
if not errors: say("unknown", "the run raised no error")
mk, er = markers[0], errors[0]
if mk["file"] != run_path or er["file"] != run_path:
    say("unknown", f"the marker or the error was not raised from the contract file ({mk['file']}, {er['file']})")
if er["start"] < mk["start"]: say("differs", "the first error came before the marker")
before = [e for e in echo if e < mk["start"]]
if not before: say("differs", "psql echoed nothing before the marker, so the statement that raised it is not known")
sent = lines[before[-1]]
between = [lines[e] for e in echo if mk["end"] < e < er["start"]]
if between:
    say("differs", f"psql sent another statement between the marker and the error: `{between[0][:160]}` (the marker's statement was `{sent[:160]}`)")
if mk["line"] != er["line"]:
    say("differs", f"the marker came from input line {mk['line']} and the error from input line {er['line']}")
say("same", f"input line {er['line']}, `{sent[:300]}`")
PY
}

# Canned transcripts with the verdict each must get; no database. Run by
# --verdict-selftest and, silently, before any run trusts a verdict. Fields:
# want | contract or classify | exit code | output (\n separates lines).
verdict_selftest() {
  local d n=0 bad=0 got want kind code body P="psql:/x/t.sql:9:"
  d=$(mktemp -d /tmp/obdd-verdict.XXXXXX)
  while IFS='|' read -r want kind code body; do
    [ -z "$want" ] && continue
    n=$((n + 1))
    body=$(printf '%s' "$body" | sed "s#@P#$P#g")
    printf '%b\n' "$body" > "$d/out"
    VERDICT=""
    case "$kind" in
      contract) contract_verdict "$code" "$d/out"; got=$?;;
      classify) VERDICT=$(classify m "$code" "$(cat "$d/out")"); got=$?;;
      kind) VERDICT=$(sqlstate_kind "$code"); [ "$VERDICT" = "$body" ]; got=$?;;
    esac
    if [ "$got" != "$want" ]; then
      bad=$((bad + 1)); echo "FAIL verdict case $n ($kind, exit $code): got $got, expected $want: $VERDICT"
    fi
  done <<'CASES'
0|contract|0|@P NOTICE:  00000: PASS T01 x\nLOCATION:  exec_stmt_raise, pl_exec.c:3911\n@P NOTICE:  00000: DEDUP SQL TEST PASSED\nLOCATION:  exec_stmt_raise, pl_exec.c:3911
2|contract|0|@P NOTICE:  00000: PASS T01 x
2|contract|0|@P NOTICE:  00000: PASS T01 x\n@P ERROR:  TF001: FAIL T02 y: z\n@P NOTICE:  00000: DEDUP SQL TEST PASSED
1|contract|3|@P NOTICE:  00000: PASS T01 x\n@P ERROR:  TF001: FAIL T08 a keep on a deferred item is refused: recorded|kept c1080001\nCONTEXT:  PL/pgSQL function pg_temp_3.ok(text,boolean,text) line 4 at RAISE
2|contract|3|@P ERROR:  57014: canceling statement due to statement timeout\nLOCATION:  ProcessInterrupts, postgres.c:3382
2|contract|3|@P NOTICE:  00000: PASS T01 x\n@P ERROR:  57014: canceling statement due to user request
2|contract|3|@P ERROR:  57P01: terminating connection due to administrator command
2|contract|3|@P ERROR:  08006: connection failure
2|contract|3|@P ERROR:  53200: out of memory
2|contract|3|@P ERROR:  53100: could not extend file: No space left on device
2|contract|3|@P ERROR:  54001: stack depth limit exceeded
2|contract|3|@P ERROR:  58030: could not read block 0
2|contract|3|@P ERROR:  XX000: unexpected internal state
2|contract|3|@P ERROR:  55P03: canceling statement due to lock timeout
2|contract|3|@P ERROR:  23503: insert or update on table "action_items" violates foreign key constraint "action_items_triage_replacement_id_fkey"
2|contract|3|@P ERROR:  22012: division by zero
2|contract|3|@P ERROR:  P0001: FAIL T02 looks like a check but is not the contract's SQLSTATE
2|contract|3|@P ERROR:  TF001: T02 the contract's SQLSTATE without the FAIL marker
2|contract|3|@P ERROR:  canceling statement due to statement timeout
2|contract|3|@P ERROR:  FAIL T02 a FAIL message with no SQLSTATE at all
2|contract|3|@P NOTICE:  00000: PASS T01 x
2|contract|3|
2|contract|2|psql: error: connection to server at "127.0.0.1", port 1 failed
2|contract|1|psql: fatal
2|contract|124|@P ERROR:  TF001: FAIL T02 y: z
0|classify|1|migration applied over 3 existing rows\nPASS T01 x\nERROR TF001: FAIL T08 a keep on a deferred item is refused: recorded\nFAIL DEDUP SQL TEST: FAIL T08 a keep on a deferred item is refused: recorded
0|classify|1|PASS C1 x\nFAIL C2: the review behind the archive was not refused (recorded|kept c0910001)
0|classify|1|PASS I helper list\nFAIL integration: MCP review: a keep is recorded
2|classify|1|ERROR 57014: canceling statement due to statement timeout\nFAIL DEDUP SQL TEST: canceling statement due to statement timeout
2|classify|1|ERROR: canceling statement due to statement timeout\nFAIL DEDUP SQL TEST: canceling statement due to statement timeout
2|classify|1|ERROR 23503: insert or update on table "action_items" violates foreign key constraint\nFAIL DEDUP SQL TEST: insert or update on table
2|classify|1|ERROR TF001: not a fail message\nFAIL DEDUP SQL TEST: x
2|classify|1|ERROR: FAIL T38 the old display shape, with no SQLSTATE
2|classify|1|FAIL C1: the first review did not record\nNEVER-RAN: a helper query did not execute
2|classify|1|NEVER-RAN: the script stopped before its last check
2|classify|1|something died
2|classify|1|
2|classify|1|PASS T01 x\n  FAIL indented is not a verdict line
1|classify|0|DEDUP TEST COMPLETE (mutation x)
2|classify|124|FAIL C2: printed before the deadline killed the run
2|classify|2|NEVER-RAN: initdb failed
2|classify|3|FAIL x
2|classify|137|FAIL x
0|kind|TF001|assertion
0|kind|57014|interruption
0|kind|57P01|interruption
0|kind|08006|interruption
0|kind|53200|interruption
0|kind|54001|interruption
0|kind|58030|interruption
0|kind|XX000|interruption
0|kind|55P03|interruption
0|kind|55000|behavioral
0|kind|23503|behavioral
0|kind|23514|behavioral
0|kind|22023|behavioral
0|kind|40P01|behavioral
0|kind|P0001|behavioral
0|kind||unparseable
0|kind|5701|unparseable
0|kind|57014x|unparseable
0|kind|tf001|unparseable
CASES
  # sent_identity on canned psql -e transcripts (Codex re-review 2 of PR 33,
  # F1). The contract source is src.sql: its one meta-command, a statement,
  # the anchor, a statement. Each case plants its block (\n separates lines,
  # starting at input line 4) and gives psql's output (@F is
  # "psql:<the run file>"). Fields: want (same, differs or unknown) | case |
  # planted block | output.
  local idn=0 idbad=0 iwant iname iplant ibody igot
  printf '%s\n' '\set ON_ERROR_STOP 1' 'select 1;' > "$d/src.sql"
  printf '%s' "$POINT_ANCHOR" >> "$d/src.sql"
  printf '%s\n' 'select 2;' >> "$d/src.sql"
  while IFS='|' read -r iwant iname iplant ibody; do
    [ -z "$iwant" ] && continue
    idn=$((idn + 1))
    { printf '%s\n' '\set ON_ERROR_STOP 1' 'select 1;'; printf '%s' "$POINT_ANCHOR"; printf '%b\n' "$iplant"; printf '%s\n' 'select 2;'; } > "$d/run.sql"
    [ "$iname" = "the run is not the source plus one block" ] && printf '%s\n' 'select 3;' >> "$d/run.sql"
    printf '%b\n' "$(printf '%s' "$ibody" | sed "s#@F#psql:$d/run.sql#g")" > "$d/idout"
    igot=$(sent_identity "$d/idout" "$d/run.sql" "$d/src.sql" "$POINT_ANCHOR" x)
    case "$igot" in "OBDD_SENT_IDENTITY $iwant: "*) ;; *) idbad=$((idbad + 1)); echo "FAIL identity case $idn ($iname): expected $iwant, got: $igot";; esac
  done <<'IDCASES'
same|one statement raised the marker and the error|do $o$ begin raise notice 'OBDD_INJECT_REACHED x'; perform 1/0; end $o$;|select 1;\n ?column? \n----------\n        1\n(1 row)\n\ndo $o$ begin raise notice 'OBDD_INJECT_REACHED x'; perform 1/0; end $o$;\n@F:4: NOTICE:  00000: OBDD_INJECT_REACHED x\nLOCATION:  exec_stmt_raise, pl_exec.c:3911\n@F:4: ERROR:  22012: division by zero\nCONTEXT:  SQL statement "SELECT 1/0"\nPL/pgSQL function inline_code_block line 1 at PERFORM\nLOCATION:  int4div, int.c:846
same|a multi-line statement with a notice before the marker|do $o$ begin\n  raise notice 'other';\n  raise notice 'OBDD_INJECT_REACHED x'; perform 1/0; end $o$;|select 1;\ndo $o$ begin\n  raise notice 'other';\n  raise notice 'OBDD_INJECT_REACHED x'; perform 1/0; end $o$;\n@F:6: NOTICE:  00000: other\nLOCATION:  exec_stmt_raise, pl_exec.c:3911\n@F:6: NOTICE:  00000: OBDD_INJECT_REACHED x\nLOCATION:  exec_stmt_raise, pl_exec.c:3911\n@F:6: ERROR:  22012: division by zero\nLOCATION:  int4div, int.c:846
differs|two anonymous blocks on two lines (Codex)|do $a$ begin raise notice 'OBDD_INJECT_REACHED x'; end $a$;\ndo $b$ begin perform 1/0; end $b$;|select 1;\ndo $a$ begin raise notice 'OBDD_INJECT_REACHED x'; end $a$;\n@F:4: NOTICE:  00000: OBDD_INJECT_REACHED x\nLOCATION:  exec_stmt_raise, pl_exec.c:3911\ndo $b$ begin perform 1/0; end $b$;\n@F:5: ERROR:  22012: division by zero\nLOCATION:  int4div, int.c:846
differs|two anonymous blocks on one line|do $a$ begin raise notice 'OBDD_INJECT_REACHED x'; end $a$; do $b$ begin perform 1/0; end $b$;|select 1;\ndo $a$ begin raise notice 'OBDD_INJECT_REACHED x'; end $a$;\n@F:4: NOTICE:  00000: OBDD_INJECT_REACHED x\nLOCATION:  exec_stmt_raise, pl_exec.c:3911\ndo $b$ begin perform 1/0; end $b$;\n@F:4: ERROR:  22012: division by zero\nLOCATION:  int4div, int.c:846
differs|psql set to echo input lines, both blocks on one line|\\set ECHO all\ndo $a$ begin raise notice 'OBDD_INJECT_REACHED x'; end $a$; do $b$ begin perform 1/0; end $b$;|select 1;\ndo $a$ begin raise notice 'OBDD_INJECT_REACHED x'; end $a$; do $b$ begin perform 1/0; end $b$;\n@F:5: NOTICE:  00000: OBDD_INJECT_REACHED x\nLOCATION:  exec_stmt_raise, pl_exec.c:3911\n@F:5: ERROR:  22012: division by zero\nLOCATION:  int4div, int.c:846
differs|no echo between, but the marker and the error name different input lines|do $a$ begin raise notice 'OBDD_INJECT_REACHED x'; end $a$;\ndo $b$ begin perform 1/0; end $b$;|select 1;\ndo $a$ begin raise notice 'OBDD_INJECT_REACHED x'; end $a$;\n@F:4: NOTICE:  00000: OBDD_INJECT_REACHED x\nLOCATION:  exec_stmt_raise, pl_exec.c:3911\n@F:5: ERROR:  22012: division by zero\nLOCATION:  int4div, int.c:846
differs|the first error comes before the marker|do $o$ begin perform 1/0; end $o$;|select 1;\ndo $o$ begin perform 1/0; end $o$;\n@F:4: ERROR:  22012: division by zero\nLOCATION:  int4div, int.c:846\n@F:4: NOTICE:  00000: OBDD_INJECT_REACHED x\nLOCATION:  exec_stmt_raise, pl_exec.c:3911
differs|nothing echoed before the marker|do $o$ begin raise notice 'OBDD_INJECT_REACHED x'; perform 1/0; end $o$;|@F:4: NOTICE:  00000: OBDD_INJECT_REACHED x\nLOCATION:  exec_stmt_raise, pl_exec.c:3911\n@F:4: ERROR:  22012: division by zero\nLOCATION:  int4div, int.c:846
unknown|the marker twice|do $o$ begin raise notice 'OBDD_INJECT_REACHED x'; raise notice 'OBDD_INJECT_REACHED x'; perform 1/0; end $o$;|select 1;\ndo $o$ begin raise notice 'OBDD_INJECT_REACHED x'; raise notice 'OBDD_INJECT_REACHED x'; perform 1/0; end $o$;\n@F:4: NOTICE:  00000: OBDD_INJECT_REACHED x\nLOCATION:  exec_stmt_raise, pl_exec.c:3911\n@F:4: NOTICE:  00000: OBDD_INJECT_REACHED x\nLOCATION:  exec_stmt_raise, pl_exec.c:3911\n@F:4: ERROR:  22012: division by zero\nLOCATION:  int4div, int.c:846
unknown|no error|do $o$ begin raise notice 'OBDD_INJECT_REACHED x'; end $o$;|select 1;\ndo $o$ begin raise notice 'OBDD_INJECT_REACHED x'; end $o$;\n@F:4: NOTICE:  00000: OBDD_INJECT_REACHED x\nLOCATION:  exec_stmt_raise, pl_exec.c:3911
unknown|a message with no LOCATION line|do $o$ begin raise notice 'OBDD_INJECT_REACHED x'; perform 1/0; end $o$;|select 1;\ndo $o$ begin raise notice 'OBDD_INJECT_REACHED x'; perform 1/0; end $o$;\n@F:4: NOTICE:  00000: OBDD_INJECT_REACHED x\n@F:4: ERROR:  22012: division by zero\nLOCATION:  int4div, int.c:846
unknown|the run is not the source plus one block|do $o$ begin raise notice 'OBDD_INJECT_REACHED x'; perform 1/0; end $o$;|select 1;\ndo $o$ begin raise notice 'OBDD_INJECT_REACHED x'; perform 1/0; end $o$;\n@F:4: NOTICE:  00000: OBDD_INJECT_REACHED x\nLOCATION:  exec_stmt_raise, pl_exec.c:3911\n@F:4: ERROR:  22012: division by zero\nLOCATION:  int4div, int.c:846
unknown|the marker from another file|do $o$ begin raise notice 'OBDD_INJECT_REACHED x'; perform 1/0; end $o$;|select 1;\ndo $o$ begin raise notice 'OBDD_INJECT_REACHED x'; perform 1/0; end $o$;\npsql:/elsewhere.sql:4: NOTICE:  00000: OBDD_INJECT_REACHED x\nLOCATION:  exec_stmt_raise, pl_exec.c:3911\n@F:4: ERROR:  22012: division by zero\nLOCATION:  int4div, int.c:846
IDCASES
  rm -rf "$d"
  [ "$n" = 62 ] || { echo "VERDICT SELFTEST FAILED: ran $n cases, expected 62 (a case was lost)"; return 1; }
  [ "$idn" = 13 ] || { echo "VERDICT SELFTEST FAILED: ran $idn identity cases, expected 13 (a case was lost)"; return 1; }
  if [ "$bad" -gt 0 ] || [ "$idbad" -gt 0 ]; then echo "VERDICT SELFTEST FAILED ($bad of $n verdict cases, $idbad of $idn identity cases)"; return 1; fi
  echo "VERDICT SELFTEST PASSED ($n cases, $idn identity cases)"; return 0
}

if [ "${1:-}" = "--verdict-selftest" ]; then
  verdict_selftest; exit $?
fi
# No verdict below is trusted unless the classifiers pass their own cases.
vst=$(verdict_selftest) || { echo "NEVER-RAN: the verdict classifiers failed their own self-test, so no verdict can be trusted: $(printf '%s\n' "$vst" | grep -m1 '^FAIL')"; exit 2; }

if [ "${1:-}" = "--all-mutations" ]; then
  caught=0; survived=0; never=0; n=0
  shm_before=$(ipcs -m 2>/dev/null | grep -c '^m')
  for m in ${OBFG_MUTATIONS:-$MUTATIONS}; do
    n=$((n + 1))
    out=$(python3 "$HERE/deadline.py" "$MUTANT_DEADLINE" bash "$0" --mutate "$m" 2>&1); code=$?
    classify "$m" "$code" "$out"
    case $? in 0) caught=$((caught + 1));; 1) survived=$((survived + 1));; *) never=$((never + 1));; esac
  done
  shm_after=$(ipcs -m 2>/dev/null | grep -c '^m')
  [ "$shm_after" -gt "$shm_before" ] && echo "WARNING: SysV shared memory segments grew from $shm_before to $shm_after during the sweep"
  echo "SWEEP: $n mutations, $caught caught, $survived survived, $never never ran"
  if [ "$never" -gt 0 ]; then echo "SWEEP INCOMPLETE: $never mutant(s) never ran; they are not catches"; exit 2; fi
  if [ "$survived" -gt 0 ]; then exit 1; fi
  echo "ALL $n MUTATIONS CAUGHT"
  exit 0
fi

# The injections: name | expected exit | ERE the run's first FAIL/NEVER-RAN line
# must match | where the error must have been raised: "-" not checked (the
# diagnostic carries a token only the planted code produces and is not a SQL
# contract error), "none" a top-level contract statement (the run's
# OBDD_ERROR_CONTEXT line is "(none)"), otherwise an ERE that line must match:
# the PL/pgSQL frames the error passed through (Codex re-review 1 of PR 33, F1).
# sql_timeout's diagnostic is the generic 57014 line, so its site names the one
# function that raises its marker and sleeps; assert_fail and raw_error must be
# raised inside their planted DO block (their diagnostics also carry tokens).
# bridge_scalar_column and bridge_object_json are Codex's two planted adapter
# faults (review 1 of PR 33, R2): an SQL error in the bridge itself must end
# NEVER-RAN, never a completed failure. bridge_assert_fail is their positive
# control: a wrong persisted value, no SQL error, must still be a completed
# failure (exit 1); the value, 0.31415926, is written only by its trigger.
inject_table() {
  cat <<'T'
assert_fail|1|^FAIL DEDUP SQL TEST: FAIL INJECTED obdd_assert_fail a completed check that does not hold: one is not two$|^OBDD_ERROR_CONTEXT PL/pgSQL function pg_temp(_[0-9]+)?\.ok\(text,boolean,text\) line [0-9]+ at RAISE \| SQL statement "SELECT pg_temp\.ok\('INJECTED obdd_assert_fail a completed check that does not hold', 1 = 2, 'one is not two'\)" \| PL/pgSQL function inline_code_block line [0-9]+ at PERFORM$
raw_error|2|^NEVER-RAN: the SQL contract stopped on an SQL error that is not one of its assertions \(SQLSTATE 22P02: invalid input syntax for type integer: "obdd_raw_error"\)|^OBDD_ERROR_CONTEXT PL/pgSQL function inline_code_block line [0-9]+ at PERFORM$
sql_timeout|2|^NEVER-RAN: the SQL contract was interrupted \(SQLSTATE 57014: canceling statement due to statement timeout\)|^OBDD_ERROR_CONTEXT SQL statement "SELECT pg_sleep\(p_secs\)" \| PL/pgSQL function pg_temp(_[0-9]+)?\.obdd_reach_then_sleep\(text,double precision\) line [0-9]+ at PERFORM$
helper_fail|2|^NEVER-RAN: every check held, but a helper query did not execute during the run \(psql exit 1: ERROR:  22P02: invalid input syntax for type integer: "obdd_helper_fail"|-
integration_cancel|2|^NEVER-RAN: statement interrupted at insert action_items returning id, description \(SQLSTATE 57014: canceling statement due to statement timeout \(obdd_integration_cancel\)\)$|-
bridge_scalar_column|2|^NEVER-RAN: an SQL error no check expects, at rpc record_decisions \(SQLSTATE 42703: column "obdd_injected_missing_column" does not exist\)|-
bridge_object_json|2|^NEVER-RAN: an SQL error no check expects, at rpc record_decisions \(SQLSTATE 22P02: invalid input syntax for type json; Token "obdd_injected_invalid_json" is invalid\.\)|-
bridge_assert_fail|1|^FAIL integration: I2 proposal row: \[\{.*"score":0\.31415926[,}]|-
T
}
if [ "${1:-}" = "--inject-selftest" ]; then
  bad=0; inc=0; n=0
  # Set but empty is an empty table (INCOMPLETE), never a silent fall back to the default.
  table="${OBDD_INJECT_TABLE-$(inject_table)}"
  while IFS='|' read -r inj want re where; do
    [ -z "$inj" ] && continue
    n=$((n + 1))
    if [ -z "$where" ]; then inc=$((inc + 1)); echo "INJECT INCOMPLETE $inj: the table entry names no error site (use - to skip that check)"; continue; fi
    out=$(OBFG_INJECT="$inj" python3 "$HERE/deadline.py" "$MUTANT_DEADLINE" bash "$0" </dev/null 2>&1); code=$?
    decisive=$(printf '%s\n' "$out" | grep -m1 -E '^(FAIL|NEVER-RAN)' | cut -c1-300)
    reached=$(printf '%s\n' "$out" | grep -cx "OBDD_INJECT_REACHED $inj")
    other=$(printf '%s\n' "$out" | grep '^OBDD_INJECT_REACHED ' | grep -m1 -vx "OBDD_INJECT_REACHED $inj")
    ctxs=$(printf '%s\n' "$out" | grep -c '^OBDD_ERROR_CONTEXT ')
    ctx=$(printf '%s\n' "$out" | grep -m1 '^OBDD_ERROR_CONTEXT ')
    ids=$(printf '%s\n' "$out" | grep -c '^OBDD_SENT_IDENTITY ')
    sent=$(printf '%s\n' "$out" | grep -m1 '^OBDD_SENT_IDENTITY ')
    site_ok=1; sent_ok=1
    case "$where" in
      -) ;;
      none) [ "$ctxs" = 1 ] && [ "$ctx" = "OBDD_ERROR_CONTEXT (none)" ] || site_ok=0;;
      *) [ "$ctxs" = 1 ] && printf '%s\n' "$ctx" | grep -Eq -- "$where" || site_ok=0;;
    esac
    # A contract injection: the marker and the error from one sent statement.
    if [ "$where" != - ]; then
      [ "$ids" = 1 ] && case "$sent" in "OBDD_SENT_IDENTITY same: "*) true;; *) false;; esac || sent_ok=0
    fi
    if [ "$code" = 124 ]; then
      inc=$((inc + 1)); echo "INJECT INCOMPLETE $inj: the run hit its ${MUTANT_DEADLINE}s deadline"
    elif [ "$reached" != 1 ] || [ -n "$other" ]; then
      inc=$((inc + 1)); echo "INJECT INCOMPLETE $inj: the injection did not reach its site (OBDD_INJECT_REACHED $inj seen $reached time(s)${other:+, and $other}); exit $code: ${decisive:-$(printf '%s\n' "$out" | tail -1 | cut -c1-160)}"
    elif [ "$code" != "$want" ]; then
      bad=$((bad + 1)); echo "INJECT BAD  $inj: reached its site, but exit $code, expected $want: ${decisive:-$(printf '%s\n' "$out" | tail -1 | cut -c1-160)}"
    elif ! printf '%s\n' "$decisive" | grep -Eq -- "$re"; then
      bad=$((bad + 1)); echo "INJECT BAD  $inj: reached its site and exit $code, but not its diagnostic: ${decisive:-none} (expected /$re/)"
    elif [ "$site_ok" != 1 ]; then
      bad=$((bad + 1)); echo "INJECT BAD  $inj: reached its site, exit $code and its diagnostic, but the error was not raised where it must be: $(printf '%s' "${ctx:-no OBDD_ERROR_CONTEXT line}" | cut -c1-400) ($ctxs line(s); expected $where)"
    elif [ "$sent_ok" != 1 ]; then
      bad=$((bad + 1)); echo "INJECT BAD  $inj: reached its site, exit $code, its diagnostic and its frame, but the error was not raised by the statement that printed the marker: $(printf '%s' "${sent:-no OBDD_SENT_IDENTITY line}" | cut -c1-400) ($ids line(s))"
    else
      echo "INJECT ok   $inj: reached, exit $code, $decisive${ctx:+; $(printf '%s' "$ctx" | cut -c1-400)}$([ "$where" != - ] && printf '; %s' "$(printf '%s' "$sent" | cut -c1-300)")"
    fi
  done <<< "$table"
  if [ "$bad" -gt 0 ]; then echo "INJECT SELFTEST FAILED ($bad of $n wrong, $inc incomplete)"; exit 1; fi
  if [ "$n" = 0 ]; then echo "INJECT SELFTEST INCOMPLETE (the table held no injections, so nothing was controlled)"; exit 2; fi
  if [ "$inc" -gt 0 ]; then echo "INJECT SELFTEST INCOMPLETE ($inc of $n did not reach their site or finish; they are not controls)"; exit 2; fi
  if [ -z "${OBDD_INJECT_TABLE+set}" ] && [ "$n" != 8 ]; then echo "INJECT SELFTEST INCOMPLETE (ran $n injections, expected 8: an entry was lost)"; exit 2; fi
  echo "INJECT SELFTEST PASSED ($n of $n)"; exit 0
fi

# Controls OF the self-test: each runs --inject-selftest on a one-entry table and
# must end with the named exit and summary line. A to D are the shapes the
# exit-only self-test accepted (Codex review 1 of PR 33, R3): an unknown name;
# Codex's fresh-05 planted fault (the cancellation trigger on a table that does
# not exist, so it never fires) under integration_cancel's own checks; a run that
# ends NEVER-RAN for an unrelated reason before the bridge; and the right exit
# with the wrong diagnostic. E is a reached injection with the wrong exit. F is
# the positive control that proves A to E fail for the reason they name.
# G to L are the timeout-site controls (Codex re-review 1 of PR 33, F1), each
# under sql_timeout's own diagnostic and site: G is Codex's displaced plant as
# written (the marker's DO block completes, an unrelated top-level sleep times
# out), H the same with the marker raised by a function that returns before a
# separate sleep, I a timeout before the marker statement; J is the positive
# control that proves G to I fail for the reason they name; K proves the
# "none" site check can fail (the real in-function timeout under it); L moves
# raw_error's planted cast out of its DO block, under raw_error's own checks;
# M is an entry with no site field, which must be INCOMPLETE without a run.
# N to S are the sending-statement controls (Codex re-review 2 of PR 33, F1):
# the marker's statement completes and a later one raises the error, each
# under the real entry's own checks. N (raw_error) and O (assert_fail) are
# Codex's two anonymous blocks, whose error frame is the planted one's; P is
# the same displacement for sql_timeout, whose frame then differs; Q redefines
# sql_timeout's function without the marker and calls it again, so its frame
# matches too; R puts N's two blocks on one line (one input line, two sent
# statements); S has psql echo input lines (\set ECHO all) with R's line, so
# only the meta-command rule sees it. Each must be FAILED.
if [ "${1:-}" = "--inject-selftest-controls" ]; then
  bad=0; n=0
  real_cancel=$(inject_table | grep '^integration_cancel|')
  cancel_checks=${real_cancel#integration_cancel|}
  real_timeout=$(inject_table | grep '^sql_timeout|')
  timeout_checks=${real_timeout#sql_timeout|}
  real_raw=$(inject_table | grep '^raw_error|')
  real_assert=$(inject_table | grep '^assert_fail|')
  ctl() { # label, want exit, required ERE, env assignments...
    local label="$1" want="$2" need="$3" out code; shift 3
    n=$((n + 1))
    out=$(env "$@" bash "$0" --inject-selftest </dev/null 2>&1); code=$?
    if [ "$code" = "$want" ] && printf '%s\n' "$out" | grep -Eq -- "$need"; then
      echo "CONTROL ok   $label: exit $code; $(printf '%s\n' "$out" | grep -E '^INJECT (ok|BAD|INCOMPLETE)' | head -1 | cut -c1-260)"
    else
      bad=$((bad + 1)); echo "CONTROL BAD  $label: exit $code, expected $want and /$need/: $(printf '%s\n' "$out" | tail -2 | tr '\n' ' ' | cut -c1-300)"
    fi
  }
  ctl "A unknown injection name" 2 '^INJECT INCOMPLETE no_such_injection: the injection did not reach its site' \
    OBDD_INJECT_TABLE='no_such_injection|2|^NEVER-RAN|-'
  ctl "B injection not installed (Codex's trigger on a missing table)" 2 '^INJECT INCOMPLETE selftest_cancel_not_installed: the injection did not reach its site' \
    OBDD_INJECT_TABLE="selftest_cancel_not_installed|$cancel_checks"
  ctl "C an unrelated NEVER-RAN before the injection site" 2 '^INJECT INCOMPLETE integration_cancel: the injection did not reach its site' \
    OBDD_INJECT_TABLE='integration_cancel|2|^NEVER-RAN|-' OBDD_SELFTEST_STOP_BEFORE_BRIDGE=1
  ctl "D reached with the right exit but the wrong diagnostic" 1 '^INJECT BAD  integration_cancel: reached its site and exit 2, but not its diagnostic' \
    OBDD_INJECT_TABLE='integration_cancel|2|^NEVER-RAN: a diagnostic this run never prints$|-'
  ctl "E reached with the wrong exit" 1 '^INJECT BAD  bridge_scalar_column: reached its site, but exit 2, expected 1' \
    OBDD_INJECT_TABLE='bridge_scalar_column|1|^FAIL|-'
  ctl "F the real integration_cancel entry alone" 0 '^INJECT SELFTEST PASSED \(1 of 1\)$' \
    OBDD_INJECT_TABLE="$real_cancel"
  ctl "G Codex's displaced timeout: the marker's statement completes, a later top-level sleep times out" 1 '^INJECT BAD  selftest_timeout_displaced: reached its site, exit 2 and its diagnostic, but the error was not raised where it must be: OBDD_ERROR_CONTEXT \(none\)' \
    OBDD_INJECT_TABLE="selftest_timeout_displaced|$timeout_checks"
  ctl "H the marker from a function that returns, then a separate sleep in a DO block" 1 '^INJECT BAD  selftest_timeout_after_return: reached its site, exit 2 and its diagnostic, but the error was not raised where it must be: OBDD_ERROR_CONTEXT SQL statement "SELECT pg_sleep\(2\)" \| PL/pgSQL function inline_code_block' \
    OBDD_INJECT_TABLE="selftest_timeout_after_return|$timeout_checks"
  ctl "I a timeout before the marker statement" 2 '^INJECT INCOMPLETE selftest_timeout_before_reach: the injection did not reach its site' \
    OBDD_INJECT_TABLE="selftest_timeout_before_reach|$timeout_checks"
  ctl "J the real sql_timeout entry alone" 0 '^INJECT SELFTEST PASSED \(1 of 1\)$' \
    OBDD_INJECT_TABLE="$real_timeout"
  ctl "K an in-function timeout is not a top-level one" 1 '^INJECT BAD  sql_timeout: reached its site, exit 2 and its diagnostic, but the error was not raised where it must be' \
    OBDD_INJECT_TABLE="sql_timeout|$(printf '%s\n' "$real_timeout" | cut -d'|' -f2,3)|none"
  ctl "L raw_error's cast moved out of its DO block" 1 '^INJECT BAD  selftest_raw_error_displaced: reached its site, exit 2 and its diagnostic, but the error was not raised where it must be: OBDD_ERROR_CONTEXT \(none\)' \
    OBDD_INJECT_TABLE="selftest_raw_error_displaced|${real_raw#raw_error|}"
  ctl "M an entry that names no error site" 2 '^INJECT INCOMPLETE sql_timeout: the table entry names no error site' \
    OBDD_INJECT_TABLE="sql_timeout|$(printf '%s\n' "$real_timeout" | cut -d'|' -f2,3)"
  NOT_SENT=': reached its site, exit [12], its diagnostic and its frame, but the error was not raised by the statement that printed the marker: OBDD_SENT_IDENTITY differs: '
  ctl "N raw_error's cast moved to a second anonymous block (Codex)" 1 "^INJECT BAD  selftest_raw_error_two_blocks${NOT_SENT}psql sent another statement between the marker and the error" \
    OBDD_INJECT_TABLE="selftest_raw_error_two_blocks|${real_raw#raw_error|}"
  ctl "O assert_fail's failing check moved to a second anonymous block (Codex)" 1 "^INJECT BAD  selftest_assert_fail_two_blocks${NOT_SENT}psql sent another statement between the marker and the error" \
    OBDD_INJECT_TABLE="selftest_assert_fail_two_blocks|${real_assert#assert_fail|}"
  ctl "P sql_timeout's sleep moved to a second anonymous block" 1 '^INJECT BAD  selftest_timeout_two_blocks: reached its site, exit 2 and its diagnostic, but the error was not raised where it must be: OBDD_ERROR_CONTEXT SQL statement "SELECT pg_sleep\(2\)" \| PL/pgSQL function inline_code_block' \
    OBDD_INJECT_TABLE="selftest_timeout_two_blocks|$timeout_checks"
  ctl "Q sql_timeout's function redefined without the marker and called again" 1 "^INJECT BAD  selftest_timeout_redefined${NOT_SENT}psql sent another statement between the marker and the error" \
    OBDD_INJECT_TABLE="selftest_timeout_redefined|$timeout_checks"
  ctl "R the two anonymous blocks on one line" 1 "^INJECT BAD  selftest_raw_error_same_line${NOT_SENT}psql sent another statement between the marker and the error" \
    OBDD_INJECT_TABLE="selftest_raw_error_same_line|${real_raw#raw_error|}"
  ctl "S psql set to echo input lines, the two blocks on one line" 1 "^INJECT BAD  selftest_raw_error_echo_all${NOT_SENT}the planted block holds a backslash" \
    OBDD_INJECT_TABLE="selftest_raw_error_echo_all|${real_raw#raw_error|}"
  [ "$bad" -eq 0 ] && { echo "INJECT SELFTEST CONTROLS PASSED ($n of $n)"; exit 0; }
  echo "INJECT SELFTEST CONTROLS FAILED ($bad of $n)"; exit 1
fi

MUTATE="${2:-}"; [ "${1:-}" = "--mutate" ] || MUTATE=""
INJECT="${OBFG_INJECT:-}"
# A port nothing is listening on.
PORT=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  p=$((55000 + RANDOM % 900))
  if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then PORT=$p; break; fi
done
[ -n "$PORT" ] || { echo "NEVER-RAN: no free port found"; exit 2; }
# The /tmp/obrp. prefix is the one deadline.py's reaper recognises.
WORK="$(mktemp -d /tmp/obrp.XXXXXX)"
COMPLETED=0
never() { echo "NEVER-RAN: $*"; exit 2; }
fail() {
  if [ -s "$WORK/qfail" ]; then never "a helper query did not execute while checking: $* ($(head -1 "$WORK/qfail" | cut -c1-200))"; fi
  echo "FAIL $*"; exit 1
}
cleanup() {
  local rc=$?
  pg_ctl -D "$WORK/pg" stop -m fast -t 10 >/dev/null 2>&1 || pg_ctl -D "$WORK/pg" stop -m immediate >/dev/null 2>&1
  rm -rf "$WORK"
  if [ "$COMPLETED" != 1 ] && [ "$rc" = 0 ]; then
    echo "NEVER-RAN: the script stopped before its last check"
    rc=2
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'echo "NEVER-RAN: interrupted by a signal"; exit 2' TERM INT HUP

if ! initdb -D "$WORK/pg" -A trust -U postgres --locale=en_US.UTF-8 >"$WORK/initdb.log" 2>&1; then
  if grep -q shmget "$WORK/initdb.log"; then
    never "initdb failed at shmget: SysV shared memory is exhausted or denied (check 'ipcs -m' for orphaned segments from killed clusters, kern.sysv.shmmni)"
  fi
  never "initdb failed: $(tail -1 "$WORK/initdb.log")"
fi
pg_ctl -D "$WORK/pg" -o "-p $PORT -c listen_addresses=127.0.0.1 -k $WORK" -l "$WORK/pg.log" start -w >/dev/null || never "pg start failed: $(tail -1 "$WORK/pg.log")"
PSQL=(psql -X -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -q)
"${PSQL[@]}" -d postgres -c "create database obtest" >/dev/null || never "create database failed"

"${PSQL[@]}" -d obtest <<'SQL' >/dev/null || never "stub schema failed"
create role service_role nologin bypassrls; create role anon nologin; create role authenticated nologin;
create schema auth;
create function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;
grant usage on schema auth to service_role, anon, authenticated;
create table public.thoughts (id uuid primary key, metadata jsonb);
create table public.business_events (id uuid primary key, title text);
create table public.agent_task_ledger (agent_code text primary key);
create table public.action_items (
  id uuid primary key default gen_random_uuid(),
  source_thought_id uuid references public.thoughts(id) on delete set null,
  description text not null,
  status text not null default 'open' check (status in ('open','resolved','archived','deferred')),
  resolved_by_thought_id uuid references public.thoughts(id) on delete set null,
  created_at timestamptz default now(),
  resolved_at timestamptz,
  resolution_note text,
  deferred_at timestamptz,
  defer_reason text
);
create table public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null default 't',
  status text not null,
  completed_at timestamptz, claimed_at timestamptz, claimed_by text, claim_expires_at timestamptz,
  blocked_reason text, review_reason text, operator_action text, operator_target text,
  linked_action_item_id uuid references public.action_items(id),
  parent_task_id uuid, archived_at timestamptz, updated_at timestamptz not null default now()
);
create table public.agent_task_events (
  id uuid primary key default gen_random_uuid(), task_id uuid not null, event_type text not null,
  agent_code text, payload jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
grant select, insert, update, delete on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
SQL

for f in "$M_MCP_LOG" "$M_DECISIONS" "$M_CLOSE" "$M_ARCHIVE" "$M_REVIEW"; do
  PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d obtest -f "$f" >"$WORK/prior.out" 2>&1 \
    || never "prior migration failed: $(basename "$f"): $(head -3 "$WORK/prior.out")"
done

# A helper query on a fresh connection. Any non-zero exit means it did not
# execute: recorded, and fail() then reports NEVER-RAN instead of a failure.
q() {
  local out code
  out=$("${PSQL[@]}" -d obtest -At -c "$1" 2>&1); code=$?
  if [ "$code" -ne 0 ]; then echo "psql exit $code: $(printf '%s' "$out" | head -1)" >> "$WORK/qfail"; fi
  printf '%s\n' "$out"
}

FN_SQL="select coalesce(string_agg(p.proname || ':' || md5(p.prosrc), ',' order by p.proname, md5(p.prosrc)), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'"
fn_before=$(q "$FN_SQL")
case "$fn_before" in *review_proposal:*) ;; *) never "could not read the public functions before the migration";; esac
case "$fn_before" in *dedup_semantic_candidates:*|*dedup_pending_proposals:*) never "a dedup read exists before its migration";; esac

SRC="$WORK/dedup.sql"; cp "$M_DEDUP" "$SRC"
mf() { # old, new: literal replace, exactly one occurrence
  python3 - "$SRC" "$1" "$2" <<'PY' || never "mutant did not change exactly one site: $(printf '%s' "$1" | head -1)"
import sys
p, a, b = sys.argv[1:4]
s = open(p).read()
if s.count(a) != 1: sys.exit(1)
open(p, 'w').write(s.replace(a, b))
PY
}
case "$MUTATE" in
  "") ;;
  # --- dedup_semantic_candidates ---
  # Closed and deferred items become candidates (C01).
  cand_any_status) mf "  where a.status = 'open'
    and a.created_at" "  where a.status is not null
    and a.created_at";;
  # No window: the 20-day-old item is a candidate (C01).
  cand_no_window) mf "    and a.created_at >= now() - make_interval(days => least(greatest(coalesce(p_window_days, 14), 1), 90))
" "";;
  # The window is not clamped (C02: 0 days reads nothing older than now, 1000 days reaches further).
  cand_window_unclamped) mf "make_interval(days => least(greatest(coalesce(p_window_days, 14), 1), 90))" "make_interval(days => coalesce(p_window_days, 14))";;
  # Newest first (C01, C03).
  cand_newest_first) mf "  order by a.created_at, a.id
  limit least(greatest(coalesce(p_limit, 500), 1), 1000)" "  order by a.created_at desc, a.id
  limit least(greatest(coalesce(p_limit, 500), 1), 1000)";;
  # No bounds on the limit (C03).
  cand_limit_unclamped) mf "  limit least(greatest(coalesce(p_limit, 500), 1), 1000)" "  limit coalesce(p_limit, 500)";;
  # A different default (C03).
  cand_limit_default_50) mf "  limit least(greatest(coalesce(p_limit, 500), 1), 1000)" "  limit least(greatest(coalesce(p_limit, 50), 1), 1000)";;
  # The project is not trimmed (C01).
  cand_project_untrimmed) mf "nullif(btrim(th.metadata->>'project'), '')" "nullif(th.metadata->>'project', '')";;
  # A blank project reads as a project, not as null (C01).
  cand_project_blank_kept) mf "nullif(btrim(th.metadata->>'project'), '')" "btrim(th.metadata->>'project')";;
  # An item with no source thought is not a candidate (C01).
  cand_inner_join) mf "  left join public.thoughts th on th.id = a.source_thought_id" "  join public.thoughts th on th.id = a.source_thought_id";;
  # --- dedup_pending_proposals ---
  # A proposal from before a reopen reads as pending (P02).
  pend_no_generation_filter) mf "      and d.item_generation = a.reopen_generation
" "";;
  # A proposal on a deferred item is listed (P01).
  pend_includes_deferred) mf "      and a.status = 'open'
      and d.item_generation" "      and a.status in ('open', 'deferred')
      and d.item_generation";;
  # A reviewed row is listed (P01, R03).
  pend_any_outcome) mf "      and d.outcome = 'proposed'" "      and d.outcome in ('proposed', 'kept', 'accepted')";;
  # Another layer's proposal is listed (P01). The reason filter alone is
  # redundant with the outcome filter under auto_resolve_decision_legal (dedup
  # rows that are proposed are semantic_overlap only), so this removes both the
  # layer and the reason filter.
  pend_any_layer) mf "    where d.layer = 'dedup'" "    where d.layer in ('dedup', 'fragment')"
                  mf "      and d.reason = 'semantic_overlap'
" "";;
  # Two rows for one item make two lines (P03).
  pend_no_distinct) mf "    select distinct on (a.id) d.id as decision_id" "    select d.id as decision_id";;
  # The older decision wins the one line (P03).
  pend_oldest_decision) mf "    order by a.id, d.created_at desc, d.id desc" "    order by a.id, d.created_at asc, d.id asc";;
  # Newest first (P01, L01).
  pend_order_desc) mf "  order by p.proposed_at, p.item_id" "  order by p.proposed_at desc, p.item_id";;
  # The total counts only up to the row (P01, L01).
  pend_total_is_row_number) mf "count(*) over ()" "row_number() over (order by p.proposed_at, p.item_id)";;
  # No bounds on the limit (L01).
  pend_limit_unbounded) mf "  limit least(greatest(coalesce(p_limit, 200), 1), 500)" "  limit coalesce(p_limit, 200)";;
  # The survivor's status is not read (P01: the archived survivor shows as open).
  pend_no_survivor_status) mf "           s.status as survivor_status, d.score" "           'open'::text as survivor_status, d.score";;
  # Grants (G01).
  grant_anon_candidates) echo "grant execute on function public.dedup_semantic_candidates(integer, integer) to anon;" >> "$SRC";;
  grant_anon_pending) echo "grant execute on function public.dedup_pending_proposals(integer) to anon;" >> "$SRC";;
  # Shape (S01), on the candidate read.
  security_definer) mf "  project text
)
language sql
stable
set search_path" "  project text
)
language sql
stable
security definer
set search_path";;
  volatile_read) mf "  project text
)
language sql
stable
set search_path" "  project text
)
language sql
volatile
set search_path";;
  no_search_path) mf "  project text
)
language sql
stable
set search_path = pg_catalog, public
as \$\$" "  project text
)
language sql
stable
as \$\$";;
  *) never "unknown mutation: $MUTATE";;
esac

if ! PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d obtest -f "$SRC" >"$WORK/mig.out" 2>&1; then
  never "migration failed to apply: $(sed 's/^psql:.*ERROR/ERROR/' "$WORK/mig.out" | head -3)"
fi
echo "migration applied"

# 1. No existing function changed; exactly the two new ones.
fn_after=$(q "$FN_SQL")
[ -n "$fn_after" ] || never "could not read the public functions after the migration"
stripped=$(printf '%s\n' "$fn_after" | tr ',' '\n' | grep -v -e '^dedup_semantic_candidates:' -e '^dedup_pending_proposals:' | paste -sd, -)
[ "$stripped" = "$fn_before" ] || fail "the migration changed or added a function other than the two dedup reads"
[ "$(printf '%s\n' "$fn_after" | tr ',' '\n' | grep -c -e '^dedup_semantic_candidates:' -e '^dedup_pending_proposals:')" = 2 ] || fail "the two dedup reads are not exactly two functions after the migration"
echo "PASS the migration adds dedup_semantic_candidates and dedup_pending_proposals and changes none of the other $(printf '%s\n' "$fn_before" | tr ',' '\n' | wc -l | tr -d ' ') public functions"

CONTRACT="$TEST_SQL"
inject_sql() { # anchor, inserted text: into a copy of the contract, exactly one site
  CONTRACT="$WORK/contract.sql"; cp "$TEST_SQL" "$CONTRACT"
  python3 - "$CONTRACT" "$1" "$2" <<'PY' || never "injection anchor not found exactly once"
import sys
p, a, b = sys.argv[1:4]
s = open(p).read()
if s.count(a) != 1: sys.exit(1)
open(p, 'w').write(s.replace(a, a + b))
PY
}
# sql_timeout's planted statement: the reach marker and the sleep in one
# function, so an interruption whose CONTEXT names this frame was raised by the
# statement that printed the marker (Codex re-review 1 of PR 33, F1).
REACH_THEN_SLEEP="create function pg_temp.obdd_reach_then_sleep(p_name text, p_secs double precision) returns void language plpgsql as \$obdd\$
begin
  raise notice 'OBDD_INJECT_REACHED %', p_name;
  perform pg_sleep(p_secs);
end \$obdd\$;"
# Each planted statement raises its own reach marker as a NOTICE from inside
# itself (a DO block), so the marker prints only when that statement executes.
case "$INJECT" in
  "") ;;
  # The positive control: a check that runs to completion and does not hold.
  assert_fail) inject_sql "$POINT_ANCHOR" "do \$obdd\$ begin raise notice 'OBDD_INJECT_REACHED assert_fail'; perform pg_temp.ok('INJECTED obdd_assert_fail a completed check that does not hold', 1 = 2, 'one is not two'); end \$obdd\$;
";;
  # A behavioral SQL error no check was written for.
  raw_error) inject_sql "$POINT_ANCHOR" "do \$obdd\$ begin raise notice 'OBDD_INJECT_REACHED raw_error'; perform 'obdd_raw_error'::integer; end \$obdd\$;
";;
  # A real statement_timeout, of the statement that raised the marker: one
  # function raises the marker and sleeps, so the timeout's CONTEXT names it.
  sql_timeout) inject_sql "$POINT_ANCHOR" "$REACH_THEN_SLEEP
set statement_timeout = 200;
select pg_temp.obdd_reach_then_sleep('sql_timeout', 2);
";;
  # Controls only (G, H, I): Codex's displaced plant as written; the marker
  # from a function that returns before a separate sleep; a timeout before the
  # marker statement.
  selftest_timeout_displaced) inject_sql "$POINT_ANCHOR" "set statement_timeout = 200;
do \$obdd\$ begin raise notice 'OBDD_INJECT_REACHED selftest_timeout_displaced'; end \$obdd\$;
select pg_sleep(2);
";;
  selftest_timeout_after_return) inject_sql "$POINT_ANCHOR" "$REACH_THEN_SLEEP
set statement_timeout = 200;
select pg_temp.obdd_reach_then_sleep('selftest_timeout_after_return', 0);
do \$obdd\$ begin perform pg_sleep(2); end \$obdd\$;
";;
  selftest_timeout_before_reach) inject_sql "$POINT_ANCHOR" "$REACH_THEN_SLEEP
set statement_timeout = 200;
select pg_sleep(2);
select pg_temp.obdd_reach_then_sleep('selftest_timeout_before_reach', 2);
";;
  # Controls only (N to S, Codex re-review 2 of PR 33, F1): the marker's
  # statement completes and a LATER statement raises the same error with the
  # same frame. N and O are Codex's two anonymous blocks for raw_error and
  # assert_fail; P moves sql_timeout's sleep into a second anonymous block; Q
  # redefines obdd_reach_then_sleep to sleep without the marker and calls it
  # again, so even the function frame matches; R puts the two blocks on one
  # line; S sets psql to echo input lines instead of sent statements, with
  # both blocks on one line, so only the meta-command rule can see it.
  selftest_raw_error_two_blocks) inject_sql "$POINT_ANCHOR" "do \$obdd\$ begin raise notice 'OBDD_INJECT_REACHED selftest_raw_error_two_blocks'; end \$obdd\$;
do \$obdd\$ begin perform 'obdd_raw_error'::integer; end \$obdd\$;
";;
  selftest_assert_fail_two_blocks) inject_sql "$POINT_ANCHOR" "do \$obdd\$ begin raise notice 'OBDD_INJECT_REACHED selftest_assert_fail_two_blocks'; end \$obdd\$;
do \$obdd\$ begin perform pg_temp.ok('INJECTED obdd_assert_fail a completed check that does not hold', 1 = 2, 'one is not two'); end \$obdd\$;
";;
  selftest_timeout_two_blocks) inject_sql "$POINT_ANCHOR" "set statement_timeout = 200;
do \$obdd\$ begin raise notice 'OBDD_INJECT_REACHED selftest_timeout_two_blocks'; end \$obdd\$;
do \$obdd\$ begin perform pg_sleep(2); end \$obdd\$;
";;
  selftest_timeout_redefined) inject_sql "$POINT_ANCHOR" "$REACH_THEN_SLEEP
set statement_timeout = 200;
select pg_temp.obdd_reach_then_sleep('selftest_timeout_redefined', 0);
create or replace function pg_temp.obdd_reach_then_sleep(p_name text, p_secs double precision) returns void language plpgsql as \$obdd\$
begin
  perform p_name;
  perform pg_sleep(p_secs);
end \$obdd\$;
select pg_temp.obdd_reach_then_sleep('selftest_timeout_redefined_again', 2);
";;
  selftest_raw_error_same_line) inject_sql "$POINT_ANCHOR" "do \$obdd\$ begin raise notice 'OBDD_INJECT_REACHED selftest_raw_error_same_line'; end \$obdd\$; do \$obdd\$ begin perform 'obdd_raw_error'::integer; end \$obdd\$;
";;
  selftest_raw_error_echo_all) inject_sql "$POINT_ANCHOR" "\\set ECHO all
do \$obdd\$ begin raise notice 'OBDD_INJECT_REACHED selftest_raw_error_echo_all'; end \$obdd\$; do \$obdd\$ begin perform 'obdd_raw_error'::integer; end \$obdd\$;
";;
  # Control only (L): raw_error's cast as a top-level statement after its marker.
  selftest_raw_error_displaced) inject_sql "$POINT_ANCHOR" "do \$obdd\$ begin raise notice 'OBDD_INJECT_REACHED selftest_raw_error_displaced'; end \$obdd\$;
select 'obdd_raw_error'::integer;
";;
  # A helper query that raises while every check goes on to hold.
  helper_fail) echo "OBDD_INJECT_REACHED helper_fail"; q "select 'obdd_helper_fail'::integer" >/dev/null;;
  # Planted below, before the bridge runs; the bridge_* adapter faults are
  # planted by the bridge itself (OBDD_BRIDGE_INJECT).
  integration_cancel|bridge_assert_fail|bridge_scalar_column|bridge_object_json) ;;
  # Exists only for --inject-selftest-controls: Codex's fresh-05 planted fault.
  selftest_cancel_not_installed) ;;
  *) never "unknown injection: $INJECT";;
esac

# 2. The contract. psql's exit 3 says only that a statement raised;
# contract_verdict reads the SQLSTATE.
# -e (ECHO=queries): psql prints each statement it sends, so sent_identity can
# tell which statement raised an injected error.
"${PSQL[@]}" -d obtest -e -v interruption_prefixes="$INTERRUPTION_PREFIXES" -f "$CONTRACT" >"$WORK/contract.out" 2>&1; code=$?
grep -E '^psql:.*:[0-9]+: (NOTICE|ERROR):  ' "$WORK/contract.out" \
  | sed -E 's/^psql:.*:[0-9]+: NOTICE:  00000: //; s/^psql:.*:[0-9]+: ERROR:  ([0-9A-Z]{5}): /ERROR \1: /; s/^psql:.*:[0-9]+: ERROR:  /ERROR (no SQLSTATE): /'
# The first error's CONTEXT, joined on one line ("(none)" for a top-level
# statement): the inject self-test checks WHERE an injected error was raised.
ce=$(grep -n -m1 -E '^psql:.*:[0-9]+: ERROR:  ' "$WORK/contract.out" | cut -d: -f1)
if [ -n "$ce" ]; then
  ctx=$(awk -v s="$ce" 'NR > s { if ($0 ~ /^psql:/) exit; print; if ($0 ~ /^LOCATION:  /) exit }' "$WORK/contract.out" \
    | awk '/^LOCATION:  /{exit} /^CONTEXT:  /{c=1; sub(/^CONTEXT:  /, "")} c' | awk 'NR > 1 { printf " | " } { printf "%s", $0 }')
  echo "OBDD_ERROR_CONTEXT ${ctx:-(none)}"
fi
# Which statement psql sent that raised the marker and the first error
# (Codex re-review 2 of PR 33, F1); the inject self-test needs "same".
if [ -n "$INJECT" ]; then
  sent_identity "$WORK/contract.out" "$CONTRACT" "$TEST_SQL" "$POINT_ANCHOR" "$INJECT" | head -1
fi
contract_verdict "$code" "$WORK/contract.out"
case $? in
  0) ;;
  1) echo "FAIL DEDUP SQL TEST: $VERDICT"; exit 1;;
  *) never "$VERDICT";;
esac

[ "${OBDD_SELFTEST_STOP_BEFORE_BRIDGE:-}" = 1 ] && never "stopped after the SQL contract, before the integration bridge (a self-test control)"

# 3. The integration bridge, on the same database after the contract.
plant_cancel() { # table: the cancellation trigger for the second Casey capture
  "${PSQL[@]}" -d obtest >/dev/null 2>"$WORK/inject.err" <<SQL || never "injection $INJECT did not apply: $(head -1 "$WORK/inject.err")"
create function public.obt_injected_cancel() returns trigger language plpgsql as \$f\$
begin
  raise notice 'OBDD_INJECT_REACHED $INJECT';
  raise exception using errcode = '57014', message = 'canceling statement due to statement timeout (obdd_integration_cancel)';
end \$f\$;
create trigger obt_injected_cancel before insert on $1 for each row
  when (new.description = 'Add Casey Holt as a guest when his email arrives') execute function public.obt_injected_cancel();
SQL
}
case "$INJECT" in
  integration_cancel) plant_cancel public.action_items;;
  selftest_cancel_not_installed) plant_cancel public.obdd_missing_table;;
  # A wrong persisted value with no SQL error: the semantic proposal's score,
  # set to a value only this trigger writes.
  bridge_assert_fail)
    "${PSQL[@]}" -d obtest >/dev/null 2>"$WORK/inject.err" <<'SQL' || never "injection bridge_assert_fail did not apply: $(head -1 "$WORK/inject.err")"
create function public.obt_injected_score() returns trigger language plpgsql as $f$
begin
  raise notice 'OBDD_INJECT_REACHED bridge_assert_fail';
  new.score := 0.31415926;
  return new;
end $f$;
create trigger obt_injected_score before insert on public.auto_resolve_decisions for each row
  when (new.reason = 'semantic_overlap') execute function public.obt_injected_score();
SQL
    ;;
esac
BRIDGE_INJECT=""; case "$INJECT" in bridge_scalar_column|bridge_object_json) BRIDGE_INJECT="$INJECT";; esac
IOUT=$(OBDD_BRIDGE_INJECT="$BRIDGE_INJECT" OBRP_PG_PORT="$PORT" OBRP_INTERRUPTION_PREFIXES="$INTERRUPTION_PREFIXES" python3 "$HERE/deadline.py" "${OBFG_INTEGRATION_DEADLINE:-240}" \
  deno run --no-lock --allow-env --allow-read --allow-run=psql "$HERE/dedup-integration.ts" 2>&1); icode=$?
echo "$IOUT" | grep -E '^(PASS I|FAIL|NEVER-RAN|DEDUP INTEGRATION|OBDD_INJECT_REACHED |  )'
case "$icode" in
  0) echo "$IOUT" | grep -q "^DEDUP INTEGRATION PASSED$" || never "the integration bridge exited 0 without its PASSED line";;
  1) echo "$IOUT" | grep -q '^FAIL integration:' || never "the integration bridge exited 1 without a completed assertion: $(echo "$IOUT" | tail -1 | cut -c1-160)"
     echo "FAIL integration (see above)"; exit 1;;
  *) never "the integration bridge did not complete (exit $icode): $(echo "$IOUT" | tail -1 | cut -c1-200)";;
esac

[ -s "$WORK/qfail" ] && never "every check held, but a helper query did not execute during the run ($(head -1 "$WORK/qfail" | cut -c1-200))"
[ -n "$INJECT" ] && never "the injection $INJECT did not stop the run, so it did not fire"
COMPLETED=1
echo "DEDUP TEST COMPLETE${MUTATE:+ (mutation $MUTATE)}"
