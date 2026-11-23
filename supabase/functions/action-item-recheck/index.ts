// Loop-closing Task 4.1: the nightly aged-item re-check (synthesis B3).
//
// POST /functions/v1/action-item-recheck             a real run (pg_cron, 04:00 UTC)
// POST /functions/v1/action-item-recheck?dry_run=1   reads and judges, writes nothing
// Optional: limit=<1..40> items.
// Auth: the x-brain-key header, as every cron-called function here.
//
// It proposes; it never resolves. For each open item older than 7 days it reads
// the thoughts captured since the item was written (or since its last scan) that
// share project, topic or person with the item's source, plus the five nearest
// by embedding, asks gpt-4o-mini whether one of them says the item is done, and
// accepts the answer only with a verbatim quote that passes the same guards the
// capture-time auto-resolve uses. Accepted evidence becomes a `recheck` /
// `proposed` decision row; The operator replies `done <id>` or `keep <id>` (Task 3.6).
// The run loop is in _recheck.ts, the prompt and the checks in _prompt.ts.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.47.10";
import { serviceKey } from "../_shared/service-key.ts";
import { callOpenRouter } from "../_shared/openrouter.ts";
import { authenticateAccessKey } from "../_shared/access-key.ts";
import { withTimeout } from "../_shared/capture-timeouts.ts";
import { ITEM_CAP, RECHECK_MODEL } from "./_prompt.ts";
import { type RecheckLlm, runRecheck } from "./_recheck.ts";

const FUNCTION_SLUG = "action-item-recheck";
const LLM_TIMEOUT_MS = 45_000;

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey());

const llm: RecheckLlm = async (messages) => {
  const { data } = await withTimeout(LLM_TIMEOUT_MS, (signal) =>
    callOpenRouter({
      function_slug: FUNCTION_SLUG,
      call_site: "recheck_page",
      model: RECHECK_MODEL,
      messages,
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 400,
      signal,
    }));
  return data.choices?.[0]?.message?.content ?? "";
};

Deno.serve(async (req: Request): Promise<Response> => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  try {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const auth = authenticateAccessKey(req.headers, { allowBearer: false });
    if (!auth.ok) return new Response("Unauthorized", { status: 401 });

    const url = new URL(req.url);
    const dry = url.searchParams.get("dry_run");
    const dryRun = dry === "1" || dry === "true";
    const limitRaw = url.searchParams.get("limit");
    let limit = ITEM_CAP;
    if (limitRaw !== null) {
      if (!/^[0-9]{1,2}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > ITEM_CAP) {
        return json({ error: `limit must be 1 to ${ITEM_CAP}` }, 400);
      }
      limit = Number(limitRaw);
    }

    const summary = await runRecheck(supabase, llm, { dryRun, limit });
    return json(summary, summary.status === "failed" ? 500 : 200);
  } catch (err) {
    console.error("action-item-recheck failed:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
