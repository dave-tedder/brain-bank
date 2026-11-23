// Loop-closing Task 5.3: client identity per action item.
// Run: deno test --allow-read --allow-env supabase/functions/_shared/item-client.test.ts
//
// The resolver over an in-memory roster, the one-statement roster read and the
// foreign-key retry over the in-memory database
// (scripts/loop-closing/client-identity-fake.ts), and the REAL shared
// extractAndStoreActionItems (capture-pipeline.ts, the code REST /capture and
// MCP capture_thought run) over the same fake, so the plan's multi-client and
// "nudge Jordan" cases are proven on the insert payload. The ingest copy is the
// same call at the same place (fragment-gate.test.ts "mirror 5.3") and is run
// through its real handler by ingest-probe-harness.ts probe 16.

import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import {
  assignItemClients,
  clientMentions,
  loadRoster,
  nameForm,
  nameWords,
  normalizeText,
  resolveClient,
  retryWithoutMissingClients,
  ROSTER_MAX,
  type RosterEntry,
} from "./item-client.ts";
import { extractAndStoreActionItems } from "./capture-pipeline.ts";
import { FakeDb } from "../../../scripts/loop-closing/client-identity-fake.ts";
// Runtime-bound claims for the TS mutant sweep (Codex re-review 2, N1).
import { claim } from "../../../scripts/loop-closing/claim.ts";

const ALICIA = "a11c1a00-0000-4000-8000-000000000001";
const JAKE_M = "1a4e0000-0000-4000-8000-000000000002";
const JAKE_R = "1a4e0000-0000-4000-8000-000000000003";
const ANA = "a7a00000-0000-4000-8000-000000000004";
const CLIENTS = [
  { id: ALICIA, name: "Alicia Brennan", last_contact: "2026-11-01T00:00:00Z", metadata: { crm_id: "cb-alicia" } },
  { id: JAKE_M, name: "Jordan Marlow", last_contact: "2026-10-01T00:00:00Z", metadata: {} },
  { id: JAKE_R, name: "Jordan Ruiz", last_contact: "2026-09-01T00:00:00Z", metadata: {} },
  { id: ANA, name: "Ana", last_contact: "2026-08-01T00:00:00Z", metadata: {} },
];
const ROSTER: RosterEntry[] = CLIENTS.map((c) => ({ id: c.id, name: c.name }));
const T = "7a5c0000-0000-4000-8000-0000000000aa";
const roster = (...names: string[]) => names.map((name, i) => ({ id: `c${i}`, name }));

const capture = async (db: FakeDb, items: string[]) => {
  const realLog = console.log;
  console.log = () => {};
  try {
    await extractAndStoreActionItems(db, T, { type: "task", source: "slack", project: null, action_items: items }, "Notes: these still need doing.", () => false);
  } finally {
    console.log = realLog;
  }
  const inserts = db.writes.filter((w) => w.table === "action_items" && w.op === "insert");
  return inserts.flatMap((w) => w.payload as Array<Record<string, unknown>>);
};

Deno.test("client identity 5.3: full names first, then capitalised whole name tokens that do not run into a surname", () => {
  assertEquals(clientMentions("Schedule tattoo appointment for Alicia Brennan", ROSTER), { kind: "full", ids: [ALICIA] });
  assertEquals(clientMentions("schedule ALICIA brennan's touch-up", ROSTER), { kind: "full", ids: [ALICIA] });
  assertEquals(clientMentions("nudge Jordan if nothing arrives", ROSTER), { kind: "first", words: ["jordan"] });
  assertEquals(clientMentions("send Alicia the design", ROSTER), { kind: "first", words: ["alicia"] });
  assertEquals(clientMentions("Book Alicia Brennan, then tell Jordan", ROSTER), { kind: "full", ids: [ALICIA] });
  assertEquals(clientMentions("Reschedule the Brennans to March", ROSTER), { kind: "none" });
  assertEquals(clientMentions("nudge jordan about the deposit", ROSTER), { kind: "none" });
  assertEquals(clientMentions("Book Ana's session", ROSTER), { kind: "first", words: ["ana"] });
  // the leading word is never a first-name candidate
  assertEquals(clientMentions("Mark the invoice paid", [...ROSTER, { id: "m", name: "Mark Ellis" }]), { kind: "none" });
  assertEquals(clientMentions("Remind Mark about the deposit", [...ROSTER, { id: "m", name: "Mark Ellis" }]), { kind: "first", words: ["mark"] });
  // a name word joined by a hyphen or apostrophe stays one word
  assertEquals(nameForm("Jean-Luc West"), "jean luc west");
  assertEquals(nameForm("Bea O’Neil"), nameForm("Bea O'Neil"));
});

Deno.test("client identity 5.3: a surname in the text that matches no client blocks the first-name fallback", () => {
  claim(
    "surname-blocks-fallback",
    [
      resolveClient("Book a session for Jordan Miller", roster("Jordan Marlow")),
      resolveClient("Arrange an appointment for Ann Leeds", roster("Ann Lee")),
      resolveClient("Book a consultation for Cedar Frost", roster("Cedar Finch")),
      resolveClient("Send Jordan Miller the floor plan sketch", roster("Jordan Marlow")),
    ],
    [null, null, null, null],
    "a full name the text supplies but the roster lacks never falls back to a first name",
  );
  // the same names without a surname still resolve to the one client
  assertEquals(resolveClient("nudge Jordan if nothing arrives", roster("Jordan Marlow")), "c0");
});

Deno.test("client identity 5.3: every client sharing a matched name form counts, so a shared form is unresolved", () => {
  claim(
    "shared-form-unresolved",
    [
      resolveClient("Book a session for Jean Luc West", roster("Jean-Luc West", "Jean Luc West")),
      resolveClient("Book a session for Jean Luc West", roster("Jean Luc West", "Jean-Luc West")),
      resolveClient("Book Jean-Luc West", roster("Jean-Luc West", "Jean Luc West")),
    ],
    [null, null, null],
    "two clients with the same normalised name are never told apart by row order",
  );
  assertEquals(clientMentions("Book Jean Luc West", roster("Jean-Luc West", "Jean Luc West")), { kind: "full", ids: ["c0", "c1"] });
});

Deno.test("client identity 5.3: names are compared as text, never as a pattern, and Unicode letters count", () => {
  claim(
    "literal-and-unicode-names",
    [
      resolveClient("Book a session for Star*Fox", roster("Star*Fox", "StarABC Fox")),
      resolveClient("Book a session for Test%_Example", roster("Test%_Example", "TestXXExample")),
      resolveClient("Schedule a consultation for 李 明", roster("李 明")),
      resolveClient("Schedule a session for Ana María", roster("Ana María", "Ana Mar")),
    ],
    ["c0", "c0", "c0", "c0"],
    "a literal asterisk, percent or underscore is just a character; CJK and accented names resolve",
  );
});

Deno.test("client identity 5.3: a capitalised word next to a name is part of the name unless it is a scheduling or title word", () => {
  claim(
    "neighbour-rule",
    [
      resolveClient("Mary Ann Lee - consultation", roster("Ann Lee")),
      resolveClient("Consultation Mary Ann Lee", roster("Ann Lee")),
      resolveClient("Book a session with Ann Lee Smith", roster("Ann Lee")),
      resolveClient("Consultation Ann Lee", roster("Ann Lee")),
      resolveClient("Tattoo Session Alicia Brennan", ROSTER),
      resolveClient("Tattoo session: Alicia Brennan", ROSTER),
      resolveClient("Book Ann Lee Smith", roster("Ann Lee", "Ann Lee Smith")),
      resolveClient("Alicia Brennan Consultation", ROSTER),
    ],
    [null, null, null, "c0", ALICIA, ALICIA, "c1", ALICIA],
    "an unknown capitalised neighbour (Mary, Smith) leaves the text ambiguous; Consultation, Tattoo and Session do not; a longer known name wins",
  );
  // the same rule for first names: an unknown capitalised neighbour is a surname
  assertEquals(resolveClient("Book a session for Ana Mendez", roster("Ana Lopez")), null);
  assertEquals(resolveClient("Remind Ana about the deposit", roster("Ana Lopez")), "c0");
});

Deno.test("client identity 5.3: client_id only when find_client's rule finds exactly one client", () => {
  assertEquals(resolveClient("Schedule tattoo appointment for Alicia Brennan", ROSTER), ALICIA);
  assertEquals(resolveClient("send Alicia the design", ROSTER), ALICIA);
  claim("jake-two-rows-null", resolveClient("nudge Jordan if nothing arrives", ROSTER), null, "find_client's rule finds 2 clients for Jordan: no id");
});

Deno.test("client identity 5.3: two different clients named in one item give no id", () => {
  claim(
    "two-clients-null",
    [
      resolveClient("Book Alicia Brennan and Jordan Marlow together", ROSTER),
      resolveClient("Remind Alicia and Mark about the deposit", roster("Alicia Brennan", "Mark Ellis")),
    ],
    [null, null],
    "each name finds exactly one client, but they differ: no id (full names, and first names)",
  );
});

Deno.test("client identity 5.3: the roster is one read of client_roster, so the 2,001st client resolves", async () => {
  const people = Array.from({ length: 2000 }, (_, i) => ({ id: `id${String(i).padStart(5, "0")}`, name: `Synthetic Client${i}` }))
    .concat([{ id: "zz-last", name: "Ruth Ivy" }]);
  const db = new FakeDb({ clients: people });
  const rows = [{ description: "Book a consultation for Ruth Ivy" }] as Array<{ description: string; client_id?: string | null }>;
  await assignItemClients(db, rows);
  claim(
    "roster-one-read",
    { client: rows[0].client_id ?? null, reads: db.reads.filter((r) => r.table === "clients").map((r) => r.filters.join()) },
    { client: "zz-last", reads: ["rpc client_roster"] },
    "one statement reads every client, so the last of 2,001 resolves",
  );
  assertEquals(db.reads.length, 1, "no other read");
});

Deno.test("client identity 5.3: a server row cap cannot shorten the roster, and a partial or over-cap answer resolves nothing", async () => {
  // 510 clients, two Paige Smiths at opposite ends of the id order, and a
  // server that returns at most 100 rows a read (Codex re-review 1, finding
  // 7): the roster is one jsonb value, not rows, so the cap does not apply.
  const people = [{ id: "a000", name: "Paige Smith" }]
    .concat(Array.from({ length: 508 }, (_, i) => ({ id: `m${String(i).padStart(4, "0")}`, name: `Synthetic Client${i}` })))
    .concat([{ id: "z999", name: "Paige Smith" }]);
  const db = new FakeDb({ clients: people });
  db.rowCap = 100;
  const roster = await loadRoster(db);
  const rows = [{ description: "Book a consultation for Paige Smith" }] as Array<{ description: string; client_id?: string | null }>;
  await assignItemClients(db, rows);
  claim(
    "roster-capped",
    { read: roster?.length ?? null, client: rows[0].client_id ?? null },
    { read: 510, client: null },
    "every client is read under a 100-row cap, so the two Paige Smiths stay ambiguous",
  );
  // an answer whose rows do not add up to its count, or that leaves the rows
  // out (more than ROSTER_MAX clients), resolves nothing
  const answering = (data: unknown) => ({ from: () => { throw new Error("no table read expected"); }, rpc: () => Promise.resolve({ data, error: null }) });
  const realErr = console.error;
  console.error = () => {};
  let partial, overCap;
  try {
    partial = await loadRoster(answering({ read_at: "2026-11-20T12:00:00Z", total: 3, clients: [{ id: "a", name: "Paige Smith" }, { id: "b", name: "Ann Lee" }] }));
    overCap = await loadRoster(answering({ read_at: "2026-11-20T12:00:00Z", total: ROSTER_MAX + 1, clients: null }));
  } finally {
    console.error = realErr;
  }
  claim("roster-partial-refused", { partial, overCap }, { partial: null, overCap: null }, "a partial or over-cap roster is no roster");
});

// Accent spellings a person reads as the same name (correction 4, Codex
// re-review 3, finding 2).
const ACCENT_VARIANTS: Array<[string, (s: string) => string]> = [
  ["NFD", (s: string) => s.normalize("NFD")],
  ["NFC", (s: string) => s.normalize("NFC")],
];
// The same, with an invisible character between each base letter and its
// mark: since correction 5 (the allowlist) these fail closed.
const INVISIBLE_ACCENT_VARIANTS: Array<[string, (s: string) => string]> = [
  ...["\u00ad", "\u200d", "\u200c", "\u2060", "\ufeff", "\u034f"].map((x): [string, (s: string) => string] => [
    `NFD with ${JSON.stringify(x)} before each mark`,
    (s: string) => s.normalize("NFD").replace(/(\p{M})/gu, `${x}$1`),
  ]),
];

// Every way a space can be written: the identity fixtures of this file run
// through each must give exactly the answer the ASCII text gives (correction
// 3, strategy A: one normalisation at entry).
const SPACE_VARIANTS: Array<[string, (s: string) => string]> = [
  ...["\u00a0", "\u1680", "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006", "\u2007", "\u2008", "\u2009",
    "\u200a", "\u202f", "\u205f", "\u3000", "\u2028", "\u2029", "\t", "\n", "\r\n", "\u0085", "  ", "\u00a0\u00a0"]
    .map((v): [string, (s: string) => string] => [JSON.stringify(v), (s: string) => s.replaceAll(" ", v)]),
  ["edges", (s: string) => `\u00a0 ${s}\u3000\n`],
  ["typographic apostrophe and hyphen", (s: string) => s.replaceAll("'", "\u2019").replaceAll("-", "\u2010")],
  ["full-width letters", (s: string) => s.replace(/[A-Za-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))],
  // Accents (correction 4): decomposed and composed.
  ...ACCENT_VARIANTS,
];
// Invisible characters (correction 5, the allowlist): each fails closed.
const INVISIBLE_VARIANTS: Array<[string, (s: string) => string]> = [
  ['"\\u200b" for spaces', (s: string) => s.replaceAll(" ", "\u200b")],
  ['" \\u200b" for spaces', (s: string) => s.replaceAll(" ", " \u200b")],
  ["soft hyphen and joiners inside words", (s: string) => s.replace(/(\p{L})(\p{L})/gu, "$1\u00ad$2").replace(/(\p{L})(\p{L})(\p{L})/gu, "$1\u200d$2\u2060$3")],
  ...INVISIBLE_ACCENT_VARIANTS,
];
const IDENTITY_FIXTURES: Array<[string, RosterEntry[]]> = [
  ["Schedule tattoo appointment for Alicia Brennan", ROSTER],
  ["schedule ALICIA brennan's touch-up", ROSTER],
  ["nudge Jordan if nothing arrives", ROSTER],
  ["send Alicia the design", ROSTER],
  ["Book Alicia Brennan, then tell Jordan", ROSTER],
  ["Book Ana's session", ROSTER],
  ["Remind Mark about the deposit", [...ROSTER, { id: "m", name: "Mark Ellis" }]],
  ["Book a session for Jordan Miller", roster("Jordan Marlow")],
  ["Arrange an appointment for Ann Leeds", roster("Ann Lee")],
  ["nudge Jordan if nothing arrives", roster("Jordan Marlow")],
  ["Book a session for Jean Luc West", roster("Jean-Luc West", "Jean Luc West")],
  ["Book Jean-Luc West", roster("Jean-Luc West")],
  ["Schedule a consultation for 李 明", roster("李 明")],
  ["Schedule a session for Ana María", roster("Ana María", "Ana Mar")],
  ["Mary Ann Lee - consultation", roster("Ann Lee")],
  ["Consultation Mary Ann Lee", roster("Ann Lee")],
  ["Book a session with Ann Lee Smith", roster("Ann Lee")],
  ["Consultation Ann Lee", roster("Ann Lee")],
  ["Tattoo Session Alicia Brennan", ROSTER],
  ["Tattoo session: Alicia Brennan", ROSTER],
  ["Book Ann Lee Smith", roster("Ann Lee", "Ann Lee Smith")],
  ["Alicia Brennan Consultation", ROSTER],
  ["Book a session for Ana Mendez", roster("Ana Lopez")],
  ["Remind Ana about the deposit", roster("Ana Lopez")],
  ["Book Alicia Brennan and Jordan Marlow together", ROSTER],
  ["Book Bea O'Neil", roster("Bea O'Neil")],
  ["Book José Li", roster("José Li")],
  ["Book a session for Zoë Brontë", roster("Zoë Brontë", "Zoe Bronte")],
  ["Book June-Marie Bell", roster("June-Marie Bell")],
];

Deno.test("client identity 5.3: every Unicode space, separator and format character gives the ASCII answer", () => {
  const differ: string[] = [];
  for (const [text, people] of IDENTITY_FIXTURES) {
    const want = resolveClient(text, people);
    for (const [label, vary] of SPACE_VARIANTS) {
      const inText = resolveClient(vary(text), people);
      const inNames = resolveClient(text, people.map((c) => ({ id: c.id, name: vary(c.name) })));
      if (inText !== want) differ.push(`${label} in "${text}": ${inText} not ${want}`);
      if (inNames !== want) differ.push(`${label} in the names for "${text}": ${inNames} not ${want}`);
    }
  }
  claim("spaces-identical", differ, [], "the same text written with any visible space or separator resolves the same way");
  // An invisible character fails closed: the same answer or none, never
  // another client.
  const other: string[] = [];
  for (const [text, people] of IDENTITY_FIXTURES) {
    const want = resolveClient(text, people);
    for (const [label, vary] of INVISIBLE_VARIANTS) {
      for (const got of [resolveClient(vary(text), people), resolveClient(text, people.map((c) => ({ id: c.id, name: vary(c.name) })))]) {
        if (got !== null && got !== want) other.push(`${label} for "${text}": ${got} not ${want}`);
      }
    }
  }
  assertEquals(other, [], "an invisible character never selects another client");
  // the fixtures are not trivially all null or all resolved
  const answers = IDENTITY_FIXTURES.map(([t, p]) => resolveClient(t, p));
  assert(answers.includes(null) && answers.some((a) => a !== null));
});

Deno.test("client identity 5.3: a failed roster read leaves client_id unset and never throws", async () => {
  const db = new FakeDb({ clients: CLIENTS });
  db.failNext.clients = [{ message: "down" }];
  const errors: string[] = [];
  const realErr = console.error;
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  try {
    const rows = [{ description: "Schedule Alicia Brennan's session" }] as Array<{ description: string; client_id?: string | null }>;
    await assignItemClients(db, rows);
    assertEquals("client_id" in rows[0], false);
  } finally {
    console.error = realErr;
  }
  assertEquals(errors.length, 1);
});

Deno.test("client identity 5.3: a client deleted before the insert is cleared and the batch retried once", async () => {
  const fk = { code: "23503", message: 'insert or update on table "action_items" violates foreign key constraint "action_items_client_id_fkey"' };
  const db = new FakeDb({ clients: [{ id: "alive", name: "Ann Lee" }] });
  const rows: Array<Record<string, unknown>> = [
    { description: "Send Sky Harper the sketch", client_id: "gone" },
    { description: "Order printer paper for the studio" },
    { description: "Book Ann Lee", client_id: "alive" },
  ];
  let calls = 0;
  const realErr = console.error;
  console.error = () => {};
  let result;
  try {
    result = await retryWithoutMissingClients(db, rows, () => {
      calls += 1;
      return Promise.resolve(calls === 1 ? { data: null, error: fk } : { data: rows.map((r) => ({ ...r })), error: null });
    });
  } finally {
    console.error = realErr;
  }
  claim(
    "fk-retry-keeps-batch",
    { calls, error: result.error, sent: result.data?.map((r: Record<string, unknown>) => [r.description, r.client_id ?? null]) ?? null },
    { calls: 2, error: null, sent: [["Send Sky Harper the sketch", null], ["Order printer paper for the studio", null], ["Book Ann Lee", "alive"]] },
    "only the deleted client's id is cleared; every item is retried",
  );
  // another error, or a 23503 on another constraint, is returned untouched
  const other = { code: "23503", message: 'violates foreign key constraint "action_items_source_thought_id_fkey"' };
  let n = 0;
  const r2 = await retryWithoutMissingClients(db, rows, () => { n += 1; return Promise.resolve({ data: null, error: other }); });
  assertEquals([n, r2.error], [1, other]);
  let m = 0;
  const r3 = await retryWithoutMissingClients(db, rows, () => { m += 1; return Promise.resolve({ data: null, error: { code: "23505", message: "dup" } }); });
  assertEquals([m, r3.error.code], [1, "23505"]);
});

Deno.test("client identity 5.3, shared capture path: a multi-client capture assigns client_id per item", async () => {
  const db = new FakeDb({ clients: CLIENTS });
  const rows = await capture(db, [
    "Schedule tattoo appointment for Alicia Brennan",
    "Send Jordan Marlow the floor plan sketch",
    "nudge Jordan if nothing arrives",
    "deploy the reminder email to live",
  ]);
  claim(
    "multi-client-per-item",
    rows.map((r) => [r.description, r.client_id ?? null]),
    [
      ["Schedule tattoo appointment for Alicia Brennan", ALICIA],
      ["Send Jordan Marlow the floor plan sketch", JAKE_M],
      ["nudge Jordan if nothing arrives", null],
      ["deploy the reminder email to live", null],
    ],
    "each item carries its own client, Jordan (two clients) and the no-name item carry none",
  );
  assertEquals(rows.filter((r) => !("client_id" in r)).length, 2);
});

Deno.test("client identity 5.3, shared capture path: nudge Jordan gets client_id null when find_client's rule finds 2 clients", async () => {
  const db = new FakeDb({ clients: CLIENTS });
  const rows = await capture(db, ["nudge Jordan if nothing arrives"]);
  assertEquals(rows.length, 1);
  claim("jake-null-e2e", rows[0].client_id ?? null, null, "the Jordan item is stored without a client");
});

Deno.test("client identity 5.3, shared capture path: a client deleted before the insert keeps every item", async () => {
  const db = new FakeDb({ clients: [{ id: "sky", name: "Sky Harper" }] });
  db.failNext["insert:action_items"] = [{ code: "23503", message: 'insert or update on table "action_items" violates foreign key constraint "action_items_client_id_fkey"' }];
  db.tables.clients = [{ id: "sky", name: "Sky Harper" }];
  // the roster (one client_roster call) sees Sky Harper; the re-check after
  // the failed insert (the only clients table read) does not
  const realFrom = db.from.bind(db);
  db.from = (table: string) => {
    if (table === "clients") db.tables.clients = [];
    return realFrom(table);
  };
  const realErr = console.error;
  console.error = () => {};
  let rows;
  try {
    rows = await capture(db, ["Send Sky Harper the sketch", "Order printer paper for the studio"]);
  } finally {
    console.error = realErr;
  }
  const stored = db.tables.action_items.map((a) => [a.description, a.client_id ?? null]);
  claim(
    "fk-race-e2e",
    stored,
    [["Send Sky Harper the sketch", null], ["Order printer paper for the studio", null]],
    "both items are stored after the client disappears",
  );
  assertEquals(rows.length, 4, "two insert attempts of two rows each");
});

Deno.test("client identity 5.3, shared capture path: no clients adds nothing to the insert", async () => {
  const rows = await capture(new FakeDb(), ["Schedule tattoo appointment for Alicia Brennan"]);
  assertEquals(rows.length, 1);
  assertEquals("client_id" in rows[0], false);
});

Deno.test("client identity 5.3: a name written another equivalent way in a second roster row makes it ambiguous", () => {
  // Codex re-review 3, finding 2: two roster rows a person reads as the same
  // name ("José Li" twice, one spelled e + soft hyphen + combining accent)
  // must leave the text unresolved, never pick the first.
  const differ: string[] = [];
  for (const [text, people] of IDENTITY_FIXTURES) {
    const want = resolveClient(text, people);
    if (want === null) continue;
    const name = people.find((c) => c.id === want)!.name;
    for (const [label, vary] of [...ACCENT_VARIANTS, ...INVISIBLE_ACCENT_VARIANTS, ...SPACE_VARIANTS.slice(0, 1), ["soft hyphen inside", (x: string) => x.replace(/(\p{L})(\p{L})/u, "$1\u00ad$2")] as [string, (s: string) => string]]) {
      const got = resolveClient(text, [...people, { id: "equivalent-row", name: vary(name) }]);
      if (got !== null) differ.push(`${label} copy of "${name}" for "${text}": ${got}`);
    }
  }
  differ.push(...[resolveClient("Book José Li", [{ id: "a", name: "José Li" }, { id: "b", name: "Jose\u00ad\u0301 Li" }])].filter((x) => x !== null).map((x) => `Codex's case: ${x}`));
  claim("equivalent-names-ambiguous", differ, [], "a second roster row with an equivalent spelling of the matched name leaves every fixture unresolved");
});

Deno.test("client identity 5.3: normalizeText is a fixed point on every fixture and variant", () => {
  const moved: string[] = [];
  for (const [text, people] of IDENTITY_FIXTURES) {
    for (const [label, vary] of SPACE_VARIANTS) {
      for (const t of [vary(text), ...people.map((c) => vary(c.name)), "Jose\u00ad\u0301 Li"]) {
        const once = normalizeText(t);
        if (normalizeText(once) !== once) moved.push(`${label}: ${JSON.stringify(t)}`);
      }
    }
  }
  claim("normalize-fixed-point", moved, [], "normalising twice never changes the result");
});

// Correction 5, the allowlist. Every default-ignorable code point and every
// combining mark (Mn, Me), assigned or not, outside the surrogates.
const ODD_CODE_POINTS: string[] = (() => {
  const re = /^[\p{Default_Ignorable_Code_Point}\p{Mn}\p{Me}]$/u;
  const out: string[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if (re.test(ch)) out.push(ch);
  }
  return out;
})();
const insertAt = (s: string, i: number, ch: string) => {
  const a = Array.from(s);
  a.splice(i, 0, ch);
  return a.join("");
};
/** How a varied string relates to the original, judged here and not by the
 * code under test: "invisible" when removing every default-ignorable code
 * point and composing gives the original; "odd" when it holds a combining
 * mark that composition leaves standing alone and the original did not;
 * otherwise "different" (a mark that composed into another visible letter,
 * so another name). */
const variantKind = (base: string, varied: string): "invisible" | "odd" | "different" => {
  const strip = (x: string) => x.replace(/\p{Default_Ignorable_Code_Point}/gu, "").normalize("NFKC");
  if (strip(varied) === strip(base)) return "invisible";
  const loose = (x: string) => (x.normalize("NFC").match(/\p{M}/gu) ?? []).length;
  return loose(varied) > loose(base) ? "odd" : "different";
};

Deno.test("client identity 5.3: no invisible or combining code point at any position of a name makes an unresolved text resolve", () => {
  // Codex re-review 4, finding 1: a second roster "José Li" spelled with
  // U+034F inside the decomposed accent was not ambiguous. Every code point
  // above, at every position, in the roster (the duplicate row, and the
  // second Jordan) and in the text (inside and around "Mary Ann Lee").
  const cases: Array<{ text: (cp: string, i: number) => string; roster: (cp: string, i: number) => RosterEntry[]; base: string; at: number }> = [
    { text: () => "Book José Li", roster: (cp, i) => roster("José Li", insertAt("José Li", i, cp)), base: "José Li", at: 8 },
    { text: () => "nudge Jordan if nothing arrives", roster: (cp, i) => roster("Jordan Marlow", insertAt("Jordan Ruiz", i, cp)), base: "Jordan Ruiz", at: 10 },
    { text: (cp, i) => insertAt("Mary Ann Lee - consultation", i, cp), roster: () => roster("Ann Lee"), base: "Mary Ann Lee - consultation", at: 13 },
    { text: (cp, i) => insertAt("Book a session for Jordan Miller", 19 + i, cp), roster: () => roster("Jordan Marlow"), base: "Book a session for Jordan Miller", at: 12 },
  ];
  const resolved: string[] = [];
  let checked = 0, different = 0;
  for (const c of cases) {
    assertEquals(resolveClient(c.text("", 0), c.roster("", 0)), null, "the case starts unresolved");
    for (const cp of ODD_CODE_POINTS) {
      for (let i = 0; i < c.at; i++) {
        const text = c.text(cp, i), people = c.roster(cp, i);
        const varied = text !== c.text("", 0) ? text : people[people.length - 1].name;
        if (variantKind(varied === text ? c.base : c.base, varied) === "different") {
          different += 1;
          continue;
        }
        checked += 1;
        const got = resolveClient(text, people);
        if (got !== null) resolved.push(`U+${cp.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} at ${i} of ${JSON.stringify(c.base)}: ${got}`);
      }
    }
  }
  claim("no-odd-resolves", { resolved: resolved.slice(0, 20), count: resolved.length }, { resolved: [], count: 0 }, "an invisible or standalone mark never turns an unresolved name into a resolved one");
  assert(ODD_CODE_POINTS.length >= 5900 && checked > 200000 && different < checked, `coverage: ${ODD_CODE_POINTS.length} code points, ${checked} checked, ${different} visibly different`);
});

Deno.test("client identity 5.3: a sample of odd code points at every position of every fixture never changes the client", () => {
  const SAMPLE = ["\u034f", "\u0301", "\u20dd", "\ufe0f", "\ufe00", "\u{e0100}", "\u3164", "\u115f", "\uffa0", "\u180b", "\u17b4", "\u{1d173}",
    "\u{e0001}", "\ue000", "\u{f0000}", "\u0378", "\u0001", "\u061c", "\u200e", "\u2061"];
  const changed: string[] = [];
  for (const [text, people] of IDENTITY_FIXTURES) {
    const want = resolveClient(text, people);
    for (const cp of SAMPLE) {
      const n = Array.from(text).length;
      for (let i = 0; i <= n; i++) {
        const t = insertAt(text, i, cp);
        if (variantKind(text, t) === "different") continue;
        const got = resolveClient(t, people);
        if (got !== null && got !== want) changed.push(`text ${JSON.stringify(t)}: ${got} not ${want}`);
      }
      people.forEach((c, k) => {
        for (let i = 0; i <= Array.from(c.name).length; i++) {
          const name = insertAt(c.name, i, cp);
          if (variantKind(c.name, name) === "different") continue;
          const got = resolveClient(text, people.map((x, j) => (j === k ? { ...x, name } : x)));
          if (got !== null && got !== want) changed.push(`roster ${JSON.stringify(name)} for ${JSON.stringify(text)}: ${got} not ${want}`);
          if (want === null && got !== null) changed.push(`roster ${JSON.stringify(name)} resolved ${JSON.stringify(text)}`);
        }
      });
    }
  }
  claim("odd-sample-never-changes", changed.slice(0, 20), [], "an odd code point anywhere leaves the answer as it was or unresolved, never another client");
});

// Correction 6 (Codex re-review 5).
const FIRST_LAST_IGNORABLES = ["­", "‍", "‌", "⁠", "﻿"];

Deno.test("client identity 5.3: a default-ignorable code point between first and last name of any fixture resolves nothing", () => {
  // Finding 1: "Book Alicia Brennan and Jordan <soft hyphen> Marlow" resolved
  // to Alicia. Every space of every fixture text, with each code point
  // standing alone, glued before, glued after, or replacing the space: the
  // text must resolve nothing. In the roster, the same inserted into a name
  // makes that client a blocker: the answer is the one its visible spelling
  // gives, or none, and never that client.
  const wrong: string[] = [];
  for (const [text, people] of IDENTITY_FIXTURES) {
    const spaces = [...text.matchAll(/ /g)].map((m) => m.index!);
    for (const x of FIRST_LAST_IGNORABLES) {
      for (const at of spaces) {
        for (const join of [` ${x} `, `${x} `, ` ${x}`, x]) {
          const t = text.slice(0, at) + join + text.slice(at + 1);
          const got = resolveClient(t, people);
          if (got !== null) wrong.push(`${JSON.stringify(t)}: ${got}`);
        }
      }
      people.forEach((c, k) => {
        const at = c.name.indexOf(" ");
        if (at < 0) return;
        for (const join of [` ${x} `, `${x} `, ` ${x}`, x]) {
          const name = c.name.slice(0, at) + join + c.name.slice(at + 1);
          const got = resolveClient(text, people.map((p, j) => (j === k ? { ...p, name } : p)));
          // What the name looks like: glued ("Jordan<x>Marlow"), it reads as
          // one word, another name than "Jordan Marlow".
          const visible = resolveClient(text, people.map((p, j) => (j === k ? { ...p, name: name.replaceAll(x, "") } : p)));
          if (got !== null && (got !== visible || got === c.id)) wrong.push(`roster ${JSON.stringify(name)} for ${JSON.stringify(text)}: ${got}`);
        }
      });
    }
  }
  claim("ignorable-between-names", wrong.slice(0, 20), [], "an invisible code point between two name words never leaves a client chosen by that name");
  assertEquals(resolveClient("Book Alicia Brennan and Jordan ­ Marlow", [{ id: "a", name: "Alicia Brennan" }, { id: "j", name: "Jordan Marlow" }]), null);
});

Deno.test("client identity 5.3: roster names that look the same however they are encoded are ambiguous (UTS #39 skeleton)", () => {
  // Finding 2: "José Li" and "Jo<U+FFF9>sé Li" render identically. Latin,
  // Cyrillic and Greek lookalikes, a precomposed letter against base + mark
  // that NFC does not unify, a format character, and a leading U+FEFF.
  const pairs: Array<[string, string, string]> = [
    ["Book José Li", "José Li", "Jo￹sé Li"],
    ["Book Alicia Brennan", "Alicia Brennan", "Аlicia Brennan"],
    ["Book Alicia Brennan", "Alicia Brennan", "Alicia Brеnnan"],
    ["Book Paige Smith", "Paige Smith", "Рaige Smith"],
    ["Book Olga Kim", "Olga Kim", "Οlga Kim"],
    ["Book Zoë Brontë", "Zoë Brontë", "Ζoë Brontë"],
    ["Book Bjørn Li", "Bjørn Li", "Bjo̸rn Li"],
    ["Book Ian Lee", "Ian Lee", "lan Lee"],
  ];
  const chosen = pairs.map(([text, a, b]) => [text, resolveClient(text, [{ id: "a", name: a }, { id: "b", name: b }]), resolveClient(text, [{ id: "a", name: a }])]);
  const lone = resolveClient("Book Alicia Brennan", [{ id: "alicia", name: "﻿Alicia Brennan" }]);
  claim(
    "confusables-ambiguous",
    { chosen, lone },
    { chosen: pairs.map(([text]) => [text, null, "a"]), lone: null },
    "two rows that look the same are ambiguous; the same name alone still resolves; a row starting with U+FEFF is never chosen",
  );
});

Deno.test("client identity 5.3: the confusable skeleton is ICU's, from the pinned table", async () => {
  const { confusableSkeleton } = await import("./confusables.ts");
  const data = await import("./confusables-data.ts");
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data.CONFUSABLES))))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const vectors = JSON.parse(await Deno.readTextFile(new URL("../../../scripts/loop-closing/confusables-vectors.json", import.meta.url))).vectors as Array<[string, string]>;
  const differ = vectors.filter(([i, e]) => confusableSkeleton(i) !== e).slice(0, 10).map(([i]) => i);
  assertEquals({ digest, count: data.CONFUSABLES.split(";").length, vectors: vectors.length > 3000, differ },
    { digest: data.CONFUSABLES_SHA256, count: data.CONFUSABLES_COUNT, vectors: true, differ: [] });
});

Deno.test("client identity 5.3: a blocker reached by the first-name rule is never the answer", () => {
  // Finding 4 (Codex re-review 5): "İl" folds to three code points, so it
  // passes the first-name length check, while its mark-free form "Il" does
  // not; only the final guard keeps the blocker out of the answer.
  claim(
    "blocker-never-chosen",
    { odd: resolveClient("Book İl", [{ id: "short", name: "İl North͏" }]), clean: resolveClient("Book İl", [{ id: "short", name: "İl North" }]) },
    { odd: null, clean: "short" },
    "an odd roster name is never chosen, even where only the final guard stands between it and the answer",
  );
});
