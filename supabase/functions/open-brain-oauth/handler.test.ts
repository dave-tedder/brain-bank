import { assertEquals } from "jsr:@std/assert@1.0.19";
import { SignJWT } from "npm:jose@6.1.0";
import { createHandler, type Config } from "./handler.ts";
const c: Config = { supabaseUrl: "https://test.supabase.co", resource: "https://test.supabase.co/functions/v1/open-brain-oauth", ownerId: "owner", clientId: "client", upstreamKey: "upstream-only", legacyJwtSecret: "test-signing-secret-with-at-least-32-bytes" };
async function token(overrides = {}, secret = c.legacyJwtSecret!) {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ sub: "owner", client_id: "client", brain_access: "memory", role: "authenticated", iss: c.supabaseUrl + "/auth/v1", aud: c.resource, exp: now + 3600, iat: now, ...overrides }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(secret));
}
function request(t?: string, message: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" }) {
  return new Request(c.resource, { method: "POST", headers: t ? { authorization: `Bearer ${t}` } : {}, body: JSON.stringify(message) });
}
const goodUpstream: typeof fetch = async () => Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "get_compiled_page" }, { name: "capture_thought" }, { name: "complete_agent_task" }] } });
for (const [name, patch] of Object.entries({ owner: { sub: "other" }, client: { client_id: "other" }, access: { brain_access: "admin" }, role: { role: "service_role" }, issuer: { iss: "https://attacker.test" }, audience: { aud: "authenticated" }, expiry: { exp: 1 }, age: { iat: 1 }, missing_expiry: { exp: undefined } })) {
  Deno.test(`reject ${name}`, async () => assertEquals((await createHandler(c, undefined, goodUpstream)(request(await token(patch)))).status, 401));
}
Deno.test("reject bad signature", async () => assertEquals((await createHandler(c, undefined, goodUpstream)(request(await token({}, "wrong-signing-key-with-at-least-32-bytes")))).status, 401));
Deno.test("valid owner sees only memory tools", async () => {
  const r = await createHandler(c, undefined, goodUpstream)(request(await token()));
  assertEquals((await r.json()).result.tools.map((t: { name: string }) => t.name), ["get_compiled_page", "capture_thought"]);
});
Deno.test("challenge points to resource metadata", async () => assertEquals((await createHandler(c)(request())).headers.get("www-authenticate"), `Bearer resource_metadata="${c.resource}/.well-known/oauth-protected-resource", scope="email"`));
Deno.test("resource metadata is public", async () => assertEquals((await (await createHandler(c)(new Request(c.resource + "/.well-known/oauth-protected-resource"))).json()).authorization_servers, [c.supabaseUrl + "/auth/v1"]));
Deno.test("unconfigured gateway fails closed", async () => assertEquals((await createHandler({ ...c, ownerId: "" })(request(await token()))).status, 503));
Deno.test("query key is not authentication", async () => assertEquals((await createHandler(c)(new Request(c.resource + "?key=upstream-only", { method: "POST", body: "{}" }))).status, 401));
Deno.test("board call never reaches upstream", async () => {
  let called = false;
  await createHandler(c, undefined, async () => { called = true; return Response.json({}); })(request(await token(), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "complete_agent_task" } }));
  assertEquals(called, false);
});
Deno.test("allowed call forwards only server key", async () => {
  let received: unknown;
  await createHandler(c, undefined, async (url, init) => {
    received = [url, init?.headers, JSON.parse(String(init?.body)).params];
    return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [] } });
  })(request(await token(), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_compiled_page", arguments: { slug: "project/test" } } }));
  assertEquals(received, [c.supabaseUrl + "/functions/v1/open-brain-mcp", { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-brain-key": "upstream-only" }, { name: "get_compiled_page", arguments: { slug: "project/test" } }]);
});
Deno.test("SSE discovery is filtered", async () => {
  const upstream: typeof fetch = async () => new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"thought_stats"},{"name":"delete_all"}]}}\n\n', { headers: { "content-type": "text/event-stream" } });
  const r = await createHandler(c, undefined, upstream)(request(await token()));
  const line = (await r.text()).split("\n").find((s) => s.startsWith("data: "))!;
  assertEquals(JSON.parse(line.slice(6)).result.tools.map((t: { name: string }) => t.name), ["thought_stats"]);
});
Deno.test("batch rejected", async () => assertEquals((await createHandler(c)(request(await token(), [{ jsonrpc: "2.0", method: "tools/list" }]))).status, 400));
Deno.test("oversized body rejected", async () => assertEquals((await createHandler(c)(request(await token(), { jsonrpc: "2.0", method: "ping", extra: "x".repeat(256 * 1024) }))).status, 400));
Deno.test("unknown method rejected", async () => assertEquals((await (await createHandler(c)(request(await token(), { jsonrpc: "2.0", id: 1, method: "resources/read" }))).json()).error.code, -32601));
Deno.test("upstream errors are sanitized", async () => assertEquals(await (await createHandler(c, undefined, async () => new Response("secret details", { status: 500 }))(request(await token()))).json(), { error: "Memory service unavailable" }));

Deno.test("authenticated burst is limited", async () => {
  const handler = createHandler(c, async () => ({ sub: c.ownerId, client_id: c.clientId, brain_access: "memory", role: "authenticated" }), goodUpstream);
  for (let i = 0; i < 120; i++) await handler(request("test"));
  assertEquals((await handler(request("test"))).status, 429);
});

Deno.test("Supabase runtime path returns metadata", async () => {
  const response = await createHandler(c)(new Request("https://edge.test/open-brain-oauth/.well-known/oauth-protected-resource"));
  assertEquals((await response.json()).resource, c.resource);
});

Deno.test("discovery distinguishes read and capture permissions", async () => {
  const response = await createHandler(c, undefined, goodUpstream)(request(await token()));
  const tools = (await response.json()).result.tools;
  assertEquals(tools.map((t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint), [true, false]);
});
