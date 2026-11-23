// Loop-closing Task 5.1: the REAL shared capture code wired to a throwaway local
// PostgreSQL cluster. Run ONLY by fragment-gate-sql-test.sh after the
// migrations are applied, with OBRP_PG_PORT pointing at its cluster:
//   deno run --no-lock --allow-env --allow-read --allow-run=psql \
//     scripts/loop-closing/fragment-gate-integration.ts
//
// What it proves, every assertion reading persisted rows back:
//   I1 extractAndStoreActionItems (capture-pipeline.ts, the code open-brain-mcp
//      and external-crm-sync run) stores the plan's kept items with their
//      original text; the four fragment drop rows and the one pronoun_object
//      suspect row pass the real CHECK constraints and the generation trigger,
//      the suspect carrying the id the real insert returned.
//   I2 fragment_pending_proposals lists that suspect and the digest renderer
//      prints its 8-hex id under the "check wording" header.
//   I3 the real reviewProposal helper (Task 3.6, the same one the Slack forms
//      and the MCP tool call) resolves that printed id and records keep; the
//      suspect is then no longer pending. A second suspect is archived and the
//      item closes with close_reason 'fragment'.
//
// The db adapter implements exactly the supabase-js calls the code under test
// makes (select/eq, insert, insert().select(), rpc) by running SQL through psql.
// Three outcomes: exit 0 with "FRAGMENT GATE INTEGRATION PASSED"; exit 1 on a
// completed assertion ("FAIL integration: ..."); exit 2 NEVER-RAN when psql could
// not run, a statement was interrupted (the runner's SQLSTATE prefix list) or an
// error carried no readable SQLSTATE. A NeverRan is recorded when it happens, so
// a library that swallows the exception cannot turn it into a verdict.

import { extractAndStoreActionItems } from "../../supabase/functions/_shared/capture-pipeline.ts";
import { reviewProposal } from "../../supabase/functions/_shared/proposal-review.ts";
import { renderFragmentProposals, type FragmentProposalRow } from "../../supabase/functions/brain-digest/fragment-proposals.ts";

const PORT = Deno.env.get("OBRP_PG_PORT");
if (!PORT) {
  console.error("NEVER-RAN: OBRP_PG_PORT is not set (run me from fragment-gate-sql-test.sh)");
  Deno.exit(2);
}
const PREFIXES = (Deno.env.get("OBRP_INTERRUPTION_PREFIXES") ?? "08 53 54 57 58 XX 55P03").split(/\s+/).filter(Boolean);

const origLog = console.log;
const logs: string[] = [];
console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
console.error = (...a: unknown[]) => { logs.push("ERR " + a.map(String).join(" ")); };
const say = (s: string) => origLog(s);

let neverRan: string | null = null;
function recordNever(why: string): never {
  if (!neverRan) neverRan = why;
  throw new Error(`NEVER-RAN: ${why}`);
}
function fail(msg: string): never {
  if (neverRan) { say(`NEVER-RAN: ${neverRan}`); Deno.exit(2); }
  say(`FAIL integration: ${msg}`);
  for (const l of logs.slice(-20)) say(`  ${l.slice(0, 200)}`);
  Deno.exit(1);
}
const expect = (cond: boolean, msg: string) => { if (!cond) fail(msg); };

type PgError = { code: string; message: string };

async function psql(sql: string): Promise<{ out: string } | { error: PgError }> {
  let res: Deno.CommandOutput;
  try {
    res = await new Deno.Command("psql", {
      args: ["-X", "-h", "127.0.0.1", "-p", PORT!, "-U", "postgres", "-d", "obtest", "-At",
        "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-c", sql],
      stdout: "piped", stderr: "piped",
    }).output();
  } catch (e) {
    recordNever(`psql could not be run: ${e instanceof Error ? e.message : String(e)}`);
  }
  const out = new TextDecoder().decode(res.stdout);
  const err = new TextDecoder().decode(res.stderr);
  if (res.code === 0) return { out };
  const m = /ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/.exec(err);
  if (!m) recordNever(`psql exit ${res.code} with no readable SQLSTATE: ${err.split("\n")[0].slice(0, 160)}`);
  if (PREFIXES.some((p) => m[1].startsWith(p))) recordNever(`statement interrupted (SQLSTATE ${m[1]}: ${m[2].slice(0, 160)})`);
  return { error: { code: m[1], message: m[2] } };
}

async function jsonQuery(sql: string): Promise<{ data: unknown; error: PgError | null }> {
  const r = await psql(sql);
  if ("error" in r) return { data: null, error: r.error };
  const text = r.out.trim();
  try {
    return { data: JSON.parse(text), error: null };
  } catch {
    recordNever(`psql exited 0 without JSON output: ${text.slice(0, 120)}`);
  }
}

const TAG = "$obfrag$";
const lit = (v: unknown) => v === null || v === undefined ? "null" : `${TAG}${String(v)}${TAG}`;
const ident = (s: string) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) recordNever(`unsafe identifier ${s}`); return s; };

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
        return {
          eq(col: string, val: unknown) {
            const c = cols.split(",").map((x) => ident(x.trim())).join(", ");
            return jsonQuery(`select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (select ${c} from public.${ident(table)} where ${ident(col)} = ${lit(val)}) x`);
          },
        };
      },
    };
  },
  rpc(fn: string, args: Record<string, unknown>) {
    const named = Object.entries(args).map(([k, v]) => `${ident(k)} => ${lit(v)}`).join(", ");
    return jsonQuery(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.${ident(fn)}(${named}) t`);
  },
};
// insert() is lazy, as supabase-js's builder is: the plain statement runs only
// when the result is awaited, and .select() runs the RETURNING form instead, so
// one call never inserts twice.
const lazyDb = {
  from(table: string) {
    const inner = db.from(table);
    return {
      select: inner.select,
      insert(rows: Record<string, unknown> | Array<Record<string, unknown>>) {
        const list = Array.isArray(rows) ? rows : [rows];
        return {
          then(onOk: (v: { error: PgError | null }) => unknown, onErr?: (e: unknown) => unknown) {
            return jsonQuery(insertSql(table, list, null)).then((r) => ({ error: r.error })).then(onOk, onErr);
          },
          select: (cols: string) => jsonQuery(insertSql(table, list, cols)),
        };
      },
    };
  },
  rpc: db.rpc,
};

async function rows(sql: string): Promise<Array<Record<string, unknown>>> {
  const r = await jsonQuery(`select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (${sql}) x`);
  if (r.error) recordNever(`a read failed: ${r.error.code} ${r.error.message}`);
  return r.data as Array<Record<string, unknown>>;
}

try {
  const T = "e5199999-0000-4000-8000-000000000001";
  const seed = await psql(`insert into public.thoughts (id) values ('${T}') on conflict do nothing`);
  if ("error" in seed) recordNever(`thought fixture: ${seed.error.message}`);

  // I1: the real shared extraction against the real schema.
  const plan = [
    "deploy", "switch on", "then deploy", "finalize what we're",
    "Awaiting the operator to apply migration 063", "send Sam the explainer PDF",
    "send her the explainer PDF", "nudge Jordan if nothing arrives",
  ];
  await extractAndStoreActionItems(lazyDb, T, { type: "task", source: "slack", action_items: plan }, "integration note", () => false);
  if (neverRan) { say(`NEVER-RAN: ${neverRan}`); Deno.exit(2); }
  const items = await rows(`select id::text, description, status from public.action_items where source_thought_id = '${T}' order by created_at, description`);
  const kept = items.map((r) => r.description).sort();
  expect(JSON.stringify(kept) === JSON.stringify(["Awaiting the operator to apply migration 063", "nudge Jordan if nothing arrives", "send Sam the explainer PDF", "send her the explainer PDF"]),
    `I1 stored items: ${JSON.stringify(items)}`);
  say("PASS I1 the shared extraction stored the four kept items with their original text");
  const decs = await rows(`select layer, outcome, reason, candidate_description, item_id::text, thought_id::text, item_generation from public.auto_resolve_decisions where thought_id = '${T}' order by outcome, candidate_description`);
  const drops = decs.filter((d) => d.outcome === "dropped");
  expect(JSON.stringify(drops.map((d) => [d.candidate_description, d.reason]).sort()) ===
    JSON.stringify([["deploy", "one_token"], ["finalize what we're", "dangling_clause"], ["switch on", "one_token"], ["then deploy", "one_token"]]),
    `I1 drop rows: ${JSON.stringify(drops)}`);
  expect(drops.every((d) => d.layer === "fragment" && d.item_id === null && d.item_generation === null), `I1 drop row shape: ${JSON.stringify(drops)}`);
  say("PASS I1 four fragment drop rows persisted through the real CHECKs, item_id null");
  const herId = String(items.find((r) => r.description === "send her the explainer PDF")?.id);
  const sus = decs.filter((d) => d.outcome === "proposed");
  expect(sus.length === 1 && sus[0].layer === "fragment" && sus[0].reason === "pronoun_object" && sus[0].item_id === herId && sus[0].item_generation === 0,
    `I1 suspect row: ${JSON.stringify(sus)} (item ${herId})`);
  expect(decs.length === 5, `I1 exactly five decision rows for the thought: ${decs.length}`);
  say("PASS I1 one pronoun_object suspect persisted with the inserted item's id and generation 0");

  // I2: the digest's read and renderer.
  const pend = await lazyDb.rpc("fragment_pending_proposals", { p_limit: 200 });
  if (pend.error) recordNever(`fragment_pending_proposals: ${pend.error.message}`);
  const section = renderFragmentProposals(pend.data as FragmentProposalRow[]);
  const line = `- ${herId.slice(0, 8)} send her the explainer PDF`;
  expect(section === `## Check wording (reply keep <id> or archive <id>)\n\n${line}`, `I2 digest section: ${JSON.stringify(section)}`);
  say("PASS I2 the digest section lists the suspect by its 8-hex item id");

  // I3: Task 3.6's helper on the printed id.
  const keep = await reviewProposal(lazyDb, { verb: "keep", itemRef: herId.slice(0, 8), actor: "slack:U0FRAG02", source: "slack-signature" });
  expect(keep.status === "recorded", `I3 keep: ${JSON.stringify(keep)}`);
  const afterKeep = await rows(`select d.outcome, d.reviewed_by, a.status from public.auto_resolve_decisions d join public.action_items a on a.id = d.item_id where d.item_id = '${herId}'`);
  expect(afterKeep.length === 1 && afterKeep[0].outcome === "kept" && afterKeep[0].reviewed_by === "slack:U0FRAG02" && afterKeep[0].status === "open", `I3 after keep: ${JSON.stringify(afterKeep)}`);
  const pend2 = await lazyDb.rpc("fragment_pending_proposals", { p_limit: 200 });
  expect(!pend2.error && renderFragmentProposals(pend2.data as FragmentProposalRow[]) === "", `I3 still pending after keep: ${JSON.stringify(pend2)}`);
  say("PASS I3 keep through the review helper records kept, the item stays open and leaves the section");

  // A second capture with a suspect, archived this time.
  const T2 = "e5199999-0000-4000-8000-000000000002";
  const seed2 = await psql(`insert into public.thoughts (id) values ('${T2}') on conflict do nothing`);
  if ("error" in seed2) recordNever(`thought fixture 2: ${seed2.error.message}`);
  await extractAndStoreActionItems(lazyDb, T2, { type: "task", source: "slack", action_items: ["follow up with him about the koi deposit"] }, "integration note 2", () => false);
  if (neverRan) { say(`NEVER-RAN: ${neverRan}`); Deno.exit(2); }
  const himRows = await rows(`select id::text from public.action_items where source_thought_id = '${T2}'`);
  expect(himRows.length === 1, `I3 second item stored: ${JSON.stringify(himRows)}`);
  const himId = String(himRows[0].id);
  const arch = await reviewProposal(lazyDb, { verb: "archive", itemRef: himId, actor: "operator", source: "mcp-shared-key" });
  expect(arch.status === "recorded", `I3 archive: ${JSON.stringify(arch)}`);
  const afterArch = await rows(`select a.status, a.close_reason, d.outcome from public.action_items a join public.auto_resolve_decisions d on d.item_id = a.id where a.id = '${himId}'`);
  expect(afterArch.length === 1 && afterArch[0].status === "archived" && afterArch[0].close_reason === "fragment" && afterArch[0].outcome === "accepted", `I3 after archive: ${JSON.stringify(afterArch)}`);
  say("PASS I3 archive through the review helper closes the item with close_reason fragment and accepts the row");
} catch (e) {
  if (neverRan) { say(`NEVER-RAN: ${neverRan}`); Deno.exit(2); }
  say(`NEVER-RAN: the bridge threw: ${e instanceof Error ? e.message : String(e)}`);
  Deno.exit(2);
}
if (neverRan) { say(`NEVER-RAN: ${neverRan}`); Deno.exit(2); }
say("FRAGMENT GATE INTEGRATION PASSED");
Deno.exit(0);
