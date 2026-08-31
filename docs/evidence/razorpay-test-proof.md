# Razorpay Test Mode proof — sanitized evidence

Razorpay **Test Mode** end-to-end verification for the AgentReady Commerce
tracer bullet. Safe identifiers only. No API keys, webhook secrets, signatures,
raw payloads, card/contact details or environment files appear in this document.

Test date: 2026-08-31 / 2026-09-01 (UTC timestamps in the application audit timeline).

## What was verified

1. **Standard Checkout (Test Mode)** — real Razorpay Checkout modal opened from
   the storefront and completed three times with Razorpay's published test card.
2. **Authenticated webhook** — dashboard-configured Test Mode webhook subscribed
   to `payment.captured`, delivered to the app endpoint over a public HTTPS
   tunnel. Each delivery was verified server-side: raw-body HMAC signature,
   `x-razorpay-event-id` dedup, and order/amount/currency/captured binding.
3. **Processed refund** — after a simulated fulfilment failure on a
   webhook-verified payment, a genuine Razorpay refund was issued and confirmed
   as `processed` via the Razorpay API and the Razorpay Dashboard.

## Transactions

### Transaction 1 — client-verified payment

| Field | Value |
| --- | --- |
| Razorpay order ID | `order_TWTuHSmXrkHoUJ` |
| Razorpay payment ID | `pay_TWU2Fy64pOAaZi` |
| Amount / currency | ₹3848.00 / INR |
| Status | captured |
| Application result | `payment.verified` → PAID_VERIFIED |

### Transaction 2 — webhook-verified payment

| Field | Value |
| --- | --- |
| Razorpay order ID | `order_TWVIgwsRyjV7C8` |
| Razorpay payment ID | `pay_TWVJ9xLsjtdwoo` |
| Webhook event ID | `TWVJJZ01UBcNy1` |
| Event type | `payment.captured` |
| Webhook result | HTTP 200, `accepted` (signature valid, order bound, processed) |
| Amount / currency | ₹3548.00 / INR |
| Status | captured |
| Application result | `payment.verified_via_webhook` → PAID_VERIFIED |

### Transaction 3 — webhook-verified payment + genuine refund

| Field | Value |
| --- | --- |
| Razorpay order ID | `order_TWVLQtCV7OXCmI` |
| Razorpay payment ID | `pay_TWVLknN4NRrHSN` |
| Webhook event ID | `TWVLtSP9a4RfZ4` |
| Event type | `payment.captured` |
| Webhook result | HTTP 200, `accepted` (signature valid, order bound, processed) |
| Amount / currency | ₹4348.00 / INR |
| Payment status | captured |
| Fulfilment | simulated failure (inventory unavailable) |
| Refund ID | `rfnd_TWVNeD4HStaNby` |
| Refund status | `processed` (confirmed via Razorpay API and Dashboard) |
| Application result | `compensation.refunded` → REFUNDED |

## State-transition summary (application audit timeline)

```
ambiguous request → clarification → ranked shortlist → exact envelope
→ approval (hash-bound) → Razorpay Test Mode order → payment.captured webhook
→ signature + binding verified → PAID_VERIFIED → fulfilment failed
→ genuine refund → REFUNDED
```

Duplicate webhook deliveries and unsupported events were also exercised:
replays are deduplicated by `x-razorpay-event-id` (no second state transition),
and unsupported events return HTTP 200 `ignored` without changing payment state.

## Notes

- The detailed local proof record (timestamps, audit event IDs, verification
  details) is kept out of git in `data/proof/razorpay-test-proof.md` (ignored).
- Webhook secret used for dashboard delivery was rotated to a fresh 32-byte
  value; structured server logs emit only event type, event ID, safe
  order/payment IDs, HTTP status and reason code — never secrets or payloads.