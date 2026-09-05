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
- Narration: pitch-script first two paragraphs of §0:25–1:05.

## Scene 3 — Conversational shopping (0:50–1:05, 15s)

- URL: `https://agentready-commerce-pied.vercel.app/` (composer focused).
- Clicks:
  1. Click composer input, type `I need black shoes under ₹5,000.`, click Send.
  2. Show the single agent question (size first) + use-case quick-reply chips; do not answer yet.
- Capture: user bubble, agent question bubble naming size, quick replies for use.
- Narration: pitch-script §0:25–1:05 last paragraph.

## Scene 4 — Grounded ranking (1:05–1:35, 30s)

- URL: same storefront tab (state preserved).
- Clicks:
  1. Answer `UK 9, road running` — click Send — shortlist appears (size + use
     are the only hard blockers).
  2. Add `wide fit, max cushioning` — click Send — mock x402 fit scores arrive.
- Capture: three `ProductCard` cards (Max Cushion ₹4,899 best overall; Streak 4
  ₹4,299 cheaper alternative; Stride Lite ₹3,499 trade-off), fit-score notes
  labelled MOCK settlement, explicit compromises.
- Narration: pitch-script §1:05–1:50 first paragraph.

## Scene 5 — x402 settlement evidence still (1:35–1:50, 15s)

- URL (still image, no click):
  `https://explorer.solana.com/tx/5FQb8Jh7LTmwoecXpv7TGDos61oFqo66T74uYY6mA6cWuD2EaHTQ73FsY2EZ99Wsj7j3SknsT4WE8vDmGxtt1Vfk?cluster=devnet`
- Also flash `docs/devnet-settlement-evidence-app-path-2026-09-04.md` header
  (payment `pay_appath_1788535423482`, 0.01 Devnet USDC, memo
  `agentcart:v1:6826a0b9…`, slot `493082743`, finalized, `meta.err` null).
- Clicks: none.
- Capture: explorer “Success / Finalized” banner + memo instruction.
- Narration: pitch-script §1:05–1:50 second paragraph. Captions: “Recorded
  2026-09-04 evidence — not performed by the public demo.” + “That request
  returned HTTP 500 and was reconciled read-only; scores on screen are mock.”

## Scene 6 — Explicit approval (1:50–2:30, 40s)

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
- Narration: pitch-script §1:50–2:30. Read the on-screen total; do not narrate
  a memorized number.

## Scene 7 — Bounded money, mock pay (2:30–2:55, 25s)

- URL: same storefront tab (approval present).
- Clicks:
  1. Click “Choose payment method” — modal opens with two cards bound to the
     approved envelope hash.
  2. Razorpay path: click “Razorpay Checkout” (`POST /api/pay/initiate`, rail
     `razorpay_checkout`) → checkout-styled panel shows `order_MOCK_*` + total
     under “MOCK · TEST DEMO” → click “Complete test payment”
     (`POST /api/pay/mock-capture` → verify).
  3. Show `order_MOCK_*` / `pay_MOCK_*` IDs + “signature verified”.
  (Alternate take: choose “Agent Pay with x402”, review network/asset/amount/
  recipient/digests as it settles automatically with no second approval.)
- Capture: modal cards, payment panel + drawer `payment.verified` event.
- Narration: pitch-script §2:30–3:10 first paragraph. Caption: “Mock order —
  no funds moved.”

## Scene 8 — Razorpay Test Mode lifecycle stills (2:55–3:10, 15s)

- Stills (no clicks, no live calls):
  - `docs/evidence/razorpay-test-proof.md` transactions table:
    `order_TWTuHSmXrkHoUJ` / `pay_TWU2Fy64pOAaZi` ₹3848 captured;
    `order_TWVIgwsRyjV7C8` / `pay_TWVJ9xLsjtdwoo` webhook `TWVJJZ01UBcNy1`
    accepted; `order_TWVLQtCV7OXCmI` / `pay_TWVLknN4NRrHSN` webhook
    `TWVLtSP9a4RfZ4` + refund `rfnd_TWVNeD4HStaNby` processed → `REFUNDED`.
  - Audit chain: approval → Test Mode order → webhook → `PAID_VERIFIED` →
    fulfil-fail → refund.
- Narration: pitch-script §2:30–3:10 second paragraph. Caption:
  “Recorded Aug/Sep Test Mode integration-path evidence — Razorpay Test Mode
  refund, not performed by the public demo.”

## Scene 9 — Graceful failure (3:10–3:45, 35s)

- URL: `https://agentready-commerce-pied.vercel.app/demo`
- Clicks: click “Price change after approval” (`POST /api/demo/price-drift`
  `{field: price}` — self-contained: approve → tamper → stale retries in one
  request, no shared-session dependency).
- Capture: notice banner (“Price drift: approval `<12 hex>…` invalidated →
  REAPPROVAL_REQUIRED; price changed …; stale approval blocked; stale payment
  blocked”) + state + audit events.
- Narration: pitch-script §3:10–3:45 verbatim.

## Scene 10 — Recovery + auditability (3:45–4:15, 30s)

- URL: same `/demo` tab.
- Clicks:
  1. Click “Replay webhook” (`POST /api/demo/webhook-replay` — one session to
     PAYMENT_PENDING, then the same webhook twice under one event ID) — show
     “first processed (fresh), second deduplicated” and PAID_VERIFIED.
  2. Click “Run conformance suite” (`GET /api/conformance`) — show 15/15 gates.
  3. Reopen “Order & trust” drawer (storefront tab) — scroll intent → receipt.
- Capture: replay notice, gate list, full timeline.
- Narration: pitch-script §3:45–4:15 verbatim.

## Scene 11 — Value + scope honesty (4:15–5:00, 45s)

- URL: back to `https://agentready-commerce-pied.vercel.app/` hero.
- Clicks: none.
- Capture: slow pull-back; final caption card with three lines:
  “Mock-only public demo · Test Mode + Devnet are recorded evidence ·
  Vulcan not integrated.”
- Narration: pitch-script §4:15–5:00 verbatim, including: “Vulcan can make
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
