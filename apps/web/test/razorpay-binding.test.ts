import { describe, expect, it } from "vitest";
import { MockRazorpayAdapter, razorpaySignature } from "@agentready/payments";
import { getServices, type AppServices } from "../lib/services";
import { processRazorpayWebhookRaw } from "../lib/webhook";

const env: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  RAZORPAY_KEY_ID: "rzp_test_mock",
  RAZORPAY_KEY_SECRET: "mock_secret",
  ENVELOPE_SIGNING_SECRET: "test-secret",
};

const DEMO_MESSAGE = "I need black shoes under ₹5,000.";
const CLARIFICATIONS = ["UK 9", "Road running up to 10K", "Wide fit", "Cushioning preferred", "Must be returnable", "Delivery before Sunday"];

async function runToPaymentPending() {
  const services = getServices(env, { forceMock: true });
  const session = services.createSession();
  const orderId = session.logicalOrderId;
  await services.respond(orderId, DEMO_MESSAGE);
  for (const clarification of CLARIFICATIONS) {
    await services.respond(orderId, clarification);
  }
  const quote = await services.buildQuote(orderId, "p_streak_4");
  await services.approve(orderId, quote.digest);
  const initiated = await services.initiatePayment(orderId, "razorpay_checkout");
  if (!initiated.ok) throw new Error("initiate failed");
  return { services, session, orderId, quote };
}

function mockAdapter(services: AppServices): MockRazorpayAdapter {
  const adapter = services.registry.get("razorpay_checkout");
  if (!(adapter instanceof MockRazorpayAdapter)) {
    throw new Error("expected mock adapter in test");
  }
  return adapter;
}

function webhookBody(orderId: string, overrides: Record<string, unknown> = {}) {
  const session = getServices(env, { forceMock: true }).getSession(orderId);
  return {
    event: "payment.captured",
    contains: ["payment"],
    payload: {
      payment: {
        entity: {
          id: `pay_wh_${Math.random().toString(36).slice(2, 10)}`,
          order_id: session?.externalOrderId ?? "order_MOCK_x",
          amount: 434800,
          currency: "INR",
          status: "captured",
          notes: { logicalOrderId: orderId },
          ...overrides,
        },
      },
    },
  };
}

describe("client-side verification binding", () => {
  it("rejects a submitted order id that differs from the session order", async () => {
    const { services, orderId, session } = await runToPaymentPending();
    const result = await services.verifyPayment(orderId, "order_WRONG", "pay_1", "sig");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("does not match");
    expect(session.state).toBe("PAYMENT_FAILED");
  });

  it("rejects a captured payment with the wrong amount", async () => {
    const { services, orderId, session, quote } = await runToPaymentPending();
    mockAdapter(services).setSimulation({ amountMinor: quote.envelope.totalMinor + 100 });
    try {
      const capture = await services.mockCapture(orderId);
      const result = await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("amount");
    } finally {
      mockAdapter(services).setSimulation(undefined);
    }
    expect(session.state).toBe("PAYMENT_FAILED");
  });

  it("rejects a captured payment in the wrong currency", async () => {
    const { services, orderId, session } = await runToPaymentPending();
    mockAdapter(services).setSimulation({ currency: "USD" });
    try {
      const capture = await services.mockCapture(orderId);
      const result = await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("currency");
    } finally {
      mockAdapter(services).setSimulation(undefined);
    }
    expect(session.state).toBe("PAYMENT_FAILED");
  });

  it("rejects a payment that is authorized but not captured", async () => {
    const { services, orderId, session } = await runToPaymentPending();
    mockAdapter(services).setSimulation({ status: "authorized" });
    try {
      const capture = await services.mockCapture(orderId);
      const result = await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not captured");
    } finally {
      mockAdapter(services).setSimulation(undefined);
    }
    expect(session.state).toBe("PAYMENT_FAILED");
  });

  it("rejects a fetched payment whose order_id does not match", async () => {
    const { services, orderId, session } = await runToPaymentPending();
    mockAdapter(services).setSimulation({ orderId: "order_SOMEONE_ELSES" });
    try {
      const capture = await services.mockCapture(orderId);
      const result = await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("order_id");
    } finally {
      mockAdapter(services).setSimulation(undefined);
    }
    expect(session.state).toBe("PAYMENT_FAILED");
  });
});

describe("webhook verification binding", () => {
  it("rejects a webhook whose raw body was modified after signing", async () => {
    const { services, orderId } = await runToPaymentPending();
    const rawBody = JSON.stringify(webhookBody(orderId));
    const signature = razorpaySignature("mock_secret", rawBody);
    const tampered = rawBody.replace('"status":"captured"', '"status":"failed"');
    const outcome = await processRazorpayWebhookRaw(services, tampered, signature, "evt_mod_1", "mock_secret");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected rejection");
    expect(outcome.error).toContain("signature");
  });

  it("rejects a webhook whose amount does not match the envelope", async () => {
    const { services, orderId } = await runToPaymentPending();
    const rawBody = JSON.stringify(webhookBody(orderId, { amount: 1 }));
    const signature = razorpaySignature("mock_secret", rawBody);
    const outcome = await processRazorpayWebhookRaw(services, rawBody, signature, "evt_amt_1", "mock_secret");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected rejection");
    expect(outcome.error).toContain("amount");
  });

  it("rejects a webhook whose currency does not match the envelope", async () => {
    const { services, orderId } = await runToPaymentPending();
    const rawBody = JSON.stringify(webhookBody(orderId, { currency: "USD" }));
    const signature = razorpaySignature("mock_secret", rawBody);
    const outcome = await processRazorpayWebhookRaw(services, rawBody, signature, "evt_cur_1", "mock_secret");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected rejection");
    expect(outcome.error).toContain("currency");
  });

  it("rejects a webhook that is authorized but not captured", async () => {
    const { services, orderId } = await runToPaymentPending();
    const rawBody = JSON.stringify(webhookBody(orderId, { status: "authorized" }));
    const signature = razorpaySignature("mock_secret", rawBody);
    const outcome = await processRazorpayWebhookRaw(services, rawBody, signature, "evt_auth_1", "mock_secret");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected rejection");
    expect(outcome.error).toContain("not captured");
  });

  it("deduplicates by x-razorpay-event-id", async () => {
    const { services, orderId, session } = await runToPaymentPending();
    const rawBody = JSON.stringify(webhookBody(orderId));
    const signature = razorpaySignature("mock_secret", rawBody);
    const first = await processRazorpayWebhookRaw(services, rawBody, signature, "evt_dup_event", "mock_secret");
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.deduplicated).toBe(false);
    expect(session.state).toBe("PAID_VERIFIED");
    const second = await processRazorpayWebhookRaw(services, rawBody, signature, "evt_dup_event", "mock_secret");
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.deduplicated).toBe(true);
  });

  it("binds the session by Razorpay order id, not notes.logicalOrderId", async () => {
    const { services, orderId, session } = await runToPaymentPending();
    const otherOrder = services.createSession().logicalOrderId;
    const rawBody = JSON.stringify(
      webhookBody(otherOrder, { order_id: session.externalOrderId, notes: { logicalOrderId: otherOrder } }),
    );
    const signature = razorpaySignature("mock_secret", rawBody);
    const outcome = await processRazorpayWebhookRaw(services, rawBody, signature, "evt_bind_1", "mock_secret");
    expect(outcome.ok).toBe(true);
    expect(services.getSession(orderId)?.state).toBe("PAID_VERIFIED");
    expect(services.getSession(otherOrder)?.state).toBe("DRAFT");
    const mismatchEvents = (await services.timeline(orderId)).filter((e) => e.type === "webhook.notes_mismatch");
    expect(mismatchEvents).toHaveLength(1);
  });

  it("rejects a webhook for an unknown Razorpay order", async () => {
    const { services } = await runToPaymentPending();
    const rawBody = JSON.stringify(webhookBody("ord_unknown", { order_id: "order_NEVER_CREATED" }));
    const signature = razorpaySignature("mock_secret", rawBody);
    const outcome = await processRazorpayWebhookRaw(services, rawBody, signature, "evt_unk_1", "mock_secret");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected rejection");
    expect(outcome.error).toContain("unknown Razorpay order");
  });
});

describe("out-of-order webhooks", () => {
  it("settles the order when the webhook arrives before client verification", async () => {
    const { services, orderId, session } = await runToPaymentPending();
    const rawBody = JSON.stringify(webhookBody(orderId));
    const signature = razorpaySignature("mock_secret", rawBody);
    const webhook = await processRazorpayWebhookRaw(services, rawBody, signature, "evt_before_client", "mock_secret");
    expect(webhook.ok).toBe(true);
    if (!webhook.ok) throw new Error("unreachable");
    expect(webhook.held).toBe(false);
    expect(session.state).toBe("PAID_VERIFIED");

    const capture = await services.mockCapture(orderId);
    const client = await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature);
    expect(client.ok).toBe(true);
    expect(session.state).toBe("PAID_VERIFIED");
    const verifiedEvents = (await services.timeline(orderId)).filter((e) => e.type === "payment.verified" || e.type === "payment.verified_via_webhook");
    expect(verifiedEvents).toHaveLength(1);
  });

  it("holds a valid webhook after a failed client verification and reconciles on retry", async () => {
    const { services, orderId, session } = await runToPaymentPending();
    await services.verifyPayment(orderId, "order_X", "pay_forged", "forged");
    expect(session.state).toBe("PAYMENT_FAILED");

    const rawBody = JSON.stringify(webhookBody(orderId));
    const signature = razorpaySignature("mock_secret", rawBody);
    const webhook = await processRazorpayWebhookRaw(services, rawBody, signature, "evt_held_1", "mock_secret");
    expect(webhook.ok).toBe(true);
    if (!webhook.ok) throw new Error("unreachable");
    expect(webhook.held).toBe(true);
    expect(session.state).toBe("PAYMENT_FAILED");
    expect(session.heldWebhook?.eventId).toBe("evt_held_1");

    const retry = await services.initiatePayment(orderId, "razorpay_checkout");
    expect(retry.ok).toBe(true);
    const capture = await services.mockCapture(orderId);
    const client = await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature);
    expect(client.ok).toBe(true);
    expect(session.state).toBe("PAID_VERIFIED");
    expect(session.heldWebhook).toBeUndefined();
    const reconciled = (await services.timeline(orderId)).filter((e) => e.type === "webhook.reconciled_after_client_verification");
    expect(reconciled).toHaveLength(1);
    const replay = await processRazorpayWebhookRaw(services, rawBody, signature, "evt_held_1", "mock_secret");
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("unreachable");
    expect(replay.deduplicated).toBe(true);
  });
});