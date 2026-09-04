# Prototype Freeze — Decision Ledger v2

**Frozen:** 2026-09-03\
**File:** `apps/web/app/ledger-prototype/page.tsx`\
**SHA256:** `92b08d29fc65f9a09bd5f4d1b93fb5d58c3c24519674099bc8ecf20d82b5abd8`\
**Copy:** `docs/frozen/ledger-prototype-v2-frozen-2026-09-03.tsx`\
**Size:** 1044 lines, 17.6kB (build)

**Status:** Frozen for visual approval. **Do not edit** `apps/web/app/ledger-prototype/page.tsx` until approval is granted. All further changes must be tracked as separate commits and must not be merged into `main` shop flow.

**Scope of freeze:**
- Two-column desktop hero (image 340px beside details) + stacked mobile hero
- Small `MOCK` pill banner (not large `proto-notice`)
- `next/image` (verified fix for `no-img-element`, no `eslint-disable` suppression)
- Narrow 320px chat, `grid 320px 1fr` `align-items:start`, no blank gap
- Inline `ledger-alt-badge` (no absolute overlap), `min-width:0` clipping fixes
- Mobile `position:fixed` action bar at viewport bottom from load (`y 754/844`) with `padding-bottom:96px` so content not covered
- Sticky states: `Review order` (initial, not in view) → `Approve this exact order` (review in view, ready) → `Approved ✓`; after edit `Review updated order` disabled while `showLoading`
- Audit from same mock state: `5 events` → `6` only after `Approve` click; invalidation on chip edit resets to `5`
- Real viewports captured: `1280×800` desktop, `390×844` mobile (default scrolling)

**Verification:**
- `pnpm --filter @agentready/web build` passes
- `pnpm --filter @agentready/web test` 16/16, 375 passed (including `ledger-prototype-regression.test.ts` 7 tests)
- Playwright 390×844 capture log: `Review order → Approve → Approved ✓ → Review updated order (rebuilding, disabled)` with `audit 5→6→5`, `Pay disabled true`, `reviewInView` observer

**Screenshots (frozen):**
- `apps/web/public/prototype/final-desktop-1280-viewport.png` (1280)
- `apps/web/public/prototype/final-mobile-390-before.png` (390×844 before review, sticky `Review order`)
- `final-mobile-390-review.png` (after `Review order` → `Approve`)
- `final-mobile-390-approved.png` + `final-mobile-390-approved-full.png` (after Approve, audit 6)
- `final-mobile-390-rebuilding.png` (`Review updated order` disabled, main `Approve` disabled)

**Do not merge:** Prototype remains isolated at `/ledger-prototype`. No changes to `apps/web/app/page.tsx` shop flow, no payment logic changes, Devnet mock only.
