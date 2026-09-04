# UI Integration Plan — Decision Ledger (frozen prototype → real service wiring)

**Status:** Plan for approval. **Do not merge** prototype. Prototype frozen at `docs/frozen/ledger-prototype-v2-frozen-2026-09-03.tsx` (`92b08d29…5abd8`, 1044 lines). Devnet **disabled**, payment-safety fixes **separate**.

## 1. What is frozen vs what is planned

* **Frozen:** `apps/web/app/ledger-prototype/page.tsx` visual language only — two-column desktop hero (340px image beside details), 320px chat, inline alt badges, fixed mobile action bar at viewport bottom (`y 754/844`), small `MOCK` pill banner, `next/image` hero, audit from same mock state, sticky `Review order → Approve this exact order → Approved ✓` + `Review updated order` while rebuilding. No `/api` calls, `Pay` always disabled, timers (`setTimeout 900ms`) only for demo re-ranking.
* **Not frozen / separate:** Payment flow, idempotency, webhook dedup, UPI Reserve, x402 Devnet execution, `REAPPROVAL_REQUIRED`/`EXPIRED` edge handling, Vulcan seams — tracked separately, not in this plan.
* **This plan:** Wire the **frozen visuals** to **existing real contracts** and **real loading/quote states**, removing prototype timers.

## 2. Existing service contracts to reuse (no new APIs)

All contracts already exist in `apps/web/lib/services.ts:132` `AppServices` and `apps/web/app/api/*`:

| Prototype need | Real contract | File |
|---|---|---|
| Ambiguous → clarification → shortlist | `respond(orderId, message, binding?, operationId?) => RespondResult` (`shortlist` includes `matches`, `fitScores`, `machineSpend`, `state`, `parsedIntent`, `RecommendationBinding`) | `lib/services.ts:134`, `app/api/respond/route.ts` |
| Editable constraints (remove/edit chip) | `intentPatch(orderId, patch, expectedIntentVersion) => {ok, state, parsedIntent, intentVersion, matches, recommendationBinding, fitScores}` | `lib/services.ts:159`, `app/api/intent-patch/route.ts` |
| Quote for exact SKU | `buildQuote(orderId, productId, binding) => {envelope, digest, signature, state, ...binding}` | `lib/services.ts:135`, `app/api/quote/route.ts` |
| Approval binding | `approve(orderId, digest) => {ok, approvalEventId, state}` | `lib/services.ts:136`, `app/api/approve/route.ts` |
| Audit from same order state | `timeline(orderId) => AuditEvent[]` (`orderState`, `approvalEventId`, `approvedDigest`) | `lib/services.ts:143`, `app/api/audit/route.ts` |
| Single source of truth | `getSession(orderId).state: OrderState` (`DRAFT→CLARIFYING→QUOTED→AWAITING_APPROVAL→APPROVED→…`) and `getEnvelope(orderId)` | `lib/services.ts:144` |

No new endpoints. Reuse `currentStep(state)` (`app/page.tsx:38`) for progress, `formatINR` already correct (`₹4,899`).

## 3. Real loading / quote states (replace timers)

Prototype `showLoading`/`setTimeout 900ms` is a stand-in. Real integration uses:

* **Per-operation pending flags** derived from `fetch` promises:
  * `isPatching` — `POST /api/intent-patch` pending (chip remove/edit)
  * `isResponding` — `POST /api/respond` pending (chat)
  * `isQuoting` — `POST /api/quote` pending (Select)
  * `isApproving` — `POST /api/approve` pending
* **Derived rebuilding:** `isRebuilding = isPatching || isResponding || isQuoting`
* **Intent version:** `intentVersion` from `services.intentPatch` / `services.respond` response; used for `expectedIntentVersion` to avoid races. UI version `v{intentVersion}` already displayed.
* **Quote existence:** `quote: EnvelopeRecord | null` from `getEnvelope` / `buildQuote` response. `null` → no `Order review` total; `digest` only in `Technical details`.
* **Quote validity:** `session.dialogue.quoteValid && isCurrentRecommendation(session) && sameRecommendationBinding(record.recommendation, binding) && record.intentDigest === intentDigest(intent)` — same check as `services.approve` guard (`lib/services.ts:657`). If invalid → `AWAITING_APPROVAL` reverts to `QUOTED`, audit shows invalidation.
* **OrderState:** `session.state` from `timeline`/`status` polling or SSE. `orderState === "APPROVED"` enables sticky `Approved ✓`, else `AWAITING_APPROVAL`.

No `setTimeout`. All transitions await real `await fetch`.

## 4. Component mapping (frozen visuals → real data)

* **Topbar / banner:** `MOCK · payments disabled` stays (prototype-only). Real `orderState` already shown in banner `v2 · {orderState}`.
* **Chat (320px, sticky top):** Keep `Assistant` collapsed on mobile (`Show conversation`). Wire `Send` → `respond` with `operationId` (idempotency). Show `LoadingIndicator` with real `isResponding` (3-dot `1.8s` pulse), not timer.
* **Recommendation hero + 2 alts:** Hero `340px 1fr` grid (`variant-desktop`), `next/image` `max-cushion.png` etc. Data from `respond(...).matches` (dominant `p_vista_max` first, `role` from `rankProducts`). Prices via `formatINR(product.priceMinor)`. `Select` → `buildQuote(productId, recommendationBinding)` with `isQuoting` spinner, not timer.
* **What I understood chips:** Render from `parsedIntent`/`intent` returned by `respond`/`intentPatch`. `onRemove` → `intentPatch({size:"" ...}, expectedIntentVersion)`; `onEdit` → `intentPatch({size:newValue}, expectedIntentVersion)`. Show `isPatching` dots, keep `Tap to edit` hint.
* **Order review (id="order-review"):** Render from `quote.envelope` (`items[0].sku`, `unitAmountMinor`, `shippingMinor`, `totalMinor`, `expiresAt`, `returnPolicy`). No hash in main view; hash only in `Technical details` (`digest`, `signature`). Pill `AWAITING_APPROVAL` vs `● Approved` from `orderState`.
* **Approval button:** Main `Approve this exact order` `disabled={isRebuilding || isApproving || !quote}`; text `Review updated order` while `isRebuilding` (`aria-busy`), else normal. Sticky mobile uses same flags plus `reviewInView` (see §5).
* **Agent resource:** Keep separate card, `Mock — no funds moved`, `x402_mock_…` only inside `<details>Show resource evidence</details>`, never on-chain. Data from `machineSpend` in `respond` shortlist.
* **Audit history:** Render from `timeline(orderId)` filtered to same `logicalOrderId`; show `5 events` (`AUDIT_BASE`) vs `6` with approval (`AUDIT_APPROVAL` appended only when `orderState==="APPROVED"`). No timestamps/IDs outside `Technical details`.
* **Technical details:** Collapsed by default, shows `orderId`, `mandateId`, `digest`, `signature`, `issuedAt/expiresAt`, canonical envelope JSON, provider modes.

## 5. Mobile action bar — real states

Current prototype fixed to viewport bottom (`position:fixed; bottom:12px; left:50%; width:390px` `page.tsx:1005`, `padding-bottom:96px` to avoid cover) is correct and stays.

State machine to keep (but with real flags, not timers):

```
showLoading (isRebuilding) → sticky: "Review updated order" disabled, main Approve disabled
pendingUpdatedReview (set true on intentPatch start, cleared when !isRebuilding && reviewInView) → sticky: if !reviewInView → "Review updated order" (enabled to scroll), else → "Approve this exact order"
otherwise approved → "Approved ✓"
otherwise !reviewInView → "Review order"
otherwise → "Approve this exact order"
```

Implementation for integration:

* `pendingUpdatedReview` stays in UI state, set `true` on `intentPatch` start, cleared in `useEffect` when `!isRebuilding && reviewInView` (`page.tsx:365` observer already exists, threshold 0.35, root=`proto-frame-body`).
* `reviewInView` from `IntersectionObserver` on `#order-review` (`reviewRef`), root=`proto-frame-body`, as already implemented.
* `scrollToReview` scrolls `proto-frame-body` to `reviewRef.offsetTop -12` (smooth).

This yields verified flow `390×844` (default scrolling):
`Review order` (top, audit 5) → scroll → `Approve this exact order` → click → `Approved ✓` (audit 6) → edit chip → `Review updated order` disabled while `isPatching` → after `isPatching false` but not in view → `Review updated order` (enabled to scroll) → scroll → `Approve` → `Approved`. Pay stays `disabled` throughout.

## 6. Approval invalidation (real)

Real `services.approve` already invalidates on material intent change (`quote.invalidated` `lib/services.ts:379`, `requiresReapproval`). Integration must:

* After `intentPatch` success, discard `quote` (`null`) until new `buildQuote` succeeds; `orderState` will be `QUOTED` (from `respond` shortlist) until `buildQuote` → `AWAITING_APPROVAL`.
* Keep `approved` derived from `session.approvalEventId && approvedDigest === digest` (as in `lib/services.ts:665`), not local boolean alone. On edit, server clears `approvalEventId`, so UI must refetch `timeline`/`getSession` to reflect `AWAITING_APPROVAL`.

## 7. Payments disabled — keep separate

No `initiatePayment`/`verifyPayment`/`mockCapture` calls from ledger. `Pay with Razorpay` stays `disabled title="Prototype — no payment submission"` in both variants. Payment-safety fixes (idempotency, webhook dedup, `isMock`/`razorpayMode` handling) remain in `lib/services.ts` and `app/api/pay/*`, not touched here.

Devnet: `x402` stays `Mock` (`isMock` true, `x402: "mock"` indicator). No facilitator `verify/settle` calls from prototype. Real facilitator wiring stays behind `docs/devnet-preflight.md` approval.

## 8. Isolation & non-merge

* Prototype stays at `/ledger-prototype` behind `fullCapture` query flag, not imported by `app/page.tsx`.
* Integration work must be on a new branch `feat/ledger-real-wiring` branched from frozen hash `92b08d2`, behind feature flag `NEXT_PUBLIC_LEDGER_REAL=1` or `if (false)` guard, so `main` shop unchanged until visual approval.
* No `git merge` to `main` until plan approved; keep payment-safety branch separate.

## 9. Testing

* Existing `ledger-prototype-regression.test.ts` (7 tests) already covers `isApprovalDisabled`, `stickyState`, `auditCount`, `formatINR`, `isPayDisabled`. Extend to assert `isRebuilding` via real `isPatching` flag and `pendingUpdatedReview` clearing only when `reviewInView`.
* Add Playwright `390×844` viewport checks (already in `capture-final-verify.js`): `Review order (audit 5, pay disabled) → Review updated order (rebuilding, both Approves disabled) → Approve → Approved (audit 6) → edit → invalidation (audit 5)`.
* `pnpm --filter @agentready/web test` and `build` must pass.

## 10. Rollout steps (upon approval)

1. Create `feat/ledger-real-wiring` from frozen hash.
2. Extract `LedgerContent` to `app/components/DecisionLedger.tsx` with props `intent, quote, orderState, isRebuilding, pendingUpdatedReview, reviewInView, audit`.
3. Replace `showLoading` timer with `isRebuilding` derived from `useMutation` states for `respond`/`intentPatch`/`quote`.
4. Wire `onRemove/onEdit` to `intentPatch`, `onSelect` to `buildQuote`, `onApprove` to `approve`, refetch `timeline` for audit.
5. Keep `position:fixed` mobile bar and `padding-bottom:96px` so content never covered.
6. Feature-flagged preview at `/ledger-real` for visual sign-off before shop integration.
7. No payment or Devnet calls enabled.

## 11. Acceptance for this plan

* Prototype file unchanged (hash `92b08d2`).
* Plan reviewed, no code merged, Devnet still mock, payments disabled.
* Next step is approval to start `feat/ledger-real-wiring` as above.
