// The case book on screen: finished cases grouped by agent and by store, for whoever fixes the agent, and
// the instant-refund limit the buyer's own record gives the next purchase. Counts are drawn as bar lengths.
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

let data = null;
let view = null; // 'workspace' | 'measured'
let picked = false; // once the viewer picks a tab, it stays; until then the workspace shows as soon as it has a case
let signature = '';
let drawn = '';
let last = { state: null, cases: [] };

/** Called on every render of the page; asks the server again only when a case changed. */
export function refreshCaseBook(state, cases) {
  if (!state) return;
  last = { state, cases };
  const sig = `${state.workspace}|${state.cases.map((c) => `${c.id}:${c.status}`).join(',')}`;
  if (sig === signature || sig === refreshCaseBook.asking) return draw();
  refreshCaseBook.asking = sig;
  fetch(`/api/casebook?ws=${encodeURIComponent(state.workspace)}`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((json) => {
      if (!json) return;
      data = json;
      signature = sig; // kept only once the answer arrived: a failed read is asked again on the next render
      draw();
    })
    .catch(() => {})
    .finally(() => {
      if (refreshCaseBook.asking === sig) refreshCaseBook.asking = null;
    });
}

function bar(byOutcome, count, max) {
  const segs = OUTCOME.filter(([k]) => byOutcome[k])
    .map(([k, name]) => `<span class="seg o-${k}" style="flex:${byOutcome[k]}" title="${byOutcome[k]} ${esc(name)}"></span>`)
    .join('');
  return `<span class="cb-bar" style="width:${Math.max(4, (count / max) * 100)}%">${segs}</span>`;
}

function rows(group, max, actorWord) {
  if (!group.conditions.length) return `<p class="sub">No first deviation at the ${actorWord}'s own steps.</p>`;
  return `<ol class="cb-rows">${group.conditions
    .map((c) => {
      const ex = c.example;
      const ids = c.cases.map((x) => x.scenarioId || x.caseId);
      return `<li>
        <div class="cb-row"><span class="cb-k">${esc(CONDITION[c.condition] || c.condition)}</span><span class="cb-track">${bar(c.byOutcome, c.count, max)}</span><span class="cb-n num">${c.count}</span></div>
        <details class="cb-ex"><summary><span class="cb-at">${esc(ex.scenarioId || ex.caseId)} step ${ex.step}</span> “${esc(ex.quote)}”${ex.verified ? '' : ' <span class="tag sim">quote not verified</span>'}</summary>
          <p class="sub">${ids.length > 1 ? `All ${ids.length}: ` : ''}${c.cases.map((x) => `${esc(x.scenarioId || x.caseId)} (${esc(OUTCOME.find(([k]) => k === x.outcome)?.[1] || x.outcome)})`).join(', ')}</p></details>
      </li>`;
    })
    .join('')}</ol>`;
}

function outcomesStrip(book) {
  const total = book.cases || 1;
  const segs = OUTCOME.filter(([k]) => book.outcomes[k]).map(([k]) => `<span class="seg o-${k}" style="flex:${book.outcomes[k]}"></span>`).join('');
  const legend = OUTCOME.filter(([k]) => book.outcomes[k])
    .map(([k, name]) => `<li><span class="sw o-${k}"></span>${esc(name)} <b class="num">${book.outcomes[k]}</b></li>`)
    .join('');
  return `<div class="cb-total"><p class="cb-total-h"><b class="num">${book.cases}</b> finished or open case${book.cases === 1 ? '' : 's'}, by who was found responsible</p>
    <div class="cb-strip" aria-hidden="true" style="--n:${total}">${segs}</div><ul class="cb-legend">${legend}</ul></div>`;
}

function storesPanel(book, max) {
  const found = book.stores.filter((s) => s.outcomes.STORE || s.deviations || s.outcomes.HUMAN_REVIEW);
  const rest = book.stores.length - found.length;
  const list = found
    .map((s) => {
      const fd = s.conditions[0]?.example;
      const head = [s.outcomes.STORE ? `${s.outcomes.STORE} store's fault` : '', s.outcomes.HUMAN_REVIEW ? `${s.outcomes.HUMAN_REVIEW} waiting for a person` : ''].filter(Boolean).join(' · ');
      return `<li><div class="cb-row"><span class="cb-k">${esc(s.name)}</span><span class="cb-track">${bar({ STORE: s.outcomes.STORE, HUMAN_REVIEW: s.outcomes.HUMAN_REVIEW }, s.outcomes.STORE + s.outcomes.HUMAN_REVIEW || 0.0001, max)}</span><span class="cb-n num">${s.outcomes.STORE + s.outcomes.HUMAN_REVIEW}</span></div>
        <p class="sub">${esc(head || 'no verdict against the store')}${fd ? `; at its own step: ${esc(CONDITION[s.conditions[0].condition])}, ${esc(fd.scenarioId || fd.caseId)} step ${fd.step} “${esc(fd.quote)}”` : s.outcomes.STORE ? '; the first step off the mandate was not the store\'s own' : ''}</p></li>`;
    })
    .join('');
  return `<article class="card cb-stores"><h3>Stores</h3>
    ${found.length ? `<ol class="cb-rows">${list}</ol>` : '<p class="sub">No store-side finding yet.</p>'}
    ${rest > 0 ? `<p class="sub">${rest} other store${rest === 1 ? '' : 's'}: no store-side finding.${book.stores.length >= 20 ? ' The prepared cases use a different store each, so a store has one case here.' : ''}</p>` : ''}</article>`;
}

/** A number line from $0 to $100: where the next purchase's limit sits against the starting $50. */
function limitPanel(state, cases) {
  const l = state.buyerLimits;
  if (!l) return '';
  const max = Math.max(10000, l.start.perCaseCapCents * 2, l.perCaseCapCents);
  const pos = (c) => `${(c / max) * 100}%`;
  const scenarioOf = (orderId) => state.orders.find((x) => x.id === orderId)?.scenarioId || null;
  const titleOf = (orderId) => cases.find((c) => c.id === scenarioOf(orderId))?.title || '';
  const basis = l.basis
    .map((b) => `<li class="${b.effect === 'DOWN' ? 'dn' : 'up'}"><b class="num">${b.effect === 'DOWN' ? '−' : '+'}${usd(Math.abs(b.cents))}, ${b.refunds > 0 ? '+1' : '−1'} refund</b> ${esc(scenarioOf(b.orderId) || b.caseId)}${titleOf(b.orderId) ? ` “${esc(titleOf(b.orderId))}”` : ''}: ${b.effect === 'DOWN' ? 'this buyer was found responsible' : `the ${b.liable === 'AGENT' ? "agent's" : "store's"} fault`}${b.decidedBy === 'PERSON' ? ' (a person chose)' : ''}</li>`)
    .join('');
  const moved = l.perCaseCapCents !== l.start.perCaseCapCents || l.refundsPer30Days !== l.start.refundsPer30Days;
  return `<article class="card cb-limit"><h3>Next purchase for this buyer</h3>
    <p class="cb-limit-v"><b class="num">${usd(l.perCaseCapCents)}</b> a case, <b class="num">${l.refundsPer30Days}</b> instant refund${l.refundsPer30Days === 1 ? '' : 's'} per 30 days${l.perCaseCapCents === 0 || l.refundsPer30Days === 0 ? ': every purchase is checked first' : ''}</p>
    <div class="cb-line" aria-hidden="true"><span class="tick" style="left:${pos(l.start.perCaseCapCents)}"><i>start ${usd(l.start.perCaseCapCents)}</i></span><span class="dot ${moved ? (l.perCaseCapCents < l.start.perCaseCapCents ? 'dn' : 'up') : ''}" style="left:${pos(l.perCaseCapCents)}"></span><span class="end">${usd(0)}</span><span class="end r">${usd(max)}</span></div>
    ${basis ? `<ul class="cb-basis">${basis}</ul>` : `<p class="sub">No earlier case of this buyer has been decided, so the starting limits apply.</p>`}
    <p class="sub">Only this buyer's own decided cases from the last ${l.windowDays} days move it, ${usd(Math.abs(l.basis[0]?.cents || state.policy.trustStepCents || 0))} and one refund per case. Up: a case that was the agent's or store's fault (two at most). Down: a case where this buyer was found responsible and, with no dispute in the notice period, was charged again. Fixed on the order at purchase, with these reasons. Agents' and stores' records never move it. The numbers are assumptions, not measured.</p></article>`;
}

function draw() {
  const el = $('casebook');
  if (!el || !data || !last.state) return;
  const ws = data.workspace;
  if (!picked) view = ws?.cases ? 'workspace' : 'measured';
  const measured = view === 'measured';
  const book = measured ? data.measured.book : ws;
  const src = data.measured.source;
  const max = Math.max(1, ...book.agents.flatMap((a) => a.conditions.map((c) => c.count)), ...book.stores.map((s) => s.outcomes.STORE + s.outcomes.HUMAN_REVIEW));
  const agents = book.agents
    .map((a) => `<article class="card cb-agent"><h3>${esc(a.name)}</h3>
      <p class="sub"><b class="num">${a.cases}</b> case${a.cases === 1 ? '' : 's'} · first left the mandate at its own step in <b class="num">${a.deviations}</b> · found at fault in <b class="num">${a.outcomes.AGENT}</b></p>
      ${rows(a, max, 'agent')}</article>`)
    .join('');
  const empty = !book.cases;
  const html = `<div class="cb-head">
      <div><h2 id="cb-h">Case book: what to fix in the agent</h2>
      <p class="hint">For the agent's operator. Every case the desk finishes lands here: which condition the agent broke, how often, and the line in its own log where it first left the mandate. Bars are counts, coloured by who was found responsible.</p></div>
      <div class="cb-tabs" role="tablist">
        <button role="tab" class="ghost" data-cb="workspace" aria-selected="${!measured}">This workspace · ${ws?.cases ?? 0}</button>
        <button role="tab" class="ghost" data-cb="measured" aria-selected="${measured}">After our 30 measured cases</button>
      </div></div>
    ${measured ? `<p class="cb-src"><span class="tag sim">written by us</span> One measured run of the 30 prepared cases: ${esc(src.environment)}, ${src.aiProvider === 'anthropic' ? 'live Claude calls' : esc(src.aiProvider)}, ${esc(new Date(src.ranAt).toISOString().slice(0, 10))}${src.engine ? `, desk ${esc(src.engine)}` : ''}. The cases, the agent logs and the answer key are written by us; the verdicts and quotes are what that run produced. Each case had its own buyer, so no limit moved in it.</p>` : ''}
    ${empty ? `<p class="card sub">No case in this workspace yet. Run a case above, or open <button class="linkish" data-cb="measured">the 30 measured cases</button>.</p>` : `${outcomesStrip(book)}<div class="cb-grid"><div class="cb-main">${agents}</div><div class="cb-side">${measured ? '' : limitPanel(last.state, last.cases)}${storesPanel(book, max)}</div></div>`}
    ${empty ? `<div class="cb-grid"><div class="cb-main"></div><div class="cb-side">${limitPanel(last.state, last.cases)}</div></div>` : ''}
    <ul class="cb-legend cb-key">${OUTCOME.slice(0, 5).map(([k, name]) => `<li><span class="sw o-${k}"></span>${esc(name)}</li>`).join('')}</ul>`;
  // The page redraws often (every state read while an action runs); an unchanged book is left alone so an opened quote stays open.
  if (html === drawn) return;
  drawn = html;
  el.innerHTML = html;
}

/** The limit fixed on one order at purchase, and what moved it. Shown under the purchase. */
export function limitCard(order, state) {
  const p = order?.protection;
  if (!p?.limits) return '';
  const l = p.limits;
  const nameOf = (b) => state.orders.find((o) => o.id === b.orderId)?.scenarioId || b.caseId;
  const moved = l.basis.length ? l.basis.map((b) => `${b.effect === 'DOWN' ? '−' : '+'}${usd(Math.abs(b.cents))} from case ${esc(nameOf(b))} (${b.effect === 'DOWN' ? 'buyer found responsible' : `${b.liable === 'AGENT' ? "agent's" : "store's"} fault`})`).join('; ') : 'no earlier case of this buyer moved it';
  return `<p class="sub cb-fixed">Limit fixed at purchase: <b>${usd(p.perCaseCapCents)}</b> a case, <b>${p.refundsPer30Days}</b> per 30 days (start ${usd(l.start.perCaseCapCents)}, ${l.start.refundsPer30Days}; ${moved}).</p>`;
}

document.addEventListener('click', (event) => {
  const b = event.target.closest('[data-cb]');
  if (!b) return;
  view = b.dataset.cb;
  picked = true;
  draw();
});
