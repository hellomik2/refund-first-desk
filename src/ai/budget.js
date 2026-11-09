// A hard ceiling on what live AI calls may cost. Every call is appended to one file in the data
// directory, so the server and the scripts share the same count and it survives restarts.
// When a cap is reached the desk does not call the AI: every fact stays unknown, which the rules
// resolve in the buyer's favour.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

// US dollars per million tokens, prompts up to 100K tokens (claude-api skill, cached 2026-10-06).
const PRICES = {
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
};
const DEAREST = [10, 50]; // a model not in the table is counted at the Fable 5.1 price

export function costUsd({ model, inputTokens = 0, outputTokens = 0 }) {
  const [inp, out] = PRICES[model] || DEAREST;
  return (inputTokens * inp + outputTokens * out) / 1e6;
}

export function createAiBudget({ file, dailyCallCap, spendCapUsd }) {
  const calls = () => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    record(usage) {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify({ ...usage, usd: costUsd(usage) })}\n`);
    },
    spentUsd: () => calls().reduce((sum, c) => sum + c.usd, 0),
    /** @returns {string|null} why the next call is not allowed, or null */
    blockedBy() {
      const all = calls();
      const today = new Date().toISOString().slice(0, 10);
      if (all.filter((c) => c.at.startsWith(today)).length >= dailyCallCap) return 'DAILY_AI_CALL_CAP';
      if (all.reduce((sum, c) => sum + c.usd, 0) >= spendCapUsd) return 'AI_SPEND_CAP';
      return null;
    },
  };
}
