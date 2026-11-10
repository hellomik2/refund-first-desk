// What the browser may see of the PayPal call trace (codex second pass, H-3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { publicTrace } from '../src/paypal/client.js';

test('H-3. a saved-wallet id in a call path never reaches the browser', () => {
  const call = { at: '2026-11-10T00:00:00.000Z', label: 'delete-payment-token', method: 'DELETE', path: '/v3/vault/payment-tokens/8kx92736ab1234567', status: 204, ms: 120, debugId: 'abc', requestId: null };
  const shown = publicTrace(call);
  assert.equal(JSON.stringify(shown).includes('8kx92736ab1234567'), false);
  assert.equal(shown.path, '/v3/vault/payment-tokens/…');
  assert.equal(publicTrace({ ...call, path: '/v2/payments/refunds/7XY' }).path, '/v2/payments/refunds/7XY', 'other paths unchanged');
});
