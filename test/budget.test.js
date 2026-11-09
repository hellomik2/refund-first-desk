// The AI spend ceiling: once the total or the day's count is reached, no further live call is allowed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { costUsd, createAiBudget } from '../src/ai/budget.js';

const fresh = (caps) => createAiBudget({ file: join(mkdtempSync(join(tmpdir(), 'rfd-budget-')), 'ai-usage.jsonl'), ...caps });
const call = (model, inputTokens, outputTokens) => ({ at: new Date().toISOString(), purpose: 'facts', model, inputTokens, outputTokens });

test('cost uses the listed price and counts an unknown model at the dearest price', () => {
  assert.equal(costUsd({ model: 'claude-haiku-5-5', inputTokens: 1_000_000, outputTokens: 1_000_000 }), 0.6);
  assert.equal(costUsd({ model: 'some-new-model', inputTokens: 1_000_000, outputTokens: 0 }), 10);
});

test('the total spend cap stops further calls', () => {
  const budget = fresh({ dailyCallCap: 1000, spendCapUsd: 1 });
  assert.equal(budget.blockedBy(), null);
  budget.record(call('claude-haiku-5-5', 2_000_000, 1_000_000)); // $0.20 + $0.50
  assert.equal(budget.blockedBy(), null);
  budget.record(call('claude-haiku-5-5', 0, 700_000)); // +$0.35 -> $1.05
  assert.equal(budget.blockedBy(), 'AI_SPEND_CAP');
});

test('the daily call cap stops further calls and is shared through the file', () => {
  const budget = fresh({ dailyCallCap: 2, spendCapUsd: 100 });
  budget.record(call('claude-haiku-5-5', 10, 10));
  budget.record(call('claude-haiku-5-5', 10, 10));
  assert.equal(budget.blockedBy(), 'DAILY_AI_CALL_CAP');
});
