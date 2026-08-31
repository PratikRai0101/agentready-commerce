# Competitive positioning

## Existing landscape

### Razorpay Agentic Payments pilots

Razorpay has demonstrated in-conversation purchasing with selected large merchants, including Zomato, Swiggy and Zepto through Claude, using UPI Reserve Pay authorization. The public announcement describes a limited pilot rather than a self-service buyer-commerce SDK for ordinary merchants.

### Razorpay MCP server

Razorpay's public MCP surface provides many authenticated merchant-operation tools for Orders, Payments, Payment Links, Refunds, QR codes, Settlements and Payouts. It helps a merchant operate Razorpay through AI; it is not the same as exposing the merchant's catalog and fulfilment lifecycle to arbitrary buyer agents.

### Cashfree HERE

Cashfree publicly packages an MCP Apps payment widget for UPI, cards and net banking inside compatible AI conversations. This is a strong developer-facing checkout component. A payment widget alone does not bind a customer's product intent through final fulfilment.

### x402/Solana

x402 is a machine-native HTTP payment protocol well suited to paid APIs, content and agent services. Solana provides a fast, low-cost settlement rail. Core x402 does not supply retail catalog semantics, user budgets, inventory, delivery, returns or consumer disputes.

### Razorpay Vulcan

Vulcan is Razorpay's proprietary payments foundation model for routing, fraud/risk, RTO intelligence and checkout personalization. It is not a general-purpose LLM, and no public developer endpoint has been identified.

## AgentReady's position

| Product | Primary strength | AgentReady's distinct layer |
|---|---|---|
| Razorpay Claude pilot | Selected-partner agentic purchase | Reusable merchant orchestration and authorization continuity |
| Razorpay MCP | Merchant/back-office actions | Buyer-facing product, quote and fulfilment lifecycle |
| Cashfree HERE | In-chat payment UI | Intent-to-charge-to-fulfilment integrity |
| x402 | Machine-native settlement | Retail policy/lifecycle plus cross-rail evidence |
| Vulcan | Payment execution intelligence | Agent authority, exact cart binding and integration conformance |
| Typical hackathon chatbot | Happy-path recommendation and checkout | Grounded clarification, deterministic money control and negative-path proof |

## Defensible USP

> One approved commerce intent, multiple possible payment rails, exactly one successful charge, and one inspectable evidence chain.

Supporting differentiators:

1. Merchant-specific recommendation rather than marketplace-scale hand-waving.
2. Hard/soft preference separation and clarification before purchase.
3. Exact Commerce Envelope binding approval to SKU, variant, price and terms.
4. Razorpay-first physical-goods execution.
5. Purposeful x402/Solana machine payment rather than blockchain decoration.
6. Runtime guardrails plus executable conformance evidence.
7. Truthful Vulcan positioning with a future integration seam.

## Why not Open Track

The product directly satisfies AI Growth & Agentic Commerce. Open Track provides no lower execution bar and weakens immediate alignment with Razorpay's stated product direction.
