import { describe, expect, it } from "vitest";
import { getServices } from "../lib/services";

const env: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  RAZORPAY_KEY_ID: "",
  RAZORPAY_KEY_SECRET: "",
  RAZORPAY_WEBHOOK_SECRET: "mock_secret",
  ENVELOPE_SIGNING_SECRET: "test-secret",
  X402_MODE: "mock",
  X402_SETTLEMENT_ENABLED: "false",
};

const DEMO_MESSAGE = "I need black shoes under ₹5,000.";
const CLARIFICATIONS = ["UK 9", "Road running up to 10K", "Wide fit", "Cushioning preferred", "Must be returnable", "Delivery before Sunday"];

/** Drive one fresh mock session to an approved envelope. */
async function runToApproved() {
  const services = getServices(env, { forceMock: true, skipCache: true });
  const session = services.createSession();
  const orderId = session.logicalOrderId;
  await services.respond(orderId, DEMO_MESSAGE);
  let shortlist: Extract<Awaited<ReturnType<typeof services.respond>>, { kind: "shortlist" }> | undefined;
  for (const clarification of CLARIFICATIONS) {
    const result = await services.respond(orderId, clarification);
    if (result.kind === "shortlist") shortlist = result;
  }
  if (!shortlist) throw new Error("no shortlist");
  const binding = {
    intentVersion: shortlist.intentVersion,
    recommendationVersion: shortlist.recommendationVersion,
    recommendationActionToken: shortlist.recommendationActionToken,
  };
  const selected = await services.respond(orderId, "Select Streak 4.", binding);
  if (selected.kind !== "select") throw new Error("no selection");
  const quote = await services.buildQuote(orderId, "p_streak_4", {
    intentVersion: selected.intentVersion,
    recommendationVersion: selected.recommendationVersion,
    recommendationActionToken: selected.recommendationActionToken,
  });
  const approved = await services.approve(orderId, quote.digest);
  if (!approved.ok) throw new Error("not approved");
  return { services, session, orderId, quote };
}

async function runToRazorpayPaid() {
  const ctx = await runToApproved();
  const { services, orderId } = ctx;
  const initiated = await services.initiatePayment(orderId, "razorpay_checkout");
  if (!initiated.ok) throw new Error("initiate failed");
  const captured = await services.mockCapture(orderId);
  const verified = await services.verifyPayment(orderId, captured.orderId, captured.paymentId, captured.signature);
  if (!verified.ok) throw new Error("verify failed");
  return { ...ctx, captured };
}

async function runToX402Paid() {
  const ctx = await runToApproved();
  const { services, orderId } = ctx;
  const prepared = await services.prepareX402OrderPayment(orderId);
  if (!prepared.ok || !prepared.payment) throw new Error("prepare failed");
  const confirmed = await services.confirmX402OrderPayment(orderId, prepared.payment.paymentIdentifier);
  if (!confirmed.ok) throw new Error("confirm failed");
  return { ...ctx, payment: prepared.payment };
}

describe("checkout rail selector: successful paths", () => {
  it("Razorpay mock path reaches PAID_VERIFIED with mock ids", async () => {
    const { session, captured } = await runToRazorpayPaid();
    expect(session.state).toBe("PAID_VERIFIED");
    expect(captured.paymentId).toMatch(/^pay_MOCK_/);
    expect(session.verification?.rail).toBe("razorpay_checkout");
  });

  it("Agent Pay mock path reaches PAID_VERIFIED with envelope-bound digest", async () => {
    const { services, session, orderId, quote, payment } = await runToX402Paid();
    expect(session.state).toBe("PAID_VERIFIED");
    expect(payment.paymentIdentifier).toMatch(/^x402ord_/);
    expect(payment.envelopeDigest).toBe(quote.digest);
    expect(payment.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(session.verification?.rail).toBe("x402_solana");
    const events = await services.timeline(orderId);
    expect(events.some((e) => e.type === "x402_order.prepared")).toBe(true);
    expect(events.some((e) => e.type === "x402_order.verified")).toBe(true);
  });
});

describe("checkout rail selector: exclusivity", () => {
  it("completed Razorpay payment blocks Agent Pay prepare and confirm", async () => {
    const { services, orderId } = await runToRazorpayPaid();
    const prepared = await services.prepareX402OrderPayment(orderId);
    expect(prepared.ok).toBe(false);
    expect(prepared.reasonCodes).toContain("rail_single_success");
    const confirmed = await services.confirmX402OrderPayment(orderId, "x402ord_stale");
    expect(confirmed.ok).toBe(false);
    const events = await services.timeline(orderId);
    expect(events.some((e) => e.type === "x402_order.rejected")).toBe(true);
  });

  it("completed Agent Pay blocks Razorpay initiate, capture and verify", async () => {
    const { services, session, orderId, payment } = await runToX402Paid();
    const initiated = await services.initiatePayment(orderId, "razorpay_checkout");
    expect(initiated.ok).toBe(false);
    expect(initiated.reasonCodes).toContain("rail_single_success");
    await expect(services.mockCapture(orderId)).rejects.toThrow(/Agent Pay/);
    const verified = await services.verifyPayment(orderId, "order_MOCK_x", "pay_MOCK_x", "sig");
    expect(verified.ok).toBe(false);
    expect(session.state).toBe("PAID_VERIFIED");
    expect(payment.status).toBe("verified");
  });

  it("Agent Pay preparation blocks after Razorpay initiation, and vice versa", async () => {
    const ctx = await runToApproved();
    const initiated = await ctx.services.initiatePayment(ctx.orderId, "razorpay_checkout");
    expect(initiated.ok).toBe(true);
    const prepared = await ctx.services.prepareX402OrderPayment(ctx.orderId);
    expect(prepared.ok).toBe(false);
    expect(prepared.reasonCodes).toContain("rail_already_initiated");
  });
});

describe("checkout rail selector: stale approval", () => {
  it("envelope change invalidates the prepared selection and forces re-approval", async () => {
    const { services, session, orderId, quote } = await runToApproved();
    const prepared = await services.prepareX402OrderPayment(orderId);
    expect(prepared.ok).toBe(true);
    const tampered = await services.tamper(orderId, "price");
    expect(tampered.ok).toBe(true);
    expect(session.state).toBe("REAPPROVAL_REQUIRED");
    const staleConfirm = await services.confirmX402OrderPayment(orderId, prepared.payment!.paymentIdentifier);
    expect(staleConfirm.ok).toBe(false);
    expect(staleConfirm.reasonCodes).toContain("quote_invalidated");
    const stalePrepare = await services.prepareX402OrderPayment(orderId);
    expect(stalePrepare.ok).toBe(false);
    expect(quote.digest).not.toBe(services.getEnvelope(orderId)?.digest);
  });
});

describe("checkout rail selector: duplicates and retry", () => {
  it("duplicate prepare reuses the identifier; duplicate confirm reuses verification", async () => {
    const { services, session, orderId } = await runToApproved();
    const first = await services.prepareX402OrderPayment(orderId);
    const second = await services.prepareX402OrderPayment(orderId);
    expect(first.ok && second.ok).toBe(true);
    expect(second.payment?.paymentIdentifier).toBe(first.payment?.paymentIdentifier);
    const confirm1 = await services.confirmX402OrderPayment(orderId, first.payment!.paymentIdentifier);
    const confirm2 = await services.confirmX402OrderPayment(orderId, first.payment!.paymentIdentifier);
    expect(confirm1.ok && confirm2.ok).toBe(true);
    expect(session.state).toBe("PAID_VERIFIED");
    const events = await services.timeline(orderId);
    expect(events.filter((e) => e.type === "x402_order.verified")).toHaveLength(1);
    expect(events.some((e) => e.type === "x402_order.duplicate")).toBe(true);
  });

  it("Razorpay payment retry returns the same attempt without a second order", async () => {
    const { services, orderId } = await runToApproved();
    const first = await services.initiatePayment(orderId, "razorpay_checkout");
    const second = await services.initiatePayment(orderId, "razorpay_checkout");
    expect(first.ok && second.ok).toBe(true);
    expect(second.attempt?.externalOrderId).toBe(first.attempt?.externalOrderId);
  });

  it("unknown x402 identifier is rejected and audited", async () => {
    const { services, orderId } = await runToApproved();
    const result = await services.confirmX402OrderPayment(orderId, "x402ord_unknown");
    expect(result.ok).toBe(false);
    expect(result.reasonCodes).toContain("identifier_unknown");
  });
});
