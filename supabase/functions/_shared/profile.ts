export interface Profile {
  operator: { name: string; emails: string[] };
  example_domain: string;
  example_projects: string[];
  example_person_name: string;
  persona: { digest: string; compile_pages: string };
  domain: { singular_noun: string; plural_noun: string; vocabulary: string[] };
  event_types: string[];
  client_event_types: string[];
  mechanical_capture_prefixes: string[];
}

let cached: Profile | null = null;

export function loadProfile(pathOverride?: URL): Profile {
  if (!pathOverride && cached) return cached;
  const path = pathOverride ?? new URL("./profile.json", import.meta.url);
  let raw: string;
  try {
    raw = Deno.readTextFileSync(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(
        "profile.json not found at supabase/functions/_shared/profile.json. " +
          "Copy profile.example.json to supabase/functions/_shared/profile.json " +
          "and fill in your values, then redeploy.",
      );
    }
    throw err;
  }
  const parsed = JSON.parse(raw) as Profile;
  validate(parsed);
  if (!pathOverride) cached = parsed;
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
  if (missing.length) {
    throw new Error(
      `profile.json is missing required fields: ${missing.join(", ")}. ` +
        `Copy profile.example.json to supabase/functions/_shared/profile.json ` +
        `and fill in your values.`,
    );
  }
}
