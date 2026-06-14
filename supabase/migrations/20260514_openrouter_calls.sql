-- Per-call audit table for OpenRouter requests from Edge Functions and the
-- dashboard. Writes are fire-and-forget so telemetry never blocks callers.
--
-- Access is service-role-only: RLS is enabled with no public policies, so
-- browser-facing roles cannot read or write audit rows.

create table if not exists public.openrouter_calls (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  function_slug text not null,
  call_site text not null,
  model text not null,
  prompt_tokens integer,
  completion_tokens integer,
  cost_usd numeric(10, 6),
  latency_ms integer,
  status text not null,
  error_message text
);

create index if not exists idx_openrouter_calls_created_at
  on public.openrouter_calls (created_at desc);

create index if not exists idx_openrouter_calls_function_slug_created_at
  on public.openrouter_calls (function_slug, created_at desc);

alter table public.openrouter_calls enable row level security;

comment on table public.openrouter_calls is
  'Per-call OpenRouter audit log for cost, model-mix, status, and latency analysis. Service-role-only access via RLS.';
comment on column public.openrouter_calls.function_slug is
  'Edge Function or dashboard origin for the request.';
comment on column public.openrouter_calls.call_site is
  'Short label for the specific OpenRouter call site within the origin.';
comment on column public.openrouter_calls.model is
  'OpenRouter model slug used for the request.';
comment on column public.openrouter_calls.prompt_tokens is
  'Prompt-token usage reported by OpenRouter. Nullable when usage is unavailable.';
comment on column public.openrouter_calls.completion_tokens is
  'Completion-token usage reported by OpenRouter. Nullable when usage is unavailable.';
comment on column public.openrouter_calls.cost_usd is
  'Estimated request cost in USD. Null when token usage or model pricing is unavailable.';
comment on column public.openrouter_calls.latency_ms is
  'Wall-clock request latency in milliseconds.';
comment on column public.openrouter_calls.status is
  'Request outcome such as ok, error_4xx, error_5xx, budget_exceeded, or timeout.';
comment on column public.openrouter_calls.error_message is
  'Truncated provider error details for failed requests. Must not contain prompts or secrets.';
