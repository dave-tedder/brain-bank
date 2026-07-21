import { createClient, SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!_client) {
    _client = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    // Monkeypatch the REST client URL for standalone PostgREST environments where there is no Kong API gateway
    const rawUrl = process.env.SUPABASE_URL!;
    if (rawUrl && (rawUrl.includes("bb-postgrest") || !rawUrl.includes("supabase.co"))) {
      // @ts-ignore
      _client.rest.url = rawUrl;
    }
  }
  return _client;
}
