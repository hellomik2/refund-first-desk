// The page names who answered. A prepared case replays a recorded answer: every place that names the model says so,
// the same way the deep check line already did. Live and stand-in wording stays as it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aiKeySource, aiPillText, buyerKeysLine, deepAiSource, quickAiSource } from '../public/ailabels.js';

const HOSTED = { aiProvider: 'anthropic', aiModel: 'claude-haiku-5-5' }; // the hosted desk: live model, prepared cases replayed
const recorded = { provider: 'recorded', model: 'claude-haiku-5-5' };
const live = { provider: 'anthropic', model: 'claude-haiku-5-5' };
const replayedCase = { quick: { ai: recorded }, investigation: { ai: recorded } };
const liveCase = { quick: { ai: live }, investigation: { ai: live } };

test('a recorded answer is named as replayed in all four places', () => {
  assert.match(aiPillText(HOSTED, replayedCase), /claude-haiku-5-5.*recorded answer replayed/);
  assert.match(quickAiSource(recorded), /claude-haiku-5-5.*recorded answer replayed/);
  assert.match(deepAiSource({ ai: recorded }), /claude-haiku-5-5, recorded answer replayed/);
  assert.match(aiKeySource({ source: 'recorded' }, { ai: recorded }), /claude-haiku-5-5.*recorded answer replayed/);
});

test('the pill says replayed when only the quick check replayed (the deep check has not run yet)', () => {
  assert.match(aiPillText(HOSTED, { quick: { ai: recorded } }), /recorded answer replayed/);
});

test('an edited sentence: the quick check replays, the deep check calls live, and the pill follows the deep check', () => {
  assert.equal(aiPillText(HOSTED, { quick: { ai: recorded }, investigation: { ai: live } }), 'AI: claude-haiku-5-5');
});

test('a live call and the stand-in keep their wording', () => {
  assert.equal(aiPillText(HOSTED, liveCase), 'AI: claude-haiku-5-5');
  assert.equal(aiPillText(HOSTED, null), 'AI: claude-haiku-5-5');
  assert.equal(aiPillText({ aiProvider: 'fixture', aiModel: null }, replayedCase), 'AI not connected: stand-in answers');
  assert.equal(quickAiSource(live), 'claude-haiku-5-5');
  assert.equal(quickAiSource({ provider: 'fixture' }), 'stand-in answers');
  assert.equal(deepAiSource({ ai: live }), 'The investigator (claude-haiku-5-5) read every record; code then checked its quote against that step.');
  assert.equal(aiKeySource({ source: 'anthropic' }, { ai: live }), 'The investigator, claude-haiku-5-5');
  assert.equal(aiKeySource({ source: 'fixture' }, { ai: { provider: 'fixture' } }), 'Stand-in answer from our answer key (AI not connected)');
  for (const s of [aiPillText(HOSTED, liveCase), quickAiSource(live), deepAiSource({ ai: live }), aiKeySource({ source: 'anthropic' }, { ai: live })]) assert.doesNotMatch(s, /recorded/);
});

test('a desk started in replay-only mode names the replay in the pill', () => {
  assert.match(aiPillText({ aiProvider: 'recorded', aiModel: null }, null), /recorded answers? replayed/);
});

test('both keys name the buyer: a notice only when a refund was paid; with no refund there is nothing to take back', () => {
  assert.match(buyerKeysLine({ refund: { status: 'COMPLETED' } }), /only sends a notice/);
  const noRefund = buyerKeysLine({ path: 'VERIFY_FIRST', refund: null });
  assert.doesNotMatch(noRefund, /notice|re-charge/);
  assert.match(noRefund, /No refund was paid/);
});
