# Product and architecture decisions

These decisions capture the current agreement and prevent the implementation from drifting back toward generic ideas.

## D-001 — Track selection

**Decision:** Enter Track 01, AI Growth & Agentic Commerce.

**Reason:** The product directly addresses merchant growth and end-to-end AI-buyer transactions. Open Track provides no lower bar and weakens alignment.

## D-002 — Merchant-specific experience

**Decision:** Demonstrate inside a focused D2C merchant rather than a broad marketplace.

**Reason:** A merchant-specific catalog allows grounded recommendation, inventory and policy evidence. Marketplace-scale “best product” ranking is underdetermined and distracts from payment integrity.

## D-003 — Clarification before autonomy

**Decision:** An underspecified request produces clarification or a shortlist, not immediate purchase.

**Reason:** “Black running shoes under ₹5,000” lacks size, use, fit and delivery constraints. Autonomous selection requires an explicit mandate or sufficient prior consented preferences.

## D-004 — Authorization continuity as the core USP

**Decision:** Bind user approval to an immutable Commerce Envelope.

**Reason:** Payment infrastructure can prove a payment occurred, but the application must prove it matches the exact approved SKU, terms and amount.

## D-005 — Deterministic financial authority

**Decision:** The LLM never has final authority to move money.

**Reason:** Merchant, SKU, limits, expiry, approval, idempotency and state transitions are machine-checkable invariants and belong in deterministic code.

## D-006 — Razorpay-first physical commerce

**Decision:** Use Razorpay test Orders and Checkout for the main retail transaction.

**Reason:** This is Razorpay's Buildathon and Razorpay provides the relevant India/INR payment, verification and refund lifecycle.

## D-007 — Payment option taxonomy

**Decision:** Present UPI, cards and net banking under Razorpay Checkout; show Reserve Pay only when available; show x402/Solana as a separate stablecoin/machine rail.

**Reason:** Razorpay is a provider and UPI is one of its payment methods. Mixing levels produces a confusing architecture and UI.

## D-008 — x402 as purposeful interoperability

**Decision:** First use x402/Solana for a paid digital resource/API that materially improves the agent's decision.

**Reason:** x402 naturally handles paid HTTP resources. Physical retail requires additional inventory, shipping, refund, dispute and compliance layers. A secondary machine payment demonstrates real interoperability without displacing Razorpay.

## D-009 — One logical order, one successful rail

**Decision:** Rail choice is mutually exclusive once payment verifies.

**Reason:** Delayed webhooks and retries must not cause a Razorpay and x402 double charge.

## D-010 — Conformance is supporting evidence

**Decision:** Call it an Agent Commerce Conformance Suite or Readiness Report, not an independent security certification.

**Reason:** The suite verifies declared invariants in this integration. It does not certify Razorpay, Solana, Vulcan or arbitrary external systems.

## D-011 — Vulcan access boundary

**Decision:** Integrate Vulcan only through an official interface provided by Razorpay.

**Reason:** Vulcan is a proprietary payments foundation model, not a public conversational LLM, and no public API has been identified. A mock must never be labelled as Vulcan.

## D-012 — UI emphasis

**Decision:** Make the recommendation evidence, approval card and audit timeline the visual centerpieces.

**Reason:** A generic chat screen or merchant dashboard does not visibly prove the project's differentiating safety properties.
