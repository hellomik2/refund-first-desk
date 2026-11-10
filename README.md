# Refund-First Desk

**When an AI shopping agent buys the wrong thing, the buyer gets the money back first. Who pays is worked out afterwards.**

Built on PayPal Orders v2, Payments v2 (refunds), saved PayPal wallets (Vault) and Payouts, in the PayPal sandbox. Claude reads the purchase records, finds the first step where the agent went off what the buyer approved, and gives its own verdict. Fixed rules in code give a second verdict. Money moves only when the two agree; otherwise a person decides.

## Try the demo

**https://refund-first-desk.onrender.com** (PayPal sandbox). To keep the demo fast and its AI bill bounded, the prepared cases replay Claude's recorded answers from our live runs, and the screen says "recorded answer replayed". Edit the buyer's sentence before pressing **Report it** and the deep check calls Claude live for that case.

1. Pick a case, approve the buyer's conditions, let the agent pay, then press **Report it**. No sign-in is needed: the agent pays from a sandbox wallet saved earlier. Good cases to start with:
   - *Asked for a cart link, the agent checked out*: the quick check closes it in seconds.
   - *Shipping and tax took the total over the limit* or *Four ordered and charged, three shipped* (under **Show all 30 cases**): over the $50 limit, so the check comes first and the refund follows.
   - *Agent picked navy instead of black, then the store sent red*: in our runs the two keys disagreed here and a person decides; the live AI may answer differently on another run.
   - *Order matches what the buyer approved*: the buyer was responsible, gets a notice, and is charged again after it.
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

Good news for the buyer comes fast; bad news comes slowly, with notice.

```
buyer: one sentence ─► "Refund requested" ─► limits check ─► PayPal refund COMPLETED (seconds)
                                                                   │
        quick check: mandate + PayPal order only ◄─────────────────┤  a clear mismatch closes the case
                                                                   │  at once: "you will not be charged again"
        deep check (the investigator): mandate, the agent's ◄──────┤  names the first step where the agent
        numbered action log, PayPal order, store record            │  left the mandate, quoting that step
                                                                   │
        two keys: fixed rules in code   +   the AI's own verdict ──┤
                     same answer ─► money moves                    │
                     different    ─► a person decides; nothing is charged or paid out meanwhile
```

Over a limit ($50 a case, or more than 2 instant refunds in 30 days) the order flips: the checks run first and, when the buyer is not responsible, the refund follows within 5 minutes.

A refund that PayPal accepts but leaves pending is looked up again and never closes a case or pays a store until PayPal reports it completed. When PayPal refuses a refund (for example, the desk's PayPal balance is short), the case falls back to "check first" and the buyer is told so.

Pieces of this exist in other entries to this hackathon (first-deviation search, money moving only when checks agree, rules then AI then a person). What we did not find among the 217 entries we read is this order: refund first, then check, then charge the buyer again only if they were responsible.

| Responsible | Buyer | Store | Money |
|---|---|---|---|
| Store (did not ship or charge what was ordered) | keeps the refund | not paid for this order | — |
| Agent (order differs from what the buyer approved) | keeps the refund | paid from the desk's own funds | agent operator owes the desk |
| Records cannot settle it | keeps the refund | paid from the desk's own funds | desk absorbs it |
| Buyer (order matches every approved condition) | notice → 5 business days → charged again on the saved wallet, never more than was refunded | paid from that money | — |

The buyer can dispute during the notice period, or withdraw consent; either stops the charge for good.

### What the AI does, and what it never does

- **Does:** in the quick check, compares the mandate with the PayPal order; it can only close a case in the buyer's favour. In the deep check, reads all four records, answers seven yes/no/unknown questions (was paying allowed, right item, right quantity, within the limit, nothing excluded, store charged as ordered, store shipped as ordered), names the first step where the purchase went off the mandate, and gives its own verdict. Every yes/no and every first-step answer must quote the record it came from.
- **Never:** decides whether to refund, moves money on its own verdict, or overrides the rules. Its verdict is one of two keys.
- **How separate the two keys are:** the rules key runs on the same seven facts. Code computes up to four of them itself from the mandate and the PayPal order (payment permission, spending limit, store charged as ordered, and quantity when the order holds one item) and its answer replaces the AI's there. The other three (right item, nothing excluded, store shipped as ordered) come from the AI's quoted answers. So the keys are not independent: they catch a verdict that does not follow from the facts and a fact that code can compute, but not a wrong answer that the AI backs with a real quote.
- **Guards:** a quote that is not found in the cited record turns the answer into "unknown". The buyer's own report is never accepted as proof. Totals and the payment permission are computed by code and override the AI. Any open question resolves in the buyer's favour. When the keys differ, a person decides. Text inside the records that tries to instruct the checker is treated as data (three of the prepared cases contain such text).

## Measurements

All in the PayPal sandbox with live Claude calls (`claude-haiku-5-5`, no recorded answers replayed), 2026-11-10. **The 30 cases, the agents' action logs and the answer key were written by us for this demo.** The answer key was fixed before the live AI first ran on these cases (SHA-256 of `scenarios/cases.json`: `5873cb94…447d`). Targets were written down before measuring.

| What | Target | Result |
|---|---|---|
| What the buyer has to do | one sentence | one sentence |
| Report → PayPal refund status COMPLETED, within the limits | every run ≤ 60 s | 1.87–3.17 s (26/26) |
| Refund completed before any check started, within the limits | every case | 26/26 |
| Over the limits, buyer not responsible: report → refund COMPLETED | ≤ 5 min | 2.5–14.3 s (3/3); the buyer-responsible case got no refund (1/1) |
| Verdicts matching the answer key where both keys agreed | ≥ 27 of 30 | 29/30; the 30th went to a person (keys disagreed), counted as wrong |
| First step where the agent left the mandate, matching the answer key | ≥ 27 of 30 | 30/30 after tuning the prompt twice on these same 30 cases (27/30, 25/28 and 27/30 before); 10/10 on 10 new hold-out cases, see below |
| Keys disagree: no money moves, case waits for a person | 0 money moves | 0 (1 case in the person queue; 3 deliberate disagreements in the tests) |
| Quick check closes a buyer-responsible case | 0 | 0 of 6 |
| Quick check closes the cases marked for it in the answer key | ≥ 90 %, all 7 that code alone can show | 12/12, 7/7 |
| Refund completed → "you will not be charged again" notice | ≤ 10 s | median 0.9 s, max 3.8 s (12/12); in one of the two runs after tuning, one notice took 13.5 s because a single AI reply was slow |
| Buyer charged again when responsible, from the saved wallet, buyer not present | confirmed by PayPal lookup | 4 of 4 (a 5th was stopped by the buyer's dispute) |
| Buyer charged again when not responsible | 0 | 0 |
| Failure and abuse conditions reproduced on the sandbox | no unconsented, duplicate or over-cap charge | 9/9 |
| Ledger equals PayPal lookups for the buyer, the store and PayPal's fees (the desk's own two accounts are not compared) | every order | 30/30 (30-case run), 10/10 (abuse run) |

Reported without a target: the two keys agreed on 97 % of cases; the deep check took 5.9–11.5 s (median 7.7 s); two simple rules ("the last step" and "the first pay or checkout step") found the first wrong step in 0/30 and 2/30 cases; the live AI cost about $0.0017 per case.

How the table was reached, run by run (all on the same 30 cases and the same fixed answer key):

- Untuned prompt, three runs: first step 27/30, 25/28 and 27/30. The first sandbox run also had 2 cases stopped by sandbox errors (the desk's sandbox PayPal balance was short, so PayPal refused one refund and left two pending); we topped the sandbox balance up and ran again.
- The misses fell into three kinds: calling a store-only problem (seen only in the store record) a step, counting "opened checkout" instead of "paid" as the step, and not knowing when the records are too thin to tell. The answer key's rules for these were written before the AI first ran; the prompt had not stated them. We added them to the prompt, and fixed one wording slip that a second run exposed (a store step that cancels after charging). **These numbers come after tuning on the same 30 cases.**
- Tuned prompt on the 30 cases: run 1 first step 29/30 (one notice at 13.5 s, line above); run 2 first step 30/30 and every line passed. The table shows run 2.
- Hold-out: 10 new cases written by a writer who had not seen the prompt, answer key fixed before any AI run (`scenarios/holdout.json`). Untuned prompt 7/10 on the first step, missing exactly the three kinds above; tuned prompt 10/10 in three runs; verdicts 10/10 in every run.

Not comparable side by side: PayPal's "about 14 days" is its published guidance for real disputes; our seconds are sandbox measurements. "Refunded" means PayPal's refund status is COMPLETED. When the money appears depends on the funding source (PayPal balance the same day; bank or debit card about 5 business days; credit cards one or two statement cycles).

Failure and abuse conditions: the same order reported twice; the same refund request sent again; an amount over the per-case limit ($50); more instant refunds than allowed in 30 days (2); a buyer who withdrew save-for-later consent; a dispute during the notice period; records that cannot settle it; a re-charge above the amount fixed at purchase; a re-charge requested twice.

## What is simulated, and what is only true in the sandbox

- **Simulated:** shipping and returns; the store's records; waiting periods (a fast-forward button moves the policy clock only); the agent operator paying its invoice.
- **Constructed by us:** the 30 cases, the agents' numbered action logs, the store records and the answer key.
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
npm test                       # 84 tests against an in-memory PayPal stand-in
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

Measured on 2026-11-10 with the scripts above; each run writes a JSON file with every PayPal call, the ledger and the case records to `data/evidence/` (not committed, because it holds sandbox account identifiers). Recorded answers from the live AI runs are in `scenarios/recorded/`, keyed by a hash of the records the AI read.

## License

MIT
