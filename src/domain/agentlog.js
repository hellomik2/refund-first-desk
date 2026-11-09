// The agent's action log: numbered steps, shown to the investigator one line per step, plus the
// violation candidates code can flag on its own (the AgentRx idea: rule checks per step are given
// to the judge as evidence, never as the decision).
//
// One step: { step, at, actor: agent|user|store, action, content, sku?, qty?, amountCents? }
// actions: search, view, add_to_cart, remove_from_cart, checkout, pay, ask_user, message
import { fromCents } from './money.js';

export const SHIPPING_SKU = 'SHIP';

/** Older logs are plain strings: each string is one "message" step by the agent. */
export function normalizeAgentLog(log = []) {
  return log.map((entry, i) =>
    typeof entry === 'string' ? { step: i + 1, at: null, actor: 'agent', action: 'message', content: entry } : { ...entry },
  );
}

/** Exactly this form; the case checker quotes against the same form. */
export function stepLine(s) {
  const time = typeof s.at === 'string' && s.at.length >= 19 ? s.at.slice(11, 19) : '--:--:--';
  return `Step ${s.step} · ${time} · ${s.actor} · ${s.action}: ${s.content}`;
}

// Words that say nothing about what was excluded ("anything with peanuts" -> "peanuts").
const NOT_A_SIGNAL = new Set(['and', 'or', 'the', 'with', 'any', 'all', 'for', 'from', 'that', 'this', 'not', 'non', 'anything', 'something', 'product', 'products', 'item', 'items', 'thing', 'things', 'stuff']);

function excludedWordIn(content, exclusions) {
  for (const exclusion of exclusions || []) {
    for (const word of String(exclusion).toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length < 3 || NOT_A_SIGNAL.has(word)) continue;
      const stem = word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
      // Whole word, singular or plural: "sweetened" does not match "unsweetened".
      if (new RegExp(`\\b${stem}s?\\b`, 'i').test(content)) return exclusion;
    }
  }
  return null;
}

/** Steps that simple rules flag. They can be wrong and they can miss; the AI is told so. */
export function violationCandidates(steps, conditions) {
  const out = [];
  const flag = (s, condition, why) => out.push({ step: s.step, condition, why });
  let cartCents = 0;
  for (const s of steps) {
    if ((s.action === 'pay' || s.action === 'checkout') && !conditions.purchaseAuthorized) {
      flag(s, 'purchaseAuthorized', `${s.action} step, and the mandate does not let the agent pay`);
    }
    if (s.action === 'add_to_cart') {
      cartCents += s.amountCents || 0;
      if (conditions.quantity != null && s.sku !== SHIPPING_SKU && s.qty != null && s.qty !== conditions.quantity) {
        flag(s, 'quantityMatchesMandate', `adds ${s.qty}, the mandate says ${conditions.quantity}`);
      }
      if (conditions.maxTotalCents != null && cartCents > conditions.maxTotalCents) {
        flag(s, 'withinSpendingLimit', `cart reaches $${fromCents(cartCents)}, the limit is $${fromCents(conditions.maxTotalCents)}`);
      }
      const hit = excludedWordIn(s.content, conditions.exclusions);
      if (hit) flag(s, 'exclusionsRespected', `mentions what the buyer ruled out ("${hit}")`);
    }
    if (s.action === 'remove_from_cart') cartCents -= s.amountCents || 0;
  }
  return out;
}
