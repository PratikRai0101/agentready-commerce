import { describe, expect, it } from "vitest";
import { getServices } from "../lib/services";

const env: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  RAZORPAY_KEY_ID: "rzp_test_mock",
  RAZORPAY_KEY_SECRET: "mock_secret",
  ENVELOPE_SIGNING_SECRET: "test-secret",
  RAZORPAY_WEBHOOK_SECRET: "mock_secret",
};

describe("approval invalidation — real service regression", () => {
  it("preserves original approval audit, records invalidation separately, and shows current status independently", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const session = services.createSession();
    const orderId = session.logicalOrderId;

    // Build to approval
    await services.respond(orderId, "I need black shoes under ₹5,000.");
    for (const msg of ["UK 9", "Road running up to 10K", "Wide fit", "Cushioning preferred", "Must be returnable"]) {
      await services.respond(orderId, msg);
    }
    const shortlist = await services.respond(orderId, "I need black shoes under ₹5,000.");
    expect(shortlist.kind).toBe("shortlist");
    if (shortlist.kind !== "shortlist") throw new Error("expected shortlist");
    const firstIV = shortlist.intentVersion;
    const productId = shortlist.matches[0]!.product.productId;
    const binding = {
      intentVersion: shortlist.intentVersion,
      recommendationVersion: shortlist.recommendationVersion,
      recommendationActionToken: shortlist.recommendationActionToken,
    };

    const quote = await services.buildQuote(orderId, productId, binding);
    expect(quote.state).toBe("AWAITING_APPROVAL");
    const digest1 = quote.digest;
    const approve1 = await services.approve(orderId, digest1);
    expect(approve1.ok).toBe(true);
    expect(services.getSession(orderId)?.state).toBe("APPROVED");
    const timelineAfterApprove = await services.timeline(orderId);
    const approvalEventsAfterApprove = timelineAfterApprove.filter((e) => e.type === "approval.granted");
    expect(approvalEventsAfterApprove).toHaveLength(1);
    const originalApprovalId = approvalEventsAfterApprove[0]!.outputDigest;

    // Current status is APPROVED, historical event preserved
    expect(services.getSession(orderId)?.approvalEventId).toBe(originalApprovalId);
    expect(services.getEnvelope(orderId)?.digest).toBe(digest1);

    // Edit: change budget from 5000 to 4000 (material change) — should invalidate
    const patchRes = await services.intentPatch(orderId, { maxAmountMinor: 400000 }, firstIV);
    expect(patchRes.ok).toBe(true);
    // After material change, session approval must be cleared, but audit retains original
    expect(services.getSession(orderId)?.approvalEventId).toBeUndefined();
    expect(services.getSession(orderId)?.state).toBe("REAPPROVAL_REQUIRED");
    expect(services.getEnvelope(orderId)).toBeUndefined(); // quote deleted

    const timelineAfterEdit = await services.timeline(orderId);
    // Original approval still in history
    const approvalEventsAfterEdit = timelineAfterEdit.filter((e) => e.type === "approval.granted");
    expect(approvalEventsAfterEdit).toHaveLength(1);
    expect(approvalEventsAfterEdit[0]!.outputDigest).toBe(originalApprovalId);
    // Invalidation recorded separately
    const invalidationEvents = timelineAfterEdit.filter((e) => e.type === "quote.invalidated");
    expect(invalidationEvents.length).toBeGreaterThanOrEqual(1);
    expect(invalidationEvents[invalidationEvents.length - 1]!.inputDigest).toBe(digest1);

    // Current status is NOT approved, independent from history
    expect(services.getSession(orderId)?.state).not.toBe("APPROVED");
    expect(services.getEnvelope(orderId)).toBeUndefined();

    // Re-approve with new quote
    expect(patchRes.matches && patchRes.matches.length).toBeGreaterThan(0);
    const newProductId = patchRes.matches![0]!.product.productId;
    const newBinding = patchRes.recommendationBinding!;
    const quote2 = await services.buildQuote(orderId, newProductId, newBinding);
    expect(quote2.state).toBe("AWAITING_APPROVAL");
    expect(quote2.digest).not.toBe(digest1);
    const approve2 = await services.approve(orderId, quote2.digest);
    expect(approve2.ok).toBe(true);
    expect(services.getSession(orderId)?.state).toBe("APPROVED");

    const timelineAfterReapprove = await services.timeline(orderId);
    const approvalEventsAfterReapprove = timelineAfterReapprove.filter((e) => e.type === "approval.granted");
    expect(approvalEventsAfterReapprove).toHaveLength(2);
    expect(approvalEventsAfterReapprove[1]!.outputDigest).toBe(approve2.approvalEventId);
    // Both approvals preserved, current status is second
    expect(services.getSession(orderId)?.approvalEventId).toBe(approve2.approvalEventId);
    // Invalidation still separate
    expect(timelineAfterReapprove.filter((e) => e.type === "quote.invalidated").length).toBeGreaterThanOrEqual(1);
  });

  it("requires re-approval before payment after invalidation (no silent cart change)", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    const session = services.createSession();
    const orderId = session.logicalOrderId;
    await services.respond(orderId, "I need black shoes under ₹5,000.");
    for (const msg of ["UK 9", "Road running up to 10K", "Wide fit"]) {
      await services.respond(orderId, msg);
    }
    const shortlist = await services.respond(orderId, "I need black shoes under ₹5,000.");
    if (shortlist.kind !== "shortlist") throw new Error("expected shortlist");
    const quote = await services.buildQuote(orderId, shortlist.matches[0]!.product.productId, {
      intentVersion: shortlist.intentVersion,
      recommendationVersion: shortlist.recommendationVersion,
      recommendationActionToken: shortlist.recommendationActionToken,
    });
    await services.approve(orderId, quote.digest);
    // Edit to trigger invalidation
    await services.intentPatch(orderId, { maxAmountMinor: 300000 }, shortlist.intentVersion);
    // Payment with old digest must be blocked (quote invalidated or no envelope)
    const payOld = await services.initiatePayment(orderId, "razorpay_checkout");
    expect(payOld.ok).toBe(false);
    const hasInvalidation = (payOld.reasonCodes && payOld.reasonCodes.includes("quote_invalidated")) || (payOld.error && payOld.error.includes("No envelope"));
    expect(hasInvalidation).toBe(true);
  });
});

describe("Razorpay UI wiring — mocks only, no real payment", () => {
  it("wires Pay button to initiatePayment and mockCapture using mock adapter only", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    expect(services.isMock).toBe(true);
    expect(services.razorpayMode).toBe("mock");
    const session = services.createSession();
    const orderId = session.logicalOrderId;
    await services.respond(orderId, "I need black shoes under ₹5,000.");
    for (const msg of ["UK 9", "Road running up to 10K", "Wide fit", "Cushioning preferred", "Must be returnable"]) {
      await services.respond(orderId, msg);
    }
    const shortlist = await services.respond(orderId, "I need black shoes under ₹5,000.");
    if (shortlist.kind !== "shortlist") throw new Error("expected shortlist");
    const quote = await services.buildQuote(orderId, shortlist.matches[0]!.product.productId, {
      intentVersion: shortlist.intentVersion,
      recommendationVersion: shortlist.recommendationVersion,
      recommendationActionToken: shortlist.recommendationActionToken,
    });
    await services.approve(orderId, quote.digest);
    // UI would enable Pay only now; simulate click
    const initiated = await services.initiatePayment(orderId, "razorpay_checkout");
    expect(initiated.ok).toBe(true);
    expect(initiated.attempt?.externalOrderId).toMatch(/^order_MOCK_/);
    // Mock capture + verify (no real Razorpay call)
    const captured = await services.mockCapture(orderId);
    expect(captured.paymentId).toMatch(/^pay_MOCK_/);
    const verified = await services.verifyPayment(orderId, captured.orderId, captured.paymentId, captured.signature);
    expect(verified.ok).toBe(true);
    expect(services.getSession(orderId)?.state).toBe("PAID_VERIFIED");
    // No second successful rail
    const second = await services.initiatePayment(orderId, "razorpay_checkout");
    expect(second.ok).toBe(false);
  });

  it("keeps Pay disabled until approved and keeps Devnet mock", async () => {
    const services = getServices(env, { forceMock: true, skipCache: true });
    expect(services.registry.isMock("x402_solana")).toBe(true);
    const session = services.createSession();
    const orderId = session.logicalOrderId;
    // Before approval, payment must be blocked
    await services.respond(orderId, "I need black shoes under ₹5,000.");
    const beforeApprove = await services.initiatePayment(orderId, "razorpay_checkout");
    expect(beforeApprove.ok).toBe(false);
    // No real x402 settlement attempted
    expect(services.getSession(orderId)?.machineSpend).toBeUndefined();
  });
});
