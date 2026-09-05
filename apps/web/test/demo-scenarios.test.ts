import { describe, expect, it } from "vitest";
import { razorpaySignature } from "@agentready/payments";
import { getServices } from "../lib/services";
import { processRazorpayWebhookRaw } from "../lib/webhook";

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

/** Mirrors POST /api/demo/price-drift: approve, tamper, then stale attempts. */
async function runPriceDrift(field: "price" | "variant") {
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
  expect(approved.ok).toBe(true);
  const tampered = await services.tamper(orderId, field);
  const staleApproval = await services.approve(orderId, quote.digest);
  const stalePayment = await services.initiatePayment(orderId, "razorpay_checkout");
  return { services, session, orderId, quote, tampered, staleApproval, stalePayment };
}

/** Mirrors POST /api/demo/webhook-replay: initiate, then same webhook twice. */
async function runWebhookReplay() {
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
  await services.approve(orderId, quote.digest);
  const initiated = await services.initiatePayment(orderId, "razorpay_checkout");
  if (!initiated.ok || !session.externalOrderId) throw new Error("no mock order");
  const record = services.getEnvelope(orderId);
  const paymentId = `pay_MOCK_demo_${session.externalOrderId}`;
  const rawBody = JSON.stringify({
    event: "payment.captured",
    contains: ["payment"],
    payload: { payment: { entity: {
      id: paymentId,
      order_id: session.externalOrderId,
      amount: record?.envelope.totalMinor ?? 0,
      currency: record?.envelope.currency ?? "INR",
      status: "captured",
      notes: { logicalOrderId: orderId },
    } } },
  });
  const secret = "mock_secret";
  const signature = razorpaySignature(secret, rawBody);
  const eventId = `evt_demo_${session.externalOrderId}_${paymentId}`;
  const first = await processRazorpayWebhookRaw(services, rawBody, signature, eventId, secret);
  const second = await processRazorpayWebhookRaw(services, rawBody, signature, eventId, secret);
  return { services, session, orderId, first, second };
}

describe("self-contained price-drift demo", () => {
  it("invalidates the approved digest and blocks stale approval and payment", async () => {
    const { session, quote, tampered, staleApproval, stalePayment } = await runPriceDrift("price");
    expect(tampered.ok).toBe(true);
    expect(session.state).toBe("REAPPROVAL_REQUIRED");
    expect(tampered.changes.join("; ")).toMatch(/price/);
    expect(staleApproval.ok).toBe(false);
    expect(stalePayment.ok).toBe(false);
    expect(quote.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("variant drift names the changed field", async () => {
    const { tampered } = await runPriceDrift("variant");
    expect(tampered.ok).toBe(true);
    expect(tampered.changes.join("; ")).toMatch(/UK 10/);
  });
});

describe("self-contained webhook-replay demo", () => {
  it("first delivery processes fresh, second deduplicates, one transition", async () => {
    const { services, session, orderId, first, second } = await runWebhookReplay();
    expect("processed" in first && first.processed).toBe(true);
    expect("deduplicated" in first && first.deduplicated).toBe(false);
    expect(session.state).toBe("PAID_VERIFIED");
    expect("deduplicated" in second && second.deduplicated).toBe(true);
    const events = await services.timeline(orderId);
    const verified = events.filter((e) => e.type === "payment.verified_via_webhook");
    expect(verified).toHaveLength(1);
  });
});
