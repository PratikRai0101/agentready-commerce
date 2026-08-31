# Implementation plan for OpenCode or Pi

## Guiding rule

Build one complete vertical slice before adding protocols or dashboards. The Razorpay happy path and two negative paths must work before x402, Vulcan seams or broad conformance coverage.

## Phase 0 — decisions and access

Confirm:

- Razorpay test credentials
- Whether participants receive UPI Reserve Pay access
- Whether participants receive Vulcan sandbox/API access
- Demo merchant/catalog source
- Preferred LLM provider
- Deployment target
- Whether a real third-party x402 resource exists or a clearly labelled demo resource will be hosted

Do not block the core build on Reserve Pay or Vulcan access.

## Phase 1 — vertical skeleton

Deliver:

- Merchant storefront shell
- Structured catalog with inventory and policies
- Conversation flow with an initial ambiguous request
- Clarification form/state
- Deterministic product filter and ranking baseline
- Product comparison UI

Acceptance:

- The system refuses to claim a best match when required fields are absent.
- Every displayed fact is grounded in catalog data.

## Phase 2 — Commerce Envelope and policy

Deliver:

- Canonical serialization
- SHA-256 envelope hash
- Server signature
- PurchaseMandate schema
- Deterministic policy engine
- Approval UI bound to the envelope hash
- Reapproval-required state

Acceptance:

- Changing SKU, size, quantity, price, shipping or return terms invalidates approval.
- Expired quotes cannot be paid.
- Repeated approval calls are idempotent.

## Phase 3 — Razorpay end to end

Deliver:

- Server-side Razorpay Order creation
- Checkout integration
- Signature verification
- Webhook endpoint and event deduplication
- Payment/order state reconciliation
- Refund integration
- Unified audit records

Acceptance:

- Successful test payment reaches `PAID_VERIFIED` before fulfilment.
- Invalid signatures never fulfil.
- Duplicate webhooks create one logical transition.
- A fulfilment failure starts one idempotent refund.

## Phase 4 — failure theatre

Build visible, repeatable demo controls for:

1. Price or variant changes after approval
2. Duplicate agent/tool request
3. Payment succeeds but fulfilment fails

Acceptance:

- Each case produces an understandable UI response and audit event.
- No scenario requires editing code during the pitch.

## Phase 5 — x402/Solana

Deliver:

- Separate agent tool-spend mandate
- Solana Devnet wallet suitable for demo use
- x402 v2 exact payment to one digital resource/API
- Payment Identifier and settlement verification
- Optional signed Offer/Receipt extension
- Link to the Commerce Envelope or tool invocation digest
- Audit event containing network, payer/payee references and transaction signature without exposing sensitive material

Acceptance:

- The paid resource genuinely returns only after verified settlement.
- Retry does not create unintended repeated tool spend.
- The UI clearly distinguishes tool spend from the physical-goods purchase.

## Phase 6 — conformance suite

Begin with critical invariants rather than a broad arbitrary score.

Critical gates:

- No payment without a valid mandate
- No payment for an unapproved envelope
- No silent material cart change
- No second successful rail for the same logical order
- No fulfilment on unverified payment
- No missing compensation state after paid fulfilment failure

Then add catalog injection, webhook ordering, expiry, malformed provider responses and rail-specific verification cases.

## Phase 7 — polish and pitch hardening

- Remove unnecessary configuration from the demo path.
- Seed a deterministic catalog and scenario.
- Provide fallback recordings or fixtures for external service instability.
- Preserve proof that real Razorpay and x402 interactions were completed.
- Test the complete five-minute sequence repeatedly from a fresh state.

## Suggested repository shape

The builder may choose the stack, but preserve these module boundaries:

```text
apps/web
  customer conversation and merchant dashboard

packages/domain
  intent, mandate, envelope, policy and state machine

packages/catalog
  product retrieval and ranking provider

packages/payments
  common interface
  razorpay adapter
  x402-solana adapter

packages/audit
  event ledger and projections

packages/conformance
  scenarios, invariants and reports
```

## Required test layers

- Unit: canonicalization, hashing, policy, ranking and state transitions
- Contract: Razorpay adapter and x402 adapter fixtures
- Integration: order through payment/refund lifecycle
- Adversarial: injection, tampering, replay and stale state
- UI: complete demo path and visible failures

## Definition of done

- Public repository
- Reproducible local setup
- `.env.example` with no secrets
- Architecture diagram
- Meaningful tests and final results
- Razorpay test-mode proof
- Five-minute pitch video
- Clear disclosure of mocks, synthetic data and inaccessible private services
