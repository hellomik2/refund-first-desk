// The case book counts what the measured 30-case run found. These tests count the same things straight from
// the answer key (scenarios/cases.json, fixed before any real AI run) and require the same numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCaseBook, recordsFromState, toRecord } from '../src/domain/casebook.js';

const key = JSON.parse(readFileSync(new URL('../scenarios/cases.json', import.meta.url), 'utf8')).cases;
const measured = JSON.parse(readFileSync(new URL('../scenarios/casebook-measured.json', import.meta.url), 'utf8'));
const book = buildCaseBook(measured.records);
// In the measured run S22's two keys disagreed, so it waits for a person; the answer key says STORE.
const inReview = measured.records.filter((r) => r.outcome === 'HUMAN_REVIEW').map((r) => r.scenarioId);

/** Count first deviations by condition and by final outcome, for steps of one actor, straight from the answer key. */
function fromKey(actor) {
  const out = {};
  for (const sc of key) {
    const fd = sc.expected.firstDeviation;
    if (!Number.isInteger(fd) || sc.agentLog.find((s) => s.step === fd).actor !== actor) continue;
    const c = (out[sc.firstDeviationCondition] ||= { count: 0, byOutcome: {} });
    c.count += 1;
    const outcome = inReview.includes(sc.id) ? 'HUMAN_REVIEW' : sc.expected.liable;
    c.byOutcome[outcome] = (c.byOutcome[outcome] || 0) + 1;
  }
  return out;
}

const fromBook = (groups) => {
  const out = {};
  for (const g of groups) {
    for (const c of g.conditions) {
      const t = (out[c.condition] ||= { count: 0, byOutcome: {} });
      t.count += c.count;
      for (const [o, n] of Object.entries(c.byOutcome)) if (n) t.byOutcome[o] = (t.byOutcome[o] || 0) + n;
    }
  }
  return out;
};

test('the measured run is the 30 prepared cases, once each', () => {
  assert.deepEqual(measured.records.map((r) => r.scenarioId).sort(), key.map((c) => c.id).sort());
  assert.deepEqual(inReview, ['S22']);
});

test('responsibility counts equal the answer key (S22 counted as waiting for a person)', () => {
  const expected = { AGENT: 0, STORE: 0, BUYER: 0, UNDETERMINED: 0, HUMAN_REVIEW: 0, OPEN: 0 };
  for (const sc of key) expected[inReview.includes(sc.id) ? 'HUMAN_REVIEW' : sc.expected.liable] += 1;
  assert.deepEqual(book.outcomes, expected);
  assert.deepEqual(book.outcomes, { AGENT: 10, STORE: 7, BUYER: 6, UNDETERMINED: 6, HUMAN_REVIEW: 1, OPEN: 0 });
});

test('agent-step first deviations by condition and outcome equal the answer key: 15 in all', () => {
  assert.deepEqual(fromBook(book.agents), fromKey('agent'));
  const counts = Object.fromEntries(Object.entries(fromKey('agent')).map(([k, v]) => [k, v.count]));
  assert.deepEqual(counts, { purchaseAuthorized: 2, itemMatchesMandate: 7, quantityMatchesMandate: 2, withinSpendingLimit: 2, exclusionsRespected: 2 });
  assert.equal(book.agents.reduce((s, a) => s + a.deviations, 0), 15);
});

test('store-step first deviations equal the answer key: 5 in all', () => {
  assert.deepEqual(fromBook(book.stores), fromKey('store'));
  assert.deepEqual(Object.fromEntries(Object.entries(fromKey('store')).map(([k, v]) => [k, v.count])), { storeFulfilledAsOrdered: 3, storeChargedAsOrdered: 2 });
});

test('every example line is a verified quote that is in that step of that case', () => {
  for (const g of [...book.agents, ...book.stores]) {
    for (const c of g.conditions) {
      const sc = key.find((k) => k.id === c.example.scenarioId);
      assert.ok(c.example.verified, `${c.condition}: example not verified`);
      assert.ok(sc.agentLog.find((s) => s.step === c.example.step).content.includes(c.example.quote), `${c.condition}: ${sc.id} step ${c.example.step}`);
    }
  }
});

test('the example prefers a case the agent was responsible for', () => {
  const item = book.agents[0].conditions.find((c) => c.condition === 'itemMatchesMandate');
  assert.equal(item.example.outcome, 'AGENT');
});

test('a workspace groups by the agent named on the order, and by store', () => {
  const kase = (id, orderId, liable, step, actor) => ({
    id,
    orderId,
    path: 'REFUND_FIRST',
    status: 'CLOSED',
    verdict: { liable, rule: 'R2', agreed: true },
    investigation: { steps: [{ step: 1, actor, content: 'line' }], firstDeviation: { kind: 'STEP', step, condition: 'quantityMatchesMandate', quote: 'line', verified: true } },
  });
  const data = {
    orders: {
      O1: { id: 'O1', store: { id: 's1', name: 'One' }, totalCents: 100, agent: { id: 'live', name: 'Live agent' } },
      O2: { id: 'O2', store: { id: 's1', name: 'One' }, totalCents: 100 },
    },
    cases: { C1: kase('C1', 'O1', 'AGENT', 1, 'agent'), C2: kase('C2', 'O2', 'STORE', 1, 'store') },
  };
  const b = buildCaseBook(recordsFromState(data));
  assert.deepEqual(b.agents.map((a) => [a.name, a.deviations]).sort(), [['Live agent', 1], ['Scripted agent (prepared cases)', 0]]);
  assert.deepEqual(b.stores.map((s) => [s.name, s.cases, s.outcomes.STORE, s.deviations]), [['One', 2, 1, 1]]);
});

test('an open case and a case without a first deviation are counted, not dropped', () => {
  const r = toRecord({ kase: { id: 'C9', path: 'REFUND_FIRST', status: 'OPEN', verdict: null, investigation: null }, store: { id: 's', name: 'S' } });
  assert.equal(r.outcome, 'OPEN');
  assert.equal(buildCaseBook([r]).outcomes.OPEN, 1);
});
