// What the buyer side says about an order PayPal has not recorded as paid. Pure, so the tests can read it.
// "Nothing was charged" is said only where it is known: the buyer turned back at PayPal, or PayPal clearly
// refused the payment (the order is CANCELLED). While the payment is being sent, and in any state this page
// does not know, it says the payment is not confirmed yet.

/** @returns {{kind: string, title: string, text: string} | null} null when the order is paid (order.paypal set). */
export function unpaidOrderView(order, { busy = false } = {}) {
  if (!order || order.paypal) return null;
  if (order.consentCancelled) return { kind: 'consent-cancelled', title: 'Cancelled at PayPal', text: 'The buyer turned back on the PayPal screen. Nothing was charged. Pick a case to start again.' };
  const status = order.storePayable?.status;
  const consent = order.payment === 'CONSENT_CHECKOUT';
  // Once the buyer approved and the capture was sent, the result is unknown until PayPal answers: never "waiting" again.
  const sent = !!order.captureSentAt || status === 'PAYMENT_UNCONFIRMED';
  if (consent && !sent) return { kind: 'consent-waiting', title: 'Waiting for the buyer at PayPal', text: 'PayPal shows the payment and the request to save the wallet for future agent purchases on one screen.' };
  if (status === 'CANCELLED') return { kind: 'refused', title: 'PayPal refused the payment', text: 'PayPal clearly declined the saved-wallet payment, so nothing was charged. Pick a case to start again.' };
  if (sent) {
    const pending = order.pendingCaptureStatus === 'PENDING'; // PayPal answered: the capture is still being processed
    return {
      kind: 'unconfirmed',
      title: pending ? 'PayPal is still processing this payment' : 'PayPal has not confirmed this payment',
      text: `${consent ? 'The buyer approved at PayPal and the payment was sent' : 'The agent sent the payment from the saved wallet'}${pending ? '. PayPal answered that it is still processing it.' : ' and PayPal did not answer.'} The money may have moved, so the desk does not send a new payment.${consent ? '' : ' Asking again uses the same request id, and PayPal does not charge twice.'}`,
    };
  }
  if (status === 'PENDING_CAPTURE' && busy) return { kind: 'paying', title: 'Paying from the saved wallet', text: 'The agent is sending the payment to PayPal.' };
  return { kind: 'unknown', title: 'PayPal has not confirmed this payment yet', text: 'The desk has no answer from PayPal for this payment, so it does not send a new one.' };
}
