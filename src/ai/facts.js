// The fact table is the only thing the AI contributes to a decision. It reads the records and
// answers seven yes/no/unknown questions, each with a quote from the record it relied on.
// Providers:
//   fixture    development plumbing only: returns facts written by hand next to a prepared case
//   recorded   replays answers a live model gave earlier for the same evidence (keyed by evidence hash)
//   anthropic  calls the model live
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

export function evidenceHash(evidence, statement) {
  const stable = (text) => text.split('\n').filter((line) => !VOLATILE_LINE.test(line)).join('\n');
  const canonical = JSON.stringify({
    statement,
    docs: Object.keys(evidence)
      .sort()
      .map((k) => [k, stable(evidence[k].text)]),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 24);
}

/**
 * @param {object} opts
 * @param {'fixture'|'recorded'|'anthropic'} opts.provider
 * @param {string|null} opts.recordedDir   where live answers are saved and replayed from
 * @param {Function|null} opts.live        ({evidence, statement}) => {facts, model}
 * @param {boolean} opts.reuseRecorded     with provider "anthropic": replay a saved answer instead of calling again
 */
export function createFactExtractor({ provider = 'fixture', recordedDir = null, live = null, reuseRecorded = false }) {
  return {
    provider,
    /** @returns {Promise<{facts: object, provider: string, model?: string, hash: string}>} */
    async extract({ evidence, statement, fixtureFacts }) {
      const hash = evidenceHash(evidence, statement);
      if (provider === 'fixture') {
        return { facts: fixtureFacts || {}, provider: 'fixture', hash };
      }
      const file = recordedDir ? join(recordedDir, `${hash}.json`) : null;
      if (provider === 'recorded' || (provider === 'anthropic' && reuseRecorded && file && existsSync(file))) {
        if (!file || !existsSync(file)) throw new Error(`No recorded AI answer for evidence ${hash}`);
        return { ...JSON.parse(readFileSync(file, 'utf8')), provider: 'recorded', hash };
      }
      if (provider === 'anthropic') {
        if (!live) throw new Error('Live AI provider is not configured.');
        const answer = await live({ evidence, statement });
        if (file) {
          mkdirSync(recordedDir, { recursive: true });
          writeFileSync(file, JSON.stringify({ facts: answer.facts, model: answer.model, recordedAt: new Date().toISOString() }, null, 1));
        }
        return { facts: answer.facts, model: answer.model, provider: 'anthropic', hash };
      }
      throw new Error(`Unknown AI provider: ${provider}`);
    },
  };
}
