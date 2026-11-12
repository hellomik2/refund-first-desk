// What the buyer side says about an order PayPal has not recorded as paid. Pure, so the tests can read it.
// "Nothing was charged" is said only where it is known: the buyer turned back at PayPal, or PayPal clearly
// refused the payment (the order is CANCELLED). While the payment is being sent, and in any state this page
// does not know, it says the payment is not confirmed yet.

/** @returns {{kind: string, title: string, text: string} | null} null when the order is paid (order.paypal set). */
export function unpaidOrderView(order, { busy = false } = {}) {
  if (!order || order.paypal) return null;
  if (order.consentCancelled) return { kind: 'consent-cancelled', title: 'Cancelled at PayPal', text: 'The buyer turned back on the PayPal screen. Nothing was charged. Pick a case to start again.' };
  if (order.payment === 'CONSENT_CHECKOUT') return { kind: 'consent-waiting', title: 'Waiting for the buyer at PayPal', text: 'PayPal shows the payment and the request to save the wallet for future agent purchases on one screen.' };
  const status = order.storePayable?.status;
  if (status === 'CANCELLED') return { kind: 'refused', title: 'PayPal refused the payment', text: 'PayPal clearly declined the saved-wallet payment, so nothing was charged. Pick a case to start again.' };
  if (status === 'PAYMENT_UNCONFIRMED')
    return { kind: 'unconfirmed', title: 'PayPal has not confirmed this payment', text: 'The agent sent the payment from the saved wallet and PayPal did not answer. The money may have moved, so the desk does not send a new payment. Asking again uses the same request id, and PayPal does not charge twice.' };
  if (status === 'PENDING_CAPTURE' && busy) return { kind: 'paying', title: 'Paying from the saved wallet', text: 'The agent is sending the payment to PayPal.' };
  return { kind: 'unknown', title: 'PayPal has not confirmed this payment yet', text: 'The desk has no answer from PayPal for this payment, so it does not send a new one.' };
}
