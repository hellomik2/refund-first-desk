// The desk's side: each check as one short proof block (name, result, status, time), details folded away.
import { S, esc, usd, time, day, secs, label, linesSince, REASONS, FACT_LABELS, FACT_SHORT, INTEGRITY, RULES, WHO_SHORT, WHO_IN, DOCS, DOCS_IN, REVIEW_REASONS, KINDS } from './shared.js';
import { unpaidOrderView } from './payment.js';
import { aiKeySource, buyerKeysLine, deepAiSource, quickAiLine } from './ailabels.js';

// ---- desk column ----------------------------------------------------------------------------------------
export function deskColumn({ order, kase: k }, working) {
  if (!order) return `<div class="card proof"><p class="pr">Nothing yet. The desk acts when the buyer reports a problem.</p></div>`;
  if (!order.paypal) {
    const kind = unpaidOrderView(order, { busy: S.busy })?.kind;
    const line = { 'consent-cancelled': 'Nothing was charged.', refused: 'Nothing was charged.', 'consent-waiting': 'Nothing charged yet. The payment and the saved-wallet consent are waiting at PayPal.', paying: 'The payment is on its way to PayPal.' }[kind] || 'PayPal has not confirmed the payment, so the desk records nothing as paid yet.';
    return `<div class="card proof"><p class="pr">${line}</p></div>`;
  }
  if (!k) {
    const p = order.protection;
    return `<div class="card proof"><div class="ph"><h3>Waiting for a report</h3>${chip('grey', 'holding the payment')}</div>
      <p class="pr">${p.refundFirst ? `Refund first. The buyer can never be charged again for more than ${usd(p.buyerLiabilityCapCents)}.` : `Check first: ${esc(p.reasons.map((r) => label(REASONS, r)).join('; '))}.`}</p>
      <p class="fine">Fixed at purchase. The store's money is held ${S.state.policy.storeHoldDays} days (simulated).</p></div>`;
  }
  const checking = working === 'investigate';
  const inv = k.investigation;
  const now = inv?.codeKey && inv?.aiKey ? 'keys' : inv?.finishedAt ? 'deep' : k.quick?.finishedAtMs ? 'quick' : '';
  if (k.status === 'HUMAN_REVIEW') return operatorPanel(k, working) + quickCard(k, false, false) + afterCard(k, order);
  return quickCard(k, checking, now === 'quick') + deepCard(k, checking, now === 'deep') + keysCard(k, order, working, now === 'keys') + afterCard(k, order);
}

const took = (ms) => `<span class="took">${secs(ms)}</span>`;
const chip = (tone, text, spin = false) => `<span class="chip c-${tone}">${spin ? '<span class="spinner"></span>' : ''}${esc(text)}</span>`;
const head = (name, chips = '', ms = null) => `<div class="ph"><h3>${name}</h3>${chips}${ms == null ? '' : took(ms)}</div>`;

function factLine(key, value, quote, by, discarded = false) {
  return `<li class="fx"><span class="ans ${esc(value)}">${esc(value)}</span><div><span class="fl">${esc(label(FACT_LABELS, key))}</span>${
    quote ? `<q>${esc(quote)}</q>` : discarded ? '<span class="tag sim">quote not found in the record: discarded</span>' : '<span class="by">not settled by these documents</span>'
  }<span class="by">${esc(by)}</span></div></li>`;
}

// No "deep check" or "two keys" in this card: the video script finds each card by its name.
function quickCard(k, checking, now) {
  const q = k.quick;
  if (!q?.finishedAtMs) {
    return `<div class="card proof">${head('Quick check', checking ? chip('grey', 'reading', true) : chip('grey', 'waiting'))}
      <p class="pr">Reads the mandate and the PayPal order. It can only close a case for the buyer.</p></div>`;
  }
  const rows = Object.entries(q.codeFacts || {}).map(([key, f]) => factLine(key, f.value, f.quote, `code, from ${label(DOCS_IN, f.doc)}`));
  for (const [key, f] of Object.entries(q.aiFacts || {})) {
    const ev = f.evidence?.[0];
    rows.push(factLine(key, f.value, ev?.quote, ev ? `AI, quoting ${label(DOCS_IN, ev.doc)}` : 'AI, with no quote from these two documents', q.downgraded?.includes(key)));
  }
  const found = (q.reasons || []).map((r) => label(FACT_SHORT, r.key)).join(', ');
  const line = q.closed
    ? `Mismatch found${found ? `: ${esc(found)}` : ''}. This order can never be charged again. Who is responsible is decided next.`
    : 'Nothing settled from the mandate and the PayPal order.';
  return `<div class="card proof${now ? ' now' : ''}">${head('Quick check', q.closed ? chip('go', 'closed for the buyer') : chip('grey', 'nothing settled'), q.ms)}
    <p class="pr">${line}</p>
    <p class="fine">${quickAiLine(q)}</p>
    <details><summary>What it read</summary><ul class="facts">${rows.join('')}</ul></details></div>`;
}

// No "two keys" in this card either.
function deepCard(k, checking, now) {
  const inv = k.investigation;
  if (!inv?.finishedAt) {
    return `<div class="card proof">${head('Deep check', checking ? chip('grey', 'reading', true) : chip('grey', 'waiting'))}
      <p class="pr">The investigator reads every record and names the first step that went off the mandate.</p></div>`;
  }
  return `<div class="card proof${now ? ' now' : ''}">${head('Deep check', deepChip(inv), inv.durationMs)}
    ${deepFinding(inv)}
    <p class="fine">${deepAiSource(inv)}</p>${traceHtml(k)}</div>`;
}

function deepChip(inv) {
  const fd = inv.firstDeviation || { kind: 'INSUFFICIENT' };
  if (fd.kind === 'STEP') return fd.verified ? chip('go', 'quote checked by code') : chip('stop', 'quote not verified');
  return fd.kind === 'NONE' ? chip('grey', 'no step off') : chip('wait', 'not enough records');
}

/** The one big thing the deep check found: the step, in red, with the condition it broke. */
function deepFinding(inv) {
  const fd = inv.firstDeviation || { kind: 'INSUFFICIENT' };
  const inLog = fd.kind === 'STEP' && (inv.steps || []).some((s) => s.step === fd.step);
  if (inLog) return `<p class="pbig stop">Step ${esc(fd.step)}</p><p class="pr">The first step off the mandate${fd.condition ? `: ${esc(label(FACT_SHORT, fd.condition))}` : ''}.</p>`;
  if (fd.kind === 'STEP') return `<p class="pr">The investigator named step ${esc(fd.step)}, which is not in this log.</p>`;
  return `<p class="pr">${fd.kind === 'NONE' ? 'No step went off the mandate.' : 'The records are not enough to name a step.'}</p>`;
}

function markQuote(line, quote) {
  const qt = String(quote || '').trim();
  const i = qt ? line.toLowerCase().indexOf(qt.toLowerCase()) : -1;
  if (i < 0) return esc(line);
  return `${esc(line.slice(0, i))}<mark>${esc(line.slice(i, i + qt.length))}</mark>${esc(line.slice(i + qt.length))}`;
}

/** The agent's own log, one row per step: the investigator's pick in red, rule flags kept apart. Press a step to open its line. */
function traceHtml(k) {
  const inv = k.investigation;
  const steps = inv.steps || [];
  if (!steps.length) return `<p class="fine">This case has no step-by-step agent log.</p>`;
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
      const open = S.openSteps.has(key) ? S.openSteps.get(key) : fork;
      const raw = lines.find((l) => l.startsWith(`Step ${s.step} · `)) || `Step ${s.step} · ${String(s.at || '').slice(11, 19) || '--:--:--'} · ${s.actor} · ${s.action}: ${s.content}`;
      const marks = [
        fork ? `<span class="mk ai">${fd.verified ? 'AI: first step off' : 'AI: first step off, quote not verified'}</span>` : '',
        ...f.map((c) => `<span class="mk flag">rule flag: ${esc(label(FACT_SHORT, c.condition))}</span>`),
      ].join('');
      let detail = `<p class="raw">${fork && fd.verified ? markQuote(raw, fd.quote) : esc(raw)}</p>`;
      if (fork) {
        detail += fd.verified
          ? `<p class="dl"><span class="tag real">quote found in this step</span> Condition: ${esc(fd.condition ? label(FACT_SHORT, fd.condition) : 'none')}.</p>`
          : `<p class="dl"><span class="tag stop">quote not verified</span> It quoted <q class="struck">${esc(fd.quote || '(nothing)')}</q>, which is not in this step. Kept as a report only; it plays no part in the decision.</p>`;
      }
      for (const c of f) detail += `<p class="dl"><span class="tag flagtag">rule flag</span> ${esc(c.why)}. A simple rule; it can be wrong or miss.</p>`;
      if (!fork && !f.length) detail += `<p class="dl">Nothing flagged on this step.</p>`;
      const cls = ['st', off ? 'off' : '', fork ? 'fork' : '', f.length ? 'flagged' : '', open ? 'open' : ''].filter(Boolean).join(' ');
      return `<li class="${cls}">
        <button class="st-row" data-step="${s.step}" aria-expanded="${open}">
          <span class="sn">${s.step}</span>
          <span class="st-body"><span class="st-head"><span class="act">${esc(s.action)}</span><span class="actor">${esc(s.actor)}</span>${marks}</span><span class="st-text">${esc(s.content)}</span></span>
        </button>
        ${open ? `<div class="st-open">${detail}</div>` : ''}</li>`;
    })
    .join('');

  const flagLine = flagged.length ? `Rule flags on step${flagged.length > 1 ? 's' : ''} ${flagged.join(', ')} were given to the investigator as evidence, not as the answer.` : 'No rule flagged any step.';
  const live = S.state.mandates.find((m) => m.id === S.state.orders.find((o) => o.id === k.orderId)?.mandateId)?.live;
  return `<ol class="trace tight">${rows}</ol>
    <p class="fine">Press a step to open its log line (times in UTC). ${live ? 'Written by the live agent as it shopped. The catalog is ours; the steps are not, and there is no answer key.' : 'Agent logs and answer key written by us for this demo.'}</p>
    <details><summary>How to read this log</summary>
      <p class="legend"><span class="lg"><span class="mk ai">AI</span> the investigator's first step off</span><span class="lg"><span class="mk flag">rule flag</span> a simple rule's pick</span></p>
      <p class="fine">${flagLine} The first step off is a report for whoever fixes the agent; it does not decide who pays.</p></details>`;
}

function keyBox(kind, key, inv) {
  if (kind === 'code') {
    const reasons = (key.reasons || [])
      .map((r) => (INTEGRITY[r] ? `<li>${esc(INTEGRITY[r])}</li>` : `<li><span class="ans ${esc(inv.facts?.[r]?.value || 'unknown')}">${esc(inv.facts?.[r]?.value || 'unknown')}</span> ${esc(label(FACT_SHORT, r))}</li>`))
      .join('');
    return `<div class="key k-code"><span class="kh">Rules key, fixed rules in code</span><strong>${esc(label(WHO_SHORT, key.liable))}</strong>
      <span class="kr">Rule ${esc(key.rule)}. ${esc(label(RULES, key.rule))}</span>${reasons ? `<ul class="kreasons">${reasons}</ul>` : ''}</div>`;
  }
  // The AI key shows its conclusion only. Its own wording is not put on screen as an argument.
  return `<div class="key k-ai"><span class="kh">AI key, the investigator</span><strong>${esc(label(WHO_SHORT, key.liable))}</strong><span class="kr">${aiKeySource(key, inv)}</span></div>`;
}

function keysPair(inv) {
  const same = inv.codeKey.liable === inv.aiKey.liable;
  const buyer = same && inv.codeKey.liable === 'BUYER';
  return `<div class="keys${buyer ? ' k-buyer' : ''}">${keyBox('code', inv.codeKey, inv)}<div class="gate ${same ? 'g-open' : 'g-shut'}" aria-label="${same ? 'same' : 'different'}">${same ? '=' : '≠'}</div>${keyBox('ai', inv.aiKey, inv)}</div>`;
}

function movedList(lines) {
  return `<ul class="moved">${lines
    .map((l) => `<li><span>${esc(label(KINDS, l.kind))}${l.memo ? ' <span class="tag">memo</span>' : l.simulated ? ' <span class="tag sim">ledger only</span>' : ''}</span><span class="num">${usd(l.cents)}</span></li>`)
    .join('')}</ul>`;
}

const RULE_LINE = "A re-charge, the store's payout or an invoice entry for the agent happens on its own only when they agree.";

function keysCard(k, order, working, now) {
  const inv = k.investigation;
  if (!inv?.codeKey || !inv?.aiKey) {
    return `<div class="card proof">${head('Two keys', working === 'investigate' ? chip('grey', 'waiting', true) : chip('grey', 'waiting'))}
      <p class="pr">The rules key and the AI key each name who is responsible. ${RULE_LINE}</p></div>`;
  }
  const same = inv.codeKey.liable === inv.aiKey.liable;
  const v = k.verdict;
  let outcome = '';
  if (v) {
    const moved = linesSince(order.id, v.decidedAt);
    const list = moved.length ? `<p class="fine">Moved since then:</p>${movedList(moved)}` : '<p class="fine">Nothing has moved yet.</p>';
    if (v.rule === 'R0') outcome = `<div class="result"><strong>The records could not be tied together.</strong> Neither key is used; the buyer keeps the refund.</div>${list}`;
    else if (v.rule === 'OPERATOR') outcome = `<div class="result wait"><strong>They differed. A person chose ${esc(label(WHO_SHORT, v.liable).toLowerCase())}</strong> at ${time(v.decidedAt)}${v.note ? `: <q>${esc(v.note)}</q>` : '.'}</div>${list}`;
    else if (v.liable === 'BUYER') outcome = `<div class="result wait"><strong>Both keys name the buyer.</strong> ${buyerKeysLine(k)}</div>${list}`;
    else outcome = `<div class="result go"><strong>${v.liable === 'UNDETERMINED' ? 'Both keys say nobody can be named, so the desk absorbs it.' : `Both keys name ${esc(label(WHO_IN, v.liable))}.`}</strong> Only then did the desk act.</div>${list}`;
  }
  const tone = v?.rule === 'OPERATOR' || !same ? chip('wait', 'different answers') : v?.liable === 'BUYER' ? chip('wait', 'same answer') : chip('go', 'same answer');
  return `<div class="card proof${now ? ' now' : ''}">${head('Two keys', tone)}
    <p class="pr">${RULE_LINE}</p>${keysPair(inv)}${outcome}${factsAndRecords(inv)}</div>`;
}

function factsAndRecords(inv) {
  if (!inv?.facts) return '';
  const rows = Object.entries(inv.facts)
    .map(([key, f]) => {
      const ev = f.evidence?.[0];
      const src = ev ? `${esc(inv.evidence?.[ev.doc]?.title || label(DOCS, ev.doc))}: <q>${esc(ev.quote)}</q>${ev.computed ? ' <span class="tag">computed by code</span>' : ''}` : inv.downgraded?.includes(key) ? '<span class="tag sim">quote not found in the record: discarded</span>' : 'not settled by the records';
      return `<tr><td>${esc(label(FACT_LABELS, key))}</td><td class="${esc(f.value)}">${esc(f.value)}</td><td class="src">${src}</td></tr>`;
    })
    .join('');
  return `<details class="records"><summary>The seven facts the rules key read</summary>
    <p class="fine">Each answer must quote a record; a quote not in the record is thrown out. Code computes the mandate, limit, charge and quantity facts itself.</p>
    <div class="tbl"><table><thead><tr><th>Question</th><th>Answer</th><th>From the record</th></tr></thead><tbody>${rows}</tbody></table></div></details>
    <details class="records"><summary>The records that were compared</summary>
    ${Object.values(inv.evidence || {}).map((d) => `<h4>${esc(d.title)}</h4><pre>${esc(d.text)}</pre>`).join('')}</details>`;
}

function operatorPanel(k, working) {
  const rv = k.review || {};
  const inv = k.investigation;
  const off = S.busy ? 'disabled' : '';
  const choices = ['STORE', 'AGENT', 'BUYER', 'UNDETERMINED']
    .map((who) => {
      const blocked = who === 'BUYER' && k.rechargeClosed;
      return `<button class="choice${who === 'BUYER' ? ' c-buyer' : ''}" data-act="resolve" data-liable="${who}" ${off || (blocked ? 'disabled' : '')}${blocked ? ' title="The quick check closed the re-charge for this order"' : ''}>${esc(WHO_SHORT[who])}</button>`;
    })
    .join('');
  return `<div class="card proof op now"><div class="ph"><h3>A person decides</h3>${chip('wait', `waiting since ${time(rv.openedAt)}`)}</div>
    <p class="pr">${esc(label(REVIEW_REASONS, rv.reason))} Nothing moves until then: no re-charge, no store payout, no agent invoice.</p>
    ${inv?.codeKey && inv?.aiKey ? keysPair(inv) : ''}
    ${inv?.steps ? `<h4 class="op-sub">Where the agent left the mandate</h4>${deepFinding(inv)}${traceHtml(k)}` : ''}
    <div class="choose">
      <label for="review-note">Note for the record (optional)</label>
      <textarea id="review-note" rows="2" placeholder="What you checked"></textarea>
      <p class="fine">Who is responsible? Choosing the buyer still sends a notice and leaves time to dispute.${k.rechargeClosed ? ' The buyer cannot be chosen: the quick check closed the re-charge.' : ''}</p>
      <div class="row">${working === 'resolveReview' ? '<span class="spinner"></span>' : ''}${choices}</div>
    </div>
    ${factsAndRecords(inv)}</div>`;
}

function afterCard(k, order) {
  const rows = [];
  const row = (cls, at, what, detail = '') => rows.push(`<li class="${cls}">${at ? `<span class="when">${time(at)}</span>` : ''}<div class="what">${what}</div>${detail ? `<div class="detail">${detail}</div>` : ''}</li>`);
  for (const e of k.events || []) {
    if (e.type === 'REVIEW_RESOLVED') row('done', e.at, `A person chose: ${esc(label(WHO_SHORT, e.liable))}`);
    if (e.type === 'NOTICE_SENT') row('done', e.at, 'Notice sent to the buyer', `No charge before ${day(e.chargeNotBefore)} (${S.state.policy.noticeBusinessDays} business days).`);
    if (e.type === 'DISPUTE_FILED') row('halt', e.at, 'The buyer disputed', k.recharge ? 'The re-charge is stopped for good.' : 'Kept on file with the case.');
    if (e.type === 'RECHARGE_HALTED' && e.reason !== 'BUYER_DISPUTED') row('halt', e.at, 'Re-charge stopped', esc(label(REASONS, e.reason)));
    if (e.type === 'RECHARGE_COMPLETED') row('money', e.at, `Saved wallet charged again: ${usd(e.amountCents)}`, `Buyer not present. Capture ${esc(e.captureId)}.`);
    if (e.type === 'STORE_PAID') row('money', e.at, `Store paid from ${e.source === 'desk:reserve' ? "the desk's own funds" : 'the purchase money'}`, `PayPal payout item: ${esc(e.payoutItemStatus || 'unknown')}.`);
    if (e.type === 'STORE_PAYOUT_FAILED') row('halt', e.at, 'Store payout failed', esc(e.error || ''));
    if (e.type === 'STORE_PAYOUT_UNCONFIRMED') row('halt', e.at, 'Store payout sent, no answer from PayPal yet', `${esc(e.error || '')}. Sent again under the same id on the next fast-forward or ledger check; PayPal never pays it twice.`);
    if (e.type === 'STORE_PAYOUT_PENDING') row('halt', e.at, 'Store payout sent, not confirmed yet', `PayPal payout item: ${esc(e.payoutItemStatus || 'no status yet')}. Looked up again on the next fast-forward or ledger check.`);
    if (e.type === 'RESERVE_SHORTFALL') row('halt', e.at, "The desk's own funds are short", 'The store payment waits for an operator.');
  }
  const sp = order.storePayable;
  if (sp.status === 'PAID' && sp.simulated) row('done', sp.paidAt, `Store paid from ${sp.source === 'desk:reserve' ? "the desk's own funds" : 'the purchase money'} <span class="tag sim">ledger only</span>`, 'No store PayPal account is set up, so this is recorded, not sent.');
  if (sp.storeOwesBack && k.verdict) row('halt', null, 'The store was paid before the report', `It is responsible, so it owes ${usd(sp.cents)} back. Recorded only; the desk's own funds cover the refund.`);
  if (sp.needsPerson) row('halt', null, 'Store payout: no answer from PayPal for about 30 days', 'Not sent again (PayPal forgets the payout id after 30 days). A person checks the PayPal account.');
  if (sp.status === 'CANCELLED' && k.verdict) row('halt', null, 'Store is not paid for this order', 'The amount set aside for it is released.');
  if (!rows.length) return '';
  return `<div class="card proof"><div class="ph"><h3>After the decision</h3></div><ol class="steps">${rows.join('')}</ol></div>`;
}
