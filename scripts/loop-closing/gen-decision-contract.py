#!/usr/bin/env python3
"""Loop-closing Task 1.4: ONE source for the auto_resolve_decisions writer mapping.

Emits two files from the MAPPING below so SQL and TypeScript cannot drift:
  supabase/migrations/20261105_auto_resolve_decisions.sql   (the two immutable CHECK functions)
  supabase/functions/_shared/decisions.ts                   (DECISION_MAPPING and the vocab constants)

Run from the repo root:  python3 scripts/loop-closing/gen-decision-contract.py
Both outputs are checked in. Re-run after any mapping change and commit all three.
The plan's writer mapping (Task 1.4) is the authority; this file transcribes it.
"""
import json, pathlib, sys

LAYERS = ["L0", "L1.5", "L2", "L3", "L3.5", "resolved", "gate", "fragment", "dedup", "recheck", "calendar", "archive"]
OUTCOMES = ["blocked", "dropped", "vetoed", "resolved", "proposed", "kept", "accepted", "no_evidence"]
REASONS = [
    "mechanical_prefix", "operation_command", "restatement", "not_claimed", "llm_failed", "parse_failed",
    "no_quote", "coverage_below_threshold", "still_owed", "work_report", "age_work_report", "age_standard",
    "deadline_passed", "none_found", "thought_not_in_page", "quote_not_verbatim", "veto", "coverage",
    "scope_mismatch", "one_token", "dangling_clause", "pronoun_object", "exact_batch", "semantic_overlap",
    "booking_match",
]
REVIEW = ["proposed", "kept", "accepted"]
ID_COLS = ["item_id", "thought_id", "evidence_thought_id", "evidence_event_id", "related_item_id"]

MAPPING = []
def add(layer, outcomes, reasons, required, quote=False, score=False, null_quote_score=False):
    for o in outcomes:
        for r in reasons:
            req = list(required) + (["quote"] if quote else []) + (["score"] if score else [])
            MAPPING.append({"layer": layer, "outcome": o, "reason": r, "required": req,
                            "null_quote_score": null_quote_score})

# Writer mapping, one row per (layer, outcome, reason). "required" is the plan's "ids set" column.
add("L0", ["blocked"], ["mechanical_prefix", "operation_command"], ["thought_id"])
add("L1.5", ["dropped"], ["restatement"], ["item_id", "thought_id"])
add("L2", ["dropped"], ["not_claimed", "llm_failed", "parse_failed"], ["item_id", "thought_id"])
add("L3", ["dropped"], ["no_quote"], ["item_id", "thought_id"], null_quote_score=True)
add("L3", ["dropped"], ["coverage_below_threshold"], ["item_id", "thought_id"], quote=True, score=True)
add("L3.5", ["vetoed"], ["still_owed"], ["item_id", "thought_id"], quote=True)
add("resolved", ["resolved"], [None], ["item_id", "thought_id"], quote=True)
add("gate", ["dropped"], ["work_report"], ["thought_id"])
add("archive", REVIEW, ["age_work_report", "age_standard", "deadline_passed"], ["item_id"])
add("recheck", REVIEW, [None], ["item_id", "evidence_thought_id"], quote=True, score=True)
add("recheck", ["no_evidence"], ["none_found", "thought_not_in_page"], ["item_id"])
add("recheck", ["no_evidence"], ["quote_not_verbatim", "veto", "coverage", "scope_mismatch"], ["item_id", "evidence_thought_id"])
add("fragment", ["dropped"], ["one_token", "dangling_clause"], ["thought_id"])
add("fragment", REVIEW, ["pronoun_object"], ["item_id", "thought_id"])
add("dedup", ["dropped"], ["exact_batch"], ["thought_id", "related_item_id"])
add("dedup", REVIEW, ["semantic_overlap"], ["item_id", "related_item_id"], score=True)
add("calendar", REVIEW, ["booking_match"], ["item_id", "evidence_event_id"], quote=True)

assert len(MAPPING) == 41, len(MAPPING)
assert len({(m["layer"], m["outcome"], m["reason"]) for m in MAPPING}) == 41
for m in MAPPING:
    assert m["layer"] in LAYERS and m["outcome"] in OUTCOMES and (m["reason"] is None or m["reason"] in REASONS)

def sql_lit(v):
    return "null::text" if v is None else "'" + v.replace("'", "''") + "'"

def sql_bool(b):
    return "true" if b else "false"

legal_rows = ",\n      ".join(f"({sql_lit(m['layer'])}, {sql_lit(m['outcome'])}, {sql_lit(m['reason'])})" for m in MAPPING)
payload_rows = ",\n      ".join(
    "(" + ", ".join([
        sql_lit(m["layer"]), sql_lit(m["outcome"]), sql_lit(m["reason"]),
        *(sql_bool(c in m["required"]) for c in ID_COLS),
        sql_bool("quote" in m["required"]), sql_bool("score" in m["required"]), sql_bool(m["null_quote_score"]),
    ]) + ")" for m in MAPPING)

def sql_list(vals):
    return ", ".join(sql_lit(v) for v in vals)

MIGRATION = f"""-- Loop-closing Task 1.4 (synthesis B2): record every auto-resolve decision.
--
-- One row per decision the capture pipeline makes about an action-item
-- candidate (or about a capture, for the LAYER 0 block), so the 7-day Edge
-- Function log retention stops being the only record. The schema serves every
-- later writer in the plan (Tasks 1.2, 1.3, 3.2, 4.1, 5.1, 5.2, 5.3) and the
-- review handler (3.6); only the capture-time writers and the 1.2 gate write
-- today. Two immutable SQL functions carry the writer mapping: the legal
-- (layer, outcome, reason) triples and the ids each triple must and must not
-- carry. GENERATED by scripts/loop-closing/gen-decision-contract.py together
-- with supabase/functions/_shared/decisions.ts; edit the generator, not this.
--
-- Rollback: drop table public.auto_resolve_decisions;
--           drop function public.auto_resolve_decision_legal(text, text, text);
--           drop function public.auto_resolve_decision_payload_ok(text, text, text, uuid, uuid, uuid, uuid, uuid, text, numeric);

-- The legal triples. Null-safe on reason, and exists() returns false (never
-- SQL null) for a triple outside the mapping, so the CHECK refuses it.
create or replace function public.auto_resolve_decision_legal(
  p_layer text, p_outcome text, p_reason text
) returns boolean
language sql immutable
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from (values
      {legal_rows}
    ) as m(layer, outcome, reason)
    where m.layer = p_layer
      and m.outcome = p_outcome
      and m.reason is not distinct from p_reason
  )
$$;

-- The "ids set" column of the mapping: for a mapped triple, each of the five
-- id columns must be present when listed and absent when not; quote and score
-- must be present when listed, and both null for L3/no_quote (scoring has not
-- run). Returns TRUE for a triple the mapping does not contain, so an illegal
-- triple is refused by the combination CHECK alone and never by both.
create or replace function public.auto_resolve_decision_payload_ok(
  p_layer text, p_outcome text, p_reason text,
  p_item_id uuid, p_thought_id uuid, p_evidence_thought_id uuid,
  p_evidence_event_id uuid, p_related_item_id uuid,
  p_quote text, p_score numeric
) returns boolean
language sql immutable
set search_path = pg_catalog, public
as $$
  select coalesce((
    select (p_item_id is not null) = m.item_id
       and (p_thought_id is not null) = m.thought_id
       and (p_evidence_thought_id is not null) = m.evidence_thought_id
       and (p_evidence_event_id is not null) = m.evidence_event_id
       and (p_related_item_id is not null) = m.related_item_id
       and (not m.quote or p_quote is not null)
       and (not m.score or p_score is not null)
       and (not m.null_quote_score or (p_quote is null and p_score is null))
    from (values
      {payload_rows}
    ) as m(layer, outcome, reason, item_id, thought_id, evidence_thought_id,
           evidence_event_id, related_item_id, quote, score, null_quote_score)
    where m.layer = p_layer
      and m.outcome = p_outcome
      and m.reason is not distinct from p_reason
  ), true)
$$;

revoke execute on function public.auto_resolve_decision_legal(text, text, text) from public, anon, authenticated;
revoke execute on function public.auto_resolve_decision_payload_ok(text, text, text, uuid, uuid, uuid, uuid, uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.auto_resolve_decision_legal(text, text, text) to service_role, postgres;
grant execute on function public.auto_resolve_decision_payload_ok(text, text, text, uuid, uuid, uuid, uuid, uuid, text, numeric) to service_role, postgres;

create table public.auto_resolve_decisions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- The capture or evidence thought. Cascade: probe captures are deleted after
  -- live verification and must take their decision rows with them.
  thought_id uuid null references public.thoughts(id) on delete cascade,
  -- Null for capture-level (L0) and rejected-before-insert (gate, fragment,
  -- exact dedup) rows.
  item_id uuid null references public.action_items(id) on delete cascade,
  -- Always set, so a row is readable after the item is gone or never existed.
  candidate_description text not null,
  layer text not null,
  -- A short code from the writer mapping; null where the mapping says null.
  reason text null,
  score numeric null,
  -- The LLM quote or matched text only, never an id.
  quote text null,
  -- Dedup survivor or supersede replacement.
  related_item_id uuid null references public.action_items(id) on delete cascade,
  -- Re-check evidence (Task 4.1).
  evidence_thought_id uuid null references public.thoughts(id) on delete cascade,
  -- Calendar evidence (Task 5.3): a typed column, not an id inside quote.
  evidence_event_id uuid null references public.business_events(id) on delete cascade,
  outcome text not null,
  -- Review fields are written only by Task 3.6's handler, by updating a
  -- proposed row in place; no producer insert carries them. review_seq is the
  -- item-local review number assigned under the item lock; reviewed_at is
  -- display only.
  reviewed_at timestamptz null,
  reviewed_by text null,
  review_seq integer null,
  constraint auto_resolve_decision_layer check (layer in ({sql_list(LAYERS)})),
  constraint auto_resolve_decision_outcome check (outcome in ({sql_list(OUTCOMES)})),
  constraint auto_resolve_decision_reason check (reason is null or reason in ({sql_list(REASONS)})),
  constraint auto_resolve_decision_legal check (
    public.auto_resolve_decision_legal(layer, outcome, reason)
  ),
  constraint auto_resolve_decision_payload_ok check (
    public.auto_resolve_decision_payload_ok(
      layer, outcome, reason, item_id, thought_id, evidence_thought_id,
      evidence_event_id, related_item_id, quote, score
    )
  ),
  -- A review row always carries its number and no other row does.
  constraint auto_resolve_decision_review_seq check (
    (outcome in ('kept', 'accepted')) = (review_seq is not null)
  )
);

comment on table public.auto_resolve_decisions is
  'Every auto-resolve decision, one row per candidate (or per capture for L0). Writer mapping: scripts/loop-closing/gen-decision-contract.py. Loop-closing Task 1.4.';

create index auto_resolve_decisions_item_created_idx
  on public.auto_resolve_decisions (item_id, created_at desc);
create index auto_resolve_decisions_layer_created_idx
  on public.auto_resolve_decisions (layer, created_at desc);
create index auto_resolve_decisions_item_review_seq_idx
  on public.auto_resolve_decisions (item_id, review_seq desc)
  where review_seq is not null;
-- Lifetime uniques: a replayed re-check or a re-fired booking match cannot
-- duplicate a proposal, and after a restore the same evidence is never
-- proposed again (Tasks 4.1, 5.3; the reopen boundary is Task 3.1's generation).
create unique index auto_resolve_decisions_recheck_evidence_uniq
  on public.auto_resolve_decisions (item_id, evidence_thought_id)
  where layer = 'recheck' and evidence_thought_id is not null;
create unique index auto_resolve_decisions_calendar_evidence_uniq
  on public.auto_resolve_decisions (item_id, evidence_event_id)
  where layer = 'calendar' and evidence_event_id is not null;

alter table public.auto_resolve_decisions enable row level security;
create policy "Service role full access on auto_resolve_decisions"
  on public.auto_resolve_decisions for all
  using (auth.role() = 'service_role'::text);
"""

def ts_str(v):
    return "null" if v is None else json.dumps(v)

ts_rows = ",\n".join(
    "  { layer: %s, outcome: %s, reason: %s, required: [%s], nullQuoteScore: %s }" % (
        ts_str(m["layer"]), ts_str(m["outcome"]), ts_str(m["reason"]),
        ", ".join(json.dumps(r) for r in m["required"]), "true" if m["null_quote_score"] else "false")
    for m in MAPPING)

TS = f"""// supabase/functions/_shared/decisions.ts
//
// Loop-closing Task 1.4: the auto_resolve_decisions writer contract and the
// single-row writer every capture-time producer calls.
//
// GENERATED by scripts/loop-closing/gen-decision-contract.py together with the
// migration that holds the matching SQL CHECK functions. Edit the generator,
// re-run it, and commit all three files; decisions.test.ts and the SQL test in
// scripts/loop-closing/decisions-sql-test.sh prove the two stay equal.
//
// recordDecision writes ONE row per call, never an array, so a TypeScript
// producer holds at most one generation-stamp lock at a time (Task 3.1's lock
// contract). It validates the payload first, destructures {{ error }} on the
// insert, logs and returns on failure, and never throws: a failed decision row
// must never fail the capture.

export const DECISION_LAYERS = [{", ".join(json.dumps(v) for v in LAYERS)}] as const;
export const DECISION_OUTCOMES = [{", ".join(json.dumps(v) for v in OUTCOMES)}] as const;
export const DECISION_REASONS = [
  {", ".join(json.dumps(v) for v in REASONS)},
] as const;

export type DecisionLayer = (typeof DECISION_LAYERS)[number];
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];
export type DecisionReason = (typeof DECISION_REASONS)[number];

// Review outcomes are written only by Task 3.6's handler, by updating a
// proposed row in place. No producer insert carries them.
export const REVIEW_OUTCOMES: readonly DecisionOutcome[] = ["kept", "accepted"];
export const REVIEW_FIELDS = ["review_seq", "reviewed_at", "reviewed_by"] as const;

export const DECISION_ID_COLUMNS = [
  "item_id",
  "thought_id",
  "evidence_thought_id",
  "evidence_event_id",
  "related_item_id",
] as const;
export type DecisionIdColumn = (typeof DECISION_ID_COLUMNS)[number];
export type DecisionPayloadField = DecisionIdColumn | "quote" | "score";

export type DecisionMappingEntry = {{
  layer: DecisionLayer;
  outcome: DecisionOutcome;
  reason: DecisionReason | null;
  // The plan's "ids set" column: ids that must be present (every other id
  // column must be null), plus quote/score when the writer carries them.
  required: readonly DecisionPayloadField[];
  // L3/no_quote: quote and score must both be null (scoring has not run).
  nullQuoteScore: boolean;
}};

// One entry per legal (layer, outcome, reason) triple: {len(MAPPING)} in all.
export const DECISION_MAPPING: readonly DecisionMappingEntry[] = [
{ts_rows},
];

export type DecisionRow = {{
  layer: DecisionLayer;
  outcome: DecisionOutcome;
  reason: DecisionReason | null;
  candidate_description: string;
  item_id?: string | null;
  thought_id?: string | null;
  evidence_thought_id?: string | null;
  evidence_event_id?: string | null;
  related_item_id?: string | null;
  quote?: string | null;
  score?: number | null;
}};

export function findMapping(
  layer: string,
  outcome: string,
  reason: string | null,
): DecisionMappingEntry | undefined {{
  return DECISION_MAPPING.find((m) =>
    m.layer === layer && m.outcome === outcome && m.reason === reason
  );
}}

/** Producer validator. Returns null when the row is a legal producer insert,
 * otherwise a short message naming the first problem. Refuses review outcomes
 * and review fields outright, because those are 3.6's in-place update. */
export function validateDecisionRow(row: unknown): string | null {{
  if (!row || typeof row !== "object") return "row is not an object";
  const r = row as Record<string, unknown>;
  for (const f of REVIEW_FIELDS) {{
    if (f in r && r[f] !== undefined) return `producer rows never carry ${{f}}`;
  }}
  const layer = r.layer, outcome = r.outcome, reason = r.reason ?? null;
  if (typeof layer !== "string" || !(DECISION_LAYERS as readonly string[]).includes(layer)) {{
    return `unknown layer ${{String(layer)}}`;
  }}
  if (typeof outcome !== "string" || !(DECISION_OUTCOMES as readonly string[]).includes(outcome)) {{
    return `unknown outcome ${{String(outcome)}}`;
  }}
  if ((REVIEW_OUTCOMES as readonly string[]).includes(outcome)) {{
    return `outcome ${{outcome}} is a review outcome; producers write proposed`;
  }}
  if (reason !== null && (typeof reason !== "string" || !(DECISION_REASONS as readonly string[]).includes(reason))) {{
    return `unknown reason ${{String(reason)}}`;
  }}
  const m = findMapping(layer, outcome, reason as string | null);
  if (!m) return `illegal triple ${{layer}}/${{outcome}}/${{String(reason)}}`;
  if (typeof r.candidate_description !== "string" || r.candidate_description.trim() === "") {{
    return "candidate_description is required";
  }}
  for (const col of DECISION_ID_COLUMNS) {{
    const present = r[col] !== undefined && r[col] !== null;
    const wanted = m.required.includes(col);
    if (wanted && !present) return `${{col}} is required for ${{layer}}/${{outcome}}/${{String(reason)}}`;
    if (!wanted && present) return `${{col}} is not allowed for ${{layer}}/${{outcome}}/${{String(reason)}}`;
  }}
  const quotePresent = r.quote !== undefined && r.quote !== null;
  const scorePresent = r.score !== undefined && r.score !== null;
  if (m.required.includes("quote") && !quotePresent) return "quote is required";
  if (m.required.includes("score") && !scorePresent) return "score is required";
  if (m.nullQuoteScore && (quotePresent || scorePresent)) {{
    return "quote and score must both be null for L3/no_quote";
  }}
  return null;
}}

/** The exact insert payload: every column named, unlisted ids as null. */
export function toInsertPayload(row: DecisionRow): Record<string, unknown> {{
  return {{
    layer: row.layer,
    outcome: row.outcome,
    reason: row.reason ?? null,
    candidate_description: row.candidate_description,
    item_id: row.item_id ?? null,
    thought_id: row.thought_id ?? null,
    evidence_thought_id: row.evidence_thought_id ?? null,
    evidence_event_id: row.evidence_event_id ?? null,
    related_item_id: row.related_item_id ?? null,
    quote: row.quote ?? null,
    score: row.score ?? null,
  }};
}}

/** The one supabase-js call this module makes, typed structurally. */
// deno-lint-ignore no-explicit-any
export type DecisionDb = {{ from(table: string): any }};

export const DECISION_LOG_TRUNC = 200;

/** ONE row per call. Never throws; a failed decision row never fails the capture. */
export async function recordDecision(
  db: DecisionDb,
  row: DecisionRow,
): Promise<{{ ok: boolean; error?: string }}> {{
  const problem = validateDecisionRow(row);
  if (problem) {{
    console.error(
      `recordDecision: refused ${{row.layer}}/${{row.outcome}}/${{String(row.reason)}}: ${{problem}}`,
    );
    return {{ ok: false, error: problem }};
  }}
  try {{
    const {{ error }} = await db.from("auto_resolve_decisions").insert(
      toInsertPayload(row),
    );
    if (error) {{
      const msg = typeof error === "object" && error && "message" in error
        ? String((error as {{ message: unknown }}).message)
        : String(error);
      console.error(
        `recordDecision: insert failed for ${{row.layer}}/${{row.outcome}}/${{String(row.reason)}} (${{
          row.candidate_description.slice(0, DECISION_LOG_TRUNC)
        }}): ${{msg}}`,
      );
      return {{ ok: false, error: msg }};
    }}
    return {{ ok: true }};
  }} catch (e) {{
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`recordDecision: insert threw: ${{msg}}`);
    return {{ ok: false, error: msg }};
  }}
}}
"""

root = pathlib.Path(__file__).resolve().parents[2]
(root / "supabase/migrations/20261105_auto_resolve_decisions.sql").write_text(MIGRATION)
(root / "supabase/functions/_shared/decisions.ts").write_text(TS)
print(f"wrote migration and decisions.ts ({len(MAPPING)} triples)")
