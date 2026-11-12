// The desk: refund first, verify after.
//
//   report (one sentence) -> limit check -> PayPal refund -> only then: quick check -> deep check
//   (the AI investigator) -> two keys (rules and AI) -> settle, or a person decides when the keys differ
//
// Over a limit the order is: report -> quick check -> refund on the spot if it closes, otherwise
// deep check and two keys first ("check, then refund within 5 minutes").
// The quick check can only close in the buyer's favour: once it finds a mismatch the buyer can never
// be charged again for the order (kase.rechargeClosed). It does not decide who is responsible.
// The buyer sees each step as a notice (kase.notices).
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
import { limitWhy, trustLimits } from './domain/trust.js';
import { normalizeAgentLog, stepLine, violationCandidates } from './domain/agentlog.js';
import { ALL_FACTS, LIABLE, QUICK_AI_FACTS, applyCodeChecks, codeFacts, decideLiability, quoteFound, verifyFacts } from './domain/verdict.js';
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

// Payout item statuses (PayPal Payouts transaction_status). SUCCESS reached the store; these never will;
// any other (PENDING, UNCLAIMED, ONHOLD) may still be paid later and is looked up again.
const PAYOUT_NEVER_PAID = ['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED'];
const PAYOUT_RESEND_WINDOW_MS = 29 * 24 * 60 * 60 * 1000; // PayPal keeps a sender_batch_id for 30 days

export function createDesk({ db, paypal, factExtractor, clock, ledger, config, pollMs = 1500, refundWaitMs = 60_000, payoutWaitMs = 45_000 }) {
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
  /** What the buyer is told, in order, with the time. The screen shows this list as it is. */
  const notify = (kase, type, text) => {
    const atMs = Date.now();
    (kase.notices ||= []).push({ type, at: new Date(atMs).toISOString(), atMs, text }); // cases saved before notices existed have none
  };
  const CHECK_FIRST_BECAUSE = {
    OVER_PER_CASE_CAP: (p) => `it is over the $${fromCents(p.perCaseCapCents ?? policy.perCaseCapCents)} instant-refund limit`,
    NO_SAVED_WALLET_CONSENT: () => 'this purchase was made without a saved wallet',
    OVER_30_DAY_COUNT: (p) => {
      const n = p.refundsPer30Days ?? policy.refundsPer30Days;
      return n === 0 ? 'your record allows no instant refunds right now' : `you already had ${n} instant refund${n === 1 ? '' : 's'} in 30 days`;
    },
    RESERVE_TOO_LOW: () => "the desk's own funds are low right now",
    REFUND_CALL_FAILED: () => 'the instant refund did not go through',
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

  function newOrder({ mandate, buyer, store, cart, agentCart, agentLog, storeRecord, payment, scenarioId, fixtureFacts, fixtureDeep, fixtureQuick }) {
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
      fixtureDeep: fixtureDeep || null, // fixture provider only: first deviation and verdict for the deep check
      fixtureQuick: fixtureQuick || null, // fixture provider only: quick-check answers when a test sets them apart
    };
  }

  function recordCapture(order, buyer, parsed) {
    // The saved wallet that paid this order: the only one a re-charge for it may use (rechargeGuard).
    order.paidWithVaultId = buyer.wallet?.vaultId ?? null;
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
      limits: trustLimits({ policy, buyerCases: Object.values(S.cases).filter((c) => c.buyerId === buyer.id), now: clock.now() }),
    });
    order.storePayable.status = 'HELD';
    ledger.post({ orderId: order.id, kind: 'PURCHASE_CAPTURED', from: 'buyer', to: 'desk:purchase', cents: parsed.capture.grossCents, paypal: { type: 'capture', id: parsed.capture.id } });
    if (order.paypal.feeCents) {
      ledger.post({ orderId: order.id, kind: 'PAYPAL_FEE', from: 'desk:reserve', to: 'paypal:fees', cents: order.paypal.feeCents, paypal: { type: 'capture', id: parsed.capture.id }, note: 'PayPal fee on the purchase capture' });
    }
  }

  /** The agent pays from the wallet the buyer saved earlier. No buyer in front of a screen. */
  async function agentPurchase({ mandateId, store, cart, agentCart, agentLog, storeRecord, scenarioId, fixtureFacts, fixtureDeep, fixtureQuick }) {
    const mandate = must(S.mandates, mandateId, 'mandate');
    if (mandate.status !== 'APPROVED') throw new DeskError('MANDATE_NOT_APPROVED');
    const buyer = must(S.buyers, mandate.buyerId, 'buyer');
    if (buyer.wallet?.consent !== 'ACTIVE') throw new DeskError('NO_ACTIVE_CONSENT', 'The buyer has no saved wallet with active consent');
    const order = newOrder({ mandate, buyer, store, cart, agentCart, agentLog, storeRecord, payment: 'SAVED_WALLET', scenarioId, fixtureFacts, fixtureDeep, fixtureQuick });
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
  async function startConsentPurchase({ mandateId, store, cart, agentCart, agentLog, storeRecord, scenarioId, fixtureFacts, fixtureDeep, fixtureQuick, returnQuery = '' }) {
    const mandate = must(S.mandates, mandateId, 'mandate');
    if (mandate.status !== 'APPROVED') throw new DeskError('MANDATE_NOT_APPROVED');
    const buyer = must(S.buyers, mandate.buyerId, 'buyer');
    const order = newOrder({ mandate, buyer, store, cart, agentCart, agentLog, storeRecord, payment: 'CONSENT_CHECKOUT', scenarioId, fixtureFacts, fixtureDeep, fixtureQuick });
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
      quick: null, // the quick check: { closed, reasons, at, ... }
      rechargeClosed: false, // set once by a closing quick check; never cleared
      investigation: null, // the deep check
      review: null, // set when the two keys differ: a person decides
      verdict: null,
      notice: null,
      dispute: null,
      recharge: null,
      status: 'OPEN',
      notices: [],
      events: [],
    };
    S.cases[kase.id] = kase; // registered before the first await, so a concurrent report sees it
    notify(
      kase,
      'REFUND_REQUESTED',
      kase.path === 'REFUND_FIRST'
        ? 'Refund requested. We have your report and the refund is on its way.'
        : 'Refund requested. We have your report. This order is checked before any refund is sent.',
    );
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
    if (kase.path === 'VERIFY_FIRST') {
      const because =
        kase.limitCheck.reasons.map((r) => CHECK_FIRST_BECAUSE[r]?.(order.protection) || r).join('; ') +
        (kase.limitCheck.reasons.some((r) => r === 'OVER_PER_CASE_CAP' || r === 'OVER_30_DAY_COUNT') ? limitWhy(order.protection.limits) : '');
      notify(kase, 'CHECKING_FIRST', `We check this order before refunding it, because ${because}. If it was not your mistake, the refund follows within 5 minutes.`);
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
    const giveUpAt = Date.now() + refundWaitMs;
    for (;;) {
      refund = readRefund((await paypal.getRefund(kase.refund.id)).body);
      kase.refund.status = refund.status;
      if (refund.status === 'COMPLETED' || refund.status === 'FAILED' || refund.status === 'CANCELLED' || Date.now() > giveUpAt) break;
      await sleep(pollMs);
    }
    if (refund.status !== 'COMPLETED') {
      // PayPal accepted the refund but has not finished it (in the sandbox: funded by eCheck when the
      // desk's balance is short). Nothing is closed and no store is paid until a lookup says COMPLETED.
      event(kase, 'REFUND_PENDING', { status: refund.status });
      if (!kase.notices.some((n) => n.type === 'REFUND_PENDING')) {
        notify(kase, 'REFUND_PENDING', `PayPal accepted the refund and is still processing it (status ${refund.status}). Nothing is closed until PayPal reports it completed.`);
      }
      return;
    }
    completeRefund(kase, order, refund);
  }

  /** A refund left PENDING earlier: look it up again (no new refund is sent). */
  async function refreshRefund(kase, order) {
    if (!kase.refund?.id || kase.refund.completedAt) return;
    const refund = readRefund((await paypal.getRefund(kase.refund.id)).body);
    kase.refund.status = refund.status;
    if (refund.status === 'COMPLETED') completeRefund(kase, order, refund);
  }

  function completeRefund(kase, order, refund) {
    const completedAtMs = Date.now();
    kase.refund.amountCents = refund.amountCents ?? kase.refund.amountCents;
    kase.refund.completedAtMs = completedAtMs;
    kase.refund.completedAt = new Date(completedAtMs).toISOString();
    kase.refund.secondsFromReport = Math.round((completedAtMs - kase.receivedAtMs) / 10) / 100;
    ledger.post({ orderId: order.id, caseId: kase.id, kind: 'REFUND', from: 'desk:purchase', to: 'buyer', cents: kase.refund.amountCents, paypal: { type: 'refund', id: kase.refund.id } });
    event(kase, 'REFUND_COMPLETED', { refundId: kase.refund.id, seconds: kase.refund.secondsFromReport });
    notify(kase, 'REFUND_COMPLETED', `PayPal refund completed: $${fromCents(kase.refund.amountCents)} is back in your PayPal account. A card or bank statement can take a few days to show it.`);
  }

  /** Own funds set aside so an innocent store can still be paid once the purchase money is refunded. */
  function setAsideForStore(kase, order) {
    if (S.reserve.allocations[order.id]?.status === 'HELD') return;
    try {
      ledger.allocateReserve(order.id, kase.id, order.totalCents);
    } catch {
      // The desk's own funds cannot cover the store right now. The buyer is still refunded;
      // the store payment waits for an operator and is shown as waiting.
      order.storePayable.status = 'AWAITING_DESK_FUNDS';
      event(kase, 'RESERVE_SHORTFALL');
    }
  }

  // ---- investigate: only after the refund -----------------------------------------------------

  const orderLine = (l) => `${l.qty} x ${l.name} (sku ${l.sku}) @ $${fromCents(l.unitCents)}`;

  /** The two documents the quick check reads: what the buyer approved and what PayPal charged. */
  function quickEvidence({ mandate, paypalOrder }) {
    return {
      mandate: {
        title: 'Mandate approved by the buyer before the purchase',
        text: [`Instruction (buyer's words): ${mandate.instruction}`, `Approved at: ${mandate.approval.at}`, mandate.approval.approvedText].join('\n'),
      },
      paypal_order: {
        title: `PayPal order ${paypalOrder.orderId} (read back from PayPal)`,
        text: [
          `Status: ${paypalOrder.status}`,
          `Total: $${fromCents(paypalOrder.totalCents ?? 0)}`,
          `custom_id: ${paypalOrder.customId}`,
          'Items:',
          ...paypalOrder.items.map(orderLine),
        ].join('\n'),
      },
    };
  }

  function buildEvidence({ mandate, order, kase, paypalOrder, steps }) {
    const { mandate: mandateDoc, paypal_order } = quickEvidence({ mandate, paypalOrder });
    return {
      mandate: mandateDoc,
      agent_log: {
        title: "Agent's own log",
        text: [...steps.map(stepLine), 'Cart submitted by the agent:', ...(order.agentCart || order.cart).map(orderLine)].join('\n'),
      },
      paypal_order,
      store_record: {
        title: `Store order record from ${order.store.name} (provided by the demo store)`,
        text: order.storeRecord.join('\n') || '(the store has not provided a record)',
      },
      complaint: { title: "Buyer's report", text: kase.statement },
    };
  }

  const readPayPalOrder = async (order) => readOrder((await paypal.getOrder(order.paypal.orderId)).body);

  /**
   * Quick check: code computes what it can from the originals; only if that finds nothing does the AI
   * read the mandate and the PayPal order for item, exclusions (and quantity when code cannot tell).
   * Any "no" closes the re-charge for good. Over a limit, a closure is refunded on the spot.
   */
  async function quickCheck(kase, order, mandate) {
    const startedAtMs = Date.now();
    kase.quick = { startedAt: new Date(startedAtMs).toISOString(), startedAtMs };
    event(kase, 'QUICK_CHECK_STARTED');
    const paypalOrder = await readPayPalOrder(order);
    const code = codeFacts({ mandate, paypalOrder, agentCart: order.agentCart });
    const reasons = Object.entries(code)
      .filter(([, f]) => f.value === 'no')
      .map(([key, f]) => ({ key, by: 'code', doc: f.doc, quote: f.quote }));
    let ai = null;
    const aiFacts = {};
    let downgraded = [];
    if (!reasons.length) {
      const evidence = quickEvidence({ mandate, paypalOrder });
      const answer = await factExtractor.quick({ evidence, fixture: { facts: order.fixtureFacts, quick: order.fixtureQuick } });
      const checked = verifyFacts(answer.facts, evidence); // a quote must be in one of these two documents
      for (const key of QUICK_AI_FACTS.filter((k) => !code[k])) {
        aiFacts[key] = checked.facts[key];
        if (checked.facts[key].value === 'no') reasons.push({ key, by: 'ai', doc: checked.facts[key].evidence[0].doc, quote: checked.facts[key].evidence[0].quote });
      }
      downgraded = checked.downgraded.filter((k) => k in aiFacts);
      ai = { provider: answer.provider, model: answer.model || null, evidenceHash: answer.hash, ms: answer.ms ?? null, note: answer.note || null };
    }
    const finishedAtMs = Date.now();
    Object.assign(kase.quick, { closed: reasons.length > 0, reasons, at: new Date(finishedAtMs).toISOString(), codeFacts: code, aiFacts, downgraded, ai, finishedAtMs, ms: finishedAtMs - startedAtMs });
    if (!kase.quick.closed) {
      event(kase, 'QUICK_CHECK_OPEN');
      return;
    }
    kase.rechargeClosed = true;
    event(kase, 'QUICK_CHECK_CLOSED', { reasons: reasons.map((r) => r.key) });
    try {
      if (kase.path === 'VERIFY_FIRST' && !kase.refund?.completedAt) {
        setAsideForStore(kase, order);
        await refundNow(kase, order);
      }
    } finally {
      notify(kase, 'NO_RECHARGE', 'Checked: this order is not what you approved, so you will not be charged again for it. Nothing more to do.');
    }
  }

  /** The AI investigator reads every record; code then checks its quotes and computes its own key. */
  async function deepCheck(kase, order, mandate) {
    const startedAtMs = Date.now();
    kase.investigation = { startedAt: new Date(startedAtMs).toISOString(), startedAtMs };
    event(kase, 'INVESTIGATION_STARTED');

    const paypalOrder = await readPayPalOrder(order);
    const problems = [];
    const recomputed = fingerprintMandate({ instruction: mandate.instruction, conditions: mandate.conditions, approvedAt: mandate.approval.at });
    if (recomputed !== mandate.fingerprint) problems.push('MANDATE_RECORD_CHANGED_AFTER_APPROVAL');
    if (paypalOrder.customId !== `mandate:${mandate.fingerprint}`) problems.push('PAYPAL_ORDER_NOT_TIED_TO_THIS_MANDATE');
    if (!paypalOrder.capture) problems.push('NO_PAYPAL_CAPTURE');
    const integrity = { ok: problems.length === 0, problems };

    const steps = normalizeAgentLog(order.agentLog);
    const candidates = violationCandidates(steps, mandate.conditions);
    const evidence = buildEvidence({ mandate, order, kase, paypalOrder, steps });
    const answer = await factExtractor.deep({ evidence, statement: kase.statement, candidates, fixture: { facts: order.fixtureFacts, deep: order.fixtureDeep } });
    const { facts, downgraded } = verifyFacts(answer.facts, evidence);
    const overrides = applyCodeChecks(facts, { mandate, paypalOrder, agentCart: order.agentCart });
    const codeKey = decideLiability(facts, integrity);
    let aiKey;
    if (LIABLE.includes(answer.verdict?.liable)) aiKey = { liable: answer.verdict.liable, reason: answer.verdict.reason || '', source: answer.provider };
    else if (answer.provider === 'fixture') aiKey = { liable: codeKey.liable, reason: 'no hand-written verdict: the fixture reads the records the way the rules do', source: 'fixture-default' };
    else aiKey = { liable: 'UNDETERMINED', reason: `no verdict from the AI${answer.note ? ` (${answer.note})` : ''}`, source: answer.provider };

    const finishedAtMs = Date.now();
    Object.assign(kase.investigation, {
      finishedAt: new Date(finishedAtMs).toISOString(),
      finishedAtMs,
      durationMs: finishedAtMs - startedAtMs,
      evidence,
      steps,
      candidates,
      firstDeviation: checkFirstDeviation(answer.firstDeviation, steps),
      facts,
      downgraded,
      overrides,
      integrity,
      codeKey,
      aiKey,
      ai: { provider: answer.provider, model: answer.model || null, evidenceHash: answer.hash, ms: answer.ms ?? null, note: answer.note || null },
    });
  }

  /** The first deviation is a report (for whoever fixes the agent), never part of the decision. */
  function checkFirstDeviation(raw, steps) {
    const kind = ['STEP', 'NONE', 'INSUFFICIENT'].includes(raw?.kind) ? raw.kind : 'INSUFFICIENT';
    if (kind !== 'STEP') return { kind, step: null, condition: null, quote: '', verified: null, note: raw ? '' : 'no answer' };
    const step = steps.find((s) => s.step === raw.step);
    const verified = Boolean(step && quoteFound(step.content, raw.quote));
    return {
      kind,
      step: raw.step,
      condition: ALL_FACTS.includes(raw.condition) ? raw.condition : null,
      quote: raw.quote || '',
      verified,
      note: verified ? '' : 'quote not verified: it is not in that step',
    };
  }

  /** Two keys: the rules over the checked fact table, and the AI's own verdict. Money moves only when they agree. */
  function decide(kase) {
    const inv = kase.investigation;
    const { codeKey, aiKey } = inv;
    const keys = { code: codeKey.liable, ai: aiKey.liable };
    const decidedAt = new Date().toISOString();
    if (codeKey.rule === 'R0') {
      // The records cannot be tied together: buyer's side, without asking either key.
      kase.verdict = { ...codeKey, keys, agreed: null, decidedAt };
      event(kase, 'VERDICT', { liable: codeKey.liable, rule: codeKey.rule });
      return;
    }
    let reason = null;
    if (keys.code !== keys.ai) reason = 'KEYS_DISAGREE';
    else if (keys.code === 'BUYER' && kase.rechargeClosed) reason = 'QUICK_CLOSED_BUT_BOTH_BUYER'; // contradiction: a person looks
    if (!reason) {
      kase.verdict = { ...codeKey, keys, agreed: true, decidedAt };
      event(kase, 'VERDICT', { liable: codeKey.liable, rule: codeKey.rule });
      return;
    }
    kase.status = 'HUMAN_REVIEW';
    kase.review = { reason, code: codeKey, ai: aiKey, firstDeviation: inv.firstDeviation, openedAt: decidedAt };
    event(kase, 'HUMAN_REVIEW_OPENED', { reason, code: keys.code, ai: keys.ai });
    notify(
      kase,
      'HUMAN_REVIEW',
      kase.refund?.completedAt
        ? 'Two independent checks of this order disagree, so a person will look at it. Your refund stays where it is meanwhile.'
        : 'Two independent checks of this order disagree, so a person will decide. That can take longer than 5 minutes. Nothing is charged or paid out meanwhile.',
    );
  }

  const inFlight = new Set(); // case ids being checked right now: a second call never runs a check twice

  /** Quick check, deep check, two keys. Settling is a separate step (settle, or resolveReview for a person). */
  async function investigate(caseId) {
    const kase = must(S.cases, caseId, 'case');
    const order = must(S.orders, kase.orderId, 'order');
    const mandate = must(S.mandates, order.mandateId, 'mandate');
    if (kase.verdict || kase.status === 'HUMAN_REVIEW') return kase;
    if (kase.path === 'REFUND_FIRST' && !kase.refund?.completedAt) await refreshRefund(kase, order);
    if (kase.path === 'REFUND_FIRST' && !kase.refund?.completedAt) {
      // The order of operations is the product: no checking before the money is back.
      throw new DeskError('REFUND_NOT_COMPLETED', 'Investigation cannot start before the refund is completed');
    }
    if (inFlight.has(caseId)) throw new DeskError('CHECK_IN_PROGRESS', 'This case is being checked right now');
    inFlight.add(caseId);
    try {
      if (!kase.quick?.finishedAtMs) await quickCheck(kase, order, mandate);
      if (!kase.investigation?.finishedAt) await deepCheck(kase, order, mandate);
      decide(kase);
    } finally {
      inFlight.delete(caseId);
      db.save();
    }
    return kase;
  }

  /** A person chooses when the two keys differ. Choosing the buyer keeps the notice and dispute period. */
  async function resolveReview(caseId, liable, note = '') {
    const kase = must(S.cases, caseId, 'case');
    if (kase.status !== 'HUMAN_REVIEW') throw new DeskError('NOT_IN_REVIEW', 'This case is not waiting for a person');
    if (!LIABLE.includes(liable)) throw new DeskError('BAD_CHOICE', `Choose one of ${LIABLE.join(', ')}`);
    if (liable === 'BUYER' && kase.rechargeClosed) throw new DeskError('RECHARGE_CLOSED', 'The quick check closed the re-charge for this order; the buyer cannot be made responsible');
    const decidedAt = new Date().toISOString();
    kase.review = { ...kase.review, resolvedAt: decidedAt, resolvedLiable: liable, note: String(note) };
    kase.verdict = { liable, rule: 'OPERATOR', reasons: [], keys: { code: kase.review.code.liable, ai: kase.review.ai.liable }, agreed: false, note: String(note), decidedAt };
    kase.status = 'OPEN'; // set before the first await: a second decision on the same case is refused
    event(kase, 'REVIEW_RESOLVED', { liable });
    return settle(caseId);
  }

  // ---- settle -------------------------------------------------------------------------------------

  /** The store is paid once. Desk funds set aside for it stay set aside until PayPal reports the payout as SUCCESS. */
  async function payStore(order, kase, source, note) {
    if (order.storePayable.status === 'PAID' && source === 'desk:reserve') coverPrepaidStore(order, kase, note);
    if (['PAID', 'CANCELLED', 'AWAITING_DESK_FUNDS', 'PAYOUT_FAILED'].includes(order.storePayable.status)) return;
    if (order.storePayable.payout?.batchId || order.storePayable.status === 'PAYOUT_UNCONFIRMED') return followStorePayout(order, kase); // already sent: never sent as new
    const cents = order.storePayable.cents;
    if (!config.storePayoutEmail) {
      // No store PayPal account configured: the payment is shown on the ledger only and marked as such.
      ledger.post({ orderId: order.id, caseId: kase?.id || null, kind: 'STORE_PAID', from: source, to: 'store', cents, note, simulated: true });
      order.storePayable = { ...order.storePayable, status: 'PAID', source, simulated: true, paidAt: new Date().toISOString() };
      if (source === 'desk:reserve') ledger.settleAllocation(order.id, kase?.id || null, 'CONSUMED', note);
      return;
    }
    order.storePayable = { ...order.storePayable, source, note, simulated: false };
    await sendStorePayout(order, kase, payoutWaitMs);
  }

  /**
   * Send the store payout under one fixed sender_batch_id (store-<order id>). Sending again after an answer
   * was lost is safe: PayPal answers with the original payout, or refuses the repeated id and links it.
   */
  async function sendStorePayout(order, kase, waitMs) {
    const sp = order.storePayable;
    const resend = sp.status === 'PAYOUT_UNCONFIRMED'; // an earlier send may have reached PayPal
    if (!resend) sp.firstSentAtMs = Date.now();
    let batchId;
    try {
      batchId = readPayout((await paypal.createPayout({ batchId: `store-${order.id}`, receiverEmail: config.storePayoutEmail, amountCents: sp.cents, itemId: order.id, note: `Order ${order.id}: ${sp.note || ''}` })).body).batchId;
    } catch (err) {
      batchId = (err.links || []).map((l) => /\/v1\/payments\/payouts\/([^/?#]+)/.exec(l.href || '')?.[1]).find(Boolean);
      if (!batchId) {
        // Only a clear refusal of the first send (bad request, auth, not found, unprocessable) means nothing
        // was sent. Anything else (no answer, 5xx, 409, 429, or any answer to a repeat, which says nothing about
        // the original) may have been sent: it stays unconfirmed, keeps its set-aside, and is sent again later.
        const refused = !resend && err instanceof PayPalError && [400, 401, 403, 404, 422].includes(err.status);
        sp.status = refused ? 'PAYOUT_FAILED' : 'PAYOUT_UNCONFIRMED';
        sp.error = err.message;
        if (kase) event(kase, refused ? 'STORE_PAYOUT_FAILED' : 'STORE_PAYOUT_UNCONFIRMED', { error: err.message });
        return;
      }
    }
    // PayPal has the payout: keep its id before anything else can fail, so it is only ever looked up again.
    sp.status = 'PAYOUT_PENDING';
    delete sp.error;
    sp.payout = { batchId, itemId: null, itemStatus: null, feeCents: 0 };
    await refreshStorePayout(order, kase, waitMs);
  }

  /** A payout sent earlier and not final yet: look it up, or send it again under the same id if no answer ever came. */
  async function followStorePayout(order, kase) {
    const sp = order.storePayable;
    if (sp.status !== 'PAYOUT_UNCONFIRMED') return refreshStorePayout(order, kase);
    // PayPal keeps a sender_batch_id (and a request id) for 30 days. Past about 29 days of real time a repeat
    // could become a second payout, so it is never sent again: a person checks the PayPal account.
    if (Date.now() - (sp.firstSentAtMs ?? 0) > PAYOUT_RESEND_WINDOW_MS) {
      if (!sp.needsPerson && kase) event(kase, 'STORE_PAYOUT_NEEDS_PERSON', { error: 'no answer from PayPal for about 30 days' });
      sp.needsPerson = true;
      return;
    }
    return sendStorePayout(order, kase, 0);
  }

  /**
   * The store was already paid from the purchase money when its hold window ended, and the buyer reported
   * afterwards and was refunded. Purchase money went out twice, so the desk's own funds set aside for this
   * order cover the refund (an internal transfer; no PayPal movement) and the set-aside is closed.
   */
  function coverPrepaidStore(order, kase, note) {
    const a = S.reserve.allocations[order.id];
    const refunded = Object.values(S.cases).some((c) => c.orderId === order.id && c.refund?.completedAt);
    if (!a || a.status !== 'HELD' || !refunded || order.storePayable.status !== 'PAID' || order.storePayable.source !== 'desk:purchase') return;
    ledger.post({ orderId: order.id, caseId: kase?.id || null, kind: 'RESERVE_COVERS_REFUND', from: 'desk:reserve', to: 'desk:purchase', cents: a.cents, note: `store was paid before the report; desk funds cover the refund (${note})` });
    ledger.settleAllocation(order.id, kase?.id || null, 'CONSUMED', 'store was paid before the report; desk funds cover the refund');
  }

  /** Look a sent store payout up (waiting up to waitMs for a final status) and record what PayPal says. */
  async function refreshStorePayout(order, kase, waitMs = 0) {
    const sp = order.storePayable;
    if (sp.status !== 'PAYOUT_PENDING' || !sp.payout?.batchId) return;
    const giveUpAt = Date.now() + waitMs;
    let payout;
    try {
      for (;;) {
        payout = readPayout((await paypal.getPayout(sp.payout.batchId)).body);
        const s = payout.item?.status;
        if (s === 'SUCCESS' || PAYOUT_NEVER_PAID.includes(s) || Date.now() >= giveUpAt) break;
        await sleep(pollMs);
      }
    } catch (err) {
      if (kase) event(kase, 'STORE_PAYOUT_LOOKUP_FAILED', { error: err.message }); // stays pending with its id
      return;
    }
    const itemStatus = payout.item?.status || null;
    sp.payout = { ...sp.payout, itemId: payout.item?.id || null, itemStatus, feeCents: payout.feeCents ?? 0 };
    if (itemStatus === 'SUCCESS') {
      const ref = { type: 'payout_item', id: payout.item?.id || sp.payout.batchId };
      ledger.post({ orderId: order.id, caseId: kase?.id || null, kind: 'STORE_PAID', from: sp.source, to: 'store', cents: sp.cents, note: sp.note || '', paypal: ref });
      if (payout.feeCents) ledger.post({ orderId: order.id, caseId: kase?.id || null, kind: 'PAYPAL_FEE', from: 'desk:reserve', to: 'paypal:fees', cents: payout.feeCents, paypal: ref, note: 'PayPal fee on the store payout' });
      if (sp.source === 'desk:reserve') ledger.settleAllocation(order.id, kase?.id || null, 'CONSUMED', sp.note || 'store paid from desk funds');
      sp.status = 'PAID';
      sp.paidAt = new Date().toISOString();
      if (kase) event(kase, 'STORE_PAID', { source: sp.source, payoutItemStatus: itemStatus });
      // Sent from the purchase money before a report, confirmed after the refund: desk funds cover that refund.
      coverPrepaidStore(order, kase, 'store payout confirmed after the report');
      return;
    }
    if (PAYOUT_NEVER_PAID.includes(itemStatus)) {
      // Never reached the store. The desk funds set aside for it stay set aside: the store is still owed,
      // unless the store was found responsible, in which case it is not owed and the set-aside is released.
      if (kase?.verdict?.liable === 'STORE') {
        ledger.settleAllocation(order.id, kase.id, 'RELEASED', 'store is responsible and its payout did not go through');
        sp.storeOwesBack = false;
      }
      sp.status = 'PAYOUT_FAILED';
      if (kase) event(kase, 'STORE_PAYOUT_FAILED', { error: `PayPal payout item ${itemStatus}` });
      return;
    }
    // Still on its way (PENDING, UNCLAIMED, ONHOLD): looked up again on the next fast-forward or ledger check.
    if (kase && !kase.events.some((e) => e.type === 'STORE_PAYOUT_PENDING')) event(kase, 'STORE_PAYOUT_PENDING', { payoutItemStatus: itemStatus });
  }

  /** Apply the verdict. Money rules only; nothing here asks the AI anything. */
  async function settle(caseId) {
    const kase = must(S.cases, caseId, 'case');
    const order = must(S.orders, kase.orderId, 'order');
    // While a person has not decided, nothing moves: no re-charge, no store payout, no agent invoice.
    if (kase.status === 'HUMAN_REVIEW') throw new DeskError('IN_HUMAN_REVIEW', 'The two checks disagree; a person decides first');
    if (!kase.verdict) throw new DeskError('NO_VERDICT');
    if (kase.settledAt || kase.settling) return kase;
    const liable = kase.verdict.liable;
    if (liable === 'BUYER' && kase.rechargeClosed) throw new DeskError('RECHARGE_CLOSED', 'The quick check closed the re-charge for this order');
    kase.settling = true; // set before the first await so a repeated call cannot settle twice
    try {
      await applyVerdict(kase, order, liable);
    } catch (err) {
      // Cleared so the case can be settled again. A retry is safe: the refund reuses its request id,
      // the reserve is set aside once, and a store that is already paid is not paid again.
      delete kase.settling;
      event(kase, 'SETTLE_FAILED', { liable, error: err.message });
      db.save();
      throw err;
    }
    kase.settledAt = new Date().toISOString();
    delete kase.settling;
    db.save();
    return kase;
  }

  async function applyVerdict(kase, order, liable) {
    if (kase.path === 'VERIFY_FIRST' && liable !== 'BUYER' && !kase.refund?.completedAt) {
      // Over a limit, so the check came first. The buyer is not responsible: refund now.
      if (liable !== 'STORE') setAsideForStore(kase, order);
      if (kase.refund?.id) await refreshRefund(kase, order); // sent earlier and left PENDING: never sent twice
      else await refundNow(kase, order);
      // Refund first is the promise: no case closes and no store is paid while the buyer has no money back.
      if (!kase.refund?.completedAt) throw new DeskError('REFUND_PENDING', `The refund is not completed at PayPal yet (status ${kase.refund?.status || 'none'})`);
    }

    if (liable === 'STORE') {
      const sp = order.storePayable;
      if (['PAID', 'PAYOUT_PENDING', 'PAYOUT_UNCONFIRMED'].includes(sp.status)) {
        // The store was paid (or a payout was already sent) before the report. That fact is kept; the desk
        // records what the store owes back (shown only, not counted as funds) and its own funds cover the refund.
        sp.storeOwesBack = true;
        ledger.memo({ orderId: order.id, caseId: kase.id, kind: 'STORE_OWES_DESK', cents: order.totalCents, note: 'store responsible but paid before the report; to recover (shown only)' });
        coverPrepaidStore(order, kase, 'store responsible, paid before the report');
      } else {
        sp.status = 'CANCELLED';
        ledger.settleAllocation(order.id, kase.id, 'RELEASED', 'store is responsible and is not paid for this order');
      }
      kase.status = 'CLOSED_STORE_RESPONSIBLE';
    } else if (liable === 'AGENT') {
      // The set-aside is used when PayPal reports the payout as SUCCESS (refreshStorePayout), not before.
      await payStore(order, kase, 'desk:reserve', 'agent error, innocent store paid from the desk\'s own funds');
      ledger.memo({ orderId: order.id, caseId: kase.id, kind: 'AGENT_COMPANY_OWES', cents: order.totalCents, note: 'invoice to the agent company (shown only; not counted as funds until paid)' });
      kase.status = 'CLOSED_AGENT_RESPONSIBLE';
    } else if (liable === 'UNDETERMINED') {
      await payStore(order, kase, 'desk:reserve', 'could not be decided: buyer keeps the refund, desk pays the store');
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
        // Disputed while a person was deciding: the charge stops at once and the store is paid from desk funds.
        if (kase.dispute) await haltRecharge(kase, 'BUYER_DISPUTED');
      }
    }
  }

  // ---- re-charge and the things that stop it -----------------------------------------------------

  async function haltRecharge(kase, reason) {
    const order = S.orders[kase.orderId];
    kase.recharge = { ...(kase.recharge || {}), status: 'HALTED', blockedBy: reason, haltedAt: new Date().toISOString() };
    kase.status = 'RECHARGE_HALTED';
    event(kase, 'RECHARGE_HALTED', { reason });
    // The store did nothing wrong and is still paid, from the desk's own funds.
    await payStore(order, kase, 'desk:reserve', `re-charge halted (${reason}); store paid from desk funds`);
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
      // The wallet that paid this order is gone; no later wallet may stand in for it. The charge stops for good
      // and the innocent store is paid from the desk's own funds, as after a dispute.
      if (blockedBy === 'NOT_THE_WALLET_THAT_PAID' && kase.recharge?.status === 'SCHEDULED') await haltRecharge(kase, blockedBy);
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
    const caseOf = new Map(Object.values(S.cases).map((c) => [c.orderId, c]));
    for (const order of Object.values(S.orders)) {
      if (order.storePayable.status === 'HELD' && !caseOf.has(order.id) && now >= new Date(order.storePayable.releaseAt).getTime()) {
        await payStore(order, null, 'desk:purchase', 'no problem reported during the hold window');
      } else if (order.storePayable.status === 'PAYOUT_PENDING' || order.storePayable.status === 'PAYOUT_UNCONFIRMED') {
        await followStorePayout(order, caseOf.get(order.id) || null); // sent earlier and not final yet: look it up again
      } else continue;
      if (order.storePayable.status === 'PAID') done.storesPaid.push(order.id);
    }
    db.save();
    return done;
  }

  // ---- reconcile: ledger against PayPal -----------------------------------------------------------

  /** Recompute each party's total for one order from fresh PayPal lookups and compare with the ledger. */
  async function reconcile(orderId) {
    const order = must(S.orders, orderId, 'order');
    const kase = Object.values(S.cases).find((c) => c.orderId === orderId) || null;
    if (['PAYOUT_PENDING', 'PAYOUT_UNCONFIRMED'].includes(order.storePayable.status)) await followStorePayout(order, kase); // a payout still on its way is looked up first, so the ledger is current
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
      // The ledger books the payout fee only with a SUCCESS payout (refreshStorePayout); compared on the same terms.
      if (payout.item?.status === 'SUCCESS') {
        fromPayPal.store += payout.item.amountCents;
        fromPayPal['paypal:fees'] += payout.feeCents ?? 0;
      }
      lookups.push({ type: 'payout_item', id: payout.item?.id, status: payout.item?.status, amountCents: payout.item?.amountCents, feeCents: payout.feeCents });
    }
    const totals = ledger.orderTotals(orderId);
    const rows = Object.keys(fromPayPal).map((party) => {
      const ledgerCents = totals[party].netCents - totals[party].simulatedCents; // only what PayPal actually moved
      return { party, ledgerCents, paypalCents: fromPayPal[party], match: ledgerCents === fromPayPal[party] };
    });
    // A payout whose answer never came cannot be compared: the store side is unknown, so this never reads as a match.
    const storeUnknown = order.storePayable.status === 'PAYOUT_UNCONFIRMED';
    return { orderId, ok: !storeUnknown && rows.every((r) => r.match), storeUnknown, rows, simulatedStoreCents: totals.store.simulatedCents, lookups };
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
    resolveReview,
    settle,
    fileDispute,
    recharge,
    processDue,
    reconcile,
  };
}
