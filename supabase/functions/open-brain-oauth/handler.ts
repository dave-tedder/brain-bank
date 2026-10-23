import { jwtVerify, createRemoteJWKSet, type JWTPayload } from "npm:jose@6.1.0";

export const MEMORY_TOOLS = new Set([
  "capture_thought", "list_thoughts", "search_thoughts", "thought_stats",
  "list_compiled_pages", "search_compiled_pages", "get_compiled_page",
  "get_thought_by_id", "get_thought_edges",
]);
export interface Config {
  supabaseUrl: string;
  resource: string;
  ownerId: string;
  clientId: string;
  upstreamKey: string;
  legacyJwtSecret?: string;
}
export function claimsAllowed(p: JWTPayload, c: Config): boolean {
  return !!c.ownerId && !!c.clientId && p.sub === c.ownerId &&
    p.client_id === c.clientId && p.brain_access === "memory" &&
    p.role === "authenticated";
}
export function tokenVerifier(c: Config) {
  const jwks = createRemoteJWKSet(new URL(`${c.supabaseUrl}/auth/v1/.well-known/jwks.json`));
  return async (token: string): Promise<JWTPayload> => {
    // Select the fixed key source by algorithm, never by any token-provided URL.
    const { payload } = await jwtVerify(token, async (header, flattened) => {
      if (header.alg === "HS256" && c.legacyJwtSecret) {
        return new TextEncoder().encode(c.legacyJwtSecret);
      }
      return await jwks(header, flattened);
    }, {
      issuer: `${c.supabaseUrl}/auth/v1`, audience: c.resource,
      algorithms: ["HS256", "ES256", "RS256"],
      requiredClaims: ["exp", "iat", "sub", "iss", "aud"], maxTokenAge: "1h",
    });
    return payload;
  };
}
const MAX_BODY = 256 * 1024;
async function boundedBody(req: Request): Promise<string> {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("empty");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) { await reader.cancel(); throw new Error("large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}
function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...extra } });
}
export function createHandler(
  c: Config,
  verify: (token: string) => Promise<JWTPayload> = tokenVerifier(c),
  fetcher: typeof fetch = fetch,
) {
  // Per-isolate burst protection supplements Supabase Auth rate limits.
  let windowStart = Date.now();
  let requests = 0;
  const metadataUrl = `${c.resource}/.well-known/oauth-protected-resource`;
  const challenge = `Bearer resource_metadata="${metadataUrl}", scope="email"`;
  return async (req: Request): Promise<Response> => {
    if (!c.ownerId || !c.clientId || !c.upstreamKey) return json({ error: "Connection not configured" }, 503);
    const receivedPath = new URL(req.url).pathname;
    // Supabase strips /functions/v1 before dispatching to the Edge runtime.
    const path = receivedPath.startsWith("/open-brain-oauth") ? "/functions/v1" + receivedPath : receivedPath;
    if (path === new URL(metadataUrl).pathname && req.method === "GET") {
      return json({ resource: c.resource, authorization_servers: [`${c.supabaseUrl}/auth/v1`], scopes_supported: ["email"], bearer_methods_supported: ["header"], resource_name: "Brain Bank memory" });
    }
    if (path !== new URL(c.resource).pathname && path !== new URL(c.resource).pathname + "/") return json({ error: "Not found" }, 404);
    const token = req.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!token) return json({ error: "Sign in to Brain Bank" }, 401, { "WWW-Authenticate": challenge });
    try {
      if (!claimsAllowed(await verify(token), c)) throw new Error("denied");
    } catch {
      return json({ error: "Invalid or expired authorization" }, 401, { "WWW-Authenticate": `${challenge}, error="invalid_token"` });
    }
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
    if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); requests = 0; }
    if (++requests > 120) return json({ error: "Too many requests" }, 429, { "Retry-After": "60" });
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await boundedBody(req));
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || parsed.jsonrpc !== "2.0") throw new Error("invalid");
      message = parsed;
    } catch { return json({ error: "Invalid or oversized JSON-RPC request" }, 400); }
    const id = typeof message.id === "number" || typeof message.id === "string" ? message.id : null;
    const method = message.method;
    if (method === "notifications/initialized" || method === "notifications/cancelled") return new Response(null, { status: 202 });
    if (method === "tools/call") {
      const params = message.params as Record<string, unknown> | undefined;
      if (!params || typeof params.name !== "string" || !MEMORY_TOOLS.has(params.name)) {
        return json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Tool not available on this connection" } });
      }
    } else if (!["initialize", "ping", "tools/list"].includes(String(method))) {
      return json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not available" } });
    }
    try {
      const upstream = await fetcher(`${c.supabaseUrl}/functions/v1/open-brain-mcp`, {
        method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "x-brain-key": c.upstreamKey },
        body: JSON.stringify(message), signal: AbortSignal.timeout(55_000), redirect: "error",
      });
      if (!upstream.ok) return json({ error: "Memory service unavailable" }, 502);
      if (upstream.status === 202 || upstream.status === 204) return new Response(null, { status: upstream.status });
      const contentType = upstream.headers.get("content-type") || "application/json";
      // The deployed stateless MCP transport emits one JSON-RPC result, as JSON or SSE.
      const text = await upstream.text();
      const filter = (value: Record<string, unknown>) => {
        if (method === "tools/list") {
          const result = value.result as { tools?: { name: string }[]; nextCursor?: string } | undefined;
          if (!result || !Array.isArray(result.tools)) throw new Error("invalid tool list");
          result.tools = result.tools.filter((t) => MEMORY_TOOLS.has(t.name));
          // Advertise OAuth on every tool so the host knows sign-in is required.
          for (const tool of result.tools) Object.assign(tool, { annotations: { readOnlyHint: tool.name !== "capture_thought", destructiveHint: false, openWorldHint: false }, securitySchemes: [{ type: "oauth2", scopes: ["email"] }] });
        }
        return value;
      };
      if (contentType.includes("text/event-stream")) {
        const output = text.split("\n").map((line) => line.startsWith("data: ") ? `data: ${JSON.stringify(filter(JSON.parse(line.slice(6))))}` : line).join("\n");
        return new Response(output, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
      }
      return json(filter(JSON.parse(text)));
    } catch { return json({ error: "Memory service unavailable" }, 502); }
  };
}
