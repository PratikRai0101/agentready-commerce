import { describe, expect, it } from "vitest";
import { getServices } from "../lib/services";
import { buildPublicCatalog } from "../lib/catalog-public";
import { buildDiscoveryDoc } from "../lib/discovery";

/**
 * Reproducible mock buyer-client demonstration.
 *
 * Acts as an independent machine client driving ONLY the same service calls
 * the public HTTP routes wrap (respond/quote/approve/pay/audit), on the mock
 * rail. Human approval is an explicit, separately asserted step: payment
 * initiated before it must be blocked, and the approval audit event must carry
 * actor "customer". No browser, no real payment, no network.
 */
const env: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  RAZORPAY_KEY_ID: "rzp_test_mock",
  RAZORPAY_KEY_SECRET: "mock_secret",
  ENVELOPE_SIGNING_SECRET: "test-secret",
  RAZORPAY_WEBHOOK_SECRET: "mock_secret",
};

describe("mock buyer-client — machine discovery", () => {
  it("publishes a grounded catalog projection", () => {
    const catalog = buildPublicCatalog();
    expect(catalog.merchantId).toBe("merchant_runvista");
    expect(catalog.productCount).toBe(catalog.products.length);
    expect(catalog.productCount).toBeGreaterThan(0);
    for (const product of catalog.products) {
      expect(product.priceMinor).toBeGreaterThan(0);
      expect(product.variants.length).toBeGreaterThan(0);
      expect(product.variants.some((v) => v.inStock > 0)).toBe(true);
    }
  });

  it("publishes a non-protocol discovery descriptor", () => {
    const doc = buildDiscoveryDoc({ razorpay: "mock", x402: "mock", llm: "disabled", envelopeSigning: "mock" });
    expect(doc.catalog).toBe("/api/catalog");
    expect(JSON.stringify(doc)).toContain("SHA-256");
    expect(doc.protocolConformance).toMatch(/none claimed/i);
    expect(doc.modes.razorpay).toBe("mock");
  });
});

describe("mock buyer-client — gated purchase with explicit human approval", () => {
  it("clarify → shortlist → quote → approve → pay → verify (mock ids only)", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    expect(services.isMock).toBe(true);
    const session = services.createSession();
    const orderId = session.logicalOrderId;

    const r1 = await services.respond(orderId, "I need black shoes under ₹5,000.");
    expect(r1.kind).toBe("clarify");
    const r2 = await services.respond(orderId, "UK 9, road running");
    expect(r2.kind).toBe("shortlist");
    if (r2.kind !== "shortlist") throw new Error("expected shortlist");
    expect(r2.matches.length).toBeGreaterThan(0);
    const productId = r2.matches[0]!.product.productId;
    const binding = {
      intentVersion: r2.intentVersion,
      recommendationVersion: r2.recommendationVersion,
      recommendationActionToken: r2.recommendationActionToken,
    };

    const quote = await services.buildQuote(orderId, productId, binding);
    expect(quote.state).toBe("AWAITING_APPROVAL");

    // Human approval is explicit: payment before it is blocked.
    const blocked = await services.initiatePayment(orderId, "razorpay_checkout");
    expect(blocked.ok).toBe(false);

    const approval = await services.approve(orderId, quote.digest);
    expect(approval.ok).toBe(true);
    expect(services.getSession(orderId)?.state).toBe("APPROVED");

    const initiated = await services.initiatePayment(orderId, "razorpay_checkout");
    expect(initiated.ok).toBe(true);
    expect(initiated.attempt?.externalOrderId).toMatch(/^order_MOCK_/);

    const captured = await services.mockCapture(orderId);
    expect(captured.paymentId).toMatch(/^pay_MOCK_/);
    const verified = await services.verifyPayment(orderId, captured.orderId, captured.paymentId, captured.signature);
    expect(verified.ok).toBe(true);
    expect(services.getSession(orderId)?.state).toBe("PAID_VERIFIED");

    // Approval audit event is human-attributed.
    const timeline = await services.timeline(orderId);
    const approvals = timeline.filter((e) => e.type === "approval.granted");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.actor).toBe("customer");

    // Single successful rail: a second initiation is rejected.
    const second = await services.initiatePayment(orderId, "razorpay_checkout");
    expect(second.ok).toBe(false);
  });
});

describe("mock buyer-client — failure to compensation (mock refund)", () => {
  it("fulfilment failure → compensation → REFUNDED with one refund event", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const session = services.createSession();
    const orderId = session.logicalOrderId;

    await services.respond(orderId, "I need black shoes under ₹5,000.");
    const shortlist = await services.respond(orderId, "UK 9, road running");
    if (shortlist.kind !== "shortlist") throw new Error("expected shortlist");
    const quote = await services.buildQuote(orderId, shortlist.matches[0]!.product.productId, {
      intentVersion: shortlist.intentVersion,
      recommendationVersion: shortlist.recommendationVersion,
      recommendationActionToken: shortlist.recommendationActionToken,
    });
    await services.approve(orderId, quote.digest);
    await services.initiatePayment(orderId, "razorpay_checkout");
    const captured = await services.mockCapture(orderId);
    await services.verifyPayment(orderId, captured.orderId, captured.paymentId, captured.signature);

    const failed = await services.fulfil(orderId, true);
    expect(failed.ok).toBe(false);
    expect(services.getSession(orderId)?.state).toBe("FULFILMENT_FAILED");

    const compensated = await services.compensate(orderId);
    expect(compensated.ok).toBe(true);
    expect(compensated.refundId).toMatch(/^rfnd_MOCK_/);
    expect(services.getSession(orderId)?.state).toBe("REFUNDED");

    // Idempotent: exactly one refund event despite a repeated call.
    await services.compensate(orderId);
    const timeline = await services.timeline(orderId);
    const types = timeline.map((e) => e.type);
    for (const required of ["intent.shortlist_ranked", "quote.envelope_created", "approval.granted", "payment.initiated", "payment.verified", "fulfilment.failed", "compensation.refunded"]) {
      expect(types).toContain(required);
    }
    expect(timeline.filter((e) => e.type === "compensation.refunded")).toHaveLength(1);
  });
});
