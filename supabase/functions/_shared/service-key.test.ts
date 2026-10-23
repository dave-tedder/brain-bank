// Deno unit tests for the named secret-key resolver.
// Run: deno test supabase/functions/_shared/service-key.test.ts
import { assertEquals } from "jsr:@std/assert@1.0.19";
import { resolveServiceKey } from "./service-key.ts";

const env = (vars: Record<string, string>) => (n: string) => vars[n];
const KEYS = JSON.stringify({ default: "sb_secret_old", "edge_2026_10": "sb_secret_new" });

Deno.test("resolveServiceKey: unset name uses SUPABASE_SERVICE_ROLE_KEY", () => {
  assertEquals(
    resolveServiceKey(env({ SUPABASE_SERVICE_ROLE_KEY: "legacy", SUPABASE_SECRET_KEYS: KEYS })),
    "legacy",
  );
});

Deno.test("resolveServiceKey: named key wins over the legacy variable", () => {
  assertEquals(
    resolveServiceKey(env({
      BB_SECRET_KEY_NAME: "edge_2026_10",
      SUPABASE_SERVICE_ROLE_KEY: "legacy",
      SUPABASE_SECRET_KEYS: KEYS,
    })),
    "sb_secret_new",
  );
});

Deno.test("resolveServiceKey: missing name falls back", () => {
  assertEquals(
    resolveServiceKey(env({
      BB_SECRET_KEY_NAME: "nope",
      SUPABASE_SERVICE_ROLE_KEY: "legacy",
      SUPABASE_SECRET_KEYS: KEYS,
    })),
    "legacy",
  );
});

Deno.test("resolveServiceKey: bad JSON falls back", () => {
  assertEquals(
    resolveServiceKey(env({
      BB_SECRET_KEY_NAME: "edge_2026_10",
      SUPABASE_SERVICE_ROLE_KEY: "legacy",
      SUPABASE_SECRET_KEYS: "{",
    })),
    "legacy",
  );
});
