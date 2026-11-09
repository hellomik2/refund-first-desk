# Refund-First Desk

**When an AI shopping agent buys the wrong thing, the buyer gets the money back first. Who pays is worked out afterwards.**

Built on PayPal Orders v2, Payments v2 (refunds), saved PayPal wallets (Vault) and Payouts, in the PayPal sandbox. Claude reads the purchase records; fixed rules in code decide responsibility and move money.

## Try the demo

**https://refund-first-desk.onrender.com** (PayPal sandbox, live Claude)

1. Pick a case, approve the buyer's conditions, let the agent pay, then press **Report it**. No sign-in is needed: the agent pays from a sandbox wallet saved earlier.
2. Each visitor gets a separate workspace. A buyer gets **2 instant refunds per 30 days**, so the third case in one workspace is checked first instead of refunded first. That is the limit working. To try more cases, press **Start a fresh workspace** (top right).
3. For the buyer-responsible ending, press **Fast-forward the notice period** to skip the 5-business-day notice; the saved wallet is then charged again.
4. The server runs on Render's free plan. After a quiet spell the first page load can take about a minute while it wakes up.

The **Pay at PayPal and save the wallet** button shows how the wallet gets saved in the first place. On this screen we checked it as far as PayPal's sign-in page and back through Cancel. Approving at PayPal, capturing the payment and saving the wallet were checked with the same PayPal calls in a separate test script on 2026-11-09, not through this screen. To try it you need your own PayPal sandbox personal account, signed in at `sandbox.paypal.com` first.

## Who runs this

- **Today, on PayPal as it is:** a company that operates AI shopping agents runs the desk. It receives the purchase payment, refunds from it, and makes an innocent store whole from its own funds.
- **If PayPal ran it:** PayPal would hold the store's funds for the disputed order instead. Delayed disbursement already exists for approved partners.

## The problem

A buyer tells an agent "compare prices, don't buy yet", and the agent buys. Or it picks the 750 ml bottle when the buyer asked for 500 ml. Today the buyer has to contact the seller, open a dispute, escalate it and answer requests for documents. PayPal says most decisions take about 14 days, some 30 or more. An item that arrived as described but was not what the buyer asked the agent for may not be covered at all.

## What the desk does

```
buyer: one sentence ──► limits check ──► PayPal refund COMPLETED ──► only then: check the records
                                                                        │
                       mandate (approved before purchase) ◄────────────┤
                       agent's own log                    ◄────────────┤  Claude fills a fact table,
                       PayPal order, read back from PayPal ◄───────────┤  quoting each record
                       store record                       ◄────────────┘
                                                                        │
                       fixed rules in code ─► STORE · AGENT · BUYER · UNDETERMINED
```

| Responsible | Buyer | Store | Money |
|---|---|---|---|
| Store (did not ship or charge what was ordered) | keeps the refund | not paid for this order | — |
| Agent (order differs from what the buyer approved) | keeps the refund | paid from the desk's own funds | agent operator owes the desk |
| Records cannot settle it | keeps the refund | paid from the desk's own funds | desk absorbs it |
| Buyer (order matches every approved condition) | notice → 5 business days → charged again on the saved wallet, never more than was refunded | paid from that money | — |

The buyer can dispute during the notice period, or withdraw consent; either stops the charge for good.

### What the AI does, and what it never does

- **Does:** reads the four records and answers seven yes/no/unknown questions (was paying allowed, right item, right quantity, within the limit, nothing excluded, store charged as ordered, store shipped as ordered). Every yes/no must quote the record it came from.
- **Never:** decides responsibility, decides whether to refund, or moves money.
- **Guards:** a quote that is not found in the cited record turns the answer into "unknown". The buyer's own report is never accepted as proof. Totals and the payment permission are computed by code and override the AI. Any open question resolves in the buyer's favour. Text inside the records that tries to instruct the checker is treated as data (three of the prepared cases contain such text).

## Measurements

All in the PayPal sandbox. The cases are written for this demo.

| What | Target (set before measuring) | Result |
|---|---|---|
| What the buyer has to do | one sentence | one sentence |
| Report → PayPal refund status COMPLETED, 10 runs | every run ≤ 60 s | 2.86–3.47 s (10/10); in the 30-case run 1.88–5.17 s (28/28) |
| Refund completed before the check started | every refund-first case | 28/28 (the 2 cases over the $50 limit were checked first, as designed, and are counted separately) |
| Verdicts matching the answer key, 30 cases, live Claude (`claude-haiku-5-5`) | ≥ 27 of 30 | 30/30, end to end on the sandbox; also 30/30 in a separate AI-only run. First measurement, prompt not tuned to the cases |
| Fact answers matching the answer key | (reported, no target) | 206 of 210; the 4 differences did not change a verdict |
| Buyer charged again when responsible, from the saved wallet, buyer not present | confirmed by PayPal lookup | 4 of 4 (a 5th was stopped by the buyer's dispute) |
| Buyer charged again when not responsible | 0 | 0 |
| Failure and abuse conditions reproduced on the sandbox | no unconsented, duplicate or over-cap charge | 9/9 |
| Ledger equals PayPal lookups, per party | every order | 30/30 (30-case run), 10/10 (abuse run), 10/10 (refund run) |
| Cost of the live AI | — | about $0.0011 per case |

Not comparable side by side: PayPal's "about 14 days" is its published guidance for real disputes; our seconds are sandbox measurements. "Refunded" means PayPal's refund status is COMPLETED. When the money appears depends on the funding source (PayPal balance the same day; bank or debit card about 5 business days; credit cards one or two statement cycles).

Failure and abuse conditions: the same order reported twice; the same refund request sent again; an amount over the per-case limit ($50); more instant refunds than allowed in 30 days (2); a buyer who withdrew save-for-later consent; a dispute during the notice period; records that cannot settle it; a re-charge above the amount fixed at purchase; a re-charge requested twice.

## What is simulated, and what is only true in the sandbox

- **Simulated:** shipping and returns; the store's records; waiting periods (a fast-forward button moves the policy clock only); the agent operator paying its invoice.
- **Constructed:** the 30 cases and their answer key.
- **Sandbox only:** charging a saved PayPal wallet without the buyer present requires PayPal's approval (billing agreements / reference transactions) on live accounts.
- **Policy numbers are assumptions:** $50 per case, 2 instant refunds per 30 days, 5 business days' notice (the same notice period PayPal's buyer protection terms give before recovering a temporary refund).

## PayPal APIs used

| Step | Call |
|---|---|
| First purchase, buyer present, wallet saved for later | `POST /v2/checkout/orders` with `payment_source.paypal.attributes.vault.store_in_vault: ON_SUCCESS`, then `POST /v2/checkout/orders/{id}/capture` |
| Agent pays, buyer not present | `POST /v2/checkout/orders` with `payment_source.paypal.vault_id` |
| Refund first | `POST /v2/payments/captures/{id}/refund` (with `PayPal-Request-Id`), `GET /v2/payments/refunds/{id}` |
| Read the order back for the check | `GET /v2/checkout/orders/{id}` |
| Charge the buyer again | `POST /v2/checkout/orders` with `vault_id` |
| Pay the store | `POST /v1/payments/payouts`, `GET /v1/payments/payouts/{id}` |
| Consent withdrawn | `DELETE /v3/vault/payment-tokens/{id}` |
| Ledger check | `GET /v2/payments/captures/{id}` and the lookups above |

The mandate's SHA-256 fingerprint is written into the PayPal order's `custom_id`, so the check can show the record it compares is the one kept before the purchase.

## Run it

Node 20 or later.

```bash
npm install
npm test                       # 57 tests against an in-memory PayPal stand-in
npm start                      # http://localhost:8787
```

Settings go in a `.env` file (one level above this folder, or in it):

```
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
DEMO_VAULT_ID=...              # a sandbox wallet that already gave save-for-later consent
AI_PROVIDER=anthropic          # or "fixture" for hand-written stand-in answers
AI_MODEL=claude-haiku-5-5
ANTHROPIC_API_KEY=...
STORE_PAYPAL_EMAIL=...         # optional: a sandbox business account that receives store payouts
```

Scripts: `node scripts/loop.mjs` (cases end to end on the sandbox), `node scripts/abuse.mjs` (failure and abuse conditions on the sandbox), `node scripts/ai-eval.mjs` (the AI on all cases, no sandbox money moves). Live AI calls are capped per day and in total (`src/ai/budget.js`).

## Evidence

Measured on 2026-11-09 with the scripts above; each run writes a JSON file with every PayPal call, the ledger and the case records to `data/evidence/` (not committed, because it holds sandbox account identifiers). Recorded answers from the live AI runs are in `scenarios/recorded/`, keyed by a hash of the records the AI read.

## License

MIT
