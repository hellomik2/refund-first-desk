// The live shopping agent: the catalog it shops from, the tool loop that turns each tool call into a
// numbered log step, and the hand-off to the desk's saved-wallet purchase. The model is scripted here;
// the live model runs in scripts/live-agent.mjs and on the demo page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPolicy } from '../src/config.js';
import { createDb } from '../src/store.js';
import { createClock } from '../src/domain/clock.js';
import { createLedger } from '../src/domain/ledger.js';
import { createFactExtractor } from '../src/ai/facts.js';
import { createAiBudget } from '../src/ai/budget.js';
import { createDesk } from '../src/desk.js';
import { cartTotalCents } from '../src/domain/money.js';
import { loadCatalog, priceCart, searchCatalog, listingLine } from '../src/shop/catalog.js';
import { runShoppingAgent } from '../src/shop/agent.js';
import { createFakePayPal } from './fake-paypal.js';

const catalog = loadCatalog();
const prompt = (id) => catalog.prompts.find((p) => p.id === id);

/** A scripted model: each call returns the next turn. A turn is a list of tool calls, or a final text. */
function scripted(turns) {
  const seen = [];
  let i = 0;
  const turn = async (params) => {
    seen.push({ ...params, messages: structuredClone(params.messages) }); // as sent: the loop keeps appending to the same array
    const t = turns[i++];
    if (!t) return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] };
    if (typeof t === 'string') return { stop_reason: 'end_turn', content: [{ type: 'text', text: t }] };
    return { stop_reason: 'tool_use', content: t.map((c, j) => ({ type: 'tool_use', id: `tu_${i}_${j}`, name: c[0], input: c[1] || {} })) };
  };
  return { turn, seen };
}

test('search shows sponsored matches first; the hasty view hides store, variant and shipping', () => {
  const found = searchCatalog(catalog, 'aeropress go travel coffee maker');
  assert.equal(found[0].sku, '31074'); // sponsored, and cheaper before shipping and tax
  assert.ok(found.some((p) => p.sku === '10012'));
  const soap = searchCatalog(catalog, 'dish soap 16 oz');
  const full = listingLine(catalog, soap[0], 'careful');
  const short = listingLine(catalog, soap[0], 'hasty');
  assert.match(full, /Lavender/);
  assert.match(full, /KitchenHub/);
  assert.doesNotMatch(short, /Lavender|KitchenHub|shipping/);
});

test('a cart is priced with the store shipping and tax, and the PayPal cart adds up to the total', () => {
  const priced = priceCart(catalog, [{ sku: '31074', qty: 1 }]);
  assert.equal(priced.subtotalCents, 3695);
  assert.equal(priced.shippingCents, 699);
  assert.equal(priced.taxCents, 296); // 8% of 36.95, rounded
  assert.equal(priced.totalCents, 4690);
  assert.equal(cartTotalCents(priced.paypalCart), 4690);
  assert.deepEqual(priced.paypalCart.map((l) => l.sku), ['31074', 'SHIP', 'TAX']);
  assert.equal(priceCart(catalog, [{ sku: '10012', qty: 1 }]).totalCents, 3995); // free shipping, no tax
  assert.throws(() => priceCart(catalog, [{ sku: '31074', qty: 1 }, { sku: '55216', qty: 1 }]), /one store/);
});

test('each tool call becomes a numbered log step; payment goes through the desk once', async () => {
  const { turn, seen } = scripted([
    [['search_products', { query: 'aeropress go' }]],
    [['add_to_cart', { sku: '31074', quantity: 1 }]],
    [['checkout_and_pay', {}]],
    [['checkout_and_pay', {}]],
    'Bought it.',
  ]);
  const paid = [];
  const pay = async ({ store, cart }) => {
    paid.push({ store, cart });
    return { orderId: 'O1', paypalOrderId: 'PP1', totalCents: cartTotalCents(cart) };
  };
  const p = prompt('P1');
  const run = await runShoppingAgent({ catalog, instruction: p.instruction, conditions: p.conditions, kind: 'hasty', turn, pay });
  assert.equal(paid.length, 1);
  assert.equal(paid[0].store.id, 'kitchenhub');
  assert.equal(cartTotalCents(paid[0].cart), 4690);
  assert.equal(run.purchase.orderId, 'O1');
  assert.deepEqual(run.steps.map((s) => s.action), ['search', 'add_to_cart', 'pay', 'message', 'message']);
  assert.deepEqual(run.steps.map((s) => s.step), [1, 2, 3, 4, 5]);
  assert.equal(run.steps[2].amountCents, 4690);
  assert.equal(run.steps[1].sku, '31074');
  assert.equal(run.steps[3].actor, 'store');
  assert.match(run.steps[3].content, /Shipped 1 x AeroPress Go Travel Coffee Maker/);
  assert.equal(run.steps[4].actor, 'agent'); // its closing note to the buyer
  assert.deepEqual(run.storeRecord.length, 3);
  // The second pay call is refused and the refusal goes back to the model as a tool result.
  const lastUser = seen[4].messages.at(-1);
  assert.match(JSON.stringify(lastUser.content), /already paid/);
  // The hasty agent is not given the approved condition slots; the careful one is.
  assert.doesNotMatch(seen[0].messages[0].content, /Spending limit/);
  // ...and has no product-page or cart tool.
  assert.deepEqual(seen[0].tools.map((t) => t.name), ['search_products', 'add_to_cart', 'remove_from_cart', 'checkout_and_pay']);
});

test('the careful agent gets the approved conditions; an agent that does not pay leaves no purchase', async () => {
  const { turn, seen } = scripted([
    [['search_products', { query: 'AA batteries 24-pack' }]],
    [['view_product', { sku: '58824' }]],
    [['add_to_cart', { sku: '58824', quantity: 1 }], ['view_cart', {}]],
    'The AA 24-pack is in the cart at HomeBasics ($21.98 with shipping). I did not pay, as you asked.',
  ]);
  const p = prompt('P4');
  const run = await runShoppingAgent({ catalog, instruction: p.instruction, conditions: p.conditions, kind: 'careful', turn, pay: async () => assert.fail('must not pay') });
  assert.match(seen[0].messages[0].content, /May the agent pay without asking again: no/);
  assert.equal(run.purchase, null);
  assert.deepEqual(run.steps.map((s) => s.action), ['search', 'view', 'add_to_cart', 'checkout', 'message']);
  assert.equal(run.steps[3].amountCents, 2198);
  // Both tool results of one turn go back in one user message.
  assert.equal(seen[3].messages.at(-1).content.length, 2);
});

test('the run stops at the call cap', async () => {
  const { turn, seen } = scripted(Array.from({ length: 30 }, () => [['search_products', { query: 'soap' }]]));
  const run = await runShoppingAgent({ catalog, instruction: 'x', conditions: prompt('P2').conditions, kind: 'careful', turn, pay: async () => ({}), maxCalls: 4 });
  assert.equal(seen.length, 4);
  assert.equal(run.stopReason, 'CALL_CAP');
});

test('a live run ends in a real desk order: the code key reads the cart the agent built', async () => {
  const config = { policy: defaultPolicy(), demoWallet: { vaultId: 'VAULT-DEMO' }, storePayoutEmail: 'store@example.test', publicBaseUrl: 'http://localhost' };
  const db = createDb({ policy: config.policy });
  const desk = createDesk({ db, paypal: createFakePayPal(), factExtractor: createFactExtractor({ provider: 'fixture' }), clock: createClock(db), ledger: createLedger(db), config, pollMs: 1, refundWaitMs: 20 });
  const buyer = desk.createBuyer({ name: 'Live', useDemoWallet: true });
  const p = prompt('P1');
  const mandate = desk.approveMandate(desk.draftMandate({ buyerId: buyer.id, instruction: p.instruction, conditions: p.conditions }).id);
  const { turn } = scripted([[['search_products', { query: 'aeropress go' }]], [['add_to_cart', { sku: '31074', quantity: 1 }]], [['checkout_and_pay', {}]], 'Done.']);
  const pay = async ({ store, cart }) => {
    const order = await desk.agentPurchase({ mandateId: mandate.id, store, cart, agentCart: cart, agentLog: [], storeRecord: [] });
    return { orderId: order.id, paypalOrderId: order.paypal.orderId, totalCents: order.totalCents };
  };
  const run = await runShoppingAgent({ catalog, instruction: p.instruction, conditions: p.conditions, kind: 'hasty', turn, pay });
  desk.attachAgentRecord(run.purchase.orderId, { agentLog: run.steps, storeRecord: run.storeRecord });
  const order = db.data.orders[run.purchase.orderId];
  assert.equal(order.agentLog.length, run.steps.length);
  assert.equal(order.totalCents, 4690);

  const { kase } = await desk.reportProblem({ orderId: order.id, statement: 'This is not what I asked the agent to buy.' });
  assert.equal(kase.path, 'REFUND_FIRST');
  await desk.investigate(kase.id);
  // Over the $45 limit, computed by code from the PayPal order: the quick check closes the re-charge.
  assert.equal(kase.quick.codeFacts.withinSpendingLimit.value, 'no');
  assert.equal(kase.quick.codeFacts.storeChargedAsOrdered.value, 'yes');
  assert.equal(kase.rechargeClosed, true);
  assert.ok(kase.investigation.steps.some((s) => s.action === 'pay' && s.amountCents === 4690));
  assert.throws(() => desk.attachAgentRecord(order.id, { agentLog: [], storeRecord: [] }), /report/); // the record is fixed once a case exists
});

test('agent calls have their own daily run cap and do not use up the investigator calls', () => {
  const budget = createAiBudget({ file: join(mkdtempSync(join(tmpdir(), 'rfd-agent-')), 'ai-usage.jsonl'), dailyCallCap: 2, spendCapUsd: 100 });
  const at = new Date().toISOString();
  for (let i = 0; i < 5; i++) budget.record({ at, purpose: 'agent', runId: 'R1', model: 'claude-haiku-5-5', inputTokens: 10, outputTokens: 10 });
  assert.equal(budget.blockedBy(), null);
  assert.equal(budget.agentBlockedBy({ dailyRunCap: 2 }), null);
  budget.record({ at, purpose: 'agent', runId: 'R2', model: 'claude-haiku-5-5', inputTokens: 10, outputTokens: 10 });
  assert.equal(budget.agentBlockedBy({ dailyRunCap: 2 }), 'DAILY_AGENT_RUN_CAP');
  assert.equal(budget.runUsd('R1') > 0, true);
});

test('a live run through the shopper names the agent on the order (the case book groups by it)', async () => {
  const { createLiveShopper } = await import('../src/shop/run.js');
  const config = { policy: defaultPolicy(), demoWallet: { vaultId: 'VAULT-DEMO' }, storePayoutEmail: 'store@example.test', publicBaseUrl: 'http://localhost' };
  const db = createDb({ policy: config.policy });
  const desk = createDesk({ db, paypal: createFakePayPal(), factExtractor: createFactExtractor({ provider: 'fixture' }), clock: createClock(db), ledger: createLedger(db), config, pollMs: 1, refundWaitMs: 20 });
  const buyer = desk.createBuyer({ name: 'Live', useDemoWallet: true });
  const runOnce = async (kind) => {
    const p = prompt('P1');
    const m = desk.draftMandate({ buyerId: buyer.id, instruction: p.instruction, conditions: p.conditions });
    m.live = { promptId: 'P1' };
    desk.approveMandate(m.id);
    const { turn } = scripted([[['search_products', { query: 'aeropress go' }]], [['add_to_cart', { sku: '31074', quantity: 1 }]], [['checkout_and_pay', {}]], 'Done.']);
    const shopper = createLiveShopper({ desk, db, catalog, provider: async () => ({ agentTurn: turn }), budget: { agentBlockedBy: () => null, releaseRun: () => {}, spendBlockedBy: () => null, runUsd: () => 0 }, caps: { dailyRunCap: 9, runsPerWorkspace: 9, maxCalls: 16 } });
    await shopper.shop({ mandateId: m.id, kind });
    return db.data.orders[m.live.orderId];
  };
  const careful = await runOnce('careful');
  const hasty = await runOnce('hasty');
  assert.deepEqual(careful.agent, { id: 'live-careful', name: 'Careful agent (live Claude)' });
  assert.deepEqual(hasty.agent, { id: 'live-hasty', name: 'Hasty agent (live Claude)' });
  assert.equal(careful.agentLog.length > 0, true);
});

test('after the merge: a live purchase fixes the buyer-record limit, and the case book shows each live agent apart', async () => {
  const { createLiveShopper } = await import('../src/shop/run.js');
  const { buildCaseBook, recordsFromState } = await import('../src/domain/casebook.js');
  const config = { policy: defaultPolicy(), demoWallet: { vaultId: 'VAULT-DEMO' }, storePayoutEmail: 'store@example.test', publicBaseUrl: 'http://localhost' };
  const db = createDb({ policy: config.policy });
  const clock = createClock(db);
  const desk = createDesk({ db, paypal: createFakePayPal(), factExtractor: createFactExtractor({ provider: 'fixture' }), clock, ledger: createLedger(db), config, pollMs: 1, refundWaitMs: 20 });
  const buyer = desk.createBuyer({ name: 'Live', useDemoWallet: true });
  // An earlier case of this buyer: found responsible, notice period over, charged again. It must lower the next limit.
  db.data.cases['C-EARLIER'] = { id: 'C-EARLIER', buyerId: buyer.id, orderId: 'O-EARLIER', receivedAt: new Date(clock.now()).toISOString(), status: 'CLOSED_BUYER_RESPONSIBLE', verdict: { liable: 'BUYER', agreed: true, rule: 'TWO_KEYS' }, recharge: { status: 'COMPLETED' } };
  const runOnce = async (kind) => {
    const p = prompt('P1');
    const m = desk.draftMandate({ buyerId: buyer.id, instruction: p.instruction, conditions: p.conditions });
    m.live = { promptId: 'P1' };
    desk.approveMandate(m.id);
    const { turn } = scripted([[['search_products', { query: 'aeropress go' }]], [['add_to_cart', { sku: '31074', quantity: 1 }]], [['checkout_and_pay', {}]], 'Done.']);
    const shopper = createLiveShopper({ desk, db, catalog, provider: async () => ({ agentTurn: turn }), budget: { agentBlockedBy: () => null, releaseRun: () => {}, spendBlockedBy: () => null, runUsd: () => 0 }, caps: { dailyRunCap: 9, runsPerWorkspace: 9, maxCalls: 16 } });
    await shopper.shop({ mandateId: m.id, kind });
    return db.data.orders[m.live.orderId];
  };
  const careful = await runOnce('careful');
  const hasty = await runOnce('hasty');
  for (const o of [careful, hasty]) {
    assert.equal(o.protection.limits.perCaseCapCents, config.policy.perCaseCapCents - config.policy.trustStepCents);
    assert.equal(o.protection.limits.refundsPer30Days, config.policy.refundsPer30Days - 1);
    assert.deepEqual(o.protection.limits.basis.map((b) => [b.caseId, b.effect]), [['C-EARLIER', 'DOWN']]);
  }
  db.data.cases['C-C'] = { id: 'C-C', buyerId: buyer.id, orderId: careful.id, receivedAt: new Date(clock.now()).toISOString(), status: 'CLOSED_BUYER_RESPONSIBLE', verdict: { liable: 'BUYER', agreed: true } };
  db.data.cases['C-H'] = { id: 'C-H', buyerId: buyer.id, orderId: hasty.id, receivedAt: new Date(clock.now()).toISOString(), status: 'CLOSED_AGENT_RESPONSIBLE', verdict: { liable: 'AGENT', agreed: true } };
  const agents = Object.fromEntries(buildCaseBook(recordsFromState(db.data)).agents.map((g) => [g.id, g]));
  assert.equal(agents['live-careful'].name, 'Careful agent (live Claude)');
  assert.equal(agents['live-careful'].outcomes.BUYER, 1);
  assert.equal(agents['live-hasty'].name, 'Hasty agent (live Claude)');
  assert.equal(agents['live-hasty'].outcomes.AGENT, 1);
  assert.equal(agents.scripted.cases, 1); // the earlier case has no live order behind it
});

// ---- money guards on the live agent (independent check 2, 2026-11-12) ---------------------------------------

/** A desk with one buyer and approved live mandates; the PayPal stand-in is returned so a test can break it. */
function liveDesk(count = 1) {
  const config = { policy: defaultPolicy(), demoWallet: { vaultId: 'VAULT-DEMO' }, storePayoutEmail: 'store@example.test', publicBaseUrl: 'http://localhost' };
  const db = createDb({ policy: config.policy });
  const paypal = createFakePayPal();
  const desk = createDesk({ db, paypal, factExtractor: createFactExtractor({ provider: 'fixture' }), clock: createClock(db), ledger: createLedger(db), config, pollMs: 1, refundWaitMs: 20 });
  const buyer = desk.createBuyer({ name: 'Live', useDemoWallet: true });
  const p = prompt('P1');
  const mandates = Array.from({ length: count }, () => {
    const m = desk.draftMandate({ buyerId: buyer.id, instruction: p.instruction, conditions: p.conditions });
    m.live = { promptId: 'P1' };
    return desk.approveMandate(m.id);
  });
  return { db, desk, paypal, mandates };
}

test('runs started at the same moment cannot pass the daily run cap together', async () => {
  const { createLiveShopper } = await import('../src/shop/run.js');
  const { db, desk, mandates } = liveDesk(3);
  const budget = createAiBudget({ file: join(mkdtempSync(join(tmpdir(), 'rfd-agent-')), 'ai-usage.jsonl'), dailyCallCap: 40, spendCapUsd: 100 });
  // Each model call is counted in the shared file under its run id, as the live provider does.
  const provider = async () => ({
    agentTurn: async ({ runId }) => {
      budget.record({ at: new Date().toISOString(), purpose: 'agent', runId, model: 'claude-haiku-5-5', inputTokens: 10, outputTokens: 10 });
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Nothing to buy.' }] };
    },
  });
  const shopper = createLiveShopper({ desk, db, catalog, provider, budget, caps: { dailyRunCap: 1, runsPerWorkspace: 9, maxCalls: 4 } });
  const results = await Promise.allSettled(mandates.map((m) => shopper.shop({ mandateId: m.id, kind: 'careful' })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.deepEqual(results.filter((r) => r.status === 'rejected').map((r) => r.reason.code), ['DAILY_AGENT_RUN_CAP', 'DAILY_AGENT_RUN_CAP']);
  assert.equal(budget.agentBlockedBy({ dailyRunCap: 1 }), 'DAILY_AGENT_RUN_CAP');
});

test('one instruction started twice at the same moment runs once', async () => {
  const { createLiveShopper } = await import('../src/shop/run.js');
  const { db, desk, mandates } = liveDesk(1);
  let starts = 0;
  const provider = async () => ({ agentTurn: async () => (starts++, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Nothing to buy.' }] }) });
  const budget = createAiBudget({ file: join(mkdtempSync(join(tmpdir(), 'rfd-agent-')), 'ai-usage.jsonl'), dailyCallCap: 40, spendCapUsd: 100 });
  const shopper = createLiveShopper({ desk, db, catalog, provider, budget, caps: { dailyRunCap: 9, runsPerWorkspace: 9, maxCalls: 4 } });
  const results = await Promise.allSettled([shopper.shop({ mandateId: mandates[0].id, kind: 'careful' }), shopper.shop({ mandateId: mandates[0].id, kind: 'hasty' })]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'ALREADY_RUN');
  assert.equal(starts, 1);
});

test('a run that cannot reach the model leaves the instruction unrun and frees its place under the cap', async () => {
  const { createLiveShopper } = await import('../src/shop/run.js');
  const { db, desk, mandates } = liveDesk(1);
  const budget = createAiBudget({ file: join(mkdtempSync(join(tmpdir(), 'rfd-agent-')), 'ai-usage.jsonl'), dailyCallCap: 40, spendCapUsd: 100 });
  const shopper = createLiveShopper({ desk, db, catalog, provider: async () => { throw new Error('no model'); }, budget, caps: { dailyRunCap: 1, runsPerWorkspace: 9, maxCalls: 4 } });
  await assert.rejects(shopper.shop({ mandateId: mandates[0].id, kind: 'careful' }), /no model/);
  assert.equal(mandates[0].live.status, undefined);
  assert.equal(budget.agentBlockedBy({ dailyRunCap: 1 }), null);
});

/** A live run on a desk whose PayPal stand-in is replaced by `charge` (it gets the real stand-in's charge). */
async function liveRunWith(charge, turns) {
  const { createLiveShopper } = await import('../src/shop/run.js');
  const ctx = liveDesk(1);
  const real = ctx.paypal.chargeSavedWallet;
  const sent = [];
  ctx.paypal.chargeSavedWallet = async (args) => (sent.push(args.requestId), charge(real, args, sent.length));
  const { turn } = scripted(turns);
  const budget = createAiBudget({ file: join(mkdtempSync(join(tmpdir(), 'rfd-agent-')), 'ai-usage.jsonl'), dailyCallCap: 40, spendCapUsd: 100 });
  const shopper = createLiveShopper({ desk: ctx.desk, db: ctx.db, catalog, provider: async () => ({ agentTurn: turn }), budget, caps: { dailyRunCap: 9, runsPerWorkspace: 9, maxCalls: 16 } });
  const { mandate, run } = await shopper.shop({ mandateId: ctx.mandates[0].id, kind: 'careful' });
  return { ...ctx, mandate, run, sent };
}
const BUY_COFFEE = [[['search_products', { query: 'aeropress go' }]], [['add_to_cart', { sku: '31074', quantity: 1 }]], [['checkout_and_pay', {}]]];

test('a payment whose answer was lost is asked again under the same request id: charged once, recorded, reportable', async () => {
  // PayPal takes the money, then the first answer is lost on the way back.
  const { db, desk, paypal, mandate, run, sent } = await liveRunWith(async (real, args, n) => {
    const res = await real(args);
    if (n === 1) throw new Error('socket hang up');
    return res;
  }, [...BUY_COFFEE, 'Done.']);
  assert.equal(new Set(sent).size, 1, 'one request id for the one payment');
  assert.equal(paypal.totals().captures, 1, 'charged once');
  assert.equal(mandate.live.status, 'PAID');
  const order = db.data.orders[mandate.live.orderId];
  assert.ok(order.paypal?.captureId, 'the capture is on the order');
  assert.equal(db.data.ledger.filter((l) => l.orderId === order.id && l.kind === 'PURCHASE_CAPTURED').length, 1);
  assert.ok(run.purchase);
  const { kase } = await desk.reportProblem({ orderId: order.id, statement: 'This is not what I asked the agent to buy.' });
  assert.ok(kase.id);
});

test('when PayPal clearly refuses the payment, the agent may pay again (a new request)', async () => {
  const { PayPalError } = await import('../src/paypal/client.js');
  const { db, paypal, mandate, sent } = await liveRunWith(async (real, args, n) => {
    if (n === 1) throw new PayPalError({ label: 'charge-saved-wallet', status: 422, name: 'UNPROCESSABLE_ENTITY', issues: [{ issue: 'INSTRUMENT_DECLINED' }] });
    return real(args);
  }, [...BUY_COFFEE, [['checkout_and_pay', {}]], 'Done.']);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0], sent[1], 'the second try is a new payment request');
  assert.equal(paypal.totals().captures, 1);
  assert.equal(mandate.live.status, 'PAID');
  assert.equal(Object.values(db.data.orders).filter((o) => o.storePayable.status === 'CANCELLED').length, 1);
});

test('a payment PayPal never answered stays unconfirmed: never "nothing was charged", and the next try asks again under the same id', async () => {
  // No answer at all, twice: the desk cannot tell whether money moved.
  const silent = await liveRunWith(async () => {
    throw new Error('timeout');
  }, [...BUY_COFFEE, 'Done.']);
  assert.equal(silent.mandate.live.status, 'PAYMENT_UNCONFIRMED');
  const pending = silent.db.data.orders[silent.mandate.live.orderId];
  assert.equal(pending.storePayable.status, 'PAYMENT_UNCONFIRMED');
  assert.equal(new Set(silent.sent).size, 1);

  // PayPal had taken it; the agent's next try asks about that payment again and records it, with no second charge.
  const late = await liveRunWith(async (real, args, n) => {
    const res = await real(args);
    if (n <= 2) throw new Error('timeout');
    return res;
  }, [...BUY_COFFEE, [['checkout_and_pay', {}]], 'Done.']);
  assert.equal(new Set(late.sent).size, 1, 'every try used the same request id');
  assert.equal(late.paypal.totals().captures, 1);
  assert.equal(late.mandate.live.status, 'PAID');
});

test('the prepared-case purchase also pays once per instruction', async () => {
  const { desk, paypal, mandates } = liveDesk(1);
  const store = { id: 'kitchenhub', name: 'KitchenHub' };
  const cart = [{ sku: '31074', name: 'AeroPress Go', qty: 1, unitCents: 3995 }];
  await desk.agentPurchase({ mandateId: mandates[0].id, store, cart, agentCart: cart, agentLog: [], storeRecord: [] });
  const before = paypal.chargeSavedWallet;
  let charges = 0;
  paypal.chargeSavedWallet = async (args) => (charges++, before(args));
  await assert.rejects(desk.agentPurchase({ mandateId: mandates[0].id, store, cart, agentCart: cart, agentLog: [], storeRecord: [] }), (err) => err.code === 'ALREADY_PAID_ONCE');
  assert.equal(charges, 0);
});

test('code counts the quantity when the order also has a tax line (the only product line is the one that counts)', async () => {
  const { codeFacts } = await import('../src/domain/verdict.js');
  const priced = priceCart(catalog, [{ sku: '31074', qty: 2 }]);
  assert.ok(priced.paypalCart.some((l) => l.sku === 'TAX'), 'this store adds a tax line');
  const facts = codeFacts({ mandate: { conditions: { purchaseAuthorized: true, maxTotalCents: null, quantity: 1 } }, paypalOrder: { totalCents: priced.totalCents, items: priced.paypalCart } });
  assert.equal(facts.quantityMatchesMandate?.value, 'no');
  assert.match(facts.quantityMatchesMandate.quote, /quantity 2 vs mandate quantity 1/);
});

test('the spend cap is checked before every model call of a run, not only at its start', async () => {
  const { createLiveShopper } = await import('../src/shop/run.js');
  const { db, desk, mandates } = liveDesk(1);
  const budget = createAiBudget({ file: join(mkdtempSync(join(tmpdir(), 'rfd-agent-')), 'ai-usage.jsonl'), dailyCallCap: 40, spendCapUsd: 0.5 });
  let calls = 0;
  const provider = async () => ({
    agentTurn: async ({ runId }) => {
      calls += 1;
      budget.record({ at: new Date().toISOString(), purpose: 'agent', runId, model: 'claude-haiku-5-5', inputTokens: 0, outputTokens: 1_000_000 }); // $0.50: the cap
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu_${calls}`, name: 'search_products', input: { query: 'soap' } }] };
    },
  });
  const shopper = createLiveShopper({ desk, db, catalog, provider, budget, caps: { dailyRunCap: 9, runsPerWorkspace: 9, maxCalls: 16 } });
  const { mandate, run } = await shopper.shop({ mandateId: mandates[0].id, kind: 'careful' });
  assert.equal(calls, 1);
  assert.equal(run.stopReason, 'AI_SPEND_CAP');
  assert.equal(mandate.live.status, 'NOT_PAID');
});

test('a payment with no answer is not a buyer who turned back at PayPal: Cancel is refused and the order stays unconfirmed', async () => {
  // PayPal takes the money and the answer is lost every time: the desk cannot tell whether money moved.
  const { db, desk, paypal, mandate } = await liveRunWith(async (real, args) => {
    await real(args);
    throw new Error('socket hang up');
  }, [...BUY_COFFEE, 'Done.']);
  assert.equal(mandate.live.status, 'PAYMENT_UNCONFIRMED');
  assert.equal(paypal.totals().captures, 1, 'PayPal did take the money');
  const order = db.data.orders[mandate.live.orderId];
  assert.equal(order.payment, 'SAVED_WALLET');
  assert.throws(() => desk.cancelConsentPurchase(order.id), (err) => err.code === 'NOT_A_CONSENT_CHECKOUT');
  assert.equal(order.storePayable.status, 'PAYMENT_UNCONFIRMED', 'never "cancelled, nothing was charged"');
  assert.ok(!order.consentCancelled);
});

// ---- payment states that are not a clear answer (PayPal Orders v2 capture status: COMPLETED, DECLINED,
// PARTIALLY_REFUNDED, PENDING, REFUNDED, FAILED; order status VOIDED). Only DECLINED, FAILED or VOIDED say no money moved.

const KITCHEN = { id: 'kitchenhub', name: 'KitchenHub' };
const COFFEE_CART = [{ sku: '31074', name: 'AeroPress Go', qty: 1, unitCents: 3995 }];

test('a capture PayPal answers PENDING is not cancelled: no new payment, and it is recorded once PayPal completes it', async () => {
  const { db, desk, paypal, mandates } = liveDesk(1);
  const buy = () => desk.agentPurchase({ mandateId: mandates[0].id, store: KITCHEN, cart: COFFEE_CART, agentCart: COFFEE_CART, agentLog: [], storeRecord: [] });
  const sent = [];
  const real = paypal.chargeSavedWallet;
  paypal.chargeSavedWallet = async (args) => (sent.push(args.requestId), real(args));
  paypal.captureStatus = 'PENDING';
  await assert.rejects(buy(), (err) => err.code === 'PAYMENT_UNCONFIRMED' && !!err.orderId);
  paypal.captureStatus = 'COMPLETED';
  const orders = () => Object.values(db.data.orders);
  assert.equal(orders().length, 1);
  assert.equal(orders()[0].storePayable.status, 'PAYMENT_UNCONFIRMED', 'money may move: never "cancelled, nothing was charged"');

  // Asked again while PayPal is still processing: still unconfirmed, and no new payment request goes out.
  await assert.rejects(buy(), (err) => err.code === 'PAYMENT_UNCONFIRMED');
  assert.equal(paypal.totals().captures, 1);
  assert.equal(new Set(sent).size, 1, 'never a new payment request');

  // PayPal completes the capture: the next ask records it, still one payment.
  paypal.completePendingCaptures();
  const order = await buy();
  assert.equal(order.paypal.status, 'COMPLETED');
  assert.equal(orders().length, 1);
  assert.equal(paypal.totals().captures, 1, 'one instruction, one payment');
  assert.equal(new Set(sent).size, 1);
  assert.equal(db.data.ledger.filter((l) => l.kind === 'PURCHASE_CAPTURED').length, 1);
});

test('a capture PayPal answers DECLINED is a clear failure: nothing was charged, a new payment may go out', async () => {
  const { db, desk, paypal, mandates } = liveDesk(1);
  const buy = () => desk.agentPurchase({ mandateId: mandates[0].id, store: KITCHEN, cart: COFFEE_CART, agentCart: COFFEE_CART, agentLog: [], storeRecord: [] });
  paypal.captureStatus = 'DECLINED';
  await assert.rejects(buy(), (err) => err.code === 'CAPTURE_NOT_COMPLETED');
  assert.equal(Object.values(db.data.orders)[0].storePayable.status, 'CANCELLED');
  paypal.captureStatus = 'COMPLETED';
  const order = await buy();
  assert.equal(order.paypal.status, 'COMPLETED');
  assert.equal(Object.values(db.data.orders).length, 2, 'the declined order stays cancelled; the new one is paid');
});

test('Cancel on an unconfirmed payment, then the same instruction again: still one payment (codex round 3 path)', async () => {
  const { db, desk, paypal, mandates } = liveDesk(1);
  const buy = () => desk.agentPurchase({ mandateId: mandates[0].id, store: KITCHEN, cart: COFFEE_CART, agentCart: COFFEE_CART, agentLog: [], storeRecord: [] });
  const real = paypal.chargeSavedWallet;
  let lose = 2; // PayPal takes the money; the first two answers are lost
  paypal.chargeSavedWallet = async (args) => {
    const res = await real(args);
    if (lose-- > 0) throw new Error('socket hang up');
    return res;
  };
  await assert.rejects(buy(), (err) => err.code === 'PAYMENT_UNCONFIRMED');
  const first = Object.values(db.data.orders)[0];
  assert.throws(() => desk.cancelConsentPurchase(first.id), (err) => err.code === 'NOT_A_CONSENT_CHECKOUT');
  const order = await buy();
  assert.equal(order.id, first.id);
  assert.equal(paypal.totals().captures, 1);
  assert.equal(paypal.totals().capturedCents, 3995);
  assert.equal(db.data.ledger.filter((l) => l.kind === 'PURCHASE_CAPTURED').length, 1);
});

test('a retry with a different cart records the order that was actually paid, never the new cart', async () => {
  // The coffee maker payment goes through but both answers are lost; the agent then switches to dish soap and pays.
  // The desk asks PayPal about the first order again (same request id): what was paid is the coffee maker.
  const coffee = priceCart(catalog, [{ sku: '31074', qty: 1 }]);
  const soap = priceCart(catalog, [{ sku: '55216', qty: 1 }]);
  const { db, paypal, mandate, run } = await liveRunWith(async (real, args, n) => {
    const res = await real(args);
    if (n <= 2) throw new Error('timeout');
    return res;
  }, [
    ...BUY_COFFEE,
    [['remove_from_cart', { sku: '31074' }]],
    [['add_to_cart', { sku: '55216', quantity: 1 }]],
    [['checkout_and_pay', {}]],
    'Done.',
  ]);
  assert.equal(paypal.totals().captures, 1);
  assert.equal(paypal.totals().capturedCents, coffee.totalCents);
  const order = db.data.orders[mandate.live.orderId];
  assert.equal(order.totalCents, coffee.totalCents);
  const paidLine = order.agentLog.filter((s) => s.action === 'pay').at(-1);
  assert.equal(paidLine.amountCents, coffee.totalCents, 'the pay step shows what PayPal charged');
  assert.match(paidLine.content, /\$46\.90/);
  assert.doesNotMatch(paidLine.content, /^Paid \$8\.48/);
  const shipped = order.agentLog.filter((s) => s.actor === 'store').map((s) => s.content).join(' ');
  assert.match(shipped, /AeroPress Go/);
  assert.doesNotMatch(shipped, /Dish Soap/, 'the store never ships what was not paid for');
  const store = order.storeRecord.join(' ');
  assert.match(store, /\$46\.90/);
  assert.match(store, /AeroPress Go/);
  assert.doesNotMatch(store, /Dish Soap|\$8\.48/);
  assert.equal(run.purchase.totalCents, coffee.totalCents);
  assert.equal(mandate.live.cart.totalCents, coffee.totalCents, 'the page shows the cart that was paid');
  assert.ok(soap.totalCents !== coffee.totalCents);
});
