// Demo UI. The page is a pure function of the workspace state the server returns; every button
// calls one desk action and re-renders. Nothing here decides anything about money.
// Every time and duration on screen comes from the server's own timestamps. The page waits 1.4 s
// between the report and the check so the refund can be seen on its own; no duration shown
// includes that wait.
import { limitCard, refreshCaseBook } from './casebook.js';
import { aiKeySource, aiPillText, buyerKeysLine, deepAiSource, quickAiLine } from './ailabels.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (cents) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents || 0) / 100).toFixed(2)}`;
const signed = (cents) => (!cents ? '$0.00' : `${cents > 0 ? '+' : '-'}$${(Math.abs(cents) / 100).toFixed(2)}`);
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const day = (iso) => (iso ? new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : '');
const secs = (ms) => `${(Math.max(0, ms || 0) / 1000).toFixed(2)} s`;
const humanize = (key) => {
  const s = String(key ?? '').replace(/_/g, ' ').toLowerCase().trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Not given';
};
/** A label for a server value; a value this page does not know yet is spelled out, never "undefined". */
const label = (map, key) => map[key] ?? humanize(key);

let state = null;
let cases = [];
let catalog = null; // the live agent's demo catalog and prepared instructions
let busy = false;
let showAll = false;
let reconciliation = null;
const openSteps = new Map(); // "caseId:step" -> open or closed, once the viewer has clicked a step

const REASONS = {
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
const FACT_LABELS = {
  purchaseAuthorized: 'The mandate allowed the agent to pay',
  itemMatchesMandate: 'The ordered item is what the buyer described',
  quantityMatchesMandate: 'The quantity matches',
  withinSpendingLimit: 'The total is within the spending limit',
  exclusionsRespected: 'Nothing the buyer ruled out is in the order',
  storeChargedAsOrdered: 'The store charged what the agent submitted',
  storeFulfilledAsOrdered: 'The store shipped what was ordered',
};
const FACT_SHORT = {
  purchaseAuthorized: 'allowed to pay',
  itemMatchesMandate: 'item',
  quantityMatchesMandate: 'quantity',
  withinSpendingLimit: 'spending limit',
  exclusionsRespected: 'ruled-out items',
  storeChargedAsOrdered: 'store charge',
  storeFulfilledAsOrdered: 'store shipment',
};
const INTEGRITY = {
  MANDATE_RECORD_CHANGED_AFTER_APPROVAL: 'The mandate record changed after the buyer approved it',
  PAYPAL_ORDER_NOT_TIED_TO_THIS_MANDATE: 'The PayPal order does not carry this mandate',
  NO_PAYPAL_CAPTURE: 'PayPal has no capture for this order',
};
const RULES = {
  R0: 'The records could not be tied together, so nothing is held against the buyer.',
  R1: 'The store did not deliver or charge what was ordered.',
  R2: 'The order differs from what the buyer approved.',
  R3: 'The records leave a question open. An open question is never held against the buyer.',
  R4: 'The order matches every condition the buyer approved, and the store delivered and charged as ordered.',
  OPERATOR: 'The two keys differed, so a person chose.',
};
const WHO = { STORE: 'The store', AGENT: "The agent's operator", BUYER: 'The buyer', UNDETERMINED: 'Nobody could be named: the desk absorbs it' };
const WHO_SHORT = { STORE: 'Store', AGENT: "Agent's operator", BUYER: 'Buyer', UNDETERMINED: 'Nobody (desk absorbs)' };
const WHO_IN = { STORE: 'the store', AGENT: "the agent's operator", BUYER: 'the buyer' };
const DOCS = { mandate: 'Mandate', paypal_order: 'PayPal order', agent_log: "Agent's log", store_record: 'Store record', complaint: "Buyer's report" };
const DOCS_IN = { mandate: 'the mandate', paypal_order: 'the PayPal order', agent_log: "the agent's log", store_record: 'the store record', complaint: "the buyer's report" };
const NOTICES = {
  REFUND_REQUESTED: { title: 'Refund requested', tone: 'info' },
  REFUND_COMPLETED: { title: 'PayPal refund completed', tone: 'go' },
  REFUND_PENDING: { title: 'Refund still with PayPal', tone: 'wait' },
  NO_RECHARGE: { title: 'No re-charge', tone: 'go' },
  CHECKING_FIRST: { title: 'Checking first', tone: 'wait' },
  HUMAN_REVIEW: { title: 'A person is checking', tone: 'wait' },
};
const REVIEW_REASONS = {
  KEYS_DISAGREE: 'The rules key and the AI key name different parties.',
  QUICK_CLOSED_BUT_BOTH_BUYER: 'Both keys name the buyer, but the quick check already found a mismatch. A contradiction goes to a person.',
};
const ACCOUNTS = { buyer: 'Buyer', 'desk:purchase': 'Desk, purchase money held', 'desk:reserve': "Desk's own funds", store: 'Store', 'paypal:fees': 'PayPal fees' };
const KINDS = {
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
  const watch = watchProgress(label);
  try {
    const result = await api(`/api/act/${name}`, { ws: state.workspace, ...body });
    watch.stop();
    state = result.state;
    return result;
  } catch (err) {
    toast(err.message);
    return null;
  } finally {
    watch.stop();
    busy = false;
    render();
  }
}

// One action can take a while (the deep check, waiting for PayPal to confirm the store payout). The desk
// records each step as it happens, so while the action runs the page reads the state again and shows the
// buyer each notice the moment it exists: "Refund requested", then "PayPal refund completed", then the rest.
function watchProgress(label) {
  let stopped = false;
  let inFlight = false;
  let last = '';
  const timer = setInterval(async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const res = await fetch(`/api/state?ws=${encodeURIComponent(state.workspace)}`, { cache: 'no-store' });
      const text = res.ok ? await res.text() : '';
      // The policy clock ticks on every read; only a real change redraws (an opened record stays open).
      const key = text.replace(/"clock":\{[^}]*\}/, '');
      if (!stopped && text && key !== last) {
        last = key;
        state = JSON.parse(text);
        render(label);
      }
    } catch {
      // A missed read is fine: the next one, or the action's own answer, brings the state.
    } finally {
      inFlight = false;
    }
  }, 400);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
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
  catalog = await api('/api/catalog').catch(() => null);
  // Coming back from the PayPal approval screen: the workspace id rides on the return URL.
  const params = new URLSearchParams(location.search);
  if (params.has('ws')) {
    localStorage.setItem('rfd-workspace', params.get('ws'));
    if (RETURN_NOTES[params.get('paypal')]) setTimeout(() => toast(RETURN_NOTES[params.get('paypal')]), 300);
    history.replaceState(null, '', '/');
  }
  const saved = !fresh && localStorage.getItem('rfd-workspace');
  state = null;
  if (saved) {
    try {
      state = await api(`/api/state?ws=${saved}`);
    } catch {
      state = null;
    }
  }
  if (!state) state = await api('/api/workspaces', {});
  localStorage.setItem('rfd-workspace', state.workspace);
  reconciliation = null;
  render();
}

// ---- what is on screen now ---------------------------------------------------------------------------
function current() {
  const mandate = state.mandates.at(-1) || null;
  // After a refused payment the agent may pay again: the order that was paid is the one on screen.
  const mine = mandate ? state.orders.filter((o) => o.mandateId === mandate.id) : [];
  const order = mine.find((o) => o.paypal) || mine.at(-1) || null;
  const kase = order ? state.cases.find((c) => c.orderId === order.id) || null : null;
  const sc = mandate ? cases.find((c) => c.id === mandate.caseId) || null : null;
  return { mandate, order, kase, sc };
}

function render(working = '') {
  if (!state) return;
  const cur = current();
  $('ai-pill').textContent = aiPillText(state.flags, cur.kase);
  renderCases(cur);
  refreshCaseBook(state, cases);
  renderLive(cur);
  // The line is shown before any case is picked: the order of the steps is what this desk is about.
  $('stage').hidden = false;
  $('rail').innerHTML = railHtml(cur, working);
  $('cols').hidden = !cur.mandate;
  if (!cur.mandate) return;
  const scope = cur.mandate.id; // typed text belongs to this purchase; a new case starts clean
  redraw('buyer', buyerColumn(cur, working), scope);
  redraw('desk', deskColumn(cur, working), scope);
  redraw('money', moneyColumn(cur), scope);
}

/**
 * Replace a column's content but keep what the reader did there: every record opened or closed (matched by
 * its summary) and any text typed into a field (the buyer's sentence, the operator's note), within one purchase.
 */
function redraw(id, html, scope) {
  const el = $(id);
  const keyOf = (d) => (d.querySelector('summary')?.textContent || '').replace(/\d+/g, '#'); // "latest 14" and "latest 15" are the same record
  const was = new Map([...el.querySelectorAll('details')].map((d) => [keyOf(d), d.open]));
  const typed = el.dataset.scope === scope ? new Map([...el.querySelectorAll('textarea[id], input[id]')].map((f) => [f.id, f.value])) : new Map();
  el.innerHTML = html;
  el.dataset.scope = scope;
  for (const d of el.querySelectorAll('details')) {
    if (was.has(keyOf(d))) d.open = was.get(keyOf(d));
  }
  for (const f of el.querySelectorAll('textarea[id], input[id]')) {
    if (typed.has(f.id)) f.value = typed.get(f.id);
  }
}

function renderCases(cur) {
  const list = showAll ? cases : cases.slice(0, 6);
  const cap = state.buyerLimits?.perCaseCapCents ?? state.policy.perCaseCapCents; // this buyer's limit for the next purchase
  $('cases').innerHTML =
    list
      .map((c) => {
        const total = c.cart.reduce((s, l) => s + l.unitCents * l.qty, 0);
        return `<button class="case" data-case="${esc(c.id)}" aria-pressed="${cur.sc?.id === c.id}" ${busy ? 'disabled' : ''}>
          <span class="t">${esc(c.title)}</span>
          <span class="q">“${esc(c.instruction)}”</span>
          <span class="m"><span>${esc(c.store.name)}</span><span class="amt-cell">${total > cap ? `<span class="tag sim">over ${usd(cap)}: checked first</span>` : ''}${usd(total)}</span></span>
        </button>`;
      })
      .join('') + (cases.length > 6 ? `<button class="ghost more" data-toggle-all>${showAll ? 'Show fewer' : `Show all ${cases.length} cases`}</button>` : '');
}

// ---- the live agent ----------------------------------------------------------------------------------------
function renderLive(cur) {
  const el = $('live-prompts');
  if (!catalog) {
    el.innerHTML = '';
    return;
  }
  const on = state.flags.liveAgent;
  el.innerHTML = catalog.prompts
    .map(
      (p) => `<button class="case" data-live-prompt="${esc(p.id)}" aria-pressed="${cur.mandate?.live?.promptId === p.id}" ${busy || !on ? 'disabled' : ''}>
        <span class="t">${esc(p.label)}</span><span class="q">“${esc(p.instruction)}”</span>
        <span class="m"><span>3 demo stores</span><span class="amt-cell">${p.conditions.maxTotalCents == null ? 'no limit' : `limit ${usd(p.conditions.maxTotalCents)}`}</span></span></button>`,
    )
    .join('') + (on ? '' : '<p class="sub">The live agent is off here: this server has no live AI connected. The prepared cases below still run.</p>');
  document.querySelector('[data-act="liveOwn"]').disabled = busy || !on;
  const list = $('catalog-list');
  if (!list.dataset.done) {
    const store = (id) => catalog.stores.find((s) => s.id === id);
    list.innerHTML = `<table class="catalog"><thead><tr><th>Store</th><th>Listing title</th><th>On the product page</th><th class="num">Price</th></tr></thead><tbody>${catalog.products
      .map((p) => `<tr><td>${esc(store(p.store).name)}${p.sponsored ? ' <span class="tag sim">sponsored</span>' : ''}</td><td>${esc(p.title)}</td><td>${esc(p.details)}</td><td class="num">${usd(p.priceCents)}</td></tr>`)
      .join('')}</tbody></table><p class="fine">${catalog.stores.map((s) => `${esc(s.name)}: ${esc(s.shippingNote)}`).join(' · ')}</p>`;
    list.dataset.done = '1';
  }
}

const AGENT_SAYS = {
  careful: 'Told: the approved conditions bind, open product pages, check the cart total, pay only if allowed. Sees the condition slots, store, variant and shipping.',
  hasty: 'Told: it is graded on speed, pick from the top and pay. Sees only the buyer’s words and number, title and price. No product page, no cart view.',
};

function liveStepsHtml(steps, running) {
  if (!steps?.length) return running ? '<p class="sub"><span class="spinner"></span>The agent is reading the instruction…</p>' : '';
  return `<ol class="trace live-trace">${steps
    .map((s) => `<li class="st"><div class="st-row"><span class="sn">${s.step}</span><span class="st-body"><span class="st-head"><span class="act">${esc(s.action)}</span><span class="actor">${esc(s.actor)}</span></span><span class="st-text">${esc(s.content)}</span></span></div></li>`)
    .join('')}${running ? '<li class="st"><div class="st-row"><span class="sn"><span class="spinner"></span></span><span class="st-body"><span class="st-text">thinking…</span></span></div></li>' : ''}</ol>`;
}

function liveAgentCard(mandate, order, working) {
  const live = mandate.live;
  const off = busy ? 'disabled' : '';
  if (!live.status) {
    return `<div class="card"><h3>Give this to a live AI agent</h3>
      <p class="sub" style="margin-bottom:10px">Same model, same catalog. It pays from the PayPal wallet the buyer saved earlier, if it decides to: a real sandbox charge. Nobody is asked again at checkout.</p>
      <div class="agent-pick">${['careful', 'hasty']
        .map((k) => `<div class="agent-opt"><button class="${k === 'careful' ? 'primary' : 'danger'}" data-act="shop" data-kind="${k}" ${off}>${working === 'shop' ? '<span class="spinner"></span>' : ''}Run the ${k} agent</button><p class="sub">${esc(AGENT_SAYS[k])}</p></div>`)
        .join('')}</div></div>`;
  }
  const running = live.status === 'RUNNING' || (working === 'shop' && !live.finishedAt);
  const who = live.kind === 'hasty' ? 'The hasty agent' : 'The careful agent';
  const cost = live.finishedAt ? ` ${live.calls} model calls, $${(live.usd || 0).toFixed(4)} of AI.` : '';
  let tail = '';
  if (live.status === 'NOT_PAID') tail = `<div class="result"><strong>It did not pay.</strong> Nothing was charged, so there is nothing to report. Pick another instruction to try again.</div>`;
  if (live.status === 'PAYMENT_UNCONFIRMED') tail = `<div class="result wait"><strong>PayPal did not confirm the payment.</strong> It may have gone through. The desk sent no second payment; the next try asks PayPal about this one again, under the same request id.</div>`;
  if (live.status === 'FAILED') tail = `<div class="result"><strong>The run stopped:</strong> ${esc(live.error || 'error')}.</div>`;
  const body = liveStepsHtml(live.steps, running);
  return `<div class="card"><h3>${who} ${running ? 'is shopping' : 'shopped'}, step by step</h3>
    <p class="sub">Each line is one tool call it made, written down as it happened. This is the log the investigator will read.${cost}</p>
    ${body}${tail}</div>`;
}

// ---- the line: the order of operations is the product ------------------------------------------------
const lockIcon = (open) =>
  `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3" y="7.2" width="10" height="7" rx="1.6" fill="currentColor"/><path d="M5.2 7.2V5a2.8 2.8 0 0 1 5.6 0${open ? '' : 'v2.2'}" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>`;

function stations({ order, kase: k }, working) {
  const verifyFirst = k ? k.path === 'VERIFY_FIRST' : order?.protection ? !order.protection.refundFirst : false;
  const q = k?.quick;
  const inv = k?.investigation;
  const v = k?.verdict;
  const review = k?.status === 'HUMAN_REVIEW';
  const st = {};

  st.report = k ? { state: 'done', sub: `at ${time(k.receivedAt)}` } : working === 'report' ? { state: 'done', sub: 'sending' } : { state: 'todo', sub: 'one sentence' };

  if (k?.refund?.completedAt) {
    st.refund = verifyFirst
      ? { state: 'money', sub: `${usd(k.refund.amountCents)}, ${refundTiming(k)}` }
      : { state: 'money', sub: `${usd(k.refund.amountCents)} in ${secs(k.refund.completedAtMs - k.receivedAtMs)}, before any check` };
  } else if (k && verifyFirst && v?.liable === 'BUYER') st.refund = { state: 'skip', sub: 'no refund: the order matches' };
  else if (review) st.refund = { state: 'hold', sub: 'held until a person decides' };
  else if (k?.refund) st.refund = { state: 'todo', sub: `PayPal says ${k.refund.status}` };
  else st.refund = { state: 'todo', sub: verifyFirst ? 'within 5 minutes if not the buyer' : 'before anything is checked' };

  if (q?.finishedAtMs) st.quick = q.closed ? { state: 'done', tone: 'go', sub: `mismatch found in ${secs(q.ms)}` } : { state: 'done', sub: `nothing settled, ${secs(q.ms)}` };
  else st.quick = { state: 'todo', sub: 'mandate and PayPal order' };

  if (inv?.finishedAt) {
    const fd = inv.firstDeviation;
    const what = fd?.kind === 'STEP' ? `step ${fd.step} went off` : fd?.kind === 'NONE' ? 'no step went off' : 'records not enough';
    st.deep = { state: 'done', sub: `${what}, ${secs(inv.durationMs)}` };
  } else st.deep = { state: 'todo', sub: 'every record, step by step' };

  if (v) {
    if (v.rule === 'R0') st.keys = { state: 'done', sub: "records not tied: buyer's side" };
    else if (v.rule === 'OPERATOR') st.keys = { state: 'done', tone: 'wait', sub: `differed; a person chose ${label(WHO_SHORT, v.liable)}` };
    else st.keys = { state: 'done', tone: 'go', sub: `both say ${label(WHO_SHORT, v.liable)}` };
  } else if (review) st.keys = { state: 'hold', sub: 'they differ: a person decides' };
  else st.keys = { state: 'todo', sub: 'further money moves only if they agree' };

  const r = k?.recharge;
  if (k?.rechargeClosed) {
    st.notice = { state: 'closed', sub: 'closed by the quick check' };
    st.recharge = { state: 'closed', sub: 'never, for this order' };
  } else if (v && v.liable !== 'BUYER') {
    st.notice = { state: 'skip', sub: 'not needed' };
    st.recharge = { state: 'skip', sub: 'not needed' };
  } else if (v?.liable === 'BUYER' && !k.refund?.completedAt) {
    st.notice = { state: 'skip', sub: 'nothing was refunded' };
    st.recharge = { state: 'skip', sub: 'nothing to charge' };
  } else if (k?.notice) {
    st.notice = { state: 'done', sub: `dispute any time before ${day(k.notice.chargeNotBefore)}` };
    if (r?.status === 'COMPLETED') st.recharge = { state: 'charged', sub: `${usd(r.amountCents)} from the saved wallet` };
    else if (r?.status === 'HALTED') st.recharge = { state: 'halt', sub: `stopped: ${label(REASONS, r.blockedBy)}` };
    else st.recharge = { state: 'todo', sub: `not before ${day(k.notice.chargeNotBefore)}` };
  } else {
    st.notice = { state: 'todo', sub: 'only if both keys name the buyer' };
    st.recharge = { state: 'todo', sub: 'after the notice, unless disputed' };
  }

  // Over a limit the quick check comes before the refund; if it settles nothing, the refund waits for the keys.
  const main = !verifyFirst ? ['report', 'refund', 'quick', 'deep', 'keys'] : q?.finishedAtMs && !q.closed ? ['report', 'quick', 'deep', 'keys', 'refund'] : ['report', 'quick', 'refund', 'deep', 'keys'];
  const ids = [...main, 'notice', 'recharge'];
  if (working && ['report', 'investigate', 'resolveReview', 'dispute', 'fastForward'].includes(working)) {
    const next = ids.find((id) => st[id].state === 'todo');
    if (next) st[next] = { ...st[next], working: true };
  }
  const names = { report: 'Report', refund: verifyFirst ? 'Refund' : 'Refund first', quick: 'Quick check', deep: 'Deep check', keys: 'Two keys', notice: 'Notice', recharge: 'Re-charge' };
  return { verifyFirst, list: ids.map((id) => ({ id, name: names[id], ...st[id] })) };
}

function railHtml(cur, working) {
  const { verifyFirst, list } = stations(cur, working);
  const reached = (s) => s && !['todo', 'skip'].includes(s.state);
  let here = -1;
  list.forEach((s, i) => {
    if (reached(s)) here = i;
  });
  const items = list
    .map((s, i) => {
      const cls = ['stn', `s-${s.state}`, s.tone ? `t-${s.tone}` : '', s.id === 'notice' || s.id === 'recharge' ? 'br' : '', i === 4 ? 'br-out' : '', reached(s) ? 'in' : '', reached(list[i + 1]) ? 'out' : '', i === here ? 'here' : '', s.working ? 'working' : '']
        .filter(Boolean)
        .join(' ');
      const inner = s.working ? '<span class="spinner"></span>' : s.id === 'keys' ? lockIcon(s.state === 'done') : s.id === 'refund' && s.state === 'money' ? '↩' : '';
      return `<li class="${cls}" data-stn="${s.id}"><span class="dot">${inner}</span><span class="nm">${esc(s.name)}</span><span class="sb">${esc(s.sub)}</span></li>`;
    })
    .join('');
  const lead = verifyFirst
    ? 'Over a limit, so the quick check comes first. If it was not the buyer’s mistake, the refund follows within 5 minutes.'
    : 'Trust the buyer first: the money goes back before anything is checked. It is taken back only if both keys name the buyer, after notice, and a dispute stops that.';
  return `<div class="rail-head"><h2>What happens, in order</h2><p>${esc(lead)}</p></div><ol class="rail" aria-label="Steps of this case, in order">${items}</ol>`;
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
      <dt>Quantity</dt><dd>${esc(c.quantity ?? '(not specified)')}</dd>
      <dt>Spending limit</dt><dd>${c.maxTotalCents == null ? '(none)' : `${usd(c.maxTotalCents)} total`}</dd>
      <dt>Must not include</dt><dd>${c.exclusions?.length ? esc(c.exclusions.join('; ')) : '(nothing listed)'}</dd>
      <dt>May pay without asking again</dt><dd class="flag">${c.purchaseAuthorized ? 'yes' : 'no'}</dd>
    </dl>
    ${
      mandate.status === 'DRAFT'
        ? `<div class="row"><button class="primary" data-act="approve" ${busy ? 'disabled' : ''}>${spin}Approve these conditions</button><span class="sub">The buyer approves once, before anything is bought.</span></div>`
        : `<p class="sub">Approved at ${time(mandate.approval.at)} and kept as a record. Its fingerprint <code>${esc(mandate.fingerprint.slice(0, 12))}…</code> goes into the PayPal order.</p>`
    }
  </div>`;

  if (mandate.live && mandate.status === 'APPROVED') {
    html += liveAgentCard(mandate, order, working);
  } else if (mandate.status === 'APPROVED' && !order) {
    html += `<div class="card"><h3>The agent goes shopping</h3>
      <p class="sub" style="margin-bottom:10px">It pays from the PayPal wallet the buyer saved earlier. Nobody is asked again at checkout.</p>
      <button class="primary" data-act="purchase" ${busy ? 'disabled' : ''}>${spin}Let the agent shop and pay</button>
      <p class="sub" style="margin:14px 0 8px">Or see how the wallet gets saved in the first place: pay this order at PayPal yourself and agree to save the wallet for the agent. You need a PayPal sandbox personal account; sign in at <code>sandbox.paypal.com</code> first.</p>
      <button class="ghost" data-act="consentPurchase" ${busy ? 'disabled' : ''}>Pay at PayPal and save the wallet</button></div>`;
  }
  if (order && order.consentCancelled) {
    html += `<div class="card"><h3>Cancelled at PayPal</h3><p class="sub">The buyer turned back on the PayPal screen. Nothing was charged. Pick a case to start again.</p></div>`;
  } else if (order && !order.paypal && order.payment !== 'CONSENT_CHECKOUT') {
    // A saved-wallet payment PayPal did not confirm: no Cancel, it may have gone through. The live agent card says so itself.
    if (mandate.live) html += '';
    else if (order.storePayable?.status === 'PAYMENT_UNCONFIRMED')
      html += `<div class="card"><h3>PayPal has not confirmed this payment</h3>
      <p class="sub" style="margin-bottom:10px">The agent sent the payment from the saved wallet and PayPal did not answer. The money may have moved, so the desk does not send a new payment. Asking again uses the same request id, and PayPal does not charge twice.</p>
      <button class="primary" data-act="purchase" ${busy ? 'disabled' : ''}>${spin}Ask PayPal about this payment again</button></div>`;
    else html += `<div class="card"><h3>PayPal refused the payment</h3><p class="sub">PayPal clearly declined the saved-wallet payment, so nothing was charged. Pick a case to start again.</p></div>`;
  } else if (order && !order.paypal) {
    html += `<div class="card"><h3>Waiting for the buyer at PayPal</h3>
      <p class="sub" style="margin-bottom:10px">PayPal shows the payment and the request to save the wallet for future agent purchases on one screen.</p>
      <div class="row">${order.approveUrl ? `<a class="primary" href="${esc(order.approveUrl)}">Continue at PayPal</a>` : ''}
      <button class="ghost" data-act="cancelConsent" ${busy ? 'disabled' : ''}>Cancel</button></div></div>`;
  } else if (order) {
    const atPayPal = order.payment === 'CONSENT_CHECKOUT';
    const saved = state.buyers[0]?.wallet?.source === 'OWN';
    html += `<div class="card"><h3>${atPayPal ? 'The buyer paid at PayPal' : 'The agent bought this'} at ${esc(order.store.name)}</h3>
      <ul class="items">${order.cart.map((l) => `<li><span>${l.qty} × ${esc(l.name)}</span><span class="num">${usd(l.unitCents * l.qty)}</span></li>`).join('')}
      <li class="total"><span>${atPayPal ? (saved ? 'Paid at PayPal; wallet saved for the agent' : 'Paid at PayPal; the wallet was not saved') : 'Paid from the saved PayPal wallet'}</span><span class="num">${usd(order.totalCents)}</span></li></ul>
      <p class="sub">PayPal order <code>${esc(order.paypal.orderId)}</code></p>${limitCard(order, state)}</div>`;
  }
  if (order?.paypal && !kase) {
    html += `<div class="card"><h3>Something is wrong? Say it in one sentence.</h3>
      <textarea id="statement" aria-label="What went wrong">${esc(sc?.complaint || (mandate.live ? 'This is not what I asked the agent to buy.' : ''))}</textarea>
      <div class="row"><button class="primary" data-act="report" ${busy ? 'disabled' : ''}>${spin}Report it</button><span class="sub">This is the only thing the buyer has to do.</span></div></div>`;
  }
  if (kase) {
    html += `<div class="card"><h3>The buyer's report</h3><p class="quote">“${esc(kase.statement)}”</p></div>`;
    html += noticesCard(kase);
    if (kase.verdict) html += buyerOutcome(kase);
  }
  return html;
}

/**
 * How long the refund took, from server times only. Refund first: from the report. Checked first: from
 * the start of the check, or from a person's choice when one was needed (their waiting time is not the desk's).
 */
function refundTiming(k) {
  const done = k.refund.completedAtMs;
  if (k.path === 'REFUND_FIRST') return `${secs(done - k.receivedAtMs)} after the report, before any check`;
  const chosen = k.verdict?.rule === 'OPERATOR' ? Date.parse(k.verdict.decidedAt) : NaN;
  if (done >= chosen) return `${secs(done - chosen)} after a person chose`;
  return `${secs(done - (k.quick?.startedAtMs ?? k.receivedAtMs))} after the check began`;
}

/** The notices exactly as the desk sent them, in order, with the server's time. */
function noticesCard(k) {
  const list = k.notices || [];
  if (!list.length) return '';
  return `<div class="phone"><p class="phone-h">Sent to the buyer</p><ol class="notes">${list.map((n) => noticeHtml(n, k)).join('')}</ol></div>`;
}

function noticeHtml(n, k) {
  const meta = NOTICES[n.type] || { title: humanize(n.type), tone: 'info' };
  const atMs = n.atMs ?? Date.parse(n.at);
  let measured = '';
  if (n.type === 'REFUND_COMPLETED' && k.refund?.completedAtMs) measured = `${refundTiming(k)}. PayPal refund <code>${esc(k.refund.id)}</code>.`;
  if (n.type === 'NO_RECHARGE' && k.quick?.startedAtMs) measured = `${secs(atMs - k.quick.startedAtMs)} after the quick check began.`;
  return `<li class="note n-${meta.tone}${n.type === 'REFUND_COMPLETED' ? ' n-big' : ''}">
    <div class="nt"><strong>${esc(meta.title)}</strong><time datetime="${esc(n.at)}">${time(n.at)}</time></div>
    <p>${esc(n.text)}</p>${measured ? `<p class="meta">${measured}</p>` : ''}</li>`;
}

function buyerOutcome(kase) {
  const v = kase.verdict;
  const liable = v.liable;
  const by = v.rule === 'OPERATOR' ? 'A person decided. ' : '';
  const off = busy ? 'disabled' : '';
  if (liable !== 'BUYER') {
    const line = label({ AGENT: 'The agent went beyond what you approved.', STORE: 'The store did not deliver what was ordered.', UNDETERMINED: 'The records could not settle it.' }, liable);
    if (!kase.refund?.completedAt) return `<div class="stamp wait"><div class="big">Refund on its way</div><p>${by}${esc(line)}</p></div>`;
    return `<div class="stamp info"><div class="big">You keep the refund</div><p>${by}${esc(line)} Nothing more to do, and you will not be charged again.</p></div>`;
  }
  if (!kase.refund?.completedAt) {
    return `<div class="stamp wait"><div class="big">No refund</div>
      <p>${by}The order matches what you approved. Because the check came first, nothing was refunded and nothing is charged again.</p>
      ${kase.dispute ? `<p><strong>Your dispute is on file</strong> since ${time(kase.dispute.at)}.</p>` : `<div class="row" style="margin-top:10px"><button class="danger" data-act="dispute" ${off}>Dispute this decision</button></div>`}</div>`;
  }
  const r = kase.recharge || {};
  // Once the charge happened or stopped, the notice that came first stays visible.
  const noticeLine = kase.notice ? `<p class="sub">Notice sent at ${time(kase.notice.sentAt)}, charge not before ${day(kase.notice.chargeNotBefore)}.</p>` : '';
  if (r.status === 'SCHEDULED') {
    return `<div class="stamp wait"><div class="big">Notice: we plan to charge ${usd(kase.notice.amountCents)} again</div>
      <p>${by}${esc(kase.notice.text)}</p><p>Not before <strong>${day(kase.notice.chargeNotBefore)}</strong>. Never more than the amount fixed when you bought.</p>
      <div class="row" style="margin-top:10px">
        <button class="danger" data-act="dispute" ${off}>Dispute this charge</button>
        <button class="ghost" data-act="fastForward" ${off}>Fast-forward the notice period <span class="tag sim">simulated</span></button>
      </div></div>`;
  }
  if (r.status === 'COMPLETED') {
    return `<div class="stamp info"><div class="big">Charged again: ${usd(r.amountCents)}</div><p>After the notice period, from the saved wallet, with no dispute on file. PayPal capture <code>${esc(r.captureId)}</code>.</p>${noticeLine}</div>`;
  }
  if (r.status === 'HALTED') {
    // Say what PayPal reported for the store payout, not what was intended.
    const sp = state.orders.find((o) => o.id === kase.orderId)?.storePayable;
    const store = sp?.status === 'PAID' ? "the store is still paid, from the desk's own funds" : sp?.status === 'PAYOUT_FAILED' ? "the store payout from the desk's own funds did not go through, and that money stays set aside for the store" : "the store's payout from the desk's own funds is on its way at PayPal";
    return `<div class="stamp go"><div class="big">The charge is stopped</div><p>Because ${esc(label(REASONS, r.blockedBy))}. You keep the refund; ${store}.</p>${noticeLine}</div>`;
  }
  return '';
}

// ---- desk column ----------------------------------------------------------------------------------------
function deskColumn({ order, kase: k }, working) {
  if (!order) return `<div class="card"><p class="sub">Nothing has happened yet. The desk only acts when the buyer reports a problem.</p></div>`;
  if (!order.paypal) return `<div class="card"><p class="sub">${order.consentCancelled ? 'Nothing was charged.' : 'Nothing has been charged yet. The payment and the saved-wallet consent are waiting at PayPal.'}</p></div>`;
  if (!k) {
    const p = order.protection;
    return `<div class="card"><h3>Waiting for a report</h3><p class="sub">The desk received the payment for this order and holds it for the store until the hold window ends (${state.policy.storeHoldDays} days, simulated). The protection for this purchase was fixed at the moment of purchase: ${p.refundFirst ? `refund first, and the buyer can never be charged again for more than ${usd(p.buyerLiabilityCapCents)}` : `check first, because ${esc(p.reasons.map((r) => label(REASONS, r)).join('; '))}`}.</p></div>`;
  }
  const checking = working === 'investigate';
  if (k.status === 'HUMAN_REVIEW') return operatorPanel(k, working) + quickCard(k, false) + afterCard(k, order);
  return quickCard(k, checking) + deepCard(k, checking) + keysCard(k, order, working) + afterCard(k, order);
}

const took = (ms) => `<span class="took">${secs(ms)}</span>`;

function factLine(key, value, quote, by, discarded = false) {
  return `<li class="fx"><span class="ans ${esc(value)}">${esc(value)}</span><div><span class="fl">${esc(label(FACT_LABELS, key))}</span>${
    quote ? `<q>${esc(quote)}</q>` : discarded ? '<span class="tag sim">quote not found in the record: discarded</span>' : '<span class="src">the documents do not settle this</span>'
  }<span class="by">${esc(by)}</span></div></li>`;
}

function quickCard(k, checking) {
  const q = k.quick;
  if (!q?.finishedAtMs) {
    return `<div class="card stage-card"><h3>Quick check</h3><p class="sub">${checking ? '<span class="spinner"></span>Reading' : 'Reads'} only the mandate and the PayPal order. It can close the case in the buyer's favour, never against the buyer.</p></div>`;
  }
  const rows = Object.entries(q.codeFacts || {}).map(([key, f]) => factLine(key, f.value, f.quote, `computed by code from ${label(DOCS_IN, f.doc)}`));
  for (const [key, f] of Object.entries(q.aiFacts || {})) {
    const ev = f.evidence?.[0];
    rows.push(factLine(key, f.value, ev?.quote, ev ? `AI, quoting ${label(DOCS_IN, ev.doc)}` : 'AI, with no quote from these two documents', q.downgraded?.includes(key)));
  }
  const aiLine = quickAiLine(q);
  const result = q.closed
    ? `<div class="result go"><strong>Closed in the buyer's favour.</strong> The buyer can never be charged again for this order. Who is responsible is still open: the deep check and the two keys decide that.</div>`
    : `<div class="result"><strong>Nothing settled from these two documents.</strong> On to the deep check.</div>`;
  return `<div class="card stage-card"><h3>Quick check ${took(q.ms)}</h3>
    <p class="sub">Read only the mandate and the PayPal order. ${aiLine}</p>
    <ul class="facts">${rows.join('')}</ul>${result}</div>`;
}

function deepCard(k, checking) {
  const inv = k.investigation;
  if (!inv?.finishedAt) {
    return `<div class="card stage-card"><h3>Deep check</h3><p class="sub">${checking ? '<span class="spinner"></span>' : ''}The investigator reads the mandate, the numbered agent log, the PayPal order and the store record, and names the first step that went off the mandate.</p></div>`;
  }
  return `<div class="card stage-card"><h3>Deep check: where the agent left the mandate ${took(inv.durationMs)}</h3>
    <p class="sub">${byWhom(inv)}</p>${traceHtml(k)}</div>`;
}

const byWhom = deepAiSource;

function markQuote(line, quote) {
  const qt = String(quote || '').trim();
  const i = qt ? line.toLowerCase().indexOf(qt.toLowerCase()) : -1;
  if (i < 0) return esc(line);
  return `${esc(line.slice(0, i))}<mark>${esc(line.slice(i, i + qt.length))}</mark>${esc(line.slice(i + qt.length))}`;
}

/** The fork picture: the agent's own log, one row per step, with the investigator's pick and the rule flags kept apart. */
function traceHtml(k) {
  const inv = k.investigation;
  const steps = inv.steps || [];
  if (!steps.length) return `<p class="sub">This case has no step-by-step agent log.</p>`;
  const fd = inv.firstDeviation || { kind: 'INSUFFICIENT' };
  const forkAt = fd.kind === 'STEP' && steps.some((s) => s.step === fd.step) ? fd.step : null;
  const lines = String(inv.evidence?.agent_log?.text || '').split('\n');
  const flags = {};
  for (const c of inv.candidates || []) (flags[c.step] ||= []).push(c);
  const flagged = Object.keys(flags).map(Number);

  const rows = steps
    .map((s) => {
      const off = forkAt != null && s.step >= forkAt;
      const fork = s.step === forkAt;
      const f = flags[s.step] || [];
      const key = `${k.id}:${s.step}`;
      const open = openSteps.has(key) ? openSteps.get(key) : fork;
      const raw = lines.find((l) => l.startsWith(`Step ${s.step} · `)) || `Step ${s.step} · ${String(s.at || '').slice(11, 19) || '--:--:--'} · ${s.actor} · ${s.action}: ${s.content}`;
      const marks = [
        fork ? `<span class="mk ai">${fd.verified ? 'AI: first step off' : 'AI: first step off, quote not verified'}</span>` : '',
        ...f.map((c) => `<span class="mk flag">rule flag: ${esc(label(FACT_SHORT, c.condition))}</span>`),
      ].join('');
      let detail = `<p class="raw">${fork && fd.verified ? markQuote(raw, fd.quote) : esc(raw)}</p><p class="dl muted">The log line is shown as the investigator read it; its time is UTC.</p>`;
      if (fork) {
        detail += fd.verified
          ? `<p class="dl"><span class="tag real">quote found in this step</span> Condition named: ${esc(fd.condition ? label(FACT_LABELS, fd.condition) : 'none')}.</p>`
          : `<p class="dl"><span class="tag stop">quote not verified</span> The investigator quoted <q class="struck">${esc(fd.quote || '(nothing)')}</q>, which is not in this step. It is kept as a report only and plays no part in the decision.</p>`;
      }
      for (const c of f) detail += `<p class="dl"><span class="tag flagtag">rule flag</span> ${esc(c.why)}. A simple rule; it can be wrong or miss.</p>`;
      if (!fork && !f.length) detail += `<p class="dl muted">Nothing flagged on this step.</p>`;
      const cls = ['st', off ? 'off' : '', fork ? 'fork' : '', f.length ? 'flagged' : '', open ? 'open' : ''].filter(Boolean).join(' ');
      return `<li class="${cls}">
        ${fork ? '<svg class="bend" viewBox="0 0 30 22" aria-hidden="true"><path d="M1.5 0 C1.5 12, 28.5 8, 28.5 22" fill="none"/></svg>' : ''}
        <button class="st-row" data-step="${s.step}" aria-expanded="${open}">
          <span class="sn">${s.step}</span>
          <span class="st-body"><span class="st-head"><span class="act">${esc(s.action)}</span><span class="actor">${esc(s.actor)}</span>${marks}</span><span class="st-text">${esc(s.content)}</span></span>
        </button>
        ${open ? `<div class="st-open">${detail}</div>` : ''}</li>`;
    })
    .join('');

  const summary =
    fd.kind === 'STEP'
      ? forkAt != null
        ? `The investigator puts the first step off the mandate at <strong>step ${fd.step}</strong>${fd.condition ? ` (${esc(label(FACT_SHORT, fd.condition))})` : ''}${fd.verified ? '.' : ', but its quote is not in that step.'}`
        : `The investigator named step ${esc(fd.step)}, which is not in this log.`
      : fd.kind === 'NONE'
        ? 'The investigator found no step that went off the mandate.'
        : 'The investigator says the records are not enough to name a step.';
  const flagLine = flagged.length ? ` Rule flags on step${flagged.length > 1 ? 's' : ''} ${flagged.join(', ')} were given to it as evidence, not as the answer.` : ' No rule flagged any step.';
  return `<p class="trace-sum">${summary}${flagLine} The first step off is a report for whoever fixes the agent; it does not decide who pays.</p>
    <p class="legend"><span class="lg"><span class="mk ai">AI</span> the investigator's first step off</span><span class="lg"><span class="mk flag">rule flag</span> a simple rule's pick</span><span class="hint">Press a step to see its line in the log.</span></p>
    <ol class="trace">${rows}</ol>
    <p class="fine">${state.mandates.find((m) => m.id === state.orders.find((o) => o.id === k.orderId)?.mandateId)?.live ? 'Written by the live agent as it shopped. The catalog is ours; the steps are not, and there is no answer key.' : 'Agent logs and answer key written by us for this demo.'}</p>`;
}

function keyBox(kind, key, inv) {
  if (kind === 'code') {
    const reasons = (key.reasons || [])
      .map((r) => {
        if (INTEGRITY[r]) return `<li>${esc(INTEGRITY[r])}</li>`;
        const f = inv.facts?.[r];
        const ev = f?.evidence?.[0];
        return `<li><span class="ans ${esc(f?.value || 'unknown')}">${esc(f?.value || 'unknown')}</span> ${esc(label(FACT_LABELS, r))}${ev?.quote ? `<q>${esc(ev.quote)}</q>` : ''}</li>`;
      })
      .join('');
    return `<div class="key k-code"><span class="kh">Rules key: fixed rules in code</span><strong>${esc(label(WHO_SHORT, key.liable))}</strong>
      <span class="kr">Rule ${esc(key.rule)}. ${esc(label(RULES, key.rule))}</span>${reasons ? `<ul class="kreasons">${reasons}</ul>` : ''}</div>`;
  }
  // The AI key shows its conclusion only. Its own wording is not put on screen as an argument.
  const src = aiKeySource(key, inv);
  return `<div class="key k-ai"><span class="kh">AI key: the investigator's verdict</span><strong>${esc(label(WHO_SHORT, key.liable))}</strong><span class="kr">${src}</span></div>`;
}

function keysPair(inv) {
  const same = inv.codeKey.liable === inv.aiKey.liable;
  return `<div class="keys">${keyBox('code', inv.codeKey, inv)}<div class="gate ${same ? 'g-open' : 'g-shut'}" aria-label="${same ? 'same' : 'different'}">${same ? '=' : '≠'}</div>${keyBox('ai', inv.aiKey, inv)}</div>`;
}

/** Ledger lines for this order at or after a moment (server times on both sides). */
const linesSince = (orderId, iso) => state.ledger.filter((l) => l.orderId === orderId && iso && l.at >= iso);

function movedList(lines) {
  return `<ul class="moved">${lines
    .map((l) => `<li><span>${esc(label(KINDS, l.kind))}${l.memo ? ' <span class="tag">memo</span>' : l.simulated ? ' <span class="tag sim">ledger only</span>' : ''}</span><span class="num">${usd(l.cents)}</span></li>`)
    .join('')}</ul>`;
}

function keysCard(k, order, working) {
  const inv = k.investigation;
  if (!inv?.codeKey || !inv?.aiKey) {
    return `<div class="card stage-card"><h3>Two keys</h3><p class="sub">${working === 'investigate' ? '<span class="spinner"></span>' : ''}The rules key and the AI key each name who is responsible. A re-charge, the store's payout or an agent invoice happens only when they name the same party.</p></div>`;
  }
  const v = k.verdict;
  let outcome = '';
  if (v) {
    const moved = linesSince(order.id, v.decidedAt);
    const list = moved.length ? movedList(moved) : '<p class="sub">Nothing has moved yet.</p>';
    if (v.rule === 'R0') outcome = `<div class="result"><strong>The records could not be tied together.</strong> Neither key is used; the buyer keeps the refund.</div>${list}`;
    else if (v.rule === 'OPERATOR') outcome = `<div class="result wait"><strong>The keys differed. A person chose ${esc(label(WHO_SHORT, v.liable).toLowerCase())}</strong> at ${time(v.decidedAt)}${v.note ? `: <q>${esc(v.note)}</q>` : '.'} Ledger lines since that choice:</div>${list}`;
    else if (v.liable === 'BUYER') outcome = `<div class="result"><strong>Both keys name the buyer.</strong> ${buyerKeysLine(k)} Ledger lines since the keys agreed:</div>${list}`;
    else outcome = `<div class="result go"><strong>${v.liable === 'UNDETERMINED' ? 'Both keys say nobody can be named, so the desk absorbs it.' : `Both keys name ${esc(label(WHO_IN, v.liable))}.`}</strong> Only then did the desk act. Ledger lines since the keys agreed:</div>${list}`;
  }
  return `<div class="card stage-card"><h3>Two keys</h3>${keysPair(inv)}${outcome}${factsAndRecords(inv)}</div>`;
}

function factsAndRecords(inv) {
  if (!inv?.facts) return '';
  const rows = Object.entries(inv.facts)
    .map(([key, f]) => {
      const ev = f.evidence?.[0];
      const src = ev ? `${esc(inv.evidence?.[ev.doc]?.title || label(DOCS, ev.doc))}: <q>${esc(ev.quote)}</q>${ev.computed ? ' <span class="tag">computed by code</span>' : ''}` : inv.downgraded?.includes(key) ? '<span class="tag sim">quote not found in the record: discarded</span>' : 'the records do not settle this';
      return `<tr><td>${esc(label(FACT_LABELS, key))}</td><td class="${esc(f.value)}">${esc(f.value)}</td><td class="src">${src}</td></tr>`;
    })
    .join('');
  return `<details class="records"><summary>The seven facts the rules key read</summary>
    <p class="sub" style="margin:6px 0">Each answer must quote a record; a quote that is not in the record is thrown out. Code computes the mandate, limit, charge and quantity facts itself.</p>
    <table><thead><tr><th>Question</th><th>Answer</th><th>From the record</th></tr></thead><tbody>${rows}</tbody></table></details>
    <details class="records"><summary>Open the records that were compared</summary>
    ${Object.values(inv.evidence || {}).map((d) => `<h4>${esc(d.title)}</h4><pre>${esc(d.text)}</pre>`).join('')}</details>`;
}

function operatorPanel(k, working) {
  const rv = k.review || {};
  const inv = k.investigation;
  const off = busy ? 'disabled' : '';
  const choices = ['STORE', 'AGENT', 'BUYER', 'UNDETERMINED']
    .map((who) => {
      const blocked = who === 'BUYER' && k.rechargeClosed;
      return `<button class="choice${who === 'BUYER' ? ' c-buyer' : ''}" data-act="resolve" data-liable="${who}" ${off || (blocked ? 'disabled' : '')}${blocked ? ' title="The quick check closed the re-charge for this order"' : ''}>${esc(WHO_SHORT[who])}</button>`;
    })
    .join('');
  return `<div class="card op"><div class="op-head"><h3>A person decides</h3><span class="since">waiting since ${time(rv.openedAt)}</span></div>
    <p>${esc(label(REVIEW_REASONS, rv.reason))} Until someone chooses, nothing moves: no re-charge, no store payout, no invoice to the agent's operator.</p>
    ${inv?.codeKey && inv?.aiKey ? keysPair(inv) : ''}
    ${inv?.steps ? `<h4 class="op-sub">Where the agent left the mandate</h4>${traceHtml(k)}` : ''}
    <div class="choose">
      <label for="review-note">Note for the record (optional)</label>
      <textarea id="review-note" rows="2" placeholder="What you checked"></textarea>
      <p class="sub">Who is responsible? Choosing the buyer still sends a notice and leaves time to dispute.${k.rechargeClosed ? ' The buyer cannot be chosen here: the quick check already closed the re-charge.' : ''}</p>
      <div class="row">${working === 'resolveReview' ? '<span class="spinner"></span>' : ''}${choices}</div>
    </div>
    ${factsAndRecords(inv)}</div>`;
}

function afterCard(k, order) {
  const rows = [];
  for (const e of k.events || []) {
    const at = `<span class="when">${time(e.at)}</span>`;
    if (e.type === 'REVIEW_RESOLVED') rows.push(`<li class="done">${at}<div class="what">A person chose: ${esc(label(WHO_SHORT, e.liable))}</div></li>`);
    if (e.type === 'NOTICE_SENT') rows.push(`<li class="done">${at}<div class="what">Notice sent to the buyer</div><div class="detail">No charge before ${day(e.chargeNotBefore)} (${state.policy.noticeBusinessDays} business days).</div></li>`);
    if (e.type === 'DISPUTE_FILED') rows.push(`<li class="halt">${at}<div class="what">The buyer disputed</div><div class="detail">${k.recharge ? 'The re-charge is stopped for good.' : 'Kept on file with the case.'}</div></li>`);
    if (e.type === 'RECHARGE_HALTED' && e.reason !== 'BUYER_DISPUTED') rows.push(`<li class="halt">${at}<div class="what">Re-charge stopped</div><div class="detail">${esc(label(REASONS, e.reason))}</div></li>`);
    if (e.type === 'RECHARGE_COMPLETED') rows.push(`<li class="money">${at}<div class="what">Saved wallet charged again</div><div class="detail">${usd(e.amountCents)}, buyer not present, capture ${esc(e.captureId)}.</div></li>`);
    if (e.type === 'STORE_PAID') rows.push(`<li class="money">${at}<div class="what">Store paid from ${e.source === 'desk:reserve' ? "the desk's own funds" : 'the purchase money'}</div><div class="detail">PayPal payout item: ${esc(e.payoutItemStatus || 'unknown')}.</div></li>`);
    if (e.type === 'STORE_PAYOUT_FAILED') rows.push(`<li class="halt">${at}<div class="what">Store payout failed</div><div class="detail">${esc(e.error || '')}</div></li>`);
    if (e.type === 'STORE_PAYOUT_UNCONFIRMED') rows.push(`<li class="halt">${at}<div class="what">Store payout sent, no answer from PayPal yet</div><div class="detail">${esc(e.error || '')}. Sent again under the same id on the next fast-forward or ledger check; PayPal never pays it twice.</div></li>`);
    if (e.type === 'STORE_PAYOUT_PENDING') rows.push(`<li class="halt">${at}<div class="what">Store payout sent, not confirmed yet</div><div class="detail">PayPal payout item: ${esc(e.payoutItemStatus || 'no status yet')}. Looked up again on the next fast-forward or ledger check.</div></li>`);
    if (e.type === 'RESERVE_SHORTFALL') rows.push(`<li class="halt">${at}<div class="what">The desk's own funds are short</div><div class="detail">The store payment waits for an operator.</div></li>`);
  }
  const sp = order.storePayable;
  if (sp.status === 'PAID' && sp.simulated) rows.push(`<li class="done"><span class="when">${time(sp.paidAt)}</span><div class="what">Store paid from ${sp.source === 'desk:reserve' ? "the desk's own funds" : 'the purchase money'} <span class="tag sim">ledger only</span></div><div class="detail">No store PayPal account is configured, so this payment is recorded but not sent.</div></li>`);
  if (sp.storeOwesBack && k.verdict) rows.push(`<li class="halt"><div class="what">The store was paid before the report</div><div class="detail">It is responsible, so it owes ${usd(sp.cents)} back. Recorded only; the desk's own funds cover the buyer's refund.</div></li>`);
  if (sp.needsPerson) rows.push(`<li class="halt"><div class="what">Store payout: no answer from PayPal for about 30 days</div><div class="detail">Not sent again (PayPal forgets the payout id after 30 days). A person checks the PayPal account.</div></li>`);
  if (sp.status === 'CANCELLED' && k.verdict) rows.push(`<li class="halt"><div class="what">Store is not paid for this order</div><div class="detail">The amount set aside for it is released.</div></li>`);
  if (!rows.length) return '';
  return `<div class="card stage-card"><h3>After the decision</h3><ol class="steps">${rows.join('')}</ol></div>`;
}

// ---- money column ---------------------------------------------------------------------------------------
/** Which part of the sequence a ledger line belongs to, from server times. */
function stageOf(l, k) {
  if (!k || l.at < k.receivedAt) return null;
  const v = k.verdict;
  if (v?.decidedAt && l.at >= v.decidedAt) return v.rule === 'OPERATOR' ? ['after a person chose', 'wait'] : v.agreed ? ['after both keys agreed', 'keys'] : ['after the decision', 'keys'];
  if (!k.quick?.startedAt || l.at < k.quick.startedAt) return ['before any check', 'go'];
  return k.quick?.closed ? ['after the quick check', 'go'] : ['during the checks', ''];
}

function heldCard(k, order) {
  const since = k.review?.openedAt;
  const after = linesSince(order.id, since);
  const sum = (kind) => after.filter((l) => l.kind === kind).reduce((s, l) => s + l.cents, 0);
  const rows = [
    ['Re-charge to the buyer', sum('RECHARGE_CAPTURED')],
    ['Payout to the store', sum('STORE_PAID')],
    ["Invoice to the agent's operator", sum('AGENT_COMPANY_OWES')],
    ...(k.refund?.completedAt ? [] : [['Refund to the buyer', sum('REFUND')]]),
  ];
  return `<div class="card held"><h3>Held while a person decides</h3>
    <p class="sub">Moved since the keys differed at ${time(since)}, read from the ledger:</p>
    <table><tbody>${rows.map(([what, cents]) => `<tr><td>${what}</td><td class="num">${usd(cents)}</td></tr>`).join('')}</tbody></table></div>`;
}

function moneyColumn({ order, kase: k }) {
  if (!order) return `<div class="card"><p class="sub">No money has moved.</p></div>`;
  const lines = state.ledger.filter((l) => l.orderId === order.id);
  const net = {};
  for (const l of lines) {
    if (l.memo) continue;
    net[l.to] = (net[l.to] || 0) + l.cents;
    net[l.from] = (net[l.from] || 0) - l.cents;
  }
  let html = k?.status === 'HUMAN_REVIEW' ? heldCard(k, order) : '';
  html += `<div class="card"><h3>This order, party by party</h3>
    <table><thead><tr><th>Party</th><th class="num">Net</th></tr></thead><tbody>
    ${Object.keys(ACCOUNTS).map((a) => `<tr><td>${ACCOUNTS[a]}</td><td class="num ${net[a] > 0 ? 'pos' : net[a] < 0 ? 'neg' : ''}">${signed(net[a] || 0)}</td></tr>`).join('')}
    </tbody></table>
    <p class="sub" style="margin-top:8px">Desk's own funds: ${usd(state.funds.reserveBalanceCents)} of ${usd(state.funds.reserveStartCents)} left, ${usd(state.funds.reserveAllocatedCents)} set aside for open cases.</p>
    <div class="row" style="margin-top:10px"><button class="ghost" data-act="reconcile" ${busy ? 'disabled' : ''}>Check the ledger against PayPal</button></div>
    ${reconciliation && reconciliation.orderId === order.id ? reconciliationTable(reconciliation) : ''}
  </div>`;
  html += `<div class="card"><h3>Ledger</h3><table class="ledger"><thead><tr><th>What, from whom to whom</th><th class="num">Amount</th></tr></thead><tbody>
    ${lines
      .map((l) => {
        const stage = stageOf(l, k);
        const chip = stage ? `<span class="stagechip ${stage[1]}">${stage[0]}</span>` : '';
        return l.memo
          ? `<tr><td><strong>${esc(label(KINDS, l.kind))}</strong> <span class="tag">memo</span><span class="src">${esc(l.note)}</span>${chip}</td><td class="num">${usd(l.cents)}</td></tr>`
          : `<tr><td><strong>${esc(label(KINDS, l.kind))}</strong> ${l.simulated ? '<span class="tag sim">ledger only</span>' : l.paypal?.id ? '<span class="tag real">PayPal</span>' : '<span class="tag">between desk accounts</span>'}<span class="src">${esc(ACCOUNTS[l.from] || l.from)} to ${esc(ACCOUNTS[l.to] || l.to)}${l.paypal?.id && !l.simulated ? `, <code>${esc(l.paypal.id)}</code>` : ''}</span>${chip}</td><td class="num">${usd(l.cents)}</td></tr>`;
      })
      .join('')}
    </tbody></table></div>`;
  const calls = state.paypalCalls.slice(-14);
  html += `<div class="card"><details><summary>PayPal API calls made by the desk (latest ${calls.length})</summary>
    <table><thead><tr><th>Call</th><th>HTTP</th><th class="num">ms</th></tr></thead><tbody>
    ${calls.map((c) => `<tr><td><code>${esc(c.method)} ${esc(String(c.path).replace(/[A-Z0-9-]{12,}/g, '…'))}</code><div class="src">${esc(c.label)}</div></td><td>${esc(c.status)}</td><td class="num">${esc(c.ms)}</td></tr>`).join('')}
    </tbody></table></details></div>`;
  return html;
}

function reconciliationTable(r) {
  return `<table style="margin-top:10px"><thead><tr><th>Party</th><th class="num">Ledger</th><th class="num">PayPal</th><th></th></tr></thead><tbody>
    ${r.rows.map((row) => `<tr><td>${ACCOUNTS[row.party]}</td><td class="num">${signed(row.ledgerCents)}</td><td class="num">${signed(row.paypalCents)}</td><td class="${row.match ? 'yes' : 'no'}">${row.match ? 'match' : 'differs'}</td></tr>`).join('')}
    </tbody></table>
    <p class="sub">Looked up just now: ${r.lookups.map((l) => `${l.type.replace('_', ' ')} ${esc(l.status)}`).join(', ')}.${r.simulatedStoreCents ? ` ${usd(r.simulatedStoreCents)} to the store is ledger only and is not part of this comparison.` : ''}${r.storeUnknown ? ' <strong>The store payout got no answer from PayPal yet, so this order cannot be called a match.</strong>' : ''}</p>`;
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
  const livePrompt = event.target.closest('[data-live-prompt]');
  if (livePrompt) {
    reconciliation = null;
    await act('liveMandate', { promptId: livePrompt.dataset.livePrompt });
    $('stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const stepButton = event.target.closest('[data-step]');
  if (stepButton) {
    const { kase } = current();
    const key = `${kase.id}:${stepButton.dataset.step}`;
    openSteps.set(key, stepButton.getAttribute('aria-expanded') !== 'true');
    render();
    return;
  }
  const button = event.target.closest('[data-act]');
  if (!button || button.disabled) return;
  const { mandate, order, kase } = current();
  const name = button.dataset.act;
  if (name === 'liveOwn') {
    reconciliation = null;
    const made = await act('liveMandate', { instruction: $('own-instruction').value }, 'liveMandate');
    if (made) $('stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (name === 'shop') await act('shop', { mandateId: mandate.id, kind: button.dataset.kind }, 'shop');
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
    if (reported) await act('investigate', { caseId: reported.caseId }, 'investigate');
  }
  if (name === 'resolve') {
    const note = $('review-note')?.value || '';
    await act('resolveReview', { caseId: kase.id, liable: button.dataset.liable, note }, 'resolveReview');
  }
  if (name === 'dispute') await act('dispute', { caseId: kase.id, text: 'I do not agree that this was my mistake.' }, 'dispute');
  if (name === 'fastForward') await act('fastForward', { days: 8 }, 'fastForward');
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
