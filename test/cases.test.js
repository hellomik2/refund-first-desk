// Checks the prepared cases file itself: every case must be well-formed, every hand-written
// fixture quote must really appear in the records the desk builds, and the fixed rules must reach
// the expected responsibility from the fixture facts. This validates the answer key and the rules,
// not the AI: measuring the AI on these cases is done on the sandbox with the live provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultPolicy } from '../src/config.js';
import { createDb } from '../src/store.js';
import { createClock } from '../src/domain/clock.js';
import { createLedger } from '../src/domain/ledger.js';
import { createFactExtractor } from '../src/ai/facts.js';
import { expandFixtureFacts } from '../src/context.js';
import { ALL_FACTS } from '../src/domain/verdict.js';
import { cartTotalCents } from '../src/domain/money.js';
import { createDesk } from '../src/desk.js';
import { createFakePayPal } from './fake-paypal.js';

const file = JSON.parse(readFileSync(new URL('../scenarios/cases.json', import.meta.url), 'utf8'));
const LIABLE = ['STORE', 'AGENT', 'BUYER', 'UNDETERMINED'];

test('case ids are unique', () => {
  const ids = file.cases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

for (const sc of file.cases) {
  test(`${sc.id} ${sc.title} -> ${sc.expected.liable}`, async () => {
    assert.ok(LIABLE.includes(sc.expected.liable), 'expected.liable is one of the four outcomes');
    assert.deepEqual(Object.keys(sc.fixtureFacts).sort(), [...ALL_FACTS].sort(), 'fixtureFacts covers exactly the seven facts');
    assert.ok(sc.instruction && sc.complaint && sc.cart.length && sc.agentLog.length, 'instruction, complaint, cart and agent log are present');
    for (const line of sc.cart) assert.ok(Number.isInteger(line.unitCents) && line.unitCents > 0 && Number.isInteger(line.qty) && line.qty > 0);

    const config = {
      policy: { ...defaultPolicy(), reserveStartCents: 10_000_000 },
      demoWallet: { vaultId: 'VAULT-DEMO', customerId: 'CUST-DEMO', email: 'buyer@example.test' },
      storePayoutEmail: 'store@example.test',
      publicBaseUrl: 'http://localhost:8787',
    };
    const db = createDb({ policy: config.policy });
    const ledger = createLedger(db);
    const paypal = createFakePayPal();
    const desk = createDesk({ db, paypal, factExtractor: createFactExtractor({ provider: 'fixture' }), clock: createClock(db), ledger, config, pollMs: 1 });

    const buyer = desk.createBuyer({ name: 'Case check', useDemoWallet: true });
    const mandate = desk.approveMandate(desk.draftMandate({ buyerId: buyer.id, instruction: sc.instruction, conditions: sc.conditions }).id);
    const order = await desk.agentPurchase({
      mandateId: mandate.id,
      store: sc.store,
      cart: sc.cart,
      agentCart: sc.agentCart,
      agentLog: sc.agentLog,
      storeRecord: sc.storeRecord,
      fixtureFacts: expandFixtureFacts(sc.fixtureFacts),
    });
    const { kase } = await desk.reportProblem({ orderId: order.id, statement: sc.complaint });
    const overCap = cartTotalCents(sc.cart) > config.policy.perCaseCapCents;
    assert.equal(kase.path, overCap ? 'VERIFY_FIRST' : 'REFUND_FIRST');
    await desk.investigate(kase.id);

    // A fixture "yes"/"no" whose quote is not in the records would be silently downgraded. Catch it here.
    const intendedUnknown = Object.entries(sc.fixtureFacts).filter(([, v]) => v[0] === 'unknown').map(([k]) => k);
    assert.deepEqual(kase.investigation.downgraded, [], `quotes not found in the records for: ${kase.investigation.downgraded.join(', ')}`);
    // The two facts code computes must agree with what the case author wrote.
    assert.deepEqual(kase.investigation.overrides, [], `fixture disagrees with code-computed facts: ${JSON.stringify(kase.investigation.overrides)}`);
    assert.equal(kase.verdict.liable, sc.expected.liable, `rule ${kase.verdict.rule}, reasons ${kase.verdict.reasons.join(', ')}, unknown by design: ${intendedUnknown.join(', ')}`);
  });
}
