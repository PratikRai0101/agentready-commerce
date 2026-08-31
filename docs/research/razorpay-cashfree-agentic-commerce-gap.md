# Razorpay vs Cashfree agentic commerce: what exists and what Track 01 is asking for

_Checked 23 August 2026. Primary sources only._

## Executive conclusion

The reported Razorpay–Claude experience is real, but it is not evidence that Track 01 has already been solved as a broadly available product. Razorpay describes the Zomato, Swiggy and Zepto experience as a **pilot for a small/closed user group**. The payment authorization is based on UPI Reserve Pay: the user authorizes a merchant-specific spending reserve once, after which exact amounts can be debited within that authorization without another PIN step.

Cashfree HERE is currently better packaged as a **self-serve in-chat checkout component**: it has public integration documentation and an npm package that renders UPI, card and net-banking widgets inside MCP-compatible chats. However, its documented ReservePay method is still marked “coming soon.” Its present public widget is therefore primarily a secure, user-completed checkout inside chat, not the same thing as a generally available autonomous/delegated payment mandate.

The Buildathon brief itself says Razorpay’s pilots are already live. The assignment is therefore not “recreate the Claude demo.” It invites builders to construct the product layers needed to make agentic commerce general, safe and valuable for merchants: catalog/discovery, growth decisions, authorization, protocol interoperability, auditability, and reliable handling of the complete order/payment lifecycle.

## What Razorpay has actually implemented

### Confirmed scope and status

Razorpay announced on 20 February 2026 that Claude could order from Zomato, Swiggy and Zepto without leaving the conversation. Razorpay explicitly called it a pilot for a small group of users and said a demonstration was shown at the India AI Impact Summit. The described flow is:

1. Claude interprets the request and finds suitable items from the merchant.
2. The user confirms the proposed order.
3. Razorpay executes payment through UPI Reserve Pay.
4. The merchant fulfills the order, while the conversation reports completion.

The user first approves a spending amount for a particular merchant. Later purchases can be debited from that reserve without repeated UPI PIN prompts; the user retains visibility, can change limits and can revoke consent. [Razorpay–NPCI Claude pilot announcement](https://razorpay.com/newsroom/?p=4701) and [Razorpay’s pilot explainer](https://razorpay.com/blog/?p=26080).

This was preceded by the October 2025 Razorpay–NPCI–OpenAI announcement, also described as a pilot/exploration rather than a general product launch. [Razorpay–NPCI–OpenAI announcement](https://razorpay.com/newsroom/?p=4631).

Razorpay’s current product page separates the maturity of its offerings:

- In-app agentic payments are labeled beta.
- LLM and voice variants require sign-up.
- UPI Reserve Pay is labeled live.
- UPI Circle is labeled coming soon.

[Razorpay Agentic Payments product page](https://razorpay.com/agentic-payments/).

### The underlying payment mechanism

UPI Reserve Pay is Single Block Multi Debit. The customer authorizes a reserved amount once with a UPI PIN; the business may then debit exact amounts as goods or services are delivered, without fresh authentication for each debit. Razorpay’s public documentation exists, but account activation is eligibility/support-gated. [Razorpay UPI Reserve Pay documentation](https://razorpay.com/docs/payments/recurring-payments/upi-reserve-pay/).

NPCI’s own guidelines make the consent boundary important: the reserve is created with a merchant; it must remain visible to the user; transaction history and available limit must be shown; and creation, modification and revocation controls must be available. [NPCI UPI Reserve Pay guidelines](https://www.npci.org.in/uploads/UPI_Reserve_Pay_Guidlines_b4cb359cbc.pdf).

This means Razorpay has not merely placed a checkout page inside Claude. It has demonstrated **delegated, bounded repeat payment to already-integrated enterprise merchants**.

### What is publicly available to ordinary developers

Razorpay’s general MCP server is public and production-supported. It exposes 35+ merchant-operation tools for orders, payment links, payments, refunds, QR codes, settlements and payouts, and can connect to Claude, ChatGPT and other MCP clients. [MCP overview](https://razorpay.com/docs/mcp-server/), [tools reference](https://razorpay.com/docs/mcp-server/tools-reference/) and [integration guide](https://razorpay.com/docs/mcp-server/integrations/).

That MCP surface should not be confused with a public SDK for reproducing the Zomato/Claude buyer experience. The public MCP documentation is mainly an authenticated **merchant-operations interface**. The consumer commerce pilots and Reserve Pay activation have separate, gated onboarding.

## What Cashfree offers

### Cashfree Agentic Payments

Cashfree’s October 2025 announcement describes a merchant MCP handing the conversation to Cashfree’s Payments MCP when the customer is ready to pay. It mentions UPI Reserve Pay, device-tokenized cards and biometric authentication, with the goal of avoiding redirects and pop-ups. The announcement presents an end-to-end product but does not itself provide the self-serve technical contract of that enterprise agent-to-agent flow. [Cashfree Agentic Payments announcement](https://www.cashfree.com/news-room/cashfree-payments-becomes-one-of-the-first-fintechs-in-india-to-unveil-agentic-payments-bringing-end-to-end-ai-commerce-inside-chat/).

### Cashfree HERE

Cashfree HERE, announced in February 2026 with Mastercard and Swiggy, is the stronger public developer proposition for **inline payment UI**. It is an MCP Apps payment extension that renders the payment interface directly inside ChatGPT, Claude or another compatible host. Sensitive payment details are kept outside the model. [Cashfree HERE announcement](https://www.cashfree.com/news-room/cashfree-payments-unveils-india%E2%80%99s-first-payments-extension-for-ai-apps-launches-cashfree-here-in-collaboration-with-mastercard-and-swiggy-at-india-ai-impact-summit-2026/).

The public documentation shows that a merchant can install `@cashfreepayments/cashfree-here`, register its widget and payment tools, and select sandbox or production. Currently documented payment methods are UPI Intent, UPI QR, cards and net banking. ReservePay and Cashfree Pay are marked coming soon. [Cashfree HERE developer documentation](https://www.cashfree.com/docs/tools-ai/cashfree-here).

Cashfree also publishes an MCP server and framework toolkits for programmatic payment operations. [Cashfree MCP server](https://www.cashfree.com/docs/tools-ai/mcp-server) and [Cashfree Agent Toolkit](https://www.cashfree.com/docs/tools-ai/cashfree-agent-toolkit).

### Is Cashfree’s version “better”?

It depends on the target problem:

| Question | Razorpay pilot | Cashfree HERE public integration |
|---|---|---|
| Keeps the user inside chat | Yes | Yes |
| Public reusable payment widget | Not shown in the cited public buyer-pilot docs | Yes |
| Current documented payment choices | UPI Reserve Pay in the pilot; Razorpay’s broader stack also supports cards and other rails | UPI Intent/QR, cards, net banking |
| Delegated repeat purchases without a PIN each time | Demonstrated through a pre-approved Reserve Pay limit | ReservePay is marked coming soon in HERE docs |
| Human action at payment time | One confirmation in the announced Claude flow, after reserve authorization | User interacts with the embedded payment widget |
| Availability | Closed/small-user pilot; product sign-up/beta | Public docs/package; merchant account and credentials required |

So Cashfree HERE is better today if “better” means **the clearest public SDK for embedding a polished checkout widget in chat**. Razorpay’s pilot is more ambitious if “better” means **bounded delegated spending by an AI against a pre-authorized reserve**. They overlap, but they are not identical products.

## What Track 01 is asking for despite those products

The Buildathon wording explicitly acknowledges that Razorpay’s in-app pilots already exist. It asks for either merchant revenue growth on Razorpay test-mode APIs or an end-to-end AI-buyer transaction. It names agent-readable catalogs, conversational checkout, upsell/cross-sell and campaign orchestration, while requiring every money action to be explainable, bounded and gated, with an audit trail and a gracefully handled failure. [Official Razorpay Buildathon brief](https://razorpay.com/buildathon/).

### Inference from the brief and product status

Razorpay is likely testing whether applicants can build useful product layers **above and around its payment rails**, not whether they can duplicate an already announced payment button. The protocol references in the brief suggest that merchant interoperability and trustworthy orchestration are still open design spaces.

The concrete whitespace is:

1. **Long-tail merchant readiness.** The public pilots feature large merchants with custom integrations. There is no cited general self-serve product that converts an ordinary merchant’s catalog, inventory, pricing, policies and fulfillment operations into a reliable AI storefront.
2. **Protocol-neutral intent enforcement.** A buyer request may arrive in different mandate or commerce formats. A merchant needs one deterministic policy layer that validates amount, merchant, products, expiry, price changes and approval requirements before Razorpay execution.
3. **Binding intent to execution.** A signed or hashed cart/quote snapshot can prove that the approved price, quantity, refund terms and recipient are the same ones sent to the payment rail.
4. **Complete lifecycle reliability.** Payment is only one step. Inventory reservation, idempotency, duplicate webhook handling, partial fulfillment, capture, cancellation and refunds must remain consistent.
5. **Observable trust.** Merchants and users need a human-readable evidence chain, not raw logs: request, recommendation, mandate, policy decision, Razorpay order/payment, fulfillment and refund.
6. **Evaluation and certification.** A merchant endpoint should be tested against replay, duplicate charge, price mutation, expired consent, prompt injection, unavailable inventory and failed fulfillment before it is labeled “agent-ready.”

## Recommended differentiated Buildathon direction

Do **not** build “order food in a chatbot” or “put Razorpay Checkout in an MCP widget.” Both are too close to announced products, and Cashfree already packages the latter publicly.

Build an **Agent-Ready Merchant Gateway and Certification Layer for Razorpay**:

> Connect an ordinary merchant, generate an agent-readable catalog and transaction endpoint, enforce a portable purchase policy, bind the approved cart to the Razorpay order, coordinate fulfillment/capture/refund, and certify the integration against adversarial and failure scenarios.

The strongest demo would show the same small merchant being purchased from by two differently structured buyer agents, followed by three memorable failures:

- a changed price after approval is blocked;
- a repeated tool call does not create a second charge;
- failed fulfillment triggers the correct cancellation/refund path.

The UI should make the intent-to-receipt evidence chain the centerpiece and show a readiness score based on a batch of test scenarios. Razorpay remains central throughout: test-mode Orders/Checkout, signature verification, webhooks, refunds and stored Razorpay identifiers. Reserve Pay authorization semantics can be modeled honestly if the account is not enabled; it should not be presented as a live integration without access.

This approach complements Razorpay’s pilots rather than cloning them. Its USP is not “payments inside chat”; it is **making many ordinary merchants safely interoperable with many AI buyers, with evidence that the transaction cannot drift from the user’s authorization**.
