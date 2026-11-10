// Minimal PayPal REST client: OAuth token cache, JSON calls, idempotency header, call trace.
// No SDK on purpose. Every call the desk makes is visible in one place and shows up in the demo's API trace.

export class PayPalError extends Error {
  constructor({ label, status, name, message, issues, debugId }) {
    super(`PayPal ${label} failed: HTTP ${status} ${name || ''} ${issues?.[0]?.issue || message || ''}`.trim());
    this.label = label;
    this.status = status;
    this.paypalName = name;
    this.issues = issues || [];
    this.debugId = debugId;
  }
  get issue() {
    return this.issues[0]?.issue || this.paypalName || 'UNKNOWN';
  }
}

/** A trace entry as the browser may see it: a saved-wallet (vault) id in the path is masked. */
export function publicTrace(call) {
  return { ...call, path: String(call.path || '').replace(/(\/v3\/vault\/payment-tokens\/)[^/?]+/, '$1…') };
}

export function createPayPalClient({ apiBase, clientId, clientSecret, onCall, fetchImpl = fetch, tokenStore = {} }) {
  // tokenStore can be shared by several clients (one per demo workspace) so they reuse one OAuth token.

  async function accessToken() {
    if (tokenStore.token && Date.now() < tokenStore.expiresAt - 60_000) return tokenStore.token;
    if (!clientId || !clientSecret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set.');
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetchImpl(`${apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new PayPalError({ label: 'oauth-token', status: res.status, name: json.error, message: json.error_description });
    }
    tokenStore.token = json.access_token;
    tokenStore.expiresAt = Date.now() + (json.expires_in || 300) * 1000;
    return tokenStore.token;
  }

  /**
   * @param {string} label   short name for the trace, e.g. "refund-capture"
   * @param {string} method
   * @param {string} path    path starting with /v1 or /v2 or /v3
   * @param {{body?: object, requestId?: string, headers?: object}} [opts]
   */
  async function call(label, method, path, opts = {}) {
    const bearer = await accessToken();
    const headers = { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (opts.requestId) headers['PayPal-Request-Id'] = opts.requestId;
    const startedAt = Date.now();
    const res = await fetchImpl(apiBase + path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const ms = Date.now() - startedAt;
    const text = await res.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text.slice(0, 300) };
    }
    const debugId = res.headers?.get?.('paypal-debug-id') || null;
    onCall?.({
      at: new Date(startedAt).toISOString(),
      label,
      method,
      path: path.replace(/\?.*$/, ''),
      status: res.status,
      ms,
      debugId,
      requestId: opts.requestId || null,
    });
    if (!res.ok) {
      const err = new PayPalError({ label, status: res.status, name: body.name, message: body.message, issues: body.details, debugId });
      err.links = Array.isArray(body.links) ? body.links : []; // e.g. a reused sender_batch_id links the original payout
      throw err;
    }
    return { status: res.status, body, ms, debugId };
  }

  return { call };
}
