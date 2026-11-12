// Demo UI. The page is a pure function of the workspace state the server returns; every button
// calls one desk action and re-renders. Nothing here decides anything about money.
// Every time and duration on screen comes from the server's own timestamps. The page waits 1.4 s
// between the report and the check so the refund can be seen on its own; no duration shown
// includes that wait.
import { refreshCaseBook } from './casebook.js';
import { aiPillText } from './ailabels.js';
import { S, $ } from './shared.js';
import { failureView } from './failure.js';
import { renderCases, renderLive } from './view-home.js';
import { railHtml } from './view-rail.js';
import { buyerColumn } from './view-buyer.js';
import { deskColumn } from './view-desk.js';
import { moneyColumn } from './view-money.js';

// ---- server ----------------------------------------------------------------------------------------
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.message || 'Request failed'), { code: json.error, status: res.status });
  return json;
}

async function act(name, body = {}, label = '') {
  if (S.busy) return null;
  S.busy = true;
  render(label);
  const watch = watchProgress(label);
  try {
    const result = await api(`/api/act/${name}`, { ws: S.state.workspace, ...body });
    watch.stop();
    S.state = result.state;
    return result;
  } catch (err) {
    const v = failureView(err);
    if (v.stays) gone(v.text);
    else toast(v.text);
    return null;
  } finally {
    watch.stop();
    S.busy = false;
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
      const res = await fetch(`/api/state?ws=${encodeURIComponent(S.state.workspace)}`, { cache: 'no-store' });
      const text = res.ok ? await res.text() : '';
      // The policy clock ticks on every read; only a real change redraws (an opened record stays open).
      const key = text.replace(/"clock":\{[^}]*\}/, '');
      if (!stopped && text && key !== last) {
        last = key;
        S.state = JSON.parse(text);
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

/** A failure that a retry cannot fix stays on screen with its way out (a fresh workspace). */
function gone(message) {
  $('gone-text').textContent = message;
  $('gone').hidden = false;
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
  S.cases = (await api('/api/cases')).cases;
  S.catalog = await api('/api/catalog').catch(() => null);
  // Coming back from the PayPal approval screen: the workspace id rides on the return URL.
  const params = new URLSearchParams(location.search);
  if (params.has('ws')) {
    localStorage.setItem('rfd-workspace', params.get('ws'));
    if (RETURN_NOTES[params.get('paypal')]) setTimeout(() => toast(RETURN_NOTES[params.get('paypal')]), 300);
    history.replaceState(null, '', '/');
  }
  const saved = !fresh && localStorage.getItem('rfd-workspace');
  S.state = null;
  if (saved) {
    try {
      S.state = await api(`/api/state?ws=${saved}`);
    } catch {
      S.state = null;
    }
  }
  if (!S.state) S.state = await api('/api/workspaces', {});
  localStorage.setItem('rfd-workspace', S.state.workspace);
  S.reconciliation = null;
  $('gone').hidden = true;
  render();
}

// ---- what is on screen now ---------------------------------------------------------------------------
function current() {
  const mandate = S.state.mandates.at(-1) || null;
  // After a refused payment the agent may pay again: the order that was paid is the one on screen.
  const mine = mandate ? S.state.orders.filter((o) => o.mandateId === mandate.id) : [];
  const order = mine.find((o) => o.paypal) || mine.at(-1) || null;
  const kase = order ? S.state.cases.find((c) => c.orderId === order.id) || null : null;
  const sc = mandate ? S.cases.find((c) => c.id === mandate.caseId) || null : null;
  return { mandate, order, kase, sc };
}

function render(working = '') {
  if (!S.state) return;
  const cur = current();
  $('ai-pill').textContent = aiPillText(S.state.flags, cur.kase);
  renderCases(cur);
  refreshCaseBook(S.state, S.cases);
  renderLive(cur);
  // The order of the steps is shown at the top of the page; the case's own line appears once a case is picked.
  $('stage').hidden = !cur.mandate;
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

// ---- events -----------------------------------------------------------------------------------------------
document.addEventListener('click', async (event) => {
  const caseButton = event.target.closest('[data-case]');
  if (caseButton) {
    S.reconciliation = null;
    await act('mandate', { caseId: caseButton.dataset.case });
    $('stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (event.target.closest('[data-toggle-all]')) {
    S.showAll = !S.showAll;
    render();
    return;
  }
  const livePrompt = event.target.closest('[data-live-prompt]');
  if (livePrompt) {
    S.reconciliation = null;
    await act('liveMandate', { promptId: livePrompt.dataset.livePrompt });
    $('stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const stepButton = event.target.closest('[data-step]');
  if (stepButton) {
    const { kase } = current();
    const key = `${kase.id}:${stepButton.dataset.step}`;
    S.openSteps.set(key, stepButton.getAttribute('aria-expanded') !== 'true');
    render();
    return;
  }
  const button = event.target.closest('[data-act]');
  if (!button || button.disabled) return;
  const { mandate, order, kase } = current();
  const name = button.dataset.act;
  if (name === 'liveOwn') {
    S.reconciliation = null;
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
      S.reconciliation = result.reconciliation;
      render();
    }
  }
});
$('reset').addEventListener('click', () => start(true));
$('gone-restart').addEventListener('click', () => start(true));

start().catch((err) => toast(`Could not start: ${err.message}`));
