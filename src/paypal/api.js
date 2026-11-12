// The PayPal calls the desk uses, one function per endpoint, plus small readers that pull the
// fields we need out of PayPal's responses. Request shapes follow the PayPal REST docs:
//   Orders v2    POST /v2/checkout/orders, POST /v2/checkout/orders/{id}/capture, GET /v2/checkout/orders/{id}
//   Payments v2  POST /v2/payments/captures/{id}/refund, GET /v2/payments/refunds/{id}, GET /v2/payments/captures/{id}
//   Vault v3     DELETE /v3/vault/payment-tokens/{id}
//   Payouts v1   POST /v1/payments/payouts, GET /v1/payments/payouts/{batch_id}
import { fromCents, toCents, usd } from '../domain/money.js';

function purchaseUnit({ orderRef, mandateFingerprint, cart, totalCents, description }) {
  return {
    reference_id: orderRef,
    description: (description || 'Agent purchase').slice(0, 127),
    // The fingerprint of the buyer-approved mandate travels with the PayPal order, so the order
    // the desk later reads back from PayPal can be tied to the instruction record it kept.
    custom_id: `mandate:${mandateFingerprint}`,
    invoice_id: orderRef,
    amount: { ...usd(totalCents), breakdown: { item_total: usd(totalCents) } },
    items: cart.map((line) => ({
      name: line.name.slice(0, 127),
      sku: line.sku,
      quantity: String(line.qty),
      unit_amount: usd(line.unitCents),
    })),
  };
}

export function createPayPalApi(client) {
  return {
    /** First purchase: the buyer is present, approves the payment and agrees to save the wallet for later charges. */
    async createConsentOrder({ orderRef, mandateFingerprint, cart, totalCents, description, returnUrl, cancelUrl, requestId }) {
      return client.call('create-order-with-wallet-consent', 'POST', '/v2/checkout/orders', {
        requestId,
        body: {
          intent: 'CAPTURE',
          purchase_units: [purchaseUnit({ orderRef, mandateFingerprint, cart, totalCents, description })],
          payment_source: {
            paypal: {
              attributes: { vault: { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT' } },
              experience_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: 'PAY_NOW' },
            },
          },
        },
      });
    },

    async captureOrder(orderId, requestId) {
      return client.call('capture-order', 'POST', `/v2/checkout/orders/${orderId}/capture`, { requestId, body: {} });
    },

    /** Buyer not present: the agent (or the desk, for a re-charge) pays from the wallet saved earlier. */
    async chargeSavedWallet({ label = 'charge-saved-wallet', vaultId, orderRef, mandateFingerprint, cart, totalCents, description, requestId }) {
      return client.call(label, 'POST', '/v2/checkout/orders', {
        requestId,
        body: {
          intent: 'CAPTURE',
          purchase_units: [purchaseUnit({ orderRef, mandateFingerprint, cart, totalCents, description })],
          payment_source: { paypal: { vault_id: vaultId } },
        },
      });
    },

    async getOrder(orderId) {
      return client.call('get-order', 'GET', `/v2/checkout/orders/${orderId}`);
    },

    async getCapture(captureId) {
      return client.call('get-capture', 'GET', `/v2/payments/captures/${captureId}`);
    },

    /** Full refund when amountCents is omitted. The request id makes a re-sent refund return the first one. */
    async refundCapture(captureId, { requestId, note, amountCents } = {}) {
      const body = {};
      if (amountCents != null) body.amount = usd(amountCents);
      if (note) body.note_to_payer = note.slice(0, 255);
      return client.call('refund-capture', 'POST', `/v2/payments/captures/${captureId}/refund`, {
        requestId,
        headers: { Prefer: 'return=representation' },
        body,
      });
    },

    async getRefund(refundId) {
      return client.call('get-refund', 'GET', `/v2/payments/refunds/${refundId}`);
    },

    async deletePaymentToken(vaultId) {
      return client.call('delete-payment-token', 'DELETE', `/v3/vault/payment-tokens/${vaultId}`);
    },

    async createPayout({ batchId, receiverEmail, amountCents, note, itemId }) {
      return client.call('create-payout', 'POST', '/v1/payments/payouts', {
        requestId: batchId,
        body: {
          sender_batch_header: {
            sender_batch_id: batchId,
            recipient_type: 'EMAIL',
            email_subject: 'Refund-First Desk store settlement (sandbox)',
          },
          items: [
            {
              amount: { currency: 'USD', value: fromCents(amountCents) },
              receiver: receiverEmail,
              sender_item_id: itemId,
              note: (note || '').slice(0, 255),
            },
          ],
        },
      });
    },

    async getPayout(batchId) {
      return client.call('get-payout', 'GET', `/v1/payments/payouts/${batchId}`);
    },
  };
}

// ---- readers ---------------------------------------------------------------------------------

/** Pull the capture, fee breakdown, payer and vault result out of an order response. */
export function readOrder(order) {
  const unit = order.purchase_units?.[0] || {};
  const capture = unit.payments?.captures?.[0] || null;
  const wallet = order.payment_source?.paypal || {};
  const vault = wallet.attributes?.vault || {};
  const breakdown = capture?.seller_receivable_breakdown || {};
  return {
    orderId: order.id,
    status: order.status,
    customId: unit.custom_id || capture?.custom_id || null,
    invoiceId: unit.invoice_id || capture?.invoice_id || null,
    items: (unit.items || []).map((i) => ({
      name: i.name,
      sku: i.sku,
      qty: Number(i.quantity),
      unitCents: toCents(i.unit_amount?.value || '0'),
    })),
    totalCents: unit.amount ? toCents(unit.amount.value) : null,
    payerEmail: wallet.email_address || order.payer?.email_address || null,
    payerId: wallet.account_id || order.payer?.payer_id || null,
    capture: capture && {
      id: capture.id,
      status: capture.status,
      grossCents: toCents(capture.amount.value),
      feeCents: breakdown.paypal_fee ? toCents(breakdown.paypal_fee.value) : null,
      netCents: breakdown.net_amount ? toCents(breakdown.net_amount.value) : null,
      createTime: capture.create_time,
    },
    vault: vault.id ? { id: vault.id, status: vault.status, customerId: vault.customer?.id || null } : null,
    approveUrl: (order.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href || null,
  };
}

export function readCapture(capture) {
  const breakdown = capture.seller_receivable_breakdown || {};
  return {
    id: capture.id,
    status: capture.status,
    grossCents: toCents(capture.amount.value),
    feeCents: breakdown.paypal_fee ? toCents(breakdown.paypal_fee.value) : null,
    netCents: breakdown.net_amount ? toCents(breakdown.net_amount.value) : null, // what reached the desk's PayPal account
    customId: capture.custom_id || null,
    invoiceId: capture.invoice_id || null,
  };
}

export function readRefund(refund) {
  const breakdown = refund.seller_payable_breakdown || {};
  return {
    id: refund.id,
    status: refund.status,
    amountCents: refund.amount ? toCents(refund.amount.value) : null,
    totalRefundedCents: breakdown.total_refunded_amount ? toCents(breakdown.total_refunded_amount.value) : null,
    feeReturnedCents: breakdown.paypal_fee ? toCents(breakdown.paypal_fee.value) : null, // part of the capture fee PayPal gave back
    netCents: breakdown.net_amount ? toCents(breakdown.net_amount.value) : null, // what left the desk's PayPal account
    createTime: refund.create_time || null,
  };
}

export function readPayout(payout) {
  const header = payout.batch_header || {};
  const item = payout.items?.[0] || null;
  return {
    batchId: header.payout_batch_id,
    batchStatus: header.batch_status,
    feeCents: header.fees ? toCents(header.fees.value) : item?.payout_item_fee ? toCents(item.payout_item_fee.value) : null,
    item: item && {
      id: item.payout_item_id,
      status: item.transaction_status,
      amountCents: toCents(item.payout_item.amount.value),
      receiver: item.payout_item.receiver,
    },
  };
}
