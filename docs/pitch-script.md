# Five-minute pitch script — AgentReady Commerce (RunVista)

> Timing: ~640 words at ~130 wpm = 5:00. Read verbatim. Bracketed cues are
> actions, not narration. The public demo at
> `https://agentready-commerce-pied.vercel.app` is mock-only. Razorpay Test
> Mode and Solana Devnet are shown as recorded evidence, not actions performed
> by the public demo.

## 0:00–0:25 — Problem (75 words, 0:30)

“AI can already recommend products, and Razorpay can already execute payments.
The unresolved risk is whether the eventual charge and fulfilment still match
what the customer actually approved.

Carts drift: prices change, variants substitute, tools retry, webhooks replay.
Payment success is not fulfilment success. AgentReady Commerce is the
merchant-side control plane that keeps one approved intent, one successful
charge, and one inspectable evidence chain — for the fictional RunVista Sports
storefront you see here, running mock-only.”

[Cue: storefront `/` loaded, mock indicators visible.]

## 0:25–1:10 — Agent-readable discovery + conversational shopping (110 words, 0:45)

“Buyer agents don’t start in chat. They start at machine-readable discovery.

`GET /.well-known/agentready` states the merchant, the catalog path, the
session/respond/quote/approve/pay/verify/audit routes, the exact approval rule,
and the disclosures: synthetic catalog, no protocol-conformance claim.

`GET /api/catalog` returns the same six-product RunVista catalog the ranking
engine uses — one model, so chat and machines can never disagree on price,
stock, or policy.

Now the human path. I type: ‘I need black shoes under ₹5,000.’ The agent
refuses to guess. It asks for size, use, fit, cushioning, returnability, and
delivery — only the highest-value gaps.”

[Cue: show both endpoints, then type the ambiguous request, show clarification.]

## 1:10–1:55 — Grounded ranking + tiny x402 spend (110 words, 0:45)

“I answer: UK 9, road running up to 10K, wide fit, max cushioning, returnable.
Three cards appear — never one unsupported ‘best shoe’.

Max Cushion at ₹4,899 is the best overall match: wide, max cushioning, road,
returnable. Streak 4 at ₹4,299 is the cheaper alternative. Stride Lite at
₹3,499 is the trade-off choice. Every fact is catalog-verbatim; every
compromise is explicit.

Before ranking, the agent spent a tiny, separately authorized amount — 0.01
Devnet USDC — through x402 v2 exact on Solana Devnet for a premium fit-scoring
resource that returned these fit scores. That settlement is recorded evidence
from 2026-09-04, signature `5FQb8Jh7…`, memo-bound to the request digest. It is
not a second charge for the shoes.”

[Cue: shortlist + fit scores; cut to Devnet evidence screenshot.]

## 1:55–2:35 — Explicit approval (100 words, 0:40)

“I select Max Cushion, UK 9, SKU VMAX-BLK-9. The system freezes an exact
Commerce Envelope: merchant, SKU, variant, quantity, subtotal, ₹49 shipping,
total, return terms, inventory hold, mandate, expiry.

Approval binds to the SHA-256 hash of that exact envelope — shown on screen.
The deterministic policy engine checks mandate, merchant, amount, and expiry.
The LLM only interpreted and explained; it has no authority to move money.

I click ‘Approve exact envelope hash’. The timeline records
`approval.bound` with the digest.”

[Cue: approval card, click Approve, open ‘Order & trust’ drawer.]

## 2:35–3:15 — Bounded money + Razorpay Test Mode lifecycle (100 words, 0:40)

“One logical order, one successful rail. I choose Razorpay Checkout and click
‘Pay with Razorpay’.

On this public host that creates a mock order `order_MOCK_*` — no funds move.
The recorded Test Mode lifecycle from 2026-08-31/09-01 is the real-money-path
evidence: three Test Mode checkouts, two authenticated `payment.captured`
webhooks verified by raw-body HMAC with event-ID dedup and
order/amount/currency/captured binding, then `PAID_VERIFIED` before fulfilment.

Transaction 3 then simulated a fulfilment failure and issued genuine refund
`rfnd_TWVNeD4HStaNby`, confirmed `processed` — state `REFUNDED`. Fulfilment
begins only after rail-specific verification.”

[Cue: mock pay on camera; cut to Test Mode evidence doc screenshot.]

## 3:15–3:50 — Graceful failure (80 words, 0:35)

“The memorable failure: I change the budget to ₹3,000 after approval — or use
‘Price change after approval’ in Demo Lab.

The deterministic engine invalidates the envelope, moves to
`REAPPROVAL_REQUIRED`, and blocks both approval and payment on the stale
digest, naming the exact changed fields. A stale ‘Select’ with an old action
token is rejected with refreshed options. No code edits, no toast-only error —
a visible state transition plus audit event.”

[Cue: run `/api/scenario` or Demo Lab tamper button; show block + timeline.]

## 3:50–4:20 — Recovery + auditability (70 words, 0:30)

“Retries are safe. A replayed webhook with the same `x-razorpay-event-id` is
deduplicated to one transition. A duplicate logical-order call returns the
same result — never a second successful charge. A paid-but-unfulfillable order
moves `FULFILMENT_FAILED → COMPENSATION_PENDING → REFUNDED`, rail-specifically:
a Razorpay refund on the retail rail, a separate compensating transfer — never
a ‘reversal’ — on x402.

The ‘Order & trust’ drawer shows intent through receipt: every material action,
external ID, and decision.”

[Cue: replay webhook, conformance 15/15, audit timeline scroll.]

## 4:20–5:00 — Razorpay value + scope honesty (95 words, 0:40)

“AgentReady gives Razorpay the merchant-side control plane to scale agentic
commerce safely beyond curated integrations, while leaving payment execution
and intelligence inside Razorpay.

Vulcan can make payment intelligence smarter; RunVista makes the agent
executing payment decisions bounded, explainable and auditable. Vulcan is not
integrated — no public integration interface was used, and no mock output is
labelled as Vulcan. UPI Reserve Pay is out of scope without official access;
UPI remains a method inside Razorpay Checkout.

The catalog is synthetic, the public demo is mock-only, Test Mode and Devnet
are recorded evidence. What is real is the invariant: no silent cart change,
no second charge, no fulfilment on unverified payment.”
