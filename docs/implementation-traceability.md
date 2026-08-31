# Implementation traceability

Maps the plan in [`implementation-plan.md`](implementation-plan.md), the
[`product-spec.md`](product-spec.md) requirements and the
[`demo-and-evaluation.md`](demo-and-evaluation.md) conformance matrix to concrete code and
tests. Commit history in this repo follows the same phases.

## Build order compliance (AGENTS.md tracer bullet)

| Step | Where |
|---|---|
| Ambiguous request → clarification | `apps/web/lib/intent.ts` (deterministic parser), `packages/catalog/src/ranking.ts` (`missingHardConstraints`), `apps/web/lib/services.ts` (`respond`) |
| Ranked shortlist | `packages/catalog/src/ranking.ts` (`rankProducts`), refusal to rank without size/use-case |
| Exact envelope | `apps/web/lib/services.ts` (`buildQuote`), `packages/domain/src/types.ts` (`CommerceEnvelope`) |
| Approval bound to hash | `packages/domain/src/canonical.ts` (canonicalize/SHA-256/HMAC), `apps/web/lib/services.ts` (`approve`) |
| Razorpay payment | `packages/payments/src/razorpay.ts` + `mock-razorpay.ts`, `apps/web/app/api/pay/*` |
| Signature verification + rail binding | `apps/web/lib/services.ts` (`verifyPayment`: order/amount/currency/captured), tests in `apps/web/test/razorpay-binding.test.ts` |
| Audit timeline | `packages/audit/src/ledger.ts`, `apps/web/app/api/audit/route.ts`, UI sidebar |
| Tamper rejection | `apps/web/lib/services.ts` (`tamper`), `packages/domain/src/policy.ts` (`materialChanges`/`requiresReapproval`), `apps/web/app/api/tamper/route.ts` |

## Implementation plan phases

| Phase | Status | Where |
|---|---|---|
| 0 — decisions/access | Partially (Test Mode credentials present locally; devnet wallet pending) | `apps/web/.env.example`, `apps/web/.env.local` (gitignored), `docs/open-questions.md` |
| 1 — vertical skeleton | Done | catalog + intent + ranking + storefront UI |
| 2 — envelope + policy | Done | `packages/domain`, `approve`/`tamper` routes |
| 3 — Razorpay end to end | **Done — real Test Mode checkout, authenticated webhook, processed refund** (see [Razorpay Test Mode proof](#razorpay-test-mode-proof)) | `packages/payments`, `pay/*`, `webhook/*` routes |
| 4 — failure theatre | Done | UI panel + `tamper`/`fulfil`/`compensate`/`webhook/simulate` routes |
| 5 — x402/Solana | Protocol done; settlement mock | `packages/payments/src/x402.ts`, `apps/web/lib/machine.ts`, `machine.paid_resource` audit event |
| 6 — conformance | 15 critical gates | `packages/conformance/src/checks.ts`, `apps/web/app/api/conformance/route.ts` |
| 7 — polish | Partially (no video/credentials) | reset + scenario endpoints, indicators, this document |

## Product-spec functional requirements

| Requirement | Where |
|---|---|
| Hard vs soft constraints; clarification (5.1) | `packages/catalog/src/ranking.ts`; LLM can only add soft prefs (`apps/web/lib/llm.ts` sanitizer) |
| Never invent catalog data (5.1) | ranking uses only `SHOE_CATALOG` fields; `packages/catalog/test/ranking.test.ts` |
| Deterministic authority, LLM advisory (5.2) | `packages/domain/src/policy.ts`; `llm_advisory_only` reason code; `apps/web/test/llm.test.ts` |
| Approval binds envelope hash (5.2) | `packages/domain/src/canonical.ts`; `approve` rejects digest mismatch |
| Reapproval on material change (5.2) | `materialChanges`; `REAPPROVAL_REQUIRED` state; UI + tamper route |
| One rail per logical order (5.3) | state guard in `initiatePayment`; `rail_single_success`; `packages/domain/src/types.ts` transitions |
| Razorpay signature verification (5.4) | `packages/payments/src/razorpay.ts` + raw-body webhook verify in `apps/web/lib/webhook.ts` |
| Webhook dedup + out-of-order (5.4) | `x-razorpay-event-id` dedup, hold/reconcile in `webhook.ts` + `services.ts`; `apps/web/test/razorpay-binding.test.ts` |
| Idempotent order creation/retry (5.4) | `initiatePayment` idempotent attempt; `approve` idempotent |
| Refund/compensation explicit (5.4) | `FULFILMENT_FAILED → COMPENSATION_PENDING → REFUNDED`; `compensate` route |
| x402 compensating transfer ≠ reversal (5.4) | `compensation.refunded` audit on Razorpay rail; x402 spends are tool-spend, never refunds |

## Demo-and-evaluation conformance matrix

| Scenario | Result | Coverage |
|---|---|---|
| Valid mandate + unchanged envelope | Payment allowed | `packages/domain/test/policy.test.ts`, `apps/web/test/services.test.ts` |
| Missing required preference | Clarification, not purchase | `packages/catalog/test/ranking.test.ts` |
| Amount exceeds maximum | Block / review | `policy.test.ts` (`mandate_amount_exceeded`) |
| Price changes after approval | Reapproval required | `services.test.ts`, `tamper` route |
| Variant changes after approval | Reapproval required | `services.test.ts`, `tamper` route |
| Envelope expires | Payment blocked | conformance `gate_09` |
| Duplicate logical order call | No second charge | `initiatePayment` idempotency; `services.test.ts` |
| Invalid Razorpay signature | Fulfilment blocked | `services.test.ts`, conformance `gate_05` |
| Wrong order / amount / currency / not-captured | Binding rejected | conformance `gate_11`–`gate_14`, `apps/web/test/razorpay-binding.test.ts` |
| Duplicate webhook | One transition | conformance `gate_10`, `razorpay-binding.test.ts` |
| Modified raw webhook body | Signature rejection | `razorpay-binding.test.ts` |
| Webhook before client verification | Reconcile safely | conformance `gate_15`, `razorpay-binding.test.ts` |
| Paid but inventory unavailable | Compensation/refund | conformance `gate_06`, `services.test.ts` |
| Product description contains instructions | Untrusted data | `llm.test.ts` (structured prompts only, no descriptions); policy never reads prose |
| x402 underpayment/wrong recipient | Settlement rejected | conformance `gate_07` |
| x402 retry same identifier | No repeat spend | conformance `gate_08`, `apps/web/test/machine.test.ts` |

## Honesty boundaries

- Mock adapters are explicit: `MockRazorpayAdapter.isMock`, `mock: "true"` on x402 audit events, UI badges.
- **Razorpay Test Mode is verified end-to-end** (checkout, authenticated webhook, processed refund); Live Mode is not claimed — see [Razorpay Test Mode proof](#razorpay-test-mode-proof) and `docs/evidence/razorpay-test-proof.md`.
- Test Mode credentials live only in gitignored `apps/web/.env.local`; the UI badge shows "TEST MODE", never "live", for `rzp_test_` keys.
- Webhook secrets are rotated, never logged; structured webhook logs emit only event type, event ID, safe order/payment IDs, HTTP status and reason code.
- Conformance suite verifies declared invariants only — no third-party certification claims.

## Razorpay Test Mode proof

Completed against the real Razorpay Test Mode API with dashboard-configured
`payment.captured` webhooks (raw-body HMAC verification, `x-razorpay-event-id`
dedup, order/amount/currency/captured binding, out-of-order hold/reconcile):

| Transaction | Order | Payment | Webhook event | Result |
|---|---|---|---|---|
| 1 — client-verified | `order_TWTuHSmXrkHoUJ` | `pay_TWU2Fy64pOAaZi` | — | ₹3848.00 INR captured; `payment.verified` |
| 2 — webhook-verified | `order_TWVIgwsRyjV7C8` | `pay_TWVJ9xLsjtdwoo` | `TWVJJZ01UBcNy1` | ₹3548.00 INR; webhook HTTP 200 `accepted`; `payment.verified_via_webhook` |
| 3 — webhook + refund | `order_TWVLQtCV7OXCmI` | `pay_TWVLknN4NRrHSN` | `TWVLtSP9a4RfZ4` | ₹4348.00 INR captured; fulfilment failure; refund `rfnd_TWVNeD4HStaNby` `processed`; state REFUNDED |

Safe identifiers only; see `docs/evidence/razorpay-test-proof.md` for the
judge-facing summary and `data/proof/razorpay-test-proof.md` (gitignored) for
the detailed local record. Test date: 2026-08-31/2026-09-01 (local proof files).

## Definition-of-done status

| Item | Status |
|---|---|
| Public repository | **Pending** — repo intentionally private until the owner decides |
| Reproducible local setup | Done (`pnpm install && pnpm dev`) |
| `.env.example` with no secrets | Done (`apps/web/.env.example`; local values only in gitignored `.env.local`) |
| Architecture diagram | `docs/architecture.md` + README |
| Meaningful tests and final results | 106 tests, 15/15 conformance gates |
| Razorpay test-mode proof | **Done** — real Test Mode checkout ×3, authenticated `payment.captured` webhook ×2, processed refund ×1 (`docs/implementation-traceability.md` § Razorpay Test Mode proof, `docs/evidence/razorpay-test-proof.md`) |
| Five-minute pitch video | **Pending** |
| Disclosure of mocks/synthetic data | Done (badges, audit `mock` flags, README) |