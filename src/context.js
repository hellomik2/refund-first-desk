// Wires the pieces together for the server and the scripts.
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { createDb } from './store.js';
import { createClock } from './domain/clock.js';
import { createLedger } from './domain/ledger.js';
import { createPayPalClient } from './paypal/client.js';
import { createPayPalApi } from './paypal/api.js';
import { createFactExtractor } from './ai/facts.js';
import { createAiBudget } from './ai/budget.js';
import { createDesk, DeskError } from './desk.js';
import { loadCatalog } from './shop/catalog.js';
import { createLiveShopper } from './shop/run.js';

/** @param {object} [opts.paypal] a PayPal stand-in (scripts/ai-eval.mjs measures the AI without moving sandbox money) */
export function createContext(opts = {}) {
  const { overrides = {}, dbName = null, fresh = false, live = null, tokenStore = {}, paypal: paypalStandIn = null } = opts;
  const config = loadConfig(overrides);
  const dataDir = dbName ? join(config.dataDir, dbName) : config.dataDir;
  const db = createDb({ dataDir, policy: config.policy, fresh });
  const clock = createClock(db);
  const ledger = createLedger(db);
  const client = createPayPalClient({
    ...config.paypal,
    tokenStore,
    onCall: (call) => {
      db.data.paypalCalls.push(call);
      if (db.data.paypalCalls.length > 2000) db.data.paypalCalls.splice(0, 500);
    },
  });
  const paypal = paypalStandIn || createPayPalApi(client);

  // Live AI is created on first use, counted, and capped per day and in total: the hosted demo runs
  // on the operator's key, so a visitor can never run up an open-ended bill. The count lives in one
  // file shared by every workspace, the server and the scripts.
  const budget = createAiBudget({ file: join(config.dataDir, 'ai-usage.jsonl'), dailyCallCap: config.ai.dailyCallCap, spendCapUsd: config.ai.spendCapUsd });
  let providerPromise = null;
  const liveProvider = () => {
    providerPromise ||= import('./ai/anthropic.js').then((m) =>
      m.createAnthropicProvider({
        apiKey: config.ai.apiKey,
        model: config.ai.model,
        effort: config.ai.effort,
        onUsage: (usage) => {
          db.data.aiCalls.push(usage);
          budget.record(usage);
        },
      }),
    );
    return providerPromise;
  };
  // Over a cap the AI is not called: the quick check closes nothing, and the deep check's key counts
  // as UNDETERMINED, so money moves only if the rules also say UNDETERMINED (buyer keeps the refund).
  const guarded = (job) => async (args) => {
    const blockedBy = budget.blockedBy();
    if (blockedBy) return { facts: {}, firstDeviation: null, verdict: null, note: `AI not called: ${blockedBy}`, notCalled: blockedBy };
    return (await liveProvider())[job](args);
  };
  const liveCalls = live || { quick: guarded('quickCheck'), deep: guarded('deepCheck') };

  const factExtractor = createFactExtractor({
    provider: config.ai.provider,
    recordedDir: join(config.root, 'scenarios', 'recorded'),
    live: liveCalls,
    reuseRecorded: config.ai.reuseRecorded,
  });
  const desk = createDesk({ db, paypal, factExtractor, clock, ledger, config });

  // The live shopping agent always calls the model (there is no recorded answer for a run nobody has seen).
  const catalog = loadCatalog(config.root);
  const liveAvailable = config.ai.provider === 'anthropic' && Boolean(config.ai.model);
  const shopper = createLiveShopper({
    desk,
    db,
    catalog,
    budget,
    caps: config.ai.agent,
    provider: () => {
      if (!liveAvailable) throw new DeskError('NO_LIVE_AI', 'The live agent needs the live AI provider (AI_PROVIDER=anthropic).');
      return liveProvider();
    },
    beforePay: opts.beforePay,
  });
  /** A typed instruction becomes condition slots for the buyer to approve (one desk AI call, under the desk caps). */
  async function draftConditions(instruction) {
    if (!liveAvailable) throw new DeskError('NO_LIVE_AI', 'Typing your own instruction needs the live AI provider.');
    const blockedBy = budget.blockedBy();
    if (blockedBy) throw new DeskError(blockedBy, 'The AI cap for today is reached. Pick a prepared instruction instead.');
    return (await liveProvider()).draftConditions(instruction);
  }
  const liveAgent = { available: liveAvailable, catalog, shop: shopper.shop, draftConditions };
  return { config, db, clock, ledger, paypal, factExtractor, desk, liveAgent, budget };
}

/** Scenario files write facts as [value, doc, quote]; expand to the shape the extractor returns. */
export function expandFixtureFacts(compact) {
  const out = {};
  for (const [key, [value, doc, quote]] of Object.entries(compact || {})) {
    out[key] = { value, evidence: quote ? [{ doc, quote }] : [] };
  }
  return out;
}

/**
 * The hand-written stand-in answers for a prepared case: the fact table, and for the deep check the
 * first deviation and verdict from the answer key. Only the fixture provider reads them.
 */
export function fixtureFromCase(sc) {
  const fd = sc.expected?.firstDeviation;
  const firstDeviation = Number.isInteger(fd)
    ? { kind: 'STEP', step: fd, condition: sc.firstDeviationCondition || null, quote: sc.firstDeviationQuote || '' }
    : { kind: fd === 'NONE' ? 'NONE' : 'INSUFFICIENT', step: null, condition: null, quote: '' };
  return {
    fixtureFacts: expandFixtureFacts(sc.fixtureFacts),
    fixtureDeep: { firstDeviation, verdict: { liable: sc.expected.liable, reason: 'answer key (fixture)' } },
  };
}
