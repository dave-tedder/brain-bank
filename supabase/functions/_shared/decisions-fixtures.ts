// supabase/functions/_shared/decisions-fixtures.ts
//
// Loop-closing Task 1.4: one exact payload per legal (layer, outcome, reason)
// triple, generated from DECISION_MAPPING and checked in as
// decisions.fixtures.json. decisions.test.ts asserts the JSON equals this
// generator's output and that the fixture triples equal DECISION_MAPPING, so a
// triple added on one side without the other fails. The SQL test
// (scripts/loop-closing/decisions-sql-test.sh) inserts the same payloads
// against the migration on a local Postgres.
//
// Two kinds of fixture, told apart by outcome: a producer payload (every
// outcome except kept and accepted) is an exact insert; a reviewed-state
// fixture (kept or accepted) is inserted as proposed and then brought to its
// stored outcome by a test-only review update, the shape Task 3.6's RPC uses.
//
// Every fixture gets its own ids per role, so fixtures sharing a lifetime
// unique index (recheck item+evidence, calendar item+event) never collide.
//
// Regenerate: deno run --allow-write supabase/functions/_shared/decisions-fixtures.ts

import {
  DECISION_ID_COLUMNS,
  DECISION_MAPPING,
  type DecisionIdColumn,
  type DecisionLayer,
  type DecisionOutcome,
  type DecisionReason,
} from "./decisions.ts";

export type DecisionFixture = {
  layer: DecisionLayer;
  outcome: DecisionOutcome;
  reason: DecisionReason | null;
  payload: Record<string, unknown>;
};

const ROLE_DIGIT: Record<DecisionIdColumn, string> = {
  item_id: "1",
  thought_id: "2",
  evidence_thought_id: "3",
  evidence_event_id: "4",
  related_item_id: "5",
};

/** Deterministic, valid v4-shaped uuid per (role, fixture index). */
export function fixtureUuid(role: DecisionIdColumn, n: number): string {
  const d = ROLE_DIGIT[role];
  return `${d.repeat(8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export function generateDecisionFixtures(): DecisionFixture[] {
  return DECISION_MAPPING.map((m, i) => {
    const n = i + 1;
    const payload: Record<string, unknown> = {
      layer: m.layer,
      outcome: m.outcome,
      reason: m.reason,
      candidate_description:
        `fixture ${n}: ${m.layer}/${m.outcome}/${String(m.reason)}`,
    };
    for (const col of DECISION_ID_COLUMNS) {
      payload[col] = m.required.includes(col) ? fixtureUuid(col, n) : null;
    }
    payload.quote = m.required.includes("quote") ? `fixture ${n} quote` : null;
    payload.score = m.required.includes("score") ? 0.5 : null;
    return { layer: m.layer, outcome: m.outcome, reason: m.reason, payload };
  });
}

if (import.meta.main) {
  const out = new URL("./decisions.fixtures.json", import.meta.url);
  await Deno.writeTextFile(
    out,
    JSON.stringify(generateDecisionFixtures(), null, 2) + "\n",
  );
  console.log(`wrote ${out.pathname}`);
}
