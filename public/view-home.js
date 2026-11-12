// The start of the page: the prepared cases and the live agent's instructions, as compact rows.
import { S, $, esc, usd, swapKeepingFocus } from './shared.js';

/** One row: title on the left (with a tag under it if any), amount or spending limit on the right. */
const row = (attrs, title, tag, right, pressed, off) =>
  `<button class="case" ${attrs} aria-pressed="${pressed}" ${off ? 'disabled' : ''}>
    <span class="t">${esc(title)}${tag}</span><span class="r">${right}</span></button>`;

export function casesHtml(cur) {
  const list = S.showAll ? S.cases : S.cases.slice(0, 6);
  const cap = S.state.buyerLimits?.perCaseCapCents ?? S.state.policy.perCaseCapCents; // this buyer's instant-refund limit
  return (
    list
      .map((c) => {
        const total = c.cart.reduce((s, l) => s + l.unitCents * l.qty, 0);
        const tag = total > cap ? `<span class="tag sim">over ${usd(cap)}: checked first</span>` : '';
        return row(`data-case="${esc(c.id)}" title="${esc(c.instruction)}"`, c.title, tag, usd(total), cur.sc?.id === c.id, S.busy);
      })
      .join('') + (S.cases.length > 6 ? `<button class="more" data-toggle-all>${S.showAll ? 'Show fewer' : `Show all ${S.cases.length} cases`}</button>` : '')
  );
}

export function renderCases(cur) {
  swapKeepingFocus($('cases'), casesHtml(cur));
}

// ---- the live agent ----------------------------------------------------------------------------------------
export function liveHtml(cur) {
  if (!S.catalog) return '';
  const on = S.state.flags.liveAgent;
  return (
    S.catalog.prompts
      .map((p) => {
        const max = p.conditions.maxTotalCents;
        const right = max == null ? 'no spending limit' : `spending limit ${usd(max)}`;
        return row(`data-live-prompt="${esc(p.id)}" title="${esc(p.instruction)}"`, p.label, '', right, cur.mandate?.live?.promptId === p.id, S.busy || !on);
      })
      .join('') + (on ? '' : '<p class="sub off">The live agent is off: this server has no live AI connected. The prepared cases still run.</p>')
  );
}

export function renderLive(cur) {
  const el = $('live-prompts');
  swapKeepingFocus(el, liveHtml(cur));
  if (!S.catalog) return;
  document.querySelector('[data-act="liveOwn"]').disabled = S.busy || !S.state.flags.liveAgent;
  const list = $('catalog-list');
  if (!list.dataset.done) {
    const store = (id) => S.catalog.stores.find((s) => s.id === id);
    list.innerHTML = `<div class="catalog-scroll"><table class="catalog"><thead><tr><th>Store</th><th>Listing title</th><th>On the product page</th><th class="num">Price</th></tr></thead><tbody>${S.catalog.products
      .map((p) => `<tr><td>${esc(store(p.store).name)}${p.sponsored ? ' <span class="tag sim">sponsored</span>' : ''}</td><td>${esc(p.title)}</td><td>${esc(p.details)}</td><td class="num">${usd(p.priceCents)}</td></tr>`)
      .join('')}</tbody></table></div><p class="fine">${S.catalog.stores.map((s) => `${esc(s.name)}: ${esc(s.shippingNote)}`).join(' · ')}</p>`;
    list.dataset.done = '1';
  }
}
