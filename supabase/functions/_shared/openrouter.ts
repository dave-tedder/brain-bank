import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export const MODEL_PRICING: Record<string, { in: number; out: number }> = {
  "openai/text-embedding-3-small": { in: 0.02, out: 0 },
  "openai/gpt-4o-mini": { in: 0.15, out: 0.60 },
  "openai/gpt-4.1-mini": { in: 0.40, out: 1.60 },
  "anthropic/claude-sonnet-4.6": { in: 3.00, out: 15.00 },
};

export function computeCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return null;
  return (
    promptTokens * pricing.in + completionTokens * pricing.out
  ) / 1_000_000;
}

type Endpoint = "chat/completions" | "embeddings";
type Status =
  | "ok"
  | "error_4xx"
  | "error_5xx"
  | "budget_exceeded"
  | "timeout";

export interface OpenRouterCallOptions {
  function_slug: string;
  call_site: string;
  model: string;
  endpoint?: Endpoint;
  messages?: Array<{ role: string; content: string }>;
  max_tokens?: number;
  response_format?: { type: string };
  temperature?: number;
  input?: string | string[];
  signal?: AbortSignal;
}

export interface OpenRouterCallResult {
  data: Record<string, unknown> & {
    choices?: Array<{ message?: { content?: string } }>;
    data?: Array<{ embedding?: number[] }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number | null;
  latency_ms: number;
}

export interface OpenRouterAuditRow {
  function_slug: string;
  call_site: string;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number;
  status: Status;
  error_message: string | null;
}

export interface OpenRouterDependencies {
  fetch: typeof fetch;
  now: () => number;
  insertAudit: (row: OpenRouterAuditRow) => Promise<void>;
  waitUntil: (promise: PromiseLike<unknown>) => void;
  apiKey: string;
  onAuditError?: (error: unknown, row: OpenRouterAuditRow) => void;
}

let supabase: ReturnType<typeof createClient> | null = null;

function getSupabase(): ReturnType<typeof createClient> {
  if (!supabase) {
    const url = Deno.env.get("SUPABASE_URL")!;
    supabase = createClient(
      url,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    if (url && (url.includes("bb-postgrest") || !url.includes("supabase.co"))) {
      // @ts-ignore
      supabase.rest.url = url;
    }
  }
  return supabase;
}

async function insertAudit(row: OpenRouterAuditRow): Promise<void> {
  const table = getSupabase().from("openrouter_calls") as unknown as {
    insert: (
      value: OpenRouterAuditRow,
    ) => PromiseLike<{ error?: { message?: string } | null }>;
  };
  const { error } = await table.insert(row);
  if (error) throw new Error(error.message || "openrouter_calls insert failed");
}

function defaultWaitUntil(promise: PromiseLike<unknown>): void {
  const runtime = (globalThis as unknown as {
    EdgeRuntime?: { waitUntil: (value: PromiseLike<unknown>) => void };
  }).EdgeRuntime;
  if (runtime) {
    runtime.waitUntil(promise);
    return;
  }
  void promise;
}

function defaultDependencies(): OpenRouterDependencies {
  return {
    fetch: globalThis.fetch,
    now: Date.now,
    insertAudit,
    waitUntil: defaultWaitUntil,
    apiKey: Deno.env.get("OPENROUTER_API_KEY")!,
    onAuditError: (error, row) => {
      console.error(
        `[openrouter-log] insert failed for ${row.function_slug}/${row.call_site}:`,
        error,
      );
    },
  };
}

function classifyError(httpStatus: number, errorMessage: string): Status {
  if (
    httpStatus === 403 &&
    /budget.*(exceed|limit)/i.test(errorMessage)
  ) {
    return "budget_exceeded";
  }
  return httpStatus >= 500 ? "error_5xx" : "error_4xx";
}

function scheduleAudit(
  row: OpenRouterAuditRow,
  deps: OpenRouterDependencies,
): void {
  const write = deps.insertAudit(row).catch((error) => {
    deps.onAuditError?.(error, row);
  });
  try {
    deps.waitUntil(write);
  } catch (error) {
    deps.onAuditError?.(error, row);
    void write;
  }
}

export async function callOpenRouter(
  opts: OpenRouterCallOptions,
  dependencies?: OpenRouterDependencies,
): Promise<OpenRouterCallResult> {
  const deps = dependencies ?? defaultDependencies();
  const endpoint = opts.endpoint ?? "chat/completions";
  const body: Record<string, unknown> = { model: opts.model };
  if (opts.messages !== undefined) body.messages = opts.messages;
  if (opts.input !== undefined) body.input = opts.input;
  if (opts.max_tokens !== undefined) body.max_tokens = opts.max_tokens;
  if (opts.response_format !== undefined) {
    body.response_format = opts.response_format;
  }
  if (opts.temperature !== undefined) body.temperature = opts.temperature;

  const startedAt = deps.now();
  let httpStatus = 0;

  try {
    const response = await deps.fetch(`${OPENROUTER_BASE}/${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    httpStatus = response.status;

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      const latencyMs = deps.now() - startedAt;
      scheduleAudit({
        function_slug: opts.function_slug,
        call_site: opts.call_site,
        model: opts.model,
        prompt_tokens: null,
        completion_tokens: null,
        cost_usd: null,
        latency_ms: latencyMs,
        status: classifyError(httpStatus, errorBody),
        error_message: errorBody.slice(0, 500),
      }, deps);
      throw new Error(
        `OpenRouter ${opts.model} ${httpStatus} (${opts.function_slug}/${opts.call_site}): ${errorBody.slice(0, 200)}`,
      );
    }

    const data = await response.json();
    const promptTokens = Number(data?.usage?.prompt_tokens ?? 0) || 0;
    const completionTokens = Number(data?.usage?.completion_tokens ?? 0) || 0;
    const costUsd = computeCost(opts.model, promptTokens, completionTokens);
    const latencyMs = deps.now() - startedAt;
    scheduleAudit({
      function_slug: opts.function_slug,
      call_site: opts.call_site,
      model: opts.model,
      prompt_tokens: promptTokens || null,
      completion_tokens: completionTokens || null,
      cost_usd: costUsd,
      latency_ms: latencyMs,
      status: "ok",
      error_message: null,
    }, deps);

    return {
      data,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      cost_usd: costUsd,
      latency_ms: latencyMs,
    };
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    if (isAbort) {
      scheduleAudit({
        function_slug: opts.function_slug,
        call_site: opts.call_site,
        model: opts.model,
        prompt_tokens: null,
        completion_tokens: null,
        cost_usd: null,
        latency_ms: deps.now() - startedAt,
        status: "timeout",
        error_message: "AbortError: call exceeded caller timeout",
      }, deps);
    } else if (httpStatus === 0) {
      scheduleAudit({
        function_slug: opts.function_slug,
        call_site: opts.call_site,
        model: opts.model,
        prompt_tokens: null,
        completion_tokens: null,
        cost_usd: null,
        latency_ms: deps.now() - startedAt,
        status: "error_5xx",
        error_message: (error instanceof Error ? error.message : String(error))
          .slice(0, 500),
      }, deps);
    }
    throw error;
  }
}
