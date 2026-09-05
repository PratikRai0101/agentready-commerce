# AgentReady Commerce

A merchant-specific AI sales agent that turns ambiguous intent into a justified product choice, binds approval to the exact commercial terms, and completes a safe transaction through Razorpay — with an x402/Solana rail for machine-purchased resources.

Built for the Razorpay Buildathon, Track 01 (AI Growth & Agentic Commerce). Full product rationale in [`docs/`](docs/product-spec.md) (spec, architecture, decisions, demo script, implementation plan).

## Demo

- **Public demo (mock-only):** `https://agentready-commerce-pied.vercel.app` (`/demo` for Demo Lab).
  The public host runs `razorpay: mock`, `x402: mock`, `llm: disabled` with
  `X402_SETTLEMENT_ENABLED=false` and no Razorpay keys, database, keypair, or
  Mainnet configuration. Money steps there create `order_MOCK_*` / `pay_MOCK_*`
  IDs only — no funds move. Verified in
  [`docs/evidence/public-demo-preflight.md`](docs/evidence/public-demo-preflight.md)
  §5 (public-alias smoke: storefront 42/42 + prototype 20/20, zero egress).
- **Recorded evidence (not performed by the public demo):** Razorpay Test Mode
  lifecycle (2026-08-31/09-01) and Solana Devnet settlements (2026-09-02,
  2026-09-04) below. The pitch shows them as screenshots, never as live calls.
- **Submission package:** [`docs/pitch-script.md`](docs/pitch-script.md) (5:00
  script) · [`docs/recording-plan.md`](docs/recording-plan.md) (scenes, exact
  URLs/clicks/narration) · [`docs/demo-runbook.md`](docs/demo-runbook.md)
  (live runbook + prerecorded fallback) ·
  [`docs/architecture-explainer.md`](docs/architecture-explainer.md) ·
  [`docs/claims-evidence-checklist.md`](docs/claims-evidence-checklist.md).

## What it demonstrates

The tracer bullet (fully deterministic, no external service required to demo):

```text
ambiguous request → clarification → ranked shortlist → exact envelope
→ approval (binds SHA-256 hash) → Razorpay order → signature verification
→ PAID_VERIFIED → fulfilment/refund → unified audit timeline
```

Negative paths are first-class demo scenes: price/variant tampering after approval, duplicate requests, replayed webhooks, forged signatures, and paid-but-unfulfillable orders (refund recovery).

### x402/Solana machine rail

The agent can purchase a premium fit-scoring resource through x402/Solana. Two modes:

- **Mock** (`X402_MODE=mock`): Simulated settlements, no funds moved. Clearly labelled everywhere as "x402 MOCK — no funds moved."
- **Devnet** (`X402_MODE=devnet`): Real Solana Devnet USDC transactions via the official x402 facilitator. Clearly labelled everywhere as "x402 SOLANA DEVNET — test tokens, no real money."

One real Devnet settlement was executed through the application path and is
documented in [`docs/devnet-settlement-evidence-app-path-2026-09-04.md`](docs/devnet-settlement-evidence-app-path-2026-09-04.md).
It used test tokens only; no replacement transaction was submitted. The live
test remains gated behind `X402_LIVE_DEVNET_TEST=1` and valid credentials. See
"Devnet setup" below.

## Run it

Prerequisites: Node 20+, pnpm.

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local   # optional; everything runs in mock mode without it
pnpm dev                    # http://localhost:3000
```

```bash
pnpm test                   # unit, adversarial, integration, conformance tests
pnpm typecheck
```

To use real Razorpay **Test Mode**, add `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` (test keys starting
with `rzp_test_`) to `apps/web/.env.local` (dashboard.razorpay.com → Settings → API Keys). The
storefront header then shows a "Razorpay TEST MODE" badge. Without credentials, the app uses the
clearly-labelled `MockRazorpayAdapter` (same signature scheme, same code path).

`.env.local` and all `*.env.*.local` files are gitignored — credentials never reach the repository.
The web app reads environment files from `apps/web/` (Next.js convention); there is no root `.env`
loading.

## Devnet setup

Follow the [read-only preflight and approval-gated runbook](docs/devnet-preflight.md).
Do not create or fund a wallet, set up a live payer, or run the live integration
test until explicit owner approval is given. The live test is skipped by
default; it requires `X402_LIVE_DEVNET_TEST=1`, `X402_MODE=devnet`, a payer
keypair path, a payee public address, and an RPC URL.

**Pinned dependencies for reproducible demo builds:**
- `@x402/core@2.24.0`, `@x402/svm@2.24.0`
- `@solana/kit@5.5.1`
- `@noble/curves@2.4.0`, `@scure/base@2.4.0`

## Repo layout

```text
apps/web              Next.js storefront: conversation, shortlist, approval card,
                      Razorpay Checkout, audit timeline, failure theatre, conformance
packages/domain       PurchaseIntent/Mandate, Commerce Envelope, canonicalization,
                      SHA-256 hashing, HMAC signing, order state machine, policy engine
packages/catalog      Seeded RunVista running-shoe catalog, deterministic filtering/ranking
packages/payments     PaymentAdapter interface, Razorpay adapter (Orders/verify/refund),
                      Mock adapter, x402 v2 protocol helpers, DevnetMachineResource
packages/audit        Event ledger and timeline projection
packages/conformance  10 critical invariants (gate suite) over a plane contract
```

## Architecture

Concise explainer: [`docs/architecture-explainer.md`](docs/architecture-explainer.md).
Full contract: [`docs/architecture.md`](docs/architecture.md).

```text
Customer / buyer agent
        │
        ▼
Conversation and recommendation layer (deterministic intent + optional LLM prose)
        │ structured intent + ranked products
        ▼
Commerce control plane
  ├─ Quote and inventory service
  ├─ Commerce Envelope service (SHA-256, HMAC-signed)
  ├─ Deterministic policy engine
  ├─ Idempotency coordinator
  └─ Audit ledger
        │ choose exactly one rail for the retail order
        ▼
Razorpay adapter (INR retail checkout)
        │  ·  x402/Solana (machine resource spend, separate mandate)
        ▼
Fulfilment/refund state machine → unified audit timeline
```

Approval binds to the SHA-256 hash of the exact Commerce Envelope; any
material change (SKU, variant, quantity, amounts, currency, recipient,
delivery, returns, mandate, expiry) requires reapproval before payment. One
logical retail order may have at most one successful rail.

## Verified Razorpay Test Mode evidence (recorded 2026-08-31/09-01)

Real Test Mode checkouts plus dashboard-configured `payment.captured`
webhooks (raw-body HMAC, `x-razorpay-event-id` dedup,
order/amount/currency/captured binding). Safe identifiers only; full record in
[`docs/evidence/razorpay-test-proof.md`](docs/evidence/razorpay-test-proof.md):

| Transaction | Order / payment / webhook | Result |
|---|---|---|
| 1 — client-verified | `order_TWTuHSmXrkHoUJ` / `pay_TWU2Fy64pOAaZi` | ₹3848.00 INR captured → `PAID_VERIFIED` |
| 2 — webhook-verified | `order_TWVIgwsRyjV7C8` / `pay_TWVJ9xLsjtdwoo` / event `TWVJJZ01UBcNy1` | HTTP 200 accepted → `PAID_VERIFIED` |
| 3 — webhook + refund | `order_TWVLQtCV7OXCmI` / `pay_TWVLknN4NRrHSN` / event `TWVLtSP9a4RfZ4` | ₹4348.00 captured, fulfilment failure, refund `rfnd_TWVNeD4HStaNby` `processed` → `REFUNDED` |

Duplicate webhook replays are deduplicated; unsupported events return HTTP 200
`ignored`. Test Mode credentials stay in gitignored `apps/web/.env.local` and
never reach the repository or the public demo.

## Verified x402 Devnet evidence (recorded, test tokens only)

x402 v2 `exact`, Solana Devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`),
Devnet USDC (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`), 0.010000 USDC
per settlement, memo `agentcart:v1:{requestDigest}`, full envelope off-chain.
No real money, no Mainnet activity, no second submission per run:

- **Application path (2026-09-04):**
  [`docs/devnet-settlement-evidence-app-path-2026-09-04.md`](docs/devnet-settlement-evidence-app-path-2026-09-04.md) —
  session `ord_ec64c3682612`, payment `pay_appath_1788535423482`, tx
  [`5FQb8Jh7…`](https://explorer.solana.com/tx/5FQb8Jh7LTmwoecXpv7TGDos61oFqo66T74uYY6mA6cWuD2EaHTQ73FsY2EZ99Wsj7j3SknsT4WE8vDmGxtt1Vfk?cluster=devnet)
  (slot `493082743`, finalized, `meta.err` null), reconciled via
  `operator-cli reconcile-settled` with zero replacement submissions.
- **Harness settlement (2026-09-02):**
  [`docs/devnet-settlement-evidence.md`](docs/devnet-settlement-evidence.md) —
  tx
  [`9Z795iRrqkymKipM3XTY7q3gY7FZ2qvUFQKisnewPmhKH3opqzyVq2gmyPxrrJ8ez2KxSDHdXvJ8qeqkKKZi4JM`](https://explorer.solana.com/tx/9Z795iRrqkymKipM3XTY7q3gY7FZ2qvUFQKisnewPmhKH3opqzyVq2gmyPxrrJ8ez2KxSDHdXvJ8qeqkKKZi4JM?cluster=devnet)
  (slot `492017649`, finalized). Replay coverage remains offline-only; the
  application never resubmits a settled payment identifier.

The x402 spend buys the premium fit-scoring resource under a separate
tool-spend mandate — it is not a second charge for the shoes, and a retail
refund is always the Razorpay refund, never an x402 “reversal”.

## Safety controls

- Deterministic policy gates every money step (mandate, merchant, SKU, amount,
  expiry, approval hash); the LLM is advisory only.
- Fulfilment begins only after rail-specific verification (Razorpay signature +
  order/amount/currency/captured binding; x402 finalized settlement check).
- Idempotent order creation, approval, refunds, and webhook handling
  (`x-razorpay-event-id` dedup, Stable Payment Identifier on x402); one
  logical order → at most one successful rail.
- Kill-switches default safe: `X402_MODE=mock`, `X402_SETTLEMENT_ENABLED=false`,
  `X402_LIVE_DEVNET_TEST=0` on the public host; live Devnet runs stay
  approval-gated per [`docs/devnet-preflight.md`](docs/devnet-preflight.md).
- Secrets hygiene: `.env.local` / `data/proof/` / keypairs gitignored; logs and
  audit events carry safe IDs only — never keys, signatures, raw payloads,
  card/contact data, or chain private material. On-chain memos carry only the
  request digest.

## Honest claims

- Approval binds to the exact envelope hash; any material change requires reapproval.
- The LLM (when configured) only interprets and explains. Money movement is gated by deterministic policy code.
- One logical retail order may have one successful rail only.
- x402 is used for agent tool spend on a digital resource (premium fit-scoring API), memo-anchored to the request digest. Mock settlements are clearly labelled; no synthetic data is presented as live.
- Devnet settlements are labelled "x402 SOLANA DEVNET — test tokens, no real money" and include verified on-chain memo evidence where available.
- The conformance suite verifies *our declared invariants*; it is not an independent certification of Razorpay, Solana, x402 or any third party.
- Vulcan is not integrated and no public integration interface was used; no mock output is labelled as Vulcan. A neutral seam is documented in `docs/architecture.md`. Future alignment only: “Vulcan can make payment intelligence smarter; RunVista makes the agent executing payment decisions bounded, explainable and auditable.”
- UPI is a payment method within Razorpay Checkout; UPI Reserve Pay is a conditional agentic authorization mode, out of scope without official access.

## Known limitations

- Public demo is mock-only and in-memory per instance: no real Razorpay/Test Mode
  or Devnet execution, and a horizontally scaled host may rarely show an
  unknown-session error (reload; see
  [`docs/evidence/public-demo-preflight.md`](docs/evidence/public-demo-preflight.md)).
- Catalog is synthetic demo data for the fictional RunVista Sports merchant
  (6 products); no real inventory, delivery, or customer profile.
- x402 replay of a live settlement through the app path is covered offline-only;
  the two Devnet settlements are single-run recorded evidence each.
- LLM cost figures beyond the theoretical $0.0022 ceiling in
  [`docs/evidence/llm-verification-3msg.md`](docs/evidence/llm-verification-3msg.md)
  require the provider console; exact per-call tokens were unavailable for that run.
- Repository visibility is currently private; the public artifact is the Vercel
  demo alias until the owner flips it. Test suites were last measured at
  411 passed / 1 skipped across 20 files (2026-09-04); re-run `pnpm test` and
  `pnpm typecheck` before judging.

## Product thesis

Razorpay can execute agentic payments. The open problem is **authorization continuity** — ensuring the charge and fulfilment still match what the customer actually approved:

```text
vague request → grounded recommendation → exact quote → explicit approval → correct charge → correct fulfilment or refund
```

AgentReady is the merchant-side orchestration and trust layer around that chain. See [`docs/competitive-positioning.md`](docs/competitive-positioning.md) for the full thesis and the scope hierarchy (core demo, differentiators, non-goals).
