// Loop-closing Task 5.1: the fragment gate's writers, and the mirror proof for
// the two capture paths.
// Run: deno test --allow-read --allow-env supabase/functions/_shared/fragment-gate.test.ts
// (--allow-read: the mirror tests read capture-pipeline.ts and
// ingest-thought/index.ts from disk; ingest-thought cannot be imported in a
// unit test because it builds its client and starts Deno.serve at import.
// --allow-env: the TypeScript parser the mirror tests use reads a few
// environment variables when it loads; see scripts/loop-closing/ts-parser.ts.)
//
// The ingest copy's BEHAVIOR is proven by scripts/loop-closing/
// ingest-probe-harness.ts probe 10 (the real handler, a signed Slack event);
// open-brain-mcp's REST /capture and capture_thought by
// closeout-capture-probe-harness.ts probes D and E. These tests prove the two
// extractAndStoreActionItems bodies are the same syntax tree apart from a fixed
// list of names (scripts/loop-closing/mirror-ast.ts, on the TypeScript parser),
// and that the two extraction prompts are the same string.

import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import {
  applyFragmentGate,
  EMPTY_ITEM_MARKER,
  recordPronounSuspects,
} from "./fragment-gate.ts";
import { EXTRACT_METADATA_SYSTEM_PROMPT } from "./capture-pipeline.ts";
import { validateDecisionRow } from "./decisions.ts";
import { claim } from "../../../scripts/loop-closing/claim.ts";
import {
  astKey,
  commentRanges,
  editLayout,
  findAll,
  findFunction,
  identifierNames,
  inTypePosition,
  isDirective,
  isTypeOnlyStatement,
  kindName,
  LINE_TERMINATOR,
  loadTs,
  outermostWrapper,
  parseTs,
  runtimeRejects,
  skipErased,
  treeFind,
  ts,
} from "../../../scripts/loop-closing/mirror-ast.ts";

const T = "4a51f000-0000-4000-8000-0000000000aa";

function recorder(fail = false) {
  const rows: Array<Record<string, unknown>> = [];
  const db = {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        assertEquals(table, "auto_resolve_decisions");
        assert(!Array.isArray(row), "recordDecision writes one row per call");
        rows.push(row);
        return Promise.resolve({ error: fail ? { message: "down" } : null });
      },
    }),
  };
  return { db, rows };
}

Deno.test("applyFragmentGate: keeps rows unchanged and in order, one valid decision row per drop", async () => {
  const { db, rows } = recorder();
  const input = [
    { description: "deploy", status: "open", source_thought_id: T },
    { description: "send Sam the explainer PDF", status: "open", source_thought_id: T },
    { description: "finalize what we're", status: "open", source_thought_id: T },
    { description: "TODO: send her the floor plan sketch", status: "open", source_thought_id: T },
  ];
  const kept = await applyFragmentGate(db, T, input);
  assertEquals(kept, [input[1], input[3]]);
  assertEquals(rows.map((r) => [r.layer, r.outcome, r.reason, r.candidate_description, r.item_id, r.thought_id]), [
    ["fragment", "dropped", "one_token", "deploy", null, T],
    ["fragment", "dropped", "dangling_clause", "finalize what we're", null, T],
  ]);
  for (const r of rows) assertEquals(validateDecisionRow(r), null);
});

Deno.test("applyFragmentGate: nothing to drop writes nothing", async () => {
  const { db, rows } = recorder();
  const kept = await applyFragmentGate(db, T, [{ description: "nudge Jordan if nothing arrives" }]);
  assertEquals(kept.length, 1);
  assertEquals(rows.length, 0);
});

Deno.test("applyFragmentGate: a blank item is dropped and audited with the marker", async () => {
  const { db, rows } = recorder();
  assertEquals(await applyFragmentGate(db, T, [{ description: "" }]), []);
  assertEquals(rows.map((r) => r.candidate_description), [EMPTY_ITEM_MARKER]);
});

Deno.test("applyFragmentGate: a failed decision write still drops the item", async () => {
  const { db, rows } = recorder(true);
  assertEquals(await applyFragmentGate(db, T, [{ description: "deploy" }]), []);
  assertEquals(rows.length, 1);
});

Deno.test("recordPronounSuspects: one fragment/proposed/pronoun_object row per suspect, item_id set", async () => {
  const { db, rows } = recorder();
  const n = await recordPronounSuspects(db, T, [
    { id: "a1000000-0000-4000-8000-000000000001", description: "send Sam the explainer PDF" },
    { id: "a1000000-0000-4000-8000-000000000002", description: "send her the explainer PDF" },
    { id: "a1000000-0000-4000-8000-000000000003", description: "follow up with him on Friday" },
  ]);
  assertEquals(n, 2);
  assertEquals(rows.map((r) => [r.layer, r.outcome, r.reason, r.item_id, r.thought_id, r.candidate_description]), [
    ["fragment", "proposed", "pronoun_object", "a1000000-0000-4000-8000-000000000002", T, "send her the explainer PDF"],
    ["fragment", "proposed", "pronoun_object", "a1000000-0000-4000-8000-000000000003", T, "follow up with him on Friday"],
  ]);
  for (const r of rows) assertEquals(validateDecisionRow(r), null);
});

// ---------------------------------------------------------------------------
// Mirror proof (AGENTS.md mirror rule).
// ---------------------------------------------------------------------------

const ROOT = new URL("../../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, ROOT));
const SHARED = "supabase/functions/_shared/capture-pipeline.ts";
const INGEST = "supabase/functions/ingest-thought/index.ts";
const FN = "extractAndStoreActionItems";

// A prerequisite that does not hold (a function the parser cannot find, a
// source that does not parse) is not a verdict on that code. It throws a plain
// Error tagged "setup:", never an AssertionError, so
// scripts/loop-closing/fragment-gate-ts-mutants.py classifies such a run as
// NEVER-RAN instead of CAUGHT (Codex review 1, F1; re-review 1, R1). The test
// still fails.
//
// The assertions the mutant sweep certifies are `claim(id, ...)` calls
// (scripts/loop-closing/claim.ts): the claim records its own entry and its own
// failure at run time, and the sweep counts CAUGHT only on that record, so an
// assertion raised anywhere else in a test (a helper, a fake, a prerequisite)
// can never stand in for the claimed one (Codex re-review 2, N1).
function setup(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`setup: ${msg}`);
}

// The ONLY differences the two copies may carry, applied to the syntax tree,
// never to text. Each is a name, never behavior: the shared copy takes its
// client and its mechanical test as parameters and is exported; ingest-thought
// uses its module client and the imported isMechanicalCapture (since
// correction 3 of PR 33 both copies also read the same imported LOG_TRUNC, so
// the shared copy's old ACTION_ITEM_LOG_TRUNC rename is gone). Type annotations
// differ too (`db: ActionItemDb`, `as Array<...>`), and need no rule: types
// are not part of the compared tree (see mirror-ast.ts), so a runtime-neutral
// type change in one copy, such as Codex re-review 1's `db: any`, compares
// equal instead of failing a rewrite count.
const SHARED_ONLY_PARAMS = ["db", "isMechanical"];
const RENAMES = new Map([
  ["db", "supabase"],
  ["isMechanical", "isMechanicalCapture"],
]);

function sharedKey(fn: ts.FunctionDeclaration): string[] {
  const isExport = (m: ts.Node) => m.kind === ts.SyntaxKind.ExportKeyword;
  setup((ts.getModifiers(fn) ?? []).some(isExport), "the shared copy is exported");
  for (const name of SHARED_ONLY_PARAMS) {
    setup(fn.parameters.filter((p) => ts.isIdentifier(p.name) && p.name.text === name).length === 1, `the shared copy has one ${name} parameter`);
  }
  // A rename may not merge two different names: no target name is already in
  // the shared copy.
  const names = identifierNames(fn);
  for (const to of RENAMES.values()) setup(!names.has(to), `the shared copy has no identifier ${to} of its own`);
  return astKey(fn, {
    rename: RENAMES,
    skip: (n) => n.parent === fn && (isExport(n) || (ts.isParameter(n) && ts.isIdentifier(n.name) && SHARED_ONLY_PARAMS.includes(n.name.text))),
  });
}

function ingestKey(fn: ts.FunctionDeclaration): string[] {
  const names = identifierNames(fn);
  for (const from of RENAMES.keys()) setup(!names.has(from), `the ingest copy has no identifier ${from} (it is the shared copy's name)`);
  for (const name of SHARED_ONLY_PARAMS) setup(!fn.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name), `the ingest copy has no ${name} parameter`);
  return astKey(fn);
}

const sharedFn = (src = read(SHARED)) => findFunction(parseTs(src, "the shared copy"), FN);
const ingestFn = (src = read(INGEST)) => findFunction(parseTs(src, "the ingest copy"), FN);
// The ingest function's own text, parsed standalone by the layout tests below.
function ingestFnText(): string {
  const fn = ingestFn();
  return fn.getSourceFile().text.slice(fn.getStart(), fn.end);
}
const keyOf = (fnText: string) => ingestKey(findFunction(parseTs(fnText, "the edited ingest copy"), FN));
// A compared function must also be code the runtime loads: the parser builds a
// tree for some code only its checker (and Deno) refuses (mirror-ast.ts).
async function setupLoads(fn: ts.FunctionDeclaration | string, label: string): Promise<void> {
  const text = typeof fn === "string" ? fn : fn.getSourceFile().text.slice(fn.getStart(), fn.end);
  const why = await runtimeRejects(text);
  setup(why === null, `${label} does not load: ${why}`);
}
const sameKey = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

// The tree locators of these tests, in one place. Each looks through erased
// TypeScript wrappers and grouping parentheses with mirror-ast.ts's skipErased,
// the policy astKey itself uses, so a type change the comparison accepts can
// never make a locator miss its site (Codex re-review 3, R4-1: `return true as
// boolean` used to fail the line-break test's `TrueKeyword` prerequisite).
function returnsTrue(fn: ts.Node): ts.ReturnStatement[] {
  return findAll(fn, ts.isReturnStatement).filter((r) => r.expression !== undefined && skipErased(r.expression).kind === ts.SyntaxKind.TrueKeyword);
}
// The open-item filter's "open" literal: the second argument of a
// `.eq("status", "open")` call.
function openFilterLiterals(fn: ts.Node): ts.StringLiteral[] {
  return findAll(fn, ts.isCallExpression).flatMap((c) => {
    const callee = skipErased(c.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "eq" || c.arguments.length !== 2) return [];
    const [k, v] = c.arguments.map((a) => skipErased(a));
    return ts.isStringLiteral(k) && k.text === "status" && ts.isStringLiteral(v) && v.text === "open" ? [v] : [];
  });
}
function callsTo(fn: ts.Node, name: string): ts.CallExpression[] {
  return findAll(fn, ts.isCallExpression).filter((c) => {
    const callee = skipErased(c.expression);
    return ts.isIdentifier(callee) && callee.text === name;
  });
}
// The order facts of the order test: the gate after the appointment guard and
// before the dedup, the insert selected after the dedup, the suspects recorded
// after the insert. treeFind matches by key, so it shares the same policy.
function orderFacts(fn: ts.Node, client: string) {
  const at = (needle: string) => treeFind(fn, needle).at;
  const guard = at("isUnanchoredAppointmentItem(row.description, content, new Date())");
  const gate = at(`await applyFragmentGate(${client}, thoughtId, guarded)`);
  const dedup = at("!existingNormalized.has(normalizeActionText(row.description))");
  const insertFound = treeFind(fn, `${client}.from("action_items").insert(rows)`);
  const selectFound = treeFind(fn, `${client}.from("action_items").insert(rows).select("id, description")`);
  const insert = insertFound.at, select = selectFound.at;
  const suspects = callsTo(fn, "recordPronounSuspects")[0]?.getStart() ?? -1;
  // insert(rows) is the inner call of .select(...), by structure: the select
  // call applies to the insert call, through any erased wrapper around it
  // (not by offset: a wrapper moves the select call's first token).
  const selectCall = selectFound.nodes[0] as ts.CallExpression | undefined;
  const selectCallee = selectCall === undefined ? undefined : skipErased(selectCall.expression);
  const selectsInsert = selectCallee !== undefined && ts.isPropertyAccessExpression(selectCallee) &&
    selectFound.count === 1 && insertFound.count === 1 && skipErased(selectCallee.expression) === insertFound.nodes[0];
  const pos = { guard, gate, dedup, insert, select, suspects };
  return {
    pos,
    missing: Object.entries(pos).filter(([, v]) => v < 0).map(([k]) => k),
    ordered: guard < gate && gate < dedup && insert < suspects,
    selectedAfterDedup: dedup < insert && selectsInsert,
    gateCalls: callsTo(fn, "applyFragmentGate").length,
    suspectCalls: callsTo(fn, "recordPronounSuspects").length,
  };
}

// Loop-closing Task 5.2's order facts, found by tree shape like orderFacts:
// the batch-local exact dedup is a filter AFTER the open-item dedup; the
// semantic candidates are read after it and BEFORE the insert (so every
// candidate is older than the inserted rows); the exact_batch rows and the
// semantic proposals are written after the insert and after the suspects.
function dedupOrderFacts(fn: ts.Node, client: string) {
  const at = (needle: string) => treeFind(fn, needle).at;
  const first = (name: string) => callsTo(fn, name)[0]?.getStart() ?? -1;
  const pos = {
    openDedup: at("!existingNormalized.has(normalizeActionText(row.description))"),
    batchKeep: at("batch.keep(row.description)"),
    candidates: at(`loadSemanticCandidates(${client})`),
    insert: at(`${client}.from("action_items").insert(rows)`),
    suspects: first("recordPronounSuspects"),
    batchRows: at(`recordBatchDuplicates(${client}, thoughtId, batch.duplicates, inserted, normalizeActionText)`),
    proposals: at(`proposeSemanticDuplicates(${client}, recent, thoughtId, metadata.project, inserted)`),
  };
  return {
    missing: Object.entries(pos).filter(([, v]) => v < 0).map(([k]) => k),
    ordered: pos.openDedup < pos.batchKeep && pos.batchKeep < pos.candidates && pos.candidates < pos.insert &&
      pos.insert < pos.suspects && pos.suspects < pos.batchRows && pos.batchRows < pos.proposals,
    calls: ["createBatchDedup", "loadSemanticCandidates", "recordBatchDuplicates", "proposeSemanticDuplicates"].map((n) => callsTo(fn, n).length),
  };
}

Deno.test("mirror 5.1: the two extractAndStoreActionItems bodies are the same code apart from the listed names", async () => {
  // Layout, comments and types may differ (deno fmt wraps the two files
  // differently); the syntax tree, and every literal value, may not.
  const sf = sharedFn(), inf = ingestFn();
  await setupLoads(sf, "the shared copy");
  await setupLoads(inf, "the ingest copy");
  const a = sharedKey(sf);
  const b = ingestKey(inf);
  claim("mirror-body", a, b, "the two bodies' syntax trees differ");
});

// Snippets for the comparison's own tests, each parsed inside an async
// generator so that return, await and yield are all legal.
const wrap = (s: string) => `async function* probe() {\n${s}\n}`;
const snippetKey = (s: string) => astKey(parseTs(wrap(s), "snippet"));
const snippetsSame = (a: string, b: string) => sameKey(snippetKey(a), snippetKey(b));
// What the snippet does, by V8's own parser (new Function), independent of the
// TypeScript parser: the value it returns, or the error it throws.
function runs(s: string): string {
  try {
    return JSON.stringify(new Function(s)()) ?? "undefined";
  } catch (e) {
    return `throws ${(e as Error).name}`;
  }
}

// Every case Codex has raised against the comparison, in three reviews, plus
// the earlier unit cases. [a, b, executable by new Function?]
const MUST_DIFFER: Array<[string, string, boolean]> = [
  // review 1, F2: whitespace inside a literal.
  ['return "status" + "open";', 'return "status" + "op en";', true],
  ["return 'open';", "return 'op en';", true],
  ["const x = 1; return `dropped item: ${x}`;", "const x = 1; return `dropped  item: ${x}`;", true],
  ["return /a b/.test('a b');", "return /ab/.test('a b');", true],
  ['return "say \\"hi there\\"";', 'return "say \\"hithere\\"";', true],
  // re-review 1, R2: a line break after return, bare, in a block comment, in a
  // line comment, before a template.
  ["return true;", "return\n  true;", true],
  ["return /* x */ true;", "return /* x\n */ true;", true],
  ["return true;", "return // note\n  true;", true],
  ["return true;", "return\r\n  true;", true],
  ["return `x`;", "return\n`x`;", true],
  // re-review 2, N2: a line break before ++ after a non-ASCII identifier and
  // after TypeScript's postfix non-null (the latter is TypeScript, so not
  // executable here; the sweep proves it with the ingest probe).
  ["let 数 = 0; let 値 = 0; 数\n++値; return [数, 値];", "let 数 = 0; let 値 = 0; 数++\n値; return [数, 値];", true],
  ["let count = 0; let step = 0; count!\n++step; return step;", "let count = 0; let step = 0; count!++\nstep; return step;", false],
  ["let a = 1, b = 1; a\n++b; return [a, b];", "let a = 1, b = 1; a++\nb; return [a, b];", true],
  ["let a = 1, b = 1; a\n--b; return [a, b];", "let a = 1, b = 1; a--\nb; return [a, b];", true],
  // re-review 2, kin of 35-regex: regular-expression source.
  ["let hit = false; if (true) /^a +$/.test('a ') && (hit = true); return hit;", "let hit = false; if (true) /^a+$/.test('a ') && (hit = true); return hit;", true],
  // Operators, declarations and optional chains.
  ["let a = 1, b = 2; return a + ++b;", "let a = 1, b = 2; return a++ + b;", true],
  ["let a = 3, b = 2; return a - -b;", "let a = 3, b = 2; return a-- - b;", true],
  ["const total = 12, count = 3; return total / count / 2;", "const total = 12, count = 3; return total / count / 3;", true],
  ["let x = 1; { let x = 2; } return x;", "let x = 1; { x = 2; } return x;", true],
  // The declaration kind and the operator are values of a node, not children.
  ["let x = 1; x = 2; return x;", "const x = 1; x = 2; return x;", true],
  ["{ var v = 1; } return typeof v;", "{ let v = 1; } return typeof v;", true],
  ["let a = 1; a++; return a;", "let a = 1; a--; return a;", true],
  ["let a = 1; return -a;", "let a = 1; return +a;", true],
  ["let a = 1; return !a;", "let a = 1; return ~a;", true],
  ["const o = null; return (o?.a).b;", "const o = null; return o?.a.b;", true],
  ["let n = 0; for (let i = 5; i < 2;) { n++; break; } return n;", "let n = 0; for (let i = 5; ; i < 2) { n++; break; } return n;", true],
  ["const x = 1; let y = x\n(2); return y;", "const x = 1; let y = x;\n(2); return y;", true],
  ["yield value;", "yield\nvalue;", false],
  ["break outer;", "break\nouter;", false],
  ["continue outer;", "continue\nouter;", false],
];

const MUST_MATCH: Array<[string, string, boolean]> = [
  // Layout and comment wording.
  ["const a = [1, 2].map((v) => v * 2); return a;", "const a = [1, 2]\n  .map((v) =>\n    v * 2\n  );\n\n\nreturn a;", true],
  ["return 1; // one comment\n/* block */", "return 1; // another", true],
  ["const o = {\n  a: 1,\n  b: 2\n};\nreturn o;", "const o = { a: 1, b: 2 }; return o;", true],
  ["return {\n  a: 1\n};", "return { a: 1 };", true],
  ["const x = 1; return (\n  x\n);", "const x = 1; return (x);", true],
  ["const a = 1, b = 0; if (\n  a &&\n  !b\n) {\n  return 1;\n}\nreturn 0;", "const a = 1, b = 0; if (a && !b) { return 1; } return 0;", true],
  ["const x = { return: () => 7 }; return x.return\n  .call(null);", "const x = { return: () => 7 }; return x.return.call(null);", true],
  ["const x = 2; return `a${\n  x\n}b`;", "const x = 2; return `a${x}b`;", true],
  ["return true; /* a\n b */", "return true;", true],
  ["let a = 1; /* one\n two */ a = 2; return a;", "let a = 1; a = 2; return a;", true],
  // re-review 2, N3: a comment holding a line break before an empty return's
  // semicolon; a space before a semicolon; a comment and spaces inside a member
  // call; the property-name and template-expression wrappings (33, 34).
  ["return /* explanation\n*/;", "return;", true],
  ["return true ;", "return true;", true],
  ['const s = { eq: (a, b) => a + b }; return s . /* lookup */ eq ("status", "open");', 'const s = { eq: (a, b) => a + b }; return s.eq("status", "open");', true],
  ["const probe = { return\n  : true }; return probe.return;", "const probe = { return: true }; return probe.return;", true],
  ['return `captured ${ /}/.test("}") }`;', 'return `captured ${/}/.test( "}" )}`;', true],
  // What deno fmt does: quotes, trailing commas when it wraps.
  ["return 'a';", 'return "a";', true],
  ["return Math.max(\n  1,\n  2,\n);", "return Math.max(1, 2);", true],
  ["const o = { a: 1, }; return o;", "const o = { a: 1 }; return o;", true],
  // Types are erased at runtime (TypeScript; not executable here).
  ["const e: string[] | null = null; return ((e || []) as Array<{ d: string }>).map((i) => i);", "const e = null; return (e || []).map((i) => i);", false],
  ["function g(db: any): void {} return g;", "function g(db: ActionItemDb): Promise<void> {} return g;", false],
  ["let x!: number; const y = x!; return y satisfies number;", "let x: number; const y = x; return y;", false],
];

// Fail to parse (by V8 as well): refused as a setup error, never compared.
const UNPARSEABLE = [
  "const f = async\n(x) => x;",
  "const f = (x)\n=> x;",
  "const f = (x) /* c\n */ => x;",
  "return )",
  "throw\nerr;",
];

Deno.test("mirror 5.1: the tree comparison keeps literal values and every line break that changes the parse, and drops layout, comments and types", () => {
  for (const [a, b, executable] of MUST_DIFFER) {
    claim("ast-differ", snippetsSame(a, b), false, `should differ: ${JSON.stringify(a)} | ${JSON.stringify(b)}`);
    // The difference is real: V8 runs the two differently.
    if (executable) assert(runs(a) !== runs(b), `V8 should run these differently: ${JSON.stringify(a)} | ${JSON.stringify(b)}: ${runs(a)}`);
  }
  for (const [a, b, executable] of MUST_MATCH) {
    claim("ast-same", snippetsSame(a, b), true, `should compare equal: ${JSON.stringify(a)} | ${JSON.stringify(b)}`);
    if (executable) assertEquals(runs(a), runs(b), `V8 should run these the same: ${JSON.stringify(a)} | ${JSON.stringify(b)}`);
  }
  for (const bad of UNPARSEABLE) {
    let refused = "";
    try {
      snippetKey(bad);
    } catch (e) {
      refused = (e as Error).message;
    }
    claim("ast-refuses-unparseable", refused.startsWith("setup: snippet does not parse"), true, `should be refused: ${JSON.stringify(bad)} (${refused})`);
    assert(runs(bad).startsWith("throws SyntaxError"), `V8 also rejects ${JSON.stringify(bad)}`);
  }
});

// The comparison against V8 on every possible single line break: in each
// snippet, at EVERY gap between two tokens, a line break (bare, and inside a
// block comment) is inserted. Wherever the tree comparison says "same tree",
// V8 must run the edited snippet exactly as the original. (Where it says
// "different", it may be conservative: no claim either way.) This is how the
// arrow-function rule (TS1200, enforced by TypeScript's checker, not its
// parser) was found and added to parseTs.
const LAYOUT_CORPUS = [
  "let a = 1, b = 1; a\n++b; return [a, b];",
  "let 数 = 0; let 値 = 0; 数\n++値; return [数, 値];",
  "const f = (x) => x * 2; return f(3);",
  "const f = async (x) => x; return typeof f;",
  "const g = async function () { return 1; }; return typeof g;",
  "const o = { get x() { return 1; }, set y(v) {}, static: 2, async: 3, get: 4 }; return [o.x, o.static, o.async, o.get];",
  "class C { static x = 1; get y() { return 2; } static async z() { return 3; } } return [C.x, new C().y];",
  "let r = 0; outer: for (const i of [1, 2]) { for (const j of [1, 2]) { if (j === 2) continue outer; r += i * j; } } return r;",
  "function* gen() { yield 1; yield* [2, 3]; } return [...gen()];",
  "let x = 5; x--; --x; return x;",
  "const s = `a${1 + 1}b`; return s;",
  "const re = /a+/g; return 'aa a'.match(re);",
  "let t = 1; t = t / 2 / 1; return t;",
  "const a = [1, 2, 3]; return a.filter((v) => v > 1).map((v) => v * 2);",
  "try { throw new Error('x'); } catch (e) { return e.message; }",
  "let n = null; return n ?? 'd';",
  "const o = { a: { b: 1 } }; return o?.a?.b;",
  "let i = 0; do { i++; } while (i < 3); return i;",
  "var v = 1; if (v) { return 'yes'; } else { return 'no'; }",
  "let q = 1; q += 2; q **= 2; return q;",
  "const f = function named() { return named.name; }; return f();",
  "let a = 1; let b = 2; [a, b] = [b, a]; return [a, b];",
  "const {p, q: r = 3} = {p: 1}; return [p, r];",
  "label: { break label; } return 1;",
  "return void 0;",
  "let x = 1; const f = (v) => v + 1; x = f\n(2); return x;",
  "const items = ['a', '']; return items.filter((row) => { if (row === '') { return false; } return true; });",
];

Deno.test("mirror 5.1: a line break at any token gap leaves the tree unchanged only where V8 runs the code the same", () => {
  const problems: string[] = [];
  let unchanged = 0;
  for (const s of LAYOUT_CORPUS) {
    const base = snippetKey(s);
    const before = runs(s);
    const gaps: number[] = [];
    editLayout(s, (g) => {
      gaps.push(g.index);
      return g.text;
    }, "corpus snippet");
    for (const k of gaps) {
      for (const brk of ["\n", " /* c\n */ "]) {
        let edited: string;
        try {
          edited = editLayout(s, (g) => (g.index === k ? g.text + brk : g.text), "corpus snippet");
        } catch {
          continue; // the edit does not parse: refused, not compared
        }
        let key: string[];
        try {
          key = snippetKey(edited);
        } catch {
          continue;
        }
        if (!sameKey(key, base)) continue;
        unchanged++;
        if (runs(edited) !== before) problems.push(`${JSON.stringify(edited)}: ${before} became ${runs(edited)}`);
      }
    }
  }
  setup(unchanged > 500, `the corpus exercised ${unchanged} unchanged-tree line breaks`);
  claim("ast-agrees-with-v8", problems, [], "a line break the tree comparison calls layout changes what V8 runs");
});

// ---------------------------------------------------------------------------
// Parentheses and erased type wrappers (Codex re-review 3, R4-1).
// ---------------------------------------------------------------------------

// What a snippet does, with the error's message as well as its name: V8 (new
// Function, sloppy script code) for JavaScript, and Deno's own TypeScript
// transpiler (a data: module, strict, exactly the path a .ts file takes) for
// TypeScript. A location in a load-time message is dropped: the edited text's
// columns differ.
function outcome(s: string): string {
  try {
    return JSON.stringify(new Function(s)()) ?? "undefined";
  } catch (e) {
    return `throws ${(e as Error).name}: ${(e as Error).message}`;
  }
}
// What a TypeScript snippet does in V8 after the TypeScript compiler's own type
// erasure (transpileModule, sloppy script code): unlike Deno's transpiler, it
// keeps grouping parentheses, so this is how V8 runs a body tsc emitted. The
// parenthesis rows for statements the key erases (Codex re-review 5, R6-1)
// need it: V8 cannot read a type alias, and Deno drops the grouping.
function outcomeAfterTsc(s: string): string {
  const js = ts.transpileModule(s, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, alwaysStrict: false } }).outputText;
  return outcome(js);
}
// V8's verdict on the snippet's syntax alone (new Function compiles, never runs).
function v8Rejects(s: string): string | null {
  try {
    new Function(s);
    return null;
  } catch (e) {
    return `${(e as Error).name}: ${(e as Error).message}`;
  }
}
const asModule = (s: string) => `export function probe() {\n${s}\n}\n`;
async function runsTs(s: string): Promise<string> {
  const loaded = await loadTs(asModule(s));
  if (!loaded.ok) return `refused: ${loaded.error}`;
  const probe = loaded.module.probe as () => unknown;
  try {
    return JSON.stringify(probe()) ?? "undefined";
  } catch (e) {
    return `throws ${(e as Error).name}: ${(e as Error).message}`;
  }
}

// [a, b]: the two must key DIFFERENTLY, and run differently (V8). Every
// grouping the language can observe: an optional-chain boundary (recorded as
// the OptionalChain flag), function naming through a bare identifier target
// (only when an anonymous function, arrow or class is assigned, looked for
// through the value's own parentheses), a directive (only inside a directive
// prologue, where a grouped string also ends the prologue), `this` through a
// comma, `new` with or without the call, precedence and associativity, a
// comma list, an arrow's object body.
const PAREN_DIFFER: Array<[string, string]> = [
  ["const o = null; return (o?.a).b;", "const o = null; return o?.a.b;"],
  ["const o = null; return (o?.f)();", "const o = null; return o?.f();"],
  ["const o = null; return (o?.a)[0];", "const o = null; return o?.a[0];"],
  ["const o = { a: null }; return (o.a?.b).c;", "const o = { a: null }; return o.a?.b.c;"],
  ["let a; (a) = function () {}; return a.name;", "let a; a = function () {}; return a.name;"],
  ["let a; ((a)) = () => 1; return a.name;", "let a; a = () => 1; return a.name;"],
  ["let a; (a) ??= () => 1; return a.name;", "let a; a ??= () => 1; return a.name;"],
  ["let a = 0; (a) ||= class {}; return a.name;", "let a = 0; a ||= class {}; return a.name;"],
  ["let a = 1; (a) &&= function () {}; return a.name;", "let a = 1; a &&= function () {}; return a.name;"],
  ["let a; [(a) = function () {}] = []; return a.name;", "let a; [a = function () {}] = []; return a.name;"],
  ["let a; ({ x: (a) = function () {} } = {}); return a.name;", "let a; ({ x: a = function () {} } = {}); return a.name;"],
  // Codex re-review 4, R5-1: what the narrowed naming rule must still catch.
  ["let a; (a) = () => 1; return a.name;", "let a; a = () => 1; return a.name;"],
  ["let a; (a) = class {}; return a.name;", "let a; a = class {}; return a.name;"],
  ["let a; (a) = async function* () {}; return a.name;", "let a; a = async function* () {}; return a.name;"],
  ["let a; (a) = (function () {}); return a.name;", "let a; a = (function () {}); return a.name;"],
  ["let a; [(a) = (() => 1)] = []; return a.name;", "let a; [a = (() => 1)] = []; return a.name;"],
  ['function f() { ("use strict"); return typeof this; } return f();', 'function f() { "use strict"; return typeof this; } return f();'],
  ["function f(a = 1) { ('use strict'); return a; } return f();", "function f(a = 1) { 'use strict'; return a; } return f();"],
  // R5-1: what the narrowed directive rule must still catch. A grouped string
  // ends the prologue, so the "use strict" after it is not a directive; a
  // grouped "use strict" after a directive is not one; a method body has a
  // prologue too.
  ['function f() { ("x"); "use strict"; return typeof this; } return f();', 'function f() { "x"; "use strict"; return typeof this; } return f();'],
  ['function f() { "x"; ("use strict"); return typeof this; } return f();', 'function f() { "x"; "use strict"; return typeof this; } return f();'],
  ['const o = { m() { ("use strict"); return typeof this; } }; return o.m.call(undefined);', 'const o = { m() { "use strict"; return typeof this; } }; return o.m.call(undefined);'],
  ["const o = { f() { return this === o; } }; return (0, o.f)();", "const o = { f() { return this === o; } }; return o.f();"],
  ["function F() { return function G() {}; } return typeof new (F());", "function F() { return function G() {}; } return typeof new F();"],
  ["const a = 1, b = 2, c = 3; return (a + b) * c;", "const a = 1, b = 2, c = 3; return a + b * c;"],
  ["const a = 8, b = 4, c = 2; return a - (b - c);", "const a = 8, b = 4, c = 2; return a - b - c;"],
  ["const a = 2, b = 3, c = 2; return (a ** b) ** c;", "const a = 2, b = 3, c = 2; return a ** b ** c;"],
  ["const a = 0, b = 0, c = 5; return (a ?? b) || c;", "const a = 0, b = 0, c = 5; return a ?? (b || c);"],
  ["const c = 1, o = { x: 5 }, p = { x: 6 }; return (c ? o : p).x;", "const c = 1, o = { x: 5 }, p = { x: 6 }; return c ? o : p.x;"],
  ["const a = 1, b = 0; return !(a && b);", "const a = 1, b = 0; return !a && b;"],
  ["const x = 'a'; return typeof (x + 1);", "const x = 'a'; return typeof x + 1;"],
  ["const f = (...v) => v.length; return f((1, 2));", "const f = (...v) => v.length; return f(1, 2);"],
  ["const f = () => ({}); return typeof f();", "const f = () => {}; return typeof f();"],
];
// The same, in TypeScript, run through Deno's transpiler: an erased wrapper
// does not move the chain boundary.
const PAREN_DIFFER_TS: Array<[string, string]> = [
  ["const o: any = null; return (o?.a as any).b;", "const o: any = null; return o?.a.b;"],
  ["const o: any = null; return (o?.f as any)();", "const o: any = null; return o?.f();"],
  ["const o: any = null; return (o?.a)!.b;", "const o: any = null; return o?.a!.b;"],
];
// [a, b]: the two must key ALIKE, and run alike: grouping that only repeats
// what the tree's shape already says, and grouping that exists only for an
// erased type (V8 for the JavaScript rows).
const PAREN_SAME: Array<[string, string]> = [
  ["const x = 1; return ((x));", "const x = 1; return x;"],
  ["const f = (function () {}); return f.name;", "const f = function () {}; return f.name;"],
  ["const o = { f() { return this === o; } }; return (o.f)();", "const o = { f() { return this === o; } }; return o.f();"],
  ["const o = { t() { return this === o; } }; return (o.t)`x`;", "const o = { t() { return this === o; } }; return o.t`x`;"],
  ["const o = { a: null }; return (o?.a)?.b;", "const o = { a: null }; return o?.a?.b;"],
  ["const o = { a: 1 }; delete (o.a); return o;", "const o = { a: 1 }; delete o.a; return o;"],
  ["return typeof (undeclaredZz);", "return typeof undeclaredZz;"],
  ["let x = 5; return (eval)('x');", "let x = 5; return eval('x');"],
  ["function F() { this.k = 1; } const m = { F }; return new (m.F)().k;", "function F() { this.k = 1; } const m = { F }; return new m.F().k;"],
  ["const a = 1, b = 2, c = 3; return a + (b * c);", "const a = 1, b = 2, c = 3; return a + b * c;"],
  ["const a = 8, b = 4, c = 2; return (a - b) - c;", "const a = 8, b = 4, c = 2; return a - b - c;"],
  ["let a; (a) += 1; return a;", "let a; a += 1; return a;"],
  ["const o = { a: 1 }; (o.a) = function () {}; return o.a.name;", "const o = { a: 1 }; o.a = function () {}; return o.a.name;"],
  ["return (function () { return 1; })();", "return (function () { return 1; }());"],
  ["const s = ('use strict'); return s;", "const s = 'use strict'; return s;"],
  // Codex re-review 4, R5-1: grouping the two rules do NOT reach. A target
  // assigned anything but an anonymous function definition (a value, a comma
  // expression, a named function or class); the value's own parentheses; an
  // object shorthand default (its target cannot be grouped).
  ["let a; (a) = [1]; return a;", "let a; a = [1]; return a;"],
  ["let a; (a) = (0, function () {}); return a.name;", "let a; a = (0, function () {}); return a.name;"],
  ["let a; (a) = function named() {}; return a.name;", "let a; a = function named() {}; return a.name;"],
  ["let a; (a) = class K {}; return a.name;", "let a; a = class K {}; return a.name;"],
  ["let a; a = (() => 1); return a.name;", "let a; a = () => 1; return a.name;"],
  ["let a; ({ a = (function () {}) } = {}); return a.name;", "let a; ({ a = function () {} } = {}); return a.name;"],
  // A string statement outside a directive prologue: after a declaration
  // (Codex's pair), after a prologue a grouped string already ended, inside a
  // nested block.
  ["let n = 2; ('reviewer'); return n;", "let n = 2; 'reviewer'; return n;"],
  ['function f() { let k = 0; ("use strict"); return typeof this; } return f();', 'function f() { let k = 0; "use strict"; return typeof this; } return f();'],
  ['function f() { ("x"); ("use strict"); return typeof this; } return f();', 'function f() { ("x"); "use strict"; return typeof this; } return f();'],
  ['function f() { if (true) { ("use strict"); } return typeof this; } return f();', 'function f() { if (true) { "use strict"; } return typeof this; } return f();'],
];
// The same, in TypeScript, run through Deno's transpiler. The first two are
// Codex re-review 3's real-body edits (52, 53).
const PAREN_SAME_TS: Array<[string, string]> = [
  ["const items = [1]; if ((items as typeof items).length === 0) return 0; return 1;", "const items = [1]; if (items.length === 0) return 0; return 1;"],
  ["return [1, 2].filter(() => { return true as boolean; });", "return [1, 2].filter(() => { return true; });"],
  ["const o: any = null; return (o?.a as any).b;", "const o: any = null; return (o?.a).b;"],
  ["const o: any = { a: null }; return o?.a!.b;", "const o: any = { a: null }; return o?.a.b;"],
  ["const o: any = { a: null }; return (o?.a)!.b;", "const o: any = { a: null }; return (o?.a).b;"],
  ["const o = { f() { return this === o; } }; return (o.f as () => boolean)();", "const o = { f() { return this === o; } }; return o.f();"],
  ["const o = { f() { return this === o; } }; return (<() => boolean>o.f)();", "const o = { f() { return this === o; } }; return o.f();"],
  ["const x = 2; return ((x satisfies number) as number) ** 2;", "const x = 2; return x ** 2;"],
  ["const e: string[] | null = null; return ((e || []) as string[]).length;", "const e: string[] | null = null; return (e || []).length;"],
  ["const id = <T,>(v: T) => v; const f = id<number>; return f(3);", "const id = (v) => v; const f = id; return f(3);"],
  ["let a: any; a! = function () {}; return a.name;", "let a: any; a = function () {}; return a.name;"],
  // Codex re-review 4, R5-1: its case 79 (a definite-assignment marker and a
  // typed assignment target), its case 78 (both receivers non-null), and an
  // erased wrapper on an anonymous function value (Deno names it either way).
  ["let items!: unknown[]; (items as unknown[]) = [1]; return items;", "let items: unknown[]; items = [1]; return items;"],
  ["const items = [1]; if ((items!).length === 0) return 0; return (items!).length;", "const items = [1]; if (items.length === 0) return 0; return items.length;"],
  ["let a: any; a = (function () {}) as any; return a.name;", "let a: any; a = function () {}; return a.name;"],
  ["let a: any; (a) = [1] as unknown[]; return a;", "let a: any; a = [1]; return a;"],
];
// Codex re-review 5, R6-1: a statement the key erases (a type alias, an
// interface; isTypeOnlyStatement) neither ends a directive prologue nor counts
// in it, so a grouped string after one still stands where a directive would.
// Run in V8 after the TypeScript compiler's erasure (outcomeAfterTsc), which
// keeps the grouping. Must key differently and run differently: an erased
// declaration between an ordinary directive and the grouped string.
const PAREN_DIFFER_TSC: Array<[string, string]> = [
  ['function f() { "x"; type T = number; ("use strict"); return typeof this; } return f();', 'function f() { "x"; type T = number; "use strict"; return typeof this; } return f();'],
  ['function f() { "x"; interface I { v: number } ("use strict"); return typeof this; } return f();', 'function f() { "x"; interface I { v: number } "use strict"; return typeof this; } return f();'],
];
// Must key alike and run alike (V8 after tsc, and Deno): Codex's 87 and 88 (an
// erased declaration added before an already-grouped string), the same between
// an ordinary directive and a grouped string, and before an ordinary
// directive; and the two terminators that still end the prologue after an
// erased declaration, an executable statement and a grouped string.
const PAREN_SAME_TSC: Array<[string, string]> = [
  ['function f() { type ReviewMarker = number; ("reviewer marker"); return typeof this; } return f();', 'function f() { ("reviewer marker"); return typeof this; } return f();'],
  ['function f() { interface ReviewMarker { value: number } ("reviewer marker"); return typeof this; } return f();', 'function f() { ("reviewer marker"); return typeof this; } return f();'],
  ['function f() { "reviewer ordinary"; type ReviewMarker = number; ("reviewer marker"); return typeof this; } return f();', 'function f() { "reviewer ordinary"; ("reviewer marker"); return typeof this; } return f();'],
  ['function f() { type ReviewMarker = number; "use strict"; return typeof this; } return f();', 'function f() { "use strict"; return typeof this; } return f();'],
  ['function f() { type T = number; let k = 0; ("use strict"); return typeof this; } return f();', 'function f() { type T = number; let k = 0; "use strict"; return typeof this; } return f();'],
  ['function f() { type T = number; ("x"); ("use strict"); return typeof this; } return f();', 'function f() { type T = number; ("x"); "use strict"; return typeof this; } return f();'],
];
// Kept in the key although Deno's transpiler drops the parenthesis (it runs
// the two alike): a parenthesis the language can observe is kept even around
// an erased wrapper. Conservative: a false FAIL only, on code nobody writes.
const PAREN_CONSERVATIVE_TS: Array<[string, string]> = [
  ["let a: any; (a as any) = function () {}; return a.name;", "let a: any; a = function () {}; return a.name;"],
  ["let a: any; (a) = function () {}; return a.name;", "let a: any; a = function () {}; return a.name;"],
  ["let a: any; (a) = (function () {}) as any; return a.name;", "let a: any; a = function () {}; return a.name;"],
  ["function f(a = 1) { ('use strict' as string); return a; } return f();", "function f(a = 1) { 'use strict'; return a; } return f();"],
];
// R6-1, kept the same way: a grouped string after a LEADING erased declaration
// is in the prologue. V8 after tsc observes it (the bare form's directive in a
// function with a non-simple parameter list is an early error; the grouped
// form returns 1); Deno drops the grouping and refuses both.
const PAREN_CONSERVATIVE_TSC: Array<[string, string]> = [
  ["function f(a = 1) { type T = number; ('use strict'); return a; } return f();", "function f(a = 1) { type T = number; 'use strict'; return a; } return f();"],
  ["function f(a = 1) { interface I { v: number } ('use strict'); return a; } return f();", "function f(a = 1) { interface I { v: number } 'use strict'; return a; } return f();"],
];

Deno.test("mirror 5.1: parentheses the language can observe stay distinct, and parentheses that only group an erased type compare equal", async () => {
  // JavaScript rows run in V8, TypeScript rows through Deno's transpiler.
  // TypeScript rows through Deno's transpiler ("deno"), or in V8 after the
  // TypeScript compiler's erasure ("tsc").
  type Mode = "v8" | "deno" | "tsc";
  const tag = (rows: Array<[string, string]>, mode: Mode) => rows.map(([a, b]) => [a, b, mode] as const);
  const run = async (s: string, mode: Mode) => mode === "deno" ? await runsTs(s) : mode === "tsc" ? outcomeAfterTsc(s) : outcome(s);
  const runner = (mode: Mode) => mode === "deno" ? "Deno" : mode === "tsc" ? "V8 after tsc" : "V8";
  for (const [a, b, mode] of [...tag(PAREN_DIFFER, "v8"), ...tag(PAREN_DIFFER_TS, "deno"), ...tag(PAREN_DIFFER_TSC, "tsc")]) {
    claim("paren-differ", snippetsSame(a, b), false, `should differ: ${JSON.stringify(a)} | ${JSON.stringify(b)}`);
    assert(await run(a, mode) !== await run(b, mode), `${runner(mode)} should run these differently: ${JSON.stringify(a)} | ${JSON.stringify(b)}`);
  }
  for (const [a, b, mode] of [...tag(PAREN_SAME, "v8"), ...tag(PAREN_SAME_TS, "deno"), ...tag(PAREN_SAME_TSC, "tsc")]) {
    claim("paren-same", snippetsSame(a, b), true, `should compare equal: ${JSON.stringify(a)} | ${JSON.stringify(b)}`);
    assertEquals(await run(a, mode), await run(b, mode), `${runner(mode)} should run these the same: ${JSON.stringify(a)} | ${JSON.stringify(b)}`);
    if (mode === "tsc") assertEquals(await runsTs(a), await runsTs(b), `Deno should run these the same: ${JSON.stringify(a)} | ${JSON.stringify(b)}`);
  }
  for (const [a, b] of [...PAREN_CONSERVATIVE_TS, ...PAREN_CONSERVATIVE_TSC]) {
    assert(!snippetsSame(a, b), `kept, conservatively: ${JSON.stringify(a)} | ${JSON.stringify(b)}`);
    assertEquals(await runsTs(a), await runsTs(b), `Deno drops this parenthesis: ${JSON.stringify(a)} | ${JSON.stringify(b)}`);
  }
  for (const [a, b] of PAREN_CONSERVATIVE_TSC) {
    assert(outcomeAfterTsc(a) !== outcomeAfterTsc(b), `V8 after tsc should observe this parenthesis: ${JSON.stringify(a)} | ${JSON.stringify(b)}`);
  }
});

// The comparison against the runtime on every possible single wrapping: in each
// snippet, EVERY node is wrapped in parentheses, and in `( ... as any)`, and
// every parenthesis is removed. Wherever the edit parses and the tree
// comparison says "same tree", the code must run exactly as the original: V8
// for the parenthesis edits, Deno's transpiler for the type assertion. (Where
// it says "different", it may be conservative: no claim either way.)
const PAREN_CORPUS = [
  ...LAYOUT_CORPUS,
  "let a; a = function () {}; let b = 0; b ||= () => 1; let c; c ??= class {}; let d = 1; d &&= function () {}; return [a.name, b.name, c.name, d.name];",
  "let a; [a = function () {}] = []; let b; ({ x: b = () => 1 } = {}); return [a.name, b.name];",
  "function f() { 'use strict'; return typeof this; } function g() { 'use strict'; 'other'; return typeof this; } return [f(), g()];",
  "const o = null; const p = { a: null, f() { return this === p; } }; return [o?.a.b, o?.f(), o?.a[0], p.a?.b.c, p?.a?.b, p.f(), p?.f()];",
  "const o = { f() { return this === o; }, t() { return this === o; } }; return [o.f(), o['f'](), o.t`x`, (0, o.f)()];",
  "function F() { this.k = 1; } function G() { return F; } const m = { F }; return [new F().k, new m.F().k, typeof new G(), typeof G()];",
  "const a = 2, b = 3, c = 4; return [a + b * c, a - b - c, a ** b ** 2, (-a) ** 2, a * (b + c), !a && b, typeof a + b];",
  "const a = 0, b = 0, c = 5, d = null; return [(a ?? b) || c, a || b && c, d ?? c, c ? a : b, a, b];",
  "let x = 5; const o = { a: 1, b: 2 }; delete o.a; return [eval('x'), o, typeof undeclaredZz, void 0, (1, 2)];",
  "const f = (x) => ({ x }); const g = async () => 1; const h = function () { return 1; }; return [f(1), typeof g, h.name, (function () { return 2; })()];",
  "let i = 0; const arr = [1, 2]; arr[i++] += 10; const s = 'use strict'; return [arr, i, s];",
  // Codex re-review 4, R5-1: targets assigned values, a comma expression, a
  // named function; string statements in and out of a prologue.
  "let a; a = [1]; let b; b = (function () {}); let c; c = (0, function () {}); let d; d = function named() {}; let e = 0; e ||= [2]; let f; [f = 3] = []; return [a, b.name, c.name, d.name, e, f];",
  "let n = 2; 'late'; function h() { 'a'; 'use strict'; 'b'; return typeof this; } function k() { let z = 0; 'use strict'; return typeof this; } return [n, h(), k()];",
  "const x = (1 + 2) * 3, y = (x), z = ((x)); const o = { f() { return this === o; } }; let w; (w) = (function () {}); return [(o.f)(), (y), z, (function () { return 4; })(), typeof (x), (w).name, (o?.f)()];",
];

Deno.test("mirror 5.1: wrapping any node in parentheses or an erased type assertion leaves the tree unchanged only where the code runs the same", async () => {
  const problems: string[] = [];
  const prefix = wrap("").indexOf("\n") + 1; // the snippet's offset inside wrap()
  let parenSame = 0, unwrapSame = 0, typeSame = 0, refusedV8 = 0, refusedDeno = 0;
  for (const s of PAREN_CORPUS) {
    const base = snippetKey(s);
    const js = outcome(s);
    const tsRun = await runsTs(s);
    setup(v8Rejects(s) === null && !tsRun.startsWith("refused"), `the corpus snippet loads: ${s}`);
    // Same tree: where V8 compiles the edit, it must run as the original
    // (JavaScript's own semantics); where Deno's loader takes it (the
    // mirror tests' gate, runtimeRejects), Deno must run it as the original.
    const sameRun = async (edited: string, viaV8: boolean) => {
      if (viaV8) {
        if (v8Rejects(edited) !== null) refusedV8++;
        else if (outcome(edited) !== js) problems.push(`V8: ${JSON.stringify(edited)}: ${js} became ${outcome(edited)}`);
      }
      if (await runtimeRejects(asModule(edited)) !== null) refusedDeno++;
      else {
        const r = await runsTs(edited);
        if (r !== tsRun) problems.push(`Deno: ${JSON.stringify(edited)}: ${tsRun} became ${r}`);
      }
    };
    const sf = parseTs(wrap(s), "snippet");
    const spans = new Map<string, [number, number]>();
    for (const n of findAll(sf, () => true)) {
      const a = n.getStart(sf) - prefix, b = n.end - prefix;
      if (a >= 0 && b <= s.length && b > a) spans.set(`${a},${b}`, [a, b]);
    }
    const keyOrNull = (edited: string) => {
      try {
        return snippetKey(edited);
      } catch {
        return null; // does not parse: refused, not compared
      }
    };
    for (const [a, b] of spans.values()) {
      const parened = `${s.slice(0, a)}(${s.slice(a, b)})${s.slice(b)}`;
      const k1 = keyOrNull(parened);
      if (k1 !== null && sameKey(k1, base)) {
        parenSame++;
        await sameRun(parened, true);
      }
      const typed = `${s.slice(0, a)}(${s.slice(a, b)} as any)${s.slice(b)}`;
      const k2 = keyOrNull(typed);
      if (k2 !== null && sameKey(k2, base)) {
        typeSame++;
        await sameRun(typed, false);
      }
    }
    for (const p of findAll(sf, ts.isParenthesizedExpression)) {
      const a = p.getStart(sf) - prefix, b = p.end - prefix;
      if (a < 0 || b > s.length) continue;
      const inner = p.expression;
      const bare = `${s.slice(0, a)}${s.slice(inner.getStart(sf) - prefix, inner.end - prefix)}${s.slice(b)}`;
      const k = keyOrNull(bare);
      if (k !== null && sameKey(k, base)) {
        unwrapSame++;
        await sameRun(bare, true);
      }
    }
  }
  setup(parenSame > 400 && typeSame > 400 && unwrapSame > 5, `the corpus exercised ${parenSame} parenthesized, ${typeSame} typed and ${unwrapSame} unwrapped same-tree edits`);
  console.log(`same-tree edits: ${parenSame} parenthesized, ${typeSame} typed, ${unwrapSame} unwrapped; refused by V8 ${refusedV8}, by Deno's loader ${refusedDeno}`);
  claim("paren-agrees-with-runtime", problems, [], "a wrapping the tree comparison calls equal changes what the code does");
});

// A gap's offset: the end of the token before it. editLayout hands each gap
// with its index; this maps index to offset for the AST-located sites below.
function gapEnds(text: string): number[] {
  const ends: number[] = [];
  editLayout(text, (g) => {
    ends[g.index] = g.prevEnd;
    return g.text;
  });
  return ends;
}

Deno.test("mirror 5.1: Codex's ingest-only line-break mutants fail the body comparison", () => {
  const shared = sharedKey(sharedFn());
  const text = ingestFnText();
  const fn = findFunction(parseTs(text, "the ingest copy"), FN);
  // Every `return <value>` in the ingest body, found in the tree: the gap after
  // its `return` keyword.
  const returns = findAll(fn, ts.isReturnStatement).filter((r) => r.expression !== undefined);
  // Codex re-review 1, R2 (patches 32 and 33) put the break after the
  // appointment guard's `return true`: the filter then returns undefined and
  // every item is filtered out. Found by its tree, so `return true ;` or a
  // comment around it does not move it (Codex re-review 2, N3).
  setup(returnsTrue(fn).length > 0, "the ingest body has a `return true`");
  const sites = returns.map((r) => r.getStart() + "return".length);
  const ends = gapEnds(text);
  const own = keyOf(text);
  for (const site of sites) {
    setup(ends.includes(site), `a token gap follows the return at ${site}`);
    for (const brk of ["\n      ", " /* reviewer line break\n      */ ", " // reviewer note\n      "]) {
      const mutant = editLayout(text, (g) => (g.prevEnd === site ? brk : g.text), "line break after return");
      const where = `${JSON.stringify(text.slice(site - 12, site))}|${JSON.stringify(brk)}|${JSON.stringify(text.slice(site, site + 12))}`;
      // Against the ingest copy's OWN tree, so the line break is the only
      // difference there is to see; then against the shared copy, the mirror
      // comparison itself.
      claim("linebreak-after-return", sameKey(keyOf(mutant), own), false, `a line break after return must differ: ${where}`);
      assert(!sameKey(keyOf(mutant), shared), `the mirror comparison must see it too: ${where}`);
      // ASI really applied: that return lost its value.
      const after = findAll(findFunction(parseTs(mutant, "mutant"), FN), ts.isReturnStatement).find((r) => r.getStart() === site - "return".length);
      assertEquals(after?.expression, undefined, where);
    }
  }
});

Deno.test("mirror 5.1: allowed reformatting and comment wording of the ingest body still compare equal", () => {
  const shared = sharedKey(sharedFn());
  const text = ingestFnText();
  const lt = (g: { text: string }) => LINE_TERMINATOR.test(g.text);
  // Rewrite each comment of a gap, keeping whether it holds a line break.
  const reword = (gap: string) => {
    let out = "", at = 0;
    for (const c of commentRanges(gap)) {
      const holdsBreak = LINE_TERMINATOR.test(gap.slice(c.start, c.end));
      out += gap.slice(at, c.start) + (!c.multiLine ? "// reworded by the mirror test" : holdsBreak ? "/* reworded\n */" : "/* reworded */");
      at = c.end;
    }
    return out + gap.slice(at);
  };
  // Each edit touches only layout or comments (editLayout checks the tokens are
  // unchanged), everywhere it can, so it holds whatever today's wording and
  // wrapping are (Codex re-review 1, R3: patch 31 rewords one comment; this
  // rewords all of them).
  const edits: Array<[string, string]> = [
    ["every comment reworded", editLayout(text, (g) => reword(g.text))],
    ["a blank line at every line break", editLayout(text, (g) => g.text.replace(/\n/g, "\n\n"))],
    ["re-indented with tabs", editLayout(text, (g) => lt(g) ? g.text.replace(/\n[ \t]*/g, "\n\t") : g.text)],
    ["a line comment added at every line break", editLayout(text, (g) => lt(g) ? `${g.text}// an added note\n  ` : g.text)],
    ["a one-line block comment in every gap on a line", editLayout(text, (g) => lt(g) ? g.text : `${g.text} /* note */ `)],
    ["a space in every gap on a line", editLayout(text, (g) => lt(g) ? g.text : `${g.text} `)],
    ["a two-line block comment at every line break", editLayout(text, (g) => lt(g) ? `${g.text}/* an added\n note */ ` : g.text)],
    // Codex re-review 2, N3: `return /* explanation\n*/;` at an empty return,
    // generalized: a comment holding a line break before every semicolon.
    ["a two-line block comment before every semicolon", editLayout(text, (g) => g.next === ";" ? `${g.text} /* explanation\n*/` : g.text)],
  ];
  for (const [name, edited] of edits) {
    setup(edited !== text, `the edit "${name}" changed the body`);
    claim("allowed-reformatting", keyOf(edited), shared, name);
  }
});

// Every node in `nodes` wrapped as open + node + close, in one pass (nested
// nodes nest; at one offset, closings come before openings).
function wrapAll(text: string, nodes: ts.Node[], open: string, close: string): string {
  const opens = new Map<number, number>(), closes = new Map<number, number>();
  for (const n of nodes) {
    opens.set(n.getStart(), (opens.get(n.getStart()) ?? 0) + 1);
    closes.set(n.end, (closes.get(n.end) ?? 0) + 1);
  }
  let out = "";
  for (let i = 0; i <= text.length; i++) {
    out += close.repeat(closes.get(i) ?? 0) + open.repeat(opens.get(i) ?? 0);
    if (i < text.length) out += text[i];
  }
  return out;
}

// What every locator of these tests finds in an ingest function text.
function locate(fnText: string) {
  const fn = findFunction(parseTs(fnText, "the edited ingest copy"), FN);
  return {
    returnTrue: returnsTrue(fn).length,
    returnsWithValue: findAll(fn, ts.isReturnStatement).filter((r) => r.expression !== undefined).length,
    openFilter: openFilterLiterals(fn).map((l) => l.text),
    order: (({ pos: _pos, ...facts }) => facts)(orderFacts(fn, "supabase")),
    dedup: dedupOrderFacts(fn, "supabase"),
  };
}

Deno.test("mirror 5.1: erased TypeScript syntax in the ingest body compares equal, and every tree locator still finds its site", async () => {
  const shared = sharedKey(sharedFn());
  const text = ingestFnText();
  const fn = findFunction(parseTs(text, "the ingest copy"), FN);
  const returnValues = findAll(fn, ts.isReturnStatement).flatMap((r) => r.expression ? [r.expression] : []);
  // The expression a property access, element access, call or tagged template
  // applies to; never an optional-chain link, which a wrapper would cut off
  // from its chain (that is not a permitted edit).
  const receivers = findAll(fn, (n) => ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n) || ts.isTaggedTemplateExpression(n))
    .map((n) => ts.isTaggedTemplateExpression(n) ? n.tag : (n as ts.PropertyAccessExpression).expression)
    .filter((e) => (e.flags & ts.NodeFlags.OptionalChain) === 0 && e.kind !== ts.SyntaxKind.SuperKeyword);
  const args = findAll(fn, ts.isCallExpression).flatMap((c) => [...c.arguments]).filter((a) => !ts.isSpreadElement(a));
  // Every expression statement but a directive: wrapping a directive in
  // parentheses makes it an ordinary expression, which V8 observes, so it is
  // not a permitted edit. Found by the comparison's own prologue walk
  // (isDirective, which skips erased statements), never by position (Codex
  // re-review 5, R6-1: a directive in a helper of the ingest copy made this
  // edit fail the claim).
  const statements = findAll(fn, ts.isExpressionStatement).filter((st) => !isDirective(st)).map((st) => st.expression);
  // An identifier a property is read from (`items` in `items.length`), found in
  // the tree through the shared erasure policy (skipErased), never by its text:
  // `(items!).length` and `(items as typeof items).length` are such sites too
  // (Codex re-review 4, R5-1 B).
  const identifierReceivers = findAll(fn, ts.isPropertyAccessExpression)
    .filter((n) => (n.flags & ts.NodeFlags.OptionalChain) === 0)
    .map((n) => skipErased(n.expression))
    .filter((e): e is ts.Identifier => ts.isIdentifier(e));
  // An identifier assigned a value that is not an anonymous function definition
  // (`items = extractOperatorLines(content)`), through any wrapper: grouping it
  // is not observable (R5-1 A). The value is read the same way.
  const anonymousFunction = (e: ts.Node) =>
    (ts.isFunctionExpression(e) && e.name === undefined) || ts.isArrowFunction(e) || (ts.isClassExpression(e) && e.name === undefined);
  const assignedIdentifiers = findAll(fn, ts.isBinaryExpression)
    .filter((b) => b.operatorToken.kind === ts.SyntaxKind.EqualsToken && !anonymousFunction(skipErased(b.right)))
    .map((b) => skipErased(b.left))
    .filter((e): e is ts.Identifier => ts.isIdentifier(e));
  // Codex re-review 5, R6-1: a statement the key erases (an interface or a type
  // alias, alternately) before every statement of every block, the function's
  // own body first among them.
  const blockStatements = findAll(fn, ts.isBlock).flatMap((b) => [...b.statements]).sort((x, y) => x.getStart() - y.getStart());
  const erasedBefore = () => {
    let out = "";
    let at = 0;
    blockStatements.forEach((st, k) => {
      out += text.slice(at, st.getStart()) + (k % 2 === 0 ? `type ReviewErased${k} = never; ` : `interface ReviewErased${k} { v: number } `);
      at = st.getStart();
    });
    return out + text.slice(at);
  };
  const castEach = (ids: ts.Identifier[]) => {
    let out = "";
    let at = 0;
    for (const id of [...ids].sort((x, y) => x.getStart() - y.getStart())) {
      out += text.slice(at, id.getStart()) + `(${id.text} as typeof ${id.text})`;
      at = id.end;
    }
    return out + text.slice(at);
  };
  const edits: Array<[string, string]> = [
    // Codex re-review 3, R4-1, the two real-body edits (52 and 53), each
    // everywhere its form applies: `(items as typeof items).length` is one of
    // the first edit's sites.
    ["every identifier receiver: (x as typeof x), Codex's (items as typeof items).length among them", castEach(identifierReceivers)],
    ["return true as boolean", wrapAll(text, returnsTrue(fn).map((r) => r.expression!), "", " as boolean")],
    // Codex re-review 4, R5-1: its case 70 (a grouped assignment target), its
    // case 79's typed target, and its case 78 (`(items!).length`), each
    // everywhere it applies.
    ["every assignment target: (target)", wrapAll(text, assignedIdentifiers, "(", ")")],
    ["every assignment target: (target as typeof target)", castEach(assignedIdentifiers)],
    ["every identifier receiver: (x!)", wrapAll(text, identifierReceivers, "(", "!)")],
    // The same kinds of edit, everywhere they apply.
    ["every return value: (value) as any", wrapAll(text, returnValues, "(", ") as any")],
    ["every return value: value satisfies unknown", wrapAll(text, returnValues, "(", " satisfies unknown)")],
    ["every receiver: (receiver as any)", wrapAll(text, receivers, "(", " as any)")],
    ["every receiver: receiver!", wrapAll(text, receivers, "", "!")],
    ["every call argument: (<any>(argument))", wrapAll(text, args, "(<any>(", "))")],
    ["every expression statement: (expression) as unknown", wrapAll(text, statements, "(", ") as unknown")],
    ["every block statement: an erased type alias or interface before it", erasedBefore()],
  ];
  // Codex's sites, located through the same policy, whatever erased wrapper the
  // body already carries there: `items` read as `.length` (re-review 3, 52;
  // re-review 4, 78), and `items` assigned (re-review 4, 70 and 79).
  const readsLength = (id: ts.Identifier) => {
    const access = outermostWrapper(id).parent;
    return access !== undefined && ts.isPropertyAccessExpression(access) && access.name.text === "length";
  };
  setup(identifierReceivers.some((id) => id.text === "items" && readsLength(id)), "Codex's edits have their site: items read as .length");
  setup(assignedIdentifiers.some((id) => id.text === "items"), "Codex's edit has its site: items assigned");
  setup(returnValues.length > 1 && receivers.length > 10 && args.length > 10 && statements.length > 2 && identifierReceivers.length > 5 && assignedIdentifiers.length > 1 && blockStatements.length > 10, `the ingest body has sites for every edit: ${[returnValues.length, receivers.length, args.length, statements.length, identifierReceivers.length, assignedIdentifiers.length, blockStatements.length]}`);
  for (const [name, edited] of edits) {
    setup(edited !== text, `the edit "${name}" changed the body`);
    await setupLoads(edited, `the edit "${name}"`);
    claim("allowed-type-erasure", keyOf(edited), shared, name);
  }
  // The locators find the same sites in every edited body as in the original.
  const want = locate(text);
  setup(want.returnTrue > 0 && want.openFilter.length === 1 && want.order.missing.length === 0 && want.dedup.missing.length === 0, "the locators find their sites in the ingest body");
  for (const [name, edited] of edits) claim("locators-through-types", locate(edited), want, name);
});

// Wrapping that the live bodies do not happen to exercise, on a fixed function
// shaped like extractAndStoreActionItems: a joined or split call chain, an
// object literal on one line or several, a joined filter, a wrapped call.
const FIXTURE = `async function f(db, rows) {
  const { data: existing } = await db
    .from("action_items")
    .select("description")
    .eq("status", "open");
  const mapped = rows
    .map((d) => ({
      description: String(d),
      status: "open",
    }))
    .filter((row) => {
      if (row.description === "") {
        console.log(\`skipped: \${
          row.description.slice(0, 80)
        }\`);
        return false;
      }
      return true;
    });
  return mapped.filter((row) =>
    !existing.has(row.description)
  );
}`;

Deno.test("mirror 5.1: the tree comparison on a fixed capture-shaped fixture: wrapping compares equal, a line break after return does not", () => {
  const swap = (from: string, to: string) => {
    setup(FIXTURE.split(from).length - 1 === 1, `the fixture has one ${JSON.stringify(from)}`);
    return FIXTURE.replace(from, to);
  };
  const key = (s: string) => astKey(parseTs(s, "fixture"));
  const base = key(FIXTURE);
  for (const allowed of [
    swap('await db\n    .from("action_items")\n    .select("description")\n    .eq("status", "open");', 'await db.from("action_items").select("description").eq("status", "open");'),
    swap('({\n      description: String(d),\n      status: "open",\n    }))', '({ description: String(d), status: "open" }))'),
    swap("mapped.filter((row) =>\n    !existing.has(row.description)\n  );", "mapped.filter((row) => !existing.has(row.description));"),
    swap("`skipped: ${\n          row.description.slice(0, 80)\n        }`", "`skipped: ${row.description.slice(0, 80)}`"),
    swap("        return false;\n", "\n\n        return false;\n\n"),
    swap("if (row.description === \"\") {", "if (\n        row.description === \"\"\n      ) {"),
  ]) {
    assertEquals(key(allowed), base, `allowed: ${allowed}`);
  }
  for (const changed of [
    swap("      return true;", "      return\n      true;"),
    swap("      return true;", "      return /* x\n */ true;"),
    swap("        return false;", "        return\n        false;"),
    swap("  return mapped", "  return\n  mapped"),
  ]) {
    assert(!sameKey(key(changed), base), `must differ: ${changed}`);
  }
});

Deno.test("mirror 5.1: Codex's ingest-only filter mutant (status \"op en\") fails the body comparison", () => {
  const text = ingestFnText();
  const fn = findFunction(parseTs(text, "the ingest copy"), FN);
  // The filter's "open" literal, found in the tree: the second argument of a
  // `.eq("status", "open")` call, whatever the layout and comments around it.
  const lits = openFilterLiterals(fn);
  setup(lits.length === 1, `the ingest body has one open-item filter (found ${lits.length})`);
  const mutant = text.slice(0, lits[0].getStart()) + '"op en"' + text.slice(lits[0].end);
  // The first version's comparison could not see it. Shown on a fixed fixture
  // and on the ingest body against its OWN mutated copy, never against the
  // shared copy: the old squash kept comment text, so a cross-file squash
  // fails on a comment rewording the mirror rule allows (Codex re-review 1, R3).
  const squash = (s: string) => s.replace(/\s+/g, "");
  assertEquals(squash(`.eq("status", "open")`), squash(`.eq("status", "op en")`), "the old squash erases the space (fixture)");
  assertEquals(squash(text), squash(mutant), "the old whitespace squash erases the space inside the literal");
  // The tree comparison sees it, first at exactly that literal.
  const own = keyOf(text), b = keyOf(mutant);
  assert(!sameKey(own, b), "the tree comparison must see the divergent filter string");
  const at = own.findIndex((t, k) => t !== b[k]);
  assertEquals([own[at], b[at]], ['item=StringLiteral "open"', 'item=StringLiteral "op en"']);
  // And under the real mirror contract the mutant differs from the shared copy.
  assert(!sameKey(sharedKey(sharedFn()), b), "the live comparison must see the divergent filter string");
});

Deno.test("mirror 5.1: both copies run the gate after the appointment guard, before the dedup, and record suspects after the insert", () => {
  for (const [label, fn, client] of [
    ["shared", sharedFn(), "db"],
    ["ingest", ingestFn(), "supabase"],
  ] as const) {
    // Found by tree shape (mirror-ast.ts treeFind), so neither a rewrap nor a
    // comment that quotes the code can move or add a match.
    const f = orderFacts(fn, client);
    assertEquals(f.missing, [], `${label}: not found`);
    assert(f.ordered, `${label}: order ${Object.values(f.pos)}`);
    // insert(rows) is the inner call of .select(...), and both come after the
    // dedup.
    assert(f.selectedAfterDedup, `${label}: the insert is selected after the dedup ${[f.pos.dedup, f.pos.insert, f.pos.select]}`);
    assertEquals(f.gateCalls, 1, `${label}: one gate call`);
    assertEquals(f.suspectCalls, 1, `${label}: one suspect call`);
  }
});

Deno.test("mirror 5.2: both copies run the batch-local dedup after the open-item dedup, read candidates before the insert, and write dedup rows after it", () => {
  const facts = [
    ["shared", sharedFn(), "db"],
    ["ingest", ingestFn(), "supabase"],
  ].map(([label, fn, client]) => {
    const f = dedupOrderFacts(fn as ts.FunctionDeclaration, client as string);
    setup(f.missing.length === 0, `${label}: the 5.2 sites are found: missing ${f.missing}`);
    return { label, ordered: f.ordered, calls: f.calls };
  });
  claim(
    "dedup-order",
    facts,
    [
      { label: "shared", ordered: true, calls: [1, 1, 1, 1] },
      { label: "ingest", ordered: true, calls: [1, 1, 1, 1] },
    ],
    "open-item dedup < batch keep < candidate read < insert < suspects < exact_batch rows < semantic proposals, once each, in both copies",
  );
});

// Loop-closing Task 5.3's order facts, found by tree shape like the two above:
// client identity is assigned to the final rows after the batch-local dedup
// and the empty-batch return, and before the semantic candidate read and the
// insert, once, on the rows the insert sends.
function clientOrderFacts(fn: ts.Node, client: string) {
  const at = (needle: string) => treeFind(fn, needle).at;
  const pos = {
    batchKeep: at("batch.keep(row.description)"),
    emptyReturn: at("rows.length === 0"),
    assign: at(`await assignItemClients(${client}, rows)`),
    candidates: at(`loadSemanticCandidates(${client})`),
    insert: at(`${client}.from("action_items").insert(rows)`),
  };
  return {
    missing: Object.entries(pos).filter(([, v]) => v < 0).map(([k]) => k),
    ordered: pos.batchKeep < pos.emptyReturn && pos.emptyReturn < pos.assign && pos.assign < pos.candidates &&
      pos.candidates < pos.insert,
    calls: callsTo(fn, "assignItemClients").length,
  };
}

Deno.test("mirror 5.3: both copies assign client identity to the final rows after the batch dedup and before the insert", () => {
  const facts = [
    ["shared", sharedFn(), "db"],
    ["ingest", ingestFn(), "supabase"],
  ].map(([label, fn, client]) => {
    const f = clientOrderFacts(fn as ts.FunctionDeclaration, client as string);
    setup(f.missing.length === 0, `${label}: the 5.3 sites are found: missing ${f.missing}`);
    return { label, ordered: f.ordered, calls: f.calls };
  });
  claim(
    "client-order",
    facts,
    [
      { label: "shared", ordered: true, calls: 1 },
      { label: "ingest", ordered: true, calls: 1 },
    ],
    "batch keep < empty-batch return < assignItemClients(client, rows) < candidate read < insert, once, in both copies",
  );
});

// Loop-closing Task 5.3 (Codex review 1 of PR 38, finding 9): the order test
// above sees a call to assignItemClients, not the function it reaches. Both
// capture files must import assignItemClients and retryWithoutMissingClients,
// unaliased, from the ONE module _shared/item-client.ts, and declare neither
// name themselves, so the two copies cannot reach two different resolvers.
const CLIENT_HELPERS = ["assignItemClients", "retryWithoutMissingClients"];
function clientHelperBindings(rel: string): Array<[string, string, string]> {
  const sf = parseTs(read(rel), rel);
  const out: Array<[string, string, string]> = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.importClause) {
      const target = new URL(st.moduleSpecifier.text, new URL(rel, ROOT)).pathname.slice(ROOT.pathname.length);
      const nb = st.importClause.namedBindings;
      if (st.importClause.name && CLIENT_HELPERS.includes(st.importClause.name.text)) out.push([st.importClause.name.text, target, "default"]);
      if (nb && ts.isNamespaceImport(nb) && target.endsWith("/item-client.ts")) out.push([`* as ${nb.name.text}`, target, "namespace"]);
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          if (CLIENT_HELPERS.includes(el.name.text) || CLIENT_HELPERS.includes(el.propertyName?.text ?? "")) {
            out.push([el.name.text, target, el.propertyName?.text ?? el.name.text]);
          }
        }
      }
    }
  }
  for (const n of findAll(sf, (x) => ts.isFunctionDeclaration(x) || ts.isVariableDeclaration(x) || ts.isClassDeclaration(x))) {
    const name = (n as ts.FunctionDeclaration).name;
    if (name && ts.isIdentifier(name) && CLIENT_HELPERS.includes(name.text)) out.push([name.text, rel, "declared here"]);
  }
  return out.filter(([local, , imported]) => CLIENT_HELPERS.includes(local) || CLIENT_HELPERS.includes(imported) || local.startsWith("* as"))
    .sort();
}

Deno.test("mirror 5.3: both capture files import the client helpers, unaliased, from _shared/item-client.ts and declare neither", () => {
  const want = CLIENT_HELPERS.map((n) => [n, "supabase/functions/_shared/item-client.ts", n]).sort();
  claim(
    "client-import-pinned",
    { shared: clientHelperBindings(SHARED), ingest: clientHelperBindings(INGEST) },
    { shared: want, ingest: want },
    "one module, one export per name, no alias, no local declaration, in both capture files",
  );
});

// ---------------------------------------------------------------------------
// Per-file helpers the two extraction bodies reach (Codex review 1 of PR 33,
// R4; re-review 1, F2; re-review 2, F2). The body comparison above sees a call
// to normalizeActionText, not the function it reaches. Each capture file used
// to carry its own copy of normalizeActionText, the mechanical-prefix test and
// the log constant, and three rounds of tests that compared those copies each
// missed another way for them to differ at run time (a digit-stripping
// normalizer, an enum the normalizer read, a module-level write to a compared
// namespace). Since correction 3 there is ONE copy, in
// _shared/capture-helpers.ts, so there is nothing left to compare. These two
// tests hold that in place:
//   - single source: no capture file declares any of those names, at module
//     level or anywhere inside it; each imports exactly its list from the one
//     module, as plain named value imports, and imports none of the names from
//     anywhere else or in any other form; and the module is exactly its four
//     declarations (no imports, no other top-level code), with the prefix list
//     module-private. So what a capture file can import is two functions and a
//     number: an import binding cannot be reassigned, and none of the three
//     holds state a capture file can reach and change.
//   - inventory: neither extraction body reaches ANY module-level binding of
//     its own file, directly or through another one (imports are single-source
//     and excluded; so is the module's Supabase client, which is the `db`
//     parameter under the existing rename). The shared copy's `isMechanical`
//     parameter is resolved through its one production caller, open-brain-mcp's
//     wrapper, which must pass the imported isMechanicalCapture. A per-file
//     helper added later, an enum or a namespace a body reads, or one a
//     module-level statement writes, therefore fails the inventory; a reached
//     binding of a kind the enumeration does not handle is refused as a setup
//     error, never skipped.
// ---------------------------------------------------------------------------
const MCP = "supabase/functions/open-brain-mcp/index.ts";
const CLIENT_NAME = "supabase";
const SINGLE_SOURCE = "supabase/functions/_shared/capture-helpers.ts";
// What each capture file imports from the single module.
const SINGLE_SOURCE_IMPORTS: Array<[string, string[]]> = [
  [INGEST, ["LOG_TRUNC", "isMechanicalCapture", "normalizeActionText"]],
  [SHARED, ["LOG_TRUNC", "normalizeActionText"]],
  [MCP, ["LOG_TRUNC", "isMechanicalCapture"]],
];
// Names no capture file may declare or import from elsewhere: the module's
// three exports, its private prefix list, and the shared copy's old name for
// the log constant.
const SINGLE_SOURCE_NAMES = ["ACTION_ITEM_LOG_TRUNC", "LOG_TRUNC", "MECHANICAL_CAPTURE_PREFIXES", "isMechanicalCapture", "normalizeActionText"];
// The module, statement by statement: nothing else may be in it.
const SINGLE_SOURCE_SHAPE = [
  // Brain Bank's one import: the operator's own bridge prefixes come from the
  // profile, so the list cannot be a pure literal.
  'ImportDeclaration: import { loadProfile } from "./profile.ts";',
  "export function normalizeActionText",
  "const MECHANICAL_CAPTURE_PREFIXES = ArrayLiteralExpression",
  "export function isMechanicalCapture",
  "export const LOG_TRUNC = NumericLiteral",
];

// A module specifier, resolved against the importing file, as a repository path.
function resolvesTo(fromFile: string, spec: string): string {
  return new URL(spec, new URL(fromFile, "file:///repo/")).pathname.replace(/^\/repo\//, "");
}

const DECLARING_PARENTS = (p: ts.Node) =>
  ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) ||
  ts.isClassDeclaration(p) || ts.isClassExpression(p) || ts.isBindingElement(p) || ts.isEnumDeclaration(p) ||
  ts.isModuleDeclaration(p) || ts.isImportEqualsDeclaration(p) || ts.isImportClause(p) || ts.isNamespaceImport(p);

// How one file relates to the single module: the names it imports from it as
// plain named value imports (sorted), every declaration of one of the names in
// the file other than such an import, and every other import form that binds
// one of them or reads the module (an alias, a type-only or namespace or
// default import, a re-export, an import from another module).
function singleSourceFacts(sf: ts.SourceFile, file: string): { imports: string[]; declared: string[]; otherForms: string[] } {
  const imports: string[] = [], otherForms: string[] = [], declared = new Set<string>();
  const NAMES = new Set(SINGLE_SOURCE_NAMES);
  for (const st of sf.statements) {
    if (!(ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) || st.moduleSpecifier === undefined) continue;
    setup(ts.isStringLiteral(st.moduleSpecifier), `${file}: every module specifier is a string`);
    const spec = (st.moduleSpecifier as ts.StringLiteral).text;
    const fromModule = resolvesTo(file, spec) === SINGLE_SOURCE;
    const text = st.getText(sf).replace(/\s+/g, " ");
    if (ts.isExportDeclaration(st)) {
      if (fromModule) otherForms.push(`a re-export from the module: ${text}`);
      continue;
    }
    const clause = st.importClause;
    if (clause === undefined) {
      if (fromModule) otherForms.push(`a side-effect import of the module: ${text}`);
      continue;
    }
    const named = clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : [];
    const whole = [clause.name?.text, clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings.name.text : undefined]
      .filter((n): n is string => n !== undefined);
    if (fromModule && (clause.isTypeOnly || whole.length > 0)) otherForms.push(`an import of the module that is not plain named value bindings: ${text}`);
    for (const n of whole) if (!fromModule && NAMES.has(n)) otherForms.push(`${n} bound by ${text}`);
    for (const el of named) {
      const local = el.name.text, imported = (el.propertyName ?? el.name).text;
      if (fromModule && !clause.isTypeOnly) {
        if (el.isTypeOnly || el.propertyName !== undefined) otherForms.push(`${imported} imported from the module ${el.isTypeOnly ? "as a type" : `as ${local}`}`);
        else imports.push(local);
      } else if (!fromModule && (NAMES.has(local) || NAMES.has(imported))) {
        otherForms.push(`${local} imported from ${spec}`);
      }
    }
  }
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && NAMES.has(n.text) && n.parent !== undefined && DECLARING_PARENTS(n.parent) &&
      (n.parent as unknown as { name?: ts.Node }).name === n) {
      declared.add(`${n.text} (${kindName(n.parent.kind)})`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { imports: imports.sort(), declared: [...declared].sort(), otherForms };
}

// The single module, one line per top-level statement.
function moduleShape(sf: ts.SourceFile): string[] {
  const exported = (st: ts.Node) => (ts.canHaveModifiers(st) ? ts.getModifiers(st) ?? [] : []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  return sf.statements.map((st) => {
    const ex = exported(st) ? "export " : "";
    if (ts.isFunctionDeclaration(st)) return `${ex}function ${st.name?.text ?? "(anonymous)"}${st.body === undefined ? " (no body)" : ""}`;
    if (ts.isVariableStatement(st)) {
      const scoped = st.declarationList.flags & ts.NodeFlags.BlockScoped;
      const kw = scoped === ts.NodeFlags.Const ? "const" : scoped === ts.NodeFlags.Let ? "let" : "var";
      return `${ex}${kw} ${st.declarationList.declarations.map((d) => `${d.name.getText(sf)} = ${d.initializer === undefined ? "(none)" : kindName(d.initializer.kind)}`).join(", ")}`;
    }
    return `${ex}${kindName(st.kind)}: ${st.getText(sf).replace(/\s+/g, " ").slice(0, 80)}`;
  });
}

Deno.test("mirror 5.2: the per-file capture helpers have one copy, in _shared/capture-helpers.ts, which every capture file imports and none declares", () => {
  const files = SINGLE_SOURCE_IMPORTS.map(([file]) => ({ file, ...singleSourceFacts(parseTs(read(file), file), file) }));
  claim(
    "single-source-helpers",
    { module: moduleShape(parseTs(read(SINGLE_SOURCE), SINGLE_SOURCE)), files },
    { module: SINGLE_SOURCE_SHAPE, files: SINGLE_SOURCE_IMPORTS.map(([file, names]) => ({ file, imports: names, declared: [], otherForms: [] })) },
    "each capture file imports its helpers from the one module and declares none of them; the module is its four declarations",
  );
});

// A file's module-level runtime bindings: name -> what declares it. Kinds: a
// function, a class, a `const` variable, a runtime enum (`enum` or `const
// enum`) and a namespace (Codex re-review 1 of PR 33, F2: the first version
// enumerated functions, classes and variables only, so an enum a reached helper
// read was skipped). Imports are single-source and bind nothing of the file's
// own; the statements mirror-ast.ts erases (types, `declare`, overload
// signatures) run nothing. Every other runtime binding is recorded as
// `unsupported` with its reason, and REACHING one fails the test as a setup
// error instead of being skipped (so the next unknown kind fails closed): an
// import alias of a module-level entity (`import A = N.A`), a name declared
// more than once (declaration merging), a `let` or `var` or `using`, a `var`
// hoisted out of a top-level block, and any other named top-level statement.
// An unsupported binding nothing reaches refuses nothing. Since correction 3 a
// reached binding of ANY supported kind fails the inventory too: no per-file
// binding may be reached at all.
type ModuleDecl =
  | { kind: "function"; node: ts.FunctionDeclaration }
  | { kind: "class"; node: ts.ClassDeclaration }
  | { kind: "variable"; node: ts.VariableDeclaration }
  | { kind: "enum"; node: ts.EnumDeclaration }
  | { kind: "namespace"; node: ts.ModuleDeclaration }
  | { kind: "unsupported"; node: ts.Node; why: string };

function boundNames(b: ts.BindingName): string[] {
  if (ts.isIdentifier(b)) return [b.text];
  return b.elements.flatMap((e) => ts.isOmittedExpression(e) ? [] : boundNames(e.name));
}

// The `var` names a statement hoists to module scope: every var declaration in
// it that is not inside a nested function or class.
function hoistedVars(st: ts.Node): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
    if (ts.isVariableDeclarationList(n) && (n.flags & ts.NodeFlags.BlockScoped) === 0) {
      for (const d of n.declarations) out.push(...boundNames(d.name));
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(st, visit);
  return out;
}

function moduleDecls(sf: ts.SourceFile): Map<string, ModuleDecl> {
  const m = new Map<string, ModuleDecl>();
  const add = (name: string, d: ModuleDecl) => {
    const prior = m.get(name);
    m.set(name, prior === undefined ? d : {
      kind: "unsupported",
      node: d.node,
      why: `a name declared more than once at module level (${prior.kind}, then ${d.kind}: declaration merging)`,
    });
  };
  const unsupported = (name: string, node: ts.Node, why: string) => add(name, { kind: "unsupported", node, why });
  for (const st of sf.statements) {
    if (isTypeOnlyStatement(st)) continue;
    // Imports and re-exports bind nothing of the file's own.
    if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st) || ts.isExportAssignment(st)) continue;
    if (ts.isFunctionDeclaration(st)) {
      if (st.name) add(st.name.text, { kind: "function", node: st });
    } else if (ts.isClassDeclaration(st)) {
      if (st.name) add(st.name.text, { kind: "class", node: st });
    } else if (ts.isVariableStatement(st)) {
      const isConst = (st.declarationList.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const;
      for (const d of st.declarationList.declarations) {
        setup(ts.isIdentifier(d.name), "every module-level variable declaration binds one plain name");
        const name = (d.name as ts.Identifier).text;
        if (isConst) add(name, { kind: "variable", node: d });
        else unsupported(name, d, "a module-level variable not declared const (its value can change outside its declaration)");
      }
    } else if (ts.isEnumDeclaration(st)) {
      add(st.name.text, { kind: "enum", node: st });
    } else if (ts.isModuleDeclaration(st)) {
      if (ts.isIdentifier(st.name)) add(st.name.text, { kind: "namespace", node: st });
      else unsupported(st.name.text, st, "a module declaration named by a string");
    } else if (ts.isImportEqualsDeclaration(st)) {
      if (st.isTypeOnly || ts.isExternalModuleReference(st.moduleReference)) continue; // an import
      unsupported(st.name.text, st, "an import alias of a module-level entity");
    } else {
      for (const v of hoistedVars(st)) unsupported(v, st, `a var hoisted out of a top-level ${kindName(st.kind)}`);
      const named = (st as unknown as { name?: ts.Node }).name;
      if (named !== undefined && ts.isIdentifier(named)) unsupported(named.text, st, `a module-level ${kindName(st.kind)}`);
    }
  }
  return m;
}

// The names a node reads as values, and the names it declares itself.
function valueNames(root: ts.Node): { refs: Set<string>; locals: Set<string> } {
  const refs = new Set<string>(), locals = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && n.parent !== undefined) {
      const p = n.parent;
      const nameOf = (x: ts.Node) => (x as unknown as { name?: ts.Node }).name === n;
      if (inTypePosition(n)) { /* erased */ }
      else if (ts.isPropertyAccessExpression(p) && p.name === n) { /* a property */ }
      else if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) ||
        ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isEnumMember(p)) && nameOf(p)) { /* a key */ }
      else if (ts.isBindingElement(p) && p.propertyName === n) { /* a key */ }
      else if ((ts.isLabeledStatement(p) || ts.isBreakStatement(p) || ts.isContinueStatement(p)) && p.label === n) { /* a label */ }
      else if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) ||
        ts.isBindingElement(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p) || ts.isEnumDeclaration(p) ||
        ts.isModuleDeclaration(p) || ts.isImportEqualsDeclaration(p)) && nameOf(p)) locals.add(n.text);
      else refs.add(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return { refs, locals };
}

// Every module-level declaration of `sf` reached from `start`, transitively,
// and any local inside a reached node that shadows one (ambiguous: reported).
// Reaching an unsupported binding is a setup error, never a skip.
function reachedHelpers(sf: ts.SourceFile, start: ts.Node, exclude: string[]): { names: string[]; shadowed: string[] } {
  const decls = moduleDecls(sf);
  const seen = new Set<string>(), shadowed = new Set<string>();
  const todo: ts.Node[] = [start];
  while (todo.length > 0) {
    const n = todo.pop()!;
    const { refs, locals } = valueNames(n);
    for (const l of locals) if (decls.has(l) && decls.get(l)!.node !== n && !exclude.includes(l)) shadowed.add(l);
    for (const r of refs) {
      if (exclude.includes(r) || seen.has(r) || !decls.has(r) || locals.has(r)) continue;
      const d = decls.get(r)!;
      if (d.kind === "unsupported") {
        setup(false, `${sf.fileName}: an extraction body reaches ${r}, ${d.why}, which the helper inventory does not compare`);
      }
      seen.add(r);
      todo.push(d.node);
    }
  }
  return { names: [...seen].sort(), shadowed: [...shadowed].sort() };
}

// open-brain-mcp's wrapper: the arguments it hands the shared copy.
function mcpWrapperArgs(sf: ts.SourceFile): string[] {
  const fn = findFunction(sf, FN);
  const calls = callsTo(fn, "sharedExtractAndStoreActionItems");
  setup(calls.length === 1, `open-brain-mcp's ${FN} calls the shared copy once (found ${calls.length})`);
  return calls[0].arguments.map((a) => { const e = skipErased(a); return ts.isIdentifier(e) ? e.text : `<${kindName(e.kind)}>`; });
}

Deno.test("mirror 5.2: neither extraction body reaches a module-level binding of its own file, and open-brain-mcp's wrapper passes the imported mechanical test", () => {
  const ingestSf = parseTs(read(INGEST), INGEST), sharedSf = parseTs(read(SHARED), SHARED), mcpSf = parseTs(read(MCP), MCP);
  const ingest = reachedHelpers(ingestSf, findFunction(ingestSf, FN), [FN, CLIENT_NAME]);
  const shared = reachedHelpers(sharedSf, findFunction(sharedSf, FN), [FN]);
  const mcp = reachedHelpers(mcpSf, findFunction(mcpSf, FN), [FN, CLIENT_NAME]);
  claim(
    "mirror-helper-inventory",
    { ingest, shared, mcp, wrapperArgs: mcpWrapperArgs(mcpSf) },
    {
      ingest: { names: [], shadowed: [] },
      shared: { names: [], shadowed: [] },
      mcp: { names: [], shadowed: [] },
      wrapperArgs: [CLIENT_NAME, "thoughtId", "metadata", "content", "isMechanicalCapture"],
    },
    "no extraction body reaches a per-file helper; every helper they share is imported",
  );
});

// On fixtures shaped like the capture files: what the inventory reaches, what
// it refuses, and what the single-source facts report. Codex re-review 1 of
// PR 33, F2 (an enum or namespace the normalizer reads) and re-review 2, F2 (a
// namespace a module-level statement rewrites after its declaration): with a
// per-file normalizer, each is reached, so the inventory, which now allows no
// reached per-file binding, fails on it. Then the declaration kinds the
// enumeration does not handle: reaching one is a setup error, not a pass.
// Then the single-source facts: a local copy, an alias, a namespace or default
// import, an import from another module, a re-export and a local shadow inside
// a function are each reported.
Deno.test("mirror 5.2: the inventory reaches a per-file enum, namespace or namespace written at module level, refuses a kind it does not enumerate, and the single-source facts report every other form", () => {
  const extraction = `async function ${FN}(items: string[]) {\n  return items.map((i) => normalizeActionText(i));\n}\n`;
  const normalizer = `function normalizeActionText(s: string): string {\n  return s.toLowerCase().replace(new RegExp(NormalizationPolicy.Strip, "g"), "");\n}\n`;
  const enumOf = (cls: string) => `enum NormalizationPolicy { Strip = "[^${cls}0-9\\\\s]" }\n`;
  const namespaceOf = (cls: string) => `namespace NormalizationPolicy {\n  export const Strip = "[^${cls}0-9\\\\s]";\n}\n`;
  const sfOf = (label: string, ...parts: string[]) => parseTs(parts.join("\n"), label);
  const reach = (sf: ts.SourceFile) => reachedHelpers(sf, findFunction(sf, FN), [FN]);
  for (const [kind, decl] of [["enum", enumOf("a-y")], ["namespace", namespaceOf("a-y")]] as const) {
    assertEquals(reach(sfOf(kind, decl, normalizer, extraction)), { names: ["NormalizationPolicy", "normalizeActionText"], shadowed: [] }, `the ${kind} is reached`);
  }
  // Codex re-review 2, F2, as written: the declaration holds a-z, a later
  // module-level statement sets a-y.
  const rules = `function normalizeActionText(s: string): string {\n  return s.toLowerCase().replace(new RegExp(NormalizationPolicy.rules.strip, "g"), "");\n}\n`;
  const written = sfOf("namespace written at module level",
    `namespace NormalizationPolicy {\n  export const rules = { strip: "[^a-z0-9\\\\s]" };\n}\nNormalizationPolicy.rules.strip = "[^a-y0-9\\\\s]";\n`, rules, extraction);
  assertEquals(reach(written), { names: ["NormalizationPolicy", "normalizeActionText"], shadowed: [] }, "the written namespace is reached");
  // Reached declarations the enumeration does not handle: each refused.
  const readsStrip = `function normalizeActionText(s: string): string {\n  return s.replace(new RegExp(STRIP, "g"), "");\n}\n`;
  for (const [what, decl] of [
    ["a var hoisted out of a top-level block", `if (true) {\n  var STRIP = "[^a-z0-9\\\\s]";\n}\n`],
    ["an import alias", `${namespaceOf("a-z")}import STRIP = NormalizationPolicy.Strip;\n`],
    ["a let", `let STRIP = "[^a-z0-9\\\\s]";\n`],
    ["a merged enum", `enum STRIP { A = "a" }\nenum STRIP { B = "b" }\n`],
    ["a function merged with a namespace", `function STRIP() { return "a"; }\nnamespace STRIP { export const B = "b"; }\n`],
  ] as const) {
    let refused = "";
    try { reach(sfOf(what, decl, readsStrip, extraction)); } catch (e) { refused = (e as Error).message; }
    assert(refused.startsWith("setup: ") && refused.includes("reaches STRIP") && refused.includes("does not compare"), `${what}: reaching it must be refused, got ${JSON.stringify(refused)}`);
  }
  // An unsupported binding nothing reaches refuses nothing.
  const unrelated = sfOf("unreached var", `if (true) {\n  var UNRELATED = 1;\n}\n`, enumOf("a-z"), normalizer, extraction);
  assertEquals(reach(unrelated), { names: ["NormalizationPolicy", "normalizeActionText"], shadowed: [] });
  // The single-source facts, on a file named like the ingest copy so its
  // relative specifiers resolve as the real file's do.
  const facts = (src: string) => singleSourceFacts(parseTs(src, INGEST), INGEST);
  const IMPORT = `import { LOG_TRUNC, normalizeActionText } from "../_shared/capture-helpers.ts";\n`;
  const USE = `function f(s: string) { return normalizeActionText(s).slice(0, LOG_TRUNC); }\n`;
  assertEquals(facts(IMPORT + USE), { imports: ["LOG_TRUNC", "normalizeActionText"], declared: [], otherForms: [] }, "the plain import");
  assertEquals(facts(`import {\n  normalizeActionText,\n  LOG_TRUNC, // relaid\n} from "../_shared/capture-helpers.ts";\n` + USE),
    { imports: ["LOG_TRUNC", "normalizeActionText"], declared: [], otherForms: [] }, "the plain import, relaid");
  for (const [what, src, field] of [
    ["a local copy beside the import", `import { LOG_TRUNC } from "../_shared/capture-helpers.ts";\nfunction normalizeActionText(s: string) { return s; }\n${USE}`, "declared"],
    ["a local prefix list", `${IMPORT}const MECHANICAL_CAPTURE_PREFIXES = ["x"];\n${USE}`, "declared"],
    ["the old log constant", `${IMPORT}const ACTION_ITEM_LOG_TRUNC = 100;\n${USE}`, "declared"],
    ["a shadow inside a function", `${IMPORT}function g() { const LOG_TRUNC = 100; return LOG_TRUNC; }\n${USE}`, "declared"],
    ["a destructured shadow", `${IMPORT}function g(o: { normalizeActionText: (s: string) => string }) { const { normalizeActionText } = o; return normalizeActionText; }\n${USE}`, "declared"],
    ["an alias", `import { LOG_TRUNC, normalizeActionText as n } from "../_shared/capture-helpers.ts";\nconst normalizeActionText = n;\n${USE}`, "otherForms"],
    ["a namespace import", `${IMPORT}import * as H from "../_shared/capture-helpers.ts";\n${USE}`, "otherForms"],
    ["a type-only import", `${IMPORT}import type { LOG_TRUNC as L } from "../_shared/capture-helpers.ts";\n${USE}`, "otherForms"],
    ["an import from another module", `import { LOG_TRUNC } from "../_shared/capture-helpers.ts";\nimport { normalizeActionText } from "../_shared/capture-pipeline.ts";\n${USE}`, "otherForms"],
    ["a re-export of the module", `${IMPORT}export { isMechanicalCapture } from "../_shared/capture-helpers.ts";\n${USE}`, "otherForms"],
  ] as const) {
    const got = facts(src);
    assert(got[field].length > 0, `${what}: must be reported under ${field}, got ${JSON.stringify(got)}`);
  }
  // The module's shape, on a fixture module of the same four declarations: an
  // extra top-level write, an import or an exported prefix list is a line the
  // expected shape does not hold.
  const shapeOf = (src: string) => moduleShape(parseTs(src, SINGLE_SOURCE));
  const MODULE = `import { loadProfile } from "./profile.ts";\n` +
    `export function normalizeActionText(s: string): string {\n  return s.trim();\n}\n` +
    `const MECHANICAL_CAPTURE_PREFIXES = ["[A]"];\n` +
    `export function isMechanicalCapture(content: string): boolean {\n  return MECHANICAL_CAPTURE_PREFIXES.some((p) => content.startsWith(p));\n}\n` +
    `export const LOG_TRUNC = 200;\n`;
  assertEquals(shapeOf(MODULE), SINGLE_SOURCE_SHAPE, "the fixture module has the expected shape");
  for (const [what, extra] of [
    ["a top-level write", `\nMECHANICAL_CAPTURE_PREFIXES.push("[Reviewer]");\n`],
    ["an import", `\nimport { stem } from "./quote-coverage.ts";\n`],
    ["an exported prefix list", `\nexport { MECHANICAL_CAPTURE_PREFIXES };\n`],
  ] as const) {
    assert(!sameKey(shapeOf(MODULE + extra), SINGLE_SOURCE_SHAPE), `${what}: the module shape must differ`);
  }
});

const RULE = "Each item must stand alone: name the person and the thing. Never use her, him, it, that, or this as the object.";

// The ingest prompt, found in the tree: the one template literal whose value
// opens with the prompt's first sentence. Its value (not its source text) is
// compared, which is what the model receives.
// Brain Bank keeps ONE copy of the prompt: ingest-thought imports the shared
// constant instead of carrying its own literal, so "byte-equal" is structural.
function ingestUsesSharedPrompt(src: string): boolean {
  const open = "Extract metadata from the user's captured thought.";
  return !src.includes(open) &&
    /import \{ EXTRACT_METADATA_SYSTEM_PROMPT \} from "\.\.\/_shared\/capture-pipeline\.ts";/.test(src) &&
    src.includes("content: EXTRACT_METADATA_SYSTEM_PROMPT,");
}

Deno.test("mirror 5.1: the extraction prompt carries the stand-alone rule once, and the ingest copy is the shared constant", () => {
  claim("prompt-rule-once", EXTRACT_METADATA_SYSTEM_PROMPT.split(RULE).length - 1, 1, "the shared prompt carries the rule once");
  assert(EXTRACT_METADATA_SYSTEM_PROMPT.includes(`    * ${RULE}\n`), "the rule is one of the action_items STRICT RULES bullets");
  claim("prompt-single-source", ingestUsesSharedPrompt(read(INGEST)), true, "the ingest copy is the shared constant, not a literal of its own");
});
