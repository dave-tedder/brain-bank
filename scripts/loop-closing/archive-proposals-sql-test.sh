#!/bin/bash
# Loop-closing Task 3.2 (producer): prove 20261119_action_items_archive_proposal_job.sql
# on a throwaway LOCAL PostgreSQL cluster (never production).
#
#   bash scripts/loop-closing/archive-proposals-sql-test.sh                  # exit 0 passed
#   bash scripts/loop-closing/archive-proposals-sql-test.sh --mutate <name>  # exit 1 expected
#   bash scripts/loop-closing/archive-proposals-sql-test.sh --all-mutations  # all must be CAUGHT
#   bash scripts/loop-closing/archive-proposals-sql-test.sh --diff <snapshot-dir>
#   bash scripts/loop-closing/archive-proposals-sql-test.sh --verdict-selftest  # no database
#   bash scripts/loop-closing/archive-proposals-sql-test.sh --load-selftest     # no database
#
# Three outcomes, never two (the PR 23 rule):
#   0  passed: every check ran to completion and held.
#   1  FAILED: a check RAN TO COMPLETION and its assertion did not hold. Only this is
#      a caught mutation. Every exit 1 prints a line starting "FAIL" or "ERROR".
#   2  NEVER-RAN: the cluster, a migration or a mutant did not apply; a connection
#      never finished its statements; a helper query could not connect; a step
#      stopped before its last check. Nothing was judged, so nothing was caught.
#
# What it proves:
#   1. archive-proposals-sql-test.sql (A01-A26, B01-B11, W01-W13, U01-U14, G01-G04): the policy, the
#      writer, review state through Task 3.6's real review_proposal, the reopen
#      exemption and generation, grants, the schedule and the digest's last-run read.
#   2. Schedules on real second connections:
#      C1 an item closed by an uncommitted transaction: the job waits on it (read
#         from pg_stat_activity), and once it commits the job skips it.
#      C2 two jobs at once: the second waits and writes nothing; one proposal per item.
#   3. --diff: the SQL functions and archive-policy.ts agree on every row of a
#      snapshot (synthetic from emit-snapshot, or production exported read-only to
#      a private directory, never the repo) and on hand-written edge cases; see
#      archive-proposals-diff.ts. The diff's exit 3 (INCOMPLETE: the SQL output did
#      not cover the snapshot's inventory) is reported here as NEVER-RAN, and a
#      passing diff is followed by its guard self-test on the same SQL output.
#      The diff's exit code alone is never trusted: diff_verdict below accepts a
#      FAIL only when the comparison printed its completed-failure verdict as its
#      last line, because Deno exits 1 for an uncaught exception too (Codex second
#      re-review of PR 24, 2026-11-18). --verdict-selftest proves that rule on
#      canned outputs without a database, and --diff runs it before trusting one.
#      The snapshot loader (build_load_sql) refuses any file that is not an array
#      of objects with a typed key, because valid JSON "" or null iterates to
#      nothing and once read as an empty list on both sides (Codex third
#      re-review, 2026-11-18); an empty array stays legitimate. --load-selftest
#      proves it on canned snapshots without a database, and --diff runs it first.
#      A refusal counts only when the loader's whole output is the one refusal
#      line: a line matched anywhere let a crash AFTER the refusal was printed
#      pass (Codex fourth re-review, 2026-11-18). load_verdict holds that rule
#      and --load-selftest proves it on canned transcripts too. The output is
#      judged as bytes in a file: $(...) drops trailing newlines, which hid a
#      blank line of output from the judge (Codex fifth re-review, 2026-11-18).
#
# The cluster is initialised with --locale=en_US.UTF-8 because production's database
# ctype is en_US.UTF-8 and lower(), \s and [[:space:]] read the locale. So would \y,
# which is why the work-report classifier spells its boundaries in ASCII (W01-W13),
# whitespace as JavaScript's 25 code points and lowercasing as
# archive_policy_js_lower (U01-U14).
export LC_ALL=C
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/scripts/loop-closing"
M_MCP_LOG="$ROOT/supabase/migrations/0016_mcp_tool_invocations.sql"
M_DECISIONS="$ROOT/supabase/migrations/20261105_auto_resolve_decisions.sql"
M_CLOSE="$ROOT/supabase/migrations/20261106_action_items_close_reason.sql"
M_ARCHIVE="$ROOT/supabase/migrations/20261109a_action_items_archive_proposals.sql"
M_REVIEW="$ROOT/supabase/migrations/20261109b_review_proposal_rpc.sql"
M_JOB="$ROOT/supabase/migrations/20261119_action_items_archive_proposal_job.sql"
TEST_SQL="$HERE/archive-proposals-sql-test.sql"

MUTATIONS="no_prelock no_recompute pending_reproposed kept_never_reproposes repropose_keeps_review card_done_exempts card_archived_exempts no_card_exemption reopen_exempt_off client_one_match client_fullname_off canary_off deferred_included deadline_no_clause_break deadline_window_4 deadline_grace_off wr_future_header_counts wr_threshold_1 fragment_ignored fragment_any_generation work_report_age_60 status_written grant_anon schedule_wrong last_run_oldest exclusive_boundary wr_locale_boundary wr_alnum_boundary wr_boundary_no_underscore ws_locale_commit ws_locale_deadline ws_no_feff window_chars lower_locale_tokens lower_locale_partial lower_locale_canary js_lower_no_dotted_i js_lower_no_kelvin"
MUTANT_DEADLINE="${OBAP_MUTANT_DEADLINE:-300}"

classify() {
  local m="$1" code="$2" out="$3" line
  case "$code" in
    1)
      line=$(printf '%s\n' "$out" | grep -E '^(FAIL|ERROR)' | head -1 | cut -c1-160)
      if [ -n "$line" ]; then echo "CAUGHT    $m: $line"; return 0; fi
      echo "NEVER-RAN $m: exit 1 with no completed FAIL/ERROR line: $(printf '%s\n' "$out" | tail -1 | cut -c1-140)"; return 2;;
    0) echo "SURVIVED  $m"; return 1;;
    124) echo "NEVER-RAN $m: deadline of ${MUTANT_DEADLINE}s exceeded, the run did not complete"; return 2;;
    *) echo "NEVER-RAN $m (exit $code): $(printf '%s\n' "$out" | tail -1 | cut -c1-140)"; return 2;;
  esac
}

if [ "${1:-}" = "--all-mutations" ]; then
  caught=0; survived=0; never=0; n=0
  shm_before=$(ipcs -m 2>/dev/null | grep -c '^m')
  for m in ${OBAP_MUTATIONS:-$MUTATIONS}; do
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

# diff_verdict <compare|selftest> <exit> <output-file>: classify one run of
# archive-proposals-diff.ts. Sets VERDICT and returns 0 (completed, passed),
# 1 (completed, behavioral FAIL) or 2 (NEVER-RAN). An exit code is evidence only
# together with the verdict line the comparison prints after it has finished.
diff_verdict() {
  local kind="$1" code="$2" file="$3" last nfail
  last=$(grep -v '^[[:space:]]*$' "$file" | tail -1)
  case "$kind:$code" in
    compare:0)
      if [ "$last" = "ARCHIVE PROPOSALS DIFF PASSED" ]; then VERDICT="passed"; return 0; fi
      VERDICT="the diff exited 0 without its PASSED verdict as the last line"; return 2;;
    compare:1)
      nfail=$(grep -c '^FAIL ' "$file")
      if printf '%s\n' "$last" | grep -Eqx 'ARCHIVE PROPOSALS DIFF FAILED \([1-9][0-9]*\)' && [ "$nfail" -gt 0 ]; then
        VERDICT="completed comparison failed ($nfail FAIL line(s))"; return 1
      fi
      VERDICT="the diff exited 1 without a completed FAILED verdict (an exception, a failed import or a cut-off run): $(printf '%s' "$last" | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-140)"; return 2;;
    compare:3) VERDICT="the diff's SQL output did not cover the snapshot's inventory, or the comparison did not complete (INCOMPLETE above); nothing was judged"; return 2;;
    compare:124) VERDICT="the diff hit its deadline"; return 2;;
    selftest:0)
      if [ "$last" = "DIFF SELFTEST PASSED" ]; then VERDICT="self-test passed"; return 0; fi
      VERDICT="the self-test exited 0 without its PASSED line"; return 2;;
    selftest:*) VERDICT="the diff passed but its own guard self-test did not (exit $code), so the pass is not trusted"; return 2;;
    *) VERDICT="the diff did not complete (exit $code)"; return 2;;
  esac
}

# Canned outputs with the class each must get. Run by --verdict-selftest and,
# silently, before --diff trusts any verdict.
verdict_selftest() {
  local d n=0 bad=0 got want kind code body
  d=$(mktemp -d /tmp/obap-verdict.XXXXXX)
  while IFS='|' read -r want kind code body; do
    [ -z "$want" ] && continue
    n=$((n + 1))
    printf '%b\n' "$body" > "$d/out"
    diff_verdict "$kind" "$code" "$d/out"; got=$?
    if [ "$got" != "$want" ]; then
      bad=$((bad + 1)); echo "FAIL verdict case $n ($kind exit $code): got $got, expected $want: $VERDICT"
    fi
  done <<'CASES'
2|compare|1|migrations applied\nerror: Uncaught (in promise) TypeError: Cannot read properties of null (reading 'item_id')\n    at fkey (archive-proposals-diff.ts:346:81)
2|compare|1|error: Module not found "file:///x/archive-policy.ts".
2|compare|1|FAIL client_shaped: 1 of 303 differ\nerror: Uncaught TypeError: boom
2|compare|1|PASS deadline: 3 rows identical\nARCHIVE PROPOSALS DIFF FAILED (1)
2|compare|1|FAIL client_shaped: 1 of 3 differ\nARCHIVE PROPOSALS DIFF FAILED (1)\nerror: Uncaught TypeError: after the verdict
2|compare|1|FAIL client_shaped: 1 of 3 differ\nARCHIVE PROPOSALS DIFF FAILED (0)
2|compare|1|
1|compare|1|PASS deadline: 3 rows identical\nFAIL client_shaped: 1 of 3 differ\n  item x: ts=true sql=false\nARCHIVE PROPOSALS DIFF FAILED (1)
0|compare|0|PASS deadline: 3 rows identical\nARCHIVE PROPOSALS DIFF PASSED
2|compare|0|PASS deadline: 3 rows identical
2|compare|3|INCOMPLETE fragments: malformed row #0 null\nARCHIVE PROPOSALS DIFF INCOMPLETE: nothing was judged
2|compare|3|INCOMPLETE the compare did not run to completion: injected\nARCHIVE PROPOSALS DIFF INCOMPLETE: nothing was judged
2|compare|124|PASS deadline: 3 rows identical
2|compare|2|usage: archive-proposals-diff.ts
0|selftest|0|GUARDED  unaltered output: exit 0, expected 0\nDIFF SELFTEST PASSED
2|selftest|0|GUARDED  unaltered output: exit 0, expected 0
2|selftest|1|UNGUARDED a null fragment entry: exit exception, expected 3\nDIFF SELFTEST FAILED
2|selftest|3|INCOMPLETE the selftest did not run to completion: x
CASES
  rm -rf "$d"
  if [ "$bad" -gt 0 ]; then echo "VERDICT SELFTEST FAILED ($bad of $n)"; return 1; fi
  echo "VERDICT SELFTEST PASSED ($n cases)"; return 0
}

if [ "${1:-}" = "--verdict-selftest" ]; then
  verdict_selftest; exit $?
fi

# build_load_sql <snapshot-dir> <work-dir>: write <work-dir>/load.sql from the
# snapshot (and <work-dir>/adv.json). A snapshot that cannot be loaded faithfully
# is refused: exit 1 with one "unsupported snapshot: ..." line, ended by exactly
# one newline, and nothing else. A good load writes no output at all, not even a
# newline. Any other nonzero exit, or exit 1 with any other output, is a crash. --diff
# treats both as NEVER-RAN; --load-selftest tells them apart (load_verdict).
build_load_sql() {
  python3 - "$1" "$2" <<'PY'
import json, sys
snap, work = sys.argv[1], sys.argv[2]
def lit(obj):
    s = json.dumps(obj)
    assert "$SNAPJSON$" not in s
    return "$SNAPJSON$" + s + "$SNAPJSON$::jsonb"
def refuse(why):
    print("unsupported snapshot: " + why)
    sys.exit(1)
out = open(work + "/load.sql", "w")
out.write("delete from public.thoughts;\n")
def ins(table, cols, data, rectype):
    c = ", ".join(cols)
    out.write(f"insert into {table} ({c}) select {c} from jsonb_populate_recordset(null::{rectype}, {lit(data)});\n")
# Every snapshot file must be an array of objects, checked BEFORE it is iterated:
# valid JSON of another shape ("" or null) iterates to nothing, so a lost file
# read as an empty list on both sides of the diff, which agreed and passed (Codex
# third re-review of PR 24, 2026-11-18). A row's key field must have its column's
# type. An empty array stays legitimate. Same rules as loadRows in
# archive-proposals-diff.ts.
MISSING = object()
def short(v):
    return "missing" if v is MISSING else json.dumps(v)[:80]
def rows(name, key=None, nullable=False):
    try:
        v = json.load(open(snap + "/" + name))
    except (OSError, ValueError) as e:
        refuse(f"{name} is not readable JSON: {e}")
    if not isinstance(v, list):
        refuse(f"{name} is not an array: {short(v)}")
    for i, r in enumerate(v):
        if not isinstance(r, dict):
            refuse(f"{name} row #{i} is not an object: {short(r)}")
        if key is not None:
            k = r[key] if key in r else MISSING
            if not (isinstance(k, str) or (nullable and k is None)):
                refuse(f"{name} row #{i} has {key} {short(k)}")
    return v
ins("public.thoughts", ["id", "content", "created_at"], rows("thoughts.json", "id"), "public.thoughts")
ins("public.clients", ["id", "name"], rows("clients.json", "name"), "public.clients")
ins("public.action_items", ["id", "source_thought_id", "description", "status", "created_at", "resolved_at",
    "resolution_note", "closed_at", "close_reason", "deferred_at", "defer_reason", "reopened_at",
    "reopen_generation", "archive_proposed_at", "archive_review_outcome", "archive_reviewed_at"],
    rows("items.json", "id"), "public.action_items")
ins("public.agent_tasks", ["id", "status", "archived_at", "linked_action_item_id"],
    rows("cards.json", "linked_action_item_id", nullable=True), "public.agent_tasks")
# decisions.json: the policy reads only current-generation fragment rows, so
# exactly those rows and columns are loaded, and a fragment row that cannot be
# loaded faithfully refuses the snapshot rather than being skipped. The
# generation trigger is disabled for the load: it would restamp every row with
# the item's CURRENT generation, turning an old-generation row into a current one.
frag_cols = ["id", "item_id", "thought_id", "candidate_description", "layer", "outcome", "reason", "item_generation"]
frags = []
for d in rows("decisions.json"):
    if d.get("layer") != "fragment":
        continue
    for k in frag_cols:
        if k not in d:
            refuse(f"decisions.json fragment row {d.get('id')} has no {k}")
    if d["item_generation"] is not None and (isinstance(d["item_generation"], bool) or not isinstance(d["item_generation"], int)):
        refuse(f"decisions.json fragment row {d.get('id')} has item_generation {d['item_generation']!r}")
    frags.append({k: d[k] for k in frag_cols})
out.write("alter table public.auto_resolve_decisions disable trigger auto_resolve_decisions_stamp_generation;\n")
if frags:
    ins("public.auto_resolve_decisions", frag_cols, frags, "public.auto_resolve_decisions")
out.write("alter table public.auto_resolve_decisions enable trigger auto_resolve_decisions_stamp_generation;\n")
adv = json.load(open(work + "/adv.json"))
out.write("create table public.adv (i int, text text, captured_at timestamptz);\n")
ins("public.adv", ["i", "text", "captured_at"], adv["adversarial"], "public.adv")
out.write("create table public.known_split (i int, text text, captured_at timestamptz);\n")
ins("public.known_split", ["i", "text", "captured_at"], adv["known"], "public.known_split")
PY
}

# load_verdict <want> <exit> <output-file> <load.sql>: did one build_load_sql run
# do what <want> says ("ok" or "refuse:<text of the refusal>")? Returns 0 when it
# did, 1 otherwise. The whole output is compared, never one line of it: Python
# exits 1 for an uncaught exception as well, so a refusal line followed (or
# preceded) by a traceback is a crash, not a refusal.
# The output is a FILE and is compared byte for byte. A shell variable filled by
# $(...) has already lost every trailing newline, so it cannot tell silence from
# a blank line, or one refusal line from the line plus blank lines. A refusal is
# exactly the line and one newline; a good load is exactly zero bytes.
load_verdict() {
  local want="$1" code="$2" out="$3" sql="$4"
  [ -f "$out" ] || return 1
  case "$want" in
    ok) [ "$code" = 0 ] && [ ! -s "$out" ] && [ -s "$sql" ];;
    refuse:*) [ "$code" = 1 ] && printf '%s\n' "unsupported snapshot: ${want#refuse:}" | cmp -s - "$out";;
    *) return 1;;
  esac
}

# Two sets of canned cases, no database. Run by --load-selftest and, silently,
# before --diff loads a snapshot.
#   1. Judge cases: canned transcripts with the answer load_verdict must give
#      (0 accepted, 1 rejected). "sql" says whether a non-empty load.sql exists.
#      The transcript is written with printf %b, so every newline in it is
#      spelled out, the final one included.
#   2. Snapshot cases: canned snapshots with the outcome each must get from
#      build_load_sql. Each starts from five empty arrays (a legitimate, empty
#      snapshot) and replaces one file.
load_selftest() {
  local d n=0 jn=0 bad=0 want file json out code f expect sql body got
  d=$(mktemp -d /tmp/obap-load.XXXXXX)
  while IFS='|' read -r expect want code sql body; do
    [ -z "$expect" ] && continue
    jn=$((jn + 1))
    rm -f "$d/j.sql"; [ "$sql" = sql ] && printf 'delete from public.thoughts;\n' > "$d/j.sql"
    printf '%b' "$body" > "$d/j.out"
    load_verdict "$want" "$code" "$d/j.out" "$d/j.sql"; got=$?
    if [ "$got" != "$expect" ]; then
      bad=$((bad + 1)); echo "FAIL load judge case $jn ($want, exit $code, $sql): got $got, expected $expect: $(printf '%s' "$body" | cut -c1-80)"
    fi
  done <<'JUDGE'
0|refuse:x.json is not an array: ""|1|nosql|unsupported snapshot: x.json is not an array: ""\n
1|refuse:x.json is not an array: ""|1|nosql|unsupported snapshot: x.json is not an array: ""\nTraceback (most recent call last):\n  File "<stdin>", line 9, in refuse\nRuntimeError: crash after the refusal line\n
1|refuse:x.json is not an array: ""|1|nosql|Traceback (most recent call last):\n  File "<stdin>", line 30, in rows\nRuntimeError: crash before the refusal line\n
1|refuse:x.json is not an array: ""|1|nosql|Traceback (most recent call last):\nRuntimeError: boom\nunsupported snapshot: x.json is not an array: ""\n
1|refuse:x.json is not an array: ""|1|nosql|unsupported snapshot: x.json is not an array: ""\nunsupported snapshot: x.json is not an array: ""\n
1|refuse:x.json is not an array: ""|1|nosql|unsupported snapshot: x.json is not an array: null\n
1|refuse:x.json is not an array: ""|1|nosql|unsupported snapshot: x.json is not an array: "" and more\n
1|refuse:x.json is not an array: ""|1|nosql|
1|refuse:x.json is not an array: ""|0|sql|unsupported snapshot: x.json is not an array: ""\n
1|refuse:x.json is not an array: ""|2|nosql|unsupported snapshot: x.json is not an array: ""\n
1|refuse:x.json is not an array: ""|124|nosql|unsupported snapshot: x.json is not an array: ""\n
0|ok|0|sql|
1|ok|0|nosql|
1|ok|1|sql|
1|ok|0|sql|unsupported snapshot: x.json is not an array: ""\n
1|ok|0|sql|Traceback (most recent call last):\nRuntimeError: boom\n
1|refuse:x.json is not an array: ""|1|nosql|unsupported snapshot: x.json is not an array: ""\n\n
1|refuse:x.json is not an array: ""|1|nosql|unsupported snapshot: x.json is not an array: ""
1|refuse:x.json is not an array: ""|1|nosql|\nunsupported snapshot: x.json is not an array: ""\n
1|refuse:x.json is not an array: ""|1|nosql|unsupported snapshot: x.json is not an array: ""\r\n
1|refuse:x.json is not an array: ""|1|nosql|unsupported snapshot: x.json is not an array: "" \n
1|refuse:x.json is not an array: ""|1|nosql|\n
1|ok|0|sql|\n
1|ok|0|sql|\n\n
1|ok|0|sql|\t
JUDGE
  # A run whose output was never captured is not a silent run.
  jn=$((jn + 1)); printf 'delete from public.thoughts;\n' > "$d/j.sql"; rm -f "$d/absent.out"
  if load_verdict ok 0 "$d/absent.out" "$d/j.sql"; then
    bad=$((bad + 1)); echo "FAIL load judge case $jn (ok, exit 0, sql, no output file): got 0, expected 1"
  fi
  while IFS='|' read -r want file json; do
    [ -z "$want" ] && continue
    n=$((n + 1))
    rm -rf "$d/s" "$d/w"; mkdir -p "$d/s" "$d/w"
    for f in thoughts items clients cards decisions; do printf '[]' > "$d/s/$f.json"; done
    printf '{"adversarial": [], "known": []}' > "$d/w/adv.json"
    [ -n "$file" ] && printf '%s' "$json" > "$d/s/$file"
    build_load_sql "$d/s" "$d/w" > "$d/out" 2>&1; code=$?
    if ! load_verdict "$want" "$code" "$d/out" "$d/w/load.sql"; then
      bad=$((bad + 1))
      case "$want" in
        ok) echo "FAIL load case $n ($file $json): expected ok with no output, got exit $code and $(wc -c < "$d/out" | tr -d ' ') byte(s) of output: $(tail -1 "$d/out" | cut -c1-120)";;
        *) echo "FAIL load case $n ($file $json): expected only the refusal '${want#refuse:}' and one newline, got exit $code and $(wc -c < "$d/out" | tr -d ' ') byte(s) in $(grep -c '' "$d/out") line(s) ending: $(tail -1 "$d/out" | cut -c1-120)";;
      esac
    fi
  done <<'CASES'
ok||
ok|decisions.json|[]
refuse:decisions.json is not an array: ""|decisions.json|""
refuse:decisions.json is not an array: "x"|decisions.json|"x"
refuse:decisions.json is not an array: null|decisions.json|null
refuse:decisions.json is not an array: {}|decisions.json|{}
refuse:decisions.json is not an array: true|decisions.json|true
refuse:decisions.json is not an array: 0|decisions.json|0
refuse:decisions.json row #0 is not an object: null|decisions.json|[null]
refuse:decisions.json row #0 is not an object: 5|decisions.json|[5]
refuse:decisions.json row #1 is not an object: []|decisions.json|[{"layer": "other"}, []]
ok|decisions.json|[{"layer": "other"}]
refuse:decisions.json fragment row d1 has no item_generation|decisions.json|[{"id": "d1", "layer": "fragment", "item_id": "i1", "thought_id": null, "candidate_description": "it", "outcome": "proposed", "reason": "r"}]
refuse:thoughts.json is not an array: ""|thoughts.json|""
refuse:items.json is not an array: {}|items.json|{}
refuse:clients.json is not an array: null|clients.json|null
refuse:cards.json is not an array: 0|cards.json|0
refuse:thoughts.json row #0 is not an object: "t1"|thoughts.json|["t1"]
refuse:thoughts.json row #0 has id 5|thoughts.json|[{"id": 5, "content": "x", "created_at": "2026-01-01T00:00:00Z"}]
refuse:items.json row #0 has id missing|items.json|[{"description": "x"}]
refuse:clients.json row #0 has name null|clients.json|[{"id": "c1", "name": null}]
refuse:cards.json row #0 has linked_action_item_id ["i1"]|cards.json|[{"id": "k1", "status": "Agent Todo", "archived_at": null, "linked_action_item_id": ["i1"]}]
ok|cards.json|[{"id": "k1", "status": "Agent Todo", "archived_at": null, "linked_action_item_id": null}]
ok|thoughts.json|[{"id": "t1", "content": "x", "created_at": "2026-01-01T00:00:00Z"}]
refuse:decisions.json is not readable JSON: Expecting value: line 1 column 1 (char 0)|decisions.json|
CASES
  rm -rf "$d"
  if [ "$bad" -gt 0 ]; then echo "LOAD SELFTEST FAILED ($bad of $((n + jn)))"; return 1; fi
  echo "LOAD SELFTEST PASSED ($n cases, $jn judge cases)"; return 0
}

if [ "${1:-}" = "--load-selftest" ]; then
  load_selftest; exit $?
fi

MODE=contract; MUTATE=""; SNAP=""
case "${1:-}" in
  --mutate) MUTATE="${2:-}";;
  # OBAP_MUTATE applies a mutant to the diff too: the negative control that proves
  # the diff can fail (a diff that cannot fail proves nothing).
  --diff) MODE=diff; SNAP="${2:-}"; MUTATE="${OBAP_MUTATE:-}"; [ -d "$SNAP" ] || { echo "NEVER-RAN: --diff needs a snapshot directory"; exit 2; };;
  "") ;;
  *) echo "NEVER-RAN: unknown argument $1"; exit 2;;
esac
PORT=$((55000 + RANDOM % 900))
WORK="$(mktemp -d /tmp/obap.XXXXXX)"
PIDS=""
COMPLETED=0
never() { echo "NEVER-RAN: $*"; exit 2; }
fail() {
  if [ -s "$WORK/qfail" ]; then never "a helper query could not connect while checking: $* ($(head -1 "$WORK/qfail" | cut -c1-160))"; fi
  echo "FAIL $*"; exit 1
}
cleanup() {
  local rc=$?
  for p in $PIDS; do kill "$p" 2>/dev/null; done
  wait 2>/dev/null
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

if ! initdb -D "$WORK/pg" -A trust -U postgres -E UTF8 --locale=en_US.UTF-8 >"$WORK/initdb.log" 2>&1; then
  if grep -q shmget "$WORK/initdb.log"; then
    never "initdb failed at shmget: SysV shared memory is exhausted or denied (check 'ipcs -m' for orphaned segments)"
  fi
  never "initdb failed: $(tail -1 "$WORK/initdb.log")"
fi
pg_ctl -D "$WORK/pg" -o "-p $PORT -c listen_addresses=127.0.0.1 -k $WORK -c deadlock_timeout=200ms -c timezone=UTC" -l "$WORK/pg.log" start -w >/dev/null || never "pg start failed: $(tail -1 "$WORK/pg.log")"
PSQL=(psql -X -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -d postgres -c "create database obtest" >/dev/null || never "create database failed"

"${PSQL[@]}" -d obtest <<'SQL' >/dev/null || never "stub schema failed"
create role service_role nologin bypassrls; create role anon nologin; create role authenticated nologin;
create schema auth;
create function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;
grant usage on schema auth to service_role, anon, authenticated;
create table public.thoughts (id uuid primary key, content text, created_at timestamptz default now());
insert into public.thoughts (id) values ('e0000000-0000-4000-8000-000000000001'), ('e0000000-0000-4000-8000-000000000002');
create table public.business_events (id uuid primary key, title text);
create table public.clients (id uuid primary key default gen_random_uuid(), name text not null);
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
-- pg_cron, stubbed: the two tables the digest's read uses and an upserting schedule().
create schema cron;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
create table cron.job_run_details (runid bigserial primary key, jobid bigint, status text,
  return_message text, start_time timestamptz, end_time timestamptz);
create function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint
language sql as $$
  insert into cron.job (jobname, schedule, command) values (p_name, p_schedule, p_command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid
$$;
grant select, insert, update, delete on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
SQL

for f in "$M_MCP_LOG" "$M_DECISIONS" "$M_CLOSE" "$M_ARCHIVE" "$M_REVIEW"; do
  PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d obtest -f "$f" >"$WORK/prior.out" 2>&1 \
    || never "prior migration failed: $(basename "$f"): $(head -3 "$WORK/prior.out")"
done

SRC="$WORK/job.sql"; cp "$M_JOB" "$SRC"
mj() { # old, new: literal replace, every occurrence; a mutant that changes nothing never ran
  python3 - "$SRC" "$1" "$2" <<'PY' || never "mutant did not change the target: $(printf '%s' "$1" | head -1)"
import sys
p, a, b = sys.argv[1:4]
s = open(p).read()
if a not in s: sys.exit(1)
open(p, 'w').write(s.replace(a, b))
PY
}
case "$MUTATE" in
  "") ;;
  # C1/C2: without the pre-lock the write's snapshot predates a concurrent close or run.
  no_prelock) mj "  select coalesce(array_agg(locked.id), '{}') into v_locked from (
    select id from public.action_items
    where id = any(v_ids)
    order by id
    for no key update
  ) locked;" "  v_locked := v_ids;";;
  # Locks taken, but the write uses the pre-lock list instead of recomputing.
  no_recompute) mj "    select d.item_id, d.reason
    from public.archive_proposals_due(p_now) d
    where d.action in ('propose', 'repropose')
      and d.item_id = any(v_locked)" "    select x as item_id, 'age_standard'::text as reason from unnest(v_locked) x";;
  pending_reproposed) mj "      when a.archive_proposed_at is not null then 'pending'" "      when a.archive_proposed_at is not null then 'propose'";;
  kept_never_reproposes) mj "          then 'kept_recently' else 'repropose' end" "          then 'kept_recently' else 'kept_recently' end";;
  repropose_keeps_review) mj "        archive_review_outcome = null,
        archive_reviewed_at = null" "        archive_review_outcome = a.archive_review_outcome,
        archive_reviewed_at = a.archive_reviewed_at";;
  card_done_exempts) mj "        and t.status <> 'Agent Done'" "";;
  card_archived_exempts) mj "        and t.archived_at is null
        and t.status" "        and t.status";;
  no_card_exemption) mj "      where t.linked_action_item_id = a.id" "      where false and t.linked_action_item_id = a.id";;
  reopen_exempt_off) mj "    and (a.reopened_at is null or a.reopened_at <= p_now - interval '2160 hours')" "";;
  client_one_match) mj "           where position(public.archive_policy_js_lower(w.word) in public.archive_policy_js_lower(c.name)) > 0) >= 2" "           where position(public.archive_policy_js_lower(w.word) in public.archive_policy_js_lower(c.name)) > 0) >= 1";;
  client_fullname_off) mj "    where coalesce(array_length(names.ct, 1), 0) >= 2" "    where coalesce(array_length(names.ct, 1), 0) >= 99";;
  canary_off) mj "    and not (public.archive_policy_js_lower(a.description) like '%perpetual%'" "    and not (false and public.archive_policy_js_lower(a.description) like '%perpetual%'";;
  deferred_included) mj "  where a.status = 'open'" "  where a.status in ('open', 'deferred')";;
  deadline_no_clause_break) mj "      exit when v_toks[j] ~ '[,;.]\$';" "";;
  deadline_window_4) mj "greatest(1, i - 3)" "greatest(1, i - 4)";;
  deadline_grace_off) mj "(d.dl::timestamp at time zone 'UTC') + interval '336 hours'" "(d.dl::timestamp at time zone 'UTC')";;
  wr_future_header_counts) mj "    if (make_date(v_y, v_mo, v_d)::timestamp at time zone 'UTC') <= p_captured_at + interval '24 hours' then" "    if true then";;
  wr_threshold_1) mj "  if v_hits >= 2 then
    return true;" "  if v_hits >= 1 then
    return true;";;
  fragment_ignored) mj "          or exists (
            select 1 from public.auto_resolve_decisions f" "          or false and exists (
            select 1 from public.auto_resolve_decisions f";;
  fragment_any_generation) mj "              and f.item_generation = a.reopen_generation" "";;
  work_report_age_60) mj "        when 'age_work_report' then a.created_at + interval '720 hours'" "        when 'age_work_report' then a.created_at + interval '1440 hours'";;
  status_written) mj "    set archive_proposed_at = p_now," "    set status = 'deferred', defer_reason = 'archive:proposed', archive_proposed_at = p_now,";;
  grant_anon) echo "grant execute on function public.run_archive_proposals(timestamptz) to anon;" >> "$SRC";;
  schedule_wrong) mj "  '30 5 * * *'," "  '30 11 * * *',";;
  last_run_oldest) mj "  order by d.start_time desc nulls last" "  order by d.start_time asc nulls last";;
  exclusive_boundary) mj "    and r.due_at <= p_now" "    and r.due_at < p_now";;
  # The ASCII word boundary put back to the locale's (the code before the PR 24
  # review): \y, then [[:alnum:]_], then ASCII without the underscore.
  wr_locale_boundary) mj "(?<![A-Za-z0-9_])" '\y'; mj "(?![A-Za-z0-9_])" '\y';;
  wr_alnum_boundary) mj "(?<![A-Za-z0-9_])" "(?<![[:alnum:]_])"; mj "(?![A-Za-z0-9_])" "(?![[:alnum:]_])";;
  wr_boundary_no_underscore) mj "(?<![A-Za-z0-9_])" "(?<![A-Za-z0-9])"; mj "(?![A-Za-z0-9_])" "(?![A-Za-z0-9])";;
  # JavaScript's whitespace, UTF-16 window and lowercasing put back to the locale's
  # (the code before the PR 24 re-review), one site at a time.
  ws_locale_commit) mj 'commit[\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+[0-9a-f]' 'commit\s+[0-9a-f]';;
  ws_locale_deadline) mj "'[\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+'), '')" "'\s+'), '')";;
  ws_no_feff) mj '[\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]' '[\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000]';;
  window_chars) mj "    continue when char_length(v_gap)
      + char_length(regexp_replace(v_gap, '[^\U00010000-\U0010FFFF]', '', 'g')) > 24;" "    continue when char_length(v_gap) > 24;";;
  lower_locale_tokens) mj "regexp_split_to_array(public.archive_policy_js_lower(coalesce(p_description, '')), '[^a-z0-9]+')" "regexp_split_to_array(lower(coalesce(p_description, '')), '[^a-z0-9]+')"; mj "regexp_split_to_array(public.archive_policy_js_lower(c.name), '[^a-z0-9]+')" "regexp_split_to_array(lower(c.name), '[^a-z0-9]+')";;
  lower_locale_partial) mj "position(public.archive_policy_js_lower(w.word) in public.archive_policy_js_lower(c.name))" "position(lower(w.word) in lower(c.name))";;
  lower_locale_canary) mj "public.archive_policy_js_lower(a.description) like" "lower(a.description) like";;
  # Not in MUTATIONS: equivalent on every locale tested (no deadline keyword
  # holds a k, and lower() and JavaScript both reduce U+0130 to an "i" that
  # survives the strip to a-z). Run by hand; it is expected to survive.
  lower_locale_deadline) mj "regexp_replace(public.archive_policy_js_lower(v_toks[j]), '[^a-z]', '', 'g')" "regexp_replace(lower(v_toks[j]), '[^a-z]', '', 'g')";;
  js_lower_no_dotted_i) mj "replace(replace(coalesce(p_text, ''), chr(304), 'i' || chr(775)), chr(8490), 'k')" "replace(coalesce(p_text, ''), chr(8490), 'k')";;
  js_lower_no_kelvin) mj "replace(replace(coalesce(p_text, ''), chr(304), 'i' || chr(775)), chr(8490), 'k')" "replace(coalesce(p_text, ''), chr(304), 'i' || chr(775))";;
  *) never "unknown mutation: $MUTATE";;
esac

if ! PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d obtest -f "$SRC" >"$WORK/mig.out" 2>&1; then
  never "migration failed to apply: $(sed 's/^psql:.*ERROR/ERROR/' "$WORK/mig.out" | head -3)"
fi
echo "migrations applied"

q() {
  local out code
  out=$("${PSQL[@]}" -d obtest -At -c "$1" 2>&1); code=$?
  if [ "$code" -ne 0 ] && [ "$code" -ne 1 ]; then echo "psql exit $code: $out" >> "$WORK/qfail"; fi
  printf '%s\n' "$out"
}

# --------------------------------------------------------------------------
# --diff: load the snapshot, run the SQL functions, compare with the TypeScript.
# --------------------------------------------------------------------------
if [ "$MODE" = diff ]; then
  vst=$(verdict_selftest) || never "the diff verdict classifier failed its own self-test, so no diff verdict can be trusted: $(printf '%s\n' "$vst" | grep -m1 '^FAIL')"
  lst=$(load_selftest) || never "the snapshot loader failed its own self-test, so no snapshot load can be trusted: $(printf '%s\n' "$lst" | grep -m1 '^FAIL')"
  deno run --no-lock --allow-read "$HERE/archive-proposals-diff.ts" emit-adversarial > "$WORK/adv.json" || never "emit-adversarial failed"
  build_load_sql "$SNAP" "$WORK" || never "could not build the snapshot load file (see the line above)"
  # Snapshot rows carry their own closed_at/reopen values; the status triggers fire
  # only on UPDATE, so inserting them changes nothing.
  PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d obtest -f "$WORK/load.sql" >"$WORK/load.out" 2>&1 \
    || never "snapshot load failed: $(head -3 "$WORK/load.out")"
  SNAP_AT=$(tr -d '\n' < "$SNAP/snapshot_at.txt")
  FIRST_RUN="2026-11-19T05:30:00Z"
  MOMENTS="$SNAP_AT,$FIRST_RUN"
  if [ -f "$SNAP/moments.txt" ]; then
    MOMENTS="$MOMENTS,$(grep -v '^$' "$SNAP/moments.txt" | paste -sd, -)"
  fi
  DUE_SQL=""
  IFS=',' read -ra MARR <<< "$MOMENTS"
  for m in "${MARR[@]}"; do
    case "$m" in *[!0-9TZ:.+-]*|"") never "moment '$m' is not a timestamp";; esac
    DUE_SQL="$DUE_SQL${DUE_SQL:+ union all }select '$m'::text as moment, (select coalesce(jsonb_agg(to_jsonb(d)), '[]') from public.archive_proposals_due('$m') d) as rows"
  done
  "${PSQL[@]}" -d obtest -At -o "$WORK/sql.json" -c "
    select jsonb_build_object(
      'loaded', jsonb_build_object(
        'thoughts', (select count(*) from public.thoughts),
        'items', (select count(*) from public.action_items),
        'clients', (select count(*) from public.clients),
        'cards', (select count(*) from public.agent_tasks),
        'fragments', (select count(*) from public.auto_resolve_decisions where layer = 'fragment')),
      'fragments', (select coalesce(jsonb_agg(jsonb_build_object('item_id', f.item_id, 'item_generation', f.item_generation)), '[]')
                    from public.auto_resolve_decisions f where f.layer = 'fragment'),
      'work_report', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'v', public.archive_policy_is_work_report(t.content, t.created_at))), '[]')
                      from public.thoughts t where t.id in (select source_thought_id from public.action_items)),
      'deadline', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'v', public.archive_policy_deadline(a.description))), '[]') from public.action_items a),
      'client', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'v', public.archive_policy_client_shaped(a.description))), '[]') from public.action_items a),
      'adversarial', (select coalesce(jsonb_agg(jsonb_build_object('i', x.i,
                        'wr', public.archive_policy_is_work_report(x.text, x.captured_at),
                        'dl', public.archive_policy_deadline(x.text),
                        'cs', public.archive_policy_client_shaped(x.text))), '[]') from public.adv x),
      'known', (select coalesce(jsonb_agg(jsonb_build_object('i', k.i,
                  'wr', public.archive_policy_is_work_report(k.text, k.captured_at))), '[]') from public.known_split k),
      'due', (select coalesce(jsonb_agg(jsonb_build_object('moment', m.moment, 'rows', m.rows)), '[]') from ($DUE_SQL) m))" \
    || never "the SQL side of the diff did not run"
  [ -n "${OBAP_SAVE_SQL_OUT:-}" ] && cp "$WORK/sql.json" "$OBAP_SAVE_SQL_OUT"
  deno run --no-lock --allow-read "$HERE/archive-proposals-diff.ts" compare "$SNAP" "$WORK/sql.json" "$MOMENTS" >"$WORK/compare.out" 2>&1; dcode=$?
  cat "$WORK/compare.out"
  diff_verdict compare "$dcode" "$WORK/compare.out"
  case $? in
    0) ;;
    1) exit 1;;
    *) never "$VERDICT";;
  esac
  # The comparison passed. Prove its guards on this very output: a missing,
  # duplicated or unexpected row or moment must be INCOMPLETE, a changed value FAIL.
  deno run --no-lock --allow-read "$HERE/archive-proposals-diff.ts" selftest "$SNAP" "$WORK/sql.json" "$MOMENTS" >"$WORK/selftest.out" 2>&1; scode=$?
  cat "$WORK/selftest.out"
  diff_verdict selftest "$scode" "$WORK/selftest.out" || never "$VERDICT"
  COMPLETED=1; exit 0
fi

# --------------------------------------------------------------------------
# 1. The single-connection contract.
# --------------------------------------------------------------------------
if [ -z "${ONLY_CONCURRENCY:-}" ]; then
  OUT=$("${PSQL[@]}" -d obtest -f "$TEST_SQL" 2>&1); code=$?
  echo "$OUT" | grep -E "PASS|PASSED|ERROR" | sed 's/^psql:.*NOTICE:  //; s/^psql:.*ERROR:  /ERROR: /'
  case "$code" in
    0) echo "$OUT" | grep -q "ARCHIVE PROPOSALS SQL TEST PASSED" || never "the SQL contract exited 0 without its PASSED line";;
    3) echo "FAIL ARCHIVE PROPOSALS SQL TEST: $(echo "$OUT" | grep -m1 'ERROR' | sed 's/^psql:.*ERROR:  //' | cut -c1-200)"; exit 1;;
    *) never "the SQL contract did not complete (psql exit $code): $(echo "$OUT" | tail -1 | cut -c1-160)";;
  esac
fi

# --------------------------------------------------------------------------
# 2. Concurrency. Each connection reads commands from a FIFO, so the shell decides
# the interleaving. "Blocked" is read from pg_stat_activity, never assumed.
# --------------------------------------------------------------------------
SEQ=0
open_conn() {
  mkfifo "$WORK/$1.in"
  psql -X -h 127.0.0.1 -p "$PORT" -U postgres -d obtest -v ON_ERROR_STOP=0 -q -At < "$WORK/$1.in" > "$WORK/$1.out" 2>&1 &
  PIDS="$PIDS $!"
  case "$1" in A) exec 7>"$WORK/A.in";; B) exec 8>"$WORK/B.in";; esac
  send "$1" "set application_name = 'conn_$1';"
  sync_conn "$1"
}
send() { case "$1" in A) printf '%s\n' "$2" >&7;; B) printf '%s\n' "$2" >&8;; esac; }
sync_conn() {
  SEQ=$((SEQ + 1)); local f="$WORK/sync.$SEQ"
  send "$1" "\\! touch $f"
  local t="${OBAP_SYNC_TICKS:-200}"
  while [ ! -e "$f" ] && [ "$t" -gt 0 ]; do sleep 0.05; t=$((t - 1)); done
  [ -e "$f" ] || never "connection $1 did not finish its statements in time (incomplete execution, not a check failure)"
}
blocked_count() { q "select count(*) from pg_stat_activity where application_name = 'conn_$1' and wait_event_type = 'Lock'"; }
wait_blocked() {
  local t=60
  while [ "$t" -gt 0 ]; do
    [ "$(blocked_count "$1")" = "1" ] && return 0
    sleep 0.05; t=$((t - 1))
  done
  sync_conn "$1"
  fail "$2: connection $1 completed without ever waiting on a lock"
}
clean() { tr -d '\000' < "$WORK/$1.out"; }
NOW0="2026-11-19 05:30:00+00"
# Each schedule uses its own items, aged against a moment far after the contract's,
# and asserts per item, so the contract's leftover rows cannot decide it.
NOWC="2027-06-01 05:30:00+00"

open_conn A; open_conn B

# C1: an item closed by an uncommitted transaction.
X1=c1000001-0000-4000-8000-000000000000; Y1=c1000002-0000-4000-8000-000000000000
q "insert into public.action_items (id, description, created_at) values ('$X1', 'c1 x', '$NOWC'::timestamptz - interval '61 days'), ('$Y1', 'c1 y', '$NOWC'::timestamptz - interval '61 days')" >/dev/null
q "update public.action_items set archive_proposed_at = '$NOWC', archive_review_outcome = 'kept', archive_reviewed_at = '$NOWC' where id not in ('$X1', '$Y1') and status = 'open'" >/dev/null
: > "$WORK/A.out"; : > "$WORK/B.out"
send B "begin;"
send B "select public.transition_action_item('$Y1', '{open}', 'resolved', 'operator', 'done');"
sync_conn B
send A "select 'run=' || public.run_archive_proposals('$NOWC');"
wait_blocked A "C1 the job waits for the uncommitted close"
send B "commit;"; sync_conn B; sync_conn A
clean A | grep -qx "run=1" || fail "C1: expected run=1, got '$(clean A | tail -2)'"
[ "$(q "select (archive_proposed_at is not null)::text || '|' || status from public.action_items where id = '$X1'")" = "true|open" ] || fail "C1: X was not proposed"
[ "$(q "select (archive_proposed_at is null)::text || '|' || status || '|' || (select count(*) from public.auto_resolve_decisions where item_id = '$Y1' and layer = 'archive') from public.action_items where id = '$Y1'")" = "true|resolved|0" ] || fail "C1: the item closed during the run was proposed"
echo "PASS C1 the job waited on the uncommitted close and then skipped the closed item"

# C2: two runs at once write each proposal once.
X2=c2000001-0000-4000-8000-000000000000; Y2=c2000002-0000-4000-8000-000000000000
q "insert into public.action_items (id, description, created_at) values ('$X2', 'c2 x', '$NOWC'::timestamptz - interval '61 days'), ('$Y2', 'c2 y', '$NOWC'::timestamptz - interval '61 days')" >/dev/null
: > "$WORK/A.out"; : > "$WORK/B.out"
send A "begin;"
send A "select 'runA=' || public.run_archive_proposals('$NOWC');"
sync_conn A
send B "select 'runB=' || public.run_archive_proposals('$NOWC');"
wait_blocked B "C2 the second run waits for the first"
send A "commit;"; sync_conn A; sync_conn B
clean A | grep -qx "runA=2" || fail "C2: expected runA=2, got '$(clean A | tail -2)'"
clean B | grep -qx "runB=0" || fail "C2: expected runB=0, got '$(clean B | tail -2)'"
[ "$(q "select count(*) from public.auto_resolve_decisions where item_id in ('$X2', '$Y2') and layer = 'archive'")" = "2" ] || fail "C2: a proposal was written twice"
echo "PASS C2 two concurrent runs: the second waited and wrote nothing; one proposal per item"

[ "$(q "select count(*) from public.action_item_events where actor = 'sql'")" = "0" ] || fail "C: an sql-actor event"
COMPLETED=1
echo "ARCHIVE PROPOSALS TEST COMPLETE${MUTATE:+ (mutation $MUTATE)}"
