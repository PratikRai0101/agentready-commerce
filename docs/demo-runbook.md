# Live-demo runbook + prerecorded fallback

> Public host is mock-only. Do not execute payments, settlements, migrations,
> or external writes during a live or recorded demo. Razorpay Test Mode and
> Solana Devnet are presented as committed recorded evidence, never as live
> actions from the public demo.

## 1. What the public demo is (say this first)

- URL: `https://agentready-commerce-pied.vercel.app` (+ `/demo` for Demo Lab).
- Posture: `razorpay: mock`, `x402: mock`, `llm: disabled`;
  `X402_SETTLEMENT_ENABLED=false`, `X402_LIVE_DEVNET_TEST=0`; no Razorpay keys,
  no database URL, no keypair, no Mainnet configuration.
- Money behavior on camera: `order_MOCK_*` / `pay_MOCK_*` IDs only, zero
  external egress. Verified in `docs/evidence/public-demo-preflight.md` §5
  (storefront 42/42 + prototype 20/20 browser smoke on the public alias).

## 2. Live runbook (5:00, fresh state)

### T-10 min — preflight (read-only)

1. Open `/api/status` — expect 200, mock/mock/disabled, mock adapter.
2. Open `/.well-known/agentready` — expect 200, `protocolConformance` None
   claimed.
3. Open `/api/catalog` — expect 200, 6 products.
4. Keep `/demo` closed until Scene 9. Keep Devnet/Razorpay evidence screenshots
   pre-opened in background tabs (no live fetch needed on stage).

### T-0 — go (follow docs/recording-plan.md Scenes 1–11)

| Clock | Do |
|---|---|
| 0:00 | Storefront `/` loaded. State the mock-only framing. |
| 0:25 | Show `/.well-known/agentready` + `/api/catalog` JSON. |
| 0:50 | Composer: `I need black shoes under ₹5,000.` → Send. Show size-and-use question. |
| 1:05 | Reply `UK 9, road running` → Send (shortlist), then add `wide fit, max cushioning` → Send (mock fit scores). |
| 1:35 | Still: Devnet explorer `5FQb8Jh7…?cluster=devnet` + evidence header. Narrate HTTP-500-then-reconciled caveat; scores on screen are mock. |
| 1:50 | Max Cushion card → Select → approval panel → “Approve exact envelope hash” → “Order & trust” drawer. |
| 2:30 | “Choose payment method” → “Razorpay Checkout” → “Complete test payment”. Narrate mock IDs. (Alternate: “Agent Pay with x402” → review details → “Confirm mock payment”.) |
| 2:55 | Stills: `docs/evidence/razorpay-test-proof.md` table (orders `order_TWTuHSmXrkHoUJ`, `order_TWVIgwsRyjV7C8`, `order_TWVLQtCV7OXCmI`; Razorpay Test Mode refund `rfnd_TWVNeD4HStaNby` processed). |
| 3:10 | `/demo` → “Price change after approval” (self-contained `POST /api/demo/price-drift`). Show invalidated digest, `REAPPROVAL_REQUIRED`, named change, stale approval + payment blocked. |
| 3:45 | “Replay webhook” (self-contained `POST /api/demo/webhook-replay`: first processed fresh, second deduplicated) → “Run conformance suite” (15/15) → drawer timeline scroll. |
| 4:15 | Back to `/` hero. Deliver value + Vulcan future-alignment line. Stop at 5:00. |

### Fresh-state recovery (if anything looks stale)

- Storefront: click through “Order & trust” → use reset via `POST /api/reset`
  only if you can do it off-camera in <15s; otherwise switch to `/demo` →
  “Reset server state” or “New conversation” and continue narration without
  apologizing more than once.
- Never edit code, env vars, or Vercel settings on stage. Never open
  `.env.local`, keypairs, dashboards with secrets, or raw webhook bodies.

### Abort criteria (switch to fallback, do not debug live)

- `/api/status` not mock/mock/disabled; any non-`MOCK` order ID on the public
  host; any unexpected external redirect; two failed clicks in a row; time
  past 3:30 without reaching approval. Say: “That’s the live mock path — here
  is the identical prerecorded run,” and play the fallback.

## 3. Prerecorded fallback plan

- Primary fallback: the 5:00 recording made per `docs/recording-plan.md`
  (mock UI + evidence stills, captions on).
- If video fails: click through the same scenes using stills only —
  `/.well-known/agentready` JSON, catalog JSON, shortlist screenshot, approval
  panel screenshot, `order_MOCK_*` screenshot, `docs/evidence/razorpay-test-proof.md`
  table, Devnet explorer `5FQb8Jh7…` + `9Z795iRrqkymKipM3XTY7q3gY7FZ2qvUFQKisnewPmhKH3opqzyVq2gmyPxrrJ8ez2KxSDHdXvJ8qeqkKKZi4JM`
  stills, Demo Lab price-drift notice (digest invalidated → REAPPROVAL_REQUIRED,
  stale approval + payment blocked), webhook-replay notice (first processed
  fresh, second deduplicated), 15/15 conformance, audit timeline.
- Narrate the identical pitch script over stills; keep the same honesty
  captions (“mock-only”, “recorded Test Mode 2026-08-31/09-01”, “recorded
  Devnet 2026-09-04 / harness 2026-09-02”).
- Never substitute a live Test Mode or Devnet call as a “quick fix” — the
  fallback is prerecorded precisely so no money path executes under pressure.

## 4. Forbidden on stage and on camera

- No Razorpay live keys, no Test Mode key entry, no Checkout with real cards.
- No `X402_MODE=devnet`, no keypair paths, no `operator-cli` reconcile, no
  facilitator calls, no Solana transfers.
- No migrations, deploys, env edits, or secret pastes.
- Vulcan: future-alignment sentence only — “Vulcan can make payment
  intelligence smarter; RunVista makes the agent executing payment decisions
  bounded, explainable and auditable.” No integration claimed, no mock labelled
  as Vulcan.
