# Scene-by-scene recording plan (5:00 total)

> Public host (mock-only): `https://agentready-commerce-pied.vercel.app`
> Record at 1280×800, Chromium, clean profile. No payments, settlements,
> migrations, or external writes are performed during recording. Razorpay Test
> Mode and Solana Devnet appear as screenshots of committed evidence files, not
> live calls. All button labels below are verbatim from `apps/web/app/page.tsx`
> and `apps/web/app/demo/page.tsx`.

## Global setup (before Scene 1)

- Open `https://agentready-commerce-pied.vercel.app/` in one tab.
- Open `https://agentready-commerce-pied.vercel.app/demo` in a second tab.
- Confirm header indicators read mock / mock / disabled and order IDs use the
  `order_MOCK_*` / `pay_MOCK_*` shape before narrating any money step.
- Set narration captions on. Total budget: 5:00; per-scene durations are hard
  caps — cut visuals, never speed narration above 140 wpm.

## Scene 1 — Problem + mock-only framing (0:00–0:25, 25s)

- URL: `https://agentready-commerce-pied.vercel.app/`
- Clicks: none. Hover the storefront header (RunVista brand, Shop nav).
- Capture: full storefront hero + “Find your next running shoe” heading.
- Narration: pitch-script §0:00–0:25 verbatim.
- On-screen caption: “Public demo is mock-only — no funds move here.”

## Scene 2 — Agent-readable discovery (0:25–0:50, 25s)

- URLs (open as raw JSON, scroll slowly):
  - `https://agentready-commerce-pied.vercel.app/.well-known/agentready`
  - `https://agentready-commerce-pied.vercel.app/api/catalog`
  - `https://agentready-commerce-pied.vercel.app/api/status`
- Clicks: none (read-only GETs).
- Capture: `protocolConformance: "None claimed…"`, `productCount: 6`,
  `indicators: {razorpay: mock, x402: mock, llm: disabled}`.
- Narration: pitch-script first two paragraphs of §0:25–1:10.

## Scene 3 — Conversational shopping (0:50–1:10, 20s)

- URL: `https://agentready-commerce-pied.vercel.app/` (composer focused).
- Clicks:
  1. Click composer input, type `I need black shoes under ₹5,000.`, click Send.
  2. Show agent clarification + quick-reply chips; do not answer yet.
- Capture: user bubble, agent question bubble (“size, use, fit…”).
- Narration: pitch-script last paragraph of §0:25–1:10.

## Scene 4 — Grounded ranking (1:10–1:40, 30s)

- URL: same storefront tab (state preserved).
- Clicks: answer clarifications in one message —
  `UK 9, road running up to 10K, wide fit, max cushioning, must be returnable`
  — click Send.
- Capture: three `ProductCard` cards (Max Cushion ₹4,899 best overall; Streak 4
  ₹4,299 cheaper alternative; Stride Lite ₹3,499 trade-off), fit-score notes,
  explicit compromises.
- Narration: pitch-script §1:10–1:55 first paragraph.

## Scene 5 — x402 settlement evidence still (1:40–1:55, 15s)

- URL (still image, no click):
  `https://explorer.solana.com/tx/5FQb8Jh7LTmwoecXpv7TGDos61oFqo66T74uYY6mA6cWuD2EaHTQ73FsY2EZ99Wsj7j3SknsT4WE8vDmGxtt1Vfk?cluster=devnet`
- Also flash `docs/devnet-settlement-evidence-app-path-2026-09-04.md` header
  (payment `pay_appath_1788535423482`, 0.01 Devnet USDC, memo
  `agentcart:v1:6826a0b9…`, slot `493082743`, finalized, `meta.err` null).
- Clicks: none.
- Capture: explorer “Success / Finalized” banner + memo instruction.
- Narration: pitch-script §1:10–1:55 second paragraph. Caption: “Recorded
  2026-09-04 evidence — not performed by the public demo.”

## Scene 6 — Explicit approval (1:55–2:35, 40s)

- URL: same storefront tab.
- Clicks:
  1. On Max Cushion card, click Select (card button; `chooseProduct` →
     `POST /api/quote`).
  2. Scroll to “Order review” approval panel; show SKU `VMAX-BLK-9`, quantity,
     subtotal, ₹49 shipping, total, envelope hash, expiry, 14-day return line.
  3. Click “Approve exact envelope hash” (`POST /api/approve`).
  4. Click “Order & trust” (topbar `trust-badge`) to open drawer; show
     `approval.bound` event.
- Capture: digest string, “approved” state, drawer event row.
- Narration: pitch-script §1:55–2:35. Read the on-screen total; do not narrate
  a memorized number.

## Scene 7 — Bounded money, mock pay (2:35–2:55, 20s)

- URL: same storefront tab (approval present).
- Clicks:
  1. Click “Pay with Razorpay” (`POST /api/pay/initiate`, rail
     `razorpay_checkout`).
  2. Click “Complete test payment” (`POST /api/pay/mock-capture` → verify).
  3. Show `order_MOCK_*` / `pay_MOCK_*` IDs + “signature verified”.
- Capture: payment panel + drawer `payment.verified` event.
- Narration: pitch-script §2:35–3:15 first paragraph. Caption: “Mock order —
  no funds moved.”

## Scene 8 — Razorpay Test Mode lifecycle stills (2:55–3:15, 20s)

- Stills (no clicks, no live calls):
  - `docs/evidence/razorpay-test-proof.md` transactions table:
    `order_TWTuHSmXrkHoUJ` / `pay_TWU2Fy64pOAaZi` ₹3848 captured;
    `order_TWVIgwsRyjV7C8` / `pay_TWVJ9xLsjtdwoo` webhook `TWVJJZ01UBcNy1`
    accepted; `order_TWVLQtCV7OXCmI` / `pay_TWVLknN4NRrHSN` webhook
    `TWVLtSP9a4RfZ4` + refund `rfnd_TWVNeD4HStaNby` processed → `REFUNDED`.
  - Audit chain: approval → Test Mode order → webhook → `PAID_VERIFIED` →
    fulfil-fail → refund.
- Narration: pitch-script §2:35–3:15 second + third paragraphs. Caption:
  “Recorded 2026-08-31/09-01 Test Mode evidence.”

## Scene 9 — Graceful failure (3:15–3:50, 35s)

- URL: `https://agentready-commerce-pied.vercel.app/demo`
- Clicks (either path; prefer deterministic API scenario for recording):
  - Option A (visible): click “Run prepared scenario” (`GET /api/scenario`),
    then show invalidation block: budget edit to ₹3,000 → stale-digest approval
    rejected + stale payment rejected, exact changed fields named.
  - Option B: click “Price change after approval” (`POST /api/tamper`
    `{field: price}`), show `REAPPROVAL_REQUIRED` notice + timeline event.
- Capture: notice banner (“Material change detected…”) + state + audit event.
- Narration: pitch-script §3:15–3:50 verbatim.

## Scene 10 — Recovery + auditability (3:50–4:20, 30s)

- URL: same `/demo` tab.
- Clicks:
  1. Click “Replay webhook” (two `POST /api/webhook/simulate` calls) — show
     “first processed (fresh), second deduplicated”.
  2. Click “Run conformance suite” (`GET /api/conformance`) — show 15/15 gates.
  3. Reopen “Order & trust” drawer (storefront tab) — scroll intent → receipt.
- Capture: replay notice, gate list, full timeline.
- Narration: pitch-script §3:50–4:20 verbatim.

## Scene 11 — Value + scope honesty (4:20–5:00, 40s)

- URL: back to `https://agentready-commerce-pied.vercel.app/` hero.
- Clicks: none.
- Capture: slow pull-back; final caption card with three lines:
  “Mock-only public demo · Test Mode + Devnet are recorded evidence ·
  Vulcan not integrated.”
- Narration: pitch-script §4:20–5:00 verbatim, including: “Vulcan can make
  payment intelligence smarter; RunVista makes the agent executing payment
  decisions bounded, explainable and auditable.”

## Post-recording checklist

- [ ] No `order_` / `pay_` / `rfnd_` ID outside the documented mock + Test Mode
      sets appears on camera.
- [ ] No secret, key, seed phrase, keypair content, signed payload, raw webhook
      body, or `.env.local` content visible in any frame.
- [ ] Both Devnet stills show the `?cluster=devnet` explorer URL and a
      “recorded evidence” caption.
- [ ] Every click above matches a verbatim button label; every URL returns 200
      on the public host in mock posture.
