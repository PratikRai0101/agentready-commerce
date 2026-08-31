# Product specification

## 1. Track and submission goal

**Track:** AI Growth & Agentic Commerce.

The product must grow a Razorpay merchant's revenue or make that merchant transactable by an AI buyer end to end. Every money action must be explainable, bounded and gated, with an audit trail and at least one graceful failure.

## 2. Problem

Existing agentic-commerce demonstrations prove that an assistant can find products and initiate payment. They do not, by themselves, solve four connected merchant problems:

1. **Decision quality:** “Buy black running shoes under ₹5,000” is underspecified. An agent cannot honestly identify the best product without fit, size, use, delivery and preference information.
2. **Authorization continuity:** the cart charged later can differ from the quote approved earlier because of repricing, inventory substitution, tool mistakes, retries or malicious data.
3. **Lifecycle correctness:** payment success is not fulfilment success. Inventory, delivery, cancellation and refunds must remain consistent with the transaction.
4. **Merchant readiness:** ordinary merchants need a repeatable integration and evidence that their agentic flow behaves safely outside the happy path.

## 3. Target user and demonstration merchant

Build for a **merchant-owned storefront**, not a broad marketplace.

The demo merchant should be a fictional or cooperating D2C running/sports retailer with a small structured catalog. This constrains the domain enough to make recommendation quality explainable and testable.

Example customer request:

> “I need black shoes under ₹5,000.”

The agent should ask only the highest-value questions:

- Shoe size
- Road, trail, gym or casual use
- Typical distance
- Fit and cushioning preference
- Delivery deadline
- Return requirement

The result is a ranked shortlist, not an unsupported claim that one shoe is universally best.

## 4. Core user journey

1. Customer enters an ambiguous natural-language request.
2. Agent identifies missing hard constraints and asks concise follow-ups.
3. Agent retrieves structured catalog, inventory, price, delivery and policy information.
4. Agent optionally purchases one external machine resource through x402/Solana when that resource materially improves the decision.
5. Agent presents up to three ranked products with explicit trade-offs.
6. Customer selects a product.
7. System creates an exact, expiring Commerce Envelope.
8. Deterministic policy validates the envelope against the customer's mandate.
9. Customer approves the exact envelope hash when required.
10. Customer selects one payment method/rail.
11. Razorpay processes the primary INR retail transaction.
12. The system verifies the payment before fulfilment.
13. Fulfilment completes or a rail-specific refund/compensation workflow begins.
14. The customer and merchant can inspect one unified audit timeline.

## 5. Functional requirements

### 5.1 Recommendation

- Separate hard constraints from soft preferences.
- Ask clarification when confidence is insufficient.
- Never invent catalog, inventory, delivery or policy attributes.
- Explain why each shortlisted item matches and where it compromises.
- Require a specific SKU and variant before approval.
- Support a consented customer profile, but do not require one for the MVP.

### 5.2 Authorization

- Convert natural-language authority into structured constraints.
- Enforce merchant, category, product, amount, expiry and approval thresholds in deterministic code.
- Treat model output as advisory, never as the final authority to move money.
- Bind approval to an immutable Commerce Envelope hash.
- Require reapproval whenever a financially or operationally material field changes.

### 5.3 Payments

- Exactly one payment rail may succeed for one logical order.
- Razorpay Checkout supports UPI, cards, net banking and other enabled methods.
- UPI Reserve Pay is a separate agentic authorization mode and remains conditional on access.
- x402/Solana is a secondary stablecoin rail or machine-service payment, not a second charge after Razorpay.
- All adapters implement common initiation, verification and compensation semantics while preserving rail-specific differences.

### 5.4 Lifecycle and audit

- Verify Razorpay signature before fulfilment.
- Deduplicate webhooks and tolerate out-of-order events.
- Make order creation and retry handling idempotent.
- Record all external IDs and state transitions.
- Represent payment success followed by fulfilment failure explicitly.
- Never label an x402 compensating transfer as a native reversal.

## 6. Product surfaces

### Customer conversation

Natural-language request, concise clarification, product comparison and checkout progression.

### Product comparison

Three cards with matched constraints, evidence, compromises, inventory, delivery and return terms.

### Approval card

Exact item, variant, quantity, total, shipping, return terms, expiry and approval status.

### Payment selector

- Razorpay UPI
- Razorpay card
- Razorpay net banking/other enabled methods
- UPI Reserve Pay when available
- x402/Solana when the merchant/resource supports it

### Audit timeline

Human-readable events from intent through recommendation, quote, approval, payment, verification, fulfilment and refund.

### Conformance view

Pass/fail evidence for declared critical invariants. This supports the product; it is not the primary customer proposition.

## 7. Success criteria

- A user can progress from an ambiguous request to a justified shortlist.
- The selected SKU and commercial terms are frozen into an approved envelope.
- A Razorpay test payment completes end to end.
- A changed price or variant is blocked before payment.
- A repeated logical request does not create a second successful charge.
- A fulfilment failure reaches a visible refund/compensation state.
- One real x402/Solana Devnet payment can be demonstrated without weakening the Razorpay story.
- Every material action appears in the audit timeline.

## 8. Claims the submission must avoid

- “The agent found the objectively best shoe.”
- “Blockchain proves the customer received the product.”
- “Razorpay signs every cart line item.”
- “x402 provides budgets, retail refunds or consumer disputes.”
- “Powered by Vulcan” without official access.
- “Certified secure” without defining a recognized certification authority and scope.
