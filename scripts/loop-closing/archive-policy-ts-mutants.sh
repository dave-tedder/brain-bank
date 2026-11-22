#!/bin/bash
# Loop-closing Task 3.2: negative controls for the TypeScript side. Each mutant is
# applied to a THROWAWAY COPY of the tree (never this checkout) and judged by
#   supabase/functions/_shared/archive-policy.test.ts  (policy) or
#   supabase/functions/brain-digest/archive-proposals.test.ts  (digest section) or
#   scripts/loop-closing/archive-proposals-diff.test.ts       (the diff checker's guards) or
#   archive-proposals-sql-test.sh --verdict-selftest         (the shell's diff verdict
#                                                             classifier; no database) or
#   archive-proposals-sql-test.sh --load-selftest            (the shell's snapshot
#                                                             loader; no database).
# The SQL mirror is judged separately by archive-proposals-sql-test.sh, and the two
# are tied together by its --diff mode.
#
#   bash scripts/loop-closing/archive-policy-ts-mutants.sh            # every mutant
#   bash scripts/loop-closing/archive-policy-ts-mutants.sh <name>...  # some
#
# CAUGHT only when deno test ran and reported a failed test. A judge that timed
# out or could not load is NEVER-RAN. Exit 0 only when every mutant was CAUGHT;
# 1 if any survived; 2 if any never ran.
export LC_ALL=C
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEADLINE="$ROOT/scripts/loop-closing/deadline.py"
POLICY=supabase/functions/_shared/archive-policy.ts
DIGEST=supabase/functions/brain-digest/archive-proposals.ts
DIFF=scripts/loop-closing/archive-proposals-diff.ts
ALL="no_clause_break window_4 grace_0 client_one_match client_fullname_single reopen_exempt_off card_ignored canary_ignored deferred_allowed work_report_60 kept_never_repropose pending_reproposed digest_includes_young digest_job_warning_off digest_failed_read_as_empty diff_no_duplicate diff_no_missing diff_no_unexpected diff_no_moment_inventory diff_no_loaded_counts diff_no_fragment_rows diff_due_as_set diff_incomplete_as_fail diff_unsupported_ignored diff_fragment_members_unchecked diff_null_generation_refused diff_id_rows_unchecked diff_snapshot_row_unchecked diff_snapshot_array_unchecked diff_snapshot_empty_refused diff_snapshot_key_unchecked diff_snapshot_nullable_refused diff_cli_uncaught diff_selftest_exception_matches shell_exit1_trusted shell_exit0_trusted shell_fail_lines_optional shell_verdict_anywhere shell_incomplete_as_fail shell_selftest_line_optional shell_load_array_unchecked shell_load_empty_refused shell_load_row_unchecked shell_load_key_unchecked shell_load_nullable_refused shell_load_refuse_crashes shell_load_refusal_anywhere shell_load_refusal_exit_ignored shell_load_ok_noise_trusted shell_load_ok_file_optional shell_load_success_prints_blank shell_load_refusal_extra_newline shell_load_ok_blank_trusted shell_load_refusal_newlines_loose shell_load_output_file_optional"
SHELL=scripts/loop-closing/archive-proposals-sql-test.sh

apply() { # tree, file, old, new
  python3 - "$1/$2" "$3" "$4" <<'PY'
import sys
p, a, b = sys.argv[1:4]
s = open(p).read()
if s.count(a) != 1: sys.exit(1)
open(p, 'w').write(s.replace(a, b))
PY
}

mutate() { # tree, name -> sets JUDGE
  case "$2" in
    no_clause_break) JUDGE=policy; apply "$1" "$POLICY" '      if (CLAUSE_END.test(toks[j])) break;' '';;
    window_4) JUDGE=policy; apply "$1" "$POLICY" 'export const DEADLINE_WINDOW_TOKENS = 3;' 'export const DEADLINE_WINDOW_TOKENS = 4;';;
    grace_0) JUDGE=policy; apply "$1" "$POLICY" 'export const DEADLINE_GRACE_DAYS = 14;' 'export const DEADLINE_GRACE_DAYS = 0;';;
    client_one_match) JUDGE=policy; apply "$1" "$POLICY" '    if (matches >= 2) return true;' '    if (matches >= 1) return true;';;
    client_fullname_single) JUDGE=policy; apply "$1" "$POLICY" '    if (ct.length >= 2 && hay.includes' '    if (ct.length >= 1 && hay.includes';;
    reopen_exempt_off) JUDGE=policy; apply "$1" "$POLICY" '    if (r > now.getTime() - REOPEN_EXEMPT_DAYS * DAY_MS) return null;' '';;
    card_ignored) JUDGE=policy; apply "$1" "$POLICY" '  if (ctx.linkedToOpenCard) return null;' '';;
    canary_ignored) JUDGE=policy; apply "$1" "$POLICY" '  if (isPerpetualCanaryText(item.description)) return null;' '';;
    deferred_allowed) JUDGE=policy; apply "$1" "$POLICY" '  if (item.status !== "open") return null;' '  if (item.status !== "open" && item.status !== "deferred") return null;';;
    work_report_60) JUDGE=policy; apply "$1" "$POLICY" 'export const WORK_REPORT_AGE_DAYS = 30;' 'export const WORK_REPORT_AGE_DAYS = 60;';;
    kept_never_repropose) JUDGE=policy; apply "$1" "$POLICY" '"kept_recently" : "repropose";' '"kept_recently" : "kept_recently";';;
    pending_reproposed) JUDGE=policy; apply "$1" "$POLICY" '  return item.archive_proposed_at ? "pending" : "propose";' '  return "propose";';;
    digest_includes_young) JUDGE=digest; apply "$1" "$DIGEST" '  const unreviewed = rows.filter((r) => wholeDays(r.archive_proposed_at, nowMs) >= UNREVIEWED_DAYS).length;' '  const unreviewed = rows.length;';;
    digest_job_warning_off) JUDGE=digest; apply "$1" "$DIGEST" '  if (run.status !== "succeeded") {' '  if (run.status === "__never__") {';;
    # A failed read rendered as an empty list ("none pending"), the lie I4 forbids.
    digest_failed_read_as_empty) JUDGE=digest; apply "$1" "$DIGEST" '  if (rows === null) {' '  if (rows === null) rows = [];
  if (rows.length < 0) {';;
    # The diff checker's inventory guards (Codex re-review of PR 24, 2026-11-18).
    diff_no_duplicate) JUDGE=diff; apply "$1" "$DIFF" '  if (dup.length) out.push(' '  if (false && dup.length) out.push(';;
    diff_no_missing) JUDGE=diff; apply "$1" "$DIFF" '  if (missing.length) {' '  if (false && missing.length) {';;
    diff_no_unexpected) JUDGE=diff; apply "$1" "$DIFF" '  if (extra.length) out.push(' '  if (false && extra.length) out.push(';;
    diff_no_moment_inventory) JUDGE=diff; apply "$1" "$DIFF" '  inventory(
    "due moments",' '  if (false) inventory(
    "due moments",';;
    diff_no_loaded_counts) JUDGE=diff; apply "$1" "$DIFF" '    if (got !== n) inc.push(' '    if (false && got !== n) inc.push(';;
    diff_no_fragment_rows) JUDGE=diff; apply "$1" "$DIFF" '  if (fa.join(" ") !== fb.join(" ")) {' '  if (false) {';;
    diff_due_as_set) JUDGE=diff; apply "$1" "$DIFF" '    for (const [k, n] of cb) if ((ca.get(k) ?? 0) < n)' '    for (const [k, n] of cb) if ((ca.get(k) ?? 0) < Math.min(n, 1))';;
    diff_incomplete_as_fail) JUDGE=diff; apply "$1" "$DIFF" '  if (inc.length) return { code: 3, lines: inc };

  // Every inventory is complete' '  if (inc.length) return { code: 1, lines: inc };

  // Every inventory is complete';;
    diff_unsupported_ignored) JUDGE=diff; apply "$1" "$DIFF" '  for (const u of snap.unsupported) inc.push(' '  for (const u of [] as string[]) inc.push(';;
    # The second re-review's P3 (Codex, 2026-11-18): malformed members and
    # exceptions are INCOMPLETE, never a crash that reads as a completed FAIL.
    diff_fragment_members_unchecked) JUDGE=diff; apply "$1" "$DIFF" '      inc.push(`INCOMPLETE fragments: malformed row' '      if (false) inc.push(`INCOMPLETE fragments: malformed row';;
    diff_null_generation_refused) JUDGE=diff; apply "$1" "$DIFF" '  const isGen = (g: unknown) => g === null || (typeof g' '  const isGen = (g: unknown) => (typeof g';;
    diff_id_rows_unchecked) JUDGE=diff; apply "$1" "$DIFF" '      if (!ok) inc.push(`INCOMPLETE ${name}: malformed row' '      if (false && !ok) inc.push(`INCOMPLETE ${name}: malformed row';;
    # The third re-review's P3 (Codex, 2026-11-18): every snapshot file must be an
    # array of objects with a typed key, checked before iteration, and an empty
    # array stays valid. (The decisions-row check of the second re-review moved
    # into this general row check, so diff_snapshot_row_unchecked replaces
    # diff_decision_row_unchecked.)
    diff_snapshot_row_unchecked) JUDGE=diff; apply "$1" "$DIFF" '    if (r === null || typeof r !== "object" || Array.isArray(r)) {' '    if (false) {';;
    diff_snapshot_array_unchecked) JUDGE=diff; apply "$1" "$DIFF" '  if (!Array.isArray(v)) {
    unsupported.push(`${file} is not an array' '  if (false) {
    unsupported.push(`${file} is not an array';;
    diff_snapshot_empty_refused) JUDGE=diff; apply "$1" "$DIFF" '  if (!Array.isArray(v)) {
    unsupported.push(`${file} is not an array' '  if (!Array.isArray(v) || v.length === 0) {
    unsupported.push(`${file} is not an array';;
    diff_snapshot_key_unchecked) JUDGE=diff; apply "$1" "$DIFF" '    if (key !== null && !(typeof k === "string" || (nullable && k === null))) {' '    if (false) {';;
    diff_snapshot_nullable_refused) JUDGE=diff; apply "$1" "$DIFF" '(typeof k === "string" || (nullable && k === null))' '(typeof k === "string" || (false && k === null))';;
    diff_cli_uncaught) JUDGE=diff; apply "$1" "$DIFF" '      console.log(`INCOMPLETE the ${mode} did not run to completion:' '      if (e) throw e;
      console.log(`INCOMPLETE the ${mode} did not run to completion:';;
    diff_selftest_exception_matches) JUDGE=diff; apply "$1" "$DIFF" '      got = "exception";' '      got = 3;';;
    # The shell's verdict classifier, judged by its canned cases.
    shell_exit1_trusted) JUDGE=shell; apply "$1" "$SHELL" '    compare:1)
      nfail=' '    compare:1)
      VERDICT="trusted"; return 1
      nfail=';;
    shell_exit0_trusted) JUDGE=shell; apply "$1" "$SHELL" '    compare:0)
      if [ "$last" = "ARCHIVE PROPOSALS DIFF PASSED" ]' '    compare:0)
      if true';;
    shell_fail_lines_optional) JUDGE=shell; apply "$1" "$SHELL" ' && [ "$nfail" -gt 0 ]; then' '; then';;
    shell_verdict_anywhere) JUDGE=shell; apply "$1" "$SHELL" "if printf '%s\\n' \"\$last\" | grep -Eqx 'ARCHIVE PROPOSALS DIFF FAILED \\([1-9][0-9]*\\)'" "if grep -Eqx 'ARCHIVE PROPOSALS DIFF FAILED \\([1-9][0-9]*\\)' \"\$file\"";;
    shell_incomplete_as_fail) JUDGE=shell; apply "$1" "$SHELL" '    compare:3) VERDICT=' '    compare:3) return 1; VERDICT=';;
    shell_selftest_line_optional) JUDGE=shell; apply "$1" "$SHELL" '      if [ "$last" = "DIFF SELFTEST PASSED" ]' '      if true';;
    # The shell's snapshot loader (build_load_sql), judged by --load-selftest.
    shell_load_array_unchecked) JUDGE=load; apply "$1" "$SHELL" '    if not isinstance(v, list):
        refuse(f"{name} is not an array' '    if False:
        refuse(f"{name} is not an array';;
    shell_load_empty_refused) JUDGE=load; apply "$1" "$SHELL" '    if not isinstance(v, list):
        refuse(f"{name} is not an array' '    if not isinstance(v, list) or not v:
        refuse(f"{name} is not an array';;
    shell_load_row_unchecked) JUDGE=load; apply "$1" "$SHELL" '        if not isinstance(r, dict):' '        if False:';;
    shell_load_key_unchecked) JUDGE=load; apply "$1" "$SHELL" '            if not (isinstance(k, str) or (nullable and k is None)):' '            if False:';;
    shell_load_nullable_refused) JUDGE=load; apply "$1" "$SHELL" '(isinstance(k, str) or (nullable and k is None))' '(isinstance(k, str) or (False and k is None))';;
    # The refusal judge (load_verdict), Codex fourth re-review, 2026-11-18. The
    # first is the reviewer's mutant: the loader prints the refusal, then crashes.
    shell_load_refuse_crashes) JUDGE=load; apply "$1" "$SHELL" '    print("unsupported snapshot: " + why)
    sys.exit(1)' '    print("unsupported snapshot: " + why)
    raise RuntimeError("crash after the refusal line")';;
    # The old judge: the refusal line anywhere in the output.
    shell_load_refusal_anywhere) JUDGE=load; apply "$1" "$SHELL" "printf '%s\\n' \"unsupported snapshot: \${want#refuse:}\" | cmp -s - \"\$out\";;" "grep -qxF \"unsupported snapshot: \${want#refuse:}\" \"\$out\";;";;
    shell_load_refusal_exit_ignored) JUDGE=load; apply "$1" "$SHELL" "    refuse:*) [ \"\$code\" = 1 ] && printf" "    refuse:*) printf";;
    shell_load_ok_noise_trusted) JUDGE=load; apply "$1" "$SHELL" '    ok) [ "$code" = 0 ] && [ ! -s "$out" ] && [ -s "$sql" ];;' '    ok) [ "$code" = 0 ] && [ -s "$sql" ];;';;
    shell_load_ok_file_optional) JUDGE=load; apply "$1" "$SHELL" '    ok) [ "$code" = 0 ] && [ ! -s "$out" ] && [ -s "$sql" ];;' '    ok) [ "$code" = 0 ] && [ ! -s "$out" ];;';;
    # Trailing newlines (Codex fifth re-review, 2026-11-18). The first two are the
    # reviewer's mutants on the loader: a blank line printed by a good load, and a
    # blank line after the refusal.
    shell_load_success_prints_blank) JUDGE=load; apply "$1" "$SHELL" 'ins("public.known_split", ["i", "text", "captured_at"], adv["known"], "public.known_split")
' 'ins("public.known_split", ["i", "text", "captured_at"], adv["known"], "public.known_split")
print()
';;
    shell_load_refusal_extra_newline) JUDGE=load; apply "$1" "$SHELL" '    print("unsupported snapshot: " + why)
    sys.exit(1)' '    print("unsupported snapshot: " + why + "\n")
    sys.exit(1)';;
    # The old judge's blind spot: the output read back through $(...), which
    # drops trailing newlines.
    shell_load_ok_blank_trusted) JUDGE=load; apply "$1" "$SHELL" '    ok) [ "$code" = 0 ] && [ ! -s "$out" ] && [ -s "$sql" ];;' '    ok) [ "$code" = 0 ] && [ -z "$(cat "$out")" ] && [ -s "$sql" ];;';;
    shell_load_refusal_newlines_loose) JUDGE=load; apply "$1" "$SHELL" "printf '%s\\n' \"unsupported snapshot: \${want#refuse:}\" | cmp -s - \"\$out\";;" "[ \"\$(cat \"\$out\")\" = \"unsupported snapshot: \${want#refuse:}\" ];;";;
    shell_load_output_file_optional) JUDGE=load; apply "$1" "$SHELL" '  [ -f "$out" ] || return 1
' '';;
    *) return 2;;
  esac
}

caught=0; survived=0; never=0
for m in ${*:-$ALL}; do
  T="$(mktemp -d /tmp/obap-ts.XXXXXX)"
  mkdir -p "$T/supabase"
  cp -R "$ROOT/supabase/functions" "$T/supabase/"
  mkdir -p "$T/scripts/loop-closing"
  cp "$ROOT/$DIFF" "$ROOT/scripts/loop-closing/archive-proposals-diff.test.ts" "$ROOT/$SHELL" "$T/scripts/loop-closing/"
  cp "$ROOT/deno.json" "$T/"
  JUDGE=""
  if ! mutate "$T" "$m"; then
    echo "NEVER-RAN $m: the mutant did not apply to exactly one site"; never=$((never + 1)); rm -rf "$T"; continue
  fi
  case "$JUDGE" in
    policy) TEST="$T/supabase/functions/_shared/archive-policy.test.ts";;
    digest) TEST="$T/supabase/functions/brain-digest/archive-proposals.test.ts";;
    diff) TEST="$T/scripts/loop-closing/archive-proposals-diff.test.ts";;
  esac
  if [ "$JUDGE" = shell ] || [ "$JUDGE" = load ]; then
    # CAUGHT only when the canned cases ran and one was misjudged: the verdict
    # classifier's (shell) or the snapshot loader's (load). Every misjudged case
    # is listed, so a reader can see the mutant reached the case aimed at it.
    if [ "$JUDGE" = shell ]; then flag=--verdict-selftest; word=VERDICT; else flag=--load-selftest; word=LOAD; fi
    out=$(cd "$T" && python3 "$DEADLINE" 60 bash "$T/$SHELL" "$flag" 2>&1); code=$?
    if [ "$code" = 1 ] && printf '%s\n' "$out" | grep -qE "^$word SELFTEST FAILED \\([1-9]"; then
      echo "CAUGHT    $m: $(printf '%s\n' "$out" | grep -E '^FAIL (verdict|load) (judge )?case' | sed -E 's/^FAIL (verdict|load) (judge )?case ([0-9]+).*/\2\3/' | paste -sd, - | sed 's/^/cases /') | $(printf '%s\n' "$out" | grep -m1 -E '^FAIL (verdict|load)' | cut -c1-110)"; caught=$((caught + 1))
    elif [ "$code" = 0 ] && printf '%s\n' "$out" | grep -q "^$word SELFTEST PASSED"; then
      echo "SURVIVED  $m"; survived=$((survived + 1))
    else
      echo "NEVER-RAN $m (exit $code): $(printf '%s\n' "$out" | tail -1 | cut -c1-120)"; never=$((never + 1))
    fi
    rm -rf "$T"; continue
  fi
  out=$(cd "$T" && python3 "$DEADLINE" 120 deno test --no-lock --allow-read --allow-write --allow-run "$TEST" 2>&1); code=$?
  if [ "$code" = 1 ] && printf '%s\n' "$out" | grep -qE '[1-9][0-9]* failed'; then
    # Every failing test, so a reader can see the mutant reached the test aimed at it.
    echo "CAUGHT    $m: $(printf '%s\n' "$out" | sed 's/\x1b\[[0-9;]*m//g' | grep -E ' \.\.\. FAILED' | sed 's/ \.\.\. FAILED.*//' | sort -u | paste -sd'|' - | sed 's/|/ | /g' | cut -c1-400)"
    caught=$((caught + 1))
  elif [ "$code" = 0 ]; then
    echo "SURVIVED  $m"; survived=$((survived + 1))
  else
    echo "NEVER-RAN $m (exit $code): $(printf '%s\n' "$out" | tail -1 | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-120)"; never=$((never + 1))
  fi
  rm -rf "$T"
done
n=$((caught + survived + never))
echo "TS SWEEP: $n mutations, $caught caught, $survived survived, $never never ran"
[ "$never" -gt 0 ] && exit 2
[ "$survived" -gt 0 ] && exit 1
echo "ALL $n TS MUTATIONS CAUGHT"
exit 0
