# Refund-First Desk

**Trust the buyer first. If that was wrong, give notice and take it back.**

**Demo: https://refund-first-desk.onrender.com** (PayPal sandbox)

**Video (3 min): https://youtu.be/0Zpp-MCgaGk**

![The buyer reported it and the money went back first: PayPal refund status COMPLETED 2.87 s after the report, while the deep check is still reading](docs/img/refund-first.png)

*The refund comes first: PayPal's refund status is COMPLETED 2.87 s after the report, while the deep check is still reading the records.*

![Here the buyer was responsible: the rules key and the AI key both say Buyer, so the buyer gets a notice and 5 business days to dispute before any re-charge](docs/img/two-keys-notice.png)

*Then the two keys: fixed rules in code and the AI investigator (here a recorded answer replayed) both name the buyer, so the buyer gets a notice and 5 business days to dispute before the saved wallet is charged again.*

**For judges, four steps on the demo** (the case in the two screenshots):

1. Open the demo. It runs on Render's free plan: if you see a Render loading page, wait and refresh; waking up can take up to about two minutes.
2. Pick *Order matches what the buyer approved*, press **Approve these conditions**, then **Let the agent shop and pay**.
3. Press **Report it**. The refund completes in seconds, then the quick check, the deep check and the two keys run.
4. Both keys name the buyer, so a notice comes first. Press **Fast-forward the notice period**: the saved sandbox wallet is charged again, never for more than was refunded.

**To watch a live AI agent instead** (live Claude, no recorded answers): under **Watch a live AI agent shop**, pick *Coffee maker, $45 limit*, press **Approve these conditions**, then **Run the hasty agent**. If it pays, press **Report it**. It is a live model, so the same instruction can end differently from run to run, including not paying at all. Live runs have a daily cap shared by all visitors ([limits](#a-live-agent-that-really-shops)).

When an AI shopping agent buys the wrong thing, PayPal refunds the buyer within seconds, before the purchase is checked. The records are checked afterwards. If the check finds the buyer responsible, the buyer gets a notice and 5 business days to dispute; after that, the saved PayPal wallet that paid is charged again, never for more than was refunded. In every other outcome the buyer keeps the refund.

1. **Refund first.** PayPal's refund status is COMPLETED before the purchase is checked (within the limits; sandbox run 7: 2.13–4.41 s).
2. **Then check.** The AI's verdict and fixed rules in code; after the refund, a re-charge or an agent invoice happens on its own only when they agree. If the records cannot be tied together, the buyer keeps the refund and the desk pays the store from its own funds.
3. **Take it back, only if the buyer was responsible.** Notice, 5 business days to dispute, then the wallet that paid is charged again.

The desk also has:

- A live agent that really shops. Claude takes the buyer's instruction, shops a small catalog we wrote one tool call at a time, and pays from the saved sandbox wallet if it decides to. The investigator reads that numbered log the same way it reads the prepared cases ([more](#a-live-agent-that-really-shops)).
- A case book, and a limit set by the buyer's own record. Every finished case goes into a case book that shows whoever runs the agent which condition it broke, and at which step. The buyer's instant-refund limit moves with that buyer's own past cases, by fixed rules in code; the AI never sets it ([more](#the-case-book-and-the-buyers-limit)).

The refund can come first because it can be taken back. The buyer saved the wallet with consent at purchase, the most they can be charged again is fixed at purchase, they get notice and can dispute, and a re-charge happens on its own only when the AI and the rules agree. PayPal's own buyer protection terms already allow a temporary refund during a dispute, recovered after at least 5 business days' notice if the dispute goes against the buyer ([Purchase Protection Program](https://www.paypal.com/us/legalhub/paypal/buyer-protection), updated 2026-01-26). The desk applies the same pattern to purchases made by AI agents, by rule, and before the check.

Other entries in this hackathon also check agent purchases against what the buyer approved. On 2026-11-09 we found 217 public GitHub repositories by search (16 search terms, repositories updated after 2026-10-01; the hackathon's Devpost gallery was not public then) and read the READMEs of the 211 that had one. Among them we found none that refunds before the check and then has a step to take the money back from the buyer.

Built on PayPal Orders v2, Payments v2 (refunds), saved PayPal wallets (Vault) and Payouts, in the PayPal sandbox. Claude reads the purchase records, finds the first step where the agent went off what the buyer approved, and gives its own verdict. Fixed rules in code give a second verdict. A re-charge or an agent invoice happens on its own only when the two agree; otherwise a person decides. When the records cannot be tied together (rule R0), the buyer keeps the refund and the desk pays the store from its own funds.

## The problem

A buyer tells an agent "compare prices, don't buy yet", and the agent buys. Or it picks the 750 ml bottle when the buyer asked for 500 ml. Today the buyer has to contact the seller, open a dispute, escalate it and answer requests for documents. PayPal says it usually reaches a decision within 14 days, but some cases can take 30 days or longer ([PayPal Help: How long does it take to resolve a dispute or claim?](https://www.paypal.com/us/cshelp/article/how-long-does-it-take-to-resolve-a-dispute-or-claim-help257)). An item that arrived as described, but was not what the buyer asked the agent for, may not be covered at all.

## Try the demo

The demo runs in the PayPal sandbox. To keep it fast and its AI bill bounded, the prepared cases replay Claude's recorded answers from our live runs. Wherever the screen names the model (the header, the quick check, the deep check and the AI key), it adds "recorded answer replayed". If you edit the buyer's sentence before pressing **Report it**, the deep check calls Claude live for that case.

To watch a real agent make the purchase first, use **Watch a live AI agent shop** at the top of the page. Pick an instruction (or write your own), approve the conditions, and run the **careful** or the **hasty** agent. Claude shops a small catalog we wrote, one tool call per step, and pays from the saved sandbox wallet if it decides to. Then report the purchase in one sentence, as below. See [A live agent that really shops](#a-live-agent-that-really-shops).

1. Or pick a prepared case, approve the buyer's conditions, let the agent pay, then press **Report it**. No sign-in is needed: the agent pays from a sandbox wallet saved earlier. Good cases to start with:
   - *Asked for a cart link, the agent checked out*: the quick check closes it in seconds.
   - *Shipping and tax took the total over the limit* or *Four ordered and charged, three shipped* (under **Show all 30 cases**): the order is over the $50 instant-refund limit, so the check comes first and the refund follows.
   - *Agent picked navy instead of black, then the store sent red*: the agent picked the wrong colour, and the store then shipped a colour nobody ordered. Both keys name the store, so the store is not paid (the demo replays the AI's recorded answer from run 7). The live AI may answer differently on another run.
   - *Order matches what the buyer approved*: the buyer was responsible, gets a notice, and is charged again after it.
2. Each visitor gets a separate workspace. A buyer starts with **$50 a case and 2 instant refunds per 30 days**, and the buyer's own record moves both (see [the buyer's limit](#the-case-book-and-the-buyers-limit)). If you run *Order matches what the buyer approved* to the end (fast-forward, charged again), the limit drops to $25 and 1 instant refund, which is already used, so every later purchase in that workspace is checked first. If instead two cases were the agent's fault, a $58 purchase is refunded first. To start over, press **Start a fresh workspace** (top right).
3. For the buyer-responsible outcome, press **Fast-forward the notice period** to skip the 5-business-day notice; the saved wallet is then charged again.
4. The server runs on Render's free plan. After a quiet spell, the first page load can take up to about two minutes while it wakes up; if you see a Render loading page, refresh. A scheduled job in this repository (`.github/workflows/keep-awake.yml`) calls `/healthz` every 5 minutes to keep the free server awake, but GitHub can delay or skip scheduled runs, so the first load can still be slow.

The **Pay at PayPal and save the wallet** button shows how the wallet gets saved in the first place. On this screen we tested it only as far as PayPal's sign-in page and back through Cancel. Approving at PayPal, capturing the payment and saving the wallet were tested with the same PayPal calls in a separate test script on 2026-11-09, not through this screen. To try it, you need your own PayPal sandbox personal account, signed in at `sandbox.paypal.com` first.

## How it works

Trust the buyer first: the refund comes before the check. If the check finds the buyer responsible, the desk gives notice and takes the money back; otherwise the buyer keeps it. Good news reaches the buyer fast; bad news comes slowly, and with notice.

```
buyer: one sentence ─► "Refund requested" ─► limits check ─► PayPal refund COMPLETED (seconds)
                                                                   │
        quick check: mandate + PayPal order only ◄─────────────────┤  a clear mismatch closes the case
                                                                   │  at once: "you will not be charged again"
        deep check (the investigator): mandate, the agent's ◄──────┤  names the first step where the agent
        numbered action log, PayPal order, store record            │  left the mandate, quoting that step
                                                                   │
        two keys: fixed rules in code   +   the AI's own verdict ──┤
                     same answer ─► re-charge, store payout or     │
                                    agent invoice (the refund stays)
                     different    ─► a person decides; nothing is charged or paid out meanwhile
```

Over the instant-refund limit (for a buyer with no record, $50 a case or more than 2 instant refunds in 30 days; the buyer's own record moves both), the order flips: the checks run first and, when the buyer is not responsible, the refund follows within 5 minutes (longer if a person has to decide).

If PayPal accepts a refund but leaves it pending, the desk looks it up again, and the refund never closes a case or pays a store until PayPal reports it completed. If PayPal refuses a refund (for example, because the desk's PayPal balance is short), the case falls back to "check first" and the buyer is told so.

| Responsible | Buyer | Store | Money |
|---|---|---|---|
| Store (did not ship or charge what was ordered) | keeps the refund | not paid for this order | none |
| Agent (order differs from what the buyer approved) | keeps the refund | paid from the desk's own funds | agent operator owes the desk |
| Records cannot settle it | keeps the refund | paid from the desk's own funds | desk absorbs it |
| Buyer (order matches every approved condition) | notice → 5 business days → charged again on the saved wallet, never for more than was refunded | paid from that money | none |

The buyer can dispute during the notice period, or withdraw consent; either one stops the charge for good.

Pieces of this exist in other entries to this hackathon: checking the purchase against a mandate, searching for the first deviation, holding or cancelling a payment before it settles, refunding once a verdict is in, an operator making the store whole, moving money only when checks agree, and rules, then AI, then a person. What we did not find in the READMEs of those 217 repositories (GitHub search, 2026-11-09) is this order with this last step: refund first, then check, then take the money back from the buyer, after notice, and only if they were responsible.

### What the AI does, and what it never does

- **Does:** in the quick check, it compares the mandate with the PayPal order, and it can only close a case in the buyer's favour. In the deep check, it reads all four records and answers seven yes/no/unknown questions: was paying allowed, right item, right quantity, within the spending limit, nothing excluded, store charged as ordered, store shipped as ordered. It names the first step where the purchase went off the mandate, and gives its own verdict. Every yes/no answer and every first-step answer must quote the record it came from.
- **Never:** decides whether to refund, moves money on its own verdict, or overrides the rules. Its verdict is one of two keys.
- **How separate the two keys are:** the rules key works from the same seven facts. Code computes up to four of them itself from the mandate and the PayPal order (payment permission, spending limit, store charged as ordered, and quantity when the order holds one item), and its answer replaces the AI's for those. The other three (right item, nothing excluded, store shipped as ordered) come from the AI's quoted answers. So the keys are not independent. They catch a verdict that does not follow from the facts, and a fact that code can compute, but not a wrong answer that the AI backs with a real quote.
- **Guards:** a quote that is not found in the cited record turns the answer into "unknown". The buyer's own report is never accepted as proof. Totals and the payment permission are computed by code and override the AI. Any open question resolves in the buyer's favour. When the keys differ, a person decides. Text inside the records that tries to instruct the checker is treated as data (three of the prepared cases contain such text).

Here, "spending limit" is the buyer's cap on the order total in the mandate. The "instant-refund limit" is the desk's limit on refunding before the check.

### The case book and the buyer's limit

Every case the desk finishes goes into a case book below the cases on screen, written for whoever runs the agent. For each agent, it counts the conditions the agent broke at its own steps (paid without permission, wrong item, wrong quantity, over the spending limit, included something ruled out) as bars, coloured by who was finally found responsible, with the quoted log line of one case for each. For each store, it counts the store's own findings. A visitor's workspace holds only a few cases, so the screen can also show the book **after our 30 measured cases**: one measured run (run 7: PayPal sandbox, live Claude, 2026-11-12) on cases written by us. In that run the agent first left the mandate at its own step in 14 cases (wrong item 6; the other four conditions 2 each), and the store at its own step in 5. These counts equal the answer key except for S28, where the run found no step off and the key names the agent's step 3 (`test/casebook.test.js`). The 30 prepared cases carry no agent name, so they form one agent; an order that names its agent (`order.agent`) is grouped under that name.

The buyer's record also moves the instant-refund limit for the next purchase, by fixed rules in code (`src/domain/trust.js`). The AI never sets it.

- **Up:** for each earlier case of the same buyer that was the agent's or the store's fault (both keys agreed, or a person chose): +$25 a case and +1 refund, for at most two cases.
- **Down (the only rule that lowers it):** for each earlier case where this buyer was found responsible and was charged again with no dispute during the notice period: −$25 and −1 refund, down to a floor of $0 (every purchase is checked first). A verdict still inside its notice period does not count yet, because the buyer can still dispute it. A raise also lapses once its case is older than 180 days.
- Only that buyer's cases from the last 180 days count. The limit is fixed on the order at purchase, together with the cases that moved it, and the screen shows that reason under the purchase and in the buyer's "checking first" notice. Agents' and stores' records never move a buyer's limit.
- In the measured 30-case run each case has its own buyer, so no limit moved, and the money results are the same as before this rule (`scripts/loop.mjs --fake-paypal`, before and after).

### A live agent that really shops

In the 30 prepared cases, we wrote what the agent did. Here a real model does it. Claude (`claude-haiku-5-5`) gets the buyer's instruction and shops `scenarios/catalog.json` (written by us: 3 demo stores, 16 products, 4 prepared instructions) with six tools: search, product page, add to cart, remove, cart view, and checkout and pay. Each tool call is recorded as one numbered step, in the same format the investigator reads for the prepared cases. Payment goes through the same saved-wallet purchase (`POST /v2/checkout/orders` with `vault_id`); the store record and shipping are simulated. After that, the buyer's one sentence starts the same desk: refund first, quick check, deep check, two keys, and a re-charge only if the buyer was responsible.

**Why there are two agents.** An honest, careful agent usually buys the right thing, and then there is nothing to refund. So the page offers a second one. The two use the same model and settings, and differ in two ways only:

- **What it is told.** Careful: the approved conditions bind; open the product page of anything it adds; compare the cart total with the limit before paying; do not pay without permission. Hasty: it is an express-checkout agent graded on speed; pick from the top of the results and finish with payment.
- **What it can see.** Careful: the buyer's words and the approved condition slots; search results with store, variant and shipping; product pages and a cart view. Hasty: the buyer's words only; search results with product number, listing title and price; no product page and no cart view.

Neither agent is told to make a mistake, and no mistake is written in by code. It is a live model, so the same instruction can end differently from one run to the next. The catalog makes mistakes possible: a cheaper copy whose shipping and tax push the total over the limit, listing titles that hide the scent or the connector, multi-packs, and sponsored listings first. We changed the hasty agent once before measuring. At first its product numbers spelled out the variant (`SOAP-LAV`, `AAA24`) and it could open product pages, and it got 3 of 4 right. Product numbers became plain numbers, and the hasty agent lost the product page and cart tools.

On the hosted demo the live agent has limits: 15 runs a day for all visitors, 3 per workspace, 16 model calls per run, and the same overall AI spending cap as the checks, checked before every model call. The counts behind these limits are kept in a file on the server. The hosted demo runs on Render's free plan with no persistent disk, so that file is lost when the instance restarts, for example after it sleeps. The limits hold while the server stays up, and the counts start again from zero after a restart. The spending cap is checked against calls already recorded, so calls made at the same moment can take the total slightly past it (each call cost about $0.001 or less in our measurement).

## Who runs this

- **Today, on PayPal as it is:** a company that operates AI shopping agents runs the desk. It receives the purchase payment, refunds from it, and makes an innocent store whole from its own funds.
- **If PayPal ran it:** PayPal would hold the store's funds for the disputed order instead. Delayed disbursement already exists for approved partners.

## Measurements

### The 30 prepared cases

All runs used the PayPal sandbox and live Claude calls (`claude-haiku-5-5`, no recorded answers replayed). The table shows run 7, measured on 2026-11-12 at commit `14216bb`, after we changed the prompt a third time on these same 30 cases (see the run-by-run list below). The prepared cases on the demo page replay run 7's recorded AI answers, and its "30 measured cases" view shows run 7 too, so on screen all 30 cases close without a person (S22: the store). The prompt in this code is the fourth change (commit `ab310ba`, see the run-by-run list below). The table, the prepared cases on screen and the video all come from run 7, under the third change. The recorded answers are not results of the fourth change: for example, S28 shows "no step off" on screen, while the fourth change named step 3 in each of its runs. Only the live-agent path calls the current prompt live. **We wrote the 30 cases, the agents' action logs and the answer key for this demo.** The answer key was fixed before the live AI first ran on these cases (SHA-256 of `scenarios/cases.json`: `5873cb94…447d`). Targets were written down before measuring. The per-case results behind this table, runs 5, 6 and 8, all hold-out sets and the latest abuse run are in [`docs/measurements/2026-11-12-run7-summary.json`](docs/measurements/2026-11-12-run7-summary.json); run 4 and the live-agent run below are in [`docs/measurements/2026-11-12-summary.json`](docs/measurements/2026-11-12-summary.json). Both are without account or order identifiers.

| What | Target | Result |
|---|---|---|
| What the buyer has to do | one sentence | one sentence |
| Report → PayPal refund status COMPLETED, within the limits | every run ≤ 60 s | 2.13–4.41 s (26/26) |
| Refund completed before the purchase was checked, within the limits | every case | 26/26 |
| Over the limits, buyer not responsible: report → refund COMPLETED | ≤ 5 min | 2.8–13.3 s (3/3); the buyer-responsible case got no refund (1/1) |
| Verdicts matching the answer key where both keys agreed | ≥ 27 of 30 | 30/30; no case went to a person |
| First step where the agent left the mandate, matching the answer key | ≥ 27 of 30 | 29/30 (S28 answered "no step off", as in runs 5 and 6); 30/30 in runs 2 and 3. All after changing the prompt three times on these same 30 cases (27/30, 25/28 and 27/30 before the first change); 10/10 on each of two sets of 10 new hold-out cases, lower on 52 newer cases under the third change (33/40 and 9/12; 36 and 37 of 40 and 9/12 after the fourth); 18/20 on hold-out 5, see below |
| Keys disagree: no re-charge, store payout or agent invoice; the refund stays; the case waits for a person | 0 such money moves | 0 (no case in the person queue in this run; 3 deliberate disagreements in the tests) |
| Quick check closes a buyer-responsible case | 0 | 0 of 6 |
| Quick check closes the cases marked for it in the answer key | ≥ 90 %, all 7 that code alone can show | 12/12, 7/7 |
| Refund completed → "you will not be charged again" notice | ≤ 10 s | median 0.8 s, max 4.6 s (12/12); in run 1 after tuning, one notice took 13.5 s because a single AI reply was slow |
| Buyer charged again when responsible, from the saved wallet, buyer not present | confirmed by PayPal lookup | 4 of 4 (a 5th was stopped by the buyer's dispute) |
| Buyer charged again when not responsible | 0 | 0 |
| Failure and abuse conditions reproduced on the sandbox | no unconsented, duplicate or over-cap charge | 9/9 (abuse run at commit `14216bb`) |
| Ledger equals PayPal lookups for the buyer, the store and PayPal's fees (the desk's own two accounts are not compared) | every order | 30/30 (30-case run), 10/10 (abuse run) |

Reported without a target: the two keys agreed on 100 % of cases (30/30); the deep check took 5.0–14.8 s (median 8.3 s); two simple rules ("the last step" and "the first pay or checkout step") found the first wrong step in 0/30 and 2/30 cases; the live AI cost about $0.0017 per case (from the 2026-11-10 run; the run 7 evidence file holds no cost figure).

How we got to the table, run by run (all on the same 30 cases and the same fixed answer key):

- Untuned prompt, three runs: first step 27/30, 25/28 and 27/30. The first sandbox run also had 2 cases stopped by sandbox errors (the desk's sandbox PayPal balance was short, so PayPal refused one refund and left two pending); we topped up the sandbox balance and ran again.
- The misses fell into three kinds: calling a store-only problem (seen only in the store record) a step, counting "opened checkout" instead of "paid" as the step, and not knowing when the records are too thin to tell. The answer key's rules for these were written before the AI first ran, but the prompt had not stated them. We added them to the prompt, and fixed one wording slip that a second run exposed (a store step that cancels after charging). **These numbers come after tuning on the same 30 cases.**
- Tuned prompt on the 30 cases: run 1 first step 29/30 (one notice at 13.5 s, see the line above); run 2 first step 30/30, and every line passed.
- After the store-payout and screen fixes (same prompt, same 30 cases): run 3 first step 30/30, verdicts 29/30 (S22 to a person), every line passed; refund 1.88–3.09 s (26/26), notice max 3.0 s, over the limits 3.3–13.2 s, ledger 30/30; abuse 9/9, ledger 10/10. Two earlier runs of this build did not finish. One hit a PayPal 503 on a lookup after the money had moved (S28). In the other, the desk's sandbox PayPal balance ran out, so PayPal left refunds pending (19 cases stopped). We topped up the sandbox balance before run 3.
- After merging the case book and the live agent (2026-11-12, same prompt, same 30 cases; each case has its own buyer, so no limit moved): run 4 first step 29/30 (S28 answered "no step off"; S28 has varied between runs before), verdicts 28/30 (S14 and S22 went to a person because the keys disagreed; for both the refund was kept, with no re-charge, store payout or agent invoice), every line passed; refund 1.99–3.19 s (26/26), notice max 3.2 s, over the limits 4.1–13.6 s, ledger 30/30; abuse 9/9, ledger 10/10.
- An outside reviewer (Codex) cross-checked the money paths (store payouts that fail, wait or lose their answer, the 30-day boundary, prepaid stores) three times. Every finding was fixed with a test that failed first. The six findings of the third check are confirmed by those tests only, with no fourth review.
- Hold-out: 10 new cases written by someone who had not seen the prompt, with the answer key fixed before any AI run (`scenarios/holdout.json`). The untuned prompt got 7/10 on the first step, missing exactly the three kinds above; the tuned prompt got 10/10 in three runs; verdicts were 10/10 in every run.
- Verdict order (2026-11-12, the third prompt change on these same 30 cases): in run 4 the AI named the agent in S14 and S22, where the answer key names the store. The prompt now checks the answers in a fixed order (store, then agent, then undetermined, then buyer), so if the store did not charge or ship what the agent submitted and paid for, the store is named even when the agent also left the mandate earlier. To test this on cases the prompt was not tuned on, a separate agent that had not read the prompt wrote 10 new cases (`scenarios/holdout2.json`, SHA-256 `e5c064d2…`), and the answer key was fixed at 20:53 KST, before any AI run on them. The prompt before this change got 7/10 verdicts on them (X01 to X03 went to a person), the changed prompt 10/10; the first step was 10/10 with both. On the first hold-out set the changed prompt got 10/10 verdicts and 10/10 first step. Run 5 started at 20:47 KST, six minutes before hold-out 2 was fixed; every AI run on hold-out 2 came after. We report all three runs on the 30 cases:
  - Run 5 (commit `255f640`): verdicts 30/30, none to a person, first step 29/30 (S28), every line passed; refund 1.90–3.82 s (26/26), notice max 2.8 s, over the limits 3.0–12.5 s, ledger 30/30.
  - Run 6 (commit `14216bb`, which only adds hold-out 2): 29 cases finished, verdicts 29/29, first step 27/29 (S20 and S28 answered "no step off"). S14 counted as an error: both keys named the store and the case closed with the refund COMPLETED, then PayPal answered HTTP 503 to the refund lookup of the final ledger check. Refund 1.96–3.79 s (25), ledger 29/29.
  - Run 7 (commit `14216bb`): verdicts 30/30, none to a person, first step 29/30 (S28), every line passed; refund 2.13–4.41 s (26/26), notice max 4.6 s, over the limits 2.8–13.3 s, ledger 30/30; abuse 9/9, ledger 10/10. The table above shows this run.
  - Run 8 (2026-11-12, the merged build at commit `bac3742`, with the desk's sandbox fund starting at $2,000 instead of $500): verdicts 30/30, none to a person, first step 29/30 (S20: the answer key says the records cannot tell, the AI answered "no step off"; S28 was right this time), every line passed; refund 1.95–3.54 s (26/26), notice max 3.3 s, over the limits 4.9–11.7 s; store payouts paid 22, cancelled 8 (the store was responsible), waiting 0; re-charged 4, and S04 stopped by the buyer's dispute; desk fund $2,000.00 at the start, $1,467.26 at the end.
  - Run 8 also checks the desk's own line: for every case the ledger is compared with PayPal lookups on four lines (buyer, store, PayPal fees, desk), and all four matched in 30/30 cases. The net amount of the first capture came from PayPal in all 30 cases (computed by us in 0). The desk's two accounts are one PayPal merchant account, so PayPal confirms only their sum; we do not compare the account's whole balance.
  - S28 answered "no step off" in runs 5 to 7 (the answer key says step 3: the agent put a 500 ml bottle in the cart, then changed it to 750 ml before paying). The refund time range is wider than in runs 3 and 4 (up to 4.41 s against 3.09 and 3.19 s).
- New cases after the third change, written by others (2026-11-12; `scripts/ai-eval.mjs` with PayPal in memory; each answer key fixed in a commit before any AI run on it):
  - Hold-out 3: 40 cases by four writers who did not read the prompt, the earlier cases or the measured results (`scenarios/holdout3.json`, commit `5328131`, SHA-256 `41624dca…`; the key names the store, the agent, the buyer and "cannot tell" 10 times each). Changed prompt: verdicts 39/40 in both runs. Prompt before the change (`8bfa408`): 38/40, with one case (Y-C03) going to a person because the keys disagreed; no money moved for it.
  - All three runs got Y-D06 wrong. The buyer approved two tubes of sunscreen and later said they wanted one; the key says the buyer. The store had added a free sample sachet to the parcel, and the AI read that as "not shipped as ordered". The rules key takes that fact from the AI's answer (see [What the AI does](#what-the-ai-does-and-what-it-never-does): the keys are not independent), so both keys named the store and the case closed: the buyer keeps the refund and the store is not paid. The prompt before the change did the same. We did not change the prompt for this set then. The fourth change below addresses free extras, and with it Y-D06 is right in both runs; since hold-out 3 showed what to change, it is no longer a held-out test of that change.
  - Hold-out 3 Codex: 12 cases written by Codex, a different model (`scenarios/holdout3-codex.json`, commit `4b13c7a`, SHA-256 `37f05569…`; 3 per answer, none removed). Changed prompt: 12/12 in both runs; prompt before the change: 10/12, two cases to a person. Caveat: Codex reported that it read `scenarios/cases.json` once while writing, and that it did not look at it again from the fourth case on.
  - Together, on these 52 cases: changed prompt 51/52 (twice), prompt before the change 48/52.
  - The first step is lower on these cases than on the prepared 30 (29/30): 33/40 on hold-out 3 and 9/12 on the Codex cases, in all three runs of each. On hold-out 3, 3 of the 7 misses in each run are single items over the spending limit, where the writer marked the add-to-cart step and the AI the pay step, which the prompt then named as the step that pays a total over the limit (the fourth change below sets one rule for this). The rest, and all 3 on the Codex cases, are "no step off" against "cannot tell" on cases whose verdict is "cannot tell" (a missing or unclear store record, or a mandate that does not settle it). We left the answer keys as written.
- Fourth change (2026-11-13, commit `ab310ba`, 00:04 KST), aimed at what hold-out 3 showed. A free extra that nobody was charged for (a sample, a gift) no longer counts as shipping something other than the order. One rule sets the step that goes over the spending limit: the add-to-cart step if the items in the cart are already over it, the pay step if only shipping, tax or fees take it over. The steps are compared one by one, and the first deviation is answered as a step, then "cannot tell", then "no step off". The runs in this item use `scripts/ai-eval.mjs` with PayPal in memory, with no sandbox money.
  - Hold-out 4: 24 cases by two writers, 12 each, who did not open the prompt, the cases, the measured results or earlier case files (their own report) (`scenarios/holdout4.json`, SHA-256 `6222b50d…`; the key names each answer 6 times). The key was fixed in commit `a221b07` at 00:08 KST, after the prompt change and before the first AI run on these cases. This set is aimed at the change: the writing brief named the shapes to include and how to judge them (a free extra, a charged extra, a missing line, no usable store record, a single item over the limit, a wrong choice changed before paying). It shows whether those shapes are now judged right; it does not show that the prompt generalizes. Prompt before the change: verdicts 19/24 and 20/24 (one of these runs gave a wrong "buyer" verdict, Z-B12). Changed prompt: 23/24 twice, none to a person. First step: 20 and 21 before, 24 and 22 after.
  - Z-B05 is wrong in all four runs. The key says the buyer; both keys closed it as "cannot tell". The buyer ruled out cotton blends, and the product page says only "85% merino wool", so the key itself is open to dispute. We left the key as written and count the case as wrong. It is also an example of the limit above: both keys use the facts the AI read.
  - Hold-out 4's key marks no case for the quick check, but code alone closes 6 of them there, so we report no quick-check numbers for this set.
  - Regression on the earlier sets. These runs are not tests of the fourth change: hold-out 3 and the Codex cases were used to find what to change. Prepared 30 cases: verdicts 30/30 in three runs, first step 30, 29 (S18) and 30. Hold-out 1 and 2: 10/10 in two runs each. Hold-out 3: 40/40 in two runs, first step 36 and 37 (33, 33 and 35 before). Codex cases: 12/12 in two runs, first step 9 and 9. No verdict that was right before became wrong. The first step became wrong in one run each for S18, Y-B01 and Z-B06.
  - The first-step rule and six fixed keys do not agree. The changed prompt answers "cannot tell" when no step departs and a fact is unknown, while the keys of Y-B09, Y-C10 and Y-D08 (hold-out 3) and Y10, Y11 and Y12 (Codex) say "no step off". These six are not scored on the same rule. The scores above use the keys as written, and these six make up most of the first-step misses left on those two sets.
  - Run 9 (2026-11-13, 00:18 to 00:34 KST, commit `a221b07` with the fourth change, PayPal sandbox, live Claude, desk fund starting at $2,000): one run. Verdicts 30/30, none to a person, first step 30/30, no errors, every line passed; refund 2.27–3.29 s (26/26), notice max 3.4 s, over the limits 3.1–15.4 s, and the buyer-responsible case over the limits got no refund; store payouts paid 22, cancelled 8, waiting 0; re-charged 4 (S03, S08, S17, S28), and S04 stopped by the buyer's dispute; the ledger matched PayPal on all four lines (buyer, store, PayPal fees, desk) in 30/30 cases, with PayPal's net amount in all 30 first captures; desk fund $2,000.00 at the start, $1,467.26 at the end. This is a single sandbox run; with the same prompt, the three in-memory runs got first step 30, 29 and 30. Replaying the recorded answers at the same commit (PayPal in memory, no AI calls) gives verdicts 30/30 and first step 29/30 (S28), the run 7 answers as they are.
- Hold-out 5 (2026-11-13): 20 new cases by two writers, 10 each, not aimed at any change. The writers got a one-paragraph request, the meaning of the four responsibility rules, the case format with one earlier case as a format example, and a format check they could run but not read. They got no list of shapes, no prompt, no earlier cases to study and no measured results. The key names the store 6 times, the agent 6, the buyer 4 and "cannot tell" 4. It was fixed in commit `bf817a8` on branch `verify/holdout5` at 00:50 KST (SHA-256 `a7dad590…`; the same file is now in `scenarios/holdout5.json`), before the first AI run on them. Runs use `scripts/ai-eval.mjs` with PayPal in memory. Current prompt (fourth change), two runs: verdicts 20/20 and 20/20, none to a person, no case where both keys were wrong, first step 18/20 and 18/20. Third-change prompt (`e528e38`), one run: verdicts 20/20, first step 16/20. We did not change the prompt after seeing this set. Limits: it is one set of 20 cases, the writers were Claude too, and the third-change prompt also got 20/20 verdicts, so this set does not separate the two prompts on verdicts. The two first-step misses with the current prompt: in H5-B01 the store took the payment and did not ship; the key names the store's step and the AI answered "no step off" in all three runs, a real miss (the verdict, the store, was right). In H5-B05 the agent chose express shipping at checkout, and only the shipping took the total over the limit; the key names the checkout step, where the agent chose it, and the AI named the pay step, which is what the prompt's rule gives when only shipping takes the total over (prepared case S13 is keyed the same way), so this key is open to dispute.
- Hold-out 6 (2026-11-13): 20 new cases by two writers, 10 each, who got the hold-out 5 brief unchanged, with product areas that do not overlap hold-out 5 (`scenarios/holdout6.json`, SHA-256 `ecb7ec58…`; the key names the store 6 times, the agent 6, the buyer 4 and "cannot tell" 4). The key was fixed in commit `66295f2` on branch `fix/first23` at 01:12 KST; the measurement runs started at 01:13 KST. Current prompt (fourth change, the one in this code), two runs: verdicts 20/20 and 20/20, none to a person, no case where both keys were wrong, first step 16/20 and 16/20. In each of the four first-step misses (H6-C04, H6-D05, H6-D09, H6-D10) the new key does not follow the rule the earlier keys use. In H6-D09 and H6-D10 the agent put a wrong product or quantity in the cart and removed it before paying; the key says "no step off", and 11 earlier keys (S04, S28 and others) name that add-to-cart step, as the AI did. H6-D05 is the same shape, with the key on the checkout step. In H6-C04 checkout only showed the store's shipping, which took the total over; the key names the checkout step, and S13 and H02 name the pay step, as the AI did. We tried a fifth prompt change aimed at the two first-step misses of hold-out 5 (branch `fix/first23`, commit `90beccd`): those two cases came out right in all three runs, but on hold-out 6 the first step stayed at 16/20 and 15/20, and in one hold-out 5 run both keys wrongly closed H5-B08 as the buyer's (the current prompt gave the same wrong answer in 2 of 28 runs of that case alone), so this version does not include that change. Limits: 20 cases is a small set, and the writers were Claude subagents.

**What trusting first cost in the 30 cases.** Counted from run 7's ledger (PayPal sandbox; we wrote the cases and the answer key): of $873.53 bought, $593.26 was refunded before the purchase was checked and $207.33 after. Re-charges took back $114.49 from 4 buyers; one buyer-responsible refund ($25.98) stayed with the buyer because our test script filed a dispute. The desk's own funds paid $473.50: $410.41 to innocent stores and $63.09 in PayPal fees. That is less than in run 4 only because one innocent store was not paid: in S27 (the agent was responsible, $58.08) the store's payout was still waiting for desk funds when the run ended, because this run's sandbox fund started at $500 (run 4: $2,000) and had $26.50 left. The same happened in run 5. It is not a saving. $343.20 is invoiced to the agent's operator (paying it is simulated in this demo). Run 8 started with a $2,000 fund, and there S27's store was paid: the desk's own funds paid $532.74 and, if that invoice is paid, the desk is left with $189.54, or $6.32 a case, the same as in run 4; S27's payout and its $1.16 fee are the whole difference from run 7. Every other sum here is the same as in run 4. We estimate that refunding before the check, instead of after it, added $31.93 (the disputed $25.98 plus $5.95 in re-charge fees). A buyer with no record starts at $50 a case and 2 instant refunds per 30 days. The buyer's own record moves both by fixed rules, up to $100 a case and 4 refunds, or down to $0 and 0 (`src/config.js`, `src/domain/trust.js`; see [the buyer's limit](#the-case-book-and-the-buyers-limit)). These limits are assumptions. The sums are in `thirtyCases.money` of the [run 7 summary](docs/measurements/2026-11-12-run7-summary.json) (run 4: the [earlier summary](docs/measurements/2026-11-12-summary.json)).

Not comparable side by side: PayPal's "usually within 14 days" is its [published guidance](https://www.paypal.com/us/cshelp/article/how-long-does-it-take-to-resolve-a-dispute-or-claim-help257) for real disputes; our seconds are sandbox measurements. "Refunded" means PayPal's refund status is COMPLETED. When the money appears depends on the funding source (PayPal balance the same day; bank or debit card about 5 business days; credit cards one or two statement cycles).

Failure and abuse conditions: the same order reported twice; the same refund request sent again; an amount over the per-case limit ($50); more instant refunds than allowed in 30 days (2); a buyer who withdrew save-for-later consent; a dispute during the notice period; records that cannot settle it; a re-charge above the amount fixed at purchase; a re-charge requested twice.

### The live agent

**Measured on 2026-11-12 in the PayPal sandbox, with live Claude for the agent and for the checks.** 12 runs, each with a fresh buyer: careful and hasty, 6 each, on the 4 prepared instructions. A live run has no answer key. For each paid run, we read the agent log and the PayPal order and wrote down who was responsible, after the purchase and before any report or check ran (the file's fingerprint was fixed first). Every run was then reported with the same sentence, "This is not what I asked the agent to buy." Targets were written before measuring.

| What | Target | Result |
|---|---|---|
| Paid runs that went purchase → report → refund → two keys → settle (re-charge when the buyer was responsible) → ledger check without an error | ≥ 90 % | 8/8 |
| Two keys agreed and matched the person's answer | ≥ 80 % of paid runs | 8/8 (5 buyer responsible, 3 agent responsible); none went to a person |
| Hasty runs that bought off the mandate | ≥ 3 of 6 | 3 of 6 (coffee maker $46.90 over a $45 limit, twice; a USB-C to Lightning cable at $21.02 when a USB-C to USB-C cable under $20 was asked for); the other 3 did not pay |
| Buyer charged again when the person's answer was not "buyer" | 0 | 0 |
| Ledger equals PayPal lookups | every finished run | 8/8 |
| AI cost of the whole measurement | ≤ $0.50 | $0.024 (agent 51 calls, $0.011; checks 13 calls, $0.013) |

Reported without a target: the careful agent paid 5 of 6 times, each purchase within every condition; in the 6th ("put it in the cart, don't pay") it did not pay. The hasty agent stopped without paying twice on the dish soap, because its listings did not state the scent, and once put AAA batteries in the cart when AA were asked for, without paying. Refund 2.06–3.77 s. In all 3 agent-responsible runs, the deep check named the first step off as the pay step (over the limit) or the add-to-cart step (wrong connector), with the quote found in that step; in the 5 buyer-responsible runs it named no step. An agent run took 3 to 6 model calls, about $0.001.

## What is simulated, and what is only true in the sandbox

- **Simulated:** shipping and returns; the store's records; waiting periods (a fast-forward button moves the policy clock only); the agent operator paying its invoice.
- **Written by us:** the 30 cases, the agents' numbered action logs, the store records and the answer key. For the live agent: the catalog, its stores and the 4 prepared instructions (the live agent's log is its own).
- **Fast-forward and the counting windows:** the 30-day instant-refund count and the 180-day record window compare the policy clock with the real time each case was reported. Pressing fast-forward several times moves only the policy clock, so in the demo earlier cases can drop out of those windows too early. Without fast-forward, as in real use, the two clocks are the same and this does not happen.
- **Payments and re-charges without a clear answer:** a capture PayPal reports as `PENDING`, or a payment whose answer was lost, stays "not confirmed". The desk never cancels it or sends a new payment; asking again looks it up at PayPal. Only a `DECLINED` or `FAILED` capture (or a `VOIDED` order) counts as "nothing was charged". A re-charge is handled the same way: until PayPal answers, it is recorded neither as charged nor as stopped, the store is not paid from the desk's own funds, and the ledger check does not call the order a match. The next fast-forward or ledger check asks again under the same request id. Only a clear refusal (HTTP 400, 401, 403, 404 or 422, or a declined or failed capture) stops it. The tests cover this with the in-memory PayPal stand-in, not the sandbox.
- **Sandbox only:** on live accounts, charging a saved PayPal wallet without the buyer present requires PayPal's approval (billing agreements / reference transactions).
- **Policy numbers are assumptions:** $50 per case, 2 instant refunds per 30 days, 5 business days' notice (the same notice period PayPal's buyer protection terms give before recovering a temporary refund). How a buyer's record moves the limit (±$25 and ±1 refund per case, at most two cases up, 180 days) is an assumption too, not based on measured abuse or loss data. All of these are settings in `src/config.js` (`POLICY_*`; the record rule is `POLICY_TRUST_*`).

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

The mandate's SHA-256 fingerprint is written into the PayPal order's `custom_id`, so the check can show that the record it compares is the one kept before the purchase.

## Run it

Node 20 or later.

```bash
npm install
npm test                       # 194 tests against an in-memory PayPal stand-in
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

Scripts:

- `node scripts/loop.mjs`: the cases end to end on the sandbox.
- `node scripts/abuse.mjs`: the failure and abuse conditions on the sandbox.
- `node scripts/ai-eval.mjs`: the AI on all cases, with no sandbox money moving.
- `node scripts/live-agent.mjs buy`, then `report <answers.json>`: the live agent, in two phases so the person's answer is written before the checks run. Add `--fake-paypal` for a run without sandbox money.

Live AI calls are capped per day and in total (`src/ai/budget.js`); on the hosted demo these counts start again after a restart (see [A live agent that really shops](#a-live-agent-that-really-shops)).

## Evidence

Measured on 2026-11-10 and 2026-11-12 with the scripts above. Each run writes a JSON file with every PayPal call, the ledger and the case records to `data/evidence/` (not committed, because it holds sandbox account identifiers). Summaries of the 2026-11-12 runs without identifiers, with the SHA-256 of each source file, are committed: [`docs/measurements/2026-11-12-summary.json`](docs/measurements/2026-11-12-summary.json) (run 4, the abuse run at `7a3ebfb` and the live-agent run) and [`docs/measurements/2026-11-12-run7-summary.json`](docs/measurements/2026-11-12-run7-summary.json) (runs 5 to 8, hold-out 1 to 3, the Codex cases and the abuse run at `14216bb`). Recorded answers from the live AI runs are in `scenarios/recorded/`, keyed by a hash of the records the AI read.

## License

MIT

The page's colour, spacing, corner and shadow values are copied by hand from [Astryx](https://github.com/meta/astryx) 0.7.14 (MIT); no Astryx file is loaded.
