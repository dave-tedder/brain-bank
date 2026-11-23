// Loop-closing Task 5.3 (B5): client identity per action item.
//
// Per ITEM, not per capture: each item's own text is searched for a client
// name, and `client_id` is set only when the text establishes exactly one
// client. A multi-client capture therefore gives each item its own id (an
// Alicia item and a Jordan item get different ids), and an item whose name
// matches two clients ("nudge Jordan" with two Jakes) keeps client_id null.
// Where the text cannot establish identity, the item stays unresolved.
//
// Called by BOTH copies of extractAndStoreActionItems (capture-pipeline.ts,
// which REST /capture and MCP capture_thought run, and ingest-thought), after
// every filter and before the insert, so one shared copy carries the rule and
// the mirror suite only has to prove both bodies call it at the same place.
// The booking matcher (booking-match.ts) resolves an event title the same way.
//
// The roster: every client's id and name, read in ONE statement
// (client_roster, migration 20261121b), so ambiguity is judged on one
// consistent snapshot and no server row cap can shorten it. A roster longer
// than ROSTER_MAX resolves nothing. Names are compared in memory, never
// through a database pattern, so no character in a name (*, %, _, backslash)
// can act as a wildcard.
//
// Text: every identity and date path (an item's text, an event title, each
// roster name) passes through normalizeText ONCE at its entry, and every word
// split, neighbour check, name match and mask below works only on its output:
// NFKC; the apostrophe and hyphen variants made ASCII; every Unicode space,
// separator and control space made one ASCII space; runs collapsed;
// trimmed; NFKC again (a fixed point). Nothing invisible is removed: the
// allowlist below decides what an invisible code point means. Case is
// kept in the text, because a capital letter is evidence the rules below use
// (a name word, a month), and folded (lowercased) in every token compared.
//
// Words: runs of normalised text between spaces, punctuation and symbols,
// joined by an inner hyphen or apostrophe ("Jean-Luc", "O'Neil"), with a
// possessive "'s" dropped; tokens are those words split at the joiners and
// lowercased (so "李 明" is two tokens and "Jean-Luc West" and "Jean Luc
// West" share the form "jean luc west").
//
// ALLOWLIST (correction 5). A word is a NAME word only when every part of it
// is letters: \p{L} that is not a default-ignorable code point. Normalisation
// has already composed every combining mark that composes into its letter, so
// a combining mark still standing alone, a default-ignorable code point (the
// combining grapheme joiner, variation selectors, Hangul fillers, ...), a
// private-use or unassigned code point, or a control, makes the word ODD.
// Nothing is stripped to make a word match: the code points that may take
// part in a name are listed, and anything else fails closed.
//   - ANY odd word in the text (an item's text or an event title) makes the
//     whole text resolve nothing (correction 6): an odd word can hide or
//     interrupt a name ("Jordan <soft hyphen> Marlow" beside "Alicia Brennan"),
//     with or without a letter of its own. This includes a variation
//     selector after an emoji ("<heart><VS16>").
//   - A roster name holding an ODD word can never be chosen. It still takes
//     part in every comparison under its visible spellings (the invisible
//     code points removed and the rest composed again; then the marks still
//     standing alone removed; then every mark removed), so any text it would
//     match is ambiguous; and a text that, read with every mark removed,
//     names a blocker (read the same way) resolves nothing.
//   - CONFUSABLES (correction 6): any two roster names whose UTS #39
//     confusable skeletons are equal (confusables.ts; compared as written
//     and lowercased) look the same however they are encoded (Latin "A" and
//     Cyrillic "A", "o" + U+0338 and "o-slash"): both become blockers, so a
//     text naming either resolves nothing.
//   - A word with digits ("Studio 54") is a plain word: it matches nothing,
//     and is a neighbour only if it is capitalised.
//
// The rule, in order:
//   1. Full names. A client name of two or more tokens matches when its tokens
//      appear contiguously in the text, starting at the start of a word and
//      ending at the end of a word. A match run into another capitalised word
//      separated only by spaces, other than the scheduling and title words in
//      NAME_NEIGHBOURS (Book, Schedule, Consultation, Tattoo, Session, ...),
//      may be part of a longer name ("Mary Ann Lee" is not "Ann Lee"): it
//      makes the text AMBIGUOUS and nothing resolves, unless it lies inside a
//      longer known name that matched cleanly. Every client whose name has
//      the matched form counts, not just the first. When any full name
//      matches, the result is that one client, or nothing when the matches
//      name two or more clients; there is no first-name fallback.
//   2. First names, only when no full name matched. A capitalised word of
//      three or more letters, other than the item's first word, that is a whole
//      token of some client's name. If such a word is run into a capitalised
//      word that is not in NAME_NEIGHBOURS, the text supplies a name the roster
//      lacks ("Jordan Miller", "Ann Leeds") and nothing resolves.
//      Each such word is looked up the way find_client does it (the name
//      contains the word, ignoring case); it must find exactly one client.
//   An item gets an id only when every candidate it names finds exactly one
//   client and they agree. Anything else (no name, 0 or 2+ clients, a
//   conflict, a failed read) leaves client_id unset. Nothing here throws.
//
// No supabase-js import: callers pass their own client, typed structurally.

import { confusableSkeleton } from "./confusables.ts";

/** A roster longer than this resolves nothing (logged): client_roster then
 * returns the count without the rows. */
export const ROSTER_MAX = 20000;

export type ClientDb = {
  // deno-lint-ignore no-explicit-any
  from(table: string): any;
  // deno-lint-ignore no-explicit-any
  rpc?: (fn: string, args: Record<string, unknown>) => any;
};

export type RosterEntry = { id: string; name: string };

/** A word of normalised text: [start, end) without a possessive "'s",
 * [start, fullEnd) with it. */
type Word = { start: number; end: number; fullEnd: number; tokens: string[]; capitalised: boolean; possessive: boolean; odd: boolean };

// Words end at the ASCII space (the only space normalizeText leaves),
// punctuation and symbols. Not \s: JavaScript counts U+FEFF as whitespace,
// and here it is an invisible code point the allowlist fails closed on.
const WORD_RE = /[^ \p{P}\p{S}]+(?:['\-][^ \p{P}\p{S}]+)*/gu;
const NAME_LETTER = /^\p{L}$/u;
const IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;
const DIGIT = /^\p{N}$/u;
/** What a word part is: all name letters, letters and digits, or anything
 * else (odd). */
function partKind(part: string): "letters" | "plain" | "odd" {
  let kind: "letters" | "plain" = "letters";
  for (const ch of part) {
    if (NAME_LETTER.test(ch) && !IGNORABLE.test(ch)) continue;
    if (DIGIT.test(ch)) {
      kind = "plain";
      continue;
    }
    return "odd";
  }
  return kind;
}
/** A token no other token equals: each non-name word gets its own. */
let unmatchable = 0;
const noMatch = () => `\u0000${++unmatchable}`;
// Nothing invisible is removed or rewritten here (correction 5): a format
// character, the zero-width space or any other default-ignorable code point
// stays in the text and makes its word ODD (see the allowlist above).
const APOSTROPHES = /[\u2018\u2019\u02BC\u2032]/g;
const HYPHENS = /[\u2010\u2011]/g;
const SPACES = /[\p{Z}\t\n\v\f\r\u0085]+/gu;

/** The one normalisation every identity and date path applies at entry (see
 * the header): NFKC, the visible apostrophe, hyphen and space variants made
 * ASCII, runs of spaces collapsed, trimmed, and NFKC again, so the result is
 * composed and a fixed point: normalizeText(normalizeText(x)) ===
 * normalizeText(x). Invisible code points are kept, so the allowlist sees
 * them. */
export function normalizeText(text: string): string {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(APOSTROPHES, "'")
    .replace(HYPHENS, "-")
    .replace(SPACES, " ")
    // Only the ASCII space is trimmed: String.prototype.trim would also
    // remove U+FEFF, which the allowlist must see.
    .replace(/^ +| +$/g, "")
    .normalize("NFKC");
}

/** Lowercase: the case folding of a token of normalised text. */
function fold(s: string): string {
  return s.toLowerCase();
}

/** The words of NORMALISED text, with their tokens and whether they start
 * uppercase. Callers pass normalizeText output. */
export function nameWords(text: string): Word[] {
  const out: Word[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    // A possessive ending is not part of the name ("Alicia Brennan's"); a word
    // ending in s may take a bare trailing apostrophe ("James'").
    const raw = m[0].replace(/'[sS]$/u, "");
    const after = m.index! + m[0].length;
    const trailing = raw === m[0] && /[sS]$/u.test(raw) && text[after] === "'" &&
      (after + 1 >= text.length || /[ \p{P}\p{S}]/u.test(text[after + 1]));
    const parts = raw.split(/['\-]/);
    const kinds = parts.map(partKind);
    const odd = kinds.includes("odd");
    const name = kinds.every((k) => k === "letters");
    out.push({
      start: m.index!,
      end: m.index! + raw.length,
      fullEnd: after + (trailing ? 1 : 0),
      // Only a name word has tokens that can match; any other word gets a
      // token of its own, so no match runs across it.
      tokens: name ? parts.map(fold).filter(Boolean) : [noMatch()],
      // An odd word always counts as a capitalised neighbour.
      capitalised: odd || /^[\p{Lu}\p{Lt}]/u.test(raw),
      possessive: raw.length !== m[0].length || trailing,
      odd,
    });
  }
  return out;
}

/** The normalised token form of a name ("Jean-Luc West" -> "jean luc west"). */
export function nameForm(name: string): string {
  return nameWords(normalizeText(name)).flatMap((w) => w.tokens).join(" ");
}

/** True when two words of normalised text are separated by one space only
 * (normalizeText has already made every space, of any kind, that space). */
function spaceOnly(text: string, a: Word, b: Word): boolean {
  return text.slice(a.end, b.start) === " ";
}

/** The only capitalised words that may stand right next to a client's name,
 * separated by spaces alone: the scheduling and messaging verbs items begin
 * with, and the words event titles put before or after a name. Any other
 * capitalised word there may be part of the name ("Mary Ann Lee" is not "Ann
 * Lee"), so the match is ambiguous. Lowercase, compared with the word's token. */
export const NAME_NEIGHBOURS: ReadonlySet<string> = new Set([
  "book", "booking", "schedule", "reschedule", "arrange", "set", "send", "email", "text", "call",
  "message", "remind", "nudge", "ask", "tell", "invite", "confirm", "follow", "check",
  "tattoo", "session", "consult", "consultation", "appointment", "appt", "touch", "touchup",
]);

/** True when the matched word span [i, j] runs into another capitalised
 * word (spaces only between them) that is not one of NAME_NEIGHBOURS. */
function runsIntoName(text: string, words: Word[], i: number, j: number): boolean {
  const foreign = (w: Word) => w.capitalised && !(w.tokens.length === 1 && NAME_NEIGHBOURS.has(w.tokens[0]));
  if (i > 0 && foreign(words[i - 1]) && spaceOnly(text, words[i - 1], words[i])) return true;
  if (j + 1 < words.length && foreign(words[j + 1]) && spaceOnly(text, words[j], words[j + 1])) return true;
  return false;
}

/** The id prefix of a roster name that can never be chosen (an ODD word). */
const BLOCKER = "\u0000blocker:";
/** Every code point that is not a letter, digit, combining mark or part of
 * the normalised spacing and punctuation: what a visible spelling leaves out. */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Cc}]/gu;

/** The roster as identity compares it: a name with an ODD word becomes, under
 * its visible spellings, a blocker that takes part in every comparison but
 * is never chosen. Idempotent. */
export function prepareRoster(roster: readonly RosterEntry[]): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (const c of roster) {
    const n = normalizeText(c.name);
    if (c.id.startsWith(BLOCKER) || !nameWords(n).some((w) => w.odd)) {
      out.push(c);
      continue;
    }
    // Its visible spellings: the invisible code points removed and the rest
    // composed again; then also every mark still standing alone removed
    // (composed letters kept); then every mark removed.
    const visible = normalizeText(n.replace(INVISIBLE, ""));
    const marksAlone = normalizeText(visible.replace(/\p{M}/gu, ""));
    const bare = normalizeText(visible.normalize("NFD").replace(/\p{M}/gu, ""));
    for (const name of new Set([visible, marksAlone, bare])) out.push({ id: BLOCKER + c.id, name });
  }
  // Confusables: names of different clients whose skeletons are equal, as
  // written or lowercased, are all blockers.
  const clientOf = (id: string) => (id.startsWith(BLOCKER) ? id.slice(BLOCKER.length) : id);
  const byKey = new Map<string, Set<string>>();
  for (const c of out) {
    const n = normalizeText(c.name);
    for (const key of [confusableSkeleton(n), "\u0000" + confusableSkeleton(fold(n))]) {
      const ids = byKey.get(key) ?? new Set<string>();
      ids.add(clientOf(c.id));
      byKey.set(key, ids);
    }
  }
  const confusable = new Set<string>();
  for (const ids of byKey.values()) if (ids.size > 1) ids.forEach((id) => confusable.add(id));
  if (confusable.size === 0) return out;
  return out.map((c) => (!c.id.startsWith(BLOCKER) && confusable.has(c.id) ? { id: BLOCKER + c.id, name: c.name } : c));
}

export type Mentions =
  | { kind: "full"; ids: string[] }
  | { kind: "first"; words: string[] }
  | { kind: "ambiguous" }
  | { kind: "none" };

/** What the text names, per the rule above. Pure. Normalises the text and
 * every roster name at entry. */
export function clientMentions(text: string, roster: readonly RosterEntry[]): Mentions {
  return mentionsIn(text, prepareRoster(roster));
}

function mentionsIn(text: string, roster: readonly RosterEntry[]): Mentions {
  const s = normalizeText(text);
  const words = nameWords(s);
  // Any odd word may hide or interrupt a name: nothing resolves.
  if (words.some((w) => w.odd)) return { kind: "ambiguous" };
  // Flattened tokens with the word each belongs to.
  const toks: Array<{ t: string; w: number; first: boolean; last: boolean }> = [];
  words.forEach((w, wi) =>
    w.tokens.forEach((t, k) => toks.push({ t, w: wi, first: k === 0, last: k === w.tokens.length - 1 }))
  );
  const byForm = new Map<string, string[]>();
  for (const c of roster) {
    const f = nameForm(c.name);
    if (f.split(" ").length < 2) continue;
    const ids = byForm.get(f) ?? [];
    if (!ids.includes(c.id)) ids.push(c.id);
    byForm.set(f, ids);
  }
  const full = new Set<string>();
  const accepted: Array<[number, number]> = [];
  const blocked: Array<[number, number]> = [];
  for (const [form, ids] of byForm) {
    const ft = form.split(" ");
    for (let p = 0; p + ft.length <= toks.length; p++) {
      if (!toks[p].first || !toks[p + ft.length - 1].last) continue;
      let ok = true;
      for (let k = 0; k < ft.length; k++) if (toks[p + k].t !== ft[k]) { ok = false; break; }
      if (!ok) continue;
      const span: [number, number] = [toks[p].w, toks[p + ft.length - 1].w];
      if (runsIntoName(s, words, span[0], span[1])) {
        blocked.push(span);
        continue;
      }
      accepted.push(span);
      ids.forEach((id) => full.add(id));
    }
  }
  // A blocked match inside an accepted longer name ("Ann Lee" inside a known
  // "Ann Lee Smith") is that longer name; any other blocked match leaves the
  // text ambiguous, so nothing resolves.
  if (blocked.some(([a, b]) => !accepted.some(([c, d]) => c <= a && b <= d))) return { kind: "ambiguous" };
  if (full.size > 0) return { kind: "full", ids: [...full] };
  const rosterTokens = new Set(roster.flatMap((c) => nameForm(c.name).split(" ")).filter(Boolean));
  const firsts: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (!w.capitalised || w.tokens.length !== 1 || [...w.tokens[0]].length < 3) continue;
    if (!rosterTokens.has(w.tokens[0])) continue;
    // A name word run into a capitalised word that is not a NAME_NEIGHBOUR
    // is part of a name the roster lacks ("Jordan Miller"): ambiguous.
    if (runsIntoName(s, words, i, i)) return { kind: "ambiguous" };
    if (!firsts.includes(w.tokens[0])) firsts.push(w.tokens[0]);
  }
  return firsts.length ? { kind: "first", words: firsts } : { kind: "none" };
}

/** find_client's rule for one word (the client's name contains it, case
 * ignored), over the roster. */
export function clientsContaining(word: string, roster: readonly RosterEntry[]): string[] {
  const w = fold(normalizeText(word));
  return [...new Set(roster.filter((c) => fold(normalizeText(c.name)).includes(w)).map((c) => c.id))];
}

/** The one client a text names, or null. Pure. */
export function resolveClient(text: string, roster: readonly RosterEntry[]): string | null {
  return resolveIn(text, prepareRoster(roster));
}

/** Text with every combining mark removed (letters kept, recomposed). */
function withoutMarks(text: string): string {
  return normalizeText(normalizeText(text).normalize("NFD").replace(/\p{M}/gu, ""));
}

/** resolveClient over a roster prepareRoster has already prepared. A blocker
 * is never the answer, and a text that names one with every mark removed
 * resolves nothing. */
export function resolveIn(text: string, prepared: readonly RosterEntry[]): string | null {
  const blockers = prepared.filter((c) => c.id.startsWith(BLOCKER)).map((c) => ({ id: c.id, name: withoutMarks(c.name) }));
  if (blockers.length > 0) {
    const bare = withoutMarks(text);
    const b = mentionsIn(bare, blockers);
    if (b.kind === "full" || b.kind === "ambiguous") return null;
    if (b.kind === "first" && b.words.some((w) => clientsContaining(w, blockers).length > 0)) return null;
  }
  const m = mentionsIn(text, prepared);
  let chosen: string | null = null;
  if (m.kind === "full") {
    chosen = m.ids.length === 1 ? m.ids[0] : null;
  } else if (m.kind === "first") {
    for (const word of m.words) {
      const ids = clientsContaining(word, prepared);
      if (ids.length !== 1) return null;
      if (chosen !== null && chosen !== ids[0]) return null;
      chosen = ids[0];
    }
  }
  return chosen === null || chosen.startsWith(BLOCKER) ? null : chosen;
}

/** Every client (id, name), read by ONE call of client_roster (migration
 * 20261121b): one statement, so one consistent snapshot of the table, and a
 * single jsonb value, so no server row cap applies. Null on a failed read, a
 * malformed answer, or more than ROSTER_MAX clients: nothing resolves. */
export async function loadRoster(db: ClientDb): Promise<RosterEntry[] | null> {
  return (await readRoster(db))?.clients ?? null;
}

/** loadRoster, plus the database time the read began (the booking matcher
 * passes it to sync_booking_proposals). */
export async function readRoster(db: ClientDb): Promise<{ clients: RosterEntry[]; readAt: string } | null> {
  if (typeof db.rpc !== "function") {
    console.error("client identity: roster read failed: the client has no rpc");
    return null;
  }
  const { data, error } = await db.rpc("client_roster", { p_max: ROSTER_MAX });
  if (error) {
    console.error(`client identity: roster read failed: ${error.message ?? String(error)}`);
    return null;
  }
  const answer = data as { total?: unknown; read_at?: unknown; clients?: unknown } | null;
  if (!answer || typeof answer.total !== "number" || typeof answer.read_at !== "string") {
    console.error("client identity: roster read returned no roster; nothing resolved");
    return null;
  }
  if (!Array.isArray(answer.clients)) {
    console.error(`client identity: ${answer.total} clients is more than ${ROSTER_MAX}; nothing resolved`);
    return null;
  }
  const clients = (answer.clients as Array<{ id: unknown; name: unknown }>).map((r) => ({ id: String(r.id), name: String(r.name ?? "") }));
  if (clients.length !== answer.total) {
    console.error("client identity: roster read returned a partial roster; nothing resolved");
    return null;
  }
  return { clients, readAt: answer.read_at };
}

/** Sets `client_id` on each row whose own description names exactly one
 * client; leaves the others without the key (so the insert payload is
 * unchanged for them). Mutates `rows` in place. Never throws. */
export async function assignItemClients(
  db: ClientDb,
  rows: Array<{ description: string; client_id?: string | null }>,
): Promise<void> {
  if (rows.length === 0) return;
  try {
    const roster = await loadRoster(db);
    if (roster === null || roster.length === 0) return;
    const prepared = prepareRoster(roster);
    for (const row of rows) {
      const id = resolveIn(row.description, prepared);
      if (id !== null) row.client_id = id;
    }
  } catch (e) {
    console.error(`client identity: assignment threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const CLIENT_FK = "action_items_client_id_fkey";

/** Runs the action_items insert; when it fails ONLY because a client chosen
 * by assignItemClients was deleted before the insert (23503 on
 * action_items_client_id_fkey), clears the client_id of every row whose
 * client no longer exists and runs the insert once more. Unaffected rows and
 * still-valid ids are kept. Any other error, or a re-check that cannot run or
 * finds nothing to clear, returns the first result unchanged. */
// deno-lint-ignore no-explicit-any
export type InsertResult = { data: any; error: any };

export async function retryWithoutMissingClients(
  db: ClientDb,
  rows: Array<Record<string, unknown>>,
  insert: () => PromiseLike<InsertResult>,
): Promise<InsertResult> {
  const first = await insert();
  const err = first.error as { code?: string; message?: string; details?: string } | null;
  if (!err || err.code !== "23503" || !`${err.message ?? ""} ${err.details ?? ""}`.includes(CLIENT_FK)) {
    return first;
  }
  const ids = [...new Set(rows.map((r) => r.client_id).filter((v): v is string => typeof v === "string"))];
  if (ids.length === 0) return first;
  const { data, error } = await db.from("clients").select("id").in("id", ids);
  if (error) {
    console.error(`client identity: client re-check failed: ${error.message ?? String(error)}`);
    return first;
  }
  const alive = new Set(((data ?? []) as Array<{ id: unknown }>).map((r) => String(r.id)));
  let cleared = 0;
  for (const r of rows) {
    if (typeof r.client_id === "string" && !alive.has(r.client_id)) {
      delete r.client_id;
      cleared += 1;
    }
  }
  if (cleared === 0) return first;
  console.error(`client identity: ${cleared} client(s) deleted before the insert; retrying without them`);
  return await insert();
}
