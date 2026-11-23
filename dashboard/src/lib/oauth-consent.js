import { randomBytes } from "node:crypto";

/** @param {import("./oauth-consent").ConsentConfig} config */
export function consentResponse(config) {
  if (!config.supabaseUrl || !config.publicKey || !config.ownerId || !config.clientId) {
    return new Response("Brain Bank sign-in is not configured.", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  // Refuse accidental injection of a service-role key into browser configuration.
  const parts = config.publicKey.split(".");
  let publicKey = config.publicKey.startsWith("sb_publishable_");
  if (parts.length === 3) {
    try { publicKey = JSON.parse(Buffer.from(parts[1], "base64url").toString()).role === "anon"; } catch { /* reject */ }
  }
  if (!publicKey) return new Response("Public sign-in key is not configured.", { status: 503 });
  const origin = new URL(config.supabaseUrl).origin;
  if (origin !== config.supabaseUrl || !origin.startsWith("https://")) return new Response("Invalid sign-in configuration.", { status: 503 });
  const nonce = randomBytes(24).toString("base64");
  const data = JSON.stringify(config).replaceAll("<", "\\u003c");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect Brain Bank</title>
<style nonce="${nonce}">body{background:#101512;color:#eef5ee;font:17px system-ui;margin:0;padding:36px 20px}main{max-width:520px;margin:6vh auto}h1{font-size:30px}label,input,button{font:inherit}label{display:block;margin:24px 0 8px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #87958b;border-radius:6px;background:#202923;color:white}button{margin:20px 12px 0 0;padding:12px 18px;border:0;border-radius:6px;background:#98dfab;color:#102317;cursor:pointer}button:disabled{opacity:.5;cursor:wait}p,li{line-height:1.55}#status{min-height:1.5em;color:#d4e9d9}.secondary{background:#344239;color:white}</style></head>
<body><main><h1>Connect Brain Bank</h1><p>Authorize ChatGPT to use your private memory.</p>
<form id="email-form"><label for="email">Your account email</label><input id="email" type="email" autocomplete="email" required><button>Send sign-in code</button></form>
<form id="code-form" hidden><label for="code">Code from your email</label><input id="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" required><button>Sign in</button></form>
<section id="consent" hidden><h2 id="client-name"></h2><p>This connection can:</p><ul><li>Search and read your captured thoughts and compiled wiki.</li><li>Save new thoughts to your memory.</li></ul><p>It cannot change your task board through this connection.</p><p id="scopes"></p><button id="approve">Allow access</button><button id="deny" class="secondary">Deny</button></section>
<p id="status" role="status" aria-live="polite"></p></main>
<script nonce="${nonce}">
'use strict';
const config = ${data};
const byId = id => document.getElementById(id);
const authorizationId = new URL(location.href).searchParams.get('authorization_id');
let accessToken = null;
let accountEmail = '';
let priorRedirect = null;
function status(message) { byId('status').textContent = message; }
function redirectBack(url) {
  const target = new URL(url);
  if (target.origin !== 'https://chatgpt.com' || !(target.pathname === '/connector_platform_oauth_redirect' || /^\\/connector\\/oauth\\/[a-zA-Z0-9_-]+$/.test(target.pathname))) throw new Error('Unexpected return address.');
  accessToken = null;
  location.assign(target.href);
}
async function auth(path, body, authorized = false) {
  const headers = { apikey: config.publicKey, 'Content-Type': 'application/json' };
  if (authorized) { if (!accessToken) throw new Error('Sign in again.'); headers.Authorization = 'Bearer ' + accessToken; }
  const response = await fetch(config.supabaseUrl + '/auth/v1' + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, credentials: 'omit', cache: 'no-store', redirect: 'error' });
  const data = await response.json();
  if (!response.ok) throw new Error('Sign-in request failed. Check your email or code, then try again.');
  return data;
}
async function loadConsent() {
  const user = await auth('/user', null, true);
  if (user.id !== config.ownerId) { accessToken = null; throw new Error('This account cannot connect Brain Bank.'); }
  const details = await auth('/oauth/authorizations/' + authorizationId, null, true);
  // Never automatically follow a prior-grant response before explicit interaction.
  if (!details.authorization_id && details.redirect_url) {
    priorRedirect = details.redirect_url;
    byId('client-name').textContent = 'Continue to ChatGPT';
    byId('approve').textContent = 'Continue';
    byId('deny').hidden = true;
    byId('code-form').hidden = true; byId('consent').hidden = false;
    status('You have already approved this connection.'); return;
  }
  if (details.authorization_id !== authorizationId) throw new Error('Invalid authorization request.');
  if (details.client?.id !== config.clientId) throw new Error('This application is not approved for Brain Bank.');
  byId('client-name').textContent = details.client.name || 'ChatGPT';
  byId('scopes').textContent = 'Account permission: ' + (details.scope || 'email');
  byId('code-form').hidden = true; byId('consent').hidden = false; status('Review the access above.');
}
async function run(form, fn) {
  const buttons = form.querySelectorAll('button'); buttons.forEach(b => b.disabled = true);
  try { await fn(); } catch (error) { status(error.message || 'Unable to continue. Please restart from ChatGPT.'); }
  finally { buttons.forEach(b => b.disabled = false); }
}
if (!authorizationId || !/^[a-zA-Z0-9_-]{16,256}$/.test(authorizationId)) { byId('email-form').hidden = true; status('Start this connection from ChatGPT.'); }
byId('email-form').addEventListener('submit', event => { event.preventDefault(); run(event.currentTarget, async () => {
  accountEmail = byId('email').value.trim();
  await auth('/otp', { email: accountEmail, create_user: false });
  byId('email-form').hidden = true; byId('code-form').hidden = false; status('Enter the sign-in code from your email.');
}); });
byId('code-form').addEventListener('submit', event => { event.preventDefault(); run(event.currentTarget, async () => {
  const session = await auth('/verify', { email: accountEmail, token: byId('code').value.trim(), type: 'email' });
  byId('code').value = ''; accessToken = session.access_token; await loadConsent();
}); });
for (const action of ['approve', 'deny']) byId(action).addEventListener('click', () => run(byId('consent'), async () => {
  if (priorRedirect && action === 'approve') { redirectBack(priorRedirect); return; }
  const decision = await auth('/oauth/authorizations/' + authorizationId + '/consent', { action }, true);
  redirectBack(decision.redirect_url);
}));
</script></body></html>`, { headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src ${origin}; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
  } });
}
