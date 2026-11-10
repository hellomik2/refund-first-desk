// Runs prepared cases end to end against the PayPal sandbox, without a UI:
//   mandate approved -> agent pays from the saved wallet -> one-sentence report -> refund first (or check
//   first over a limit) -> quick check -> deep check -> two keys -> settle, or wait for a person when the
//   keys differ -> (fast-forward the notice period) -> re-charge or halt -> reconcile
//
// Usage:  node scripts/loop.mjs [S01 S02 ...]     (no ids = every case in scenarios/cases.json)
//         node scripts/loop.mjs --fake-paypal      plumbing check on the in-memory PayPal stand-in (no sandbox calls)
// Writes an evidence file under <data dir>/evidence/ with pass lines 3 and 10-15 and the report values.
// Needs PayPal sandbox credentials and DEMO_VAULT_ID (not with --fake-paypal).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, fixtureFromCase } from '../src/context.js';
import { fromCents } from '../src/domain/money.js';
import { createFakePayPal } from '../test/fake-paypal.js';
import { caseRow, printPassLines, summarize } from './metrics.mjs';

const fake = process.argv.includes('--fake-paypal');
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ctx = createContext({ dbName: fake ? 'loop-fake' : 'loop', fresh: true, paypal: fake ? createFakePayPal() : null });
const { desk, db, clock, config, ledger } = ctx;
const all = JSON.parse(readFileSync(join(config.root, 'scenarios', 'cases.json'), 'utf8')).cases;
const cases = wanted.length ? all.filter((c) => wanted.includes(c.id)) : all;
// What the buyer does after the verdict. S04 disputes during the notice period (pass line 9). The case file
// carried this as `then: "dispute"` until the 2026-11-09 rewrite dropped it; the file is fingerprinted with
// the answer key, so the step lives here instead of in the file.
const AFTER_VERDICT = { S04: 'dispute' };

console.log(`PayPal: ${fake ? 'in-memory stand-in (plumbing check)' : 'sandbox'} | AI provider: ${config.ai.provider} | store payout: ${config.storePayoutEmail ? 'real PayPal Payouts' : 'ledger only (no store account configured)'}`);
const results = [];

for (const sc of cases) {
  let row = { id: sc.id, title: sc.title, expected: { liable: sc.expected.liable } };
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
      ...fixtureFromCase(sc),
    });
    row.orderId = order.id;
    row.amount = fromCents(order.totalCents);

    const { kase } = await desk.reportProblem({ orderId: order.id, statement: sc.complaint });
    row.caseId = kase.id;
    row.path = kase.path;
    row.refundStatus = kase.refund?.status || null;
    row.refundSeconds = kase.refund?.secondsFromReport ?? null;

    await desk.investigate(kase.id);
    row.refundBeforeInvestigation = kase.path === 'REFUND_FIRST' ? kase.refund?.completedAtMs != null && kase.refund.completedAtMs <= kase.quick.startedAtMs : null;

    if (kase.verdict) {
      await desk.settle(kase.id);
      if ((sc.then || AFTER_VERDICT[sc.id]) === 'dispute') await desk.fileDispute(kase.id, 'I do not agree that this was my mistake.');
      if (kase.verdict.liable === 'BUYER') {
        clock.fastForwardDays(8); // notice period (5 business days) passes on the policy clock only
        await desk.processDue();
      }
    } // else: HUMAN_REVIEW. Nobody decides in this script, so nothing more may move.
    row.recharge = kase.recharge ? `${kase.recharge.status}${kase.recharge.blockedBy ? ` (${kase.recharge.blockedBy})` : ''}` : 'none';
    row.store = `${order.storePayable.status}${order.storePayable.source ? ` from ${order.storePayable.source}` : ''}${order.storePayable.simulated ? ' [ledger only]' : ''}`;

    const recon = await desk.reconcile(order.id);
    row = { ...row, ...caseRow({ sc, kase, order, db, policy: config.policy }), reconciled: recon.ok, reconciliation: recon };
  } catch (err) {
    row.error = err.message;
  }
  results.push(row);
  const line = [
    row.id,
    row.error ? `ERROR ${row.error}` : `$${row.amount} ${row.path} refund=${row.refundCompleted ? 'COMPLETED' : row.refundStatus} ${row.refundSecondsFromReport ?? '-'}s refundBeforeInvestigation=${row.refundBeforeInvestigation}`,
    row.error ? '' : `quick=${row.quickClosed ? `closed ${row.quickReasons.join(',')}` : 'open'} | first deviation=${row.firstDeviation?.kind === 'STEP' ? row.firstDeviation.step : row.firstDeviation?.kind} (key ${row.expected.firstDeviation ?? '-'})`,
    row.error ? '' : `${row.decided ? `verdict=${row.decided.liable}(${row.decided.rule})` : `HUMAN_REVIEW code=${row.keys.code} ai=${row.keys.ai}`} expected=${row.expected.liable}`,
    row.error ? '' : `recharge=${row.recharge} | store=${row.store} | ledger==PayPal: ${row.reconciled}`,
  ].filter(Boolean);
  console.log(line.join('\n   '));
}

const ok = results.filter((r) => !r.error);
const summary = {
  ranAt: new Date().toISOString(),
  environment: fake ? 'in-memory PayPal stand-in' : 'PayPal sandbox',
  aiProvider: config.ai.provider,
  storePayout: config.storePayoutEmail ? 'paypal-payouts' : 'ledger-only',
  cases: results.length,
  errors: results.length - ok.length,
  refundFirst: ok.filter((r) => r.path === 'REFUND_FIRST').length,
  refundBeforeInvestigation: ok.filter((r) => r.refundBeforeInvestigation).length,
  refundSeconds: ok.map((r) => r.refundSeconds).filter((s) => s != null),
  buyerRechargedWhenNotResponsible: ok.filter((r) => r.decided?.liable !== 'BUYER' && /COMPLETED/.test(r.recharge)).length,
  reconciled: ok.filter((r) => r.reconciled).length,
  reserve: { startCents: db.data.reserve.startCents, balanceCents: ledger.reserveBalanceCents(), allocatedCents: ledger.reserveAllocatedCents() },
  passLines: summarize(results, { provider: config.ai.provider }),
};
printPassLines(summary.passLines);
console.log('\nSUMMARY', JSON.stringify({ ...summary, passLines: undefined }));

const dir = join(config.dataDir, 'evidence');
mkdirSync(dir, { recursive: true });
const file = join(dir, `loop-${fake ? 'fake-' : ''}${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ summary, results, cases: db.data.cases, ledger: db.data.ledger, paypalCalls: db.data.paypalCalls }, null, 1));
console.log(`evidence: ${file}`);
db.save();
