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
import { SHIPPING_SKU } from './agentlog.js';
import { cartTotalCents } from './money.js';

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
export const LIABLE = ['STORE', 'AGENT', 'BUYER', 'UNDETERMINED'];
// What the quick check asks the AI, reading only the mandate and the PayPal order (quantity only when code cannot tell).
export const QUICK_AI_FACTS = ['itemMatchesMandate', 'exclusionsRespected', 'quantityMatchesMandate'];

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

/** The same test verifyFacts applies to a quote, for a single piece of text. */
export function quoteFound(text, quote) {
  return typeof quote === 'string' && quote.trim() !== '' && normalize(text).includes(normalize(quote));
}

/**
 * The facts code computes from the originals (mandate, PayPal order, the cart the agent submitted),
 * before and instead of the AI. A fact code cannot settle is left out.
 * @returns {Record<string, {value: 'yes'|'no', doc: string, quote: string}>}
 */
export function codeFacts({ mandate, paypalOrder, agentCart }) {
  const out = {};
  const put = (key, ok, doc, quote) => {
    out[key] = { value: ok ? 'yes' : 'no', doc, quote };
  };
  const c = mandate.conditions;
  put('purchaseAuthorized', c.purchaseAuthorized, 'mandate', `May the agent pay without asking again: ${c.purchaseAuthorized ? 'yes' : 'no'}`);
  if (c.maxTotalCents != null && paypalOrder.totalCents != null) {
    put('withinSpendingLimit', paypalOrder.totalCents <= c.maxTotalCents, 'paypal_order', `PayPal order total ${paypalOrder.totalCents} cents vs limit ${c.maxTotalCents} cents`);
  } else if (c.maxTotalCents == null) {
    put('withinSpendingLimit', true, 'mandate', 'Spending limit: (none)');
  }
  if (agentCart?.length && paypalOrder.totalCents != null) {
    // Line by line (sku, quantity, unit price) and the total: what the agent submitted against what PayPal charged.
    const lines = (cart) => cart.map((l) => `${l.sku}|${l.qty}|${l.unitCents}`).sort().join(',');
    const agentTotal = cartTotalCents(agentCart);
    const same = lines(agentCart) === lines(paypalOrder.items) && agentTotal === paypalOrder.totalCents;
    put('storeChargedAsOrdered', same, 'paypal_order', `Cart submitted by the agent ${agentTotal} cents in ${agentCart.length} lines vs PayPal order ${paypalOrder.totalCents} cents in ${paypalOrder.items.length} lines: ${same ? 'same lines and total' : 'different'}`);
  }
  if (c.quantity != null) {
    // Only when the order holds one item (shipping aside); with more, which line counts is a judgement.
    const items = paypalOrder.items.filter((i) => i.sku !== SHIPPING_SKU);
    if (new Set(items.map((i) => i.sku)).size === 1) {
      const qty = items.reduce((sum, i) => sum + i.qty, 0);
      put('quantityMatchesMandate', qty === c.quantity, 'paypal_order', `PayPal order quantity ${qty} vs mandate quantity ${c.quantity}`);
    }
  }
  return out;
}

/** Facts code can compute on its own win over what the AI said. Disagreements are reported. */
export function applyCodeChecks(facts, { mandate, paypalOrder, agentCart = null }) {
  const overrides = [];
  for (const [key, f] of Object.entries(codeFacts({ mandate, paypalOrder, agentCart }))) {
    if (facts[key].value !== f.value) overrides.push({ key, ai: facts[key].value, code: f.value });
    facts[key] = { value: f.value, evidence: [{ doc: f.doc, quote: f.quote, computed: true }], note: 'computed by code' };
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
