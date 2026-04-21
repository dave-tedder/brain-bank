import { assertEquals, assertRejects, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadProfile } from "../../supabase/functions/_shared/profile.ts";

Deno.test("loadProfile parses a valid profile from a fixture URL", () => {
  const fixture = new URL("./fixtures/profile.valid.json", import.meta.url);
  const p = loadProfile(fixture);
  assertEquals(p.operator.name, "Test Operator");
  assertEquals(p.operator.emails, ["test@example.com"]);
  assertEquals(p.example_domain, "example.com");
  assertEquals(p.persona.digest, "a knowledge worker");
  assertEquals(p.domain.plural_noun, "client sessions");
  assertEquals(p.event_types.length, 4);
  assertEquals(p.client_event_types.length, 3);
  assertEquals(p.content_types.length, 3);
  assertEquals(p.mechanical_capture_prefixes, []);
});

Deno.test("loadProfile throws a helpful error when required fields are missing", () => {
  const fixture = new URL("./fixtures/profile.missing-required.json", import.meta.url);
  const err = assertThrows(() => loadProfile(fixture), Error);
  const msg = (err as Error).message;
  if (!msg.includes("operator.name")) {
    throw new Error(`Expected error message to mention 'operator.name', got: ${msg}`);
  }
});

Deno.test("loadProfile throws a helpful error when the file is missing", () => {
  const fixture = new URL("./fixtures/does-not-exist.json", import.meta.url);
  const err = assertThrows(() => loadProfile(fixture), Error);
  const msg = (err as Error).message;
  if (!msg.includes("profile.json not found")) {
    throw new Error(`Expected error message to mention 'profile.json not found', got: ${msg}`);
  }
  if (!msg.includes("Copy profile.example.json")) {
    throw new Error(`Expected error message to mention 'Copy profile.example.json', got: ${msg}`);
  }
});
