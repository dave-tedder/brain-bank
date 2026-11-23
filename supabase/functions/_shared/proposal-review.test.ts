import { assertEquals } from "jsr:@std/assert@1.0.19";
import { EMPTY_DECISION_REF, isIdRef, parseReviewCommand, resolveItemRef, reviewProposal } from "./proposal-review.ts";

const ITEM = "c0140001-0000-4000-8000-000000000000";
const DEC = "d0140002-0000-4000-8000-000000000000";

type Answer = { data: unknown; error: unknown };
function scriptedDb(answers: Record<string, Answer[]>) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    db: {
      rpc: (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        const list = answers[fn] ?? [];
        const n = calls.filter((c) => c.fn === fn).length;
        return Promise.resolve(list[Math.min(n - 1, list.length - 1)] ?? { data: null, error: { message: "unscripted" } });
      },
    },
  };
}
const oneItem: Answer = { data: [{ item_id: ITEM, description: "send her the explainer PDF" }], error: null };

Deno.test("parseReviewCommand accepts exactly the four Slack forms", () => {
  assertEquals(parseReviewCommand("keep c0140001"), { verb: "keep", itemRef: "c0140001", decisionRef: null });
  assertEquals(parseReviewCommand("  ARCHIVE C0140001  "), { verb: "archive", itemRef: "c0140001", decisionRef: null });
  assertEquals(parseReviewCommand(`done ${ITEM}`), { verb: "done", itemRef: ITEM, decisionRef: null });
  assertEquals(parseReviewCommand("done c0140001 d0140002"), { verb: "done", itemRef: "c0140001", decisionRef: "d0140002" });
  assertEquals(parseReviewCommand(`done c0140001 ${DEC}`), { verb: "done", itemRef: "c0140001", decisionRef: DEC });
});

Deno.test("parseReviewCommand rejects everything else, so it is captured as before", () => {
  for (
    const text of [
      "done: sent the explainer", // the free-text done: command, unchanged
      "keep c0140001 d0140002", // keep cannot carry a decision id in Slack
      "archive c0140001 d0140002",
      "keep c014000", // 7 hex
      "keep c0140001x",
      "keep c0140001 please",
      "keep",
      "keep the kitchen remodel design",
      "please keep c0140001",
      "done c0140001 d0140002 extra",
      "keep c0140001-0000", // partial uuid
    ]
  ) {
    assertEquals(parseReviewCommand(text), null, text);
  }
});

Deno.test("isIdRef: a full uuid or 8 lowercase hex, nothing else", () => {
  assertEquals(isIdRef(ITEM), true);
  assertEquals(isIdRef("c0140001"), true);
  assertEquals(isIdRef("C0140001"), false);
  assertEquals(isIdRef("c014000"), false);
  assertEquals(isIdRef("c0140001-0000"), false);
});

Deno.test("resolveItemRef: one, none, ambiguous and a malformed answer", async () => {
  assertEquals(await resolveItemRef(scriptedDb({ resolve_proposal_item: [oneItem] }).db, "c0140001"), {
    kind: "one",
    itemId: ITEM,
    description: "send her the explainer PDF",
  });
  assertEquals(await resolveItemRef(scriptedDb({ resolve_proposal_item: [{ data: [], error: null }] }).db, "c0140001"), { kind: "none" });
  const two = { data: [{ item_id: ITEM, description: "a" }, { item_id: DEC, description: "b" }], error: null };
  assertEquals(await resolveItemRef(scriptedDb({ resolve_proposal_item: [two] }).db, "c0140001"), { kind: "ambiguous" });
  assertEquals((await resolveItemRef(scriptedDb({ resolve_proposal_item: [{ data: null, error: null }] }).db, "x")).kind, "error");
});

Deno.test("keep or archive with a decision id is refused before any database call", async () => {
  for (const verb of ["keep", "archive"]) {
    const s = scriptedDb({});
    const r = await reviewProposal(s.db, { verb, itemRef: "c0140001", decisionRef: "d0140002", actor: "operator", source: "mcp-shared-key" });
    assertEquals([r.status, r.message], ["refused", "keep and archive take no decision id"]);
    assertEquals(s.calls.length, 0);
  }
});

// F1 (PR 23 review): a supplied decision ref is never normalized to "absent".
const BLANKS = ["", " ", "   ", "\t", "\n", " \t\r\n "];

Deno.test("keep or archive with an empty or whitespace decision id is refused before any database call", async () => {
  for (const verb of ["keep", "archive"]) {
    for (const blank of BLANKS) {
      const s = scriptedDb({ resolve_proposal_item: [oneItem] });
      const r = await reviewProposal(s.db, { verb, itemRef: "c0140001", decisionRef: blank, actor: "operator", source: "mcp-shared-key" });
      assertEquals([r.status, r.message], ["refused", "keep and archive take no decision id"], `${verb} ${JSON.stringify(blank)}`);
      assertEquals(s.calls.length, 0, `${verb} ${JSON.stringify(blank)} touched the database`);
    }
  }
});

Deno.test("done with an empty or whitespace decision id is malformed, never 'pick the only pending row'", async () => {
  for (const blank of BLANKS) {
    const s = scriptedDb({ resolve_proposal_item: [oneItem] });
    const r = await reviewProposal(s.db, { verb: "done", itemRef: "c0140001", decisionRef: blank, actor: "operator", source: "mcp-shared-key" });
    assertEquals([r.status, r.message], ["refused", EMPTY_DECISION_REF], JSON.stringify(blank));
    assertEquals(s.calls.length, 0, `done ${JSON.stringify(blank)} touched the database`);
  }
});

Deno.test("an absent decision id (undefined or null) still reaches the RPC as null", async () => {
  for (const decisionRef of [undefined, null]) {
    for (const verb of ["keep", "archive", "done"]) {
      const s = scriptedDb({
        resolve_proposal_item: [oneItem],
        review_proposal: [{ data: [{ status: "recorded", message: "ok", decision_id: null }], error: null }],
      });
      const r = await reviewProposal(s.db, { verb, itemRef: "c0140001", decisionRef, actor: "operator", source: "mcp-shared-key" });
      assertEquals(r.status, "recorded", `${verb} ${decisionRef}`);
      assertEquals(s.calls.map((c) => c.fn), ["resolve_proposal_item", "review_proposal"]);
      assertEquals(s.calls[1].args.p_decision_ref, null);
    }
  }
});

Deno.test("a padded valid decision id is trimmed and passed through on done", async () => {
  const s = scriptedDb({
    resolve_proposal_item: [oneItem],
    review_proposal: [{ data: [{ status: "recorded", message: "ok", decision_id: DEC }], error: null }],
  });
  await reviewProposal(s.db, { verb: "done", itemRef: "c0140001", decisionRef: "\t D0140002 \n", actor: "operator", source: "mcp-shared-key" });
  assertEquals(s.calls[1].args.p_decision_ref, "d0140002");
});

Deno.test("malformed refs and unknown verbs are refused with no database call", async () => {
  const cases = [
    { verb: "keep", itemRef: "c014000" },
    { verb: "done", itemRef: "c0140001", decisionRef: "zz" },
    { verb: "close", itemRef: "c0140001" },
  ];
  for (const c of cases) {
    const s = scriptedDb({});
    const r = await reviewProposal(s.db, { ...c, actor: "operator", source: "mcp-shared-key" });
    assertEquals(r.status, "refused", JSON.stringify(c));
    assertEquals(s.calls.length, 0);
  }
});

Deno.test("an unknown or ambiguous item answers without calling the review RPC", async () => {
  const none = scriptedDb({ resolve_proposal_item: [{ data: [], error: null }] });
  const r1 = await reviewProposal(none.db, { verb: "keep", itemRef: "ffffffff", actor: "operator", source: "mcp-shared-key" });
  assertEquals([r1.status, r1.message], ["not_found", "no proposal on record for ffffffff"]);
  assertEquals(none.calls.map((c) => c.fn), ["resolve_proposal_item"]);

  const two = scriptedDb({
    resolve_proposal_item: [{ data: [{ item_id: ITEM, description: "a" }, { item_id: DEC, description: "b" }], error: null }],
  });
  const r2 = await reviewProposal(two.db, { verb: "keep", itemRef: "c0140001", actor: "operator", source: "mcp-shared-key" });
  assertEquals([r2.status, r2.message], ["ambiguous", "ambiguous, use the full id"]);
  assertEquals(two.calls.map((c) => c.fn), ["resolve_proposal_item"]);
});

Deno.test("the decision ref goes to the RPC as raw text, resolved under the lock there", async () => {
  const s = scriptedDb({
    resolve_proposal_item: [oneItem],
    review_proposal: [{ data: [{ status: "already_recorded", message: "already recorded 2026-11-18 03:04 UTC", decision_id: DEC }], error: null }],
  });
  const r = await reviewProposal(s.db, { verb: "DONE", itemRef: "C0140001", decisionRef: "D0140002", actor: "slack:U123", source: "slack-signature" });
  assertEquals(s.calls[1], {
    fn: "review_proposal",
    args: { p_item_id: ITEM, p_verb: "done", p_actor: "slack:U123", p_actor_source: "slack-signature", p_decision_ref: "d0140002" },
  });
  assertEquals(r.status, "already_recorded");
  assertEquals(r.decisionId, DEC);
  assertEquals(r.text, 'c0140001 "send her the explainer PDF": already recorded 2026-11-18 03:04 UTC');
});

Deno.test("the reply quotes a long description shortened", async () => {
  const long = "x".repeat(200);
  const s = scriptedDb({
    resolve_proposal_item: [{ data: [{ item_id: ITEM, description: long }], error: null }],
    review_proposal: [{ data: [{ status: "recorded", message: "kept c0140001 on open (1 proposal)", decision_id: null }], error: null }],
  });
  const r = await reviewProposal(s.db, { verb: "keep", itemRef: "c0140001", actor: "operator", source: "mcp-shared-key" });
  assertEquals(r.text, `c0140001 "${"x".repeat(77)}...": kept c0140001 on open (1 proposal)`);
});

Deno.test("an RPC error or an unknown status is an error reply, never success", async () => {
  const err = scriptedDb({ resolve_proposal_item: [oneItem], review_proposal: [{ data: null, error: { code: "22023", message: "Actor mallory is neither operator nor a registered agent_code." } }] });
  const r1 = await reviewProposal(err.db, { verb: "keep", itemRef: "c0140001", actor: "mallory", source: "mcp-shared-key" });
  assertEquals(r1.status, "error");
  assertEquals(r1.message.includes("Actor mallory is neither"), true);

  const odd = scriptedDb({ resolve_proposal_item: [oneItem], review_proposal: [{ data: [{ status: "ok", message: "m" }], error: null }] });
  assertEquals((await reviewProposal(odd.db, { verb: "keep", itemRef: "c0140001", actor: "operator", source: "mcp-shared-key" })).status, "error");

  const empty = scriptedDb({ resolve_proposal_item: [oneItem], review_proposal: [{ data: [], error: null }] });
  assertEquals((await reviewProposal(empty.db, { verb: "keep", itemRef: "c0140001", actor: "operator", source: "mcp-shared-key" })).status, "error");
});

Deno.test("a deadlock victim is retried whole", async () => {
  const s = scriptedDb({
    resolve_proposal_item: [oneItem],
    review_proposal: [
      { data: null, error: { code: "40P01", message: "deadlock detected" } },
      { data: [{ status: "recorded", message: "kept c0140001 on open (1 proposal)", decision_id: null }], error: null },
    ],
  });
  const r = await reviewProposal(s.db, { verb: "keep", itemRef: "c0140001", actor: "operator", source: "mcp-shared-key" });
  assertEquals(r.status, "recorded");
  assertEquals(s.calls.filter((c) => c.fn === "review_proposal").length, 2);
});

Deno.test("the statuses this module accepts are exactly the ones the RPC returns", () => {
  const sql = Deno.readTextFileSync(new URL("../../migrations/20261109b_review_proposal_rpc.sql", import.meta.url));
  const inSql = new Set([...sql.matchAll(/return query select '([a-z_]+)'::text/g)].map((m) => m[1]));
  const ts = Deno.readTextFileSync(new URL("./proposal-review.ts", import.meta.url));
  const block = ts.slice(ts.indexOf("KNOWN_STATUSES"), ts.indexOf("]);", ts.indexOf("KNOWN_STATUSES")));
  const inTs = new Set([...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
  assertEquals([...inSql].sort(), [...inTs].sort());
});
