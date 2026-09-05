# Five-minute pitch script — AgentReady Commerce (RunVista)

> 608 spoken words at ~130 wpm ≈ 4:41 narration, with UI actions inside the
> cues = 5:00.
> Read the quoted lines verbatim; bracketed cues are actions, not narration.
> The public demo at `https://agentready-commerce-pied.vercel.app` is
> mock-only. Razorpay Test Mode and Solana Devnet appear as recorded evidence,
> not actions performed by the public demo.

## 0:00–0:25 — Problem

“AI can already recommend products, and Razorpay can already execute payments.
The unresolved risk is whether the eventual charge and fulfilment still match
what the customer actually approved.

Carts drift: prices change, variants substitute, tools retry, webhooks replay.
AgentReady Commerce is the merchant-side control plane: one approved intent,
one successful charge, one inspectable evidence chain — shown here on the
fictional RunVista storefront, running mock-only.”

[Cue: storefront `/` loaded, mock indicators visible.]

## 0:25–1:05 — Discovery + clarification

“Buyer agents start at machine-readable discovery. `GET /.well-known/agentready`
states the merchant, the catalog path, the gated routes, the exact approval
rule, and the disclosures: synthetic catalog, no protocol-conformance claim.
`GET /api/catalog` returns the same six-product catalog the ranking engine
uses — chat and machines can never disagree on price, stock, or policy.

Now the human path. I type: ‘I need black shoes under ₹5,000.’ The agent
refuses to guess. It asks only for size and use — the two hard blockers —
with quick replies, then shortlists.”

[Cue: show both endpoints, type the request, show the size-and-use question.]

## 1:05–1:50 — Grounded shortlist, mock fit scores

“I answer UK 9, road running, and add wide fit with max cushioning. Three
cards appear — never one unsupported best shoe. Max Cushion at ₹4,899 is the
best overall match; Streak 4 at ₹4,299 the cheaper alternative; Stride Lite at
₹3,499 the trade-off. Every fact is catalog-verbatim; every compromise is
explicit.

Those fit scores come from the public mock x402 settlement — no funds moved.
Separately, one real application-path Devnet settlement finalized on-chain in
September, signature `5FQb8Jh7…`; that request itself returned HTTP 500 and
was reconciled read-only with no resubmission. The scores on screen are mock.”

[Cue: shortlist + fit scores; cut to the Devnet evidence still.]

## 1:50–2:30 — Exact approval

“I select Max Cushion, UK 9, SKU VMAX-BLK-9. The system freezes an exact
Commerce Envelope: merchant, SKU, variant, quantity, subtotal, ₹49 shipping,
total, return terms, inventory hold, mandate, expiry.

Approval binds to the SHA-256 hash of that exact envelope, shown on screen.
The deterministic policy engine checks mandate, merchant, amount, and expiry.
The model only interpreted and explained; it has no authority to move money.
I click ‘Approve exact envelope hash’; the timeline records `approval.bound`.”

[Cue: approval card, click Approve, open ‘Order & trust’.]

## 2:30–3:10 — Mock payment + Test Mode evidence

“One logical order, one successful rail. I click ‘Pay with Razorpay’: on this
host that creates a mock order `order_MOCK_*` — no funds move.

The Razorpay Test Mode integration-path evidence from August and September is
separate: three Test Mode checkouts, two authenticated `payment.captured`
webhooks verified by raw-body HMAC with event-ID dedup and
order/amount/currency/captured binding, then `PAID_VERIFIED` before
fulfilment. Transaction 3 took a simulated fulfilment failure and issued a
Razorpay Test Mode refund, `rfnd_TWVNeD4HStaNby`, confirmed processed.”

[Cue: mock pay on camera; cut to the Test Mode evidence still.]

## 3:10–3:45 — Graceful failure

“The memorable failure, live in Demo Lab: ‘Price change after approval’ runs
approve, then a material tool-retry price change, then stale retries — all in
one request. The original approved digest is invalidated, state moves to
`REAPPROVAL_REQUIRED`, the changed field is named, and both the stale approval
and the stale payment are blocked. No code edits, no toast-only error.”

[Cue: click ‘Price change after approval’; show digest, state, named change.]

## 3:45–4:15 — Recovery + audit

“Retries are safe. ‘Replay webhook’ delivers one `payment.captured` webhook
twice under one event ID: first processed fresh, second deduplicated — one
transition. A paid-but-unfulfillable order moves to an explicit refund, and
the conformance suite holds 15 of 15 gates. The ‘Order & trust’ drawer shows
intent through receipt: every material action, external ID, and decision.”

[Cue: replay notice, 15/15 gates, timeline scroll.]

## 4:15–5:00 — Razorpay value + scope honesty

“AgentReady gives Razorpay the merchant-side control plane to scale agentic
commerce beyond curated integrations, while payment execution and intelligence
stay inside Razorpay.

Vulcan can make payment intelligence smarter; RunVista makes the agent
executing payment decisions bounded, explainable and auditable. Vulcan is
explicitly not integrated. UPI Reserve Pay is out of scope without official
access; UPI remains a method inside Razorpay Checkout.

The catalog is synthetic, the public demo is mock-only, Test Mode and Devnet
are recorded evidence. What is real is the invariant: no silent cart change,
no second charge, no fulfilment on unverified payment.”
