# x402/Solana + Razorpay: verified facts and recommended dual-rail design

_Checked 23 August 2026. Primary sources only. Facts and recommendations are deliberately separated._

## Bottom line

x402 v2 on Solana is a credible **alternative settlement rail** for an agent: it negotiates a price over HTTP, lets the buyer sign a partially signed Solana transaction, delegates verification/fee sponsorship/submission to a facilitator, and returns a transaction result. It does **not** decide which physical product to buy, authorize the agent's shopping mandate, reserve inventory, calculate shipping/tax, handle delivery, or provide native reversals/disputes.

The defensible Buildathon design is therefore **not “Razorpay plus blockchain in one payment.”** It is one agent-commerce control plane with two mutually exclusive rail adapters:

- Razorpay test mode for the complete India/INR physical-goods path.
- x402 v2 + Solana Devnet for an opted-in stablecoin path, preferably demonstrated first with a digital good/API; a physical-good purchase is feasible only because our application supplies the missing retail lifecycle.

Both rails reference the same signed, immutable commerce envelope. Vulcan belongs only underneath the Razorpay rail and is not publicly callable in the material reviewed.

## Part I — Verified facts

### 1. What x402 v2 actually does

The canonical v2 HTTP flow is:

1. Client requests a protected resource.
2. Resource server replies `402 Payment Required` with a Base64-encoded `PaymentRequired` object in `PAYMENT-REQUIRED`. It contains the resource and one or more acceptable combinations of scheme, network, asset, amount, payee and timeout.
3. Client selects one option, constructs a scheme-specific `PaymentPayload`, and retries with it in `PAYMENT-SIGNATURE`.
4. Resource server verifies locally or calls a facilitator's `/verify` endpoint.
5. Resource server settles locally or calls `/settle`.
6. It returns the resource plus a Base64-encoded `SettlementResponse` in `PAYMENT-RESPONSE` (or a payment error).

The facilitator is optional infrastructure: it standardizes verification and settlement; on Solana it can sponsor fees, add the missing fee-payer signature, submit the transaction, and await confirmation. It does not need custody of the buyer's funds. [x402 v2 specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md), [x402 facilitator flow](https://docs.x402.org/core-concepts/facilitator), [Coinbase facilitator FAQ](https://docs.cdp.coinbase.com/x402/support/faq)

### 2. Exact v2 flow on Solana

For Solana's `exact` scheme, the server's requirements identify an SPL/Token-2022 mint, receiving wallet, amount, sponsor/fee payer and timeout. The client builds and signs a versioned Solana transaction; the sponsor signature remains missing. The facilitator/sponsor verifies the required transfer and its own safety policy, adds its fee-payer signature, submits it, and returns a settlement result. The canonical network IDs are `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (mainnet) and `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet). [Exact SVM specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md), [network and token support](https://docs.x402.org/core-concepts/network-and-token-support)

The latest SVM specification is outcome-based. It requires exactly one matching transfer to the derived recipient token account, disallows partial fulfilment, and tolerates overpayment while rejecting an underpayment. It also imposes fee-payer isolation and supports a stricter sponsor acceptance policy. This is payment correctness, not cart correctness. [Exact SVM specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md)

For a no-key demo, the Foundation's `https://x402.org/facilitator` supports x402 v2 `exact` on Solana Devnet. The CDP facilitator supports v2 `exact` on Solana mainnet and devnet but requires CDP credentials for its mainnet endpoint. Solana v2 supports SPL and Token-2022 tokens; actual support still depends on the chosen facilitator. [Coinbase network support](https://docs.cdp.coinbase.com/x402/network-support), [x402 network support](https://docs.x402.org/core-concepts/network-and-token-support)

### 3. The audit primitives x402 provides

- Core `SettlementResponse` can contain success, network, payer, amount and transaction hash. Carried in `PAYMENT-RESPONSE`, it is a settlement result; core does not by itself make it a merchant-signed retail receipt. [x402 v2 specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)
- The optional **Offer & Receipt extension** lets the resource server sign the offered payment terms and, after success, sign a receipt. Its standard offer commits to resource URL, scheme, network, asset, payee, amount and expiry; its receipt contains resource URL, network, payer, issue time and optionally transaction hash. It does **not** natively contain SKU, size, shipping address, tax, returns policy or physical-delivery evidence. Its wire placement is explicitly described as potentially evolving. For Solana-native keys, the official docs recommend JWS/Ed25519 as a natural signing choice. [Offer & Receipt specification](https://github.com/x402-foundation/x402/blob/main/specs/extensions/extension-offer-and-receipt.md), [official extension guide](https://docs.x402.org/extensions/offer-receipt)
- The optional **Payment Identifier extension** adds a 16–128 character identifier for tracking, reconciliation and application-level idempotency. The server must still extract it and check/cache it; merely attaching the ID does not create idempotency automatically. [Payment Identifier guide](https://docs.x402.org/extensions/payment-identifier)
- v2 supports custom extensions and lifecycle hooks. A custom extension is useful for carrying a declared commerce schema, but custom data is not magically standardized, understood by arbitrary agents, or cryptographically bound to the Solana transfer. [Extensions overview](https://docs.x402.org/extensions/overview), [x402 v2 extension schema](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)
- Solana `exact` supports an optional seller-defined `extra.memo` of up to 256 bytes. When present, the reference verifier requires the transaction's Memo instruction to match it. This is the cleanest standardized place to anchor a compact invoice/envelope digest on the Solana transaction. [Exact SVM specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md)

### 4. What x402 does **not** cover

x402's own materials describe it as a protocol for paying to access internet resources, APIs and services. Budget/spending controls and correlation are explicitly implementation-specific. Its `exact` and `upto` payments are push payments and irreversible; a refund is a separate seller-to-buyer transfer, while conditional/escrow refunds are future-scheme territory. [x402 repository](https://github.com/x402-foundation/x402), [x402 v2 specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md), [Coinbase x402 FAQ](https://docs.cdp.coinbase.com/x402/support/faq)

Consequently, core x402 does not provide:

- preference discovery or “best shoe” ranking;
- a user mandate, per-category budget or human approval policy;
- retail cart line items, variants or cart-change detection;
- inventory reservation, shipping, tax, fulfilment or proof of physical delivery;
- returns, native refunds, chargebacks or card-like consumer dispute rights;
- stablecoin acquisition/off-ramp, INR conversion, or the merchant's compliance/tax treatment.

Those must remain application, merchant, wallet/facilitator or jurisdiction-specific layers. A physical-goods order can use x402 for settlement, but saying “x402 solves physical commerce” would overclaim.

### 5. What Razorpay provides for the other rail

Razorpay's public Orders API fixes the amount/currency for an order, groups multiple attempts, provides a unique merchant receipt, and supports merchant `notes`; those notes can store a commerce-envelope digest. Standard Checkout returns order/payment IDs and a signature, which Razorpay requires the server to verify before fulfilment. Refund APIs provide explicit idempotency support. [Create Order API](https://razorpay.com/docs/api/orders/create/), [Checkout signature verification](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/), [idempotent refund API](https://razorpay.com/docs/api/refunds/normal-refunds-idempotent/)

Important limitation: Razorpay's checkout signature authenticates the `order_id | payment_id` relationship, not our cart JSON or `notes` directly. The digest-to-order binding is therefore an evidence chain maintained by our server (and rechecked against the server-created order), not a claim that Razorpay signed every line item.

### 6. Vulcan's legitimate role and current access boundary

Razorpay describes Vulcan as a proprietary transformer-based **payments foundation model**, not a conversational LLM. Its disclosed production roles include route scoring, network-level fraud detection, RTO risk, payment-method personalisation and offer targeting. [Razorpay Vulcan announcement](https://razorpay.com/blog/?p=27542), [AWS/Razorpay technical announcement](https://press.aboutamazon.com/aws-international/2026/8/razorpay-launches-vulcan-indias-first-ai-payments-foundation-model-fueled-by-nvidia-and-aws-re-architecting-payments-for-a-350-bn-e-comm-future-by-2030)

The reviewed official announcement and public API index disclose no Vulcan endpoint, SDK, playground, test-mode score, reason-code schema or Buildathon access. The safe inference is that Vulcan is currently an internal Razorpay intelligence layer, not a public dependency we can call. Razorpay's public API index documents Orders, Payments, Refunds and related products but not Vulcan. [Razorpay API index](https://razorpay.com/docs/api/)

No source reviewed says Vulcan consumes agent mandate fields, cart hashes or x402/Solana activity. It should not be placed above both rails, claimed as our fraud model, or simulated under the Vulcan name.

## Part II — Recommended architecture (our design, not current product claims)

### 1. One commerce control plane, two alternative rails

```text
Buyer request
  -> preference clarification / ranked shortlist
  -> exact merchant quote + inventory hold
  -> signed Commerce Envelope
  -> deterministic mandate/policy check
  -> choose exactly one rail
       A. Razorpay INR order/checkout
       B. x402 v2 Solana stablecoin settlement
  -> rail-specific verification
  -> asynchronous fulfilment / refund workflow
  -> unified audit timeline
```

Razorpay must remain the main demonstration because this is Razorpay's Buildathon and it supplies the richer physical-goods lifecycle. x402/Solana is the interoperability proof: the same governance layer can safely drive another machine-native rail. It is not a second charge, a backup transaction after Razorpay, or a claim of Razorpay–Solana integration.

### 2. The signed Commerce Envelope

After preference clarification and product selection, create one canonical object containing at least:

```text
version, merchant_id, quote_id, user/agent IDs,
line items (SKU/variant/qty), subtotal, tax, shipping, currency, total,
inventory-hold ID, return-policy digest, shipping destination digest,
mandate limits, approval event, issued_at, expires_at, nonce
```

Canonicalize it, sign it server-side, and compute `envelope_hash = SHA-256(canonical_envelope)`. Approval always names this exact hash. Recompute the hash immediately before payment. A changed price, SKU, quantity, fee, policy or expired quote requires a new envelope and approval.

This is the concrete answer to “what if the merchant or agent changes something?” It need not mean an attack: inventory repricing, a newly calculated delivery fee, wrong tool arguments, a retried stale cart, or accidental variant substitution can all make the charged cart differ from what was approved.

### 3. Binding the same envelope to each rail without overclaiming

**Razorpay rail**

- Create the Razorpay order for the envelope's exact total/currency.
- Store the full `envelope_hash` and internal quote ID in order `notes`; use the unique `receipt` as the application idempotency/correlation key.
- Keep the signed canonical envelope in our database.
- Before fulfilment, verify the Checkout signature, fetch/check order state and amount, then compare the stored order-to-envelope link.
- Store order, payment, webhook and refund IDs on the same audit record; use Razorpay's refund idempotency header for retries.

This provides a strong server-maintained evidence chain, but we must say “linked to a Razorpay order,” not “Razorpay cryptographically signed the cart.”

**x402/Solana rail**

- Make a free quote/reservation first; the paid resource is a unique order-acceptance endpoint such as `/orders/{quote_id}?digest={envelope_hash}`.
- Advertise `exact` on Solana Devnet. Use the built-in `payment-identifier` extension with a stable order/payment ID for retries.
- Put a compact domain-separated value such as `agentcart:v1:<base58(envelope_hash)>` in `extra.memo`; the SVM verifier then requires the client transaction to contain that memo.
- Optionally enable a JWS Offer & Receipt extension. Because its signed offer includes `resourceUrl`, placing the digest in the unique resource URL indirectly binds the signed offer to the envelope; the Solana Memo anchors the same digest to the payment transaction.
- Settle through the facilitator, return the order acceptance plus `PAYMENT-RESPONSE`, and treat physical fulfilment as a later application event.
- If fulfilment fails, execute and audit a separate compensating stablecoin transfer. Do not label it a native x402 reversal.

The on-chain memo reveals only a digest, not customer/cart data. The full envelope remains off-chain. The digest proves correspondence if the canonical envelope is later disclosed; it does not prove that the goods were delivered.

### 4. Certification/conformance claims we can honestly make

Call the feature an **Agent Commerce Conformance Suite** or **Readiness Score**, not an independent security certification. Test our own declared invariants across both rails:

- approved envelope hash equals the pre-payment envelope hash;
- one logical order selects only one rail;
- cart drift/expiry/over-budget cases are blocked before payment;
- duplicate agent calls return one logical result;
- Razorpay: verified signature, correct amount/order, webhook dedupe/order tolerance, idempotent refund;
- x402: correct network/asset/payee/amount, memo equals envelope digest, payment identifier replay behavior, valid facilitator settlement response;
- payment-success/fulfilment-failure transitions create an explicit refund/compensation case;
- every decision and external ID appears in the audit trail.

This suite evaluates our merchant integration and orchestration. It does not certify Razorpay, Vulcan, Solana, the facilitator, or all arbitrary buyer agents.

### 5. Where Vulcan fits

```text
General LLM            Our control plane                    Payment rail
intent/preferences -> envelope + policy + rail choice -> Razorpay public APIs
                                                       -> x402/Solana

Inside Razorpay's production path (not our callable layer): Vulcan may optimise
routing, risk and checkout personalisation.
```

For the prototype, define a neutral future seam such as `PaymentIntelligenceProvider`, but populate it only with exposed Razorpay outcomes or clearly labelled synthetic demo data. If Razorpay grants private Vulcan access, plug in the real contract and surface actual outputs. Until then:

- say **“Vulcan-compatible context is a future collaboration point,”** not “powered by Vulcan”;
- do not show invented Vulcan scores or reason codes;
- do not imply Vulcan controls Solana settlement;
- do not claim Vulcan verifies the cart/mandate—our deterministic control plane does that.

## Recommended demo scope

1. Show a merchant-specific query, clarification and ranked shortlist—not blind autonomous choice from a vague request.
2. Lock one exact quote and show the approved Commerce Envelope.
3. Complete the main physical-goods flow through Razorpay test mode.
4. Tamper with price/variant after approval and show deterministic rejection.
5. Replay the order and show no duplicate logical charge.
6. In a separate scene, pay for a digital add-on/API through x402 v2 on Solana Devnet using the same envelope/audit model.
7. End on one audit timeline and conformance results.

This tells a stronger story than forcing x402 into the primary retail path: Razorpay remains central, Solana interoperability is real, and every technical claim is demonstrable with public interfaces.
