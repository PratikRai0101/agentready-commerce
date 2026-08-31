# Demo and evaluation

## Five-minute pitch

### 0:00–0:25 — Problem

“AI can already recommend products and Razorpay can already execute payments. The unresolved risk is whether the eventual charge and fulfilment still match what the customer actually approved.”

### 0:25–1:20 — Responsible recommendation

Start with:

> “Find black running shoes under ₹5,000.”

Show the agent asking for size, use, fit/cushioning and delivery deadline. Answer with the prepared scenario and show three evidence-backed options.

### 1:20–1:50 — Optional agent-to-agent payment

The agent spends a tiny, separately authorized amount through x402/Solana to access one premium machine resource that improves the recommendation. Show the verified Devnet transaction briefly.

### 1:50–2:35 — Exact approval

Select one shoe. Display the Commerce Envelope: SKU, size, quantity, price, shipping, return terms and expiry. Approve the exact envelope hash.

### 2:35–3:10 — Razorpay purchase

Choose Razorpay UPI or another enabled test method, complete Checkout, verify the signature and show the order becoming `PAID_VERIFIED`.

### 3:10–3:45 — Memorable failure

Replay the scenario with a changed price or size after approval. Show the deterministic block and the exact changed fields. Do not merely show an error toast.

### 3:45–4:15 — Duplicate/failure recovery

Replay a tool call or webhook and show that no second logical charge occurs. Optionally show fulfilment failure transitioning into refund.

### 4:15–4:45 — Evidence

Show the intent-to-receipt timeline and conformance results. Highlight critical invariants, not an unexplained vanity score.

### 4:45–5:00 — Razorpay value

“AgentReady gives Razorpay the merchant-side control plane to scale agentic commerce safely beyond curated integrations, while leaving payment execution and Vulcan intelligence inside Razorpay.”

## Prepared demo scenario

Customer:

> “I need black shoes under ₹5,000.”

Clarified requirements:

- UK 9
- Road running up to 10K
- Wide fit
- Cushioning preferred
- Must be returnable
- Delivery before Sunday

Prepare three products with explicit compromises and one clear best match under the stated evidence.

## Critical conformance matrix

| Scenario | Expected result |
|---|---|
| Valid mandate and unchanged envelope | Payment allowed |
| Missing required product preference | Clarification, not purchase |
| Amount exceeds maximum | Block or human approval |
| Price changes after approval | Reapproval required |
| Variant changes after approval | Reapproval required |
| Envelope expires | Payment blocked |
| Duplicate logical order call | Same result/no second successful charge |
| Invalid Razorpay signature | Fulfilment blocked |
| Duplicate Razorpay webhook | One state transition |
| Out-of-order webhook | Reconciled or held safely |
| Paid but inventory unavailable | Compensation/refund path |
| Product description contains instructions | Treated as untrusted data |
| x402 underpayment/wrong recipient | Settlement rejected |
| x402 retry with same identifier | No unintended repeat spend |

## Metrics

### Recommendation

- Hard-constraint satisfaction rate
- Required-clarification recall
- Grounded-attribute rate
- Top-three relevance against a small labelled scenario set

### Authorization and payments

- Material cart-drift detection rate
- Unauthorized-payment count
- Duplicate successful charge count
- Signature-verification coverage
- Audit completeness

### Lifecycle

- Fulfilment state consistency
- Refund/compensation initiation success
- Webhook deduplication and ordering tolerance

### Presentation

- Fresh-start demo completion rate across repeated rehearsals
- Total demo time
- Number of manual recovery steps required

## Judge-facing evidence

- Real Razorpay test Order/payment IDs
- Verified x402/Solana Devnet transaction
- Audit timeline with external references
- Automated test report
- Clear labels for synthetic catalog/data
- Clear disclosure of any simulated Reserve Pay or Vulcan seam
