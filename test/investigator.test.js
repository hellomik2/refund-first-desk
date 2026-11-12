// The investigator bundle: three notices, the quick check, the deep check (AI investigator), two
// keys with a human review queue, and the over-limit "check first, refund within 5 minutes" path.
// Fake PayPal and the fixture AI only. Several AI answers below are written wrong on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPolicy } from '../src/config.js';
import { createDb } from '../src/store.js';
import { createClock } from '../src/domain/clock.js';
import { createLedger } from '../src/domain/ledger.js';
import { createFactExtractor, evidenceHash } from '../src/ai/facts.js';
import { stepLine, violationCandidates } from '../src/domain/agentlog.js';
import { createDesk } from '../src/desk.js';
import { caseRow } from '../scripts/metrics.mjs';
import { createFakePayPal } from './fake-paypal.js';

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const STORE = { id: 'greengrocer', name: 'GreenGrocer' };
const INSTRUCTION = 'Buy two cartons of barista oat milk, unsweetened, under $30. Pay with my saved wallet.';
const MANDATE = { item: 'oat milk, barista edition, 1 litre, unsweetened', quantity: 2, maxTotalCents: 3000, exclusions: ['sweetened'], purchaseAuthorized: true };
const OAT = (unitCents = 549, qty = 2) => ({ sku: 'OAT-BAR-1L', name: 'Oatly Barista Edition 1 L', qty, unitCents });
const SHIP = { sku: 'SHIP', name: 'Shipping', qty: 1, unitCents: 400 };
const CART = [OAT(), SHIP]; // $14.98, inside every limit
const OVER_CART = [OAT(2800), SHIP]; // $60.00, over the $50 per-case cap
const OVER_MANDATE = { maxTotalCents: 8000 };
const STORE_RECORD = ['Order received from agent checkout.', 'Charged the total, same as the submitted cart.', 'Shipped 2 x Oatly Barista Edition 1 L.'];

function agentLog({ total = '$14.98', addCents = 1098, payCents = 1498 } = {}) {
  return [
    { step: 1, at: '2026-11-02T14:00:05Z', actor: 'user', action: 'message', content: INSTRUCTION },
    { step: 2, at: '2026-11-02T14:00:40Z', actor: 'agent', action: 'search', content: 'Searched GreenGrocer for barista oat milk 1 L.' },
    { step: 3, at: '2026-11-02T14:01:10Z', actor: 'agent', action: 'view', content: 'Viewed Oatly Barista Edition 1 L (unsweetened).' },
    { step: 4, at: '2026-11-02T14:01:30Z', actor: 'agent', action: 'add_to_cart', content: 'Added 2 x Oatly Barista Edition 1 L (unsweetened) to the cart.', sku: 'OAT-BAR-1L', qty: 2, amountCents: addCents },
    { step: 5, at: '2026-11-02T14:02:00Z', actor: 'agent', action: 'checkout', content: `Opened checkout, total ${total} with shipping.`, amountCents: payCents },
    { step: 6, at: '2026-11-02T14:02:20Z', actor: 'agent', action: 'pay', content: `Paid ${total} with the saved PayPal wallet.`, amountCents: payCents },
    { step: 7, at: '2026-11-02T14:30:00Z', actor: 'store', action: 'message', content: 'Order confirmed and packed.' },
  ];
}
const OVER_LOG = agentLog({ total: '$60.00', addCents: 5600, payCents: 6000 });

/** Hand-written fact table; every quote is in the records the desk builds. */
function facts(overrides = {}) {
  const base = {
    purchaseAuthorized: ['yes', 'mandate', 'May the agent pay without asking again'],
    itemMatchesMandate: ['yes', 'paypal_order', '2 x Oatly Barista Edition 1 L'],
    quantityMatchesMandate: ['yes', 'paypal_order', '2 x Oatly Barista Edition 1 L'],
    withinSpendingLimit: ['yes', 'paypal_order', 'Total:'],
    exclusionsRespected: ['yes', 'paypal_order', '2 x Oatly Barista Edition 1 L'],
    storeChargedAsOrdered: ['yes', 'store_record', 'same as the submitted cart'],
    storeFulfilledAsOrdered: ['yes', 'store_record', 'Shipped 2 x Oatly Barista Edition 1 L.'],
  };
  const out = {};
  for (const [key, [value, doc, quote]] of Object.entries(base)) {
    const o = overrides[key];
    if (o === 'unknown') out[key] = { value: 'unknown', evidence: [] };
    else if (Array.isArray(o)) out[key] = { value: o[0], evidence: [{ doc: o[1], quote: o[2] }] };
    else out[key] = { value, evidence: [{ doc, quote }] };
  }
  return out;
}

function setup({ policy = {}, factExtractor = createFactExtractor({ provider: 'fixture' }) } = {}) {
  const config = {
    policy: { ...defaultPolicy(), ...policy },
    demoWallet: { vaultId: 'VAULT-DEMO', customerId: 'CUST-DEMO', email: 'buyer@example.test' },
    storePayoutEmail: 'store@example.test',
    publicBaseUrl: 'http://localhost:8787',
  };
  const db = createDb({ policy: config.policy });
  const paypal = createFakePayPal();
  const clock = createClock(db);
  const ledger = createLedger(db);
  const desk = createDesk({ db, paypal, factExtractor, clock, ledger, config, pollMs: 1 });
  return { config, db, paypal, clock, ledger, desk };
}

async function purchase(ctx, { conditions = {}, cart = CART, agentCart = cart, log = agentLog(), storeRecord = STORE_RECORD, fixtureFacts = facts(), deep, quick } = {}) {
  const buyer = ctx.desk.createBuyer({ name: 'Buyer', useDemoWallet: true });
  const mandate = ctx.desk.approveMandate(ctx.desk.draftMandate({ buyerId: buyer.id, instruction: INSTRUCTION, conditions: { ...MANDATE, ...conditions } }).id);
  const order = await ctx.desk.agentPurchase({ mandateId: mandate.id, store: STORE, cart, agentCart, agentLog: log, storeRecord, fixtureFacts, fixtureDeep: deep, fixtureQuick: quick });
  return { buyer, mandate, order };
}

async function reportAndCheck(ctx, order, statement = 'This is not what I asked for.') {
  const { kase } = await ctx.desk.reportProblem({ orderId: order.id, statement });
  await ctx.desk.investigate(kase.id);
  return kase;
}

const types = (kase) => kase.notices.map((n) => n.type);
const agentInvoices = (ctx) => ctx.db.data.ledger.filter((l) => l.kind === 'AGENT_COMPANY_OWES').length;

// ---- 2.1 notices and 2.2 quick check, inside the limits ------------------------------------------------

test('notices, in the limits, quick check closes: refund requested -> refund completed -> no re-charge', async () => {
  const ctx = setup();
  const { order } = await purchase(ctx, { conditions: { purchaseAuthorized: false } });
  const { kase } = await ctx.desk.reportProblem({ orderId: order.id, statement: 'I only asked it to compare prices.' });
  assert.deepEqual(types(kase), ['REFUND_REQUESTED', 'REFUND_COMPLETED']);
  assert.ok(kase.notices[0].atMs <= kase.refund.requestedAtMs, 'the request notice comes before the refund call');
  assert.match(kase.notices[1].text, /days/, 'the completed notice says card or bank statements take days');
  assert.equal(kase.quick, null, 'nothing is checked inside the report');

  await ctx.desk.investigate(kase.id);
  assert.deepEqual(types(kase), ['REFUND_REQUESTED', 'REFUND_COMPLETED', 'NO_RECHARGE']);
  const at = kase.notices.map((n) => n.atMs);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'notices are in time order');
  assert.ok(kase.refund.completedAtMs <= kase.quick.startedAtMs, 'the quick check starts only after the refund is completed');
  assert.equal(kase.quick.closed, true);
  assert.ok(kase.quick.at);
  assert.deepEqual(kase.quick.reasons.map((r) => [r.key, r.by]), [['purchaseAuthorized', 'code']]);
  assert.equal(kase.rechargeClosed, true);
  assert.equal(kase.quick.ai, null, 'code already closed it, so the quick AI is not asked');
});

test('notices, in the limits, order matches the mandate: no quick closure and no NO_RECHARGE notice', async () => {
  const ctx = setup();
  const { order } = await purchase(ctx);
  const kase = await reportAndCheck(ctx, order);
  assert.equal(kase.quick.closed, false);
  assert.equal(kase.rechargeClosed, false);
  assert.ok(kase.quick.ai, 'the quick AI was asked for item, exclusions and quantity');
  assert.deepEqual(types(kase), ['REFUND_REQUESTED', 'REFUND_COMPLETED']);
  assert.equal(kase.verdict.liable, 'BUYER');
  assert.deepEqual(kase.verdict.keys, { code: 'BUYER', ai: 'BUYER' });
  assert.equal(kase.verdict.agreed, true);
  await ctx.desk.settle(kase.id);
  assert.equal(kase.recharge.status, 'SCHEDULED');
});

// ---- 2.5 over-limit path ----------------------------------------------------------------------------------

test('over the limit, quick check closes: checked first, refunded on the spot, then the deep check', async () => {
  const ctx = setup();
  const { order } = await purchase(ctx, { cart: OVER_CART, log: OVER_LOG, conditions: { ...OVER_MANDATE, purchaseAuthorized: false } });
  const { kase } = await ctx.desk.reportProblem({ orderId: order.id, statement: 'I never said it could pay.' });
  assert.equal(kase.path, 'VERIFY_FIRST');
  assert.deepEqual(types(kase), ['REFUND_REQUESTED', 'CHECKING_FIRST']);
  assert.match(kase.notices[1].text, /5 minutes/);
  assert.equal(ctx.paypal.totals().refunds, 0);

  await ctx.desk.investigate(kase.id);
  assert.equal(kase.quick.closed, true);
  assert.equal(kase.refund.status, 'COMPLETED');
  assert.ok(kase.refund.completedAtMs <= kase.investigation.startedAtMs, 'refunded before the deep check started');
  assert.ok(kase.refund.completedAtMs - kase.receivedAtMs < FIVE_MINUTES_MS);
  assert.deepEqual(types(kase), ['REFUND_REQUESTED', 'CHECKING_FIRST', 'REFUND_COMPLETED', 'NO_RECHARGE']);

  await ctx.desk.settle(kase.id);
  assert.equal(kase.verdict.liable, 'AGENT');
  assert.equal(ctx.paypal.totals().refunds, 1, 'the settlement does not refund a second time');
  assert.equal(order.storePayable.source, 'desk:reserve');
  const recon = await ctx.desk.reconcile(order.id);
  assert.ok(recon.ok, JSON.stringify(recon.rows));
});

test('over the limit, not closable, both keys say the store: refunded after the two keys', async () => {
  const ctx = setup();
  const storeRecord = ['Order received from agent checkout.', 'Charged the total, same as the submitted cart.', 'Shipped 1 x Oatly Barista Edition 1 L; the second carton was out of stock.'];
  const { order } = await purchase(ctx, {
    cart: OVER_CART,
    log: OVER_LOG,
    conditions: OVER_MANDATE,
    storeRecord,
    fixtureFacts: facts({ storeFulfilledAsOrdered: ['no', 'store_record', 'the second carton was out of stock'] }),
  });
  const kase = await reportAndCheck(ctx, order);
  assert.equal(kase.quick.closed, false, 'only the store record shows it, so the quick check cannot close');
  assert.equal(ctx.paypal.totals().refunds, 0, 'no refund before the two keys agree');
  assert.equal(kase.verdict.liable, 'STORE');
  await ctx.desk.settle(kase.id);
  assert.equal(kase.refund.status, 'COMPLETED');
  assert.ok(kase.refund.completedAtMs - kase.receivedAtMs < FIVE_MINUTES_MS);
  assert.deepEqual(types(kase), ['REFUND_REQUESTED', 'CHECKING_FIRST', 'REFUND_COMPLETED']);
  assert.equal(order.storePayable.status, 'CANCELLED');
});

test('over the limit, both keys say the buyer: no refund, nothing charged, the dispute still goes in', async () => {
  const ctx = setup();
  const { order } = await purchase(ctx, { cart: OVER_CART, log: OVER_LOG, conditions: OVER_MANDATE });
  const kase = await reportAndCheck(ctx, order);
  assert.equal(kase.verdict.liable, 'BUYER');
  await ctx.desk.settle(kase.id);
  assert.equal(kase.status, 'CLOSED_NO_REFUND');
  assert.equal(ctx.paypal.totals().refunds, 0);
  assert.deepEqual(types(kase), ['REFUND_REQUESTED', 'CHECKING_FIRST']);
  await ctx.desk.fileDispute(kase.id, 'I do not agree.');
  assert.ok(kase.dispute);
  const r = await ctx.desk.recharge(kase.id);
  assert.equal(r.charged, false);
  assert.equal(ctx.paypal.totals().captures, 1);
});

test('over the limit: the first notice confirms the request without saying the refund is on its way', async () => {
  const ctx = setup();
  const inside = await purchase(ctx);
  const a = (await ctx.desk.reportProblem({ orderId: inside.order.id, statement: 'Wrong.' })).kase;
  assert.match(a.notices[0].text, /^Refund requested\./);
  assert.match(a.notices[0].text, /on its way/, 'inside the limits the refund really is under way');

  // Like S24: over the limit and the order matches the mandate, so no refund ever comes.
  const over = await purchase(ctx, { cart: OVER_CART, log: OVER_LOG, conditions: OVER_MANDATE });
  const b = await reportAndCheck(ctx, over.order);
  await ctx.desk.settle(b.id);
  assert.equal(b.status, 'CLOSED_NO_REFUND');
  assert.equal(b.notices[0].type, 'REFUND_REQUESTED');
  assert.match(b.notices[0].text, /^Refund requested\./);
  assert.ok(b.notices.every((n) => !/on its way/.test(n.text)), b.notices.map((n) => n.text).join(' | '));
});

test('over the limit, keys disagree: the notice says the checks disagree and that it can take longer than 5 minutes', async () => {
  const ctx = setup();
  const { order } = await purchase(ctx, { cart: OVER_CART, log: OVER_LOG, conditions: OVER_MANDATE, deep: { verdict: 'AGENT' } });
  const kase = await reportAndCheck(ctx, order);
  assert.equal(kase.status, 'HUMAN_REVIEW');
  const n = kase.notices.at(-1);
  assert.equal(n.type, 'HUMAN_REVIEW');
  assert.ok(n.atMs - kase.receivedAtMs < FIVE_MINUTES_MS, 'the notice comes long before 5 minutes have passed');
  assert.doesNotMatch(n.text, /could not finish/);
  assert.match(n.text, /disagree/);
  assert.match(n.text, /longer than 5 minutes/);
  assert.doesNotMatch(n.text, /independent/i); // the two keys share facts (README, How separate the two keys are)
});

test('two checks of the same over-limit case at the same moment refund it once', async () => {
  const ctx = setup();
  const { order } = await purchase(ctx, { cart: OVER_CART, log: OVER_LOG, conditions: { ...OVER_MANDATE, purchaseAuthorized: false } });
  const { kase } = await ctx.desk.reportProblem({ orderId: order.id, statement: 'Wrong.' });
  const results = await Promise.allSettled([ctx.desk.investigate(kase.id), ctx.desk.investigate(kase.id)]);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.code === 'CHECK_IN_PROGRESS').length, 1);
  assert.equal(ctx.paypal.totals().refunds, 1);
  assert.equal(ctx.db.data.ledger.filter((l) => l.kind === 'REFUND').length, 1);
});

// ---- 2.4 two keys and the human review queue (pass line 11) -------------------------------------------------

const DISAGREEING = [
  { name: 'code AGENT (payment not allowed) vs AI BUYER', opts: { conditions: { purchaseAuthorized: false } }, ai: 'BUYER', code: 'AGENT' },
  { name: 'code BUYER vs AI STORE', opts: {}, ai: 'STORE', code: 'BUYER' },
  {
    name: 'code STORE (short shipment) vs AI AGENT',
    opts: { fixtureFacts: facts({ storeFulfilledAsOrdered: ['no', 'store_record', 'Order received from agent checkout.'] }) },
    ai: 'AGENT',
    code: 'STORE',
  },
  { name: 'code UNDETERMINED vs AI BUYER', opts: { fixtureFacts: facts({ itemMatchesMandate: 'unknown' }) }, ai: 'BUYER', code: 'UNDETERMINED' },
  { name: 'over the limit: code BUYER vs AI AGENT', opts: { cart: OVER_CART, log: OVER_LOG, conditions: OVER_MANDATE }, ai: 'AGENT', code: 'BUYER', over: true },
];

test('11. keys made to disagree on purpose move no money and every one waits for a person', async () => {
  const ctx = setup();
  const kases = [];
  for (const c of DISAGREEING) {
    const { order } = await purchase(ctx, { ...c.opts, deep: { verdict: { liable: c.ai, reason: 'written wrong on purpose' } } });
    const kase = await reportAndCheck(ctx, order);
    kases.push({ c, kase, order });
    assert.equal(kase.status, 'HUMAN_REVIEW', c.name);
    assert.equal(kase.verdict, null, c.name);
    assert.equal(kase.review.code.liable, c.code, c.name);
    assert.equal(kase.review.ai.liable, c.ai, c.name);
    assert.ok(kase.review.firstDeviation && kase.review.openedAt, c.name);
    assert.equal(types(kase).at(-1), 'HUMAN_REVIEW', c.name);
    if (c.over) assert.match(kase.notices.at(-1).text, /5 minutes/, c.name);
    await assert.rejects(() => ctx.desk.settle(kase.id), { code: 'IN_HUMAN_REVIEW' }, c.name);
  }
  assert.ok(kases.length >= 3);
  ctx.clock.fastForwardDays(30);
  await ctx.desk.processDue();
  for (const { c, kase, order } of kases) {
    const r = await ctx.desk.recharge(kase.id);
    assert.equal(r.charged, false, c.name);
    assert.equal(order.storePayable.status, 'HELD', `${c.name}: the store is not paid while a person has not decided`);
  }
  assert.equal(ctx.paypal.totals().captures, DISAGREEING.length, 'no buyer was charged again');
  assert.equal(ctx.paypal.totals().payouts, 0, 'no store was paid');
  assert.equal(agentInvoices(ctx), 0, 'no agent company was invoiced');
  assert.equal(ctx.paypal.totals().refunds, DISAGREEING.filter((c) => !c.over).length, 'only the refund-first refunds; the over-limit case is not refunded');
});

test('operator decision: settles with rule OPERATOR; choosing the buyer keeps the notice and dispute period', async () => {
  const ctx = setup();
  const toBuyer = await purchase(ctx, { deep: { verdict: 'STORE' } });
  const a = await reportAndCheck(ctx, toBuyer.order);
  await assert.rejects(() => ctx.desk.resolveReview(a.id, 'NOBODY', ''), { code: 'BAD_CHOICE' });
  await ctx.desk.resolveReview(a.id, 'BUYER', 'Checked by hand: the order matches.');
  assert.equal(a.verdict.rule, 'OPERATOR');
  assert.equal(a.verdict.agreed, false);
  assert.deepEqual(a.verdict.keys, { code: 'BUYER', ai: 'STORE' });
  assert.equal(a.status, 'NOTICE_SENT');
  assert.equal((await ctx.desk.recharge(a.id)).blockedBy, 'NOTICE_PERIOD_RUNNING');
  await ctx.desk.fileDispute(a.id, 'No.');
  assert.equal(a.recharge.status, 'HALTED');
  await assert.rejects(() => ctx.desk.resolveReview(a.id, 'AGENT', ''), { code: 'NOT_IN_REVIEW' });

  const over = await purchase(ctx, { cart: OVER_CART, log: OVER_LOG, conditions: OVER_MANDATE, deep: { verdict: 'AGENT' } });
  const b = await reportAndCheck(ctx, over.order);
  assert.equal(ctx.paypal.totals().refunds, 1, 'only the first case, refunded first');
  await ctx.desk.resolveReview(b.id, 'AGENT', 'The agent picked a pack size the buyer did not ask for.');
  assert.equal(b.status, 'CLOSED_AGENT_RESPONSIBLE');
  assert.equal(b.refund.status, 'COMPLETED', 'not the buyer: the over-limit refund follows the decision');
  assert.equal(over.order.storePayable.source, 'desk:reserve');
  assert.equal(agentInvoices(ctx), 1);
});

test('a dispute filed while a person decides stops the re-charge even if the person chooses the buyer', async () => {
  const ctx = setup();
  const { order } = await purchase(ctx, { deep: { verdict: 'AGENT' } });
  const kase = await reportAndCheck(ctx, order);
  assert.equal(kase.status, 'HUMAN_REVIEW');
  await ctx.desk.fileDispute(kase.id, 'I did not want this.');
  await ctx.desk.resolveReview(kase.id, 'BUYER', 'Matches the mandate.');
  assert.equal(kase.recharge.status, 'HALTED');
  assert.equal(kase.recharge.blockedBy, 'BUYER_DISPUTED');
  assert.equal(order.storePayable.source, 'desk:reserve', 'the store is still paid, from desk funds');
  ctx.clock.fastForwardDays(30);
  await ctx.desk.processDue();
  assert.equal(ctx.paypal.totals().captures, 1);
});

test('R0: records that cannot be tied together are UNDETERMINED without the two keys', async () => {
  const ctx = setup();
  const { order, mandate } = await purchase(ctx, { deep: { verdict: 'BUYER' } });
  const { kase } = await ctx.desk.reportProblem({ orderId: order.id, statement: 'Wrong.' });
  mandate.instruction = 'Buy whatever you like.'; // the mandate record changed after approval
  await ctx.desk.investigate(kase.id);
  assert.equal(kase.status, 'OPEN');
  assert.equal(kase.verdict.liable, 'UNDETERMINED');
  assert.equal(kase.verdict.rule, 'R0');
  assert.equal(kase.verdict.agreed, null);
});

test('an AI that gives no answer counts as UNDETERMINED for its key', async () => {
  const silent = { provider: 'anthropic', quick: async () => ({ facts: {}, provider: 'anthropic', hash: 'h' }), deep: async () => ({ facts: {}, provider: 'anthropic', hash: 'h' }) };
  const ctx = setup({ factExtractor: silent });
  const quiet = await purchase(ctx);
  const a = await reportAndCheck(ctx, quiet.order);
  assert.deepEqual(a.verdict.keys, { code: 'UNDETERMINED', ai: 'UNDETERMINED' });
  const notAllowed = await purchase(ctx, { conditions: { purchaseAuthorized: false } });
  const b = await reportAndCheck(ctx, notAllowed.order);
  assert.equal(b.status, 'HUMAN_REVIEW', 'code says AGENT, the AI said nothing: a person decides');
});

// ---- pass line 12 and the closed re-charge --------------------------------------------------------------------

test('12. an order that matches the mandate is never closed by the quick check', async () => {
  const ctx = setup();
  const variants = [
    {},
    { conditions: { quantity: null, maxTotalCents: null, exclusions: [] } },
    // The quick AI says "no" but quotes the agent log, which the quick check does not read: discarded.
    { quick: { itemMatchesMandate: { value: 'no', evidence: [{ doc: 'agent_log', quote: 'Viewed Oatly Barista Edition 1 L' }] } } },
  ];
  for (const v of variants) {
    const { order } = await purchase(ctx, v);
    const kase = await reportAndCheck(ctx, order);
    assert.equal(kase.quick.closed, false, JSON.stringify(v));
    assert.equal(kase.verdict.liable, 'BUYER', JSON.stringify(v));
  }
});

test('a quick closure followed by two BUYER keys is a contradiction and goes to a person', async () => {
  const ctx = setup();
  const { order } = await purchase(ctx, { quick: { itemMatchesMandate: { value: 'no', evidence: [{ doc: 'paypal_order', quote: '2 x Oatly Barista Edition 1 L' }] } } });
  const kase = await reportAndCheck(ctx, order);
  assert.equal(kase.quick.closed, true);
  assert.deepEqual(kase.quick.reasons.map((r) => [r.key, r.by]), [['itemMatchesMandate', 'ai']]);
  assert.equal(kase.status, 'HUMAN_REVIEW');
  assert.equal(kase.review.reason, 'QUICK_CLOSED_BUT_BOTH_BUYER');
  await assert.rejects(() => ctx.desk.resolveReview(kase.id, 'BUYER', ''), { code: 'RECHARGE_CLOSED' });
  await ctx.desk.resolveReview(kase.id, 'UNDETERMINED', 'Item looks right; the closure stands.');
  assert.equal(kase.status, 'CLOSED_UNDETERMINED_BUYER_KEEPS_REFUND');
});

test('after a quick closure no path can charge the buyer again', async () => {
  const ctx = setup();
  // rechargeGuard: even if the verdict were changed to BUYER afterwards
  const one = await purchase(ctx, { conditions: { purchaseAuthorized: false } });
  const a = await reportAndCheck(ctx, one.order);
  await ctx.desk.settle(a.id);
  a.verdict = { ...a.verdict, liable: 'BUYER' };
  a.notice = { chargeNotBefore: new Date(0).toISOString() };
  ctx.clock.fastForwardDays(30);
  assert.equal((await ctx.desk.recharge(a.id)).blockedBy, 'RECHARGE_CLOSED_BY_QUICK_CHECK');
  // settle: a BUYER verdict on a closed case is refused before any money moves
  const two = await purchase(ctx, { conditions: { purchaseAuthorized: false } });
  const b = await reportAndCheck(ctx, two.order);
  b.verdict = { ...b.verdict, liable: 'BUYER' };
  await assert.rejects(() => ctx.desk.settle(b.id), { code: 'RECHARGE_CLOSED' });
  assert.equal(b.recharge, null);
  await ctx.desk.processDue();
  assert.equal(ctx.paypal.totals().captures, 2, 'only the two purchases were ever captured');
});

// ---- 2.3 deep check ---------------------------------------------------------------------------------------------

test('deep check: the first-deviation quote must be in that step, otherwise it is kept as not verified', async () => {
  const ctx = setup();
  const right = await purchase(ctx, { conditions: { purchaseAuthorized: false }, deep: { firstDeviation: { kind: 'STEP', step: 6, condition: 'purchaseAuthorized', quote: 'Paid $14.98 with the saved PayPal wallet' } } });
  const a = await reportAndCheck(ctx, right.order);
  assert.equal(a.investigation.firstDeviation.verified, true);
  assert.equal(a.investigation.firstDeviation.step, 6);

  const wrongStep = await purchase(ctx, { conditions: { purchaseAuthorized: false }, deep: { firstDeviation: { kind: 'STEP', step: 5, condition: 'purchaseAuthorized', quote: 'Paid $14.98 with the saved PayPal wallet' } } });
  const b = await reportAndCheck(ctx, wrongStep.order);
  assert.equal(b.investigation.firstDeviation.verified, false);
  assert.match(b.investigation.firstDeviation.note, /not verified/i);
  assert.equal(b.verdict.liable, 'AGENT', 'an unverified first deviation is a report, not a decision');

  const none = await purchase(ctx, { deep: { firstDeviation: { kind: 'NONE' } } });
  const c = await reportAndCheck(ctx, none.order);
  assert.equal(c.investigation.firstDeviation.kind, 'NONE');
  assert.equal(c.investigation.firstDeviation.verified, null);
});

test('deep check: code lists violation candidates per step for the AI', async () => {
  const log = [
    { step: 1, at: '2026-11-02T09:00:00Z', actor: 'user', action: 'message', content: INSTRUCTION },
    { step: 2, at: '2026-11-02T09:01:00Z', actor: 'agent', action: 'search', content: 'Searched for barista oat milk.' },
    { step: 3, at: '2026-11-02T09:02:00Z', actor: 'agent', action: 'add_to_cart', content: 'Added 3 x Oatly Barista Edition 1 L (unsweetened).', sku: 'OAT-BAR-1L', qty: 3, amountCents: 1647 },
    { step: 4, at: '2026-11-02T09:03:00Z', actor: 'agent', action: 'add_to_cart', content: 'Added 1 x Sweetened Vanilla Oat Milk 1 L.', sku: 'OAT-VAN-1L', qty: 1, amountCents: 1499 },
    { step: 5, at: '2026-11-02T09:04:00Z', actor: 'agent', action: 'remove_from_cart', content: 'Removed the vanilla oat milk.', sku: 'OAT-VAN-1L', qty: 1, amountCents: 1499 },
    { step: 6, at: '2026-11-02T09:05:00Z', actor: 'agent', action: 'pay', content: 'Paid with the saved PayPal wallet.', amountCents: 2047 },
  ];
  const found = violationCandidates(log, { ...MANDATE, purchaseAuthorized: false }).map((c) => `${c.step}:${c.condition}`);
  assert.deepEqual(found.sort(), ['3:quantityMatchesMandate', '4:exclusionsRespected', '4:quantityMatchesMandate', '4:withinSpendingLimit', '6:purchaseAuthorized'].sort());
  assert.ok(!found.includes('3:exclusionsRespected'), '"unsweetened" is not the excluded word "sweetened"');

  const ctx = setup();
  const { order } = await purchase(ctx, { conditions: { purchaseAuthorized: false } });
  const kase = await reportAndCheck(ctx, order);
  assert.deepEqual(kase.investigation.candidates.map((c) => `${c.step}:${c.condition}`), ['5:purchaseAuthorized', '6:purchaseAuthorized']);
});

test('deep check: a checkout or pay total over the limit is a candidate even when the cart alone is under it', () => {
  // Cart $28.00 under the $30 limit; shipping takes checkout and payment to $32.00.
  const log = agentLog({ total: '$32.00', addCents: 2800, payCents: 3200 });
  assert.deepEqual(violationCandidates(log, MANDATE).map((c) => `${c.step}:${c.condition}`), ['5:withinSpendingLimit', '6:withinSpendingLimit']);
  // S27: $44.99 in the cart, $58.08 paid after shipping and tax, limit $55.
  const s27 = JSON.parse(readFileSync(new URL('../scenarios/cases.json', import.meta.url), 'utf8')).cases.find((c) => c.id === 'S27');
  const found = violationCandidates(s27.agentLog, s27.conditions).map((c) => `${c.step}:${c.condition}`);
  assert.ok(found.includes(`${s27.expected.firstDeviation}:withinSpendingLimit`), `S27 candidates: ${found.join(', ') || '(none)'}`);
});

test('fixture quick answer quotes only the mandate and the PayPal order; otherwise it answers unknown', async () => {
  const extractor = createFactExtractor({ provider: 'fixture' });
  const table = facts({
    itemMatchesMandate: ['yes', 'agent_log', 'Viewed Oatly Barista Edition 1 L'],
    exclusionsRespected: ['no', 'store_record', 'Shipped 2 x Oatly Barista Edition 1 L.'],
  });
  const answer = await extractor.quick({ evidence: {}, fixture: { facts: table } });
  assert.equal(answer.facts.itemMatchesMandate.value, 'unknown', 'the agent log is not read by the quick check');
  assert.deepEqual(answer.facts.itemMatchesMandate.evidence, []);
  assert.equal(answer.facts.exclusionsRespected.value, 'unknown', 'the store record is not read by the quick check');
  assert.deepEqual(answer.facts.quantityMatchesMandate, { value: 'yes', evidence: [{ doc: 'paypal_order', quote: '2 x Oatly Barista Edition 1 L' }] });

  // In the desk: the quick check discards nothing, and the deep check still keeps the agent-log quote.
  const ctx = setup();
  const { order } = await purchase(ctx, { fixtureFacts: facts({ itemMatchesMandate: ['yes', 'agent_log', 'Viewed Oatly Barista Edition 1 L'] }) });
  const kase = await reportAndCheck(ctx, order);
  assert.deepEqual(kase.quick.downgraded, []);
  assert.equal(kase.quick.aiFacts.itemMatchesMandate.value, 'unknown');
  assert.equal(kase.quick.closed, false);
  assert.equal(kase.investigation.facts.itemMatchesMandate.value, 'yes');
  assert.deepEqual(kase.investigation.downgraded, []);
});

test('pass line 15 times the refund from server records: report received to the COMPLETED refund lookup', async () => {
  const ctx = setup();
  const conditions = { ...MANDATE, ...OVER_MANDATE, purchaseAuthorized: false };
  const { order } = await purchase(ctx, { cart: OVER_CART, log: OVER_LOG, conditions });
  const kase = await reportAndCheck(ctx, order);
  kase.refund.secondsFromReport = 9999; // a stored duration must not reach line 15; only the two server times do
  const sc = { id: 'T1', expected: { liable: 'AGENT', firstDeviation: 5, quickClose: true }, agentLog: OVER_LOG, cart: OVER_CART, agentCart: OVER_CART, conditions };
  const row = caseRow({ sc, kase, order, db: ctx.db, policy: ctx.config.policy });
  assert.equal(row.refundSecondsFromReport, (kase.refund.completedAtMs - kase.receivedAtMs) / 1000);
});

test('evidence: each step is one line in the agreed form; old one-string logs still read as steps', async () => {
  const ctx = setup();
  const { order } = await purchase(ctx);
  const kase = await reportAndCheck(ctx, order);
  const lines = kase.investigation.evidence.agent_log.text.split('\n');
  assert.equal(lines[5], 'Step 6 · 14:02:20 · agent · pay: Paid $14.98 with the saved PayPal wallet.');
  assert.equal(lines[7], 'Cart submitted by the agent:');
  assert.equal(lines[8], '2 x Oatly Barista Edition 1 L (sku OAT-BAR-1L) @ $5.49');
  assert.equal(stepLine({ step: 12, at: '2026-11-02T23:59:01Z', actor: 'store', action: 'message', content: 'x' }), 'Step 12 · 23:59:01 · store · message: x');

  const old = await purchase(ctx, { log: ['Looked up the item.', 'Placed the order.'], fixtureFacts: facts({ itemMatchesMandate: ['yes', 'agent_log', 'Placed the order.'] }) });
  const k2 = await reportAndCheck(ctx, old.order);
  assert.deepEqual(k2.investigation.evidence.agent_log.text.split('\n').slice(0, 2), ['Step 1 · --:--:-- · agent · message: Looked up the item.', 'Step 2 · --:--:-- · agent · message: Placed the order.']);
  assert.deepEqual(k2.investigation.downgraded, []);
});

test('code computes four facts: charged-as-ordered from the agent cart, quantity only for a single item', async () => {
  const ctx = setup();
  const bag = { sku: 'BAG', name: 'Paper bag', qty: 1, unitCents: 25 };
  const { order } = await purchase(ctx, { cart: [OAT(), SHIP, bag], agentCart: CART });
  const kase = await reportAndCheck(ctx, order);
  assert.equal(kase.quick.codeFacts.storeChargedAsOrdered.value, 'no');
  assert.ok(!('quantityMatchesMandate' in kase.quick.codeFacts), 'two different items: quantity is left to the AI');
  assert.deepEqual(kase.quick.reasons.map((r) => r.key), ['storeChargedAsOrdered']);
  assert.equal(kase.investigation.facts.storeChargedAsOrdered.value, 'no');
  assert.ok(kase.investigation.overrides.some((o) => o.key === 'storeChargedAsOrdered' && o.code === 'no'));
  assert.equal(kase.verdict.liable, 'STORE');

  const many = await purchase(ctx, { cart: [OAT(549, 3), SHIP] });
  const k2 = await reportAndCheck(ctx, many.order);
  assert.equal(k2.quick.codeFacts.quantityMatchesMandate.value, 'no', 'three cartons against a mandate of two');
  assert.equal(k2.quick.closed, true);
});

// ---- 2.6 recorded answers -------------------------------------------------------------------------------------

test('recorded answers are kept apart by purpose and evidence hash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rfd-recorded-'));
  const extractor = createFactExtractor({ provider: 'recorded', recordedDir: dir });
  const evidence = { mandate: { title: 'm', text: 'Item: eggs' } };
  await assert.rejects(() => extractor.quick({ evidence, statement: '' }), /quick/);
  writeFileSync(join(dir, `quick-${evidenceHash(evidence, '', 'quick')}.json`), JSON.stringify({ facts: { itemMatchesMandate: { value: 'yes', evidence: [] } } }));
  const answer = await extractor.quick({ evidence, statement: '' });
  assert.equal(answer.facts.itemMatchesMandate.value, 'yes');
  assert.notEqual(evidenceHash(evidence, '', 'quick'), evidenceHash(evidence, '', 'deep'));
});
