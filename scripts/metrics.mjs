// Pass lines 3 and 10-15 and the report-only values (intent.md section 3, plan section 5), counted the
// same way by scripts/ai-eval.mjs and scripts/loop.mjs. Lines 3, 10 and 12-15 count only with the live
// AI; a run on the fixture provider shows the plumbing works and nothing more.
import { normalizeAgentLog } from '../src/domain/agentlog.js';
import { normalizeConditions } from '../src/domain/mandate.js';
import { cartTotalCents } from '../src/domain/money.js';
import { codeFacts } from '../src/domain/verdict.js';

const FIVE_MINUTES_S = 300;
const NOTICE_LIMIT_S = 10;

function firstDeviationMatches(fd, expected) {
  if (expected == null || !fd) return null; // the answer key has no first deviation yet
  return Number.isInteger(expected) ? fd.kind === 'STEP' && fd.step === expected : fd.kind === expected;
}

/** From the case file alone, without the desk: does code find a mismatch in mandate, cart and agent cart? */
function codeOnlyFromCase(sc) {
  const found = codeFacts({
    mandate: { conditions: normalizeConditions(sc.conditions) },
    paypalOrder: { items: sc.cart, totalCents: cartTotalCents(sc.cart) },
    agentCart: sc.agentCart,
  });
  return Object.values(found).some((f) => f.value === 'no');
}

/** One row per case, read from the desk's records after the run. */
export function caseRow({ sc, kase, order, db, policy }) {
  const notices = kase.notices || [];
  const noticeAtMs = (type) => notices.find((n) => n.type === type)?.atMs ?? null;
  const inv = kase.investigation || {};
  const lines = db.data.ledger.filter((l) => l.orderId === order.id);
  const steps = normalizeAgentLog(sc.agentLog);
  const firstPay = steps.find((s) => s.action === 'pay' || s.action === 'checkout');
  const closed = Boolean(kase.quick?.closed);
  const fd = inv.firstDeviation || null;
  return {
    id: sc.id,
    status: kase.status,
    expected: { liable: sc.expected.liable, firstDeviation: sc.expected.firstDeviation ?? null, quickClose: sc.expected.quickClose ?? null },
    overLimit: order.totalCents > policy.perCaseCapCents,
    codeOnlyByCaseFile: codeOnlyFromCase(sc),
    notices: notices.map((n) => n.type),
    quickClosed: closed,
    quickReasons: (kase.quick?.reasons || []).map((r) => `${r.key}(${r.by})`),
    quickMs: kase.quick?.ms ?? null,
    noRechargeSecondsAfterRefund: closed && kase.refund?.completedAtMs && noticeAtMs('NO_RECHARGE') ? (noticeAtMs('NO_RECHARGE') - kase.refund.completedAtMs) / 1000 : null,
    deepMs: inv.durationMs ?? null,
    firstDeviation: fd && { kind: fd.kind, step: fd.step, condition: fd.condition, verified: fd.verified },
    firstDeviationMatch: firstDeviationMatches(fd, sc.expected.firstDeviation),
    keys: inv.codeKey ? { code: inv.codeKey.liable, ai: inv.aiKey.liable } : null,
    review: kase.review ? kase.review.reason : null,
    decided: kase.verdict ? { liable: kase.verdict.liable, rule: kase.verdict.rule, agreed: kase.verdict.agreed } : null,
    refundCompleted: Boolean(kase.refund?.completedAt),
    refundSecondsFromReport: kase.refund?.completedAtMs ? (kase.refund.completedAtMs - kase.receivedAtMs) / 1000 : null,
    moneyMoved: {
      recharged: kase.recharge?.status === 'COMPLETED',
      storePaid: lines.some((l) => l.kind === 'STORE_PAID'),
      agentInvoiced: lines.some((l) => l.kind === 'AGENT_COMPANY_OWES'),
    },
    simpleRules: { lastStep: steps.at(-1)?.step ?? null, firstPayOrCheckout: firstPay ? firstPay.step : 'NONE' },
  };
}

const ids = (rows) => rows.map((r) => r.id);
const seconds = (list) => {
  const s = list.filter((v) => v != null).sort((a, b) => a - b);
  return s.length ? { n: s.length, min: s[0], median: s[Math.floor(s.length / 2)], max: s.at(-1) } : { n: 0 };
};

export function summarize(rows, { provider }) {
  const ok = rows.filter((r) => !r.error);
  const n = ok.length;
  const full = n === 30; // the pass lines are written for the 30 prepared cases
  const inReview = ok.filter((r) => r.review && !r.decided);
  const byKeys = ok.filter((r) => r.keys && r.decided?.rule !== 'R0');
  const scored = ok.filter((r) => r.firstDeviationMatch != null);
  const exp = (r) => r.expected.liable;

  const right3 = ok.filter((r) => r.decided && r.decided.agreed !== false && r.decided.liable === exp(r));
  const right10 = scored.filter((r) => r.firstDeviationMatch);
  const moneyInReview = inReview.filter((r) => Object.values(r.moneyMoved).some(Boolean));
  const disagreedOutside = byKeys.filter((r) => r.keys.code !== r.keys.ai && !r.review);
  const buyerClosed = ok.filter((r) => exp(r) === 'BUYER' && r.quickClosed);
  const wantClose = ok.filter((r) => r.expected.quickClose === true);
  const closedOfWanted = wantClose.filter((r) => r.quickClosed);
  const codeOnly = ok.filter((r) => r.codeOnlyByCaseFile);
  const closedRows = ok.filter((r) => r.quickClosed);
  const noticeTimes = closedRows.map((r) => r.noRechargeSecondsAfterRefund);
  const over = ok.filter((r) => r.overLimit);
  const overInnocent = over.filter((r) => exp(r) !== 'BUYER');
  const overBuyer = over.filter((r) => exp(r) === 'BUYER');
  const lateOrMissing = overInnocent.filter((r) => r.refundSecondsFromReport == null || r.refundSecondsFromReport > FIVE_MINUTES_S);
  const buyerRefunded = overBuyer.filter((r) => r.refundCompleted);
  const firstNoticeMissing = ok.filter((r) => r.notices[0] !== 'REFUND_REQUESTED');
  const rule = (key) => {
    const s = scored.filter((r) => r.simpleRules[key] === r.expected.firstDeviation);
    return { right: s.length, of: scored.length, rate: scored.length ? s.length / scored.length : null, overHalf: scored.length ? s.length / scored.length > 0.5 : null };
  };

  return {
    provider,
    countsForPassLines: provider !== 'fixture' && provider !== 'recorded', // lines 3, 10, 12-15 are measured with the live AI
    cases: rows.length,
    errors: rows.length - n,
    line3: { what: 'verdict right where the two keys agreed (human review counts as not right)', right: right3.length, of: n, wrong: ok.filter((r) => !right3.includes(r)).map((r) => `${r.id}: ${r.decided ? r.decided.liable : `review (${r.keys?.code}/${r.keys?.ai})`} vs ${exp(r)}`), pass: full ? right3.length >= 27 : null },
    line10: { what: 'first deviation matches the answer key', right: right10.length, of: scored.length, verifiedQuotes: scored.filter((r) => r.firstDeviation?.kind === 'STEP' && r.firstDeviation.verified).length, wrong: scored.filter((r) => !r.firstDeviationMatch).map((r) => `${r.id}: ${r.firstDeviation?.kind === 'STEP' ? r.firstDeviation.step : r.firstDeviation?.kind} vs ${r.expected.firstDeviation}`), pass: full && scored.length === n ? right10.length >= 27 : null },
    line11: { what: 'keys disagree: no money moves and the case waits for a person', inReview: ids(inReview), moneyMovedInReview: ids(moneyInReview), disagreedButNotInReview: ids(disagreedOutside), pass: moneyInReview.length === 0 && disagreedOutside.length === 0, note: 'the three or more deliberate disagreements are in test/investigator.test.js' },
    line12: { what: 'buyer-responsible cases closed by the quick check', buyerCases: ok.filter((r) => exp(r) === 'BUYER').length, closed: ids(buyerClosed), pass: buyerClosed.length === 0 },
    line13: {
      what: 'quick check closes the cases the answer key marks for it',
      marked: wantClose.length,
      closed: closedOfWanted.length,
      rate: wantClose.length ? closedOfWanted.length / wantClose.length : null,
      markedNotClosed: ids(wantClose.filter((r) => !r.quickClosed)),
      closedNotMarked: ids(closedRows.filter((r) => r.expected.quickClose === false)),
      codeOnlyByCaseFile: ids(codeOnly),
      codeOnlyNotClosed: ids(codeOnly.filter((r) => !r.quickClosed)),
      pass: wantClose.length ? closedOfWanted.length / wantClose.length >= 0.9 && codeOnly.every((r) => r.quickClosed) : null,
    },
    line14: { what: 'seconds from refund completed to the NO_RECHARGE notice', closed: closedRows.length, seconds: seconds(noticeTimes), over10s: ids(closedRows.filter((r) => r.noRechargeSecondsAfterRefund == null || r.noRechargeSecondsAfterRefund > NOTICE_LIMIT_S)), pass: closedRows.length ? noticeTimes.every((s) => s != null && s <= NOTICE_LIMIT_S) : null },
    line15: {
      what: 'over the limit: not the buyer -> refunded within 5 minutes; the buyer -> no refund (dispute button is a screen check); every case -> REFUND_REQUESTED first',
      overLimit: ids(over),
      notBuyer: overInnocent.map((r) => ({ id: r.id, refundSeconds: r.refundSecondsFromReport, status: r.status })),
      buyer: overBuyer.map((r) => ({ id: r.id, refunded: r.refundCompleted, status: r.status })),
      lateOrMissing: ids(lateOrMissing),
      buyerRefunded: ids(buyerRefunded),
      firstNoticeNotRefundRequested: ids(firstNoticeMissing),
      pass: lateOrMissing.length === 0 && buyerRefunded.length === 0 && firstNoticeMissing.length === 0,
    },
    report: {
      keysAgreementRate: byKeys.length ? byKeys.filter((r) => r.keys.code === r.keys.ai).length / byKeys.length : null,
      humanReviewRate: n ? inReview.length / n : null,
      bothKeysWrong: ids(byKeys.filter((r) => r.keys.code !== exp(r) && r.keys.ai !== exp(r))),
      agreedAndWrong: ids(byKeys.filter((r) => r.keys.code === r.keys.ai && r.keys.code !== exp(r))),
      deepCheckSeconds: seconds(ok.map((r) => (r.deepMs == null ? null : r.deepMs / 1000))),
      quickCheckSeconds: seconds(ok.map((r) => (r.quickMs == null ? null : r.quickMs / 1000))),
      simpleRuleLastStep: rule('lastStep'),
      simpleRuleFirstPayOrCheckout: rule('firstPayOrCheckout'),
    },
  };
}

export function printPassLines(summary) {
  const mark = (p) => (p === true ? 'PASS' : p === false ? 'FAIL' : '----');
  console.log(`\nPass lines (${summary.countsForPassLines ? 'live AI' : `${summary.provider}: plumbing only, does not count`})`);
  for (const k of ['line3', 'line10', 'line11', 'line12', 'line13', 'line14', 'line15']) console.log(`  ${mark(summary[k].pass)} ${k.slice(4)}. ${summary[k].what}`);
  const r = summary.report;
  console.log(`  report: keys agree ${r.keysAgreementRate == null ? '-' : (r.keysAgreementRate * 100).toFixed(0)}%, human review ${r.humanReviewRate == null ? '-' : (r.humanReviewRate * 100).toFixed(0)}%, both keys wrong ${r.bothKeysWrong.length}, agreed and wrong ${r.agreedAndWrong.length}, deep check median ${r.deepCheckSeconds.median ?? '-'} s, simple rules last-step ${r.simpleRuleLastStep.right}/${r.simpleRuleLastStep.of} first-pay ${r.simpleRuleFirstPayOrCheckout.right}/${r.simpleRuleFirstPayOrCheckout.of}`);
}
