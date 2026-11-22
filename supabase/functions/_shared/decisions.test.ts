// Loop-closing Task 1.4 contract tests for the auto_resolve_decisions writer.
// Run: deno test --allow-read supabase/functions/_shared/decisions.test.ts
//
// The SQL side of the same contract (every fixture lands, every negative is
// refused by the named constraint, membership lists equal these constants)
// runs against a local Postgres in scripts/loop-closing/decisions-sql-test.sh.
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1.0.19";
import {
  DECISION_LAYERS,
  DECISION_MAPPING,
  DECISION_OUTCOMES,
  DECISION_REASONS,
  type DecisionRow,
  findMapping,
  recordDecision,
  REVIEW_FIELDS,
  toInsertPayload,
  validateDecisionRow,
} from "./decisions.ts";
import {
  type DecisionFixture,
  generateDecisionFixtures,
} from "./decisions-fixtures.ts";
import { resolveOpenItemAndRecord } from "./resolve-open-item.ts";

const FIXTURE_PATH = new URL("./decisions.fixtures.json", import.meta.url);
const checkedIn: DecisionFixture[] = JSON.parse(
  await Deno.readTextFile(FIXTURE_PATH),
);

const tripleKey = (t: { layer: string; outcome: string; reason: string | null }) =>
  `${t.layer}/${t.outcome}/${t.reason === null ? "null" : t.reason}`;

Deno.test("vocabulary: layers, outcomes and reasons are the plan's lists, no duplicates", () => {
  assertEquals(new Set(DECISION_LAYERS).size, DECISION_LAYERS.length);
  assertEquals(new Set(DECISION_OUTCOMES).size, DECISION_OUTCOMES.length);
  assertEquals(new Set(DECISION_REASONS).size, DECISION_REASONS.length);
  assertEquals(DECISION_LAYERS.length, 12);
  assertEquals(DECISION_OUTCOMES.length, 8);
  assertEquals(DECISION_REASONS.length, 25);
  for (const m of DECISION_MAPPING) {
    assert((DECISION_LAYERS as readonly string[]).includes(m.layer));
    assert((DECISION_OUTCOMES as readonly string[]).includes(m.outcome));
    assert(
      m.reason === null ||
        (DECISION_REASONS as readonly string[]).includes(m.reason),
    );
  }
});

Deno.test("mapping: every triple is unique and every required field is a payload column", () => {
  const keys = DECISION_MAPPING.map(tripleKey);
  assertEquals(new Set(keys).size, keys.length);
  const allowed = new Set([
    "item_id",
    "thought_id",
    "evidence_thought_id",
    "evidence_event_id",
    "related_item_id",
    "quote",
    "score",
  ]);
  for (const m of DECISION_MAPPING) {
    for (const f of m.required) assert(allowed.has(f), `${tripleKey(m)}: ${f}`);
  }
});

Deno.test("fixtures: the checked-in JSON equals the generator's output", () => {
  assertEquals(checkedIn, generateDecisionFixtures());
});

Deno.test("fixtures: the fixture triple set equals DECISION_MAPPING (stored triples, before any insert projection)", () => {
  const fromFixtures = new Set(checkedIn.map(tripleKey));
  const fromMapping = new Set(DECISION_MAPPING.map(tripleKey));
  assertEquals(fromFixtures, fromMapping);
  // A triple added on one side without the other fails: prove the assertion
  // can fail by checking a mapping minus one entry is not equal.
  const minusOne = new Set(DECISION_MAPPING.slice(1).map(tripleKey));
  assertNotEquals(fromFixtures, minusOne);
});

function asRow(payload: Record<string, unknown>): DecisionRow {
  return payload as unknown as DecisionRow;
}

Deno.test("validator: every producer fixture passes; every reviewed-state fixture's proposed projection passes", () => {
  for (const f of checkedIn) {
    if (f.outcome === "kept" || f.outcome === "accepted") {
      const projected = { ...f.payload, outcome: "proposed" };
      assertEquals(validateDecisionRow(projected), null, tripleKey(f));
    } else {
      assertEquals(validateDecisionRow(f.payload), null, tripleKey(f));
    }
  }
});

Deno.test("validator: refuses each reviewed-state fixture at its stored outcome", () => {
  const reviewed = checkedIn.filter((f) =>
    f.outcome === "kept" || f.outcome === "accepted"
  );
  assertEquals(reviewed.length, 14);
  for (const f of reviewed) {
    const problem = validateDecisionRow(f.payload);
    assertNotEquals(problem, null, tripleKey(f));
    assert(problem!.includes("review outcome"), problem!);
  }
});

Deno.test("validator: refuses a producer fixture carrying any one review field", () => {
  const producer = checkedIn.find((f) => f.layer === "gate")!;
  assertEquals(validateDecisionRow(producer.payload), null);
  const values: Record<string, unknown> = {
    review_seq: 1,
    reviewed_at: "2026-11-05T00:00:00Z",
    reviewed_by: "test",
  };
  for (const field of REVIEW_FIELDS) {
    const problem = validateDecisionRow({
      ...producer.payload,
      [field]: values[field],
    });
    assertNotEquals(problem, null, field);
    assert(problem!.includes(field), problem!);
  }
});

// The plan's negative list. Each is refused by the validator; the SQL test
// proves WHICH constraint refuses it on the database side.
const LEGAL_ARCHIVE = checkedIn.find((f) =>
  f.layer === "archive" && f.outcome === "proposed" &&
  f.reason === "age_standard"
)!.payload;

Deno.test("validator: illegal triples and an unknown outcome are refused", () => {
  const negatives: Array<[string, Record<string, unknown>]> = [
    ["outcome open", { ...LEGAL_ARCHIVE, outcome: "open" }],
    ["recheck/dropped/null", {
      ...checkedIn.find((f) => f.layer === "recheck" && f.outcome === "proposed")!
        .payload,
      outcome: "dropped",
      reason: null,
    }],
    ["fragment/resolved/null", {
      ...checkedIn.find((f) =>
        f.layer === "fragment" && f.outcome === "proposed"
      )!.payload,
      outcome: "resolved",
      reason: null,
    }],
    ["L0/blocked/work_report", {
      ...checkedIn.find((f) => f.layer === "L0")!.payload,
      reason: "work_report",
    }],
    ["archive/proposed/none_found", { ...LEGAL_ARCHIVE, reason: "none_found" }],
    ["dedup/accepted/exact_batch", {
      ...checkedIn.find((f) =>
        f.layer === "dedup" && f.reason === "exact_batch"
      )!.payload,
      outcome: "accepted",
    }],
  ];
  for (const [label, row] of negatives) {
    assertNotEquals(validateDecisionRow(row), null, label);
  }
});

Deno.test("validator: payload negatives (a required id missing, an unlisted id present) are refused", () => {
  const recheck = checkedIn.find((f) =>
    f.layer === "recheck" && f.outcome === "proposed"
  )!.payload;
  const exact = checkedIn.find((f) =>
    f.layer === "dedup" && f.reason === "exact_batch"
  )!.payload;
  const calendar = checkedIn.find((f) =>
    f.layer === "calendar" && f.outcome === "proposed"
  )!.payload;
  const l0 = checkedIn.find((f) =>
    f.layer === "L0" && f.reason === "mechanical_prefix"
  )!.payload;
  const negatives: Array<[string, Record<string, unknown>, string]> = [
    ["recheck without evidence", { ...recheck, evidence_thought_id: null }, "evidence_thought_id"],
    ["exact dedup without survivor", { ...exact, related_item_id: null }, "related_item_id"],
    ["calendar without event", { ...calendar, evidence_event_id: null }, "evidence_event_id"],
    ["L0 with an item id", { ...l0, item_id: "11111111-0000-4000-8000-000000000099" }, "item_id"],
  ];
  for (const [label, row, field] of negatives) {
    const problem = validateDecisionRow(row);
    assertNotEquals(problem, null, label);
    assert(problem!.includes(field), `${label}: ${problem}`);
  }
});

Deno.test("validator: L3/no_quote requires quote and score both null; coverage_below_threshold requires both", () => {
  const noQuote = checkedIn.find((f) => f.reason === "no_quote")!.payload;
  assertEquals(validateDecisionRow(noQuote), null);
  assertNotEquals(validateDecisionRow({ ...noQuote, quote: "x" }), null);
  const cov = checkedIn.find((f) =>
    f.reason === "coverage_below_threshold"
  )!.payload;
  assertEquals(validateDecisionRow(cov), null);
  assertNotEquals(validateDecisionRow({ ...cov, score: null }), null);
  assertNotEquals(validateDecisionRow({ ...cov, quote: null }), null);
});

Deno.test("findMapping / toInsertPayload: unlisted ids project to null, every column named", () => {
  assert(findMapping("resolved", "resolved", null));
  assertEquals(findMapping("resolved", "resolved", "work_report"), undefined);
  const payload = toInsertPayload({
    layer: "gate",
    outcome: "dropped",
    reason: "work_report",
    candidate_description: "x",
    thought_id: "22222222-0000-4000-8000-000000000001",
  });
  assertEquals(Object.keys(payload).sort(), [
    "candidate_description",
    "evidence_event_id",
    "evidence_thought_id",
    "item_id",
    "layer",
    "outcome",
    "quote",
    "reason",
    "related_item_id",
    "score",
    "thought_id",
  ]);
  assertEquals(payload.item_id, null);
  assertEquals(payload.score, null);
});

// --- recordDecision against a fake db ------------------------------------

type Inserted = { table: string; row: Record<string, unknown> };

function makeFakeDecisionDb(opts: {
  insertError?: unknown;
  insertThrows?: boolean;
  affected?: Array<{ id: string }>;
  updateError?: unknown;
} = {}) {
  const inserted: Inserted[] = [];
  const updates: Array<{ patch: Record<string, unknown>; filters: string[] }> =
    [];
  const db = {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        if (opts.insertThrows) throw new Error("network down");
        inserted.push({ table, row });
        return Promise.resolve({ error: opts.insertError ?? null });
      },
      update: (patch: Record<string, unknown>) => {
        const filters: string[] = [];
        const chain = {
          eq: (col: string, val: string) => {
            filters.push(`${col}=${val}`);
            return chain;
          },
          select: (_cols: string) => {
            updates.push({ patch, filters });
            return Promise.resolve({
              data: opts.updateError ? null : (opts.affected ?? []),
              error: opts.updateError ?? null,
            });
          },
        };
        return chain;
      },
    }),
  };
  return { db, inserted, updates };
}

const GATE_ROW: DecisionRow = {
  layer: "gate",
  outcome: "dropped",
  reason: "work_report",
  candidate_description: "The operator runs both deploys",
  thought_id: "22222222-0000-4000-8000-000000000001",
};

Deno.test("recordDecision: a legal row inserts exactly one row into auto_resolve_decisions", async () => {
  const { db, inserted } = makeFakeDecisionDb();
  const result = await recordDecision(db, GATE_ROW);
  assertEquals(result, { ok: true });
  assertEquals(inserted.length, 1);
  assertEquals(inserted[0].table, "auto_resolve_decisions");
  assertEquals(inserted[0].row.layer, "gate");
  assertEquals(inserted[0].row.item_id, null);
});

Deno.test("recordDecision: logs and returns on a failed insert, never throws", async () => {
  const { db, inserted } = makeFakeDecisionDb({
    insertError: { message: "check constraint violated" },
  });
  const result = await recordDecision(db, GATE_ROW);
  assertEquals(result.ok, false);
  assert(result.error!.includes("check constraint"));
  assertEquals(inserted.length, 1);
  const thrown = makeFakeDecisionDb({ insertThrows: true });
  const r2 = await recordDecision(thrown.db, GATE_ROW);
  assertEquals(r2.ok, false);
  assert(r2.error!.includes("network down"));
});

Deno.test("recordDecision: refuses an illegal row before touching the db", async () => {
  const { db, inserted } = makeFakeDecisionDb();
  const result = await recordDecision(db, {
    ...GATE_ROW,
    item_id: "11111111-0000-4000-8000-000000000001",
  });
  assertEquals(result.ok, false);
  assertEquals(inserted.length, 0);
});

Deno.test("resolve path: no resolved row when the guarded update affects zero rows", async () => {
  // Simulates an item deferred while the LAYER 2 model ran: the status
  // predicate matches nothing, so nothing is recorded as resolved.
  const { db, inserted, updates } = makeFakeDecisionDb({ affected: [] });
  const outcome = await resolveOpenItemAndRecord(db, {
    itemId: "11111111-0000-4000-8000-000000000001",
    description: "ship the thing",
    thoughtId: "22222222-0000-4000-8000-000000000001",
    quote: "shipped the thing",
    now: "2026-11-05T00:00:00.000Z",
  });
  assertEquals(outcome, "not_open");
  assertEquals(inserted.length, 0);
  assertEquals(updates.length, 1);
  assert(updates[0].filters.includes("status=open"), updates[0].filters.join());
});

Deno.test("resolve path: one resolved row when the guarded update affects the row", async () => {
  const { db, inserted } = makeFakeDecisionDb({
    affected: [{ id: "11111111-0000-4000-8000-000000000001" }],
  });
  const outcome = await resolveOpenItemAndRecord(db, {
    itemId: "11111111-0000-4000-8000-000000000001",
    description: "ship the thing",
    thoughtId: "22222222-0000-4000-8000-000000000001",
    quote: "shipped the thing",
    now: "2026-11-05T00:00:00.000Z",
  });
  assertEquals(outcome, "resolved");
  assertEquals(inserted.length, 1);
  assertEquals(inserted[0].row.layer, "resolved");
  assertEquals(inserted[0].row.outcome, "resolved");
  assertEquals(inserted[0].row.reason, null);
  assertEquals(inserted[0].row.quote, "shipped the thing");
});

Deno.test("resolve path: an update error records nothing", async () => {
  const { db, inserted } = makeFakeDecisionDb({
    updateError: { message: "boom" },
  });
  const outcome = await resolveOpenItemAndRecord(db, {
    itemId: "11111111-0000-4000-8000-000000000001",
    description: "ship the thing",
    thoughtId: "22222222-0000-4000-8000-000000000001",
    quote: "shipped the thing",
    now: "2026-11-05T00:00:00.000Z",
  });
  assertEquals(outcome, "error");
  assertEquals(inserted.length, 0);
});
