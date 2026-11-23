#!/bin/bash
# Loop-closing Task 3.3: negative controls for the TypeScript side. Each mutant is
# applied to a THROWAWAY COPY of the tree (never this checkout) and judged by
#   supabase/functions/brain-digest/action-checklist.test.ts   (the digest checklist) or
#   supabase/functions/open-brain-mcp/_action_items_test.ts    (the review helpers).
# The SQL side and the MCP tool wiring are judged separately by
# action-item-review-sql-test.sh (its --all-mutations and its integration step).
#
#   bash scripts/loop-closing/action-item-review-ts-mutants.sh            # every mutant
#   bash scripts/loop-closing/action-item-review-ts-mutants.sh <name>...  # some
#
# CAUGHT only when deno test ran and reported a failed test. A judge that timed
# out or could not load is NEVER-RAN. Exit 0 only when every mutant was CAUGHT;
# 1 if any survived; 2 if any never ran.
export LC_ALL=C
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEADLINE="$ROOT/scripts/loop-closing/deadline.py"
CHECKLIST=supabase/functions/brain-digest/action-checklist.ts
HELPERS=supabase/functions/open-brain-mcp/_action_items.ts
ALL="reserve_cap_off reserve_newest_first reserve_off reserve_no_id_tiebreak proposals_first_restored general_by_created general_no_id_tiebreak row_listed_twice cap_off dated_any_iso client_ignored tag_on_keep tag_duplicate_null evidence_uncapped evidence_multiline tag_dropped_in_render failed_read_as_empty legacy_note_off clients_failed_silent clients_partial_silent truncated_read_silent param_name_wrong blank_as_absent error_message_lost unknown_status_trusted deferred_combo_allowed newest_combo_allowed total_left_on_items later_empty_page_zero list_error_swallowed total_unchecked offset_dropped limit_dropped"

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
    # ----- the digest checklist -----
    reserve_cap_off) JUDGE=checklist; apply "$1" "$CHECKLIST" '    .slice(0, Math.min(reservedSlots, cap));' '    .slice(0, cap);';;
    reserve_newest_first) JUDGE=checklist; apply "$1" "$CHECKLIST" '    .sort((a, b) => time(a.created_at) - time(b.created_at) || byId(a, b))' '    .sort((a, b) => time(b.created_at) - time(a.created_at) || byId(a, b))';;
    reserve_off) JUDGE=checklist; apply "$1" "$CHECKLIST" '    .filter((r) => isReservedItem(r, clientNames))' '    .filter(() => false)';;
    reserve_no_id_tiebreak) JUDGE=checklist; apply "$1" "$CHECKLIST" '    .sort((a, b) => time(a.created_at) - time(b.created_at) || byId(a, b))' '    .sort((a, b) => time(a.created_at) - time(b.created_at))';;
    # The withdrawn reading: pending proposals ahead of everything in the general slots.
    proposals_first_restored) JUDGE=checklist; apply "$1" "$CHECKLIST" '    .sort((a, b) => {
      const ta = time(a.last_reviewed_at ?? a.created_at);' '    .sort((a, b) => {
      const pa = isPendingProposal(a) ? 0 : 1;
      const pb = isPendingProposal(b) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const ta = time(a.last_reviewed_at ?? a.created_at);';;
    general_by_created) JUDGE=checklist; apply "$1" "$CHECKLIST" '      const ta = time(a.last_reviewed_at ?? a.created_at);
      const tb = time(b.last_reviewed_at ?? b.created_at);' '      const ta = time(a.created_at);
      const tb = time(b.created_at);';;
    general_no_id_tiebreak) JUDGE=checklist; apply "$1" "$CHECKLIST" '      return ta - tb || byId(a, b);' '      return ta - tb;';;
    row_listed_twice) JUDGE=checklist; apply "$1" "$CHECKLIST" '    .filter((r) => !taken.has(r.id))' '    .filter(() => true)';;
    cap_off) JUDGE=checklist; apply "$1" "$CHECKLIST" '    .slice(0, Math.max(0, cap - reserved.length));' '    .slice(0, cap);';;
    # "Dated" widened from a deadline to any ISO date.
    dated_any_iso) JUDGE=checklist; apply "$1" "$CHECKLIST" '  return deadlineFrom(row.description) !== null ||' '  return /[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(row.description) ||';;
    client_ignored) JUDGE=checklist; apply "$1" "$CHECKLIST" '    isClientShaped(row.description, clientNames);' '    false;';;
    tag_on_keep) JUDGE=checklist; apply "$1" "$CHECKLIST" '  return row.review_outcome === "proposal" && !!row.triage_disposition;' '  return !!row.triage_disposition;';;
    tag_duplicate_null) JUDGE=checklist; apply "$1" "$CHECKLIST" '    return row.triage_replacement_id
      ?' '    return true
      ?';;
    evidence_uncapped) JUDGE=checklist; apply "$1" "$CHECKLIST" 'const EVIDENCE_MAX = 80;' 'const EVIDENCE_MAX = 8000;';;
    evidence_multiline) JUDGE=checklist; apply "$1" "$CHECKLIST" '  const flat = String(s ?? "").replace(/\s+/g, " ").trim();' '  const flat = String(s ?? "").trim();';;
    tag_dropped_in_render) JUDGE=checklist; apply "$1" "$CHECKLIST" '(${row.id})${tag ? ` [${tag}]` : ""}`;' '(${row.id})`;';;
    # A failed read rendered as an empty section.
    failed_read_as_empty) JUDGE=checklist; apply "$1" "$CHECKLIST" '      return "Open action items unavailable: action_items could not be read.";' '      return "";';;
    legacy_note_off) JUDGE=checklist; apply "$1" "$CHECKLIST" '    const body = renderOpenActionChecklist(input.legacyRows, total, [
      "Triage tags unavailable: the review columns could not be read. Newest first, no reserved slots.",
    ]);' '    const body = renderOpenActionChecklist(input.legacyRows, total, []);';;
    clients_failed_silent) JUDGE=checklist; apply "$1" "$CHECKLIST" '  if (input.clientNames === null) {' '  if (false) {';;
    clients_partial_silent) JUDGE=checklist; apply "$1" "$CHECKLIST" '  } else if (input.clientNamesPartial) {' '  } else if (false) {';;
    truncated_read_silent) JUDGE=checklist; apply "$1" "$CHECKLIST" '  if (total > input.rows.length) {' '  if (false) {';;
    # ----- the review helpers -----
    param_name_wrong) JUDGE=helpers; apply "$1" "$HELPERS" '    p_evidence: args.evidence ?? null,' '    p_note: args.evidence ?? null,';;
    blank_as_absent) JUDGE=helpers; apply "$1" "$HELPERS" '    p_evidence: args.evidence ?? null,' '    p_evidence: args.evidence || null,';;
    error_message_lost) JUDGE=helpers; apply "$1" "$HELPERS" '  if (error) return { status: "error", message: error.message };' '';;
    unknown_status_trusted) JUDGE=helpers; apply "$1" "$HELPERS" '    typeof status !== "string" || !REVIEW_REPLY_STATUSES.has(status) ||' '    typeof status !== "string" ||';;
    deferred_combo_allowed) JUDGE=helpers; apply "$1" "$HELPERS" '  if (args.include_deferred) {' '  if (false) {';;
    newest_combo_allowed) JUDGE=helpers; apply "$1" "$HELPERS" '  if (args.order === "newest") {' '  if (false) {';;
    total_left_on_items) JUDGE=helpers; apply "$1" "$HELPERS" '    const { unreviewed_total, ...item } = r;' '    const { unreviewed_total } = r; const item = r;';;
    later_empty_page_zero) JUDGE=helpers; apply "$1" "$HELPERS" '  let total: number | null = window.from === 0 ? 0 : null;' '  let total: number | null = 0;';;
    list_error_swallowed) JUDGE=helpers; apply "$1" "$HELPERS" '  if (error) throw new Error(error.message);' '';;
    total_unchecked) JUDGE=helpers; apply "$1" "$HELPERS" '    if (!Number.isInteger(n) || n < rows.length) {' '    if (false) {';;
    offset_dropped) JUDGE=helpers; apply "$1" "$HELPERS" '    p_offset: window.from,' '    p_offset: 0,';;
    limit_dropped) JUDGE=helpers; apply "$1" "$HELPERS" '    p_limit: limit,' '    p_limit: 50,';;
    *) return 2;;
  esac
}

caught=0; survived=0; never=0
for m in ${*:-$ALL}; do
  T="$(mktemp -d /tmp/obar-ts.XXXXXX)"
  mkdir -p "$T/supabase"
  cp -R "$ROOT/supabase/functions" "$T/supabase/"
  cp "$ROOT/deno.json" "$T/"
  JUDGE=""
  if ! mutate "$T" "$m"; then
    echo "NEVER-RAN $m: the mutant did not apply to exactly one site"; never=$((never + 1)); rm -rf "$T"; continue
  fi
  case "$JUDGE" in
    checklist) TEST="$T/supabase/functions/brain-digest/action-checklist.test.ts";;
    helpers) TEST="$T/supabase/functions/open-brain-mcp/_action_items_test.ts";;
  esac
  # --no-check: a mutant is judged by what the tests observe, not by the type
  # checker (several mutants are deliberately ill-typed, e.g. `if (false)`).
  out=$(cd "$T" && python3 "$DEADLINE" 120 deno test --no-lock --no-check --allow-read "$TEST" 2>&1); code=$?
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
