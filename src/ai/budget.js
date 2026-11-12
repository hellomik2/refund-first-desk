// A hard ceiling on what live AI calls may cost. Every call is appended to one file in the data
// directory, so the server and the scripts share the same count and it survives restarts.
// When a cap is reached the desk does not call the AI: every fact stays unknown, which the rules
// resolve in the buyer's favour.
// The live shopping agent's calls (purpose "agent") share the total spend cap but are counted apart from the
// desk's daily call cap, so a visitor's shopping run never uses up the checks; agent runs have their own daily cap.
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

const isAgent = (c) => c.purpose === 'agent';
// Runs that have started but may not have a call in the file yet, per usage file: every workspace has its own
// budget object over the same file, so the places held are kept here, shared by all of them.
const startedRuns = new Map(); // file -> Set of run ids

export function createAiBudget({ file, dailyCallCap, spendCapUsd }) {
  const calls = () => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const today = () => new Date().toISOString().slice(0, 10);
  const held = startedRuns.get(file) || startedRuns.set(file, new Set()).get(file);
  return {
    record(usage) {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify({ ...usage, usd: costUsd(usage) })}\n`);
    },
    spentUsd: () => calls().reduce((sum, c) => sum + c.usd, 0),
    /** @returns {string|null} why the next desk call (quick, deep, conditions) is not allowed, or null */
    blockedBy() {
      const all = calls();
      if (all.filter((c) => !isAgent(c) && c.at.startsWith(today())).length >= dailyCallCap) return 'DAILY_AI_CALL_CAP';
      if (all.reduce((sum, c) => sum + c.usd, 0) >= spendCapUsd) return 'AI_SPEND_CAP';
      return null;
    },
    /**
     * Why a new shopping run may not start, or null. With `holdFor`, a run that may start takes its place under the
     * daily cap in the same synchronous step, so runs started at the same moment cannot all pass. A run counts
     * until `releaseRun`, and after that through its calls in the file.
     * @returns {string|null}
     */
    agentBlockedBy({ dailyRunCap, holdFor = null }) {
      const all = calls();
      if (all.reduce((sum, c) => sum + c.usd, 0) >= spendCapUsd) return 'AI_SPEND_CAP';
      const runs = new Set(all.filter((c) => isAgent(c) && c.at.startsWith(today())).map((c) => c.runId));
      for (const id of held) runs.add(id);
      if (runs.size >= dailyRunCap) return 'DAILY_AGENT_RUN_CAP';
      if (holdFor) held.add(holdFor);
      return null;
    },
    releaseRun: (runId) => held.delete(runId),
    runUsd: (runId) => calls().filter((c) => c.runId === runId).reduce((sum, c) => sum + c.usd, 0),
  };
}
