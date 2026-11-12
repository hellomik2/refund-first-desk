// The buyer's side: what the person sees, from the instruction to the last notice.
// On top, the moment: one big number for where this purchase is now, from server state only.
import { S, esc, sentences, usd, time, day, secs, humanize, label, refundTiming, REASONS, NOTICES } from './shared.js';
import { limitCard } from './casebook.js';
import { unpaidOrderView } from './payment.js';

const AGENT_SAYS = {
  careful: 'Bound by the approved conditions. Sees product pages and the cart total.',
  hasty: 'Graded on speed. Sees only titles and prices, no product page or cart.',
};

// ---- the moment ----------------------------------------------------------------------------------------
/** One big value with an optional unit after it, e.g. big('1.97', 's'). */
const big = (value, unit = '') => ({ value: String(value), unit });

/** What the buyer's moment is now: a label, one big value, one line. Null when there is nothing to show. */
function moment({ mandate, order, kase: k }, working) {
  const live = mandate.live;
  if (!order) {
    if (live?.status === 'RUNNING' || (live && working === 'shop' && !live.finishedAt)) return { label: 'Tool calls so far', giant: big(live.steps?.length || 0) };
    if (live?.status === 'NOT_PAID') return { label: 'The agent did not pay', giant: big('$0.00', 'charged'), tone: 'green' };
    if (live?.status) return null;
    const cap = mandate.conditions.maxTotalCents;
    if (cap == null) return null;
    return { label: mandate.status === 'DRAFT' ? 'Spending limit to approve' : 'Spending limit, approved', giant: big(usd(cap), 'total') };
  }
  const unpaid = unpaidOrderView(order, { busy: S.busy });
  if (unpaid) {
    // "Nothing charged" only where it is known (payment.js): a refusal or a buyer who turned back at PayPal.
    if (unpaid.kind === 'consent-cancelled') return { label: 'Cancelled at PayPal', giant: big('$0.00', 'charged'), line: 'You turned back on the PayPal screen. Pick a case to start again.' };
    if (unpaid.kind === 'consent-waiting') return { label: 'Waiting for you at PayPal', giant: big(usd(order.totalCents)), line: 'Not paid yet.' };
    if (unpaid.kind === 'refused') return { label: 'PayPal refused the payment', giant: big('$0.00', 'charged') };
    if (unpaid.kind === 'paying') return { label: 'Paying from the saved wallet', giant: big(usd(order.totalCents)), line: 'Sending the payment to PayPal.' };
    if (unpaid.kind === 'unconfirmed') return { label: order.payment === 'CONSENT_CHECKOUT' ? 'Sent after your approval at PayPal' : 'Sent from the saved wallet', giant: big(usd(order.totalCents)), tone: 'yellow', line: order.pendingCaptureStatus === 'PENDING' ? 'PayPal is still processing it.' : 'PayPal has not confirmed it. It may have gone through.' };
    return { label: 'Not confirmed by PayPal yet', giant: big(usd(order.totalCents)), tone: 'yellow' };
  }
  if (!k) return { label: order.payment === 'CONSENT_CHECKOUT' ? 'Paid at PayPal' : 'The agent paid', giant: big(usd(order.totalCents)) };

  const quote = `<p class="quote">You wrote: “${esc(k.statement)}”</p>`;
  if (k.verdict) return { ...outcome(k), quote };
  const refunded = k.refund?.completedAt;
  if (k.status === 'HUMAN_REVIEW') {
    return {
      label: 'A person is checking',
      giant: big('Review'),
      tone: 'yellow',
      line: refunded ? `Your ${usd(k.refund.amountCents)} refund stays with you. Nothing is charged until a person decides.` : 'The refund waits for a person. Nothing is charged meanwhile.',
      quote,
    };
  }
  if (refunded && k.path === 'REFUND_FIRST') {
    // the one section on a colour background: the money went back first
    return { label: 'Seconds after the report', giant: big(secs(k.refund.completedAtMs - k.receivedAtMs).replace(' s', ''), 's'), tone: 'green', point: true, line: sentences(`${usd(k.refund.amountCents)} refunded. PayPal refund status: COMPLETED.`), quote };
  }
  if (refunded) return { label: 'Refunded after the check', giant: big(usd(k.refund.amountCents)), tone: 'green', line: `${esc(refundTiming(k))}. PayPal refund status: COMPLETED.`, quote };
  if (k.path === 'VERIFY_FIRST') return { label: 'Checked before any refund', giant: big(usd(order.totalCents)), line: 'If it was not your mistake, the refund follows within 5 minutes. If a person has to decide, it can take longer.', quote };
  return { label: 'Refund requested', giant: big(usd(k.refund?.amountCents ?? order.totalCents)), tone: 'yellow', line: k.refund ? `PayPal says ${esc(k.refund.status)}.` : 'On its way.', quote };
}

/** After the two keys (or a person) decided. These moments carry the .stamp classes. */
function outcome(k) {
  const v = k.verdict;
  const by = v.rule === 'OPERATOR' ? 'A person decided. ' : '';
  const off = S.busy ? 'disabled' : '';
  if (v.liable !== 'BUYER') {
    const why = label({ AGENT: 'The agent went beyond what you approved.', STORE: 'The store did not deliver what was ordered.', UNDETERMINED: 'The records could not settle it.' }, v.liable);
    if (!k.refund?.completedAt) return { stamp: 'wait', label: 'Refund on its way', giant: big(usd(k.refund?.amountCents ?? orderOf(k)?.totalCents)), tone: 'yellow', line: esc(by + why) };
    return { stamp: 'info', label: 'You keep the refund', giant: big(usd(k.refund.amountCents)), tone: 'green', line: `${esc(by + why)} You will not be charged again.` };
  }
  if (!k.refund?.completedAt) {
    return {
      stamp: 'wait',
      label: 'No refund',
      giant: big('$0.00', 'refunded'),
      line: `${esc(by)}The order matches what you approved. It was checked first, so nothing is charged again either.`,
      act: k.dispute ? `<p class="m-line"><strong>Your dispute is on file</strong> since ${time(k.dispute.at)}.</p>` : `<div class="row"><button class="danger" data-act="dispute" ${off}>Dispute this decision</button></div>`,
    };
  }
  const r = k.recharge || {};
  const n = k.notice;
  const noticeStep = n ? `<li><time datetime="${esc(n.sentAt)}">${time(n.sentAt)}</time><span>Notice sent: no charge before ${day(n.chargeNotBefore)}.</span></li>` : '';
  const asSent = n ? `<details><summary>The notice as sent</summary><p class="quote">${esc(n.text)}</p></details>` : '';
  if (r.status === 'SCHEDULED') {
    return {
      stamp: 'wait',
      label: `Notice: we plan to charge ${usd(n.amountCents)} again`,
      giant: big(S.state.policy.noticeBusinessDays, 'business days to dispute'),
      tone: 'yellow',
      line: `${esc(by)}No charge before <strong>${day(n.chargeNotBefore)}</strong>, never more than ${usd(n.amountCents)}.`,
      extra: asSent,
      act: `<div class="row">
        <button class="danger" data-act="dispute" ${off}>Dispute this charge</button>
        <button class="ghost" data-act="fastForward" ${off}>Fast-forward the notice period <span class="tag sim">simulated</span></button></div>`,
    };
  }
  if (r.status === 'COMPLETED') {
    return {
      stamp: 'info',
      label: 'Charged again',
      giant: big(usd(r.amountCents)),
      tone: 'yellow',
      extra: `<ol class="seq">${noticeStep}<li><time datetime="${esc(r.at || '')}">${time(r.at)}</time><span>Charged from the saved wallet, no dispute on file.${S.state.clock?.fastForwarded ? ' <span class="tag sim">notice period fast-forwarded: simulated</span>' : ''}</span></li></ol>
        <p class="fine">PayPal capture <code>${esc(r.captureId)}</code>, in the sandbox. On live accounts, charging a saved wallet without the buyer needs PayPal's approval.</p>${asSent}`,
    };
  }
  if (r.status === 'HALTED') {
    // Say what PayPal reported for the store payout, not what was intended.
    const sp = orderOf(k)?.storePayable;
    const store = sp?.status === 'PAID' ? "the store is still paid, from the desk's own funds" : sp?.status === 'PAYOUT_FAILED' ? "the store payout from the desk's own funds did not go through, and that money stays set aside for the store" : "the store's payout from the desk's own funds is on its way at PayPal";
    return {
      stamp: 'go',
      label: 'The charge is stopped',
      giant: big(usd(k.refund.amountCents), 'kept'),
      tone: 'green',
      line: `Because ${esc(label(REASONS, r.blockedBy))}. You keep the refund; ${store}.`,
      extra: noticeStep ? `<ol class="seq">${noticeStep}</ol>${asSent}` : '',
    };
  }
  if (r.status === 'UNCONFIRMED') {
    return {
      label: 'Charge sent again',
      giant: big(usd(r.amountCents)),
      tone: 'yellow',
      line: r.captureStatus === 'PENDING' ? 'PayPal is still processing it.' : 'PayPal has not confirmed it. It may have gone through.',
      extra: `${noticeStep ? `<ol class="seq">${noticeStep}</ol>` : ''}<p class="fine">The desk asks PayPal again when the ledger is checked, under the same request id, so it never charges twice. The store is paid once PayPal answers.</p>`,
    };
  }
  if (r.status === 'PENDING') return { label: 'Charging again now', giant: big(usd(r.amountCents)), tone: 'yellow', extra: noticeStep ? `<ol class="seq">${noticeStep}</ol>` : '' };
  return { label: 'Refunded', giant: big(usd(k.refund.amountCents)), tone: 'green' };
}

const orderOf = (k) => S.state.orders.find((o) => o.id === k.orderId);

/** A line of two or more sentences gets one sentence per line; a line already made of spans is left alone. */
const lineBreaks = (html) => (html.includes('class="ln"') ? html : html.split(/(?<=[.!?])\s+(?=[A-Z"“$<])/).map((t) => `<span class="ln">${t}</span>`).join(' '));

function momentHtml(m) {
  if (!m) return '';
  const g = m.giant;
  const long = g.value.length > 7 ? ' long' : '';
  const head = m.stamp ? `<p class="big">${esc(m.label)}</p>` : `<p class="m-label">${esc(m.label)}</p>`;
  return `<div class="moment${m.stamp ? ` stamp ${m.stamp}` : ''}${m.point ? ' point' : ''}">${head}
    <p class="giant${m.tone ? ` ${m.tone}` : ''}${long}">${esc(g.value)}${g.unit ? `<small> ${esc(g.unit)}</small>` : ''}</p>
    ${m.line ? `<p class="m-line">${lineBreaks(m.line)}</p>` : ''}${m.extra || ''}${m.quote || ''}${m.act || ''}</div>`;
}

// ---- the live agent ------------------------------------------------------------------------------------
function liveStepsHtml(steps, running) {
  if (!steps?.length) return running ? '<p class="sub"><span class="spinner"></span>The agent is reading the instruction…</p>' : '';
  return `<ol class="trace live-trace">${steps
    .map((s) => `<li class="st"><div class="st-row"><span class="sn">${s.step}</span><span class="st-body"><span class="st-head"><span class="act">${esc(s.action)}</span><span class="actor">${esc(s.actor)}</span></span><span class="st-text">${esc(s.content)}</span></span></div></li>`)
    .join('')}${running ? '<li class="st"><div class="st-row"><span class="sn"><span class="spinner"></span></span><span class="st-body"><span class="st-text">thinking…</span></span></div></li>' : ''}</ol>`;
}

function liveAgentCard(mandate, working) {
  const live = mandate.live;
  const off = S.busy ? 'disabled' : '';
  if (!live.status) {
    return `<div class="card"><h3>Give this to a live AI agent</h3>
      <p class="sub">Same model and catalog. If it decides to pay, it pays from the saved PayPal wallet: a real sandbox charge, with no second ask.</p>
      <div class="agent-pick">${['careful', 'hasty']
        .map((k) => `<div class="agent-opt"><button class="${k === 'careful' ? 'primary' : 'danger'}" data-act="shop" data-kind="${k}" ${off}>${working === 'shop' ? '<span class="spinner"></span>' : ''}Run the ${k} agent</button><p class="sub">${esc(AGENT_SAYS[k])}</p></div>`)
        .join('')}</div></div>`;
  }
  const running = live.status === 'RUNNING' || (working === 'shop' && !live.finishedAt);
  const who = live.kind === 'hasty' ? 'The hasty agent' : 'The careful agent';
  const cost = live.finishedAt ? ` ${live.calls} model calls, $${(live.usd || 0).toFixed(4)} of AI.` : '';
  let tail = '';
  if (live.status === 'NOT_PAID') tail = `<div class="result"><strong>It did not pay.</strong> Nothing was charged. Pick another instruction to try again.</div>`;
  if (live.status === 'PAYMENT_UNCONFIRMED') tail = `<div class="result wait"><strong>PayPal did not confirm the payment.</strong> It may have gone through. No second payment was sent; the next try asks PayPal about this one, same request id.</div>`;
  if (live.status === 'FAILED') tail = `<div class="result"><strong>The run stopped:</strong> ${esc(live.error || 'error')}.</div>`;
  return `<div class="card"><h3>${who} ${running ? 'is shopping' : 'shopped'}, step by step</h3>
    <p class="sub">One line per tool call, as it happened. The investigator reads this log.${cost}</p>
    ${liveStepsHtml(live.steps, running)}${tail}</div>`;
}

// ---- the buyer's own cards -------------------------------------------------------------------------------
function mandateCard(mandate, spin, folded) {
  const c = mandate.conditions;
  const body = `<p class="quote">“${esc(mandate.instruction)}”</p>
    <dl class="slots">
      <dt>Item</dt><dd>${esc(c.item || '(not specified)')}</dd>
      <dt>Quantity</dt><dd>${esc(c.quantity ?? '(not specified)')}</dd>
      <dt>Spending limit</dt><dd>${c.maxTotalCents == null ? '(none)' : `${usd(c.maxTotalCents)} total`}</dd>
      <dt>Must not include</dt><dd>${c.exclusions?.length ? esc(c.exclusions.join('; ')) : '(nothing listed)'}</dd>
      <dt>May pay without asking again</dt><dd class="flag">${c.purchaseAuthorized ? 'yes' : 'no'}</dd>
    </dl>
    ${
      mandate.status === 'DRAFT'
        ? `<div class="row"><button class="primary" data-act="approve" ${S.busy ? 'disabled' : ''}>${spin}Approve these conditions</button><span class="sub">Once, before anything is bought.</span></div>`
        : `<p class="fine">Approved at ${time(mandate.approval.at)}. Fingerprint <code>${esc(mandate.fingerprint.slice(0, 12))}…</code> is in the PayPal order.</p>`
    }`;
  if (folded) return `<details class="card fold"><summary>What the buyer approved</summary>${body}</details>`;
  return `<div class="card"><h3>What the buyer told the agent</h3>${body}</div>`;
}

function orderCards(mandate, order, spin) {
  const off = S.busy ? 'disabled' : '';
  if (!order || order.consentCancelled) return ''; // a cancelled checkout is said in the moment
  const unpaidNow = order.paypal ? null : unpaidOrderView(order, { busy: S.busy });
  if (unpaidNow && unpaidNow.kind !== 'consent-waiting') {
    if (mandate.live && order.payment !== 'CONSENT_CHECKOUT') return ''; // the live agent card says it itself
    const unpaid = unpaidNow;
    // only a saved-wallet payment is asked again from here, under its own request id; a sent consent capture has no Cancel
    const ask = unpaid.kind === 'unconfirmed' && order.payment !== 'CONSENT_CHECKOUT';
    return `<div class="card"><h3>${unpaid.kind === 'paying' ? '<span class="spinner"></span>' : ''}${esc(unpaid.title)}</h3><p class="sub">${esc(unpaid.text)}</p>
      ${ask ? `<div class="row"><button class="primary" data-act="purchase" ${off}>${spin}Ask PayPal about this payment again</button></div>` : ''}</div>`;
  }
  if (!order.paypal) {
    return `<div class="card"><h3>Waiting for the buyer at PayPal</h3>
      <p class="sub">One PayPal screen: the payment, and saving the wallet for the agent.</p>
      <div class="row">${order.approveUrl ? `<a class="primary" href="${esc(order.approveUrl)}">Continue at PayPal</a>` : ''}
      <button class="ghost" data-act="cancelConsent" ${off}>Cancel</button></div></div>`;
  }
  const atPayPal = order.payment === 'CONSENT_CHECKOUT';
  const saved = S.state.buyers[0]?.wallet?.source === 'OWN';
  const limit = limitCard(order, S.state);
  return `<div class="card"><h3>${atPayPal ? 'The buyer paid at PayPal' : 'The agent bought this'} at ${esc(order.store.name)}</h3>
    <ul class="items">${order.cart.map((l) => `<li><span>${l.qty} × ${esc(l.name)}</span><span class="num">${usd(l.unitCents * l.qty)}</span></li>`).join('')}
    <li class="total"><span>${atPayPal ? (saved ? 'Paid at PayPal; wallet saved for the agent' : 'Paid at PayPal; wallet not saved') : 'Paid from the saved PayPal wallet'}</span><span class="num">${usd(order.totalCents)}</span></li></ul>
    <p class="fine">PayPal order <code>${esc(order.paypal.orderId)}</code></p>
    ${!limit ? '' : order.protection.limits.basis.length ? limit : `<details><summary>Instant-refund limit for this order</summary>${limit}</details>`}</div>`;
}

// ---- buyer column ---------------------------------------------------------------------------------------
export function buyerColumn(cur, working) {
  const { mandate, order, kase, sc } = cur;
  const spin = working ? `<span class="spinner"></span>` : '';
  const off = S.busy ? 'disabled' : '';
  let html = momentHtml(moment(cur, working));
  if (kase) html += noticesCard(kase);
  if (order?.paypal && !kase) {
    html += `<div class="card"><h3>Something wrong? One sentence.</h3>
      <textarea id="statement" aria-label="What went wrong">${esc(sc?.complaint || (mandate.live ? 'This is not what I asked the agent to buy.' : ''))}</textarea>
      <div class="row"><button class="primary" data-act="report" ${off}>${spin}Report it</button><span class="sub">The buyer's only step.</span></div></div>`;
  }
  if (!order) html += mandateCard(mandate, spin, false);
  if (mandate.status === 'APPROVED' && !order && !mandate.live) {
    html += `<div class="card"><h3>The agent goes shopping</h3>
      <p class="sub">It pays from the saved PayPal wallet. Nobody is asked again at checkout.</p>
      <div class="row"><button class="primary" data-act="purchase" ${off}>${spin}Let the agent shop and pay</button>
      <button class="ghost" data-act="consentPurchase" ${off}>Pay at PayPal and save the wallet</button></div>
      <details><summary>How the wallet gets saved, and what that needs</summary><p class="sub">Pay this order at PayPal yourself and agree to save the wallet for the agent. You need a PayPal sandbox personal account; sign in at <code>sandbox.paypal.com</code> first.</p></details></div>`;
  }
  html += orderCards(mandate, order, spin);
  if (mandate.live && mandate.status === 'APPROVED') html += liveAgentCard(mandate, working);
  if (order) html += mandateCard(mandate, spin, true);
  return html;
}

// ---- notices -------------------------------------------------------------------------------------------
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
  return `<li class="note n-${meta.tone}">
    <div class="nt"><strong>${esc(meta.title)}</strong><time datetime="${esc(n.at)}">${time(n.at)}</time></div>
    <p>${esc(n.text)}</p>${measured ? `<p class="meta">${measured}</p>` : ''}</li>`;
}
