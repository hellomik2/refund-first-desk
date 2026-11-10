// An in-memory stand-in for the PayPal calls in src/paypal/api.js, used by unit tests only.
// It mimics the response shapes and the PayPal-Request-Id idempotency the desk relies on.
// The real behaviour is exercised against the sandbox by scripts/loop.mjs.
import { fromCents } from '../src/domain/money.js';

export function createFakePayPal({ failNextCharge = false } = {}) {
  const state = { orders: new Map(), captures: new Map(), refunds: new Map(), payouts: new Map(), byRequestId: new Map(), deletedTokens: [], log: [] };
  let n = 0;
  const id = (p) => `${p}${String(++n).padStart(6, '0')}`;
  const usd = (cents) => ({ currency_code: 'USD', value: fromCents(cents) });
  const fee = (cents) => Math.round(cents * 0.0349) + 49;
  const ok = (body, status = 200) => ({ status, body, ms: 1, debugId: 'fake' });
  const idem = (requestId, make) => {
    if (requestId && state.byRequestId.has(requestId)) return state.byRequestId.get(requestId);
    const made = make();
    if (requestId) state.byRequestId.set(requestId, made);
    return made;
  };
  const cents = (v) => Math.round(Number(v) * 100);

  function orderBody(o) {
    const cap = o.captureId ? state.captures.get(o.captureId) : null;
    return {
      id: o.id,
      status: o.status,
      payment_source: { paypal: { email_address: 'buyer@example.test', account_id: 'FAKEPAYER', attributes: o.vault ? { vault: o.vault } : undefined } },
      purchase_units: [
        {
          reference_id: o.unit.reference_id,
          custom_id: o.unit.custom_id,
          invoice_id: o.unit.invoice_id,
          amount: o.unit.amount,
          items: o.unit.items,
          payments: cap
            ? {
                captures: [
                  {
                    id: cap.id,
                    status: cap.status,
                    amount: usd(cap.grossCents),
                    seller_receivable_breakdown: { gross_amount: usd(cap.grossCents), paypal_fee: usd(cap.feeCents), net_amount: usd(cap.grossCents - cap.feeCents) },
                    create_time: cap.at,
                  },
                ],
              }
            : undefined,
        },
      ],
      links: [{ rel: 'payer-action', href: `https://fake.paypal.test/approve/${o.id}` }],
    };
  }

  function capture(o) {
    const grossCents = cents(o.unit.amount.value);
    const cap = { id: id('CAP'), status: 'COMPLETED', grossCents, feeCents: fee(grossCents), custom_id: o.unit.custom_id, invoice_id: o.unit.invoice_id, at: new Date().toISOString(), refundedCents: 0 };
    state.captures.set(cap.id, cap);
    o.captureId = cap.id;
    o.status = 'COMPLETED';
  }

  const api = {
    state,
    failNextCharge,
    async createConsentOrder({ orderRef, mandateFingerprint, cart, totalCents, requestId }) {
      state.log.push('createConsentOrder');
      return ok(orderBody(idem(requestId, () => {
        const o = { id: id('ORD'), status: 'PAYER_ACTION_REQUIRED', unit: unit(orderRef, mandateFingerprint, cart, totalCents), wantsVault: true };
        state.orders.set(o.id, o);
        return o;
      })));
    },
    async captureOrder(orderId, requestId) {
      state.log.push('captureOrder');
      const o = state.orders.get(orderId);
      idem(requestId, () => {
        capture(o);
        if (o.wantsVault && !api.vaultDeclined) o.vault = { id: id('VAULT'), status: 'VAULTED', customer: { id: id('CUST') } };
        return o;
      });
      return ok(orderBody(o), 201);
    },
    async chargeSavedWallet({ vaultId, orderRef, mandateFingerprint, cart, totalCents, requestId }) {
      state.log.push('chargeSavedWallet');
      if (api.failNextCharge) {
        api.failNextCharge = false;
        const err = new Error('PayPal charge-saved-wallet failed: HTTP 422 INSTRUMENT_DECLINED');
        err.code = 'INSTRUMENT_DECLINED';
        throw err;
      }
      if (state.deletedTokens.includes(vaultId)) {
        const err = new Error('PayPal charge-saved-wallet failed: HTTP 422 TOKEN_NOT_FOUND');
        err.code = 'TOKEN_NOT_FOUND';
        throw err;
      }
      return ok(orderBody(idem(requestId, () => {
        const o = { id: id('ORD'), status: 'CREATED', unit: unit(orderRef, mandateFingerprint, cart, totalCents) };
        state.orders.set(o.id, o);
        capture(o);
        return o;
      })), 201);
    },
    async getOrder(orderId) {
      return ok(orderBody(state.orders.get(orderId)));
    },
    async getCapture(captureId) {
      const cap = state.captures.get(captureId);
      return ok({ id: cap.id, status: cap.status, amount: usd(cap.grossCents), custom_id: cap.custom_id, invoice_id: cap.invoice_id, seller_receivable_breakdown: { paypal_fee: usd(cap.feeCents) } });
    },
    async refundCapture(captureId, { requestId, amountCents } = {}) {
      state.log.push('refundCapture');
      const cap = state.captures.get(captureId);
      const r = idem(requestId, () => {
        const amount = amountCents ?? cap.grossCents - cap.refundedCents;
        if (amount <= 0 || cap.refundedCents + amount > cap.grossCents) {
          const err = new Error('PayPal refund-capture failed: HTTP 422 CAPTURE_FULLY_REFUNDED');
          err.code = 'CAPTURE_FULLY_REFUNDED';
          throw err;
        }
        cap.refundedCents += amount;
        // api.refundsPending mimics the sandbox when the merchant balance is short: PayPal accepts the
        // refund and funds it by eCheck, so the lookup says PENDING (reason ECHECK) for a while.
        const refund = { id: id('REF'), status: api.refundsPending ? 'PENDING' : 'COMPLETED', amountCents: amount, at: new Date().toISOString() };
        state.refunds.set(refund.id, refund);
        return refund;
      });
      return ok(refundBody(r), 201);
    },
    async getRefund(refundId) {
      return ok(refundBody(state.refunds.get(refundId)));
    },
    async deletePaymentToken(vaultId) {
      state.deletedTokens.push(vaultId);
      return ok({}, 204);
    },
    async createPayout({ batchId, receiverEmail, amountCents, itemId }) {
      state.log.push('createPayout');
      const p = idem(batchId, () => {
        const payout = { batchId: id('BATCH'), itemId: id('ITEM'), receiverEmail, amountCents, senderItemId: itemId, status: api.payoutStatus, feeCents: 25 };
        state.payouts.set(payout.batchId, payout);
        return payout;
      });
      return ok({ batch_header: { payout_batch_id: p.batchId, batch_status: 'PENDING' } }, 201);
    },
    async getPayout(batchId) {
      if (api.failNextGetPayout) {
        api.failNextGetPayout = false;
        throw new Error('network error while looking up the payout');
      }
      const p = state.payouts.get(batchId);
      return ok({
        batch_header: { payout_batch_id: p.batchId, batch_status: 'SUCCESS', fees: { currency: 'USD', value: fromCents(p.feeCents) } },
        items: [{ payout_item_id: p.itemId, transaction_status: p.status, payout_item: { amount: { currency: 'USD', value: fromCents(p.amountCents) }, receiver: p.receiverEmail } }],
      });
    },
  };

  function unit(orderRef, mandateFingerprint, cart, totalCents) {
    return {
      reference_id: orderRef,
      custom_id: `mandate:${mandateFingerprint}`,
      invoice_id: orderRef,
      amount: usd(totalCents),
      items: cart.map((l) => ({ name: l.name, sku: l.sku, quantity: String(l.qty), unit_amount: usd(l.unitCents) })),
    };
  }
  function refundBody(r) {
    return { id: r.id, status: r.status, amount: usd(r.amountCents), seller_payable_breakdown: { total_refunded_amount: usd(r.amountCents) }, create_time: r.at };
  }

  api.refundsPending = false;
  api.payoutStatus = 'SUCCESS'; // set to FAILED, RETURNED, BLOCKED or UNCLAIMED to mimic a payout that did not reach the store
  api.failNextGetPayout = false;
  /** PayPal finishes payouts that were still in flight: every existing payout item takes this status. */
  api.setPayoutStatus = (status) => {
    for (const p of state.payouts.values()) p.status = status;
  };
  /** The eCheck clears: every pending refund becomes COMPLETED. */
  api.completePendingRefunds = () => {
    for (const r of state.refunds.values()) if (r.status === 'PENDING') r.status = 'COMPLETED';
  };

  // Totals the tests assert on: what actually left and entered the buyer's wallet.
  api.totals = () => ({
    refunds: state.refunds.size,
    refundedCents: [...state.refunds.values()].reduce((s, r) => s + r.amountCents, 0),
    captures: state.captures.size,
    capturedCents: [...state.captures.values()].reduce((s, c) => s + c.grossCents, 0),
    payouts: state.payouts.size,
    payoutCalls: state.log.filter((l) => l === 'createPayout').length,
  });
  return api;
}
