// Demo UI. The page is a pure function of the workspace state the server returns; every button
// calls one desk action and re-renders. Nothing here decides anything about money.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (cents) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
const signed = (cents) => (cents === 0 ? '$0.00' : `${cents > 0 ? '+' : '-'}$${(Math.abs(cents) / 100).toFixed(2)}`);
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const day = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

let state = null;
let cases = [];
let busy = false;
let showAll = false;
let reconciliation = null;

const REASONS = {
  OVER_PER_CASE_CAP: 'the amount is over the instant-refund limit per case',
  OVER_30_DAY_COUNT: 'this buyer already used the instant refunds allowed in 30 days',
  NO_SAVED_WALLET_CONSENT: 'the buyer has no saved wallet with consent',
  RESERVE_TOO_LOW: "the desk's own funds could not cover the store",
  REFUND_CALL_FAILED: 'the refund call did not go through',
  BUYER_DISPUTED: 'the buyer disputed it',
  NO_ACTIVE_CONSENT: 'the buyer withdrew consent',
};
const FACT_LABELS = {
  purchaseAuthorized: 'The mandate allowed the agent to pay',
  itemMatchesMandate: 'The ordered item is what the buyer described',
  quantityMatchesMandate: 'The quantity matches',
  withinSpendingLimit: 'The total is within the spending limit',
  exclusionsRespected: 'Nothing the buyer ruled out is in the order',
  storeChargedAsOrdered: 'The store charged what the agent submitted',
  storeFulfilledAsOrdered: 'The store shipped what was ordered',
};
const RULES = {
  R0: 'The records could not be tied together, so nothing is held against the buyer.',
  R1: 'The store did not deliver or charge what was ordered.',
  R2: 'The order differs from what the buyer approved.',
  R3: 'The records leave a question open. An open question is never held against the buyer.',
  R4: 'The order matches every condition the buyer approved, and the store delivered and charged as ordered.',
};
const WHO = { STORE: 'The store', AGENT: "The agent's operator", BUYER: 'The buyer', UNDETERMINED: 'Nobody could be named: the desk absorbs it' };
const ACCOUNTS = { buyer: 'Buyer', 'desk:purchase': 'Desk · purchase money held', 'desk:reserve': 'Desk · own funds', store: 'Store', 'paypal:fees': 'PayPal fees' };
const KINDS = {
  PURCHASE_CAPTURED: 'Purchase captured',
  PAYPAL_FEE: 'PayPal fee',
  REFUND: 'Refund to buyer',
  STORE_PAID: 'Store paid',
  RECHARGE_CAPTURED: 'Buyer charged again',
  RESERVE_ALLOCATED: 'Own funds set aside',
  RESERVE_RELEASED: 'Set-aside released',
  RESERVE_CONSUMED: 'Set-aside used',
  AGENT_COMPANY_OWES: 'Agent operator owes the desk',
};

// ---- server ----------------------------------------------------------------------------------------
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.message || 'Request failed'), { code: json.error, status: res.status });
  return json;
}

async function act(name, body = {}, label = '') {
  if (busy) return null;
  busy = true;
  render(label);
  try {
    const result = await api(`/api/act/${name}`, { ws: state.workspace, ...body });
    state = result.state;
    return result;
  } catch (err) {
    toast(err.message);
    return null;
  } finally {
    busy = false;
    render();
  }
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 5000);
}

const RETURN_NOTES = {
  approved: 'Back from PayPal: the payment is captured.',
  cancelled: 'Back from PayPal: cancelled, nothing was charged.',
  failed: 'Back from PayPal, but the payment could not be completed.',
};

async function start(fresh = false) {
  cases = (await api('/api/cases')).cases;
  // Coming back from the PayPal approval screen: the workspace id rides on the return URL.
  const params = new URLSearchParams(location.search);
  if (params.has('ws')) {
    localStorage.setItem('rfd-workspace', params.get('ws'));
    if (RETURN_NOTES[params.get('paypal')]) setTimeout(() => toast(RETURN_NOTES[params.get('paypal')]), 300);
    history.replaceState(null, '', '/');
  }
  const saved = !fresh && localStorage.getItem('rfd-workspace');
  if (saved) {
    try {
      state = await api(`/api/state?ws=${saved}`);
    } catch {
      state = null;
    }
  }
  if (!state || fresh) state = await api('/api/workspaces', {});
  localStorage.setItem('rfd-workspace', state.workspace);
  reconciliation = null;
  render();
}

// ---- what is on screen now ---------------------------------------------------------------------------
function current() {
  const mandate = state.mandates.at(-1) || null;
  const order = mandate ? state.orders.find((o) => o.mandateId === mandate.id) || null : null;
  const kase = order ? state.cases.find((c) => c.orderId === order.id) || null : null;
  const sc = mandate ? cases.find((c) => c.id === mandate.caseId) || null : null;
  return { mandate, order, kase, sc };
}

function render(working = '') {
  if (!state) return;
  const cur = current();
  $('env-pill').textContent = `PayPal sandbox · ${state.flags.aiProvider === 'fixture' ? 'AI not connected (stand-in answers)' : `AI: ${state.flags.aiModel || state.flags.aiProvider}`}`;
  renderCases(cur);
  $('stage').hidden = !cur.mandate;
  if (!cur.mandate) return;
  $('buyer').innerHTML = buyerColumn(cur, working);
  $('desk').innerHTML = deskColumn(cur, working);
  $('money').innerHTML = moneyColumn(cur);
}

function renderCases(cur) {
  const list = showAll ? cases : cases.slice(0, 6);
  $('cases').innerHTML =
    list
      .map((c) => {
        const total = c.cart.reduce((s, l) => s + l.unitCents * l.qty, 0);
        return `<button class="case" data-case="${esc(c.id)}" aria-pressed="${cur.sc?.id === c.id}" ${busy ? 'disabled' : ''}>
          <span class="t">${esc(c.title)}</span>
          <span class="q">“${esc(c.instruction)}”</span>
          <span class="m"><span>${esc(c.store.name)}</span><span>${usd(total)}</span></span>
        </button>`;
      })
      .join('') + (cases.length > 6 ? `<button class="ghost more" data-toggle-all>${showAll ? 'Show fewer' : `Show all ${cases.length} cases`}</button>` : '');
}

// ---- buyer column ---------------------------------------------------------------------------------------
function buyerColumn({ mandate, order, kase, sc }, working) {
  const c = mandate.conditions;
  const spin = working ? `<span class="spinner"></span>` : '';
  let html = `<div class="card">
    <h3>What the buyer told the agent</h3>
    <p class="quote">“${esc(mandate.instruction)}”</p>
    <dl class="slots">
      <dt>Item</dt><dd>${esc(c.item || '(not specified)')}</dd>
      <dt>Quantity</dt><dd>${c.quantity ?? '(not specified)'}</dd>
      <dt>Spending limit</dt><dd>${c.maxTotalCents == null ? '(none)' : `${usd(c.maxTotalCents)} total`}</dd>
      <dt>Must not include</dt><dd>${c.exclusions.length ? esc(c.exclusions.join('; ')) : '(nothing listed)'}</dd>
      <dt>May pay without asking again</dt><dd class="flag">${c.purchaseAuthorized ? 'yes' : 'no'}</dd>
    </dl>
    ${
      mandate.status === 'DRAFT'
        ? `<div class="row"><button class="primary" data-act="approve" ${busy ? 'disabled' : ''}>${spin}Approve these conditions</button><span class="sub">The buyer approves once, before anything is bought.</span></div>`
        : `<p class="sub">Approved ${time(mandate.approval.at)} · kept as a record · fingerprint <code>${esc(mandate.fingerprint.slice(0, 12))}…</code> goes into the PayPal order</p>`
    }
  </div>`;

  if (mandate.status === 'APPROVED' && !order) {
    html += `<div class="card"><h3>The agent goes shopping</h3>
      <p class="sub" style="margin-bottom:10px">It pays from the PayPal wallet the buyer saved earlier. Nobody is asked again at checkout.</p>
      <button class="primary" data-act="purchase" ${busy ? 'disabled' : ''}>${spin}Let the agent shop and pay</button>
      <p class="sub" style="margin:14px 0 8px">Or see how the wallet gets saved in the first place: pay this order at PayPal yourself and agree to save the wallet for the agent. You need a PayPal sandbox personal account; sign in at <code>sandbox.paypal.com</code> first.</p>
      <button class="ghost" data-act="consentPurchase" ${busy ? 'disabled' : ''}>Pay at PayPal and save the wallet</button></div>`;
  }
  if (order && order.consentCancelled) {
    html += `<div class="card"><h3>Cancelled at PayPal</h3><p class="sub">The buyer turned back on the PayPal screen. Nothing was charged. Pick a case to start again.</p></div>`;
  } else if (order && !order.paypal) {
    html += `<div class="card"><h3>Waiting for the buyer at PayPal</h3>
      <p class="sub" style="margin-bottom:10px">PayPal shows the payment and the request to save the wallet for future agent purchases on one screen.</p>
      <div class="row">${order.approveUrl ? `<a class="primary" href="${esc(order.approveUrl)}">Continue at PayPal</a>` : ''}
      <button class="ghost" data-act="cancelConsent" ${busy ? 'disabled' : ''}>Cancel</button></div></div>`;
  } else if (order) {
    const atPayPal = order.payment === 'CONSENT_CHECKOUT';
    const saved = state.buyers[0]?.wallet?.source === 'OWN';
    html += `<div class="card"><h3>${atPayPal ? 'The buyer paid at PayPal' : 'The agent bought this'} at ${esc(order.store.name)}</h3>
      <ul class="items">${order.cart.map((l) => `<li><span>${l.qty} × ${esc(l.name)}</span><span class="mono">${usd(l.unitCents * l.qty)}</span></li>`).join('')}
      <li class="total"><span>${atPayPal ? (saved ? 'Paid at PayPal; wallet saved for the agent' : 'Paid at PayPal; the wallet was not saved') : 'Paid from the saved PayPal wallet'}</span><span class="mono">${usd(order.totalCents)}</span></li></ul>
      <p class="sub">PayPal order <code>${esc(order.paypal.orderId)}</code></p></div>`;
  }
  if (order?.paypal && !kase) {
    html += `<div class="card"><h3>Something is wrong? Say it in one sentence.</h3>
      <textarea id="statement" aria-label="What went wrong">${esc(sc?.complaint || '')}</textarea>
      <div class="row"><button class="primary" data-act="report" ${busy ? 'disabled' : ''}>${spin}Report it</button><span class="sub">This is the only thing the buyer has to do.</span></div></div>`;
  }
  if (kase) {
    html += `<div class="card"><h3>The buyer's report</h3><p class="quote">“${esc(kase.statement)}”</p></div>`;
    if (kase.refund?.completedAt) {
      const first = kase.path === 'REFUND_FIRST';
      html += `<div class="stamp go"><div class="big">${first ? 'Refunded first' : 'Refunded'} · ${usd(kase.refund.amountCents)}</div>
        <p>PayPal refund <code>${esc(kase.refund.id)}</code> COMPLETED ${first ? `<strong>${kase.refund.secondsFromReport} s</strong> after the report. Nothing had been checked yet.` : 'after the check.'}</p></div>`;
    } else if (kase.path === 'VERIFY_FIRST' && !kase.verdict) {
      html += `<div class="stamp wait"><div class="big">Checked first this time</div><p>Because ${esc(kase.limitCheck.reasons.map((r) => REASONS[r] || r).join('; '))}. This is the stated exception to refund-first.</p></div>`;
    }
    if (kase.verdict) html += buyerOutcome(kase);
  }
  return html;
}

function buyerOutcome(kase) {
  const liable = kase.verdict.liable;
  if (liable !== 'BUYER') {
    const line = { AGENT: 'The agent went beyond what you approved.', STORE: 'The store did not deliver what was ordered.', UNDETERMINED: 'The records could not settle it.' }[liable];
    return `<div class="stamp info"><div class="big">You keep the refund</div><p>${line} Nothing more to do, and you will not be charged again.</p></div>`;
  }
  if (!kase.refund?.completedAt) {
    return `<div class="stamp wait"><div class="big">No refund</div><p>The order matches what you approved. Because the check came first, nothing was refunded and nothing is charged again.</p></div>`;
  }
  const r = kase.recharge || {};
  if (r.status === 'SCHEDULED') {
    return `<div class="stamp wait"><div class="big">Notice: we plan to charge ${usd(kase.notice.amountCents)} again</div>
      <p>${esc(kase.notice.text)}</p><p>Not before <strong>${day(kase.notice.chargeNotBefore)}</strong>. Never more than the amount fixed when you bought.</p>
      <div class="row" style="margin-top:10px">
        <button class="danger" data-act="dispute" ${busy ? 'disabled' : ''}>Dispute this charge</button>
        <button class="ghost" data-act="fastForward" ${busy ? 'disabled' : ''}>Fast-forward the notice period <span class="tag sim">simulated</span></button>
      </div></div>`;
  }
  if (r.status === 'COMPLETED') {
    return `<div class="stamp info"><div class="big">Charged again · ${usd(r.amountCents)}</div><p>After the notice period, from the saved wallet, with no dispute on file. PayPal capture <code>${esc(r.captureId)}</code>.</p></div>`;
  }
  if (r.status === 'HALTED') {
    return `<div class="stamp go"><div class="big">The charge is stopped</div><p>Because ${esc(REASONS[r.blockedBy] || r.blockedBy)}. You keep the refund; the store is still paid, from the desk's own funds.</p></div>`;
  }
  return '';
}

// ---- desk column ----------------------------------------------------------------------------------------
function deskColumn({ order, kase }, working) {
  if (!order) return `<div class="card"><p class="sub">Nothing has happened yet. The desk only acts when the buyer reports a problem.</p></div>`;
  if (!order.paypal) return `<div class="card"><p class="sub">${order.consentCancelled ? 'Nothing was charged.' : 'Nothing has been charged yet. The payment and the saved-wallet consent are waiting at PayPal.'}</p></div>`;
  if (!kase) return `<div class="card"><h3>Waiting</h3><p class="sub">The desk received the payment for this order and holds it for the store until the hold window ends (${state.policy.storeHoldDays} days, simulated). The protection for this purchase was fixed at the moment of purchase: ${order.protection.refundFirst ? `refund first, and the buyer can never be charged again for more than ${usd(order.protection.buyerLiabilityCapCents)}` : `check first (${esc(order.protection.reasons.map((r) => REASONS[r] || r).join('; '))})`}.</p></div>`;

  const t0 = kase.receivedAtMs;
  const rel = (ms) => `+${((ms - t0) / 1000).toFixed(2)} s`;
  const steps = [`<li class="done"><span class="when">0.00 s</span><div class="what">Report received</div><div class="detail">${kase.path === 'REFUND_FIRST' ? 'Within the limits: refund first, ask nothing.' : `Check first: ${esc(kase.limitCheck.reasons.map((r) => REASONS[r] || r).join('; '))}.`}</div></li>`];
  const refundStep = kase.refund?.completedAt ? `<li class="money"><span class="when">${kase.path === 'REFUND_FIRST' ? `+${kase.refund.secondsFromReport.toFixed(2)} s` : rel(kase.refund.completedAtMs)}</span><div class="what">PayPal refund COMPLETED</div><div class="detail">${usd(kase.refund.amountCents)} back to the buyer${kase.path === 'REFUND_FIRST' ? ', before any check' : ''}.</div></li>` : '';
  const inv = kase.investigation;
  const invStep = inv ? `<li class="done"><span class="when">${rel(inv.startedAtMs)}</span><div class="what">Check of the records started</div><div class="detail">Mandate, agent log, PayPal order read back from PayPal, store record.</div></li>` : '';
  if (kase.path === 'REFUND_FIRST') steps.push(refundStep, invStep);
  else steps.push(invStep, refundStep);
  if (kase.verdict) steps.push(`<li class="done"><div class="what">Responsible: ${esc(WHO[kase.verdict.liable])}</div><div class="detail">Rule ${kase.verdict.rule}. ${esc(RULES[kase.verdict.rule])}</div></li>`);
  for (const e of kase.events) {
    if (e.type === 'NOTICE_SENT') steps.push(`<li class="done"><div class="what">Notice sent to the buyer</div><div class="detail">No charge before ${day(e.chargeNotBefore)} (${state.policy.noticeBusinessDays} business days).</div></li>`);
    if (e.type === 'DISPUTE_FILED') steps.push(`<li class="halt"><div class="what">The buyer disputed</div><div class="detail">The re-charge is stopped for good.</div></li>`);
    if (e.type === 'RECHARGE_HALTED' && e.reason !== 'BUYER_DISPUTED') steps.push(`<li class="halt"><div class="what">Re-charge stopped</div><div class="detail">${esc(REASONS[e.reason] || e.reason)}</div></li>`);
    if (e.type === 'RECHARGE_COMPLETED') steps.push(`<li class="money"><div class="what">Saved wallet charged again</div><div class="detail">${usd(e.amountCents)}, buyer not present, capture ${esc(e.captureId)}.</div></li>`);
    if (e.type === 'STORE_PAID') steps.push(`<li class="money"><div class="what">Store paid from ${e.source === 'desk:reserve' ? "the desk's own funds" : 'the purchase money'}</div><div class="detail">PayPal payout item: ${esc(e.payoutItemStatus)}.</div></li>`);
  }
  if (order.storePayable.status === 'PAID' && order.storePayable.simulated) steps.push(`<li class="done"><div class="what">Store paid from ${order.storePayable.source === 'desk:reserve' ? "the desk's own funds" : 'the purchase money'} <span class="tag sim">ledger only</span></div><div class="detail">No store PayPal account is configured, so this payment is recorded but not sent.</div></li>`);
  if (order.storePayable.status === 'CANCELLED') steps.push(`<li class="halt"><div class="what">Store is not paid for this order</div><div class="detail">The amount set aside for it is released.</div></li>`);
  if (kase.status === 'OPEN' && !kase.verdict) steps.push(`<li><div class="what">${working ? '<span class="spinner"></span>' : ''}Checking the records…</div></li>`);

  let html = `<div class="card"><h3>In this order</h3><ol class="steps">${steps.join('')}</ol></div>`;
  if (inv?.facts) {
    const byAi = inv.ai.provider === 'fixture' ? 'hand-written stand-in answers (AI not connected in this build)' : `${esc(inv.ai.model || inv.ai.provider)}${inv.ai.provider === 'recorded' ? ' (recorded answer replayed)' : ''}`;
    html += `<div class="card"><h3>Fact table</h3>
      <p class="sub" style="margin-bottom:8px">Filled by: ${byAi}. Each answer must quote a record; a quote that is not in the record is thrown out. Responsibility is then decided by fixed rules in code.</p>
      <table><thead><tr><th>Question</th><th>Answer</th><th>From the record</th></tr></thead><tbody>
      ${Object.entries(inv.facts)
        .map(([key, f]) => {
          const ev = f.evidence[0];
          const src = ev ? `${esc(inv.evidence[ev.doc]?.title || ev.doc)}: <q>${esc(ev.quote)}</q>${ev.computed ? ' <span class="tag">computed by code</span>' : ''}` : inv.downgraded.includes(key) ? '<span class="tag sim">quote not found in the record: discarded</span>' : 'the records do not settle this';
          return `<tr><td>${esc(FACT_LABELS[key])}</td><td class="${f.value}">${f.value}</td><td class="src">${src}</td></tr>`;
        })
        .join('')}
      </tbody></table>
      <details class="records"><summary>Open the records that were compared</summary>
      ${Object.values(inv.evidence).map((d) => `<h4>${esc(d.title)}</h4><pre>${esc(d.text)}</pre>`).join('')}
      </details></div>`;
  }
  return html;
}

// ---- money column ---------------------------------------------------------------------------------------
function moneyColumn({ order }) {
  if (!order) return `<div class="card"><p class="sub">No money has moved.</p></div>`;
  const lines = state.ledger.filter((l) => l.orderId === order.id);
  const net = {};
  for (const l of lines) {
    if (l.memo) continue;
    net[l.to] = (net[l.to] || 0) + l.cents;
    net[l.from] = (net[l.from] || 0) - l.cents;
  }
  let html = `<div class="card"><h3>This order, party by party</h3>
    <table><thead><tr><th>Party</th><th class="num">Net</th></tr></thead><tbody>
    ${Object.keys(ACCOUNTS).map((a) => `<tr><td>${ACCOUNTS[a]}</td><td class="num ${net[a] > 0 ? 'pos' : net[a] < 0 ? 'neg' : ''}">${signed(net[a] || 0)}</td></tr>`).join('')}
    </tbody></table>
    <p class="sub" style="margin-top:8px">Desk's own funds: ${usd(state.funds.reserveBalanceCents)} of ${usd(state.funds.reserveStartCents)} left, ${usd(state.funds.reserveAllocatedCents)} set aside for open cases.</p>
    <div class="row" style="margin-top:10px"><button class="ghost" data-act="reconcile" ${busy ? 'disabled' : ''}>Check the ledger against PayPal</button></div>
    ${reconciliation && reconciliation.orderId === order.id ? reconciliationTable(reconciliation) : ''}
  </div>`;
  html += `<div class="card"><h3>Ledger</h3><table><thead><tr><th>What</th><th>From → to</th><th class="num">Amount</th></tr></thead><tbody>
    ${lines
      .map((l) =>
        l.memo
          ? `<tr><td>${esc(KINDS[l.kind] || l.kind)} <span class="tag">memo</span></td><td class="src">${esc(l.note)}</td><td class="num">${usd(l.cents)}</td></tr>`
          : `<tr><td>${esc(KINDS[l.kind] || l.kind)}<div class="src">${l.simulated ? '<span class="tag sim">ledger only</span>' : `<span class="tag real">PayPal</span> <code>${esc(l.paypal?.id || '')}</code>`}</div></td><td class="src">${esc(ACCOUNTS[l.from] || l.from)} → ${esc(ACCOUNTS[l.to] || l.to)}</td><td class="num">${usd(l.cents)}</td></tr>`,
      )
      .join('')}
    </tbody></table></div>`;
  const calls = state.paypalCalls.slice(-14);
  html += `<div class="card"><details><summary>PayPal API calls made by the desk (latest ${calls.length})</summary>
    <table><thead><tr><th>Call</th><th>HTTP</th><th class="num">ms</th></tr></thead><tbody>
    ${calls.map((c) => `<tr><td><code>${esc(c.method)} ${esc(c.path.replace(/[A-Z0-9-]{12,}/g, '…'))}</code><div class="src">${esc(c.label)}</div></td><td>${c.status}</td><td class="num">${c.ms}</td></tr>`).join('')}
    </tbody></table></details></div>`;
  return html;
}

function reconciliationTable(r) {
  return `<table style="margin-top:10px"><thead><tr><th>Party</th><th class="num">Ledger</th><th class="num">PayPal</th><th></th></tr></thead><tbody>
    ${r.rows.map((row) => `<tr><td>${ACCOUNTS[row.party]}</td><td class="num">${signed(row.ledgerCents)}</td><td class="num">${signed(row.paypalCents)}</td><td class="${row.match ? 'yes' : 'no'}">${row.match ? 'match' : 'differs'}</td></tr>`).join('')}
    </tbody></table>
    <p class="sub">Looked up just now: ${r.lookups.map((l) => `${l.type.replace('_', ' ')} ${esc(l.status)}`).join(', ')}.${r.simulatedStoreCents ? ` ${usd(r.simulatedStoreCents)} to the store is ledger only and is not part of this comparison.` : ''}</p>`;
}

// ---- events -----------------------------------------------------------------------------------------------
document.addEventListener('click', async (event) => {
  const caseButton = event.target.closest('[data-case]');
  if (caseButton) {
    reconciliation = null;
    await act('mandate', { caseId: caseButton.dataset.case });
    $('stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (event.target.closest('[data-toggle-all]')) {
    showAll = !showAll;
    render();
    return;
  }
  const button = event.target.closest('[data-act]');
  if (!button) return;
  const { mandate, order, kase } = current();
  const name = button.dataset.act;
  if (name === 'approve') await act('approve', { mandateId: mandate.id }, 'approve');
  if (name === 'purchase') await act('purchase', { mandateId: mandate.id }, 'purchase');
  if (name === 'consentPurchase') {
    const started = await act('consentPurchase', { mandateId: mandate.id }, 'consentPurchase');
    if (started?.approveUrl) window.location.href = started.approveUrl;
  }
  if (name === 'cancelConsent') await act('cancelConsent', { orderId: order.id });
  if (name === 'report') {
    const statement = $('statement').value;
    const reported = await act('report', { orderId: order.id, statement }, 'report');
    if (reported) {
      // Let the refund be seen on its own before the check starts drawing attention.
      await new Promise((r) => setTimeout(r, 1400));
      await act('investigate', { caseId: reported.caseId }, 'investigate');
    }
  }
  if (name === 'dispute') await act('dispute', { caseId: kase.id, text: 'I do not agree that this was my mistake.' });
  if (name === 'fastForward') await act('fastForward', { days: 8 });
  if (name === 'reconcile') {
    const result = await act('reconcile', { orderId: order.id });
    if (result) {
      reconciliation = result.reconciliation;
      render();
    }
  }
});
$('reset').addEventListener('click', () => start(true));

start().catch((err) => toast(`Could not start: ${err.message}`));
