# Razorpay Vulcan: verified facts and fit for AgentReady

_Checked 23 August 2026. Primary sources only: Razorpay and technology partner AWS/Amazon._

## Bottom line

Razorpay Vulcan is **not a conversational LLM** and is not a replacement for Claude, GPT, or another agent model. Razorpay describes it as a proprietary, transformer-based **payments foundation model**: an internal shared intelligence layer trained to understand patterns in transaction data and make real-time payment decisions. Its disclosed production jobs are routing, fraud/risk detection, Cash-on-Delivery return-to-origin (RTO) risk, and checkout/payment-method personalisation.

For AgentReady, the credible architecture is:

```text
Claude/GPT/etc.             AgentReady                         Razorpay / Vulcan
understands user intent  -> mandate + deterministic policy -> payment execution/intelligence
                           cart integrity + audit trail       routing, fraud, checkout optimisation
```

AgentReady should therefore be positioned as the **governance, integrity, and certification layer around agentic buying**, while Vulcan is Razorpay's **transaction-intelligence layer underneath payment execution**. This is complementary, not competitive.

## What Razorpay has actually disclosed

### Nature and architecture

- Razorpay announced Vulcan on 18 August 2026 as what it calls India's first AI Payments Foundation Model. Razorpay's own blog calls it a single, unified intelligence layer for payments. [Razorpay announcement](https://razorpay.com/blog/?p=27542)
- AWS's announcement is more technically precise: Vulcan is transformer-based but **"not an LLM"**; it models the movement of money rather than text. It replaces or unifies previously siloed models for routing, fraud, risk, and checkout. [AWS/Amazon partner announcement](https://press.aboutamazon.com/aws-international/2026/8/razorpay-launches-vulcan-indias-first-ai-payments-foundation-model-fueled-by-nvidia-and-aws-re-architecting-payments-for-a-350-bn-e-comm-future-by-2030)
- Razorpay says the model and its training data are proprietary and built from the ground up. NVIDIA accelerated computing powered training and execution; AWS cloud infrastructure and Amazon SageMaker supported development, training, autoscaling inference, and deployment. [Razorpay announcement](https://razorpay.com/blog/?p=27542), [AWS/Amazon partner announcement](https://press.aboutamazon.com/aws-international/2026/8/razorpay-launches-vulcan-indias-first-ai-payments-foundation-model-fueled-by-nvidia-and-aws-re-architecting-payments-for-a-350-bn-e-comm-future-by-2030)
- AWS reports approximately 3 trillion training data points across 4 billion payments, with roughly 3,000 signals per transaction. Razorpay says its network handles almost 4 billion customer-to-merchant payments per year. The exact model size, layer count, embeddings, objective functions, feature schema, latency, and privacy-preserving techniques have not been publicly disclosed in the sources reviewed. [AWS/Amazon partner announcement](https://press.aboutamazon.com/aws-international/2026/8/razorpay-launches-vulcan-indias-first-ai-payments-foundation-model-fueled-by-nvidia-and-aws-re-architecting-payments-for-a-350-bn-e-comm-future-by-2030), [Razorpay announcement](https://razorpay.com/blog/?p=27542)

### Disclosed capabilities

1. **Hyper-Precision Routing:** score available payment routes in real time and choose the route most likely to succeed before the attempt.
2. **Network-Level Fraud Detection:** detect cross-merchant patterns that an individual merchant cannot see.
3. **RTO Risk Intelligence:** identify risky Cash-on-Delivery orders before checkout.
4. **Predictive Checkout Personalisation:** recommend the payment method most likely to work for a shopper.
5. Razorpay also describes offer targeting based on inferred price sensitivity, intended to reduce unnecessary discounting. [Razorpay announcement](https://razorpay.com/blog/?p=27542), [AWS/Amazon partner announcement](https://press.aboutamazon.com/aws-international/2026/8/razorpay-launches-vulcan-indias-first-ai-payments-foundation-model-fueled-by-nvidia-and-aws-re-architecting-payments-for-a-350-bn-e-comm-future-by-2030)

### Release and production status

- Razorpay calls 18 August 2026 the launch and says Vulcan capabilities are already making production decisions. AWS says early components had been running on live transactions before the full launch; named customers include Blinkit, Bachatt, and redBus. [Razorpay announcement](https://razorpay.com/blog/?p=27542), [AWS/Amazon partner announcement](https://press.aboutamazon.com/aws-international/2026/8/razorpay-launches-vulcan-indias-first-ai-payments-foundation-model-fueled-by-nvidia-and-aws-re-architecting-payments-for-a-350-bn-e-comm-future-by-2030)
- The stated long-term goal is broader than today's deployment: Razorpay wants every payment decision, eventually including authentication and lending, to use the shared model. Those future areas must not be presented as current capabilities. [AWS/Amazon partner announcement](https://press.aboutamazon.com/aws-international/2026/8/razorpay-launches-vulcan-indias-first-ai-payments-foundation-model-fueled-by-nvidia-and-aws-re-architecting-payments-for-a-350-bn-e-comm-future-by-2030)

### Company-reported results—not independent benchmarks

AWS's publication reports the following Razorpay results from early live deployment:

- 8–10% improvement in payment success rates.
- 8x more international-card fraud detected and stopped.
- 5x more fraudulent or disputed transactions identified without more alerts.
- 40% more shoppers shown their preferred UPI app in Magic Checkout, associated with 1–2 lakh additional completed purchases per month.

These are **company-reported operational outcomes**, not a public benchmark with an independently inspectable dataset, baseline definition, statistical methodology, or model card. They can be cited with that qualification. [AWS/Amazon partner announcement](https://press.aboutamazon.com/aws-international/2026/8/razorpay-launches-vulcan-indias-first-ai-payments-foundation-model-fueled-by-nvidia-and-aws-re-architecting-payments-for-a-350-bn-e-comm-future-by-2030)

## Access and API availability

The reviewed official materials do **not** disclose:

- A Vulcan API endpoint, SDK, playground, public model weights, or model download.
- A developer waitlist or documented Buildathon-specific Vulcan access.
- Request/response schemas for fraud, routing, RTO, checkout, or offer scores.
- Confirmation that test-mode Razorpay payments run through Vulcan or expose its decisions.

Therefore the safe conclusion is: **Vulcan appears to be an internal intelligence layer embedded in Razorpay's production products, not a publicly callable developer model at present.** This is an inference from the absence of disclosed access—not proof that no private or partner interface exists.

Ordinary Razorpay APIs and test-mode keys are documented, but those should not be conflated with Vulcan access. [Razorpay API documentation](https://razorpay.com/docs/api/), [Razorpay sandbox documentation](https://razorpay.com/docs/api/sandbox-setup/)

## Credible role in AgentReady

### What we can build now

1. **Use a general-purpose model for language and planning.** It converts the buyer's natural-language request into a structured purchase mandate and explains product selection.
2. **Use deterministic AgentReady code for financial authority.** Merchant, cart hash, amount, expiry, approval threshold, idempotency, and refund rules are checked in code, not delegated to an LLM.
3. **Use Razorpay test-mode APIs for order, checkout, signature verification, webhook, and refund lifecycle.** This is the verifiable integration.
4. **Treat Vulcan as the production intelligence below that interface.** In the product story, a real Razorpay deployment could benefit from Vulcan's routing, fraud, and checkout personalisation while AgentReady protects the user-intent-to-receipt chain.
5. **Certify the agentic layer, not Vulcan itself.** AgentReady tests cart drift, hidden fees, expired mandates, duplicate calls, out-of-order webhooks, fulfilment failure, prompt injection, and refund recovery. It should not claim to assess Vulcan's proprietary model internals.

### Future integration seam, clearly labelled

Define an internal `PaymentIntelligenceProvider` seam that can accept optional signals such as:

```text
recommended_payment_method
route_success_likelihood
risk_decision
rto_risk
reason_codes
```

For the Buildathon, populate it with transparent synthetic/demo data or ordinary exposed Razorpay outcomes and label it accordingly. If Razorpay later grants Vulcan access, the adapter can be replaced without altering the mandate, policy, payment, or audit architecture. Do **not** name a demo/mock adapter `Vulcan API`.

### Strong presentation line

> Vulcan helps Razorpay decide how a payment should succeed safely. AgentReady proves that the payment should happen at all—and that what was charged and fulfilled is exactly what the user authorized.

This creates a clean division:

| Layer | Responsibility |
|---|---|
| Buyer agent (Claude/GPT/etc.) | Understand intent; discover and recommend |
| AgentReady | Bind intent to cart; enforce authority; gate actions; audit and certify |
| Razorpay + Vulcan | Execute and optimise payment; route intelligently; detect network risk; personalise checkout |

## Claims to avoid

- **"Vulcan is Razorpay's new LLM."** Official partner material explicitly says it is not an LLM.
- **"Our app calls Vulcan."** No public endpoint or Buildathon access is documented.
- **"Vulcan works in Razorpay test mode."** Not disclosed.
- **"Vulcan explains every decision."** The sources disclose scoring and predictions, not merchant-facing reason codes or explainability interfaces.
- **"Vulcan guarantees fraud-free or failure-free payments."** No model can support that claim, and Razorpay reports improvements rather than guarantees.
- **"Vulcan provides AP2/UAP mandates, cart signing, approvals, idempotency, webhook ordering, fulfilment, or refunds."** Those are separate protocol/application/payment-lifecycle concerns and are precisely where AgentReady adds value.
- **"The 8–10%, 8x, or 5x figures are independent benchmark results."** They are company-reported live outcomes without a published benchmark methodology.
- **"The model automatically learns from every transaction online in real time."** Razorpay uses continuously-learning language, but the update mechanism and cadence are not disclosed; avoid implying unsafe online weight updates.
- **"We certify Vulcan or Razorpay security."** AgentReady should certify a merchant integration and agent transaction flow against its own declared scenarios, not audit proprietary Razorpay internals.

## Recommendation

Keep Vulcan in the pitch because it strengthens the Razorpay-specific architecture, but do not make project completion depend on access to it. The defensible USP remains:

> AgentReady supplies the missing policy, transaction-integrity, and certification control plane for AI buyers; Razorpay supplies regulated payment execution; Vulcan supplies proprietary payments intelligence underneath that execution.

That story shows awareness of Razorpay's newest technical direction while leaving the prototype truthful, testable, and fully implementable with public test-mode APIs.
