import { describe, expect, it } from "vitest";
import { MockRazorpayAdapter, razorpaySignature, verifyRazorpayPaymentSignature, verifyRazorpayWebhookSignature } from "../src";
import { transitionState } from "@agentready/domain";
import type { CommerceEnvelope } from "@agentready/domain";

const envelope: CommerceEnvelope = {
  version: 1,
  logicalOrderId: "ord_1",
  merchantId: "merchant_runvista",
  quoteId: "qt_1",
  customerId: "cust_1",
  items: [
    {
      productId: "p_streak_4",
      sku: "STRK4-BLK-9",
      variant: { size: "UK 9", colour: "black" },
      quantity: 1,
      unitAmountMinor: 429900,
    },
  ],
  subtotalMinor: 429900,
  taxMinor: 0,
  shippingMinor: 4900,
  totalMinor: 434800,
  currency: "INR",
  inventoryHoldId: "hold_1",
  returnPolicyDigest: "rp",
  shippingDestinationDigest: "dest",
  mandateId: "mdt_1",
  issuedAt: "2026-08-31T10:00:00.000Z",
  expiresAt: "2026-08-31T10:15:00.000Z",
  nonce: "nonce_1",
};

describe("razorpay signature helpers", () => {
  it("verifies a payment signature built from order|payment", () => {
    const orderId = "order_ABC";
    const paymentId = "pay_XYZ";
    const signature = razorpaySignature("secret", `${orderId}|${paymentId}`);
    expect(verifyRazorpayPaymentSignature("secret", orderId, paymentId, signature)).toBe(true);
  });

  it("rejects a signature for the wrong order", () => {
    const orderId = "order_ABC";
    const paymentId = "pay_XYZ";
    const signature = razorpaySignature("secret", `${orderId}|${paymentId}`);
    expect(verifyRazorpayPaymentSignature("secret", "order_OTHER", paymentId, signature)).toBe(false);
  });

  it("verifies a webhook signature over the raw body", () => {
    const body = JSON.stringify({ event: "payment.captured", payload: { id: "pay_1" } });
    const signature = razorpaySignature("whsec", body);
    expect(verifyRazorpayWebhookSignature("whsec", body, signature)).toBe(true);
  });

  it("rejects a tampered webhook body", () => {
    const body = JSON.stringify({ event: "payment.captured", payload: { id: "pay_1" } });
    const signature = razorpaySignature("whsec", body);
    const tampered = JSON.stringify({ event: "payment.captured", payload: { id: "pay_2" } });
    expect(verifyRazorpayWebhookSignature("whsec", tampered, signature)).toBe(false);
  });
});

describe("MockRazorpayAdapter", () => {
  it("creates an order and verifies a correctly signed capture", async () => {
    const adapter = new MockRazorpayAdapter({ keyId: "rzp_mock", keySecret: "secret" });
    const attempt = await adapter.initiate(envelope);
    expect(attempt.externalOrderId).toContain("order_MOCK_");
    const signature = razorpaySignature("secret", `${attempt.externalOrderId}|pay_1`);
    const result = await adapter.verify({
      logicalOrderId: envelope.logicalOrderId,
      envelopeHash: "hash",
      rail: "razorpay_checkout",
      externalOrderId: attempt.externalOrderId!,
      externalPaymentId: "pay_1",
      expectedAmountMinor: envelope.totalMinor,
      signature,
    });
    expect(result.verified).toBe(true);
  });

  it("rejects a forged signature", async () => {
    const adapter = new MockRazorpayAdapter({ keyId: "rzp_mock", keySecret: "secret" });
    const attempt = await adapter.initiate(envelope);
    const result = await adapter.verify({
      logicalOrderId: envelope.logicalOrderId,
      envelopeHash: "hash",
      rail: "razorpay_checkout",
      externalOrderId: attempt.externalOrderId!,
      externalPaymentId: "pay_1",
      signature: "deadbeef",
    });
    expect(result.verified).toBe(false);
  });
});

describe("order state machine", () => {
  it("allows the tracer bullet path", () => {
    expect(transitionState("DRAFT", "CLARIFYING").ok).toBe(true);
    expect(transitionState("CLARIFYING", "QUOTED").ok).toBe(true);
    expect(transitionState("QUOTED", "AWAITING_APPROVAL").ok).toBe(true);
    expect(transitionState("AWAITING_APPROVAL", "APPROVED").ok).toBe(true);
    expect(transitionState("APPROVED", "PAYMENT_PENDING").ok).toBe(true);
    expect(transitionState("PAYMENT_PENDING", "PAID_VERIFIED").ok).toBe(true);
    expect(transitionState("PAID_VERIFIED", "FULFILMENT_PENDING").ok).toBe(true);
    expect(transitionState("FULFILMENT_PENDING", "FULFILLED").ok).toBe(true);
  });

  it("forbids fulfilment before payment", () => {
    const result = transitionState("APPROVED", "FULFILLED");
    expect(result.ok).toBe(false);
  });

  it("forbids refunds without a paid fulfilment failure", () => {
    expect(transitionState("APPROVED", "REFUNDED").ok).toBe(false);
    expect(transitionState("PAID_VERIFIED", "REFUNDED").ok).toBe(false);
  });

  it("allows the compensation chain", () => {
    expect(transitionState("PAID_VERIFIED", "FULFILMENT_FAILED").ok).toBe(true);
    expect(transitionState("FULFILMENT_FAILED", "COMPENSATION_PENDING").ok).toBe(true);
    expect(transitionState("COMPENSATION_PENDING", "REFUNDED").ok).toBe(true);
  });
});