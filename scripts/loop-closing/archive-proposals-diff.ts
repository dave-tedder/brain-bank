// Loop-closing Task 3.2, Step 2: prove the SQL job mirrors archive-policy.ts.
// Driven by archive-proposals-sql-test.sh --diff <snapshot-dir>; never run alone
// against production.
//
//   emit-adversarial              print the hand-written edge cases as JSON
//   emit-snapshot <dir>           write a synthetic snapshot built from the edge
//                                 cases and a set of state fixtures (see below).
//                                 Nothing private: commit-safe.
//   compare <snap> <sqlout> <m,m> compare SQL output with the TypeScript
//   selftest <snap> <sqlout> <m,m> prove compare's guards on that SQL output
//
// Exit codes, never two (the PR 23 rule, extended for the diff):
//   0  every comparison ran over its complete inventory and agreed.
//   1  FAIL: a comparison ran over its complete inventory and SQL disagreed with
//      the TypeScript. Only this is a behavioral finding (or a caught mutant).
//   3  INCOMPLETE: the SQL output did not cover what the snapshot says it must
//      (a missing, duplicated or unexpected id, adversarial index or moment; a
//      malformed value or row, including a null fragment entry; zero rows; the
//      SQL side loaded different rows than the TypeScript reads; an unsupported
//      snapshot), OR the comparison itself did not run to completion (an
//      unreadable snapshot or SQL output, or any exception while comparing).
//      Nothing was judged, so this is never a behavioral finding. The shell
//      reports it as NEVER-RAN.
//   2  usage error.
//
// A completed comparison always ends with exactly one verdict line, printed only
// after compare() has returned: "ARCHIVE PROPOSALS DIFF PASSED" (exit 0) or
// "ARCHIVE PROPOSALS DIFF FAILED (<n>)" (exit 1). An uncaught exception also
// exits 1 in Deno, so the shell trusts exit 1 only together with that last line
// (Codex second re-review of PR 24, 2026-11-18: a null fragment entry crashed
// compare and the shell counted the crash as a completed FAIL).
//
// Comparisons, each over every row it can reach, never a sample:
//   work_report   archive_policy_is_work_report vs sourceIsWorkReport, for exactly
//                 the snapshot thoughts some item names as its source
//   deadline      archive_policy_deadline vs deadlineFrom, exactly every item
//   client        archive_policy_client_shaped vs isClientShaped, exactly every item
//   adversarial   all three functions over exactly every edge case, by index
//   due@<moment>  archive_proposals_due vs archiveDueRows over every open item, at
//                 exactly the moments the shell asked for; id, reason, action and
//                 due_at to the ms, as a multiset (a repeated SQL row is a FAIL)
//   loaded        the row counts SQL loaded, and the fragment decision rows it
//                 holds, must equal what the TypeScript reads from the snapshot
//                 (Codex re-review of PR 24: the loader once skipped decisions.json
//                 while the TypeScript read its fragment rows); client_ids, the
//                 items carrying a Task 5.3 client_id, is one of those counts
//   client_id     not a comparison of its own: a COVER line says how many items
//                 carry a client_id and how many due rows exist only because of
//                 it (what the TypeScript would propose with client_id cleared),
//                 so a reader sees the due sets compared rows the rule decides
//
// The accepted exception (the operator, 2026-11-18): a session NUMBER shaped like an ISO
// date, e.g. "session 2026-11-02 x 2026-12-30" captured 2026-11-02, is a dated
// header to JavaScript (its first date is inside the number) and not to SQL (the
// tail starts after the number). It is documented, not fixed, and is NOT among
// the edge cases below, since it is a known split, not a regression. KNOWN_SPLITS
// carries it so every diff run reports whether it still holds.

import {
  archiveDueRows,
  type ArchivePolicyItem,
  deadlineFrom,
  isClientShaped,
  sourceIsWorkReport,
} from "../../supabase/functions/_shared/archive-policy.ts";

// Edge cases chosen to split a careless port: JS \b vs Postgres \y, greediness
// of the dated header, case flags per shape, date validity, the clause break,
// the 24-character window, possessives and capitalisation.
export const ADVERSARIAL: Array<{ text: string; captured_at: string }> = [
  { text: "Session 86 (2026-11-02): shipped it, see SESSION-LOG.md", captured_at: "2026-11-02T20:00:00Z" },
  { text: "session 86 (2026-11-02)", captured_at: "2026-11-02T20:00:00Z" },
  { text: "session 2 (2026-12-12): send the revised koi", captured_at: "2026-11-02T20:00:00Z" },
  { text: "session 2 (2026-12-12 and 2026-11-01) handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "session 2 2026-11-01 handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "session 1 then session 2 2026-11-01", captured_at: "2026-11-02T20:00:00Z" },
  { text: "session 12 abcdefghijklmnopqrstuvwxy 2026-11-01 handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "session 12 abcdefghijklmnopqrstuvw 2026-11-01 handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "session 12 (\n2026-11-01) handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "session 12 2026-02-30 handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "session 12 0099-01-01 handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "session 12 2026-11-03 handoff", captured_at: "2026-11-02T00:00:00Z" },
  { text: "session 12 2026-11-03 handoff", captured_at: "2026-11-01T23:59:59Z" },
  { text: "session 1 2026-11-01session 2", captured_at: "2026-11-02T20:00:00Z" },
  { text: "session 5 2026-11-012 handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "SESSION 5 2026-11-01", captured_at: "2026-11-02T20:00:00Z" },
  { text: "session5 handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "Handoff: see project-tracker.md and commit ABCDEF1", captured_at: "2026-11-02T20:00:00Z" },
  { text: "HANDOFF (abcdef12) [OE:1234abcd", captured_at: "2026-11-02T20:00:00Z" },
  { text: "[oe:1234abcd] deliverables/brain-bank/x.md", captured_at: "2026-11-02T20:00:00Z" },
  { text: "deliverables/x handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "Deliverables/a/b.md handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "Deployed 2026-11-01 and TASK 1234ABCD", captured_at: "2026-11-02T20:00:00Z" },
  { text: "deployed 2025-11-01 handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "commit\tabc1234 handoffs", captured_at: "2026-11-02T20:00:00Z" },
  { text: "xcommit abc1234 (abc1234)", captured_at: "2026-11-02T20:00:00Z" },
  { text: "PROJECT-TRACKER.mdx SESSION-LOG.md", captured_at: "2026-11-02T20:00:00Z" },
  { text: "need to flip the Riverside venue in April 2027 by 2027-03-01", captured_at: "2026-11-02T20:00:00Z" },
  { text: "compare Fluent Forms entries per page for the 60 days before and after, from 2026-12-22", captured_at: "2026-11-02T20:00:00Z" },
  { text: "due on Friday 2026-12-04; by: 2026-12-01 until (2027-01-05).", captured_at: "2026-11-02T20:00:00Z" },
  { text: "BY 2026-12-01, after.2026-12-09 before—2026-12-10", captured_at: "2026-11-02T20:00:00Z" },
  { text: "  by   2026-12-01  ", captured_at: "2026-11-02T20:00:00Z" },
  { text: "nudge Jordan if nothing arrives; ask Mira; Paul Reyes's pergola", captured_at: "2026-11-02T20:00:00Z" },
  { text: "chris and CHRIS and Chris's", captured_at: "2026-11-02T20:00:00Z" },
  { text: "Jo, Ann, Delivery proof, Ingest drill", captured_at: "2026-11-02T20:00:00Z" },
  { text: "Café Ångström Émile", captured_at: "2026-11-02T20:00:00Z" },
  // Word boundaries: JavaScript's \b is ASCII [A-Za-z0-9_]; Postgres \y and
  // [[:alnum:]] read the locale, where an accented letter is a word character
  // (Codex review of PR 24, 2026-11-18). Underscore cases are the controls:
  // underscore is a word character to both.
  { text: "ésession 12 handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "session 12 handoffé", captured_at: "2026-11-02T20:00:00Z" },
  { text: "_session 12 handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "session 12 handoff_", captured_at: "2026-11-02T20:00:00Z" },
  { text: "session 12_ handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "Ésession 5 é2026-11-01é", captured_at: "2026-11-02T20:00:00Z" },
  { text: "session 5 _2026-11-01", captured_at: "2026-11-02T20:00:00Z" },
  { text: "session 5 2026-11-01_", captured_at: "2026-11-02T20:00:00Z" },
  { text: "écommit abc1234é handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "commit abc1234_ handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "éPROJECT-TRACKER.mdé handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "PROJECT-TRACKER.md_ handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "édeliverables/a/b.md handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "_deliverables/a/b.md handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "éshipped 2026-11-01é handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "shipped 2026-11-01_ handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "étask 1234abcdé handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "_task 1234abcd handoff", captured_at: "2026-11-02T20:00:00Z" },
  // Letters outside Latin-1, a non-ASCII digit, and the two characters that
  // case-fold onto ASCII under JavaScript /iu but not /i (Kelvin sign, long s).
  { text: "λsession 3 handoffж", captured_at: "2026-11-02T20:00:00Z" },
  { text: "会session 3 handoff会", captured_at: "2026-11-02T20:00:00Z" },
  { text: "\u0663session 3 handoff", captured_at: "2026-11-02T20:00:00Z" },
  { text: "\u212Asession 3 handoff\u017F", captured_at: "2026-11-02T20:00:00Z" },
  { text: "\u017Fession 3 handoff tas\u212A 1234abcd", captured_at: "2026-11-02T20:00:00Z" },
  // ASCII neighbours still block, as they did under \y.
  { text: "xsession 12 handoffs", captured_at: "2026-11-02T20:00:00Z" },
  { text: "", captured_at: "2026-11-02T20:00:00Z" },
];

// JavaScript \s, all 25 code points (an exhaustive scan under Deno 2.9.3), and
// three that are NOT whitespace to JavaScript. Postgres \s under en_US.UTF-8
// missed U+FEFF (Codex re-review of PR 24, 2026-11-18).
export const JS_WHITESPACE = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];
export const NOT_JS_WHITESPACE = [0x85, 0x180e, 0x200b];
const CAP = "2026-11-02T20:00:00Z";
const ch = (cp: number) => String.fromCodePoint(cp);
const EMOJI = "\u{1F600}";
for (const cp of [...JS_WHITESPACE, ...NOT_JS_WHITESPACE]) {
  // The commit shape's \s+ and the deadline's token split, one character each.
  ADVERSARIAL.push({ text: `commit${ch(cp)}abcdef1 handoff`, captured_at: CAP });
  ADVERSARIAL.push({ text: `reply by${ch(cp)}2026-12-30`, captured_at: CAP });
}
ADVERSARIAL.push(
  // A U+FEFF that joins two tokens moves the keyword into the three-token window.
  { text: "by x\uFEFFy z 2026-12-30", captured_at: CAP },
  { text: "by x y z 2026-12-30", captured_at: CAP },
  { text: "by\uFEFF\uFEFFthe 2026-12-30", captured_at: CAP },
  // The dated header's 24 is UTF-16 code units: a character above U+FFFF is two.
  { text: `session 1 ${EMOJI.repeat(11)} 2026-11-01`, captured_at: CAP }, // 24 units: header
  { text: `session 1 ${EMOJI.repeat(12)} 2026-11-01`, captured_at: CAP }, // 26 units, 14 chars
  { text: `session 1 ${EMOJI.repeat(13)} 2026-11-01`, captured_at: CAP },
  { text: `session 1 ${EMOJI.repeat(22)} 2026-11-01`, captured_at: CAP },
  { text: `session 1 ${"a".repeat(20)}${EMOJI} 2026-11-01`, captured_at: CAP }, // 24 units
  { text: `session 1 ${"a".repeat(21)}${EMOJI} 2026-11-01`, captured_at: CAP }, // 25 units, 24 chars
  { text: `session 1 ${"é".repeat(22)} 2026-11-01`, captured_at: CAP }, // BMP: 24 both ways
  { text: `session 1 ${"é".repeat(23)} 2026-11-01`, captured_at: CAP },
  { text: `session 1 (2026-11-01) ${EMOJI.repeat(30)} handoff`, captured_at: CAP },
  { text: `session 1 ${EMOJI}\n2026-11-01`, captured_at: CAP },
  // Lowercasing: JavaScript turns U+0130 into "i" + U+0307 and U+212A into "k";
  // Postgres lower() turned U+0130 into a bare "i". Clients in the synthetic
  // snapshot include "İpek Kaya", "Ipek Demir" and "\u212Aira Lee".
  { text: "notify i\u0307pek kaya", captured_at: CAP },
  { text: "notify ipek kaya", captured_at: CAP },
  { text: "notify İpek Kaya", captured_at: CAP },
  { text: "notify I\u0307pek Kaya", captured_at: CAP },
  { text: "notify İPEK KAYA", captured_at: CAP },
  { text: "ask Ipek about the swatch", captured_at: CAP },
  { text: "ask İpek about the swatch", captured_at: CAP },
  { text: "ask kira lee and Kira", captured_at: CAP },
  { text: "ask \u212Aira Lee", captured_at: CAP },
  { text: "UNTİL 2026-12-30", captured_at: CAP },
  { text: "ÜNTIL 2026-12-30 or by\u212A 2026-12-31", captured_at: CAP },
  { text: "perpetual trİpwire, do not resolve", captured_at: CAP },
  { text: "Perpetual TRIPWIRE, do not resolve", captured_at: CAP },
  { text: "sessİon 12 handoff and ses\u0131on 12", captured_at: CAP },
);
// The partial-name arm ON ITS OWN. "nudge Jordan ...; Paul Reyes's pergola" above also
// matches Paul Reyes's full name, so a broken partial arm could hide behind the
// full-name arm (Codex second re-review of PR 24: removing the needle's
// lowercasing survived the stock diff). "Jordan" is in two client names (true);
// "Mira" is in one (false); a lowercase word is never a partial needle (false).
// Appended, so every earlier index keeps its number.
ADVERSARIAL.push(
  { text: "nudge Jordan", captured_at: CAP },
  { text: "nudge Mira", captured_at: CAP },
  { text: "nudge jake", captured_at: CAP },
);

// Known, documented splits: compared every run and reported, never failed.
export const KNOWN_SPLITS: Array<{ text: string; captured_at: string; ts: boolean; sql: boolean; note: string }> = [
  {
    text: "session 2026-11-02 x 2026-12-30",
    captured_at: "2026-11-02T00:00:00Z",
    ts: true,
    sql: false,
    note: "four-digit-session exception, accepted by the operator 2026-11-18",
  },
];

export type DueRow = { item_id: string; reason: string; due_at: string; action: string };
export type SqlOut = {
  loaded: { thoughts: number; items: number; client_ids: number; clients: number; cards: number; fragments: number };
  fragments: Array<{ item_id: string; item_generation: number | null }>;
  work_report: Array<{ id: string; v: boolean }>;
  deadline: Array<{ id: string; v: string | null }>;
  client: Array<{ id: string; v: boolean }>;
  adversarial: Array<{ i: number; wr: boolean; dl: string | null; cs: boolean }>;
  known: Array<{ i: number; wr: boolean }>;
  due: Array<{ moment: string; rows: DueRow[] }>;
};

export type SnapItem = ArchivePolicyItem & { source_thought_id: string | null; reopen_generation: number };
export interface Snapshot {
  items: SnapItem[];
  thoughts: Map<string, { content: string; created_at: string }>;
  thoughtCount: number;
  clientNames: string[];
  cardCount: number;
  openCards: Set<string>;
  fragments: Array<{ item_id: string; item_generation: number | null }>;
  unsupported: string[];
}

// Every snapshot file must be an array of objects, and that is checked BEFORE it
// is iterated: valid JSON of another shape ("" or null) iterates to nothing in
// both JavaScript and Python, so a lost file read as an empty list on BOTH sides
// of the diff, which then agreed and passed (Codex third re-review of PR 24,
// 2026-11-18). A row's key field must also have its column's type. An empty
// array stays a legitimate snapshot: a database can have no fragment decisions.
// The Python loader in archive-proposals-sql-test.sh applies the same rules.
export const SNAPSHOT_FILES = [
  { file: "thoughts.json", key: "id", nullable: false },
  { file: "items.json", key: "id", nullable: false },
  { file: "clients.json", key: "name", nullable: false },
  { file: "cards.json", key: "linked_action_item_id", nullable: true },
  { file: "decisions.json", key: null, nullable: false },
] as const;

function loadRows(dir: string, file: string, key: string | null, nullable: boolean, unsupported: string[]) {
  const v: unknown = JSON.parse(Deno.readTextFileSync(`${dir}/${file}`));
  const show = (x: unknown) => JSON.stringify(x)?.slice(0, 80) ?? "missing";
  if (!Array.isArray(v)) {
    unsupported.push(`${file} is not an array: ${show(v)}`);
    return [];
  }
  const arr = v as unknown[];
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < arr.length; i++) {
    const r = arr[i];
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      unsupported.push(`${file} row #${i} is not an object: ${show(r)}`);
      continue;
    }
    const k = key === null ? "" : (r as Record<string, unknown>)[key];
    if (key !== null && !(typeof k === "string" || (nullable && k === null))) {
      unsupported.push(`${file} row #${i} has ${key} ${show(k)}`);
      continue;
    }
    rows.push(r as Record<string, unknown>);
  }
  return rows;
}

export function loadSnapshot(dir: string): Snapshot {
  const unsupported: string[] = [];
  const f = Object.fromEntries(
    SNAPSHOT_FILES.map((s) => [s.file, loadRows(dir, s.file, s.key, s.nullable, unsupported)]),
  );
  const thoughtsArr = f["thoughts.json"] as Array<{ id: string; content: string; created_at: string }>;
  const cards = f["cards.json"] as Array<{ status: string; archived_at: string | null; linked_action_item_id: string }>;
  const fragments: Array<{ item_id: string; item_generation: number | null }> = [];
  for (const d of f["decisions.json"]) {
    if (d.layer !== "fragment") continue;
    for (const k of ["item_id", "item_generation", "thought_id", "candidate_description", "outcome", "reason"]) {
      if (!(k in d)) unsupported.push(`decisions.json fragment row without ${k}`);
    }
    if (d.item_generation !== null && !Number.isInteger(d.item_generation)) {
      unsupported.push(`decisions.json fragment row with item_generation ${JSON.stringify(d.item_generation)}`);
    }
    fragments.push({ item_id: String(d.item_id), item_generation: (d.item_generation ?? null) as number | null });
  }
  // client_id (Task 5.3) decides an exemption, so every item must carry it, null
  // or a string: a snapshot exported before the column existed would otherwise
  // read as all-null. Same rule as build_load_sql in archive-proposals-sql-test.sh.
  f["items.json"].forEach((r, i) => {
    const c = "client_id" in r ? r.client_id : undefined;
    if (!(c === null || typeof c === "string")) {
      unsupported.push(`items.json row #${i} has client_id ${c === undefined ? "missing" : JSON.stringify(c)?.slice(0, 80)}`);
    }
  });
  return {
    items: f["items.json"] as unknown as SnapItem[],
    thoughts: new Map(thoughtsArr.map((t) => [t.id, t])),
    thoughtCount: thoughtsArr.length,
    clientNames: f["clients.json"].map((c) => c.name as string),
    cardCount: cards.length,
    openCards: new Set(
      cards.filter((c) => !c.archived_at && c.status !== "Agent Done").map((c) => c.linked_action_item_id),
    ),
    fragments,
    unsupported: [...new Set(unsupported)],
  };
}

const isoDate = (t: number | null) => (t === null ? null : new Date(t).toISOString().slice(0, 10));
const isoMoment = (m: string) => {
  const t = Date.parse(m);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

function tsDue(snap: Snapshot, moment: string, clearClientIds = false): DueRow[] {
  const byId = new Map(snap.items.map((i) => [i.id, i]));
  return archiveDueRows(
    clearClientIds ? snap.items.map((i) => ({ ...i, client_id: null })) : snap.items,
    (it) => {
      const full = byId.get(it.id)!;
      const src = full.source_thought_id ? snap.thoughts.get(full.source_thought_id) : undefined;
      return {
        sourceIsWorkReport: sourceIsWorkReport(src?.content, src?.created_at),
        fragmentFlagged: snap.fragments.some((f) =>
          f.item_id === it.id && f.item_generation === full.reopen_generation
        ),
        linkedToOpenCard: snap.openCards.has(it.id),
        clientNames: snap.clientNames,
      };
    },
    new Date(moment),
  );
}

const clientIdCount = (snap: Snapshot) =>
  snap.items.filter((i) => i.client_id !== null && i.client_id !== undefined).length;

/** Due rows that exist only because an item carries a client_id: what the
 * TypeScript would propose at this moment with every client_id cleared, minus
 * what it proposes as the items stand. */
export function clientIdOnlyExempt(snap: Snapshot, moment: string): DueRow[] {
  const real = new Set(tsDue(snap, moment).map((r) => r.item_id));
  return tsDue(snap, moment, true).filter((r) => !real.has(r.item_id));
}

/** The output a perfect SQL mirror would produce: the TypeScript reference in
 * the SQL output's shape. Used by the self-test and its unit test only. */
export function referenceSqlOut(snap: Snapshot, moments: string[]): SqlOut {
  const sources = new Set(snap.items.map((i) => i.source_thought_id).filter(Boolean));
  return {
    loaded: {
      thoughts: snap.thoughtCount,
      items: snap.items.length,
      client_ids: clientIdCount(snap),
      clients: snap.clientNames.length,
      cards: snap.cardCount,
      fragments: snap.fragments.length,
    },
    fragments: snap.fragments.map((f) => ({ ...f })),
    work_report: [...snap.thoughts.entries()].filter(([id]) => sources.has(id)).map(([id, t]) => ({
      id,
      v: sourceIsWorkReport(t.content, t.created_at),
    })),
    deadline: snap.items.map((i) => ({ id: i.id, v: isoDate(deadlineFrom(i.description)) })),
    client: snap.items.map((i) => ({ id: i.id, v: isClientShaped(i.description, snap.clientNames) })),
    adversarial: ADVERSARIAL.map((a, i) => ({
      i,
      wr: sourceIsWorkReport(a.text, a.captured_at),
      dl: isoDate(deadlineFrom(a.text)),
      cs: isClientShaped(a.text, snap.clientNames),
    })),
    known: KNOWN_SPLITS.map((k, i) => ({ i, wr: k.sql })),
    due: moments.map((m) => ({ moment: m, rows: tsDue(snap, m) })),
  };
}

export type CompareResult = { code: 0 | 1 | 3; lines: string[] };

/** Reconcile one result array's keys with the expected inventory. */
function inventory<K>(name: string, got: K[], expected: K[], show: (k: K) => string, out: string[]) {
  if (expected.length === 0) {
    out.push(`INCOMPLETE ${name}: the snapshot gives zero rows to compare`);
    return;
  }
  if (got.length === 0) {
    out.push(`INCOMPLETE ${name}: compared zero rows (expected ${expected.length})`);
    return;
  }
  const seen = new Map<string, number>();
  for (const k of got) seen.set(show(k), (seen.get(show(k)) ?? 0) + 1);
  const want = new Set(expected.map(show));
  const dup = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  const missing = [...want].filter((k) => !seen.has(k));
  const extra = [...seen.keys()].filter((k) => !want.has(k));
  if (dup.length) out.push(`INCOMPLETE ${name}: ${dup.length} duplicated, e.g. ${dup.slice(0, 3).join(" ")}`);
  if (missing.length) {
    out.push(`INCOMPLETE ${name}: ${missing.length} of ${want.size} missing, e.g. ${missing.slice(0, 3).join(" ")}`);
  }
  if (extra.length) out.push(`INCOMPLETE ${name}: ${extra.length} unexpected, e.g. ${extra.slice(0, 3).join(" ")}`);
}

export function compare(snap: Snapshot, sql: SqlOut, moments: string[]): CompareResult {
  const inc: string[] = [];
  for (const u of snap.unsupported) inc.push(`INCOMPLETE unsupported snapshot: ${u}`);
  const arr = (k: keyof SqlOut) => Array.isArray((sql as Record<string, unknown>)?.[k]);
  for (const k of ["fragments", "work_report", "deadline", "client", "adversarial", "known", "due"] as const) {
    if (!arr(k)) inc.push(`INCOMPLETE ${k}: missing or not an array in the SQL output`);
  }
  if (typeof sql?.loaded !== "object" || sql.loaded === null) inc.push("INCOMPLETE loaded: missing from the SQL output");
  if (inc.length) return { code: 3, lines: inc };

  // Every member is checked BEFORE anything below reads a field of it: a null or
  // mistyped entry is a malformed row (INCOMPLETE), never a crash. A fragment's
  // item_generation may legitimately be null; only its type is checked.
  const isGen = (g: unknown) => g === null || (typeof g === "number" && Number.isInteger(g));
  sql.fragments.forEach((f, i) => {
    const r = f as unknown as Record<string, unknown> | null;
    if (r === null || typeof r !== "object" || Array.isArray(r) || typeof r.item_id !== "string" || !isGen(r.item_generation)) {
      inc.push(`INCOMPLETE fragments: malformed row #${i} ${JSON.stringify(f)?.slice(0, 80)}`);
    }
  });
  const idRow = (name: string, rows: unknown[], field: "id" | "i") =>
    rows.forEach((x, n) => {
      const v = (x as Record<string, unknown> | null)?.[field];
      const ok = x !== null && typeof x === "object" && !Array.isArray(x) &&
        (field === "id" ? typeof v === "string" : typeof v === "number" && Number.isInteger(v));
      if (!ok) inc.push(`INCOMPLETE ${name}: malformed row #${n} ${JSON.stringify(x)?.slice(0, 80)}`);
    });
  idRow("work_report", sql.work_report, "id");
  idRow("deadline", sql.deadline, "id");
  idRow("client_shaped", sql.client, "id");
  idRow("adversarial", sql.adversarial, "i");
  idRow("known splits", sql.known, "i");
  if (inc.length) return { code: 3, lines: inc };

  // What SQL loaded must be what the TypeScript reads.
  const want = {
    thoughts: snap.thoughtCount,
    items: snap.items.length,
    client_ids: clientIdCount(snap),
    clients: snap.clientNames.length,
    cards: snap.cardCount,
    fragments: snap.fragments.length,
  };
  for (const [k, n] of Object.entries(want)) {
    const got = (sql.loaded as Record<string, unknown>)[k];
    if (got !== n) inc.push(`INCOMPLETE loaded ${k}: SQL holds ${JSON.stringify(got)}, the snapshot has ${n}`);
  }
  const fkey = (f: { item_id: string; item_generation: number | null }) => `${f.item_id}@${f.item_generation}`;
  const fa = snap.fragments.map(fkey).sort(), fb = sql.fragments.map(fkey).sort();
  if (fa.join(" ") !== fb.join(" ")) {
    inc.push(`INCOMPLETE loaded fragment rows: SQL holds ${fb.length} (${fb.slice(0, 3).join(" ")}), the snapshot has ${fa.length} (${fa.slice(0, 3).join(" ")})`);
  }

  const sources = new Set(snap.items.map((i) => i.source_thought_id).filter(Boolean));
  const expectedSources = [...snap.thoughts.keys()].filter((id) => sources.has(id));
  const itemIds = snap.items.map((i) => i.id);
  inventory("work_report (source thoughts)", sql.work_report.map((r) => r?.id), expectedSources, String, inc);
  inventory("deadline (item descriptions)", sql.deadline.map((r) => r?.id), itemIds, String, inc);
  inventory("client_shaped (item descriptions)", sql.client.map((r) => r?.id), itemIds, String, inc);
  inventory("adversarial (edge cases)", sql.adversarial.map((r) => r?.i), ADVERSARIAL.map((_, i) => i), String, inc);
  inventory("known splits", sql.known.map((r) => r?.i), KNOWN_SPLITS.map((_, i) => i), String, inc);
  inventory(
    "due moments",
    sql.due.map((d) => (typeof d?.moment === "string" ? isoMoment(d.moment) ?? `unparseable:${d.moment}` : "missing")),
    moments.map((m) => isoMoment(m) ?? `unparseable:${m}`),
    String,
    inc,
  );
  const bad = (name: string, ok: boolean, what: unknown) => {
    if (!ok) inc.push(`INCOMPLETE ${name}: malformed value ${JSON.stringify(what).slice(0, 80)}`);
  };
  const dateOrNull = (v: unknown) => v === null || (typeof v === "string" && /^\d{4}-\d\d-\d\d$/.test(v));
  for (const r of sql.work_report) bad("work_report", typeof r?.v === "boolean", r);
  for (const r of sql.client) bad("client_shaped", typeof r?.v === "boolean", r);
  for (const r of sql.deadline) bad("deadline", dateOrNull(r?.v), r);
  for (const r of sql.adversarial) {
    bad("adversarial", typeof r?.wr === "boolean" && typeof r?.cs === "boolean" && dateOrNull(r?.dl), r);
  }
  for (const r of sql.known) bad("known splits", typeof r?.wr === "boolean", r);
  for (const d of sql.due) {
    bad("due", Array.isArray(d?.rows), d?.moment);
    for (const r of Array.isArray(d?.rows) ? d.rows : []) {
      bad(
        "due row",
        typeof r?.item_id === "string" && typeof r?.reason === "string" && typeof r?.action === "string" &&
          typeof r?.due_at === "string" && isoMoment(r.due_at) !== null,
        r,
      );
    }
  }
  if (snap.items.filter((i) => i.status === "open").length === 0) {
    inc.push("INCOMPLETE due: the snapshot has zero open items, so no due set can be compared");
  }
  if (inc.length) return { code: 3, lines: inc };

  // Every inventory is complete: judge behavior.
  const lines: string[] = [];
  let failures = 0;
  const report = (name: string, n: number, diffs: string[]) => {
    if (diffs.length) {
      lines.push(`FAIL ${name}: ${diffs.length} of ${n} differ`);
      for (const d of diffs.slice(0, 10)) lines.push(`  ${d}`);
      failures += 1;
    } else {
      lines.push(`PASS ${name}: ${n} rows identical`);
    }
  };
  const byId = new Map(snap.items.map((i) => [i.id, i]));
  {
    const diffs: string[] = [];
    let pos = 0;
    for (const r of sql.work_report) {
      const t = snap.thoughts.get(r.id)!;
      const ts = sourceIsWorkReport(t.content, t.created_at);
      if (ts) pos += 1;
      if (ts !== r.v) diffs.push(`thought ${r.id}: ts=${ts} sql=${r.v}`);
    }
    report(`work_report (every source thought; ${pos} true)`, sql.work_report.length, diffs);
  }
  {
    const diffs: string[] = [];
    let pos = 0;
    for (const r of sql.deadline) {
      const ts = isoDate(deadlineFrom(byId.get(r.id)!.description));
      if (ts !== null) pos += 1;
      if (ts !== r.v) diffs.push(`item ${r.id}: ts=${ts} sql=${r.v}`);
    }
    report(`deadline (every item description; ${pos} with a deadline)`, sql.deadline.length, diffs);
  }
  {
    const diffs: string[] = [];
    let pos = 0;
    for (const r of sql.client) {
      const ts = isClientShaped(byId.get(r.id)!.description, snap.clientNames);
      if (ts) pos += 1;
      if (ts !== r.v) diffs.push(`item ${r.id}: ts=${ts} sql=${r.v}`);
    }
    report(`client_shaped (every item description; ${pos} true)`, sql.client.length, diffs);
  }
  {
    const diffs: string[] = [];
    for (const r of sql.adversarial) {
      const a = ADVERSARIAL[r.i];
      const wr = sourceIsWorkReport(a.text, a.captured_at);
      const dl = isoDate(deadlineFrom(a.text));
      const cs = isClientShaped(a.text, snap.clientNames);
      if (wr !== r.wr || dl !== r.dl || cs !== r.cs) {
        diffs.push(`#${r.i} ${JSON.stringify(a.text).slice(0, 60)}: ts=${wr}/${dl}/${cs} sql=${r.wr}/${r.dl}/${r.cs}`);
      }
    }
    report("adversarial strings (all three functions)", sql.adversarial.length, diffs);
  }
  for (const r of sql.known) {
    const k = KNOWN_SPLITS[r.i];
    const ts = sourceIsWorkReport(k.text, k.captured_at);
    const holds = ts === k.ts && r.wr === k.sql;
    lines.push(
      `${holds ? "KNOWN" : "NOTE"} split #${r.i} (${k.note}): ts=${ts} sql=${r.wr}` +
        (holds ? "" : ` (recorded ts=${k.ts} sql=${k.sql}; the exception changed, review it)`),
    );
  }
  const openCount = snap.items.filter((i) => i.status === "open").length;
  const key = (r: DueRow) => `${r.item_id} ${r.reason} ${new Date(r.due_at).toISOString()} ${r.action}`;
  for (const d of sql.due) {
    const ts = tsDue(snap, d.moment).map(key);
    const sq = d.rows.map(key);
    const count = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
    const ca = count(ts), cb = count(sq);
    const diffs: string[] = [];
    for (const [k, n] of ca) if ((cb.get(k) ?? 0) < n) diffs.push(`ts only: ${k}`);
    for (const [k, n] of cb) if ((ca.get(k) ?? 0) < n) diffs.push(`sql only${(ca.get(k) ?? 0) > 0 ? " (repeated)" : ""}: ${k}`);
    const reasons = [...new Set(d.rows.map((r) => `${r.reason}/${r.action}`))].sort().join(" ");
    report(
      `due set at ${isoMoment(d.moment)} (${openCount} open items, ${sq.length} due${reasons ? `: ${reasons}` : ""})`,
      openCount,
      diffs,
    );
  }
  {
    const carriers = snap.items.filter((i) => i.status === "open" && i.client_id !== null && i.client_id !== undefined).length;
    if (carriers === 0) {
      lines.push("NOTE no open item carries a client_id: the client_id rule is not exercised by this snapshot");
    } else {
      const per = sql.due.map((d) => `${clientIdOnlyExempt(snap, d.moment).length} at ${isoMoment(d.moment)}`).join(", ");
      lines.push(`COVER client_id: ${carriers} open items carry one; due only without it: ${per}`);
    }
  }
  lines.push(failures > 0 ? `ARCHIVE PROPOSALS DIFF FAILED (${failures})` : "ARCHIVE PROPOSALS DIFF PASSED");
  return { code: failures > 0 ? 1 : 0, lines };
}

/** Negative controls on compare's guards, built from one real (or reference)
 * SQL output that compare passes. Each control names the exit it must give;
 * an inventory defect must be INCOMPLETE (3), never FAIL (1), and a changed
 * value must be FAIL (1), never INCOMPLETE. */
export function selftest(snap: Snapshot, base: SqlOut, moments: string[]): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;
  const clone = () => JSON.parse(JSON.stringify(base)) as SqlOut;
  const expect = (name: string, want: 0 | 1 | 3, mut: (s: SqlOut) => void | false) => {
    const s = clone();
    if (mut(s) === false) {
      lines.push(`SKIPPED   ${name}: nothing in this output to alter`);
      return;
    }
    // An exception is not an exit code: it never matches what a control expects,
    // so a guard that crashes is UNGUARDED, not a lucky INCOMPLETE.
    let got: 0 | 1 | 3 | "exception";
    try {
      got = compare(snap, s, moments).code;
    } catch (_e) {
      got = "exception";
    }
    const pass = got === want;
    if (!pass) ok = false;
    lines.push(`${pass ? "GUARDED " : "UNGUARDED"} ${name}: exit ${got}, expected ${want}`);
  };
  expect("unaltered output", 0, () => {});
  for (const k of ["work_report", "deadline", "client", "adversarial"] as const) {
    expect(`${k} reduced to its first row`, 3, (s) => {
      (s[k] as unknown[]).splice(1);
    });
    expect(`${k} with one row duplicated`, 3, (s) => {
      (s[k] as unknown[]).push(JSON.parse(JSON.stringify((s[k] as unknown[])[0])));
    });
    expect(`${k} with one row removed`, 3, (s) => {
      (s[k] as unknown[]).pop();
    });
    expect(`${k} emptied`, 3, (s) => {
      (s[k] as unknown[]).splice(0);
    });
  }
  expect("an unexpected item id", 3, (s) => {
    s.client.push({ id: "00000000-0000-4000-8000-000000000000", v: false });
  });
  expect("a malformed value (string for boolean)", 3, (s) => {
    (s.client[0] as unknown as { v: unknown }).v = "false";
  });
  expect("due emptied of moments", 3, (s) => {
    s.due = [];
  });
  expect("due replaced by an object", 3, (s) => {
    (s as unknown as { due: unknown }).due = {};
  });
  expect("one moment missing", 3, (s) => {
    s.due.pop();
  });
  expect("one moment duplicated", 3, (s) => {
    s.due.push(JSON.parse(JSON.stringify(s.due[0])));
  });
  expect("an unexpected moment", 3, (s) => {
    s.due.push({ moment: "2030-01-01T00:00:00.000Z", rows: [] });
  });
  expect("the whole output empty", 3, (s) => {
    for (const k of Object.keys(s)) delete (s as Record<string, unknown>)[k];
  });
  expect("SQL loaded one item fewer", 3, (s) => {
    s.loaded.items -= 1;
  });
  // The loader once dropping client_id would load every item as unattributed.
  expect("SQL loaded no client_id", 3, (s) => {
    if (s.loaded.client_ids === 0) return false;
    s.loaded.client_ids = 0;
  });
  expect("SQL loaded no fragment rows", 3, (s) => {
    if (s.fragments.length === 0) return false;
    s.fragments = [];
    s.loaded.fragments = 0;
  });
  expect("a fragment row in another generation", 3, (s) => {
    if (s.fragments.length === 0) return false;
    s.fragments[0].item_generation = (s.fragments[0].item_generation ?? 0) + 1;
  });
  // Codex second re-review of PR 24: a null member once crashed compare.
  expect("a null fragment entry", 3, (s) => {
    if (s.fragments.length === 0) return false;
    (s.fragments as unknown[])[0] = null;
  });
  expect("a fragment generation of the wrong type", 3, (s) => {
    if (s.fragments.length === 0) return false;
    (s.fragments[0] as unknown as { item_generation: unknown }).item_generation = "0";
  });
  expect("a null work_report row", 3, (s) => {
    (s.work_report as unknown[])[0] = null;
  });
  expect("an id that is not a string", 3, (s) => {
    (s.client[0] as unknown as { id: unknown }).id = [s.client[0].id];
  });
  // Behavioral controls: complete inventories, one value changed.
  expect("one work_report value flipped", 1, (s) => {
    s.work_report[0].v = !s.work_report[0].v;
  });
  expect("one client value flipped", 1, (s) => {
    s.client[0].v = !s.client[0].v;
  });
  expect("one deadline changed", 1, (s) => {
    s.deadline[0].v = s.deadline[0].v === "2001-01-01" ? null : "2001-01-01";
  });
  expect("one adversarial deadline changed", 1, (s) => {
    s.adversarial[0].dl = s.adversarial[0].dl === "2001-01-01" ? null : "2001-01-01";
  });
  const withRows = base.due.findIndex((d) => d.rows.length > 0);
  expect("one due row dropped", 1, (s) => {
    if (withRows < 0) return false;
    s.due[withRows].rows.pop();
  });
  expect("one due row repeated", 1, (s) => {
    if (withRows < 0) return false;
    s.due[withRows].rows.push({ ...s.due[withRows].rows[0] });
  });
  expect("one due reason changed", 1, (s) => {
    if (withRows < 0) return false;
    const r = s.due[withRows].rows[0];
    r.reason = r.reason === "age_standard" ? "age_work_report" : "age_standard";
  });
  // A SQL due set that ignored client_id: one row the client_id rule exempts
  // appears in it.
  expect("a row exempt only by client_id added to a due set", 1, (s) => {
    for (const d of s.due) {
      const extra = clientIdOnlyExempt(snap, d.moment);
      if (extra.length) {
        d.rows.push(extra[0]);
        return;
      }
    }
    return false;
  });
  if (withRows < 0) lines.push("NOTE no moment has a due row: the due set compares only empty sets here");
  lines.push(ok ? "DIFF SELFTEST PASSED" : "DIFF SELFTEST FAILED");
  return { ok, lines };
}

export function emitSnapshot(out: string) {
  const at = "2026-12-10T05:30:00.000Z";
  const extraMoments = ["2027-01-20T05:30:00.000Z", "2027-04-01T05:30:00.000Z"];
  const day = 24 * 3600 * 1000;
  const ago = (d: number, from = at) => new Date(Date.parse(from) - d * day).toISOString();
  const hex = (n: number) => n.toString(16).padStart(12, "0");
  const base = {
    status: "open",
    resolved_at: null, resolution_note: null, closed_at: null, close_reason: null,
    deferred_at: null, defer_reason: null, reopened_at: null, reopen_generation: 0,
    archive_proposed_at: null, archive_review_outcome: null, archive_reviewed_at: null,
    client_id: null,
  };
  // Family A: each edge case as a SOURCE thought of a neutral 40-day item, so the
  // classifier picks the clock (30 days for a work report, 60 otherwise).
  const thoughts = ADVERSARIAL.map((a, i) => ({ id: `f1000000-0000-4000-8000-${hex(i)}`, content: a.text, created_at: a.captured_at }));
  const items: Array<Record<string, unknown>> = ADVERSARIAL.map((_, i) => ({
    ...base,
    id: `f2000000-0000-4000-8000-${hex(i)}`,
    source_thought_id: thoughts[i].id,
    description: "reply to the vendor",
    created_at: ago(40),
  }));
  // Family B: each edge case as the item's DESCRIPTION, 100 days old with no
  // source, so the deadline, client and canary rules decide the due set.
  ADVERSARIAL.forEach((a, i) =>
    items.push({ ...base, id: `f4000000-0000-4000-8000-${hex(i)}`, source_thought_id: null, description: a.text, created_at: ago(100) })
  );
  // Family C: one item per review state and exemption.
  const neutral = "f1000000-0000-4000-8000-ffffffffffff";
  thoughts.push({ id: neutral, content: "buy more black ink and needles", created_at: ago(40) });
  const c = (n: number) => `f5000000-0000-4000-8000-${hex(n)}`;
  const st: Array<[number, Record<string, unknown>]> = [
    [1, { description: "fragment flagged, current generation", source_thought_id: neutral, created_at: ago(40) }],
    [2, { description: "fragment flagged, older generation", source_thought_id: neutral, created_at: ago(40),
          reopen_generation: 1, reopened_at: "2026-06-01T00:00:00.000Z" }],
    [3, { description: "linked to an open card", created_at: ago(100) }],
    [4, { description: "linked to an Agent Done card", created_at: ago(100) }],
    [5, { description: "linked to an archived card", created_at: ago(100) }],
    [6, { description: "reopened recently", created_at: ago(200), reopen_generation: 1, reopened_at: "2026-11-20T00:00:00.000Z" }],
    [7, { description: "proposed, unreviewed", created_at: ago(100), archive_proposed_at: "2026-12-01T05:30:00.000Z" }],
    [8, { description: "kept recently", created_at: ago(100), archive_proposed_at: "2026-11-20T05:30:00.000Z",
          archive_review_outcome: "kept", archive_reviewed_at: "2026-12-01T00:00:00.000Z" }],
    [9, { description: "kept long ago", created_at: ago(200), archive_proposed_at: "2026-07-20T05:30:00.000Z",
          archive_review_outcome: "kept", archive_reviewed_at: "2026-08-01T00:00:00.000Z" }],
    [10, { description: "paused for now", created_at: ago(200), status: "deferred", deferred_at: ago(150), defer_reason: "pause:test" }],
    [11, { description: "already done", created_at: ago(200), status: "resolved", resolved_at: ago(150), closed_at: ago(150), close_reason: "done" }],
    [12, { description: "Perpetual auto-resolve canary (do NOT resolve)", created_at: ago(400) }],
    [13, { description: "exactly sixty days old", created_at: ago(60) }],
    [14, { description: "fifty-nine days old", created_at: ago(59) }],
    // Unreachable in production (a reopen clears it), but the SQL maps it.
    [15, { description: "accepted yet open", created_at: ago(100), archive_proposed_at: "2026-11-20T05:30:00.000Z",
           archive_review_outcome: "accepted", archive_reviewed_at: "2026-11-25T00:00:00.000Z" }],
  ];
  // Family D: the client_id exemption (Task 5.3), each next to a null twin.
  // Mira is client 3 below; a lone "Mira" matches one client, so the text rule
  // alone does not exempt #20.
  const mira = `f3000000-0000-4000-8000-${hex(3)}`;
  st.push(
    [16, { description: "send the aftercare sheet", created_at: ago(100), client_id: mira }],
    [17, { description: "send the aftercare sheet", created_at: ago(100) }],
    [18, { description: "send the proof by 2026-11-01", created_at: ago(20), client_id: mira }],
    [19, { description: "send the proof by 2026-11-01", created_at: ago(20) }],
    [20, { description: "ask Mira about the swatch", created_at: ago(100), client_id: mira }],
    [21, { description: "ask Mira about the swatch", created_at: ago(100) }],
    [22, { description: "fragment flagged with a client", source_thought_id: neutral, created_at: ago(40), client_id: mira }],
    [23, { description: "proposed, then given a client", created_at: ago(100), client_id: mira,
           archive_proposed_at: "2026-12-01T05:30:00.000Z" }],
    // The text rule with no client_id: a full name, kept for rows from before 5.3.
    [24, { description: "design the sleeve for Paul Reyes", created_at: ago(100) }],
    // Codex review of PR 39 (P2, 2026-11-22): a keep older than 90 days. With a
    // client_id the item stays exempt; its null twin is age_standard/repropose.
    [25, { description: "send the deposit reminder", created_at: ago(200), client_id: mira,
           archive_proposed_at: "2026-07-20T05:30:00.000Z", archive_review_outcome: "kept",
           archive_reviewed_at: "2026-08-01T00:00:00.000Z" }],
    [26, { description: "send the deposit reminder", created_at: ago(200),
           archive_proposed_at: "2026-07-20T05:30:00.000Z", archive_review_outcome: "kept",
           archive_reviewed_at: "2026-08-01T00:00:00.000Z" }],
    // Codex review of PR 39 (P3, 2026-11-22): a client_id on a row that is not
    // open. Never due either way, but the loaded client_id count includes it, so a
    // loader that dropped client_id on non-open rows is INCOMPLETE, not a pass.
    [27, { description: "paused, with a client", created_at: ago(200), status: "deferred", deferred_at: ago(150),
           defer_reason: "pause:test", client_id: mira }],
  );
  for (const [n, f] of st) items.push({ ...base, id: c(n), source_thought_id: null, ...f });
  const cards = [
    { id: "f6000000-0000-4000-8000-000000000003", status: "Agent Todo", archived_at: null, linked_action_item_id: c(3) },
    { id: "f6000000-0000-4000-8000-000000000004", status: "Agent Done", archived_at: null, linked_action_item_id: c(4) },
    { id: "f6000000-0000-4000-8000-000000000005", status: "Agent Todo", archived_at: ago(10), linked_action_item_id: c(5) },
  ];
  const frag = (id: string, item: string, gen: number) => ({
    id, item_id: item, thought_id: neutral, candidate_description: "it", layer: "fragment",
    outcome: "proposed", reason: "pronoun_object", item_generation: gen,
  });
  const decisions = [
    frag("f7000000-0000-4000-8000-000000000001", c(1), 0),
    frag("f7000000-0000-4000-8000-000000000002", c(2), 0),
    frag("f7000000-0000-4000-8000-000000000022", c(22), 0),
  ];
  const clients = ["Jordan Lee", "Jordan Morrow", "Paul Reyes", "Mira", "İpek Kaya", "Ipek Demir", "\u212Aira Lee"]
    .map((name, i) => ({ id: `f3000000-0000-4000-8000-${hex(i)}`, name }));
  Deno.mkdirSync(out, { recursive: true });
  const w = (f: string, v: unknown) => Deno.writeTextFileSync(`${out}/${f}`, JSON.stringify(v));
  w("thoughts.json", thoughts);
  w("items.json", items);
  w("clients.json", clients);
  w("cards.json", cards);
  w("decisions.json", decisions);
  Deno.writeTextFileSync(`${out}/snapshot_at.txt`, at + "\n");
  Deno.writeTextFileSync(`${out}/moments.txt`, extraMoments.join("\n") + "\n");
}

if (import.meta.main) {
  const [mode, a1, a2, a3] = Deno.args;
  if (mode === "emit-adversarial") {
    console.log(JSON.stringify({
      adversarial: ADVERSARIAL.map((a, i) => ({ i, ...a })),
      known: KNOWN_SPLITS.map((a, i) => ({ i, text: a.text, captured_at: a.captured_at })),
    }));
    Deno.exit(0);
  }
  if (mode === "emit-snapshot" && a1) {
    emitSnapshot(a1);
    Deno.exit(0);
  }
  if ((mode === "compare" || mode === "selftest") && a1 && a2 && a3) {
    // Everything that can throw is inside this try: reading the snapshot or the
    // SQL output, comparing, self-testing. A throw is incomplete execution (3);
    // Deno's own uncaught-exception exit (1) must never be reachable from here.
    let code: number;
    try {
      let snap: Snapshot;
      try {
        snap = loadSnapshot(a1);
      } catch (e) {
        throw new Error(`the snapshot is not readable: ${e}`);
      }
      let sql: SqlOut;
      try {
        sql = JSON.parse(Deno.readTextFileSync(a2));
      } catch (e) {
        throw new Error(`the SQL output is not readable JSON: ${e}`);
      }
      const moments = a3.split(",").filter(Boolean);
      if (mode === "compare") {
        const r = compare(snap, sql, moments);
        for (const l of r.lines) console.log(l);
        if (r.code === 3) console.log("ARCHIVE PROPOSALS DIFF INCOMPLETE: nothing was judged");
        code = r.code;
      } else {
        const r = selftest(snap, sql, moments);
        for (const l of r.lines) console.log(l);
        code = r.ok ? 0 : 1;
      }
    } catch (e) {
      console.log(`INCOMPLETE the ${mode} did not run to completion: ${e instanceof Error ? e.message : String(e)}`);
      console.log(`ARCHIVE PROPOSALS DIFF INCOMPLETE: nothing was judged`);
      code = 3;
    }
    Deno.exit(code);
  }
  console.error(
    "usage: archive-proposals-diff.ts emit-adversarial | emit-snapshot <dir> | compare|selftest <snapshot-dir> <sql-out.json> <moment,moment,...>",
  );
  Deno.exit(2);
}
