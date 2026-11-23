// Loop-closing Task 5.3: a supabase-js stand-in that runs every call as SQL
// through psql against a throwaway LOCAL cluster. Used by
// client-identity-integration.ts (the counted bridge) and
// client-identity-witness.ts (the before/after reproductions). Not deployed.
//
// It implements exactly the supabase-js calls the code under test makes:
//   from(t).select(cols)[.eq(col, v)]*[.in(col, vs)][.ilike(col, p)][.order(col, {ascending})][.limit(n)|.range(a, b)]
//   from(t).insert(rows)                 awaitable { error }
//   from(t).insert(rows).select(cols)    awaitable { data, error }
//   rpc(fn, args)                        a scalar-returning function answers the bare value, as PostgREST does
// "metadata->>key" names a jsonb text path, as supabase-js does.
//
// The verdict rule of dedup-integration.ts (Codex review 1 of PR 33, R2): the
// code under test logs and swallows database errors, so ANY statement that
// raises is recorded as NEVER-RAN before the error is handed back, and the
// caller's check() exits 2. The one exception is a refusal a check expects:
// expectError({ at, code, includes }) admits exactly ONE error whose call
// site, SQLSTATE and message text all match, consumed on use; an expectation
// still unused at the end is itself NEVER-RAN (the refusal never happened).
// Three outcomes for the callers: 0 passed, 1 a completed assertion failed,
// 2 NEVER-RAN.

export type PgError = { code: string; message: string };
type Expectation = { at: string; code: string; includes: string };

const PREFIXES = ["08", "53", "54", "57", "58", "XX", "55P03"];
const TAG = "$obci$";
// client_open_items is the previous head's item read (correction 3); the
// witness runs this adapter against that head too.
const SCALAR_RPCS = new Set(["record_decisions", "sync_booking_proposals", "client_roster", "booking_match_read", "client_open_items"]);

export function makePsqlDb(port: string, dbName: string) {
  let neverRan: string | null = null;
  const expected: Expectation[] = [];
  const reads: string[] = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let beforeInsert: Record<string, (() => Promise<void>) | undefined> = {};
  // Run once right after the next roster read completes (a select on clients,
  // or a client_roster or booking_match_read call), before the caller sees
  // its result.
  let afterRoster: (() => Promise<void>) | undefined;
  const rosterHook = async <T>(r: T): Promise<T> => {
    const h = afterRoster;
    if (h) {
      afterRoster = undefined;
      await h();
    }
    return r;
  };
  // A server-side row cap, as PostgREST's db-max-rows applies (set per
  // scenario with setRowCap; none by default).
  let cap = Number.MAX_SAFE_INTEGER;
  const rowCap = () => cap;

  function markNever(why: string): void {
    if (!neverRan) neverRan = why;
  }
  function recordNever(why: string): never {
    markNever(why);
    throw new Error(`NEVER-RAN: ${why}`);
  }

  async function psql(sql: string, at: string): Promise<{ out: string } | { error: PgError }> {
    let res: Deno.CommandOutput;
    try {
      res = await new Deno.Command("psql", {
        args: ["-X", "-h", "127.0.0.1", "-p", port, "-U", "postgres", "-d", dbName, "-At",
          "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-c", sql],
        stdout: "piped", stderr: "piped",
      }).output();
    } catch (e) {
      recordNever(`psql could not be run: ${e instanceof Error ? e.message : String(e)}`);
    }
    const out = new TextDecoder().decode(res.stdout);
    const err = new TextDecoder().decode(res.stderr);
    if (res.code === 0) return { out };
    // The OUTER diagnostic only: the first line psql prints for the error.
    const m = /^ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/m.exec(err);
    if (!m) recordNever(`psql exit ${res.code} at ${at} with no readable SQLSTATE: ${err.split("\n")[0].slice(0, 160)}`);
    if (PREFIXES.some((p) => m[1].startsWith(p))) recordNever(`statement interrupted at ${at} (SQLSTATE ${m[1]}: ${m[2].slice(0, 160)})`);
    const k = expected.findIndex((x) => x.at === at && x.code === m[1] && m[2].includes(x.includes));
    if (k >= 0) {
      expected.splice(k, 1);
      return { error: { code: m[1], message: m[2] } };
    }
    markNever(`an SQL error no check expects, at ${at} (SQLSTATE ${m[1]}: ${m[2].slice(0, 160)}); the statement did not execute, so nothing after it was judged`);
    return { error: { code: m[1], message: m[2] } };
  }

  async function jsonQuery(sql: string, at: string): Promise<{ data: unknown; error: PgError | null }> {
    const r = await psql(sql, at);
    if ("error" in r) return { data: null, error: r.error };
    const text = r.out.trim();
    try {
      return { data: JSON.parse(text), error: null };
    } catch {
      recordNever(`psql exited 0 without JSON output at ${at}: ${text.slice(0, 120)}`);
    }
  }

  const lit = (v: unknown) =>
    v === null || v === undefined ? "null"
    : typeof v === "object" ? `${TAG}${JSON.stringify(v)}${TAG}::jsonb`
    : `${TAG}${String(v)}${TAG}`;
  const ident = (s: string) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(s)) recordNever(`unsafe identifier ${s}`);
    return s;
  };
  const column = (c: string) => {
    const m = /^([a-z_]+)->>([a-z_]+)$/.exec(c.trim());
    return m ? `${ident(m[1])}->>'${ident(m[2])}'` : ident(c.trim());
  };

  function insertSql(table: string, rows: Array<Record<string, unknown>>, returning: string | null): string {
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].map(ident);
    const src = `jsonb_populate_recordset(null::public.${ident(table)}, ${TAG}${JSON.stringify(rows)}${TAG}::jsonb)`;
    const ins = `insert into public.${ident(table)} (${cols.join(", ")}) select ${cols.join(", ")} from ${src}`;
    if (!returning) return `with ins as (${ins} returning 1) select to_jsonb(count(*)) from ins`;
    const ret = returning.split(",").map((c) => ident(c.trim())).join(", ");
    return `with ins as (${ins} returning ${ret}) select coalesce(jsonb_agg(to_jsonb(ins)), '[]'::jsonb) from ins`;
  }

  const db = {
    from(table: string) {
      return {
        select(cols: string) {
          const where: string[] = [];
          let order = "";
          let tail = "";
          const chain = {
            eq(col: string, val: unknown) { where.push(`${column(col)} = ${lit(val)}`); return chain; },
            gt(col: string, val: unknown) { where.push(`${column(col)} > ${lit(val)}`); return chain; },
            in(col: string, vals: unknown[]) { where.push(vals.length ? `${column(col)} in (${vals.map(lit).join(", ")})` : "false"); return chain; },
            ilike(col: string, pattern: string) { where.push(`${column(col)} ilike ${lit(pattern)}`); return chain; },
            order(col: string, opts?: { ascending?: boolean }) {
              order = ` order by ${column(col)} ${opts?.ascending === false ? "desc nulls last" : "asc"}`;
              return chain;
            },
            limit(n: number) { tail = ` limit ${Math.min(Math.trunc(n), rowCap())}`; return chain; },
            range(a: number, b: number) { tail = ` offset ${Math.trunc(a)} limit ${Math.min(Math.trunc(b - a + 1), rowCap())}`; return chain; },
            then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) {
              reads.push(table);
              const c = cols.split(",").map((x) => ident(x.trim())).join(", ");
              const w = where.length ? ` where ${where.join(" and ")}` : "";
              return jsonQuery(`select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (select ${c} from public.${ident(table)}${w}${order}${tail}) x`, `select ${table}`)
                .then((r) => (table === "clients" ? rosterHook(r) : r))
                .then(ok, bad);
            },
          };
          return chain;
        },
        insert(rows: Record<string, unknown> | Array<Record<string, unknown>>) {
          const list = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ ...r }));
          const hook = async () => {
            const h = beforeInsert[table];
            if (h) {
              beforeInsert[table] = undefined;
              await h();
            }
          };
          return {
            then(onOk: (v: { error: PgError | null }) => unknown, onErr?: (e: unknown) => unknown) {
              return hook().then(() => jsonQuery(insertSql(table, list, null), `insert ${table}`))
                .then((r) => ({ error: r.error })).then(onOk, onErr);
            },
            select: (cols: string) => hook().then(() => jsonQuery(insertSql(table, list, cols), `insert ${table} returning ${cols}`)),
          };
        },
      };
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      const named = Object.entries(args).map(([k, v]) => `${ident(k)} => ${lit(v)}`).join(", ");
      if (SCALAR_RPCS.has(fn)) {
        return jsonQuery(`select to_jsonb(public.${ident(fn)}(${named}))`, `rpc ${fn}`)
          .then((r) => (fn === "client_roster" || fn === "booking_match_read" ? rosterHook(r) : r));
      }
      return jsonQuery(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.${ident(fn)}(${named}) t`, `rpc ${fn}`);
    },
  };

  return {
    db,
    reads,
    rpcCalls,
    psql,
    /** Admit exactly one error at this call site with this SQLSTATE and text. */
    expectError(at: string, code: string, includes: string) {
      expected.push({ at, code, includes });
    },
    /** Run `fn` once, just before the next insert into `table`. */
    beforeNextInsert(table: string, fn: () => Promise<void>) {
      beforeInsert[table] = fn;
    },
    async rows(sql: string): Promise<Array<Record<string, unknown>>> {
      const r = await jsonQuery(`select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (${sql}) x`, "a read-back");
      if (r.error) recordNever(`a read failed: ${r.error.code} ${r.error.message}`);
      return r.data as Array<Record<string, unknown>>;
    },
    async exec(sql: string, at: string): Promise<void> {
      const r = await psql(sql, at);
      if ("error" in r) recordNever(`fixture ${at}: ${r.error.code} ${r.error.message}`);
    },
    /** The first reason the run cannot be judged, or null. Unused
     * expectations count: an expected refusal that never happened. */
    neverRan(): string | null {
      if (!neverRan && expected.length) return `an expected refusal never happened: ${JSON.stringify(expected[0])}`;
      return neverRan;
    },
    /** Cap every limited read at n rows (Infinity for none). */
    setRowCap(n: number) {
      cap = Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
    },
    /** Run `fn` once, right after the next roster read completes. */
    afterNextRosterRead(fn: () => Promise<void>) {
      afterRoster = fn;
    },
    resetHooks() {
      beforeInsert = {};
      afterRoster = undefined;
    },
  };
}
