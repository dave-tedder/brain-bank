// Which Supabase secret key the Edge Functions use.
//
// Supabase fills SUPABASE_SERVICE_ROLE_KEY for every function itself, so on a
// project with several secret keys you cannot rotate one without knowing which
// the platform will inject next. Setting the function secret
// BB_SECRET_KEY_NAME=<name> makes every function read that named key from
// SUPABASE_SECRET_KEYS instead. Secrets apply without a redeploy, so switching
// keys (or rolling back, by unsetting it) is one `supabase secrets set/unset`.
// Supabase key names allow only lowercase letters, digits and underscores.
//
// Unset, or naming a key that is not present, falls back to
// SUPABASE_SERVICE_ROLE_KEY, the default behavior.

type EnvGet = (name: string) => string | undefined;

export function resolveServiceKey(get: EnvGet): string {
  const name = (get("BB_SECRET_KEY_NAME") || "").trim();
  if (name) {
    try {
      const keys = JSON.parse(get("SUPABASE_SECRET_KEYS") || "{}");
      const key = keys?.[name];
      if (typeof key === "string" && key) return key;
      console.error(
        `[service-key] BB_SECRET_KEY_NAME=${name} not in SUPABASE_SECRET_KEYS; falling back to SUPABASE_SERVICE_ROLE_KEY`,
      );
    } catch {
      console.error(
        "[service-key] SUPABASE_SECRET_KEYS is not valid JSON; falling back to SUPABASE_SERVICE_ROLE_KEY",
      );
    }
  }
  return get("SUPABASE_SERVICE_ROLE_KEY") || "";
}

export function serviceKey(): string {
  return resolveServiceKey((n) => Deno.env.get(n));
}
