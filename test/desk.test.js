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

function setup(policyOverrides = {}) {
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
  const desk = createDesk({ db, paypal, factExtractor: createFactExtractor({ provider: 'fixture' }), clock, ledger, config, pollMs: 1 });
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
  const { kase } = await ctx.desk.reportProblem({ orderId: order.id, statement: 'Wrong order.' });
  kase.refund.completedAt = null; // simulate a refund that is still pending
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
