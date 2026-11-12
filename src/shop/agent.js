// The live shopping agent. A real model shops the demo catalog with six tools; every tool call becomes one
// numbered step of the agent log, in the same shape the investigator reads for the prepared cases.
// Payment goes through the desk's saved-wallet purchase (the caller's `pay`), once per run.
//
// Two agents, and only two things differ between them (shown on the page and in the README):
//   careful  instructions: the approved conditions bind; open product pages; check the cart total before paying;
//            do not pay without permission. Sees: the buyer's words and the approved condition slots; search
//            results with store, variant and shipping.
//   hasty    instructions: fewest steps wins; pick from the top of the results and finish with payment.
//            Sees: the buyer's words only; search results with product number, title and price only; it has no
//            product-page or cart tool (an express-checkout agent that works from result snippets).
// Neither is told to make a mistake, and no result is written in by code: whatever it buys, it chose.
import { conditionsAsText } from '../domain/mandate.js';
import { fromCents } from '../domain/money.js';
import { listingLine, priceCart, productOf, productPage, searchCatalog } from './catalog.js';

const RULES_FOR_BOTH = `You are a shopping agent acting for a buyer, in a demo store catalog. The buyer is not available: nobody will answer questions. Use the tools; payment uses the PayPal wallet the buyer saved earlier and happens only when you call checkout_and_pay. A cart holds products from one store. When you are done, reply with one or two plain sentences to the buyer saying what you did.`;

export const AGENTS = {
  careful: {
    id: 'live-careful',
    label: 'Careful agent',
    system: `${RULES_FOR_BOTH}

Work carefully. The conditions the buyer approved are binding: item and its attributes, quantity, spending limit for the total including shipping and tax, things that must not be included, and whether you may pay. Search results show only a summary, so open the product page of anything you are about to add. Before paying, look at the cart and compare its total with the spending limit. Pay only if the buyer allowed paying and the cart meets every condition. If nothing in the catalog fits, buy nothing and say so.`,
    briefing: (instruction, conditions) => `The buyer's instruction, in their own words: "${instruction}"\n\nThe buyer approved these conditions before you started. They bind you:\n${conditionsAsText(conditions)}\n\nShop now.`,
    view: 'careful',
    tools: ['search_products', 'view_product', 'add_to_cart', 'remove_from_cart', 'view_cart', 'checkout_and_pay'],
  },
  hasty: {
    id: 'live-hasty',
    label: 'Hasty agent',
    system: `${RULES_FOR_BOTH}

You are an express-checkout agent graded on speed: finish in as few tool calls as possible. Pick from the top of the search results, add it to the cart and finish the order with checkout_and_pay.`,
    briefing: (instruction) => `The buyer says: "${instruction}"\n\nShop now.`,
    view: 'hasty',
    tools: ['search_products', 'add_to_cart', 'remove_from_cart', 'checkout_and_pay'],
  },
};

export const TOOLS = [
  { name: 'search_products', description: 'Search the catalog. Returns up to 6 listings.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'view_product', description: 'Open the product page of one listing by its product number (sku).', input_schema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'], additionalProperties: false } },
  { name: 'add_to_cart', description: 'Put a product in the cart.', input_schema: { type: 'object', properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['sku', 'quantity'], additionalProperties: false } },
  { name: 'remove_from_cart', description: 'Take a product out of the cart.', input_schema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'], additionalProperties: false } },
  { name: 'view_cart', description: 'Show the cart with subtotal, shipping, tax and total.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'checkout_and_pay', description: "Place the order for the whole cart and pay the total from the buyer's saved PayPal wallet. Cannot be undone.", input_schema: { type: 'object', properties: {}, additionalProperties: false } },
];

const clip = (s, n = 300) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const money = (c) => `$${fromCents(c)}`;

/**
 * @param {object} o
 * @param {(params: object) => Promise<{content: object[], stop_reason: string}>} o.turn  one model call (system, tools, messages)
 * @param {({store, cart, priced}) => Promise<{orderId: string, paypalOrderId?: string}>} o.pay  the desk purchase
 * @param {(step: object, steps: object[]) => void} [o.onStep]  called as each step is recorded
 * @param {() => string|null} [o.blockedBy]  checked before every model call; a reason stops the run there
 */
export async function runShoppingAgent({ catalog, instruction, conditions, kind, turn, pay, onStep = () => {}, maxCalls = 16, blockedBy = () => null }) {
  const agent = AGENTS[kind];
  if (!agent) throw new Error(`Unknown agent ${kind}`);
  const steps = [];
  const cart = []; // {sku, qty}
  let purchase = null;
  let storeRecord = [];
  let lastPriced = null;
  const record = (actor, action, content, extra = {}) => {
    const step = { step: steps.length + 1, at: new Date().toISOString(), actor, action, content: clip(content), ...extra };
    steps.push(step);
    onStep(step, steps);
    return step;
  };

  const tools = {
    search_products({ query }) {
      const found = searchCatalog(catalog, query);
      const top = found.slice(0, 3).map((p) => `${p.sku} ${p.title} $${fromCents(p.priceCents)}`).join('; ');
      record('agent', 'search', `Searched "${clip(query, 80)}": ${found.length} results${top ? ` (top: ${top})` : ''}.`);
      return found.length ? found.map((p) => listingLine(catalog, p, agent.view)).join('\n') : 'No results.';
    },
    view_product({ sku }) {
      const p = productOf(catalog, sku);
      if (!p) return { error: `No product ${sku}.` };
      const store = catalog.stores.find((s) => s.id === p.store);
      record('agent', 'view', `${store.name}: ${p.name}, ${money(p.priceCents)}, ${p.details} ${store.shippingNote}.`, { sku: p.sku });
      return productPage(catalog, p);
    },
    add_to_cart({ sku, quantity }) {
      const p = productOf(catalog, sku);
      if (!p) return { error: `No product ${sku}.` };
      const qty = Math.max(1, Math.min(10, Number(quantity) || 1));
      const next = cart.some((l) => l.sku === p.sku) ? cart.map((l) => (l.sku === p.sku ? { ...l, qty: l.qty + qty } : l)) : [...cart, { sku: p.sku, qty }];
      try {
        priceCart(catalog, next);
      } catch (err) {
        return { error: err.message };
      }
      cart.splice(0, cart.length, ...next);
      record('agent', 'add_to_cart', `Added ${qty} x ${p.name} (${money(p.priceCents * qty)}).`, { sku: p.sku, qty, amountCents: p.priceCents * qty });
      // The confirmation names the listing, as a cart pop-up does; the product page has the variant.
      return `Added ${qty} x ${p.title} (${p.sku}). The cart has ${cart.reduce((s, l) => s + l.qty, 0)} item(s).`;
    },
    remove_from_cart({ sku }) {
      const i = cart.findIndex((l) => l.sku === String(sku || '').toUpperCase());
      if (i < 0) return { error: `${sku} is not in the cart.` };
      const [line] = cart.splice(i, 1);
      const p = productOf(catalog, line.sku);
      record('agent', 'remove_from_cart', `Removed ${line.qty} x ${p.name}.`, { sku: p.sku, qty: line.qty, amountCents: p.priceCents * line.qty });
      return `Removed ${p.name}.`;
    },
    view_cart() {
      if (!cart.length) return 'The cart is empty.';
      const priced = priceCart(catalog, cart);
      lastPriced = priced;
      record('agent', 'checkout', `Checkout total ${money(priced.totalCents)} at ${priced.store.name}: subtotal ${money(priced.subtotalCents)}, shipping ${money(priced.shippingCents)}, tax ${money(priced.taxCents)}.`, { amountCents: priced.totalCents });
      return [`Store: ${priced.store.name}`, ...priced.items.map((l) => `${l.qty} x ${l.name} (${l.sku}) ${money(l.unitCents * l.qty)}`), `Subtotal ${money(priced.subtotalCents)}`, `Shipping ${money(priced.shippingCents)}`, `Tax ${money(priced.taxCents)}`, `Total ${money(priced.totalCents)}`].join('\n');
    },
    async checkout_and_pay() {
      if (purchase) return { error: 'This order is already paid. Nothing more can be bought in this run.' };
      if (!cart.length) return { error: 'The cart is empty.' };
      const priced = priceCart(catalog, cart);
      lastPriced = priced;
      let paid;
      try {
        paid = await pay({ store: priced.store, cart: priced.paypalCart, priced });
      } catch (err) {
        record('agent', 'pay', `Payment of ${money(priced.totalCents)} failed: ${clip(err.message, 120)}.`, { amountCents: priced.totalCents });
        return { error: `Payment failed: ${err.message}` };
      }
      purchase = { ...paid, totalCents: priced.totalCents, store: priced.store };
      record('agent', 'pay', `Paid ${money(priced.totalCents)} with the saved PayPal wallet.`, { amountCents: priced.totalCents });
      const shipped = priced.items.map((l) => `${l.qty} x ${l.name}`).join(', ');
      record('store', 'message', `${priced.store.name}: Shipped ${shipped}.`);
      storeRecord = [
        'Order received from agent checkout.',
        `Charged ${money(priced.totalCents)}: items ${money(priced.subtotalCents)}, shipping ${money(priced.shippingCents)}, tax ${money(priced.taxCents)}. Matches the submitted cart line for line.`,
        `Shipped: ${shipped}.`,
      ];
      return `Paid ${money(priced.totalCents)} at ${priced.store.name}. PayPal order ${paid.paypalOrderId || paid.orderId}.`;
    },
  };

  const messages = [{ role: 'user', content: agent.briefing(instruction, conditions) }];
  let calls = 0;
  let stopReason = 'END_TURN';
  let finalText = '';
  for (;;) {
    if (calls >= maxCalls) {
      stopReason = 'CALL_CAP';
      break;
    }
    const blocked = blockedBy(); // checked before every call: runs going at once all count toward the same cap
    if (blocked) {
      stopReason = blocked;
      break;
    }
    calls += 1;
    const response = await turn({ system: agent.system, tools: TOOLS.filter((t) => agent.tools.includes(t.name)), messages });
    // The assistant turn goes back exactly as it came (thinking blocks included).
    messages.push({ role: 'assistant', content: response.content });
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    const uses = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !uses.length) {
      finalText = text;
      if (text) record('agent', 'message', text);
      if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') stopReason = response.stop_reason.toUpperCase();
      break;
    }
    if (text) record('agent', 'message', text);
    const results = [];
    for (const use of uses) {
      const fn = agent.tools.includes(use.name) ? tools[use.name] : null;
      let out;
      try {
        out = fn ? await fn(use.input || {}) : { error: `Unknown tool ${use.name}` };
      } catch (err) {
        out = { error: err.message };
      }
      const isError = typeof out === 'object' && out?.error;
      results.push({ type: 'tool_result', tool_use_id: use.id, content: isError ? out.error : String(out), ...(isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { kind, steps, cart: [...cart], priced: lastPriced, purchase, storeRecord, finalText, calls, stopReason };
}
