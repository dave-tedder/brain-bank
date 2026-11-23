// Loop-closing Task 5.3 (B5): booking events PROPOSE closing scheduling items.
//
// Called after a business_events row is written: by open-brain-mcp's REST
// /event (the Dash-Bot bridge and the calendar sync) and by external-crm-sync's
// upsert_event (the the CRM push). It reads everything the match depends
// on in ONE statement (booking_match_read, migration 20261121b: the event
// row, every client's id, name and the CRM key, every open item that
// carries a client, and the time that read began), so the event, its client
// and the client's items are one snapshot. Then:
//   - the event must be a tattoo_session or consultation, active (not
//     cancelled per metadata.status), with a date_start today or later, where
//     today is the UTC date of the read's own database time (no caller or
//     process clock takes part, so the date and the read-time order agree);
//   - its client must resolve, from that read's roster:
//     metadata.crm_client_id to exactly one client's the CRM key;
//     when the event carries no such id, or it matches no client, the title is
//     searched with the item rule (item-client.ts: exactly one client);
//   - candidate items are that read's open items of that client, match the
//     scheduling predicate after Task 5.1's prefix normalisation, and their
//     own date, when they carry one, is on or before date_start. Item text and
//     event title pass through item-client's normalizeText once at entry; the
//     client's name, whole or as a possessive of a run of its words however
//     they are joined ("June's", "June-Marie's", "June Marie's"), is masked by
//     span before the date is read.
// Each hit is ONE auto_resolve_decisions row, layer calendar, outcome
// proposed, reason booking_match, item_id the item, evidence_event_id the
// event, quote "<title> on <date_start>", no thought id. Every run ends in ONE
// call to sync_booking_proposals (migration 20261121b), with the event's
// snapshot (title, type, date, status, the CRM client id, as read), the
// time the one read began, and the full set of items the event supports
// right now (possibly none), each with its description as read. In one
// transaction that function refuses a sync whose read is older than the last
// one applied to this event (-2, changing nothing: the newer read stands),
// pre-locks the items in id order, withdraws the
// support of this event's pending proposals that are no longer in the set,
// skips an item that already holds a supported pending proposal for the same
// logical booking on another event row (same Google event key, or, when
// either row has none, same date and type), writes the new rows through
// record_decisions (on conflict do nothing against the lifetime unique on
// (item_id, evidence_event_id)), and records the support (snapshot and the
// item's client) of the surviving rows. A pending proposal is shown and
// accepted only while its support row matches the event's CURRENT snapshot
// and the item's client: an event changed after the last run (reassigned,
// cancelled, moved) hides its proposals until the matcher re-checks them, and
// a done reply on one is refused by the guard trigger in that migration. So a
// re-fired write never proposes twice, a REST replay that created a second
// event row for one booking does not either, and a restored item is proposed
// again only against a different booking.
//
// PROPOSALS ONLY. Nothing here resolves, archives or updates an item; The operator
// replies `done <id>` or `keep <id>` and Task 3.6's review_proposal does the
// rest. Neither auto-resolve implementation is touched. Never throws: the
// event write has already succeeded and its response must not change.

import { normalizeItemPrefix } from "./metadata-validation.ts";
import { realDateUtc } from "./archive-policy.ts";
import { type DecisionRow, toInsertPayload, validateDecisionRow } from "./decisions.ts";
import { rpcWithDeadlockRetry } from "./action-item-transition.ts";
import { type ClientDb, nameWords, normalizeText, resolveClient, ROSTER_MAX } from "./item-client.ts";

export const BOOKING_EVENT_TYPES: ReadonlySet<string> = new Set(["tattoo_session", "consultation"]);

/** The plan's scheduling predicate, applied after normalizeItemPrefix. Case
 * is ignored (items begin with a capital as often as not). */
export const SCHEDULING_PREDICATE =
  /^(schedule|book|reschedule|set up|arrange)\b.*\b(appointment|session|consult|consultation)\b/i;

export function isSchedulingItem(description: string): boolean {
  return SCHEDULING_PREDICATE.test(normalizeItemPrefix(normalizeText(description)));
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const ISO_DATE = /(?<![0-9])([0-9]{4})-([0-9]{2})-([0-9]{2})(?![0-9])/g;
// A capitalised month name, an optional day, an optional year.
const MONTH_DATE = new RegExp(
  `\\b(${MONTHS.join("|")})\\b(?:\\s+([0-9]{1,2})(?:st|nd|rd|th)?\\b)?(?:,?\\s+([0-9]{4})\\b)?`,
  "g",
);
// "May" alone is usually the verb ("May need a consult"); it is a month when a
// day or a year follows, or when one of these words comes right before it
// ("for May", "in May").
const MAY_PREPOSITION = /\b(?:for|in|to|by|until|till|before|after|during|on|from|around|late|early|mid)\s+$/i;

const isoOf = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The normalised text with each MENTION of one of `names` blanked out, so
 * a client called June Bell is not read as a month while "June 15" elsewhere
 * in the same item still is. A mention is the words that spell the whole
 * name, in order, or a possessive word all of whose tokens are tokens of the
 * name in order, together with the words right before it that only a space
 * separates and that continue that ordered part of the name ("June's",
 * "Bell's", "June-Marie's", "June Marie's", "Marie's" for June-Marie Bell;
 * "James'" with a bare trailing apostrophe): a possessive is a person. A
 * separate name word before it that does not continue the name ("early June
 * June's") stays, and a month there is still a month. A bare first
 * word ("Book June ...") is not masked; it still reads as a month (a decision
 * put to the operator). */
export function withoutNames(text: string, names: readonly string[]): string {
  let out = normalizeText(text);
  const words = nameWords(out);
  const blank = (a: number, b: number) => {
    out = out.slice(0, a) + " ".repeat(b - a) + out.slice(b);
  };
  for (const name of names) {
    const ft = nameWords(normalizeText(name)).flatMap((w) => w.tokens);
    if (ft.length === 0) continue;
    for (let i = 0; i < words.length; i++) {
      // Whole words only: the name's tokens are exactly the tokens of words i..j.
      let k = 0, j = i;
      while (j < words.length && k < ft.length) {
        const wt = words[j].tokens;
        if (wt.length === 0 || ft.slice(k, k + wt.length).join(" ") !== wt.join(" ")) break;
        k += wt.length;
        j += 1;
      }
      if (k === ft.length && j > i) blank(words[i].start, words[j - 1].fullEnd);
      const w = words[i];
      // The exact possessive span: the possessive word and the words right
      // before it (single spaces between) whose tokens, IN ORDER, spell a
      // contiguous part of the name. A word outside that part (a separate
      // "June" before "June's" when the name has one June) is not masked.
      const inName = (run: string[]) => run.length > 0 && ft.some((_, p) => run.every((t, k) => ft[p + k] === t));
      if (w.possessive && inName(w.tokens)) {
        let a = i;
        while (
          a > 0 && !words[a - 1].possessive && out.slice(words[a - 1].end, words[a].start) === " " &&
          inName(words.slice(a - 1, i + 1).flatMap((x) => x.tokens))
        ) a -= 1;
        blank(words[a].start, w.fullEnd);
      }
    }
  }
  return out;
}

/** The item's own date as YYYY-MM-DD, or null when its text carries none.
 * ISO dates and capitalised month names ("to March", "for May", "March 3",
 * "March 3, 2027") count; a month with no year is its next occurrence on or
 * after the item's creation month (day 1 when no day is given). Words of
 * `ignoreNames` (the item's client) are not dates. With several dates the
 * LATEST counts, so the event must be on or after every date the item names. */
export function itemDate(description: string, createdAt: string | Date, ignoreNames: readonly string[] = []): string | null {
  const text = withoutNames(description, ignoreNames);
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return null;
  const cy = created.getUTCFullYear();
  const cm = created.getUTCMonth() + 1;
  const cd = created.getUTCDate();
  let best: number | null = null;
  const take = (t: number | null) => {
    if (t !== null && (best === null || t > best)) best = t;
  };
  for (const m of text.matchAll(ISO_DATE)) take(realDateUtc(Number(m[1]), Number(m[2]), Number(m[3])));
  for (const m of text.matchAll(MONTH_DATE)) {
    const month = MONTHS.indexOf(m[1]) + 1;
    const day = m[2] ? Number(m[2]) : null;
    const year = m[3] ? Number(m[3]) : null;
    if (m[1] === "May" && day === null && year === null && !MAY_PREPOSITION.test(text.slice(0, m.index!))) continue;
    if (year !== null) {
      take(realDateUtc(year, month, day ?? 1));
      continue;
    }
    const sameYearLater = month > cm || (month === cm && (day === null || day >= cd));
    take(realDateUtc(sameYearLater ? cy : cy + 1, month, day ?? 1));
  }
  return best === null ? null : isoOf(best);
}

export type BookingEvent = {
  id: string;
  title: string | null;
  event_type: string | null;
  date_start: string | null;
  metadata: Record<string, unknown> | null;
};

export type BookingItem = { id: string; description: string; created_at: string; status?: string };

/** Cancelled per metadata.status, when present. */
export function isActiveEvent(event: Pick<BookingEvent, "metadata">): boolean {
  const status = event.metadata?.status;
  if (typeof status !== "string") return true;
  const s = status.trim().toLowerCase();
  return s !== "cancelled" && s !== "canceled";
}

/** Why the event cannot propose anything, or null when it can. */
export function bookingEventIneligible(event: BookingEvent, today: string): string | null {
  if (!event.event_type || !BOOKING_EVENT_TYPES.has(event.event_type)) return "event_type";
  if (!isActiveEvent(event)) return "cancelled";
  const start = String(event.date_start ?? "").slice(0, 10);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(start)) return "no_date";
  if (start < today) return "not_future";
  return null;
}

/** The quote a booking proposal carries. */
export function bookingQuote(event: BookingEvent): string {
  return `${String(event.title ?? "").trim() || "(untitled event)"} on ${String(event.date_start ?? "").slice(0, 10)}`;
}

/** The proposal rows for one eligible event and its client's open items. Pure.
 * `clientNames` are the client's name(s), never read as a date. */
export function planBookingProposals(
  event: BookingEvent,
  items: readonly BookingItem[],
  today: string,
  clientNames: readonly string[] = [],
): DecisionRow[] {
  if (bookingEventIneligible(event, today) !== null) return [];
  const start = String(event.date_start).slice(0, 10);
  const rows: DecisionRow[] = [];
  for (const item of items) {
    if (!item || typeof item.id !== "string") continue;
    if (item.status !== undefined && item.status !== "open") continue;
    if (!isSchedulingItem(item.description)) continue;
    const own = itemDate(item.description, item.created_at, clientNames);
    if (own !== null && own > start) continue;
    rows.push({
      layer: "calendar",
      outcome: "proposed",
      reason: "booking_match",
      candidate_description: String(item.description),
      item_id: item.id,
      evidence_event_id: event.id,
      quote: bookingQuote(event),
    });
  }
  return rows;
}

/** What sync_booking_proposals records and the database compares with the
 * event's current row (booking_event_snapshot in 20261121b): the fields that
 * decide eligibility and the client. jsonb equality, so key order and spacing
 * do not matter; an absent value is JSON null. */
export function bookingSnapshot(event: BookingEvent): Record<string, unknown> {
  const md = event.metadata ?? {};
  return {
    title: event.title ?? null,
    event_type: event.event_type ?? null,
    date_start: event.date_start ? String(event.date_start).slice(0, 10) : null,
    status: md.status ?? null,
    crm_client_id: md.crm_client_id ?? null,
  };
}

export type BookingDb = ClientDb & {
  // deno-lint-ignore no-explicit-any
  rpc?: (fn: string, args: Record<string, unknown>) => any;
};

/** A client as booking_match_read returns it. */
export type MatchClient = { id: string; name: string; crm_id: string | null };
/** An open item that carries a client, as booking_match_read returns it. */
export type MatchItem = BookingItem & { client_id: string };

export type EventClient =
  | { kind: "client"; id: string; names: string[] }
  | { kind: "none" };

/** The event's client (id and the name(s) it goes by) from ONE read's
 * roster: the the CRM key when it names exactly one client, else the
 * title with the item rule. Pure. */
export function resolveEventClient(event: BookingEvent, clients: readonly MatchClient[]): EventClient {
  const namesOf = (id: string) => clients.filter((c) => c.id === id).map((c) => c.name);
  const cb = event.metadata?.crm_client_id;
  if (typeof cb === "string" && cb.trim() !== "") {
    const ids = [...new Set(clients.filter((c) => c.crm_id === cb.trim()).map((c) => c.id))];
    if (ids.length === 1) return { kind: "client", id: ids[0], names: namesOf(ids[0]) };
    if (ids.length > 1) return { kind: "none" };
  }
  const id = resolveClient(String(event.title ?? ""), clients);
  return id === null ? { kind: "none" } : { kind: "client", id, names: namesOf(id) };
}

/** More open items that carry a client than this, in the whole table, and
 * no booking match proposes anything (logged). */
export const ITEM_MAX = 20000;

/** What booking_match_read answers, checked: a list is null when it is left
 * out (over its cap) or does not add up to its count. */
export type MatchInputs = {
  readAt: string;
  event: BookingEvent | null;
  clients: MatchClient[] | null;
  items: MatchItem[] | null;
};

/** The one read a match is built from (booking_match_read): the event, the
 * roster with the CRM keys, the open items that carry a client, and the
 * time the read began, from one statement. Null on a failed or malformed
 * read. */
export async function readMatchInputs(db: BookingDb, eventId: string): Promise<MatchInputs | null> {
  if (typeof db.rpc !== "function") {
    console.error("booking match: read failed: the client has no rpc");
    return null;
  }
  const { data, error } = await db.rpc("booking_match_read", { p_event_id: eventId, p_max_clients: ROSTER_MAX, p_max_items: ITEM_MAX });
  if (error) {
    console.error(`booking match: read failed: ${error.message ?? String(error)}`);
    return null;
  }
  const a = data as {
    read_at?: unknown; event?: unknown; clients_total?: unknown; clients?: unknown; items_total?: unknown; items?: unknown;
  } | null;
  if (!a || typeof a.read_at !== "string" || typeof a.clients_total !== "number" || typeof a.items_total !== "number") {
    console.error("booking match: read returned nothing readable");
    return null;
  }
  const whole = <T>(rows: unknown, total: number, what: string): T[] | null => {
    if (!Array.isArray(rows)) {
      console.error(`booking match: ${total} ${what} is more than the read returns; nothing proposed`);
      return null;
    }
    if (rows.length !== total) {
      console.error(`booking match: the read returned a partial ${what} list; nothing proposed`);
      return null;
    }
    return rows as T[];
  };
  const clients = whole<{ id: unknown; name: unknown; crm_id: unknown }>(a.clients, a.clients_total, "clients");
  return {
    readAt: a.read_at,
    event: (a.event ?? null) as BookingEvent | null,
    clients: clients === null ? null : clients.map((c) => ({
      id: String(c.id),
      name: String(c.name ?? ""),
      crm_id: typeof c.crm_id === "string" ? c.crm_id : null,
    })),
    items: whole<MatchItem>(a.items, a.items_total, "open items"),
  };
}

export type BookingMatchResult = { status: string; proposed: number };

/** What sync_booking_proposals answers when the snapshot it was given no
 * longer matches the event row (another write landed in between): it changed
 * nothing, and the match is run again from a fresh read. */
export const SYNC_STALE = -1;
/** What it answers when a sync of this event built from a LATER read has
 * already been applied: it changed nothing, and nothing is re-run (the newer
 * read stands). */
export const SYNC_SUPERSEDED = -2;

/** Re-reads the event, and syncs its booking proposals. Never throws. When
 * the database reports the read stale, runs once more from a fresh read. */
export async function proposeBookingMatches(
  db: BookingDb,
  eventId: string,
): Promise<BookingMatchResult> {
  const first = await matchOnce(db, eventId);
  return first.status === "stale_snapshot" ? await matchOnce(db, eventId) : first;
}

async function matchOnce(db: BookingDb, eventId: string): Promise<BookingMatchResult> {
  const done = (status: string, proposed = 0): BookingMatchResult => {
    console.log(`booking match: event ${eventId}: ${status}${proposed ? ` (${proposed} proposed)` : ""}`);
    return { status, proposed };
  };
  try {
    // One read: the event, its client and the client's items are one
    // snapshot, and its time is the sync's read time.
    const read = await readMatchInputs(db, eventId);
    if (read === null) return done("read_failed");
    const event = read.event;
    if (!event) return done("event_missing");
    // Today is the UTC date of the read's own time (the time can carry an
    // offset, so the instant is converted to UTC first).
    const readInstant = new Date(read.readAt);
    if (Number.isNaN(readInstant.getTime())) return done("read_failed");
    const today = readInstant.toISOString().slice(0, 10);
    // Every outcome below ends in one sync: an empty set withdraws the support
    // of any proposal this event held before the write.
    let status: string;
    let rows: Array<DecisionRow & { client_id: string; item_description: string }> = [];
    const why = bookingEventIneligible(event, today);
    if (why !== null) {
      status = `skipped_${why}`;
    } else {
      if (read.clients === null) return done("client_unreadable");
      const client = resolveEventClient(event, read.clients);
      if (client.kind === "none") {
        status = "no_client";
      } else {
        if (read.items === null) return done("items_unreadable");
        const items = read.items.filter((i) => i.client_id === client.id && i.status === "open");
        const described = new Map(items.map((i) => [i.id, String(i.description)]));
        rows = planBookingProposals(event, items, today, client.names)
          .filter((r) => {
            const problem = validateDecisionRow(r);
            if (problem) console.error(`booking match: refused a proposal row: ${problem}`);
            return problem === null;
          })
          .map((r) => ({ ...r, client_id: client.id, item_description: described.get(r.item_id!) ?? "" }));
        status = rows.length ? "proposed" : "no_match";
      }
    }
    const readAt = read.readAt;
    const { data: written, error: writeError, attempts } = await rpcWithDeadlockRetry(
      { rpc: db.rpc!.bind(db) },
      "sync_booking_proposals",
      {
        p_event_id: event.id,
        p_snapshot: bookingSnapshot(event),
        p_read_at: readAt,
        p_rows: rows.map((r) => ({ ...toInsertPayload(r), client_id: r.client_id, item_description: r.item_description })),
      },
    );
    if (writeError) {
      console.error(
        `booking match: sync_booking_proposals failed after ${attempts} attempt(s); ${rows.length} proposal row(s) not written: ${
          (writeError as { message?: string }).message ?? String(writeError)
        }`,
      );
      return done("write_failed");
    }
    if (written === SYNC_STALE) return done("stale_snapshot");
    if (written === SYNC_SUPERSEDED) return done("superseded");
    return done(status, typeof written === "number" ? written : 0);
  } catch (e) {
    console.error(`booking match: threw: ${e instanceof Error ? e.message : String(e)}`);
    return done("threw");
  }
}
