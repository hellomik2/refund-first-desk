// Responsibility is decided by code from a fact table. The AI fills the table and must quote the
// record each fact came from; this module checks the quotes, overrides the facts code can compute
// itself (amounts, counts, the mandate fingerprint), and applies fixed rules.
//
// Responsibility table (the only way a buyer can be found responsible is rule R4):
//   R0  the records cannot be tied together (fingerprint mismatch, no PayPal capture)  -> UNDETERMINED
//   R1  the store did not deliver or charge what was ordered                           -> STORE
//   R2  the order differs from the approved mandate in any slot                         -> AGENT
//   R3  any fact is still unknown after R1 and R2                                       -> UNDETERMINED (buyer keeps the refund)
//   R4  the order matches every slot of the mandate, the buyer approved paying,
//       and the store delivered and charged as ordered                                 -> BUYER

export const MANDATE_FACTS = [
  'purchaseAuthorized', // the approved mandate allowed the agent to pay
  'itemMatchesMandate', // what was ordered is the item the buyer described
  'quantityMatchesMandate',
  'withinSpendingLimit',
  'exclusionsRespected', // nothing the buyer ruled out is in the order
];
export const STORE_FACTS = [
  'storeChargedAsOrdered', // the store charged exactly the cart the agent submitted
  'storeFulfilledAsOrdered', // the store shipped what the order says
];
export const ALL_FACTS = [...MANDATE_FACTS, ...STORE_FACTS];

const VALUES = new Set(['yes', 'no', 'unknown']);

/**
 * Keep a yes/no only if it comes with at least one quote that really appears in the cited document.
 * Anything else becomes "unknown". This is the guard against an AI that sounds sure without a source.
 */
export function verifyFacts(rawFacts, evidence) {
  const facts = {};
  const downgraded = [];
  for (const key of ALL_FACTS) {
    const raw = rawFacts?.[key] || {};
    let value = VALUES.has(raw.value) ? raw.value : 'unknown';
    const quotes = (raw.evidence || []).filter((e) => {
      // The buyer's own report is a claim, not a record. It can never be the proof of a fact.
      if (e.doc === 'complaint') return false;
      const doc = evidence[e.doc];
      return doc && typeof e.quote === 'string' && e.quote.trim() && normalize(doc.text).includes(normalize(e.quote));
    });
    if (value !== 'unknown' && quotes.length === 0) {
      downgraded.push(key);
      value = 'unknown';
    }
    facts[key] = { value, evidence: quotes, note: raw.note || '' };
  }
  return { facts, downgraded };
}

function normalize(s) {
  return String(s).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Facts code can compute on its own win over what the AI said. Disagreements are reported. */
export function applyCodeChecks(facts, { mandate, paypalOrder }) {
  const overrides = [];
  const set = (key, value, doc, note) => {
    if (facts[key].value !== value) overrides.push({ key, ai: facts[key].value, code: value });
    facts[key] = { value, evidence: [{ doc, quote: note, computed: true }], note: 'computed by code' };
  };
  const c = mandate.conditions;
  set('purchaseAuthorized', c.purchaseAuthorized ? 'yes' : 'no', 'mandate', `May the agent pay without asking again: ${c.purchaseAuthorized ? 'yes' : 'no'}`);
  if (c.maxTotalCents != null && paypalOrder.totalCents != null) {
    const ok = paypalOrder.totalCents <= c.maxTotalCents;
    set('withinSpendingLimit', ok ? 'yes' : 'no', 'paypal_order', `PayPal order total ${paypalOrder.totalCents} cents vs limit ${c.maxTotalCents} cents`);
  } else if (c.maxTotalCents == null) {
    set('withinSpendingLimit', 'yes', 'mandate', 'Spending limit: (none)');
  }
  return overrides;
}

export function decideLiability(facts, integrity = { ok: true, problems: [] }) {
  if (!integrity.ok) {
    return { liable: 'UNDETERMINED', rule: 'R0', reasons: integrity.problems };
  }
  const no = (keys) => keys.filter((k) => facts[k]?.value === 'no');
  const unknown = (keys) => keys.filter((k) => facts[k]?.value !== 'yes' && facts[k]?.value !== 'no');

  const storeNo = no(STORE_FACTS);
  if (storeNo.length) return { liable: 'STORE', rule: 'R1', reasons: storeNo };

  const mandateNo = no(MANDATE_FACTS);
  if (mandateNo.length) return { liable: 'AGENT', rule: 'R2', reasons: mandateNo };

  const open = unknown(ALL_FACTS);
  if (open.length) return { liable: 'UNDETERMINED', rule: 'R3', reasons: open };

  return { liable: 'BUYER', rule: 'R4', reasons: [] };
}
