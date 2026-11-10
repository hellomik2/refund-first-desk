// Measures the AI on the prepared cases without moving sandbox money: the desk runs against the
// in-memory PayPal stand-in, builds the same records it builds on the sandbox, runs the quick check,
// the deep check (AI investigator) and the two keys, settles where the keys agree, and compares
// everything with the answer key. Pass lines 3 and 10-15 and the report values go to the result file.
// Use it to tune the prompts; the final measurement runs on the real sandbox with scripts/loop.mjs.
//
// Usage:  node scripts/ai-eval.mjs [S01 S02 ...]     (no ids = every case)
// Each live call counts against the AI caps in src/ai/budget.js (up to two calls per case: quick and deep).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, fixtureFromCase } from '../src/context.js';
import { ALL_FACTS } from '../src/domain/verdict.js';
import { createFakePayPal } from '../test/fake-paypal.js';
import { caseRow, printPassLines, summarize } from './metrics.mjs';

// CASES_FILE=holdout.json measures the hold-out cases written after the 30; the default is the fixed 30-case file.
const CASES_FILE = process.env.CASES_FILE || 'cases.json';
const wanted = process.argv.slice(2);
const ctx = createContext({
  dbName: 'ai-eval',
  fresh: true,
  paypal: createFakePayPal(),
  overrides: { POLICY_RESERVE_START_CENTS: '10000000' }, // a ledger number only: keeps every case on the same path
});
const { desk, config, db } = ctx;
const all = JSON.parse(readFileSync(join(config.root, 'scenarios', CASES_FILE), 'utf8')).cases;
const cases = wanted.length ? all.filter((c) => wanted.includes(c.id)) : all;
console.log(`AI provider: ${config.ai.provider}${config.ai.model ? ` (${config.ai.model}, effort ${config.ai.effort})` : ''} | ${cases.length} cases | PayPal: in-memory stand-in`);

const rows = [];
for (const sc of cases) {
  let row = { id: sc.id, expected: { liable: sc.expected.liable } };
  try {
    const buyer = desk.createBuyer({ name: `Eval ${sc.id}`, useDemoWallet: true });
    const mandate = desk.approveMandate(desk.draftMandate({ buyerId: buyer.id, instruction: sc.instruction, conditions: sc.conditions }).id);
    const order = await desk.agentPurchase({ mandateId: mandate.id, store: sc.store, cart: sc.cart, agentCart: sc.agentCart, agentLog: sc.agentLog, storeRecord: sc.storeRecord, scenarioId: sc.id, ...fixtureFromCase(sc) });
    const { kase } = await desk.reportProblem({ orderId: order.id, statement: sc.complaint });
    await desk.investigate(kase.id);
    if (kase.verdict) await desk.settle(kase.id); // the stand-in moves no real money; line 15 needs the refund timing
    const inv = kase.investigation;
    row = { ...caseRow({ sc, kase, order, db, policy: config.policy }), ai: { quick: kase.quick.ai, deep: inv.ai } };
    // Fact by fact against the answer key, after the quote check and the code-computed facts.
    row.factDiffs = ALL_FACTS.filter((k) => inv.facts[k].value !== sc.fixtureFacts[k][0]).map((k) => ({
      fact: k,
      key: sc.fixtureFacts[k][0],
      ai: inv.facts[k].value,
      quote: inv.facts[k].evidence[0]?.quote || null,
      note: inv.facts[k].note || '',
    }));
    row.downgraded = inv.downgraded;
    row.overrides = inv.overrides;
  } catch (err) {
    row.error = err.message;
  }
  rows.push(row);
  console.log(
    row.error
      ? `${row.id} ERROR ${row.error}`
      : `${row.id} ${row.decided ? `verdict=${row.decided.liable}(${row.decided.rule})` : `HUMAN_REVIEW code=${row.keys.code} ai=${row.keys.ai}`} expected=${row.expected.liable}` +
          ` | quick ${row.quickClosed ? `closed ${row.quickReasons.join(',')}` : 'open'} (key: ${row.expected.quickClose ?? '-'})` +
          ` | first deviation ${row.firstDeviation?.kind === 'STEP' ? `step ${row.firstDeviation.step}${row.firstDeviation.verified ? '' : ' (quote not verified)'}` : row.firstDeviation?.kind} (key: ${row.expected.firstDeviation ?? '-'})` +
          (row.factDiffs.length ? `\n   facts differing from the key: ${row.factDiffs.map((d) => `${d.fact} key=${d.key} ai=${d.ai}`).join('; ')}` : '') +
          (row.downgraded.length ? `\n   quote not found, discarded: ${row.downgraded.join(', ')}` : ''),
  );
}

const ok = rows.filter((r) => !r.error);
const calls = db.data.aiCalls;
const summary = {
  ranAt: new Date().toISOString(),
  provider: config.ai.provider,
  model: config.ai.model || null,
  effort: config.ai.effort,
  cases: rows.length,
  errors: rows.length - ok.length,
  wrongBuyerVerdicts: ok.filter((r) => r.decided?.liable === 'BUYER' && r.expected.liable !== 'BUYER').map((r) => r.id), // the costly error: a buyer charged who should not be
  liveCalls: calls.length,
  liveCallsByPurpose: Object.fromEntries(['quick', 'deep'].map((p) => [p, calls.filter((c) => c.purpose === p).length])),
  inputTokens: calls.reduce((s, c) => s + c.inputTokens, 0),
  outputTokens: calls.reduce((s, c) => s + c.outputTokens, 0),
  passLines: summarize(rows, { provider: config.ai.provider }),
};
printPassLines(summary.passLines);
console.log('\nSUMMARY', JSON.stringify({ ...summary, passLines: undefined }));
const dir = join(config.dataDir, 'evidence');
mkdirSync(dir, { recursive: true });
const file = join(dir, `ai-eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ summary, rows, aiCalls: calls }, null, 1));
console.log(`evidence: ${file}`);
