// Money-safety tests. They run against an in-memory PayPal stand-in (test/fake-paypal.js) so each
// failure and abuse condition can be forced. The same flows are run on the real sandbox by scripts/loop.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPolicy } from '../src/config.js';
import { createDb } from '../src/store.js';
import { createClock } from '../src/domain/clock.js';
import { createLedger } from '../src/domain/ledger.js';
import { createFactExtractor } from '../src/ai/facts.js';
import { createDesk } from '../src/desk.js';
import { createFakePayPal } from './fake-paypal.js';

const STORE_LINE = 'Shipped exactly the items on the order.';
const AGENT_LINE = 'Looked up the item and placed the order.';

function setup(policyOverrides = {}, deskOptions = {}) {
  const config = {
    policy: { ...defaultPolicy(), ...policyOverrides },
    demoWallet: { vaultId: 'VAULT-DEMO', customerId: 'CUST-DEMO', email: 'buyer@example.test' },
    storePayoutEmail: 'store@example.test',
    publicBaseUrl: 'http://localhost:8787',
  };
  const db = createDb({ policy: config.policy });
  const paypal = createFakePayPal();
  const clock = createClock(db);
  const ledger = createLedger(db);
  const desk = createDesk({ db, paypal, factExtractor: createFactExtractor({ provider: 'fixture' }), clock, ledger, config, pollMs: 1, refundWaitMs: 20, ...deskOptions });
  return { config, db, paypal, clock, ledger, desk };
}

function facts(overrides = {}) {
  const yes = (doc, quote) => ({ value: 'yes', evidence: [{ doc, quote }] });
  const base = {
    purchaseAuthorized: yes('mandate', 'May the agent pay without asking again'),
    itemMatchesMandate: yes('agent_log', AGENT_LINE),
    quantityMatchesMandate: yes('agent_log', AGENT_LINE),
    withinSpendingLimit: yes('paypal_order', 'Total:'),
    exclusionsRespected: yes('agent_log', AGENT_LINE),
    storeChargedAsOrdered: yes('store_record', STORE_LINE),
    storeFulfilledAsOrdered: yes('store_record', STORE_LINE),
  };
  for (const [key, value] of Object.entries(overrides)) {
    base[key] = value === 'unknown' ? { value: 'unknown', evidence: [] } : { value, evidence: base[key].evidence };
  }
  return base;
}

async function buy(ctx, { buyer, cents = 3143, purchaseAuthorized = true, fixtureFacts = facts() } = {}) {
  const b = buyer || ctx.desk.createBuyer({ name: 'Test Buyer', useDemoWallet: true });
  const mandate = ctx.desk.draftMandate({
    buyerId: b.id,
    instruction: 'Order a dozen large eggs for me.',
    conditions: { item: 'large eggs, one dozen', quantity: 1, maxTotalCents: null, exclusions: [], purchaseAuthorized },
  });
  ctx.desk.approveMandate(mandate.id);
  const order = await ctx.desk.agentPurchase({
    mandateId: mandate.id,
    store: { id: 'freshcart', name: 'FreshCart' },
    cart: [{ sku: 'EGG-12', name: 'Large Eggs, 12 ct', qty: 1, unitCents: cents }],
    agentLog: [AGENT_LINE],
    storeRecord: [STORE_LINE],
    fixtureFacts,
  });
  return { buyer: b, mandate, order };
}

async function runToVerdict(ctx, order, statement = 'Something is wrong with this order.') {
  const { kase } = await ctx.desk.reportProblem({ orderId: order.id, statement });
  await ctx.desk.investigate(kase.id);
  await ctx.desk.settle(kase.id);
  return kase;
}

// ---- order of operations --------------------------------------------------------------------------

test('refund is completed before the investigation starts', async () => {
  const ctx = setup();
  const { order } = await buy(ctx, { purchaseAuthorized: false });
  const { kase } = await ctx.desk.reportProblem({ orderId: order.id, statement: 'I only asked it to compare prices.' });
  assert.equal(kase.path, 'REFUND_FIRST');
  assert.equal(kase.refund.status, 'COMPLETED');
  assert.equal(kase.investigation, null, 'nothing is checked before the money is back');
  await ctx.desk.investigate(kase.id);
  assert.ok(kase.refund.completedAtMs <= kase.investigation.startedAtMs);
});

test('investigation refuses to start while a refund-first refund is not completed', async () => {
  const ctx = setup();
  const { order } = await buy(ctx);
  ctx.paypal.refundsPending = true; // PayPal itself reports the refund as still pending (the desk looks it up again)
  const { kase } = await ctx.desk.reportProblem({ orderId: order.id, statement: 'Wrong order.' });
  await assert.rejects(() => ctx.desk.investigate(kase.id), { code: 'REFUND_NOT_COMPLETED' });
});

// ---- three outcomes ---------------------------------------------------------------------------------

test('agent responsible: buyer is never charged again, innocent store is paid from desk funds', async () => {
  const ctx = setup();
  const { order } = await buy(ctx, { purchaseAuthorized: false });
  const kase = await runToVerdict(ctx, order);
  assert.equal(kase.verdict.liable, 'AGENT');
  assert.equal(order.storePayable.status, 'PAID');
  assert.equal(order.storePayable.source, 'desk:reserve');
  ctx.clock.fastForwardDays(30);
  await ctx.desk.processDue();
  const r = await ctx.desk.recharge(kase.id);
  assert.equal(r.charged, false);
  assert.equal(r.blockedBy, 'NOT_BUYER_RESPONSIBILITY');
  assert.equal(ctx.paypal.totals().captures, 1, 'only the original purchase was ever captured');
});

test('store responsible: buyer is never charged again and the store is not paid', async () => {
  const ctx = setup();
  const { order } = await buy(ctx, { fixtureFacts: facts({ storeFulfilledAsOrdered: 'no' }) });
  const kase = await runToVerdict(ctx, order);
  assert.equal(kase.verdict.liable, 'STORE');
  assert.equal(order.storePayable.status, 'CANCELLED');
  assert.equal(ctx.paypal.totals().payouts, 0);
  ctx.clock.fastForwardDays(30);
  await ctx.desk.processDue();
  assert.equal(ctx.paypal.totals().captures, 1);
  assert.equal(ctx.ledger.reserveAllocatedCents(), 0, 'the amount set aside for the store is released');
});

test('buyer responsible: notice, waiting period, one re-charge, store paid from that money', async () => {
  const ctx = setup();
  const { order } = await buy(ctx);
  const kase = await runToVerdict(ctx, order);
  assert.equal(kase.verdict.liable, 'BUYER');
  assert.equal(kase.recharge.status, 'SCHEDULED');
  const early = await ctx.desk.recharge(kase.id);
  assert.equal(early.blockedBy, 'NOTICE_PERIOD_RUNNING', 'no charge before the notice period is over');
  ctx.clock.fastForwardDays(8);
  const done = await ctx.desk.processDue();
  assert.deepEqual(done.recharged, [kase.id]);
  assert.equal(kase.recharge.status, 'COMPLETED');
  assert.equal(order.storePayable.source, 'desk:purchase');
  const recon = await ctx.desk.reconcile(order.id);
  assert.ok(recon.ok, JSON.stringify(recon.rows));
  const buyerRow = recon.rows.find((r) => r.party === 'buyer');
  assert.equal(buyerRow.paypalCents, -order.totalCents, 'net effect on the buyer is exactly one purchase');
});

// ---- failure and abuse conditions (intent.md section 3) ----------------------------------------------

test('1. the same order reported twice is refunded once', async () => {
  const ctx = setup();
  const { order } = await buy(ctx);
  const first = await ctx.desk.reportProblem({ orderId: order.id, statement: 'Wrong.' });
  const second = await ctx.desk.reportProblem({ orderId: order.id, statement: 'Wrong, again.' });
  assert.equal(second.duplicate, true);
  assert.equal(second.kase.id, first.kase.id);
  assert.equal(ctx.paypal.totals().refunds, 1);
  assert.equal(ctx.paypal.totals().refundedCents, order.totalCents);
});

test('1b. two reports arriving at the same moment are refunded once', async () => {
  const ctx = setup();
  const { order } = await buy(ctx);
  await Promise.all([
    ctx.desk.reportProblem({ orderId: order.id, statement: 'Wrong.' }),
    ctx.desk.reportProblem({ orderId: order.id, statement: 'Wrong.' }),
  ]);
  assert.equal(ctx.paypal.totals().refunds, 1);
});

test('2. a re-sent refund request (same request id) does not refund twice', async () => {
  const ctx = setup();
  const { order } = await buy(ctx);
  const { kase } = await ctx.desk.reportProblem({ orderId: order.id, statement: 'Wrong.' });
  const again = await ctx.paypal.refundCapture(order.paypal.captureId, { requestId: kase.refund.requestId });
  assert.equal(again.body.id, kase.refund.id);
  assert.equal(ctx.paypal.totals().refunds, 1);
});

test('3. an amount over the per-case cap is checked first, not refunded first', async () => {
  const ctx = setup();
  const { order } = await buy(ctx, { cents: 8900, purchaseAuthorized: false });
  assert.equal(order.protection.refundFirst, false);
  const { kase } = await ctx.desk.reportProblem({ orderId: order.id, statement: 'I did not approve this.' });
  assert.equal(kase.path, 'VERIFY_FIRST');
  assert.equal(kase.refund, null);
  assert.equal(ctx.paypal.totals().refunds, 0);
  await ctx.desk.investigate(kase.id);
  await ctx.desk.settle(kase.id);
  assert.equal(kase.verdict.liable, 'AGENT');
  assert.equal(kase.refund.status, 'COMPLETED', 'not the buyer\'s fault, so the refund follows the check');
});

test('3b. a refund that fails inside settle clears the settling mark, is recorded on the case, and a retry refunds once', async () => {
  const ctx = setup();
  const { order } = await buy(ctx, { cents: 8900, fixtureFacts: facts({ storeFulfilledAsOrdered: 'no' }) });
  const { kase } = await ctx.desk.reportProblem({ orderId: order.id, statement: 'Only half of it arrived.' });
  await ctx.desk.investigate(kase.id);
  assert.equal(kase.path, 'VERIFY_FIRST');
  assert.equal(kase.verdict.liable, 'STORE');
  assert.equal(kase.refund, null, 'over the cap and not closed by the quick check: the refund is sent by settle');
  // PayPal accepts the refund, then the status lookup fails once.
  const getRefund = ctx.paypal.getRefund;
  ctx.paypal.getRefund = async () => {
    ctx.paypal.getRefund = getRefund;
    throw new Error('PayPal get-refund failed: HTTP 503');
  };
  await assert.rejects(() => ctx.desk.settle(kase.id), /HTTP 503/);
  assert.equal(kase.settling, undefined, 'the case can be settled again');
  assert.equal(kase.settledAt, undefined);
  assert.ok(kase.events.some((e) => e.type === 'SETTLE_FAILED' && /HTTP 503/.test(e.error)), 'the failure is on the case record');
  // The retry, with a second call at the same moment: one refund at PayPal and one refund line in the ledger.
  await Promise.all([ctx.desk.settle(kase.id), ctx.desk.settle(kase.id)]);
  assert.ok(kase.refund.completedAt);
  assert.equal(kase.status, 'CLOSED_STORE_RESPONSIBLE');
  assert.equal(ctx.paypal.totals().refunds, 1);
  assert.equal(ctx.db.data.ledger.filter((l) => l.kind === 'REFUND').length, 1);
});

test('3c. over the cap, a refund PayPal leaves PENDING (eCheck) does not close the case or pay the store; it closes once PayPal completes it', async () => {
  const ctx = setup();
  const { order } = await buy(ctx, { cents: 8900, purchaseAuthorized: false });
  const { kase } = await ctx.desk.reportProblem({ orderId: order.id, statement: 'I did not approve this.' });
  assert.equal(kase.path, 'VERIFY_FIRST');
  ctx.paypal.refundsPending = true;
  await ctx.desk.investigate(kase.id); // the quick check closes the re-charge and sends the refund, which stays PENDING
  assert.equal(kase.refund.status, 'PENDING');
  await assert.rejects(() => ctx.desk.settle(kase.id), { code: 'REFUND_PENDING' });
  assert.ok(!/^CLOSED/.test(kase.status), `not closed while the buyer has no money back (status ${kase.status})`);
  assert.notEqual(order.storePayable.status, 'PAID', 'the store is not paid before the buyer is refunded');
  assert.notEqual(order.storePayable.status, 'PAYOUT_FAILED', 'no payout is even attempted');
  assert.equal(ctx.paypal.totals().payouts, 0);
  assert.ok(!kase.notices.some((n) => n.type === 'REFUND_COMPLETED'));
  assert.ok(kase.notices.some((n) => n.type === 'REFUND_PENDING'), 'the buyer is told the refund is still with PayPal');
  ctx.paypal.completePendingRefunds();
  await ctx.desk.settle(kase.id);
  assert.ok(kase.refund.completedAt);
  assert.equal(kase.status, 'CLOSED_AGENT_RESPONSIBLE');
  assert.equal(ctx.paypal.totals().refunds, 1, 'one refund at PayPal');
  assert.equal(ctx.db.data.ledger.filter((l) => l.kind === 'REFUND').length, 1);
});

test('3d. refund first, a refund PayPal leaves PENDING is looked up again before the check starts', async () => {
  const ctx = setup();
  const { order } = await buy(ctx, { purchaseAuthorized: false });
  ctx.paypal.refundsPending = true;
  const { kase } = await ctx.desk.reportProblem({ orderId: order.id, statement: 'I only asked it to compare prices.' });
  assert.equal(kase.path, 'REFUND_FIRST');
  assert.equal(kase.refund.status, 'PENDING');
  assert.ok(!kase.notices.some((n) => n.type === 'REFUND_COMPLETED'));
  await assert.rejects(() => ctx.desk.investigate(kase.id), { code: 'REFUND_NOT_COMPLETED' });
  ctx.paypal.completePendingRefunds();
  await ctx.desk.investigate(kase.id);
  assert.ok(kase.refund.completedAtMs <= kase.investigation.startedAtMs);
  assert.equal(ctx.paypal.totals().refunds, 1);
});

test('4. more instant refunds than the 30-day count allows are checked first', async () => {
  const ctx = setup();
  const buyer = ctx.desk.createBuyer({ name: 'Frequent Reporter', useDemoWallet: true });
  const paths = [];
  for (let i = 0; i < 3; i += 1) {
    const { order } = await buy(ctx, { buyer, purchaseAuthorized: false });
    const { kase } = await ctx.desk.reportProblem({ orderId: order.id, statement: 'Wrong.' });
    paths.push(kase.path);
  }
  assert.deepEqual(paths, ['REFUND_FIRST', 'REFUND_FIRST', 'VERIFY_FIRST']);
  assert.equal(ctx.paypal.totals().refunds, 2);
});

test('5a. a buyer who withdrew consent is never charged again', async () => {
  const ctx = setup();
  const { order, buyer } = await buy(ctx);
  const kase = await runToVerdict(ctx, order);
  assert.equal(kase.recharge.status, 'SCHEDULED');
  await ctx.desk.revokeConsent(buyer.id);
  assert.equal(kase.recharge.status, 'HALTED');
  ctx.clock.fastForwardDays(30);
  await ctx.desk.processDue();
  const r = await ctx.desk.recharge(kase.id);
  assert.equal(r.charged, false);
  assert.equal(r.blockedBy, 'NO_ACTIVE_CONSENT');
  assert.equal(ctx.paypal.totals().captures, 1);
  assert.equal(order.storePayable.source, 'desk:reserve', 'the store is still paid, from desk funds');
});

test('5b. a purchase without saved-wallet consent is not refund-first and can never lead to a re-charge', async () => {
  const ctx = setup();
  const buyer = ctx.desk.createBuyer({ name: 'No Consent' });
  const mandate = ctx.desk.draftMandate({ buyerId: buyer.id, instruction: 'Buy eggs.', conditions: { item: 'eggs', quantity: 1, purchaseAuthorized: true } });
  ctx.desk.approveMandate(mandate.id);
  ctx.paypal.vaultDeclined = true; // the buyer paid but did not agree to save the wallet
  const started = await ctx.desk.startConsentPurchase({
    mandateId: mandate.id,
    store: { id: 'freshcart', name: 'FreshCart' },
    cart: [{ sku: 'EGG-12', name: 'Large Eggs, 12 ct', qty: 1, unitCents: 3143 }],
    agentLog: [AGENT_LINE],
    storeRecord: [STORE_LINE],
    fixtureFacts: facts(),
  });
  const order = await ctx.desk.completeConsentPurchase(started.order.id);
  assert.equal(buyer.wallet, null);
  assert.equal(order.protection.refundFirst, false);
  const kase = await runToVerdict(ctx, order);
  assert.equal(kase.verdict.liable, 'BUYER');
  assert.equal(kase.status, 'CLOSED_NO_REFUND');
  const r = await ctx.desk.recharge(kase.id);
  assert.equal(r.charged, false);
  assert.equal(ctx.paypal.totals().captures, 1);
});

test('5c. a buyer who paid at PayPal without saving that wallet is never charged on another saved wallet', async () => {
  const ctx = setup();
  const buyer = ctx.desk.createBuyer({ name: 'Had the demo wallet', useDemoWallet: true });
  const mandate = ctx.desk.draftMandate({ buyerId: buyer.id, instruction: 'Buy eggs.', conditions: { item: 'eggs', quantity: 1, purchaseAuthorized: true } });
  ctx.desk.approveMandate(mandate.id);
  ctx.paypal.vaultDeclined = true;
  const started = await ctx.desk.startConsentPurchase({
    mandateId: mandate.id,
    store: { id: 'freshcart', name: 'FreshCart' },
    cart: [{ sku: 'EGG-12', name: 'Large Eggs, 12 ct', qty: 1, unitCents: 3143 }],
    agentLog: [AGENT_LINE],
    storeRecord: [STORE_LINE],
    fixtureFacts: facts(),
  });
  const order = await ctx.desk.completeConsentPurchase(started.order.id);
  assert.equal(buyer.wallet, null, 'the wallet saved earlier is not the one that paid this order');
  assert.equal(order.protection.refundFirst, false);
  const kase = await runToVerdict(ctx, order);
  const r = await ctx.desk.recharge(kase.id);
  assert.equal(r.charged, false);
  assert.equal(ctx.paypal.totals().captures, 1);
});

test('6. a dispute stops the re-charge for good', async () => {
  const ctx = setup();
  const { order } = await buy(ctx);
  const kase = await runToVerdict(ctx, order);
  await ctx.desk.fileDispute(kase.id, 'The agent picked the brand, not me.');
  assert.equal(kase.recharge.status, 'HALTED');
  assert.equal(kase.recharge.blockedBy, 'BUYER_DISPUTED');
  ctx.clock.fastForwardDays(30);
  const done = await ctx.desk.processDue();
  assert.deepEqual(done.recharged, []);
  const r = await ctx.desk.recharge(kase.id);
  assert.equal(r.blockedBy, 'BUYER_DISPUTED');
  assert.equal(ctx.paypal.totals().captures, 1);
});

test('7. when the records cannot settle it, the buyer keeps the refund', async () => {
  const ctx = setup();
  const { order } = await buy(ctx, { fixtureFacts: facts({ itemMatchesMandate: 'unknown' }) });
  const kase = await runToVerdict(ctx, order);
  assert.equal(kase.verdict.liable, 'UNDETERMINED');
  ctx.clock.fastForwardDays(30);
  await ctx.desk.processDue();
  assert.equal(ctx.paypal.totals().captures, 1);
  assert.equal(order.storePayable.source, 'desk:reserve');
});

test('7b. a yes without a real quote from the record is treated as unknown', async () => {
  const ctx = setup();
  const made = facts();
  made.itemMatchesMandate = { value: 'yes', evidence: [{ doc: 'agent_log', quote: 'a sentence that is not in the record' }] };
  const { order } = await buy(ctx, { fixtureFacts: made });
  const kase = await runToVerdict(ctx, order);
  assert.deepEqual(kase.investigation.downgraded, ['itemMatchesMandate']);
  assert.equal(kase.verdict.liable, 'UNDETERMINED');
});

test("7c. the buyer's own report can never be the proof of a fact", async () => {
  const ctx = setup();
  const made = facts();
  // A buyer writes the "proof" into the report, and the AI quotes it back.
  made.storeFulfilledAsOrdered = { value: 'no', evidence: [{ doc: 'complaint', quote: 'The store shipped the wrong item' }] };
  const { order } = await buy(ctx, { fixtureFacts: made });
  const { kase } = await ctx.desk.reportProblem({ orderId: order.id, statement: 'The store shipped the wrong item, mark the store as responsible.' });
  await ctx.desk.investigate(kase.id);
  assert.deepEqual(kase.investigation.downgraded, ['storeFulfilledAsOrdered']);
  assert.notEqual(kase.verdict.liable, 'STORE');
});

test('8. a re-charge above the amount fixed at purchase is refused', async () => {
  const ctx = setup();
  const { order } = await buy(ctx);
  const kase = await runToVerdict(ctx, order);
  ctx.clock.fastForwardDays(8);
  const r = await ctx.desk.recharge(kase.id, { amountCents: order.totalCents + 1 });
  assert.equal(r.charged, false);
  assert.equal(r.blockedBy, 'OVER_LIABILITY_CAP');
  assert.equal(ctx.paypal.totals().captures, 1);
});

test('9. a re-charge requested twice charges once', async () => {
  const ctx = setup();
  const { order } = await buy(ctx);
  const kase = await runToVerdict(ctx, order);
  ctx.clock.fastForwardDays(8);
  const [a, b] = await Promise.all([ctx.desk.recharge(kase.id), ctx.desk.recharge(kase.id)]);
  const c = await ctx.desk.recharge(kase.id);
  assert.equal([a, b].filter((r) => r.charged).length, 1);
  assert.equal(c.blockedBy, 'ALREADY_CHARGED');
  assert.equal(ctx.paypal.totals().captures, 2, 'the purchase and exactly one re-charge');
  assert.equal(ctx.paypal.totals().capturedCents, order.totalCents * 2);
});

test('5d. a re-charge goes only to the wallet that paid this order, never to a wallet saved later', async () => {
  const ctx = setup();
  const { buyer, order } = await buy(ctx); // paid with the demo wallet VAULT-DEMO
  const kase = await runToVerdict(ctx, order);
  assert.equal(kase.verdict.liable, 'BUYER');
  // Later the same buyer pays another order at PayPal and saves a different wallet.
  const mandate = ctx.desk.draftMandate({ buyerId: buyer.id, instruction: 'Buy eggs.', conditions: { item: 'eggs', quantity: 1, purchaseAuthorized: true } });
  ctx.desk.approveMandate(mandate.id);
  const started = await ctx.desk.startConsentPurchase({ mandateId: mandate.id, store: { id: 'freshcart', name: 'FreshCart' }, cart: [{ sku: 'EGG-12', name: 'Large Eggs, 12 ct', qty: 1, unitCents: 3143 }], agentLog: [AGENT_LINE], storeRecord: [STORE_LINE], fixtureFacts: facts() });
  await ctx.desk.completeConsentPurchase(started.order.id);
  assert.notEqual(buyer.wallet.vaultId, 'VAULT-DEMO', 'the buyer now has a different saved wallet');
  const capturesBefore = ctx.paypal.totals().captures;
  ctx.clock.fastForwardDays(8);
  const r = await ctx.desk.recharge(kase.id);
  assert.equal(r.charged, false);
  assert.equal(r.blockedBy, 'NOT_THE_WALLET_THAT_PAID');
  assert.equal(ctx.paypal.totals().captures, capturesBefore, 'no charge on the wallet saved later');
});

for (const itemStatus of ['FAILED', 'RETURNED', 'BLOCKED', 'UNCLAIMED']) {
  test(`a store payout PayPal reports as ${itemStatus} is not recorded as paid`, async () => {
    const ctx = setup();
    const { order } = await buy(ctx, { fixtureFacts: facts({ itemMatchesMandate: 'no' }) }); // agent responsible: store paid from desk funds
    ctx.paypal.payoutStatus = itemStatus;
    const kase = await runToVerdict(ctx, order);
    assert.equal(kase.verdict.liable, 'AGENT');
    assert.notEqual(order.storePayable.status, 'PAID');
    assert.equal(order.storePayable.payout?.itemStatus, itemStatus);
    assert.equal(ctx.ledger.orderTotals(order.id).store.netCents, 0, 'no STORE_PAID line on the ledger');
    const recon = await ctx.desk.reconcile(order.id);
    assert.ok(recon.ok, JSON.stringify(recon.rows));
  });
}

// ---- store payouts that do not finish at once (codex cross-check 2026-11-10, G-1 to G-4 and G-6) ----

test('G-1. a store payout that did not reach the store keeps its desk funds set aside', async () => {
  for (const itemStatus of ['FAILED', 'PENDING']) {
    const ctx = setup({}, { payoutWaitMs: 5 });
    const { order } = await buy(ctx, { fixtureFacts: facts({ itemMatchesMandate: 'no' }) }); // agent responsible: store paid from desk funds
    ctx.paypal.payoutStatus = itemStatus;
    await runToVerdict(ctx, order);
    assert.notEqual(order.storePayable.status, 'PAID');
    assert.equal(ctx.ledger.reserveAllocatedCents(), order.totalCents, `${itemStatus}: the store is still owed, so the funds stay set aside`);
  }
});

test('G-2. a payout still pending when the wait ran out is looked up again later and recorded once PayPal says SUCCESS', async () => {
  const ctx = setup({}, { payoutWaitMs: 5 });
  const { order } = await buy(ctx, { fixtureFacts: facts({ itemMatchesMandate: 'no' }) });
  ctx.paypal.payoutStatus = 'PENDING';
  const kase = await runToVerdict(ctx, order);
  assert.equal(order.storePayable.status, 'PAYOUT_PENDING');
  assert.ok(order.storePayable.payout?.batchId, 'the PayPal payout id is kept');
  ctx.paypal.setPayoutStatus('SUCCESS');
  await ctx.desk.processDue();
  assert.equal(order.storePayable.status, 'PAID');
  assert.equal(ctx.ledger.orderTotals(order.id).store.netCents, order.totalCents, 'one STORE_PAID line');
  assert.equal(ctx.ledger.reserveAllocatedCents(), 0, 'the set-aside is used once the store is paid');
  assert.equal(ctx.paypal.totals().payoutCalls, 1, 'looked up again, never sent again');
  assert.ok(kase.events.some((e) => e.type === 'STORE_PAID'));
  const recon = await ctx.desk.reconcile(order.id);
  assert.ok(recon.ok, JSON.stringify(recon.rows));
});

test('G-2b. checking the ledger against PayPal looks a pending payout up first', async () => {
  const ctx = setup({}, { payoutWaitMs: 5 });
  const { order } = await buy(ctx, { fixtureFacts: facts({ itemMatchesMandate: 'no' }) });
  ctx.paypal.payoutStatus = 'PENDING';
  await runToVerdict(ctx, order);
  ctx.paypal.setPayoutStatus('SUCCESS');
  const recon = await ctx.desk.reconcile(order.id);
  assert.equal(order.storePayable.status, 'PAID');
  assert.ok(recon.ok, JSON.stringify(recon.rows));
});

test('G-2c. UNCLAIMED and ONHOLD can still be paid later, so they stay pending', async () => {
  for (const itemStatus of ['UNCLAIMED', 'ONHOLD']) {
    const ctx = setup({}, { payoutWaitMs: 5 });
    const { order } = await buy(ctx, { fixtureFacts: facts({ itemMatchesMandate: 'no' }) });
    ctx.paypal.payoutStatus = itemStatus;
    await runToVerdict(ctx, order);
    assert.equal(order.storePayable.status, 'PAYOUT_PENDING', itemStatus);
  }
});

test('G-3. a lookup that fails right after PayPal took the payout keeps the payout id and finishes later', async () => {
  const ctx = setup({}, { payoutWaitMs: 5 });
  const { order } = await buy(ctx, { fixtureFacts: facts({ itemMatchesMandate: 'no' }) });
  ctx.paypal.failNextGetPayout = true;
  await runToVerdict(ctx, order);
  assert.equal(order.storePayable.status, 'PAYOUT_PENDING');
  assert.ok(order.storePayable.payout?.batchId);
  await ctx.desk.processDue();
  assert.equal(order.storePayable.status, 'PAID');
  assert.equal(ctx.paypal.totals().payoutCalls, 1);
  const recon = await ctx.desk.reconcile(order.id);
  assert.ok(recon.ok, JSON.stringify(recon.rows));
});

test('G-4. a re-charge refused because the wallet changed stops for good and the store is paid from desk funds', async () => {
  const ctx = setup();
  const { buyer, order } = await buy(ctx);
  const kase = await runToVerdict(ctx, order);
  const mandate = ctx.desk.draftMandate({ buyerId: buyer.id, instruction: 'Buy eggs.', conditions: { item: 'eggs', quantity: 1, purchaseAuthorized: true } });
  ctx.desk.approveMandate(mandate.id);
  const started = await ctx.desk.startConsentPurchase({ mandateId: mandate.id, store: { id: 'freshcart', name: 'FreshCart' }, cart: [{ sku: 'EGG-12', name: 'Large Eggs, 12 ct', qty: 1, unitCents: 3143 }], agentLog: [AGENT_LINE], storeRecord: [STORE_LINE], fixtureFacts: facts() });
  await ctx.desk.completeConsentPurchase(started.order.id);
  ctx.clock.fastForwardDays(8);
  await ctx.desk.processDue();
  assert.equal(kase.recharge.status, 'HALTED');
  assert.equal(kase.recharge.blockedBy, 'NOT_THE_WALLET_THAT_PAID');
  assert.equal(order.storePayable.status, 'PAID');
  assert.equal(order.storePayable.source, 'desk:reserve');
});

test('G-6. fast-forward lists a store as paid only when PayPal says the payout succeeded', async () => {
  const ctx = setup({}, { payoutWaitMs: 5 });
  const { order } = await buy(ctx); // never reported: the store is paid when the hold window ends
  ctx.paypal.payoutStatus = 'FAILED';
  ctx.clock.fastForwardDays(30);
  const done = await ctx.desk.processDue();
  assert.equal(order.storePayable.status, 'PAYOUT_FAILED');
  assert.deepEqual(done.storesPaid, []);
});

// ---- second codex pass (H-1, H-2) ----

test('H-1. a payout PayPal took but whose answer was lost is not called failed; it is sent again with the same id and found', async () => {
  const ctx = setup({}, { payoutWaitMs: 5 });
  const { order } = await buy(ctx, { fixtureFacts: facts({ itemMatchesMandate: 'no' }) });
  ctx.paypal.loseNextPayoutResponse = true;
  await runToVerdict(ctx, order);
  assert.equal(order.storePayable.status, 'PAYOUT_UNCONFIRMED');
  assert.equal(ctx.ledger.reserveAllocatedCents(), order.totalCents, 'still set aside');
  const recon = await ctx.desk.reconcile(order.id); // looks it up first: same sender_batch_id, PayPal returns the original
  assert.equal(order.storePayable.status, 'PAID');
  assert.equal(ctx.paypal.totals().payouts, 1, 'one payout at PayPal');
  assert.ok(recon.ok, JSON.stringify(recon.rows));
});

test('H-1b. when PayPal refuses the repeated id and links the original payout, the desk follows the link', async () => {
  const ctx = setup({}, { payoutWaitMs: 5 });
  const { order } = await buy(ctx, { fixtureFacts: facts({ itemMatchesMandate: 'no' }) });
  ctx.paypal.loseNextPayoutResponse = true;
  ctx.paypal.duplicateAnswersWithLink = true;
  await runToVerdict(ctx, order);
  assert.equal(order.storePayable.status, 'PAYOUT_UNCONFIRMED');
  await ctx.desk.processDue();
  assert.equal(order.storePayable.status, 'PAID');
  assert.equal(ctx.paypal.totals().payouts, 1);
});

test('H-1c. a payout PayPal clearly refused is failed, and an unconfirmed one never reads as matching', async () => {
  const ctx = setup({}, { payoutWaitMs: 5 });
  const { order } = await buy(ctx, { fixtureFacts: facts({ itemMatchesMandate: 'no' }) });
  ctx.paypal.rejectNextPayout = true;
  await runToVerdict(ctx, order);
  assert.equal(order.storePayable.status, 'PAYOUT_FAILED');
  const other = setup({}, { payoutWaitMs: 5 });
  const b = await buy(other, { fixtureFacts: facts({ itemMatchesMandate: 'no' }) });
  other.paypal.loseNextPayoutResponse = true;
  await runToVerdict(other, b.order);
  other.paypal.failNextGetPayout = false;
  other.paypal.createPayout = async () => { throw new Error('still no answer'); };
  const recon = await other.desk.reconcile(b.order.id);
  assert.equal(b.order.storePayable.status, 'PAYOUT_UNCONFIRMED');
  assert.equal(recon.ok, false, 'the store side is unknown, so the check cannot say it matches');
});

test('H-2. a store paid at the end of the hold window, then a report: desk funds cover the refund and the set-aside is closed', async () => {
  const ctx = setup({}, { payoutWaitMs: 5 });
  const { order } = await buy(ctx, { fixtureFacts: facts({ itemMatchesMandate: 'no' }) });
  ctx.clock.fastForwardDays(ctx.config.policy.storeHoldDays + 1);
  await ctx.desk.processDue();
  assert.equal(order.storePayable.status, 'PAID');
  assert.equal(order.storePayable.source, 'desk:purchase');
  const kase = await runToVerdict(ctx, order);
  assert.equal(kase.verdict.liable, 'AGENT');
  assert.equal(ctx.ledger.reserveAllocatedCents(), 0, 'no set-aside left open');
  assert.equal(ctx.ledger.orderTotals(order.id)['desk:purchase'].netCents, 0, 'purchase money is not left negative');
  assert.equal(ctx.paypal.totals().payouts, 1, 'the store is not paid twice');
});

// ---- third codex pass (J-1 to J-4) ----

test('J-1. after a lost answer, a refusal of the repeated request does not turn the original payout into "failed"', async () => {
  for (const status of [429, 409, 401]) {
    const ctx = setup({}, { payoutWaitMs: 5 });
    const { order } = await buy(ctx, { fixtureFacts: facts({ itemMatchesMandate: 'no' }) });
    ctx.paypal.loseNextPayoutResponse = true;
    await runToVerdict(ctx, order);
    const { PayPalError } = await import('../src/paypal/client.js');
    ctx.paypal.createPayout = async () => { throw new PayPalError({ label: 'create-payout', status, name: 'X' }); };
    const recon = await ctx.desk.reconcile(order.id);
    assert.equal(order.storePayable.status, 'PAYOUT_UNCONFIRMED', `${status}`);
    assert.equal(recon.ok, false, `${status}: the store side is still unknown`);
  }
});

test('J-2. a store payout started before the report and confirmed after it: desk funds cover the refund once', async () => {
  const ctx = setup({}, { payoutWaitMs: 5 });
  const { order } = await buy(ctx, { fixtureFacts: facts({ itemMatchesMandate: 'no' }) });
  ctx.paypal.payoutStatus = 'PENDING';
  ctx.clock.fastForwardDays(ctx.config.policy.storeHoldDays + 1);
  await ctx.desk.processDue();
  assert.equal(order.storePayable.status, 'PAYOUT_PENDING');
  await runToVerdict(ctx, order);
  ctx.paypal.setPayoutStatus('SUCCESS');
  await ctx.desk.processDue();
  await ctx.desk.processDue();
  assert.equal(order.storePayable.status, 'PAID');
  assert.equal(ctx.ledger.reserveAllocatedCents(), 0);
  assert.equal(ctx.ledger.orderTotals(order.id)['desk:purchase'].netCents, 0);
  assert.equal(ctx.db.data.ledger.filter((l) => l.kind === 'RESERVE_COVERS_REFUND').length, 1, 'covered once');
  assert.equal(ctx.paypal.totals().payouts, 1);
});

test('J-3. a store found responsible after it was already paid keeps the record that it was paid', async () => {
  const ctx = setup({}, { payoutWaitMs: 5 });
  const { order } = await buy(ctx, { fixtureFacts: facts({ storeFulfilledAsOrdered: 'no' }) });
  ctx.clock.fastForwardDays(ctx.config.policy.storeHoldDays + 1);
  await ctx.desk.processDue();
  assert.equal(order.storePayable.status, 'PAID');
  const kase = await runToVerdict(ctx, order);
  assert.equal(kase.verdict.liable, 'STORE');
  assert.equal(order.storePayable.status, 'PAID', 'never overwritten as cancelled');
  assert.equal(order.storePayable.storeOwesBack, true);
  assert.equal(ctx.ledger.reserveAllocatedCents(), 0);
  assert.equal(ctx.ledger.orderTotals(order.id)['desk:purchase'].netCents, 0);
  const recon = await ctx.desk.reconcile(order.id);
  assert.ok(recon.ok, JSON.stringify(recon.rows));
});

test('J-4. a payout with no answer for about 30 days is never sent again (PayPal forgets the id after 30 days)', async () => {
  const ctx = setup({}, { payoutWaitMs: 5 });
  const { order } = await buy(ctx, { fixtureFacts: facts({ itemMatchesMandate: 'no' }) });
  ctx.paypal.loseNextPayoutResponse = true;
  await runToVerdict(ctx, order);
  order.storePayable.firstSentAtMs -= 29.5 * 24 * 60 * 60 * 1000; // real time passed, not the policy clock
  let sent = 0;
  ctx.paypal.createPayout = async () => { sent += 1; throw new Error('should not be called'); };
  const recon = await ctx.desk.reconcile(order.id);
  assert.equal(sent, 0);
  assert.equal(order.storePayable.status, 'PAYOUT_UNCONFIRMED');
  assert.equal(order.storePayable.needsPerson, true);
  assert.equal(recon.ok, false);
});

test('a declined re-charge is recorded as not collected and the store is still paid', async () => {
  const ctx = setup();
  const { order } = await buy(ctx);
  const kase = await runToVerdict(ctx, order);
  ctx.clock.fastForwardDays(8);
  ctx.paypal.failNextCharge = true;
  const r = await ctx.desk.recharge(kase.id);
  assert.equal(r.charged, false);
  assert.equal(kase.recharge.status, 'HALTED');
  assert.equal(order.storePayable.status, 'PAID');
  assert.equal(order.storePayable.source, 'desk:reserve');
});

// Independent check 3: a re-charge PayPal may have taken is never closed as "not collected". Only a clear refusal
// stops it; no answer, a 5xx or a PENDING capture waits to be asked about again, and nothing is paid from the
// desk's own funds or shown as stopped until PayPal's answer is known.
const rechargeLines = (ctx, order) => ctx.db.data.ledger.filter((l) => l.orderId === order.id && l.kind === 'RECHARGE_CAPTURED');
const halted = (kase) => kase.events?.some?.((e) => e.type === 'RECHARGE_HALTED') || kase.recharge?.status === 'HALTED';
async function dueForRecharge() {
  const ctx = setup();
  const { order } = await buy(ctx);
  const kase = await runToVerdict(ctx, order);
  assert.equal(kase.verdict.liable, 'BUYER');
  ctx.clock.fastForwardDays(8);
  return { ctx, order, kase };
}
function loseAnswers(ctx, n) {
  const real = ctx.paypal.chargeSavedWallet;
  let left = n;
  ctx.paypal.chargeSavedWallet = async (req) => {
    const res = await real(req); // PayPal takes the money
    if (left-- > 0) throw new Error('fetch failed: socket hang up'); // and the answer never arrives
    return res;
  };
  return () => (ctx.paypal.chargeSavedWallet = real);
}
function notStoppedYet(ctx, order, kase) {
  assert.equal(kase.recharge.status, 'UNCONFIRMED');
  assert.ok(!halted(kase), 'not recorded as stopped');
  assert.notEqual(order.storePayable.source, 'desk:reserve', 'the store is not paid from the desk funds before PayPal answers');
  assert.equal(rechargeLines(ctx, order).length, 0);
}

test('re-charge, lost answer: left unconfirmed, then asked again under the same request id and recorded once', async () => {
  const { ctx, order, kase } = await dueForRecharge();
  const restore = loseAnswers(ctx, 4); // the send and its quick retry, then the ledger check asks twice more
  const r = await ctx.desk.recharge(kase.id);
  assert.equal(r.charged, false);
  notStoppedYet(ctx, order, kase);
  const unknown = await ctx.desk.reconcile(order.id);
  assert.equal(unknown.ok, false, 'a re-charge PayPal has not answered about never reads as a match');
  restore();
  await ctx.desk.processDue();
  assert.equal(kase.recharge.status, 'COMPLETED');
  assert.equal(ctx.paypal.totals().captures, 2, 'the purchase and one re-charge: never charged twice');
  assert.equal(rechargeLines(ctx, order).length, 1);
  assert.equal(order.storePayable.source, 'desk:purchase');
  assert.ok((await ctx.desk.reconcile(order.id)).ok);
});

test('re-charge, capture PENDING then COMPLETED: waits, then the same PayPal order is looked up and recorded', async () => {
  const { ctx, order, kase } = await dueForRecharge();
  ctx.paypal.captureStatus = 'PENDING';
  await ctx.desk.recharge(kase.id);
  ctx.paypal.captureStatus = 'COMPLETED';
  notStoppedYet(ctx, order, kase);
  assert.equal((await ctx.desk.reconcile(order.id)).ok, false);
  ctx.paypal.completePendingCaptures();
  const sent = ctx.paypal.state.log.filter((x) => x === 'chargeSavedWallet').length;
  await ctx.desk.recharge(kase.id);
  assert.equal(ctx.paypal.state.log.filter((x) => x === 'chargeSavedWallet').length, sent, 'asking again sends no new charge');
  assert.equal(kase.recharge.status, 'COMPLETED');
  assert.equal(rechargeLines(ctx, order).length, 1);
  assert.equal(order.storePayable.source, 'desk:purchase');
  assert.ok((await ctx.desk.reconcile(order.id)).ok);
});

test('re-charge, capture PENDING then DECLINED: only then stopped, and the store is paid from the desk funds', async () => {
  const { ctx, order, kase } = await dueForRecharge();
  ctx.paypal.captureStatus = 'PENDING';
  await ctx.desk.recharge(kase.id);
  ctx.paypal.captureStatus = 'COMPLETED';
  notStoppedYet(ctx, order, kase);
  ctx.paypal.declinePendingCaptures();
  await ctx.desk.processDue();
  assert.equal(kase.recharge.status, 'HALTED');
  assert.equal(rechargeLines(ctx, order).length, 0);
  assert.equal(order.storePayable.source, 'desk:reserve');
  assert.ok((await ctx.desk.reconcile(order.id)).ok);
});

test('re-charge: a 5xx is not a refusal (left unconfirmed); a clear 422 refusal stops it', async () => {
  const { PayPalError } = await import('../src/paypal/client.js');
  const a = await dueForRecharge();
  const real = a.ctx.paypal.chargeSavedWallet;
  a.ctx.paypal.chargeSavedWallet = async () => { throw new PayPalError({ label: 're-charge-saved-wallet', status: 503, name: 'SERVICE_UNAVAILABLE' }); };
  await a.ctx.desk.recharge(a.kase.id);
  notStoppedYet(a.ctx, a.order, a.kase);
  a.ctx.paypal.chargeSavedWallet = real;

  const b = await dueForRecharge();
  b.ctx.paypal.chargeSavedWallet = async () => { throw new PayPalError({ label: 're-charge-saved-wallet', status: 422, name: 'UNPROCESSABLE_ENTITY', issues: [{ issue: 'INSTRUMENT_DECLINED' }] }); };
  const r = await b.ctx.desk.recharge(b.kase.id);
  assert.equal(r.charged, false);
  assert.equal(b.kase.recharge.status, 'HALTED');
  assert.equal(b.kase.recharge.blockedBy, 'PAYPAL_INSTRUMENT_DECLINED');
  assert.equal(b.order.storePayable.source, 'desk:reserve');
});

// Independent check 3, part 10: a dispute or a withdrawn consent while a re-charge has no answer. In the end the buyer
// pays nothing for the re-charge (a charge PayPal took is given back at once), the case is stopped, the store is paid
// from the desk's funds, and the ledger matches PayPal.
function notReached(ctx, n) {
  const real = ctx.paypal.chargeSavedWallet;
  let left = n;
  ctx.paypal.chargeSavedWallet = async (req) => {
    if (left-- > 0) throw new Error('fetch failed: connect ETIMEDOUT'); // the request never reached PayPal
    return real(req);
  };
  return () => (ctx.paypal.chargeSavedWallet = real);
}
async function stoppedWithNothingTaken(ctx, order, kase, reason) {
  await ctx.desk.processDue();
  assert.equal(kase.recharge.status, 'HALTED');
  assert.equal(kase.recharge.blockedBy, reason);
  assert.equal(order.storePayable.source, 'desk:reserve');
  const recon = await ctx.desk.reconcile(order.id);
  assert.ok(recon.ok, JSON.stringify(recon.rows));
  assert.equal(recon.rows.find((r) => r.party === 'buyer').paypalCents, 0, 'the buyer paid nothing in the end: purchase, refund, and no re-charge kept');
}
for (const [stopName, stop, reason] of [
  ['a dispute', (ctx, kase) => ctx.desk.fileDispute(kase.id, 'Not my mistake.'), 'BUYER_DISPUTED'],
  ['a withdrawn consent', (ctx, kase) => ctx.desk.revokeConsent(kase.buyerId), 'NO_ACTIVE_CONSENT'],
]) {
  test(`re-charge with no answer, then ${stopName}; the first request never reached PayPal: nothing is kept from the buyer`, async () => {
    const { ctx, order, kase } = await dueForRecharge();
    const restore = notReached(ctx, 2);
    await ctx.desk.recharge(kase.id);
    assert.equal(kase.recharge.status, 'UNCONFIRMED');
    restore();
    await stop(ctx, kase);
    await stoppedWithNothingTaken(ctx, order, kase, reason);
  });
  test(`re-charge with no answer, then ${stopName}; PayPal had taken the charge: it is given back`, async () => {
    const { ctx, order, kase } = await dueForRecharge();
    const restore = loseAnswers(ctx, 2);
    await ctx.desk.recharge(kase.id);
    assert.equal(kase.recharge.status, 'UNCONFIRMED');
    restore();
    await stop(ctx, kase);
    await stoppedWithNothingTaken(ctx, order, kase, reason);
  });
}

// The buyer's own wallet (not the shared demo one): withdrawing consent also deletes the wallet token at PayPal. The re-charge
// with no answer is asked about while the token still works, so a charge PayPal took is found and given back; the token is
// deleted once no re-charge of this buyer is left without an answer. Without that order the resend is refused for good.
async function ownWalletWithUnansweredRecharge(lose) {
  const { ctx, order, kase } = await dueForRecharge();
  const buyer = ctx.db.data.buyers[kase.buyerId];
  buyer.wallet.source = 'OWN';
  const restore = lose(ctx, 2);
  await ctx.desk.recharge(kase.id);
  assert.equal(kase.recharge.status, 'UNCONFIRMED');
  restore();
  return { ctx, order, kase, buyer, vaultId: buyer.wallet.vaultId };
}
for (const [what, lose] of [['PayPal had taken the charge', loseAnswers], ['the first request never reached PayPal', notReached]]) {
  test(`own wallet: re-charge with no answer, then consent withdrawn; ${what}: nothing is kept and the token is deleted`, async () => {
    const { ctx, order, kase, buyer, vaultId } = await ownWalletWithUnansweredRecharge(lose);
    await ctx.desk.revokeConsent(buyer.id);
    assert.equal(buyer.wallet.consent, 'REVOKED');
    await stoppedWithNothingTaken(ctx, order, kase, 'NO_ACTIVE_CONSENT');
    assert.ok(ctx.paypal.state.deletedTokens.includes(vaultId), 'the wallet token is deleted at PayPal in the end');
  });
}
test('own wallet: the resend fails while consent is withdrawn; the withdrawal stands and the token is deleted once PayPal answers', async () => {
  const { ctx, order, kase, buyer, vaultId } = await ownWalletWithUnansweredRecharge(loseAnswers);
  const restore = notReached(ctx, 4); // the resends during the withdrawal and the ledger check never reach PayPal
  await ctx.desk.revokeConsent(buyer.id);
  assert.equal(buyer.wallet.consent, 'REVOKED', 'the withdrawal is recorded even though PayPal could not be asked');
  assert.equal(kase.recharge.status, 'UNCONFIRMED');
  assert.equal((await ctx.desk.reconcile(order.id)).ok, false, 'never a match while the re-charge has no answer');
  assert.ok(!ctx.paypal.state.deletedTokens.includes(vaultId), 'the token is kept until PayPal answers about the re-charge');
  restore();
  await assert.rejects(buy(ctx, { buyer }), /NO_ACTIVE_CONSENT|active consent/, 'no new purchase with the withdrawn wallet');
  await stoppedWithNothingTaken(ctx, order, kase, 'NO_ACTIVE_CONSENT');
  assert.ok(ctx.paypal.state.deletedTokens.includes(vaultId));
});
test('own wallet: a charge taken after consent was withdrawn is not closed while its refund is still pending', async () => {
  const { ctx, order, kase, buyer } = await ownWalletWithUnansweredRecharge(loseAnswers);
  ctx.paypal.refundsPending = true;
  await ctx.desk.revokeConsent(buyer.id);
  await ctx.desk.processDue();
  assert.equal(kase.recharge.status, 'RETURNING');
  assert.ok(!halted(kase));
  assert.equal((await ctx.desk.reconcile(order.id)).ok, false, 'not a match while the charge is being given back');
  ctx.paypal.completePendingRefunds();
  await stoppedWithNothingTaken(ctx, order, kase, 'NO_ACTIVE_CONSENT');
});

// ---- fund table -----------------------------------------------------------------------------------------

test('desk funds: refund-first is refused when own funds cannot cover the store', async () => {
  const ctx = setup({ reserveStartCents: 2000 });
  const { order } = await buy(ctx, { purchaseAuthorized: false });
  const { kase } = await ctx.desk.reportProblem({ orderId: order.id, statement: 'Wrong.' });
  assert.equal(kase.path, 'VERIFY_FIRST');
  assert.ok(kase.limitCheck.reasons.includes('RESERVE_TOO_LOW'));
});

test('ledger and PayPal agree for every party after an agent-responsible case', async () => {
  const ctx = setup();
  const { order } = await buy(ctx, { purchaseAuthorized: false });
  await runToVerdict(ctx, order);
  const recon = await ctx.desk.reconcile(order.id);
  assert.ok(recon.ok, JSON.stringify(recon.rows));
  const by = Object.fromEntries(recon.rows.map((r) => [r.party, r.paypalCents]));
  assert.equal(by.buyer, 0, 'buyer paid and got everything back');
  assert.equal(by.store, order.totalCents, 'store received the full price');
});

// The buyer approved at PayPal and the desk sent the capture: from then on money may have moved. A pending capture
// or a lost answer is never closed as "the buyer turned back, nothing was charged"; asking again records it.
async function consentStarted(ctx) {
  const buyer = ctx.desk.createBuyer({ name: 'At PayPal' });
  const mandate = ctx.desk.draftMandate({ buyerId: buyer.id, instruction: 'Buy eggs.', conditions: { item: 'eggs', quantity: 1, purchaseAuthorized: true } });
  ctx.desk.approveMandate(mandate.id);
  const started = await ctx.desk.startConsentPurchase({ mandateId: mandate.id, store: { id: 'freshcart', name: 'FreshCart' }, cart: [{ sku: 'EGG-12', name: 'Large Eggs, 12 ct', qty: 1, unitCents: 3143 }], agentLog: [AGENT_LINE], storeRecord: [STORE_LINE], fixtureFacts: facts() });
  return started.order;
}

test('consent purchase: a capture PayPal answers PENDING cannot be cancelled as "nothing was charged" and is recorded once completed', async () => {
  const ctx = setup();
  const order = await consentStarted(ctx);
  ctx.paypal.captureStatus = 'PENDING';
  await assert.rejects(ctx.desk.completeConsentPurchase(order.id), (err) => err.code === 'PAYMENT_UNCONFIRMED');
  ctx.paypal.captureStatus = 'COMPLETED';
  assert.equal(order.storePayable.status, 'PAYMENT_UNCONFIRMED');
  assert.throws(() => ctx.desk.cancelConsentPurchase(order.id), (err) => err.code === 'CAPTURE_ALREADY_SENT');
  assert.ok(!order.consentCancelled);
  ctx.paypal.completePendingCaptures();
  const paid = await ctx.desk.completeConsentPurchase(order.id);
  assert.equal(paid.paypal.status, 'COMPLETED');
  assert.equal(ctx.paypal.totals().captures, 1);
  assert.equal(ctx.db.data.ledger.filter((l) => l.kind === 'PURCHASE_CAPTURED').length, 1);
});

test('consent purchase: a capture whose answer was lost cannot be cancelled; asking again records the one capture', async () => {
  const ctx = setup();
  const order = await consentStarted(ctx);
  const real = ctx.paypal.captureOrder;
  let lose = 1;
  ctx.paypal.captureOrder = async (...args) => {
    const res = await real(...args);
    if (lose-- > 0) throw new Error('socket hang up');
    return res;
  };
  await assert.rejects(ctx.desk.completeConsentPurchase(order.id));
  assert.throws(() => ctx.desk.cancelConsentPurchase(order.id), (err) => err.code === 'CAPTURE_ALREADY_SENT');
  assert.notEqual(order.storePayable.status, 'CANCELLED');
  const paid = await ctx.desk.completeConsentPurchase(order.id);
  assert.ok(paid.paypal?.captureId);
  assert.equal(ctx.paypal.totals().captures, 1);
});

test('a consent payment with no answer yet blocks a new saved-wallet payment for the same instruction', async () => {
  const ctx = setup();
  const buyer = ctx.desk.createBuyer({ name: 'Has a saved wallet', useDemoWallet: true });
  const mandate = ctx.desk.draftMandate({ buyerId: buyer.id, instruction: 'Buy eggs.', conditions: { item: 'eggs', quantity: 1, purchaseAuthorized: true } });
  ctx.desk.approveMandate(mandate.id);
  const what = { mandateId: mandate.id, store: { id: 'freshcart', name: 'FreshCart' }, cart: [{ sku: 'EGG-12', name: 'Large Eggs, 12 ct', qty: 1, unitCents: 3143 }], agentLog: [AGENT_LINE], storeRecord: [STORE_LINE], fixtureFacts: facts() };
  const started = await ctx.desk.startConsentPurchase(what);
  const real = ctx.paypal.captureOrder;
  let lose = 1;
  ctx.paypal.captureOrder = async (...args) => {
    const res = await real(...args);
    if (lose-- > 0) throw new Error('socket hang up');
    return res;
  };
  await assert.rejects(ctx.desk.completeConsentPurchase(started.order.id));
  await assert.rejects(ctx.desk.agentPurchase(what), (err) => err.code === 'PAYMENT_UNCONFIRMED');
  assert.equal(ctx.paypal.totals().captures, 1, 'no second payment for one instruction');
});

test('consent purchase: a buyer who turned back before any capture was sent can still cancel', async () => {
  const ctx = setup();
  const order = await consentStarted(ctx);
  ctx.desk.cancelConsentPurchase(order.id);
  assert.equal(order.storePayable.status, 'CANCELLED');
  assert.equal(order.consentCancelled, true);
});

// ---- the desk's own PayPal account in the ledger check (intent.md section 3, line 8) ----------------
// PayPal keeps one balance for the desk. The ledger splits it into purchase money held and the desk's
// own funds; PayPal can only confirm the sum, from the seller-side amounts it returns on each lookup.

function deskRow(recon) {
  return recon.rows.find((r) => r.party === 'desk');
}

test('desk row: the two desk accounts together equal what PayPal says reached or left the desk', async () => {
  const ctx = setup({}, { payoutWaitMs: 5 });
  const { order } = await buy(ctx, { fixtureFacts: facts({ itemMatchesMandate: 'no' }) }); // agent at fault: innocent store paid from desk funds
  const kase = await runToVerdict(ctx, order);
  await ctx.desk.processDue();
  assert.equal(order.storePayable.status, 'PAID');
  const recon = await ctx.desk.reconcile(order.id);
  assert.ok(recon.ok, JSON.stringify(recon.rows));
  const row = deskRow(recon);
  assert.ok(row, 'a desk row is part of the check');
  assert.equal(row.match, true);
  const cap = ctx.paypal.state.captures.get(order.paypal.captureId);
  const refund = ctx.paypal.state.refunds.get(kase.refund.id);
  const payout = ctx.paypal.state.payouts.get(order.storePayable.payout.batchId);
  assert.equal(row.paypalCents, cap.grossCents - cap.feeCents - refund.amountCents - payout.amountCents - payout.feeCents, 'capture net in, refund and payout with its fee out');
  assert.equal(row.parts['desk:purchase'] + row.parts['desk:reserve'], row.ledgerCents, 'the ledger split adds up to the compared total');
});

test('desk row: a fee PayPal gave back with the refund, missing from the ledger, reads as a difference', async () => {
  const ctx = setup();
  const { order } = await buy(ctx);
  ctx.paypal.refundFeeReturnedCents = 40;
  await ctx.desk.reportProblem({ orderId: order.id, statement: 'Wrong item.' });
  const recon = await ctx.desk.reconcile(order.id);
  assert.equal(recon.ok, false);
  assert.equal(deskRow(recon).match, false, 'the desk was debited 40 cents less than the ledger says');
  assert.equal(deskRow(recon).paypalCents - deskRow(recon).ledgerCents, 40);
  assert.equal(recon.rows.find((r) => r.party === 'paypal:fees').match, false, 'and PayPal kept 40 cents less in fees');
  assert.equal(recon.rows.find((r) => r.party === 'buyer').match, true);
});

test('desk row: a capture whose net amount is short of gross minus fee is caught only by the desk row', async () => {
  const ctx = setup();
  ctx.paypal.captureNetShortCents = 7;
  const { order } = await buy(ctx);
  await ctx.desk.reportProblem({ orderId: order.id, statement: 'Wrong item.' });
  const recon = await ctx.desk.reconcile(order.id);
  assert.equal(recon.ok, false);
  for (const party of ['buyer', 'store', 'paypal:fees']) assert.equal(recon.rows.find((r) => r.party === party).match, true, party);
  assert.equal(deskRow(recon).match, false);
  assert.equal(deskRow(recon).ledgerCents - deskRow(recon).paypalCents, 7);
});

test('desk row: a failed PayPal lookup fails the check instead of reading as a match', async () => {
  const ctx = setup();
  const { order } = await buy(ctx);
  await ctx.desk.reportProblem({ orderId: order.id, statement: 'Wrong item.' });
  ctx.paypal.failNextGetRefund = true;
  await assert.rejects(() => ctx.desk.reconcile(order.id));
  const again = await ctx.desk.reconcile(order.id);
  assert.ok(again.ok, JSON.stringify(again.rows));
  assert.equal(deskRow(again).match, true);
});

test('lookups: the purchase capture records the net amount used for the desk row and whether it was computed', async () => {
  const ctx = setup();
  const { order } = await buy(ctx);
  await ctx.desk.reportProblem({ orderId: order.id, statement: 'Wrong item.' });
  const cap = ctx.paypal.state.captures.get(order.paypal.captureId);
  const fromPayPal = (await ctx.desk.reconcile(order.id)).lookups.find((l) => l.type === 'capture');
  assert.equal(fromPayPal.netCents, cap.grossCents - cap.feeCents, 'PayPal net_amount');
  assert.equal(fromPayPal.netComputed, false);

  ctx.paypal.captureOmitsNet = true; // PayPal sent no net_amount: the desk falls back to gross minus fee
  const computed = (await ctx.desk.reconcile(order.id)).lookups.find((l) => l.type === 'capture');
  assert.equal(computed.netCents, cap.grossCents - cap.feeCents);
  assert.equal(computed.netComputed, true);
});
