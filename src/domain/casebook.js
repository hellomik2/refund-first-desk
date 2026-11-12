// The case book: finished cases grouped by agent and by store, for whoever fixes the agent.
// "This agent broke which condition how many times, and here is the line." Read-only; nothing here moves money.
//
// A record is one case, reduced to what the book needs. Each first deviation is counted for the party whose
// step it was (the agent's log line or the store's line), and split by who was finally found responsible:
// an agent step can still end as the store's fault (a mislabelled listing) or the buyer's (the buyer asked for it).

export const OUTCOMES = ['AGENT', 'STORE', 'BUYER', 'UNDETERMINED', 'HUMAN_REVIEW', 'OPEN'];
// The 30 prepared cases carry no agent name: one scripted agent wrote all of their logs.
export const SCRIPTED_AGENT = { id: 'scripted', name: 'Scripted agent (prepared cases)' };

/** One case as the book sees it. order may be missing (measured runs keep cases, not orders). */
export function toRecord({ kase, order = null, scenarioId = null, title = null, store = null, amountCents = null }) {
  const inv = kase.investigation;
  const fd = inv?.firstDeviation;
  const step = fd?.kind === 'STEP' ? inv.steps?.find((s) => s.step === fd.step) : null;
  return {
    caseId: kase.id,
    scenarioId: scenarioId ?? order?.scenarioId ?? null,
    title,
    agent: order?.agent?.id ? { id: order.agent.id, name: order.agent.name || order.agent.id } : SCRIPTED_AGENT,
    store: store ?? order?.store ?? { id: 'unknown', name: 'Unknown store' },
    amountCents: amountCents ?? order?.totalCents ?? null,
    path: kase.path,
    outcome: kase.status === 'HUMAN_REVIEW' ? 'HUMAN_REVIEW' : kase.verdict?.liable || 'OPEN',
    decidedBy: !kase.verdict ? null : kase.verdict.rule === 'OPERATOR' ? 'PERSON' : 'TWO_KEYS',
    firstDeviation: fd ? { kind: fd.kind, step: fd.step ?? null, actor: step?.actor ?? null, condition: fd.condition ?? null, quote: fd.quote || '', verified: fd.verified ?? null } : null,
    recharge: kase.recharge?.status || null,
  };
}

/** Every case in one workspace's database. */
export function recordsFromState(data) {
  return Object.values(data.cases).map((kase) => toRecord({ kase, order: data.orders[kase.orderId] }));
}

const zero = () => Object.fromEntries(OUTCOMES.map((o) => [o, 0]));

function group(records, keyOf, actor, own) {
  const groups = new Map();
  for (const r of records) {
    const { id, name } = keyOf(r);
    if (!groups.has(id)) groups.set(id, { id, name, cases: 0, outcomes: zero(), deviations: 0, conditions: new Map(), caseIds: [] });
    const g = groups.get(id);
    g.cases += 1;
    g.outcomes[r.outcome] += 1;
    g.caseIds.push(r.scenarioId || r.caseId);
    const fd = r.firstDeviation;
    if (fd?.kind !== 'STEP' || fd.actor !== actor) continue;
    g.deviations += 1;
    const key = fd.condition || 'unnamed';
    if (!g.conditions.has(key)) g.conditions.set(key, { condition: key, count: 0, byOutcome: zero(), cases: [], example: null });
    const c = g.conditions.get(key);
    c.count += 1;
    c.byOutcome[r.outcome] += 1;
    const ref = { caseId: r.caseId, scenarioId: r.scenarioId, title: r.title, step: fd.step, quote: fd.quote, verified: fd.verified, outcome: r.outcome };
    c.cases.push(ref);
    // The example line: a verified quote from a case this party was responsible for, else any verified one.
    const rank = (x) => (x.verified ? 2 : 0) + (x.outcome === own ? 1 : 0);
    if (!c.example || rank(ref) > rank(c.example)) c.example = ref;
  }
  return [...groups.values()]
    .map((g) => ({ ...g, conditions: [...g.conditions.values()].sort((a, b) => b.count - a.count || a.condition.localeCompare(b.condition)) }))
    .sort((a, b) => b.outcomes[own] + b.deviations - (a.outcomes[own] + a.deviations) || a.name.localeCompare(b.name));
}

export function buildCaseBook(records) {
  const outcomes = zero();
  for (const r of records) outcomes[r.outcome] += 1;
  return {
    cases: records.length,
    outcomes,
    agents: group(records, (r) => r.agent, 'agent', 'AGENT'),
    stores: group(records, (r) => r.store, 'store', 'STORE'),
  };
}
