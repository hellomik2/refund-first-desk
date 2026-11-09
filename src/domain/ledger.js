// The fund table. Every PayPal money movement becomes a ledger line that names both parties and
// carries the PayPal id it came from, so each party's total can be recomputed from PayPal later.
//
// Accounts:
//   buyer           the buyer's PayPal wallet
//   desk:purchase   purchase money the desk received and is holding for the store
//   desk:reserve    the desk operator's own funds (PayPal fees and store make-good come from here)
//   store           the store that sold the goods
//   paypal:fees     fees PayPal kept
// An invoice the desk expects from the agent company is recorded as a memo, never as funds.

export const ACCOUNTS = ['buyer', 'desk:purchase', 'desk:reserve', 'store', 'paypal:fees'];

export function createLedger(db) {
  const state = db.data;

  function post({ orderId, caseId = null, kind, from, to, cents, paypal = null, simulated = false, note = '' }) {
    if (!Number.isInteger(cents) || cents < 0) throw new Error(`Bad ledger amount: ${cents}`);
    const line = {
      id: db.nextId('L'),
      at: new Date().toISOString(),
      orderId,
      caseId,
      kind,
      from,
      to,
      cents,
      paypal, // { type: 'capture'|'refund'|'payout_item', id }
      simulated, // true when no PayPal movement happened (e.g. store payout shown on the ledger only)
      note,
    };
    state.ledger.push(line);
    return line;
  }

  function memo({ orderId, caseId = null, kind, cents, note = '' }) {
    const line = { id: db.nextId('L'), at: new Date().toISOString(), orderId, caseId, kind, memo: true, cents, note };
    state.ledger.push(line);
    return line;
  }

  // ---- reserve allocation -------------------------------------------------------------------
  // When purchase money leaves as a refund, the desk sets aside the same amount of its own funds
  // for that order, because an innocent store must still be paid. The allocation is released when
  // the store turns out to be at fault or the buyer is charged again, and consumed otherwise.

  function reserveBalanceCents() {
    return state.reserve.startCents + balanceOf('desk:reserve');
  }
  function reserveAllocatedCents() {
    return Object.values(state.reserve.allocations).reduce((sum, a) => sum + (a.status === 'HELD' ? a.cents : 0), 0);
  }
  function reserveAvailableCents() {
    return reserveBalanceCents() - reserveAllocatedCents();
  }
  function allocateReserve(orderId, caseId, cents) {
    if (reserveAvailableCents() < cents) throw new Error('RESERVE_TOO_LOW');
    state.reserve.allocations[orderId] = { cents, status: 'HELD', at: new Date().toISOString() };
    memo({ orderId, caseId, kind: 'RESERVE_ALLOCATED', cents, note: 'own funds set aside for this order' });
  }
  function settleAllocation(orderId, caseId, status, note) {
    const a = state.reserve.allocations[orderId];
    if (!a || a.status !== 'HELD') return;
    a.status = status; // RELEASED | CONSUMED
    memo({ orderId, caseId, kind: `RESERVE_${status}`, cents: a.cents, note });
  }

  function balanceOf(account, filter = () => true) {
    let cents = 0;
    for (const l of state.ledger) {
      if (l.memo || !filter(l)) continue;
      if (l.to === account) cents += l.cents;
      if (l.from === account) cents -= l.cents;
    }
    return cents;
  }

  /** Net position of every party for one order, split into "PayPal moved it" and "ledger only". */
  function orderTotals(orderId) {
    const totals = {};
    for (const account of ACCOUNTS) {
      totals[account] = {
        netCents: balanceOf(account, (l) => l.orderId === orderId),
        simulatedCents: balanceOf(account, (l) => l.orderId === orderId && l.simulated),
      };
    }
    return totals;
  }

  return {
    post,
    memo,
    balanceOf,
    orderTotals,
    reserveBalanceCents,
    reserveAllocatedCents,
    reserveAvailableCents,
    allocateReserve,
    settleAllocation,
    lines: (orderId) => state.ledger.filter((l) => l.orderId === orderId),
  };
}
