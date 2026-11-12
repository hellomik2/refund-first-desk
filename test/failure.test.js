// A failed action is never silent. A workspace the server no longer has (Render's free server forgets
// everything when it sleeps and wakes) gets a message that stays, with a way to start again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { failureView } from '../public/failure.js';

test('an unknown workspace stays on screen, says why, and offers a fresh start', () => {
  const v = failureView({ code: 'BAD_WORKSPACE', message: 'Unknown workspace' });
  assert.equal(v.stays, true);
  assert.match(v.text, /restart/i);
  assert.match(v.text, /fresh workspace/i);
  assert.equal(v.restart, true);
});

test('any other failure shows its own message', () => {
  const v = failureView({ code: 'PAYPAL_ERROR', message: 'PayPal answered 422 INSTRUMENT_DECLINED' });
  assert.equal(v.restart, false);
  assert.match(v.text, /422 INSTRUMENT_DECLINED/);
  assert.match(failureView({}).text, /\S/, 'never an empty message');
});
