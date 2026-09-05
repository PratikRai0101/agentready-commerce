# Architecture explainer (concise)

> RunVista Sports is a fictional merchant. The public demo at
> `https://agentready-commerce-pied.vercel.app` is mock-only. Razorpay Test
> Mode and Solana Devnet below are recorded evidence, not public-demo actions.

## The chain

```text
vague request → grounded recommendation → exact quote → explicit approval
→ one verified charge → correct fulfilment or refund → one audit timeline
```

## Layers

- **Conversation + recommendation.** Deterministic intent parser and ranking
  over a 6-product typed catalog (`packages/catalog`). The LLM, when
  configured, adds only soft preferences and explanations; without a key the
  app runs fully deterministically. It never authorizes money.
- **Commerce control plane.** Quote/inventory service, Commerce Envelope
  service (canonical serialization, SHA-256 hash, HMAC signature),
  deterministic policy engine (mandate, merchant, SKU, amount, expiry,
  approval), idempotency coordinator, audit ledger (`packages/domain`,
  `packages/audit`, `apps/web/lib/services.ts`).
- **Exactly one successful rail.** A unified `PaymentAdapter`
  (initiate/verify/compensate) fronts `razorpay_checkout` for INR retail and
  `x402_solana` for separately mandated machine-resource spend. Once one rail
  verifies, new initiation is rejected (`packages/payments`).
- **Fulfilment/refund state machine.** `DRAFT → CLARIFYING → QUOTED →
  AWAITING_APPROVAL → APPROVED → PAYMENT_PENDING → PAID_VERIFIED →
  FULFILMENT_PENDING → FULFILLED`, with `EXPIRED`, `REAPPROVAL_REQUIRED`,
  `PAYMENT_FAILED`, and `FULFILMENT_FAILED → COMPENSATION_PENDING →
  REFUNDED | MANUAL_REVIEW`. No transition is inferred from LLM prose.

## Why the Envelope matters

Approval binds to the hash of the exact commercial state (merchant, SKU,
variant, quantity, subtotal, tax, shipping, total, currency, recipient,
delivery, returns, mandate, expiry). Any material change invalidates approval
and requires reapproval before payment. Razorpay’s signature authenticates the
order–payment relationship; the server-held evidence chain binds that order to
the envelope. x402 memos carry only a request digest (`agentcart:v1:{digest}`);
the full envelope stays off-chain.

## Rails in one paragraph each

- **Razorpay (primary).** Server creates an Order for the exact envelope total,
  Checkout collects UPI/cards/net-banking, the server verifies the signature
  plus order/amount/currency/captured binding, deduplicates webhooks by
  `x-razorpay-event-id`, and issues idempotent refunds on fulfilment failure.
  Recorded Test Mode evidence: 3 checkouts, 2 authenticated webhooks, 1
  processed refund (`docs/evidence/razorpay-test-proof.md`).
- **x402/Solana (secondary).** v2 `exact` for the premium fit-scoring API only,
  under a separate tool-spend mandate: 402 + `PAYMENT-REQUIRED` → signed
  SPL payload → facilitator verify/settle → resource + `PAYMENT-RESPONSE`,
  with Stable Payment Identifier, finalized verification, and memo digest.
  Recorded Devnet evidence: app-path settlement `5FQb8Jh7…` (2026-09-04) plus
  harness settlement `9Z795iRrqkymKipM3XTY7q3gY7FZ2qvUFQKisnewPmhKH3opqzyVq2gmyPxrrJ8ez2KxSDHdXvJ8qeqkKKZi4JM`
  (2026-09-02); replay covered offline-only. Test tokens, no real money.
- **Reserve Pay / Vulcan.** UPI Reserve Pay is an authorization mode under the
  Razorpay/UPI path, conditional on access — out of scope here. Vulcan is not
  integrated and no public integration interface was used. Vulcan can make
  payment intelligence smarter; RunVista makes the agent executing payment
  decisions bounded, explainable and auditable.

## Discovery + audit

- `GET /api/catalog` (same typed catalog) and
  `GET /.well-known/agentready` (routes, approval rule, mock modes,
  `protocolConformance: None claimed`) let buyer agents discover and drive the
  same gated HTTP flow (`POST /api/session|respond|quote|approve`,
  `POST /api/pay/initiate|verify`, `GET /api/audit`). The audit drawer shows
  one timeline from intent to receipt with external IDs and allow/block/review
  decisions.
