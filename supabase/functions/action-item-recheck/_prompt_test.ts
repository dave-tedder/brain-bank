import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import {
  BLOCK_SEPARATOR,
  buildRecheckPrompt,
  CHUNK_CHARS,
  CHUNK_OVERLAP,
  chunkThought,
  judgeAnswer,
  MAX_CALL_CHARS,
  mergeRows,
  type PageThought,
  parseRecheckAnswer,
  planRecheckCalls,
  QUOTE_STORE_MAX,
  type RecheckRow,
  thoughtBlocks,
  thoughtNamesItemClient,
} from "./_prompt.ts";
import { SUBJECT_COVERAGE_THRESHOLD, subjectCoverage } from "../_shared/quote-coverage.ts";

// Text with no repeated run: word i is "w<i>", so any 20-character slice occurs once.
function words(chars: number, from = 0): string {
  let s = "";
  for (let i = from; s.length < chars; i++) s += `w${i} `;
  return s.slice(0, chars);
}
const T = (id: string, content: string, project: string | null = null): PageThought => ({
  id,
  created_at: "2026-11-01T10:00:00.123456+00:00",
  content,
  metadata: project === null ? {} : { project },
});
const pageOf = (...ts: PageThought[]) => new Map(ts.map((t) => [t.id, t]));
const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const NO_CLIENTS: string[] = [];

// ---------- chunking ----------

Deno.test("chunkThought: a thought of exactly 4,000 characters is one chunk, unchanged", () => {
  const text = words(CHUNK_CHARS);
  assertEquals(chunkThought(text), [text]);
});

Deno.test("chunkThought: 4,001 characters is two chunks of 4,000 with a 400-character overlap", () => {
  const text = words(CHUNK_CHARS + 1);
  const chunks = chunkThought(text);
  assertEquals(chunks.length, 2);
  assertEquals(chunks[0], text.slice(0, 4000));
  assertEquals(chunks[1], text.slice(3600));
  assertEquals(chunks[0].slice(-CHUNK_OVERLAP), chunks[1].slice(0, CHUNK_OVERLAP));
});

Deno.test("chunkThought: every chunk is text[i*3600, i*3600+4000) and the last one reaches the end", () => {
  for (const len of [7599, 7600, 7601, 10000, 25000]) {
    const text = words(len);
    const chunks = chunkThought(text);
    chunks.forEach((c, i) => assertEquals(c, text.slice(i * 3600, i * 3600 + 4000), `len ${len} chunk ${i}`));
    assert(text.endsWith(chunks[chunks.length - 1]), `len ${len}: the tail is not cut off`);
    assertEquals(chunks.length, Math.ceil((len - CHUNK_OVERLAP) / (CHUNK_CHARS - CHUNK_OVERLAP)), `len ${len} count`);
  }
});

Deno.test("chunkThought: a chunk never starts in the middle of a surrogate pair", () => {
  const text = "a".repeat(3599) + "\u{1F600}" + "b".repeat(3000); // the pair sits at 3599..3600
  const chunks = chunkThought(text);
  assertEquals(chunks.length, 2);
  assertEquals(chunks[1].codePointAt(0), 0x1f600);
});

// ---------- the prompt ----------

Deno.test("buildRecheckPrompt: a page of ten short thoughts is one call, every thought in full, the item text on every block", () => {
  const item = "rotate the Railway deploy token";
  const thoughts = Array.from({ length: 10 }, (_, i) => T(`0000000${i}-0000-4000-8000-000000000000`, `note number ${i} body`));
  const calls = planRecheckCalls(thoughts);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].length, 10);
  const messages = buildRecheckPrompt(item, calls[0]);
  assertEquals(messages.length, 2);
  assertEquals(messages[0].role, "system");
  const user = messages[1].content;
  assertEquals(user.split(`ITEM: ${item}\n`).length - 1, 10);
  assertEquals(user.split(BLOCK_SEPARATOR).length, 10);
  thoughts.forEach((t, i) => {
    assert(user.includes(`THOUGHT ${t.id} (captured ${t.created_at})\nnote number ${i} body`));
  });
  // The item line is FIRST in every block.
  for (const block of user.split(BLOCK_SEPARATOR)) assert(block.startsWith(`ITEM: ${item}\n`));
});

Deno.test("buildRecheckPrompt: a 9,000-character thought is three labelled parts, each carrying the item text, nothing truncated", () => {
  const item = "send the explainer PDF";
  const text = words(9000);
  const blocks = thoughtBlocks(T(ID1, text));
  assertEquals(blocks.map((b) => `${b.part}/${b.parts}`), ["1/3", "2/3", "3/3"]);
  const user = buildRecheckPrompt(item, blocks)[1].content;
  assertEquals(user.split(`ITEM: ${item}\n`).length - 1, 3);
  for (const n of [1, 2, 3]) assert(user.includes(`THOUGHT ${ID1} (captured 2026-11-01T10:00:00.123456+00:00) [part ${n} of 3]\n`));
  // The last 50 characters of the stored thought reach the model.
  assert(user.includes(text.slice(-50)));
  // No 600-character cut: character 601 onward is there too.
  assert(user.includes(text.slice(590, 700)));
});

Deno.test("buildRecheckPrompt: an unsplit thought carries no part label", () => {
  const user = buildRecheckPrompt("x", thoughtBlocks(T(ID1, "short")))[1].content;
  assertEquals(user, `ITEM: x\nTHOUGHT ${ID1} (captured 2026-11-01T10:00:00.123456+00:00)\nshort`);
});

Deno.test("planRecheckCalls: an oversize page becomes several calls, no block lost, order kept, no chunk split", () => {
  const big = Array.from({ length: 10 }, (_, i) => T(`0000000${i}-0000-4000-8000-000000000000`, words(60_000, i * 100_000)));
  const calls = planRecheckCalls(big);
  assert(calls.length > 1, "600,000 characters do not fit one call");
  const flat = calls.flat();
  const expected = big.flatMap((t) => thoughtBlocks(t));
  assertEquals(flat, expected);
  for (const c of calls) {
    assert(c.reduce((n, b) => n + b.text.length, 0) <= MAX_CALL_CHARS);
    for (const b of c) assert(b.text.length <= CHUNK_CHARS);
  }
});

Deno.test("planRecheckCalls: an empty page plans no call", () => {
  assertEquals(planRecheckCalls([]), []);
});

// ---------- parsing ----------

Deno.test("parseRecheckAnswer: plain, fenced and mixed-case answers", () => {
  assertEquals(
    parseRecheckAnswer('{"verdict":"done","thought_id":"ABCDEF12-1111-4111-8111-11111111ABCD ","quote":" it shipped "}'),
    { verdict: "done", thought_id: "abcdef12-1111-4111-8111-11111111abcd", quote: "it shipped" },
  );
  assertEquals(
    parseRecheckAnswer('```json\n{"verdict":"OPEN","thought_id":null,"quote":null}\n```'),
    { verdict: "open", thought_id: null, quote: null },
  );
  assertEquals(
    parseRecheckAnswer('{"verdict":"superseded","thought_id":"","quote":"   "}'),
    { verdict: "superseded", thought_id: null, quote: null },
  );
});

Deno.test("parseRecheckAnswer: a reply that is not the object asked for is null, never 'open'", () => {
  for (const raw of ["", "I think it is done.", "[]", '{"verdict":"maybe"}', '{"thought_id":"x"}', '{"verdict":7}', "{not json"]) {
    assertEquals(parseRecheckAnswer(raw), null, raw);
  }
});

// ---------- the acceptance checks ----------

const ITEM = { description: "rotate the Railway deploy token", project: "brain-bank" };
const DONE_TEXT = "Rotated the Railway deploy token this morning and confirmed the new one works.";
const DONE_QUOTE = "Rotated the Railway deploy token this morning";

Deno.test("judgeAnswer: 'open' writes nothing", () => {
  assertEquals(judgeAnswer({ verdict: "open", thought_id: ID1, quote: DONE_QUOTE }, ITEM, pageOf(T(ID1, DONE_TEXT)), NO_CLIENTS), null);
});

Deno.test("judgeAnswer: a verbatim quote that covers the item, in scope, is a proposal with its score", () => {
  for (const verdict of ["done", "superseded"] as const) {
    assertEquals(
      judgeAnswer({ verdict, thought_id: ID1, quote: DONE_QUOTE }, ITEM, pageOf(T(ID1, DONE_TEXT, "brain-bank")), NO_CLIENTS),
      { outcome: "proposed", reason: null, evidence_thought_id: ID1, quote: DONE_QUOTE, score: 1 },
    );
  }
});

Deno.test("judgeAnswer: a thought id that was not in the page is thought_not_in_page with NO evidence id", () => {
  const page = pageOf(T(ID1, DONE_TEXT));
  const expected: RecheckRow = { outcome: "no_evidence", reason: "thought_not_in_page", evidence_thought_id: null, quote: null, score: null };
  assertEquals(judgeAnswer({ verdict: "done", thought_id: ID2, quote: DONE_QUOTE }, ITEM, page, NO_CLIENTS), expected);
  assertEquals(judgeAnswer({ verdict: "done", thought_id: null, quote: DONE_QUOTE }, ITEM, page, NO_CLIENTS), expected);
  assertEquals(judgeAnswer({ verdict: "done", thought_id: "not-a-uuid", quote: DONE_QUOTE }, ITEM, page, NO_CLIENTS), expected);
});

Deno.test("judgeAnswer: a missing quote or one that is not verbatim is quote_not_verbatim", () => {
  const page = pageOf(T(ID1, DONE_TEXT));
  assertEquals(
    judgeAnswer({ verdict: "done", thought_id: ID1, quote: null }, ITEM, page, NO_CLIENTS),
    { outcome: "no_evidence", reason: "quote_not_verbatim", evidence_thought_id: ID1, quote: null, score: null },
  );
  const altered = "Rotated the Railway deploy token this afternoon";
  assertEquals(
    judgeAnswer({ verdict: "done", thought_id: ID1, quote: altered }, ITEM, page, NO_CLIENTS),
    { outcome: "no_evidence", reason: "quote_not_verbatim", evidence_thought_id: ID1, quote: altered, score: null },
  );
  // Case matters: verbatim is exact.
  assertEquals(
    judgeAnswer({ verdict: "done", thought_id: ID1, quote: DONE_QUOTE.toLowerCase() }, ITEM, page, NO_CLIENTS)?.reason,
    "quote_not_verbatim",
  );
});

Deno.test("judgeAnswer: a quote that exists in the PROMPT across two parts but not in the full stored thought is quote_not_verbatim", () => {
  const text = words(6000);
  const blocks = thoughtBlocks(T(ID1, text));
  assertEquals(blocks.length, 2);
  // The end of part 1 followed by the start of part 2: adjacent in what the
  // model was shown, not adjacent in the stored thought (the parts overlap).
  const joined = blocks[0].text.slice(-20) + blocks[1].text.slice(0, 20);
  assert(!text.includes(joined), "the fixture must not be a real substring");
  assert((blocks[0].text + blocks[1].text).includes(joined));
  assertEquals(
    judgeAnswer({ verdict: "done", thought_id: ID1, quote: joined }, ITEM, pageOf(T(ID1, text)), NO_CLIENTS)?.reason,
    "quote_not_verbatim",
  );
  // Control: a quote wholly inside part 2 IS verbatim in the full text.
  const inside = blocks[1].text.slice(500, 540);
  assert(judgeAnswer({ verdict: "done", thought_id: ID1, quote: inside }, ITEM, pageOf(T(ID1, text)), NO_CLIENTS)?.reason !== "quote_not_verbatim");
});

Deno.test("judgeAnswer: 'still pending' after character 4,000 vetoes a completion clause in the first 4,000 (the veto reads the full thought)", () => {
  const head = `${DONE_TEXT} `;
  const filler = words(4500 - head.length, 5000);
  const tail = " Correction: the Railway deploy token rotation is still pending on staging.";
  const text = (head + filler + tail).padEnd(6000, " z");
  assertEquals(text.length, 6000);
  assert(text.indexOf("still pending") > CHUNK_CHARS, "the still-owed clause is after the first chunk");
  assert(text.indexOf(DONE_QUOTE) < CHUNK_CHARS);
  assertEquals(
    judgeAnswer({ verdict: "done", thought_id: ID1, quote: DONE_QUOTE }, ITEM, pageOf(T(ID1, text)), NO_CLIENTS),
    { outcome: "no_evidence", reason: "veto", evidence_thought_id: ID1, quote: DONE_QUOTE, score: null },
  );
  // Control: the same thought without the still-owed clause is a proposal.
  const clean = (head + filler).padEnd(6000, " z");
  assertEquals(
    judgeAnswer({ verdict: "done", thought_id: ID1, quote: DONE_QUOTE }, ITEM, pageOf(T(ID1, clean)), NO_CLIENTS)?.outcome,
    "proposed",
  );
});

Deno.test("judgeAnswer: a verbatim quote that does not cover the item's subject is coverage, with the score", () => {
  const text = "Finished the newsletter draft and sent it to Sam. Also looked at the Railway dashboard.";
  const quote = "Finished the newsletter draft and sent it to Sam.";
  assertEquals(
    judgeAnswer({ verdict: "done", thought_id: ID1, quote }, ITEM, pageOf(T(ID1, text)), NO_CLIENTS),
    { outcome: "no_evidence", reason: "coverage", evidence_thought_id: ID1, quote, score: 0 },
  );
  // One of the item's content tokens is not enough.
  const one = "Opened Railway.";
  assertEquals(
    judgeAnswer({ verdict: "done", thought_id: ID1, quote: one }, ITEM, pageOf(T(ID1, `${one} Nothing else.`)), NO_CLIENTS)?.reason,
    "coverage",
  );
});

Deno.test("judgeAnswer: the thought's project must be the item's project or null", () => {
  const ans = { verdict: "done" as const, thought_id: ID1, quote: DONE_QUOTE };
  assertEquals(judgeAnswer(ans, ITEM, pageOf(T(ID1, DONE_TEXT, "fitness-tracker")), NO_CLIENTS)?.reason, "scope_mismatch");
  assertEquals(judgeAnswer(ans, ITEM, pageOf(T(ID1, DONE_TEXT, "fitness-tracker")), NO_CLIENTS)?.evidence_thought_id, ID1);
  assertEquals(judgeAnswer(ans, ITEM, pageOf(T(ID1, DONE_TEXT, "brain-bank")), NO_CLIENTS)?.outcome, "proposed");
  assertEquals(judgeAnswer(ans, ITEM, pageOf(T(ID1, DONE_TEXT, null)), NO_CLIENTS)?.outcome, "proposed");
  // An item with no project accepts only a thought with no project.
  const bare = { description: ITEM.description, project: null };
  assertEquals(judgeAnswer(ans, bare, pageOf(T(ID1, DONE_TEXT, "brain-bank")), NO_CLIENTS)?.reason, "scope_mismatch");
  assertEquals(judgeAnswer(ans, bare, pageOf(T(ID1, DONE_TEXT, null)), NO_CLIENTS)?.outcome, "proposed");
  // A blank project is no project.
  assertEquals(judgeAnswer(ans, bare, pageOf({ ...T(ID1, DONE_TEXT), metadata: { project: "  " } }), NO_CLIENTS)?.outcome, "proposed");
  assertEquals(judgeAnswer(ans, bare, pageOf({ ...T(ID1, DONE_TEXT), metadata: null }), NO_CLIENTS)?.outcome, "proposed");
});

const CLIENTS = ["Alicia Brennan", "Jordan Smith", "Jordan Jones", "Morgan Lee"];

Deno.test("judgeAnswer: for a client-shaped item the thought must name that client", () => {
  const item = { description: "Send Alicia Brennan the deposit link", project: null };
  const without = "Sent the deposit link this afternoon.";
  const other = "Sent Morgan Lee the deposit link this afternoon.";
  const named = "Sent Alicia Brennan the deposit link this afternoon.";
  const q = (text: string) => text.slice(0, text.indexOf(" this"));
  assertEquals(judgeAnswer({ verdict: "done", thought_id: ID1, quote: q(without) }, item, pageOf(T(ID1, without)), CLIENTS)?.reason, "scope_mismatch");
  assertEquals(judgeAnswer({ verdict: "done", thought_id: ID1, quote: q(other) }, item, pageOf(T(ID1, other)), CLIENTS)?.reason, "scope_mismatch");
  assertEquals(judgeAnswer({ verdict: "done", thought_id: ID1, quote: q(named) }, item, pageOf(T(ID1, named)), CLIENTS)?.outcome, "proposed");
  // The same texts with no client list are not client-shaped, so scope passes.
  assertEquals(judgeAnswer({ verdict: "done", thought_id: ID1, quote: q(without) }, item, pageOf(T(ID1, without)), NO_CLIENTS)?.outcome, "proposed");
});

Deno.test("thoughtNamesItemClient: full names need every one; a shared first name needs that name; otherwise it passes", () => {
  assertEquals(thoughtNamesItemClient("email the vendor", "anything", CLIENTS), true);
  assertEquals(thoughtNamesItemClient("Call Alicia Brennan", "called alicia brennan", CLIENTS), true);
  assertEquals(thoughtNamesItemClient("Call Alicia Brennan", "called Alicia", CLIENTS), false);
  assertEquals(thoughtNamesItemClient("Call Alicia Brennan", "called aliciabrennan", CLIENTS), false);
  assertEquals(thoughtNamesItemClient("Call Alicia Brennan and Morgan Lee", "called Alicia Brennan", CLIENTS), false);
  assertEquals(thoughtNamesItemClient("Call Alicia Brennan and Morgan Lee", "Morgan Lee and Alicia Brennan both called", CLIENTS), true);
  // "Jordan" matches two clients: client-shaped through the shared first name.
  assertEquals(thoughtNamesItemClient("Nudge Jordan if nothing arrives", "nudged him", CLIENTS), false);
  assertEquals(thoughtNamesItemClient("Nudge Jordan if nothing arrives", "Nudged Jordan today", CLIENTS), true);
  assertEquals(thoughtNamesItemClient("Nudge Jordan if nothing arrives", "Nudged Jordanson today", CLIENTS), false);
});

Deno.test("judgeAnswer: the first failing check names the reason (verbatim before scope)", () => {
  assertEquals(
    judgeAnswer({ verdict: "done", thought_id: ID1, quote: "never said" }, ITEM, pageOf(T(ID1, DONE_TEXT, "fitness-tracker")), NO_CLIENTS)?.reason,
    "quote_not_verbatim",
  );
});

Deno.test("judgeAnswer: an accepted quote is stored WHOLE: the stored evidence is itself verbatim and its own coverage is the stored score", () => {
  // Review finding F1: 600 characters of preamble, then the sentence that says
  // the item is done. The first 500 characters alone say nothing about the item.
  const preamble = words(600);
  const text = `${preamble}${DONE_TEXT}`;
  const quote = `${preamble}${DONE_QUOTE}`;
  assert(quote.length > QUOTE_STORE_MAX, "the fixture must be longer than the rejected-quote cap");
  assertEquals(subjectCoverage(quote.slice(0, QUOTE_STORE_MAX), ITEM.description), 0, "the fixture's first 500 characters must not cover the item");
  const row = judgeAnswer({ verdict: "done", thought_id: ID1, quote }, ITEM, pageOf(T(ID1, text)), NO_CLIENTS);
  assertEquals(row, { outcome: "proposed", reason: null, evidence_thought_id: ID1, quote, score: 1 });
  // What is stored passes the acceptance checks by itself.
  assert(text.includes(row!.quote!), "the stored quote is a verbatim substring of the stored thought");
  assert(subjectCoverage(row!.quote!, ITEM.description) >= SUBJECT_COVERAGE_THRESHOLD, "the stored quote covers the item");
  assertEquals(Math.round(subjectCoverage(row!.quote!, ITEM.description) * 10000) / 10000, row!.score, "the stored score is the stored quote's score");

  // The reviewer's own reproduction, value for value.
  const description = "rotate Railway deploy token";
  const bg = "Background details. ".repeat(30) + "Rotated the Railway deploy token.";
  const r2 = judgeAnswer({ verdict: "done", thought_id: ID1, quote: bg }, { description, project: null }, pageOf(T(ID1, bg)), NO_CLIENTS);
  assertEquals([r2?.outcome, r2?.quote?.length, r2?.score], ["proposed", 633, 1]);
  assertEquals(subjectCoverage(r2!.quote!, description), 1);
});

Deno.test("judgeAnswer: a REJECTED answer's quote is capped at 500 characters, for each reason that stores one", () => {
  const cap = (q: string) => q.slice(0, QUOTE_STORE_MAX);
  // quote_not_verbatim: a long quote that is not in the thought.
  const invented = words(900, 20000);
  const nv = judgeAnswer({ verdict: "done", thought_id: ID1, quote: invented }, ITEM, pageOf(T(ID1, DONE_TEXT)), NO_CLIENTS);
  assertEquals([nv?.reason, nv?.quote], ["quote_not_verbatim", cap(invented)]);
  // veto: a long verbatim quote in a thought that also says the work is still pending.
  const preamble = words(600);
  const vetoQuote = `${preamble}${DONE_QUOTE}`;
  const vetoText = `${preamble}${DONE_TEXT} Correction: the Railway deploy token rotation is still pending on staging.`;
  const veto = judgeAnswer({ verdict: "done", thought_id: ID1, quote: vetoQuote }, ITEM, pageOf(T(ID1, vetoText)), NO_CLIENTS);
  assertEquals([veto?.reason, veto?.quote], ["veto", cap(vetoQuote)]);
  // coverage: a long verbatim quote that says nothing about the item.
  const filler = words(900);
  const cov = judgeAnswer({ verdict: "done", thought_id: ID1, quote: filler }, ITEM, pageOf(T(ID1, filler)), NO_CLIENTS);
  assertEquals([cov?.reason, cov?.quote, cov?.score], ["coverage", cap(filler), 0]);
  // scope_mismatch: a long verbatim quote that covers the item, in another project's thought.
  const scoped = `${DONE_QUOTE} ${words(900)}`;
  const sc = judgeAnswer({ verdict: "done", thought_id: ID1, quote: scoped }, ITEM, pageOf(T(ID1, scoped, "fitness-tracker")), NO_CLIENTS);
  assertEquals([sc?.reason, sc?.quote, sc?.score], ["scope_mismatch", cap(scoped), 1]);
  for (const r of [nv, veto, cov, sc]) assertEquals(r?.quote?.length, QUOTE_STORE_MAX);
});

Deno.test("judgeAnswer: the score is rounded to four places", () => {
  const item3 = { description: "rotate Railway token vault secret keys", project: null };
  const partial = judgeAnswer({ verdict: "done", thought_id: ID1, quote: "Rotated the Railway token" }, item3, pageOf(T(ID1, "Rotated the Railway token today.")), NO_CLIENTS);
  assertEquals(partial?.score, 0.5);
});

// ---------- merging a page's answers ----------

Deno.test("mergeRows: one row per evidence thought, a proposal beats a rejection, one thought_not_in_page", () => {
  const rej: RecheckRow = { outcome: "no_evidence", reason: "coverage", evidence_thought_id: ID1, quote: "a", score: 0.1 };
  const pro: RecheckRow = { outcome: "proposed", reason: null, evidence_thought_id: ID1, quote: "b", score: 0.9 };
  const veto: RecheckRow = { outcome: "no_evidence", reason: "veto", evidence_thought_id: ID1, quote: "c", score: null };
  const nip: RecheckRow = { outcome: "no_evidence", reason: "thought_not_in_page", evidence_thought_id: null, quote: null, score: null };
  const other: RecheckRow = { outcome: "no_evidence", reason: "veto", evidence_thought_id: ID2, quote: "d", score: null };
  assertEquals(mergeRows([rej, pro]), [pro]);
  assertEquals(mergeRows([pro, rej]), [pro]);
  assertEquals(mergeRows([rej, veto]), [rej]);
  assertEquals(mergeRows([nip, other, nip, rej]), [nip, other, rej]);
  assertEquals(mergeRows([]), []);
});
