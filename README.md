# AgentReady Commerce

A merchant-specific AI sales agent that turns ambiguous intent into a justified product choice, binds approval to the exact commercial terms, and completes a safe transaction through Razorpay — with an x402/Solana rail for machine-purchased resources.

Built for the Razorpay Buildathon, Track 01 (AI Growth & Agentic Commerce). Full product rationale in [`docs/`](docs/product-spec.md) (spec, architecture, decisions, demo script, implementation plan).

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

## Honest claims

- Approval binds to the exact envelope hash; any material change requires reapproval.
- The LLM (when configured) only interprets and explains. Money movement is gated by deterministic policy code.
- One logical retail order may have one successful rail only.
- x402 is used for agent tool spend on a digital resource (premium fit-scoring API), memo-anchored to the request digest. Mock settlements are clearly labelled; no synthetic data is presented as live.
- Devnet settlements are labelled "x402 SOLANA DEVNET — test tokens, no real money" and include verified on-chain memo evidence where available.
- The conformance suite verifies *our declared invariants*; it is not an independent certification of Razorpay, Solana, x402 or any third party.
- Vulcan is not claimed — no official interface was available. A neutral seam is documented in `docs/architecture.md`.

## Product thesis

Razorpay can execute agentic payments. The open problem is **authorization continuity** — ensuring the charge and fulfilment still match what the customer actually approved:

```text
vague request → grounded recommendation → exact quote → explicit approval → correct charge → correct fulfilment or refund
```

AgentReady is the merchant-side orchestration and trust layer around that chain. See [`docs/competitive-positioning.md`](docs/competitive-positioning.md) for the full thesis and the scope hierarchy (core demo, differentiators, non-goals).
