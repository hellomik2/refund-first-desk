// The buyer side never says "nothing was charged" unless that is known: a refusal or a buyer who turned back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { unpaidOrderView } from '../public/payment.js';

const wallet = (status) => ({ payment: 'SAVED_WALLET', paypal: null, storePayable: { status } });
const charged = /nothing was charged/i;

test('a new order being paid (PENDING_CAPTURE while the action runs) shows the payment in progress, not a refusal', () => {
  const v = unpaidOrderView(wallet('PENDING_CAPTURE'), { busy: true });
  assert.equal(v.kind, 'paying');
  assert.doesNotMatch(`${v.title} ${v.text}`, charged);
  assert.doesNotMatch(v.title, /refused/i);
});

test('a PENDING_CAPTURE order after the action ended, or any state the page does not know, never says nothing was charged', () => {
  for (const v of [unpaidOrderView(wallet('PENDING_CAPTURE')), unpaidOrderView(wallet('SOMETHING_NEW')), unpaidOrderView({ payment: 'SAVED_WALLET', paypal: null })]) {
    assert.equal(v.kind, 'unknown');
    assert.doesNotMatch(`${v.title} ${v.text}`, charged);
  }
});

test('only a clear refusal (CANCELLED) or a buyer who turned back says nothing was charged', () => {
  assert.equal(unpaidOrderView(wallet('CANCELLED')).kind, 'refused');
  assert.match(unpaidOrderView(wallet('CANCELLED')).text, charged);
  assert.match(unpaidOrderView({ payment: 'CONSENT_CHECKOUT', consentCancelled: true, paypal: null }).text, charged);
  const unconfirmed = unpaidOrderView(wallet('PAYMENT_UNCONFIRMED'));
  assert.equal(unconfirmed.kind, 'unconfirmed');
  assert.doesNotMatch(unconfirmed.text, charged);
  assert.equal(unpaidOrderView({ payment: 'CONSENT_CHECKOUT', paypal: null, storePayable: { status: 'PENDING_CAPTURE' } }).kind, 'consent-waiting');
  assert.equal(unpaidOrderView({ payment: 'SAVED_WALLET', paypal: { orderId: 'X' } }), null);
});

// fix/pay13 follow-up: a consent checkout whose capture was sent has an unknown result; it is not "waiting at PayPal".
const consent = (extra) => ({ payment: 'CONSENT_CHECKOUT', paypal: null, storePayable: { status: 'PENDING_CAPTURE' }, ...extra });

test('a consent checkout whose capture was sent shows the unknown-result card, not the waiting card', () => {
  for (const o of [consent({ captureSentAt: '2026-11-12T05:00:00Z', storePayable: { status: 'PAYMENT_UNCONFIRMED' } }), consent({ captureSentAt: '2026-11-12T05:00:00Z' })]) {
    const v = unpaidOrderView(o);
    assert.equal(v.kind, 'unconfirmed');
    assert.doesNotMatch(`${v.title} ${v.text}`, charged);
    assert.match(v.text, /approved at PayPal/);
  }
  assert.equal(unpaidOrderView(consent({})).kind, 'consent-waiting');
});

test('a capture PayPal answered as PENDING says PayPal is still processing it, not that PayPal did not answer', () => {
  const v = unpaidOrderView({ payment: 'SAVED_WALLET', paypal: null, pendingCaptureStatus: 'PENDING', storePayable: { status: 'PAYMENT_UNCONFIRMED' } });
  assert.equal(v.kind, 'unconfirmed');
  assert.match(`${v.title} ${v.text}`, /still processing/i);
  assert.doesNotMatch(v.text, /did not answer/i);
  assert.match(unpaidOrderView(wallet('PAYMENT_UNCONFIRMED')).text, /did not answer/);
});
