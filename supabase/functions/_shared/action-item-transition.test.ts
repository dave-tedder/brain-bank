import { assertEquals } from "jsr:@std/assert@1.0.19";
import {
  ACTION_ITEM_CLOSE_REASONS,
  restoreByDeferReason,
  rpcWithDeadlockRetry,
  transitionActionItem,
  transitionRpcArgs,
} from "./action-item-transition.ts";

const DEADLOCK = { code: "40P01", message: "deadlock detected" };

function scriptedDb(answers: Array<{ data: unknown; error: unknown }>) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    db: {
      rpc: (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return Promise.resolve(answers[Math.min(calls.length - 1, answers.length - 1)]);
      },
    },
  };
}

const CLOSE = {
  itemId: "a",
  from: ["open" as const],
  to: "resolved" as const,
  actor: "auto-resolve",
  closeReason: "done" as const,
};

Deno.test("close reasons are exactly the migration's CHECK list", () => {
  const migration = Deno.readTextFileSync(
    new URL("../../migrations/20261106_action_items_close_reason.sql", import.meta.url),
  );
  const match = migration.match(/close_reason in \(([^)]*)\)/);
  const inSql = [...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assertEquals(inSql.length, 6);
  assertEquals([...ACTION_ITEM_CLOSE_REASONS].sort(), inSql.sort());
});

Deno.test("transition args name every RPC parameter, nulling what was not given", () => {
  const args = transitionRpcArgs(CLOSE);
  assertEquals(Object.keys(args).sort(), [
    "p_actor", "p_close_reason", "p_defer_reason", "p_duplicate_of", "p_event_payload",
    "p_evidence_thought_id", "p_from_statuses", "p_item_id", "p_resolution_note",
    "p_resolved_by_thought_id", "p_to_status",
  ]);
  assertEquals(args.p_duplicate_of, null);
  assertEquals(args.p_close_reason, "done");
});

Deno.test("the wrapper's parameter names are the ones the migration declares", () => {
  const migration = Deno.readTextFileSync(
    new URL("../../migrations/20261106_action_items_close_reason.sql", import.meta.url),
  );
  const body = migration.slice(
    migration.indexOf("function public.transition_action_item("),
    migration.indexOf("returns integer"),
  );
  for (const name of Object.keys(transitionRpcArgs(CLOSE))) {
    assertEquals(body.includes(`${name} `), true, `${name} missing from the SQL signature`);
  }
});

Deno.test("affected count comes back; zero is a clean refusal", async () => {
  const one = scriptedDb([{ data: 1, error: null }]);
  assertEquals(await transitionActionItem(one.db, CLOSE), { ok: true, affected: 1 });
  const zero = scriptedDb([{ data: 0, error: null }]);
  assertEquals(await transitionActionItem(zero.db, CLOSE), { ok: true, affected: 0 });
});

Deno.test("an error or a non-numeric answer is never read as zero rows", async () => {
  const failed = scriptedDb([{ data: null, error: { code: "22023", message: "bad" } }]);
  assertEquals(await transitionActionItem(failed.db, CLOSE), { ok: false, error: "bad" });
  assertEquals(failed.calls.length, 1, "a non-deadlock error is not retried");
  const odd = scriptedDb([{ data: null, error: null }]);
  assertEquals((await transitionActionItem(odd.db, CLOSE)).ok, false);
});

Deno.test("a deadlock victim retries the whole call and completes on the second attempt", async () => {
  const { db, calls } = scriptedDb([
    { data: null, error: DEADLOCK },
    { data: 3, error: null },
  ]);
  assertEquals(await restoreByDeferReason(db, "tag", "operator"), { ok: true, affected: 3 });
  assertEquals(calls.length, 2);
});

Deno.test("deadlock retries stop at three attempts and return the error", async () => {
  const { db, calls } = scriptedDb([{ data: null, error: DEADLOCK }]);
  const result = await rpcWithDeadlockRetry(db, "record_decisions", {});
  assertEquals(calls.length, 3);
  assertEquals(result.attempts, 3);
  assertEquals(result.error, DEADLOCK);
});
