// The line of steps at the top of a case: where this case is now, and what comes next.
import { S, $, esc, sentences, usd, signed, time, day, secs, humanize, label, linesSince, refundTiming, REASONS, FACT_LABELS, FACT_SHORT, INTEGRITY, RULES, WHO, WHO_SHORT, WHO_IN, DOCS, DOCS_IN, NOTICES, REVIEW_REASONS, ACCOUNTS, KINDS } from './shared.js';

// ---- the line: the order of operations is the product ------------------------------------------------
const lockIcon = (open) =>
  `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3" y="7.2" width="10" height="7" rx="1.6" fill="currentColor"/><path d="M5.2 7.2V5a2.8 2.8 0 0 1 5.6 0${open ? '' : 'v2.2'}" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>`;

export function stations({ order, kase: k }, working) {
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
      : { state: 'money', sub: `${usd(k.refund.amountCents)} in ${secs(k.refund.completedAtMs - k.receivedAtMs)}, before the purchase is checked` };
  } else if (k && verifyFirst && v?.liable === 'BUYER') st.refund = { state: 'skip', sub: 'no refund: the order matches' };
  else if (review) st.refund = { state: 'hold', sub: 'held until a person decides' };
  else if (k?.refund) st.refund = { state: 'todo', sub: `PayPal says ${k.refund.status}` };
  else st.refund = { state: 'todo', sub: verifyFirst ? 'within 5 minutes if not the buyer' : 'before the purchase is checked' };

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

export function railHtml(cur, working) {
  const { verifyFirst, list } = stations(cur, working);
  const reached = (s) => s && !['todo', 'skip'].includes(s.state);
  let here = -1;
  list.forEach((s, i) => {
    if (reached(s) && s.state !== 'closed') here = i; // a step closed for good is never "now"
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
  const now = list[here];
  const caption = now ? `${now.name}: ${now.sub}` : 'Nothing has happened yet';
  const { title, lead } = scene(cur, working, verifyFirst);
  return `<ol class="rail" aria-label="Steps of this case, in order">${items}</ol><p class="rail-now">${esc(caption)}</p>
    <div class="rail-head"><h2>${sentences(title)}</h2>${lead ? `<p>${sentences(lead)}</p>` : ''}</div>`;
}

/** The headline of the moment on screen: one sentence for where this case is now, from server state only. */
function scene({ mandate, order, kase: k }, working, verifyFirst) {
  const v = k?.verdict;
  const r = k?.recharge;
  if (!mandate) return { title: 'Pick a case to start.' };
  if (mandate.status === 'DRAFT') return { title: 'The buyer approves the conditions once.', lead: 'Before anything is bought. They are fixed into the PayPal order.' };
  if (mandate.live && !order) {
    const live = mandate.live;
    if (live.status === 'NOT_PAID') return { title: 'The agent stopped without paying.' };
    if (live.status === 'PAYMENT_UNCONFIRMED') return { title: 'PayPal has not confirmed the payment.' };
    if (live.status === 'FAILED') return { title: 'The agent run stopped.' };
    return live.status || working === 'shop' ? { title: 'A live AI agent is shopping.', lead: 'Each line is one tool call it made.' } : { title: 'Give this to a live AI agent.' };
  }
  if (!order) return { title: 'The agent shops and pays from the saved wallet.', lead: 'Nobody is asked again at checkout.' };
  if (!order.paypal) {
    if (order.consentCancelled) return { title: 'Cancelled at PayPal. Nothing was charged.' };
    if (order.payment === 'CONSENT_CHECKOUT') return { title: 'Waiting for the buyer at PayPal.' };
    if (order.storePayable?.status === 'PAYMENT_UNCONFIRMED') return { title: 'PayPal has not confirmed this payment.' };
    return { title: 'PayPal refused the payment. Nothing was charged.' };
  }
  if (!k) return working === 'report' ? { title: 'Sending the report.' } : { title: 'Paid. Something wrong? One sentence is enough.' };
  if (k.status === 'HUMAN_REVIEW') return { title: 'The two keys differ. A person decides.', lead: 'Nothing is charged or paid out meanwhile.' };
  if (v?.liable === 'BUYER') {
    if (!k.refund?.completedAt) return { title: 'The order matches what the buyer approved. No refund.', lead: 'The check came first here, so there is nothing to take back.' };
    if (r?.status === 'COMPLETED') return { title: 'Charged again after the notice period.', lead: 'Never for more than was refunded.' };
    if (r?.status === 'HALTED') return { title: 'The re-charge is stopped. The buyer keeps the refund.' };
    return { title: 'Here the buyer was responsible: notice first.', lead: 'A dispute before the date stops the charge.' };
  }
  if (v) {
    if (!k.refund?.completedAt) return { title: 'Not the buyer. The refund is on its way.' };
    const who = { AGENT: "The agent's operator", STORE: 'The store', UNDETERMINED: 'Nobody could be named' }[v.liable] || 'Decided';
    return { title: v.rule === 'OPERATOR' ? `A person chose: ${who.toLowerCase()}. The buyer keeps the refund.` : v.liable === 'UNDETERMINED' ? 'Nobody could be named. The buyer keeps the refund.' : `Two keys agree: ${who.charAt(0).toLowerCase() + who.slice(1)} is responsible.`, lead: 'The buyer keeps the refund and is not charged again.' };
  }
  if (k.refund?.completedAt && !verifyFirst) return { title: 'The buyer reported it. The money went back first.', lead: working === 'investigate' ? 'Now the checks run.' : '' };
  if (verifyFirst && k.refund?.completedAt) return { title: 'Checked first, then refunded.', lead: 'Over the instant-refund limit, so the check came before the refund.' };
  if (verifyFirst) return { title: 'Over the instant-refund limit, so the desk checks first.', lead: 'If it was not the buyer, the refund follows within 5 minutes. If a person has to decide, it can take longer.' };
  return { title: 'The buyer reported it. The refund goes out first.' };
}
