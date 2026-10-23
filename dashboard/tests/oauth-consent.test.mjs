import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { consentResponse } from '../src/lib/oauth-consent.js';
const config = { supabaseUrl: 'https://test.supabase.co', publicKey: 'sb_publishable_test', ownerId: 'owner', clientId: 'client' };
const authorizationId = 'abcdefghijklmnopqrstuv234567abcd';
async function page(responses = []) {
  const response = consentResponse(config);
  const html = await response.text();
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: false, textContent: '', addEventListener() {}, querySelectorAll: () => [] });
    return elements.get(id);
  };
  const destinations = [];
  const calls = [];
  const context = vm.createContext({ URL, document: { getElementById: get }, location: { href: `https://brain.test/oauth/consent?authorization_id=${authorizationId}`, assign: url => destinations.push(url) }, fetch: async (url, init) => {
    calls.push([url, init]);
    if (!responses.length) throw new Error('Unexpected fetch');
    return Response.json(responses.shift());
  } });
  vm.runInContext(html.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/)[1], context);
  vm.runInContext("accessToken = 'test-session'", context);
  return { response, html, context, get, destinations, calls };
}
test('configured consent uses native client id and name', async () => {
  const p = await page([{ id: 'owner' }, { authorization_id: authorizationId, client: { id: 'client', name: 'Example memory client' }, scope: 'email' }]);
  await vm.runInContext('loadConsent()', p.context);
  assert.deepEqual([p.get('client-name').textContent, p.get('consent').hidden], ['Example memory client', false]);
});
test('wrong owner cannot load consent', async () => {
  const p = await page([{ id: 'other' }]);
  await assert.rejects(vm.runInContext('loadConsent()', p.context), /account cannot/);
});
test('wrong client cannot load consent', async () => {
  const p = await page([{ id: 'owner' }, { authorization_id: authorizationId, client: { id: 'other' } }]);
  await assert.rejects(vm.runInContext('loadConsent()', p.context), /application is not approved/);
});
test('prior grant waits for explicit interaction', async () => {
  const p = await page([{ id: 'owner' }, { redirect_url: 'https://chatgpt.com/connector_platform_oauth_redirect?code=test' }]);
  await vm.runInContext('loadConsent()', p.context);
  assert.deepEqual([p.destinations.length, p.get('approve').textContent, p.get('deny').hidden], [0, 'Continue', true]);
});
test('redirect rejects attacker origin', async () => {
  const p = await page();
  assert.throws(() => vm.runInContext("redirectBack('https://attacker.test/connector_platform_oauth_redirect')", p.context), /Unexpected return/);
});
test('redirect rejects unexpected ChatGPT path', async () => {
  const p = await page();
  assert.throws(() => vm.runInContext("redirectBack('https://chatgpt.com/untrusted')", p.context), /Unexpected return/);
});
test('valid callback clears session and redirects', async () => {
  const p = await page();
  vm.runInContext("redirectBack('https://chatgpt.com/connector/oauth/test?code=abc')", p.context);
  assert.deepEqual([p.destinations, vm.runInContext('accessToken', p.context)], [['https://chatgpt.com/connector/oauth/test?code=abc'], null]);
});
test('service role key never reaches browser', async () => {
  const key = 'x.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.x';
  assert.equal(consentResponse({ ...config, publicKey: key }).status, 503);
});
test('consent is not frameable and not cached', async () => {
  const p = await page();
  assert.deepEqual([p.response.headers.get('x-frame-options'), p.response.headers.get('cache-control'), p.response.headers.get('content-security-policy').includes("frame-ancestors 'none'")], ['DENY', 'no-store', true]);
});

test('opaque authorization id opens sign-in', async () => {
  const p = await page();
  assert.equal(p.get('email-form').hidden, false);
});
