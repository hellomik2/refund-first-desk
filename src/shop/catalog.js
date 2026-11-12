// The demo catalog the live agent shops from (scenarios/catalog.json, written by us). Pure functions:
// search, the listing line an agent sees, and the price of a one-store cart with shipping and tax.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../config.js';
import { fromCents } from '../domain/money.js';
import { SHIPPING_SKU } from '../domain/agentlog.js';

export function loadCatalog(root = ROOT) {
  return JSON.parse(readFileSync(join(root, 'scenarios', 'catalog.json'), 'utf8'));
}

export const storeOf = (catalog, id) => catalog.stores.find((s) => s.id === id);
export const productOf = (catalog, sku) => catalog.products.find((p) => p.sku === String(sku || '').trim().toUpperCase());

const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length > 0);

/** Matches by words in the title, name, details and tags. Sponsored matches come first, as on a real store page. */
export function searchCatalog(catalog, query, limit = 6) {
  const q = new Set(words(query).flatMap((w) => [w, w.replace(/s$/, '')]));
  if (!q.size) return [];
  return catalog.products
    .map((p, i) => {
      const hay = new Set(words(`${p.title} ${p.name} ${p.details} ${p.tags.join(' ')}`).flatMap((w) => [w, w.replace(/s$/, '')]));
      const score = [...q].filter((w) => hay.has(w)).length;
      return { p, i, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => Number(Boolean(b.p.sponsored)) - Number(Boolean(a.p.sponsored)) || b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((r) => r.p);
}

/**
 * One search result as the agent sees it. "careful": store, the variant line from the product page, and the
 * store's shipping. "hasty": product number, listing title and price only (what a results page shows at a glance).
 */
export function listingLine(catalog, p, view) {
  const head = `${p.sku} | ${p.title} | $${fromCents(p.priceCents)}`;
  if (view === 'hasty') return head;
  const store = storeOf(catalog, p.store);
  return `${head} | ${store.name}${p.sponsored ? ' (sponsored)' : ''} | ${p.details} | ${store.shippingNote}`;
}

/** The full product page: the same for every agent. */
export function productPage(catalog, p) {
  const store = storeOf(catalog, p.store);
  return `${p.sku} at ${store.name}${p.sponsored ? ' (sponsored listing)' : ''}\nListing title: ${p.title}\nProduct: ${p.name}\nPrice: $${fromCents(p.priceCents)}\n${p.details}\nStore terms: ${store.shippingNote}. In stock.`;
}

/**
 * Price a cart of {sku, qty}. A cart holds products from one store only. The PayPal cart is the product lines
 * plus a shipping line and a tax line, so the PayPal order total is what the buyer pays.
 */
export function priceCart(catalog, lines) {
  if (!lines.length) throw new Error('The cart is empty.');
  const products = lines.map((l) => {
    const p = productOf(catalog, l.sku);
    if (!p) throw new Error(`No product ${l.sku}.`);
    return { p, qty: l.qty };
  });
  const stores = new Set(products.map((x) => x.p.store));
  if (stores.size > 1) throw new Error('A cart can hold products from one store only.');
  const store = storeOf(catalog, products[0].p.store);
  const items = products.map(({ p, qty }) => ({ sku: p.sku, name: p.name, qty, unitCents: p.priceCents }));
  const subtotalCents = items.reduce((s, l) => s + l.qty * l.unitCents, 0);
  const shippingCents = store.shippingCents;
  const taxCents = Math.round(subtotalCents * store.taxRate);
  const paypalCart = [...items];
  if (shippingCents) paypalCart.push({ sku: SHIPPING_SKU, name: 'Shipping', qty: 1, unitCents: shippingCents });
  if (taxCents) paypalCart.push({ sku: 'TAX', name: 'Sales tax', qty: 1, unitCents: taxCents });
  return { store: { id: store.id, name: store.name }, items, subtotalCents, shippingCents, taxCents, totalCents: subtotalCents + shippingCents + taxCents, paypalCart };
}
