# Builder instructions

Read these files before implementation:

1. `docs/product-spec.md`
2. `docs/architecture.md`
3. `docs/implementation-plan.md`
4. `docs/demo-and-evaluation.md`
5. `docs/decisions.md`

## Non-negotiable product constraints

- Razorpay is the primary physical-goods payment path.
- UPI is a payment method within Razorpay Checkout; UPI Reserve Pay is a conditional agentic authorization mode.
- x402/Solana must serve a real purpose and must not create a second charge for the same logical order.
- The LLM may interpret and recommend but may not be the authority that moves money.
- Approval must bind to an immutable Commerce Envelope.
- Material changes require reapproval.
- Fulfilment may begin only after rail-specific payment verification.
- All retryable money operations must be idempotent.
- Never claim direct Vulcan usage without an official working interface.
- Clearly label synthetic data, mocks and inaccessible private services.

## Build order

Do not start with x402, dashboards or broad protocol support. Complete this tracer bullet first:

```text
ambiguous request
→ clarification
→ ranked shortlist
→ exact envelope
→ approval
→ Razorpay test payment
→ signature verification
→ audit timeline
→ tamper rejection
```

Then add duplicate protection, refund recovery, x402 and broader conformance coverage in that order.

## Quality bar

- Prefer deterministic state machines and typed domain models over prompt conventions.
- Test negative paths as first-class product behavior.
- Keep external adapters behind small interfaces.
- Preserve a fully deterministic demo scenario.
- Do not expose secrets or personal/payment data in logs, screenshots, fixtures or blockchain metadata.
