// codex UI 3: the one line under the two keys never states as found what the deep check card calls not verified.
import test from 'node:test';
import assert from 'node:assert/strict';
import { firstOff } from '../public/view-desk.js';

const inv = (verified) => ({ steps: [{ step: 5 }], firstDeviation: { kind: 'STEP', step: 5, condition: 'purchaseAuthorized', verified } });

test('the first-step line under the two keys: stated only when code found the quote in that step', () => {
  assert.match(firstOff(inv(true)), /Step 5<\/b> went off the mandate first/);
  const unverified = firstOff(inv(false));
  assert.doesNotMatch(unverified, /went off the mandate first/, 'an unverified answer is not stated as found');
  assert.match(unverified, /not verified/);
});

test('the first-step line names the broken condition as a failure, not as the condition itself', () => {
  assert.doesNotMatch(firstOff(inv(true)), /allowed to pay/);
  assert.match(firstOff(inv(true)), /paid without permission/);
});
