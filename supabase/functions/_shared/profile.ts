// JSON module import (Deno 2.x stable). Creates a module-graph edge so the
// Supabase CLI bundler uploads profile.json alongside this file. A runtime
// Deno.readTextFileSync() would leave profile.json out of the deploy bundle
// and crash at module-load time.
import profileDefaults from "./profile.json" with { type: "json" };

export interface Profile {
  operator: { name: string; emails: string[] };
  example_domain: string;
  example_projects: string[];
  example_person_name: string;
  persona: { digest: string; compile_pages: string };
  domain: { singular_noun: string; plural_noun: string; vocabulary: string[] };
  event_types: string[];
  client_event_types: string[];
  content_types: string[];
  mechanical_capture_prefixes: string[];
  // OE board-hygiene: WordPress site handles a `wp_post_status` close_check may
  // name. Optional and FAIL-CLOSED: leave it unset and every wp_post_status
  // probe is refused at authorship, which is the correct default for a fork
  // that has not wired any WordPress credentials. A probe naming an unlisted
  // site is refused rather than silently attempted, so a typo cannot become a
  // network call.
  wordpress_sites?: string[];
}

let cached: Profile | null = null;

export function loadProfile(override?: Profile): Profile {
  if (!override && cached) return cached;
  const parsed = (override ?? profileDefaults) as Profile;
  validate(parsed);
  if (!override) cached = parsed;
  return parsed;
}

function validate(p: Profile): void {
  const missing: string[] = [];
  if (!p.operator?.name) missing.push("operator.name");
  if (!p.operator?.emails?.length) missing.push("operator.emails");
  if (!p.example_domain) missing.push("example_domain");
  if (!p.example_projects?.length) missing.push("example_projects");
  if (!p.example_person_name) missing.push("example_person_name");
  if (!p.persona?.digest) missing.push("persona.digest");
  if (!p.persona?.compile_pages) missing.push("persona.compile_pages");
  if (!p.domain?.singular_noun) missing.push("domain.singular_noun");
  if (!p.domain?.plural_noun) missing.push("domain.plural_noun");
  if (!p.domain?.vocabulary?.length) missing.push("domain.vocabulary");
  if (!p.event_types?.length) missing.push("event_types");
  if (!p.client_event_types?.length) missing.push("client_event_types");
  if (!p.content_types?.length) missing.push("content_types");
  if (missing.length) {
    throw new Error(
      `profile.json is missing required fields: ${missing.join(", ")}. ` +
        `Copy profile.example.json to supabase/functions/_shared/profile.json ` +
        `and fill in your values.`,
    );
  }
}
