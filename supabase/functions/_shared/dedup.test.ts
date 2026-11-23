// Loop-closing Task 5.2 (A3): batch-local exact dedup and semantic dedup
// proposals. Run:
//   deno test --allow-read --allow-env supabase/functions/_shared/dedup.test.ts
//
// The plan's tests, by name, through the pure functions and through the REAL
// shared extractAndStoreActionItems (capture-pipeline.ts, which open-brain-mcp's
// REST /capture and capture_thought call) over a stateful fake database: items
// persist across captures, dedup_semantic_candidates answers from them with the
// source thought's project, record_decisions records its rows. The ingest copy
// is the same syntax tree (fragment-gate.test.ts, "mirror 5.1: the two
// extractAndStoreActionItems bodies ...") and is exercised through its real
// handler by scripts/loop-closing/ingest-probe-harness.ts probe 13; the MCP
// entrypoints by closeout-capture-probe-harness.ts probes F and G.
//
// The assertions the TS mutant sweep (scripts/loop-closing/
// fragment-gate-ts-mutants.py) certifies are claim() calls, bound at run time
// (scripts/loop-closing/claim.ts).
//
// Fixture provenance. The Casey rows c31cea1a, 03cc194f and 29c04c0c (Codex
// audit, docs/audits/2026-11-03-loop-closing-audit-codex.md section 2.2: "add
// Casey as a guest when his email arrives, with small differences in name and
// wording") are not quoted verbatim anywhere in the repository and production
// was not read for this build, so their text here is a reconstruction of that
// description, ids kept for reference. The Claude audit's "5 wrongly-matched
// pairs" (docs/audits/2026-11-03-loop-closing-audit-claude.md, fix D1: "about
// 5 were wrong, mostly generic ones like 'Deliver the report under
// deliverables/'") are not listed by id or text in the repository either; the
// MUST_NOT_SUPPRESS stand-ins below are generic pairs of that named shape, not
// the audit's rows.

import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import {
  constraintTokens,
  createBatchDedup,
  describeConstraints,
  overlapContainment,
  planSemanticProposals,
  proposeSemanticDuplicates,
  type SemanticCandidate,
  semanticOverlap,
} from "./dedup.ts";
import { extractAndStoreActionItems, normalizeActionText } from "./capture-pipeline.ts";
import { validateDecisionRow } from "./decisions.ts";
import { claim } from "../../../scripts/loop-closing/claim.ts";

// ---------------------------------------------------------------------------
// A stateful fake database for the shared capture path.
// ---------------------------------------------------------------------------

type Item = { id: string; description: string; status: string; source_thought_id: string; created_at: string };

function makeDb(opts: { recordError?: Array<{ code?: string; message: string } | null>; noRpc?: boolean } = {}) {
  const items: Item[] = [];
  const projects = new Map<string, string | null>();
  const decisions: Array<Record<string, unknown>> = []; // recordDecision rows
  const recordCalls: Array<Array<Record<string, unknown>>> = []; // record_decisions p_rows
  const calls: string[] = []; // order of reads and writes
  let n = 0, clock = Date.parse("2026-11-20T00:00:00.000Z");
  const db: Record<string, unknown> = {
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, val: string) => {
          calls.push(`select ${table}`);
          return Promise.resolve({ data: items.filter((i) => i.status === val).map((i) => ({ description: i.description })), error: null });
        },
      }),
      insert: (rows: Array<Record<string, unknown>> | Record<string, unknown>) => {
        if (table === "auto_resolve_decisions") {
          assert(!Array.isArray(rows), "recordDecision writes one row per call");
          calls.push(`decision ${(rows as Record<string, unknown>).layer}`);
          decisions.push(rows as Record<string, unknown>);
          return Promise.resolve({ error: null });
        }
        assertEquals(table, "action_items");
        calls.push("insert action_items");
        const back = (rows as Array<Record<string, unknown>>).map((r) => {
          n += 1;
          clock += 60_000;
          const it: Item = {
            id: `d5200000-0000-4000-8000-${String(n).padStart(12, "0")}`,
            description: String(r.description),
            status: String(r.status),
            source_thought_id: String(r.source_thought_id),
            created_at: new Date(clock).toISOString(),
          };
          items.push(it);
          return { id: it.id, description: it.description };
        });
        return Object.assign(Promise.resolve({ error: null }), {
          select: (_cols: string) => Promise.resolve({ data: back, error: null }),
        });
      },
    }),
  };
  if (!opts.noRpc) {
    db.rpc = (fn: string, args: Record<string, unknown>) => {
      calls.push(`rpc ${fn}`);
      if (fn === "dedup_semantic_candidates") {
        assertEquals(args, { p_window_days: 14, p_limit: 500 });
        return Promise.resolve({
          data: items.filter((i) => i.status === "open").map((i) => ({
            id: i.id,
            description: i.description,
            created_at: i.created_at,
            source_thought_id: i.source_thought_id,
            project: projects.get(i.source_thought_id) ?? null,
          })),
          error: null,
        });
      }
      if (fn === "record_decisions") {
        const err = opts.recordError?.shift();
        if (err) return Promise.resolve({ data: null, error: err });
        const rows = args.p_rows as Array<Record<string, unknown>>;
        recordCalls.push(rows);
        return Promise.resolve({ data: rows.length, error: null });
      }
      throw new Error(`unexpected rpc ${fn}`);
    };
  }
  return { db, items, projects, decisions, recordCalls, calls };
}

const T1 = "4a52f000-0000-4000-8000-000000000001";
const T2 = "4a52f000-0000-4000-8000-000000000002";
const T3 = "4a52f000-0000-4000-8000-000000000003";
// Still-owed language in the source, so the Session 272 appointment guard
// (which runs before dedup) keeps the plan's appointment-reminder fixtures.
const NOTE = "Notes from today: these still need to go out.";
const noMech = (_c: string) => false;

async function capture(
  f: ReturnType<typeof makeDb>,
  thoughtId: string,
  project: string | null,
  items: string[],
): Promise<void> {
  f.projects.set(thoughtId, project);
  await extractAndStoreActionItems(
    f.db as { from(t: string): unknown } as never,
    thoughtId,
    { type: "task", source: "slack", project, action_items: items },
    NOTE,
    noMech,
  );
}

const idOf = (f: ReturnType<typeof makeDb>, d: string) => f.items.find((i) => i.description === d)?.id;
const proposals = (f: ReturnType<typeof makeDb>) => f.recordCalls.flat();
const pick = (r: Record<string, unknown>) => [r.layer, r.outcome, r.reason, r.item_id, r.related_item_id, r.score, r.thought_id];

// ---------------------------------------------------------------------------
// The plan's pair verdicts.
// ---------------------------------------------------------------------------

const SAM = "send Sam the final appointment reminder email";
const RILEY = "send Riley the final appointment reminder email";
const LIVE = "deploy Acme CRM appointment reminder email to live";
const DEMO = "deploy Acme CRM appointment reminder email to demo";

Deno.test("dedup 5.2: Sam vs Riley is maybe at 0.833 with empty constraint sets (must not suppress)", () => {
  assertEquals(Math.round(overlapContainment(SAM, RILEY) * 1000) / 1000, 0.833);
  assertEquals(constraintTokens(SAM).size, 0);
  assertEquals(constraintTokens(RILEY).size, 0);
  claim("sam-riley-maybe", semanticOverlap(SAM, RILEY), "maybe", "the Sam/Riley pair is a proposal, never a suppressing value");
  assertEquals(describeConstraints(RILEY, SAM), "constraints agree");
});

Deno.test("dedup 5.2: live vs demo is maybe and the proposal says constraints differ: live vs demo", () => {
  assertEquals(semanticOverlap(LIVE, DEMO), "maybe");
  // The survivor (the older, "live") first, the newer item second.
  claim("live-demo-wording", describeConstraints(DEMO, LIVE), "constraints differ: live vs demo", "survivor's constraints first");
});

Deno.test("dedup 5.2: invite Sam vs send Sam the deck is no", () => {
  assertEquals(overlapContainment("invite Sam", "send Sam the deck"), 0.5);
  assertEquals(semanticOverlap("invite Sam", "send Sam the deck"), "no");
});

Deno.test("dedup 5.2: containment is of the SHORTER item's content tokens in the longer item's", () => {
  // The Claude audit's own example (cause 5): exact-text dedup misses it.
  const short = "invite Sam", long = "should invite Sam with npm run demo:invite";
  claim("shorter-containment", overlapContainment(short, long), 1, "the shorter item's two tokens are both in the longer one");
  assertEquals(overlapContainment(long, short), 1, "symmetric in argument order");
  assertEquals(semanticOverlap(short, long), "maybe");
});

Deno.test("dedup 5.2: the threshold is inclusive at 0.8", () => {
  // 4 of the shorter item's 5 content tokens: exactly 0.8.
  const a = "email Jordan the kitchen remodel stencil", b = "email Jordan the kitchen remodel deposit invoice";
  assertEquals(overlapContainment(a, b), 0.8);
  claim("threshold-inclusive", semanticOverlap(a, b), "maybe", "0.8 is at the threshold");
  assertEquals(semanticOverlap("email Jordan the koi stencil", "email Jordan the sleeve invoice"), "no"); // 0.5
});

Deno.test("dedup 5.2: the shorter item needs at least two content tokens", () => {
  // "invite" has one content token; contained 1 of 1, still no.
  claim("min-two-tokens", semanticOverlap("invite", "invite Sam to the demo"), "no", "one content token never proposes");
  assertEquals(semanticOverlap("the and for", "the and for"), "no"); // all stoplisted
});

Deno.test("dedup 5.2: constraintTokens takes numbers, ISO dates, hostnames, environment words and negations, lowercase", () => {
  assertEquals(
    [...constraintTokens("Verify brain.example.com migration 063 on 2026-11-05 is NOT live; staging next, never prod or Production or test or demo, no rush")].sort(),
    ["063", "2026-11-05", "brain.example.com", "demo", "live", "never", "no", "not", "prod", "production", "staging", "test"],
  );
  // A file name is not a hostname; a date is not three numbers.
  assertEquals([...constraintTokens("update deliverables/report.md by 2026-12-01")].sort(), ["2026-12-01"]);
  assertEquals(constraintTokens("send Sam the explainer PDF").size, 0);
  assertEquals(describeConstraints("rotate the live key", "rotate the key"), "constraints differ: none vs live");
});

// ---------------------------------------------------------------------------
// Batch-local exact dedup.
// ---------------------------------------------------------------------------

Deno.test("dedup 5.2: createBatchDedup keeps the first of each normalized text and records later copies in order", () => {
  const b = createBatchDedup(normalizeActionText);
  const kept = ["Send Sam the deck", "send sam the deck.", "invite Jordan", "SEND SAM THE DECK!"].filter((d) => b.keep(d));
  assertEquals(kept, ["Send Sam the deck", "invite Jordan"]);
  assertEquals(b.duplicates.map((d) => d.description), ["send sam the deck.", "SEND SAM THE DECK!"]);
});

const CASEY_1 = "Add Casey as a guest when his email arrives"; // c31cea1a (reconstructed)
const CASEY_2 = "Add Casey Holt as a guest when his email arrives"; // 03cc194f (reconstructed)
const CASEY_3 = "Add Casey as guest when his email address arrives"; // 29c04c0c (reconstructed)

Deno.test("dedup 5.2, shared capture path: two identical Casey strings in ONE batch insert once with an exact_batch row", async () => {
  const f = makeDb();
  await capture(f, T1, "brain-bank", [CASEY_1, "Add Casey as a guest when his email arrives.", "nudge Jordan if nothing arrives"]);
  const dedupRows = f.decisions.filter((d) => d.layer === "dedup");
  claim(
    "exact-batch-e2e",
    {
      inserted: f.items.map((i) => i.description),
      rows: dedupRows.map((d) => [d.outcome, d.reason, d.candidate_description, d.thought_id, d.related_item_id, d.item_id]),
    },
    {
      inserted: [CASEY_1, "nudge Jordan if nothing arrives"],
      rows: [["dropped", "exact_batch", "Add Casey as a guest when his email arrives.", T1, idOf(f, CASEY_1), null]],
    },
    "the batch inserts one copy and writes one exact_batch row naming the inserted survivor",
  );
  for (const r of dedupRows) assertEquals(validateDecisionRow(r), null);
  // Same-thought items are never semantic candidates of each other.
  assertEquals(proposals(f), []);
});

Deno.test("dedup 5.2, shared capture path: the fragment gate runs before the batch dedup, so a fragment's copies are both fragment drops", async () => {
  const f = makeDb();
  await capture(f, T1, null, ["deploy", "deploy", "send Sam the explainer PDF"]);
  assertEquals(f.items.map((i) => i.description), ["send Sam the explainer PDF"]);
  claim(
    "gate-before-batch",
    f.decisions.map((d) => [d.layer, d.outcome, d.reason]),
    [["fragment", "dropped", "one_token"], ["fragment", "dropped", "one_token"]],
    "every copy of a fragment is a fragment drop; none is an exact_batch",
  );
});

Deno.test("dedup 5.2, shared capture path: a batch copy of an item already open is skipped silently by the open-item dedup", async () => {
  const f = makeDb();
  await capture(f, T1, null, ["send Sam the deck"]);
  await capture(f, T2, null, ["Send Sam the deck.", "send sam the deck", "invite Jordan to the flash day"]);
  assertEquals(f.items.map((i) => i.description), ["send Sam the deck", "invite Jordan to the flash day"]);
  assertEquals(f.decisions.filter((d) => d.layer === "dedup"), []);
});

// ---------------------------------------------------------------------------
// Semantic proposals, end to end.
// ---------------------------------------------------------------------------

Deno.test("dedup 5.2, shared capture path: the three Casey rows (one capture each, same project) all insert, the second and third propose the first", async () => {
  const f = makeDb();
  await capture(f, T1, "brain-bank", [CASEY_1]);
  await capture(f, T2, "brain-bank", [CASEY_2]);
  await capture(f, T3, "brain-bank", [CASEY_3]);
  assertEquals(f.items.map((i) => i.description), [CASEY_1, CASEY_2, CASEY_3]);
  const first = idOf(f, CASEY_1);
  // CASEY_3 also overlaps CASEY_2 (0.833); the OLDEST candidate is the survivor.
  assertEquals(overlapContainment(CASEY_3, CASEY_2) >= 0.8, true);
  claim(
    "casey-proposals",
    proposals(f).map(pick),
    [
      ["dedup", "proposed", "semantic_overlap", idOf(f, CASEY_2), first, 1, null],
      ["dedup", "proposed", "semantic_overlap", idOf(f, CASEY_3), first, 1, null],
    ],
    "the second and third Casey rows carry proposed rows pointing at the first",
  );
  for (const r of proposals(f)) assertEquals(validateDecisionRow(r), null);
  // One record_decisions call per capture that has a proposal, read before the insert.
  assertEquals(f.recordCalls.length, 2);
  assertEquals(f.calls.filter((c) => c === "rpc dedup_semantic_candidates" || c === "insert action_items" || c === "rpc record_decisions").slice(2, 5), [
    "rpc dedup_semantic_candidates",
    "insert action_items",
    "rpc record_decisions",
  ]);
});

Deno.test("dedup 5.2, shared capture path: Sam and Riley BOTH insert, the second carries a proposal (must not suppress)", async () => {
  const f = makeDb();
  await capture(f, T1, "external-crm", [SAM]);
  await capture(f, T2, "external-crm", [RILEY]);
  claim("sam-riley-both-insert", f.items.map((i) => i.description), [SAM, RILEY], "both clients' tasks are inserted");
  assertEquals(proposals(f).map(pick), [["dedup", "proposed", "semantic_overlap", idOf(f, RILEY), idOf(f, SAM), 0.833, null]]);
});

Deno.test("dedup 5.2, shared capture path: live vs demo both insert and the proposal is worded constraints differ", async () => {
  const f = makeDb();
  await capture(f, T1, "external-crm", [LIVE]);
  await capture(f, T2, "external-crm", [DEMO]);
  assertEquals(f.items.map((i) => i.description), [LIVE, DEMO]);
  const p = proposals(f);
  assertEquals(p.map(pick), [["dedup", "proposed", "semantic_overlap", idOf(f, DEMO), idOf(f, LIVE), 0.833, null]]);
  const survivor = f.items.find((i) => i.id === p[0].related_item_id)!;
  assertEquals(describeConstraints(String(p[0].candidate_description), survivor.description), "constraints differ: live vs demo");
});

Deno.test("dedup 5.2, shared capture path: a null-project pair at 0.9 containment is maybe and both insert", async () => {
  const a = "email Jordan the kitchen remodel stencil deposit invoice consent aftercare sheet";
  const b = "email Jordan the kitchen remodel stencil deposit invoice consent aftercare card";
  assertEquals(overlapContainment(a, b), 0.9);
  for (const [pa, pb] of [[null, "external-crm"], ["external-crm", null], [null, null]] as const) {
    const f = makeDb();
    await capture(f, T1, pa, [a]);
    await capture(f, T2, pb, [b]);
    assertEquals(f.items.map((i) => i.description), [a, b]);
    claim(
      "null-project-proposes",
      proposals(f).map(pick),
      [["dedup", "proposed", "semantic_overlap", idOf(f, b), idOf(f, a), 0.9, null]],
      `a null project on either side still proposes (${pa}, ${pb})`,
    );
  }
});

Deno.test("dedup 5.2, shared capture path: a different project proposes nothing and both insert", async () => {
  const f = makeDb();
  await capture(f, T1, "external-crm", [SAM]);
  await capture(f, T2, "Open-Brain", [RILEY]);
  assertEquals(f.items.map((i) => i.description), [SAM, RILEY]);
  claim("project-scope", proposals(f), [], "candidates are limited to the capture's project");
  // Project names compare case- and space-insensitively.
  const g = makeDb();
  await capture(g, T1, " External-CRM", [SAM]);
  await capture(g, T2, "external-crm ", [RILEY]);
  assertEquals(proposals(g).length, 1);
});

// The Claude audit's five wrongly-matched pairs, as must-not-suppress fixtures.
// The audit gives neither ids nor text (see the provenance note at the top);
// these are stand-ins of the one shape it names, plus four generic shapes of
// the same kind. Whatever the verdict, BOTH rows insert.
const MUST_NOT_SUPPRESS: Array<[string, string]> = [
  ["Deliver the report under deliverables/example-site/", "Deliver the report under deliverables/other-site/"],
  ["Deliver the research brief under deliverables/seo-agent/", "Deliver the audit brief under deliverables/seo-agent/"],
  ["Send Jordan the kitchen remodel deposit link", "Send Jordan Lee the dragon sleeve deposit link"],
  ["Run the migration 063 on staging", "Run the migration 064 on staging"],
  ["Post the flash day announcement on Instagram", "Post the flash day recap on Instagram"],
];

Deno.test("dedup 5.2, shared capture path: the audit-shaped wrongly-matched pairs all insert (stand-ins; the audit lists no ids)", async () => {
  for (const [older, newer] of MUST_NOT_SUPPRESS) {
    const f = makeDb();
    await capture(f, T1, "brain-bank", [older]);
    await capture(f, T2, "brain-bank", [newer]);
    claim("must-not-suppress", f.items.map((i) => i.description), [older, newer], `both insert: ${older} | ${newer}`);
    // A proposal, when there is one, names the older item and is review-only.
    for (const p of proposals(f)) assertEquals([p.item_id, p.related_item_id], [idOf(f, newer), idOf(f, older)]);
  }
});

// ---------------------------------------------------------------------------
// Candidate selection and failure handling.
// ---------------------------------------------------------------------------

const cand = (id: string, description: string, created_at: string, source_thought_id: string | null, project: string | null): SemanticCandidate =>
  ({ id, description, created_at, source_thought_id, project });

Deno.test("dedup 5.2: planSemanticProposals excludes the batch's own rows and its own source thought, and picks the oldest candidate", () => {
  const newId = "d5200000-0000-4000-8000-0000000000ff";
  const rows = planSemanticProposals(
    [
      cand("d5200000-0000-4000-8000-000000000003", CASEY_2, "2026-11-19T00:00:00Z", T2, null),
      cand(newId, CASEY_3, "2026-11-20T00:00:00Z", T3, null), // the inserted row itself
      cand("d5200000-0000-4000-8000-000000000004", CASEY_1, "2026-11-17T00:00:00Z", T3, null), // same thought, and the oldest
      cand("d5200000-0000-4000-8000-000000000002", CASEY_1, "2026-11-18T00:00:00Z", T1, "brain-bank"),
    ],
    T3,
    "brain-bank",
    [{ id: newId, description: CASEY_3 }],
  );
  claim(
    "same-thought-excluded",
    rows.map((r) => r.related_item_id),
    ["d5200000-0000-4000-8000-000000000002"],
    "the oldest candidate from another thought",
  );
});

Deno.test("dedup 5.2: record_decisions is retried on 40P01 and a refusal is logged, never thrown", async () => {
  const inserted = [{ id: "d5200000-0000-4000-8000-0000000000aa", description: RILEY }];
  const candidates = [cand("d5200000-0000-4000-8000-0000000000bb", SAM, "2026-11-19T00:00:00Z", T1, null)];
  const once = makeDb({ recordError: [{ code: "40P01", message: "deadlock detected" }] });
  claim("deadlock-retry", await proposeSemanticDuplicates(once.db as never, candidates, T2, null, inserted), 1, "the second attempt writes the row");
  assertEquals(once.recordCalls.length, 1);
  const thrice = makeDb({ recordError: [{ code: "40P01", message: "d" }, { code: "40P01", message: "d" }, { code: "40P01", message: "d" }] });
  assertEquals(await proposeSemanticDuplicates(thrice.db as never, candidates, T2, null, inserted), 0);
  assertEquals(thrice.recordCalls.length, 0);
  const refused = makeDb({ recordError: [{ code: "23514", message: "check violation" }] });
  assertEquals(await proposeSemanticDuplicates(refused.db as never, candidates, T2, null, inserted), 0);
  assertEquals(refused.calls.filter((c) => c === "rpc record_decisions").length, 1, "a CHECK failure is not retried as a deadlock");
});

Deno.test("dedup 5.2, shared capture path: with no rpc the items still insert and nothing is proposed", async () => {
  const f = makeDb({ noRpc: true });
  await capture(f, T1, null, [SAM]);
  await capture(f, T2, null, [RILEY, RILEY]);
  assertEquals(f.items.map((i) => i.description), [SAM, RILEY]);
  assertEquals(f.decisions.map((d) => [d.layer, d.reason]), [["dedup", "exact_batch"]]);
});
