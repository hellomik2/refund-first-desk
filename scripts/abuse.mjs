// Reproduces the failure and abuse conditions on the real PayPal sandbox and checks each one against
// what PayPal itself reports (refunds on the order, charge calls that PayPal accepted), not only
// against the desk's own records. The same conditions run on the in-memory stand-in in test/desk.test.js.
//
// Usage:  node scripts/abuse.mjs       Writes data/evidence/abuse-<time>.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, fixtureFromCase } from '../src/context.js';

const ctx = createContext({ dbName: 'abuse', fresh: true, overrides: { POLICY_RESERVE_START_CENTS: '1000000' } });
const { desk, db, clock, paypal, config } = ctx;
const CASES = Object.fromEntries(JSON.parse(readFileSync(join(config.root, 'scenarios', 'cases.json'), 'utf8')).cases.map((c) => [c.id, c]));

/** Calls PayPal accepted (2xx) with this label, optionally only those whose path contains `part`. */
const accepted = (label, part = '') => db.data.paypalCalls.filter((c) => c.label === label && c.status >= 200 && c.status < 300 && c.path.includes(part)).length;
const refundsAtPayPal = async (order) => (await paypal.getOrder(order.paypal.orderId)).body.purchase_units?.[0]?.payments?.refunds?.length || 0;

async function purchase(buyer, caseId) {
  const sc = CASES[caseId];
  const mandate = desk.approveMandate(desk.draftMandate({ buyerId: buyer.id, instruction: sc.instruction, conditions: sc.conditions }).id);
  const order = await desk.agentPurchase({ mandateId: mandate.id, store: sc.store, cart: sc.cart, agentCart: sc.agentCart, agentLog: sc.agentLog, storeRecord: sc.storeRecord, scenarioId: sc.id, ...fixtureFromCase(sc) });
  return { order, sc };
}
async function toVerdict(order, sc) {
  const { kase } = await desk.reportProblem({ orderId: order.id, statement: sc.complaint });
  await desk.investigate(kase.id);
  await desk.settle(kase.id);
  return kase;
}
const buyer = (n) => desk.createBuyer({ name: `Abuse check ${n}`, useDemoWallet: true });

const rows = [];
async function check(condition, expected, run) {
  const row = { condition, expected };
  try {
    Object.assign(row, await run());
  } catch (err) {
    row.pass = false;
    row.error = err.message;
  }
  rows.push(row);
  console.log(`${row.pass ? 'PASS' : 'FAIL'}  ${condition}\n      ${row.error ? `ERROR ${row.error}` : row.observed}`);
}

console.log(`PayPal sandbox | AI provider: ${config.ai.provider}\n`);

let first; // reused by condition 2
await check('1. The same order is reported twice (two reports at the same moment)', 'one refund', async () => {
  const { order, sc } = await purchase(buyer(1), 'S03');
  const [a, b] = await Promise.all([desk.reportProblem({ orderId: order.id, statement: sc.complaint }), desk.reportProblem({ orderId: order.id, statement: 'Reporting again.' })]);
  const refunds = await refundsAtPayPal(order);
  const refundCalls = accepted('refund-capture', order.paypal.captureId);
  first = { order, kase: a.kase };
  return { pass: refunds === 1 && refundCalls === 1 && a.kase.id === b.kase.id, observed: `refunds on the PayPal order: ${refunds}; refund calls sent: ${refundCalls}; second report marked duplicate: ${a.duplicate || b.duplicate}`, paypalOrderId: order.paypal.orderId };
});

await check('2. The same refund request is sent again (same request id)', 'no second refund', async () => {
  const { order, kase } = first;
  const again = await paypal.refundCapture(order.paypal.captureId, { requestId: kase.refund.requestId });
  const refunds = await refundsAtPayPal(order);
  return { pass: again.body.id === kase.refund.id && refunds === 1, observed: `PayPal answered with the first refund (${again.body.id === kase.refund.id ? 'same id' : 'a different id'}); refunds on the PayPal order: ${refunds}`, paypalOrderId: order.paypal.orderId };
});

await check('3. The amount is over the per-case limit ($50)', 'checked first, no refund before the verdict', async () => {
  const { order, sc } = await purchase(buyer(3), 'S23');
  const { kase } = await desk.reportProblem({ orderId: order.id, statement: sc.complaint });
  const refundsAtReport = await refundsAtPayPal(order);
  await desk.investigate(kase.id);
  await desk.settle(kase.id);
  return { pass: kase.path === 'VERIFY_FIRST' && refundsAtReport === 0, observed: `$${(order.totalCents / 100).toFixed(2)}: path ${kase.path} (${kase.limitCheck.reasons.join(', ')}); refunds on the PayPal order right after the report: ${refundsAtReport}; after the verdict (${kase.verdict.liable}): ${await refundsAtPayPal(order)}`, paypalOrderId: order.paypal.orderId };
});

await check('4. More instant refunds than the 30-day count allows (2)', 'third report checked first', async () => {
  const b = buyer(4);
  const paths = [];
  let last;
  for (let i = 0; i < 3; i += 1) {
    const { order, sc } = await purchase(b, 'S06');
    const { kase } = await desk.reportProblem({ orderId: order.id, statement: sc.complaint });
    paths.push(kase.path);
    last = { order, kase, refunds: await refundsAtPayPal(order) };
  }
  return { pass: paths.join() === 'REFUND_FIRST,REFUND_FIRST,VERIFY_FIRST' && last.refunds === 0, observed: `paths: ${paths.join(' -> ')}; third order refunds on PayPal at report: ${last.refunds} (${last.kase.limitCheck.reasons.join(', ')})`, paypalOrderId: last.order.paypal.orderId };
});

await check('5. The buyer withdraws save-for-later consent before the charge', 'no re-charge', async () => {
  const b = buyer(5);
  const { order, sc } = await purchase(b, 'S03');
  const kase = await toVerdict(order, sc);
  const before = accepted('re-charge-saved-wallet');
  await desk.revokeConsent(b.id);
  clock.fastForwardDays(8);
  await desk.processDue();
  const r = await desk.recharge(kase.id);
  const sent = accepted('re-charge-saved-wallet') - before;
  return { pass: kase.verdict.liable === 'BUYER' && sent === 0 && r.charged === false, observed: `verdict ${kase.verdict.liable}; re-charge ${kase.recharge.status} (${kase.recharge.blockedBy}); charge calls accepted by PayPal: ${sent}; store ${order.storePayable.status} from ${order.storePayable.source}`, paypalOrderId: order.paypal.orderId };
});

await check('6. The buyer disputes during the notice period', 'no re-charge', async () => {
  const { order, sc } = await purchase(buyer(6), 'S04');
  const kase = await toVerdict(order, sc);
  const before = accepted('re-charge-saved-wallet');
  await desk.fileDispute(kase.id, 'I do not agree that this was my mistake.');
  clock.fastForwardDays(8);
  await desk.processDue();
  const r = await desk.recharge(kase.id);
  const sent = accepted('re-charge-saved-wallet') - before;
  return { pass: kase.verdict.liable === 'BUYER' && sent === 0 && r.blockedBy === 'BUYER_DISPUTED', observed: `verdict ${kase.verdict.liable}; re-charge ${kase.recharge.status} (${kase.recharge.blockedBy}); charge calls accepted by PayPal: ${sent}`, paypalOrderId: order.paypal.orderId };
});

await check('7. The records cannot settle it', 'buyer keeps the refund, no re-charge', async () => {
  const { order, sc } = await purchase(buyer(7), 'S05');
  const before = accepted('re-charge-saved-wallet');
  const kase = await toVerdict(order, sc);
  clock.fastForwardDays(8);
  await desk.processDue();
  const r = await desk.recharge(kase.id);
  const sent = accepted('re-charge-saved-wallet') - before;
  return { pass: kase.verdict.liable === 'UNDETERMINED' && sent === 0 && r.blockedBy === 'NOT_BUYER_RESPONSIBILITY' && (await refundsAtPayPal(order)) === 1, observed: `verdict ${kase.verdict.liable} (${kase.verdict.rule}); refund kept; charge calls accepted by PayPal: ${sent}`, paypalOrderId: order.paypal.orderId };
});

await check('8. A re-charge above the amount fixed at purchase is requested', 'refused; only the fixed amount can be charged', async () => {
  const { order, sc } = await purchase(buyer(8), 'S08');
  const kase = await toVerdict(order, sc);
  clock.fastForwardDays(8);
  const before = accepted('re-charge-saved-wallet');
  const over = await desk.recharge(kase.id, { amountCents: order.totalCents + 100 });
  const sentForOver = accepted('re-charge-saved-wallet') - before;
  const normal = await desk.recharge(kase.id);
  return { pass: over.blockedBy === 'OVER_LIABILITY_CAP' && sentForOver === 0 && normal.charged && kase.recharge.amountCents === order.totalCents, observed: `request for $${((order.totalCents + 100) / 100).toFixed(2)} refused (${over.blockedBy}), calls sent: ${sentForOver}; then charged $${(kase.recharge.amountCents / 100).toFixed(2)} = the refunded amount (capture ${kase.recharge.captureId})`, paypalOrderId: order.paypal.orderId };
});

await check('9. The re-charge is requested twice (at the same moment, then once more)', 'one charge', async () => {
  const { order, sc } = await purchase(buyer(9), 'S17');
  const kase = await toVerdict(order, sc);
  clock.fastForwardDays(8);
  const before = accepted('re-charge-saved-wallet');
  const both = await Promise.all([desk.recharge(kase.id), desk.recharge(kase.id)]);
  const third = await desk.recharge(kase.id);
  const sent = accepted('re-charge-saved-wallet') - before;
  return { pass: sent === 1 && both.filter((r) => r.charged).length === 1 && third.blockedBy === 'ALREADY_CHARGED', observed: `charge calls accepted by PayPal: ${sent}; answers: ${both.map((r) => (r.charged ? 'charged' : r.blockedBy)).join(', ')}, then ${third.blockedBy}`, paypalOrderId: order.paypal.orderId };
});

// Every order touched above: the desk's ledger against fresh PayPal lookups.
const recon = [];
for (const order of Object.values(db.data.orders)) recon.push(await desk.reconcile(order.id));
const summary = { ranAt: new Date().toISOString(), environment: 'PayPal sandbox', conditions: rows.length, passed: rows.filter((r) => r.pass).length, ordersReconciled: `${recon.filter((r) => r.ok).length}/${recon.length}` };
console.log('\nSUMMARY', JSON.stringify(summary));
const dir = join(config.root, 'data', 'evidence');
mkdirSync(dir, { recursive: true });
const file = join(dir, `abuse-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ summary, rows, reconciliation: recon, cases: db.data.cases, ledger: db.data.ledger, paypalCalls: db.data.paypalCalls }, null, 1));
console.log(`evidence: ${file}`);
db.save();
