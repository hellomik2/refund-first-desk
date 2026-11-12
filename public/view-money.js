// The money: who holds what for this order, the check against PayPal, and the ledger.
import { S, esc, usd, signed, time, label, linesSince, ACCOUNTS, KINDS } from './shared.js';

/** Which part of the sequence a ledger line belongs to, from server times. */
function stageOf(l, k) {
  if (!k || l.at < k.receivedAt) return null;
  const v = k.verdict;
  if (v?.decidedAt && l.at >= v.decidedAt) return v.rule === 'OPERATOR' ? ['after a person chose', 'wait'] : v.agreed ? ['after both keys agreed', 'keys'] : ['after the decision', 'keys'];
  if (!k.quick?.startedAt || l.at < k.quick.startedAt) return ['before the purchase is checked', 'go'];
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
    <p class="sub">Moved since the keys differed at ${time(since)}:</p>
    <table><tbody>${rows.map(([what, cents]) => `<tr class="${cents ? '' : 'zero'}"><td>${what}</td><td class="num">${usd(cents)}</td></tr>`).join('')}</tbody></table></div>`;
}

export function moneyColumn({ order, kase: k }) {
  if (!order) return `<div class="card"><p class="sub">No money has moved.</p></div>`;
  const lines = S.state.ledger.filter((l) => l.orderId === order.id);
  const net = {};
  for (const l of lines) {
    if (l.memo) continue;
    net[l.to] = (net[l.to] || 0) + l.cents;
    net[l.from] = (net[l.from] || 0) - l.cents;
  }
  const f = S.state.funds;
  let html = `<div class="card m-parties"><h3>This order, party by party</h3>
    <table><thead><tr><th>Party</th><th class="num">Net</th></tr></thead><tbody>
    ${Object.keys(ACCOUNTS).map((a) => `<tr class="${net[a] ? '' : 'zero'}${a === 'buyer' ? ' hl' : ''}"><td>${ACCOUNTS[a]}</td><td class="num">${signed(net[a] || 0)}</td></tr>`).join('')}
    </tbody></table>
    <p class="fine">Desk's own funds: ${usd(f.reserveBalanceCents)} of ${usd(f.reserveStartCents)} left, ${usd(f.reserveAllocatedCents)} set aside for open cases.</p>
    <div class="row m-check"><button class="ghost" data-act="reconcile" ${S.busy ? 'disabled' : ''}>Check the ledger against PayPal</button></div>
    ${S.reconciliation && S.reconciliation.orderId === order.id ? reconciliationBlock(S.reconciliation) : ''}
  </div>`;
  if (k?.status === 'HUMAN_REVIEW') html += heldCard(k, order);
  html += `<div class="card"><h3>Ledger</h3><table class="ledger"><tbody>
    ${lines
      .map((l) => {
        const stage = stageOf(l, k);
        const chip = stage ? ` <span class="stagechip ${stage[1]}">${stage[0]}</span>` : '';
        const tag = l.memo ? '<span class="tag">memo</span>' : l.simulated ? '<span class="tag sim">ledger only</span>' : l.paypal?.id ? '<span class="tag real">PayPal</span>' : '<span class="tag">between desk accounts</span>';
        const where = l.memo ? esc(l.note) : `${esc(ACCOUNTS[l.from] || l.from)} to ${esc(ACCOUNTS[l.to] || l.to)}${l.paypal?.id && !l.simulated ? `, <code>${esc(l.paypal.id)}</code>` : ''}`;
        return `<tr class="${l.memo ? 'memo' : ''}"><td><b>${esc(label(KINDS, l.kind))}</b> ${tag}<span class="src">${where}${chip}</span></td><td class="num">${usd(l.cents)}</td></tr>`;
      })
      .join('')}
    </tbody></table></div>`;
  const calls = S.state.paypalCalls.slice(-14);
  html += `<div class="card"><details><summary>PayPal API calls made by the desk (latest ${calls.length})</summary>
    <table><thead><tr><th>Call</th><th>HTTP</th><th class="num">ms</th></tr></thead><tbody>
    ${calls.map((c) => `<tr><td><code>${esc(c.method)} ${esc(String(c.path).replace(/[A-Z0-9-]{12,}/g, '…'))}</code><div class="src">${esc(c.label)}</div></td><td>${esc(c.status)}</td><td class="num">${esc(c.ms)}</td></tr>`).join('')}
    </tbody></table></details></div>`;
  return html;
}

function reconciliationBlock(r) {
  const ok = r.ok ?? (!r.storeUnknown && r.rows.every((row) => row.match));
  const status = ok ? '<span class="m-status">Ledger matches PayPal</span>' : r.storeUnknown ? '<span class="m-status wait">No answer on the store payout yet</span>' : '<span class="m-status no">Ledger differs from PayPal</span>';
  return `<div class="m-recon">${status}
    <table><thead><tr><th>Party</th><th class="num">Ledger</th><th class="num">PayPal</th><th class="num"></th></tr></thead><tbody>
    ${r.rows.map((row) => `<tr><td>${ACCOUNTS[row.party]}</td><td class="num">${signed(row.ledgerCents)}</td><td class="num">${signed(row.paypalCents)}</td><td class="num ${row.match ? 'yes' : 'no'}">${row.match ? 'match' : 'differs'}</td></tr>`).join('')}
    </tbody></table>
    <p class="sub">Looked up just now: ${r.lookups.map((l) => `${l.type.replace('_', ' ')} ${esc(l.status)}`).join(', ')}.${r.simulatedStoreCents ? ` ${usd(r.simulatedStoreCents)} to the store is ledger only and is not part of this comparison.` : ''}${r.storeUnknown ? ' <strong>The store payout got no answer from PayPal yet, so this order cannot be called a match.</strong>' : ''}</p></div>`;
}
