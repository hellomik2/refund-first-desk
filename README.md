# Refund-First Desk

**Trust the buyer first. If that was wrong, give notice and take it back.**

**Demo: https://refund-first-desk.onrender.com** (PayPal sandbox)

When an AI shopping agent buys the wrong thing, PayPal refunds the buyer in seconds, before anything is checked. Then the records are checked. Only if the check finds the buyer responsible does the buyer get a notice and 5 business days to dispute; after that, the saved PayPal wallet that paid is charged again, never more than was refunded. In every other ending the buyer keeps the refund.

1. **Refund first.** PayPal's refund status is COMPLETED before any check starts (within the limits; sandbox runs 1.87–3.17 s).
2. **Then check.** The AI's verdict and fixed rules in code; money moves only when they agree.
3. **Take it back, only if the buyer was responsible.** Notice, 5 business days to dispute, then the wallet that paid is charged again.

- **A live agent that really shops:** Claude takes the buyer's instruction, shops a small catalog we wrote one tool call at a time, and pays from the saved sandbox wallet if it decides to; the investigator reads that numbered log as it reads the prepared cases ([more](#a-live-agent-that-really-shops)).
- **A case book and a limit set by the buyer's own record:** every finished case lands in a case book that shows whoever runs the agent which conditions it broke at which step. The buyer's instant-refund limit moves with that buyer's own past cases, by fixed rules in code; the AI never sets it ([more](#the-case-book-what-to-fix-in-the-agent)).

The refund can come first because it can be taken back: the buyer saved the wallet with consent at purchase, the most they can be charged again is fixed at purchase, they get notice and can dispute, and money moves only when the AI and the rules agree. PayPal's own buyer protection terms already allow a temporary refund during a dispute, recovered after at least 5 business days' notice if the dispute goes against the buyer ([Purchase Protection Program](https://www.paypal.com/us/legalhub/paypal/buyer-protection), updated 2026-01-26). The desk applies that pattern to purchases made by AI agents, by rule and before the check.

Other entries in this hackathon also check agent purchases against what the buyer approved. Among the 217 entries we read, we did not find one that refunds before the check and has a step to take the money back from the buyer.

Built on PayPal Orders v2, Payments v2 (refunds), saved PayPal wallets (Vault) and Payouts, in the PayPal sandbox. Claude reads the purchase records, finds the first step where the agent went off what the buyer approved, and gives its own verdict. Fixed rules in code give a second verdict. Money moves only when the two agree; otherwise a person decides.

## Try the demo

The demo (link at the top) runs in the PayPal sandbox. To keep the demo fast and its AI bill bounded, the prepared cases replay Claude's recorded answers from our live runs, and wherever the screen names the model (the header, the quick check, the deep check and the AI key) it adds "recorded answer replayed". Edit the buyer's sentence before pressing **Report it** and the deep check calls Claude live for that case.

To watch a real agent make the purchase first, use **Watch a live AI agent shop** at the top: pick an instruction (or write your own), approve the conditions, and run the **careful** or the **hasty** agent. Claude shops a small catalog we wrote, one tool call per step, and pays from the saved sandbox wallet if it decides to. Then report it in one sentence, as below. See [A live agent that really shops](#a-live-agent-that-really-shops).

1. Or pick a prepared case, approve the buyer's conditions, let the agent pay, then press **Report it**. No sign-in is needed: the agent pays from a sandbox wallet saved earlier. Good cases to start with:
   - *Asked for a cart link, the agent checked out*: the quick check closes it in seconds.
   - *Shipping and tax took the total over the limit* or *Four ordered and charged, three shipped* (under **Show all 30 cases**): over the $50 limit, so the check comes first and the refund follows.
   - *Agent picked navy instead of black, then the store sent red*: in our runs the two keys disagreed here and a person decides; the live AI may answer differently on another run.
   - *Order matches what the buyer approved*: the buyer was responsible, gets a notice, and is charged again after it.
2. Each visitor gets a separate workspace. A buyer starts with **$50 a case and 2 instant refunds per 30 days**, and the buyer's own record moves both (see [The case book](#the-case-book-what-to-fix-in-the-agent)). Run *Order matches what the buyer approved* to the end (fast-forward, charged again): the limit drops to $25 and 1 instant refund, already used, so every next purchase in that workspace is checked first. After two cases that were the agent's fault instead, a $58 purchase is refunded first. To start over, press **Start a fresh workspace** (top right).
3. For the buyer-responsible ending, press **Fast-forward the notice period** to skip the 5-business-day notice; the saved wallet is then charged again.
4. The server runs on Render's free plan. After a quiet spell the first page load can take about a minute while it wakes up.

The **Pay at PayPal and save the wallet** button shows how the wallet gets saved in the first place. On this screen we checked it as far as PayPal's sign-in page and back through Cancel. Approving at PayPal, capturing the payment and saving the wallet were checked with the same PayPal calls in a separate test script on 2026-11-09, not through this screen. To try it you need your own PayPal sandbox personal account, signed in at `sandbox.paypal.com` first.

## Who runs this

- **Today, on PayPal as it is:** a company that operates AI shopping agents runs the desk. It receives the purchase payment, refunds from it, and makes an innocent store whole from its own funds.
- **If PayPal ran it:** PayPal would hold the store's funds for the disputed order instead. Delayed disbursement already exists for approved partners.

## The problem

A buyer tells an agent "compare prices, don't buy yet", and the agent buys. Or it picks the 750 ml bottle when the buyer asked for 500 ml. Today the buyer has to contact the seller, open a dispute, escalate it and answer requests for documents. PayPal says most decisions take about 14 days, some 30 or more. An item that arrived as described but was not what the buyer asked the agent for may not be covered at all.

## What the desk does

Trust the buyer first: the refund comes before the check. If the check finds the buyer responsible, the desk gives notice and takes the money back; otherwise the buyer keeps it. Good news for the buyer comes fast; bad news comes slowly, with notice.

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

Pieces of this exist in other entries to this hackathon (checking the purchase against a mandate, first-deviation search, holding or cancelling a payment before it settles, refunding once a verdict is in, an operator making the store whole, money moving only when checks agree, rules then AI then a person). What we did not find among the 217 entries we read is the order and the last step: refund first, then check, then take the money back from the buyer, after notice, only if they were responsible.

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

### The case book: what to fix in the agent

Every case the desk finishes lands in a case book below the cases on screen, written for whoever runs the agent. Per agent, it counts the conditions the agent broke at its own steps (paid without permission, wrong item, wrong quantity, over the spending limit, included something ruled out) as bars, coloured by who was finally found responsible, with the quoted log line of one case for each. Per store, it counts the store's own findings. A visitor's workspace holds only a few cases, so the screen can also show the book **after our 30 measured cases**: one measured run (PayPal sandbox, live Claude, 2026-11-10), cases written by us. In that run the agent first left the mandate at its own step in 15 cases (wrong item 7; the other four conditions 2 each) and the store at its own step in 5; the counts equal the answer key (`test/casebook.test.js`). The 30 prepared cases carry no agent name, so they form one agent; an order that names its agent (`order.agent`) is grouped under that name.

The record also moves the next purchase's instant-refund limit, by fixed rules in code (`src/domain/trust.js`); the AI never sets it:

- **Up:** each earlier case of the same buyer that was the agent's or the store's fault (both keys agreed, or a person chose): +$25 a case and +1 refund, for at most two cases.
- **Down, the only way down:** each earlier case where this buyer was found responsible and, with no dispute during the notice period, was charged again: −$25 and −1 refund, to a floor of $0 (every purchase checked first). A verdict still inside its notice period does not count yet, because the buyer can still dispute it. A raise also lapses once its case is older than 180 days.
- Only that buyer's cases from the last 180 days count. The limit is fixed on the order at purchase together with the cases that moved it, and the screen shows that reason under the purchase and in the buyer's "checking first" notice. Agents' and stores' records never move a buyer's limit.
- In the measured 30-case run each case has its own buyer, so no limit moved there and the money results are the same as before this rule (`scripts/loop.mjs --fake-paypal`, before and after).

## Measurements

All in the PayPal sandbox with live Claude calls (`claude-haiku-5-5`, no recorded answers replayed). The table shows run 4, measured on 2026-11-12 at commit `7a3ebfb`. **The 30 cases, the agents' action logs and the answer key were written by us for this demo.** The answer key was fixed before the live AI first ran on these cases (SHA-256 of `scenarios/cases.json`: `5873cb94…447d`). Targets were written down before measuring.

| What | Target | Result |
|---|---|---|
| What the buyer has to do | one sentence | one sentence |
| Report → PayPal refund status COMPLETED, within the limits | every run ≤ 60 s | 1.99–3.19 s (26/26) |
| Refund completed before any check started, within the limits | every case | 26/26 |
| Over the limits, buyer not responsible: report → refund COMPLETED | ≤ 5 min | 4.1–13.6 s (3/3); the buyer-responsible case got no refund (1/1) |
| Verdicts matching the answer key where both keys agreed | ≥ 27 of 30 | 28/30; S14 and S22 went to a person (keys disagreed), counted as wrong |
| First step where the agent left the mandate, matching the answer key | ≥ 27 of 30 | 29/30 (S28 answered "no step off"); 30/30 in runs 2 and 3. All after tuning the prompt twice on these same 30 cases (27/30, 25/28 and 27/30 before); 10/10 on 10 new hold-out cases, see below |
| Keys disagree: no money moves, case waits for a person | 0 money moves | 0 (2 cases in the person queue; 3 deliberate disagreements in the tests) |
| Quick check closes a buyer-responsible case | 0 | 0 of 6 |
| Quick check closes the cases marked for it in the answer key | ≥ 90 %, all 7 that code alone can show | 12/12, 7/7 |
| Refund completed → "you will not be charged again" notice | ≤ 10 s | median 1.0 s, max 3.2 s (12/12); in run 1 after tuning, one notice took 13.5 s because a single AI reply was slow |
| Buyer charged again when responsible, from the saved wallet, buyer not present | confirmed by PayPal lookup | 4 of 4 (a 5th was stopped by the buyer's dispute) |
| Buyer charged again when not responsible | 0 | 0 |
| Failure and abuse conditions reproduced on the sandbox | no unconsented, duplicate or over-cap charge | 9/9 |
| Ledger equals PayPal lookups for the buyer, the store and PayPal's fees (the desk's own two accounts are not compared) | every order | 30/30 (30-case run), 10/10 (abuse run) |

Reported without a target: the two keys agreed on 93 % of cases (28/30); the deep check took 5.6–12.1 s (median 7.9 s); two simple rules ("the last step" and "the first pay or checkout step") found the first wrong step in 0/30 and 2/30 cases; the live AI cost about $0.0017 per case (from the 2026-11-10 run; the run 4 evidence file holds no cost figure).

How the table was reached, run by run (all on the same 30 cases and the same fixed answer key):

- Untuned prompt, three runs: first step 27/30, 25/28 and 27/30. The first sandbox run also had 2 cases stopped by sandbox errors (the desk's sandbox PayPal balance was short, so PayPal refused one refund and left two pending); we topped the sandbox balance up and ran again.
- The misses fell into three kinds: calling a store-only problem (seen only in the store record) a step, counting "opened checkout" instead of "paid" as the step, and not knowing when the records are too thin to tell. The answer key's rules for these were written before the AI first ran; the prompt had not stated them. We added them to the prompt, and fixed one wording slip that a second run exposed (a store step that cancels after charging). **These numbers come after tuning on the same 30 cases.**
- Tuned prompt on the 30 cases: run 1 first step 29/30 (one notice at 13.5 s, line above); run 2 first step 30/30 and every line passed.
- After the store-payout and screen fixes (same prompt, same 30 cases): run 3 first step 30/30, verdicts 29/30 (S22 to a person), every line passed; refund 1.88–3.09 s (26/26), notice max 3.0 s, over the limits 3.3–13.2 s, ledger 30/30; abuse 9/9, ledger 10/10. Two earlier runs of this build did not finish: one hit a PayPal 503 on a lookup after the money had moved (S28), and in the other the desk's sandbox PayPal balance ran out, so PayPal left refunds pending (19 cases stopped). We topped the sandbox balance up before run 3.
- After merging the case book and the live agent (2026-11-12, same prompt, same 30 cases; each case has its own buyer, so no limit moved): run 4 first step 29/30 (S28 answered "no step off"; S28 has varied between runs before), verdicts 28/30 (S14 and S22 went to a person because the keys disagreed; no money moved for either), every line passed; refund 1.99–3.19 s (26/26), notice max 3.2 s, over the limits 4.1–13.6 s, ledger 30/30; abuse 9/9, ledger 10/10. The table above shows this run.
- The money paths (store payouts that fail, wait or lose their answer, the 30-day boundary, prepaid stores) were cross-checked by an outside reviewer (Codex) three times. Every finding was fixed with a test that failed first; the six findings of the third check are confirmed by those tests only, with no fourth review.
- Hold-out: 10 new cases written by a writer who had not seen the prompt, answer key fixed before any AI run (`scenarios/holdout.json`). Untuned prompt 7/10 on the first step, missing exactly the three kinds above; tuned prompt 10/10 in three runs; verdicts 10/10 in every run.

Not comparable side by side: PayPal's "about 14 days" is its published guidance for real disputes; our seconds are sandbox measurements. "Refunded" means PayPal's refund status is COMPLETED. When the money appears depends on the funding source (PayPal balance the same day; bank or debit card about 5 business days; credit cards one or two statement cycles).

Failure and abuse conditions: the same order reported twice; the same refund request sent again; an amount over the per-case limit ($50); more instant refunds than allowed in 30 days (2); a buyer who withdrew save-for-later consent; a dispute during the notice period; records that cannot settle it; a re-charge above the amount fixed at purchase; a re-charge requested twice.

## A live agent that really shops

In the 30 prepared cases we wrote what the agent did. Here a real model does it. Claude (`claude-haiku-5-5`) gets the buyer's instruction and shops `scenarios/catalog.json` (written by us: 3 demo stores, 16 products, 4 prepared instructions) with tools: search, product page, add to cart, remove, cart view, and checkout and pay. Each tool call is written down as one numbered step, in the same shape the investigator reads for the prepared cases. Paying goes through the same saved-wallet purchase (`POST /v2/checkout/orders` with `vault_id`); the store record and shipping are simulated. After that, the buyer's one sentence starts the same desk: refund first, quick check, deep check, two keys, and a re-charge only if the buyer was responsible.

**Why there are two agents.** An honest, careful agent usually buys the right thing, and then there is nothing to refund. So the page offers a second one. The two use the same model and settings, and differ in two things only:

- **What it is told.** Careful: the approved conditions bind; open the product page of anything it adds; compare the cart total with the limit before paying; do not pay without permission. Hasty: it is an express-checkout agent graded on speed; pick from the top of the results and finish with payment.
- **What it can see.** Careful: the buyer's words and the approved condition slots; search results with store, variant and shipping; product pages and a cart view. Hasty: the buyer's words only; search results with product number, listing title and price; no product page and no cart view.

Neither is told to make a mistake, and no mistake is written in by code. It is a live model, so the same instruction can end differently from one run to the next. The catalog makes a mistake possible: a cheaper copy whose shipping and tax push the total over the limit, listing titles that hide the scent or the connector, multi-packs, sponsored listings first. We changed the hasty agent once before measuring: at first its product numbers spelled out the variant (`SOAP-LAV`, `AAA24`) and it could open product pages, and it got 3 of 4 right; product numbers became plain numbers and the hasty agent lost the product page and cart tools.

**Measured on 2026-11-12, PayPal sandbox, live Claude for the agent and for the checks.** 12 runs, each with a fresh buyer: careful and hasty, 6 each, on the 4 prepared instructions. There is no answer key for a live run. We read each paid run's agent log and PayPal order and wrote down who was responsible after the purchase and before any report or check ran (file fingerprint fixed first). Every run was then reported with the same sentence, "This is not what I asked the agent to buy." Targets were written before measuring.

| What | Target | Result |
|---|---|---|
| Paid runs that went purchase → report → refund → two keys → settle (re-charge when the buyer was responsible) → ledger check without an error | ≥ 90 % | 8/8 |
| Two keys agreed and matched the person's answer | ≥ 80 % of paid runs | 8/8 (5 buyer responsible, 3 agent responsible); none went to a person |
| Hasty runs that bought off the mandate | ≥ 3 of 6 | 3 of 6 (coffee maker $46.90 over a $45 limit, twice; a USB-C to Lightning cable at $21.02 when a USB-C to USB-C cable under $20 was asked); the other 3 did not pay |
| Buyer charged again when the person's answer was not "buyer" | 0 | 0 |
| Ledger equals PayPal lookups | every finished run | 8/8 |
| AI cost of the whole measurement | ≤ $0.50 | $0.024 (agent 51 calls, $0.011; checks 13 calls, $0.013) |

Reported without a target: the careful agent paid 5 of 6 times, each purchase within every condition, and in the 6th ("put it in the cart, don't pay") it did not pay. The hasty agent stopped without paying twice on the dish soap, because its listings did not say the scent, and once put AAA batteries in the cart when AA were asked, without paying. Refund 2.06–3.77 s. The deep check named the first step off as the pay step (over the limit) or the add-to-cart step (wrong connector), with the quote found in that step, in all 3 agent-responsible runs, and no step in the 5 buyer-responsible runs. An agent run took 3 to 6 model calls, about $0.001.

On the hosted demo the live agent has limits: 15 runs a day for all visitors, 3 per workspace, 16 model calls per run, and the same overall AI spending cap as the checks, checked before every model call. The counts behind these limits are kept in a file on the server. The hosted demo runs on Render's free plan with no persistent disk, so that file is lost when the instance restarts, for example after it sleeps: the limits hold while the server stays up, and the counts start again from zero after a restart.

## What is simulated, and what is only true in the sandbox

- **Simulated:** shipping and returns; the store's records; waiting periods (a fast-forward button moves the policy clock only); the agent operator paying its invoice.
- **Constructed by us:** the 30 cases, the agents' numbered action logs, the store records and the answer key. For the live agent: the catalog, its stores and the 4 prepared instructions (the live agent's log is its own).
- **Fast-forward and the counting windows:** the 30-day instant-refund count and the 180-day record window compare the policy clock with the real time each case was reported. Pressing fast-forward several times moves only the policy clock, so on the demo earlier cases can drop out of those windows too early. Without fast-forward, as in real use, the two clocks are the same and this does not happen.
- **Sandbox only:** charging a saved PayPal wallet without the buyer present requires PayPal's approval (billing agreements / reference transactions) on live accounts.
- **Policy numbers are assumptions:** $50 per case, 2 instant refunds per 30 days, 5 business days' notice (the same notice period PayPal's buyer protection terms give before recovering a temporary refund). The way a buyer's record moves the limit (±$25 and ±1 refund per case, at most two cases up, 180 days) is an assumption too, not based on measured abuse or loss data; all of it is in settings (`POLICY_TRUST_*`).

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
npm test                       # 151 tests against an in-memory PayPal stand-in
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

Scripts: `node scripts/loop.mjs` (cases end to end on the sandbox), `node scripts/abuse.mjs` (failure and abuse conditions on the sandbox), `node scripts/ai-eval.mjs` (the AI on all cases, no sandbox money moves), `node scripts/live-agent.mjs buy` then `report <answers.json>` (the live agent, in two phases so the person's answer is written before the checks run; `--fake-paypal` for a run without sandbox money). Live AI calls are capped per day and in total (`src/ai/budget.js`).

## Evidence

Measured on 2026-11-10 and 2026-11-12 with the scripts above; each run writes a JSON file with every PayPal call, the ledger and the case records to `data/evidence/` (not committed, because it holds sandbox account identifiers). Recorded answers from the live AI runs are in `scenarios/recorded/`, keyed by a hash of the records the AI read.

## License

MIT
