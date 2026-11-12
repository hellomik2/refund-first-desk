// Who gets an instant refund, and what the buyer can later be charged. These are money rules, so
// they are plain code. The AI never decides them.

const DAY_MS = 24 * 60 * 60 * 1000;

export function addBusinessDays(from, days) {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return d;
}

/**
 * Fixed at purchase time and stored on the order: whether this purchase is covered by refund-first,
 * and the most the buyer can ever be charged again for it. Later rule changes do not touch it.
 */
export function fixProtectionAtPurchase({ policy, totalCents, walletConsentActive, now, limits = null }) {
  // limits: this buyer's instant-refund limit from their own record (domain/trust.js), with its reasons.
  const perCaseCapCents = limits?.perCaseCapCents ?? policy.perCaseCapCents;
  const reasons = [];
  if (totalCents > perCaseCapCents) reasons.push('OVER_PER_CASE_CAP');
  if (!walletConsentActive) reasons.push('NO_SAVED_WALLET_CONSENT');
  return {
    fixedAt: new Date(now).toISOString(),
    refundFirst: reasons.length === 0,
    reasons,
    // The buyer can never be re-charged more than what was refunded for this order.
    buyerLiabilityCapCents: totalCents,
    noticeBusinessDays: policy.noticeBusinessDays,
    perCaseCapCents,
    refundsPer30Days: limits?.refundsPer30Days ?? policy.refundsPer30Days,
    limits,
  };
}

/**
 * Checked when the buyer reports a problem. Returns refundFirst=false (verify first) when a limit
 * is exceeded. Verify-first is the stated exception to the refund-first promise.
 */
export function checkAtReport({ policy, order, buyerCases, reserveAvailableCents, now }) {
  const reasons = [...(order.protection.refundFirst ? [] : order.protection.reasons)];
  const since = new Date(now).getTime() - 30 * DAY_MS;
  const recentInstantRefunds = buyerCases.filter(
    (c) => c.path === 'REFUND_FIRST' && c.refund?.completedAt && new Date(c.receivedAt).getTime() >= since,
  ).length;
  // The count fixed at purchase; orders saved before limits were fixed use the policy number.
  if (recentInstantRefunds >= (order.protection.refundsPer30Days ?? policy.refundsPer30Days)) reasons.push('OVER_30_DAY_COUNT');
  // The desk must be able to make an innocent store whole from its own funds before it lets the purchase money go.
  if (reserveAvailableCents < order.totalCents) reasons.push('RESERVE_TOO_LOW');
  return { refundFirst: reasons.length === 0, reasons, recentInstantRefunds };
}

/** Every condition must hold before the desk charges a buyer again. Returns the first failing guard. */
export function rechargeGuard({ order, kase, buyer, amountCents, now }) {
  if (kase.verdict?.liable !== 'BUYER') return 'NOT_BUYER_RESPONSIBILITY';
  if (kase.rechargeClosed) return 'RECHARGE_CLOSED_BY_QUICK_CHECK'; // a closing quick check is final
  if (kase.recharge?.status === 'COMPLETED') return 'ALREADY_CHARGED';
  if (!kase.refund?.completedAt) return 'NOTHING_WAS_REFUNDED';
  if (kase.dispute) return 'BUYER_DISPUTED';
  if (!buyer.wallet || buyer.wallet.consent !== 'ACTIVE') return 'NO_ACTIVE_CONSENT';
  // Only the wallet that paid this order may be charged again for it, never one saved later.
  if (buyer.wallet.vaultId !== order.paidWithVaultId) return 'NOT_THE_WALLET_THAT_PAID';
  if (kase.recharge?.status === 'HALTED') return kase.recharge.blockedBy || 'RECHARGE_HALTED';
  if (!kase.notice) return 'NO_NOTICE_SENT';
  if (new Date(now).getTime() < new Date(kase.notice.chargeNotBefore).getTime()) return 'NOTICE_PERIOD_RUNNING';
  if (amountCents > order.protection.buyerLiabilityCapCents) return 'OVER_LIABILITY_CAP';
  if (amountCents > kase.refund.amountCents) return 'OVER_REFUNDED_AMOUNT';
  return null;
}
