// What the AI contributes, in two jobs. Neither decides money; code checks every quote and decides.
//   quick  reads only the mandate and the PayPal order: item, exclusions (and quantity when code cannot tell)
//   deep   the investigator: reads every record and the numbered agent log, and gives the first step that
//          went off the mandate, the seven-fact table and its own verdict (one of the two keys)
// Providers:
//   fixture    development plumbing only: answers written by hand next to a prepared case (tests can override them)
//   recorded   replays answers a live model gave earlier, kept apart by job and evidence hash
//   anthropic  calls the model live
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { QUICK_AI_FACTS } from '../domain/verdict.js';

export const FACT_QUESTIONS = {
  purchaseAuthorized: 'Did the buyer-approved mandate allow the agent to pay without asking again?',
  itemMatchesMandate: 'Is what was ordered the item the buyer described in the mandate?',
  quantityMatchesMandate: 'Does the ordered quantity match the quantity in the mandate?',
  withinSpendingLimit: 'Is the PayPal order total within the spending limit in the mandate?',
  exclusionsRespected: 'Is the order free of everything the buyer said must not be included?',
  storeChargedAsOrdered: 'Did the store charge exactly the cart the agent submitted (no added items, no price change)?',
  storeFulfilledAsOrdered: 'Did the store ship what the order says?',
};

// Lines that change on every run (approval time, the mandate fingerprint) are left out of the
// hash, so the answer recorded for a prepared case can be replayed when the same case runs again.
const VOLATILE_LINE = /^(Approved at:|custom_id:)/;

export function evidenceHash(evidence, statement, purpose) {
  const stable = (text) => text.split('\n').filter((line) => !VOLATILE_LINE.test(line)).join('\n');
  const canonical = JSON.stringify({
    purpose,
    statement,
    docs: Object.keys(evidence)
      .sort()
      .map((k) => [k, stable(evidence[k].text)]),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 24);
}

const NO_FIRST_DEVIATION = { kind: 'INSUFFICIENT', step: null, condition: null, quote: '' };

// The quick check reads only these two documents. A fact-table slot is used there only with its quotes
// from them; with none left it is unknown, the way a model that read only these two would answer.
const QUICK_DOCS = ['mandate', 'paypal_order'];
function quickSlot(fact) {
  const evidence = (fact.evidence || []).filter((e) => QUICK_DOCS.includes(e.doc));
  return evidence.length ? { ...fact, evidence } : { value: 'unknown', evidence: [] };
}

/**
 * Hand-written answers. quick: `fixture.quick` if a test set it (passed as written), else the matching
 * slots of the fact table, keeping only quotes from the mandate and the PayPal order. deep: the fact
 * table (or `fixture.deep.facts`), `fixture.deep.firstDeviation`, and
 * `fixture.deep.verdict` (a liable string or {liable, reason}); with no verdict the desk uses the rules'
 * answer, so a bare fixture reads the records the way the rules do.
 */
function fixtureAnswer(purpose, fixture = {}) {
  if (purpose === 'quick') {
    const facts = fixture.quick || Object.fromEntries(QUICK_AI_FACTS.filter((k) => fixture.facts?.[k]).map((k) => [k, quickSlot(fixture.facts[k])]));
    return { facts };
  }
  const deep = fixture.deep || {};
  const verdict = typeof deep.verdict === 'string' ? { liable: deep.verdict, reason: '' } : deep.verdict || null;
  return { facts: deep.facts || fixture.facts || {}, firstDeviation: deep.firstDeviation || NO_FIRST_DEVIATION, verdict };
}

/**
 * @param {object} opts
 * @param {'fixture'|'recorded'|'anthropic'} opts.provider
 * @param {string|null} opts.recordedDir   where live answers are saved and replayed from
 * @param {{quick: Function, deep: Function}|null} opts.live   live calls ({evidence, statement, candidates}) => answer
 * @param {boolean} opts.reuseRecorded     with provider "anthropic": replay a saved answer instead of calling again
 */
export function createFactExtractor({ provider = 'fixture', recordedDir = null, live = null, reuseRecorded = false }) {
  async function ask(purpose, { evidence, statement = '', candidates = [], fixture }) {
    const hash = evidenceHash(evidence, statement, purpose);
    if (provider === 'fixture') {
      return { ...fixtureAnswer(purpose, fixture), provider: 'fixture', hash };
    }
    const file = recordedDir ? join(recordedDir, `${purpose}-${hash}.json`) : null;
    if (provider === 'recorded' || (provider === 'anthropic' && reuseRecorded && file && existsSync(file))) {
      if (!file || !existsSync(file)) throw new Error(`No recorded AI answer for ${purpose} evidence ${hash}`);
      return { ...JSON.parse(readFileSync(file, 'utf8')), provider: 'recorded', hash };
    }
    if (provider === 'anthropic') {
      if (!live?.[purpose]) throw new Error('Live AI provider is not configured.');
      const startedAtMs = Date.now();
      const answer = await live[purpose]({ evidence, statement, candidates });
      const ms = Date.now() - startedAtMs;
      if (file && answer.model) {
        mkdirSync(recordedDir, { recursive: true });
        writeFileSync(file, JSON.stringify({ ...answer, recordedAt: new Date().toISOString() }, null, 1));
      }
      // An answer skipped over a cap (src/context.js) is named as such, never as a live answer.
      return { ...answer, provider: answer.notCalled ? 'not-called' : 'anthropic', hash, ms };
    }
    throw new Error(`Unknown AI provider: ${provider}`);
  }
  return {
    provider,
    /** @returns {Promise<{facts: object, provider: string, model?: string, hash: string}>} */
    quick: (args) => ask('quick', args),
    /** @returns {Promise<{facts: object, firstDeviation: object, verdict: {liable, reason}|null, provider: string, model?: string, hash: string}>} */
    deep: (args) => ask('deep', args),
  };
}
