# Five-minute pitch script: RunVista

> 610 spoken words at 130 words per minute, leaving time for the UI actions.
> Read the quoted sections aloud. The bracketed lines are recording cues.
> The public demo at `https://agentready-commerce-pied.vercel.app` uses mocks.
> Razorpay Test Mode and Solana Devnet are shown only as recorded evidence.

## 0:00 to 0:25 | The problem

"AI can recommend a product, and Razorpay can collect the payment. But does the
final charge still match what the customer approved?

Prices change, sizes get replaced, tools retry and webhooks repeat. RunVista is
the merchant's control layer: one approved cart, one successful charge and one
audit trail. I am showing it on a fictional storefront in mock mode."

[Cue: Open the storefront. Keep the mock indicators visible.]

## 0:25 to 1:05 | Discovery and clarification

"A buyer agent discovers the store through this endpoint. It lists the catalog,
paid routes, exact approval rule and disclosures, including the synthetic catalog
and the absence of a protocol conformance claim. The catalog endpoint returns the
same six products used for ranking, so chat and machines see the same facts.

I type, 'I need black shoes under ₹5,000.' RunVista does not guess. It asks for
the two missing requirements, size and use."

[Cue: Show both endpoints. Enter the request and display the size and use question.]

## 1:05 to 1:50 | The shortlist

"I choose UK 9, road running, wide fit and cushioning. RunVista returns
three choices, not one unsupported winner. Max Cushion at ₹4,899 is the closest
match. Streak 4 at ₹4,299 is cheaper. Stride Lite at ₹3,499 has a clear trade-off.
Every product fact comes from the catalog.

These fit scores use mock x402, so no funds moved. Separately, one real 0.01 USDC
application-path payment finalized on Solana Devnet in September. That request
returned HTTP 500. We checked the chain and reconciled the existing record
read-only, with no resubmission. Its signature begins `5FQb8Jh7`."

[Cue: Show the shortlist and fit scores, then the recorded Devnet evidence.]

## 1:50 to 2:30 | Exact approval

"I select Max Cushion, UK 9, SKU VMAX-BLK-9. RunVista freezes a Commerce Envelope
with merchant, SKU, variant, quantity, subtotal, ₹49 shipping, total, return
terms, inventory hold, mandate and expiry.

Approval attaches to its SHA-256 hash. If a material field changes, the approval
no longer applies. Deterministic policy checks the mandate, merchant, amount and
expiry. The model interprets and explains, but cannot move money. I click
'Approve exact envelope hash,' and the timeline records `approval.bound`."

[Cue: Open the approval card, approve the hash, then open "Order & trust".]

## 2:30 to 3:10 | Razorpay payment

"One order gets one payment rail. I click 'Choose payment method':
'Razorpay Checkout' mints a mock `order_MOCK_*`; 'Agent Pay with x402' shows the
network, asset, exact amount, recipient and digests for a Solana Devnet
simulation that settles automatically with no second approval. No funds move,
and the service layer blocks whichever rail loses.

Our separate August and September evidence covers three Razorpay Test Mode
checkouts. Two `payment.captured` webhooks passed raw-body HMAC verification and
event-ID deduplication. RunVista matched the order, amount, currency and captured
status before moving to `PAID_VERIFIED` and fulfilment. Transaction three hit a
simulated fulfilment failure. Refund `rfnd_TWVNeD4HStaNby` was processed."

[Cue: Use mock payment on camera, then show the recorded Test Mode evidence.]

## 3:10 to 3:45 | A failure handled safely

"Now I break the order. In one request, 'Price change after approval'
approves one price, then changes it during a tool retry. RunVista invalidates the original
digest, names the changed field and moves to `REAPPROVAL_REQUIRED`. Both the stale
approval and stale payment are blocked. No code edit is involved."

[Cue: Run "Price change after approval". Show the digest, state and changed field.]

## 3:45 to 4:15 | Retries and the audit trail

"Webhook retries are safe too. This button sends one `payment.captured` event
twice under the same ID. RunVista processes the first and deduplicates the second,
leaving one transition. A paid order that cannot be fulfilled moves to an explicit
refund.

The conformance suite passes 15 of 15 gates. The 'Order & trust' drawer follows
the order from intent to receipt, including each action, external ID and decision."

[Cue: Run the webhook replay. Show 15 of 15 checks, then scroll the timeline.]

## 4:15 to 5:00 | Why it matters

"RunVista gives Razorpay a merchant-side control layer for agentic commerce beyond
curated integrations, while payment execution stays with Razorpay.

Vulcan could make that payment intelligence smarter in future. It is not
integrated here. UPI Reserve Pay is also outside this build because we did not
have official access. UPI remains a method in Razorpay Checkout.

The catalog is synthetic. The demo is mock-only. Test Mode and Devnet are
recorded evidence. The rule is simple: no silent cart change, no second charge
and no fulfilment until the payment is verified."
