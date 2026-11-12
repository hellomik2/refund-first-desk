// HTTP server: a small JSON API over the desk plus the static demo UI. No framework.
// Every visitor gets a workspace: its own buyer profile, ledger, desk funds and policy clock, so
// one visitor fast-forwarding a notice period or using up instant refunds never affects another.
// All workspaces share the sandbox PayPal app and (for the default path) one pre-consented sandbox wallet.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { loadConfig } from './config.js';
import { createContext, fixtureFromCase } from './context.js';
import { DeskError } from './desk.js';
import { PayPalError, publicTrace } from './paypal/client.js';
import { buildCaseBook, recordsFromState } from './domain/casebook.js';
import { trustLimits } from './domain/trust.js';
import { loadCatalog } from './shop/catalog.js';
import { AGENTS } from './shop/agent.js';

const config = loadConfig();
const PUBLIC_DIR = join(config.root, 'public');
const CASES = JSON.parse(readFileSync(join(config.root, 'scenarios', 'cases.json'), 'utf8')).cases;
// The case book "after 30 cases": one measured run of the prepared cases (scripts/casebook-snapshot.mjs).
const MEASURED = JSON.parse(readFileSync(join(config.root, 'scenarios', 'casebook-measured.json'), 'utf8'));
const MEASURED_BOOK = { source: MEASURED.source, note: MEASURED._note, book: buildCaseBook(MEASURED.records) };
const CATALOG = loadCatalog(config.root);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

// ---- shared across workspaces ---------------------------------------------------------------------
const tokenStore = {};
const workspaces = new Map();
const META_FILE = join(config.dataDir, 'server-meta.json');
const meta = existsSync(META_FILE) ? JSON.parse(readFileSync(META_FILE, 'utf8')) : { purchasesByDay: {} };
const DAILY_PURCHASE_CAP = Number(process.env.DAILY_PURCHASE_CAP || 400); // protects the sandbox wallet from runaway use

function countPurchase() {
  const day = new Date().toISOString().slice(0, 10);
  if ((meta.purchasesByDay[day] || 0) >= DAILY_PURCHASE_CAP) throw new DeskError('DAILY_DEMO_LIMIT', 'The demo has reached its daily purchase limit. Try again tomorrow.');
  meta.purchasesByDay[day] = (meta.purchasesByDay[day] || 0) + 1;
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(META_FILE, JSON.stringify(meta));
}

function workspace(id) {
  if (!/^[a-z0-9]{12}$/.test(id || '')) throw new DeskError('BAD_WORKSPACE', 'Unknown workspace');
  if (!workspaces.has(id)) {
    if (!existsSync(join(config.dataDir, 'ws', id, 'db.json'))) throw new DeskError('BAD_WORKSPACE', 'Unknown workspace');
    workspaces.set(id, createContext({ dbName: join('ws', id), tokenStore, beforePay: countPurchase }));
  }
  return workspaces.get(id);
}

function newWorkspace() {
  const id = randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 12);
  const ctx = createContext({ dbName: join('ws', id), tokenStore, fresh: true, beforePay: countPurchase });
  ctx.desk.createBuyer({ name: 'Demo buyer', useDemoWallet: true });
  ctx.db.save();
  workspaces.set(id, ctx);
  return id;
}

// ---- what the browser is allowed to see -----------------------------------------------------------
/** What the next purchase of a workspace's buyer would get, from the buyer's own record (fixed again at purchase). */
function buyerLimitsOf(ctx) {
  const d = ctx.db.data;
  const buyer = Object.values(d.buyers)[0];
  return buyer ? trustLimits({ policy: config.policy, buyerCases: Object.values(d.cases).filter((c) => c.buyerId === buyer.id), now: ctx.clock.now() }) : null;
}

function view(id, ctx) {
  const d = ctx.db.data;
  const buyers = Object.values(d.buyers).map((b) => ({
    id: b.id,
    name: b.name,
    wallet: b.wallet && { consent: b.wallet.consent, source: b.wallet.source, consentAt: b.wallet.consentAt }, // vault and customer ids never leave the server
  }));
  const orders = Object.values(d.orders).map(({ fixtureFacts, fixtureDeep, fixtureQuick, pendingPayPalOrderId, paidWithVaultId, ...o }) => o); // the vault id stays on the server
  return {
    workspace: id,
    environment: 'PayPal sandbox',
    flags: {
      aiProvider: ctx.factExtractor.provider,
      aiModel: config.ai.provider === 'anthropic' ? config.ai.model : null,
      liveAgent: ctx.liveAgent.available,
      storePayout: config.storePayoutEmail ? 'PAYPAL_PAYOUTS' : 'LEDGER_ONLY',
    },
    policy: config.policy,
    // What the next purchase of this workspace's buyer would get, from the buyer's own record (fixed again at purchase).
    buyerLimits: buyerLimitsOf(ctx),
    clock: { now: ctx.clock.now().toISOString(), fastForwarded: ctx.clock.isFastForwarded() },
    buyers,
    mandates: Object.values(d.mandates),
    orders,
    cases: Object.values(d.cases),
    ledger: d.ledger,
    funds: {
      reserveStartCents: d.reserve.startCents,
      reserveBalanceCents: ctx.ledger.reserveBalanceCents(),
      reserveAllocatedCents: ctx.ledger.reserveAllocatedCents(),
      balances: Object.fromEntries(['buyer', 'desk:purchase', 'desk:reserve', 'store', 'paypal:fees'].map((a) => [a, ctx.ledger.balanceOf(a)])),
    },
    paypalCalls: d.paypalCalls.slice(-80).map(publicTrace), // saved-wallet ids in paths are masked
  };
}

function publicCase(sc) {
  // The answer key and the hand-written stand-in facts stay on the server.
  const { fixtureFacts, expected, why, firstDeviationQuote, firstDeviationCondition, ...rest } = sc;
  return rest;
}

// ---- actions --------------------------------------------------------------------------------------
const actions = {
  /** Approve the mandate of a prepared case: the buyer sees the condition slots and agrees once. */
  async mandate(ctx, { caseId }) {
    const sc = CASES.find((c) => c.id === caseId);
    if (!sc) throw new DeskError('NOT_FOUND', 'Unknown case');
    const buyer = Object.values(ctx.db.data.buyers)[0];
    const mandate = ctx.desk.draftMandate({ buyerId: buyer.id, instruction: sc.instruction, conditions: sc.conditions });
    mandate.caseId = sc.id;
    ctx.db.save();
    return { mandateId: mandate.id };
  },
  /**
   * The live agent's instruction: a prepared one (its condition slots are fixed in the catalog file) or the
   * visitor's own words, which the AI turns into condition slots. Either way the buyer approves them next.
   */
  async liveMandate(ctx, { promptId, instruction }) {
    const buyer = Object.values(ctx.db.data.buyers)[0];
    let text;
    let conditions;
    if (promptId) {
      const p = ctx.liveAgent.catalog.prompts.find((x) => x.id === promptId);
      if (!p) throw new DeskError('NOT_FOUND', 'Unknown instruction');
      ({ instruction: text, conditions } = p);
    } else {
      text = String(instruction || '').trim().slice(0, 300);
      if (text.length < 8) throw new DeskError('EMPTY_INSTRUCTION', 'Write what the agent should buy, in one or two sentences.');
      ({ conditions } = await ctx.liveAgent.draftConditions(text));
    }
    const mandate = ctx.desk.draftMandate({ buyerId: buyer.id, instruction: text, conditions });
    mandate.live = { promptId: promptId || null };
    ctx.db.save();
    return { mandateId: mandate.id };
  },
  /** The live agent shops the demo catalog and, if it decides to, pays from the saved wallet (a real sandbox charge). */
  async shop(ctx, { mandateId, kind }) {
    if (!['careful', 'hasty'].includes(kind)) throw new DeskError('BAD_CHOICE', 'Choose the careful or the hasty agent');
    const { mandate } = await ctx.liveAgent.shop({ mandateId, kind });
    return { status: mandate.live.status };
  },
  async approve(ctx, { mandateId }) {
    ctx.desk.approveMandate(mandateId);
    return {};
  },
  /** The agent pays from the saved wallet. A real sandbox charge. */
  async purchase(ctx, { mandateId }) {
    const mandate = ctx.db.data.mandates[mandateId];
    const sc = CASES.find((c) => c.id === mandate?.caseId);
    if (!sc) throw new DeskError('NOT_FOUND', 'Unknown mandate');
    countPurchase();
    const order = await ctx.desk.agentPurchase({
      mandateId,
      store: sc.store,
      cart: sc.cart,
      agentCart: sc.agentCart,
      agentLog: sc.agentLog,
      storeRecord: sc.storeRecord,
      scenarioId: sc.id,
      ...fixtureFromCase(sc),
    });
    return { orderId: order.id };
  },
  /** The first purchase, with the buyer present: PayPal shows the payment and the save-for-later consent together. */
  async consentPurchase(ctx, { mandateId, ws }) {
    const mandate = ctx.db.data.mandates[mandateId];
    const sc = CASES.find((c) => c.id === mandate?.caseId);
    if (!sc) throw new DeskError('NOT_FOUND', 'Unknown mandate');
    countPurchase();
    const { order, approveUrl } = await ctx.desk.startConsentPurchase({
      mandateId,
      store: sc.store,
      cart: sc.cart,
      agentCart: sc.agentCart,
      agentLog: sc.agentLog,
      storeRecord: sc.storeRecord,
      scenarioId: sc.id,
      ...fixtureFromCase(sc),
      returnQuery: `&ws=${ws}`,
    });
    if (!approveUrl) throw new DeskError('NO_APPROVE_URL', 'PayPal did not return an approval link.');
    return { orderId: order.id, approveUrl };
  },
  async cancelConsent(ctx, { orderId }) {
    ctx.desk.cancelConsentPurchase(orderId);
    return {};
  },
  /** One sentence in. If the limits allow, the PayPal refund is completed before this returns. */
  async report(ctx, { orderId, statement }) {
    if (!statement || !String(statement).trim()) throw new DeskError('EMPTY_REPORT', 'Tell us in one sentence what went wrong.');
    const { kase, duplicate } = await ctx.desk.reportProblem({ orderId, statement: String(statement).slice(0, 500) });
    return { caseId: kase.id, duplicate };
  },
  /** Quick check, deep check, two keys; a re-charge, store payout or agent invoice happens only when the keys agree. Otherwise the case waits for a person. */
  async investigate(ctx, { caseId }) {
    const kase = await ctx.desk.investigate(caseId);
    if (kase.verdict) await ctx.desk.settle(caseId);
    return { status: kase.status };
  },
  /** The operator's choice for a case in HUMAN_REVIEW: STORE, AGENT, BUYER or UNDETERMINED. */
  async resolveReview(ctx, { caseId, liable, note }) {
    await ctx.desk.resolveReview(caseId, String(liable || ''), String(note || '').slice(0, 500));
    return {};
  },
  async dispute(ctx, { caseId, text }) {
    await ctx.desk.fileDispute(caseId, String(text || '').slice(0, 500));
    return {};
  },
  async revoke(ctx) {
    const buyer = Object.values(ctx.db.data.buyers)[0];
    await ctx.desk.revokeConsent(buyer.id);
    return {};
  },
  /** Demo device: move the policy clock forward and run whatever became due. */
  async fastForward(ctx, { days }) {
    ctx.clock.fastForwardDays(Math.min(Math.max(Number(days) || 0, 1), 30));
    return { due: await ctx.desk.processDue() };
  },
  async reconcile(ctx, { orderId }) {
    return { reconciliation: await ctx.desk.reconcile(orderId) };
  },
};

// ---- http -----------------------------------------------------------------------------------------
function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20_000) throw new DeskError('TOO_LARGE', 'Request too large');
  }
  return raw ? JSON.parse(raw) : {};
}

function serveStatic(res, pathname) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^([/\\])+/, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) return send(res, 404, { error: 'NOT_FOUND' });
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(readFileSync(file));
}

const busy = new Set(); // one action at a time per workspace keeps the sequence of money movements simple to reason about

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/cases') return send(res, 200, { cases: CASES.map(publicCase) });
    if (req.method === 'GET' && url.pathname === '/api/casebook') {
      const id = url.searchParams.get('ws');
      const ctx = id ? workspace(id) : null;
      // the buyer's limit is read in the same moment as the book, so the two sides of the case book always agree
      return send(res, 200, { workspace: ctx ? buildCaseBook(recordsFromState(ctx.db.data)) : null, buyerLimits: ctx ? buyerLimitsOf(ctx) : null, measured: MEASURED_BOOK });
    }
    if (req.method === 'GET' && url.pathname === '/api/catalog') {
      const { stores, products, prompts } = CATALOG;
      return send(res, 200, { stores, products, prompts, agents: Object.fromEntries(Object.entries(AGENTS).map(([k, a]) => [k, { label: a.label, tools: a.tools }])) });
    }
    if (req.method === 'POST' && url.pathname === '/api/workspaces') {
      const id = newWorkspace();
      return send(res, 200, view(id, workspace(id)));
    }
    if (req.method === 'GET' && (url.pathname === '/paypal/return' || url.pathname === '/paypal/cancel')) {
      // PayPal sends the buyer back here after the approval screen. Capture (or close) the order, then show the page again.
      const ws = url.searchParams.get('ws') || '';
      const orderId = url.searchParams.get('order');
      let outcome = url.pathname === '/paypal/return' ? 'paypal=approved' : 'paypal=cancelled';
      try {
        const ctx = workspace(ws);
        if (busy.has(ws)) throw new DeskError('BUSY');
        busy.add(ws);
        try {
          if (url.pathname === '/paypal/return') await ctx.desk.completeConsentPurchase(orderId);
          else ctx.desk.cancelConsentPurchase(orderId);
          ctx.db.save();
        } finally {
          busy.delete(ws);
        }
      } catch (err) {
        console.error(`[server] ${url.pathname} failed: ${err.message}`);
        outcome = `paypal=failed&reason=${encodeURIComponent(err.code || err.issue || 'ERROR')}`;
      }
      res.writeHead(303, { Location: `/?ws=${encodeURIComponent(ws)}&${outcome}`, 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const id = url.searchParams.get('ws');
      return send(res, 200, view(id, workspace(id)));
    }
    const m = url.pathname.match(/^\/api\/act\/([a-zA-Z]+)$/);
    if (req.method === 'POST' && m && actions[m[1]]) {
      const body = await readJson(req);
      const ctx = workspace(body.ws);
      if (busy.has(body.ws)) throw new DeskError('BUSY', 'The previous step is still running.');
      busy.add(body.ws);
      try {
        const result = await actions[m[1]](ctx, body);
        ctx.db.save();
        return send(res, 200, { ...result, state: view(body.ws, ctx) });
      } finally {
        busy.delete(body.ws);
      }
    }
    if (req.method === 'GET') return serveStatic(res, url.pathname);
    return send(res, 404, { error: 'NOT_FOUND' });
  } catch (err) {
    if (err instanceof DeskError) return send(res, err.code === 'NOT_FOUND' || err.code === 'BAD_WORKSPACE' ? 404 : 409, { error: err.code, message: err.message });
    if (err instanceof PayPalError) return send(res, 502, { error: 'PAYPAL_ERROR', message: `PayPal answered ${err.status} ${err.issue}`, debugId: err.debugId });
    console.error(`[server] ${req.method} ${url.pathname} failed: ${err.message}`);
    return send(res, 500, { error: 'INTERNAL', message: 'Something went wrong on our side.' });
  }
});

server.listen(config.port, () => {
  console.log(`Refund-First Desk listening on ${config.publicBaseUrl} (PayPal sandbox, AI provider: ${config.ai.provider})`);
});
