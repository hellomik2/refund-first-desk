// Measures the fact-table AI on the prepared cases without moving sandbox money: the desk runs
// against the in-memory PayPal stand-in, builds the same records it builds on the sandbox, asks the
// configured AI provider for the fact table, and compares the verdict with the answer key.
// Use it to tune the prompt; the final measurement runs on the real sandbox with scripts/loop.mjs.
//
// Usage:  node scripts/ai-eval.mjs [S01 S02 ...]     (no ids = every case)
// Each live call counts against the AI caps in src/ai/budget.js.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, expandFixtureFacts } from '../src/context.js';
import { ALL_FACTS } from '../src/domain/verdict.js';
import { createFakePayPal } from '../test/fake-paypal.js';

const wanted = process.argv.slice(2);
const ctx = createContext({
  dbName: 'ai-eval',
  fresh: true,
  paypal: createFakePayPal(),
  overrides: { POLICY_RESERVE_START_CENTS: '10000000' }, // a ledger number only: keeps every case on the same path
});
const { desk, config, db } = ctx;
const all = JSON.parse(readFileSync(join(config.root, 'scenarios', 'cases.json'), 'utf8')).cases;
const cases = wanted.length ? all.filter((c) => wanted.includes(c.id)) : all;
console.log(`AI provider: ${config.ai.provider}${config.ai.model ? ` (${config.ai.model}, effort ${config.ai.effort})` : ''} | ${cases.length} cases | PayPal: in-memory stand-in`);

const rows = [];
for (const sc of cases) {
  const row = { id: sc.id, expected: sc.expected.liable };
  try {
    const buyer = desk.createBuyer({ name: `Eval ${sc.id}`, useDemoWallet: true });
    const mandate = desk.approveMandate(desk.draftMandate({ buyerId: buyer.id, instruction: sc.instruction, conditions: sc.conditions }).id);
    const order = await desk.agentPurchase({ mandateId: mandate.id, store: sc.store, cart: sc.cart, agentCart: sc.agentCart, agentLog: sc.agentLog, storeRecord: sc.storeRecord, scenarioId: sc.id, fixtureFacts: expandFixtureFacts(sc.fixtureFacts) });
    const { kase } = await desk.reportProblem({ orderId: order.id, statement: sc.complaint });
    await desk.investigate(kase.id);
    const inv = kase.investigation;
    row.liable = kase.verdict.liable;
    row.rule = kase.verdict.rule;
    row.match = row.liable === row.expected;
    row.ai = inv.ai;
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
      : `${row.id} ${row.match ? 'MATCH   ' : 'MISMATCH'} verdict=${row.liable}(${row.rule}) expected=${row.expected}` +
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
  verdictMatches: ok.filter((r) => r.match).length,
  mismatches: ok.filter((r) => !r.match).map((r) => `${r.id}: ${r.liable} vs ${r.expected}`),
  wrongBuyerVerdicts: ok.filter((r) => r.liable === 'BUYER' && r.expected !== 'BUYER').map((r) => r.id), // the costly error: a buyer charged who should not be
  liveCalls: calls.length,
  inputTokens: calls.reduce((s, c) => s + c.inputTokens, 0),
  outputTokens: calls.reduce((s, c) => s + c.outputTokens, 0),
};
console.log('\nSUMMARY', JSON.stringify(summary));
const dir = join(config.root, 'data', 'evidence');
mkdirSync(dir, { recursive: true });
const file = join(dir, `ai-eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ summary, rows, aiCalls: calls }, null, 1));
console.log(`evidence: ${file}`);
