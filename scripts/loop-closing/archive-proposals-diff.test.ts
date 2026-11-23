// The diff checker's own guards, without a database: the TypeScript reference
// rendered in the SQL output's shape must pass, and every inventory defect must
// be INCOMPLETE (3) while every changed value is FAIL (1). The shell repeats the
// same self-test on the real SQL output after every passing diff.
//   deno test --no-lock --allow-read --allow-write --allow-run scripts/loop-closing/archive-proposals-diff.test.ts
// (--allow-run: the CLI tests below run the checker as its own process, because
// the exit code the shell sees is the thing under test.)
import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { ADVERSARIAL, clientIdOnlyExempt, compare, emitSnapshot, loadSnapshot, referenceSqlOut, selftest } from "./archive-proposals-diff.ts";
import { isClientShaped } from "../../supabase/functions/_shared/archive-policy.ts";

function synthetic() {
  const dir = Deno.makeTempDirSync({ prefix: "obap-diff-test-" });
  emitSnapshot(dir);
  const at = Deno.readTextFileSync(`${dir}/snapshot_at.txt`).trim();
  const extra = Deno.readTextFileSync(`${dir}/moments.txt`).split("\n").filter(Boolean);
  const moments = [at, "2026-11-19T05:30:00Z", ...extra];
  return { dir, snap: loadSnapshot(dir), moments };
}

Deno.test("the reference output passes, with positive coverage at every rule", () => {
  const { dir, snap, moments } = synthetic();
  const out = referenceSqlOut(snap, moments);
  const r = compare(snap, out, moments);
  assertEquals(r.code, 0, r.lines.join("\n"));
  const reasons = new Set(out.due.flatMap((d) => d.rows.map((x) => `${x.reason}/${x.action}`)));
  for (const want of ["age_standard/propose", "age_work_report/propose", "deadline_passed/propose", "age_standard/pending", "age_standard/kept_recently", "age_standard/repropose", "age_standard/accepted"]) {
    assert(reasons.has(want), `no ${want} in ${[...reasons].join(" ")}`);
  }
  assert(out.client.some((c) => c.v) && out.client.some((c) => !c.v));
  assert(out.deadline.some((c) => c.v !== null));
  assert(out.work_report.some((c) => c.v) && out.work_report.some((c) => !c.v));
  assertEquals(out.fragments.length, 3);
  assert(out.loaded.client_ids > 0, "no item carries a client_id");
  assert(r.lines.some((l) => l.startsWith("COVER client_id: ")), r.lines.join("\n"));
  Deno.removeSync(dir, { recursive: true });
});

// Task 3.2 follow-up to Task 5.3: the due sets compared must include rows that
// the client_id rule alone decides, or a SQL mirror without the predicate would
// pass the diff.
Deno.test("client_id: the synthetic snapshot has due rows exempt only by client_id, and a SQL due set holding one FAILs", () => {
  const { dir, snap, moments } = synthetic();
  const c = (n: number) => `f5000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
  const only = clientIdOnlyExempt(snap, moments[0]).map((r) => r.item_id).sort();
  // 16 standard, 18 deadline, 20 lone first name, 22 fragment-flagged, 23 pending,
  // 25 kept more than 90 days ago (Codex review of PR 39, P2).
  assertEquals(only, [c(16), c(18), c(20), c(22), c(23), c(25)].sort());
  const reasons = clientIdOnlyExempt(snap, moments[0]).map((r) => `${r.reason}/${r.action}`).sort();
  assertEquals(reasons, ["age_standard/pending", "age_standard/propose", "age_standard/propose", "age_standard/repropose", "age_work_report/propose", "deadline_passed/propose"]);
  const base = referenceSqlOut(snap, moments);
  // Their null twins are in the reference due set; the client_id items are not.
  const due0 = new Set(base.due[0].rows.map((r) => r.item_id));
  for (const n of [17, 19, 21, 26]) assert(due0.has(c(n)), `twin ${n} not due`);
  for (const n of [16, 18, 20, 22, 23, 24, 25]) assert(!due0.has(c(n)), `${n} due`);
  // The kept null twin is re-proposed at every moment; its carrier never is.
  for (const d of base.due) {
    assert(d.rows.some((r) => r.item_id === c(26) && r.action === "repropose"), `26 not repropose at ${d.moment}`);
    assert(!d.rows.some((r) => r.item_id === c(25)), `25 due at ${d.moment}`);
  }
  const bad = JSON.parse(JSON.stringify(base));
  bad.due[0].rows.push(clientIdOnlyExempt(snap, moments[0])[0]);
  const r = compare(snap, bad, moments);
  assertEquals(r.code, 1, r.lines.join("\n"));
  assert(r.lines.some((l) => l.includes("sql only:")), r.lines.join("\n"));
  const noIds = JSON.parse(JSON.stringify(base));
  noIds.loaded.client_ids = 0;
  assertEquals(compare(snap, noIds, moments).code, 3);
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("client_id: a snapshot where no item carries one still compares, with a NOTE", () => {
  const s = synthetic();
  const items = JSON.parse(Deno.readTextFileSync(`${s.dir}/items.json`));
  for (const i of items) i.client_id = null;
  Deno.writeTextFileSync(`${s.dir}/items.json`, JSON.stringify(items));
  const snap = loadSnapshot(s.dir);
  const r = compare(snap, referenceSqlOut(snap, s.moments), s.moments);
  assertEquals(r.code, 0, r.lines.join("\n"));
  assert(r.lines.some((l) => l.startsWith("NOTE no open item carries a client_id")), r.lines.join("\n"));
  Deno.removeSync(s.dir, { recursive: true });
});

Deno.test("selftest: every guard holds on the reference output", () => {
  const { dir, snap, moments } = synthetic();
  const r = selftest(snap, referenceSqlOut(snap, moments), moments);
  assert(r.ok, r.lines.join("\n"));
  assert(!r.lines.some((l) => l.startsWith("SKIPPED")), r.lines.join("\n"));
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("Codex's controls: one-row arrays and an object for due are INCOMPLETE, not PASS", () => {
  const { dir, snap, moments } = synthetic();
  const base = referenceSqlOut(snap, moments);
  const subset = JSON.parse(JSON.stringify(base));
  for (const k of ["work_report", "deadline", "client", "adversarial"]) subset[k].splice(1);
  assertEquals(compare(snap, subset, moments).code, 3);
  const noDue = JSON.parse(JSON.stringify(base));
  noDue.due = {};
  assertEquals(compare(snap, noDue, moments).code, 3);
  const emptyWr = JSON.parse(JSON.stringify(base));
  emptyWr.work_report = [];
  assertEquals(compare(snap, emptyWr, moments).code, 3);
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("an unsupported snapshot is INCOMPLETE, never compared", () => {
  const { dir, moments } = synthetic();
  const d = JSON.parse(Deno.readTextFileSync(`${dir}/decisions.json`));
  delete d[0].item_generation;
  Deno.writeTextFileSync(`${dir}/decisions.json`, JSON.stringify(d));
  const snap = loadSnapshot(dir);
  const r = compare(snap, referenceSqlOut(snap, moments), moments);
  assertEquals(r.code, 3);
  assert(r.lines.some((l) => l.includes("unsupported snapshot")), r.lines.join("\n"));
  Deno.removeSync(dir, { recursive: true });
});

// Codex second re-review of PR 24 (2026-11-18): a null fragment entry crashed
// compare with a TypeError, Deno exited 1, and the shell counted it as a
// completed FAIL. Malformed members are INCOMPLETE; a crash is never a FAIL.
Deno.test("a null or mistyped fragment entry is INCOMPLETE, named as such, not a crash", () => {
  const { dir, snap, moments } = synthetic();
  const base = referenceSqlOut(snap, moments);
  for (const [label, bad] of [["null", null], ["string generation", { item_id: base.fragments[0].item_id, item_generation: "0" }], ["numeric id", { item_id: 7, item_generation: 0 }], ["boolean generation", { item_id: base.fragments[0].item_id, item_generation: true }]] as const) {
    const s = JSON.parse(JSON.stringify(base));
    s.fragments[0] = bad;
    const r = compare(snap, s, moments);
    assertEquals(r.code, 3, `${label}: ${r.lines.join("\n")}`);
    assert(r.lines.some((l) => l.startsWith("INCOMPLETE fragments: malformed row #0")), `${label}: ${r.lines.join("\n")}`);
  }
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("a fragment row whose generation is null is legitimate and still compares", () => {
  const { dir, moments } = synthetic();
  const d = JSON.parse(Deno.readTextFileSync(`${dir}/decisions.json`));
  d[0].item_generation = null;
  Deno.writeTextFileSync(`${dir}/decisions.json`, JSON.stringify(d));
  const snap = loadSnapshot(dir);
  assertEquals(snap.unsupported, []);
  const out = referenceSqlOut(snap, moments);
  assert(out.fragments.some((f) => f.item_generation === null));
  const r = compare(snap, out, moments);
  assertEquals(r.code, 0, r.lines.join("\n"));
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("null rows and non-string ids elsewhere are INCOMPLETE, not a crash", () => {
  const { dir, snap, moments } = synthetic();
  const base = referenceSqlOut(snap, moments);
  const cases: Array<[string, (s: Record<string, unknown[]>) => void, string]> = [
    ["null work_report row", (s) => { s.work_report[0] = null; }, "INCOMPLETE work_report: malformed row #0"],
    ["array id", (s) => { const r = s.client[0] as { id: unknown }; r.id = [r.id]; }, "INCOMPLETE client_shaped: malformed row #0"],
    ["string index", (s) => { (s.adversarial[0] as { i: unknown }).i = "0"; }, "INCOMPLETE adversarial: malformed row #0"],
  ];
  for (const [label, mut, want] of cases) {
    const s = JSON.parse(JSON.stringify(base));
    mut(s);
    const r = compare(snap, s, moments);
    assertEquals(r.code, 3, `${label}: ${r.lines.join("\n")}`);
    assert(r.lines.some((l) => l.startsWith(want)), `${label}: ${r.lines.join("\n")}`);
  }
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("a null decisions.json row is an unsupported snapshot, not a crash", () => {
  const { dir, moments } = synthetic();
  const d = JSON.parse(Deno.readTextFileSync(`${dir}/decisions.json`));
  d.push(null);
  Deno.writeTextFileSync(`${dir}/decisions.json`, JSON.stringify(d));
  const snap = loadSnapshot(dir);
  const r = compare(snap, referenceSqlOut(snap, moments), moments);
  assertEquals(r.code, 3);
  assert(r.lines.some((l) => l.includes("not an object")), r.lines.join("\n"));
  Deno.removeSync(dir, { recursive: true });
});

// Codex third re-review of PR 24 (2026-11-18): decisions.json holding valid JSON
// "" iterated to zero rows in BOTH loaders, so the full-shell diff and self-test
// passed over a lost file. Every snapshot file must be an array of objects; an
// empty array stays legitimate. The shell's own loader is proven by --load-selftest.
function withFile(file: string, raw: string) {
  const s = synthetic();
  Deno.writeTextFileSync(`${s.dir}/${file}`, raw);
  return { ...s, snap: loadSnapshot(s.dir) };
}

Deno.test("a snapshot file that is valid JSON but not an array is unsupported (INCOMPLETE), not an empty list", () => {
  const cases: Array<[string, string, string]> = [];
  for (const raw of ['""', '"x"', "null", "{}", "true", "0"]) cases.push(["decisions.json", raw, `decisions.json is not an array: ${raw}`]);
  cases.push(["thoughts.json", '""', 'thoughts.json is not an array: ""'], ["items.json", "{}", "items.json is not an array: {}"],
    ["clients.json", "null", "clients.json is not an array: null"], ["cards.json", "0", "cards.json is not an array: 0"]);
  for (const [file, raw, want] of cases) {
    const { dir, snap, moments } = withFile(file, raw);
    assert(snap.unsupported.includes(want), `${file}=${raw}: ${JSON.stringify(snap.unsupported)}`);
    const r = compare(snap, referenceSqlOut(snap, moments), moments);
    assertEquals(r.code, 3, `${file}=${raw}: ${r.lines.join("\n")}`);
    assert(r.lines.includes(`INCOMPLETE unsupported snapshot: ${want}`), r.lines.join("\n"));
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("an empty decisions array is a legitimate snapshot: no fragments, compared, passes", () => {
  const { dir, snap, moments } = withFile("decisions.json", "[]");
  assertEquals(snap.unsupported, []);
  assertEquals(snap.fragments, []);
  const r = compare(snap, referenceSqlOut(snap, moments), moments);
  assertEquals(r.code, 0, r.lines.join("\n"));
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("a snapshot row that is not an object, or whose key has the wrong type, is unsupported", () => {
  const rows = (file: string) => {
    const s = synthetic();
    const v = JSON.parse(Deno.readTextFileSync(`${s.dir}/${file}`));
    Deno.removeSync(s.dir, { recursive: true });
    return v as Array<Record<string, unknown>>;
  };
  const cases: Array<[string, unknown[], string]> = [
    ["decisions.json", [...rows("decisions.json"), 5], "is not an object: 5"],
    ["decisions.json", [...rows("decisions.json"), []], "is not an object: []"],
    ["thoughts.json", ["t1", ...rows("thoughts.json")], "thoughts.json row #0 is not an object: \"t1\""],
    ["thoughts.json", [{ ...rows("thoughts.json")[0], id: 5 }], "thoughts.json row #0 has id 5"],
    ["items.json", [{ description: "x" }], "items.json row #0 has id missing"],
    ["items.json", [{ id: "i1", description: "x" }], "items.json row #0 has client_id missing"],
    ["items.json", [{ ...rows("items.json")[0], client_id: 5 }], "items.json row #0 has client_id 5"],
    ["clients.json", [{ id: "c1", name: null }], "clients.json row #0 has name null"],
    ["cards.json", [{ id: "k1", status: "Agent Todo", archived_at: null, linked_action_item_id: ["i1"] }], 'cards.json row #0 has linked_action_item_id ["i1"]'],
  ];
  for (const [file, v, want] of cases) {
    const { dir, snap, moments } = withFile(file, JSON.stringify(v));
    assert(snap.unsupported.some((u) => u.endsWith(want)), `${file}: ${JSON.stringify(snap.unsupported)}`);
    assertEquals(compare(snap, referenceSqlOut(snap, moments), moments).code, 3, file);
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("a card with no linked item (null) is legitimate and still compares", () => {
  const s = synthetic();
  const cards = JSON.parse(Deno.readTextFileSync(`${s.dir}/cards.json`));
  cards[0].linked_action_item_id = null;
  Deno.writeTextFileSync(`${s.dir}/cards.json`, JSON.stringify(cards));
  const snap = loadSnapshot(s.dir);
  assertEquals(snap.unsupported, []);
  assertEquals(compare(snap, referenceSqlOut(snap, s.moments), s.moments).code, 0);
  Deno.removeSync(s.dir, { recursive: true });
});

Deno.test("the partial-name arm is covered on its own: 'nudge Jordan' is client-shaped through the partial arm only", () => {
  const { dir, snap, moments } = synthetic();
  const out = referenceSqlOut(snap, moments);
  const idx = (t: string) => ADVERSARIAL.findIndex((a) => a.text === t);
  for (const [t, want] of [["nudge Jordan", true], ["nudge Mira", false], ["nudge jake", false]] as const) {
    const i = idx(t);
    assert(i >= 0, `no edge case "${t}"`);
    assertEquals(out.adversarial[i].cs, want, t);
    // No client's FULL name is in it, so only the partial arm can say true.
    assertEquals(isClientShaped(t, snap.clientNames.filter((n) => !n.startsWith("Jordan"))), false, t);
  }
  Deno.removeSync(dir, { recursive: true });
});

// The CLI, as the shell runs it: the exit code AND the verdict line.
const DIFF = new URL("./archive-proposals-diff.ts", import.meta.url);
async function cli(mod: URL | string, ...args: string[]) {
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-lock", "--allow-read", String(mod), ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(o.stdout) + new TextDecoder().decode(o.stderr);
  const last = text.split("\n").filter((l) => l.trim()).at(-1) ?? "";
  return { code: o.code, text, last };
}
function writeOut(dir: string, v: unknown) {
  const p = `${dir}/sql.json`;
  Deno.writeTextFileSync(p, JSON.stringify(v));
  return p;
}

Deno.test("CLI: pass, wrong value, null fragment and unreadable snapshot give 0, 1, 3, 3 with their verdict lines", async () => {
  const { dir, snap, moments } = synthetic();
  const base = referenceSqlOut(snap, moments);
  const m = moments.join(",");
  let r = await cli(DIFF, "compare", dir, writeOut(dir, base), m);
  assertEquals([r.code, r.last], [0, "ARCHIVE PROPOSALS DIFF PASSED"], r.text);
  r = await cli(DIFF, "selftest", dir, writeOut(dir, base), m);
  assertEquals([r.code, r.last], [0, "DIFF SELFTEST PASSED"], r.text);
  const wrong = JSON.parse(JSON.stringify(base));
  wrong.client[0].v = !wrong.client[0].v;
  r = await cli(DIFF, "compare", dir, writeOut(dir, wrong), m);
  assertEquals([r.code, r.last], [1, "ARCHIVE PROPOSALS DIFF FAILED (1)"], r.text);
  assert(r.text.split("\n").some((l) => l.startsWith("FAIL client_shaped")), r.text);
  const nul = JSON.parse(JSON.stringify(base));
  nul.fragments[0] = null;
  r = await cli(DIFF, "compare", dir, writeOut(dir, nul), m);
  assertEquals([r.code, r.last], [3, "ARCHIVE PROPOSALS DIFF INCOMPLETE: nothing was judged"], r.text);
  assert(!r.text.includes("FAILED") && !r.text.includes("Uncaught"), r.text);
  const sqlPath = writeOut(dir, base);
  r = await cli(DIFF, "compare", `${dir}/no-such-snapshot`, sqlPath, m);
  assertEquals([r.code, r.last], [3, "ARCHIVE PROPOSALS DIFF INCOMPLETE: nothing was judged"], r.text);
  assert(r.text.includes("the snapshot is not readable"), r.text);
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("CLI: decisions.json of \"\" is INCOMPLETE (3); an empty array passes (0)", async () => {
  for (const [raw, code, last] of [['""', 3, "ARCHIVE PROPOSALS DIFF INCOMPLETE: nothing was judged"], ["[]", 0, "ARCHIVE PROPOSALS DIFF PASSED"]] as const) {
    const { dir, snap, moments } = withFile("decisions.json", raw);
    const r = await cli(DIFF, "compare", dir, writeOut(dir, referenceSqlOut(snap, moments)), moments.join(","));
    assertEquals([r.code, r.last], [code, last], `${raw}: ${r.text}`);
    if (code === 3) assert(r.text.includes('INCOMPLETE unsupported snapshot: decisions.json is not an array: ""'), r.text);
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("CLI: an exception thrown inside compare or selftest is INCOMPLETE (3), never Deno's uncaught exit 1", async () => {
  const { dir, snap, moments } = synthetic();
  const sqlPath = writeOut(dir, referenceSqlOut(snap, moments));
  const src = Deno.readTextFileSync(DIFF);
  const policy = new URL("../../supabase/functions/_shared/archive-policy.ts", import.meta.url).href;
  for (const [fn, mode] of [["compare", "compare"], ["selftest", "selftest"], ["compare", "selftest"]] as const) {
    const sig = fn === "compare"
      ? "export function compare(snap: Snapshot, sql: SqlOut, moments: string[]): CompareResult {\n"
      : "export function selftest(snap: Snapshot, base: SqlOut, moments: string[]): { ok: boolean; lines: string[] } {\n";
    assertEquals(src.split(sig).length, 2, `one ${fn} signature`);
    const injected = src
      .replace(sig, `${sig}  if (moments.length >= 0) throw new TypeError("injected fault in ${fn}");\n`)
      .replace('"../../supabase/functions/_shared/archive-policy.ts"', JSON.stringify(policy));
    const tmp = Deno.makeTempFileSync({ prefix: "obap-inject-", suffix: ".ts" });
    Deno.writeTextFileSync(tmp, injected);
    const r = await cli(new URL(`file://${tmp}`), mode, dir, sqlPath, moments.join(","));
    Deno.removeSync(tmp);
    if (fn === "compare" && mode === "selftest") {
      // selftest catches a throwing compare per control: UNGUARDED, exit 1 with
      // its FAILED line, which the shell reads as NEVER-RAN (never a pass).
      assertEquals([r.code, r.last], [1, "DIFF SELFTEST FAILED"], r.text);
      assert(r.text.includes("exit exception"), r.text);
      continue;
    }
    assertEquals([r.code, r.last], [3, "ARCHIVE PROPOSALS DIFF INCOMPLETE: nothing was judged"], `${fn}/${mode}: ${r.text}`);
    assert(r.text.includes(`injected fault in ${fn}`) && !r.text.includes("Uncaught"), r.text);
  }
  Deno.removeSync(dir, { recursive: true });
});
