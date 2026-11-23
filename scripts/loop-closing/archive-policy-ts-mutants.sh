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
#   bash scripts/loop-closing/archive-policy-ts-mutants.sh                  # every mutant
#   bash scripts/loop-closing/archive-policy-ts-mutants.sh <name>...        # some
#   bash scripts/loop-closing/archive-policy-ts-mutants.sh --judge-selftest # canned deno transcripts only
#
# Three outcomes per mutant. For the deno judges (policy, digest, diff), CAUGHT
# only when Deno's JUnit report shows a COMPLETED, TEST-OWNED assertion failure:
# an AssertionError whose first stack frame outside @std is the test file itself
# (see JUDGE_PY below for every clause). An error that escaped the tests (a throw
# at module load or in top-level code), a run where no test ran, a type-check
# failure, a deadline, a crash, or an assertion the module under test made on
# itself are NEVER-RAN. (Codex review of PR 39, P2, 2026-11-22: exit 1 plus any
# "N failed" text read a module that threw at load as CAUGHT. Codex re-review 1,
# P2: an @std/assert call inside the policy, and a RangeError whose message held
# "error: AssertionError", read as CAUGHT under the text-scraping judge.)
#
# Before any mutant, the judge must pass its canned reports and each NEGATIVE
# CONTROL below must (a) apply at exactly one site, (b) produce its intended Deno
# failure, observed in that run's report, and (c) be judged NEVER-RAN. Those three
# are a pass of the control, not a sweep failure. A control that fails any of
# them means no verdict can be trusted: the sweep stops, exit 2, before any mutant.
# Exit 0 only when every control held and every mutant was CAUGHT; 1 if any
# survived; 2 if any never ran.
export LC_ALL=C
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEADLINE="$ROOT/scripts/loop-closing/deadline.py"
POLICY=supabase/functions/_shared/archive-policy.ts
DIGEST=supabase/functions/brain-digest/archive-proposals.ts
DIFF=scripts/loop-closing/archive-proposals-diff.ts
ALL="client_id_off client_id_inverted client_id_replaces_text client_id_kept_repropose diff_client_id_unchecked diff_client_id_cover_noop shell_load_client_id_unchecked no_clause_break window_4 grace_0 client_one_match client_fullname_single reopen_exempt_off card_ignored canary_ignored deferred_allowed work_report_60 kept_never_repropose pending_reproposed digest_includes_young digest_job_warning_off digest_failed_read_as_empty diff_no_duplicate diff_no_missing diff_no_unexpected diff_no_moment_inventory diff_no_loaded_counts diff_no_fragment_rows diff_due_as_set diff_incomplete_as_fail diff_unsupported_ignored diff_fragment_members_unchecked diff_null_generation_refused diff_id_rows_unchecked diff_snapshot_row_unchecked diff_snapshot_array_unchecked diff_snapshot_empty_refused diff_snapshot_key_unchecked diff_snapshot_nullable_refused diff_cli_uncaught diff_selftest_exception_matches shell_exit1_trusted shell_exit0_trusted shell_fail_lines_optional shell_verdict_anywhere shell_incomplete_as_fail shell_selftest_line_optional shell_load_array_unchecked shell_load_empty_refused shell_load_row_unchecked shell_load_key_unchecked shell_load_nullable_refused shell_load_refuse_crashes shell_load_refusal_anywhere shell_load_refusal_exit_ignored shell_load_ok_noise_trusted shell_load_ok_file_optional shell_load_success_prints_blank shell_load_refusal_extra_newline shell_load_ok_blank_trusted shell_load_refusal_newlines_loose shell_load_output_file_optional"
SHELL=scripts/loop-closing/archive-proposals-sql-test.sh
# Negative controls for deno_verdict, run live before the mutants. Each must
# apply, show its intended failure, and be judged NEVER-RAN (control_expect
# names the failure each must show).
#   ctl_policy_load_crash  the policy module throws at load: Deno reports the
#                          test file "(uncaught error)" and no test case runs.
#                          The first review's case.
#   ctl_policy_step_crash  every test that reaches archiveDueAt throws a
#                          TypeError: tests run and fail, but nothing asserted.
#   ctl_policy_assertion   archiveDueAt calls @std/assert's assert(false) on
#                          itself, with a test-file frame forged in the message:
#                          an AssertionError, but the policy's, not the test's.
#                          Codex re-review 1, fault 1.
#   ctl_policy_error_text  archiveDueAt throws a RangeError whose message holds
#                          "input => ...", "error: AssertionError: ..." and a
#                          forged test-file frame. Codex re-review 1, fault 2.
CONTROLS="ctl_policy_load_crash ctl_policy_step_crash ctl_policy_assertion ctl_policy_error_text"
control_expect() { # control -> KIND (escape or an error type) and MARK (text in its message)
  case "$1" in
    ctl_policy_load_crash) KIND=escape; MARK="synthetic module startup failure (negative control)";;
    ctl_policy_step_crash) KIND=TypeError; MARK="synthetic step crash (negative control)";;
    ctl_policy_assertion) KIND=AssertionError; MARK="synthetic policy assertion (negative control)";;
    ctl_policy_error_text) KIND=RangeError; MARK="synthetic diagnostic text (negative control)";;
    *) KIND=""; MARK="";;
  esac
}

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
    # Task 3.2 follow-up to Task 5.3: the client_id exemption dropped, inverted,
    # and made to REPLACE the text rule instead of adding to it.
    client_id_off) JUDGE=policy; apply "$1" "$POLICY" '  if (item.client_id !== null && item.client_id !== undefined) return null;
' '';;
    client_id_inverted) JUDGE=policy; apply "$1" "$POLICY" '  if (item.client_id !== null && item.client_id !== undefined) return null;' '  if (item.client_id === null || item.client_id === undefined) return null;';;
    client_id_replaces_text) JUDGE=policy; apply "$1" "$POLICY" '  if (isClientShaped(item.description, ctx.clientNames)) return null;
' '';;
    # Codex review of PR 39 (P2, 2026-11-22): the TypeScript twin of the SQL
    # mutant client_id_kept_repropose, a kept item with a client_id let through.
    client_id_kept_repropose) JUDGE=policy; apply "$1" "$POLICY" '  if (item.client_id !== null && item.client_id !== undefined) return null;' '  if (item.client_id !== null && item.client_id !== undefined && item.archive_review_outcome !== "kept") return null;';;
    # The diff's client_id guards: a snapshot without the column, and the COVER
    # computation that proves the due sets hold rows the rule decides.
    diff_client_id_unchecked) JUDGE=diff; apply "$1" "$DIFF" '    if (!(c === null || typeof c === "string")) {
      unsupported.push(`items.json row' '    if (false) {
      unsupported.push(`items.json row';;
    diff_client_id_cover_noop) JUDGE=diff; apply "$1" "$DIFF" '    clearClientIds ? snap.items.map((i) => ({ ...i, client_id: null })) : snap.items,' '    snap.items,';;
    shell_load_client_id_unchecked) JUDGE=load; apply "$1" "$SHELL" '    if not (c is None or isinstance(c, str)):
        refuse(f"items.json row' '    if False:
        refuse(f"items.json row';;
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
    ctl_policy_load_crash) JUDGE=policy; printf '\nif (Deno.args.length >= 0) throw new Error("synthetic module startup failure (negative control)");\n' >> "$1/$POLICY";;
    ctl_policy_step_crash) JUDGE=policy; apply "$1" "$POLICY" '  if (item.status !== "open") return null;' '  if (item.status !== "open") return null;
  if (Deno.args.length >= 0) throw new TypeError("synthetic step crash (negative control)");';;
    ctl_policy_assertion) JUDGE=policy; apply "$1" "$POLICY" '  if (item.status !== "open") return null;' '  if (item.status !== "open") return null;
  if (Deno.args.length >= 0) ctlAssert(false, "synthetic policy assertion (negative control)\n    at " + new URL("./archive-policy.test.ts", import.meta.url).href + ":1:1");' &&
      printf '\nimport { assert as ctlAssert } from "jsr:@std/assert@1.0.19";\n' >> "$1/$POLICY";;
    ctl_policy_error_text) JUDGE=policy; apply "$1" "$POLICY" '  if (item.status !== "open") return null;' '  if (item.status !== "open") return null;
  if (Deno.args.length >= 0) throw new RangeError("synthetic diagnostic text (negative control)\ninput => synthetic:7:9\nerror: AssertionError: diagnostic text\n    at " + new URL("./archive-policy.test.ts", import.meta.url).href + ":1:1");';;
    *) return 2;;
  esac
}

# The deno judge. Deno writes a JUnit report (--junit-path) beside its normal
# output, and the verdict is read from that report's STRUCTURE, never from text
# that resembles reporter output (Codex re-review 1 of PR 39, P2, 2026-11-22: a
# policy that called the same @std/assert primitive the tests use, and a RangeError
# whose message held a line "error: AssertionError", were both read as CAUGHT).
#
# CAUGHT (0) needs exit 1, nothing escaped the tests, a report whose totals match
# its test cases, no errored or cancelled test, and at least one <failure> that is
# a TEST-OWNED assertion: its type is AssertionError, and the first stack frame
# outside https://jsr.io/@std/ is the test file under judgment (exact path). The
# frames are read only from the report body AFTER the recorded message, cut off by
# its length, so text inside a message can never pose as a frame. An assertion
# the module under test makes on itself has that module as its first own frame and
# is NOT caught. SURVIVED (1) needs exit 0, at least one test case and no failure.
# Everything else is NEVER-RAN (2), and so is a judge that crashes or prints no
# verdict. The pretty output is consulted only to find an escaped error, which can
# lower a verdict to NEVER-RAN and never raise one.
#
#   python3 -c "$JUDGE_PY" verdict  <exit> <pretty output> <junit report> <test file>
#   python3 -c "$JUDGE_PY" observe  <kind> <marker> <pretty output> <junit report> <policy file>
#   python3 -c "$JUDGE_PY" selftest
IFS= read -r -d '' JUDGE_PY <<'PY' || true
import os, re, sys, urllib.parse
import xml.etree.ElementTree as ET

STD = "https://jsr.io/@std/"
ESCAPE = re.compile(r"\(uncaught error\)$|^Uncaught error from |^This error was not caught from a test", re.M)
FRAME = re.compile(r"^    at (?:async )?(?:[^(]*\()?(?P<url>.+?):[0-9]+:[0-9]+\)?$")
WS = str.maketrans("\t\n\r", "   ")  # XML attribute normalisation turns these into spaces


def where(url):
    if url.startswith("file://"):
        return os.path.realpath(urllib.parse.unquote(url[len("file://"):]))
    return url


def failure_facts(fail):
    """(type, message, frames) of one <failure>, or None when its body does not
    start with the message Deno recorded for it. The frames come only from the
    body after the message, so a message cannot supply one."""
    msg = re.sub(r"^Uncaught (\(in promise\) )?", "", fail.get("message") or "")
    body = fail.text or ""
    if not msg or body[:len(msg)].translate(WS) != msg.translate(WS):
        return None
    rest = body[len(msg):]
    frames = [f.group("url") for f in map(FRAME.match, rest.split("\n")) if f]
    return msg.partition(":")[0], msg, frames


def first_own_frame(frames):
    return next((u for u in frames if not u.startswith(STD)), None)


def not_test_owned(fail, test):
    """None when this failure is an assertion made by the test file, else why not."""
    facts = failure_facts(fail)
    if facts is None:
        return "a failure whose report body does not start with its message"
    kind, _, frames = facts
    if kind != "AssertionError":
        return kind
    own = first_own_frame(frames)
    if own is None:
        return "an AssertionError with no caller frame"
    if where(own) != os.path.realpath(test):
        return "an AssertionError raised from " + own.rsplit("/", 1)[-1] + ", not the test file"
    return None


def parse(xmltext):
    if xmltext is None:
        return None, "no JUnit report was written"
    try:
        return ET.fromstring(xmltext), ""
    except ET.ParseError as e:
        return None, "the JUnit report does not parse: " + str(e)


def verdict(code, pretty, xmltext, test):
    """(0 CAUGHT | 1 SURVIVED | 2 NEVER-RAN, why, caught test names)."""
    if code not in (0, 1):
        return 2, "deadline exceeded" if code == 124 else "exit %d: deno did not finish a test run" % code, []
    if ESCAPE.search(pretty):
        err = next((l for l in pretty.splitlines() if l.startswith("error: ")), "")
        return 2, "an error escaped the tests (module load or top-level code), no assertion was judged: " + err[:120], []
    root, why = parse(xmltext)
    if root is None:
        return 2, why, []
    cases = list(root.iter("testcase"))
    fails = [(c, f) for c in cases for f in c.findall("failure")]
    errors = list(root.iter("error"))
    if (root.tag != "testsuites" or root.get("tests") != str(len(cases))
            or root.get("failures") != str(len(fails)) or root.get("errors") != str(len(errors))):
        return 2, "the JUnit report's totals do not match its test cases", []
    if not cases:
        return 2, "no test ran", []
    if errors:
        return 2, "a test was cancelled or errored outside an assertion", []
    if code == 0:
        if fails:
            return 2, "exit 0 with failed tests", []
        return 1, "", []
    caught = [c.get("name") for c, f in fails if not_test_owned(f, test) is None]
    if not caught:
        whys = sorted({not_test_owned(f, test) for _, f in fails})
        return 2, "tests failed, but none on an assertion made by the test file: " + ("; ".join(whys) or "no test failed")[:160], []
    return 0, "", caught


def observe(kind, marker, pretty, xmltext, policy):
    """None when the run shows the negative control's intended failure, else why not."""
    root, why = parse(xmltext)
    if kind == "escape":
        if not ESCAPE.search(pretty):
            return "no error escaped the tests"
        if not any(l.startswith("error: ") and marker in l for l in pretty.splitlines()):
            return "the escaped error is not the control's"
        if root is None:
            return why
        if any(True for _ in root.iter("testcase")):
            return "test cases ran, so the module did load"
        return None
    if root is None:
        return why
    for f in root.iter("failure"):
        facts = failure_facts(f)
        if facts is None or facts[0] != kind or marker not in facts[1]:
            continue
        own = first_own_frame(facts[2])
        if own is not None and where(own) == os.path.realpath(policy):
            return None
    return "no %s carrying the control's marker was raised from the policy" % kind


# Canned Deno 2.9 JUnit reports with the verdict the judge must give. The test
# file under judgment is always /obcanned/a.test.ts.
T = "/obcanned/a.test.ts"
U = "file://" + T
POL = "file:///obcanned/archive-policy.ts"
EQ = "assertEquals (https://jsr.io/@std/assert/1.0.19/equals.ts:67:9)"
AS = "assert (https://jsr.io/@std/assert/1.0.19/assert.ts:22:11)"
REJ = "assertRejects (https://jsr.io/@std/assert/1.0.19/rejects.ts:118:11)"
DIFF = "Values are not equal.\n\n\n    [Diff] Actual / Expected\n\n\n-   0\n+   5\n"
GENUINE = ("AssertionError", DIFF, [EQ, U + ":3:30"])


def esc(s, attr=False):
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return s.replace('"', "&quot;") if attr else s


def failure(kind, msg, frames, snippet="  throw new AssertionError(message);\n        ^"):
    full = kind + ": " + msg
    body = full + "\n" + snippet + "\n" + "\n".join("    at " + fr for fr in frames)
    return '<failure message="%s">%s</failure>' % (esc("Uncaught " + full, True), esc(body))


def case(name, *children):
    return '<testcase name="%s" classname="./a.test.ts" time="0.001" line="3" col="6">%s</testcase>' % (esc(name, True), "".join(children))


def report(*cases, tests=None, failures=None, errors=None):
    body = "".join(cases)
    n = body.count("<testcase ")
    nf = body.count("<failure ")
    ne = body.count("<error ")
    t, f, e = (n if tests is None else tests), (nf if failures is None else failures), (ne if errors is None else errors)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="deno test" tests="%d" failures="%d" errors="%d" time="0.01">'
            '<testsuite name="./a.test.ts" tests="%d" disabled="0" errors="%d" failures="%d">%s</testsuite></testsuites>'
            % (t, f, e, t, e, f, body)) if n or tests else (
            '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="deno test" tests="0" failures="0" errors="0" time="0.000">\n</testsuites>')


RUN = "running 2 tests from ./a.test.ts\n"
LOAD_CRASH = ("Uncaught error from ./a.test.ts FAILED\n\n ERRORS \n\n./a.test.ts (uncaught error)\n"
              "error: (in promise) Error: synthetic module startup failure\n"
              "This error was not caught from a test and caused the test runner to fail on the referenced module.\n\n"
              "FAILED | 0 passed | 1 failed (0ms)\n\nerror: Test failed")
FAKE = "\n    at " + U + ":1:1"
OK = case("one ok")
BAD = case("two bad", failure(*GENUINE))

CASES = [
    # 1 a genuine assertion in the test file
    (0, 1, RUN, report(OK, BAD)),
    # 2 the module throws at load (Codex review of PR 39): no test case, escaped error
    (2, 1, LOAD_CRASH, report()),
    # 3 a TypeError at the test file's own frame: a crash, not an assertion
    (2, 1, RUN, report(OK, case("three crash", failure("TypeError", "Cannot read properties of null (reading 'x')", [U + ":4:6"], "")))),
    # 4 one crash and one genuine assertion: caught by the assertion
    (0, 1, RUN, report(case("three crash", failure("TypeError", "boom", [U + ":4:6"], "")), BAD)),
    # 5 a genuine assertion, then an error escaped the tests
    (2, 1, RUN + "two bad ... FAILED\n\n./a.test.ts (uncaught error)\nerror: (in promise) Error: late\n", report(OK, BAD)),
    # 6 every test passed
    (1, 0, RUN, report(OK, case("two ok"))),
    # 7 exit 0 with no test case
    (2, 0, "ok | 0 passed | 0 failed (0ms)", report()),
    # 8 exit 0 and no report
    (2, 0, "ok | 2 passed | 0 failed (0ms)", None),
    # 9 a type-check failure: exit 1, no report
    (2, 1, "Check a.test.ts\nTS2322 [ERROR]: Type 'string' is not assignable to type 'number'.\nerror: Type checking failed.", None),
    # 10 a truncated report
    (2, 1, RUN, report(OK, BAD)[:-40]),
    # 11 totals that do not match the test cases
    (2, 1, RUN, report(OK, BAD, tests=3)),
    # 12 a failure counted but never reported, beside a genuine one
    (2, 1, RUN, report(OK, BAD, failures=2)),
    # 13 a deadline, though the report reads as a genuine failure
    (2, 124, RUN, report(OK, BAD)),
    # 14 another exit code, though the report reads as a genuine failure
    (2, 3, RUN, report(OK, BAD)),
    # 15 a genuine assertion beside a cancelled test, and no escape text
    (2, 1, RUN, report(BAD, case("after", '<error message="Cancelled"/>'))),
    # 16 exit 0 with a failure in the report
    (2, 0, RUN, report(OK, BAD)),
    # 17 exit 1 with nothing failed
    (2, 1, RUN, report(OK, case("two ok"))),
    # 18 Codex re-review 1 of PR 39, fault 1: the policy calls the @std/assert primitive itself
    (2, 1, RUN, report(OK, case("policy", failure("AssertionError", "review probe: policy invariant failed before returning",
                                                [AS, "archiveDueAt (" + POL + ":41:31)", U + ":46:10"],
                                                "    throw new AssertionError(msg);\n          ^")))),
    # 19 Codex re-review 1 of PR 39, fault 2: a RangeError whose message reads like an assertion report
    (2, 1, RUN, report(OK, case("policy", failure("RangeError", "review probe: malformed diagnostic\ninput => synthetic:7:9\nerror: AssertionError: diagnostic text",
                                                ["archiveDueAt (" + POL + ":41:37)", U + ":46:10"], "")))),
    # 20 fault 1 again, with a test-file frame forged inside the assertion's message
    (2, 1, RUN, report(OK, case("policy", failure("AssertionError", "policy invariant" + FAKE,
                                                [AS, "archiveDueAt (" + POL + ":41:31)", U + ":46:10"],
                                                "    throw new AssertionError(msg);\n          ^")))),
    # 21 a genuine assertion made through a helper in the test file
    (0, 1, RUN, report(OK, case("via helper", failure("AssertionError", DIFF, [EQ, "helper (" + U + ":4:30)", U + ":5:33"])))),
    # 22 a genuine async assertion (assertRejects)
    (0, 1, RUN, report(OK, case("rejects", failure("AssertionError", "Expected function to reject.", [REJ, "async " + U + ":3:36"],
                                                 "    throw new AssertionError(\n          ^")))),
    # 23 a genuine assertion in a test step; the parent carries "1 test step failed"
    (0, 1, RUN, report(case("group", '<failure message="1 test step failed">1 test step failed.</failure>'),
                       case("group > inner", failure("AssertionError", DIFF, [EQ, U + ":6:65", "innerWrapped (ext:cli/40_test.js:300:11)", U + ":6:43"])))),
    # 24 an assertion whose first own frame is a DIFFERENT test file
    (2, 1, RUN, report(OK, case("elsewhere", failure("AssertionError", DIFF, [EQ, "file:///obcanned/other.test.ts:9:3", U + ":5:33"])))),
    # 25 an AssertionError with no caller frame
    (2, 1, RUN, report(OK, case("no caller", failure("AssertionError", DIFF, [EQ])))),
    # 26 a report body that does not start with the recorded message
    (2, 1, RUN, report(OK, case("mismatch", BAD[BAD.index("<failure"):].replace('message="Uncaught AssertionError: Values', 'message="Uncaught AssertionError: Other', 1).replace("</testcase>", "")))),
    # 27 a report whose root is not <testsuites>
    (2, 1, RUN, report(OK, BAD).replace('<testsuites name="deno test" tests="2" failures="1" errors="0" time="0.01">', "").replace("</testsuites>", "")),
    # 28 an error counted but never reported
    (2, 1, RUN, report(OK, BAD, errors=1)),
]
WANT_CASES = 28


def selftest():
    bad = 0
    for n, (want, code, pretty, xmltext) in enumerate(CASES, 1):
        try:
            got, why, _ = verdict(code, pretty, xmltext, T)
        except Exception as e:  # a judge that raises has not judged the case
            got, why = "raised", type(e).__name__ + ": " + str(e)
        if got != want:
            bad += 1
            print("FAIL judge case %d (exit %d): got %s, expected %d: %s" % (n, code, got, want, why))
    if len(CASES) != WANT_CASES:
        print("TS JUDGE SELFTEST FAILED: ran %d cases, expected %d (a case was lost)" % (len(CASES), WANT_CASES))
        return 1
    if bad:
        print("TS JUDGE SELFTEST FAILED (%d of %d)" % (bad, len(CASES)))
        return 1
    print("TS JUDGE SELFTEST PASSED (%d cases)" % len(CASES))
    return 0


def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return None


mode = sys.argv[1]
if mode == "selftest":
    sys.exit(selftest())
elif mode == "verdict":
    v, why, names = verdict(int(sys.argv[2]), read(sys.argv[3]) or "", read(sys.argv[4]), sys.argv[5])
    print("VERDICT %d\n%s\n%s" % (v, why.replace("\n", " "), " | ".join(names).replace("\n", " ")))
elif mode == "observe":
    r = observe(sys.argv[2], sys.argv[3], read(sys.argv[4]) or "", read(sys.argv[5]), sys.argv[6])
    print("OBSERVED\n" if r is None else "NOT-OBSERVED\n" + r.replace("\n", " "))
PY

# deno_verdict <exit> <pretty output> <junit report> <test file>: 0 CAUGHT,
# 1 SURVIVED, 2 NEVER-RAN; sets WHY (the last two) and NAMES (the caught tests).
# Only an exact "VERDICT n" first line counts; a judge that crashes is NEVER-RAN.
deno_verdict() {
  local r
  r=$(python3 -c "$JUDGE_PY" verdict "$1" "$2" "$3" "$4" 2>&1)
  WHY=$(printf '%s\n' "$r" | sed -n 2p); NAMES=$(printf '%s\n' "$r" | sed -n 3p)
  case "$(printf '%s\n' "$r" | sed -n 1p)" in
    "VERDICT 0") return 0;;
    "VERDICT 1") return 1;;
    "VERDICT 2") return 2;;
  esac
  WHY="the judge returned no verdict: $(printf '%s\n' "$r" | tail -1 | cut -c1-120)"; NAMES=""; return 2
}

judge_selftest() {
  local out code
  out=$(python3 -c "$JUDGE_PY" selftest 2>&1); code=$?
  printf '%s\n' "$out"
  [ "$code" = 0 ] && printf '%s\n' "$out" | grep -qE '^TS JUDGE SELFTEST PASSED \([1-9][0-9]* cases\)$'
}

if [ "${1:-}" = "--judge-selftest" ]; then
  judge_selftest; exit $?
fi

# run_one <name> [<kind> <marker>]: apply one mutant (or control) to a throwaway
# tree and judge it. Sets RES (0 CAUGHT, 1 SURVIVED, 2 NEVER-RAN), MSG, and
# APPLIED (1 only when the mutant applied at exactly one site). With a kind and
# marker (a control), also sets OBS=1 only when the run's report shows that
# intended failure, and OBSMSG with the reason when it does not.
run_one() {
  local m="$1" T out code flag word r
  APPLIED=0; OBS=0; OBSMSG="no deno run was observed"
  T="$(mktemp -d /tmp/obap-ts.XXXXXX)"
  mkdir -p "$T/supabase"
  cp -R "$ROOT/supabase/functions" "$T/supabase/"
  mkdir -p "$T/scripts/loop-closing"
  cp "$ROOT/$DIFF" "$ROOT/scripts/loop-closing/archive-proposals-diff.test.ts" "$ROOT/$SHELL" "$T/scripts/loop-closing/"
  cp "$ROOT/deno.json" "$T/"
  JUDGE=""
  if ! mutate "$T" "$m"; then
    RES=2; MSG="the mutant did not apply to exactly one site"; rm -rf "$T"; return
  fi
  APPLIED=1
  case "$JUDGE" in
    policy) TEST="$T/supabase/functions/_shared/archive-policy.test.ts";;
    digest) TEST="$T/supabase/functions/brain-digest/archive-proposals.test.ts";;
    diff) TEST="$T/scripts/loop-closing/archive-proposals-diff.test.ts";;
  esac
  if [ "$JUDGE" = shell ] || [ "$JUDGE" = load ]; then
    # CAUGHT only when the canned cases ran and one was misjudged: the verdict
    # classifier's (shell) or the snapshot loader's (load). The "SELFTEST FAILED
    # (n" line is printed only after the whole case loop has run, so a script
    # that dies first never prints it. Every misjudged case is listed, so a
    # reader can see the mutant reached the case aimed at it.
    if [ "$JUDGE" = shell ]; then flag=--verdict-selftest; word=VERDICT; else flag=--load-selftest; word=LOAD; fi
    out=$(cd "$T" && python3 "$DEADLINE" 60 bash "$T/$SHELL" "$flag" 2>&1); code=$?
    if [ "$code" = 1 ] && printf '%s\n' "$out" | grep -qE "^$word SELFTEST FAILED \\([1-9]"; then
      RES=0; MSG="$(printf '%s\n' "$out" | grep -E '^FAIL (verdict|load) (judge )?case' | sed -E 's/^FAIL (verdict|load) (judge )?case ([0-9]+).*/\2\3/' | paste -sd, - | sed 's/^/cases /') | $(printf '%s\n' "$out" | grep -m1 -E '^FAIL (verdict|load)' | cut -c1-110)"
    elif [ "$code" = 0 ] && printf '%s\n' "$out" | grep -q "^$word SELFTEST PASSED"; then
      RES=1; MSG=""
    else
      RES=2; MSG="(exit $code): $(printf '%s\n' "$out" | tail -1 | cut -c1-120)"
    fi
    rm -rf "$T"; return
  fi
  out=$(cd "$T" && NO_COLOR=1 python3 "$DEADLINE" 120 deno test --no-lock --allow-read --allow-write --allow-run --junit-path="$T/junit.xml" "$TEST" 2>&1); code=$?
  printf '%s\n' "$out" | sed 's/\x1b\[[0-9;]*m//g' > "$T/deno.out"
  [ -n "${OBAP_KEEP_RUN:-}" ] && { mkdir -p "$OBAP_KEEP_RUN"; cp "$T/deno.out" "$OBAP_KEEP_RUN/$m.deno.out"; cp "$T/junit.xml" "$OBAP_KEEP_RUN/$m.junit.xml" 2>/dev/null; }
  deno_verdict "$code" "$T/deno.out" "$T/junit.xml" "$TEST"; RES=$?
  case "$RES" in
    # Every test failed on a test-owned assertion, so a reader can see the mutant
    # reached the test aimed at it.
    0) MSG="$(printf '%s' "$NAMES" | cut -c1-400)";;
    1) MSG="";;
    *) MSG="(exit $code): $WHY";;
  esac
  if [ -n "${2:-}" ]; then
    r=$(python3 -c "$JUDGE_PY" observe "$2" "$3" "$T/deno.out" "$T/junit.xml" "$T/$POLICY" 2>&1)
    if [ "$(printf '%s\n' "$r" | sed -n 1p)" = OBSERVED ]; then OBS=1; OBSMSG=""; else OBSMSG="$(printf '%s\n' "$r" | sed -n 2p | cut -c1-160)"; fi
  fi
  rm -rf "$T"
}

jst=$(judge_selftest) || { printf '%s\n' "$jst" | grep -m3 '^FAIL\|SELFTEST'; echo "NEVER-RAN: the deno judge failed its own canned cases, so no TS verdict can be trusted"; exit 2; }
echo "$jst"
cok=0; cbad=0
for m in $CONTROLS; do
  control_expect "$m"
  if [ -z "$KIND" ]; then
    echo "CONTROL FAILED $m: no expected failure is defined for it"; cbad=$((cbad + 1)); continue
  fi
  run_one "$m" "$KIND" "$MARK"
  if [ "$APPLIED" != 1 ]; then
    echo "CONTROL FAILED $m: it did not apply to exactly one site, so it never ran"; cbad=$((cbad + 1))
  elif [ "$OBS" != 1 ]; then
    echo "CONTROL FAILED $m: its intended failure ($KIND) was not observed in the run: $OBSMSG $MSG"; cbad=$((cbad + 1))
  elif [ "$RES" != 2 ]; then
    echo "CONTROL FAILED $m: judged $([ "$RES" = 0 ] && echo CAUGHT || echo SURVIVED), expected NEVER-RAN $MSG"; cbad=$((cbad + 1))
  else
    echo "CONTROL OK $m: applied, $KIND observed, NEVER-RAN as expected $MSG"; cok=$((cok + 1))
  fi
done
echo "TS CONTROLS: $((cok + cbad)) run, $cok held (applied, failure observed, NEVER-RAN), $cbad failed"
if [ "$cbad" -gt 0 ]; then echo "NEVER-RAN: a negative control did not hold, so no TS verdict can be trusted; no mutant was run"; exit 2; fi

caught=0; survived=0; never=0
for m in ${*:-$ALL}; do
  run_one "$m"
  case "$RES" in
    0) echo "CAUGHT    $m: $MSG"; caught=$((caught + 1));;
    1) echo "SURVIVED  $m"; survived=$((survived + 1));;
    *) echo "NEVER-RAN $m $MSG"; never=$((never + 1));;
  esac
done
n=$((caught + survived + never))
echo "TS SWEEP: $n mutations, $caught caught, $survived survived, $never never ran"
[ "$never" -gt 0 ] && exit 2
[ "$survived" -gt 0 ] && exit 1
echo "ALL $n TS MUTATIONS CAUGHT"
exit 0
