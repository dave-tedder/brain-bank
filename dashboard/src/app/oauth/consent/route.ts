import { consentResponse } from "@/lib/oauth-consent";
export const dynamic = "force-dynamic";
export function GET() {
  return consentResponse({
    supabaseUrl: process.env.SUPABASE_URL || "",
    publicKey: process.env.SUPABASE_ANON_KEY || "",
    ownerId: process.env.BRAIN_OAUTH_OWNER_ID || "",
    clientId: process.env.BRAIN_OAUTH_CLIENT_ID || "",
  });
}
