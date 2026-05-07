-- Telemetry table for MCP tool invocations on the open-brain-mcp Edge Function.
--
-- Populated fire-and-forget by the Edge Function on each registered tool call
-- (initial coverage: get_compiled_page, search_compiled_pages, list_compiled_pages;
-- coverage may expand later by adding more call sites). Used to answer "are
-- agents actually using the wiki?" plus future analytics like per-tool weekly
-- counts and per-slug hit distribution.
--
-- Service-role-only access matches the rest of the schema (thoughts,
-- action_items, compiled_pages). RLS enabled with no policies = service_role
-- bypass + everyone else denied, mirroring the project convention.

create table if not exists public.mcp_tool_invocations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  tool_name text not null,
  args jsonb,
  source text
);

create index if not exists idx_mcp_tool_invocations_created_at
  on public.mcp_tool_invocations (created_at desc);

create index if not exists idx_mcp_tool_invocations_tool_name_created_at
  on public.mcp_tool_invocations (tool_name, created_at desc);

alter table public.mcp_tool_invocations enable row level security;

comment on table public.mcp_tool_invocations is
  'MCP tool-call telemetry for open-brain-mcp. One row per registered-tool invocation, written fire-and-forget so the tool response is never blocked. Initial coverage: the three wiki tools (get_compiled_page, search_compiled_pages, list_compiled_pages). Used for usage analytics. Service-role-only access via RLS.';
comment on column public.mcp_tool_invocations.tool_name is
  'Name of the MCP tool that was invoked (e.g., get_compiled_page).';
comment on column public.mcp_tool_invocations.args is
  'JSONB capture of the tool arguments. Trim or omit large fields before logging if needed; this is for analytics, not full request audit.';
comment on column public.mcp_tool_invocations.source is
  'Optional caller source hint. Reserved for future use (e.g., distinguishing claude-code vs claude-desktop vs chatgpt-gpt vs cowork-agent if/when the dispatcher knows).';
