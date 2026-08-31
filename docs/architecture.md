# Architecture

## 1. System view

```text
Customer / buyer agent
        │
        ▼
Conversation and recommendation layer
        │ structured intent + ranked products
        ▼
Commerce control plane
  ├─ Quote and inventory service
  ├─ Commerce Envelope service
  ├─ Deterministic policy engine
  ├─ Idempotency coordinator
  └─ Audit ledger
        │ choose exactly one rail
        ├───────────────────────────┐
        ▼                           ▼
Razorpay adapter                x402/Solana adapter
INR retail checkout             Stablecoin/machine resource
        │                           │
        └───────────┬───────────────┘
                    ▼
          Fulfilment/refund state machine
```

## 2. Responsibility boundaries

| Component | Responsible for | Must not be responsible for |
|---|---|---|
| General LLM | Intent interpretation, questions, ranking, explanation | Final authority to move money |
| Policy engine | Limits, approvals, expiry, allowed merchant/SKU/rail | Product recommendation prose |
| Commerce Envelope | Exact approved commercial state | Payment settlement |
| Razorpay | Order/payment/refund execution and payment authenticity | Proving the customer approved individual cart fields |
| x402/Solana | Stablecoin authorization, verification and settlement | Retail inventory, delivery, returns or consumer disputes |
| Vulcan | Razorpay's internal routing, risk and checkout intelligence | Language understanding or our cart/mandate verification |
| Conformance suite | Testing declared integration invariants | Certifying third-party infrastructure globally |

## 3. Domain model

### PurchaseIntent

```ts
type PurchaseIntent = {
  merchantId: string;
  category: string;
  hardConstraints: {
    maxAmountMinor: number;
    currency: "INR" | "USDC";
    size?: string;
    colour?: string;
    useCase?: string;
    mustBeReturnable?: boolean;
    deliverBy?: string;
  };
  softPreferences: Array<{
    name: string;
    value: string;
    weight: number;
  }>;
};
```

### PurchaseMandate

```ts
type PurchaseMandate = {
  mandateId: string;
  customerId: string;
  allowedMerchantIds: string[];
  allowedProductIds?: string[];
  allowedRails: PaymentRail[];
  maxAmountMinor: number;
  autoApproveBelowMinor?: number;
  expiresAt: string;
  humanConfirmationRequired: boolean;
};
```

### CommerceEnvelope

```ts
type CommerceEnvelope = {
  version: 1;
  logicalOrderId: string;
  merchantId: string;
  quoteId: string;
  customerId: string;
  buyerAgentId?: string;
  items: Array<{
    productId: string;
    sku: string;
    variant: Record<string, string>;
    quantity: number;
    unitAmountMinor: number;
  }>;
  subtotalMinor: number;
  taxMinor: number;
  shippingMinor: number;
  totalMinor: number;
  currency: "INR" | "USDC";
  inventoryHoldId: string;
  returnPolicyDigest: string;
  shippingDestinationDigest: string;
  mandateId: string;
  approvalEventId?: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
};
```

The envelope is canonicalized, signed by the application and hashed with SHA-256. Approval references the exact hash.

## 4. Material-change rule

The following changes always invalidate approval:

- Merchant
- SKU, variant or quantity
- Subtotal, tax, shipping or total
- Currency or payment recipient
- Delivery deadline or inventory reservation
- Return/refund terms
- Mandate, approval requirement or expiry

Copy changes that do not alter commercial meaning may avoid reapproval, but the implementation should begin with a conservative allowlist.

## 5. Order state machine

```text
DRAFT
→ CLARIFYING
→ QUOTED
→ AWAITING_APPROVAL
→ APPROVED
→ PAYMENT_PENDING
→ PAID_VERIFIED
→ FULFILMENT_PENDING
→ FULFILLED
```

Failure branches:

```text
QUOTED/APPROVED → EXPIRED
APPROVED → REAPPROVAL_REQUIRED
PAYMENT_PENDING → PAYMENT_FAILED
PAID_VERIFIED → FULFILMENT_FAILED → COMPENSATION_PENDING
COMPENSATION_PENDING → REFUNDED | MANUAL_REVIEW
```

No transition should be inferred solely from an LLM message.

## 6. Razorpay rail

1. Create an Order for the exact envelope total and currency.
2. Store `logicalOrderId`, `quoteId` and `envelopeHash` in supported metadata/notes while retaining the full signed envelope in the application database.
3. Open Razorpay Checkout and let the user choose UPI, card, net banking or another enabled method.
4. Receive order, payment and signature values.
5. Verify the signature server-side.
6. Correlate webhooks using Razorpay event IDs and tolerate duplicates/out-of-order delivery.
7. Verify stored order amount and state before fulfilment.
8. Use the rail's idempotent refund operation when compensation is required.

Razorpay's signature authenticates the order-payment relationship. Our server-held evidence chain binds that order to the exact Commerce Envelope.

## 7. UPI Reserve Pay

Reserve Pay is an authorization mode under the Razorpay/UPI path, not an unrelated top-level provider.

If access exists, model:

- Merchant-scoped reserve
- Total and per-transaction limits
- Validity window
- User visibility
- Modification and revocation
- Debit history

Without access, document or simulate the mandate semantics but do not claim live execution.

## 8. x402/Solana rail

Recommended primary use: pay for a digital resource or machine API that materially improves the recommendation.

Canonical v2 flow:

```text
request resource
→ 402 + PAYMENT-REQUIRED
→ buyer signs Solana/SPL payment payload
→ retry with PAYMENT-SIGNATURE
→ facilitator verify/settle
→ resource + PAYMENT-RESPONSE
```

Implementation requirements:

- Solana Devnet for the demo
- Exact scheme and supported stablecoin/token
- Stable Payment Identifier for reconciliation and replay handling
- Optional Offer & Receipt extension
- Compact Commerce Envelope digest in the supported Solana memo field when available
- Full private envelope remains off-chain
- A physical-goods refund is a separate compensating transfer, not a reversal

## 9. Unified payment router

```ts
type PaymentRail =
  | "razorpay_checkout"
  | "razorpay_reserve_pay"
  | "x402_solana";

interface PaymentAdapter {
  initiate(input: AuthorizedEnvelope): Promise<PaymentAttempt>;
  verify(input: VerificationInput): Promise<VerificationResult>;
  compensate(input: CompensationInput): Promise<CompensationResult>;
}
```

Rules:

- A logical order may have multiple failed attempts but only one successful rail.
- Every adapter operation receives the same logical order and envelope identity.
- Once one rail verifies as paid, new payment initiation is rejected.
- Compensation semantics remain rail-specific.

## 10. Vulcan seam

Vulcan is not a conversational LLM and no public API is documented. It belongs inside or beneath the Razorpay payment path.

Potential future context, only if Razorpay provides a contract:

- Agent identity and autonomy level
- Human-approval status and age
- Retry status
- Mandate amount and transaction amount
- Cart-drift flag
- Merchant fulfilment history

Create a neutral `PaymentIntelligenceProvider` seam only if it improves modularity. Never label mock or synthetic scores as Vulcan output.

## 11. Audit event model

Each event should include:

```ts
type AuditEvent = {
  eventId: string;
  logicalOrderId: string;
  type: string;
  actor: "customer" | "agent" | "merchant" | "policy" | "payment" | "system";
  occurredAt: string;
  summary: string;
  inputDigest?: string;
  outputDigest?: string;
  externalReferences?: Record<string, string>;
  decision?: "allow" | "block" | "review";
  reasonCodes?: string[];
};
```

Sensitive customer, wallet and address data must not be written into public logs or on-chain metadata.
