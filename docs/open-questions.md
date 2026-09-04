# Open questions and access checklist

Resolve these before implementation decisions harden.

## Razorpay

1. Will Buildathon participants receive Vulcan sandbox/API access?
2. If yes, which real outputs are exposed: risk, route, payment-method recommendation, RTO or offer targeting?
3. Does test mode invoke Vulcan or surface any associated reason codes?
4. Will participants receive UPI Reserve Pay access?
5. Are there restrictions on using Order notes for an envelope digest?
6. Which webhook/tunnelling setup is recommended for the event?
7. Can a project use the official Razorpay MCP server alongside direct APIs?

## Merchant and catalog

1. Will the demo use a fictional catalog or a cooperating merchant?
2. Which attributes are authoritative for recommendation quality?
3. How will inventory reservation and delivery estimates be represented?
4. Will customer profile/history be used, and what consent is required?

## x402/Solana

1. ~~Which paid machine resource materially improves the recommendation?~~ **Resolved:** RunVista Premium Fit-Scoring API (project-owned demo service).
2. ~~Will it be a real third-party resource or a clearly labelled project-owned demo service?~~ **Resolved:** Project-owned demo service at `/api/resources/premium-fit-score`.
3. Which supported Devnet asset and facilitator will be used? **Resolved for testing:** USDC Devnet (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) via `https://x402.org/facilitator`.
4. ~~Which wallet approval experience is reliable for the pitch?~~ **Partially resolved:** one Solana Devnet settlement completed via a separate harness (see `docs/devnet-settlement-evidence.md`); the application Devnet path has never run live. No live transaction without explicit approval.
5. Will the Offer/Receipt and Payment Identifier extensions be used? **Pending** — not blocking the demo.
6. Is the Commerce Envelope digest supported in the chosen SVM memo flow? **Resolved in code, verified offline only:** The memo is `agentcart:v1:{requestDigest}` where `requestDigest` is the SHA-256 of the canonical `ToolSpendRequest`. The recorded live settlement carries the memo on-chain; app-path memo verification is covered by offline tests, not a live app run.

## Product choices

1. Is x402 shown inline in the main purchase journey or as a short interoperability scene?
2. Is the primary customer assistant embedded in the merchant site or exposed to external buyer agents as well? **Resolved as:** first-party chat UI plus a machine-readable catalog (`GET /api/catalog`) and capability descriptor (`GET /.well-known/agentready`, explicitly non-conformant) driving the same gated HTTP APIs; demonstrated by `apps/web/test/mock-buyer-client.test.ts`. No external-agent SLA and no protocol-conformance claim.
3. Which two negative paths will be mandatory in the five-minute pitch?
4. What evidence will justify ranking quality?

## Submission logistics

1. Final deadline and timezone
2. Required repository visibility
3. Allowed external services and credentials
4. Video format and exact duration enforcement
5. Required architecture format
6. Whether judges will run the project locally

## Recommended organizer question

> Will Buildathon participants receive a supported Vulcan sandbox/API or UPI Reserve Pay access? If so, which test-mode endpoints, outputs and usage restrictions should we design around?
