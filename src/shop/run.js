// One live shopping run, wired to the desk: caps first, then the agent loop (src/shop/agent.js) with the
// desk's saved-wallet purchase as its payment, then the full log attached to the order. Progress is written
// to the mandate as each step happens, so the page can show the agent working.
import { randomBytes } from 'node:crypto';
import { DeskError } from '../desk.js';
import { AGENTS, runShoppingAgent } from './agent.js';

/**
 * @param {object} o
 * @param {() => Promise<{agentTurn: Function}>} o.provider  the live model (created on first use)
 * @param {{agentBlockedBy: Function, releaseRun: Function, spendBlockedBy: Function, runUsd: Function}} o.budget
 * @param {{dailyRunCap: number, runsPerWorkspace: number, maxCalls: number}} o.caps
 */
export function createLiveShopper({ desk, db, catalog, provider, budget, caps, beforePay = () => {} }) {
  async function shop({ mandateId, kind }) {
    const mandate = db.data.mandates[mandateId];
    if (!mandate?.live) throw new DeskError('NOT_FOUND', 'Unknown live mandate');
    if (mandate.status !== 'APPROVED') throw new DeskError('MANDATE_NOT_APPROVED');
    if (mandate.live.status) throw new DeskError('ALREADY_RUN', 'This instruction was already given to an agent. Start a new one.');
    const runsHere = Object.values(db.data.mandates).filter((m) => m.live?.status).length;
    if (runsHere >= caps.runsPerWorkspace) throw new DeskError('WORKSPACE_AGENT_LIMIT', `A workspace can run the live agent ${caps.runsPerWorkspace} times. Start a fresh workspace to try more.`);
    // From the checks to marking the run, nothing awaits: two starts at the same moment cannot both pass.
    const runId = `R${randomBytes(6).toString('hex')}`;
    const blocked = budget.agentBlockedBy({ dailyRunCap: caps.dailyRunCap, holdFor: runId });
    if (blocked) throw new DeskError(blocked, blocked === 'DAILY_AGENT_RUN_CAP' ? 'The live agent has reached its daily limit. The prepared cases still run.' : 'The AI spending cap is reached.');
    const live = mandate.live;
    const started = { kind, runId, status: 'RUNNING', startedAt: new Date().toISOString(), steps: [], calls: 0 };
    Object.assign(live, started);
    try {
      return await runHeld(mandateId, mandate, live, started);
    } finally {
      budget.releaseRun(runId); // from here the run counts through its calls in the usage file
    }
  }

  async function runHeld(mandateId, mandate, live, { kind, runId }) {
    let model;
    try {
      model = await provider();
    } catch (err) {
      // No live AI, no run: the instruction is left as it was, to be run again.
      for (const k of ['kind', 'runId', 'status', 'startedAt', 'steps', 'calls']) delete live[k];
      throw err;
    }
    db.save();
    const turn = async (params) => {
      live.calls += 1;
      db.save();
      return model.agentTurn({ ...params, runId });
    };
    const pay = async ({ store, cart }) => {
      beforePay();
      let order;
      try {
        order = await desk.agentPurchase({ mandateId, store, cart, agentCart: cart, agentLog: [], storeRecord: [] });
      } catch (err) {
        if (err.orderId) live.orderId = err.orderId; // a payment PayPal has not confirmed yet stays tied to this run
        throw err;
      }
      live.orderId = order.id;
      // What PayPal charged: an earlier payment PayPal had not confirmed can be the one recorded here.
      return { orderId: order.id, paypalOrderId: order.paypal.orderId, totalCents: order.totalCents, store: order.store, cart: order.cart };
    };
    let run;
    try {
      run = await runShoppingAgent({
        catalog,
        instruction: mandate.instruction,
        conditions: mandate.conditions,
        kind,
        turn,
        pay,
        maxCalls: caps.maxCalls,
        blockedBy: budget.spendBlockedBy,
        onStep: (_step, steps) => {
          live.steps = steps.map((s) => ({ ...s }));
          db.save();
        },
      });
    } catch (err) {
      Object.assign(live, { status: 'FAILED', error: err.message, finishedAt: new Date().toISOString(), usd: budget.runUsd(runId) });
      db.save();
      throw err;
    }
    if (run.purchase) {
      const a = AGENTS[kind];
      desk.attachAgentRecord(run.purchase.orderId, { agentLog: run.steps, storeRecord: run.storeRecord, agent: { id: a.id, name: `${a.label} (live Claude)` } });
    }
    const unconfirmed = !run.purchase && db.data.orders[live.orderId]?.storePayable.status === 'PAYMENT_UNCONFIRMED';
    Object.assign(live, {
      status: run.purchase ? 'PAID' : unconfirmed ? 'PAYMENT_UNCONFIRMED' : 'NOT_PAID',
      steps: run.steps,
      cart: run.priced ? { store: run.priced.store, items: run.priced.items, totalCents: run.priced.totalCents } : null,
      finalText: run.finalText,
      stopReason: run.stopReason,
      finishedAt: new Date().toISOString(),
      usd: budget.runUsd(runId),
    });
    db.save();
    return { mandate, run };
  }
  return { shop };
}
