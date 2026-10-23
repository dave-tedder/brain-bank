# Connect ChatGPT with OAuth (no shared key)

This walkthrough connects ChatGPT to Brain Bank as a custom MCP connector that signs in with OAuth. ChatGPT never sees `MCP_ACCESS_KEY`. You sign in with an emailed code, approve the connection on a consent page your own dashboard serves, and ChatGPT receives a short-lived token that unlocks memory tools only.

If you have not completed [`deploy-from-scratch.md`](../deploy-from-scratch.md) through Step 10 and deployed the dashboard ([`dashboard-deploy.md`](../dashboard-deploy.md)), stop and do that first. For the simpler key-based Custom GPT, see [`chatgpt-gpt.md`](chatgpt-gpt.md) instead.

## How it works

Three pieces, and Supabase Auth does the hard part:

- **Supabase Auth's OAuth 2.1 server** issues authorization codes, enforces S256 PKCE, rotates refresh tokens and records consent. Brain Bank adds no password system.
- **`open-brain-oauth`** is a separate Edge Function that ChatGPT calls as its MCP server. It verifies each bearer token's signature, issuer, audience, expiry, owner and client, then forwards the request to `open-brain-mcp` with the server-side key. It exposes nine memory tools (`capture_thought`, `list_thoughts`, `search_thoughts`, `thought_stats`, `list_compiled_pages`, `search_compiled_pages`, `get_compiled_page`, `get_thought_by_id`, `get_thought_edges`) and refuses everything else, including every task-board tool. `open-brain-mcp` and its key are unchanged.
- **`/oauth/consent`** on the dashboard is the one page reachable without the dashboard password. It signs you in with a Supabase email code, checks that the signed-in account is the configured owner and the requesting app is the configured client, shows what the connection can do, and sends you back to ChatGPT only on an allowed `chatgpt.com` callback path.

A token hook (`brain_oauth_token_hook`, in migration `20261007_chatgpt_oauth_access.sql`) stamps the gateway's audience and a `brain_access: "memory"` claim onto tokens for that one owner/client pair, and refuses the pair for any other account. Ordinary Supabase logins pass through untouched.

## Step 1. Apply the migration

```bash
supabase db push   # applies 20261007_chatgpt_oauth_access.sql
```

It creates `brain_oauth_config` (non-secret identifiers only, service-role only) and the token hook function, executable only by `supabase_auth_admin`.

## Step 2. Create the owner account

Supabase Dashboard, Authentication, Users, **Add user**, with your own email. The consent page sends codes with `create_user: false`, so no one else can sign up through it. Copy the user's UUID; that is your owner id.

Make sure Supabase can actually email that address. The default SMTP sender only delivers to your organization's members; configure a custom SMTP provider otherwise.

Authentication, Email Templates, **Magic Link**: include `{{ .Token }}` in the body. The consent page asks for the code, not a link.

## Step 3. Turn on the OAuth server

Authentication, OAuth Server (Supabase Dashboard):

- Enable the OAuth server.
- **Authorization path:** `/oauth/consent`.
- **Site URL** (Authentication, URL Configuration): your dashboard's origin, for example `https://brain.example.com`. Supabase sends the user to `<site URL>/oauth/consent?authorization_id=...`.
- Leave dynamic client registration **off**. You register the one client yourself.

## Step 4. Register the ChatGPT client

In ChatGPT, start creating a custom MCP connector (Settings, Connectors, Advanced, Developer mode, then create). Use:

- **MCP server URL:** `https://<your-project-ref>.supabase.co/functions/v1/open-brain-oauth`
- **Authentication:** OAuth.

ChatGPT shows the exact callback URL it will use, of the form `https://chatgpt.com/connector/oauth/<id>`. Copy it, and do not submit the form yet.

Back in Supabase, Authentication, OAuth Server, **Add client**: a public client (PKCE, no secret) whose only redirect URI is that exact callback. Copy the client id. Paste it into the ChatGPT form's client id field. If you ever recreate the ChatGPT form, its callback changes; update the client's redirect URI to match.

## Step 5. Store the owner/client pair and enable the hook

```sql
insert into public.brain_oauth_config (owner_id, client_id, resource_url)
values ('<owner uuid>', '<client uuid>', 'https://<your-project-ref>.supabase.co/functions/v1/open-brain-oauth');
```

Authentication, Hooks, **Customize Access Token (JWT) Claims**: Postgres function `public.brain_oauth_token_hook`.

## Step 6. Deploy the gateway and set its environment

```bash
supabase functions deploy open-brain-oauth --no-verify-jwt --project-ref <your-project-ref>
supabase secrets set --env-file /dev/stdin --project-ref <your-project-ref> <<'EOF'
BRAIN_OAUTH_OWNER_ID=<owner uuid>
BRAIN_OAUTH_CLIENT_ID=<client uuid>
EOF
```

`--no-verify-jwt` is required here too: the platform's generic JWT check would accept any project token, while the handler performs the resource-specific validation itself. The gateway also reads `SUPABASE_URL` (provided by the platform) and the existing `MCP_ACCESS_KEY`. It verifies tokens against the project's published JWKS; if your project still signs with the legacy HS256 secret, also set `SUPABASE_JWT_SECRET`.

Until both ids are set, the gateway answers 503 to everything except its discovery document. That is the intended fail-closed state.

## Step 7. Configure the dashboard

On the dashboard's host (Railway: service, Variables), add:

| Variable | Value |
|---|---|
| `SUPABASE_ANON_KEY` | The project's **publishable** (`sb_publishable_...`) or legacy `anon` key. Never the service-role or secret key: the consent page puts this value in the browser and refuses to render (503) if it looks like anything else. |
| `BRAIN_OAUTH_OWNER_ID` | Same owner uuid as Step 5. |
| `BRAIN_OAUTH_CLIENT_ID` | Same client uuid as Step 5. |

`SUPABASE_URL` is already set from the dashboard deploy. Redeploy so the variables take effect.

## Step 8. Verify, then connect

```bash
# Discovery document: public, 200
curl -s https://<your-project-ref>.supabase.co/functions/v1/open-brain-oauth/.well-known/oauth-protected-resource
# No token: 401 with a WWW-Authenticate challenge pointing at that document
curl -si -X POST https://<your-project-ref>.supabase.co/functions/v1/open-brain-oauth | head -5
# Consent page: 200, Cache-Control: no-store (a 503 names the missing setting)
curl -sI https://brain.example.com/oauth/consent
```

Then submit the ChatGPT form. ChatGPT opens your consent page: enter your email, enter the code, review the access, choose **Allow access**. ChatGPT should list eight read tools and one write tool (`capture_thought`).

Seeing the tools proves token validation and discovery. Prove the connection end to end from a ChatGPT chat: ask for your thought stats, read a wiki page, and capture a thought, then confirm the capture landed in `thoughts`. A direct call to `open-brain-mcp` with your key does not prove the connector works.

## Troubleshooting

- **Gateway 404 on every path.** The function must be deployed under the name `open-brain-oauth`; the handler matches that path.
- **Consent page 503.** The response body says which setting is missing or rejected. A service-role key in `SUPABASE_ANON_KEY` is rejected deliberately.
- **"This account cannot connect Brain Bank."** You signed in with an account other than `BRAIN_OAUTH_OWNER_ID`.
- **"This application is not approved for Brain Bank."** The client id ChatGPT used differs from `BRAIN_OAUTH_CLIENT_ID`; usually a recreated ChatGPT form registered a new client.
- **401 after consent succeeded.** The token hook is not enabled, or `brain_oauth_config.resource_url` does not exactly match the gateway URL, so the token's audience is wrong.
- **429.** The gateway allows 120 authenticated requests per minute per isolate, on top of Supabase Auth's own limits.
