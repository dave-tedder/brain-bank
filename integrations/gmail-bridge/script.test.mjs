import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('./script.gs', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context, { filename: 'script.gs' });

const cases = [
  ['allowlisted sender wins', 'alerts@openai.com', 'Your receipt', null],
  ['allowed subject wins', 'promo@e.godaddy.com', 'Security advisory', null],
  ['blocked vendor marketing', 'offers@orders.example-supply.com', 'Save 25% today', 'Blocked sender: orders.example-supply.com'],
  ['vendor receipt capture', 'receipts@orders.example-supply.com', 'Your order confirmation', null],
  ['generic blocked receipt', 'sales@example-shop.com', 'Your order confirmation', 'Blocked subject pattern: /order\\s*(confirmation|shipped|delivered|tracking)/i'],
  ['GoDaddy promo blocking', 'offers@e.godaddy.com', 'Limited-time domain discount', 'Blocked sender: e.godaddy.com'],
];

for (const [name, from, subject, expected] of cases) {
  test(name, () => {
    assert.equal(context.shouldSkip(from, subject), expected);
  });
}
