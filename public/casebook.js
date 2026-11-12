// The case book on screen: finished cases grouped by agent and by store, for whoever fixes the agent, and
// the instant-refund limit the buyer's own record gives the next purchase. Counts are drawn as bar lengths.
import { swapKeepingFocus } from './shared.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (cents) => `$${((cents || 0) / 100).toFixed(2).replace(/\.00$/, '')}`;

const CONDITION = {
  purchaseAuthorized: 'Paid without permission',
  itemMatchesMandate: 'Wrong item',
  quantityMatchesMandate: 'Wrong quantity',
  withinSpendingLimit: 'Over the spending limit',
  exclusionsRespected: 'Included something ruled out',
  storeChargedAsOrdered: 'Charged other than the order',
  storeFulfilledAsOrdered: 'Shipped other than the order',
  unnamed: 'Condition not named',
};
// Who was finally found responsible. The same order everywhere: bars, legend, totals.
const OUTCOME = [
  ['AGENT', "agent's fault"],
  ['STORE', "store's fault"],
  ['BUYER', "buyer's own choice"],
  ['UNDETERMINED', 'could not be settled'],
  ['HUMAN_REVIEW', 'a person decides'],
  ['OPEN', 'not finished'],
];
const outcomeName = (k) => OUTCOME.find(([o]) => o === k)?.[1] || k;
const caseName = (x) => x.scenarioId || x.caseId;

let data = null;
let view = null; // 'workspace' | 'measured'
let picked = false; // once the viewer picks a tab, it stays; until then the workspace shows as soon as it has a case
let signature = '';
let drawn = '';
let last = { state: null, cases: [] }; // the state the book in `data` was read for: both sides are drawn from this pair

/** Called on every render of the page; asks the server again only when a case changed. */
export function refreshCaseBook(state, cases) {
  if (!state) return;
  const sig = `${state.workspace}|${state.cases.map((c) => `${c.id}:${c.status}:${c.verdict?.liable || ''}:${c.recharge?.status || ''}`).join(',')}`; // a verdict or a re-charge changes the book too
  if (sig === signature) {
    last = { state, cases };
    return draw();
  }
  if (sig === refreshCaseBook.asking) return draw();
  refreshCaseBook.asking = sig;
  draw(); // shows Updating over the book still on screen
  fetch(`/api/casebook?ws=${encodeURIComponent(state.workspace)}`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((json) => {
      if (!json || refreshCaseBook.asking !== sig) return; // a newer read was asked meanwhile: this older answer is dropped
      data = json;
      signature = sig; // kept only once the answer arrived: a failed read is asked again on the next render
      last = { state, cases };
      refreshCaseBook.asking = null;
      draw();
    })
    .catch(() => {})
    .finally(() => {
      if (refreshCaseBook.asking !== sig) return;
      refreshCaseBook.asking = null; // a failed read: the earlier book stays, without Updating, and is asked again on the next render
      draw();
    });
}

/** Length = count against the longest row; colour = who was finally found responsible. */
function bar(byOutcome, count, max) {
  const segs = OUTCOME.filter(([k]) => byOutcome[k])
    .map(([k, name]) => `<span class="seg o-${k}" style="flex:${byOutcome[k]}" title="${byOutcome[k]} ${esc(name)}"></span>`)
    .join('');
  return `<span class="cb-track"><span class="cb-bar" style="width:${Math.max(3, (count / max) * 100)}%">${segs}</span></span>`;
}

/** The bar's colours in words, next to it: "1 agent's fault · 1 store's fault". */
const who = (byOutcome) => `<span class="cb-o">${OUTCOME.filter(([k]) => byOutcome[k]).map(([k, name]) => `${byOutcome[k]} ${esc(name)}`).join(' · ')}</span>`;

/** One row per condition. Opening a row shows the line in the log where the agent first left the mandate. */
function rows(group, max, actorWord) {
  if (!group.conditions.length) return `<p class="sub">No first deviation at the ${actorWord}'s own steps.</p>`;
  return `<ol class="cb-rows">${group.conditions
    .map((c, i) => {
      const ex = c.example;
      return `<li><details class="cb-cond"${i === 0 ? ' open' : ''}>
        <summary><span class="cb-k">${esc(CONDITION[c.condition] || c.condition)}${who(c.byOutcome)}</span>${bar(c.byOutcome, c.count, max)}<span class="cb-n num">${c.count}</span></summary>
        <p class="cb-quote"><span class="cb-at">${esc(caseName(ex))} step ${ex.step}</span> “${esc(ex.quote)}”${ex.verified ? '' : ' <span class="tag sim">quote not verified</span>'}</p>
        ${c.cases.length > 1 ? `<p class="sub">All ${c.cases.length}: ${c.cases.map((x) => `${esc(caseName(x))} (${esc(outcomeName(x.outcome))})`).join(', ')}</p>` : ''}
      </details></li>`;
    })
    .join('')}</ol>`;
}

/** All cases as one strip, split by who was found responsible, with the counts. */
function strip(book) {
  const total = book.cases || 1;
  const shown = OUTCOME.filter(([k]) => book.outcomes[k]);
  const segs = shown.map(([k, name]) => `<span class="seg o-${k}" style="flex:${book.outcomes[k]}" title="${book.outcomes[k]} ${esc(name)}">${book.outcomes[k] / total >= 0.08 ? book.outcomes[k] : ''}</span>`).join('');
  const legend = shown.map(([k, name]) => `<li><span class="sw o-${k}"></span>${esc(name)} <b class="num">${book.outcomes[k]}</b></li>`).join('');
  return `<div class="cb-strip" aria-hidden="true">${segs}</div><ul class="cb-legend">${legend}</ul>`;
}

function agentCards(book, max) {
  return book.agents
    .map((a) => `<article class="card cb-agent"><h3>${esc(a.name)}</h3>
      <p class="sub"><b class="num">${a.cases}</b> case${a.cases === 1 ? '' : 's'} · left the mandate at its own step in <b class="num">${a.deviations}</b> · responsible in <b class="num">${a.outcomes.AGENT}</b></p>
      ${rows(a, max, 'agent')}</article>`)
    .join('');
}

function storesPanel(book, max) {
  const found = book.stores.filter((s) => s.outcomes.STORE || s.deviations || s.outcomes.HUMAN_REVIEW);
  const rest = book.stores.length - found.length;
  const list = found
    .map((s) => {
      const n = s.outcomes.STORE + s.outcomes.HUMAN_REVIEW;
      const fd = s.conditions[0]?.example;
      const head = [s.outcomes.STORE ? `${s.outcomes.STORE} store's fault` : '', s.outcomes.HUMAN_REVIEW ? `${s.outcomes.HUMAN_REVIEW} waiting for a person` : ''].filter(Boolean).join(' · ');
      return `<li><details class="cb-cond"><summary><span class="cb-k">${esc(s.name)}${who({ STORE: s.outcomes.STORE, HUMAN_REVIEW: s.outcomes.HUMAN_REVIEW })}</span>${bar({ STORE: s.outcomes.STORE, HUMAN_REVIEW: s.outcomes.HUMAN_REVIEW }, n || 0.0001, max)}<span class="cb-n num">${n}</span></summary>
        <p class="sub">${esc(head || 'no verdict against the store')}${fd ? '' : s.outcomes.STORE ? '; the first step off the mandate was not the store\'s own' : ''}</p>
        ${fd ? `<p class="cb-quote"><span class="cb-at">${esc(caseName(fd))} step ${fd.step}</span> ${esc(CONDITION[s.conditions[0].condition])}: “${esc(fd.quote)}”</p>` : ''}</details></li>`;
    })
    .join('');
  return `<article class="card cb-stores"><h3>Stores</h3>
    ${found.length ? `<ol class="cb-rows">${list}</ol>` : '<p class="sub">No store-side finding yet.</p>'}
    ${rest > 0 ? `<p class="sub">${rest} other store${rest === 1 ? '' : 's'}: no finding.${book.stores.length >= 20 ? ' Each prepared case uses its own store.' : ''}</p>` : ''}</article>`;
}

/** The next purchase's instant-refund limit as one big number, and where it sits on $0 to $100 against the start. */
function limitPanel(state, cases) {
  const l = state.buyerLimits;
  if (!l) return '';
  const start = l.start.perCaseCapCents;
  const now = l.perCaseCapCents;
  const dir = now > start ? 'up' : now < start ? 'dn' : '';
  const max = Math.max(10000, start * 2, now);
  const pos = (c) => `${(c / max) * 100}%`;
  const scenarioOf = (orderId) => state.orders.find((x) => x.id === orderId)?.scenarioId || null;
  const titleOf = (orderId) => cases.find((c) => c.id === scenarioOf(orderId))?.title || '';
  const basis = l.basis
    .map((b) => `<li class="${b.effect === 'DOWN' ? 'dn' : 'up'}"><b class="num">${b.effect === 'DOWN' ? '−' : '+'}${usd(Math.abs(b.cents))}, ${b.refunds > 0 ? '+1' : '−1'} refund</b> · ${esc(scenarioOf(b.orderId) || b.caseId)}${titleOf(b.orderId) ? ` “${esc(titleOf(b.orderId))}”` : ''}: ${b.effect === 'DOWN' ? 'this buyer was found responsible' : `the ${b.liable === 'AGENT' ? "agent's" : "store's"} fault`}${b.decidedBy === 'PERSON' ? ' (a person chose)' : ''}</li>`)
    .join('');
  const p = state.policy || {};
  return `<article class="card cb-limit">
    <p class="cb-msg"><span class="tag sim">assumption, not measured</span> Instant-refund limit for the next purchase</p>
    <p class="cb-giant ${dir}">${usd(now)}<small> a case</small></p>
    <p class="cb-msg"><b class="num">${l.refundsPer30Days}</b> instant refund${l.refundsPer30Days === 1 ? '' : 's'} per 30 days${now === 0 || l.refundsPer30Days === 0 ? ': every purchase is checked first' : ''}</p>
    <div class="cb-scale" role="img" aria-label="Instant-refund limit ${usd(now)} a case, started at ${usd(start)}, on a ${usd(0)} to ${usd(max)} scale">
      <span class="rail"></span>${dir ? `<span class="moved ${dir}" style="left:${pos(Math.min(start, now))};width:${pos(Math.abs(now - start))}"></span>` : ''}
      <span class="mark" style="left:${pos(start)}">start ${usd(start)}</span><span class="dot ${dir}" style="left:${pos(now)}"></span>
      <span class="end">${usd(0)}</span><span class="end r">${usd(max)}</span></div>
    <h4>What moved it</h4>
    ${basis ? `<ul class="cb-basis">${basis}</ul>` : `<p class="sub">No earlier case of this buyer is decided yet, so the starting limit applies.</p>`}
    <p class="fine">Only this buyer's own decided cases from the last ${l.windowDays} days move it, ${usd(p.trustStepCents)} and one refund per case. Up: the agent's or store's fault (${p.trustMaxUp ?? 2} cases at most). Down: this buyer was responsible and charged again with no dispute. Fixed on the order at purchase. Agents' and stores' records never move it. <strong>The numbers are assumptions, not measured.</strong></p></article>`;
}

function draw() {
  const el = $('casebook');
  if (!el || !data || !last.state) return;
  const ws = data.workspace;
  if (!picked) view = ws?.cases ? 'workspace' : 'measured';
  const measured = view === 'measured';
  const book = measured ? data.measured.book : ws;
  const src = data.measured.source;
  const empty = !book?.cases;
  const max = empty ? 1 : Math.max(1, ...book.agents.flatMap((a) => a.conditions.map((c) => c.count)), ...book.stores.map((s) => s.outcomes.STORE + s.outcomes.HUMAN_REVIEW));
  const rightLabel = `<p class="cb-label">Which condition the agent broke, how often</p>`;
  let body;
  if (measured) {
    const left = book.agents.reduce((s, a) => s + a.deviations, 0);
    body = `<div class="cb-grid">
      <section class="cb-col"><p class="cb-label">${book.cases} cases, by who was found responsible</p>
        <div class="card cb-hero"><p class="cb-giant">${left}<small> of ${book.cases}</small></p>
          <p class="cb-msg">cases where the agent first left the mandate at its own step.</p>${strip(book)}</div>
        <p class="cb-src"><span class="tag sim">written by us</span> One measured run of the 30 prepared cases (run 3 in the README; its table shows run 4): ${esc(src.environment)}, ${src.aiProvider === 'anthropic' ? 'live Claude calls' : esc(src.aiProvider)}, ${esc(new Date(src.ranAt).toISOString().slice(0, 10))}${src.engine ? `, desk ${esc(src.engine)}` : ''}. The cases, the agent logs and the answer key are written by us; the verdicts and quotes are what that run produced. Each case had its own buyer, so no limit moved in it.</p></section>
      <section class="cb-col cb-right">${rightLabel}${agentCards(book, max)}${storesPanel(book, max)}</section></div>`;
  } else if (empty) {
    body = `<div class="cb-grid">
      <section class="cb-col"><p class="cb-label">Next purchase for this buyer</p>${limitPanel(last.state, last.cases)}</section>
      <section class="cb-col cb-right">${rightLabel}<p class="card sub">No case in this workspace yet. Run a case above, or open <button class="linkish" data-cb="measured">the 30 measured cases</button>.</p></section></div>`;
  } else {
    body = `<div class="cb-grid">
      <section class="cb-col"><p class="cb-label">Next purchase for this buyer</p>${limitPanel(last.state, last.cases)}</section>
      <section class="cb-col cb-right">${rightLabel}${agentCards(book, max)}
        <div class="card cb-total"><p class="sub">${book.cases} case${book.cases === 1 ? '' : 's'}, by who was found responsible</p>${strip(book)}</div>
        ${storesPanel(book, max)}</section></div>`;
  }
  const updating = refreshCaseBook.asking ? '<p class="cb-updating" role="status">Updating with the latest case…</p>' : '';
  const html = `<div class="cb-head">
      <div><h2 id="cb-h">Case book: what to fix in the agent</h2>
      <p class="hint">For the agent's operator. Bar length = cases, colour = who was found responsible.</p></div>
      <div class="cb-tabs" role="group" aria-label="Which cases">
        <button class="ghost" data-cb="workspace" aria-pressed="${!measured}">This workspace · ${ws?.cases ?? 0}</button>
        <button class="ghost" data-cb="measured" aria-pressed="${measured}">30 measured cases</button>
      </div></div>${updating}${body}`;
  // The page redraws often (every state read while an action runs); an unchanged book is left alone so an opened quote stays open.
  if (html === drawn) return;
  drawn = html;
  swapKeepingFocus(el, html);
}

/** The limit fixed on one order at purchase, and what moved it. Shown under the purchase. */
export function limitCard(order, state) {
  const p = order?.protection;
  if (!p?.limits) return '';
  const l = p.limits;
  const nameOf = (b) => state.orders.find((o) => o.id === b.orderId)?.scenarioId || b.caseId;
  const moved = l.basis.length
    ? `Start ${usd(l.start.perCaseCapCents)}, ${l.start.refundsPer30Days}; ${l.basis.map((b) => `${b.effect === 'DOWN' ? '−' : '+'}${usd(Math.abs(b.cents))} from ${esc(nameOf(b))} (${b.effect === 'DOWN' ? 'buyer responsible' : `${b.liable === 'AGENT' ? "agent's" : "store's"} fault`})`).join(', ')}.`
    : 'No earlier case of this buyer moved it.';
  return `<p class="sub cb-fixed">Instant-refund limit fixed on this order: <b>${usd(p.perCaseCapCents)}</b> a case, <b>${p.refundsPer30Days}</b> per 30 days. ${moved}</p>`;
}

document.addEventListener('click', (event) => {
  const b = event.target.closest('[data-cb]');
  if (!b) return;
  view = b.dataset.cb;
  picked = true;
  draw();
});
