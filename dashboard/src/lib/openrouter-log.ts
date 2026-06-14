import { supabase } from "@/lib/supabase";

// Dashboard-side mirror of supabase/functions/_shared/openrouter.ts.
//
// The Edge Function wrapper lives in Deno and can't be imported from Next.js,
// so the dashboard reproduces just the cost-calc + insert shape. Both sides
// write the same row layout into public.openrouter_calls so the audit table
// answers cost questions across all surfaces.
//
// Driven by recommendation #1 of
// docs/audits/2026-05-14-openrouter-budget-investigation.md.

// Pricing per 1M tokens. Keep in sync with MODEL_PRICING in the Edge wrapper.
const MODEL_PRICING: Record<string, { in: number; out: number }> = {
  "openai/text-embedding-3-small": { in: 0.02, out: 0 },
  "openai/gpt-4o-mini": { in: 0.15, out: 0.6 },
  "openai/gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "anthropic/claude-sonnet-4.6": { in: 3.0, out: 15.0 },
};

export function computeCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const p = MODEL_PRICING[model];
  if (!p) return null;
  return (promptTokens * p.in + completionTokens * p.out) / 1_000_000;
}

export type LogStatus =
  | "ok"
  | "error_4xx"
  | "error_5xx"
  | "budget_exceeded"
  | "timeout";

export interface LogOpenRouterCallRow {
  function_slug: "dashboard-chat" | "dashboard-search";
  call_site: string;
  model: string;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cost_usd?: number | null;
  latency_ms: number;
  status: LogStatus;
  error_message?: string | null;
}

// Fire-and-forget. Returns the insert promise so the caller can `void` it
// (or await on a server function that's already finishing). The dashboard is
// server-side, so there's no Edge Runtime waitUntil — but since the caller's
// function is already in a Node/Railway handler, we just return the promise
// and let the runtime keep the handler alive while it flushes.
export async function logOpenRouterCall(
  row: LogOpenRouterCallRow,
): Promise<void> {
  const cost = row.cost_usd ?? (
    row.prompt_tokens != null && row.completion_tokens != null
      ? computeCost(row.model, row.prompt_tokens, row.completion_tokens)
      : null
  );

  const { error } = await supabase()
    .from("openrouter_calls")
    .insert({
      function_slug: row.function_slug,
      call_site: row.call_site,
      model: row.model,
      prompt_tokens: row.prompt_tokens ?? null,
      completion_tokens: row.completion_tokens ?? null,
      cost_usd: cost,
      latency_ms: row.latency_ms,
      status: row.status,
      error_message: row.error_message ?? null,
    });
  if (error) {
    console.error(
      `[openrouter-log] insert failed for ${row.function_slug}/${row.call_site}: ${error.message}`,
    );
  }
}
