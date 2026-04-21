import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadProfile, type Profile } from "../../supabase/functions/_shared/profile.ts";

function loadFixture(name: string): Profile {
  const raw = Deno.readTextFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(raw) as Profile;
}

Deno.test("loadProfile parses a valid profile from a fixture", () => {
  const p = loadProfile(loadFixture("profile.valid.json"));
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
  const err = assertThrows(() => loadProfile(loadFixture("profile.missing-required.json")), Error);
  const msg = (err as Error).message;
  if (!msg.includes("operator.name")) {
    throw new Error(`Expected error message to mention 'operator.name', got: ${msg}`);
  }
});
