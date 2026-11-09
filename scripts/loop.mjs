// Runs prepared cases end to end against the PayPal sandbox, without a UI:
//   mandate approved -> agent pays from the saved wallet -> one-sentence report -> refund first
//   -> investigate -> verdict -> settle -> (fast-forward the notice period) -> re-charge or halt -> reconcile
//
// Usage:  node scripts/loop.mjs [S01 S02 ...]     (no ids = every case in scenarios/cases.json)
// Writes an evidence file under data/evidence/. Needs PayPal sandbox credentials and DEMO_VAULT_ID.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, expandFixtureFacts } from '../src/context.js';
import { fromCents } from '../src/domain/money.js';

const wanted = process.argv.slice(2);
const ctx = createContext({ dbName: 'loop', fresh: true });
const { desk, db, clock, config, ledger } = ctx;
const all = JSON.parse(readFileSync(join(config.root, 'scenarios', 'cases.json'), 'utf8')).cases;
const cases = wanted.length ? all.filter((c) => wanted.includes(c.id)) : all;

console.log(`AI provider: ${config.ai.provider} | store payout: ${config.storePayoutEmail ? 'real PayPal Payouts' : 'ledger only (no store account configured)'}`);
const results = [];

for (const sc of cases) {
  const row = { id: sc.id, title: sc.title, expected: sc.expected.liable };
  try {
    // A fresh buyer profile per case keeps the 30-day count from mixing cases; the sandbox wallet is shared.
    const buyer = desk.createBuyer({ name: `Loop buyer ${sc.id}`, useDemoWallet: true });
    const mandate = desk.approveMandate(desk.draftMandate({ buyerId: buyer.id, instruction: sc.instruction, conditions: sc.conditions }).id);
    const order = await desk.agentPurchase({
      mandateId: mandate.id,
      store: sc.store,
      cart: sc.cart,
      agentCart: sc.agentCart,
      agentLog: sc.agentLog,
      storeRecord: sc.storeRecord,
      scenarioId: sc.id,
      fixtureFacts: expandFixtureFacts(sc.fixtureFacts),
    });
    row.orderId = order.id;
    row.amount = fromCents(order.totalCents);

    const { kase } = await desk.reportProblem({ orderId: order.id, statement: sc.complaint });
    row.caseId = kase.id;
    row.path = kase.path;
    row.refundStatus = kase.refund?.status || null;
    row.refundSeconds = kase.refund?.secondsFromReport ?? null;

    await desk.investigate(kase.id);
    row.refundBeforeInvestigation = kase.refund?.completedAtMs != null && kase.refund.completedAtMs <= kase.investigation.startedAtMs;
    row.liable = kase.verdict.liable;
    row.rule = kase.verdict.rule;
    row.match = row.liable === row.expected;

    await desk.settle(kase.id);
    if (sc.then === 'dispute') await desk.fileDispute(kase.id, 'I do not agree that this was my mistake.');
    if (kase.verdict.liable === 'BUYER') {
      clock.fastForwardDays(8); // notice period (5 business days) passes on the policy clock only
      await desk.processDue();
    }
    row.recharge = kase.recharge ? `${kase.recharge.status}${kase.recharge.blockedBy ? ` (${kase.recharge.blockedBy})` : ''}` : 'none';
    row.store = `${order.storePayable.status}${order.storePayable.source ? ` from ${order.storePayable.source}` : ''}${order.storePayable.simulated ? ' [ledger only]' : ''}`;
    row.status = kase.status;

    const recon = await desk.reconcile(order.id);
    row.reconciled = recon.ok;
    row.reconciliation = recon;
  } catch (err) {
    row.error = err.message;
  }
  results.push(row);
  const line = [
    row.id,
    row.error ? `ERROR ${row.error}` : `$${row.amount} ${row.path} refund=${row.refundStatus} ${row.refundSeconds ?? '-'}s refundBeforeInvestigation=${row.refundBeforeInvestigation}`,
    row.error ? '' : `verdict=${row.liable}(${row.rule}) expected=${row.expected} ${row.match ? 'MATCH' : 'MISMATCH'}`,
    row.error ? '' : `recharge=${row.recharge} | store=${row.store} | ledger==PayPal: ${row.reconciled}`,
  ].filter(Boolean);
  console.log(line.join('\n   '));
}

const ok = results.filter((r) => !r.error);
const summary = {
  ranAt: new Date().toISOString(),
  environment: 'PayPal sandbox',
  aiProvider: config.ai.provider,
  storePayout: config.storePayoutEmail ? 'paypal-payouts' : 'ledger-only',
  cases: results.length,
  errors: results.length - ok.length,
  verdictMatches: ok.filter((r) => r.match).length,
  refundFirst: ok.filter((r) => r.path === 'REFUND_FIRST').length,
  refundBeforeInvestigation: ok.filter((r) => r.refundBeforeInvestigation).length,
  refundSeconds: ok.map((r) => r.refundSeconds).filter((s) => s != null),
  buyerRechargedWhenNotResponsible: ok.filter((r) => r.liable !== 'BUYER' && /COMPLETED/.test(r.recharge)).length,
  reconciled: ok.filter((r) => r.reconciled).length,
  reserve: { startCents: db.data.reserve.startCents, balanceCents: ledger.reserveBalanceCents(), allocatedCents: ledger.reserveAllocatedCents() },
};
console.log('\nSUMMARY', JSON.stringify(summary));

const dir = join(config.root, 'data', 'evidence');
mkdirSync(dir, { recursive: true });
const file = join(dir, `loop-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ summary, results, cases: db.data.cases, ledger: db.data.ledger, paypalCalls: db.data.paypalCalls }, null, 1));
console.log(`evidence: ${file}`);
db.save();
