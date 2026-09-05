import { describe, expect, it } from "vitest";
import { razorpaySignature } from "@agentready/payments";
import { openSnapshot } from "../lib/session-token";
import { processRazorpayWebhookRaw } from "../lib/webhook";
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

function freshServices() {
  return getServices(env, { forceMock: true, skipCache: true });
}

async function runToApproved(services: ReturnType<typeof getServices>) {
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
  return { orderId, quote };
}

describe("stateless session handoff", () => {
  it("continues an approved order on a fresh instance with the same digest", async () => {
    const a = freshServices();
    const { orderId, quote } = await runToApproved(a);
    const token = await a.exportSession(orderId);
    expect(typeof token).toBe("string");

    const b = freshServices();
    expect(b.getSession(orderId)).toBeUndefined();
    const imported = await b.importSession(token!);
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("import failed");
    expect(imported.orderId).toBe(orderId);
    expect(b.getEnvelope(orderId)?.digest).toBe(quote.digest);

    const initiated = await b.initiatePayment(orderId, "razorpay_checkout");
    expect(initiated.ok).toBe(true);
    expect(initiated.attempt?.externalOrderId).toMatch(/^order_MOCK_/);
  });

  it("preserves audit history without duplicating on double import", async () => {
    const a = freshServices();
    const { orderId } = await runToApproved(a);
    const token = (await a.exportSession(orderId))!;
    const before = await a.timeline(orderId);

    const b = freshServices();
    await b.importSession(token);
    await b.importSession(token);
    const after = await b.timeline(orderId);
    expect(after.map((e) => e.type)).toEqual(before.map((e) => e.type));
    const ids = after.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rejects tampered, foreign-secret and expired tokens", async () => {
    const a = freshServices();
    const { orderId } = await runToApproved(a);
    const token = (await a.exportSession(orderId))!;
    const parts = token.split(".");
    expect(parts.length).toBe(2);
    const [payload, sig] = parts as [string, string];

    const b = freshServices();
    const flipped = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}.${sig}`;
    expect((await b.importSession(flipped)).ok).toBe(false);
    expect((await b.importSession("not-a-token")).ok).toBe(false);

    expect(openSnapshot(token, "wrong-secret")).toBeNull();
    expect(openSnapshot(token, "test-secret")).not.toBeNull();
    // A day past issue the snapshot must read as expired
    const pastExpiry = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();
    expect(openSnapshot(token, "test-secret", pastExpiry)).toBeNull();
  });

  it("stays compact enough for header transport after a full mock flow", async () => {
    const a = freshServices();
    const { orderId } = await runToApproved(a);
    await a.initiatePayment(orderId, "razorpay_checkout");
    const captured = await a.mockCapture(orderId);
    await a.verifyPayment(orderId, captured.orderId, captured.paymentId, captured.signature);
    const token = (await a.exportSession(orderId))!;
    expect(token.length).toBeLessThan(24 * 1024);
  });
});

/** Handoff helper: seal on one instance, continue on a brand-new one. */
async function handOff(services: ReturnType<typeof getServices>, orderId: string) {
  const token = await services.exportSession(orderId);
  if (!token) throw new Error("no token to hand off");
  const next = freshServices();
  const imported = await next.importSession(token);
  if (!imported.ok) throw new Error(`handoff failed: ${imported.error}`);
  return { next, token };
}

describe("cross-instance order lifecycles", () => {
  it("completes a Razorpay mock order across instances with no second charge", async () => {
    const a = freshServices();
    const { orderId } = await runToApproved(a);
    const initiated = await a.initiatePayment(orderId, "razorpay_checkout");
    expect(initiated.ok).toBe(true);

    const { next: b } = await handOff(a, orderId);
    const captured = await b.mockCapture(orderId);
    const verified = await b.verifyPayment(orderId, captured.orderId, captured.paymentId, captured.signature);
    expect(verified.ok).toBe(true);

    const { next: c } = await handOff(b, orderId);
    expect(c.getSession(orderId)?.state).toBe("PAID_VERIFIED");
    // Same-payment replay stays ok; a different payment id is rejected.
    const replay = await c.verifyPayment(orderId, captured.orderId, captured.paymentId, captured.signature);
    expect(replay.ok).toBe(true);
    const second = await c.verifyPayment(orderId, captured.orderId, "pay_MOCK_other", captured.signature);
    expect(second.ok).toBe(false);
  });

  it("completes an automatic x402 mock order across instances", async () => {
    const a = freshServices();
    const { orderId, quote } = await runToApproved(a);
    const prepared = await a.prepareX402OrderPayment(orderId);
    expect(prepared.ok).toBe(true);

    const { next: b } = await handOff(a, orderId);
    const confirmed = await b.confirmX402OrderPayment(orderId, prepared.payment!.paymentIdentifier);
    expect(confirmed.ok).toBe(true);
    expect(confirmed.payment?.envelopeDigest).toBe(quote.digest);
    expect(b.getSession(orderId)?.state).toBe("PAID_VERIFIED");
  });

  it("blocks stale approval and duplicate settlement across instances", async () => {
    const a = freshServices();
    const { orderId, quote } = await runToApproved(a);
    const prepared = await a.prepareX402OrderPayment(orderId);
    expect(prepared.ok).toBe(true);

    const { next: b } = await handOff(a, orderId);
    const tampered = await b.tamper(orderId, "price");
    expect(tampered.ok).toBe(true);
    expect(tampered.state).toBe("REAPPROVAL_REQUIRED");

    const { next: c } = await handOff(b, orderId);
    const staleApprove = await c.approve(orderId, quote.digest);
    expect(staleApprove.ok).toBe(false);
    const staleConfirm = await c.confirmX402OrderPayment(orderId, prepared.payment!.paymentIdentifier);
    expect(staleConfirm.ok).toBe(false);
    expect(staleConfirm.reasonCodes).toContain("quote_invalidated");
  });

  it("rejects cross-rail settlement in both directions across instances", async () => {
    const a = freshServices();
    const { orderId } = await runToApproved(a);
    await a.initiatePayment(orderId, "razorpay_checkout");
    const captured = await a.mockCapture(orderId);
    await a.verifyPayment(orderId, captured.orderId, captured.paymentId, captured.signature);

    const { next: b } = await handOff(a, orderId);
    const x402 = await b.prepareX402OrderPayment(orderId);
    expect(x402.ok).toBe(false);
    expect(x402.reasonCodes).toContain("rail_single_success");

    const c = freshServices();
    const second = await runToApproved(c);
    const prep = await c.prepareX402OrderPayment(second.orderId);
    expect(prep.ok).toBe(true);
    const { next: d } = await handOff(c, second.orderId);
    await d.confirmX402OrderPayment(second.orderId, prep.payment!.paymentIdentifier);
    const { next: e } = await handOff(d, second.orderId);
    const razorpay = await e.initiatePayment(second.orderId, "razorpay_checkout");
    expect(razorpay.ok).toBe(false);
    expect(razorpay.reasonCodes).toContain("rail_single_success");
  });

  it("deduplicates a replayed webhook continued on another instance", async () => {
    const a = freshServices();
    const { orderId } = await runToApproved(a);
    await a.initiatePayment(orderId, "razorpay_checkout");
    const session = a.getSession(orderId)!;
    const record = a.getEnvelope(orderId)!;
    const paymentId = `pay_MOCK_${session.externalOrderId}`;
    const rawBody = JSON.stringify({
      event: "payment.captured",
      contains: ["payment"],
      payload: { payment: { entity: {
        id: paymentId,
        order_id: session.externalOrderId,
        amount: record.envelope.totalMinor,
        currency: record.envelope.currency,
        status: "captured",
        notes: { logicalOrderId: orderId },
      } } },
    });
    const signature = razorpaySignature("mock_secret", rawBody);
    const eventId = `evt_handoff_${session.externalOrderId}`;
    const first = await processRazorpayWebhookRaw(a, rawBody, signature, eventId, "mock_secret");
    expect(first.ok && "processed" in first && first.processed).toBe(true);

    const { next: b } = await handOff(a, orderId);
    const second = await processRazorpayWebhookRaw(b, rawBody, signature, eventId, "mock_secret");
    expect(second.ok && "deduplicated" in second && second.deduplicated).toBe(true);
    const events = await b.timeline(orderId);
    expect(events.filter((e) => e.type === "payment.verified_via_webhook")).toHaveLength(1);
  });
});
