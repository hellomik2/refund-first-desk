// The desk: refund first, verify after.
//
//   report (one sentence) -> limit check -> PayPal refund -> only then: investigate -> decide -> settle
//
// Settlement by responsibility:
//   STORE         store is not paid for this order
//   AGENT         store is paid from the desk's own funds; the agent company owes the desk
//   BUYER         notice -> waiting period -> re-charge the saved wallet -> store is paid from that money
//                 (a dispute, a withdrawn consent or a failed charge stops the re-charge for good)
//   UNDETERMINED  buyer keeps the refund; store is paid from the desk's own funds
import { conditionsAsText, fingerprintMandate, normalizeConditions } from './domain/mandate.js';
import { cartTotalCents, fromCents } from './domain/money.js';
import { addBusinessDays, checkAtReport, fixProtectionAtPurchase, rechargeGuard } from './domain/policy.js';
import { applyCodeChecks, decideLiability, verifyFacts } from './domain/verdict.js';
import { PayPalError } from './paypal/client.js';
import { readCapture, readOrder, readPayout, readRefund } from './paypal/api.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DeskError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export function createDesk({ db, paypal, factExtractor, clock, ledger, config, pollMs = 1500 }) {
  const S = db.data;
  const policy = config.policy;

  const must = (map, id, what) => {
    const v = map[id];
    if (!v) throw new DeskError('NOT_FOUND', `${what} ${id} not found`);
    return v;
  };
  const event = (kase, type, detail = {}) => {
    kase.events.push({ at: new Date().toISOString(), policyClock: clock.now().toISOString(), type, ...detail });
  };

  // ---- buyers and wallets ---------------------------------------------------------------------

  function createBuyer({ name, useDemoWallet = false }) {
    const buyer = { id: db.nextId('B'), name, wallet: null, createdAt: new Date().toISOString() };
    if (useDemoWallet) {
      if (!config.demoWallet.vaultId) throw new DeskError('NO_DEMO_WALLET', 'DEMO_VAULT_ID is not configured');
      buyer.wallet = {
        vaultId: config.demoWallet.vaultId,
        customerId: config.demoWallet.customerId || null,
        email: config.demoWallet.email || null,
        consent: 'ACTIVE',
        consentAt: null,
        source: 'DEMO_SHARED', // a sandbox wallet that gave consent earlier; shared by demo visitors
      };
    }
    S.buyers[buyer.id] = buyer;
    db.save();
    return buyer;
  }

  /** Withdraw save-for-later consent. After this the desk can never charge this buyer again. */
  async function revokeConsent(buyerId) {
    const buyer = must(S.buyers, buyerId, 'buyer');
    if (!buyer.wallet) return buyer;
    buyer.wallet.consent = 'REVOKED';
    buyer.wallet.revokedAt = new Date().toISOString();
    if (buyer.wallet.source === 'OWN') {
      // The buyer's own wallet token is deleted at PayPal. The shared demo wallet is only switched off here.
      await paypal.deletePaymentToken(buyer.wallet.vaultId).catch(() => {});
    }
    for (const kase of Object.values(S.cases)) {
      if (kase.buyerId === buyerId && kase.recharge?.status === 'SCHEDULED') {
        await haltRecharge(kase, 'NO_ACTIVE_CONSENT');
      }
    }
    db.save();
    return buyer;
  }

  // ---- mandate ----------------------------------------------------------------------------------

  function draftMandate({ buyerId, instruction, conditions }) {
    must(S.buyers, buyerId, 'buyer');
    const mandate = {
      id: db.nextId('M'),
      buyerId,
      instruction: String(instruction),
      conditions: normalizeConditions(conditions),
      status: 'DRAFT',
      approval: null,
      fingerprint: null,
    };
    mandate.conditionsText = conditionsAsText(mandate.conditions);
    S.mandates[mandate.id] = mandate;
    db.save();
    return mandate;
  }

  /** The buyer approves the condition slots once. The approved text and time are kept as their own record. */
  function approveMandate(mandateId) {
    const mandate = must(S.mandates, mandateId, 'mandate');
    if (mandate.status === 'APPROVED') return mandate;
    const approvedAt = new Date().toISOString();
    mandate.approval = { at: approvedAt, approvedText: mandate.conditionsText };
    mandate.fingerprint = fingerprintMandate({ instruction: mandate.instruction, conditions: mandate.conditions, approvedAt });
    mandate.status = 'APPROVED';
    db.save();
    return mandate;
  }

  // ---- purchase -----------------------------------------------------------------------------------

  function newOrder({ mandate, buyer, store, cart, agentCart, agentLog, storeRecord, payment, scenarioId, fixtureFacts }) {
    const totalCents = cartTotalCents(cart);
    const now = clock.now();
    return {
      id: db.nextId('O'),
      buyerId: buyer.id,
      mandateId: mandate.id,
      store: { id: store.id, name: store.name },
      cart, // what the store's checkout finally charged (this is what goes to PayPal)
      agentCart: agentCart || null, // what the agent submitted, when the store's final order differs from it
      totalCents,
      agentLog: agentLog || [],
      storeRecord: storeRecord || [],
      payment, // CONSENT_CHECKOUT (buyer present) | SAVED_WALLET (agent pays, buyer not present)
      paypal: null,
      protection: null,
      storePayable: { status: 'PENDING_CAPTURE', cents: totalCents, releaseAt: new Date(now.getTime() + policy.storeHoldDays * DAY_MS).toISOString() },
      createdAt: new Date().toISOString(),
      scenarioId: scenarioId || null,
      fixtureFacts: fixtureFacts || null,
    };
  }

  function recordCapture(order, buyer, parsed) {
    order.paypal = {
      orderId: parsed.orderId,
      captureId: parsed.capture.id,
      status: parsed.capture.status,
      feeCents: parsed.capture.feeCents ?? 0,
      capturedAt: new Date().toISOString(),
    };
    order.protection = fixProtectionAtPurchase({
      policy,
      totalCents: order.totalCents,
      walletConsentActive: buyer.wallet?.consent === 'ACTIVE',
      now: clock.now(),
    });
    order.storePayable.status = 'HELD';
    ledger.post({ orderId: order.id, kind: 'PURCHASE_CAPTURED', from: 'buyer', to: 'desk:purchase', cents: parsed.capture.grossCents, paypal: { type: 'capture', id: parsed.capture.id } });
    if (order.paypal.feeCents) {
      ledger.post({ orderId: order.id, kind: 'PAYPAL_FEE', from: 'desk:reserve', to: 'paypal:fees', cents: order.paypal.feeCents, paypal: { type: 'capture', id: parsed.capture.id }, note: 'PayPal fee on the purchase capture' });
    }
  }

  /** The agent pays from the wallet the buyer saved earlier. No buyer in front of a screen. */
  async function agentPurchase({ mandateId, store, cart, agentCart, agentLog, storeRecord, scenarioId, fixtureFacts }) {
    const mandate = must(S.mandates, mandateId, 'mandate');
    if (mandate.status !== 'APPROVED') throw new DeskError('MANDATE_NOT_APPROVED');
    const buyer = must(S.buyers, mandate.buyerId, 'buyer');
    if (buyer.wallet?.consent !== 'ACTIVE') throw new DeskError('NO_ACTIVE_CONSENT', 'The buyer has no saved wallet with active consent');
    const order = newOrder({ mandate, buyer, store, cart, agentCart, agentLog, storeRecord, payment: 'SAVED_WALLET', scenarioId, fixtureFacts });
    S.orders[order.id] = order;
    const res = await paypal.chargeSavedWallet({
      vaultId: buyer.wallet.vaultId,
      orderRef: order.id,
      mandateFingerprint: mandate.fingerprint,
      cart,
      totalCents: order.totalCents,
      description: `Agent purchase at ${store.name}`,
      requestId: `purchase-${order.id}`,
    });
    const parsed = readOrder(res.body);
    if (!parsed.capture || parsed.capture.status !== 'COMPLETED') {
      order.storePayable.status = 'CANCELLED';
      db.save();
      throw new DeskError('CAPTURE_NOT_COMPLETED', `PayPal order ${parsed.orderId} is ${parsed.status}`);
    }
    recordCapture(order, buyer, parsed);
    db.save();
    return order;
  }

  /** First purchase with the buyer present: PayPal shows the payment and the save-for-later consent on one screen. */
  async function startConsentPurchase({ mandateId, store, cart, agentCart, agentLog, storeRecord, scenarioId, fixtureFacts, returnQuery = '' }) {
    const mandate = must(S.mandates, mandateId, 'mandate');
    if (mandate.status !== 'APPROVED') throw new DeskError('MANDATE_NOT_APPROVED');
    const buyer = must(S.buyers, mandate.buyerId, 'buyer');
    const order = newOrder({ mandate, buyer, store, cart, agentCart, agentLog, storeRecord, payment: 'CONSENT_CHECKOUT', scenarioId, fixtureFacts });
    S.orders[order.id] = order;
    const res = await paypal.createConsentOrder({
      orderRef: order.id,
      mandateFingerprint: mandate.fingerprint,
      cart,
      totalCents: order.totalCents,
      description: `Purchase at ${store.name} with wallet saved for agent purchases`,
      returnUrl: `${config.publicBaseUrl}/paypal/return?order=${order.id}${returnQuery}`,
      cancelUrl: `${config.publicBaseUrl}/paypal/cancel?order=${order.id}${returnQuery}`,
      requestId: `consent-${order.id}`,
    });
    const parsed = readOrder(res.body);
    order.pendingPayPalOrderId = parsed.orderId;
    order.approveUrl = parsed.approveUrl;
    db.save();
    return { order, approveUrl: parsed.approveUrl };
  }

  /** The buyer turned back at PayPal. Nothing was charged; the order is closed. */
  function cancelConsentPurchase(orderId) {
    const order = must(S.orders, orderId, 'order');
    if (order.paypal) return order;
    order.consentCancelled = true;
    order.storePayable.status = 'CANCELLED';
    db.save();
    return order;
  }

  async function completeConsentPurchase(orderId) {
    const order = must(S.orders, orderId, 'order');
    if (order.paypal) return order;
    const buyer = must(S.buyers, order.buyerId, 'buyer');
    const res = await paypal.captureOrder(order.pendingPayPalOrderId, `capture-${order.id}`);
    const parsed = readOrder(res.body);
    if (!parsed.capture || parsed.capture.status !== 'COMPLETED') throw new DeskError('CAPTURE_NOT_COMPLETED');
    // Only the wallet that paid this order may ever be charged again for it. If PayPal did not save
    // it, the buyer has no saved wallet with consent and this purchase is protected "check first".
    buyer.wallet = parsed.vault?.id
      ? { vaultId: parsed.vault.id, customerId: parsed.vault.customerId, email: parsed.payerEmail, consent: 'ACTIVE', consentAt: new Date().toISOString(), source: 'OWN' }
      : null;
    recordCapture(order, buyer, parsed);
    db.save();
    return order;
  }

  // ---- report: refund first ---------------------------------------------------------------------

  /** One sentence from the buyer. If the limits allow it, the refund is sent before anything is checked. */
  async function reportProblem({ orderId, statement }) {
    const receivedAtMs = Date.now();
    const order = must(S.orders, orderId, 'order');
    if (!order.paypal?.captureId) throw new DeskError('ORDER_NOT_PAID');
    const existing = Object.values(S.cases).find((c) => c.orderId === orderId);
    if (existing) {
      // A second report on the same order never creates a second refund.
      event(existing, 'DUPLICATE_REPORT_IGNORED', { statement });
      db.save();
      return { kase: existing, duplicate: true };
    }
    const buyerCases = Object.values(S.cases).filter((c) => c.buyerId === order.buyerId);
    const limitCheck = checkAtReport({
      policy,
      order,
      buyerCases,
      reserveAvailableCents: ledger.reserveAvailableCents(),
      now: clock.now(),
    });
    const kase = {
      id: db.nextId('C'),
      orderId,
      buyerId: order.buyerId,
      statement: String(statement),
      receivedAt: new Date(receivedAtMs).toISOString(),
      receivedAtMs,
      path: limitCheck.refundFirst ? 'REFUND_FIRST' : 'VERIFY_FIRST',
      limitCheck,
      refund: null,
      investigation: null,
      verdict: null,
      notice: null,
      dispute: null,
      recharge: null,
      status: 'OPEN',
      events: [],
    };
    S.cases[kase.id] = kase; // registered before the first await, so a concurrent report sees it
    event(kase, 'REPORT_RECEIVED', { path: kase.path, reasons: limitCheck.reasons });
    if (kase.path === 'REFUND_FIRST') {
      ledger.allocateReserve(order.id, kase.id, order.totalCents);
      try {
        await refundNow(kase, order);
      } catch (err) {
        ledger.settleAllocation(order.id, kase.id, 'RELEASED', 'refund did not go through');
        kase.path = 'VERIFY_FIRST';
        kase.limitCheck.reasons.push('REFUND_CALL_FAILED');
        event(kase, 'REFUND_FAILED', { error: err.message });
      }
    }
    db.save();
    return { kase, duplicate: false };
  }

  async function refundNow(kase, order) {
    const requestId = `refund-${order.id}`; // same id on every retry: PayPal returns the first refund again
    const requestedAtMs = Date.now();
    const res = await paypal.refundCapture(order.paypal.captureId, {
      requestId,
      note: 'Refunded first by the resolution desk. What happened is checked afterwards.',
    });
    let refund = readRefund(res.body);
    kase.refund = { id: refund.id, requestId, status: refund.status, amountCents: refund.amountCents ?? order.totalCents, requestedAtMs };
    // The clock stops when PayPal's refund lookup says COMPLETED, not when our POST returns.
    const giveUpAt = Date.now() + 60_000;
    for (;;) {
      refund = readRefund((await paypal.getRefund(kase.refund.id)).body);
      kase.refund.status = refund.status;
      if (refund.status === 'COMPLETED' || refund.status === 'FAILED' || refund.status === 'CANCELLED' || Date.now() > giveUpAt) break;
      await sleep(pollMs);
    }
    if (refund.status !== 'COMPLETED') {
      event(kase, 'REFUND_PENDING', { status: refund.status });
      return;
    }
    const completedAtMs = Date.now();
    kase.refund.amountCents = refund.amountCents ?? kase.refund.amountCents;
    kase.refund.completedAtMs = completedAtMs;
    kase.refund.completedAt = new Date(completedAtMs).toISOString();
    kase.refund.secondsFromReport = Math.round((completedAtMs - kase.receivedAtMs) / 10) / 100;
    ledger.post({ orderId: order.id, caseId: kase.id, kind: 'REFUND', from: 'desk:purchase', to: 'buyer', cents: kase.refund.amountCents, paypal: { type: 'refund', id: kase.refund.id } });
    event(kase, 'REFUND_COMPLETED', { refundId: kase.refund.id, seconds: kase.refund.secondsFromReport });
  }

  // ---- investigate: only after the refund -----------------------------------------------------

  function buildEvidence({ mandate, order, kase, paypalOrder }) {
    const cartLines = (order.agentCart || order.cart).map((l) => `${l.qty} x ${l.name} (sku ${l.sku}) @ $${fromCents(l.unitCents)}`);
    const ppLines = paypalOrder.items.map((l) => `${l.qty} x ${l.name} (sku ${l.sku}) @ $${fromCents(l.unitCents)}`);
    return {
      mandate: {
        title: 'Mandate approved by the buyer before the purchase',
        text: [`Instruction (buyer's words): ${mandate.instruction}`, `Approved at: ${mandate.approval.at}`, mandate.approval.approvedText].join('\n'),
      },
      agent_log: {
        title: "Agent's own log",
        text: [...order.agentLog, 'Cart submitted by the agent:', ...cartLines].join('\n'),
      },
      paypal_order: {
        title: `PayPal order ${paypalOrder.orderId} (read back from PayPal)`,
        text: [
          `Status: ${paypalOrder.status}`,
          `Total: $${fromCents(paypalOrder.totalCents ?? 0)}`,
          `custom_id: ${paypalOrder.customId}`,
          'Items:',
          ...ppLines,
        ].join('\n'),
      },
      store_record: {
        title: `Store order record from ${order.store.name} (provided by the demo store)`,
        text: order.storeRecord.join('\n') || '(the store has not provided a record)',
      },
      complaint: { title: "Buyer's report", text: kase.statement },
    };
  }

  async function investigate(caseId) {
    const kase = must(S.cases, caseId, 'case');
    const order = must(S.orders, kase.orderId, 'order');
    const mandate = must(S.mandates, order.mandateId, 'mandate');
    if (kase.investigation?.finishedAt) return kase;
    if (kase.path === 'REFUND_FIRST' && !kase.refund?.completedAt) {
      // The order of operations is the product: no checking before the money is back.
      throw new DeskError('REFUND_NOT_COMPLETED', 'Investigation cannot start before the refund is completed');
    }
    const startedAtMs = Date.now();
    kase.investigation = { startedAt: new Date(startedAtMs).toISOString(), startedAtMs };
    event(kase, 'INVESTIGATION_STARTED');

    const paypalOrder = readOrder((await paypal.getOrder(order.paypal.orderId)).body);
    const problems = [];
    const recomputed = fingerprintMandate({ instruction: mandate.instruction, conditions: mandate.conditions, approvedAt: mandate.approval.at });
    if (recomputed !== mandate.fingerprint) problems.push('MANDATE_RECORD_CHANGED_AFTER_APPROVAL');
    if (paypalOrder.customId !== `mandate:${mandate.fingerprint}`) problems.push('PAYPAL_ORDER_NOT_TIED_TO_THIS_MANDATE');
    if (!paypalOrder.capture) problems.push('NO_PAYPAL_CAPTURE');
    const integrity = { ok: problems.length === 0, problems };

    const evidence = buildEvidence({ mandate, order, kase, paypalOrder });
    const answer = await factExtractor.extract({ evidence, statement: kase.statement, fixtureFacts: order.fixtureFacts });
    const { facts, downgraded } = verifyFacts(answer.facts, evidence);
    const overrides = applyCodeChecks(facts, { mandate, paypalOrder });
    const decision = decideLiability(facts, integrity);

    Object.assign(kase.investigation, {
      finishedAt: new Date().toISOString(),
      evidence,
      facts,
      downgraded,
      overrides,
      integrity,
      ai: { provider: answer.provider, model: answer.model || null, evidenceHash: answer.hash },
    });
    kase.verdict = { ...decision, decidedAt: new Date().toISOString() };
    event(kase, 'VERDICT', { liable: decision.liable, rule: decision.rule });
    db.save();
    return kase;
  }

  // ---- settle -------------------------------------------------------------------------------------

  async function payStore(order, kase, source, note) {
    if (['PAID', 'CANCELLED', 'AWAITING_DESK_FUNDS'].includes(order.storePayable.status)) return;
    const cents = order.storePayable.cents;
    const base = { orderId: order.id, caseId: kase?.id || null, kind: 'STORE_PAID', from: source, to: 'store', cents, note };
    if (!config.storePayoutEmail) {
      // No store PayPal account configured: the payment is shown on the ledger only and marked as such.
      ledger.post({ ...base, simulated: true });
      order.storePayable = { ...order.storePayable, status: 'PAID', source, simulated: true, paidAt: new Date().toISOString() };
      return;
    }
    const batchId = `store-${order.id}`;
    let payout;
    try {
      payout = readPayout((await paypal.createPayout({ batchId, receiverEmail: config.storePayoutEmail, amountCents: cents, itemId: order.id, note: `Order ${order.id}: ${note}` })).body);
    } catch (err) {
      order.storePayable = { ...order.storePayable, status: 'PAYOUT_FAILED', source, error: err.message };
      if (kase) event(kase, 'STORE_PAYOUT_FAILED', { error: err.message });
      return;
    }
    const giveUpAt = Date.now() + 45_000;
    for (;;) {
      payout = readPayout((await paypal.getPayout(payout.batchId)).body);
      const s = payout.item?.status;
      if (s === 'SUCCESS' || s === 'FAILED' || s === 'RETURNED' || s === 'BLOCKED' || s === 'UNCLAIMED' || Date.now() > giveUpAt) break;
      await sleep(pollMs);
    }
    ledger.post({ ...base, paypal: { type: 'payout_item', id: payout.item?.id || payout.batchId } });
    if (payout.feeCents) {
      ledger.post({ orderId: order.id, caseId: kase?.id || null, kind: 'PAYPAL_FEE', from: 'desk:reserve', to: 'paypal:fees', cents: payout.feeCents, paypal: { type: 'payout_item', id: payout.item?.id || payout.batchId }, note: 'PayPal fee on the store payout' });
    }
    order.storePayable = {
      ...order.storePayable,
      status: 'PAID',
      source,
      simulated: false,
      payout: { batchId: payout.batchId, itemId: payout.item?.id, itemStatus: payout.item?.status, feeCents: payout.feeCents ?? 0 },
      paidAt: new Date().toISOString(),
    };
    if (kase) event(kase, 'STORE_PAID', { source, payoutItemStatus: payout.item?.status });
  }

  /** Apply the verdict. Money rules only; nothing here asks the AI anything. */
  async function settle(caseId) {
    const kase = must(S.cases, caseId, 'case');
    const order = must(S.orders, kase.orderId, 'order');
    if (!kase.verdict) throw new DeskError('NO_VERDICT');
    if (kase.settledAt || kase.settling) return kase;
    kase.settling = true; // set before the first await so a repeated call cannot settle twice
    const liable = kase.verdict.liable;

    if (kase.path === 'VERIFY_FIRST' && liable !== 'BUYER' && !kase.refund?.completedAt) {
      // Over a limit, so the check came first. The buyer is not responsible: refund now.
      if (liable !== 'STORE') {
        try {
          ledger.allocateReserve(order.id, kase.id, order.totalCents);
        } catch {
          // The desk's own funds cannot cover the store right now. The buyer is still refunded;
          // the store payment waits for an operator and is shown as waiting.
          order.storePayable.status = 'AWAITING_DESK_FUNDS';
          event(kase, 'RESERVE_SHORTFALL');
        }
      }
      await refundNow(kase, order);
    }

    if (liable === 'STORE') {
      order.storePayable.status = 'CANCELLED';
      ledger.settleAllocation(order.id, kase.id, 'RELEASED', 'store is responsible and is not paid for this order');
      kase.status = 'CLOSED_STORE_RESPONSIBLE';
    } else if (liable === 'AGENT') {
      ledger.settleAllocation(order.id, kase.id, 'CONSUMED', 'innocent store paid from the desk\'s own funds');
      await payStore(order, kase, 'desk:reserve', 'agent error, store made whole from desk funds');
      ledger.memo({ orderId: order.id, caseId: kase.id, kind: 'AGENT_COMPANY_OWES', cents: order.totalCents, note: 'invoice to the agent company (shown only; not counted as funds until paid)' });
      kase.status = 'CLOSED_AGENT_RESPONSIBLE';
    } else if (liable === 'UNDETERMINED') {
      ledger.settleAllocation(order.id, kase.id, 'CONSUMED', 'could not be decided: buyer keeps the refund, desk pays the store');
      await payStore(order, kase, 'desk:reserve', 'undetermined, desk absorbs');
      kase.status = 'CLOSED_UNDETERMINED_BUYER_KEEPS_REFUND';
    } else if (liable === 'BUYER') {
      if (!kase.refund?.completedAt) {
        // Verify-first case where the buyer is responsible: nothing was refunded, nothing to charge again.
        await payStore(order, kase, 'desk:purchase', 'order matched the mandate');
        kase.status = 'CLOSED_NO_REFUND';
      } else {
        const now = clock.now();
        const amountCents = Math.min(kase.refund.amountCents, order.protection.buyerLiabilityCapCents);
        kase.notice = {
          sentAt: now.toISOString(),
          chargeNotBefore: addBusinessDays(now, order.protection.noticeBusinessDays).toISOString(),
          amountCents,
          text: `We refunded $${fromCents(kase.refund.amountCents)} first. The order matches what you approved, so we plan to charge $${fromCents(amountCents)} to your saved PayPal wallet after ${order.protection.noticeBusinessDays} business days. You can dispute this at any time before then and the charge will not happen.`,
        };
        kase.recharge = { status: 'SCHEDULED', amountCents };
        kase.status = 'NOTICE_SENT';
        event(kase, 'NOTICE_SENT', { chargeNotBefore: kase.notice.chargeNotBefore, amountCents });
      }
    }
    kase.settledAt = new Date().toISOString();
    delete kase.settling;
    db.save();
    return kase;
  }

  // ---- re-charge and the things that stop it -----------------------------------------------------

  async function haltRecharge(kase, reason) {
    const order = S.orders[kase.orderId];
    kase.recharge = { ...(kase.recharge || {}), status: 'HALTED', blockedBy: reason, haltedAt: new Date().toISOString() };
    kase.status = 'RECHARGE_HALTED';
    event(kase, 'RECHARGE_HALTED', { reason });
    // The store did nothing wrong and is still paid, from the desk's own funds.
    ledger.settleAllocation(order.id, kase.id, 'CONSUMED', `re-charge halted (${reason}); store paid from desk funds`);
    await payStore(order, kase, 'desk:reserve', `re-charge halted: ${reason}`);
  }

  /** The buyer objects to being charged again. The charge is stopped and stays stopped. */
  async function fileDispute(caseId, text = '') {
    const kase = must(S.cases, caseId, 'case');
    if (kase.dispute) return kase;
    if (kase.recharge?.status === 'COMPLETED') throw new DeskError('ALREADY_CHARGED', 'The re-charge already happened');
    kase.dispute = { at: new Date().toISOString(), text: String(text) };
    event(kase, 'DISPUTE_FILED');
    if (kase.recharge?.status === 'SCHEDULED') await haltRecharge(kase, 'BUYER_DISPUTED');
    db.save();
    return kase;
  }

  /**
   * Charge the buyer's saved wallet again. Every guard must pass; the amount can never exceed the
   * cap fixed at purchase or the amount that was refunded; the request id makes a repeat a no-op.
   */
  async function recharge(caseId, { amountCents } = {}) {
    const kase = must(S.cases, caseId, 'case');
    const order = must(S.orders, kase.orderId, 'order');
    const buyer = must(S.buyers, kase.buyerId, 'buyer');
    const mandate = must(S.mandates, order.mandateId, 'mandate');
    if (kase.recharge?.status === 'PENDING') return { charged: false, blockedBy: 'CHARGE_IN_PROGRESS', kase };
    const amount = amountCents ?? kase.recharge?.amountCents ?? kase.refund?.amountCents ?? 0;
    const blockedBy = rechargeGuard({ order, kase, buyer, amountCents: amount, now: clock.now() });
    if (blockedBy) {
      event(kase, 'RECHARGE_REFUSED', { blockedBy, amountCents: amount });
      db.save();
      return { charged: false, blockedBy, kase };
    }
    kase.recharge = { ...kase.recharge, status: 'PENDING', amountCents: amount, requestId: `recharge-${kase.id}` };
    let parsed;
    try {
      const res = await paypal.chargeSavedWallet({
        label: 're-charge-saved-wallet',
        vaultId: buyer.wallet.vaultId,
        orderRef: `${order.id}-RC`,
        mandateFingerprint: mandate.fingerprint,
        cart: [{ sku: 'RECHARGE', name: `Re-charge for order ${order.id} (refunded first, buyer responsible)`, qty: 1, unitCents: amount }],
        totalCents: amount,
        description: `Re-charge after refund-first, order ${order.id}`,
        requestId: kase.recharge.requestId,
      });
      parsed = readOrder(res.body);
      if (!parsed.capture || parsed.capture.status !== 'COMPLETED') throw new DeskError('CAPTURE_NOT_COMPLETED', `re-charge order is ${parsed.status}`);
    } catch (err) {
      const reason = err instanceof PayPalError ? `PAYPAL_${err.issue}` : err.code || 'CHARGE_FAILED';
      event(kase, 'RECHARGE_FAILED', { reason });
      await haltRecharge(kase, reason); // not collected: recorded as such, never retried silently
      db.save();
      return { charged: false, blockedBy: reason, kase };
    }
    kase.recharge = { ...kase.recharge, status: 'COMPLETED', paypalOrderId: parsed.orderId, captureId: parsed.capture.id, feeCents: parsed.capture.feeCents ?? 0, at: new Date().toISOString() };
    ledger.post({ orderId: order.id, caseId: kase.id, kind: 'RECHARGE_CAPTURED', from: 'buyer', to: 'desk:purchase', cents: parsed.capture.grossCents, paypal: { type: 'capture', id: parsed.capture.id } });
    if (kase.recharge.feeCents) {
      ledger.post({ orderId: order.id, caseId: kase.id, kind: 'PAYPAL_FEE', from: 'desk:reserve', to: 'paypal:fees', cents: kase.recharge.feeCents, paypal: { type: 'capture', id: parsed.capture.id }, note: 'PayPal fee on the re-charge capture' });
    }
    event(kase, 'RECHARGE_COMPLETED', { captureId: parsed.capture.id, amountCents: amount });
    kase.status = 'CLOSED_BUYER_RECHARGED';
    ledger.settleAllocation(order.id, kase.id, 'RELEASED', 'buyer charged again; purchase money is back');
    db.save();
    await payStore(order, kase, 'desk:purchase', 'buyer responsible, paid from the re-charged purchase money');
    db.save();
    return { charged: true, blockedBy: null, kase };
  }

  /** Run everything whose waiting period is over on the policy clock. */
  async function processDue() {
    const now = clock.now().getTime();
    const done = { recharged: [], storesPaid: [] };
    for (const kase of Object.values(S.cases)) {
      if (kase.recharge?.status === 'SCHEDULED' && now >= new Date(kase.notice.chargeNotBefore).getTime()) {
        const r = await recharge(kase.id);
        if (r.charged) done.recharged.push(kase.id);
      }
    }
    const withCase = new Set(Object.values(S.cases).map((c) => c.orderId));
    for (const order of Object.values(S.orders)) {
      if (order.storePayable.status === 'HELD' && !withCase.has(order.id) && now >= new Date(order.storePayable.releaseAt).getTime()) {
        await payStore(order, null, 'desk:purchase', 'no problem reported during the hold window');
        done.storesPaid.push(order.id);
      }
    }
    db.save();
    return done;
  }

  // ---- reconcile: ledger against PayPal -----------------------------------------------------------

  /** Recompute each party's total for one order from fresh PayPal lookups and compare with the ledger. */
  async function reconcile(orderId) {
    const order = must(S.orders, orderId, 'order');
    const kase = Object.values(S.cases).find((c) => c.orderId === orderId) || null;
    const fromPayPal = { buyer: 0, store: 0, 'paypal:fees': 0 };
    const lookups = [];
    const cap = readCapture((await paypal.getCapture(order.paypal.captureId)).body);
    fromPayPal.buyer -= cap.grossCents;
    fromPayPal['paypal:fees'] += cap.feeCents ?? 0;
    lookups.push({ type: 'capture', id: cap.id, status: cap.status, grossCents: cap.grossCents, feeCents: cap.feeCents });
    if (kase?.refund?.id) {
      const refund = readRefund((await paypal.getRefund(kase.refund.id)).body);
      if (refund.status === 'COMPLETED') fromPayPal.buyer += refund.amountCents;
      lookups.push({ type: 'refund', id: refund.id, status: refund.status, amountCents: refund.amountCents });
    }
    if (kase?.recharge?.captureId) {
      const rc = readCapture((await paypal.getCapture(kase.recharge.captureId)).body);
      fromPayPal.buyer -= rc.grossCents;
      fromPayPal['paypal:fees'] += rc.feeCents ?? 0;
      lookups.push({ type: 'recharge_capture', id: rc.id, status: rc.status, grossCents: rc.grossCents, feeCents: rc.feeCents });
    }
    if (order.storePayable.payout?.batchId) {
      const payout = readPayout((await paypal.getPayout(order.storePayable.payout.batchId)).body);
      if (payout.item?.status === 'SUCCESS') fromPayPal.store += payout.item.amountCents;
      fromPayPal['paypal:fees'] += payout.feeCents ?? 0;
      lookups.push({ type: 'payout_item', id: payout.item?.id, status: payout.item?.status, amountCents: payout.item?.amountCents, feeCents: payout.feeCents });
    }
    const totals = ledger.orderTotals(orderId);
    const rows = Object.keys(fromPayPal).map((party) => {
      const ledgerCents = totals[party].netCents - totals[party].simulatedCents; // only what PayPal actually moved
      return { party, ledgerCents, paypalCents: fromPayPal[party], match: ledgerCents === fromPayPal[party] };
    });
    return { orderId, ok: rows.every((r) => r.match), rows, simulatedStoreCents: totals.store.simulatedCents, lookups };
  }

  return {
    createBuyer,
    revokeConsent,
    draftMandate,
    approveMandate,
    agentPurchase,
    startConsentPurchase,
    completeConsentPurchase,
    cancelConsentPurchase,
    reportProblem,
    investigate,
    settle,
    fileDispute,
    recharge,
    processDue,
    reconcile,
  };
}
