// Loop-closing Task 5.3: an in-memory stand-in for the supabase-js calls the
// client-identity code paths make, used by item-client.test.ts and
// booking-match.test.ts. Not a test file and not deployed (nothing under
// supabase/functions imports it).
//
// Tables are arrays of plain rows. Supported chains, evaluated when awaited:
//   from(t).select(cols)[.eq(col, v)]*[.gt(col, v)][.in(col, vs)][.ilike(col, pattern)][.order(col)][.limit(n)|.range(a, b)]
//     (rowCap, when set, caps every read below what it asked for)
//     eq on "metadata->>key" reads row.metadata[key] as text, as PostgREST does;
//     ilike follows SQL: % any run, _ one character, backslash escapes, case
//     ignored; limit caps the rows; order is accepted and ignored except on
//     clients.last_contact (newest first, as find_client asks).
//   from(t).insert(row | rows)            awaitable { error }
//   from(t).insert(rows).select(cols)     awaitable { data: rows with ids, error }
//   from(t).insert(rows).select(cols).single()  the first row
//   from(t).update(patch).eq(col, v)*     applied; recorded in `writes`; on
//     action_items refused (a booking match must never update an item)
//   rpc("record_decisions", { p_rows })   pre-sorts by item_id and inserts with
//     ON CONFLICT DO NOTHING against the calendar lifetime unique
//     (item_id, evidence_event_id) and the recheck one; returns the count
//   rpc("client_roster", { p_max })        the whole clients table in one answer
//     (one jsonb value, so rowCap does not apply), with a read time from a
//     clock that advances on every read; recorded in `reads` as a clients read
//     (filter "rpc client_roster"), not in rpcCalls; failNext key "clients"
//   rpc("booking_match_read", { p_event_id, p_max_clients, p_max_items })
//     the event row, every client with its the CRM key, and every open
//     item that carries a client, in one answer with one read time; recorded
//     in `reads` as table "booking_match_read"; failNext keys
//     "rpc/booking_match_read", then "business_events", "clients",
//     "action_items" (any part failing fails the whole read)
//   rpc("sync_booking_proposals", ...)    an independent re-statement of
//     20261121b's function (the snapshot check, the read-time order, support
//     rows bound to the exact item and event, the same-booking skip,
//     record_decisions)
//   rpc("dedup_semantic_candidates")      open items, oldest first, with project
//   rpc(<other>)                          recorded; answers { data: null }
// `failNext` makes the next matching call answer an error (table, "insert:<table>"
// for inserts only, or "rpc/<name>").

export type Row = Record<string, unknown>;

export class FakeDb {
  tables: Record<string, Row[]> = { clients: [], business_events: [], action_items: [], auto_resolve_decisions: [], thoughts: [], calendar_proposal_support: [], calendar_event_sync: [] };
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  writes: Array<{ table: string; op: string; payload: unknown }> = [];
  reads: Array<{ table: string; filters: string[] }> = [];
  failNext: Record<string, { code?: string; message: string }[]> = {};
  /** A server-side row cap, as PostgREST's db-max-rows applies: no read
   * returns more rows than this, whatever it asked for. */
  rowCap = Infinity;
  private seq = 0;
  /** The database clock read times come from: one second per read, from
   * clockBase (2026-11-20 12:00 UTC unless a test moves it). */
  private tick = 0;
  clockBase = Date.UTC(2026, 10, 20, 12, 0, 0);
  readTime(): string {
    this.tick += 1;
    return new Date(this.clockBase + this.tick * 1000).toISOString();
  }

  constructor(init: Partial<Record<string, Row[]>> = {}) {
    for (const [k, v] of Object.entries(init)) this.tables[k] = (v ?? []).map((r) => ({ ...r }));
  }

  newId(prefix = "f"): string {
    this.seq += 1;
    return `${prefix.padEnd(8, "0").slice(0, 8)}-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
  }

  private takeFailure(key: string): { code?: string; message: string } | null {
    const q = this.failNext[key];
    return q && q.length ? q.shift()! : null;
  }

  from(table: string) {
    // deno-lint-ignore no-this-alias
    const db = this;
    return {
      select(cols: string) {
        const filters: Array<(r: Row) => boolean> = [];
        const labels: string[] = [];
        let cap = Infinity;
        let skip = 0;
        let newestContact = false;
        let orderCol: string | null = null;
        let orderAsc = true;
        const chain = {
          eq(col: string, v: unknown) {
            labels.push(`eq ${col}`);
            filters.push((r) => readCol(r, col) === (v === null ? null : String(v)));
            return chain;
          },
          gt(col: string, v: unknown) {
            labels.push(`gt ${col}`);
            filters.push((r) => String(readCol(r, col) ?? "") > String(v));
            return chain;
          },
          in(col: string, values: unknown[]) {
            labels.push(`in ${col}`);
            const set = new Set(values.map((v) => String(v)));
            filters.push((r) => set.has(String(readCol(r, col))));
            return chain;
          },
          ilike(col: string, pattern: string) {
            labels.push(`ilike ${col}`);
            const re = likeToRegExp(pattern);
            filters.push((r) => re.test(String(readCol(r, col) ?? "")));
            return chain;
          },
          order(col: string, opts?: { ascending?: boolean }) {
            if (table === "clients" && col === "last_contact") newestContact = true;
            else {
              orderCol = col;
              orderAsc = opts?.ascending !== false;
            }
            return chain;
          },
          limit(n: number) {
            cap = n;
            return chain;
          },
          range(from: number, to: number) {
            labels.push(`range ${from}-${to}`);
            skip = from;
            cap = to - from + 1;
            return chain;
          },
          then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) {
            db.reads.push({ table, filters: labels });
            const failure = db.takeFailure(table);
            if (failure) return Promise.resolve({ data: null, error: failure }).then(ok, bad);
            let rows = db.tables[table].filter((r) => filters.every((f) => f(r)));
            if (newestContact) {
              rows = [...rows].sort((a, b) => String(b.last_contact ?? "").localeCompare(String(a.last_contact ?? "")));
            }
            if (orderCol !== null) {
              const c = orderCol;
              rows = [...rows].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0) * (orderAsc ? 1 : -1));
            }
            const names = cols.split(",").map((c) => c.trim()).filter(Boolean);
            const data = rows.slice(skip, skip + Math.min(cap, db.rowCap)).map((r) => Object.fromEntries(names.map((n) => [n, r[n] ?? null])));
            return Promise.resolve({ data, error: null }).then(ok, bad);
          },
        };
        return chain;
      },
      insert(payload: Row | Row[]) {
        const list = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ ...r }));
        db.writes.push({ table, op: "insert", payload: structuredClone(payload) });
        const apply = () => {
          const failure = db.takeFailure(`insert:${table}`) ?? db.takeFailure(table);
          if (failure) return { rows: null, error: failure };
          const stored: Row[] = list.map((r) => ({ id: r.id ?? db.newId(table.slice(0, 1)), created_at: r.created_at ?? new Date().toISOString(), ...r }));
          db.tables[table].push(...stored);
          return { rows: stored, error: null };
        };
        let done: { rows: Row[] | null; error: unknown } | null = null;
        const run = () => (done ??= apply());
        return {
          select(cols: string) {
            const r = run();
            const names = cols.split(",").map((c) => c.trim());
            const data = r.rows ? r.rows.map((x) => Object.fromEntries(names.map((n) => [n, x[n] ?? null]))) : null;
            return {
              single: () => Promise.resolve({ data: data ? data[0] ?? null : null, error: r.error }),
              then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
                Promise.resolve({ data, error: r.error }).then(ok, bad),
            };
          },
          then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) {
            return Promise.resolve({ error: run().error }).then(ok, bad);
          },
        };
      },
      update(payload: Row) {
        db.writes.push({ table, op: "update", payload: structuredClone(payload) });
        // An action item is never updated by the code these fakes serve.
        if (table === "action_items") {
          const res = { error: { message: "fake: action_items update refused" } };
          const refused: Record<string, unknown> = {
            eq: () => refused,
            select: () => Promise.resolve({ data: null, ...res }),
            then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(res).then(ok, bad),
          };
          return refused;
        }
        const filters: Array<(r: Row) => boolean> = [];
        const chain: Record<string, unknown> = {
          eq: (col: string, v: unknown) => {
            filters.push((r) => readCol(r, col) === String(v));
            return chain;
          },
          then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
            const failure = db.takeFailure(table);
            if (!failure) {
              for (const r of db.tables[table]) if (filters.every((f) => f(r))) Object.assign(r, structuredClone(payload));
            }
            return Promise.resolve({ error: failure }).then(ok, bad);
          },
        };
        return chain;
      },
    };
  }

  /** record_decisions: sorted by item, ON CONFLICT DO NOTHING against the
   * calendar and recheck lifetime uniques; returns the inserted count. */
  insertDecisions(p_rows: Row[]): number {
    const rows = [...p_rows].sort((a, b) => String(a.item_id ?? "").localeCompare(String(b.item_id ?? "")));
    let inserted = 0;
    for (const r of rows) {
      const clash = this.tables.auto_resolve_decisions.some((d) =>
        (r.layer === "calendar" && d.layer === "calendar" && r.evidence_event_id != null &&
          d.item_id === r.item_id && d.evidence_event_id === r.evidence_event_id) ||
        (r.layer === "recheck" && d.layer === "recheck" && r.evidence_thought_id != null &&
          d.item_id === r.item_id && d.evidence_thought_id === r.evidence_thought_id)
      );
      if (clash) continue;
      this.tables.auto_resolve_decisions.push({ id: this.newId("d"), created_at: new Date().toISOString(), ...r });
      inserted += 1;
    }
    return inserted;
  }

  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> {
    if (fn === "client_roster") {
      // One statement, one jsonb value: no row cap; a read, not an rpcCall.
      this.reads.push({ table: "clients", filters: [`rpc ${fn}`] });
      const failure = this.takeFailure("clients") ?? this.takeFailure(`rpc/${fn}`);
      if (failure) return Promise.resolve({ data: null, error: failure });
      const max = Number(args.p_max);
      const all = [...this.tables.clients].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
      return Promise.resolve({
        data: { read_at: this.readTime(), total: all.length, clients: all.length <= max ? all.map((c) => ({ id: c.id, name: c.name })) : null },
        error: null,
      });
    }
    if (fn === "booking_match_read") {
      this.reads.push({ table: "booking_match_read", filters: [`rpc ${fn}`] });
      const failure = this.takeFailure(`rpc/${fn}`) ?? this.takeFailure("business_events") ?? this.takeFailure("clients") ??
        this.takeFailure("action_items");
      if (failure) return Promise.resolve({ data: null, error: failure });
      const byId = (a: Row, b: Row) => (String(a.id) < String(b.id) ? -1 : 1);
      const ev = this.tables.business_events.find((e) => e.id === args.p_event_id);
      const clients = [...this.tables.clients].sort(byId);
      const items = this.tables.action_items.filter((a) => a.client_id != null && a.status === "open").sort(byId);
      return Promise.resolve({
        data: structuredClone({
          read_at: this.readTime(),
          event: ev ? { id: ev.id, title: ev.title ?? null, event_type: ev.event_type ?? null, date_start: ev.date_start ?? null, metadata: ev.metadata ?? null } : null,
          clients_total: clients.length,
          clients: clients.length <= Number(args.p_max_clients)
            ? clients.map((c) => ({ id: c.id, name: c.name, crm_id: ((c.metadata ?? {}) as Row).crm_id ?? null }))
            : null,
          items_total: items.length,
          items: items.length <= Number(args.p_max_items)
            ? items.map((a) => ({ id: a.id, client_id: a.client_id, description: a.description, created_at: a.created_at, status: a.status }))
            : null,
        }),
        error: null,
      });
    }
    this.rpcCalls.push({ fn, args: structuredClone(args) });
    const failure = this.takeFailure(`rpc/${fn}`);
    if (failure) return Promise.resolve({ data: null, error: failure });
    if (fn === "sync_booking_proposals") {
      // An independent re-statement of 20261121b's sync_booking_proposals,
      // for unit tests only; the SQL itself is proven by
      // client-identity-sql-test.sh.
      const given = args.p_rows as Row[];
      if (given.some((r) => typeof r.client_id !== "string" || typeof r.item_description !== "string")) {
        return Promise.resolve({ data: null, error: { code: "22023", message: "every row needs client_id and item_description" } });
      }
      const readAt = (args.p_read_at ?? null) as string | null;
      if (readAt === null && given.length > 0) {
        return Promise.resolve({ data: null, error: { code: "22023", message: "rows need the time their reads began" } });
      }
      const ev = this.tables.business_events.find((e) => e.id === args.p_event_id);
      if (!ev) return Promise.resolve({ data: null, error: { code: "22023", message: "event not found" } });
      // A snapshot that no longer matches the event row changes nothing.
      if (!sameJson(args.p_snapshot, fakeSnapshot(ev))) return Promise.resolve({ data: -1, error: null });
      // Reads older than the last applied sync of this event change nothing.
      if (readAt !== null) {
        const mark = this.tables.calendar_event_sync.find((m) => m.event_id === ev.id);
        if (mark && Date.parse(String(mark.read_at)) > Date.parse(readAt)) return Promise.resolve({ data: -2, error: null });
        if (mark) mark.read_at = readAt;
        else this.tables.calendar_event_sync.push({ event_id: ev.id, read_at: readAt });
      }
      const decisions = this.tables.auto_resolve_decisions;
      const support = this.tables.calendar_proposal_support;
      const eventOf = (d: Row) => this.tables.business_events.find((e) => e.id === d.evidence_event_id);
      const itemOf = (d: Row) => this.tables.action_items.find((a) => a.id === d.item_id);
      const supported = (d: Row) => {
        const s = support.find((x) => x.decision_id === d.id);
        const e = eventOf(d), a = itemOf(d);
        return !!s && !!e && !!a && s.item_id === d.item_id && s.event_id === d.evidence_event_id &&
          s.client_id === a.client_id && s.item_description === a.description && sameJson(s.event_snapshot, fakeSnapshot(e));
      };
      const rows = [...(args.p_rows as Row[])].sort((a, b) => String(a.item_id).localeCompare(String(b.item_id)));
      const fresh = rows.filter((r) =>
        !decisions.some((d) =>
          d.item_id === r.item_id && d.layer === "calendar" && d.outcome === "proposed" && d.evidence_event_id !== ev.id &&
          fakeSameBooking(eventOf(d), ev) && supported(d)
        )
      );
      const keep = new Set(fresh.map((r) => r.item_id));
      this.tables.calendar_proposal_support = support.filter((x) => {
        const d = decisions.find((y) => y.id === x.decision_id);
        return !(d && d.layer === "calendar" && d.evidence_event_id === ev.id && !keep.has(d.item_id));
      });
      const inserted = this.insertDecisions(fresh.map(({ client_id: _c, item_description: _t, ...r }) => r));
      for (const r of fresh) {
        const d = decisions.find((y) => y.item_id === r.item_id && y.evidence_event_id === ev.id && y.layer === "calendar" && y.outcome === "proposed");
        if (!d) continue;
        this.tables.calendar_proposal_support = this.tables.calendar_proposal_support.filter((x) => x.decision_id !== d.id);
        this.tables.calendar_proposal_support.push({
          decision_id: d.id, item_id: d.item_id, event_id: d.evidence_event_id, client_id: r.client_id,
          item_description: r.item_description, event_snapshot: structuredClone(args.p_snapshot),
        });
      }
      return Promise.resolve({ data: inserted, error: null });
    }
    if (fn === "record_decisions") {
      return Promise.resolve({ data: this.insertDecisions(args.p_rows as Row[]), error: null });
    }
    if (fn === "dedup_semantic_candidates") {
      const data = this.tables.action_items.filter((a) => a.status === "open").map((a) => ({
        id: a.id, description: a.description, created_at: a.created_at, source_thought_id: a.source_thought_id ?? null, project: null,
      }));
      return Promise.resolve({ data, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  }
}

function readCol(r: Row, col: string): string | null {
  const m = /^metadata->>(.+)$/.exec(col);
  const v = m ? (r.metadata as Row | null | undefined)?.[m[1]] : r[col];
  return v === undefined || v === null ? null : String(v);
}

export function likeToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      out += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (c === "%") out += "[\\s\\S]*";
    else if (c === "_") out += "[\\s\\S]";
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

function fakeSnapshot(e: Row): Row {
  const md = (e.metadata ?? {}) as Row;
  return {
    title: e.title ?? null,
    event_type: e.event_type ?? null,
    date_start: e.date_start ? String(e.date_start).slice(0, 10) : null,
    status: md.status ?? null,
    crm_client_id: md.crm_client_id ?? null,
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as Row).sort().map((k) => [k, canon((v as Row)[k])]))
      : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

function fakeGcalKey(e: Row): string | null {
  const raw = (e.metadata as Row | null | undefined)?.gcal_event_id;
  const k = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!k) return null;
  return k.endsWith("@google.com") ? (k.slice(0, -11) || null) : k;
}

function fakeSameBooking(a: Row | undefined, b: Row): boolean {
  if (!a) return false;
  const ka = fakeGcalKey(a), kb = fakeGcalKey(b);
  if (ka !== null && kb !== null) return ka === kb;
  return String(a.date_start ?? "") === String(b.date_start ?? "") && a.event_type === b.event_type;
}
