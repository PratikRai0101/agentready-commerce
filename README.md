# AgentReady Commerce

Documentation and implementation handoff for a Razorpay Buildathon Track 01 submission.

> A merchant-specific AI sales agent that turns ambiguous intent into a justified product choice, binds approval to the exact commercial terms, and completes a safe transaction through Razorpay—with optional x402/Solana payments for machine-purchased services.

## Status

This repository is intentionally **documentation-only**. Implementation is deferred to OpenCode or Pi.

## Product thesis

Razorpay has already demonstrated agentic purchases with major merchants. Cashfree has publicly packaged an in-chat payment widget. The remaining problem is not another chatbot or payment button; it is preserving **authorization continuity**:

```text
vague request
→ grounded recommendation
→ exact quote
→ explicit approval
→ correct charge
→ correct fulfilment or refund
```

AgentReady provides the merchant-side orchestration and trust layer around that chain.

## Start here

1. [Product specification](docs/product-spec.md)
2. [Architecture](docs/architecture.md)
3. [Competitive positioning](docs/competitive-positioning.md)
4. [Implementation plan](docs/implementation-plan.md)
5. [Demo and evaluation](docs/demo-and-evaluation.md)
6. [Open questions](docs/open-questions.md)

Primary-source research is preserved in [`docs/research`](docs/research/).

## Scope hierarchy

### Core demonstration

- Merchant-specific conversational discovery
- Clarification of underspecified requests
- Evidence-backed product shortlist
- Immutable Commerce Envelope
- Deterministic authorization and policy checks
- Razorpay test Order and Checkout
- Signature and webhook verification
- Cart-tampering and duplicate-action protection
- Unified intent-to-receipt audit timeline

### Differentiator

- One real x402 v2 payment on Solana Devnet for a paid machine resource or API
- The x402 event appears in the same audit timeline

### Conditional integration

- Vulcan is integrated only if Razorpay provides an official sandbox or private Buildathon interface
- UPI Reserve Pay is integrated only if Razorpay provides participant access

### Non-goals

- General Amazon-scale marketplace search
- Claiming an objectively “best” product from a vague request
- Stablecoin settlement as the primary physical-goods checkout
- Recreating Cashfree HERE
- Claiming direct Vulcan usage without an official interface
- Claiming independent certification of Razorpay, Solana, x402 or arbitrary merchants

## One-line pitch

> Razorpay can execute agentic payments. AgentReady ensures the agent recommends responsibly and can never charge or fulfil something different from what the customer approved.
