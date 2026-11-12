// Shared by every part of the page: one state object, formatting, and the words for server values.
// Times are always shown in English, whatever the visitor's browser language is.
export const S = {
  state: null,
  cases: [],
  catalog: null, // the live agent's demo catalog and prepared instructions
  busy: false,
  showAll: false,
  reconciliation: null,
  openSteps: new Map(), // "caseId:step" -> open or closed, once the viewer has clicked a step
};

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const usd = (cents) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents || 0) / 100).toFixed(2)}`;
export const signed = (cents) => (!cents ? '$0.00' : `${cents > 0 ? '+' : '-'}$${(Math.abs(cents) / 100).toFixed(2)}`);
export const time = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
export const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '');
export const secs = (ms) => `${(Math.max(0, ms || 0) / 1000).toFixed(2)} s`;
export const humanize = (key) => {
  const s = String(key ?? '').replace(/_/g, ' ').toLowerCase().trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Not given';
};
/** A label for a server value; a value this page does not know yet is spelled out, never "undefined". */
export const label = (map, key) => map[key] ?? humanize(key);

export const REASONS = {
  OVER_PER_CASE_CAP: 'the amount is over the instant-refund limit per case',
  OVER_30_DAY_COUNT: 'this buyer already used the instant refunds allowed in 30 days',
  NO_SAVED_WALLET_CONSENT: 'the buyer has no saved wallet with consent',
  RESERVE_TOO_LOW: "the desk's own funds could not cover the store",
  REFUND_CALL_FAILED: 'the refund call did not go through',
  BUYER_DISPUTED: 'the buyer disputed it',
  NO_ACTIVE_CONSENT: 'the buyer withdrew consent',
  RECHARGE_CLOSED_BY_QUICK_CHECK: 'the quick check closed the re-charge for this order',
  CHARGE_FAILED: 'the charge did not go through',
  CAPTURE_NOT_COMPLETED: 'PayPal did not complete the charge',
  NOT_THE_WALLET_THAT_PAID: 'the wallet that paid this order is no longer saved, and no other wallet may be charged for it',
};
export const FACT_LABELS = {
  purchaseAuthorized: 'The mandate allowed the agent to pay',
  itemMatchesMandate: 'The ordered item is what the buyer described',
  quantityMatchesMandate: 'The quantity matches',
  withinSpendingLimit: 'The total is within the spending limit',
  exclusionsRespected: 'Nothing the buyer ruled out is in the order',
  storeChargedAsOrdered: 'The store charged what the agent submitted',
  storeFulfilledAsOrdered: 'The store shipped what was ordered',
};
export const FACT_SHORT = {
  purchaseAuthorized: 'allowed to pay',
  itemMatchesMandate: 'item',
  quantityMatchesMandate: 'quantity',
  withinSpendingLimit: 'spending limit',
  exclusionsRespected: 'ruled-out items',
  storeChargedAsOrdered: 'store charge',
  storeFulfilledAsOrdered: 'store shipment',
};
export const INTEGRITY = {
  MANDATE_RECORD_CHANGED_AFTER_APPROVAL: 'The mandate record changed after the buyer approved it',
  PAYPAL_ORDER_NOT_TIED_TO_THIS_MANDATE: 'The PayPal order does not carry this mandate',
  NO_PAYPAL_CAPTURE: 'PayPal has no capture for this order',
};
export const RULES = {
  R0: 'The records could not be tied together, so nothing is held against the buyer.',
  R1: 'The store did not deliver or charge what was ordered.',
  R2: 'The order differs from what the buyer approved.',
  R3: 'The records leave a question open. An open question is never held against the buyer.',
  R4: 'The order matches every condition the buyer approved, and the store delivered and charged as ordered.',
  OPERATOR: 'The two keys differed, so a person chose.',
};
export const WHO = { STORE: 'The store', AGENT: "The agent's operator", BUYER: 'The buyer', UNDETERMINED: 'Nobody could be named: the desk absorbs it' };
export const WHO_SHORT = { STORE: 'Store', AGENT: "Agent's operator", BUYER: 'Buyer', UNDETERMINED: 'Nobody (desk absorbs)' };
export const WHO_IN = { STORE: 'the store', AGENT: "the agent's operator", BUYER: 'the buyer' };
export const DOCS = { mandate: 'Mandate', paypal_order: 'PayPal order', agent_log: "Agent's log", store_record: 'Store record', complaint: "Buyer's report" };
export const DOCS_IN = { mandate: 'the mandate', paypal_order: 'the PayPal order', agent_log: "the agent's log", store_record: 'the store record', complaint: "the buyer's report" };
export const NOTICES = {
  REFUND_REQUESTED: { title: 'Refund requested', tone: 'info' },
  REFUND_COMPLETED: { title: 'PayPal refund completed', tone: 'go' },
  REFUND_PENDING: { title: 'Refund still with PayPal', tone: 'wait' },
  NO_RECHARGE: { title: 'No re-charge', tone: 'go' },
  CHECKING_FIRST: { title: 'Checking first', tone: 'wait' },
  HUMAN_REVIEW: { title: 'A person is checking', tone: 'wait' },
};
export const REVIEW_REASONS = {
  KEYS_DISAGREE: 'The rules key and the AI key name different parties.',
  QUICK_CLOSED_BUT_BOTH_BUYER: 'Both keys name the buyer, but the quick check already found a mismatch. A contradiction goes to a person.',
};
export const ACCOUNTS = { buyer: 'Buyer', 'desk:purchase': 'Desk, purchase money held', 'desk:reserve': "Desk's own funds", store: 'Store', 'paypal:fees': 'PayPal fees' };
export const KINDS = {
  PURCHASE_CAPTURED: 'Purchase captured',
  PAYPAL_FEE: 'PayPal fee',
  REFUND: 'Refund to buyer',
  STORE_PAID: 'Store paid',
  RECHARGE_CAPTURED: 'Buyer charged again',
  RESERVE_ALLOCATED: 'Own funds set aside',
  RESERVE_RELEASED: 'Set-aside released',
  RESERVE_CONSUMED: 'Set-aside used',
  RESERVE_COVERS_REFUND: 'Own funds cover a refund after the store was paid',
  STORE_OWES_DESK: 'Store owes the desk (paid before the report)',
  AGENT_COMPANY_OWES: "Agent's operator owes the desk",
};

/** Ledger lines for this order at or after a moment (server times on both sides). */
export const linesSince = (orderId, iso) => S.state.ledger.filter((l) => l.orderId === orderId && iso && l.at >= iso);

/**
 * How long the refund took, from server times only. Refund first: from the report. Checked first: from
 * the start of the check, or from a person's choice when one was needed (their waiting time is not the desk's).
 */
export function refundTiming(k) {
  const done = k.refund.completedAtMs;
  if (k.path === 'REFUND_FIRST') return `${secs(done - k.receivedAtMs)} after the report, before the purchase is checked`;
  const chosen = k.verdict?.rule === 'OPERATOR' ? Date.parse(k.verdict.decidedAt) : NaN;
  if (done >= chosen) return `${secs(done - chosen)} after a person chose`;
  return `${secs(done - (k.quick?.startedAtMs ?? k.receivedAtMs))} after the check began`;
}
