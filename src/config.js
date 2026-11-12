// Configuration. Secrets come from the environment (or a local .env that is never committed).
// Nothing in this module prints or returns secret values to callers that log.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

export function loadConfig(overrides = {}) {
  // Local development keeps .env one level above the repository so it cannot be committed by accident.
  const fileEnv = { ...readEnvFile(join(ROOT, '..', '.env')), ...readEnvFile(join(ROOT, '.env')) };
  const env = { ...fileEnv, ...process.env, ...overrides };
  const port = Number(env.PORT || 8787);
  const apiBase = env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
  if (!/sandbox/.test(apiBase)) {
    // The re-charge flow needs PayPal approval (billing agreements) on live accounts. This build is sandbox only.
    throw new Error('Refund-First Desk runs against the PayPal sandbox only.');
  }
  return {
    root: ROOT,
    port,
    // Render sets RENDER_EXTERNAL_URL to the service's own https address.
    publicBaseUrl: (env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    dataDir: env.DATA_DIR || join(ROOT, 'data'),
    paypal: {
      apiBase,
      clientId: env.PAYPAL_CLIENT_ID || '',
      clientSecret: env.PAYPAL_CLIENT_SECRET || '',
    },
    // A sandbox buyer wallet that already gave save-for-later consent, so judges can run the
    // agent-pays-with-saved-wallet path without logging in to a sandbox account.
    demoWallet: {
      vaultId: env.DEMO_VAULT_ID || '',
      customerId: env.DEMO_CUSTOMER_ID || '',
      email: env.DEMO_BUYER_EMAIL || '',
    },
    storePayoutEmail: env.STORE_PAYPAL_EMAIL || '',
    ai: {
      provider: env.AI_PROVIDER || 'fixture', // fixture | recorded | anthropic
      apiKey: env.ANTHROPIC_API_KEY || '',
      model: env.AI_MODEL || '', // no silent default: the operator names the model (and so its cost)
      effort: env.AI_EFFORT || 'medium',
      reuseRecorded: env.AI_REUSE_RECORDED === '1',
      dailyCallCap: Number(env.AI_DAILY_CALL_CAP || 40),
      spendCapUsd: Number(env.AI_SPEND_CAP_USD || 7), // total for the whole event, about 10,000 KRW; approved by the owner on 2026-11-09
      // The live shopping agent: runs per day (all visitors), runs per workspace, model calls per run.
      agent: {
        dailyRunCap: Number(env.AGENT_DAILY_RUN_CAP || 15),
        runsPerWorkspace: Number(env.AGENT_RUNS_PER_WORKSPACE || 3),
        maxCalls: Number(env.AGENT_MAX_CALLS || 16),
      },
    },
    policy: defaultPolicy(env),
  };
}

// Policy numbers are assumptions made for the demo, not measured values. All of them are settings.
export function defaultPolicy(env = {}) {
  return {
    perCaseCapCents: Number(env.POLICY_PER_CASE_CAP_CENTS || 5000), // refund first only up to $50 per case
    refundsPer30Days: Number(env.POLICY_REFUNDS_PER_30_DAYS || 2), // and at most 2 instant refunds per 30 days
    noticeBusinessDays: Number(env.POLICY_NOTICE_BUSINESS_DAYS || 5), // same notice period PayPal uses before reversing a temporary refund
    storeHoldDays: Number(env.POLICY_STORE_HOLD_DAYS || 7), // demo device: the desk pays the store after this window
    reserveStartCents: Number(env.POLICY_RESERVE_START_CENTS || 50000), // the desk's own funds set aside for store make-good
    // The buyer's own record moves their instant-refund limit (domain/trust.js). Defaults set before the owner decides; a step of 0 switches it off.
    trustStepCents: Number(env.POLICY_TRUST_STEP_CENTS ?? 2500), // per earlier case: +$25 if it was not the buyer's fault, -$25 if it was
    trustMaxUp: Number(env.POLICY_TRUST_MAX_UP ?? 2), // at most this many not-the-buyer's-fault cases raise the limit
    trustWindowDays: Number(env.POLICY_TRUST_WINDOW_DAYS ?? 180), // only cases reported within this many days count
  };
}
