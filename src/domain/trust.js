// The instant-refund limit for one purchase, moved by the buyer's own record. Plain code; the AI never
// sets it. It is worked out at purchase time and fixed on the order with the reason (protection.limits).
//
//   start      the policy numbers ($50 a case, 2 instant refunds per 30 days)
//   up         each earlier case of this buyer closed as the agent's or the store's responsibility
//              (both keys agreed, or a person chose): +step per case and +1 refund, at most maxUp cases
//   down       each earlier case where this buyer was found responsible (both keys agreed, or a person
//              chose) and did not dispute: -step per case and -1 refund. The only way a limit goes down.
//   floor      $0 and 0 refunds: every purchase is checked first
//
// Only cases reported within windowDays (policy clock) count. Agents' and stores' records do not move a
// buyer's limit: they are shown to the agent's operator in the case book instead.

const DAY_MS = 24 * 60 * 60 * 1000;

const decided = (c) => c.verdict && c.status !== 'HUMAN_REVIEW' && (c.verdict.agreed === true || c.verdict.rule === 'OPERATOR');

export function trustLimits({ policy, buyerCases, now }) {
  const start = { perCaseCapCents: policy.perCaseCapCents, refundsPer30Days: policy.refundsPer30Days };
  const step = policy.trustStepCents ?? 0;
  const since = new Date(now).getTime() - (policy.trustWindowDays ?? 180) * DAY_MS;
  const recent = buyerCases.filter((c) => decided(c) && new Date(c.receivedAt).getTime() >= since).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const up = recent.filter((c) => c.verdict.liable === 'AGENT' || c.verdict.liable === 'STORE').slice(0, policy.trustMaxUp ?? 2);
  const down = recent.filter((c) => c.verdict.liable === 'BUYER' && !c.dispute);
  const basis = [
    ...up.map((c) => ({ caseId: c.id, orderId: c.orderId, liable: c.verdict.liable, decidedBy: c.verdict.rule === 'OPERATOR' ? 'PERSON' : 'TWO_KEYS', effect: 'UP', cents: step, refunds: 1 })),
    ...down.map((c) => ({ caseId: c.id, orderId: c.orderId, liable: 'BUYER', decidedBy: c.verdict.rule === 'OPERATOR' ? 'PERSON' : 'TWO_KEYS', effect: 'DOWN', cents: -step, refunds: -1 })),
  ];
  if (!step) basis.length = 0; // a step of 0 switches the record off: the policy numbers apply as they are
  const sum = (k) => basis.reduce((s, b) => s + b[k], 0);
  return {
    start,
    perCaseCapCents: Math.max(0, start.perCaseCapCents + sum('cents')),
    refundsPer30Days: Math.max(0, start.refundsPer30Days + sum('refunds')),
    basis,
    windowDays: policy.trustWindowDays ?? 180,
  };
}

const usd = (cents) => `$${(Math.abs(cents) / 100).toFixed(2).replace(/\.00$/, '')}`;

/** The reason in the buyer's words, for a notice: which earlier cases moved this purchase's limit. Empty when none did. */
export function limitWhy(limits) {
  if (!limits?.basis?.length) return '';
  const parts = limits.basis.map((b) =>
    b.effect === 'DOWN'
      ? `case ${b.caseId} found you responsible (${usd(b.cents)} lower, one refund fewer)`
      : `case ${b.caseId} was the ${b.liable === 'AGENT' ? "agent's" : "store's"} fault (${usd(b.cents)} higher, one refund more)`,
  );
  return ` (this purchase's limit was set from your own record: ${parts.join('; ')})`;
}
