// The buyer's own record moves the instant-refund limit (src/domain/trust.js). The one rule that matters
// most: a limit only goes down because of the buyer's own responsibility verdict, never anyone else's record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPolicy } from '../src/config.js';
import { createDb } from '../src/store.js';
import { createClock } from '../src/domain/clock.js';
import { createLedger } from '../src/domain/ledger.js';
import { createFactExtractor } from '../src/ai/facts.js';
import { createDesk } from '../src/desk.js';
import { trustLimits } from '../src/domain/trust.js';
import { createFakePayPal } from './fake-paypal.js';

const policy = defaultPolicy();
const NOW = '2026-11-12T00:00:00.000Z';
const kase = (id, liable, more = {}) => ({ id, orderId: `O-${id}`, receivedAt: '2026-11-01T00:00:00.000Z', status: 'CLOSED', verdict: { liable, rule: 'R2', agreed: true }, dispute: null, ...more });
const limits = (cases, p = policy) => trustLimits({ policy: p, buyerCases: cases, now: NOW });

// ---- the rule on its own -------------------------------------------------------------------------------

test('no record: the policy numbers apply as they are', () => {
  const l = limits([]);
  assert.equal(l.perCaseCapCents, 5000);
  assert.equal(l.refundsPer30Days, 2);
  assert.deepEqual(l.basis, []);
});

test('up: a case that was the agent\'s or the store\'s fault raises the limit by one step and one refund', () => {
  assert.deepEqual([limits([kase('C1', 'AGENT')]).perCaseCapCents, limits([kase('C1', 'AGENT')]).refundsPer30Days], [7500, 3]);
  assert.equal(limits([kase('C1', 'STORE')]).perCaseCapCents, 7500);
});

test('up: at most two such cases count', () => {
  const l = limits([kase('C1', 'AGENT'), kase('C2', 'STORE'), kase('C3', 'AGENT')]);
  assert.equal(l.perCaseCapCents, 10000);
  assert.equal(l.refundsPer30Days, 4);
  assert.deepEqual(l.basis.map((b) => b.caseId), ['C1', 'C2']);
});

test('down: the buyer\'s own responsibility verdict, not disputed, lowers it by one step and one refund', () => {
  const l = limits([kase('C1', 'BUYER')]);
  assert.equal(l.perCaseCapCents, 2500);
  assert.equal(l.refundsPer30Days, 1);
  assert.deepEqual(l.basis, [{ caseId: 'C1', orderId: 'O-C1', liable: 'BUYER', decidedBy: 'TWO_KEYS', effect: 'DOWN', cents: -2500, refunds: -1 }]);
});

test('down: a person\'s choice of the buyer counts like agreeing keys', () => {
  assert.equal(limits([kase('C1', 'BUYER', { verdict: { liable: 'BUYER', rule: 'OPERATOR', agreed: false } })]).basis[0].decidedBy, 'PERSON');
});

test('down never below zero: every purchase is then checked first', () => {
  const l = limits([kase('C1', 'BUYER'), kase('C2', 'BUYER'), kase('C3', 'BUYER')]);
  assert.equal(l.perCaseCapCents, 0);
  assert.equal(l.refundsPer30Days, 0);
});

test('not lowered: a disputed buyer verdict, a case waiting for a person, an undecided or undetermined case, keys that disagree', () => {
  const none = [
    kase('C1', 'BUYER', { dispute: { at: NOW, text: 'no' } }),
    { ...kase('C2', 'BUYER'), status: 'HUMAN_REVIEW', verdict: null },
    { ...kase('C3', 'BUYER'), verdict: null, status: 'OPEN' },
    kase('C4', 'UNDETERMINED'),
    kase('C5', 'BUYER', { verdict: { liable: 'BUYER', rule: 'R4', agreed: false } }),
    kase('C6', 'UNDETERMINED', { verdict: { liable: 'UNDETERMINED', rule: 'R0', agreed: null } }),
  ];
  for (const c of none) assert.equal(limits([c]).perCaseCapCents, 5000, c.id);
});

test('only cases inside the window count', () => {
  assert.equal(limits([kase('C1', 'BUYER', { receivedAt: '2026-04-01T00:00:00.000Z' })]).perCaseCapCents, 5000);
});

test('a step of 0 switches the record off', () => {
  assert.equal(limits([kase('C1', 'BUYER'), kase('C2', 'AGENT')], { ...policy, trustStepCents: 0 }).perCaseCapCents, 5000);
});

// ---- the rule inside the desk ----------------------------------------------------------------------------

const STORE_LINE = 'Shipped exactly the items on the order.';
const AGENT_LINE = 'Looked up the item and placed the order.';

function setup() {
  const config = { policy: defaultPolicy(), demoWallet: { vaultId: 'VAULT-DEMO', customerId: 'CUST-DEMO', email: 'buyer@example.test' }, storePayoutEmail: 'store@example.test', publicBaseUrl: 'http://localhost:8787' };
  const db = createDb({ policy: config.policy });
  const paypal = createFakePayPal();
  const clock = createClock(db);
  const ledger = createLedger(db);
  const desk = createDesk({ db, paypal, factExtractor: createFactExtractor({ provider: 'fixture' }), clock, ledger, config, pollMs: 1, refundWaitMs: 20 });
  return { db, paypal, clock, desk };
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
  for (const [key, value] of Object.entries(overrides)) base[key] = { value, evidence: base[key].evidence };
  return base;
}

// whose: BUYER (the order matches the mandate), AGENT (paid without permission), STORE (did not ship)
async function buy(ctx, buyer, { cents = 3143, whose = 'BUYER' } = {}) {
  const mandate = ctx.desk.draftMandate({
    buyerId: buyer.id,
    instruction: 'Order a dozen large eggs for me.',
    conditions: { item: 'large eggs, one dozen', quantity: 1, maxTotalCents: null, exclusions: [], purchaseAuthorized: whose !== 'AGENT' },
  });
  ctx.desk.approveMandate(mandate.id);
  return ctx.desk.agentPurchase({
    mandateId: mandate.id,
    store: { id: 'freshcart', name: 'FreshCart' },
    cart: [{ sku: 'EGG-12', name: 'Large Eggs, 12 ct', qty: 1, unitCents: cents }],
    agentLog: [AGENT_LINE],
    storeRecord: [STORE_LINE],
    fixtureFacts: facts(whose === 'STORE' ? { storeFulfilledAsOrdered: 'no' } : {}),
  });
}

async function runToVerdict(ctx, order) {
  const { kase: k } = await ctx.desk.reportProblem({ orderId: order.id, statement: 'Something is wrong with this order.' });
  await ctx.desk.investigate(k.id);
  await ctx.desk.settle(k.id);
  return k;
}

test('desk: after the buyer\'s own responsibility verdict, the next purchase is checked first and the notice says why', async () => {
  const ctx = setup();
  const buyer = ctx.desk.createBuyer({ name: 'B', useDemoWallet: true });
  const first = await runToVerdict(ctx, await buy(ctx, buyer));
  assert.equal(first.verdict.liable, 'BUYER');
  const next = await buy(ctx, buyer);
  assert.equal(next.protection.perCaseCapCents, 2500);
  assert.equal(next.protection.refundsPer30Days, 1);
  assert.equal(next.protection.refundFirst, false);
  assert.deepEqual(next.protection.limits.basis.map((b) => [b.caseId, b.effect]), [[first.id, 'DOWN']]);
  const { kase: k } = await ctx.desk.reportProblem({ orderId: next.id, statement: 'Wrong again.' });
  assert.equal(k.path, 'VERIFY_FIRST');
  assert.equal(k.refund, null, 'nothing refunded before the check');
  const text = k.notices.find((n) => n.type === 'CHECKING_FIRST').text;
  assert.match(text, new RegExp(`case ${first.id} found you responsible`));
  assert.equal(text.split('set from your own record').length - 1, 1, 'the reason is given once, even when both limits were hit');
});

test('desk: a disputed buyer verdict does not lower the next purchase', async () => {
  const ctx = setup();
  const buyer = ctx.desk.createBuyer({ name: 'B', useDemoWallet: true });
  const first = await runToVerdict(ctx, await buy(ctx, buyer));
  await ctx.desk.fileDispute(first.id, 'Not my mistake.');
  const next = await buy(ctx, buyer);
  assert.equal(next.protection.perCaseCapCents, 5000);
  assert.equal(next.protection.refundFirst, true);
});

test('desk: another buyer\'s responsibility verdict never lowers this buyer', async () => {
  const ctx = setup();
  const other = ctx.desk.createBuyer({ name: 'Other', useDemoWallet: true });
  await runToVerdict(ctx, await buy(ctx, other));
  const buyer = ctx.desk.createBuyer({ name: 'B', useDemoWallet: true });
  const order = await buy(ctx, buyer);
  assert.equal(order.protection.perCaseCapCents, 5000);
  assert.deepEqual(order.protection.limits.basis, []);
});

test('desk: two cases that were the agent\'s and the store\'s fault let a $58.08 purchase and a third instant refund go refund first', async () => {
  const ctx = setup();
  const buyer = ctx.desk.createBuyer({ name: 'B', useDemoWallet: true });
  assert.equal((await runToVerdict(ctx, await buy(ctx, buyer, { whose: 'AGENT' }))).verdict.liable, 'AGENT');
  assert.equal((await runToVerdict(ctx, await buy(ctx, buyer, { whose: 'STORE' }))).verdict.liable, 'STORE');
  const big = await buy(ctx, buyer, { cents: 5808, whose: 'AGENT' });
  assert.equal(big.protection.perCaseCapCents, 10000);
  assert.equal(big.protection.refundFirst, true);
  const { kase: k } = await ctx.desk.reportProblem({ orderId: big.id, statement: 'It paid without asking.' });
  assert.equal(k.path, 'REFUND_FIRST', 'third instant refund in 30 days, allowed by the count fixed at purchase (4)');
  assert.equal(k.refund.status, 'COMPLETED');
});

test('desk: the limit is fixed at purchase; a verdict reached later does not change an order already bought', async () => {
  const ctx = setup();
  const buyer = ctx.desk.createBuyer({ name: 'B', useDemoWallet: true });
  const a = await buy(ctx, buyer);
  const b = await buy(ctx, buyer);
  assert.equal((await runToVerdict(ctx, a)).verdict.liable, 'BUYER');
  const { kase: k } = await ctx.desk.reportProblem({ orderId: b.id, statement: 'Wrong.' });
  assert.equal(b.protection.perCaseCapCents, 5000);
  assert.equal(k.path, 'REFUND_FIRST');
});

test('desk: no money rule is loosened for a lowered buyer: the re-charge still needs notice and stops on dispute', async () => {
  const ctx = setup();
  const buyer = ctx.desk.createBuyer({ name: 'B', useDemoWallet: true });
  await runToVerdict(ctx, await buy(ctx, buyer));
  const next = await buy(ctx, buyer, { cents: 2000 }); // under the lowered $25: still refund first, but one refund was already used
  const { kase: k } = await ctx.desk.reportProblem({ orderId: next.id, statement: 'Wrong.' });
  assert.equal(k.path, 'VERIFY_FIRST');
  assert.deepEqual(k.limitCheck.reasons, ['OVER_30_DAY_COUNT']);
  await ctx.desk.investigate(k.id);
  await ctx.desk.settle(k.id);
  assert.equal(k.status, 'CLOSED_NO_REFUND', 'checked first and the buyer was responsible: nothing refunded, nothing charged again');
  assert.equal(ctx.paypal.totals().captures, 2, 'only the two purchases: the first case is still in its notice period');
});
