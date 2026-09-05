# Claims-and-evidence checklist

> Rule: every pitch/narration statement maps to one row below. “Supported”
> means a reviewer can open the cited file/URL and see it. Anything without a
> row must not be said on camera. The public demo is mock-only; Test Mode and
> Devnet are recorded evidence, not public-demo actions.

## How to read this

- **Claim** — exact wording (or the strongest version) used in the pitch.
- **Evidence** — committed file, route, or public URL showing it.
- **Status** — Supported / Scoped (true only under stated limits).

## Story coverage

| # | Claim | Evidence | Status |
|---|---|---|---|
| 1 | Agent-readable discovery exists; buyer agents start at machine endpoints | `GET /.well-known/agentready` (200, `protocolConformance: None claimed`), `GET /api/catalog` (200, 6 products); `apps/web/lib/discovery.ts`, `apps/web/lib/catalog-public.ts`; `apps/web/test/mock-buyer-client.test.ts` | Supported |
| 2 | Ambiguous “black shoes under ₹5,000” triggers clarification, not purchase | `packages/catalog/src/ranking.ts` (`missingHardConstraints`), `apps/web/lib/services.ts` (`respond`); `docs/demo-and-evaluation.md` prepared scenario | Supported |
| 3 | Ranking is grounded: Max Cushion ₹4,899 best overall / Streak 4 ₹4,299 cheaper / Stride Lite ₹3,499 trade-off, catalog-verbatim with compromises | `packages/catalog/src/catalog.ts` prices; `packages/catalog/src/ranking.ts`; `docs/evidence/llm-verification-3msg.md` shortlist table | Supported |
| 4 | Approval binds to the exact SHA-256 envelope hash; material change requires reapproval | `packages/domain/src/canonical.ts`, `packages/domain/src/policy.ts` (`materialChanges`/`requiresReapproval`), `apps/web/lib/services.ts` (`approve`/`tamper`); UI “Approve exact envelope hash” | Supported |
| 5 | The LLM only interprets/explains; deterministic policy moves money | `packages/domain/src/policy.ts`, `apps/web/lib/llm.ts` sanitizer, `llm_advisory_only` reason code; `apps/web/test/llm.test.ts` | Supported |
| 6 | One logical order → at most one successful rail | `initiatePayment` state guard, `rail_single_success`; `packages/domain/src/types.ts`; conformance `gate_04`-class + `apps/web/test/services.test.ts` | Supported |
| 7 | Public demo is mock-only; no funds move there | `https://agentready-commerce-pied.vercel.app/api/status` → mock/mock/disabled; `docs/evidence/public-demo-preflight.md` §5 (42/42 + 20/20 public smoke, `order_MOCK_*`/`pay_MOCK_*`, zero egress) | Supported |
| 8 | Razorpay Test Mode lifecycle verified: 3 checkouts, 2 authenticated webhooks, 1 processed refund, `PAID_VERIFIED` before fulfilment | `docs/evidence/razorpay-test-proof.md`: `order_TWTuHSmXrkHoUJ`/`pay_TWU2Fy64pOAaZi` ₹3848; `order_TWVIgwsRyjV7C8`/`pay_TWVJ9xLsjtdwoo` webhook `TWVJJZ01UBcNy1`; `order_TWVLQtCV7OXCmI`/`pay_TWVLknN4NRrHSN` webhook `TWVLtSP9a4RfZ4` + `rfnd_TWVNeD4HStaNby` processed → `REFUNDED`; 2026-08-31/09-01 | Supported (recorded evidence) |
| 9 | x402 settled on Devnet (0.01 USDC, v2 exact, memo-bound) and is not a second shoe charge | `docs/devnet-settlement-evidence-app-path-2026-09-04.md`: sig `5FQb8Jh7LTmwoecXpv7TGDos61oFqo66T74uYY6mA6cWuD2EaHTQ73FsY2EZ99Wsj7j3SknsT4WE8vDmGxtt1Vfk`, slot `493082743`, finalized, `meta.err` null, mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, payer `4aCDfCtWrrVA74n8z8XDeKSHq2ddD95E68SHno5Y4Ap5`, payee `FF6Uj3ff6tp9smbCqfvJyBTrmef8ketsm3x8v1QPTrZ1`, memo `agentcart:v1:6826a0b9…`, balances ±0.01; explorer `…/tx/5FQb8Jh7…?cluster=devnet` | Supported (recorded 2026-09-04) |
| 10 | Second Devnet settlement (harness) + recovery semantics: exactly one transfer, replay offline-only | `docs/devnet-settlement-evidence.md`: sig `9Z795iRrqkymKipM3XTY7q3gY7FZ2qvUFQKisnewPmhKH3opqzyVq2gmyPxrrJ8ez2KxSDHdXvJ8qeqkKKZi4JM`, slot `492017649`, same mint/payer/payee/amount, memo `agentcart:v1:fbbb0958…`; “replay remains offline-only”, no second submission | Supported (recorded 2026-09-02) |
| 11 | Graceful failure: price/variant change after approval → `REAPPROVAL_REQUIRED`, stale approval + payment blocked with named fields | `POST /api/tamper`, `GET /api/scenario` (budget ₹3,000 invalidation, stale-digest rejection); `apps/web/app/demo/page.tsx` “Price change after approval” / “Variant change” | Supported |
| 12 | Duplicate/replay safety: webhook dedup by event ID, no second charge | `apps/web/lib/webhook.ts` + `services.ts` (`x-razorpay-event-id` dedup, hold/reconcile); `POST /api/webhook/simulate`; conformance `gate_10`, `gate_15`; `apps/web/test/razorpay-binding.test.ts` | Supported |
| 13 | Paid-but-unfulfillable → explicit `REFUNDED` via rail-specific compensation (Razorpay refund; x402 compensating transfer never called a reversal) | `POST /api/fulfil {fail:true}` → `POST /api/compensate`; Test Mode `rfnd_TWVNeD4HStaNby` processed; `docs/product-spec.md` §5.4 | Supported |
| 14 | Full audit timeline intent → receipt with external IDs and decisions | `packages/audit/src/ledger.ts`, `GET /api/audit`, “Order & trust” drawer; `docs/evidence/razorpay-test-proof.md` state chain | Supported |
| 15 | Conformance verifies declared invariants (15 gates), not a security certification | `packages/conformance/src/checks.ts` (`gate_01`–`gate_15`), `GET /api/conformance`; `docs/decisions.md` D-010 | Supported |

## Explicit non-claims (must survive on camera)

| # | We do NOT claim | Correct line |
|---|---|---|
| N1 | “Objectively best shoe” / marketplace ranking | Ranked shortlist with trade-offs over a 6-product synthetic catalog only |
| N2 | Blockchain proves delivery | Devnet proves a 0.01-USDC tool-spend settlement; fulfilment is a separate app state |
| N3 | Razorpay signs cart line items | Razorpay signature authenticates order–payment; the app evidence chain binds order → envelope |
| N4 | x402 budgets/refunds/disputes | x402 is tool-spend under a separate mandate; retail refunds are Razorpay refunds |
| N5 | Vulcan integration / “Powered by Vulcan” | “Vulcan can make payment intelligence smarter; RunVista makes the agent executing payment decisions bounded, explainable and auditable.” Not integrated; no public integration interface was used; no mock labelled as Vulcan |
| N6 | UPI Reserve Pay live | UPI is a method inside Razorpay Checkout; Reserve Pay is conditional agentic mode, out of scope without access |
| N7 | Security certification / Live Mode | Conformance = declared invariants; Razorpay evidence is Test Mode only; Devnet = test tokens, no real money, no Mainnet |
| N8 | Public demo performs Test Mode/Devnet | Public demo is mock-only; Test Mode (2026-08-31/09-01) and Devnet (2026-09-02, 2026-09-04) are recorded evidence |

## Freshness + hygiene gates (re-check before recording/submission)

- [ ] `/`, `/demo`, `/api/status`, `/api/catalog`, `/.well-known/agentready` return 200 on `https://agentready-commerce-pied.vercel.app` in mock posture.
- [ ] No frame shows secrets: keys, webhook secrets, signatures, raw payloads, card/contact data, keypairs, seed phrases, `.env.local`, `data/proof/`, signed payment bytes.
- [ ] No `order_`/`pay_`/`rfnd_` ID outside the mock set + §8 Test Mode set appears.
- [ ] Devnet stills carry `?cluster=devnet` URLs and “recorded evidence” captions; amounts read “test tokens, no real money”.
- [ ] Repo is currently private (`gh repo view` → `isPrivate: true`); do not claim a public repository. Public artifact is the Vercel alias only.
- [ ] Test counts are cited as last measured (411 passed / 1 skipped, 20 files, 2026-09-04 per `docs/submission-readiness.md`) unless CI on this PR re-measures them.
