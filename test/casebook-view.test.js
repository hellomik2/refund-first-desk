// The case book on screen: while the book is being read again, the two sides must not mix a new state with an old book,
// and an answer that arrives after a newer one is dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const el = { innerHTML: '', contains: () => false };
globalThis.document = { getElementById: (id) => (id === 'casebook' ? el : null), addEventListener() {}, activeElement: null };
const asked = [];
globalThis.fetch = () => {
  let answer;
  const p = new Promise((resolve) => (answer = (json) => resolve({ ok: true, json: async () => json })));
  asked.push(answer);
  return p;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

const limits = (cents, basis = []) => ({ start: { perCaseCapCents: 5000, refundsPer30Days: 3 }, perCaseCapCents: cents, refundsPer30Days: 3, basis, windowDays: 30 });
const state = (verdict, cents) => ({
  workspace: 'w1',
  cases: [{ id: 'c1', status: verdict ? 'DECIDED' : 'OPEN', verdict: verdict ? { liable: verdict } : null }],
  buyerLimits: limits(cents),
  orders: [],
  policy: {},
});
const book = (outcome) => ({
  cases: 1,
  outcomes: { [outcome]: 1 },
  agents: [{ name: 'Shopping agent', cases: 1, deviations: 1, outcomes: { AGENT: outcome === 'AGENT' ? 1 : 0 }, conditions: [] }],
  stores: [],
});
const answer = (outcome) => ({ workspace: book(outcome), measured: { book: book('AGENT'), source: { environment: 'sandbox', aiProvider: 'fixture', ranAt: '2026-11-12T00:00:00Z' } } });

test('while the book is read again, a new limit is never drawn next to the old book; a late older answer is dropped', async () => {
  const { refreshCaseBook } = await import('../public/casebook.js');
  const open = state(null, 5000);
  refreshCaseBook(open, []);
  asked[0](answer('OPEN'));
  await tick();
  assert.match(el.innerHTML, /\$50<small>/);
  assert.match(el.innerHTML, /not finished/);

  // the verdict lands: the limit is now $75, the server has not answered yet
  const decided = state('AGENT', 7500);
  refreshCaseBook(decided, []);
  refreshCaseBook(decided, []); // the page redraws while it waits
  const waiting = el.innerHTML;
  assert.ok(!(waiting.includes('$75<small>') && waiting.includes('not finished')), 'new limit drawn next to the old book');
  assert.match(waiting, /Updating/);

  // a second change is asked before the first answer arrives; the newer answer lands first
  const decided2 = state('STORE', 7500);
  refreshCaseBook(decided2, []);
  asked[2](answer('STORE'));
  await tick();
  assert.match(el.innerHTML, /\$75<small>/);
  assert.match(el.innerHTML, /store's fault/);
  assert.doesNotMatch(el.innerHTML, /Updating/);

  // the older answer arrives late and must not replace the newer book
  asked[1](answer('AGENT'));
  await tick();
  assert.match(el.innerHTML, /store's fault/);
  assert.doesNotMatch(el.innerHTML, /responsible in <b class="num">1<\/b>/);
});

// codex UI 3: the verdict lands while the book is being read. The answer's book already has it; the limit must come
// from the same moment, never from the state the request started with.
test('a verdict that lands between the request and the answer: the limit and the book come from the same moment', async () => {
  const { refreshCaseBook } = await import('../public/casebook.js');
  const open = { ...state(null, 5000), workspace: 'w2' };
  refreshCaseBook(open, []);
  const answer2 = { ...answer('AGENT'), buyerLimits: limits(7500) }; // the server read the book and the limit after the verdict
  asked.at(-1)(answer2);
  await tick();
  const html = el.innerHTML;
  assert.ok(!(html.includes('$50<small>') && html.includes('responsible in <b class="num">1</b>')), 'the old limit drawn next to a book that already has the verdict');
  assert.match(html, /\$75<small>/);
  assert.match(html, /responsible in <b class="num">1<\/b>/);

  // a read that fails keeps the book and its limit on screen, without Updating
  refreshCaseBook({ ...state('STORE', 7500), workspace: 'w2' }, []);
  assert.match(el.innerHTML, /Updating/);
  asked.at(-1)(null);
  await tick();
  assert.match(el.innerHTML, /\$75<small>/);
  assert.match(el.innerHTML, /responsible in <b class="num">1<\/b>/);
  assert.doesNotMatch(el.innerHTML, /Updating/);
});
