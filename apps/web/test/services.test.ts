import { describe, expect, it } from "vitest";
import { razorpaySignature } from "@agentready/payments";
import { getServices } from "../lib/services";

const env: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  RAZORPAY_KEY_ID: "rzp_test_mock",
  RAZORPAY_KEY_SECRET: "mock_secret",
  ENVELOPE_SIGNING_SECRET: "test-secret",
};

const DEMO_MESSAGE = "I need black shoes under ₹5,000.";
const CLARIFICATIONS = ["UK 9", "Road running up to 10K", "Wide fit", "Cushioning preferred", "Must be returnable", "Delivery before Sunday"];

async function runToPaid() {
  const services = getServices(env, { forceMock: true });
  const session = services.createSession();
  const orderId = session.logicalOrderId;

  const first = await services.respond(orderId, DEMO_MESSAGE);
  expect(first.kind).toBe("clarify");
  for (const clarification of CLARIFICATIONS) {
    await services.respond(orderId, clarification);
  }
  const final = await services.respond(orderId, "I need black shoes under ₹5,000.");
  expect(final.kind).toBe("shortlist");
  const quote = await services.buildQuote(orderId, "p_streak_4");
  const approval = await services.approve(orderId, quote.digest);
  expect(approval.ok).toBe(true);
  return { services, session, orderId, quote };
}

describe("tracer bullet end to end", () => {
  it("runs ambiguous request → clarify → shortlist → quote → approve", async () => {
    const { session, quote } = await runToPaid();
    expect(session.state).toBe("APPROVED");
    expect(quote.digest).toHaveLength(64);
    expect(quote.envelope.totalMinor).toBe(434800);
  });

  it("refuses to rank before hard constraints are present", async () => {
    const services = getServices(env);
    const session = services.createSession();
    const result = await services.respond(session.logicalOrderId, DEMO_MESSAGE);
    expect(result.kind).toBe("clarify");
  });

  it("approval is idempotent for the same digest", async () => {
    const { services, orderId, quote } = await runToPaid();
    const second = await services.approve(orderId, quote.digest);
    expect(second.ok).toBe(true);
    const events = await services.timeline(orderId);
    expect(events.filter((e) => e.type === "approval.granted")).toHaveLength(1);
  });

  it("rejects approval for a different digest", async () => {
    const { services, orderId } = await runToPaid();
    const result = await services.approve(orderId, "f".repeat(64));
    expect(result.ok).toBe(false);
  });
});

describe("payment flow", () => {
  it("initiates, captures and verifies a mock payment", async () => {
    const { services, orderId, session } = await runToPaid();
    const initiated = await services.initiatePayment(orderId, "razorpay_checkout");
    expect(initiated.ok).toBe(true);
    const capture = await services.mockCapture(orderId);
    const verified = await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature);
    expect(verified.ok).toBe(true);
    expect(session.state).toBe("PAID_VERIFIED");
  });

  it("rejects a forged signature", async () => {
    const { services, orderId, session } = await runToPaid();
    await services.initiatePayment(orderId, "razorpay_checkout");
    const result = await services.verifyPayment(orderId, "order_X", "pay_X", "forged");
    expect(result.ok).toBe(false);
    expect(session.state).toBe("PAYMENT_FAILED");
  });

  it("allows a fresh payment attempt after failure", async () => {
    const { services, orderId, session } = await runToPaid();
    await services.initiatePayment(orderId, "razorpay_checkout");
    await services.verifyPayment(orderId, "order_X", "pay_X", "forged");
    expect(session.state).toBe("PAYMENT_FAILED");
    const retry = await services.initiatePayment(orderId, "razorpay_checkout");
    expect(retry.ok).toBe(true);
    expect(session.state).toBe("PAYMENT_PENDING");
    const capture = await services.mockCapture(orderId);
    const verified = await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature);
    expect(verified.ok).toBe(true);
    expect(session.state).toBe("PAID_VERIFIED");
  });

  it("blocks payment when the envelope is tampered after approval", async () => {
    const { services, orderId } = await runToPaid();
    const tamper = await services.tamper(orderId, "price");
    expect(tamper.ok).toBe(true);
    const result = await services.initiatePayment(orderId, "razorpay_checkout");
    expect(result.ok).toBe(false);
    expect(result.reasonCodes).toContain("envelope_not_approved");
  });

  it("never allows a second successful rail", async () => {
    const { services, orderId } = await runToPaid();
    await services.initiatePayment(orderId, "razorpay_checkout");
    const capture = await services.mockCapture(orderId);
    await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature);
    const second = await services.initiatePayment(orderId, "razorpay_checkout");
    expect(second.ok).toBe(false);
  });

  it("fulfils only after verification", async () => {
    const { services, orderId } = await runToPaid();
    const before = await services.fulfil(orderId, false);
    expect(before.ok).toBe(false);
    await services.initiatePayment(orderId, "razorpay_checkout");
    const capture = await services.mockCapture(orderId);
    await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature);
    const after = await services.fulfil(orderId, false);
    expect(after.ok).toBe(true);
  });
});

describe("failure recovery", () => {
  it("routes paid fulfilment failure to a refund", async () => {
    const { services, orderId, session } = await runToPaid();
    await services.initiatePayment(orderId, "razorpay_checkout");
    const capture = await services.mockCapture(orderId);
    await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature);
    const failed = await services.fulfil(orderId, true);
    expect(failed.ok).toBe(false);
    const compensation = await services.compensate(orderId);
    expect(compensation.ok).toBe(true);
    expect(session.state).toBe("REFUNDED");
  });

  it("invalidation requires reapproval before payment", async () => {
    const { services, orderId, quote } = await runToPaid();
    await services.tamper(orderId, "variant");
    const payment = await services.initiatePayment(orderId, "razorpay_checkout");
    expect(payment.ok).toBe(false);
    const record = services.getEnvelope(orderId)!;
    const reapproval = await services.approve(orderId, record.digest);
    expect(reapproval.ok).toBe(true);
    const retry = await services.initiatePayment(orderId, "razorpay_checkout");
    expect(retry.ok).toBe(true);
  });
});

describe("webhook deduplication", () => {
  it("processes a signed webhook once and deduplicates replays", async () => {
    const { services, orderId } = await runToPaid();
    await services.initiatePayment(orderId, "razorpay_checkout");
    const session = services.getSession(orderId)!;

    const payload = {
      event: "payment.captured",
      contains: ["payment"],
      payload: {
        payment: {
          entity: {
            id: "pay_wh_1",
            order_id: session.externalOrderId,
            amount: 434800,
            currency: "INR",
            status: "captured",
            notes: { logicalOrderId: orderId },
          },
        },
      },
    };
    const { processRazorpayWebhook } = await import("../lib/webhook");
    const first = processRazorpayWebhook(services, payload, razorpaySign("mock_secret", JSON.stringify(payload)), "mock_secret");
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.deduplicated).toBe(false);
    expect(session.state).toBe("PAID_VERIFIED");

    const second = processRazorpayWebhook(services, payload, razorpaySign("mock_secret", JSON.stringify(payload)), "mock_secret");
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.deduplicated).toBe(true);

    const verifiedEvents = (await services.timeline(orderId)).filter(
      (e) => e.type === "payment.verified_via_webhook" || e.type === "payment.verified",
    );
    expect(verifiedEvents).toHaveLength(1);
  });

  it("rejects webhooks with invalid signatures", async () => {
    const { services, orderId } = await runToPaid();
    const { processRazorpayWebhook } = await import("../lib/webhook");
    const payload = {
      event: "payment.captured",
      contains: ["payment"],
      payload: { payment: { entity: { id: "pay_x", notes: { logicalOrderId: orderId } } } },
    };
    const outcome = processRazorpayWebhook(services, payload, "forged", "mock_secret");
    expect(outcome.ok).toBe(false);
  });
});

function razorpaySign(secret: string, payload: string): string {
  return razorpaySignature(secret, payload);
}