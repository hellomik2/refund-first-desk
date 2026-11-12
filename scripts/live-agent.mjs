// Measures the live shopping agent end to end, in two phases so the human answer is written blind:
//
//   node scripts/live-agent.mjs buy [--fake-paypal] [careful:P1 hasty:P2 ...]
//       Each run: a fresh buyer approves a prepared instruction, the live agent shops and (maybe) pays from
//       the saved sandbox wallet. Prints every log step and the PayPal order. Nothing is reported yet.
//   (a person reads each log and PayPal order and writes the answer file: { "<mandate id>": "AGENT" | "BUYER" | ... })
//   node scripts/live-agent.mjs report <answers.json> [--fake-paypal]
//       Each paid run: the same one-sentence report, refund first, quick and deep check, two keys, settle;
//       buyer responsible -> notice, fast-forward, re-charge; then ledger against PayPal. Compares with the answers.
//
// There is no answer key written before the run: these are live runs, judged by a person after the purchase.
// Needs AI_PROVIDER=anthropic and AI_MODEL; PayPal sandbox credentials and DEMO_VAULT_ID unless --fake-paypal.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext } from '../src/context.js';
import { fromCents } from '../src/domain/money.js';
import { stepLine } from '../src/domain/agentlog.js';
import { createFakePayPal } from '../test/fake-paypal.js';

const [phase, ...rest] = process.argv.slice(2);
const fake = rest.includes('--fake-paypal');
const args = rest.filter((a) => !a.startsWith('--'));
const DEFAULT_PLAN = ['careful:P1', 'careful:P2', 'careful:P3', 'careful:P4', 'careful:P1', 'careful:P2', 'hasty:P1', 'hasty:P2', 'hasty:P3', 'hasty:P4', 'hasty:P1', 'hasty:P2'];
const STATEMENT = 'This is not what I asked the agent to buy.';

const ctx = createContext({ dbName: fake ? 'live-measure-fake' : 'live-measure', fresh: phase !== 'report', paypal: fake ? createFakePayPal() : null, overrides: { AGENT_RUNS_PER_WORKSPACE: '100' } });
const { desk, db, clock, config, liveAgent } = ctx;
const evidenceDir = join(config.dataDir, 'evidence');
mkdirSync(evidenceDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
console.log(`PayPal: ${fake ? 'in-memory stand-in' : 'sandbox'} | AI: ${config.ai.provider} ${config.ai.model} | live agent available: ${liveAgent.available}`);

async function buy(plan) {
  const runs = [];
  for (const item of plan) {
    const [kind, promptId] = item.split(':');
    const p = liveAgent.catalog.prompts.find((x) => x.id === promptId);
    const buyer = desk.createBuyer({ name: `Live ${item}`, useDemoWallet: true });
    const mandate = desk.draftMandate({ buyerId: buyer.id, instruction: p.instruction, conditions: p.conditions });
    mandate.live = { promptId };
    desk.approveMandate(mandate.id);
    const row = { mandateId: mandate.id, kind, promptId };
    const t0 = Date.now();
    try {
      await liveAgent.shop({ mandateId: mandate.id, kind });
    } catch (err) {
      row.error = err.message;
    }
    const live = mandate.live;
    const order = live.orderId ? db.data.orders[live.orderId] : null;
    Object.assign(row, { status: live.status, calls: live.calls, usd: live.usd, seconds: (Date.now() - t0) / 1000, stopReason: live.stopReason, steps: live.steps, finalText: live.finalText });
    if (order) Object.assign(row, { orderId: order.id, paypalOrderId: order.paypal.orderId, store: order.store.name, totalCents: order.totalCents, cart: order.cart });
    runs.push(row);
    console.log(`\n=== ${mandate.id} ${kind} ${promptId}: ${row.error ? `ERROR ${row.error}` : live.status} | ${live.calls} calls, $${(live.usd || 0).toFixed(4)}, ${row.seconds.toFixed(1)} s`);
    console.log(`instruction: ${p.instruction}`);
    for (const s of live.steps || []) console.log(`  ${stepLine(s)}`);
    if (order) console.log(`  PayPal order ${order.paypal.orderId} at ${order.store.name}, $${fromCents(order.totalCents)}: ${order.cart.map((l) => `${l.qty}x ${l.name} $${fromCents(l.unitCents)}`).join('; ')}`);
  }
  const file = join(evidenceDir, `live-buy-${fake ? 'fake-' : ''}${stamp}.json`);
  writeFileSync(file, JSON.stringify({ ranAt: new Date().toISOString(), environment: fake ? 'in-memory PayPal stand-in' : 'PayPal sandbox', model: config.ai.model, runs }, null, 1));
  const usd = runs.reduce((s, r) => s + (r.usd || 0), 0);
  console.log(`\nruns ${runs.length}, paid ${runs.filter((r) => r.status === 'PAID').length}, agent AI $${usd.toFixed(4)}\nevidence: ${file}`);
  db.save();
}

async function report(answersText) {
  const answers = JSON.parse(answersText).answers;
  const answersSha256 = createHash('sha256').update(answersText).digest('hex');
  const rows = [];
  for (const mandate of Object.values(db.data.mandates).filter((m) => m.live?.status === 'PAID')) {
    const order = db.data.orders[mandate.live.orderId];
    const row = { mandateId: mandate.id, kind: mandate.live.kind, promptId: mandate.live.promptId, orderId: order.id, totalCents: order.totalCents, human: answers[mandate.id] || null };
    try {
      const { kase } = await desk.reportProblem({ orderId: order.id, statement: STATEMENT });
      row.path = kase.path;
      row.refundSeconds = kase.refund?.secondsFromReport ?? null;
      row.refundStatus = kase.refund?.status || null;
      await desk.investigate(kase.id);
      row.quickClosed = kase.quick?.closed ?? null;
      row.keys = kase.investigation ? { code: kase.investigation.codeKey.liable, ai: kase.investigation.aiKey.liable } : null;
      row.firstDeviation = kase.investigation?.firstDeviation || null;
      if (kase.verdict) {
        await desk.settle(kase.id);
        if (kase.verdict.liable === 'BUYER') {
          clock.fastForwardDays(8);
          await desk.processDue();
        }
      }
      row.verdict = kase.verdict ? kase.verdict.liable : 'HUMAN_REVIEW';
      row.status = kase.status;
      row.recharge = kase.recharge ? `${kase.recharge.status}${kase.recharge.blockedBy ? ` (${kase.recharge.blockedBy})` : ''}` : 'none';
      const recon = await desk.reconcile(order.id);
      row.reconciled = recon.ok;
      row.reconciliation = recon.rows;
      row.aiCalls = db.data.aiCalls.filter((c) => c.at >= kase.receivedAt && c.purpose !== 'agent').length;
    } catch (err) {
      row.error = err.message;
    }
    rows.push(row);
    console.log(`${row.mandateId} ${row.kind} ${row.promptId} $${fromCents(row.totalCents)}: ${row.error ? `ERROR ${row.error}` : `${row.path} refund ${row.refundStatus} ${row.refundSeconds}s | quick ${row.quickClosed ? 'closed' : 'open'} | keys code=${row.keys?.code} ai=${row.keys?.ai} -> ${row.verdict} | human ${row.human} | recharge ${row.recharge} | ledger==PayPal ${row.reconciled}`}`);
  }
  const ok = rows.filter((r) => !r.error);
  const hastyRuns = Object.values(db.data.mandates).filter((m) => m.live?.kind === 'hasty');
  const summary = {
    ranAt: new Date().toISOString(),
    answersSha256,
    paidRuns: rows.length,
    endToEnd: ok.length,
    verdictMatchesHuman: ok.filter((r) => r.verdict === r.human).length,
    humanReview: ok.filter((r) => r.verdict === 'HUMAN_REVIEW').length,
    hastyRuns: hastyRuns.length,
    hastyOffMandateByHuman: hastyRuns.filter((m) => answers[m.id] === 'AGENT').length,
    buyerRechargedWhenHumanSaysNotBuyer: ok.filter((r) => r.human !== 'BUYER' && /^COMPLETED/.test(r.recharge)).length,
    reconciled: ok.filter((r) => r.reconciled).length,
  };
  console.log('\nSUMMARY', JSON.stringify(summary));
  const file = join(evidenceDir, `live-report-${fake ? 'fake-' : ''}${stamp}.json`);
  writeFileSync(file, JSON.stringify({ summary, rows, answers, cases: db.data.cases, ledger: db.data.ledger, mandates: db.data.mandates, paypalCalls: db.data.paypalCalls }, null, 1));
  console.log(`evidence: ${file}`);
  db.save();
}

if (phase === 'buy') await buy(args.length ? args : DEFAULT_PLAN);
else if (phase === 'report') await report(readFileSync(args[0], 'utf8'));
else if (phase === 'both' && fake) {
  // Plumbing check only: the in-memory PayPal lives in one process, and no person answers in between.
  await buy(args.length ? args : DEFAULT_PLAN);
  await report(JSON.stringify({ answers: {} }));
} else {
  console.log('usage: node scripts/live-agent.mjs buy [--fake-paypal] [careful:P1 ...] | report <answers.json> [--fake-paypal]');
}
