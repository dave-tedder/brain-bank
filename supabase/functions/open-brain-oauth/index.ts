import { createHandler } from "./handler.ts";
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
Deno.serve(createHandler({
  supabaseUrl,
  resource: `${supabaseUrl}/functions/v1/open-brain-oauth`,
  ownerId: Deno.env.get("BRAIN_OAUTH_OWNER_ID") || "",
  clientId: Deno.env.get("BRAIN_OAUTH_CLIENT_ID") || "",
  upstreamKey: Deno.env.get("MCP_ACCESS_KEY") || "",
  legacyJwtSecret: Deno.env.get("SUPABASE_JWT_SECRET"),
}));
