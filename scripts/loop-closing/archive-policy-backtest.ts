// Loop-closing Task 3.2, Step 3: backtest archive-policy.ts against the queue
// as it stood before the 2026-11-03 Chief of Staff sweep, labelled by what
// happened to each item afterwards. Read-only; reads a snapshot directory
// written by a PostgREST export (items.json, thoughts.json, clients.json,
// cards.json, decisions.json). The snapshot holds private data: keep it out
// of the repo.
//
//   deno run --allow-read scripts/loop-closing/archive-policy-backtest.ts <snapshot-dir> [--json]
//
// Labels (the sweep's judgment, not independent truth, as the audit said):
//   junk      archived by the sweep, or archived later with a fragment/duplicate reason
//   done      resolved at or after the cutoff (the sweep's "verified done" or any later close)
//   real      still open or deferred now: the sweep kept it
//   other     closed after the cutoff some other way (wont_do, expired, unknown)
// Limits: card links and client rows are today's, not the cutoff's; no item
// in the pre-sweep set had been reopened, since reopened_at did not exist.

import {
  archiveDueAt,
  type ArchivePolicyItem,
  isClientShaped,
  sourceIsWorkReport,
} from "../../supabase/functions/_shared/archive-policy.ts";

const CUTOFF = new Date("2026-11-02T00:00:00Z");
const SWEEP_PREFIX = "Chief of Staff sweep 2026-11-03";

type Row = ArchivePolicyItem & {
  source_thought_id: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  closed_at: string | null;
  close_reason: string | null;
  deferred_at: string | null;
};

const dir = Deno.args[0];
if (!dir) {
  console.error("usage: archive-policy-backtest.ts <snapshot-dir> [--json]");
  Deno.exit(2);
}
const load = (f: string) => JSON.parse(Deno.readTextFileSync(`${dir}/${f}`));
const items: Row[] = load("items.json");
const thoughts = new Map<string, { content: string; created_at: string }>(
  load("thoughts.json").map((t: { id: string; content: string; created_at: string }) => [t.id, t]),
);
const clientNames: string[] = load("clients.json").map((c: { name: string }) => c.name);
const openCards = new Set<string>(
  load("cards.json")
    .filter((c: { status: string; archived_at: string | null }) => !c.archived_at && c.status !== "Agent Done")
    .map((c: { linked_action_item_id: string }) => c.linked_action_item_id),
);

function closedAt(r: Row): number | null {
  const t = r.closed_at ?? r.resolved_at;
  return t ? Date.parse(t) : null;
}

// The queue at the cutoff: created before it and not yet closed or deferred at it.
const preSweep = items.filter((r) => {
  if (Date.parse(r.created_at) >= CUTOFF.getTime()) return false;
  if ((r.resolution_note ?? "").startsWith(SWEEP_PREFIX)) return true;
  if (r.status === "open") return true;
  if (r.status === "deferred") return !r.deferred_at || Date.parse(r.deferred_at) >= CUTOFF.getTime();
  const c = closedAt(r);
  return c !== null && c >= CUTOFF.getTime();
});

function label(r: Row): "junk" | "done" | "real" | "other" {
  if (r.status === "open" || r.status === "deferred") return "real";
  if (r.status === "resolved") return "done";
  if ((r.resolution_note ?? "").startsWith(SWEEP_PREFIX)) return "junk";
  if (r.close_reason === "fragment" || r.close_reason === "duplicate") return "junk";
  return "other";
}

type Out = { id: string; label: string; reason: string; age: number; description: string };
const proposed: Out[] = [];
const byBand: Record<string, Record<string, number>> = {};
let exemptClient = 0, exemptCard = 0, exemptCanary = 0;
for (const r of preSweep) {
  // Evaluate as the item stood at the cutoff: open, never proposed or reopened.
  const asOf: ArchivePolicyItem = {
    ...r,
    status: "open",
    reopened_at: null,
    archive_proposed_at: null,
    archive_review_outcome: null,
    archive_reviewed_at: null,
  };
  const src = r.source_thought_id ? thoughts.get(r.source_thought_id) : undefined;
  const ctx = {
    sourceIsWorkReport: sourceIsWorkReport(src?.content, src?.created_at),
    fragmentFlagged: false,
    linkedToOpenCard: openCards.has(r.id),
    clientNames,
  };
  const age = Math.floor((CUTOFF.getTime() - Date.parse(r.created_at)) / 86_400_000);
  const band = age >= 60 ? "60+" : age >= 30 ? "30-59" : "<30";
  const l = label(r);
  byBand[band] ??= { junk: 0, done: 0, real: 0, other: 0 };
  byBand[band][l] += 1;
  const due = archiveDueAt(asOf, ctx, CUTOFF);
  if (!due) {
    if (ctx.linkedToOpenCard) exemptCard += 1;
    else if (isClientShaped(r.description, clientNames)) exemptClient += 1;
    else exemptCanary += 1;
    continue;
  }
  if (due.dueAt.getTime() <= CUTOFF.getTime()) {
    proposed.push({ id: r.id, label: l, reason: due.reason, age, description: r.description });
  }
}

const count = (xs: Out[], l: string) => xs.filter((x) => x.label === l).length;
const summary = {
  cutoff: CUTOFF.toISOString(),
  pre_sweep_queue: preSweep.length,
  by_age_band: byBand,
  exempt: { card: exemptCard, client_shaped: exemptClient, canary_or_other: exemptCanary },
  proposed: proposed.length,
  proposed_by_label: {
    junk: count(proposed, "junk"),
    done: count(proposed, "done"),
    real: count(proposed, "real"),
    other: count(proposed, "other"),
  },
  proposed_by_reason: {
    age_work_report: proposed.filter((p) => p.reason === "age_work_report").length,
    age_standard: proposed.filter((p) => p.reason === "age_standard").length,
    deadline_passed: proposed.filter((p) => p.reason === "deadline_passed").length,
  },
  closed_share_of_proposed: proposed.length
    ? Math.round(1000 * (proposed.length - count(proposed, "real")) / proposed.length) / 10
    : null,
  real_proposed: proposed.filter((p) => p.label === "real")
    .map((p) => ({ id: p.id, age: p.age, reason: p.reason, description: p.description })),
};
console.log(JSON.stringify(summary, null, 2));
