-- OE-12 Phase 4 readiness watch, part 3: immutability by grant. Applied LAST,
-- after any verification smoke's scratch rows were removed as table owner.
-- After this, the MCP (service_role) can never rewrite its own history - the
-- property a hand-edited markdown table never had. Break-glass corrections
-- remain possible only as table owner via execute_sql, and should be treated
-- as the exception they are.
revoke update, delete on public.agent_run_log from service_role;
revoke update, delete on public.agent_run_log from anon, authenticated;
