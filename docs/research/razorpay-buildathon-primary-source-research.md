# Razorpay AI Buildathon: primary-source strategy research

Research date: 2026-08-23. Sources are limited to Razorpay, the protocol owners/specifications, and official documentation.

## Executive finding

The evidence supports **Track 01 — AI Growth & Agentic Commerce**, but not a generic shopping assistant, voice checkout, or x402 demo. Razorpay already has public pilots for conversational checkout with ChatGPT, Claude, Swiggy, Zomato, Zepto, BigBasket and Sarvam; those concepts validate the market but are no longer distinctive. The strongest whitespace is the **merchant enablement and trust/interoperability layer**:

> Make an ordinary Razorpay merchant agent-readable and safely transactable by any compliant AI buyer: publish a UCP merchant profile and catalog/checkout surface, bind user authorization to the exact cart via AP2-style mandates, execute the payment through Razorpay test-mode Orders/Checkout, and return a signed, inspectable receipt and audit trail.

This fits Razorpay's stated Track 01 outcome exactly—“make a merchant transactable by an AI buyer end to end”—and its explicit bar that every money action be explainable, bounded, gated, auditable, with one failure handled gracefully ([official Buildathon brief](https://razorpay.com/buildathon/)). It also advances Razorpay’s publicly stated strategy of converting AI intent into trusted transactions rather than cloning one of the production agents Razorpay already announced.

There is no official application-distribution data. Claims that one track will be less crowded are therefore speculation. The defensible selection criterion is **strategic whitespace + proof strength**, not assumed application count.

## What the Buildathon actually requires

The page states that candidates must pick a track, build something real, and show a **public repository, five-minute pitch video, and architecture**. Projects with signal proceed directly to a panel ([Buildathon brief](https://razorpay.com/buildathon/)). The individual track bars are unusually explicit:

| Track | Required proof, not merely suggested idea |
|---|---|
| 01 Growth & Agentic Commerce | Grow merchant revenue on Razorpay test-mode APIs **or** make a merchant transactable by an AI buyer end to end. Every money action must be explainable, bounded and gated; show an audit trail and one graceful failure. |
| 02 Risk Manager | A working detector/verifier/auto-responder for one class of loss; measured precision and recall on a held-out set; report false-positive cost; defense-only. |
| 03 Revenue Recovery | Detect, choose and execute a bounded intervention; show measured money recovered across a batch; compliant escalation, stopping rules and audit trail. |
| 04 Finance Controller | Close one finance-ops loop over 50+ synthetic records; show throughput, measured accuracy and unresolved exceptions. |
| 05 Open | A real problem, meaningful AI, working product and evidence of value; same execution/reliability/depth standard. |

Source: [Razorpay Buildathon](https://razorpay.com/buildathon/).

Implication: a polished interface is useful for the pitch, but the official bars reward **observable execution and evidence**. The project should be designed around an evaluation harness and failure cases from day one, not around a chat screen.

## Razorpay product reality: where obvious ideas are already occupied

Razorpay’s March 2026 product announcement says its Agent Studio already includes production-ready agents for **abandoned-cart conversion, dispute response, subscription recovery and cash-flow forecasting**. It also describes an Agentic Dashboard that matches uploaded bank statements to Razorpay settlements ([Razorpay Agent Studio announcement](https://razorpay.com/newsroom/?p=4704)). These correspond almost one-for-one with the most obvious submissions in Tracks 02–04.

This does not make those tracks invalid. It means a submission such as “AI subscription recovery caller,” “dispute evidence writer,” “cash forecaster,” or “CSV settlement matcher” risks looking like a small reimplementation of a product Razorpay has already announced. To be distinctive in those tracks, the project would need a new wedge, superior evaluation, or an ecosystem capability not already described.

Track 01’s obvious consumer assistant is also occupied:

- Razorpay, NPCI and OpenAI publicly demonstrated an AI agent that searches BigBasket, asks once for confirmation, pays through Razorpay’s UPI stack, provides real-time tracking, and supports instant revocation ([Razorpay–NPCI–OpenAI announcement](https://razorpay.com/newsroom/?p=4631)).
- Razorpay and NPCI brought similar in-conversation commerce to Claude with Zomato, Swiggy and Zepto. Their stated trust properties are spending limits, visibility, consent revocation, transparency, reversibility and user control ([Razorpay–NPCI–Claude announcement](https://razorpay.com/newsroom/?p=4701)).
- Razorpay and Sarvam announced multilingual, voice-first commerce, including a Swiggy integration and an embedded website assistant for The Derma Co ([Razorpay–Sarvam announcement](https://razorpay.com/newsroom/razorpay-partners-with-sarvam-to-power-voice-first-conversational-commerce-for-india/)).

Therefore, “chat or voice shopping using Razorpay” by itself is not a USP. The better question is: **how do the millions of ordinary Razorpay merchants become available to those agents safely and with minimal integration work?**

## Why the merchant enablement/control-plane wedge is Razorpay-aligned

Razorpay says the end state is to turn assistants from discovery tools into full shopping agents and enable safe, secure, user-controlled transactions through its payments stack ([Razorpay–NPCI–OpenAI](https://razorpay.com/newsroom/?p=4631)). It also says it is extending in-app commerce across several brands and wants intent to become a transaction ([Agent Studio announcement](https://razorpay.com/newsroom/?p=4704)). The Buildathon itself explicitly calls “agent-readable catalog” an example direction and names UAP, ACP, AP2 and x402 as the relevant protocol race ([Buildathon brief](https://razorpay.com/buildathon/)).

The official protocol specifications reveal a natural role for Razorpay:

- **UCP is the commerce language.** It standardizes discovery and the shopping lifecycle, supports REST/MCP/A2A transports, and deliberately separates payment instruments from payment handlers/processors ([UCP overview](https://developers.googleblog.com/under-the-hood-universal-commerce-protocol-ucp/)). A business publishes its capabilities and payment configuration at `/.well-known/ucp`; checkout supports create, get, update, complete and cancel ([UCP checkout specification](https://ucp.dev/specification/checkout/)). This makes a **Razorpay UCP payment handler/merchant adapter** structurally plausible.
- **AP2 is the authorization and evidence layer.** The official AP2 v0.2 spec defines Shopping Agent, Credential Provider, Merchant, Merchant Payment Processor and Trusted Surface roles. It binds a user-authorized mandate to a merchant-signed checkout, requires deterministic verification, and requires receipts upon acceptance or rejection. Its open mandates support autonomous flows under constraints and short expiry ([AP2 specification](https://github.com/google-agentic-commerce/AP2/blob/main/docs/ap2/specification.md)). Razorpay naturally maps to the Merchant Payment Processor/delegated verification role.
- **x402 is a paid-resource protocol, not the complete retail checkout model.** x402 v2 standardizes payment requirements, signed authorization, verification and blockchain settlement for resources, and explicitly leaves client-side budget management and sessions out of scope ([x402 v2 specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)). Its reference flow is request → HTTP 402 with terms → signed payment → verify/settle → resource ([Coinbase x402 docs](https://docs.cdp.coinbase.com/x402/welcome)). It is excellent for paid APIs/digital services; AP2/UCP better express carts, merchants, buyer intent and approval.

Important strategic conclusion: implementing x402 alone would demonstrate Coinbase’s payment rail more strongly than Razorpay’s. The more Razorpay-aligned use is a **protocol gateway/router** that exposes an agent-compatible offer while executing the Indian merchant payment through Razorpay; x402 can be shown as an optional paid-resource adapter or comparison path, not the central payment rail.

## Feasibility with Razorpay test-mode APIs

The required vertical slice is implementable without production access:

- Razorpay’s API reference says APIs are REST/JSON, uses test API keys, and exposes Orders, Payments, Settlements, Refunds, Disputes, Payment Links, Invoices, Subscriptions and Webhooks ([API reference](https://razorpay.com/docs/api/)).
- Orders can be created and linked to payments; the API can retrieve payments made toward each order ([Orders APIs](https://razorpay.com/docs/api/orders/)).
- Payments APIs can capture an authorized payment and retrieve payment/order/card detail, but do not themselves collect a payment; Checkout or another acceptance product must handle collection ([Payments APIs](https://razorpay.com/docs/api/payments/)).
- Payment Links can be created with amount, expiry, reference ID and customer metadata; success callbacks carry identifiers and a signature that the server should verify. Test Mode supports deliberate success and failure flows ([Payment Links guide](https://razorpay.com/docs/payments/payment-links/apis/), [test-payment guide](https://razorpay.com/docs/payments/payment-links/create/)).
- Refund APIs allow full or partial refund for captured payments, which gives a concrete reversible-action demo ([Refunds APIs](https://razorpay.com/docs/api/refunds/)).
- Webhooks provide event notifications, enabling an event-driven audit trail ([Webhooks APIs](https://razorpay.com/docs/api/partners/webhooks/)).

A practical solo demo can therefore use:

1. A synthetic merchant and small catalog.
2. A `/.well-known/ucp` profile and a narrow catalog/checkout implementation.
3. A buyer agent receiving a constrained intent.
4. Deterministic policy evaluation and an approval UI for out-of-policy requests.
5. Razorpay test Order plus Standard Checkout or Payment Link.
6. Server-side signature verification/webhook ingestion.
7. A receipt tying intent, exact cart, authorization, Razorpay order/payment IDs and outcome together.
8. One deliberate failure: over-budget block, expired mandate, changed price/cart hash, failed payment, duplicate request, or refund.

The most credible safety design follows AP2’s principle: use the LLM for interpretation, ranking and explanation, but keep money-policy enforcement, signature/hash checks, idempotency and state transitions deterministic.

## Cross-track assessment based on explicit bars and available APIs

### Track 01 — recommended

**Proof strength:** end-to-end transaction, policy trace, approval gate, payment result, receipt and negative tests.
**Razorpay fit:** highest; agentic payments is a declared strategic frontier and existing pilots create a strong “merchant onboarding into this ecosystem” story.
**Differentiation requirement:** do not build another conversational storefront. Build the interoperability/trust adapter that lets an ordinary Razorpay merchant participate.
**Key risk:** overclaiming protocol compliance. Clearly label full vs partial UCP/AP2 implementation and test against official schemas/examples.

### Track 02 — viable only with an unusual risk wedge

Razorpay’s Disputes APIs can fetch disputes with expanded payment and settlement detail, accept disputes, or contest them with explanations/supporting documents ([Disputes APIs](https://razorpay.com/docs/api/disputes/)). This makes a real workflow possible, but Razorpay has already announced a production Dispute Responder Agent. The official held-out precision/recall and false-positive-cost requirement also makes the quality of the labelled dataset central. A more distinctive version would be a **tamper-evident agentic-commerce dispute evidence verifier** using AP2/UCP receipts, but that starts to overlap Track 01 and may be harder to explain.

### Track 03 — easy to prove, but obvious wedges are occupied

Razorpay supports test subscriptions and webhooks; its Subscription APIs cover plan creation, subscription creation, pause/resume/cancel and invoice retrieval ([Subscriptions APIs](https://razorpay.com/docs/api/payments/subscriptions/)). Payment Links can close a recovery journey. However, Razorpay already announced abandoned-cart and subscription-recovery agents. A differentiated approach would need causal intervention selection with an offline counterfactual evaluation, not merely reminders/retries. The Buildathon demands actual batch-level money recovered, so a hand-scripted single recovery is insufficient.

### Track 04 — straightforward evidence, but common implementation is already described

Settlement APIs expose all settlements, a settlement by ID, and settlement reconciliation details ([Settlements APIs](https://razorpay.com/docs/api/settlements/)). This directly supports a 50+ record reconciliation harness. But Razorpay’s Agentic Dashboard announcement already describes bank-statement-to-settlement matching. A distinctive wedge might reconcile the **full agentic transaction evidence chain** (intent/mandate/order/payment/refund/settlement), yet Track 01 can present that as its control plane with a stronger future-facing story.

### Track 05 — not strategically preferable for a Razorpay-centric idea

The Open Track officially exists for ideas that do not fit the first four and carries the same bar. A merchant agent-commerce adapter plainly fits Track 01. Submitting it as Open would weaken the evaluator’s immediate mapping from brief to proof without lowering execution requirements. Open makes sense only if the core problem is outside merchant growth, risk, recovery and finance operations.

## Recommended product thesis and defensible USPs

Working thesis:

> **Razorpay Agent Commerce Gateway** — one adapter that turns a merchant’s current catalog and Razorpay account into a discoverable, policy-safe storefront for AI agents.

Defensible USPs:

1. **Merchant enablement, not another buyer chatbot.** The artifact exposes reusable protocol endpoints that different buyer agents can call.
2. **Indian payment rail as a first-class UCP handler.** The transaction is executed through Razorpay test-mode Orders/Checkout rather than substituting an on-chain x402 settlement.
3. **Intent-to-receipt evidence.** Every step links user intent → constraints → merchant quote/cart → approval/mandate → Razorpay order/payment → webhook-confirmed receipt.
4. **Agent-safe by construction.** LLM judgment is separated from deterministic money controls; cart/price mutation, expiry, limits and duplicate actions are mechanically rejected.
5. **Protocol translation.** A merchant integrates once; UCP-compatible agents can discover and transact. An optional x402 adapter can monetize digital resources while sharing the same policy/audit layer.
6. **Measurable merchant outcome.** Run an automated suite of at least 50 purchase intents and report completion rate, policy-block accuracy, duplicate-charge rate (target zero), time-to-checkout, failure recovery and audit completeness.

These USPs are harder to imitate with a surface-level demo because they are visible in the API surface, evaluation report and negative-path evidence—not merely in presentation copy.

## Five-minute pitch evidence order

1. **Problem (20s):** Razorpay already proves AI buyers exist; ordinary merchants still need a safe, standard on-ramp.
2. **Successful path (75s):** a fresh buyer agent discovers the merchant, selects goods, obtains the exact quote, passes constraints and completes a Razorpay test payment.
3. **Trust path (60s):** change the cart after approval or exceed the limit; deterministic checks block it and request explicit approval.
4. **Failure path (45s):** simulate failed payment or duplicate request; show no double charge and a clear recovery state.
5. **Merchant view (45s):** conversion funnel, orders, revenue, exceptions and line-by-line audit evidence.
6. **Evaluation (35s):** 50+ scripted intents with success, refusal, tampering and failure cases; display measured outcomes.
7. **Razorpay value (20s):** one adapter makes existing merchants available to many AI surfaces while keeping Razorpay as processor and trust layer.

## Claims to avoid

- Do not claim this is an official Razorpay UCP/AP2 implementation unless Razorpay publishes one or the project passes the full official conformance requirements.
- Do not imply x402 itself provides spending limits or retail authorization; its official v2 spec explicitly places client-side budget management outside core scope.
- Do not claim the recommended track is less crowded without application data.
- Do not present synthetic recovered revenue or fraud prevention as real merchant impact; label simulations and evaluation methodology clearly.
