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
    const shopper = createLiveShopper({ desk, db, catalog, provider: async () => ({ agentTurn: turn }), budget: { agentBlockedBy: () => null, runUsd: () => 0 }, caps: { dailyRunCap: 9, runsPerWorkspace: 9, maxCalls: 16 } });
    await shopper.shop({ mandateId: m.id, kind });
    return db.data.orders[m.live.orderId];
  };
  const careful = await runOnce('careful');
  const hasty = await runOnce('hasty');
  assert.deepEqual(careful.agent, { id: 'live-careful', name: 'Careful agent (live Claude)' });
  assert.deepEqual(hasty.agent, { id: 'live-hasty', name: 'Hasty agent (live Claude)' });
  assert.equal(careful.agentLog.length > 0, true);
});
