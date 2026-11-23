// Loop-closing Task 1.4: generate the SQL contract test for auto_resolve_decisions.
//
// Prints a psql script (run with -v ON_ERROR_STOP=1 by decisions-sql-test.sh)
// that, on a NON-production database where the migration has been applied:
//   1. inserts every producer fixture, inserts each reviewed-state fixture as
//      proposed and applies the test-only review update, and asserts the
//      landed count equals the fixture count with every row at its mapped
//      outcome;
//   2. inserts each of the eleven intact-table negatives and asserts WHICH
//      constraint refused it by name, then evaluates the three intact-table
//      predicates independently and asserts only the one under test is false;
//   3. copies the three membership CHECKs onto pg_temp.membership_probe with
//      their names, inserts the three membership negatives there, asserts the
//      refusing name, and evaluates the three copied expressions with only the
//      targeted one false;
//   4. reads the three membership CHECKs back from pg_constraint and asserts
//      their value lists equal the TypeScript constants.
//
//   deno run --allow-read scripts/loop-closing/decisions-sql-test.ts > test.sql

import {
  DECISION_LAYERS,
  DECISION_OUTCOMES,
  DECISION_REASONS,
} from "../../supabase/functions/_shared/decisions.ts";
import type { DecisionFixture } from "../../supabase/functions/_shared/decisions-fixtures.ts";

const fixtures: DecisionFixture[] = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../../supabase/functions/_shared/decisions.fixtures.json",
      import.meta.url,
    ),
  ),
);

const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
};
const sqlArray = (vals: readonly string[]) =>
  "array[" + vals.map(lit).join(", ") + "]::text[]";

const COLS = [
  "layer",
  "outcome",
  "reason",
  "candidate_description",
  "item_id",
  "thought_id",
  "evidence_thought_id",
  "evidence_event_id",
  "related_item_id",
  "quote",
  "score",
] as const;

type Payload = Record<string, unknown>;

function insertSql(p: Payload, extra: Record<string, unknown> = {}): string {
  const cols = [...COLS, ...Object.keys(extra)];
  const vals = [...COLS.map((c) => lit(p[c])), ...Object.values(extra).map(lit)];
  return `insert into public.auto_resolve_decisions (${cols.join(", ")}) values (${
    vals.join(", ")
  })`;
}

// FK stubs for every id any fixture or negative references.
const ids = { thoughts: new Set<string>(), items: new Set<string>(), events: new Set<string>() };
function collect(p: Payload) {
  for (const c of ["thought_id", "evidence_thought_id"]) if (p[c]) ids.thoughts.add(String(p[c]));
  for (const c of ["item_id", "related_item_id"]) if (p[c]) ids.items.add(String(p[c]));
  if (p.evidence_event_id) ids.events.add(String(p.evidence_event_id));
}
fixtures.forEach((f) => collect(f.payload));
const EXTRA_ITEM = "11111111-0000-4000-8000-000000000999";
ids.items.add(EXTRA_ITEM);

const find = (pred: (f: DecisionFixture) => boolean) => {
  const f = fixtures.find(pred);
  if (!f) throw new Error("fixture not found");
  return f.payload;
};
const legalArchive = find((f) => f.layer === "archive" && f.outcome === "proposed" && f.reason === "age_standard");
const recheckProposed = find((f) => f.layer === "recheck" && f.outcome === "proposed");
const fragmentProposed = find((f) => f.layer === "fragment" && f.outcome === "proposed");
const l0Mechanical = find((f) => f.layer === "L0" && f.reason === "mechanical_prefix");
const dedupExact = find((f) => f.layer === "dedup" && f.reason === "exact_batch");
const calendarProposed = find((f) => f.layer === "calendar" && f.outcome === "proposed");

const REVIEW_NOW = { reviewed_at: "2026-11-05T00:00:00Z", reviewed_by: "sql-test", review_seq: 1 };

// Intact-table negatives: [label, payload, extra columns, expected constraint, which predicate must be false]
type Negative = [string, Payload, Record<string, unknown>, string, "legal" | "payload" | "review_seq"];
const intactNegatives: Negative[] = [
  ["recheck/dropped/null", { ...recheckProposed, outcome: "dropped", reason: null }, {}, "auto_resolve_decision_legal", "legal"],
  ["fragment/resolved/null", { ...fragmentProposed, outcome: "resolved", reason: null }, {}, "auto_resolve_decision_legal", "legal"],
  ["L0/blocked/work_report", { ...l0Mechanical, reason: "work_report" }, {}, "auto_resolve_decision_legal", "legal"],
  ["archive/proposed/none_found", { ...legalArchive, reason: "none_found" }, {}, "auto_resolve_decision_legal", "legal"],
  // Carries review fields so only the combination CHECK fires (automatic drops are never reviewed).
  ["dedup/accepted/exact_batch", { ...dedupExact, outcome: "accepted" }, REVIEW_NOW, "auto_resolve_decision_legal", "legal"],
  ["recheck/proposed without evidence_thought_id", { ...recheckProposed, evidence_thought_id: null }, {}, "auto_resolve_decision_payload_ok", "payload"],
  ["dedup/dropped/exact_batch without related_item_id", { ...dedupExact, related_item_id: null }, {}, "auto_resolve_decision_payload_ok", "payload"],
  ["calendar/proposed without evidence_event_id", { ...calendarProposed, evidence_event_id: null }, {}, "auto_resolve_decision_payload_ok", "payload"],
  ["L0/blocked/mechanical_prefix with a real item_id", { ...l0Mechanical, item_id: EXTRA_ITEM }, {}, "auto_resolve_decision_payload_ok", "payload"],
  ["archive/kept with a review timestamp and actor but review_seq null", { ...legalArchive, outcome: "kept" }, { reviewed_at: REVIEW_NOW.reviewed_at, reviewed_by: REVIEW_NOW.reviewed_by }, "auto_resolve_decision_review_seq", "review_seq"],
  ["archive/proposed with review_seq = 1", { ...legalArchive }, { review_seq: 1 }, "auto_resolve_decision_review_seq", "review_seq"],
];

// Membership negatives, probe table only: start from the legal archive triple, change one value.
const membershipNegatives: Array<[string, Payload, string]> = [
  ["layer L9", { ...legalArchive, layer: "L9" }, "auto_resolve_decision_layer"],
  ["outcome open", { ...legalArchive, outcome: "open" }, "auto_resolve_decision_outcome"],
  ["reason bogus", { ...legalArchive, reason: "bogus" }, "auto_resolve_decision_reason"],
];

const out: string[] = [];
const say = (s: string) => out.push(s);

say(`\\set ON_ERROR_STOP on`);
say(`begin;`);
say(`-- FK stubs`);
for (const id of ids.thoughts) say(`insert into public.thoughts (id) values (${lit(id)}) on conflict do nothing;`);
for (const id of ids.items) say(`insert into public.action_items (id, description, status) values (${lit(id)}, 'sql-test item', 'open') on conflict do nothing;`);
for (const id of ids.events) say(`insert into public.business_events (id) values (${lit(id)}) on conflict do nothing;`);
say(`delete from public.auto_resolve_decisions where candidate_description like 'fixture %';`);

say(`-- 1. positive fixtures`);
let n = 0;
for (const f of fixtures) {
  n += 1;
  const reviewed = f.outcome === "kept" || f.outcome === "accepted";
  if (reviewed) {
    // Insert as proposed, then the test-only review update as a separate
    // statement (a data-modifying CTE's row is not visible to an UPDATE in
    // the same statement). One statement, the shape Task 3.6's RPC uses.
    say(insertSql({ ...f.payload, outcome: "proposed" }) + ";");
    say(`update public.auto_resolve_decisions set outcome = ${lit(f.outcome)}, reviewed_at = ${lit(REVIEW_NOW.reviewed_at)}, reviewed_by = ${lit(REVIEW_NOW.reviewed_by)}, review_seq = 1 where candidate_description = ${lit(f.payload.candidate_description)} and outcome = 'proposed';`);
  } else {
    say(insertSql(f.payload) + ";");
  }
}
say(`do $do$ begin`);
say(`  if (select count(*) from public.auto_resolve_decisions where candidate_description like 'fixture %') <> ${fixtures.length} then raise exception 'landed count is not ${fixtures.length}'; end if;`);
for (const f of fixtures) {
  say(`  if not exists (select 1 from public.auto_resolve_decisions where candidate_description = ${lit(f.payload.candidate_description)} and layer = ${lit(f.layer)} and outcome = ${lit(f.outcome)} and reason is not distinct from ${lit(f.reason)}) then raise exception 'fixture not at its mapped outcome: %', ${lit(f.payload.candidate_description)}; end if;`);
}
say(`  raise notice 'POSITIVE: % fixtures landed at their mapped outcomes', ${fixtures.length};`);
say(`end $do$;`);

say(`-- 2. intact-table negatives: refused by the named constraint, and only that predicate is false`);
for (const [label, p, extra, expected, which] of intactNegatives) {
  say(`do $do$ declare c text; v_legal boolean; v_payload boolean; v_seq boolean; begin`);
  say(`  begin`);
  say(`    ${insertSql(p, extra)};`);
  say(`    raise exception 'NEGATIVE LANDED: ${label.replace(/'/g, "''")}';`);
  say(`  exception when check_violation then`);
  say(`    get stacked diagnostics c = constraint_name;`);
  say(`    if c <> ${lit(expected)} then raise exception 'negative % refused by % not %', ${lit(label)}, c, ${lit(expected)}; end if;`);
  say(`  end;`);
  const seq = extra.review_seq ?? null;
  say(`  select public.auto_resolve_decision_legal(${lit(p.layer)}, ${lit(p.outcome)}, ${lit(p.reason)}) into v_legal;`);
  say(`  select public.auto_resolve_decision_payload_ok(${lit(p.layer)}, ${lit(p.outcome)}, ${lit(p.reason)}, ${lit(p.item_id)}::uuid, ${lit(p.thought_id)}::uuid, ${lit(p.evidence_thought_id)}::uuid, ${lit(p.evidence_event_id)}::uuid, ${lit(p.related_item_id)}::uuid, ${lit(p.quote)}, ${lit(p.score)}::numeric) into v_payload;`);
  say(`  select ((${lit(p.outcome)} in ('kept','accepted')) = (${lit(seq)}::integer is not null)) into v_seq;`);
  const expect = { legal: which === "legal" ? "false" : "true", payload: which === "payload" ? "false" : "true", review_seq: which === "review_seq" ? "false" : "true" };
  say(`  if v_legal is distinct from ${expect.legal} or v_payload is distinct from ${expect.payload} or v_seq is distinct from ${expect.review_seq} then raise exception 'predicates for % are (%, %, %), expected (${expect.legal}, ${expect.payload}, ${expect.review_seq})', ${lit(label)}, v_legal, v_payload, v_seq; end if;`);
  say(`  raise notice 'NEGATIVE OK: % refused by %', ${lit(label)}, c;`);
  say(`end $do$;`);
}

say(`-- 3. membership negatives on a disposable probe carrying only the three membership CHECKs`);
say(`create temp table membership_probe (layer text, outcome text, reason text);`);
say(`do $do$ declare r record; begin`);
say(`  for r in select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.auto_resolve_decisions'::regclass and conname in ('auto_resolve_decision_layer','auto_resolve_decision_outcome','auto_resolve_decision_reason') loop`);
say(`    execute format('alter table pg_temp.membership_probe add constraint %I %s', r.conname, r.def);`);
say(`  end loop;`);
say(`  if (select count(*) from pg_constraint where conrelid = 'pg_temp.membership_probe'::regclass and contype = 'c') <> 3 then raise exception 'probe does not carry exactly three CHECKs'; end if;`);
say(`end $do$;`);
for (const [label, p, expected] of membershipNegatives) {
  say(`do $do$ declare c text; r record; v boolean; falses int := 0; wrong text := ''; begin`);
  say(`  begin`);
  say(`    insert into pg_temp.membership_probe (layer, outcome, reason) values (${lit(p.layer)}, ${lit(p.outcome)}, ${lit(p.reason)});`);
  say(`    raise exception 'MEMBERSHIP NEGATIVE LANDED: ${label}';`);
  say(`  exception when check_violation then`);
  say(`    get stacked diagnostics c = constraint_name;`);
  say(`    if c <> ${lit(expected)} then raise exception 'membership negative % refused by % not %', ${lit(label)}, c, ${lit(expected)}; end if;`);
  say(`  end;`);
  say(`  for r in select conname, pg_get_expr(conbin, conrelid) as expr from pg_constraint where conrelid = 'pg_temp.membership_probe'::regclass and contype = 'c' loop`);
  say(`    execute format('select %s from (values ($1, $2, $3)) as t(layer, outcome, reason)', r.expr) into v using ${lit(p.layer)}::text, ${lit(p.outcome)}::text, ${lit(p.reason)}::text;`);
  say(`    if not v then falses := falses + 1; wrong := r.conname; end if;`);
  say(`  end loop;`);
  say(`  if falses <> 1 or wrong <> ${lit(expected)} then raise exception 'membership negative %: % expressions false (last %), expected only %', ${lit(label)}, falses, wrong, ${lit(expected)}; end if;`);
  say(`  raise notice 'MEMBERSHIP OK: % refused by %', ${lit(label)}, c;`);
  say(`end $do$;`);
}

say(`-- 4. membership value lists equal the TypeScript constants`);
const listCheck = (conname: string, vals: readonly string[]) => {
  say(`do $do$ declare got text[]; begin`);
  say(`  select array(select m[1] from regexp_matches(pg_get_constraintdef(oid), '''([^'']+)''::text', 'g') m order by 1) into got from pg_constraint where conrelid = 'public.auto_resolve_decisions'::regclass and conname = ${lit(conname)};`);
  say(`  if got is distinct from (select array(select unnest(${sqlArray(vals)}) order by 1)) then raise exception '% value list % differs from TypeScript %', ${lit(conname)}, got, ${sqlArray(vals)}; end if;`);
  say(`  raise notice 'MEMBERSHIP LIST OK: % (% values)', ${lit(conname)}, array_length(got, 1);`);
  say(`end $do$;`);
};
listCheck("auto_resolve_decision_layer", DECISION_LAYERS);
listCheck("auto_resolve_decision_outcome", DECISION_OUTCOMES);
listCheck("auto_resolve_decision_reason", DECISION_REASONS);

say(`rollback;`);
say(`\\echo DECISIONS SQL TEST PASSED`);
console.log(out.join("\n"));
